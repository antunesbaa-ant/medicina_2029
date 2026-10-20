import { describe, it, expect, beforeEach, vi } from 'vitest';
import { obterCicloAtivo, iniciarCicloEstudos, resetarPlanejamento } from './ciclo';
import { iniciarSessao, atualizarSessao, concluirSessao } from './sessao';
import { and, eq } from 'drizzle-orm';
import { ciclos } from '../../db/schema';

vi.mock('../../lib/authorization', () => ({
  requireAuthenticatedProfile: vi.fn().mockResolvedValue({
    id: 'perfil-1',
    authUserId: 'auth-1',
    nome: 'Estudante Teste',
    email: null,
    papel: 'estudante',
  }),
  requireRole: vi.fn().mockResolvedValue({
    id: 'perfil-1',
    authUserId: 'auth-1',
    nome: 'Estudante Teste',
    email: null,
    papel: 'estudante',
  }),
  requireManagedStudentProfile: vi.fn().mockResolvedValue({
    id: 'perfil-1',
    authUserId: 'auth-1',
    nome: 'Estudante Teste',
    email: null,
    papel: 'estudante',
  }),
  requireStudentScope: vi.fn().mockResolvedValue({
    id: 'perfil-1',
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
    it('deve retornar o mock resiliente se não houver ciclo ativo no banco', async () => {
      selectMockedOutputs = [
        [], // Busca do ciclo ativo retorna vazio
      ];

      const resultado = await obterCicloAtivo();
      expect(resultado).not.toBeNull();
      expect(resultado?.ciclo.nome).toContain('Ciclo Padrão');
      expect(resultado?.blocos.length).toBeGreaterThan(0);
      expect(selectCallsCount).toBe(1);
      expect(whereValues[0]).toEqual(and(
        eq(ciclos.ativo, true),
        eq(ciclos.estudantePerfilId, 'perfil-1')
      ));
    });

    it('deve retornar o ciclo ativo, blocos ordenados e proxima_ordem', async () => {
      const cicloMock = { id: 'ciclo-1', nome: 'Ciclo Enem', ativo: true, anoLetivo: 2027, blocosPrevistosSemana: 12 };
      const blocosMock = [
        { id: 'bloco-1', cicloId: 'ciclo-1', ordem: 1, disciplinaId: 'd-1', tipo: 'conteudo', estiloAlvo: 'enem', duracaoMin: 50, disciplina: { id: 'd-1', nome: 'Matemática' } },
        { id: 'bloco-2', cicloId: 'ciclo-1', ordem: 2, disciplinaId: 'd-2', tipo: 'questoes', estiloAlvo: 'enem', duracaoMin: 50, disciplina: { id: 'd-2', nome: 'Biologia' } },
      ];
      const estadoMock = { cicloId: 'ciclo-1', proximaOrdem: 2 };

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
      const cicloMock = { id: 'ciclo-1', nome: 'Ciclo Enem', ativo: true, anoLetivo: 2027, blocosPrevistosSemana: 12 };
      
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
      const novoCicloMock = { id: 'novo-ciclo-2027', nome: 'Ciclo Principal - 2027', ativo: true };
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
      expect(res.cicloId).toBe('novo-ciclo-2027');
      expect(insertCallsCount).toBe(30); // 1 para ciclo, 28 para blocos, 1 para cicloEstado
      expect(selectCallsCount).toBe(1); // 1 para disciplinas
      expect(insertedValues[0]).toEqual(expect.objectContaining({
        estudantePerfilId: 'perfil-1'
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
      const sessaoCriada = { id: 'sessao-123', perfilId: 'perfil-1', cicloBlocoId: 'bloco-1', topicoId: 'topico-1' };
      insertMockedOutputs = [
        [sessaoCriada],
      ];

      const idSessao = await iniciarSessao('bloco-1', 'topico-1');
      expect(idSessao).toBe('sessao-123');
      expect(insertCallsCount).toBe(1);
    });

    it('não confirma início quando INSERT não retorna sessão', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await expect(iniciarSessao('bloco-1', 'topico-1')).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
      });
      consoleError.mockRestore();
    });

    it('reutiliza sessão aberta em retry sem novo INSERT', async () => {
      selectMockedOutputs = [[{ id: 'sessao-aberta' }]];

      await expect(iniciarSessao('bloco-1', 'topico-1')).resolves.toBe('sessao-aberta');
      expect(insertCallsCount).toBe(0);
    });
  });

  describe('atualizarSessao()', () => {
    it('deve atualizar a sessão e retornar os dados atualizados', async () => {
      const sessaoAtualizada = {
        id: 'sessao-123',
        perfilId: 'perfil-1',
        cicloBlocoId: 'bloco-1',
        topicoId: 'topico-1',
        etapaAtingida: 'questoes',
        segundosEfetivos: 1200,
        segundosPausa: 100,
      };

      updateMockedOutputs = [
        [sessaoAtualizada],
      ];

      const res = await atualizarSessao('sessao-123', {
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
      await expect(atualizarSessao('sessao-inexistente', { etapaAtingida: 'conteudo' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      consoleError.mockRestore();
    });
  });

  describe('concluirSessao()', () => {
    it('trata repetição de sessão já encerrada como idempotente', async () => {
      const sessaoEncerrada = {
        id: 'sessao-123', perfilId: 'perfil-1', cicloBlocoId: 'bloco-1',
        topicoId: 'topico-1', encerradaEm: new Date(), concluida: true,
      };
      selectMockedOutputs = [[{
        sessao: sessaoEncerrada,
        bloco: { id: 'bloco-1', cicloId: 'ciclo-1', ordem: 1 },
      }]];

      await expect(concluirSessao('sessao-123', { etapaAtingida: 'registro' }))
        .resolves.toEqual(sessaoEncerrada);
      expect(updateCallsCount).toBe(0);
      expect(insertCallsCount).toBe(0);
    });

    it('não prossegue nem confirma quando UPDATE não retorna sessão', async () => {
      selectMockedOutputs = [[{
        sessao: {
          id: 'sessao-123',
          perfilId: 'perfil-1',
          cicloBlocoId: 'bloco-1',
          topicoId: 'topico-1',
          segundosEfetivos: 0,
          segundosPausa: 0,
        },
        bloco: { id: 'bloco-1', cicloId: 'ciclo-1', ordem: 1 },
      }]];
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(concluirSessao('sessao-123', { etapaAtingida: 'registro' })).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
      });
      expect(insertCallsCount).toBe(0);
      consoleError.mockRestore();
    });

    it('deve concluir como "false" se a etapa atingida for menor que "registro"', async () => {
      // Massa de dados
      const sessaoMock = { id: 'sessao-123', perfilId: 'perfil-1', cicloBlocoId: 'bloco-1', topicoId: 'topico-1', segundosEfetivos: 0, segundosPausa: 0 };
      const blocoMock = { id: 'bloco-1', cicloId: 'ciclo-1', ordem: 1 };
      
      selectMockedOutputs = [
        [{ sessao: sessaoMock, bloco: blocoMock }], // 1a chamada: dados da sessao + bloco
      ];

      const sessaoConcluidaMock = {
        id: 'sessao-123',
        concluida: false, // Menor que 'registro'
        etapaAtingida: 'questoes',
      };

      updateMockedOutputs = [
        [sessaoConcluidaMock], // Atualização da sessão
      ];

      const res = await concluirSessao('sessao-123', {
        etapaAtingida: 'questoes',
        segundosEfetivos: 1800,
        segundosPausa: 50,
      });

      expect(res.concluida).toBe(false);
      expect(res.etapaAtingida).toBe('questoes');
      expect(insertCallsCount).toBe(0);
    });

    it('deve concluir como "true" se a etapa atingida for "registro"', async () => {
      const sessaoMock = { id: 'sessao-123', perfilId: 'perfil-1', cicloBlocoId: 'bloco-1', topicoId: 'topico-1', segundosEfetivos: 0, segundosPausa: 0 };
      const blocoMock = { id: 'bloco-1', cicloId: 'ciclo-1', ordem: 1 };

      selectMockedOutputs = [
        [{ sessao: sessaoMock, bloco: blocoMock }], // 1a chamada: dados da sessao + bloco
        [{ id: 'bloco-1' }, { id: 'bloco-2' }],     // 2a chamada: blocos do ciclo (total = 2)
      ];

      const sessaoConcluidaMock = {
        id: 'sessao-123',
        concluida: true, // Atingiu 'registro'
        etapaAtingida: 'registro',
      };

      updateMockedOutputs = [
        [sessaoConcluidaMock],
      ];

      insertMockedOutputs = [
        [{ cicloId: 'ciclo-1' }], // Upsert cicloEstado
      ];

      const res = await concluirSessao('sessao-123', {
        etapaAtingida: 'registro',
        segundosEfetivos: 3000,
      });

      expect(res.concluida).toBe(true);
    });

    it('deve registrar erros na tabela correspondente', async () => {
      const sessaoMock = { id: 'sessao-123', perfilId: 'perfil-1', cicloBlocoId: 'bloco-1', topicoId: 'topico-1', segundosEfetivos: 0, segundosPausa: 0 };
      const blocoMock = { id: 'bloco-1', cicloId: 'ciclo-1', ordem: 1 };
      const questaoMock = { id: 'q-1', disciplinaId: 'd-1', estilo: 'enem' };

      selectMockedOutputs = [
        [{ sessao: sessaoMock, bloco: blocoMock }], // 1a chamada concluirSessao: sessao + bloco
        [questaoMock],                              // 2a chamada concluirSessao (dentro do loop de erro): busca questao
        [{ id: 'bloco-1' }, { id: 'bloco-2' }],     // 3a chamada concluirSessao: blocos do ciclo (total = 2)
      ];

      const sessaoConcluidaMock = {
        id: 'sessao-123',
        concluida: true,
        etapaAtingida: 'registro',
      };

      updateMockedOutputs = [
        [sessaoConcluidaMock],
      ];

      insertMockedOutputs = [
        [{ id: 'erro-1' }], // 1o insert: tabela erros
        [{ cicloId: 'ciclo-1' }], // 2o insert: upsert cicloEstado
      ];

      const res = await concluirSessao('sessao-123', {
        etapaAtingida: 'registro',
        errosParaRegistrar: [
          {
            questaoId: 'q-1',
            tentativaId: 't-1',
            tipoErro: 'conteudo',
            descricaoLivre: 'Esqueci a fórmula',
            conceitoCorreto: 'F = m.a',
          },
        ],
      });

      expect(res.concluida).toBe(true);
      expect(insertCallsCount).toBe(2); // 1 para erros e 1 para cicloEstado
    });

    it('aborta antes do ponteiro quando o erro derivado não é confirmado', async () => {
      const sessaoMock = {
        id: 'sessao-123', perfilId: 'perfil-1', cicloBlocoId: 'bloco-1',
        topicoId: 'topico-1', segundosEfetivos: 0, segundosPausa: 0,
      };
      selectMockedOutputs = [
        [{ sessao: sessaoMock, bloco: { id: 'bloco-1', cicloId: 'ciclo-1', ordem: 1 } }],
        [{ disciplinaId: 'd-1', estilo: 'enem' }],
        [{ id: 'tentativa-1' }],
      ];
      updateMockedOutputs = [[{ ...sessaoMock, concluida: true }]];
      insertMockedOutputs = [[]];

      await expect(concluirSessao('sessao-123', {
        etapaAtingida: 'registro',
        errosParaRegistrar: [{ questaoId: 'q-1', tentativaId: 'tentativa-1', tipoErro: 'conteudo' }],
      })).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' });
      expect(insertCallsCount).toBe(1);
    });

    it('deve avançar o ponteiro proximaOrdem no ciclo e resetar para 1 ao passar do limite', async () => {
      const sessaoMock = { id: 'sessao-123', perfilId: 'perfil-1', cicloBlocoId: 'bloco-2', topicoId: 'topico-1', segundosEfetivos: 0, segundosPausa: 0 };
      // Bloco atual é ordem 2 de um total de 2 blocos. ProximaOrdem deve resetar para 1.
      const blocoMock = { id: 'bloco-2', cicloId: 'ciclo-1', ordem: 2 };

      selectMockedOutputs = [
        [{ sessao: sessaoMock, bloco: blocoMock }],
        [{ id: 'bloco-1' }, { id: 'bloco-2' }],
      ];

      const sessaoConcluidaMock = { id: 'sessao-123', concluida: true, etapaAtingida: 'registro' };

      updateMockedOutputs = [
        [sessaoConcluidaMock],
      ];

      insertMockedOutputs = [
        [{ cicloId: 'ciclo-1' }], // Upsert do cicloEstado
      ];

      const res = await concluirSessao('sessao-123', {
        etapaAtingida: 'registro',
      });

      expect(res.concluida).toBe(true);
      expect(selectCallsCount).toBe(2);
      expect(insertCallsCount).toBe(1);
    });
  });
});
