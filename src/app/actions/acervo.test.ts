import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  diagnosticarReconciliacaoAcervo,
  enviarArquivo,
  enviarArquivoFormData,
  listarArquivosAcervo,
  obterAcervoStatus,
  obterUrlLeituraArquivoAcervo,
} from './acervo';
import { buscarNoAcervo } from './busca';
import {
  StorageOperationError,
  downloadFromSupabaseStorage,
  obterUrlAssinadaSupabase,
  uploadToSupabaseStorage,
} from '../../lib/supabaseStorage';

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

vi.mock('../../lib/supabaseStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/supabaseStorage')>();
  return {
    ...actual,
    uploadToSupabaseStorage: vi.fn().mockResolvedValue('acervo/mock-file-id.pdf'),
    downloadFromSupabaseStorage: vi
      .fn()
      .mockResolvedValue(Buffer.from('%PDF-1.4\nconteudo de teste\n%%EOF')),
    obterUrlAssinadaSupabase: vi
      .fn()
      .mockResolvedValue('https://storage.example.invalid/storage/v1/object/sign/acervo/mock.pdf?token=abc'),
  };
});

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
  const queryBuilder: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'mock-file-id', status: 'aguardando', etapaAtual: 'extracao' }]),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown[]) => unknown) => resolve([])
  };
  return { db: queryBuilder };
});

const DISC_ID = '00000000-0000-0000-0000-000000000001';
const INEXISTENTE_ID = 'aaaa2222-2222-4222-8222-222222222222';
const VALID_PDF_BASE64 = Buffer.from('%PDF-1.4\nconteudo de teste\n%%EOF').toString('base64');

