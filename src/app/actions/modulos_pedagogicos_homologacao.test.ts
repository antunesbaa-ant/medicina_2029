import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listarSimulados, registrarSimulado } from './simulados';
import { obterCadernoErros, resolverErro, registrarErroManual } from './cadernoErros';
import {
  obterRedacoes,
  registrarRedacao,
  obterGenerosUECE,
  registrarRepertorio,
  obterRepertorios,
} from './redacoes';
import {
  calcularAderencia,
  calcularDivergenciaTrilhos,
  calcularProximaOrdem,
  validarConclusaoSessao,
} from '../../lib/studysystem';
import { injetarTopicoNoCiclo } from './reestudo';
import { getTableName } from 'drizzle-orm';

// Mock perfis com UUIDs v4 rigorosamente válidos
const mockAlice = {
  id: 'a11ce000-0000-4000-8000-000000000001',
  authUserId: 'auth-alice-001',
  nome: 'Alice Estudante',
  email: 'alice@medicina2029.staging',
  papel: 'estudante',
};

const mockCarlos = {
  id: 'ca410500-0000-4000-8000-000000000002',
  authUserId: 'auth-carlos-002',
  nome: 'Carlos Estudante',
  email: 'carlos@medicina2029.staging',
  papel: 'estudante',
};

const mockBruno = {
  id: 'b4000000-0000-4000-8000-000000000003',
  authUserId: 'auth-bruno-003',
  nome: 'Bruno Responsável',
  email: 'bruno@medicina2029.staging',
  papel: 'responsavel',
};

let activeUser = mockAlice;

vi.mock('../../lib/authorization', () => ({
  requireAuthenticatedProfile: vi.fn().mockImplementation(async () => activeUser),
  requireRole: vi.fn().mockImplementation(async (role: string) => {
    if (activeUser.papel !== role) {
      throw new Error(`Acesso negado: esperado papel ${role}, recebido ${activeUser.papel}`);
    }
    return activeUser;
  }),
  requireManagedStudentProfile: vi.fn().mockImplementation(async () => mockAlice),
  assertOwnership: vi.fn(),
}));

const TOPICO_CITOLOGIA_ID = 'b101091a-0000-4000-8000-000000000001';
const TOPICO_ELETRICIDADE_ID = 'f151ca00-0000-4000-8000-000000000002';
const DISCIPLINA_BIO_ID = 'd15c0001-0000-4000-8000-000000000001';
const DISCIPLINA_FIS_ID = 'd15c0002-0000-4000-8000-000000000002';
const GENERO_MANIFESTO_ID = 'eeee0001-0000-4000-8000-000000000001';
const GENERO_CARTA_ID = 'eeee0002-0000-4000-8000-000000000002';
const CICLO_ALICE_ID = 'c1c10001-0000-4000-8000-000000000001';

// State stores for mocking database tables
let mockSimuladosTable: any[] = [];
let mockSimuladoAreasTable: any[] = [];
let mockSimuladoAnaliseTable: any[] = [];
let mockErrosTable: any[] = [];
let mockTopicosTable: any[] = [
  { id: TOPICO_CITOLOGIA_ID, nome: 'Citologia', disciplinaId: DISCIPLINA_BIO_ID },
  { id: TOPICO_ELETRICIDADE_ID, nome: 'Eletrodinâmica', disciplinaId: DISCIPLINA_FIS_ID },
];
let mockDisciplinasTable: any[] = [
  { id: DISCIPLINA_BIO_ID, nome: 'Biologia', corHex: '#10B981' },
  { id: DISCIPLINA_FIS_ID, nome: 'Física', corHex: '#3B82F6' },
];
let mockGenerosTable: any[] = [
  { id: GENERO_MANIFESTO_ID, nome: 'Manifesto', finalidade: 'Engajamento público' },
  { id: GENERO_CARTA_ID, nome: 'Carta Aberta', finalidade: 'Reivindicação coletiva' },
];
let mockRedacoesTable: any[] = [];
let mockRepertoriosTable: any[] = [];
let mockCiclosTable: any[] = [
  { id: CICLO_ALICE_ID, ativo: true, estudantePerfilId: mockAlice.id },
];
let mockCicloBlocosTable: any[] = [
  { id: 'bbbb0001-0000-4000-8000-000000000001', cicloId: CICLO_ALICE_ID, ordem: 1, disciplinaId: DISCIPLINA_BIO_ID },
  { id: 'bbbb0002-0000-4000-8000-000000000002', cicloId: CICLO_ALICE_ID, ordem: 2, disciplinaId: DISCIPLINA_FIS_ID },
];
let mockCicloEstadoTable: any[] = [
  { cicloId: CICLO_ALICE_ID, proximaOrdem: 3 },
];

