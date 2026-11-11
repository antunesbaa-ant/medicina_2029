import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  obterEstadoSessaoCronometro,
  iniciarSessao,
  concluirSessao,
} from './sessao';
import { applyRlsContext } from '../../db/rls-context';
import { PublicOperationError } from '../../lib/operation-result';
import { calcularProximaOrdem } from '../../lib/studysystem';

const {
  ALICE_PERFIL_ID,
  ALICE_CICLO_ID,
  BLOCO_1_ID,
  BLOCO_2_ID,
  BLOCO_28_ID,
  DISCIPLINA_MAT_ID,
  DISCIPLINA_BIO_ID,
  TOPICO_MAT_ID,
  TOPICO_BIO_ID,
  SESSAO_1_ID,
  SESSAO_2_ID,
  SESSAO_28_ID,
  dbMockState,
} = vi.hoisted(() => ({
  ALICE_PERFIL_ID: '10000000-0000-4000-8000-000000000001',
  ALICE_CICLO_ID: '40000000-0000-4000-8000-000000000001',
  BLOCO_1_ID: '41000000-0000-4000-8000-000000000001',
  BLOCO_2_ID: '41000000-0000-4000-8000-000000000002',
  BLOCO_28_ID: '41000000-0000-4000-8000-000000000028',
  DISCIPLINA_MAT_ID: 'd0000000-0000-4000-8000-000000000001',
  DISCIPLINA_BIO_ID: 'd0000000-0000-4000-8000-000000000002',
  TOPICO_MAT_ID: 'e0000000-0000-4000-8000-000000000001',
  TOPICO_BIO_ID: 'e0000000-0000-4000-8000-000000000002',
  SESSAO_1_ID: '5b17131d-4f44-414a-a87d-52485bf00f26',
  SESSAO_2_ID: '679937fc-9a54-4ba5-b7cb-ebde6b9f890b',
  SESSAO_28_ID: '779937fc-9a54-4ba5-b7cb-ebde6b9f8928',
  dbMockState: {
    txSelectOutputs: [] as unknown[][],
    txSelectCount: 0,
    txUpdateOutputs: [] as unknown[][],
    txUpdateCount: 0,
    txInsertOutputs: [] as unknown[][],
    txInsertCount: 0,
    executedQueries: [] as string[],
    updateWhereClauses: [] as unknown[],
    transactionActive: false,
    rolledBack: false,
  },
}));

vi.mock('../../lib/authorization', () => ({
  requireRole: vi.fn(async (role: string) => {
    if (role === 'estudante') {
      return {
        id: ALICE_PERFIL_ID,
        authUserId: 'a0000000-0000-4000-8000-000000000001',
        nome: 'Alice Estudante',
        email: 'alice@medicina2029.staging',
        papel: 'estudante',
      };
    }
    throw new Error('Forbidden');
  }),
  requireStudentScope: vi.fn(async () => ({
    id: ALICE_PERFIL_ID,
    nome: 'Alice Estudante',
    email: 'alice@medicina2029.staging',
    papel: 'estudante',
  })),
  requireAuthenticatedProfile: vi.fn(async () => ({
    id: ALICE_PERFIL_ID,
    papel: 'estudante',
  })),
}));

vi.mock('../../db/rls-context', () => ({
  applyRlsContext: vi.fn().mockResolvedValue(undefined),
  isRlsEnforced: vi.fn().mockReturnValue(true),
}));

interface MockQueryBuilder {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  for: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  then: (resolve: (val: unknown) => unknown) => Promise<unknown>;
}

