import { describe, it, expect, beforeEach, vi } from 'vitest';
import { obterCicloAtivo, iniciarCicloEstudos, resetarPlanejamento } from './ciclo';
import { iniciarSessao, atualizarSessao, concluirSessao } from './sessao';
import { and, eq } from 'drizzle-orm';
import { ciclos } from '../../db/schema';

const PERFIL_1_ID = '10000000-0000-4000-8000-000000000001';
const PERFIL_2_ID = '10000000-0000-4000-8000-000000000002';
const CICLO_1_ID = '40000000-0000-4000-8000-000000000001';
const BLOCO_1_ID = '41000000-0000-4000-8000-000000000001';
const BLOCO_2_ID = '41000000-0000-4000-8000-000000000002';
const TOPICO_1_ID = '31000000-0000-4000-8000-000000000001';
const DISCIPLINA_1_ID = '30000000-0000-4000-8000-000000000001';
const DISCIPLINA_2_ID = '30000000-0000-4000-8000-000000000002';
const SESSAO_1_ID = '42000000-0000-4000-8000-000000000001';
const QUESTAO_1_ID = '70000000-0000-4000-8000-000000000001';
const TENTATIVA_1_ID = '71000000-0000-4000-8000-000000000001';

vi.mock('../../lib/authorization', () => ({
  requireAuthenticatedProfile: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001',
    authUserId: 'a0000000-0000-4000-8000-000000000001',
    nome: 'Estudante Teste',
    email: null,
    papel: 'estudante',
  }),
  requireRole: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001',
    authUserId: 'a0000000-0000-4000-8000-000000000001',
    nome: 'Estudante Teste',
    email: null,
    papel: 'estudante',
  }),
  requireManagedStudentProfile: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001',
    authUserId: 'a0000000-0000-4000-8000-000000000001',
    nome: 'Estudante Teste',
    email: null,
    papel: 'estudante',
  }),
  requireStudentScope: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001',
    nome: 'Estudante Teste',
    email: null,
    papel: 'estudante',
  }),
  assertOwnership: vi.fn(),
}));

// Estado global de mocks de consulta
let selectCallsCount = 0;
let selectMockedOutputs: unknown[][] = [];

let insertCallsCount = 0;
let insertMockedOutputs: unknown[][] = [];

let updateCallsCount = 0;
let updateMockedOutputs: unknown[][] = [];
let insertedValues: unknown[] = [];
let whereValues: unknown[] = [];

type MockResolver = (value: unknown[]) => unknown;

interface MockQuery {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  for: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  then: (resolve: MockResolver) => Promise<unknown>;
}

interface MockDb {
  select: () => MockQuery;
  insert: () => MockQuery;
  update: () => MockQuery;
  delete: () => MockQuery;
  transaction: (callback: (transaction: MockDb) => unknown) => Promise<unknown>;
  execute: () => Promise<unknown>;
}

// Mock da conexão com o banco de dados e do Drizzle ORM
vi.mock('../../db', () => {
  const mockDb: MockDb = {
    select: () => {
      const query = {} as MockQuery;
      query.from = vi.fn().mockReturnValue(query);
      query.where = vi.fn((condition) => {
        whereValues.push(condition);
        return query;
      });
      query.limit = vi.fn().mockReturnValue(query);
      query.innerJoin = vi.fn().mockReturnValue(query);
      query.orderBy = vi.fn().mockReturnValue(query);
      query.for = vi.fn().mockReturnValue(query);
      query.then = (resolve: MockResolver) => {
        const result = selectMockedOutputs[selectCallsCount];
        selectCallsCount++;
        return Promise.resolve(result || []).then(resolve);
      };
      return query;
    },
    insert: () => {
      const query = {} as MockQuery;
      query.values = vi.fn((values) => {
        insertedValues.push(values);
        return query;
      });
      query.onConflictDoUpdate = vi.fn().mockReturnValue(query);
      query.returning = vi.fn().mockReturnValue(query);
      query.then = (resolve: MockResolver) => {
        const result = insertMockedOutputs[insertCallsCount];
        insertCallsCount++;
        return Promise.resolve(result || []).then(resolve);
      };
      return query;
    },
    update: () => {
      const query = {} as MockQuery;
      query.set = vi.fn().mockReturnValue(query);
      query.where = vi.fn().mockReturnValue(query);
      query.returning = vi.fn().mockReturnValue(query);
      query.then = (resolve: MockResolver) => {
        const result = updateMockedOutputs[updateCallsCount];
        updateCallsCount++;
        return Promise.resolve(result || []).then(resolve);
      };
      return query;
    },
    delete: () => {
      const query = {} as MockQuery;
      query.where = vi.fn().mockReturnValue(query);
      query.then = (resolve: MockResolver) => {
        return Promise.resolve([]).then(resolve);
      };
      return query;
    },
    transaction: async (callback: (transaction: MockDb) => unknown) => {
      return await callback(mockDb);
    },
    execute: async () => [],
  };
  return { db: mockDb };
});

