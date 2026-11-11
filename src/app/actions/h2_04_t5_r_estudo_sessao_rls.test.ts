import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  obterEstadoSessaoCronometro,
  iniciarSessao,
} from './sessao';
import { obterCicloAtivo } from './ciclo';
import { applyRlsContext } from '../../db/rls-context';
import { PublicOperationError } from '../../lib/operation-result';
import {
  reconciliarEstadoCronometroComServidor,
  type EstadoServidorCronometro,
} from '../../lib/cicloCronometroReconciliacao';

const {
  ALICE_PERFIL_ID,
  OUTRO_ESTUDANTE_ID,
  ALICE_CICLO_ID,
  BLOCO_1_ID,
  DISCIPLINA_MAT_ID,
  TOPICO_RAZAO_ID,
  SESSAO_1_ID,
  dbMockState,
} = vi.hoisted(() => ({
  ALICE_PERFIL_ID: '10000000-0000-4000-8000-000000000001',
  OUTRO_ESTUDANTE_ID: '10000000-0000-4000-8000-000000000002',
  ALICE_CICLO_ID: '40000000-0000-4000-8000-000000000001',
  BLOCO_1_ID: '41000000-0000-4000-8000-000000000001',
  DISCIPLINA_MAT_ID: 'd0000000-0000-4000-8000-000000000001',
  TOPICO_RAZAO_ID: 'e0000000-0000-4000-8000-000000000001',
  SESSAO_1_ID: '42000000-0000-4000-8000-000000000001',
  dbMockState: {
    txSelectOutputs: [] as unknown[][],
    txSelectCount: 0,
    txInsertOutputs: [] as unknown[][],
    txInsertCount: 0,
    txCreated: false,
    activeProfileId: '10000000-0000-4000-8000-000000000001',
  },
}));

// Mocks de autorização
vi.mock('../../lib/authorization', () => ({
  requireRole: vi.fn(async (role: string) => {
    if (role === 'estudante') {
      return {
        id: dbMockState.activeProfileId,
        authUserId: 'a0000000-0000-4000-8000-000000000001',
        nome: 'Estudante Teste',
        email: 'alice@medicina2029.staging',
        papel: 'estudante',
      };
    }
    throw new Error('Forbidden');
  }),
  requireStudentScope: vi.fn(async () => ({
    id: dbMockState.activeProfileId,
    nome: 'Estudante Teste',
    email: 'alice@medicina2029.staging',
    papel: 'estudante',
  })),
  requireAuthenticatedProfile: vi.fn(async () => ({
    id: dbMockState.activeProfileId,
    papel: 'estudante',
  })),
  requireManagedStudentProfile: vi.fn(async () => ({
    id: dbMockState.activeProfileId,
    papel: 'estudante',
  })),
  assertOwnership: vi.fn(),
}));

// Mock do applyRlsContext
vi.mock('../../db/rls-context', () => ({
  applyRlsContext: vi.fn().mockResolvedValue(undefined),
  isRlsEnforced: vi.fn().mockReturnValue(true),
}));

interface MockQueryBuilder {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  for: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  then: (resolve: (val: unknown) => unknown) => Promise<unknown>;
}

function createMockTx() {
  const queryBuilder = {} as MockQueryBuilder;
  queryBuilder.from = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.where = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.limit = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.innerJoin = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.orderBy = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.for = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.values = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.onConflictDoUpdate = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.returning = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.then = (resolve) => {
    const res = dbMockState.txSelectOutputs[dbMockState.txSelectCount] ?? [];
    dbMockState.txSelectCount++;
    return Promise.resolve(res).then(resolve);
  };

  const insertBuilder = {} as MockQueryBuilder;
  insertBuilder.values = vi.fn().mockReturnValue(insertBuilder);
  insertBuilder.returning = vi.fn().mockReturnValue(insertBuilder);
  insertBuilder.then = (resolve) => {
    const res = dbMockState.txInsertOutputs[dbMockState.txInsertCount] ?? [];
    dbMockState.txInsertCount++;
    return Promise.resolve(res).then(resolve);
  };

  return {
    select: vi.fn().mockReturnValue(queryBuilder),
    insert: vi.fn().mockReturnValue(insertBuilder),
    update: vi.fn().mockReturnValue(queryBuilder),
    delete: vi.fn().mockReturnValue(queryBuilder),
    execute: vi.fn().mockResolvedValue([]),
  };
}

let mockTxInstance = createMockTx();

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      throw new Error('VIOLAÇÃO DE RLS: db.select chamado fora de transação!');
    }),
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      dbMockState.txCreated = true;
      return await cb(mockTxInstance);
    }),
  },
}));

