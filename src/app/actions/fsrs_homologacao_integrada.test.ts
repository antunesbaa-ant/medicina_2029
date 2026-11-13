import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FSRS, Card as FSRSCard, Rating, State } from 'ts-fsrs';
import { obterCardsParaRevisao, registrarRevisaoCard } from './fsrs';
import { applyRlsContext } from '../../db/rls-context';
import { AuthorizationError } from '../../lib/authorization';

const {
  ESTUDANTE_ALICE_ID,
  ESTUDANTE_BRUNO_ID,
  RESPONSAVEL_RODRIGO_ID,
  TOPICO_1_ID,
  DISCIPLINA_1_ID,
  CARD_ALICE_NEW_ID,
  CARD_ALICE_REVIEW_ID,
  CARD_ALICE_LEARNING_ID,
  CARD_ALICE_RELEARNING_ID,
  CARD_BRUNO_ID,
  mockState,
} = vi.hoisted(() => {
  const ESTUDANTE_ALICE_ID = '10000000-0000-4000-8000-000000000001';
  const ESTUDANTE_BRUNO_ID = '10000000-0000-4000-8000-000000000002';
  const RESPONSAVEL_RODRIGO_ID = '20000000-0000-4000-8000-000000000001';
  const TOPICO_1_ID = '31000000-0000-4000-8000-000000000001';
  const DISCIPLINA_1_ID = '30000000-0000-4000-8000-000000000001';

  const CARD_ALICE_NEW_ID = '50000000-0000-4000-8000-000000000001';
  const CARD_ALICE_REVIEW_ID = '50000000-0000-4000-8000-000000000002';
  const CARD_ALICE_LEARNING_ID = '50000000-0000-4000-8000-000000000003';
  const CARD_ALICE_RELEARNING_ID = '50000000-0000-4000-8000-000000000004';
  const CARD_BRUNO_ID = '50000000-0000-4000-8000-000000000005';

  interface CapturedUpdate {
    set: Record<string, unknown>;
  }

  interface CapturedInsert {
    values: Record<string, unknown>;
  }

  const mockState = {
    currentProfile: {
      id: ESTUDANTE_ALICE_ID,
      papel: 'estudante' as 'estudante' | 'responsavel',
      nome: 'Alice Estudante',
      email: 'alice@medicina2029.staging',
    } as { id: string; papel: 'estudante' | 'responsavel'; nome: string; email: string } | null,
    selectQueue: [] as Array<unknown[] | Error>,
    updateQueue: [] as Array<unknown[] | Error>,
    insertQueue: [] as Array<unknown[] | Error>,
    capturedUpdates: [] as CapturedUpdate[],
    capturedInserts: [] as CapturedInsert[],
    lockedWithForUpdate: false,
    transactionCount: 0,
  };

  return {
    ESTUDANTE_ALICE_ID,
    ESTUDANTE_BRUNO_ID,
    RESPONSAVEL_RODRIGO_ID,
    TOPICO_1_ID,
    DISCIPLINA_1_ID,
    CARD_ALICE_NEW_ID,
    CARD_ALICE_REVIEW_ID,
    CARD_ALICE_LEARNING_ID,
    CARD_ALICE_RELEARNING_ID,
    CARD_BRUNO_ID,
    mockState,
  };
});

// Mock de autorização
vi.mock('../../lib/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/authorization')>();
  return {
    ...actual,
    requireRole: vi.fn(async (expectedRole: 'estudante' | 'responsavel') => {
      if (!mockState.currentProfile) {
        throw new actual.AuthorizationError('UNAUTHENTICATED');
      }
      if (mockState.currentProfile.papel !== expectedRole) {
        throw new actual.AuthorizationError('FORBIDDEN');
      }
      return mockState.currentProfile;
    }),
  };
});

// Mock do RLS Context
vi.mock('../../db/rls-context', () => ({
  applyRlsContext: vi.fn(async (tx: unknown, perfilId: string, papel: string) => {
    if (!perfilId) {
      throw new Error('RLS Context Error: perfilId é obrigatório');
    }
  }),
  isRlsEnforced: vi.fn().mockReturnValue(true),
}));

