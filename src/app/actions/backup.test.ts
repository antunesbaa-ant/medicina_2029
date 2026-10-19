import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportarDadosCompletos, restaurarDadosCompletos } from './backup';

vi.mock('../../lib/authorization', () => ({
  requireAuthenticatedProfile: vi.fn().mockResolvedValue({
    id: 'responsavel-1',
    authUserId: 'auth-responsavel-1',
    nome: 'Responsável Teste',
    email: null,
    papel: 'responsavel',
  }),
  requireRole: vi.fn().mockResolvedValue({
    id: 'responsavel-1',
    authUserId: 'auth-responsavel-1',
    nome: 'Responsável Teste',
    email: null,
    papel: 'responsavel',
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
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (resolve: any) => resolve([]),
    transaction: vi.fn().mockImplementation(async (callback) => {
      return await callback(queryBuilder);
    })
  };
  return { db: queryBuilder };
});

describe('Fase 9 - Backup, Exportação e Importação de Dados', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deve exportar todos os dados em formato JSON', async () => {
    const jsonStr = await exportarDadosCompletos();
    expect(typeof jsonStr).toBe('string');
    
    const parsed = JSON.parse(jsonStr);
    expect(parsed).toBeDefined();
    expect(parsed.perfis).toBeDefined();
    expect(parsed.disciplinas).toBeDefined();
  });

  it('deve restaurar dados a partir de um JSON válido', async () => {
    const mockBackupStr = JSON.stringify({
      perfis: [{ id: 'mock-perfil-id', authUserId: 'auth-id', nome: 'Alice', papel: 'estudante' }],
      disciplinas: [{ id: 'mock-disc-id', nome: 'Biologia', area: 'natureza', corHex: '#FFF', ordem: 1 }],
      topicos: []
    });

    const res = await restaurarDadosCompletos(mockBackupStr);
    expect(res.sucesso).toBe(true);
    expect(res.mensagem).toContain('sucesso');
  });

});
