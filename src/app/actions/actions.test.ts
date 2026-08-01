import { describe, it, expect, beforeEach, vi } from 'vitest';
import { obterCicloAtivo } from './ciclo';
import { iniciarSessao, atualizarSessao, concluirSessao } from './sessao';

// Estado global de mocks de consulta
let selectCallsCount = 0;
let selectMockedOutputs: any[] = [];

let insertCallsCount = 0;
let insertMockedOutputs: any[] = [];

let updateCallsCount = 0;
let updateMockedOutputs: any[] = [];

// Mock da conexão com o banco de dados e do Drizzle ORM
vi.mock('../../db', () => {
  return {
    db: {
      select: () => {
        const query: any = {};
        query.from = vi.fn().mockReturnValue(query);
        query.where = vi.fn().mockReturnValue(query);
        query.limit = vi.fn().mockReturnValue(query);
        query.innerJoin = vi.fn().mockReturnValue(query);
        query.orderBy = vi.fn().mockReturnValue(query);
        query.then = (resolve: any) => {
          const result = selectMockedOutputs[selectCallsCount];
          selectCallsCount++;
          return Promise.resolve(result || []).then(resolve);
        };
        return query;
      },
      insert: () => {
        const query: any = {};
        query.values = vi.fn().mockReturnValue(query);
        query.onConflictDoUpdate = vi.fn().mockReturnValue(query);
        query.returning = vi.fn().mockReturnValue(query);
        query.then = (resolve: any) => {
          const result = insertMockedOutputs[insertCallsCount];
          insertCallsCount++;
          return Promise.resolve(result || []).then(resolve);
        };
        return query;
      },
      update: () => {
        const query: any = {};
        query.set = vi.fn().mockReturnValue(query);
        query.where = vi.fn().mockReturnValue(query);
        query.returning = vi.fn().mockReturnValue(query);
        query.then = (resolve: any) => {
          const result = updateMockedOutputs[updateCallsCount];
          updateCallsCount++;
          return Promise.resolve(result || []).then(resolve);
        };
        return query;
      },
    },
  };
});

describe('Server Actions - Fase 1', () => {
  beforeEach(() => {
    selectCallsCount = 0;
    selectMockedOutputs = [];
    insertCallsCount = 0;
    insertMockedOutputs = [];
    updateCallsCount = 0;
    updateMockedOutputs = [];
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

  describe('iniciarSessao()', () => {
    it('deve inserir uma nova sessão e retornar seu ID', async () => {
      const sessaoCriada = { id: 'sessao-123', perfilId: 'perfil-1', cicloBlocoId: 'bloco-1', topicoId: 'topico-1' };
      insertMockedOutputs = [
        [sessaoCriada],
      ];

      const idSessao = await iniciarSessao('perfil-1', 'bloco-1', 'topico-1');
      expect(idSessao).toBe('sessao-123');
      expect(insertCallsCount).toBe(1);
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
  });

  describe('concluirSessao()', () => {
    it('deve concluir como "false" se a etapa atingida for menor que "registro"', async () => {
      // Massa de dados
      const sessaoMock = { id: 'sessao-123', perfilId: 'perfil-1', cicloBlocoId: 'bloco-1', topicoId: 'topico-1', segundosEfetivos: 0, segundosPausa: 0 };
      const blocoMock = { id: 'bloco-1', cicloId: 'ciclo-1', ordem: 1 };
      
      selectMockedOutputs = [
        [{ sessao: sessaoMock, bloco: blocoMock }], // 1a chamada: dados da sessao + bloco
        [{ id: 'bloco-1' }, { id: 'bloco-2' }],     // 2a chamada: blocos do ciclo (total = 2)
      ];

      const sessaoConcluidaMock = {
        id: 'sessao-123',
        concluida: false, // Menor que 'registro'
        etapaAtingida: 'questoes',
      };

      updateMockedOutputs = [
        [sessaoConcluidaMock], // Atualização da sessão
      ];

      insertMockedOutputs = [
        [], // Upsert do ciclo estado
      ];

      const res = await concluirSessao('sessao-123', {
        etapaAtingida: 'questoes',
        segundosEfetivos: 1800,
        segundosPausa: 50,
      });

      expect(res.concluida).toBe(false);
      expect(res.etapaAtingida).toBe('questoes');
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
        [], // Upsert cicloEstado
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
        [],                 // 2o insert: upsert cicloEstado
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
        [], // Upsert do cicloEstado
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