// Mock do banco de dados Drizzle
const dbDouble = vi.hoisted(() => {
  type Result = unknown[] | Error;

  const makeQuery = (
    kind: 'select' | 'update' | 'insert',
    getQueue: () => Array<Result>,
    onSet?: (val: Record<string, unknown>) => void,
    onValues?: (val: Record<string, unknown>) => void
  ) => {
    const query: Record<string, unknown> = {};

    for (const method of ['from', 'where', 'limit', 'orderBy', 'innerJoin', 'for', 'returning']) {
      query[method] = vi.fn((arg?: unknown) => {
        if (method === 'for' && arg === 'update') {
          mockState.lockedWithForUpdate = true;
        }
        return query;
      });
    }

    query.set = vi.fn((val: Record<string, unknown>) => {
      if (onSet) onSet(val);
      return query;
    });

    query.values = vi.fn((val: Record<string, unknown>) => {
      if (onValues) onValues(val);
      return query;
    });

    query.then = (resolve: (val: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => {
      const q = getQueue();
      const nextResult = q.shift() ?? (kind === 'select' ? [] : [{ id: 'auto-generated-id' }]);
      return (nextResult instanceof Error ? Promise.reject(nextResult) : Promise.resolve(nextResult)).then(
        resolve,
        reject
      );
    };

    return query;
  };

  const db: Record<string, unknown> = {};

  db.select = vi.fn(() => makeQuery('select', () => mockState.selectQueue));
  db.update = vi.fn(() =>
    makeQuery(
      'update',
      () => mockState.updateQueue,
      (setPayload) => {
        mockState.capturedUpdates.push({ set: setPayload });
      }
    )
  );
  db.insert = vi.fn(() =>
    makeQuery(
      'insert',
      () => mockState.insertQueue,
      undefined,
      (valuesPayload) => {
        mockState.capturedInserts.push({ values: valuesPayload });
      }
    )
  );

  db.transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    mockState.transactionCount++;
    return cb(db);
  });

  return { db };
});

vi.mock('../../db', () => ({ db: dbDouble.db }));

function criarCardDb(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: CARD_ALICE_NEW_ID,
    perfilId: ESTUDANTE_ALICE_ID,
    topicoId: TOPICO_1_ID,
    frente: 'Qual a primeira lei de Mendel?',
    verso: 'Lei da Segregação dos Fatores.',
    origem: 'manual',
    status: 'aprovado',
    suspenso: false,
    fonteChunkIds: null,
    due: new Date(now.getTime() - 3600_000), // 1 hora atrás (vencido / due)
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 'new',
    lastReview: null,
    ...overrides,
  };
}

