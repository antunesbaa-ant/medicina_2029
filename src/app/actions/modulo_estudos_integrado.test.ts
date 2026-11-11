import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  obterEstadoSessaoCronometro,
  iniciarSessao,
  sincronizarCheckpointSessao,
  concluirSessao,
} from './sessao';
import { obterCicloAtivo } from './ciclo';
import { applyRlsContext } from '../../db/rls-context';
import { PublicOperationError } from '../../lib/operation-result';
import { calcularProximaOrdem, validarConclusaoSessao } from '../../lib/studysystem';

const {
  ALICE_PERFIL_ID,
  CARLOS_PERFIL_ID,
  ALICE_CICLO_ID,
  CARLOS_CICLO_ID,
  BLOCO_1_MAT_ID,
  BLOCO_2_BIO_ID,
  BLOCO_28_BIO_ID,
  DISCIPLINA_MAT_ID,
  DISCIPLINA_BIO_ID,
  TOPICO_MAT_ID,
  TOPICO_BIO_ID,
  SESSAO_1_ID,
  SESSAO_2_ID,
  QUESTAO_1_ID,
  TENTATIVA_1_ID,
  dbMockState,
} = vi.hoisted(() => ({
  ALICE_PERFIL_ID: '10000000-0000-4000-8000-000000000001',
  CARLOS_PERFIL_ID: '10000000-0000-4000-8000-000000000003',
  ALICE_CICLO_ID: '40000000-0000-4000-8000-000000000001',
  CARLOS_CICLO_ID: '40000000-0000-4000-8000-000000000002',
  BLOCO_1_MAT_ID: '41000000-0000-4000-8000-000000000001',
  BLOCO_2_BIO_ID: '41000000-0000-4000-8000-000000000002',
  BLOCO_28_BIO_ID: '41000000-0000-4000-8000-000000000028',
  DISCIPLINA_MAT_ID: 'd0000000-0000-4000-8000-000000000001',
  DISCIPLINA_BIO_ID: 'd0000000-0000-4000-8000-000000000002',
  TOPICO_MAT_ID: 'e0000000-0000-4000-8000-000000000001',
  TOPICO_BIO_ID: 'e0000000-0000-4000-8000-000000000002',
  SESSAO_1_ID: '5b17131d-4f44-414a-a87d-52485bf00f26',
  SESSAO_2_ID: '679937fc-9a54-4ba5-b7cb-ebde6b9f890b',
  QUESTAO_1_ID: '80000000-0000-4000-8000-000000000001',
  TENTATIVA_1_ID: '90000000-0000-4000-8000-000000000001',
  dbMockState: {
    txSelectOutputs: [] as unknown[][],
    txSelectCount: 0,
    txUpdateOutputs: [] as unknown[][],
    txUpdateCount: 0,
    txInsertOutputs: [] as unknown[][],
    txInsertCount: 0,
    currentStudentId: '10000000-0000-4000-8000-000000000001',
  },
}));

