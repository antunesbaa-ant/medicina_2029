import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import * as schema from '../../db/schema';

const MODULE_ROOT = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';
const PGLITE_INDEX = path.join(MODULE_ROOT, '@electric-sql/pglite/dist/index.js');
const PGLITE_VECTOR = path.join(MODULE_ROOT, '@electric-sql/pglite-pgvector/dist/index.js');
const HAS_PGLITE = existsSync(PGLITE_INDEX) && existsSync(PGLITE_VECTOR);

// Atores fictícios canônicos do sistema
const ESTUDANTE_1 = {
  id: '10000000-0000-4000-8000-000000000001',
  authUserId: 'a0000000-0000-4000-8000-000000000001',
  nome: 'Estudante Ficticia 1 F1.04',
  email: 'estudante1.f104@example.invalid',
  papel: 'estudante' as const,
};

const RESPONSAVEL_1 = {
  id: '20000000-0000-4000-8000-000000000001',
  authUserId: 'b0000000-0000-4000-8000-000000000001',
  nome: 'Responsavel A (Proprietario)',
  email: 'responsavel1.f104@example.invalid',
  papel: 'responsavel' as const,
};

const RESPONSAVEL_2 = {
  id: '20000000-0000-4000-8000-000000000002',
  authUserId: 'b0000000-0000-4000-8000-000000000002',
  nome: 'Responsavel B (Terceiro / Cross-Tenant)',
  email: 'responsavel2.f104@example.invalid',
  papel: 'responsavel' as const,
};

const DISCIPLINA_BIOLOGIA = '30000000-0000-4000-8000-000000000001';

// Simulador isolado em memória do bucket privado do Supabase Storage
const simulatedBucket = vi.hoisted(() => ({
  objects: new Map<string, { body: Buffer; contentType: string; upsertUsed: boolean }>(),
  failNextUpload: false,
  returnInvalidUploadResponse: false,
  returnPublicSignedUrl: false,
  uploadCalls: 0,
  removeCalls: 0,
  signedUrlCalls: 0,
  downloadCalls: 0,
  lastUploadOptions: null as { contentType?: string; upsert?: boolean } | null,
  lastClientKey: null as string | null,
}));

const authState = vi.hoisted(() => ({
  currentProfile: null as
    | {
        id: string;
        authUserId: string;
        nome: string;
        email: string | null;
        papel: 'estudante' | 'responsavel';
      }
    | null,
  dbInstance: null as unknown,
  failNextInsert: false,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_supabaseUrl: string, supabaseServerKey: string) => {
    simulatedBucket.lastClientKey = supabaseServerKey;
    return {
      storage: {
        from: (bucketName: string) => ({
          upload: async (
            key: string,
            body: Buffer,
            options?: { contentType?: string; upsert?: boolean }
          ) => {
            simulatedBucket.uploadCalls++;
            simulatedBucket.lastUploadOptions = options ?? null;

            if (bucketName !== 'acervo') {
              return { data: null, error: { message: 'Bucket inválido' } };
            }
            if (simulatedBucket.failNextUpload) {
              simulatedBucket.failNextUpload = false;
              return { data: null, error: { message: 'Storage service unavailable' } };
            }
            if (simulatedBucket.returnInvalidUploadResponse) {
              simulatedBucket.returnInvalidUploadResponse = false;
              return { data: { path: '' }, error: null };
            }
            const upsert = options?.upsert ?? false;
            if (!upsert && simulatedBucket.objects.has(key)) {
              return {
                data: null,
                error: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' },
              };
            }
            simulatedBucket.objects.set(key, {
              body: Buffer.from(body),
              contentType: options?.contentType ?? 'application/pdf',
              upsertUsed: upsert,
            });
            return { data: { path: key }, error: null };
          },
          createSignedUrl: async (key: string, expiresIn: number) => {
            simulatedBucket.signedUrlCalls++;
            if (!simulatedBucket.objects.has(key)) {
              return { data: null, error: { message: 'Object not found' } };
            }
            if (simulatedBucket.returnPublicSignedUrl) {
              simulatedBucket.returnPublicSignedUrl = false;
              return {
                data: {
                  signedUrl: `https://storage.example.invalid/storage/v1/object/public/acervo/${key}`,
                },
                error: null,
              };
            }
            return {
              data: {
                signedUrl: `https://storage.example.invalid/storage/v1/object/sign/acervo/${key}?token=signed_${expiresIn}`,
              },
              error: null,
            };
          },
          remove: async () => {
            simulatedBucket.removeCalls++;
            return { data: [], error: null };
          },
          download: async (key: string) => {
            simulatedBucket.downloadCalls++;
            const obj = simulatedBucket.objects.get(key);
            if (!obj) {
              return { data: null, error: { message: 'Object not found' } };
            }
            return {
              data: new Blob([new Uint8Array(obj.body)], { type: obj.contentType }),
              error: null,
            };
          },
        }),
      },
    };
  }),
}));

