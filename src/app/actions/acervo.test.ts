import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enviarArquivo, listarArquivosAcervo, obterAcervoStatus } from './acervo';
import { buscarNoAcervo } from './busca';

// Mock pdf-parse
vi.mock('pdf-parse', () => {
  return {
    default: vi.fn().mockResolvedValue({
      text: 'Página 1 de teste sobre Equilíbrio Químico.\fPágina 2 de teste com exercícios de estequiometria.'
    })
  };
});

// Mock DB interactions
vi.mock('../../db', () => {
  const queryBuilder: any = {
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'mock-file-id' }]),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: (resolve: any) => resolve([])
  };
  return { db: queryBuilder };
});

describe('Acervo e Ingestão - Server Actions', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('enviarArquivo', () => {
    it('deve cadastrar um novo arquivo e retornar sucesso', async () => {
      const result = await enviarArquivo(
        'disc-id-1',
        'Livro Teste',
        'livro',
        1,
        'teste.pdf',
        Buffer.from('dummy').toString('base64'),
        'perfil-1'
      );

      expect(result.sucesso).toBe(true);
      expect(result.arquivoId).toBe('mock-file-id');
    });
  });

  describe('listarArquivosAcervo', () => {
    it('deve listar os arquivos do acervo', async () => {
      const files = await listarArquivosAcervo('disc-id-1');
      expect(Array.isArray(files)).toBe(true);
    });
  });

  describe('obterAcervoStatus', () => {
    it('deve retornar null para arquivo não existente', async () => {
      const status = await obterAcervoStatus('non-existent-id');
      expect(status).toBeNull();
    });
  });

  describe('buscarNoAcervo', () => {
    it('deve retornar resultados vazios para queries vazias', async () => {
      const results = await buscarNoAcervo('');
      expect(results.length).toBe(0);
    });
  });

});