describe('H2.04-T5-R — Auditoria e Correção da Inicialização da Sessão de Estudo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMockState.txSelectOutputs = [];
    dbMockState.txSelectCount = 0;
    dbMockState.txInsertOutputs = [];
    dbMockState.txInsertCount = 0;
    dbMockState.txCreated = false;
    dbMockState.activeProfileId = ALICE_PERFIL_ID;
    mockTxInstance = createMockTx();
  });

  it('1. Bloco e tópico válidos: obterEstadoSessaoCronometro aplica RLS context e sugere bloco e tópico', async () => {
    const mockCiclo = {
      id: ALICE_CICLO_ID,
      nome: 'Ciclo Alice 2029',
      ativo: true,
      estudantePerfilId: ALICE_PERFIL_ID,
    };
    const mockBloco = {
      id: BLOCO_1_ID,
      cicloId: ALICE_CICLO_ID,
      ordem: 1,
      disciplinaId: DISCIPLINA_MAT_ID,
      tipo: 'conteudo',
      estiloAlvo: 'enem',
      duracaoMin: 50,
    };
    const mockDisciplina = {
      id: DISCIPLINA_MAT_ID,
      nome: 'Matemática',
    };
    const mockTopico = {
      id: TOPICO_RAZAO_ID,
      disciplinaId: DISCIPLINA_MAT_ID,
      nome: 'Razão e Proporção',
      ordem: 1,
    };

    // Consultas esperadas dentro de obterEstadoSessaoCronometro:
    // 1. tx.select aberta (sessoes) -> vazia []
    // 2. tx.select cicloAtivo (ciclos) -> [mockCiclo]
    // 3. tx.select blocos (cicloBlocos + disciplinas) -> [{ bloco: mockBloco, disciplina: mockDisciplina }]
    // 4. tx.select estadoCiclo (cicloEstado) -> [{ proximaOrdem: 1 }]
    // 5. tx.select topicosDisciplina (topicos) -> [mockTopico]
    dbMockState.txSelectOutputs = [
      [], // 1. Nenhuma sessão aberta
      [mockCiclo], // 2. Ciclo ativo
      [{ bloco: mockBloco, disciplina: mockDisciplina }], // 3. Blocos
      [{ proximaOrdem: 1 }], // 4. Estado ciclo
      [mockTopico], // 5. Tópicos da disciplina
    ];

    const estado = await obterEstadoSessaoCronometro({ cicloBlocoId: BLOCO_1_ID });

    expect(dbMockState.txCreated).toBe(true);
    expect(applyRlsContext).toHaveBeenCalledWith(mockTxInstance, ALICE_PERFIL_ID, 'estudante');
    expect(estado.statusSessao).toBe('nao_iniciada');
    expect(estado.sessao).toBeNull();
    expect(estado.blocoSugerido).not.toBeNull();
    expect(estado.blocoSugerido?.blocoId).toBe(BLOCO_1_ID);
    expect(estado.blocoSugerido?.topicoId).toBe(TOPICO_RAZAO_ID);
    expect(estado.blocoSugerido?.disciplinaNome).toBe('Matemática');
    expect(estado.blocoSugerido?.topicoNome).toBe('Razão e Proporção');
  });

  it('2. Bloco existente sem tópico elegível: retorna blocoSugerido nulo quando disciplina não possui tópicos', async () => {
    const mockCiclo = { id: ALICE_CICLO_ID, ativo: true, estudantePerfilId: ALICE_PERFIL_ID };
    const mockBloco = {
      id: BLOCO_1_ID,
      cicloId: ALICE_CICLO_ID,
      ordem: 1,
      disciplinaId: DISCIPLINA_MAT_ID,
    };
    const mockDisciplina = { id: DISCIPLINA_MAT_ID, nome: 'Matemática' };

    dbMockState.txSelectOutputs = [
      [], // Nenhuma sessão aberta
      [mockCiclo],
      [{ bloco: mockBloco, disciplina: mockDisciplina }],
      [{ proximaOrdem: 1 }],
      [], // Tópicos vazios para esta disciplina
    ];

    const estado = await obterEstadoSessaoCronometro({ cicloBlocoId: BLOCO_1_ID });

    expect(dbMockState.txCreated).toBe(true);
    expect(estado.statusSessao).toBe('nao_iniciada');
    expect(estado.blocoSugerido).toBeNull();
  });

  it('3. Consulta sem contexto RLS: falha de applyRlsContext aborta a operação fail-closed', async () => {
    vi.mocked(applyRlsContext).mockRejectedValueOnce(
      new Error('RLS Context Error: medicina.set_context indisponível')
    );

    await expect(obterEstadoSessaoCronometro()).rejects.toThrow(PublicOperationError);
    expect(dbMockState.txCreated).toBe(true);
  });

  it('4. Tentativa de acesso ao bloco de outro estudante: iniciarSessao rejeita bloco não pertencente ao perfil', async () => {
    // Simula consulta de vínculo bloco/tópico onde o estudantePerfilId pertence a outro perfil
    dbMockState.txSelectOutputs = [
      [], // nenhuma sessão aberta existente
      [], // vinculoBlocoTopico retorna vazio ou perfil divergente
    ];

    await expect(iniciarSessao(BLOCO_1_ID, TOPICO_RAZAO_ID)).rejects.toThrow(PublicOperationError);
    expect(dbMockState.txCreated).toBe(true);
  });

  it('5. Falha de persistência: erro durante a transação é mapeado para PERSISTENCE_ERROR sem vazar detalhes', async () => {
    dbMockState.txSelectOutputs = [
      () => {
        throw new Error('Connection terminated unexpectedly');
      },
    ] as unknown as unknown[][];

    await expect(obterEstadoSessaoCronometro()).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      message: 'Não foi possível recuperar o estado da sessão no servidor.',
    });
  });

  it('6. Cronômetro não iniciado prematuramente: reconciliação com blocoSugerido nulo descarta cache e não cria sessão', () => {
    const estadoServidor: EstadoServidorCronometro = {
      statusSessao: 'nao_iniciada',
      sessao: null,
      blocoSugerido: null,
      proximaOrdemCiclo: 1,
      serverTimestampMs: Date.now(),
    };

    const reconciliado = reconciliarEstadoCronometroComServidor({
      servidor: estadoServidor,
      cacheLocal: null,
    });

    expect(reconciliado.statusSessao).toBe('nao_iniciada');
    expect(reconciliado.sessaoId).toBe('');
    expect(reconciliado.blocoId).toBe('');
    expect(reconciliado.topicoId).toBe('');
    expect(reconciliado.estaRodando).toBe(false);
  });

  it('7. Nova tentativa de sincronização sem duplicação: reutiliza sessão aberta existente de forma idempotente', async () => {
    const mockSessaoAberta = {
      id: SESSAO_1_ID,
      cicloBlocoId: BLOCO_1_ID,
      topicoId: TOPICO_RAZAO_ID,
    };

    // Iniciar sessão com uma sessão já aberta para o mesmo bloco e tópico
    dbMockState.txSelectOutputs = [
      [mockSessaoAberta], // sessão aberta existente encontrada
    ];

    const sessaoRetornadaId = await iniciarSessao(BLOCO_1_ID, TOPICO_RAZAO_ID);

    expect(sessaoRetornadaId).toBe(SESSAO_1_ID);
    // Não deve executar INSERT
    expect(dbMockState.txInsertCount).toBe(0);
  });

  it('8. Preservação do funcionamento da tela Ciclo: obterCicloAtivo continua retornando os dados corretos sob o perfil', async () => {
    const mockCiclo = {
      id: ALICE_CICLO_ID,
      nome: 'Ciclo Alice 2029',
      anoLetivo: 2027,
      ativo: true,
      estudantePerfilId: ALICE_PERFIL_ID,
      blocosPrevistosSemana: 28,
    };

    const mockBlocos = [
      {
        id: BLOCO_1_ID,
        cicloId: ALICE_CICLO_ID,
        ordem: 1,
        disciplinaId: DISCIPLINA_MAT_ID,
        tipo: 'conteudo',
        estiloAlvo: 'enem',
        duracaoMin: 50,
        disciplina: { id: DISCIPLINA_MAT_ID, nome: 'Matemática' },
      },
    ];

    dbMockState.txSelectOutputs = [
      [mockCiclo], // 1. tx.select ciclos
      mockBlocos,  // 2. tx.select cicloBlocos
      [{ proximaOrdem: 1 }], // 3. tx.select cicloEstado
    ];

    const cicloAtivo = await obterCicloAtivo();

    expect(cicloAtivo).not.toBeNull();
    expect(cicloAtivo?.ciclo.id).toBe(ALICE_CICLO_ID);
    expect(cicloAtivo?.blocos).toHaveLength(1);
    expect(cicloAtivo?.proximaOrdem).toBe(1);
  });
});