vi.mock('../../lib/authorization', () => ({
  requireAuthenticatedProfile: vi.fn(async () => {
    if (!authState.currentProfile) {
      const err = new Error('Autenticação necessária.') as Error & { code: string };
      err.name = 'AuthorizationError';
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    return authState.currentProfile;
  }),
  requireRole: vi.fn(async (expectedRole: 'estudante' | 'responsavel') => {
    if (!authState.currentProfile) {
      const err = new Error('Autenticação necessária.') as Error & { code: string };
      err.name = 'AuthorizationError';
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    if (authState.currentProfile.papel !== expectedRole) {
      const err = new Error('Acesso não autorizado.') as Error & { code: string };
      err.name = 'AuthorizationError';
      err.code = 'FORBIDDEN';
      throw err;
    }
    return authState.currentProfile;
  }),
  requireManagedStudentProfile: vi.fn(async () => ESTUDANTE_1),
  assertOwnership: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        const instance = authState.dbInstance as Record<PropertyKey, unknown> | null;
        if (!instance) {
          throw new Error('PGlite dbInstance não inicializado.');
        }
        if (prop === 'insert' && authState.failNextInsert) {
          authState.failNextInsert = false;
          return () => ({
            values: () => ({
              returning: async () => {
                throw new Error('Simulated DB INSERT failure after Storage upload');
              },
            }),
          });
        }
        const value = instance[prop];
        return typeof value === 'function' ? value.bind(instance) : value;
      },
    }
  ),
}));

import {
  ACERVO_BUCKET_NAME,
  DEFAULT_SIGNED_URL_SECONDS,
  StorageOperationError,
  downloadFromSupabaseStorage,
  getSupabaseClient,
  obterUrlAssinadaSupabase,
  resetSupabaseClientCache,
  uploadToSupabaseStorage,
} from '../../lib/supabaseStorage';
import {
  buildDeterministicAcervoStoragePath,
  normalizeAcervoStorageKey,
} from '../../lib/acervoReconciliacao';
import {
  enviarArquivo,
  enviarArquivoFormData,
  obterUrlLeituraArquivoAcervo,
} from './acervo';

