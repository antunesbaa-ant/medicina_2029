import { describe, it, expect, vi, beforeEach } from 'vitest';
import { obterMetricasDashboard, obterMetricasDashboardVazias } from './dashboard';

vi.mock('../../lib/authorization', () => ({
  AuthorizationError: class AuthorizationError extends Error {},
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
  assertOwnership: vi.fn(),
}));

// Mock DB retornando vazio para estudante novo
vi.mock('../../db', () => {
  const queryBuilder: any = {
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'mock-id' }]),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue([]),
    transaction: vi.fn().mockImplementation(async (callback: any) => callback(queryBuilder)),
    then: (resolve: any) => resolve([]),
  };
  return { db: queryBuilder };
});

describe('Fase 6 — Estabilização do Dashboard e Eliminação de Mocks Fictícios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. deve retornar métricas reais zeradas para novo estudante sem inventar dados', async () => {
    const metrics = await obterMetricasDashboard();
    expect(metrics).toBeDefined();

    // Aderência real: 0% e mensagem encorajadora de início de ciclo
    expect(metrics.aderencia.valor).toBe(0);
    expect(metrics.aderencia.realizado).toBe(0);
    expect(metrics.aderencia.previsto).toBe(24);
    expect(metrics.aderencia.mensagem).toContain('Nenhuma sessão concluída nas últimas 4 semanas');

    // Divergência de trilhos: neutra sem inventar estilo
    expect(metrics.divergencia.valor).toBe(0);
    expect(metrics.divergencia.alerta).toBe(false);
    expect(metrics.divergencia.diagnostico).toContain('Desempenho equilibrado');

    // Redações e simulados: coleções limpas e fidedignas
    expect(metrics.redacoes.escritas).toBe(0);
    expect(metrics.redacoes.reescritas).toBe(0);
    expect(metrics.simuladosEvolucao).toEqual([]);
    expect(metrics.perfilErro.distribuicao).toEqual([]);
  });

  it('2. deve prover função utilitária de métricas vazias estritamente limpas', async () => {
    const empty = await obterMetricasDashboardVazias('Mensagem de teste');
    expect(empty.aderencia.valor).toBe(0);
    expect(empty.aderencia.realizado).toBe(0);
    expect(empty.aderencia.mensagem).toBe('Mensagem de teste');
    expect(empty.simuladosEvolucao).toHaveLength(0);
    expect(empty.redacoes.escritas).toBe(0);
  });
});