describe('MEDICINA 2029 — Suíte de Homologação Integrada FSRS e Persistência RLS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.currentProfile = {
      id: ESTUDANTE_ALICE_ID,
      papel: 'estudante',
      nome: 'Alice Estudante',
      email: 'alice@medicina2029.staging',
    };
    mockState.selectQueue.length = 0;
    mockState.updateQueue.length = 0;
    mockState.insertQueue.length = 0;
    mockState.capturedUpdates.length = 0;
    mockState.capturedInserts.length = 0;
    mockState.lockedWithForUpdate = false;
    mockState.transactionCount = 0;
  });

  // =========================================================================
  // BLOCO 1: RLS e Obtenção de Cards para Revisão (obterCardsParaRevisao)
  // =========================================================================
  describe('1. RLS e Obtenção de Cards para Revisão (obterCardsParaRevisao)', () => {
    it('1.1 executa consulta estritamente sob db.transaction e invoca applyRlsContext com perfilId e papel', async () => {
      const cardAlice = {
        ...criarCardDb(),
        topicoNome: 'Genética Clássica',
        disciplinaNome: 'Biologia',
        corHex: '#10B981',
      };
      mockState.selectQueue.push([cardAlice]);

      const resultado = await obterCardsParaRevisao();

      expect(resultado).toHaveLength(1);
      expect(resultado[0].id).toBe(CARD_ALICE_NEW_ID);
      expect(resultado[0].disciplinaNome).toBe('Biologia');
      expect(resultado[0].corHex).toBe('#10B981');

      // Verificação RLS Mandatória
      expect(mockState.transactionCount).toBe(1);
      expect(applyRlsContext).toHaveBeenCalledWith(
        expect.anything(),
        ESTUDANTE_ALICE_ID,
        'estudante'
      );
    });

    it('1.2 propaga AuthorizationError sem mascarar como PERSISTENCE_ERROR caso estudante não esteja autenticado', async () => {
      mockState.currentProfile = null;

      await expect(obterCardsParaRevisao()).rejects.toThrow(AuthorizationError);
      await expect(obterCardsParaRevisao()).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      expect(mockState.transactionCount).toBe(0);
    });

    it('1.3 propaga AuthorizationError com code FORBIDDEN se papel for responsavel', async () => {
      mockState.currentProfile = {
        id: RESPONSAVEL_RODRIGO_ID,
        papel: 'responsavel',
        nome: 'Rodrigo Responsavel',
        email: 'rodrigo@medicina2029.staging',
      };

      await expect(obterCardsParaRevisao()).rejects.toThrow(AuthorizationError);
      await expect(obterCardsParaRevisao()).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(mockState.transactionCount).toBe(0);
    });

    it('1.4 encapsula erro de infraestrutura do Postgres em PublicOperationError PERSISTENCE_ERROR', async () => {
      mockState.selectQueue.push(new Error('Connection terminated unexpectedly'));

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await expect(obterCardsParaRevisao()).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
        message: 'Não foi possível carregar os cards para revisão.',
      });
      consoleError.mockRestore();
    });
  });

  // =========================================================================
  // BLOCO 2: Autorização, Isolamento Multi-Inquilino e Elegibilidade
  // =========================================================================
  describe('2. Autorização, Isolamento Multi-Inquilino e Elegibilidade', () => {
    it('2.1 bloqueia responsável de executar registrarRevisaoCard com AuthorizationError FORBIDDEN', async () => {
      mockState.currentProfile = {
        id: RESPONSAVEL_RODRIGO_ID,
        papel: 'responsavel',
        nome: 'Rodrigo Responsavel',
        email: 'rodrigo@medicina2029.staging',
      };

      await expect(
        registrarRevisaoCard(CARD_ALICE_NEW_ID, 'good', 3000)
      ).rejects.toThrow(AuthorizationError);

      await expect(
        registrarRevisaoCard(CARD_ALICE_NEW_ID, 'good', 3000)
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      expect(mockState.transactionCount).toBe(0);
      expect(mockState.capturedUpdates).toHaveLength(0);
      expect(mockState.capturedInserts).toHaveLength(0);
    });

    it('2.2 barra tentativa de estudante revisar card de outro estudante (isolamento multi-inquilino)', async () => {
      // Alice autenticada tenta revisar card que não pertence a ela
      mockState.selectQueue.push([]); // Where filtro perfilId = Alice retorna vazio para card do Bruno

      const res = await registrarRevisaoCard(CARD_BRUNO_ID, 'good', 2500);

      expect(res).toEqual({
        sucesso: false,
        code: 'NOT_FOUND',
        mensagem: 'Registro não encontrado ou acesso não permitido.',
      });

      expect(mockState.capturedUpdates).toHaveLength(0);
      expect(mockState.capturedInserts).toHaveLength(0);
    });

    it('2.3 rejeita card suspenso com CONFLICT sem alterar o banco', async () => {
      mockState.selectQueue.push([criarCardDb({ suspenso: true })]);

      const res = await registrarRevisaoCard(CARD_ALICE_NEW_ID, 'good', 2500);

      expect(res).toEqual({
        sucesso: false,
        code: 'CONFLICT',
        mensagem: 'Este card não está elegível para revisão.',
      });

      expect(mockState.capturedUpdates).toHaveLength(0);
      expect(mockState.capturedInserts).toHaveLength(0);
    });

    it('2.4 rejeita card com status pendente ou rejeitado com CONFLICT sem alterar o banco', async () => {
      mockState.selectQueue.push([criarCardDb({ status: 'pendente' })]);

      const res = await registrarRevisaoCard(CARD_ALICE_NEW_ID, 'good', 2500);

      expect(res).toEqual({
        sucesso: false,
        code: 'CONFLICT',
        mensagem: 'Este card não está elegível para revisão.',
      });

      expect(mockState.capturedUpdates).toHaveLength(0);
      expect(mockState.capturedInserts).toHaveLength(0);
    });
  });

  // =========================================================================
  // BLOCO 3: Concorrência com Lock Pessimista e Idempotência de Retry
  // =========================================================================
  describe('3. Concorrência e Idempotência', () => {
    it('3.1 protege leitura do card com lock pessimista for update dentro da transação', async () => {
      mockState.selectQueue.push([criarCardDb()]);
      mockState.updateQueue.push([{ id: CARD_ALICE_NEW_ID }]);
      mockState.insertQueue.push([{ id: 'rev-001' }]);

      await registrarRevisaoCard(CARD_ALICE_NEW_ID, 'good', 2500);

      expect(mockState.lockedWithForUpdate).toBe(true);
      expect(mockState.transactionCount).toBe(1);
    });

    it('3.2 reconhece retry idêntico (mesmo card, rating e timestamp) como sucesso idempotente sem gravar duplicatas', async () => {
      const revisadoEm = new Date('2026-11-13T10:00:00Z');
      const dueFuturo = new Date('2026-11-16T10:00:00Z');

      // Card já reagendado no futuro
      mockState.selectQueue.push([
        criarCardDb({
          lastReview: revisadoEm,
          due: dueFuturo,
          state: 'review',
          stability: 5.2,
          reps: 1,
        }),
      ]);

      // Último log de revisão gravado coincide perfeitamente com a requisição
      mockState.selectQueue.push([
        {
          revisadoEm,
          rating: 'good',
        },
      ]);

      const res = await registrarRevisaoCard(CARD_ALICE_NEW_ID, 'good', 2500);

      expect(res.sucesso).toBe(true);
      expect(res.idempotente).toBe(true);
      expect(res.mensagem).toContain('Card já revisado.');

      // Garante que NENHUM novo update ou insert foi executado
      expect(mockState.capturedUpdates).toHaveLength(0);
      expect(mockState.capturedInserts).toHaveLength(0);
    });

    it('3.3 rejeita com CONFLICT requisição para card já reagendado se o payload divergente (outro rating)', async () => {
      const revisadoEm = new Date('2026-11-13T10:00:00Z');
      const dueFuturo = new Date('2026-11-16T10:00:00Z');

      mockState.selectQueue.push([
        criarCardDb({
          lastReview: revisadoEm,
          due: dueFuturo,
          state: 'review',
        }),
      ]);

      mockState.selectQueue.push([
        {
          revisadoEm,
          rating: 'good',
        },
      ]);

      const res = await registrarRevisaoCard(CARD_ALICE_NEW_ID, 'easy', 2500);

      expect(res).toEqual({
        sucesso: false,
        code: 'CONFLICT',
        mensagem: 'Este card já foi revisado e teve seu agendamento atualizado.',
      });

      expect(mockState.capturedUpdates).toHaveLength(0);
      expect(mockState.capturedInserts).toHaveLength(0);
    });
  });

  // =========================================================================
  // BLOCO 4: Cálculo Matemático FSRS para todos os 4 Ratings
  // =========================================================================
  describe('4. Cálculo Matemático FSRS para todos os 4 Ratings (again, hard, good, easy)', () => {
    it('4.1 rating "again": calcula estabilidade > 0, dificuldade alta, reps = 1 e estado learning', async () => {
      mockState.selectQueue.push([criarCardDb({ state: 'new', reps: 0, lapses: 0 })]);
      mockState.updateQueue.push([{ id: CARD_ALICE_NEW_ID }]);
      mockState.insertQueue.push([{ id: 'rev-again-01' }]);

      const res = await registrarRevisaoCard(CARD_ALICE_NEW_ID, 'again', 4500);

      expect(res.sucesso).toBe(true);
      expect(mockState.capturedUpdates).toHaveLength(1);
      expect(mockState.capturedInserts).toHaveLength(1);

      const updateData = mockState.capturedUpdates[0].set;
      expect(Number(updateData.stability)).toBeGreaterThan(0);
      expect(Number(updateData.difficulty)).toBeGreaterThanOrEqual(1);
      expect(Number(updateData.difficulty)).toBeLessThanOrEqual(10);
      expect(updateData.reps).toBe(1);
      expect(updateData.lapses).toBe(0);
      expect(updateData.state).toBe('learning');
      expect(new Date(updateData.due as Date).getTime()).toBeGreaterThan(Date.now() - 5000);

      const insertData = mockState.capturedInserts[0].values;
      expect(insertData.cardId).toBe(CARD_ALICE_NEW_ID);
      expect(insertData.rating).toBe('again');
      expect(insertData.stateAnterior).toBe('new');
      expect(insertData.duracaoMs).toBe(4500);
    });

    it('4.2 rating "hard": calcula estabilidade > again, dificuldade moderada-alta, reps = 1 e estado learning', async () => {
      mockState.selectQueue.push([criarCardDb({ state: 'new', reps: 0 })]);
      mockState.updateQueue.push([{ id: CARD_ALICE_NEW_ID }]);
      mockState.insertQueue.push([{ id: 'rev-hard-01' }]);

      const res = await registrarRevisaoCard(CARD_ALICE_NEW_ID, 'hard', 3500);

      expect(res.sucesso).toBe(true);
      const updateData = mockState.capturedUpdates[0].set;
      expect(Number(updateData.stability)).toBeGreaterThan(0.2); // Hard stability > Again stability
      expect(Number(updateData.difficulty)).toBeGreaterThanOrEqual(1);
      expect(Number(updateData.difficulty)).toBeLessThanOrEqual(10);
      expect(updateData.reps).toBe(1);
      expect(updateData.state).toBe('learning');
    });

    it('4.3 rating "good": calcula estabilidade intermediária-alta, dificuldade moderada e agendamento futuro', async () => {
      mockState.selectQueue.push([criarCardDb({ state: 'new', reps: 0 })]);
      mockState.updateQueue.push([{ id: CARD_ALICE_NEW_ID }]);
      mockState.insertQueue.push([{ id: 'rev-good-01' }]);

      const res = await registrarRevisaoCard(CARD_ALICE_NEW_ID, 'good', 2200);

      expect(res.sucesso).toBe(true);
      const updateData = mockState.capturedUpdates[0].set;
      expect(Number(updateData.stability)).toBeGreaterThan(1.0);
      expect(Number(updateData.difficulty)).toBeGreaterThanOrEqual(1);
      expect(Number(updateData.difficulty)).toBeLessThanOrEqual(10);
      expect(updateData.reps).toBe(1);
      expect(updateData.state).toBe('learning');
    });

    it('4.4 rating "easy": calcula estabilidade máxima inicial, dificuldade mínima e promove diretamente para review', async () => {
      mockState.selectQueue.push([criarCardDb({ state: 'new', reps: 0 })]);
      mockState.updateQueue.push([{ id: CARD_ALICE_NEW_ID }]);
      mockState.insertQueue.push([{ id: 'rev-easy-01' }]);

      const res = await registrarRevisaoCard(CARD_ALICE_NEW_ID, 'easy', 1800);

      expect(res.sucesso).toBe(true);
      const updateData = mockState.capturedUpdates[0].set;
      expect(Number(updateData.stability)).toBeGreaterThan(5.0); // Easy stability é a mais alta
      expect(Number(updateData.difficulty)).toBeGreaterThanOrEqual(1);
      expect(Number(updateData.difficulty)).toBeLessThanOrEqual(5);
      expect(updateData.reps).toBe(1);
      // FSRS promove imediatamente para 'review' ao receber Easy no estado New
      expect(updateData.state).toBe('review');
    });
  });

  // =========================================================================
  // BLOCO 5: Transições de Estado FSRS e Detecção de Falhas (Lapses)
  // =========================================================================
  describe('5. Transições de Estado FSRS e Falhas (Lapses)', () => {
    it('5.1 transição learning -> review: card em learning promovido para review via easy', async () => {
      const cardLearning = criarCardDb({
        id: CARD_ALICE_LEARNING_ID,
        state: 'learning',
        stability: 2.3,
        difficulty: 4.5,
        reps: 1,
        elapsedDays: 1,
        scheduledDays: 1,
      });

      mockState.selectQueue.push([cardLearning]);
      mockState.updateQueue.push([{ id: CARD_ALICE_LEARNING_ID }]);
      mockState.insertQueue.push([{ id: 'rev-learn-review' }]);

      const res = await registrarRevisaoCard(CARD_ALICE_LEARNING_ID, 'easy', 2000);

      expect(res.sucesso).toBe(true);
      const updateData = mockState.capturedUpdates[0].set;
      expect(updateData.state).toBe('review');
      expect(updateData.reps).toBe(2);
      expect(Number(updateData.stability)).toBeGreaterThan(cardLearning.stability);
    });

    it('5.2 transição review -> relearning com incremento de lapses: falha (again) em card consolidado', async () => {
      const cardReview = criarCardDb({
        id: CARD_ALICE_REVIEW_ID,
        state: 'review',
        stability: 6.8,
        difficulty: 4.0,
        reps: 3,
        lapses: 0,
        elapsedDays: 5,
        scheduledDays: 5,
      });

      mockState.selectQueue.push([cardReview]);
      mockState.updateQueue.push([{ id: CARD_ALICE_REVIEW_ID }]);
      mockState.insertQueue.push([{ id: 'rev-fail-01' }]);

      const res = await registrarRevisaoCard(CARD_ALICE_REVIEW_ID, 'again', 6000);

      expect(res.sucesso).toBe(true);
      const updateData = mockState.capturedUpdates[0].set;

      // Transição obrigatória para relearning
      expect(updateData.state).toBe('relearning');
      // Lapses deve ser incrementado
      expect(updateData.lapses).toBe(1);
      // Reps incrementado
      expect(updateData.reps).toBe(4);
      // Estabilidade reduzida após esquecimento
      expect(Number(updateData.stability)).toBeLessThan(cardReview.stability);
    });

    it('5.3 transição relearning -> review: recuperação do card após reforço', async () => {
      const cardRelearning = criarCardDb({
        id: CARD_ALICE_RELEARNING_ID,
        state: 'relearning',
        stability: 1.5,
        difficulty: 5.5,
        reps: 4,
        lapses: 1,
        elapsedDays: 1,
        scheduledDays: 1,
      });

      mockState.selectQueue.push([cardRelearning]);
      mockState.updateQueue.push([{ id: CARD_ALICE_RELEARNING_ID }]);
      mockState.insertQueue.push([{ id: 'rev-relearn-recover' }]);

      const res = await registrarRevisaoCard(CARD_ALICE_RELEARNING_ID, 'good', 2500);

      expect(res.sucesso).toBe(true);
      const updateData = mockState.capturedUpdates[0].set;
      // Recuperado com sucesso para review
      expect(updateData.state).toBe('review');
      expect(updateData.lapses).toBe(1); // Não aumenta lapse em acerto
      expect(updateData.reps).toBe(5);
    });

    it('5.4 garante invariantes matemáticas FSRS: stability > 0, 1 <= difficulty <= 10 e due no futuro', async () => {
      const f = new FSRS({});
      const testRatings = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];

      const estados = [State.New, State.Learning, State.Review, State.Relearning];

      for (const st of estados) {
        const card: FSRSCard = {
          due: new Date(),
          stability: st === State.New ? 0 : 3.0,
          difficulty: st === State.New ? 0 : 5.0,
          elapsed_days: 1,
          scheduled_days: 1,
          reps: st === State.New ? 0 : 2,
          lapses: 0,
          state: st,
          last_review: st === State.New ? undefined : new Date(),
          learning_steps: 0,
        };

        const scheduled = f.repeat(card, new Date());
        for (const rating of testRatings) {
          const resultado = scheduled[rating];
          expect(resultado.card.stability).toBeGreaterThan(0);
          expect(resultado.card.difficulty).toBeGreaterThanOrEqual(1);
          expect(resultado.card.difficulty).toBeLessThanOrEqual(10);
          expect(resultado.card.reps).toBe(card.reps + 1);
        }
      }
    });
  });

  // =========================================================================
  // BLOCO 6: Atomicidade Transacional e Rollback
  // =========================================================================
  describe('6. Atomicidade Transacional e Rollback', () => {
    it('6.1 aborta transação e lança PERSISTENCE_ERROR quando inserção de histórico (cardRevisoes) falha', async () => {
      mockState.selectQueue.push([criarCardDb()]);
      mockState.updateQueue.push([{ id: CARD_ALICE_NEW_ID }]);
      mockState.insertQueue.push([]); // Retorno vazio de returning simula falha de persistência

      const res = await registrarRevisaoCard(CARD_ALICE_NEW_ID, 'good', 2500);

      expect(res).toEqual({
        sucesso: false,
        code: 'PERSISTENCE_ERROR',
        mensagem: 'Não foi possível confirmar o histórico da revisão.',
      });
    });

    it('6.2 aborta transação e lança PERSISTENCE_ERROR quando update do card falha', async () => {
      mockState.selectQueue.push([criarCardDb()]);
      mockState.updateQueue.push([]); // Retorno vazio simula falha ao atualizar o card

      const res = await registrarRevisaoCard(CARD_ALICE_NEW_ID, 'good', 2500);

      expect(res).toEqual({
        sucesso: false,
        code: 'PERSISTENCE_ERROR',
        mensagem: 'Não foi possível confirmar a atualização do card.',
      });

      // Se o update falhou, nenhuma inserção de histórico pôde ocorrer
      expect(mockState.capturedInserts).toHaveLength(0);
    });
  });
});