describe.skipIf(!HAS_PGLITE)(
  'H1.07 — Auditoria de Credenciais, Fronteira de Confiança e Isolamento de Storage',
  () => {
    let pg: {
      exec: (sql: string) => Promise<unknown>;
      query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
      close: () => Promise<void>;
    };

    const rootDir = process.cwd();
    const readSql = (relPath: string) =>
      readFileSync(path.join(rootDir, relPath), 'utf8').replaceAll('--> statement-breakpoint', '\n');

    const sql0000 = readSql('drizzle/0000_greedy_loki.sql');
    const sql0001 = readSql('drizzle/0001_dry_talos.sql');
    const sql0002 = readSql('drizzle/0002_little_swarm.sql');
    const sql0003 = readSql('drizzle/0003_f1_03_r_expansao.sql');
    const fixturesSql = readSql('tests/integration/f1_04/fixtures.sql');
    const f109ProposalSql = readSql('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql');
    const f110StorageProposalSql = readSql('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql');
    const f111QueueProposalSql = readSql('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql');

    beforeAll(async () => {
      process.env.SUPABASE_URL = 'https://storage.example.invalid';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-super-privileged-test-key';
      delete process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;
      resetSupabaseClientCache();

      const { PGlite, types } = await import(pathToFileURL(PGLITE_INDEX).href);
      const { vector } = await import(pathToFileURL(PGLITE_VECTOR).href);
      pg = await PGlite.create({ extensions: { vector } });

      await pg.exec(sql0000);
      await pg.exec(sql0001);
      await pg.exec(sql0002);
      await pg.exec(sql0003);
      await pg.exec(fixturesSql);
      // Harmoniza caminhos legados de fixtures anteriores a F1.10 para o formato canônico
      await pg.exec(`
        UPDATE public.acervo_arquivos
        SET file_path = 'acervo/' || hash_conteudo || '.pdf'
        WHERE file_path LIKE 'f1_04/%';
      `);
      await pg.exec(f109ProposalSql);

      // Compatibilidade de Storage para ambiente isolado PGlite
      await pg.exec(`
        CREATE SCHEMA IF NOT EXISTS storage;
        CREATE TABLE IF NOT EXISTS storage.buckets (
          id text PRIMARY KEY,
          name text NOT NULL UNIQUE,
          owner uuid,
          public boolean DEFAULT false NOT NULL,
          file_size_limit bigint,
          allowed_mime_types text[],
          created_at timestamptz DEFAULT now() NOT NULL,
          updated_at timestamptz DEFAULT now() NOT NULL
        );
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES ('acervo', 'acervo', false, 20971520, ARRAY['application/pdf']::text[])
        ON CONFLICT (id) DO NOTHING;
        ALTER TABLE storage.buckets
          ADD CONSTRAINT storage_buckets_acervo_private_check
          CHECK (
            id <> 'acervo'
            OR (
              public = false
              AND file_size_limit = 20971520
              AND allowed_mime_types = ARRAY['application/pdf']::text[]
            )
          );
        CREATE TABLE IF NOT EXISTS storage.objects (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          bucket_id text NOT NULL REFERENCES storage.buckets(id) ON DELETE RESTRICT,
          name text NOT NULL,
          owner uuid,
          metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
          created_at timestamptz DEFAULT now() NOT NULL,
          updated_at timestamptz DEFAULT now() NOT NULL,
          CONSTRAINT storage_objects_bucket_name_unique UNIQUE (bucket_id, name)
        );
      `);

      await pg.exec(f110StorageProposalSql);
      await pg.exec(f111QueueProposalSql);

      const parsers = {
        [types.TIMESTAMP]: (value: unknown) => value,
        [types.TIMESTAMPTZ]: (value: unknown) => value,
        [types.INTERVAL]: (value: unknown) => value,
        [types.DATE]: (value: unknown) => value,
        1231: (value: unknown) => value,
        1115: (value: unknown) => value,
        1185: (value: unknown) => value,
        1187: (value: unknown) => value,
        1182: (value: unknown) => value,
      };

      const proxyDb = drizzle(
        async (queryStr, params, method) => {
          const rowMode = method === 'all' ? 'array' : 'object';
          const res = await (
            pg as unknown as {
              query: (
                sql: string,
                params?: unknown[],
                options?: { rowMode: 'array' | 'object'; parsers: Record<number, (v: unknown) => unknown> }
              ) => Promise<{ rows: unknown[] }>;
            }
          ).query(queryStr, params, { rowMode, parsers });
          return { rows: res.rows };
        },
        { schema }
      );

      authState.dbInstance = proxyDb;
    });

    afterAll(async () => {
      if (pg) {
        await pg.close();
      }
    });

    beforeEach(() => {
      authState.currentProfile = RESPONSAVEL_1;
      authState.failNextInsert = false;
      simulatedBucket.failNextUpload = false;
      simulatedBucket.returnInvalidUploadResponse = false;
      simulatedBucket.returnPublicSignedUrl = false;
      simulatedBucket.uploadCalls = 0;
      simulatedBucket.signedUrlCalls = 0;
      simulatedBucket.removeCalls = 0;
      simulatedBucket.downloadCalls = 0;
      delete process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;
      resetSupabaseClientCache();
    });

    // ------------------------------------------------------------------------
    // TESTE 1: Rejeição de estudante tentando upload no acervo (regra e papel)
    // ------------------------------------------------------------------------
    it('1. Rejeita compulsoriamente estudante tentando upload no acervo (JSON e FormData)', async () => {
      authState.currentProfile = ESTUDANTE_1;

      const pdfBytes = Buffer.from('%PDF-1.4\nConteudo tentativa de estudante\n%%EOF\n');
      const pdfBase64 = pdfBytes.toString('base64');
      const initialUploads = simulatedBucket.uploadCalls;

      // A. Tentativa via enviarArquivo (JSON / base64)
      await expect(
        enviarArquivo(
          DISCIPLINA_BIOLOGIA,
          'Apostila Fraudulenta Estudante',
          'apostila',
          1,
          'enem',
          'tentativa_estudante.pdf',
          pdfBase64
        )
      ).rejects.toMatchObject({
        name: 'AuthorizationError',
        code: 'FORBIDDEN',
      });

      // B. Tentativa via enviarArquivoFormData (transporte binário)
      const fakeFormData = {
        get: (field: string) => {
          if (field === 'disciplinaId') return DISCIPLINA_BIOLOGIA;
          if (field === 'titulo') return 'Apostila FormData Estudante';
          if (field === 'tipoMaterial') return 'apostila';
          if (field === 'serieAlvo') return '1';
          if (field === 'vestibular') return 'enem';
          if (field === 'file') {
            return {
              name: 'tentativa_formdata.pdf',
              arrayBuffer: async () => pdfBytes.buffer,
            };
          }
          return null;
        },
      } as unknown as FormData;

      // Simula verificação de instanceof FormData contornada
      Object.setPrototypeOf(fakeFormData, FormData.prototype);

      await expect(enviarArquivoFormData(fakeFormData)).rejects.toMatchObject({
        name: 'AuthorizationError',
        code: 'FORBIDDEN',
      });

      // Garante que nenhuma chamada foi feita ao Storage e nenhum byte foi persistido
      expect(simulatedBucket.uploadCalls).toBe(initialUploads);
      expect(simulatedBucket.objects.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // TESTE 2: Rejeição de estudante tentando obter URL assinada de arquivo
    // ------------------------------------------------------------------------
    it('2. Rejeita compulsoriamente estudante tentando obter URL assinada de arquivo do acervo', async () => {
      // 1. Cadastra arquivo válido como Responsável 1
      authState.currentProfile = RESPONSAVEL_1;
      const pdfBytes = Buffer.from('%PDF-1.4\nDocumento legítimo R1\n%%EOF\n');
      const hash = crypto.createHash('sha256').update(pdfBytes).digest('hex');
      const filePath = buildDeterministicAcervoStoragePath(hash);

      simulatedBucket.objects.set(filePath, {
        body: pdfBytes,
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      const resUpload = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Material Biologia Legítimo R1',
        'livro',
        1,
        'enem',
        'legitimo.pdf',
        pdfBytes.toString('base64')
      );
      expect(resUpload.ok).toBe(true);
      const arquivoId = (resUpload as { data: { arquivoId: string } }).data.arquivoId;

      // 2. Estudante tenta gerar Signed URL do arquivo cadastrado
      authState.currentProfile = ESTUDANTE_1;
      const initialSignedCalls = simulatedBucket.signedUrlCalls;

      await expect(obterUrlLeituraArquivoAcervo(arquivoId, 300)).rejects.toMatchObject({
        name: 'AuthorizationError',
        code: 'FORBIDDEN',
      });

      // A API de Storage NUNCA foi acionada
      expect(simulatedBucket.signedUrlCalls).toBe(initialSignedCalls);
    });

    // ------------------------------------------------------------------------
    // TESTE 3: Isolamento Cross-Tenant (Responsável B vs Responsável A)
    // ------------------------------------------------------------------------
    it('3. Assegura isolamento Cross-Tenant: Responsável B não consegue gerar URL assinada de arquivo do Responsável A', async () => {
      // 1. Responsável A cadastra seu material privado
      authState.currentProfile = RESPONSAVEL_1;
      const pdfBytesA = Buffer.from('%PDF-1.4\nArquivo Confidencial Responsavel A\n%%EOF\n');
      const hashA = crypto.createHash('sha256').update(pdfBytesA).digest('hex');
      const filePathA = buildDeterministicAcervoStoragePath(hashA);

      simulatedBucket.objects.set(filePathA, {
        body: pdfBytesA,
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      const resUploadA = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Material Exclusivo Responsável A',
        'anotacao_aula',
        2,
        'unicamp',
        'exclusivo_a.pdf',
        pdfBytesA.toString('base64')
      );
      expect(resUploadA.ok).toBe(true);
      const arquivoAId = (resUploadA as { data: { arquivoId: string } }).data.arquivoId;

      // 2. Responsável B (outro responsável autenticado) tenta gerar Signed URL para o arquivo de A
      authState.currentProfile = RESPONSAVEL_2;
      const signedCallsBeforeAttack = simulatedBucket.signedUrlCalls;

      const resCrossTenant = await obterUrlLeituraArquivoAcervo(arquivoAId, 300);
      expect(resCrossTenant).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'Arquivo não encontrado ou acesso não autorizado.',
      });

      // Acesso foi estancado no Next.js (WHERE enviado_por = perfil.id); Storage não foi tocado
      expect(simulatedBucket.signedUrlCalls).toBe(signedCallsBeforeAttack);

      // 3. Responsável A (proprietário legítimo) consegue gerar sua URL assinada normalmente
      authState.currentProfile = RESPONSAVEL_1;
      const resOwner = await obterUrlLeituraArquivoAcervo(arquivoAId, 300);
      expect(resOwner).toMatchObject({
        ok: true,
        data: {
          arquivoId: arquivoAId,
          expiraEmSegundos: 300,
          signedUrl: expect.stringContaining('/object/sign/acervo/'),
        },
      });
      expect(simulatedBucket.signedUrlCalls).toBe(signedCallsBeforeAttack + 1);
    });

    // ------------------------------------------------------------------------
    // TESTE 4: Rejeição de Path Traversal (normalizeAcervoStorageKey & SQL)
    // ------------------------------------------------------------------------
    it('4. Rejeita caminhos maliciosos e Path Traversal tanto no validador TS quanto na função SQL', async () => {
      const maliciousPaths = [
        'acervo/../etc/passwd',
        'acervo/..\\windows\\win.ini',
        'acervo//dupla_barra.pdf',
        'acervo\\barra_invertida.pdf',
        'acervo/arquivo\x00nulo.pdf',
        '../fora_do_escopo.pdf',
        'acervo/subpasta/../../escape.pdf',
        '',
        '   ',
      ];

      // A. Validador TypeScript (normalizeAcervoStorageKey)
      for (const malPath of maliciousPaths) {
        expect(
          () => normalizeAcervoStorageKey(malPath),
          `normalizeAcervoStorageKey deveria rejeitar "${malPath}"`
        ).toThrow(/inválido/i);
      }

      // Caminho com barras nas pontas deve ser limpo com segurança
      const validHash = 'a'.repeat(64);
      expect(normalizeAcervoStorageKey(`  /acervo/${validHash}.pdf/  `)).toBe(`acervo/${validHash}.pdf`);

      // B. Função SQL imutável (medicina.is_valid_acervo_storage_path)
      const testCasesSql = [
        { path: 'acervo/../etc/passwd', expected: false },
        { path: 'acervo//dupla_barra.pdf', expected: false },
        { path: 'acervo\\barra_invertida.pdf', expected: false },
        { path: `outro_bucket/${validHash}.pdf`, expected: false },
        { path: `acervo/${validHash}.exe`, expected: false },
        { path: `acervo/${validHash.slice(0, 63)}.pdf`, expected: false }, // 63 chars (inválido)
        { path: `acervo/${'g'.repeat(64)}.pdf`, expected: false }, // hex inválido
        { path: `acervo/${validHash}.pdf`, expected: true }, // hash puro 64 chars
        { path: `acervo/${validHash}_anexo-1.pdf`, expected: true }, // sufixo sanitizado permitido
      ];

      for (const tc of testCasesSql) {
        const queryRes = await pg.query<{ is_valid: boolean }>(
          `SELECT medicina.is_valid_acervo_storage_path($1) AS is_valid`,
          [tc.path]
        );
        expect(queryRes.rows[0]?.is_valid).toBe(tc.expected);
      }

      // C. Proteção em uploadToSupabaseStorage e obterUrlAssinadaSupabase contra path traversal
      const dummyBuffer = Buffer.from('%PDF-1.4\nTeste Traversal\n%%EOF\n');
      await expect(
        uploadToSupabaseStorage('acervo/../malicious.pdf', dummyBuffer, 'application/pdf')
      ).rejects.toMatchObject({
        code: 'INVALID_KEY',
      });

      await expect(
        obterUrlAssinadaSupabase('acervo/../malicious.pdf', 300)
      ).rejects.toMatchObject({
        code: 'INVALID_KEY',
      });
    });

    // ------------------------------------------------------------------------
    // TESTE 5: Validação de Expiração de Signed URL (60s a 900s)
    // ------------------------------------------------------------------------
    it('5. Valida tempo de expiração da Signed URL (rejeita < 60s ou > 900s e não-inteiros)', async () => {
      const validHash = 'f'.repeat(64);
      const validKey = `acervo/${validHash}.pdf`;
      simulatedBucket.objects.set(validKey, {
        body: Buffer.from('%PDF-1.4\nPDF para Teste Expiracao\n%%EOF\n'),
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      // A. Na camada de Storage (obterUrlAssinadaSupabase)
      // Abaixo do mínimo (< 60s)
      await expect(obterUrlAssinadaSupabase(validKey, 59)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
        message: expect.stringContaining('entre 60 e 900'),
      });
      await expect(obterUrlAssinadaSupabase(validKey, 0)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });
      await expect(obterUrlAssinadaSupabase(validKey, -300)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });

      // Acima do máximo (> 900s)
      await expect(obterUrlAssinadaSupabase(validKey, 901)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
        message: expect.stringContaining('entre 60 e 900'),
      });
      await expect(obterUrlAssinadaSupabase(validKey, 3600)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });

      // Não-inteiro
      await expect(obterUrlAssinadaSupabase(validKey, 300.5)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });

      // Limites válidos (60s, 300s, 900s) funcionam com sucesso
      await expect(obterUrlAssinadaSupabase(validKey, 60)).resolves.toContain('token=signed_60');
      await expect(obterUrlAssinadaSupabase(validKey, 300)).resolves.toContain('token=signed_300');
      await expect(obterUrlAssinadaSupabase(validKey, 900)).resolves.toContain('token=signed_900');

      // B. Na Server Action (obterUrlLeituraArquivoAcervo)
      // Cadastra registro no banco
      authState.currentProfile = RESPONSAVEL_1;
      const pdfBytes = Buffer.from('%PDF-1.4\nConteudo Expira Action\n%%EOF\n');
      const hashAction = crypto.createHash('sha256').update(pdfBytes).digest('hex');
      const keyAction = `acervo/${hashAction}.pdf`;
      simulatedBucket.objects.set(keyAction, {
        body: pdfBytes,
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      const resUpload = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Documento Teste Expiracao Action',
        'lista_exercicios',
        3,
        'fuvest',
        'expira.pdf',
        pdfBytes.toString('base64')
      );
      expect(resUpload.ok).toBe(true);
      const arquivoId = (resUpload as { data: { arquivoId: string } }).data.arquivoId;

      // Expiração inválida rejeitada com VALIDATION_ERROR
      const resUnder = await obterUrlLeituraArquivoAcervo(arquivoId, 59);
      expect(resUnder).toMatchObject({
        ok: false,
        code: 'VALIDATION_ERROR',
      });

      const resOver = await obterUrlLeituraArquivoAcervo(arquivoId, 901);
      expect(resOver).toMatchObject({
        ok: false,
        code: 'VALIDATION_ERROR',
      });

      // Padrão (300s) e limites aceitos funcionam
      const resDefault = await obterUrlLeituraArquivoAcervo(arquivoId);
      expect(resDefault).toMatchObject({
        ok: true,
        data: { expiraEmSegundos: DEFAULT_SIGNED_URL_SECONDS },
      });
    });

    // ------------------------------------------------------------------------
    // TESTE 6: Bloqueio de Vazamento de SUPABASE_SERVICE_ROLE_KEY em NEXT_PUBLIC_
    // ------------------------------------------------------------------------
    it('6. Bloqueia sumariamente qualquer execução se SUPABASE_SERVICE_ROLE_KEY for exposta em NEXT_PUBLIC_', async () => {
      const validKey = `acervo/${'e'.repeat(64)}.pdf`;
      const dummyBody = Buffer.from('%PDF-1.4\nTeste Leak\n%%EOF\n');

      process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'vazamento-acidental-de-chave-mestra';

      // getSupabaseClient() detecta e aborta imediatamente
      expect(() => getSupabaseClient()).toThrowError(StorageOperationError);
      expect(() => getSupabaseClient()).toThrow(/NEXT_PUBLIC_/);

      // uploadToSupabaseStorage aborta
      await expect(
        uploadToSupabaseStorage(validKey, dummyBody, 'application/pdf')
      ).rejects.toMatchObject({
        code: 'INSECURE_CONFIGURATION',
      });

      // obterUrlAssinadaSupabase aborta
      await expect(
        obterUrlAssinadaSupabase(validKey, 300)
      ).rejects.toMatchObject({
        code: 'INSECURE_CONFIGURATION',
      });

      // downloadFromSupabaseStorage aborta
      await expect(
        downloadFromSupabaseStorage(validKey)
      ).rejects.toMatchObject({
        code: 'INSECURE_CONFIGURATION',
      });

      // Limpeza da variável pública restaura a operação segura
      delete process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;
      resetSupabaseClientCache();
      expect(() => getSupabaseClient()).not.toThrow();
    });

    // ------------------------------------------------------------------------
    // TESTE 7: Proteção Contra Sobrescrita (upsert: false) e Idempotência
    // ------------------------------------------------------------------------
    it('7. Garante proteção contra sobrescrita com upsert: false e integridade SHA-256 no reenvio', async () => {
      const pdfBytesOriginal = Buffer.from('%PDF-1.4\nVersao Original Imutavel\n%%EOF\n');
      const hashOriginal = crypto.createHash('sha256').update(pdfBytesOriginal).digest('hex');
      const canonicalKey = buildDeterministicAcervoStoragePath(hashOriginal);

      // A. Upload direto pelo helper usa upsert: false
      simulatedBucket.objects.clear();
      await uploadToSupabaseStorage(canonicalKey, pdfBytesOriginal, 'application/pdf');

      expect(simulatedBucket.lastUploadOptions?.upsert).toBe(false);
      expect(simulatedBucket.objects.get(canonicalKey)?.upsertUsed).toBe(false);

      // B. Tentativa de upload idêntico quando o objeto já existe lança OBJECT_EXISTS
      await expect(
        uploadToSupabaseStorage(canonicalKey, pdfBytesOriginal, 'application/pdf')
      ).rejects.toMatchObject({
        code: 'OBJECT_EXISTS',
      });

      // C. Em enviarArquivo: se objeto pré-existente no Storage divergir em tamanho/hash,
      //    rejeita sem tocar no objeto e sem sobrescrever!
      const pdfCorrompido = Buffer.from('%PDF-1.4\nVersao Corrompida Divergente\n%%EOF\n');
      // Coloca no storage simulado um arquivo adulterado com o mesmo path
      simulatedBucket.objects.set(canonicalKey, {
        body: pdfCorrompido,
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      authState.currentProfile = RESPONSAVEL_1;
      const resDivergente = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Material com Hash Adulterado no Storage',
        'livro',
        1,
        'enem',
        'documento.pdf',
        pdfBytesOriginal.toString('base64')
      );

      expect(resDivergente).toEqual({
        ok: false,
        code: 'CONFLICT',
        message: expect.stringContaining('falha de integridade SHA-256'),
      });

      // D. Restaura o objeto idêntico no Storage -> reenvio adota o objeto com integridade confirmada
      simulatedBucket.objects.set(canonicalKey, {
        body: pdfBytesOriginal,
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      const resAdotado = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Material com Objeto Adotado com Sucesso',
        'livro',
        1,
        'enem',
        'documento.pdf',
        pdfBytesOriginal.toString('base64')
      );

      expect(resAdotado).toMatchObject({
        ok: true,
        data: {
          uploadStatus: 'concluido',
          reconciliacao: 'objeto_existente_adotado',
        },
      });

      // O objeto no Storage não foi sobrescrito (upsertUsed continua false)
      expect(simulatedBucket.objects.get(canonicalKey)?.upsertUsed).toBe(false);
    });

    // ------------------------------------------------------------------------
    // TESTE 8: Auditoria Conceitual e Empírica da Fronteira de Confiança
    // ------------------------------------------------------------------------
    it('8. Demonstra que a API de Storage usa SUPABASE_SERVICE_ROLE_KEY (bypass RLS) e que a barreira real está no Next.js', async () => {
      // 1. Comprova que o cliente Supabase é inicializado com SUPABASE_SERVICE_ROLE_KEY
      resetSupabaseClientCache();
      const client = getSupabaseClient();
      expect(client).toBeDefined();
      expect(simulatedBucket.lastClientKey).toBe('service-role-super-privileged-test-key');

      // 2. Comprova que o bucket acervo é estritamente privado no banco
      const bucketQuery = await pg.query<{ id: string; public: boolean }>(
        `SELECT id, public FROM storage.buckets WHERE id = '${ACERVO_BUCKET_NAME}'`
      );
      expect(bucketQuery.rows[0]).toEqual({
        id: 'acervo',
        public: false,
      });

      // 3. Comprova que a trava física CHECK impede tornar o bucket público
      await expect(
        pg.exec(`UPDATE storage.buckets SET public = true WHERE id = '${ACERVO_BUCKET_NAME}'`)
      ).rejects.toThrow(/storage_buckets_acervo_private_check/);

      // 4. Comprova que o servidor Next.js rejeita qualquer URL que contenha /object/public/
      simulatedBucket.returnPublicSignedUrl = true;
      const validKey = `acervo/${'d'.repeat(64)}.pdf`;
      simulatedBucket.objects.set(validKey, {
        body: Buffer.from('%PDF-1.4\nTeste Public Url\n%%EOF\n'),
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      await expect(obterUrlAssinadaSupabase(validKey, 300)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        message: expect.stringContaining('insegura'),
      });
    });
  }
);
