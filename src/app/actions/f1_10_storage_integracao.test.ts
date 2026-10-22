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
  nome: 'Responsavel Ficticio 1 F1.04',
  email: 'responsavel1.f104@example.invalid',
  papel: 'responsavel' as const,
};

const RESPONSAVEL_2 = {
  id: '20000000-0000-4000-8000-000000000002',
  authUserId: 'b0000000-0000-4000-8000-000000000002',
  nome: 'Responsavel Ficticio 2 F1.04',
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
  createClient: vi.fn(() => ({
    storage: {
      from: (bucketName: string) => ({
        upload: async (
          key: string,
          body: Buffer,
          options?: { contentType?: string; upsert?: boolean }
        ) => {
          simulatedBucket.uploadCalls++;
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
  })),
}));

vi.mock('../../lib/authorization', () => ({
  requireAuthenticatedProfile: vi.fn(async () => {
    if (!authState.currentProfile) {
      const err = new Error('Autenticação necessária.') as Error & { code: string };
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    return authState.currentProfile;
  }),
  requireRole: vi.fn(async (expectedRole: 'estudante' | 'responsavel') => {
    if (!authState.currentProfile) {
      const err = new Error('Autenticação necessária.') as Error & { code: string };
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    if (authState.currentProfile.papel !== expectedRole) {
      const err = new Error('Acesso não autorizado.') as Error & { code: string };
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
  resetSupabaseClientCache,
  obterUrlAssinadaSupabase,
  uploadToSupabaseStorage,
} from '../../lib/supabaseStorage';
import { reconciliarSnapshotsAcervo } from '../../lib/acervoReconciliacao';
import {
  diagnosticarReconciliacaoAcervo,
  enviarArquivo,
  obterUrlLeituraArquivoAcervo,
} from './acervo';

describe.skipIf(!HAS_PGLITE)('F1.10 — Upload, Storage Privado e Reconciliação (PGlite + Storage Simulado)', () => {
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
  const f110StorageRollbackSql = readSql('docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql');
  const f111QueueProposalSql = readSql('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql');

  beforeAll(async () => {
    process.env.SUPABASE_URL = 'https://storage.example.invalid';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-synthetic-test-key';
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
    await pg.exec(f109ProposalSql);
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
  });

  it('valida a proposta SQL F1.10 de bucket privado, RLS de storage.objects e rollback reversível', async () => {
    // 1. Verifica que o bucket acervo está configurado como privado e com limite de 20 MiB
    const bucketRes = await pg.query<{
      id: string;
      public: boolean;
      file_size_limit: string;
      allowed_mime_types: string[];
    }>(`SELECT id, public, file_size_limit::text, allowed_mime_types FROM storage.buckets WHERE id = 'acervo'`);
    expect(bucketRes.rows[0]).toEqual({
      id: 'acervo',
      public: false,
      file_size_limit: '20971520',
      allowed_mime_types: ['application/pdf'],
    });

    // 2. Impede tornar o bucket acervo público via constraint
    await expect(
      pg.exec(`UPDATE storage.buckets SET public = true WHERE id = 'acervo'`)
    ).rejects.toThrow(/storage_buckets_acervo_private_check/);

    // 3. Executa rollback e reaplica a proposta mantendo o bucket privado
    await pg.exec(f110StorageRollbackSql);
    const bucketAfterRollback = await pg.query<{ public: boolean }>(
      `SELECT public FROM storage.buckets WHERE id = 'acervo'`
    );
    expect(bucketAfterRollback.rows[0]?.public).toBe(false);

    await pg.exec(f110StorageProposalSql);
  });

  it('cobre falha de upload, falha de INSERT, reconciliação por reenvio (objeto existente) e bloqueio de duplicata', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4\nDocumento de Citologia F1.10 completo\n%%EOF\n');
    const pdfBase64 = pdfBytes.toString('base64');
    const expectedHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');
    const expectedKey = `acervo/${expectedHash}.pdf`;

    // A. Falha de upload antes da persistência -> nenhum objeto salvo e nenhuma linha no banco
    simulatedBucket.failNextUpload = true;
    const resUploadFailed = await enviarArquivo(
      DISCIPLINA_BIOLOGIA,
      'Apostila Citologia F1.10',
      'apostila',
      1,
      'enem',
      'citologia.pdf',
      pdfBase64
    );
    expect(resUploadFailed).toMatchObject({
      ok: false,
      code: 'EXTERNAL_SERVICE_ERROR',
    });
    expect(simulatedBucket.objects.has(expectedKey)).toBe(false);

    // B. Upload conclui no Storage com upsert: false, mas INSERT no banco falha -> sem falso sucesso e objeto preservado
    authState.failNextInsert = true;
    const resInsertFailed = await enviarArquivo(
      DISCIPLINA_BIOLOGIA,
      'Apostila Citologia F1.10',
      'apostila',
      1,
      'enem',
      'citologia.pdf',
      pdfBase64
    );
    expect(resInsertFailed).toMatchObject({
      ok: false,
      code: 'PERSISTENCE_ERROR',
    });
    expect(simulatedBucket.objects.has(expectedKey)).toBe(true);
    expect(simulatedBucket.objects.get(expectedKey)?.upsertUsed).toBe(false);
    expect(simulatedBucket.removeCalls).toBe(0);

    // C. Diagnóstico de reconciliação detecta o objeto sem metadados como recuperável no reenvio
    const diagBeforeRetry = await diagnosticarReconciliacaoAcervo([
      {
        path: expectedKey,
        tamanhoBytes: pdfBytes.length,
        mime: 'application/pdf',
      },
    ]);
    expect(diagBeforeRetry).toMatchObject({
      ok: true,
      data: {
        somenteLeitura: true,
        exclusaoAutomaticaExecutada: false,
        classificacoes: {
          objeto_sem_metadados: [
            expect.objectContaining({
              subtipo: 'storage_orfao_recuperavel_por_hash',
              pathsStorage: [expectedKey],
              recuperavelNoReenvio: true,
            }),
          ],
        },
      },
    });

    // D. Reenvio do mesmo arquivo encontra objeto já existente no Storage (409 Duplicate com upsert: false),
    //    adota o objeto existente sem apagá-lo nem sobrescrevê-lo e conclui o INSERT no banco!
    const resRecovered = await enviarArquivo(
      DISCIPLINA_BIOLOGIA,
      'Apostila Citologia F1.10',
      'apostila',
      1,
      'enem',
      'outro_nome_mesmo_conteudo.pdf',
      pdfBase64
    );
    expect(resRecovered).toMatchObject({
      ok: true,
      data: {
        uploadStatus: 'concluido',
        processamentoStatus: 'aguardando',
        reconciliacao: 'objeto_existente_adotado',
      },
    });
    expect(simulatedBucket.removeCalls).toBe(0);

    // E. Requisição enviada uma segunda vez após persistência completa -> rejeitada com CONFLICT sem tocar o Storage
    const uploadsBeforeDuplicate = simulatedBucket.uploadCalls;
    const resDuplicate = await enviarArquivo(
      DISCIPLINA_BIOLOGIA,
      'Apostila Citologia F1.10',
      'apostila',
      1,
      'enem',
      'citologia.pdf',
      pdfBase64
    );
    expect(resDuplicate).toEqual({
      ok: false,
      code: 'CONFLICT',
      message: 'Este arquivo já foi enviado anteriormente.',
    });
    expect(simulatedBucket.uploadCalls).toBe(uploadsBeforeDuplicate);
  });

  it('protege geração de URLs assinadas por papel/ownership e rejeita URLs públicas permanentes', async () => {
    // Registra no bucket simulado o arquivo da fixture do Responsável 1
    const fixturePathR1 = 'f1_04/apostila-r1.pdf';
    const pdfBytes = Buffer.from('%PDF-1.4\nConteudo privado R1\n%%EOF\n');
    const hashR1 = crypto.createHash('sha256').update(pdfBytes).digest('hex');
    const canonicalPathR1 = `acervo/${hashR1}.pdf`;
    simulatedBucket.objects.set(canonicalPathR1, {
      body: pdfBytes,
      contentType: 'application/pdf',
      upsertUsed: false,
    });

    // Atualiza fixture 60000000-0000-4000-8000-000000000001 para usar caminho sob acervo/
    await pg.exec(`
      UPDATE public.acervo_arquivos
      SET file_path = '${canonicalPathR1}'
      WHERE id = '60000000-0000-4000-8000-000000000001'
    `);

    // 1. Usuário não autenticado -> bloqueado
    authState.currentProfile = null;
    await expect(
      obterUrlLeituraArquivoAcervo('60000000-0000-4000-8000-000000000001')
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // 2. Estudante -> bloqueada
    authState.currentProfile = ESTUDANTE_1;
    await expect(
      obterUrlLeituraArquivoAcervo('60000000-0000-4000-8000-000000000001')
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // 3. Outro responsável (Responsável 2 tentando ler arquivo do Responsável 1) -> NOT_FOUND sem chamar Storage
    authState.currentProfile = RESPONSAVEL_2;
    const callsBeforeCrossOwner = simulatedBucket.signedUrlCalls;
    const crossOwnerRes = await obterUrlLeituraArquivoAcervo('60000000-0000-4000-8000-000000000001');
    expect(crossOwnerRes).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Arquivo não encontrado ou acesso não autorizado.',
    });
    expect(simulatedBucket.signedUrlCalls).toBe(callsBeforeCrossOwner);

    // 4. Responsável 1 (proprietário) -> obtém URL assinada temporária de curta duração
    authState.currentProfile = RESPONSAVEL_1;
    const validSignedRes = await obterUrlLeituraArquivoAcervo('60000000-0000-4000-8000-000000000001', 300);
    expect(validSignedRes).toMatchObject({
      ok: true,
      data: {
        arquivoId: '60000000-0000-4000-8000-000000000001',
        expiraEmSegundos: 300,
        signedUrl: expect.stringContaining('/object/sign/acervo/'),
      },
    });

    // 5. Rejeita se o Storage retornar URL pública permanente (/object/public/)
    simulatedBucket.returnPublicSignedUrl = true;
    const publicUrlRejected = await obterUrlLeituraArquivoAcervo('60000000-0000-4000-8000-000000000001', 300);
    expect(publicUrlRejected).toMatchObject({
      ok: false,
      code: 'EXTERNAL_SERVICE_ERROR',
    });

    // 6. Bloqueia exposição de chave privilegiada em NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY
    process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'leaked-service-role';
    await expect(
      uploadToSupabaseStorage(canonicalPathR1, pdfBytes, 'application/pdf')
    ).rejects.toMatchObject({
      code: 'INSECURE_CONFIGURATION',
    });
    await expect(obterUrlAssinadaSupabase(canonicalPathR1, 300)).rejects.toMatchObject({
      code: 'INSECURE_CONFIGURATION',
    });
    delete process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;

    // Restaura fixture path
    await pg.exec(`
      UPDATE public.acervo_arquivos
      SET file_path = '${fixturePathR1}'
      WHERE id = '60000000-0000-4000-8000-000000000001'
    `);
  });

  it('classifica metadados sem objeto, objetos sem metadados, uploads incompletos e duplicações sem apagar nada', () => {
    const hash1 = '1'.repeat(64);
    const hash2 = '2'.repeat(64);
    const hash3 = '3'.repeat(64);
    const hash4 = '4'.repeat(64);

    const relatorio = reconciliarSnapshotsAcervo(
      [
        // 1. Metadados sem objeto no Storage
        {
          id: 'aaaa0000-0000-4000-8000-000000000001',
          filePath: `acervo/${hash1}.pdf`,
          hashConteudo: hash1,
          tamanhoBytes: 4096,
          mime: 'application/pdf',
          statusProcessamento: 'aguardando',
          enviadoPor: RESPONSAVEL_1.id,
        },
        // 2. Upload com tamanho divergente
        {
          id: 'aaaa0000-0000-4000-8000-000000000002',
          filePath: `acervo/${hash2}.pdf`,
          hashConteudo: hash2,
          tamanhoBytes: 8192,
          mime: 'application/pdf',
          statusProcessamento: 'concluido',
          enviadoPor: RESPONSAVEL_1.id,
        },
        // 3. Duplicados no banco (mesmo hash4)
        {
          id: 'aaaa0000-0000-4000-8000-000000000004',
          filePath: `acervo/${hash4}_a.pdf`,
          hashConteudo: hash4,
          tamanhoBytes: 2048,
          mime: 'application/pdf',
          statusProcessamento: 'concluido',
          enviadoPor: RESPONSAVEL_1.id,
        },
        {
          id: 'aaaa0000-0000-4000-8000-000000000005',
          filePath: `acervo/${hash4}_b.pdf`,
          hashConteudo: hash4,
          tamanhoBytes: 2048,
          mime: 'application/pdf',
          statusProcessamento: 'concluido',
          enviadoPor: RESPONSAVEL_1.id,
        },
      ],
      [
        // Objeto com tamanho truncado/divergente para hash2 (100 bytes != 8192 bytes)
        {
          path: `acervo/${hash2}.pdf`,
          tamanhoBytes: 100,
          mime: 'application/pdf',
        },
        // Objeto órfão sem metadados no banco (hash3)
        {
          path: `acervo/${hash3}.pdf`,
          tamanhoBytes: 5120,
          mime: 'application/pdf',
        },
        // Dois objetos no Storage para o mesmo hash4
        {
          path: `acervo/${hash4}_a.pdf`,
          tamanhoBytes: 2048,
          mime: 'application/pdf',
        },
        {
          path: `acervo/${hash4}_b.pdf`,
          tamanhoBytes: 2048,
          mime: 'application/pdf',
        },
      ]
    );

    expect(relatorio.somenteLeitura).toBe(true);
    expect(relatorio.exclusaoAutomaticaExecutada).toBe(false);
    expect(relatorio.totais.metadadosSemObjeto).toBe(1);
    expect(relatorio.totais.objetoSemMetadados).toBe(1);
    expect(relatorio.totais.uploadIncompletoOuFalho).toBe(1);
    expect(relatorio.totais.duplicados).toBe(2); // hash_duplicado_db + multiplos_objetos_mesmo_hash_storage
  });
});