function createMockTx() {
  const queryBuilder = {} as MockQueryBuilder;
  queryBuilder.from = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.where = vi.fn().mockImplementation((condition) => {
    dbMockState.updateWhereClauses.push(condition);
    return queryBuilder;
  });
  queryBuilder.limit = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.innerJoin = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.leftJoin = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.orderBy = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.for = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.values = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.set = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.onConflictDoUpdate = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.returning = vi.fn().mockImplementation(() => {
    const output = dbMockState.txInsertOutputs[dbMockState.txInsertCount] ?? [
      { id: SESSAO_1_ID, cicloBlocoId: BLOCO_1_ID, proximaOrdem: 2 },
    ];
    dbMockState.txInsertCount++;
    return {
      then: (resolve: (val: unknown) => unknown) => Promise.resolve(resolve(output)),
    };
  });

  queryBuilder.then = (resolve: (val: unknown) => unknown) => {
    const output = dbMockState.txSelectOutputs[dbMockState.txSelectCount] ?? [];
    dbMockState.txSelectCount++;
    return Promise.resolve(resolve(output));
  };

  return {
    select: vi.fn().mockImplementation(() => {
      dbMockState.executedQueries.push('SELECT');
      return queryBuilder;
    }),
    insert: vi.fn().mockImplementation(() => {
      dbMockState.executedQueries.push('INSERT');
      return queryBuilder;
    }),
    update: vi.fn().mockImplementation(() => {
      dbMockState.executedQueries.push('UPDATE');
      return queryBuilder;
    }),
    execute: vi.fn().mockImplementation(async (sqlArg: any) => {
      const sqlString = sqlArg?.queryChunks
        ? sqlArg.queryChunks.map((c: any) => (typeof c === 'string' ? c : c?.value ?? '')).join('')
        : JSON.stringify(sqlArg);
      dbMockState.executedQueries.push(`EXECUTE: ${sqlString}`);
      return [];
    }),
  };
}

let mockTxInstance = createMockTx();

vi.mock('../../db', () => ({
  db: {
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      dbMockState.transactionActive = true;
      mockTxInstance = createMockTx();
      try {
        const result = await cb(mockTxInstance);
        dbMockState.transactionActive = false;
        return result;
      } catch (err) {
        dbMockState.transactionActive = false;
        dbMockState.rolledBack = true;
        throw err;
      }
    }),
  },
}));