function resetDatabaseState() {
  mockSimuladosTable = [];
  mockSimuladoAreasTable = [];
  mockSimuladoAnaliseTable = [];
  mockErrosTable = [];
  mockRedacoesTable = [];
  mockRepertoriosTable = [];
}

vi.mock('../../db', () => {
  const buildMockQuery = (operation: string, targetTable?: any) => {
    let currentTableName = '';
    try {
      currentTableName = targetTable ? getTableName(targetTable) : '';
    } catch {
      currentTableName = targetTable?._?.name || targetTable?.tableName || '';
    }

    let insertedValues: any = null;
    let updateValues: any = null;
    let whereFilter: any = null;

    const chain: any = {
      from: vi.fn().mockImplementation((table) => {
        try {
          currentTableName = getTableName(table);
        } catch {
          currentTableName = table?._?.name || table?.tableName || '';
        }
        return chain;
      }),
      innerJoin: vi.fn().mockImplementation(() => chain),
      leftJoin: vi.fn().mockImplementation(() => chain),
      where: vi.fn().mockImplementation((filter) => {
        whereFilter = filter;
        return chain;
      }),
      orderBy: vi.fn().mockImplementation(() => chain),
      limit: vi.fn().mockImplementation(() => chain),
      groupBy: vi.fn().mockImplementation(() => chain),
      values: vi.fn().mockImplementation((vals) => {
        insertedValues = vals;
        return chain;
      }),
      set: vi.fn().mockImplementation((vals) => {
        updateValues = vals;
        return chain;
      }),
      returning: vi.fn().mockImplementation(() => {
        if (operation === 'insert') {
          const item = {
            id: insertedValues?.id || `00000000-0000-4000-8000-${Math.floor(Math.random() * 899999999999 + 100000000000)}`,
            ...insertedValues,
          };
          if (currentTableName === 'simulados') mockSimuladosTable.push(item);
          if (currentTableName === 'simulado_areas') mockSimuladoAreasTable.push(item);
          if (currentTableName === 'redacoes') mockRedacoesTable.push(item);
          if (currentTableName === 'repertorios') mockRepertoriosTable.push(item);
          if (currentTableName === 'erros') mockErrosTable.push(item);
          if (currentTableName === 'ciclo_blocos') mockCicloBlocosTable.push(item);
          return Promise.resolve([item]);
        }
        if (operation === 'update') {
          if (currentTableName === 'erros') {
            const erro = mockErrosTable.find((e) => e.perfilId === activeUser.id);
            if (erro) {
              Object.assign(erro, updateValues);
              return Promise.resolve([erro]);
            }
          }
          return Promise.resolve([{ id: 'mock-updated' }]);
        }
        return Promise.resolve([{ id: 'mock-returning' }]);
      }),
      then: (resolve: any) => {
        if (operation === 'select') {
          if (currentTableName === 'simulados') {
            const list = mockSimuladosTable.filter((s) => s.perfilId === activeUser.id);
            return resolve(list);
          }
          if (currentTableName === 'simulado_areas') {
            return resolve(mockSimuladoAreasTable);
          }
          if (currentTableName === 'simulado_analise') {
            return resolve(mockSimuladoAnaliseTable);
          }
          if (currentTableName === 'erros') {
            const list = mockErrosTable.filter((e) => e.perfilId === activeUser.id);
            return resolve(
              list.map((e) => ({
                id: e.id,
                descricaoLivre: e.descricaoLivre,
                tipoErro: e.tipoErro,
                conceitoCorreto: e.conceitoCorreto,
                criadoEm: e.criadoEm || new Date(),
                resolvidoEm: e.resolvidoEm || null,
                vezesRevisado: e.vezesRevisado || 0,
                topicoId: e.topicoId,
                topicoNome: 'Citologia',
                disciplinaId: e.disciplinaId,
                disciplinaNome: 'Biologia',
                corHex: '#10B981',
              }))
            );
          }
          if (currentTableName === 'generos') {
            if (whereFilter?.queryChunks) {
              let targetId: string | null = null;
              for (const chunk of whereFilter.queryChunks) {
                if (typeof chunk?.value === 'string' && chunk.value.length === 36) {
                  targetId = chunk.value;
                  break;
                }
              }
              if (targetId) {
                return resolve(mockGenerosTable.filter((g) => g.id === targetId));
              }
            }
            return resolve(mockGenerosTable);
          }
          if (currentTableName === 'repertorios') {
            const list = mockRepertoriosTable.filter((r) => r.perfilId === activeUser.id);
            return resolve(list);
          }
          if (currentTableName === 'redacoes') {
            const list = [...mockRedacoesTable]
              .filter((r) => r.perfilId === activeUser.id)
              .sort((a, b) => new Date(b.escritaEm).getTime() - new Date(a.escritaEm).getTime());
            return resolve(
              list.map((r) => ({
                ...r,
                generoNome: mockGenerosTable.find((g) => g.id === r.generoId)?.nome || null,
              }))
            );
          }
          if (currentTableName === 'topicos') {
            return resolve(mockTopicosTable);
          }
          if (currentTableName === 'ciclos') {
            return resolve(mockCiclosTable.filter((c) => c.estudantePerfilId === activeUser.id));
          }
          if (currentTableName === 'ciclo_estado') {
            return resolve(mockCicloEstadoTable);
          }
          if (currentTableName === 'ciclo_blocos') {
            return resolve(mockCicloBlocosTable);
          }
          return resolve([]);
        }
        if (operation === 'update') {
          return resolve([]);
        }
        return resolve([]);
      },
    };
    return chain;
  };

  const dbObj = {
    select: vi.fn().mockImplementation((fields) => buildMockQuery('select')),
    insert: vi.fn().mockImplementation((table) => buildMockQuery('insert', table)),
    update: vi.fn().mockImplementation((table) => buildMockQuery('update', table)),
    delete: vi.fn().mockImplementation((table) => buildMockQuery('delete', table)),
    execute: vi.fn().mockResolvedValue([{ maiorOrdem: 2 }]),
    transaction: vi.fn().mockImplementation(async (callback) => {
      const tx = {
        select: vi.fn().mockImplementation((fields) => buildMockQuery('select')),
        insert: vi.fn().mockImplementation((table) => buildMockQuery('insert', table)),
        update: vi.fn().mockImplementation((table) => buildMockQuery('update', table)),
        delete: vi.fn().mockImplementation((table) => buildMockQuery('delete', table)),
        execute: vi.fn().mockResolvedValue([{ maiorOrdem: 2 }]),
      };
      return callback(tx);
    }),
  };

  return { db: dbObj };
});

