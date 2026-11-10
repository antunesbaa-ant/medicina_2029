import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  obterCicloAtivo,
  obterProgressoSemanalCiclo,
  obterTopicosPorDisciplina,
} from './ciclo';
import { applyRlsContext } from '../../db/rls-context';
import { PublicOperationError } from '../../lib/operation-result';

const {
  ALICE_PERFIL_ID,
  ALICE_CICLO_ID,
  DISCIPLINA_ID,
  dbMockState,
} = vi.hoisted(() => ({
  ALICE_PERFIL_ID: '10000000-0000-4000-8000-000000000001',
  ALICE_CICLO_ID: '40000000-0000-4000-8000-000000000001',
  DISCIPLINA_ID: '30000000-0000-4000-8000-000000000001',
  dbMockState: {
    txSelectOutputs: [] as unknown[][],
    txSelectCount: 0,
    txCreated: false,
  },
}));

// Mocks de autorização
vi.mock('../../lib/authorization', () => ({
  requireStudentScope: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001',
    authUserId: 'a0000000-0000-4000-8000-000000000001',
    nome: 'Alice Silva',
    email: 'alice@medicina2029.staging',
    papel: 'estudante',
  }),
  requireAuthenticatedProfile: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001',
    authUserId: 'a0000000-0000-4000-8000-000000000001',
    nome: 'Alice Silva',
    email: 'alice@medicina2029.staging',
    papel: 'estudante',
  }),
  requireRole: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001',
    papel: 'estudante',
  }),
  requireManagedStudentProfile: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001',
    papel: 'estudante',
  }),
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
  then: (resolve: (val: unknown) => unknown) => Promise<unknown>;
}

function createMockTx() {
  const queryBuilder = {} as MockQueryBuilder;
  queryBuilder.from = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.where = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.limit = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.innerJoin = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.orderBy = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.then = (resolve) => {
    const res = dbMockState.txSelectOutputs[dbMockState.txSelectCount] ?? [];
    dbMockState.txSelectCount++;
    return Promise.resolve(res).then(resolve);
  };

  return {
    select: vi.fn().mockReturnValue(queryBuilder),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([]),
  };
}

let mockTxInstance = createMockTx();

vi.mock('../../db', () => ({
  db: {
    // Se chamar db.select diretamente fora da transação, deve lançar erro no teste
    select: vi.fn(() => {
      throw new Error('VIOLAÇÃO DE RLS: db.select chamado fora de transação com applyRlsContext!');
    }),
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      dbMockState.txCreated = true;
      return await cb(mockTxInstance);
    }),
  },
}));

