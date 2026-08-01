import { describe, it, expect, vi, beforeEach } from 'vitest';
import { obterMetricasDashboard } from './dashboard';

// Mock DB
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
    then: (resolve: any) => resolve([])
  };
  return { db: queryBuilder };
});

describe('Fase 6 - Dashboard & Métricas Derivadas', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deve obter métricas e diagnósticos com sucesso (mock fallback)', async () => {
    const metrics = await obterMetricasDashboard();
    expect(metrics).toBeDefined();
    expect(metrics.aderencia).toBeDefined();
    expect(metrics.divergencia).toBeDefined();
    expect(metrics.perfilErro).toBeDefined();
    expect(metrics.divergencia.alerta).toBe(true); // Mock trigger
  });

});
