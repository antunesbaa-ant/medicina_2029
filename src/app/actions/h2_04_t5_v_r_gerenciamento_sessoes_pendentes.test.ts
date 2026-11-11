import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  obterEstadoSessaoCronometro,
  iniciarSessao,
  concluirSessao,
} from './sessao';
import { applyRlsContext } from '../../db/rls-context';
import { PublicOperationError } from '../../lib/operation-result';

const {
  ALICE_PERFIL_ID,
  CARLOS_PERFIL_ID,
  ALICE_CICLO_ID,
  BLOCO_1_ID,
  BLOCO_2_ID,
  DISCIPLINA_MAT_ID,
  DISCIPLINA_BIO_ID,
  TOPICO_MAT_ID,
  TOPICO_BIO_ID,
  SESSAO_1_ID,
  SESSAO_2_ID,
  dbMockState,
} = vi.hoisted(() => ({
  ALICE_PERFIL_ID: '10000000-0000-4000-8000-000000000001',
  CARLOS_PERFIL_ID: '10000000-0000-4000-8000-000000000003',
  ALICE_CICLO_ID: '40000000-0000-4000-8000-000000000001',
  BLOCO_1_ID: '41000000-0000-4000-8000-000000000001',
  BLOCO_2_ID: '41000000-0000-4000-8000-000000000002',
  DISCIPLINA_MAT_ID: 'd0000000-0000-4000-8000-000000000001',
  DISCIPLINA_BIO_ID: 'd0000000-0000-4000-8000-000000000002',
  TOPICO_MAT_ID: 'e0000000-0000-4000-8000-000000000001',
  TOPICO_BIO_ID: 'e0000000-0000-4000-8000-000000000002',
  SESSAO_1_ID: '5b17131d-4f44-414a-a87d-52485bf00f26',
  SESSAO_2_ID: '679937fc-9a54-4ba5-b7cb-ebde6b9f890b',
  dbMockState: {
    txSelectOutputs: [] as unknown[][],
    txSelectCount: 0,
    txUpdateOutputs: [] as unknown[][],
    txUpdateCount: 0,
    txInsertOutputs: [] as unknown[][],
    txInsertCount: 0,
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
    select: vi.fn().mockReturnValue(queryBuilder),
    insert: vi.fn().mockReturnValue(queryBuilder),
    update: vi.fn().mockReturnValue(queryBuilder),
    execute: vi.fn().mockResolvedValue([]),
  };
}

let mockTxInstance = createMockTx();

vi.mock('../../db', () => ({
  db: {
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      mockTxInstance = createMockTx();
      return cb(mockTxInstance);
    }),
  },
}));

