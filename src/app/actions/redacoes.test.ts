import { describe, it, expect, vi, beforeEach } from 'vitest';
import { obterGenerosUECE, obterRepertorios, obterRedacoes, registrarRedacao, registrarRepertorio } from './redacoes';

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
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (resolve: any) => resolve([])
  };
  return { db: queryBuilder };
});

describe('Fase 7 - Redações & Repertório Sociocultural', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deve obter generos cadastrados (mock)', async () => {
    const list = await obterGenerosUECE();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });

  it('deve obter repertorios (mock)', async () => {
    const list = await obterRepertorios();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });

  it('deve obter redacoes da estudante (mock)', async () => {
    const list = await obterRedacoes();
    expect(Array.isArray(list)).toBe(true);
  });

  it('deve registrar nova redacao', async () => {
    const res = await registrarRedacao({
      formato: 'enem',
      tema: 'Tema de Redação',
      texto: 'Texto de Redação completo',
      minutosGastos: 60
    });
    expect(res.sucesso).toBe(true);
  });

  it('deve registrar novo repertorio', async () => {
    const res = await registrarRepertorio({
      referencia: 'Referência',
      resumo2Linhas: 'Resumo curto',
      temasAplicaveis: ['Tecnologia'],
      categoria: 'Sociologia'
    });
    expect(res.sucesso).toBe(true);
  });

});