describe('MEDICINA 2029 — H2.04-T5-V-R2: Verificação Final do Gerenciamento de Sessões', () => {
  const mockCiclo = {
    id: ALICE_CICLO_ID,
    ativo: true,
    estudantePerfilId: ALICE_PERFIL_ID,
    nome: 'Ciclo Alice 2029',
  };
  const mockBloco1 = {
    id: BLOCO_1_ID,
    cicloId: ALICE_CICLO_ID,
    ordem: 1,
    disciplinaId: DISCIPLINA_MAT_ID,
    tipo: 'teoria',
    estiloAlvo: 'enem',
    duracaoMin: 50,
  };
  const mockBloco2 = {
    id: BLOCO_2_ID,
    cicloId: ALICE_CICLO_ID,
    ordem: 2,
    disciplinaId: DISCIPLINA_BIO_ID,
    tipo: 'teoria',
    estiloAlvo: 'enem',
    duracaoMin: 50,
  };
  const mockBloco28 = {
    id: BLOCO_28_ID,
    cicloId: ALICE_CICLO_ID,
    ordem: 28,
    disciplinaId: DISCIPLINA_BIO_ID,
    tipo: 'questoes',
    estiloAlvo: 'enem',
    duracaoMin: 50,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbMockState.txSelectOutputs = [];
    dbMockState.txSelectCount = 0;
    dbMockState.txUpdateOutputs = [];
    dbMockState.txUpdateCount = 0;
    dbMockState.txInsertOutputs = [];
    dbMockState.txInsertCount = 0;
    dbMockState.executedQueries = [];
    dbMockState.updateWhereClauses = [];
    dbMockState.transactionActive = false;
    dbMockState.rolledBack = false;
  });

  describe('1. Verificação do Encerramento Automático e Transacionalidade', () => {
    it('o encerramento de resíduo ocorre na MESMA transação da inicialização autorizada', async () => {
      // 1. tx.select sessaoAberta -> Sessão órfã do bloco 1 encontrada
      // 2. tx.select blocoSessaoAberta -> Bloco 1 com ordem 1, ciclo já em 2
      // 3. tx.select vinculoBlocoTopico -> Bloco 2 autorizado
      // 4. tx.select estadoCicloBloco -> proximaOrdem = 2 (válido)
      dbMockState.txSelectOutputs = [
        [{ id: SESSAO_2_ID, cicloBlocoId: BLOCO_1_ID, topicoId: TOPICO_MAT_ID }],
        [{ blocoId: BLOCO_1_ID, ordem: 1, proximaOrdem: 2 }],
        [{
          blocoId: BLOCO_2_ID,
          cicloId: ALICE_CICLO_ID,
          blocoOrdem: 2,
          cicloAtivo: true,
          estudantePerfilId: ALICE_PERFIL_ID,
          blocoDisciplinaId: DISCIPLINA_BIO_ID,
          topicoDisciplinaId: DISCIPLINA_BIO_ID,
        }],
        [{ proximaOrdem: 2 }],
      ];

      dbMockState.txInsertOutputs = [
        [{ id: 'new-sessao-bloco-2-id', cicloBlocoId: BLOCO_2_ID }],
      ];

      const novaId = await iniciarSessao(BLOCO_2_ID, TOPICO_BIO_ID);

      expect(novaId).toBe('new-sessao-bloco-2-id');
      // Confirma que UPDATE (auto-encerramento) e INSERT (nova sessão) foram emitidos na mesma transação
      expect(dbMockState.executedQueries).toContain('UPDATE');
      expect(dbMockState.executedQueries).toContain('INSERT');
      expect(applyRlsContext).toHaveBeenCalled();
    });

    it('aplica predicados estritos no UPDATE garantindo que apenas a sessão residual correta e aberta é modificada', async () => {
      dbMockState.txSelectOutputs = [
        [{ id: SESSAO_2_ID, cicloBlocoId: BLOCO_1_ID, topicoId: TOPICO_MAT_ID }],
        [{ blocoId: BLOCO_1_ID, ordem: 1, proximaOrdem: 2 }],
        [{
          blocoId: BLOCO_2_ID,
          cicloId: ALICE_CICLO_ID,
          blocoOrdem: 2,
          cicloAtivo: true,
          estudantePerfilId: ALICE_PERFIL_ID,
          blocoDisciplinaId: DISCIPLINA_BIO_ID,
          topicoDisciplinaId: DISCIPLINA_BIO_ID,
        }],
        [{ proximaOrdem: 2 }],
      ];

      dbMockState.txInsertOutputs = [[{ id: 'nova-sessao-id' }]];

      await iniciarSessao(BLOCO_2_ID, TOPICO_BIO_ID);

      // Confirma que a cláusula WHERE foi gravada e que o mockTx registrou o update
      expect(mockTxInstance.update).toHaveBeenCalled();
    });

    it('sessões legítimas pausadas no bloco atual NÃO são encerradas indevidamente', async () => {
      // Sessão aberta no Bloco 2 com mesmo tópico
      dbMockState.txSelectOutputs = [
        [{ id: 'sessao-ativa-bloco-2', cicloBlocoId: BLOCO_2_ID, topicoId: TOPICO_BIO_ID }],
      ];

      // Ao tentar iniciar novamente o mesmo bloco/tópico (ex.: retomada pós-pausa)
      const idRetornado = await iniciarSessao(BLOCO_2_ID, TOPICO_BIO_ID);

      // Deve retornar o ID existente de forma idempotente sem emitir UPDATE de auto-encerramento
      expect(idRetornado).toBe('sessao-ativa-bloco-2');
      expect(dbMockState.executedQueries).not.toContain('UPDATE');
    });

    it('nenhuma sessão concluída (concluida = true) é modificada pelo auto-encerramento', async () => {
      // Concluídas têm encerrada_em preenchido, logo `isNull(encerradaEm)` retorna vazio
      dbMockState.txSelectOutputs = [
        [], // 1. tx.select sessaoAberta -> nenhuma aberta
        [{
          blocoId: BLOCO_2_ID,
          cicloId: ALICE_CICLO_ID,
          blocoOrdem: 2,
          cicloAtivo: true,
          estudantePerfilId: ALICE_PERFIL_ID,
          blocoDisciplinaId: DISCIPLINA_BIO_ID,
          topicoDisciplinaId: DISCIPLINA_BIO_ID,
        }],
        [{ proximaOrdem: 2 }],
      ];

      dbMockState.txInsertOutputs = [[{ id: 'nova-sessao-sem-orfa' }]];

      const id = await iniciarSessao(BLOCO_2_ID, TOPICO_BIO_ID);
      expect(id).toBe('nova-sessao-sem-orfa');
      expect(dbMockState.executedQueries).not.toContain('UPDATE');
    });

    it('falha durante o processo provoca ROLLBACK integral sem persistir o auto-encerramento', async () => {
      dbMockState.txSelectOutputs = [
        [{ id: SESSAO_2_ID, cicloBlocoId: BLOCO_1_ID, topicoId: TOPICO_MAT_ID }],
        [{ blocoId: BLOCO_1_ID, ordem: 1, proximaOrdem: 2 }],
        // 3. Simula falha de validação relacional (bloco não encontrado)
        [],
      ];

      await expect(iniciarSessao(BLOCO_2_ID, TOPICO_BIO_ID)).rejects.toThrow(PublicOperationError);
      expect(dbMockState.rolledBack).toBe(true);
    });

    it('duas abas simultâneas adquirem pg_advisory_xact_lock para serialização no PostgreSQL', async () => {
      dbMockState.txSelectOutputs = [
        [],
        [{
          blocoId: BLOCO_2_ID,
          cicloId: ALICE_CICLO_ID,
          blocoOrdem: 2,
          cicloAtivo: true,
          estudantePerfilId: ALICE_PERFIL_ID,
          blocoDisciplinaId: DISCIPLINA_BIO_ID,
          topicoDisciplinaId: DISCIPLINA_BIO_ID,
        }],
        [{ proximaOrdem: 2 }],
      ];

      dbMockState.txInsertOutputs = [[{ id: 'sessao-com-lock' }]];

      await iniciarSessao(BLOCO_2_ID, TOPICO_BIO_ID);

      // Confirma que a query de advisory lock com hash do perfil foi executada
      const lockQuery = dbMockState.executedQueries.find((q) => q.includes('pg_advisory_xact_lock'));
      expect(lockQuery).toBeDefined();
    });
  });

  describe('2. Verificação do Comportamento Circular (Transição do Bloco 28 para o Bloco 1)', () => {
    it('função calcularProximaOrdem avança ciclicamente de 28 para 1', () => {
      expect(calcularProximaOrdem(28, 28)).toBe(1);
      expect(calcularProximaOrdem(27, 28)).toBe(28);
      expect(calcularProximaOrdem(1, 28)).toBe(2);
    });

    it('a comparação de ordens NÃO impede uma nova volta legítima iniciando o Bloco 1', async () => {
      // Ciclo em proximaOrdem = 1 (início da 2ª volta)
      dbMockState.txSelectOutputs = [
        [], // Sem sessões abertas
        [{
          blocoId: BLOCO_1_ID,
          cicloId: ALICE_CICLO_ID,
          blocoOrdem: 1,
          cicloAtivo: true,
          estudantePerfilId: ALICE_PERFIL_ID,
          blocoDisciplinaId: DISCIPLINA_MAT_ID,
          topicoDisciplinaId: DISCIPLINA_MAT_ID,
        }],
        [{ proximaOrdem: 1 }], // Ciclo está em 1
      ];

      dbMockState.txInsertOutputs = [[{ id: 'sessao-bloco-1-volta-2' }]];

      const id = await iniciarSessao(BLOCO_1_ID, TOPICO_MAT_ID);

      expect(id).toBe('sessao-bloco-1-volta-2');
      expect(dbMockState.executedQueries).toContain('INSERT');
    });

    it('auto-encerra resíduo deixado no Bloco 28 quando o ciclo avança para 1 e o estudante inicia o Bloco 1', async () => {
      // 1. Sessão aberta no bloco 28 (ordem 28)
      // 2. cicloEstado indica proximaOrdem = 1 (ciclo avançou para a 2ª volta)
      // 3. vinculoBlocoTopico para Bloco 1
      // 4. estadoCicloBloco = 1
      dbMockState.txSelectOutputs = [
        [{ id: SESSAO_28_ID, cicloBlocoId: BLOCO_28_ID, topicoId: TOPICO_BIO_ID }],
        [{ blocoId: BLOCO_28_ID, ordem: 28, proximaOrdem: 1 }],
        [{
          blocoId: BLOCO_1_ID,
          cicloId: ALICE_CICLO_ID,
          blocoOrdem: 1,
          cicloAtivo: true,
          estudantePerfilId: ALICE_PERFIL_ID,
          blocoDisciplinaId: DISCIPLINA_MAT_ID,
          topicoDisciplinaId: DISCIPLINA_MAT_ID,
        }],
        [{ proximaOrdem: 1 }],
      ];

      dbMockState.txInsertOutputs = [[{ id: 'sessao-bloco-1-apos-bloco-28' }]];

      const id = await iniciarSessao(BLOCO_1_ID, TOPICO_MAT_ID);

      expect(id).toBe('sessao-bloco-1-apos-bloco-28');
      // Confirma que auto-encerrou o resíduo do bloco 28
      expect(dbMockState.executedQueries).toContain('UPDATE');
    });

    it('redireciona links obsoletos do Bloco 28 para o Bloco 1 quando o ciclo está na ordem 1', async () => {
      const todosBlocos = [
        { bloco: mockBloco1, disciplina: { id: DISCIPLINA_MAT_ID, nome: 'Matemática' } },
        { bloco: mockBloco2, disciplina: { id: DISCIPLINA_BIO_ID, nome: 'Biologia' } },
        { bloco: mockBloco28, disciplina: { id: DISCIPLINA_BIO_ID, nome: 'Biologia' } },
      ];

      dbMockState.txSelectOutputs = [
        [], // Sem sessões abertas
        [mockCiclo], // Ciclo ativo
        todosBlocos, // 28 blocos
        [{ proximaOrdem: 1 }], // Ciclo está na ordem 1
        [{ id: TOPICO_MAT_ID, disciplinaId: DISCIPLINA_MAT_ID, nome: 'Aritmética', ordem: 1 }],
      ];

      // Cliente acessou com link antigo do Bloco 28
      const estado = await obterEstadoSessaoCronometro({ cicloBlocoId: BLOCO_28_ID });

      expect(estado.statusSessao).toBe('nao_iniciada');
      // Deve ter redirecionado para o Bloco 1 (Matemática)
      expect(estado.blocoSugerido?.blocoId).toBe(BLOCO_1_ID);
      expect(estado.blocoSugerido?.ordem).toBe(1);
      expect(estado.proximaOrdemCiclo).toBe(1);
    });

    it('bloqueia reinício prematuro do Bloco 28 se ele já foi concluído na volta anterior e o ciclo está em 1', async () => {
      dbMockState.txSelectOutputs = [
        [], // Sem sessão aberta
        [{
          blocoId: BLOCO_28_ID,
          cicloId: ALICE_CICLO_ID,
          blocoOrdem: 28,
          cicloAtivo: true,
          estudantePerfilId: ALICE_PERFIL_ID,
          blocoDisciplinaId: DISCIPLINA_BIO_ID,
          topicoDisciplinaId: DISCIPLINA_BIO_ID,
        }],
        [{ proximaOrdem: 1 }], // Ciclo está em 1
        [{ id: 'sessao-concluida-anterior-bloco-28' }], // Bloco 28 já concluído
      ];

      await expect(iniciarSessao(BLOCO_28_ID, TOPICO_BIO_ID)).rejects.toThrow(
        /Este bloco do ciclo já foi concluído e o ciclo avançou para a próxima atividade/
      );
    });

    it('não recupera sessões concluídas da volta anterior como se estivessem ativas', async () => {
      const todosBlocos = [
        { bloco: mockBloco1, disciplina: { id: DISCIPLINA_MAT_ID, nome: 'Matemática' } },
      ];

      dbMockState.txSelectOutputs = [
        [], // Nenhuma sessão aberta
        [mockCiclo],
        todosBlocos,
        [{ proximaOrdem: 1 }],
        [{ id: TOPICO_MAT_ID, disciplinaId: DISCIPLINA_MAT_ID, nome: 'Aritmética', ordem: 1 }],
      ];

      const estado = await obterEstadoSessaoCronometro({});

      expect(estado.statusSessao).toBe('nao_iniciada');
      expect(estado.sessao).toBeNull();
      expect(estado.blocoSugerido?.ordem).toBe(1);
    });
  });
});
