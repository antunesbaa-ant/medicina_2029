import { describe, it, expect, vi, beforeEach } from 'vitest';
import { obterGenerosUECE, obterRepertorios, obterRedacoes, registrarRedacao, registrarRepertorio } from './redacoes';
import { db } from '../../db';
import { eq } from 'drizzle-orm';
import { repertorios } from '../../db/schema';

const PERFIL_1_ID = '10000000-0000-4000-8000-000000000001';
const GENERO_1_ID = '81000000-0000-4000-8000-000000000001';

vi.mock('../../lib/authorization', () => ({
  requireAuthenticatedProfile: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001',
    authUserId: 'a0000000-0000-4000-8000-000000000001',
    nome: 'Estudante Teste',
    email: null,
    papel: 'estudante',
  }),
  requireRole: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001',
    authUserId: 'a0000000-0000-4000-8000-000000000001',
    nome: 'Estudante Teste',
    email: null,
    papel: 'estudante',
  }),
  requireManagedStudentProfile: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001',
    authUserId: 'a0000000-0000-4000-8000-000000000001',
    nome: 'Estudante Teste',
    email: null,
    papel: 'estudante',
  }),
  assertOwnership: vi.fn(),
}));

// Mock DB
vi.mock('../../db', () => {
  const queryBuilder: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'mock-id' }]),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown[]) => unknown) => resolve([])
  };
  return { db: queryBuilder };
});

describe('Fase 7 - Redações & Repertório Sociocultural', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('distingue ausência real de gêneros sem fabricar dados', async () => {
    const list = await obterGenerosUECE();
    expect(list).toEqual([]);
  });

  it('distingue ausência real de repertórios sem fabricar dados', async () => {
    const list = await obterRepertorios();
    expect(list).toEqual([]);
    const mockedDb = db as unknown as { where: ReturnType<typeof vi.fn> };
    expect(mockedDb.where).toHaveBeenLastCalledWith(eq(repertorios.perfilId, PERFIL_1_ID));
  });

  it('deve obter redacoes da estudante (mock)', async () => {
    const list = await obterRedacoes();
    expect(Array.isArray(list)).toBe(true);
  });

  it('deve registrar nova redacao', async () => {
    const res = await registrarRedacao({
      formato: 'enem',
      tema: 'Tema de Redação',
      texto: 'Texto de Redação completo',
      minutosGastos: 60
    });
    expect(res.ok).toBe(true);
    const mockedDb = db as unknown as { values: ReturnType<typeof vi.fn> };
    expect(mockedDb.values).toHaveBeenLastCalledWith(expect.objectContaining({
      perfilId: PERFIL_1_ID
    }));
  });

  it('rejeita redacao com minutos fora dos limites, tema vazio, genero_uece sem generoId ou generoId inexistente sem gravar', async () => {
    const mockedDb = db as unknown as { insert: ReturnType<typeof vi.fn> };

    await expect(
      registrarRedacao({
        formato: 'enem',
        tema: '',
        texto: 'Texto',
        minutosGastos: 50,
      })
    ).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    await expect(
      registrarRedacao({
        formato: 'enem',
        tema: 'Tema',
        texto: 'Texto',
        minutosGastos: 0,
      })
    ).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    await expect(
      registrarRedacao({
        formato: 'genero_uece',
        tema: 'Tema',
        texto: 'Texto',
        minutosGastos: 50,
      })
    ).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    expect(mockedDb.insert).not.toHaveBeenCalled();

    // genero_uece com generoId válido mas inexistente no banco
    await expect(
      registrarRedacao({
        formato: 'genero_uece',
        generoId: GENERO_1_ID,
        tema: 'Tema UECE',
        texto: 'Texto UECE',
        minutosGastos: 50,
      })
    ).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });

    expect(mockedDb.insert).not.toHaveBeenCalled();
  });

  it('deve registrar novo repertorio', async () => {
    const res = await registrarRepertorio({
      referencia: 'Referência',
      resumo2Linhas: 'Resumo curto',
      temasAplicaveis: ['Tecnologia'],
      categoria: 'Sociologia'
    });
    expect(res.ok).toBe(true);
    const mockedDb = db as unknown as { values: ReturnType<typeof vi.fn> };
    expect(mockedDb.values).toHaveBeenLastCalledWith(expect.objectContaining({
      perfilId: PERFIL_1_ID
    }));
  });

  it('rejeita repertorio incompleto ou com temas duplicados antes de acessar o banco', async () => {
    const mockedDb = db as unknown as { insert: ReturnType<typeof vi.fn> };

    await expect(
      registrarRepertorio({
        referencia: '',
        resumo2Linhas: 'Resumo',
        temasAplicaveis: ['Saúde'],
        categoria: 'Sociologia',
      })
    ).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    await expect(
      registrarRepertorio({
        referencia: 'Autor',
        resumo2Linhas: 'Resumo',
        temasAplicaveis: ['Saúde', 'saúde'],
        categoria: 'Sociologia',
      })
    ).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    expect(mockedDb.insert).not.toHaveBeenCalled();
  });

  it('não confirma redação quando INSERT não retorna registro', async () => {
    const mockedDb = db as unknown as { returning: ReturnType<typeof vi.fn> };
    mockedDb.returning.mockResolvedValueOnce([]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await registrarRedacao({
      formato: 'enem',
      tema: 'Tema',
      texto: 'Texto',
      minutosGastos: 30,
    });

    expect(res).toMatchObject({ ok: false, code: 'PERSISTENCE_ERROR' });
    consoleError.mockRestore();
  });

  it('não confirma repertório quando INSERT não retorna registro', async () => {
    const mockedDb = db as unknown as { returning: ReturnType<typeof vi.fn> };
    mockedDb.returning.mockResolvedValueOnce([]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await registrarRepertorio({
      referencia: 'Referência',
      resumo2Linhas: 'Resumo',
      temasAplicaveis: [],
      categoria: 'História',
    });

    expect(res).toMatchObject({ ok: false, code: 'PERSISTENCE_ERROR' });
    consoleError.mockRestore();
  });

});
