import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enfileirarGeracaoDeArtefatos, obterFilaCuradoria, curarItem } from './curadoria';
import { obterLacunasEstudo } from './lacunas';
import { obterCadernoErros, resolverErro } from './cadernoErros';
import { injetarTopicoNoCiclo } from './reestudo';
import { listarSimulados } from './simulados';
import { AuthorizationError, requireManagedStudentProfile } from '../../lib/authorization';

const dbState = vi.hoisted(() => ({ selectResults: [] as unknown[][] }));

vi.mock('../../lib/authorization', () => {
  class AuthorizationError extends Error {
    readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN';

    constructor(code: 'UNAUTHENTICATED' | 'FORBIDDEN') {
      super(code === 'UNAUTHENTICATED' ? 'Autenticação necessária.' : 'Acesso não autorizado.');
      this.name = 'AuthorizationError';
      this.code = code;
    }
  }

  const estudante = {
    id: 'perfil-1',
    authUserId: 'auth-1',
    nome: 'Estudante Teste',
    email: null,
    papel: 'estudante',
  };
  const responsavel = {
    id: 'responsavel-1',
    authUserId: 'auth-responsavel-1',
    nome: 'Responsável Teste',
    email: null,
    papel: 'responsavel',
  };

  return {
    AuthorizationError,
    requireAuthenticatedProfile: vi.fn().mockResolvedValue(estudante),
    requireRole: vi.fn().mockImplementation(async (role: string) => (
      role === 'responsavel' ? responsavel : estudante
    )),
    requireManagedStudentProfile: vi.fn().mockResolvedValue(estudante),
    assertOwnership: vi.fn(),
  };
});

// Mock DB
vi.mock('../../db', () => {
  const queryBuilder: any = {
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'mock-id' }]),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (resolve: any) => resolve(dbState.selectResults.shift() ?? [])
  };
  return { db: queryBuilder };
});

describe('Fase 3 & 4 - Server Actions Tests', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectResults.length = 0;
  });

  describe('obterFilaCuradoria', () => {
    it('deve retornar lista de itens pendentes', async () => {
      const list = await obterFilaCuradoria();
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe('curarItem', () => {
    it('deve retornar erro para item inexistente', async () => {
      const res = await curarItem('non-existent', 'aprovado');
      expect(res).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });

    it('preserva a negação de autorização ao resolver a estudante vinculada', async () => {
      dbState.selectResults.push([{ id: 'fila-1', artefatoTipo: 'flashcard', artefatoId: 'fc-1' }]);
      vi.mocked(requireManagedStudentProfile).mockRejectedValueOnce(new AuthorizationError('FORBIDDEN'));

      await expect(curarItem('fila-1', 'aprovado')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('geração por IA', () => {
    it('não cria falso sucesso quando a chave Gemini está ausente', async () => {
      const originalKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      dbState.selectResults.push(
        [{ id: 'arquivo-1', statusProcessamento: 'concluido' }],
        [{ texto: 'Conteúdo médico', topicoId: 'topico-1', topicoNome: 'Fisiologia' }]
      );

      const result = await enfileirarGeracaoDeArtefatos('arquivo-1');

      expect(result).toMatchObject({ ok: false, code: 'EXTERNAL_SERVICE_ERROR' });
      expect(result).not.toHaveProperty('data');
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalKey;
    });
  });

  describe('obterLacunasEstudo', () => {
    it('deve retornar lista de lacunas', async () => {
      const lacunas = await obterLacunasEstudo();
      expect(Array.isArray(lacunas)).toBe(true);
      expect(lacunas.length).toBeGreaterThan(0);
    });
  });

  describe('Caderno de Erros', () => {
    it('deve obter erros do caderno', async () => {
      const erros = await obterCadernoErros();
      expect(Array.isArray(erros)).toBe(true);
    });

    it('deve marcar erro como resolvido', async () => {
      const res = await resolverErro('mock-erro-id');
      expect(res.ok).toBe(true);
    });
  });

  describe('Re-estudo', () => {
    it('deve retornar erro ao tentar injetar topico inexistente', async () => {
      const res = await injetarTopicoNoCiclo('non-existent');
      expect(res.sucesso).toBe(false);
    });
  });

  describe('Simulados', () => {
    it('deve listar simulados cadastrados', async () => {
      const simulados = await listarSimulados();
      expect(Array.isArray(simulados)).toBe(true);
    });
  });

});
