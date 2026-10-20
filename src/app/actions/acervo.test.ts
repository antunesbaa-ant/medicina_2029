import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enviarArquivo, listarArquivosAcervo, obterAcervoStatus } from './acervo';
import { buscarNoAcervo } from './busca';
import { uploadToSupabaseStorage } from '../../lib/supabaseStorage';

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

vi.mock('../../lib/supabaseStorage', () => ({
  uploadToSupabaseStorage: vi.fn().mockResolvedValue('acervo/mock-file-id.pdf'),
}));

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
        'enem',
        'teste.pdf',
        Buffer.from('dummy').toString('base64')
      );

      expect(result).toEqual({
        ok: true,
        data: {
          arquivoId: 'mock-file-id',
          uploadStatus: 'concluido',
          processamentoStatus: 'aguardando',
          mensagem: expect.stringContaining('Upload confirmado'),
        },
      });
    });

    it('não cadastra nem informa sucesso quando o Storage falha', async () => {
      vi.mocked(uploadToSupabaseStorage).mockRejectedValueOnce(new Error('credencial=segredo'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await enviarArquivo(
        'disc-id-1', 'Livro Teste', 'livro', 1, 'enem', 'teste.pdf',
        Buffer.from('dummy').toString('base64')
      );

      expect(result).toEqual({
        ok: false,
        code: 'EXTERNAL_SERVICE_ERROR',
        message: expect.stringContaining('Nenhum processamento foi iniciado'),
      });
      if (result.ok) throw new Error('O upload deveria ter falhado.');
      expect(result.message).not.toContain('segredo');
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('segredo');
    });

    it('não informa sucesso quando o INSERT não retorna o arquivo persistido', async () => {
      const { db } = await import('../../db');
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      } as never);

      const result = await enviarArquivo(
        'disc-id-1', 'Livro Teste', 'livro', 1, 'enem', 'teste.pdf',
        Buffer.from('dummy').toString('base64')
      );

      expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_ERROR' });
      expect(result).not.toHaveProperty('data');
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

    it('não apresenta similaridade fictícia quando embeddings reais estão indisponíveis', async () => {
      await expect(buscarNoAcervo('cardiologia')).rejects.toMatchObject({
        code: 'EXTERNAL_SERVICE_ERROR',
        message: 'A busca semântica está temporariamente indisponível.',
      });
    });
  });

});