describe('Server Actions - Fase 1', () => {
  beforeEach(() => {
    selectCallsCount = 0;
    selectMockedOutputs = [];
    insertCallsCount = 0;
    insertMockedOutputs = [];
    updateCallsCount = 0;
    updateMockedOutputs = [];
    insertedValues = [];
    whereValues = [];
  });

  describe('obterCicloAtivo()', () => {
    it('deve retornar null se não houver ciclo ativo no banco (sem fallback mockado — F1.14)', async () => {
      selectMockedOutputs = [
        [], // Busca do ciclo ativo retorna vazio
      ];

      const resultado = await obterCicloAtivo();
      expect(resultado).toBeNull();
      expect(selectCallsCount).toBe(1);
      expect(whereValues[0]).toEqual(and(
        eq(ciclos.ativo, true),
        eq(ciclos.estudantePerfilId, PERFIL_1_ID)
      ));
    });

    it('deve retornar o ciclo ativo, blocos ordenados e proxima_ordem', async () => {
      const cicloMock = { id: CICLO_1_ID, nome: 'Ciclo Enem', ativo: true, anoLetivo: 2027, blocosPrevistosSemana: 12 };
      const blocosMock = [
        { id: BLOCO_1_ID, cicloId: CICLO_1_ID, ordem: 1, disciplinaId: DISCIPLINA_1_ID, tipo: 'conteudo', estiloAlvo: 'enem', duracaoMin: 50, disciplina: { id: DISCIPLINA_1_ID, nome: 'Matemática' } },
        { id: BLOCO_2_ID, cicloId: CICLO_1_ID, ordem: 2, disciplinaId: DISCIPLINA_2_ID, tipo: 'questoes', estiloAlvo: 'enem', duracaoMin: 50, disciplina: { id: DISCIPLINA_2_ID, nome: 'Biologia' } },
      ];
      const estadoMock = { cicloId: CICLO_1_ID, proximaOrdem: 2 };

      selectMockedOutputs = [
        [cicloMock],  // 1a chamada: ciclo ativo
        blocosMock,   // 2a chamada: blocos com disciplinas
        [estadoMock], // 3a chamada: estado do ciclo
      ];

      const resultado = await obterCicloAtivo();
      expect(resultado).not.toBeNull();
      expect(resultado?.ciclo).toEqual(cicloMock);
      expect(resultado?.blocos).toEqual(blocosMock);
      expect(resultado?.proximaOrdem).toBe(2);
      expect(selectCallsCount).toBe(3);
    });

    it('deve usar proximaOrdem = 1 por padrão caso o cicloEstado não esteja definido', async () => {
      const cicloMock = { id: CICLO_1_ID, nome: 'Ciclo Enem', ativo: true, anoLetivo: 2027, blocosPrevistosSemana: 12 };
      
      selectMockedOutputs = [
        [cicloMock], // 1a chamada: ciclo ativo
        [],          // 2a chamada: blocos vazios
        [],          // 3a chamada: estado vazio
      ];

      const resultado = await obterCicloAtivo();
      expect(resultado?.proximaOrdem).toBe(1);
    });
  });

  describe('iniciarCicloEstudos()', () => {
    it('deve desativar ciclos anteriores, criar novo ciclo com 28 blocos e iniciar cicloEstado em 1', async () => {
      const novoCicloMock = { id: CICLO_1_ID, nome: 'Ciclo Principal - 2027', ativo: true };
      const disciplinasMock = [
        { id: 'd-mat', nome: 'Matemática', area: 'matematica', corHex: '#C98A2E', ordem: 1 },
        { id: 'd-bio', nome: 'Biologia', area: 'natureza', corHex: '#0E3D4D', ordem: 2 },
        { id: 'd-qui', nome: 'Química', area: 'natureza', corHex: '#17607A', ordem: 3 },
        { id: 'd-fis', nome: 'Física', area: 'natureza', corHex: '#B5502B', ordem: 4 },
        { id: 'd-red', nome: 'Redação', area: 'redacao', corHex: '#DE6B48', ordem: 5 },
        { id: 'd-lin', nome: 'Linguagens', area: 'linguagens', corHex: '#7A306C', ordem: 6 },
        { id: 'd-his', nome: 'História', area: 'humanas', corHex: '#8B575C', ordem: 7 },
        { id: 'd-geo', nome: 'Geografia', area: 'humanas', corHex: '#3A506B', ordem: 8 },
        { id: 'd-fil', nome: 'Filosofia', area: 'humanas', corHex: '#5BC0BE', ordem: 9 },
        { id: 'd-soc', nome: 'Sociologia', area: 'humanas', corHex: '#6FFFE9', ordem: 10 },
        { id: 'd-ext', nome: 'Língua Estrangeira', area: 'linguagens', corHex: '#48A9A6', ordem: 11 }
      ];

      insertMockedOutputs = [
        [novoCicloMock], // Para insert(ciclos)
      ];

      selectMockedOutputs = [
        disciplinasMock, // Para select().from(disciplinas)
      ];

      const res = await iniciarCicloEstudos();
      expect(res.sucesso).toBe(true);
      expect(res.cicloId).toBe(CICLO_1_ID);
      expect(insertCallsCount).toBe(30); // 1 para ciclo, 28 para blocos, 1 para cicloEstado
      expect(selectCallsCount).toBe(1); // 1 para disciplinas
      expect(insertedValues[0]).toEqual(expect.objectContaining({
        estudantePerfilId: PERFIL_1_ID
      }));
    });
  });

  describe('resetarPlanejamento()', () => {
    it('deve desativar todos os ciclos e limpar cicloEstado', async () => {
      const res = await resetarPlanejamento();
      expect(res.sucesso).toBe(true);
      expect(res.mensagem).toContain('resetado com sucesso');
    });
  });

  describe('iniciarSessao()', () => {
    it('deve inserir uma nova sessão e retornar seu ID', async () => {
      const sessaoCriada = { id: SESSAO_1_ID, perfilId: PERFIL_1_ID, cicloBlocoId: BLOCO_1_ID, topicoId: TOPICO_1_ID };
      selectMockedOutputs = [
        [], // Nenhuma sessão aberta
        [{
          blocoId: BLOCO_1_ID,
          estudantePerfilId: PERFIL_1_ID,
          blocoDisciplinaId: DISCIPLINA_1_ID,
          topicoDisciplinaId: DISCIPLINA_1_ID,
        }],
      ];
      insertMockedOutputs = [
        [sessaoCriada],
      ];

      const idSessao = await iniciarSessao(BLOCO_1_ID, TOPICO_1_ID);
      expect(idSessao).toBe(SESSAO_1_ID);
      expect(insertCallsCount).toBe(1);
    });

    it('não confirma início quando INSERT não retorna sessão', async () => {
      selectMockedOutputs = [
        [],
        [{
          blocoId: BLOCO_1_ID,
          estudantePerfilId: PERFIL_1_ID,
          blocoDisciplinaId: DISCIPLINA_1_ID,
          topicoDisciplinaId: DISCIPLINA_1_ID,
        }],
      ];
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await expect(iniciarSessao(BLOCO_1_ID, TOPICO_1_ID)).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
      });
      consoleError.mockRestore();
    });

    it('reutiliza sessão aberta em retry sem novo INSERT', async () => {
      selectMockedOutputs = [[{ id: SESSAO_1_ID }]];

      await expect(iniciarSessao(BLOCO_1_ID, TOPICO_1_ID)).resolves.toBe(SESSAO_1_ID);
      expect(insertCallsCount).toBe(0);
    });

    it('rejeita UUID inválido antes de acessar o banco', async () => {
      await expect(iniciarSessao('bloco-invalido', TOPICO_1_ID)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(selectCallsCount).toBe(0);
      expect(insertCallsCount).toBe(0);
    });

    it('rejeita bloco inexistente, de outro perfil ou com tópico de outra disciplina sem inserir', async () => {
      selectMockedOutputs = [[], []];
      await expect(iniciarSessao(BLOCO_1_ID, TOPICO_1_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(insertCallsCount).toBe(0);

      selectCallsCount = 0;
      selectMockedOutputs = [
        [],
        [{
          blocoId: BLOCO_1_ID,
          estudantePerfilId: PERFIL_2_ID,
          blocoDisciplinaId: DISCIPLINA_1_ID,
          topicoDisciplinaId: DISCIPLINA_1_ID,
        }],
      ];
      await expect(iniciarSessao(BLOCO_1_ID, TOPICO_1_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(insertCallsCount).toBe(0);
    });
  });

  describe('atualizarSessao()', () => {
    it('deve atualizar a sessão e retornar os dados atualizados', async () => {
      const sessaoAtualizada = {
        id: SESSAO_1_ID,
        perfilId: PERFIL_1_ID,
        cicloBlocoId: BLOCO_1_ID,
        topicoId: TOPICO_1_ID,
        etapaAtingida: 'questoes',
        segundosEfetivos: 1200,
        segundosPausa: 100,
      };

      updateMockedOutputs = [
        [sessaoAtualizada],
      ];

      const res = await atualizarSessao(SESSAO_1_ID, {
        etapaAtingida: 'questoes',
        segundosEfetivos: 1200,
        segundosPausa: 100,
      });

      expect(res.etapaAtingida).toBe('questoes');
      expect(res.segundosEfetivos).toBe(1200);
      expect(res.segundosPausa).toBe(100);
      expect(updateCallsCount).toBe(1);
    });

    it('diferencia UPDATE sem linha de falha de persistência genérica', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await expect(atualizarSessao(SESSAO_1_ID, { etapaAtingida: 'conteudo' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      consoleError.mockRestore();
    });

    it('rejeita UUID inválido, payload vazio ou valores fora dos limites sem escrever', async () => {
      await expect(atualizarSessao('id-invalido', { etapaAtingida: 'conteudo' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      await expect(atualizarSessao(SESSAO_1_ID, {})).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      await expect(atualizarSessao(SESSAO_1_ID, { segundosEfetivos: -10 })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(updateCallsCount).toBe(0);
    });
  });

  describe('concluirSessao()', () => {
    it('trata repetição de sessão já encerrada como idempotente', async () => {
      const sessaoEncerrada = {
        id: SESSAO_1_ID, perfilId: PERFIL_1_ID, cicloBlocoId: BLOCO_1_ID,
        topicoId: TOPICO_1_ID, encerradaEm: new Date(), concluida: true, etapaAtingida: 'registro',
      };
      selectMockedOutputs = [[{
        sessao: sessaoEncerrada,
        bloco: { id: BLOCO_1_ID, cicloId: CICLO_1_ID, ordem: 1 },
      }]];

      await expect(concluirSessao(SESSAO_1_ID, { etapaAtingida: 'registro' }))
        .resolves.toEqual(sessaoEncerrada);
      expect(updateCallsCount).toBe(0);
      expect(insertCallsCount).toBe(0);
    });

    it('rejeita repetição de sessão encerrada com etapa conflitante', async () => {
      const sessaoEncerrada = {
        id: SESSAO_1_ID, perfilId: PERFIL_1_ID, cicloBlocoId: BLOCO_1_ID,
        topicoId: TOPICO_1_ID, encerradaEm: new Date(), concluida: false, etapaAtingida: 'questoes',
      };
      selectMockedOutputs = [[{
        sessao: sessaoEncerrada,
        bloco: { id: BLOCO_1_ID, cicloId: CICLO_1_ID, ordem: 1 },
      }]];

      await expect(concluirSessao(SESSAO_1_ID, { etapaAtingida: 'registro' })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(updateCallsCount).toBe(0);
      expect(insertCallsCount).toBe(0);
    });

    it('não prossegue nem confirma quando UPDATE não retorna sessão', async () => {
      selectMockedOutputs = [[{
        sessao: {
          id: SESSAO_1_ID,
          perfilId: PERFIL_1_ID,
          cicloBlocoId: BLOCO_1_ID,
          topicoId: TOPICO_1_ID,
          segundosEfetivos: 0,
          segundosPausa: 0,
        },
        bloco: { id: BLOCO_1_ID, cicloId: CICLO_1_ID, ordem: 1 },
      }]];
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(concluirSessao(SESSAO_1_ID, { etapaAtingida: 'registro' })).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
      });
      expect(insertCallsCount).toBe(0);
      consoleError.mockRestore();
    });

    it('deve concluir como "false" se a etapa atingida for menor que "registro"', async () => {
      const sessaoMock = { id: SESSAO_1_ID, perfilId: PERFIL_1_ID, cicloBlocoId: BLOCO_1_ID, topicoId: TOPICO_1_ID, segundosEfetivos: 0, segundosPausa: 0 };
      const blocoMock = { id: BLOCO_1_ID, cicloId: CICLO_1_ID, ordem: 1 };
      
      selectMockedOutputs = [
        [{ sessao: sessaoMock, bloco: blocoMock }],
      ];

      const sessaoConcluidaMock = {
        id: SESSAO_1_ID,
        concluida: false,
        etapaAtingida: 'questoes',
      };

      updateMockedOutputs = [
        [sessaoConcluidaMock],
      ];

      const res = await concluirSessao(SESSAO_1_ID, {
        etapaAtingida: 'questoes',
        segundosEfetivos: 1800,
        segundosPausa: 50,
      });

      expect(res.concluida).toBe(false);
      expect(res.etapaAtingida).toBe('questoes');
      expect(insertCallsCount).toBe(0);
    });

    it('deve concluir como "true" se a etapa atingida for "registro"', async () => {
      const sessaoMock = { id: SESSAO_1_ID, perfilId: PERFIL_1_ID, cicloBlocoId: BLOCO_1_ID, topicoId: TOPICO_1_ID, segundosEfetivos: 0, segundosPausa: 0 };
      const blocoMock = { id: BLOCO_1_ID, cicloId: CICLO_1_ID, ordem: 1 };

      selectMockedOutputs = [
        [{ sessao: sessaoMock, bloco: blocoMock }],
        [{ id: BLOCO_1_ID }, { id: BLOCO_2_ID }],
      ];

      const sessaoConcluidaMock = {
        id: SESSAO_1_ID,
        concluida: true,
        etapaAtingida: 'registro',
      };

      updateMockedOutputs = [
        [sessaoConcluidaMock],
      ];

      insertMockedOutputs = [
        [{ cicloId: CICLO_1_ID }],
      ];

      const res = await concluirSessao(SESSAO_1_ID, {
        etapaAtingida: 'registro',
        segundosEfetivos: 3000,
      });

      expect(res.concluida).toBe(true);
    });

    it('deve registrar erros na tabela correspondente', async () => {
      const sessaoMock = { id: SESSAO_1_ID, perfilId: PERFIL_1_ID, cicloBlocoId: BLOCO_1_ID, topicoId: TOPICO_1_ID, segundosEfetivos: 0, segundosPausa: 0 };
      const blocoMock = { id: BLOCO_1_ID, cicloId: CICLO_1_ID, ordem: 1, disciplinaId: DISCIPLINA_1_ID };
      const questaoMock = { id: QUESTAO_1_ID, disciplinaId: DISCIPLINA_1_ID, estilo: 'enem' };

      selectMockedOutputs = [
        [{ sessao: sessaoMock, bloco: blocoMock }],
        [questaoMock],
        [{ id: TENTATIVA_1_ID, perfilId: PERFIL_1_ID, sessaoId: SESSAO_1_ID, questaoId: QUESTAO_1_ID, correta: false }],
        [{ id: BLOCO_1_ID }, { id: BLOCO_2_ID }],
      ];

      const sessaoConcluidaMock = {
        id: SESSAO_1_ID,
        concluida: true,
        etapaAtingida: 'registro',
      };

      updateMockedOutputs = [
        [sessaoConcluidaMock],
      ];

      insertMockedOutputs = [
        [{ id: '72000000-0000-4000-8000-000000000001' }],
        [{ cicloId: CICLO_1_ID }],
      ];

      const res = await concluirSessao(SESSAO_1_ID, {
        etapaAtingida: 'registro',
        errosParaRegistrar: [
          {
            questaoId: QUESTAO_1_ID,
            tentativaId: TENTATIVA_1_ID,
            tipoErro: 'conteudo',
            descricaoLivre: 'Esqueci a fórmula',
            conceitoCorreto: 'F = m.a',
          },
        ],
      });

      expect(res.concluida).toBe(true);
      expect(insertCallsCount).toBe(2);
    });

    it('aborta antes do ponteiro quando o erro derivado não é confirmado', async () => {
      const sessaoMock = {
        id: SESSAO_1_ID, perfilId: PERFIL_1_ID, cicloBlocoId: BLOCO_1_ID,
        topicoId: TOPICO_1_ID, segundosEfetivos: 0, segundosPausa: 0,
      };
      selectMockedOutputs = [
        [{ sessao: sessaoMock, bloco: { id: BLOCO_1_ID, cicloId: CICLO_1_ID, ordem: 1, disciplinaId: DISCIPLINA_1_ID } }],
        [{ disciplinaId: DISCIPLINA_1_ID, estilo: 'enem' }],
        [{ id: TENTATIVA_1_ID }],
      ];
      updateMockedOutputs = [[{ ...sessaoMock, concluida: true }]];
      insertMockedOutputs = [[]];

      await expect(concluirSessao(SESSAO_1_ID, {
        etapaAtingida: 'registro',
        errosParaRegistrar: [{ questaoId: QUESTAO_1_ID, tentativaId: TENTATIVA_1_ID, tipoErro: 'conteudo' }],
      })).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' });
      expect(insertCallsCount).toBe(1);
    });

    it('rejeita erro cuja questão pertence a outra disciplina ou tentativa correta sem escrever', async () => {
      const sessaoMock = {
        id: SESSAO_1_ID, perfilId: PERFIL_1_ID, cicloBlocoId: BLOCO_1_ID,
        topicoId: TOPICO_1_ID, segundosEfetivos: 0, segundosPausa: 0,
      };
      selectMockedOutputs = [
        [{ sessao: sessaoMock, bloco: { id: BLOCO_1_ID, cicloId: CICLO_1_ID, ordem: 1, disciplinaId: DISCIPLINA_1_ID } }],
        [{ disciplinaId: DISCIPLINA_2_ID, estilo: 'enem' }],
        [{ id: TENTATIVA_1_ID, perfilId: PERFIL_1_ID, sessaoId: SESSAO_1_ID, questaoId: QUESTAO_1_ID, correta: false }],
      ];

      await expect(concluirSessao(SESSAO_1_ID, {
        etapaAtingida: 'registro',
        errosParaRegistrar: [{ questaoId: QUESTAO_1_ID, tentativaId: TENTATIVA_1_ID, tipoErro: 'conteudo' }],
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(updateCallsCount).toBe(0);
      expect(insertCallsCount).toBe(0);
    });

    it('deve avançar o ponteiro proximaOrdem no ciclo e resetar para 1 ao passar do limite', async () => {
      const sessaoMock = { id: SESSAO_1_ID, perfilId: PERFIL_1_ID, cicloBlocoId: BLOCO_2_ID, topicoId: TOPICO_1_ID, segundosEfetivos: 0, segundosPausa: 0 };
      const blocoMock = { id: BLOCO_2_ID, cicloId: CICLO_1_ID, ordem: 2 };

      selectMockedOutputs = [
        [{ sessao: sessaoMock, bloco: blocoMock }],
        [{ id: BLOCO_1_ID }, { id: BLOCO_2_ID }],
      ];

      const sessaoConcluidaMock = { id: SESSAO_1_ID, concluida: true, etapaAtingida: 'registro' };

      updateMockedOutputs = [
        [sessaoConcluidaMock],
      ];

      insertMockedOutputs = [
        [{ cicloId: CICLO_1_ID }],
      ];

      const res = await concluirSessao(SESSAO_1_ID, {
        etapaAtingida: 'registro',
      });

      expect(res.concluida).toBe(true);
      expect(selectCallsCount).toBe(2);
      expect(insertCallsCount).toBe(1);
    });
  });
});
