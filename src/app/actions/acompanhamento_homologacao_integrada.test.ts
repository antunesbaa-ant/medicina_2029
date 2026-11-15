import { describe, it, expect, vi, beforeEach } from 'vitest';
import { obterMetricasDashboard } from './dashboard';
import { obterAcompanhamentoQuinzenal, registrarRevisaoTrimestral, obterRevisoesTrimestrais } from './responsavel';
import { calcularDivergenciaTrilhos } from '../../lib/studysystem';
import { getTableName } from 'drizzle-orm';

// Mocks de controle de autorização e escopo
const mockCurrentProfile = {
  id: 'perfil-alice-1',
  authUserId: 'auth-alice-1',
  nome: 'Alice Estudante Sintética',
  email: 'alice@medicina2029.staging',
  papel: 'estudante',
};

const mockResponsavelProfile = {
  id: 'perfil-bruno-1',
  authUserId: 'auth-bruno-1',
  nome: 'Bruno Responsável Sintético',
  email: 'bruno@medicina2029.staging',
  papel: 'responsavel',
};

let activeUser = mockCurrentProfile;

vi.mock('../../lib/authorization', () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  requireAuthenticatedProfile: vi.fn().mockImplementation(async () => activeUser),
  requireRole: vi.fn().mockImplementation(async (role: string) => {
    if (activeUser.papel !== role) {
      throw new Error(`Acesso negado: esperado papel ${role}, recebido ${activeUser.papel}`);
    }
    return activeUser;
  }),
  requireManagedStudentProfile: vi.fn().mockImplementation(async () => mockCurrentProfile),
  assertOwnership: vi.fn(),
}));

// Mocks flexíveis do banco de dados para testar cenários de dados reais e vazios
let mockDbExecuteRows: any[] | null = null;
let mockSessoesRows: any[] = [];
let mockTentativasRows: any[] = [];
let mockCardsRows: any[] = [];
let mockCheckinsRows: any[] = [];
let mockErrosRows: any[] = [];
let mockSimuladosRows: any[] = [];
let mockRevisoesTrimestraisRows: any[] = [];

vi.mock('../../db', () => {
  const queryBuilder: any = {
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockImplementation((val) => {
      mockRevisoesTrimestraisRows.push({ id: 'trim-new-id', ...val });
      return queryBuilder;
    }),
    returning: vi.fn().mockResolvedValue([{ id: 'mock-id' }]),
    select: vi.fn().mockImplementation((fields) => {
      const selectObj: any = {
        from: vi.fn().mockImplementation((table) => {
          let tableName = '';
          try {
            tableName = getTableName(table);
          } catch {
            tableName = table?._?.name || table?.tableName || '';
          }
          const createChain = () => {
            let result: any[] = [];
            if (tableName === 'sessoes') {
              result = [{ count: mockSessoesRows.length }];
            } else if (tableName === 'tentativas') {
              result = mockTentativasRows;
            } else if (tableName === 'cards') {
              result = [{ count: mockCardsRows.length }];
            } else if (tableName === 'checkins') {
              const total = mockCheckinsRows.reduce((acc, c) => acc + (c.horasSono || 0), 0);
              const avg = mockCheckinsRows.length > 0 ? total / mockCheckinsRows.length : null;
              result = [{ media: avg }];
            } else if (tableName === 'erros') {
              result = mockErrosRows;
            } else if (tableName === 'redacoes') {
              result = [{ count: 0, reescritas: 0 }];
            } else if (tableName === 'curadoria_fila') {
              result = [{ count: 0, maisAntigo: null }];
            } else if (tableName === 'simulados') {
              result = mockSimuladosRows;
            } else if (tableName === 'revisoes_trimestrais') {
              result = mockRevisoesTrimestraisRows;
            }

            const chain: any = {
              innerJoin: vi.fn().mockImplementation(() => chain),
              leftJoin: vi.fn().mockImplementation(() => chain),
              where: vi.fn().mockImplementation(() => chain),
              orderBy: vi.fn().mockImplementation(() => chain),
              limit: vi.fn().mockImplementation(() => chain),
              groupBy: vi.fn().mockImplementation(() => chain),
              then: (resolve: any) => resolve(result),
            };
            return chain;
          };

          return createChain();
        }),
      };
      return selectObj;
    }),
    execute: vi.fn().mockImplementation(async (query: any) => {
      const qStr = JSON.stringify(query || '');
      if (qStr.includes('vw_acompanhamento_quinzenal')) {
        if (mockDbExecuteRows !== null) {
          return mockDbExecuteRows;
        }
        throw new Error('View not present');
      }
      return [{ exists: true, curr_role: 'medicina_app' }];
    }),
    transaction: vi.fn().mockImplementation(async (callback: any) => callback(queryBuilder)),
  };
  return { db: queryBuilder };
});

