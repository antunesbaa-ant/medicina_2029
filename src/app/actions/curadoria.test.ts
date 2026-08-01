import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enfileirarGeracaoDeArtefatos, obterFilaCuradoria, curarItem } from './curadoria';
import { obterLacunasEstudo } from './lacunas';
import { obterCadernoErros, resolverErro } from './cadernoErros';
import { injetarTopicoNoCiclo } from './reestudo';
import { listarSimulados } from './simulados';

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

describe('Fase 3 & 4 - Server Actions Tests', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('obterFilaCuradoria', () => {
    it('deve retornar lista de itens pendentes', async () => {
      const list = await obterFilaCuradoria();
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe('curarItem', () => {
    it('deve retornar erro para item inexistente', async () => {
      const res = await curarItem('non-existent', 'aprovado');
      expect(res.sucesso).toBe(false);
    });
  });

  describe('obterLacunasEstudo', () => {
    it('deve retornar lista de lacunas', async () => {
      const lacunas = await obterLacunasEstudo();
      expect(Array.isArray(lacunas)).toBe(true);
      expect(lacunas.length).toBeGreaterThan(0);
    });
  });

  describe('Caderno de Erros', () => {
    it('deve obter erros do caderno', async () => {
      const erros = await obterCadernoErros();
      expect(Array.isArray(erros)).toBe(true);
    });

    it('deve marcar erro como resolvido', async () => {
      const res = await resolverErro('mock-erro-id');
      expect(res.sucesso).toBe(true);
    });
  });

  describe('Re-estudo', () => {
    it('deve retornar erro ao tentar injetar topico inexistente', async () => {
      const res = await injetarTopicoNoCiclo('non-existent');
      expect(res.sucesso).toBe(false);
    });
  });

  describe('Simulados', () => {
    it('deve listar simulados cadastrados', async () => {
      const simulados = await listarSimulados();
      expect(Array.isArray(simulados)).toBe(true);
    });
  });

});
