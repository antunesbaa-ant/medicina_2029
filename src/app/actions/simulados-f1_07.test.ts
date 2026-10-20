import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registrarSimulado } from './simulados';

const mocks = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  insertResults: [] as unknown[][],
  insert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../lib/authorization', () => ({
  requireRole: vi.fn().mockResolvedValue({ id: 'perfil-1', papel: 'estudante' }),
}));

vi.mock('../../db', () => ({
  db: (() => {
    const database = {
      execute: vi.fn().mockResolvedValue([]),
    select: vi.fn(() => {
      const query = {
        from: vi.fn().mockReturnThis(),
        leftJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(mocks.selectResults.shift() ?? []).then(resolve),
      };
      return query;
    }),
    insert: mocks.insert.mockImplementation(() => {
      const query = {
        values: vi.fn().mockReturnThis(),
        returning: vi.fn(async () => mocks.insertResults.shift() ?? []),
      };
      return query;
    }),
      transaction: mocks.transaction,
    };
    mocks.transaction.mockImplementation(async (callback) => callback(database));
    return database;
  })(),
}));

const entrada = {
  formato: 'enem' as const,
  data: '2026-10-20',
  condicoesReais: true,
  duracaoMin: 270,
  local: 'Casa',
  composicaoProcedencia: { origem: 'fictícia' },
  areas: [{ area: 'Natureza', acertos: 30, total: 45 }],
};

describe('F1.07 - contrato de simulados', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults = [[]];
    mocks.insertResults = [];
  });

  it('não confirma simulado quando o INSERT principal não retorna registro', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(registrarSimulado(entrada)).resolves.toMatchObject({ ok: false, code: 'PERSISTENCE_ERROR' });
    consoleError.mockRestore();
  });

  it('não apresenta análise simulada como concluída', async () => {
    mocks.insertResults = [[{ id: 'simulado-1' }], [{ id: 'area-1' }]];
    await expect(registrarSimulado(entrada)).resolves.toEqual({
      ok: true,
      data: { simuladoId: 'simulado-1', analiseStatus: 'pendente' },
    });
    expect(mocks.insert).toHaveBeenCalledTimes(2);
  });

  it('comunica conclusão parcial quando uma área não é confirmada', async () => {
    mocks.insertResults = [[{ id: 'simulado-1' }], []];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(registrarSimulado(entrada)).resolves.toMatchObject({ ok: false, code: 'PERSISTENCE_ERROR' });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it('rejeita totais inválidos antes de qualquer escrita', async () => {
    const result = await registrarSimulado({ ...entrada, areas: [{ area: 'Natureza', acertos: 1, total: 0 }] });
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('serializa a verificação e recusa repetição quando já existe análise pendente', async () => {
    mocks.selectResults = [[{ id: 'simulado-anterior', analiseConcluida: false }]];

    await expect(registrarSimulado(entrada)).resolves.toMatchObject({ ok: false, code: 'CONFLICT' });

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
