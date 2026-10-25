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
  DEFAULT_SIGNED_URL_SECONDS,
  MAX_SIGNED_URL_SECONDS,
  MIN_SIGNED_URL_SECONDS,
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
  obterAcervoStatus,
  obterStatusJobAcervo,
  obterUrlLeituraArquivoAcervo,
  retomarProcessamentoArquivoAcervo,
} from './acervo';
import { enviarArquivoInputSchema } from '../../lib/validation';

describe.skipIf(!HAS_PGLITE)(
  'H1.07-R — Suíte de Segurança do Backend Next.js e Isolamento de Storage',
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

    // ========================================================================
    // CENÁRIO 1: Estudante tentando enviar PDF via Server Action
    // Rejeição imediata (FORBIDDEN), Storage não tocado
    // ========================================================================
    it('Cenário 1: Estudante tentando enviar PDF via Server Action -> Rejeição imediata (FORBIDDEN), Storage não tocado', async () => {
      authState.currentProfile = ESTUDANTE_1;

      const pdfBytes = Buffer.from('%PDF-1.4\nConteúdo não autorizado do estudante\n%%EOF\n');
      const pdfBase64 = pdfBytes.toString('base64');
      const initialUploads = simulatedBucket.uploadCalls;

      // 1. Tentativa via enviarArquivo (JSON / base64)
      await expect(
        enviarArquivo(
          DISCIPLINA_BIOLOGIA,
          'Tentativa Estudante JSON',
          'apostila',
          1,
          'enem',
          'estudante_ataque.pdf',
          pdfBase64
        )
      ).rejects.toMatchObject({
        name: 'AuthorizationError',
        code: 'FORBIDDEN',
      });

      // 2. Tentativa via enviarArquivoFormData (multipart/form-data binário)
      const fakeFormData = {
        get: (field: string) => {
          if (field === 'disciplinaId') return DISCIPLINA_BIOLOGIA;
          if (field === 'titulo') return 'Tentativa Estudante FormData';
          if (field === 'tipoMaterial') return 'apostila';
          if (field === 'serieAlvo') return '1';
          if (field === 'vestibular') return 'enem';
          if (field === 'file') {
            return {
              name: 'estudante_form.pdf',
              arrayBuffer: async () => pdfBytes.buffer,
            };
          }
          return null;
        },
      } as unknown as FormData;

      Object.setPrototypeOf(fakeFormData, FormData.prototype);

      await expect(enviarArquivoFormData(fakeFormData)).rejects.toMatchObject({
        name: 'AuthorizationError',
        code: 'FORBIDDEN',
      });

      // 3. Comprova que Storage não foi tocado e nenhum arquivo foi persistido
      expect(simulatedBucket.uploadCalls).toBe(initialUploads);
      expect(simulatedBucket.objects.size).toBe(0);

      // 4. Comprova que banco de dados não registrou nenhum arquivo para o estudante
      const filesDb = await pg.query<{ id: string }>(
        `SELECT id FROM public.acervo_arquivos WHERE enviado_por = $1`,
        [ESTUDANTE_1.id]
      );
      expect(filesDb.rows).toHaveLength(0);
    });

    // ========================================================================
    // CENÁRIO 2: Responsável tentando acessar/gerar URL assinada de PDF pertencente
    // a outro responsável (Cross-Tenant) -> Rejeição imediata (NOT_FOUND), Storage não tocado
    // ========================================================================
    it('Cenário 2: Responsável tentando acessar/gerar URL assinada de PDF pertencente a outro responsável (Cross-Tenant) -> Rejeição imediata (NOT_FOUND), Storage não tocado', async () => {
      // 1. Responsável 1 (proprietário legítimo) envia seu material privado
      authState.currentProfile = RESPONSAVEL_1;
      const pdfBytesA = Buffer.from('%PDF-1.4\nArquivo Confidencial Responsável 1\n%%EOF\n');
      const hashA = crypto.createHash('sha256').update(pdfBytesA).digest('hex');
      const filePathA = buildDeterministicAcervoStoragePath(hashA);

      simulatedBucket.objects.set(filePathA, {
        body: pdfBytesA,
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      const resUploadA = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Material Privado Responsável 1',
        'livro',
        2,
        'unicamp',
        'privado_r1.pdf',
        pdfBytesA.toString('base64')
      );
      expect(resUploadA.ok).toBe(true);
      const arquivoAId = (resUploadA as { data: { arquivoId: string } }).data.arquivoId;

      // 2. Responsável 2 (outro tenant autenticado) tenta obter URL assinada do PDF de Responsável 1
      authState.currentProfile = RESPONSAVEL_2;
      const signedCallsBefore = simulatedBucket.signedUrlCalls;

      const resSignedCross = await obterUrlLeituraArquivoAcervo(arquivoAId, 300);
      expect(resSignedCross).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'Arquivo não encontrado ou acesso não autorizado.',
      });

      // Storage API NUNCA foi tocada
      expect(simulatedBucket.signedUrlCalls).toBe(signedCallsBefore);

      // 3. Responsável 2 tenta consultar o job do arquivo de Responsável 1
      const resJobCross = await obterStatusJobAcervo(arquivoAId);
      expect(resJobCross).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'Job ou arquivo não encontrado ou acesso não autorizado.',
      });

      // 4. Responsável 2 tenta retomar processamento do arquivo de Responsável 1
      const resResumeCross = await retomarProcessamentoArquivoAcervo(arquivoAId);
      expect(resResumeCross).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'Arquivo não encontrado ou acesso não autorizado.',
      });

      // 5. Responsável 2 tenta obter status completo via obterAcervoStatus
      const resStatusCross = await obterAcervoStatus(arquivoAId);
      expect(resStatusCross).toBeNull();

      // 6. Responsável 1 (proprietário legítimo) obtém sua URL assinada normalmente
      authState.currentProfile = RESPONSAVEL_1;
      const resSignedOwner = await obterUrlLeituraArquivoAcervo(arquivoAId, 300);
      expect(resSignedOwner).toMatchObject({
        ok: true,
        data: {
          arquivoId: arquivoAId,
          expiraEmSegundos: 300,
          signedUrl: expect.stringContaining('/object/sign/acervo/'),
        },
      });
      expect(simulatedBucket.signedUrlCalls).toBe(signedCallsBefore + 1);
    });

    // ========================================================================
    // CENÁRIO 3: Tentativa de Path Traversal (.., //, \, caminhos absolutos, escapes)
    // Rejeição pelo validador TypeScript e pela função medicina.is_valid_acervo_storage_path
    // ========================================================================
    it('Cenário 3: Tentativa de Path Traversal (.., //, \\, caminhos absolutos, caracteres de escape) -> Rejeição pelo validador TypeScript e pela função medicina.is_valid_acervo_storage_path', async () => {
      const maliciousTraversalPaths = [
        'acervo/../etc/passwd',
        'acervo/..\\windows\\win.ini',
        'acervo//dupla_barra.pdf',
        'acervo\\barra_invertida.pdf',
        'acervo/arquivo\x00nulo.pdf',
        '../fora_do_escopo.pdf',
        'acervo/subpasta/../../escape.pdf',
        'acervo/folder/../../../etc/shadow.pdf',
        '',
        '   ',
      ];

      // 1. Validador TypeScript (normalizeAcervoStorageKey)
      for (const malPath of maliciousTraversalPaths) {
        expect(
          () => normalizeAcervoStorageKey(malPath),
          `normalizeAcervoStorageKey deveria ter rejeitado: "${malPath}"`
        ).toThrow(/inválido/i);
      }

      // Normalização correta de espaços e barras externas para paths seguros
      const validHash = 'c'.repeat(64);
      expect(normalizeAcervoStorageKey(`  /acervo/${validHash}.pdf/  `)).toBe(`acervo/${validHash}.pdf`);

      // 2. Validador SQL imutável (medicina.is_valid_acervo_storage_path)
      const testCasesSql = [
        { path: 'acervo/../etc/passwd', expected: false },
        { path: 'acervo/..\\windows\\win.ini', expected: false },
        { path: 'acervo//dupla_barra.pdf', expected: false },
        { path: 'acervo\\barra_invertida.pdf', expected: false },
        { path: '../fora_do_escopo.pdf', expected: false },
        { path: '/acervo/absoluto_raiz.pdf', expected: false }, // Caminho absoluto rejeitado pelo SQL
        { path: '/etc/passwd', expected: false },
        { path: `outro_bucket/${validHash}.pdf`, expected: false },
        { path: `acervo/${validHash}.exe`, expected: false },
        { path: `acervo/${validHash.slice(0, 63)}.pdf`, expected: false }, // 63 chars (inválido)
        { path: `acervo/${'h'.repeat(64)}.pdf`, expected: false }, // hex inválido
        { path: `acervo/${validHash}.pdf`, expected: true }, // hash canônico puro
        { path: `acervo/${validHash}_anexo-1.pdf`, expected: true }, // sufixo sanitizado
      ];

      for (const tc of testCasesSql) {
        const queryRes = await pg.query<{ is_valid: boolean }>(
          `SELECT medicina.is_valid_acervo_storage_path($1) AS is_valid`,
          [tc.path]
        );
        expect(
          queryRes.rows[0]?.is_valid,
          `medicina.is_valid_acervo_storage_path falhou para "${tc.path}"`
        ).toBe(tc.expected);
      }

      // Rejeição compulsoria de byte nulo (\x00) no driver/protocolo do PostgreSQL
      await expect(
        pg.query(`SELECT medicina.is_valid_acervo_storage_path($1) AS is_valid`, ['acervo/arquivo\x00nulo.pdf'])
      ).rejects.toThrow(/invalid byte sequence for encoding "UTF8": 0x00/i);

      // 3. Client Storage rejeita em uploadToSupabaseStorage e obterUrlAssinadaSupabase
      const dummyBuffer = Buffer.from('%PDF-1.4\nTeste Traversal\n%%EOF\n');
      await expect(
        uploadToSupabaseStorage('acervo/../malicious.pdf', dummyBuffer, 'application/pdf')
      ).rejects.toMatchObject({
        code: 'INVALID_KEY',
      });

      await expect(
        uploadToSupabaseStorage('/etc/passwd', dummyBuffer, 'application/pdf')
      ).rejects.toMatchObject({
        code: 'INVALID_KEY',
      });

      await expect(
        obterUrlAssinadaSupabase('acervo/../malicious.pdf', 300)
      ).rejects.toMatchObject({
        code: 'INVALID_KEY',
      });

      await expect(
        obterUrlAssinadaSupabase('/etc/passwd', 300)
      ).rejects.toMatchObject({
        code: 'INVALID_KEY',
      });
    });

    // ========================================================================
    // CENÁRIO 4: Alteração de IDs enviados pelo cliente (spoofing de perfilId/enviadoPor)
    // Servidor descarta parâmetros e resolve identidade estritamente da sessão assinada NextAuth
    // ========================================================================
    it('Cenário 4: Alteração de IDs enviados pelo cliente (spoofing de perfilId/enviadoPor) -> Servidor descarta parâmetros e resolve identidade estritamente da sessão assinada NextAuth', async () => {
      authState.currentProfile = RESPONSAVEL_1;

      // 1. Tentativa de spoofing via payload JSON no schema enviarArquivoInputSchema
      const fakePayloadComSpoofing = {
        disciplinaId: DISCIPLINA_BIOLOGIA,
        titulo: 'Apostila com Spoofing de Identidade',
        tipoMaterial: 'apostila',
        serieAlvo: 1,
        vestibular: 'enem',
        upload: {
          nomeArquivo: 'spoof.pdf',
          base64Data: Buffer.from('%PDF-1.4\nTeste Spoofing\n%%EOF\n').toString('base64'),
        },
        perfilId: RESPONSAVEL_2.id, // Tentativa de forjar identidade do tenant 2
        enviadoPor: RESPONSAVEL_2.id,
      };

      const validacaoComSpoofing = enviarArquivoInputSchema.safeParse(fakePayloadComSpoofing);
      expect(validacaoComSpoofing.ok).toBe(false);
      if (!validacaoComSpoofing.ok) {
        expect(validacaoComSpoofing.message).toContain('Identificador de autorização não pode ser enviado pelo cliente');
      }

      // 2. Tentativa de spoofing via campos espúrios em multipart/form-data nativo
      const pdfBytesSpoof = Buffer.from('%PDF-1.4\nBinario FormData com Spoofing\n%%EOF\n');
      const hashSpoof = crypto.createHash('sha256').update(pdfBytesSpoof).digest('hex');
      const filePathSpoof = buildDeterministicAcervoStoragePath(hashSpoof);

      simulatedBucket.objects.set(filePathSpoof, {
        body: pdfBytesSpoof,
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      const formDataSpoof = new FormData();
      formDataSpoof.append('disciplinaId', DISCIPLINA_BIOLOGIA);
      formDataSpoof.append('titulo', 'Upload com Campos Injetados');
      formDataSpoof.append('tipoMaterial', 'apostila');
      formDataSpoof.append('serieAlvo', '2');
      formDataSpoof.append('vestibular', 'fuvest');
      formDataSpoof.append(
        'file',
        new File([pdfBytesSpoof], 'spoof_form.pdf', { type: 'application/pdf' })
      );
      // Campos maliciosos injetados pelo cliente mal-intencionado
      formDataSpoof.append('perfilId', RESPONSAVEL_2.id);
      formDataSpoof.append('enviadoPor', RESPONSAVEL_2.id);
      formDataSpoof.append('authUserId', RESPONSAVEL_2.authUserId);

      const resUploadFormData = await enviarArquivoFormData(formDataSpoof);
      expect(resUploadFormData.ok).toBe(true);
      const novoArquivoId = (resUploadFormData as { data: { arquivoId: string } }).data.arquivoId;

      // 3. Comprova no banco que a identidade gravada foi 100% RESPONSAVEL_1 (da sessão NextAuth)
      const [arquivoPersistido] = (
        await pg.query<{ id: string; enviado_por: string }>(
          `SELECT id, enviado_por FROM public.acervo_arquivos WHERE id = $1`,
          [novoArquivoId]
        )
      ).rows;

      expect(arquivoPersistido).toBeDefined();
      expect(arquivoPersistido?.enviado_por).toBe(RESPONSAVEL_1.id);
      expect(arquivoPersistido?.enviado_por).not.toBe(RESPONSAVEL_2.id);

      // 4. Tentativa de invocar Server Action sem sessão NextAuth válida -> UNAUTHENTICATED
      authState.currentProfile = null;
      await expect(obterUrlLeituraArquivoAcervo(novoArquivoId, 300)).rejects.toMatchObject({
        name: 'AuthorizationError',
        code: 'UNAUTHENTICATED',
      });
    });

    // ========================================================================
    // CENÁRIO 5: Colisão de SHA-256 e cenário OBJECT_EXISTS no Storage
    // Validação de tamanho e hash do objeto pré-existente antes de adotar metadados,
    // sem jamais sobrescrever bytes em disco (upsert: false)
    // ========================================================================
    it('Cenário 5: Colisão de SHA-256 e cenário OBJECT_EXISTS no Storage -> Validação de tamanho e hash sem jamais sobrescrever bytes (upsert: false)', async () => {
      const pdfBytesOriginal = Buffer.from('%PDF-1.4\nDocumento Imutável Original H1.07-R\n%%EOF\n');
      const hashOriginal = crypto.createHash('sha256').update(pdfBytesOriginal).digest('hex');
      const canonicalKey = buildDeterministicAcervoStoragePath(hashOriginal);

      // 1. Upload direto via helper utiliza upsert: false compulsoriamente
      simulatedBucket.objects.clear();
      await uploadToSupabaseStorage(canonicalKey, pdfBytesOriginal, 'application/pdf');

      expect(simulatedBucket.lastUploadOptions?.upsert).toBe(false);
      expect(simulatedBucket.objects.get(canonicalKey)?.upsertUsed).toBe(false);

      // 2. Tentativa de reupload do mesmo objeto dispara OBJECT_EXISTS do Storage
      await expect(
        uploadToSupabaseStorage(canonicalKey, pdfBytesOriginal, 'application/pdf')
      ).rejects.toMatchObject({
        code: 'OBJECT_EXISTS',
      });

      // 3. Cenário de Divergência de Hash / Tamanho no Storage:
      // Se um objeto no Storage sob a mesma chave possuir bytes corrompidos/adulterados
      const pdfBytesCorrompidos = Buffer.from('%PDF-1.4\nBytes Adulterados Maliciosos\n%%EOF\n');
      simulatedBucket.objects.set(canonicalKey, {
        body: pdfBytesCorrompidos,
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      authState.currentProfile = RESPONSAVEL_1;
      const resDivergente = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Material com Objeto Corrompido no Storage',
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

      // Bytes corrompidos NÃO foram sobrescritos (upsertUsed continua false)
      expect(simulatedBucket.objects.get(canonicalKey)?.upsertUsed).toBe(false);
      expect(simulatedBucket.objects.get(canonicalKey)?.body.toString()).toBe(
        pdfBytesCorrompidos.toString()
      );

      // 4. Cenário de Integridade Verificada:
      // Restaura o objeto idêntico no Storage -> reenvio adota com reconciliação segura
      simulatedBucket.objects.set(canonicalKey, {
        body: pdfBytesOriginal,
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      const resAdotado = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Material com Objeto Reconciliado com Sucesso',
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

      // Nunca sobrescreveu disco
      expect(simulatedBucket.objects.get(canonicalKey)?.upsertUsed).toBe(false);
    });

    // ========================================================================
    // CENÁRIO 6: URLs assinadas e prazos de expiração
    // Aceita 60s, 300s, 900s; rejeita < 60s, > 900s, decimais e negativos
    // ========================================================================
    it('Cenário 6: URLs assinadas e prazos de expiração -> Aceita 60s, 300s, 900s; rejeita < 60s, > 900s, decimais e negativos', async () => {
      const validHash = '9'.repeat(64);
      const validKey = `acervo/${validHash}.pdf`;
      simulatedBucket.objects.set(validKey, {
        body: Buffer.from('%PDF-1.4\nTeste Prazos Expiração\n%%EOF\n'),
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      // 1. Camada de Storage (obterUrlAssinadaSupabase)
      // Limites válidos: MIN_SIGNED_URL_SECONDS (60), DEFAULT (300), MAX (900)
      await expect(obterUrlAssinadaSupabase(validKey, 60)).resolves.toContain('token=signed_60');
      await expect(obterUrlAssinadaSupabase(validKey, 300)).resolves.toContain('token=signed_300');
      await expect(obterUrlAssinadaSupabase(validKey, 900)).resolves.toContain('token=signed_900');

      // Rejeições na camada de Storage
      await expect(obterUrlAssinadaSupabase(validKey, 59)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
        message: expect.stringContaining('entre 60 e 900'),
      });
      await expect(obterUrlAssinadaSupabase(validKey, 0)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });
      await expect(obterUrlAssinadaSupabase(validKey, -60)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });
      await expect(obterUrlAssinadaSupabase(validKey, 901)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });
      await expect(obterUrlAssinadaSupabase(validKey, 3600)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });
      await expect(obterUrlAssinadaSupabase(validKey, 300.5)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });

      // 2. Camada Server Action (obterUrlLeituraArquivoAcervo)
      authState.currentProfile = RESPONSAVEL_1;
      const pdfBytesExp = Buffer.from('%PDF-1.4\nDocumento para Teste Expiracao Action\n%%EOF\n');
      const hashExp = crypto.createHash('sha256').update(pdfBytesExp).digest('hex');
      const keyExp = `acervo/${hashExp}.pdf`;
      simulatedBucket.objects.set(keyExp, {
        body: pdfBytesExp,
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      const resUploadExp = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Doc Expiracao Action',
        'slide',
        1,
        'enem',
        'exp_action.pdf',
        pdfBytesExp.toString('base64')
      );
      expect(resUploadExp.ok).toBe(true);
      const arquivoId = (resUploadExp as { data: { arquivoId: string } }).data.arquivoId;

      // Teste de rejeição na Action
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

      const resFloat = await obterUrlLeituraArquivoAcervo(arquivoId, 300.5);
      expect(resFloat).toMatchObject({
        ok: false,
        code: 'VALIDATION_ERROR',
      });

      const resNeg = await obterUrlLeituraArquivoAcervo(arquivoId, -300);
      expect(resNeg).toMatchObject({
        ok: false,
        code: 'VALIDATION_ERROR',
      });

      // Sucesso na Action com valor padrão e limites
      const resDefault = await obterUrlLeituraArquivoAcervo(arquivoId);
      expect(resDefault).toMatchObject({
        ok: true,
        data: { expiraEmSegundos: DEFAULT_SIGNED_URL_SECONDS },
      });

      const resMin = await obterUrlLeituraArquivoAcervo(arquivoId, MIN_SIGNED_URL_SECONDS);
      expect(resMin).toMatchObject({
        ok: true,
        data: { expiraEmSegundos: 60 },
      });

      const resMax = await obterUrlLeituraArquivoAcervo(arquivoId, MAX_SIGNED_URL_SECONDS);
      expect(resMax).toMatchObject({
        ok: true,
        data: { expiraEmSegundos: 900 },
      });
    });

    // ========================================================================
    // CENÁRIO 7: Ausência absoluta de exposição da SUPABASE_SERVICE_ROLE_KEY
    // Bloqueio imediato (INSECURE_CONFIGURATION) caso configurada em NEXT_PUBLIC_
    // ========================================================================
    it('Cenário 7: Ausência absoluta de exposição da SUPABASE_SERVICE_ROLE_KEY -> Bloqueio imediato (INSECURE_CONFIGURATION) caso configurada em NEXT_PUBLIC_', async () => {
      const validKey = `acervo/${'7'.repeat(64)}.pdf`;
      const dummyBody = Buffer.from('%PDF-1.4\nTeste Insecure Config\n%%EOF\n');

      // Simula vazamento acidental em variável pública Next.js
      process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'vazamento-acidental-de-chave-mestra-no-cliente';

      // 1. getSupabaseClient() aborta imediatamente
      expect(() => getSupabaseClient()).toThrowError(StorageOperationError);
      expect(() => getSupabaseClient()).toThrow(/NEXT_PUBLIC_/);

      // 2. uploadToSupabaseStorage aborta
      await expect(
        uploadToSupabaseStorage(validKey, dummyBody, 'application/pdf')
      ).rejects.toMatchObject({
        code: 'INSECURE_CONFIGURATION',
      });

      // 3. obterUrlAssinadaSupabase aborta
      await expect(
        obterUrlAssinadaSupabase(validKey, 300)
      ).rejects.toMatchObject({
        code: 'INSECURE_CONFIGURATION',
      });

      // 4. downloadFromSupabaseStorage aborta
      await expect(
        downloadFromSupabaseStorage(validKey)
      ).rejects.toMatchObject({
        code: 'INSECURE_CONFIGURATION',
      });

      // 5. Limpeza restaura operação segura
      delete process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;
      resetSupabaseClientCache();
      expect(() => getSupabaseClient()).not.toThrow();
    });

    // ========================================================================
    // CENÁRIO 8: Confirmação de que uploads via service_role com owner_id nulo
    // permanecem isolados porque a autorização é verificada em public.acervo_arquivos
    // ========================================================================
    it('Cenário 8: Confirmação de que uploads via service_role com owner_id nulo permanecem isolados porque a autorização é verificada em public.acervo_arquivos', async () => {
      // 1. Upload via service_role no Supabase Storage:
      // Em uploads pelo servidor via service_role, o Supabase Storage persiste owner_id = NULL
      const pdfBytesM8 = Buffer.from('%PDF-1.4\nPDF Modelo A Upload Service Role\n%%EOF\n');
      const hashM8 = crypto.createHash('sha256').update(pdfBytesM8).digest('hex');
      const filePathM8 = buildDeterministicAcervoStoragePath(hashM8);

      simulatedBucket.objects.set(filePathM8, {
        body: pdfBytesM8,
        contentType: 'application/pdf',
        upsertUsed: false,
      });

      // Insere simulação no catálogo storage.objects com owner IS NULL (como ocorre na service_role)
      await pg.exec(`
        INSERT INTO storage.objects (bucket_id, name, owner, metadata)
        VALUES ('acervo', '${filePathM8}', NULL, '{"size": ${pdfBytesM8.length}, "mimetype": "application/pdf"}'::jsonb)
        ON CONFLICT (bucket_id, name) DO NOTHING;
      `);

      // 2. Comprova que na tabela storage.objects o owner é estritamente NULL
      const storageRow = (
        await pg.query<{ name: string; owner: string | null }>(
          `SELECT name, owner FROM storage.objects WHERE bucket_id = 'acervo' AND name = $1`,
          [filePathM8]
        )
      ).rows[0];

      expect(storageRow).toBeDefined();
      expect(storageRow?.owner).toBeNull();

      // 3. Demonstração de falha do Modelo B:
      // Políticas baseadas em storage.objects.owner = auth.uid() retornariam 0 linhas
      // para qualquer usuário, pois owner é NULL
      const simulatedModelBQuery = await pg.query(
        `SELECT id FROM storage.objects WHERE bucket_id = 'acervo' AND owner = $1`,
        [RESPONSAVEL_1.id]
      );
      expect(simulatedModelBQuery.rows).toHaveLength(0);

      // 4. Demonstração do Modelo A (MEDICINA 2029):
      // A autorização e a relação de posse vivem em public.acervo_arquivos.enviado_por
      authState.currentProfile = RESPONSAVEL_1;
      const resUpload = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Material Isolado por acervo_arquivos',
        'livro',
        3,
        'enem',
        'modelo_a_isolado.pdf',
        pdfBytesM8.toString('base64')
      );
      expect(resUpload.ok).toBe(true);
      const arquivoId = (resUpload as { data: { arquivoId: string } }).data.arquivoId;

      // 5. Verifica que no PostgreSQL a relação de posse está formalmente gravada
      const dbRow = (
        await pg.query<{ id: string; enviado_por: string; file_path: string }>(
          `SELECT id, enviado_por, file_path FROM public.acervo_arquivos WHERE id = $1`,
          [arquivoId]
        )
      ).rows[0];

      expect(dbRow).toBeDefined();
      expect(dbRow?.enviado_por).toBe(RESPONSAVEL_1.id);
      expect(dbRow?.file_path).toBe(filePathM8);

      // 6. Autorização na prática:
      // A) Responsável 1 (proprietário registrado em public.acervo_arquivos) -> Autorizado a gerar URL assinada
      authState.currentProfile = RESPONSAVEL_1;
      const resUrlOwner = await obterUrlLeituraArquivoAcervo(arquivoId, 300);
      expect(resUrlOwner.ok).toBe(true);

      // B) Responsável 2 (outro tenant) -> Rejeitado com NOT_FOUND (sem tocar no Storage)
      authState.currentProfile = RESPONSAVEL_2;
      const resUrlOther = await obterUrlLeituraArquivoAcervo(arquivoId, 300);
      expect(resUrlOther).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'Arquivo não encontrado ou acesso não autorizado.',
      });

      // C) Estudante -> Bloqueado compulsoriamente pelo papel (FORBIDDEN)
      authState.currentProfile = ESTUDANTE_1;
      await expect(obterUrlLeituraArquivoAcervo(arquivoId, 300)).rejects.toMatchObject({
        name: 'AuthorizationError',
        code: 'FORBIDDEN',
      });
    });
  }
);