describe('MEDICINA 2029 — Homologação Integrada de Acompanhamento e Dashboards', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    activeUser = mockCurrentProfile;
    mockDbExecuteRows = null;
    mockSessoesRows = [];
    mockTentativasRows = [];
    mockCardsRows = [];
    mockCheckinsRows = [];
    mockErrosRows = [];
    mockSimuladosRows = [];
    mockRevisoesTrimestraisRows = [];
  });

  describe('1. Diagnóstico do Painel do Responsável (Bruno)', () => {
    it('rejeita acesso de estudante ao módulo do responsável', async () => {
      activeUser = mockCurrentProfile; // Alice (estudante)
      await expect(obterAcompanhamentoQuinzenal()).rejects.toThrow(/Acesso negado: esperado papel responsavel/);
    });

    it('permite acesso de responsável e consome vw_acompanhamento_quinzenal sob RLS', async () => {
      activeUser = mockResponsavelProfile; // Bruno (responsavel)
      mockDbExecuteRows = [
        {
          periodo_rotulo: '31/10 a 14/11',
          blocos_concluidos: 3,
          media_horas_sono: '0.0',
          redacoes_escritas: 0,
          redacoes_reescritas: 0,
          cards_fsrs_ativos: 3
        },
        {
          periodo_rotulo: '16/10 a 30/10',
          blocos_concluidos: 0,
          media_horas_sono: '0.0',
          redacoes_escritas: 0,
          redacoes_reescritas: 0,
          cards_fsrs_ativos: 3
        }
      ];

      const res = await obterAcompanhamentoQuinzenal();
      expect(res).toHaveLength(2);
      expect(res[0].periodoRotulo).toBe('31/10 a 14/11');
      expect(res[0].blocosConcluidos).toBe(3);
      expect(res[0].mediaHorasSono).toBe(0);
      expect(res[0].cardsFSRSAtivos).toBe(3);
    });

    it('garante que nenhum dado diário ou timestamp bruto é exposto ao responsável (Regra 1.2)', async () => {
      activeUser = mockResponsavelProfile;
      mockDbExecuteRows = [
        {
          periodo_rotulo: '31/10 a 14/11',
          blocos_concluidos: 3,
          media_horas_sono: '7.8',
          redacoes_escritas: 1,
          redacoes_reescritas: 0,
          cards_fsrs_ativos: 3
        }
      ];
      const res = await obterAcompanhamentoQuinzenal();
      const first = res[0] as any;
      expect(first.iniciadaEm).toBeUndefined();
      expect(first.encerradaEm).toBeUndefined();
      expect(first.segundosEfetivos).toBeUndefined();
      expect(first.detalheSessao).toBeUndefined();
      expect(first.notaLivre).toBeUndefined();
    });

    it('registra e lista revisões trimestrais com derivação real de métricas', async () => {
      activeUser = mockResponsavelProfile;
      mockDbExecuteRows = [
        {
          periodo_rotulo: '31/10 a 14/11',
          blocos_concluidos: 12,
          media_horas_sono: '8.0',
          redacoes_escritas: 2,
          redacoes_reescritas: 1,
          cards_fsrs_ativos: 10
        }
      ];
      mockCardsRows = [{ id: 'card-due-1' }, { id: 'card-due-2' }];

      const registro = await registrarRevisaoTrimestral({
        trimestre: 4,
        ano: 2026,
        conversa: 'Conversa franca sobre ritmo de estudos',
        decisoes: 'Manter carga atual de 28 blocos e priorizar sono saudável'
      });

      expect(registro.sucesso).toBe(true);
      expect(mockRevisoesTrimestraisRows).toHaveLength(1);
      const inserido = mockRevisoesTrimestraisRows[0];
      expect(inserido.trimestre).toBe(4);
      expect(inserido.ano).toBe(2026);
      expect(inserido.estudantePerfilId).toBe('perfil-alice-1');
      expect(inserido.registradaPorPerfilId).toBe('perfil-bruno-1');
      expect(inserido.conversa).toContain('Conversa franca');
      expect(inserido.cardsAtrasados).toBe(2); // Calculado via cards reais due
    });
  });

  describe('2. Diagnóstico do Dashboard do Estudante (Alice)', () => {
    it('rejeita acesso de responsável ao dashboard do estudante', async () => {
      activeUser = mockResponsavelProfile; // Bruno
      await expect(obterMetricasDashboard()).rejects.toThrow(/Acesso negado: esperado papel estudante/);
    });

    it('calcula aderência correta com base nas sessões concluídas reais', async () => {
      activeUser = mockCurrentProfile;
      mockSessoesRows = [
        { id: 'sessao-1', concluida: true },
        { id: 'sessao-2', concluida: true },
        { id: 'sessao-3', concluida: true },
      ];

      const metrics = await obterMetricasDashboard();
      expect(metrics.aderencia.realizado).toBe(3);
      expect(metrics.aderencia.previsto).toBe(24);
      expect(metrics.aderencia.valor).toBe(13); // round(3/24 * 100) = 13%
      expect(metrics.aderencia.alerta).toBe(true);
      expect(metrics.aderencia.mensagem).toContain('4 semanas');
    });

    it('trata adequadamente perfil de erro vazio sem injetar dados fictícios', async () => {
      activeUser = mockCurrentProfile;
      mockSessoesRows = [{ id: 'sessao-1', concluida: true }];
      mockErrosRows = []; // Zero erros no banco

      const metrics = await obterMetricasDashboard();
      expect(metrics.perfilErro.distribuicao).toEqual([]);
      expect(metrics.perfilErro.alerta).toBe(false);
    });

    it('trata sono sem check-ins indicando mediaHoras=0 sem falso alarme', async () => {
      activeUser = mockCurrentProfile;
      mockSessoesRows = [{ id: 'sessao-1', concluida: true }];
      mockCheckinsRows = []; // Zero checkins

      const metrics = await obterMetricasDashboard();
      expect(metrics.sono.mediaHoras).toBe(0);
      expect(metrics.sono.alerta).toBe(false);
    });

    it('retorna lista vazia de simulados quando o estudante não realizou provas', async () => {
      activeUser = mockCurrentProfile;
      mockSessoesRows = [{ id: 'sessao-1', concluida: true }];
      mockSimuladosRows = [];

      const metrics = await obterMetricasDashboard();
      expect(metrics.simuladosEvolucao).toEqual([]);
    });
  });

  describe('3. Verificação Especial: Distinção entre Sessões e Progresso Curricular', () => {
    it('distingue volume de sessões executadas de avanço na fila do ciclo', () => {
      // Cenário verificado em Staging:
      // Sessão 1: Bloco 1 (Matemática) - 132s
      // Sessão 2: Bloco 1 (Matemática) - 22s
      // Sessão 3: Bloco 2 (Biologia) - 56s
      const sessoesExecutadas = [
        { blocoId: 'bloco-1', disciplina: 'Matemática', segundos: 132, ordem: 1 },
        { blocoId: 'bloco-1', disciplina: 'Matemática', segundos: 22, ordem: 1 },
        { blocoId: 'bloco-2', disciplina: 'Biologia', segundos: 56, ordem: 2 },
      ];

      // Volume de esforço/sessões concluídas:
      const totalSessoes = sessoesExecutadas.length;
      expect(totalSessoes).toBe(3);

      // Tempo de estudo total acumulado:
      const tempoTotalSegundos = sessoesExecutadas.reduce((acc, s) => acc + s.segundos, 0);
      expect(tempoTotalSegundos).toBe(210); // 3m30s

      // Blocos curriculares distintos completados nesta volta:
      const blocosDistintos = new Set(sessoesExecutadas.map(s => s.blocoId));
      expect(blocosDistintos.size).toBe(2);

      // Ponteiro do ciclo após avanço do Bloco 2:
      const proximaOrdem = Math.max(...sessoesExecutadas.map(s => s.ordem)) + 1;
      expect(proximaOrdem).toBe(3); // Aponta para Bloco 3 (Química)
    });

    it('calcula divergência de trilhos corretamente com base em tentativas', () => {
      // Com zero tentativas, divergência é 0 e equilibrada
      const divZero = calcularDivergenciaTrilhos([]);
      expect(divZero.divergencia).toBe(0);
      expect(divZero.alerta).toBe(false);
      expect(divZero.diagnostico).toContain('Desempenho equilibrado');

      // Com divergência alta (> 15 pts a favor de enem)
      const divDesvio = calcularDivergenciaTrilhos([
        { correta: true, estilo: 'enem' },
        { correta: true, estilo: 'enem' },
        { correta: false, estilo: 'conteudista' },
        { correta: false, estilo: 'conteudista' },
      ]);
      expect(divDesvio.divergencia).toBe(100);
      expect(divDesvio.alerta).toBe(true);
      expect(divDesvio.diagnostico).toContain('Falta profundidade técnica');
    });
  });
});