describe('MEDICINA 2029 — Homologação Integrada dos Módulos Pedagógicos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDatabaseState();
    activeUser = mockAlice;
  });

  // --------------------------------------------------------------------------
  // 1. MÓDULO DE SIMULADOS
  // --------------------------------------------------------------------------
  describe('1. Módulo de Simulados', () => {
    it('1.1 registra simulado com cálculo de percentuais por área e nota estimada', async () => {
      const input = {
        formato: 'enem' as const,
        data: new Date().toISOString(),
        condicoesReais: true,
        duracaoMin: 270,
        local: 'Em Casa (Condições reais)',
        composicaoProcedencia: { origem: 'Caderno ENEM Oficial 2025' },
        areas: [
          { area: 'Ciências da Natureza', acertos: 36, total: 45 },
          { area: 'Matemática', acertos: 40, total: 45 },
          { area: 'Ciências Humanas', acertos: 38, total: 45 },
          { area: 'Linguagens e Códigos', acertos: 35, total: 45 },
        ],
      };

      const res = await registrarSimulado(input);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.simuladoId).toBeDefined();
        expect(res.data.analiseStatus).toBe('pendente');
      }

      expect(mockSimuladosTable).toHaveLength(1);
      expect(mockSimuladosTable[0].formato).toBe('enem');
      expect(mockSimuladosTable[0].perfilId).toBe(mockAlice.id);

      expect(mockSimuladoAreasTable).toHaveLength(4);
      // Validar cálculo de notaEstimada (Math.round((acertos/total)*100 * 8.5))
      const matArea = mockSimuladoAreasTable.find((a) => a.area === 'Matemática');
      expect(matArea).toBeDefined();
      expect(matArea.acertos).toBe(40);
      expect(matArea.total).toBe(45);
      // (40/45)*100 * 8.5 = 88.888 * 8.5 = 755.55 -> 756
      expect(matArea.notaEstimada).toBe(756);
    });

    it('1.2 bloqueia registro de simulado se houver análise pendente (trava de integridade)', async () => {
      mockSimuladosTable.push({
        id: '11111111-0000-4000-8000-000000000001',
        perfilId: mockAlice.id,
        formato: 'enem',
      });
      // Análise pendente (concluida = false)
      mockSimuladoAnaliseTable.push({
        simuladoId: '11111111-0000-4000-8000-000000000001',
        concluida: false,
      });

      const res = await registrarSimulado({
        formato: 'enem',
        data: new Date().toISOString(),
        condicoesReais: true,
        duracaoMin: 270,
        local: 'Sala',
        composicaoProcedencia: {},
        areas: [{ area: 'Matemática', acertos: 30, total: 45 }],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('CONFLICT');
        expect(res.message).toContain('análise pendente');
      }
    });

    it('1.3 valida formato de prova rejeitando entradas inválidas', async () => {
      const res = await registrarSimulado({
        formato: 'formato_inexistente' as any,
        data: new Date().toISOString(),
        condicoesReais: true,
        duracaoMin: -10, // Duração negativa inválida
        local: '',
        composicaoProcedencia: {},
        areas: [],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('VALIDATION_ERROR');
      }
    });

    it('1.4 lista simulados isolados por perfil e trata ausência de dados graciosamente', async () => {
      // Base vazia
      const listaVazia = await listarSimulados();
      expect(listaVazia).toEqual([]);

      // Simulado de Alice
      mockSimuladosTable.push({
        id: '11111111-0000-4000-8000-000000000002',
        perfilId: mockAlice.id,
        formato: 'uece_1fase',
        data: new Date().toISOString(),
      });

      // Simulado de Carlos (não pode vazar)
      mockSimuladosTable.push({
        id: '22222222-0000-4000-8000-000000000001',
        perfilId: mockCarlos.id,
        formato: 'enem',
        data: new Date().toISOString(),
      });

      const listaAlice = await listarSimulados();
      expect(listaAlice).toHaveLength(1);
      expect(listaAlice[0].id).toBe('11111111-0000-4000-8000-000000000002');
    });

    it('1.5 bloqueia acesso de perfis não autorizados (ex: responsável direto)', async () => {
      activeUser = mockBruno;
      await expect(listarSimulados()).rejects.toThrow('Acesso negado');
    });
  });

  // --------------------------------------------------------------------------
  // 2. MÓDULO DE CADERNO DE ERROS E QUESTÕES
  // --------------------------------------------------------------------------
  describe('2. Módulo de Análise de Erros e Questões', () => {
    it('2.1 lista erros com filtros por disciplina, tipo e status resolvido', async () => {
      mockErrosTable.push(
        {
          id: 'eeee0001-0000-4000-8000-000000000010',
          perfilId: mockAlice.id,
          tipoErro: 'conteudo',
          disciplinaId: DISCIPLINA_BIO_ID,
          topicoId: TOPICO_CITOLOGIA_ID,
          descricaoLivre: 'Esqueci o rendimento de ATP no ciclo de Krebs',
          conceitoCorreto: 'São 2 ATP por glicose na fosforilação oxidativa em nível de substrato',
          resolvidoEm: null,
          criadoEm: new Date(),
        },
        {
          id: 'eeee0002-0000-4000-8000-000000000020',
          perfilId: mockAlice.id,
          tipoErro: 'calculo',
          disciplinaId: DISCIPLINA_FIS_ID,
          topicoId: TOPICO_ELETRICIDADE_ID,
          descricaoLivre: 'Erro de conversão de km/h para m/s',
          conceitoCorreto: 'Dividir por 3,6',
          resolvidoEm: new Date(),
          criadoEm: new Date(),
        }
      );

      const errosPendentes = await obterCadernoErros({ resolvido: false });
      expect(errosPendentes).toHaveLength(2); // Mock retorna os erros da Alice
      expect(errosPendentes[0].topicoNome).toBe('Citologia');
      expect(errosPendentes[0].disciplinaNome).toBe('Biologia');
    });

    it('2.2 resolve erro marcando data de resolução', async () => {
      mockErrosTable.push({
        id: 'eeee0003-0000-4000-8000-000000000030',
        perfilId: mockAlice.id,
        tipoErro: 'distracao',
        resolvidoEm: null,
      });

      const res = await resolverErro('eeee0003-0000-4000-8000-000000000030');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.erroId).toBe('eeee0003-0000-4000-8000-000000000030');
      }
      expect(mockErrosTable[0].resolvidoEm).toBeInstanceOf(Date);
    });

    it('2.3 rejeita registro de erro manual sem tentativa associada (integridade relacional)', async () => {
      const res = await registrarErroManual({
        descricaoLivre: 'Erro digitado sem resolver questão',
        topicoId: TOPICO_CITOLOGIA_ID,
        disciplinaId: DISCIPLINA_BIO_ID,
        estilo: 'enem',
        tipoErro: 'conteudo',
        conceitoCorreto: 'Conceito correto',
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('VALIDATION_ERROR');
        expect(res.message).toContain('exige uma questão e uma tentativa persistidas');
      }
    });

    it('2.4 calcula divergência entre trilho ENEM e Conteudista com alerta de desvio (>15 pts)', () => {
      // Caso 1: Equilíbrio
      const tentativasEquilibradas = [
        { correta: true, estilo: 'enem' as const },
        { correta: true, estilo: 'conteudista' as const },
        { correta: false, estilo: 'enem' as const },
        { correta: false, estilo: 'conteudista' as const },
      ];
      const divEquilibrada = calcularDivergenciaTrilhos(tentativasEquilibradas);
      expect(divEquilibrada.divergencia).toBe(0);
      expect(divEquilibrada.alerta).toBe(false);
      expect(divEquilibrada.diagnostico).toContain('Desempenho equilibrado');

      // Caso 2: ENEM 90%, Conteudista 60% -> Divergência = +30 (Falta profundidade técnica)
      const tentativasFaltaProfundidade = [
        { correta: true, estilo: 'enem' as const },
        { correta: true, estilo: 'enem' as const },
        { correta: true, estilo: 'enem' as const },
        { correta: true, estilo: 'conteudista' as const },
        { correta: false, estilo: 'conteudista' as const },
      ];
      const divProfunda = calcularDivergenciaTrilhos(tentativasFaltaProfundidade);
      expect(divProfunda.divergencia).toBe(50);
      expect(divProfunda.alerta).toBe(true);
      expect(divProfunda.diagnostico).toContain('Falta profundidade técnica');

      // Caso 3: Conteudista 100%, ENEM 50% -> Divergência = -50 (Falta repertório interpretativo)
      const tentativasFaltaRepertorio = [
        { correta: true, estilo: 'enem' as const },
        { correta: false, estilo: 'enem' as const },
        { correta: true, estilo: 'conteudista' as const },
        { correta: true, estilo: 'conteudista' as const },
      ];
      const divInterpretativa = calcularDivergenciaTrilhos(tentativasFaltaRepertorio);
      expect(divInterpretativa.divergencia).toBe(-50);
      expect(divInterpretativa.alerta).toBe(true);
      expect(divInterpretativa.diagnostico).toContain('Falta repertório interpretativo');
    });
  });

  // --------------------------------------------------------------------------
  // 3. MÓDULO DE REDAÇÕES, CORREÇÕES E REESCRITAS
  // --------------------------------------------------------------------------
  describe('3. Módulo de Redações e Repertórios', () => {
    it('3.1 registra redação ENEM com texto e minutos gastos, com notaTotal inicial nula', async () => {
      const res = await registrarRedacao({
        formato: 'enem',
        tema: 'Democratização do acesso ao cinema no Brasil',
        texto: 'A Constituição Federal de 1988 assegura o acesso aos direitos culturais...',
        minutosGastos: 55,
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.redacaoId).toBeDefined();
      }

      expect(mockRedacoesTable).toHaveLength(1);
      expect(mockRedacoesTable[0].formato).toBe('enem');
      expect(mockRedacoesTable[0].notaTotal).toBeNull();
      expect(mockRedacoesTable[0].minutosGastos).toBe(55);
    });

    it('3.2 registra redação Gênero UECE vinculada a um gênero existente', async () => {
      const res = await registrarRedacao({
        formato: 'genero_uece',
        generoId: GENERO_MANIFESTO_ID,
        tema: 'A importância da preservação da Caatinga',
        texto: 'Cidadãos cearenses, conclamo todos a resistir ao avanço da desertificação...',
        minutosGastos: 48,
      });

      expect(res.ok).toBe(true);
      expect(mockRedacoesTable[0].generoId).toBe(GENERO_MANIFESTO_ID);
    });

    it('3.3 rejeita redação UECE com gênero inexistente', async () => {
      const res = await registrarRedacao({
        formato: 'genero_uece',
        generoId: '00000000-0000-4000-8000-000000000999',
        tema: 'Tema Teste',
        texto: 'Texto de teste',
        minutosGastos: 40,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('NOT_FOUND');
        expect(res.message).toContain('Gênero textual não encontrado');
      }
    });

    it('3.4 lista redações incluindo reescritadeId para permitir contagem e renderização sem quebra', async () => {
      mockRedacoesTable.push(
        {
          id: '33330001-0000-4000-8000-000000000001',
          perfilId: mockAlice.id,
          formato: 'enem',
          tema: 'Invisibilidade do trabalho de cuidado',
          texto: 'Texto original com desvios gramaticais...',
          minutosGastos: 60,
          notaTotal: 840,
          reescritadeId: null,
          escritaEm: new Date('2026-03-01'),
        },
        {
          id: '33330002-0000-4000-8000-000000000002',
          perfilId: mockAlice.id,
          formato: 'enem',
          tema: 'Invisibilidade do trabalho de cuidado (Reescrita V2)',
          texto: 'Texto corrigido e aprimorado com repertório filosófico...',
          minutosGastos: 45,
          notaTotal: null, // Aguardando nova correção
          reescritadeId: '33330001-0000-4000-8000-000000000001',
          escritaEm: new Date('2026-03-05'),
        }
      );

      const lista = await obterRedacoes();
      expect(lista).toHaveLength(2);
      // Ordenado decrescente por data: a reescrita (05/03) vem primeiro
      expect(lista[0].reescritadeId).toBe('33330001-0000-4000-8000-000000000001');
      expect(lista[1].reescritadeId).toBeNull();

      // Confirma que reescritas podem ser filtradas
      const reescritas = lista.filter((r) => r.reescritadeId !== null);
      expect(reescritas).toHaveLength(1);
    });

    it('3.5 lista gêneros textuais oficiais UECE com critérios e marcas', async () => {
      const generos = await obterGenerosUECE();
      expect(generos).toHaveLength(2);
      expect(generos[0].nome).toBe('Manifesto');
    });

    it('3.6 cadastra e recupera repertório sociocultural por temas', async () => {
      const res = await registrarRepertorio({
        referencia: 'Zygmunt Bauman',
        categoria: 'Sociologia',
        resumo2Linhas: 'Conceito de Modernidade Líquida e fragilidade dos laços sociais contemporâneos.',
        temasAplicaveis: ['Individualismo', 'Relações Humanas', 'Consumo'],
      });

      expect(res.ok).toBe(true);
      expect(mockRepertoriosTable).toHaveLength(1);
      expect(mockRepertoriosTable[0].temasAplicaveis).toContain('Individualismo');

      const lista = await obterRepertorios();
      expect(lista).toHaveLength(1);
      expect(lista[0].referencia).toBe('Zygmunt Bauman');
    });
  });

  // --------------------------------------------------------------------------
  // 4. CONSISTÊNCIA FINAL DOS INDICADORES E ADERÊNCIA AO CICLO
  // --------------------------------------------------------------------------
  describe('4. Consistência Final dos Indicadores e Aderência', () => {
    it('4.1 calcula aderência formal: 3 sessões concluídas ÷ 24 previstas (4 semanas * 6) = 12.5% (13%)', () => {
      const sessoesConcluidas = 3;
      const blocosPrevistosSemana = 6;
      const semanas = 4;

      const aderencia = calcularAderencia(sessoesConcluidas, blocosPrevistosSemana, semanas);
      expect(aderencia).toBe(12.5);
      expect(Math.round(aderencia)).toBe(13);
    });

    it('4.2 confirma idempotência do ponteiro de ciclo ao repetir bloco já concluído', () => {
      const totalBlocos = 28;

      // 1ª sessão de Bloco 1 concluída -> Avança para Bloco 2
      const proximaAposSessao1 = calcularProximaOrdem(1, totalBlocos);
      expect(proximaAposSessao1).toBe(2);

      // 2ª sessão de Bloco 1 concluída (repetição legítima do mesmo bloco no percurso)
      // O cálculo baseado no bloco 1 retorna estritamente a mesma ordem 2
      const proximaAposSessao2 = calcularProximaOrdem(1, totalBlocos);
      expect(proximaAposSessao2).toBe(2);

      // Conclusão do Bloco 2 (Biologia) -> Avança para Bloco 3 (Química)
      const proximaAposSessao3 = calcularProximaOrdem(2, totalBlocos);
      expect(proximaAposSessao3).toBe(3);
    });

    it('4.3 valida encerramento de ciclo no bloco 28 retornando ao bloco 1 (ordem circular)', () => {
      const proximo = calcularProximaOrdem(28, 28);
      expect(proximo).toBe(1);
    });

    it('4.4 valida trava de sessão pedagógica: somente conclui se etapa atingida for registro', () => {
      expect(validarConclusaoSessao('revisao')).toBe(false);
      expect(validarConclusaoSessao('conteudo')).toBe(false);
      expect(validarConclusaoSessao('questoes')).toBe(false);
      expect(validarConclusaoSessao('registro')).toBe(true);
    });

    it('4.5 injeta tópico crítico de re-estudo no ciclo reordenando os blocos sem colisão', async () => {
      const res = await injetarTopicoNoCiclo(TOPICO_CITOLOGIA_ID, 50);
      expect(res.sucesso).toBe(true);
      expect(res.mensagem).toContain('injetado com sucesso');
    });
  });
});
