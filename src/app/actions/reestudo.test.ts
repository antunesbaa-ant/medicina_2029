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

  it('escopa a busca do ciclo ativo pela estudante autenticada', async () => {
    mocks.selectResults.push(
      [{ disciplinaId: 'disciplina-1', nome: 'Tópico' }],
      []
    );

    const resultado = await injetarTopicoNoCiclo('topico-1');

    expect(resultado.sucesso).toBe(false);
    expect(mocks.requireRole).toHaveBeenCalledWith('estudante');
    expect(mocks.eq).toHaveBeenCalledWith(ciclos.estudantePerfilId, 'estudante-1');
  });

  it('reordena e insere o bloco atomicamente para suportar a unicidade futura', async () => {
    mocks.selectResults.push(
      [{ disciplinaId: 'disciplina-1', nome: 'Tópico' }],
      [{ id: 'ciclo-1' }],
      [{ proximaOrdem: 2 }],
      [{ maiorOrdem: 5 }]
    );

    const resultado = await injetarTopicoNoCiclo('topico-1');

    expect(resultado.sucesso).toBe(true);
    expect(mocks.updateWhere).toHaveBeenCalledTimes(2);
    expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      cicloId: 'ciclo-1',
      ordem: 2,
      disciplinaId: 'disciplina-1'
    }));
  });
});
