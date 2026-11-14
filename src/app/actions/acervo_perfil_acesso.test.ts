import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enviarArquivo,
  listarArquivosAcervo,
  obterAcervoStatus,
  obterUrlLeituraArquivoAcervo,
} from './acervo';
import { buscarNoAcervo } from './busca';
import * as authModule from '../../lib/authorization';
import * as ingestionModule from '../../lib/ingestion';

vi.mock('../../lib/authorization', () => ({
  requireAuthenticatedProfile: vi.fn(),
  requireRole: vi.fn(),
  requireManagedStudentProfile: vi.fn(),
  assertOwnership: vi.fn(),
}));

vi.mock('../../lib/supabaseStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/supabaseStorage')>();
  return {
    ...actual,
    uploadToSupabaseStorage: vi.fn().mockResolvedValue('acervo/mock-sha.pdf'),
    downloadFromSupabaseStorage: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4\nconteudo\n%%EOF')),
    obterUrlAssinadaSupabase: vi.fn().mockResolvedValue('https://storage.supabase.com/signed/mock.pdf'),
  };
});

vi.mock('../../lib/ingestion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/ingestion')>();
  return {
    ...actual,
    buscaHibridaAcervo: vi.fn(),
  };
});

vi.mock('../../db', () => {
  const queryBuilder: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'mock-file-id', status: 'concluido' }]),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown[]) => unknown) => resolve([]),
  };
  return { db: queryBuilder };
});

const PERFIL_BRUNO_RESPONSAVEL = {
  id: '20000000-0000-4000-8000-000000000001',
  authUserId: 'auth-bruno',
  nome: 'Bruno Responsável Sintético',
  email: 'bruno@medicina2029.staging',
  papel: 'responsavel' as const,
};

const PERFIL_ALICE_ESTUDANTE = {
  id: '10000000-0000-4000-8000-000000000001',
  authUserId: 'auth-alice',
  nome: 'Alice Estudante Sintética',
  email: 'alice@medicina2029.staging',
  papel: 'estudante' as const,
};

const PERFIL_CARLOS_ESTUDANTE = {
  id: '30000000-0000-4000-8000-000000000001',
  authUserId: 'auth-carlos',
  nome: 'Carlos Estudante Sintético Independente',
  email: 'carlos@medicina2029.staging',
  papel: 'estudante' as const,
};