describe('Acervo e Ingestão - Server Actions', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('enviarArquivo', () => {
    it('deve cadastrar um novo arquivo e retornar sucesso', async () => {
      const result = await enviarArquivo(
        DISC_ID,
        'Livro Teste',
        'livro',
        1,
        'enem',
        'teste.pdf',
        VALID_PDF_BASE64
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

    it('rejeita arquivo sem assinatura PDF ou extensão inválida sem acessar Storage nem banco (F1.09)', async () => {
      const { db } = await import('../../db');

      const naoPdf = await enviarArquivo(
        DISC_ID,
        'Livro Teste',
        'livro',
        1,
        'enem',
        'teste.pdf',
        Buffer.from('<html>nao eh pdf</html>').toString('base64')
      );
      expect(naoPdf).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

      const extensaoInvalida = await enviarArquivo(
        DISC_ID,
        'Livro Teste',
        'livro',
        1,
        'enem',
        'teste.exe',
        VALID_PDF_BASE64
      );
      expect(extensaoInvalida).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

      const pathTraversal = await enviarArquivo(
        DISC_ID,
        'Livro Teste',
        'livro',
        1,
        'enem',
        '../teste.pdf',
        VALID_PDF_BASE64
      );
      expect(pathTraversal).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

      const uuidInvalido = await enviarArquivo(
        'disc-id-invalido',
        'Livro Teste',
        'livro',
        1,
        'enem',
        'teste.pdf',
        VALID_PDF_BASE64
      );
      expect(uuidInvalido).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

      const pdfTruncadoSemEof = await enviarArquivo(
        DISC_ID,
        'Livro Teste',
        'livro',
        1,
        'enem',
        'teste.pdf',
        Buffer.from('%PDF-1.4\nconteudo truncado sem marcador final').toString('base64')
      );
      expect(pdfTruncadoSemEof).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

      const pdfComJavascript = await enviarArquivo(
        DISC_ID,
        'Livro Teste',
        'livro',
        1,
        'enem',
        'teste.pdf',
        Buffer.from('%PDF-1.4\n1 0 obj << /S /JavaScript /JS (app.alert(1)) >>\n%%EOF').toString('base64')
      );
      expect(pdfComJavascript).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

      expect(uploadToSupabaseStorage).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('adota objeto determinístico já existente no Storage quando tentativa anterior falhou no INSERT (F1.10)', async () => {
      vi.mocked(uploadToSupabaseStorage).mockRejectedValueOnce(
        new StorageOperationError('OBJECT_EXISTS', 'O objeto já existe no Storage.')
      );

      const result = await enviarArquivo(
        DISC_ID,
        'Livro Recuperado',
        'livro',
        1,
        'enem',
        'recuperado.pdf',
        VALID_PDF_BASE64
      );

      expect(result).toEqual({
        ok: true,
        data: {
          arquivoId: 'mock-file-id',
          uploadStatus: 'concluido',
          processamentoStatus: 'aguardando',
          mensagem: expect.stringContaining('objeto pré-existente reconciliado'),
          reconciliacao: 'objeto_existente_adotado',
        },
      });
    });

    it('rejeita adoção após OBJECT_EXISTS quando o conteúdo armazenado no Storage diverge do SHA-256 enviado (F1.13)', async () => {
      const { db } = await import('../../db');
      vi.mocked(uploadToSupabaseStorage).mockRejectedValueOnce(
        new StorageOperationError('OBJECT_EXISTS', 'O objeto já existe no Storage.')
      );
      vi.mocked(downloadFromSupabaseStorage).mockResolvedValueOnce(
        Buffer.from('%PDF-1.4\nconteudo corrompido ou divergente\n%%EOF')
      );

      const result = await enviarArquivo(
        DISC_ID,
        'Livro Corrompido',
        'livro',
        1,
        'enem',
        'corrompido.pdf',
        VALID_PDF_BASE64
      );

      expect(result).toEqual({
        ok: false,
        code: 'CONFLICT',
        message:
          'O objeto existente no armazenamento diverge do conteúdo enviado (falha de integridade SHA-256). Nenhum cadastro foi realizado.',
      });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejeita resposta externa inválida do Storage sem inserir metadados nem reportar sucesso (F1.10)', async () => {
      const { db } = await import('../../db');
      vi.mocked(uploadToSupabaseStorage).mockRejectedValueOnce(
        new StorageOperationError('INVALID_RESPONSE', 'Resposta inválida do serviço de armazenamento.')
      );

      const result = await enviarArquivo(
        DISC_ID,
        'Livro Teste',
        'livro',
        1,
        'enem',
        'teste.pdf',
        VALID_PDF_BASE64
      );

      expect(result).toEqual({
        ok: false,
        code: 'EXTERNAL_SERVICE_ERROR',
        message: 'Resposta inválida do serviço de armazenamento. Nenhum processamento foi iniciado.',
      });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('suporta transporte binário via FormData sem inflação base64 (F1.10)', async () => {
      const formData = new FormData();
      formData.set('disciplinaId', DISC_ID);
      formData.set('titulo', 'Apostila Binária');
      formData.set('tipoMaterial', 'apostila');
      formData.set('serieAlvo', '1');
      formData.set('vestibular', 'enem');
      formData.set(
        'file',
        new File([Buffer.from('%PDF-1.4\nconteudo binario\n%%EOF')], 'apostila.pdf', {
          type: 'application/pdf',
        })
      );

      const result = await enviarArquivoFormData(formData);
      expect(result).toMatchObject({
        ok: true,
        data: {
          arquivoId: 'mock-file-id',
          uploadStatus: 'concluido',
          processamentoStatus: 'aguardando',
        },
      });
      expect(uploadToSupabaseStorage).toHaveBeenCalledWith(
        expect.stringMatching(/^acervo\/[0-9a-f]{64}\.pdf$/),
        expect.any(Buffer),
        'application/pdf',
        { upsert: false }
      );
    });

    it('não cadastra nem informa sucesso quando o Storage falha', async () => {
      vi.mocked(uploadToSupabaseStorage).mockRejectedValueOnce(new Error('credencial=segredo'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await enviarArquivo(
        DISC_ID, 'Livro Teste', 'livro', 1, 'enem', 'teste.pdf',
        VALID_PDF_BASE64
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
        DISC_ID, 'Livro Teste', 'livro', 1, 'enem', 'teste.pdf',
        VALID_PDF_BASE64
      );

      expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_ERROR' });
      expect(result).not.toHaveProperty('data');
    });

    it('retorna PERSISTENCE_ERROR sem fallback silencioso para execução efêmera quando a fila durável falha (F1.11)', async () => {
      const { db } = await import('../../db');
      const ingestion = await import('../../lib/ingestion');
      const spyExtrair = vi.spyOn(ingestion, 'extrairTextoPDF');

      // 1º insert (acervo_arquivos) sucede; 2º insert (acervo_jobs) falha
      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { id: 'mock-file-id', statusProcessamento: 'aguardando', filePath: 'acervo/mock.pdf' },
            ]),
          }),
        } as never)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockRejectedValue(new Error('acervo_jobs insert failed')),
            }),
          }),
        } as never);

      const result = await enviarArquivo(
        DISC_ID,
        'Livro Teste',
        'livro',
        1,
        'enem',
        'teste.pdf',
        VALID_PDF_BASE64
      );

      expect(result).toEqual({
        ok: false,
        code: 'PERSISTENCE_ERROR',
        message: expect.stringContaining('não foi possível enfileirar o job durável'),
      });
      expect(spyExtrair).not.toHaveBeenCalled();
    });
  });

  describe('listarArquivosAcervo', () => {
    it('deve listar os arquivos do acervo', async () => {
      const files = await listarArquivosAcervo(DISC_ID);
      expect(Array.isArray(files)).toBe(true);
    });

    it('rejeita disciplinaId inválido em listarArquivosAcervo (F1.09)', async () => {
      await expect(listarArquivosAcervo('nao-uuid')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });
  });

  describe('obterAcervoStatus', () => {
    it('deve retornar null para arquivo não existente e rejeitar UUID inválido (F1.09)', async () => {
      const status = await obterAcervoStatus(INEXISTENTE_ID);
      expect(status).toBeNull();
      await expect(obterAcervoStatus('non-existent-id')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });
  });

  describe('obterUrlLeituraArquivoAcervo e diagnosticarReconciliacaoAcervo (F1.10)', () => {
    it('bloqueia geração de URL assinada quando o arquivo não pertence ao responsável ou expiração é inválida', async () => {
      const naoEncontrado = await obterUrlLeituraArquivoAcervo(INEXISTENTE_ID, 300);
      expect(naoEncontrado).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'Arquivo não encontrado ou acesso não autorizado.',
      });
      expect(obterUrlAssinadaSupabase).not.toHaveBeenCalled();

      const expiracaoExcessiva = await obterUrlLeituraArquivoAcervo(INEXISTENTE_ID, 86400);
      expect(expiracaoExcessiva).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    });

    it('executa reconciliação em modo somente leitura sem apagar arquivos', async () => {
      const relatorio = await diagnosticarReconciliacaoAcervo([
        {
          path: 'acervo/' + 'a'.repeat(64) + '.pdf',
          tamanhoBytes: 1024,
          mime: 'application/pdf',
        },
      ]);

      expect(relatorio).toMatchObject({
        ok: true,
        data: {
          somenteLeitura: true,
          exclusaoAutomaticaExecutada: false,
          totais: {
            registrosDb: 0,
            objetosStorage: 1,
            objetoSemMetadados: 1,
          },
        },
      });
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