describe('MEDICINA 2029 — H2.04-T5-V-R: Correção do Gerenciamento de Sessões Pendentes', () => {
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
    tipo: 'conteudo',
  };
  const mockBloco2 = {
    id: BLOCO_2_ID,
    cicloId: ALICE_CICLO_ID,
    ordem: 2,
    disciplinaId: DISCIPLINA_BIO_ID,
    tipo: 'questoes',
  };
  const mockDiscMat = { id: DISCIPLINA_MAT_ID, nome: 'Matemática' };
  const mockDiscBio = { id: DISCIPLINA_BIO_ID, nome: 'Biologia' };
  const mockTopicoMat = { id: TOPICO_MAT_ID, disciplinaId: DISCIPLINA_MAT_ID, nome: 'Razão e Proporção', ordem: 1 };
  const mockTopicoBio = { id: TOPICO_BIO_ID, disciplinaId: DISCIPLINA_BIO_ID, nome: 'Citologia', ordem: 1 };

  beforeEach(() => {
    vi.clearAllMocks();
    dbMockState.txSelectOutputs = [];
    dbMockState.txSelectCount = 0;
    dbMockState.txInsertOutputs = [];
    dbMockState.txInsertCount = 0;
    dbMockState.activeProfileId = ALICE_PERFIL_ID;
  });

  describe('1. Resolução e Filtro de Sessões Órfãs de Blocos Anteriores', () => {
    it('ignora sessão aberta de bloco anterior quando a navegação é direta (sem parâmetros) e sugere o bloco atual do ciclo', async () => {
      // Simula:
      // - Sessão #2 está aberta no banco para o Bloco 1 (ordem 1)
      // - O ciclo de Alice já avançou para proximaOrdem = 2 (Biologia)
      const mockSessaoAbertaBloco1 = {
        sessao: {
          id: SESSAO_2_ID,
          perfilId: ALICE_PERFIL_ID,
          cicloBlocoId: BLOCO_1_ID,
          topicoId: TOPICO_MAT_ID,
          iniciadaEm: new Date(),
          segundosEfetivos: 0,
          segundosPausa: 0,
          etapaAtingida: 'registro',
          concluida: false,
          notaLivre: null,
        },
        bloco: mockBloco1,
        ciclo: mockCiclo,
        disciplina: mockDiscMat,
        topico: mockTopicoMat,
      };

      dbMockState.txSelectOutputs = [
        [mockSessaoAbertaBloco1], // 1. tx.select aberta -> sessão órfã do Bloco 1
        [{ proximaOrdem: 2 }],    // 2. tx.select estadoCiclo da sessão aberta -> ciclo está em 2
        [mockCiclo],              // 3. tx.select cicloAtivo
        [                         // 4. tx.select blocos
          { bloco: mockBloco1, disciplina: mockDiscMat },
          { bloco: mockBloco2, disciplina: mockDiscBio },
        ],
        [{ proximaOrdem: 2 }],    // 5. tx.select estadoCiclo
        [mockTopicoBio],          // 6. tx.select topicos da disciplina do bloco 2 (Biologia)
      ];

      const resultado = await obterEstadoSessaoCronometro({});

      // Deve reconhecer que a sessão do Bloco 1 é órfã (1 < 2) e sugerir o Bloco 2 de Biologia
      expect(resultado.statusSessao).toBe('nao_iniciada');
      expect(resultado.sessao).toBeNull();
      expect(resultado.blocoSugerido).not.toBeNull();
      expect(resultado.blocoSugerido?.blocoId).toBe(BLOCO_2_ID);
      expect(resultado.blocoSugerido?.disciplinaNome).toBe('Biologia');
      expect(resultado.blocoSugerido?.ordem).toBe(2);
      expect(resultado.proximaOrdemCiclo).toBe(2);
    });

    it('ignora sessão aberta de outro bloco quando o cliente solicita explicitamente o bloco 2', async () => {
      const mockSessaoAbertaBloco1 = {
        sessao: {
          id: SESSAO_2_ID,
          perfilId: ALICE_PERFIL_ID,
          cicloBlocoId: BLOCO_1_ID,
          topicoId: TOPICO_MAT_ID,
          iniciadaEm: new Date(),
          segundosEfetivos: 0,
          segundosPausa: 0,
          etapaAtingida: 'registro',
          concluida: false,
          notaLivre: null,
        },
        bloco: mockBloco1,
        ciclo: mockCiclo,
        disciplina: mockDiscMat,
        topico: mockTopicoMat,
      };

      dbMockState.txSelectOutputs = [
        [mockSessaoAbertaBloco1], // 1. Sessão aberta do Bloco 1
        [{ proximaOrdem: 2 }],    // 2. Ciclo em 2
        [mockCiclo],              // 3. Ciclo ativo
        [                         // 4. Blocos
          { bloco: mockBloco1, disciplina: mockDiscMat },
          { bloco: mockBloco2, disciplina: mockDiscBio },
        ],
        [{ proximaOrdem: 2 }],    // 5. Estado ciclo
        [mockTopicoBio],          // 6. Tópicos de Biologia
      ];

      const resultado = await obterEstadoSessaoCronometro({ cicloBlocoId: BLOCO_2_ID });

      expect(resultado.statusSessao).toBe('nao_iniciada');
      expect(resultado.sessao).toBeNull();
      expect(resultado.blocoSugerido?.blocoId).toBe(BLOCO_2_ID);
      expect(resultado.blocoSugerido?.disciplinaNome).toBe('Biologia');
    });

    it('redireciona para o bloco ativo corrente quando acessado com link obsoleto de bloco anterior', async () => {
      dbMockState.txSelectOutputs = [
        [],                      // 1. Nenhuma sessão aberta
        [mockCiclo],             // 2. Ciclo ativo
        [                        // 3. Blocos
          { bloco: mockBloco1, disciplina: mockDiscMat },
          { bloco: mockBloco2, disciplina: mockDiscBio },
        ],
        [{ proximaOrdem: 2 }],   // 4. Estado ciclo: proximaOrdem = 2
        [mockTopicoBio],         // 5. Tópicos de Biologia
      ];

      // Cliente tenta acessar com ?blocoId=BLOCO_1_ID (bloco já superado)
      const resultado = await obterEstadoSessaoCronometro({ cicloBlocoId: BLOCO_1_ID });

      expect(resultado.statusSessao).toBe('nao_iniciada');
      expect(resultado.sessao).toBeNull();
      // O servidor deve recusar sugerir Bloco 1 e redirecionar para Bloco 2
      expect(resultado.blocoSugerido?.blocoId).toBe(BLOCO_2_ID);
      expect(resultado.blocoSugerido?.ordem).toBe(2);
      expect(resultado.blocoSugerido?.disciplinaNome).toBe('Biologia');
    });

    it('preserva integralmente a retomada de uma sessão legítima em andamento no bloco atual', async () => {
      const mockSessaoAbertaBloco2 = {
        sessao: {
          id: 'sessao-legitima-bio-id',
          perfilId: ALICE_PERFIL_ID,
          cicloBlocoId: BLOCO_2_ID,
          topicoId: TOPICO_BIO_ID,
          iniciadaEm: new Date(),
          segundosEfetivos: 450, // 7m 30s de estudo real
          segundosPausa: 30,
          etapaAtingida: 'conteudo',
          concluida: false,
          notaLivre: 'Notas importantes de citologia...',
        },
        bloco: mockBloco2,
        ciclo: mockCiclo,
        disciplina: mockDiscBio,
        topico: mockTopicoBio,
      };

      dbMockState.txSelectOutputs = [
        [mockSessaoAbertaBloco2], // Sessão aberta do Bloco 2 (bloco atual)
        [{ proximaOrdem: 2 }],    // Ciclo está em 2
      ];

      const resultado = await obterEstadoSessaoCronometro({});

      expect(resultado.statusSessao).toBe('em_andamento');
      expect(resultado.sessao).not.toBeNull();
      expect(resultado.sessao?.id).toBe('sessao-legitima-bio-id');
      expect(resultado.sessao?.cicloBlocoId).toBe(BLOCO_2_ID);
      expect(resultado.sessao?.segundosEfetivos).toBe(450);
      expect(resultado.sessao?.etapaAtingida).toBe('conteudo');
      expect(resultado.sessao?.notaLivre).toBe('Notas importantes de citologia...');
    });
  });

  describe('2. Integridade e Regras de Inicialização (iniciarSessao)', () => {
    it('rejeita reiniciar um bloco que já foi concluído e superado pelo ciclo', async () => {
      // 1. tx.select sessaoAberta -> vazia
      // 2. tx.select vinculoBlocoTopico -> Bloco 1 (ordem 1, ciclo ativo)
      // 3. tx.select estadoCicloBloco -> proximaOrdem = 2
      // 4. tx.select sessaoJaConcluida -> encontrada (sessão #1 já concluída)
      dbMockState.txSelectOutputs = [
        [], // Nenhuma sessão aberta
        [{
          blocoId: BLOCO_1_ID,
          cicloId: ALICE_CICLO_ID,
          blocoOrdem: 1,
          cicloAtivo: true,
          estudantePerfilId: ALICE_PERFIL_ID,
          blocoDisciplinaId: DISCIPLINA_MAT_ID,
          topicoDisciplinaId: DISCIPLINA_MAT_ID,
        }],
        [{ proximaOrdem: 2 }], // Ponteiro está em 2
        [{ id: SESSAO_1_ID }], // Bloco 1 já tem sessão concluída
      ];

      await expect(iniciarSessao(BLOCO_1_ID, TOPICO_MAT_ID)).rejects.toThrow(
        'Este bloco do ciclo já foi concluído e o ciclo avançou para a próxima atividade.'
      );
    });

    it('auto-encerra sessão órfã de bloco anterior ao iniciar legitimamente a atividade atual do ciclo', async () => {
      // Simula:
      // 1. sessaoAberta encontrada (Sessão #2, Bloco 1)
      // 2. blocoSessaoAberta -> ordem 1, proximaOrdem 2 (1 < 2 => é resíduo de bloco superado)
      // 3. vinculoBlocoTopico -> Bloco 2 (ordem 2, ciclo ativo)
      // 4. estadoCicloBloco -> proximaOrdem 2 (2 não é menor que 2)
      // 5. insert sessoes -> retorna nova sessão de Biologia
      dbMockState.txSelectOutputs = [
        [{ id: SESSAO_2_ID, cicloBlocoId: BLOCO_1_ID, topicoId: TOPICO_MAT_ID }], // sessaoAberta órfã
        [{ blocoId: BLOCO_1_ID, ordem: 1, proximaOrdem: 2 }], // blocoSessaoAberta anterior
        [{
          blocoId: BLOCO_2_ID,
          cicloId: ALICE_CICLO_ID,
          blocoOrdem: 2,
          cicloAtivo: true,
          estudantePerfilId: ALICE_PERFIL_ID,
          blocoDisciplinaId: DISCIPLINA_BIO_ID,
          topicoDisciplinaId: DISCIPLINA_BIO_ID,
        }],
        [{ proximaOrdem: 2 }], // Bloco 2 não é anterior ao ponteiro
      ];

      dbMockState.txInsertOutputs = [
        [{ id: 'nova-sessao-bio-id' }],
      ];

      const novaSessaoId = await iniciarSessao(BLOCO_2_ID, TOPICO_BIO_ID);

      expect(novaSessaoId).toBe('nova-sessao-bio-id');
      // Deve ter executado o update na sessão órfã anterior para fechá-la
      expect(mockTxInstance.update).toHaveBeenCalled();
    });

    it('mantém bloqueio por conflito se a sessão aberta for de bloco válido e o estudante tentar abrir outro simultaneamente', async () => {
      // Simula sessão aberta no Bloco 2 (ordem 2, proximaOrdem 2)
      dbMockState.txSelectOutputs = [
        [{ id: 'sessao-ativa-bio-id', cicloBlocoId: BLOCO_2_ID, topicoId: TOPICO_BIO_ID }],
        [{ blocoId: BLOCO_2_ID, ordem: 2, proximaOrdem: 2 }], // 2 não é menor que 2
      ];

      await expect(iniciarSessao(BLOCO_1_ID, TOPICO_MAT_ID)).rejects.toThrow(
        'Já existe outra sessão de estudo em andamento para este perfil. Retome ou encerre a sessão aberta antes de iniciar outra.'
      );
    });
  });

  describe('3. Idempotência e Preservação do Avanço do Ciclo', () => {
    it('retorna a sessão existente de forma idempotente sem duplicar o avanço ao finalizar sessão já concluída', async () => {
      const mockSessaoConcluida = {
        id: SESSAO_1_ID,
        perfilId: ALICE_PERFIL_ID,
        cicloBlocoId: BLOCO_1_ID,
        encerradaEm: new Date(),
        etapaAtingida: 'registro' as const,
        concluida: true,
        segundosEfetivos: 132,
        segundosPausa: 0,
        notaLivre: 'Questões: 8/10 acertos.',
      };

      dbMockState.txSelectOutputs = [
        [{ sessao: mockSessaoConcluida, bloco: mockBloco1, ciclo: mockCiclo }],
      ];

      const resultado = await concluirSessao(SESSAO_1_ID, {
        etapaAtingida: 'registro',
        notaLivre: 'Questões: 8/10 acertos.',
      });

      expect(resultado.id).toBe(SESSAO_1_ID);
      expect(resultado.concluida).toBe(true);
      // Não deve executar novo update em ciclo_estado se já foi encerrada
      expect(mockTxInstance.update).not.toHaveBeenCalled();
    });
  });
});