describe('H2.04-T4-R — Auditoria e Correção RLS em Server Actions do Ciclo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMockState.txSelectOutputs = [];
    dbMockState.txSelectCount = 0;
    dbMockState.txCreated = false;
    mockTxInstance = createMockTx();
  });

  describe('obterCicloAtivo()', () => {
    it('executa compulsoriamente dentro de transação aplicando applyRlsContext com o perfil do estudante', async () => {
      const mockCiclo = {
        id: ALICE_CICLO_ID,
        nome: 'Ciclo Alice 2029',
        anoLetivo: 2027,
        ativo: true,
        estudantePerfilId: ALICE_PERFIL_ID,
        blocosPrevistosSemana: 28,
      };

      const mockBlocos = Array.from({ length: 28 }, (_, i) => ({
        id: `41000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        cicloId: ALICE_CICLO_ID,
        ordem: i + 1,
        disciplinaId: DISCIPLINA_ID,
        tipo: 'conteudo',
        estiloAlvo: 'enem',
        duracaoMin: 50,
        disciplina: { id: DISCIPLINA_ID, nome: 'Matemática' },
      }));

      const mockEstado = {
        cicloId: ALICE_CICLO_ID,
        proximaOrdem: 1,
      };

      dbMockState.txSelectOutputs = [
        [mockCiclo], // 1. tx.select().from(ciclos)
        mockBlocos,  // 2. tx.select().from(cicloBlocos).innerJoin(disciplinas)
        [mockEstado], // 3. tx.select().from(cicloEstado)
      ];

      const resultado = await obterCicloAtivo();

      // 1. Deve ter aberto transação
      expect(dbMockState.txCreated).toBe(true);

      // 2. Deve ter invocado applyRlsContext com o id e papel da Alice
      expect(applyRlsContext).toHaveBeenCalledTimes(1);
      expect(applyRlsContext).toHaveBeenCalledWith(
        mockTxInstance,
        ALICE_PERFIL_ID,
        'estudante'
      );

      // 3. Resultado deve conter o ciclo e os 28 blocos intactos
      expect(resultado).not.toBeNull();
      expect(resultado?.ciclo.id).toBe(ALICE_CICLO_ID);
      expect(resultado?.blocos).toHaveLength(28);
      expect(resultado?.proximaOrdem).toBe(1);
      expect(dbMockState.txSelectCount).toBe(3);
    });

    it('retorna null se não houver ciclo ativo sob o contexto RLS do estudante', async () => {
      dbMockState.txSelectOutputs = [
        [], // Sem ciclo ativo para este estudante
      ];

      const resultado = await obterCicloAtivo();

      expect(dbMockState.txCreated).toBe(true);
      expect(applyRlsContext).toHaveBeenCalledWith(mockTxInstance, ALICE_PERFIL_ID, 'estudante');
      expect(resultado).toBeNull();
      // Não deve prosseguir para buscar blocos se ciclo ativo for nulo
      expect(dbMockState.txSelectCount).toBe(1);
    });

    it('rejeita a operação fail-closed se applyRlsContext falhar', async () => {
      vi.mocked(applyRlsContext).mockRejectedValueOnce(
        new Error('medicina.set_context failed')
      );

      await expect(obterCicloAtivo()).rejects.toThrow(PublicOperationError);
      expect(dbMockState.txCreated).toBe(true);
    });
  });

  describe('obterProgressoSemanalCiclo()', () => {
    it('executa dentro de transação com applyRlsContext e filtra por perfilId da estudante', async () => {
      const mockSessoesRecentes = [{ id: 'sessao-1' }, { id: 'sessao-2' }, { id: 'sessao-3' }];
      const mockSessaoAberta = [{ id: 'sessao-aberta-1' }];

      dbMockState.txSelectOutputs = [
        mockSessoesRecentes,
        mockSessaoAberta,
      ];

      const progresso = await obterProgressoSemanalCiclo();

      expect(dbMockState.txCreated).toBe(true);
      expect(applyRlsContext).toHaveBeenCalledWith(mockTxInstance, ALICE_PERFIL_ID, 'estudante');
      expect(progresso.concluidosSemana).toBe(3);
      expect(progresso.sessaoAbertaId).toBe('sessao-aberta-1');
    });
  });

  describe('obterTopicosPorDisciplina()', () => {
    it('executa dentro de transação com applyRlsContext e valida UUID', async () => {
      const mockTopicos = [
        { id: 'topico-1', disciplinaId: DISCIPLINA_ID, ordem: 1, nome: 'Funções' },
        { id: 'topico-2', disciplinaId: DISCIPLINA_ID, ordem: 2, nome: 'Geometria' },
      ];

      dbMockState.txSelectOutputs = [mockTopicos];

      const topicos = await obterTopicosPorDisciplina(DISCIPLINA_ID);

      expect(dbMockState.txCreated).toBe(true);
      expect(applyRlsContext).toHaveBeenCalledWith(mockTxInstance, ALICE_PERFIL_ID, 'estudante');
      expect(topicos).toEqual(mockTopicos);
    });

    it('rejeita ID de disciplina inválido sem acessar transação', async () => {
      await expect(obterTopicosPorDisciplina('id-invalido-nao-uuid')).rejects.toThrow();
      expect(dbMockState.txCreated).toBe(false);
    });
  });
});