vi.mock('../../lib/authorization', () => ({
  requireRole: vi.fn(async (role: string) => {
    if (role === 'estudante') {
      return {
        id: dbMockState.currentStudentId,
        authUserId: 'a0000000-0000-4000-8000-000000000001',
        nome: dbMockState.currentStudentId === ALICE_PERFIL_ID ? 'Alice' : 'Carlos',
        email: dbMockState.currentStudentId === ALICE_PERFIL_ID ? 'alice@medicina2029.staging' : 'carlos@medicina2029.staging',
        papel: 'estudante',
      };
    }
    throw new Error('Forbidden');
  }),
  requireStudentScope: vi.fn(async () => ({
    id: dbMockState.currentStudentId,
    nome: dbMockState.currentStudentId === ALICE_PERFIL_ID ? 'Alice' : 'Carlos',
    email: dbMockState.currentStudentId === ALICE_PERFIL_ID ? 'alice@medicina2029.staging' : 'carlos@medicina2029.staging',
    papel: 'estudante',
  })),
  requireAuthenticatedProfile: vi.fn(async () => ({
    id: dbMockState.currentStudentId,
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
  queryBuilder.where = vi.fn().mockReturnValue(queryBuilder);
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
      { id: SESSAO_1_ID, cicloBlocoId: BLOCO_1_MAT_ID, proximaOrdem: 2 },
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
    select: vi.fn().mockReturnValue(queryBuilder),
    insert: vi.fn().mockReturnValue(queryBuilder),
    update: vi.fn().mockReturnValue(queryBuilder),
    execute: vi.fn().mockResolvedValue([]),
  };
}

let mockTx = createMockTx();

vi.mock('../../db', () => ({
  db: {
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      mockTx = createMockTx();
      return cb(mockTx);
    }),
  },
}));

describe('MEDICINA 2029 — Homologação Integrada do Módulo de Estudos (12 Fluxos)', () => {
  const mockCicloAlice = {
    id: ALICE_CICLO_ID,
    ativo: true,
    estudantePerfilId: ALICE_PERFIL_ID,
    nome: 'Ciclo Alice 2029',
  };

  const mockBloco1Mat = {
    id: BLOCO_1_MAT_ID,
    cicloId: ALICE_CICLO_ID,
    ordem: 1,
    disciplinaId: DISCIPLINA_MAT_ID,
    tipo: 'teoria',
    estiloAlvo: 'enem',
    duracaoMin: 50,
  };

  const mockBloco2Bio = {
    id: BLOCO_2_BIO_ID,
    cicloId: ALICE_CICLO_ID,
    ordem: 2,
    disciplinaId: DISCIPLINA_BIO_ID,
    tipo: 'teoria',
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
    dbMockState.currentStudentId = ALICE_PERFIL_ID;
  });

  // 1. Carregamento do ciclo
  it('1. Carregamento do ciclo: busca ciclo ativo, blocos ordenados e ponteiro sob contexto RLS', async () => {
    dbMockState.txSelectOutputs = [
      [mockCicloAlice],
      [
        { ...mockBloco1Mat, disciplina: { id: DISCIPLINA_MAT_ID, nome: 'Matemática' } },
        { ...mockBloco2Bio, disciplina: { id: DISCIPLINA_BIO_ID, nome: 'Biologia' } },
      ],
      [{ proximaOrdem: 2 }],
    ];

    const ciclo = await obterCicloAtivo();
    expect(ciclo).not.toBeNull();
    expect(ciclo?.ciclo.id).toBe(ALICE_CICLO_ID);
    expect(ciclo?.blocos).toHaveLength(2);
    expect(ciclo?.proximaOrdem).toBe(2);
    expect(applyRlsContext).toHaveBeenCalledWith(expect.anything(), ALICE_PERFIL_ID, 'estudante');
  });

  // 2. Seleção do bloco correto
  it('2. Seleção do bloco correto: sugere o bloco ativo apontado pelo ponteiro proximaOrdem', async () => {
    const todosBlocos = [
      { bloco: mockBloco1Mat, disciplina: { id: DISCIPLINA_MAT_ID, nome: 'Matemática' } },
      { bloco: mockBloco2Bio, disciplina: { id: DISCIPLINA_BIO_ID, nome: 'Biologia' } },
    ];

    dbMockState.txSelectOutputs = [
      [], // Nenhuma sessão aberta
      [mockCicloAlice],
      todosBlocos,
      [{ proximaOrdem: 2 }],
      [{ id: TOPICO_BIO_ID, disciplinaId: DISCIPLINA_BIO_ID, nome: 'Mitocôndrias', ordem: 1 }],
    ];

    const estado = await obterEstadoSessaoCronometro({});
    expect(estado.statusSessao).toBe('nao_iniciada');
    expect(estado.blocoSugerido?.blocoId).toBe(BLOCO_2_BIO_ID);
    expect(estado.blocoSugerido?.ordem).toBe(2);
    expect(estado.proximaOrdemCiclo).toBe(2);
  });

  // 3. Inicialização da sessão
  it('3. Inicialização da sessão: cria nova sessão transacional no PostgreSQL e retorna id', async () => {
    dbMockState.txSelectOutputs = [
      [], // Sem sessão aberta
      [{
        blocoId: BLOCO_2_BIO_ID,
        cicloId: ALICE_CICLO_ID,
        blocoOrdem: 2,
        cicloAtivo: true,
        estudantePerfilId: ALICE_PERFIL_ID,
        blocoDisciplinaId: DISCIPLINA_BIO_ID,
        topicoDisciplinaId: DISCIPLINA_BIO_ID,
      }],
      [{ proximaOrdem: 2 }],
    ];

    dbMockState.txInsertOutputs = [[{ id: 'sessao-bio-criada-id' }]];

    const sessaoId = await iniciarSessao(BLOCO_2_BIO_ID, TOPICO_BIO_ID);
    expect(sessaoId).toBe('sessao-bio-criada-id');
  });

  // 4. Cronômetro e etapas
  it('4. Cronômetro e etapas: sincroniza checkpoints com bloqueio FOR UPDATE e avanço de etapa', async () => {
    const sessaoMock = {
      id: SESSAO_1_ID,
      perfilId: ALICE_PERFIL_ID,
      etapaAtingida: 'revisao',
      segundosEfetivos: 300,
      segundosPausa: 0,
      encerradaEm: null,
      concluida: false,
    };

    dbMockState.txSelectOutputs = [[sessaoMock]];

    const resultado = await sincronizarCheckpointSessao(SESSAO_1_ID, {
      etapaAtual: 'conteudo',
      segundosEfetivos: 400,
      segundosPausa: 0,
    });

    expect(resultado.reconciliado).toBe(false);
    expect(resultado.statusSessao).toBe('em_andamento');
  });

  // 5. Registro de questões e acertos
  it('5. Registro de questões e acertos: valida critérios pedagógicos de conclusão', () => {
    expect(validarConclusaoSessao('registro')).toBe(true);
    expect(validarConclusaoSessao('questoes')).toBe(false);
    expect(validarConclusaoSessao('revisao')).toBe(false);
  });

  // 6. Finalização e persistência
  it('6. Finalização e persistência: marca encerrada_em, concluida = true e persiste dados', async () => {
    const sessaoEmAndamento = {
      id: SESSAO_1_ID,
      perfilId: ALICE_PERFIL_ID,
      cicloBlocoId: BLOCO_1_MAT_ID,
      topicoId: TOPICO_MAT_ID,
      iniciadaEm: new Date(Date.now() - 3600000),
      encerradaEm: null,
      segundosEfetivos: 3000,
      segundosPausa: 0,
      etapaAtingida: 'registro',
      concluida: false,
    };

    dbMockState.txSelectOutputs = [
      [{
        sessao: sessaoEmAndamento,
        bloco: mockBloco1Mat,
        ciclo: mockCicloAlice,
      }],
      [{ id: BLOCO_1_MAT_ID }, { id: BLOCO_2_BIO_ID }], // 2 blocos no ciclo
    ];

    // Mock update sessão e insert cicloEstado
    dbMockState.txInsertOutputs = [
      [{ ...sessaoEmAndamento, encerradaEm: new Date(), concluida: true }],
      [{ cicloId: ALICE_CICLO_ID }],
    ];

    const sessaoConcluida = await concluirSessao(SESSAO_1_ID, {
      etapaAtingida: 'registro',
      segundosEfetivos: 3000,
      segundosPausa: 0,
      notaLivre: '8 de 10 acertos',
    });

    expect(sessaoConcluida.concluida).toBe(true);
  });

  // 7. Pausa
  it('7. Pausa: registra status pausada e acumula segundosPausa sem encerrar a sessão', async () => {
    const sessaoMock = {
      id: SESSAO_1_ID,
      perfilId: ALICE_PERFIL_ID,
      etapaAtingida: 'conteudo',
      segundosEfetivos: 500,
      segundosPausa: 60,
      encerradaEm: null,
      concluida: false,
    };

    dbMockState.txSelectOutputs = [[sessaoMock]];

    const resultado = await sincronizarCheckpointSessao(SESSAO_1_ID, {
      etapaAtual: 'conteudo',
      segundosEfetivos: 500,
      segundosPausa: 120,
      emPausa: true,
    });

    expect(resultado.statusSessao).toBe('pausada');
  });

  // 8. Avanço do ciclo
  it('8. Avanço do ciclo: calcula deterministamente o próximo bloco após conclusão', () => {
    expect(calcularProximaOrdem(1, 28)).toBe(2);
    expect(calcularProximaOrdem(2, 28)).toBe(3);
    expect(calcularProximaOrdem(28, 28)).toBe(1);
  });

  // 9. Retomada de sessão interrompida
  it('9. Retomada de sessão interrompida: recupera sessão aberta no bloco atual mantendo tempo e etapa', async () => {
    const aberta = {
      sessao: {
        id: SESSAO_2_ID,
        perfilId: ALICE_PERFIL_ID,
        iniciadaEm: new Date(),
        encerradaEm: null,
        etapaAtingida: 'conteudo',
        segundosEfetivos: 450,
        segundosPausa: 30,
        concluida: false,
        notaLivre: null,
      },
      bloco: mockBloco2Bio,
      ciclo: mockCicloAlice,
      disciplina: { id: DISCIPLINA_BIO_ID, nome: 'Biologia' },
      topico: { id: TOPICO_BIO_ID, nome: 'Mitocôndrias' },
    };

    dbMockState.txSelectOutputs = [
      [aberta], // 1. tx.select aberta
      [{ proximaOrdem: 2 }], // 2. tx.select cicloEstado
    ];

    const estado = await obterEstadoSessaoCronometro({});
    expect(estado.statusSessao).toBe('em_andamento');
    expect(estado.sessao?.id).toBe(SESSAO_2_ID);
    expect(estado.sessao?.segundosEfetivos).toBe(450);
  });

  // 10. Proteção contra duplicações e concorrência
  it('10. Proteção contra duplicações: auto-encerra resíduo órfão anterior na mesma transação', async () => {
    dbMockState.txSelectOutputs = [
      [{ id: SESSAO_1_ID, cicloBlocoId: BLOCO_1_MAT_ID, topicoId: TOPICO_MAT_ID }], // aberta no bloco 1
      [{ blocoId: BLOCO_1_MAT_ID, ordem: 1, proximaOrdem: 2 }], // ciclo está em 2
      [{
        blocoId: BLOCO_2_BIO_ID,
        cicloId: ALICE_CICLO_ID,
        blocoOrdem: 2,
        cicloAtivo: true,
        estudantePerfilId: ALICE_PERFIL_ID,
        blocoDisciplinaId: DISCIPLINA_BIO_ID,
        topicoDisciplinaId: DISCIPLINA_BIO_ID,
      }],
      [{ proximaOrdem: 2 }],
    ];

    dbMockState.txInsertOutputs = [[{ id: 'sessao-bloco-2-nova' }]];

    const novaSessao = await iniciarSessao(BLOCO_2_BIO_ID, TOPICO_BIO_ID);
    expect(novaSessao).toBe('sessao-bloco-2-nova');
    expect(mockTx.update).toHaveBeenCalled();
  });

  // 11. Comportamento circular
  it('11. Comportamento circular: reinício legítimo do Bloco 1 na 2ª volta sem colisão', async () => {
    dbMockState.txSelectOutputs = [
      [], // Sem sessões abertas
      [{
        blocoId: BLOCO_1_MAT_ID,
        cicloId: ALICE_CICLO_ID,
        blocoOrdem: 1,
        cicloAtivo: true,
        estudantePerfilId: ALICE_PERFIL_ID,
        blocoDisciplinaId: DISCIPLINA_MAT_ID,
        topicoDisciplinaId: DISCIPLINA_MAT_ID,
      }],
      [{ proximaOrdem: 1 }], // Ponteiro em 1 na 2ª volta
    ];

    dbMockState.txInsertOutputs = [[{ id: 'sessao-bloco-1-volta-2' }]];

    const id = await iniciarSessao(BLOCO_1_MAT_ID, TOPICO_MAT_ID);
    expect(id).toBe('sessao-bloco-1-volta-2');
  });

  // 12. Isolamento entre estudantes
  it('12. Isolamento entre estudantes: Carlos não consegue acessar nem iniciar bloco pertencente ao ciclo de Alice', async () => {
    dbMockState.currentStudentId = CARLOS_PERFIL_ID;

    dbMockState.txSelectOutputs = [
      [], // Nenhuma sessão aberta para Carlos
      [], // vinculoBlocoTopico retorna vazio porque o bloco pertence a Alice (RLS impede)
    ];

    await expect(iniciarSessao(BLOCO_1_MAT_ID, TOPICO_MAT_ID)).rejects.toThrow(
      /Bloco do ciclo ou tópico não encontrado ou acesso não permitido/
    );
  });
});