describe('MEDICINA 2029 — Matriz de Acesso do Acervo por Perfil (Bruno, Alice, Carlos)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Operações Administrativas do Acervo (/acervo)', () => {
    it('Bruno (responsavel) é autorizado a listar arquivos do acervo', async () => {
      vi.mocked(authModule.requireRole).mockResolvedValue(PERFIL_BRUNO_RESPONSAVEL);
      const files = await listarArquivosAcervo();
      expect(authModule.requireRole).toHaveBeenCalledWith('responsavel');
      expect(Array.isArray(files)).toBe(true);
    });

    it('Alice (estudante vinculada) é bloqueada de listar o acervo administrativo', async () => {
      vi.mocked(authModule.requireRole).mockRejectedValue(new Error('Acesso não autorizado: papel insuficiente.'));
      await expect(listarArquivosAcervo()).rejects.toThrowError(/papel insuficiente/);
    });

    it('Carlos (estudante independente) é bloqueado de listar o acervo administrativo', async () => {
      vi.mocked(authModule.requireRole).mockRejectedValue(new Error('Acesso não autorizado: papel insuficiente.'));
      await expect(listarArquivosAcervo()).rejects.toThrowError(/papel insuficiente/);
    });

    it('Bruno é autorizado a obter status e páginas do arquivo', async () => {
      vi.mocked(authModule.requireRole).mockResolvedValue(PERFIL_BRUNO_RESPONSAVEL);
      const status = await obterAcervoStatus('f0000000-0000-4000-8000-000000000001');
      expect(authModule.requireRole).toHaveBeenCalledWith('responsavel');
    });

    it('Alice e Carlos são bloqueados de obter status do arquivo no acervo', async () => {
      vi.mocked(authModule.requireRole).mockRejectedValue(new Error('Acesso não autorizado: papel insuficiente.'));
      await expect(obterAcervoStatus('f0000000-0000-4000-8000-000000000001')).rejects.toThrow();
    });

    it('Bruno é autorizado a gerar URL assinada temporária para leitura privada', async () => {
      vi.mocked(authModule.requireRole).mockResolvedValue(PERFIL_BRUNO_RESPONSAVEL);
      // Simula arquivo retornado do banco
      const dbMock = await import('../../db');
      vi.mocked((dbMock.db as any).select().from().where().limit).mockReturnValue({
        then: (resolve: (val: any) => any) =>
          resolve([
            {
              id: 'f0000000-0000-4000-8000-000000000001',
              filePath: 'acervo/mock.pdf',
              enviadoPor: PERFIL_BRUNO_RESPONSAVEL.id,
            },
          ]),
      });

      const res = await obterUrlLeituraArquivoAcervo('f0000000-0000-4000-8000-000000000001', 300);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.signedUrl).toContain('mock.pdf');
        expect(res.data.expiraEmSegundos).toBe(300);
      }
    });

    it('Alice e Carlos são bloqueados de gerar URL assinada para download bruto', async () => {
      vi.mocked(authModule.requireRole).mockRejectedValue(new Error('Acesso não autorizado: papel insuficiente.'));
      await expect(
        obterUrlLeituraArquivoAcervo('f0000000-0000-4000-8000-000000000001', 300)
      ).rejects.toThrow();
    });
  });

  describe('2. Acesso Pedagógico e Busca Híbrida (/busca)', () => {
    it('Bruno (responsavel) busca no acervo e repassa seu papel e perfilId para o pipeline', async () => {
      vi.mocked(authModule.requireAuthenticatedProfile).mockResolvedValue(PERFIL_BRUNO_RESPONSAVEL);
      vi.mocked(ingestionModule.buscaHibridaAcervo).mockResolvedValue([
        {
          chunkId: 'chunk-1',
          arquivoId: 'f0000000-0000-4000-8000-000000000001',
          arquivoTitulo: 'Apostila Citologia',
          paginaInicial: 1,
          paginaFinal: 1,
          texto: 'Texto de Citologia',
          similaridade: 0.865,
        },
      ]);

      const res = await buscarNoAcervo('citologia');
      expect(authModule.requireAuthenticatedProfile).toHaveBeenCalled();
      expect(ingestionModule.buscaHibridaAcervo).toHaveBeenCalledWith(
        'citologia',
        undefined,
        5,
        expect.objectContaining({
          papel: 'responsavel',
          perfilId: PERFIL_BRUNO_RESPONSAVEL.id,
        })
      );
      expect(res).toHaveLength(1);
      expect(res[0].arquivoTitulo).toBe('Apostila Citologia');
    });

    it('Alice (estudante vinculada) busca no acervo e repassa seu perfil de estudante', async () => {
      vi.mocked(authModule.requireAuthenticatedProfile).mockResolvedValue(PERFIL_ALICE_ESTUDANTE);
      vi.mocked(ingestionModule.buscaHibridaAcervo).mockResolvedValue([
        {
          chunkId: 'chunk-1',
          arquivoId: 'f0000000-0000-4000-8000-000000000001',
          arquivoTitulo: 'Apostila Citologia',
          paginaInicial: 1,
          paginaFinal: 1,
          texto: 'Texto de Citologia',
          similaridade: 0.865,
        },
      ]);

      const res = await buscarNoAcervo('citologia');
      expect(authModule.requireAuthenticatedProfile).toHaveBeenCalled();
      expect(ingestionModule.buscaHibridaAcervo).toHaveBeenCalledWith(
        'citologia',
        undefined,
        5,
        expect.objectContaining({
          papel: 'estudante',
          perfilId: PERFIL_ALICE_ESTUDANTE.id,
        })
      );
      expect(res).toHaveLength(1);
      expect(res[0].similaridade).toBe(0.865);
    });

    it('Carlos (estudante independente) busca no acervo e não recebe materiais sem vínculo tutelar', async () => {
      vi.mocked(authModule.requireAuthenticatedProfile).mockResolvedValue(PERFIL_CARLOS_ESTUDANTE);
      // O pipeline do banco retorna vazio para estudante sem vínculo com o autor
      vi.mocked(ingestionModule.buscaHibridaAcervo).mockResolvedValue([]);

      const res = await buscarNoAcervo('citologia');
      expect(authModule.requireAuthenticatedProfile).toHaveBeenCalled();
      expect(ingestionModule.buscaHibridaAcervo).toHaveBeenCalledWith(
        'citologia',
        undefined,
        5,
        expect.objectContaining({
          papel: 'estudante',
          perfilId: PERFIL_CARLOS_ESTUDANTE.id,
        })
      );
      expect(res).toHaveLength(0);
    });

    it('Usuário não autenticado é rejeitado na busca do acervo', async () => {
      vi.mocked(authModule.requireAuthenticatedProfile).mockRejectedValue(new Error('UNAUTHENTICATED'));
      await expect(buscarNoAcervo('citologia')).rejects.toThrowError(/UNAUTHENTICATED/);
    });
  });
});
