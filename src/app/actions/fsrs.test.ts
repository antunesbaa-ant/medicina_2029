import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FSRS, Card as FSRSCard, Rating, State } from 'ts-fsrs';
import { obterCardsParaRevisao, registrarRevisaoCard } from './fsrs';

const PERFIL_1_ID = '10000000-0000-4000-8000-000000000001';
const CARD_1_ID = '50000000-0000-4000-8000-000000000001';
const CARD_INEXISTENTE_ID = '50000000-0000-4000-8000-000000000099';
const TOPICO_1_ID = '31000000-0000-4000-8000-000000000001';

vi.mock('../../lib/authorization', () => ({
  requireRole: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001',
    papel: 'estudante',
  }),
}));

const dbDouble = vi.hoisted(() => {
  type Result = unknown[] | Error;
  const queues = { select: [] as Result[], update: [] as Result[], insert: [] as Result[] };
  const next = (kind: keyof typeof queues) => queues[kind].shift() ?? [];
  const makeQuery = (result: Result) => {
    const query: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit', 'orderBy', 'innerJoin', 'for', 'set', 'values', 'returning']) {
      query[method] = vi.fn(() => query);
    }
    query.then = (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => (
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    ).then(resolve, reject);
    return query;
  };

  const db: Record<string, unknown> = {};
  db.select = vi.fn(() => makeQuery(next('select')));
  db.update = vi.fn(() => makeQuery(next('update')));
  db.insert = vi.fn(() => makeQuery(next('insert')));
  db.transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db));
  return { db, queues };
});

vi.mock('../../db', () => ({ db: dbDouble.db }));

const cardPendente = {
  id: CARD_1_ID, perfilId: PERFIL_1_ID, topicoId: TOPICO_1_ID, frente: 'Frente', verso: 'Verso',
  origem: 'manual', status: 'aprovado', suspenso: false, fonteChunkIds: null,
  due: new Date('2026-10-20T10:00:00Z'), stability: 1, difficulty: 5,
  elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: 'new', lastReview: null,
};

describe('FSRS Spaced Repetition Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbDouble.queues.select.length = 0;
    dbDouble.queues.update.length = 0;
    dbDouble.queues.insert.length = 0;
  });

  it('diferencia ausência real de cards de falha de consulta', async () => {
    dbDouble.queues.select.push([]);
    await expect(obterCardsParaRevisao()).resolves.toEqual([]);

    dbDouble.queues.select.push(new Error('connection string secreta'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(obterCardsParaRevisao()).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR', message: 'Não foi possível carregar os cards para revisão.',
    });
    consoleError.mockRestore();
  });

  it('falha sem efeitos ao registrar card inexistente', async () => {
    dbDouble.queues.select.push([]);
    await expect(registrarRevisaoCard(CARD_INEXISTENTE_ID, 'good', 2500)).resolves.toEqual({
      sucesso: false, code: 'NOT_FOUND', mensagem: 'Registro não encontrado ou acesso não permitido.',
    });
    expect(dbDouble.db.update).not.toHaveBeenCalled();
    expect(dbDouble.db.insert).not.toHaveBeenCalled();
  });

  it('rejeita UUID inválido, rating inválido ou duração fora dos limites sem acessar o banco', async () => {
    await expect(registrarRevisaoCard('card-invalido', 'good', 2500)).resolves.toMatchObject({
      sucesso: false, code: 'VALIDATION_ERROR',
    });
    await expect(
      registrarRevisaoCard(CARD_1_ID, 'invalido' as unknown as 'good', 2500)
    ).resolves.toMatchObject({
      sucesso: false, code: 'VALIDATION_ERROR',
    });
    await expect(registrarRevisaoCard(CARD_1_ID, 'good', 0)).resolves.toMatchObject({
      sucesso: false, code: 'VALIDATION_ERROR',
    });
    await expect(registrarRevisaoCard(CARD_1_ID, 'good', 5_000_000)).resolves.toMatchObject({
      sucesso: false, code: 'VALIDATION_ERROR',
    });
    expect(dbDouble.db.transaction).not.toHaveBeenCalled();
    expect(dbDouble.db.update).not.toHaveBeenCalled();
    expect(dbDouble.db.insert).not.toHaveBeenCalled();
  });

  it('rejeita revisão de card suspenso ou não aprovado sem escrever', async () => {
    dbDouble.queues.select.push([{ ...cardPendente, suspenso: true }]);
    await expect(registrarRevisaoCard(CARD_1_ID, 'good', 2500)).resolves.toMatchObject({
      sucesso: false, code: 'CONFLICT',
    });
    expect(dbDouble.db.update).not.toHaveBeenCalled();
    expect(dbDouble.db.insert).not.toHaveBeenCalled();
  });

  it('confirma update e histórico dentro de uma única transação', async () => {
    dbDouble.queues.select.push([cardPendente]);
    dbDouble.queues.update.push([{ id: CARD_1_ID }]);
    dbDouble.queues.insert.push([{ id: '51000000-0000-4000-8000-000000000001' }]);

    const res = await registrarRevisaoCard(CARD_1_ID, 'good', 2500);
    expect(res.sucesso).toBe(true);
    expect(dbDouble.db.transaction).toHaveBeenCalledOnce();
    expect(dbDouble.db.update).toHaveBeenCalledOnce();
    expect(dbDouble.db.insert).toHaveBeenCalledOnce();
  });

  it('falha a transação quando o histórico não é confirmado', async () => {
    dbDouble.queues.select.push([cardPendente]);
    dbDouble.queues.update.push([{ id: CARD_1_ID }]);
    dbDouble.queues.insert.push([]);
    await expect(registrarRevisaoCard(CARD_1_ID, 'good', 2500)).resolves.toMatchObject({
      sucesso: false, code: 'PERSISTENCE_ERROR',
    });
  });

  it('trata retry idêntico como sucesso idempotente sem nova escrita', async () => {
    const revisadoEm = new Date();
    dbDouble.queues.select.push(
      [{ ...cardPendente, lastReview: revisadoEm, due: new Date(Date.now() + 86_400_000) }],
      [{ revisadoEm, rating: 'good', duracaoMs: 2500 }],
    );

    await expect(registrarRevisaoCard(CARD_1_ID, 'good', 2500)).resolves.toMatchObject({
      sucesso: true, idempotente: true,
    });
    expect(dbDouble.db.update).not.toHaveBeenCalled();
    expect(dbDouble.db.insert).not.toHaveBeenCalled();
  });

  it('rejeita payload concorrente divergente para card já reagendado', async () => {
    const revisadoEm = new Date();
    dbDouble.queues.select.push(
      [{ ...cardPendente, lastReview: revisadoEm, due: new Date(Date.now() + 86_400_000) }],
      [{ revisadoEm, rating: 'good', duracaoMs: 2500 }],
    );

    await expect(registrarRevisaoCard(CARD_1_ID, 'easy', 2600)).resolves.toMatchObject({
      sucesso: false, code: 'CONFLICT',
    });
    expect(dbDouble.db.update).not.toHaveBeenCalled();
    expect(dbDouble.db.insert).not.toHaveBeenCalled();
  });

  it('instancia ts-fsrs corretamente', () => {
    const f = new FSRS({});
    const card: FSRSCard = {
      due: new Date(), stability: 1, difficulty: 5, elapsed_days: 0,
      scheduled_days: 0, reps: 0, lapses: 0, state: State.New,
      last_review: undefined, learning_steps: 0,
    };
    expect(f.repeat(card, new Date())[Rating.Good].card.stability).toBeGreaterThan(0);
  });
});
