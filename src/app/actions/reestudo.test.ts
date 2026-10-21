import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  eq: vi.fn(),
  selectResults: [] as unknown[][],
  updateWhere: vi.fn(),
  insertValues: vi.fn()
}));

vi.mock('../../lib/authorization', () => ({
  requireRole: mocks.requireRole
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: mocks.eq
  };
});

vi.mock('../../db', () => {
  const transactionClient = {
    select: vi.fn(() => {
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        limit: vi.fn(async () => mocks.selectResults.shift() ?? [])
      };
      return query;
    }),
    update: vi.fn(() => {
      const query = {
        set: vi.fn(() => query),
        where: mocks.updateWhere.mockResolvedValue([])
      };
      return query;
    }),
    insert: vi.fn(() => ({ values: mocks.insertValues.mockResolvedValue([]) }))
  };
  const db = {
    transaction: vi.fn(async (callback) => callback(transactionClient))
  };
  return { db, transactionClient };
});

import { ciclos } from '../../db/schema';
import { injetarTopicoNoCiclo } from './reestudo';

const TOPICO_1_ID = '11111111-1111-4111-8111-111111111101';
const DISCIPLINA_1_ID = '00000000-0000-0000-0000-000000000001';
const CICLO_1_ID = 'cccccccc-1111-4111-8111-111111111111';

describe('reestudo com ownership de ciclo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults.length = 0;
    mocks.requireRole.mockResolvedValue({
      id: 'estudante-1',
      nome: 'Estudante',
      email: null,
      papel: 'estudante'
    });
    mocks.eq.mockImplementation((left, right) => ({ left, right }));
  });

  it('rejeita UUID inválido ou duração fora do intervalo sem acessar o banco (F1.09)', async () => {
    const uuidInvalido = await injetarTopicoNoCiclo('topico-1');
    expect(uuidInvalido.sucesso).toBe(false);

    const duracaoInvalida = await injetarTopicoNoCiclo(TOPICO_1_ID, 2);
    expect(duracaoInvalida.sucesso).toBe(false);

    expect(mocks.updateWhere).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it('escopa a busca do ciclo ativo pela estudante autenticada', async () => {
    mocks.selectResults.push(
      [{ disciplinaId: DISCIPLINA_1_ID, nome: 'Tópico' }],
      []
    );

    const resultado = await injetarTopicoNoCiclo(TOPICO_1_ID);

    expect(resultado.sucesso).toBe(false);
    expect(mocks.requireRole).toHaveBeenCalledWith('estudante');
    expect(mocks.eq).toHaveBeenCalledWith(ciclos.estudantePerfilId, 'estudante-1');
  });

  it('reordena e insere o bloco atomicamente para suportar a unicidade futura', async () => {
    mocks.selectResults.push(
      [{ disciplinaId: DISCIPLINA_1_ID, nome: 'Tópico' }],
      [{ id: CICLO_1_ID }],
      [{ proximaOrdem: 2 }],
      [{ maiorOrdem: 5 }]
    );

    const resultado = await injetarTopicoNoCiclo(TOPICO_1_ID);

    expect(resultado.sucesso).toBe(true);
    expect(mocks.updateWhere).toHaveBeenCalledTimes(2);
    expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      cicloId: CICLO_1_ID,
      ordem: 2,
      disciplinaId: DISCIPLINA_1_ID
    }));
  });
});
