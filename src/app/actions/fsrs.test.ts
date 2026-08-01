import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registrarRevisaoCard, obterCardsParaRevisao } from './fsrs';
import { FSRS, Card as FSRSCard, State, Rating } from 'ts-fsrs';

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
    then: (resolve: any) => resolve([])
  };
  return { db: queryBuilder };
});

describe('FSRS Spaced Repetition Tests', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deve buscar cards pendentes', async () => {
    const list = await obterCardsParaRevisao();
    expect(Array.isArray(list)).toBe(true);
  });

  it('deve falhar ao registrar revisao de card inexistente', async () => {
    const res = await registrarRevisaoCard('non-existent', 'good', 2500);
    expect(res.sucesso).toBe(false);
  });

  it('deve instanciar ts-fsrs corretamente', () => {
    const f = new FSRS({});
    expect(f).toBeDefined();

    const card: FSRSCard = {
      due: new Date(),
      stability: 1.0,
      difficulty: 5.0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      state: State.New,
      last_review: undefined,
      learning_steps: 0
    };

    const scheduler = f.repeat(card, new Date());
    expect(scheduler[Rating.Good]).toBeDefined();
    expect(scheduler[Rating.Good].card.stability).toBeGreaterThan(0);
  });

});
