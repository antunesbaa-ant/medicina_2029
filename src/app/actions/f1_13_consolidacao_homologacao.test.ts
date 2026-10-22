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

const ESTUDANTE_2 = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'a0000000-0000-4000-8000-000000000002',
  nome: 'Estudante Ficticia 2 F1.04',
  email: 'estudante2.f104@example.invalid',
  papel: 'estudante' as const,
};

const RESPONSAVEL_1 = {
  id: '20000000-0000-4000-8000-000000000001',
  authUserId: 'b0000000-0000-4000-8000-000000000001',
  nome: 'Responsavel Ficticio 1 F1.04',
  email: 'responsavel1.f104@example.invalid',
  papel: 'responsavel' as const,
};

const DISCIPLINA_BIOLOGIA = '30000000-0000-4000-8000-000000000001';
const TOPICO_CITOLOGIA = '31000000-0000-4000-8000-000000000001';

const simulatedBucket = vi.hoisted(() => ({
  objects: new Map<string, { body: Buffer; contentType: string }>(),
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
  /**
   * Quando definido como `'medicina_app'`, cada query executada pela aplicação via `proxyDb`
   * roda dentro de uma transação curta sob `SET LOCAL ROLE medicina_app` + `medicina.set_context`.
   * Quando definido como `'medicina_worker'`, cada query roda sob `SET ROLE medicina_worker`.
   */
  executionRole: 'postgres' as 'postgres' | 'medicina_app' | 'medicina_worker',
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
          if (bucketName !== 'acervo') {
            return { data: null, error: { message: 'Bucket inválido' } };
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
          });
          return { data: { path: key }, error: null };
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

vi.mock('../../lib/authorization', () => {
  class AuthorizationError extends Error {
    readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN';

    constructor(code: 'UNAUTHENTICATED' | 'FORBIDDEN') {
      super(code === 'UNAUTHENTICATED' ? 'Autenticação necessária.' : 'Acesso não autorizado.');
      this.name = 'AuthorizationError';
      this.code = code;
    }
  }

  return {
    AuthorizationError,
    requireAuthenticatedProfile: vi.fn(async () => {
      if (!authState.currentProfile) {
        throw new AuthorizationError('UNAUTHENTICATED');
      }
      return authState.currentProfile;
    }),
    requireRole: vi.fn(async (expectedRole: 'estudante' | 'responsavel') => {
      if (!authState.currentProfile) {
        throw new AuthorizationError('UNAUTHENTICATED');
      }
      if (authState.currentProfile.papel !== expectedRole) {
        throw new AuthorizationError('FORBIDDEN');
      }
      return authState.currentProfile;
    }),
    requireManagedStudentProfile: vi.fn(async () => ESTUDANTE_1),
    assertOwnership: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        const instance = authState.dbInstance as Record<PropertyKey, unknown> | null;
        if (!instance) {
          throw new Error('PGlite dbInstance não inicializado.');
        }
        const value = instance[prop];
        return typeof value === 'function' ? value.bind(instance) : value;
      },
    }
  ),
}));

import { resetSupabaseClientCache } from '../../lib/supabaseStorage';
import { buildDeterministicAcervoStoragePath } from '../../lib/acervoReconciliacao';
import { processarProximoJobAcervo } from '../../lib/acervoPipelineWorker';
import { enviarArquivo } from './acervo';
import { buscarNoAcervo } from './busca';

describe.skipIf(!HAS_PGLITE)(
  'F1.13 — Consolidação Técnica e Preparação para Homologação (Sequência SQL + RLS + Worker + IA)',
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

    const f104ProposalSql = readSql('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql');
    const f104RollbackSql = readSql('docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql');
    const f109ProposalSql = readSql(
      'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'
    );
    const f109RollbackSql = readSql(
      'docs/modernizacao/propostas/F1_09_ROLLBACK_INTEGRIDADE_E_IDEMPOTENCIA.sql'
    );
    const f110StorageProposalSql = readSql(
      'docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql'
    );
    const f110StorageRollbackSql = readSql(
      'docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql'
    );
    const f111QueueProposalSql = readSql(
      'docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql'
    );
    const f111QueueRollbackSql = readSql(
      'docs/modernizacao/propostas/F1_11_ROLLBACK_FILA_INGESTAO.sql'
    );
    const f112SearchProposalSql = readSql(
      'docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'
    );
    const f112SearchRollbackSql = readSql(
      'docs/modernizacao/propostas/F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql'
    );

    let txDepth = 0;

    beforeAll(async () => {
      process.env.SUPABASE_URL = 'https://storage.example.invalid';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-synthetic-test-key';
      process.env.GEMINI_API_KEY = 'gemini-synthetic-test-key';
      delete process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;
      resetSupabaseClientCache();

      const { PGlite, types } = await import(pathToFileURL(PGLITE_INDEX).href);
      const { vector } = await import(pathToFileURL(PGLITE_VECTOR).href);
      pg = await PGlite.create({ extensions: { vector } });

      // Ordem canônica de homologação: 0000..0003 -> Fixtures -> F1.04 -> F1.09 -> F1.10 -> F1.11 -> F1.12
      await pg.exec(sql0000);
      await pg.exec(sql0001);
      await pg.exec(sql0002);
      await pg.exec(sql0003);
      await pg.exec(fixturesSql);
      await pg.exec(f104ProposalSql);
      await pg.exec(f109ProposalSql);
      await pg.exec(f110StorageProposalSql);
      await pg.exec(f111QueueProposalSql);
      await pg.exec(f112SearchProposalSql);

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

      const rawQuery = (
        pg as unknown as {
          query: (
            sql: string,
            params?: unknown[],
            options?: { rowMode: 'array' | 'object'; parsers: Record<number, (v: unknown) => unknown> }
          ) => Promise<{ rows: unknown[] }>;
        }
      ).query.bind(pg);

      const proxyDb = drizzle(
        async (queryStr, params, method) => {
          const rowMode = method === 'all' ? 'array' : 'object';
          if (authState.executionRole === 'medicina_app' && txDepth === 0) {
            await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
            try {
              if (authState.currentProfile) {
                await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
                  authState.currentProfile.id,
                  authState.currentProfile.papel,
                ]);
              }
              const res = await rawQuery(queryStr, params, { rowMode, parsers });
              await pg.exec('COMMIT;');
              return { rows: res.rows };
            } catch (err) {
              await pg.exec('ROLLBACK;');
              throw err;
            }
          }

          if (authState.executionRole === 'medicina_worker' && txDepth === 0) {
            await pg.exec('SET ROLE medicina_worker;');
            try {
              const res = await rawQuery(queryStr, params, { rowMode, parsers });
              return { rows: res.rows };
            } finally {
              await pg.exec('RESET ROLE;');
            }
          }

          const res = await rawQuery(queryStr, params, { rowMode, parsers });
          return { rows: res.rows };
        },
        { schema }
      );

      (
        proxyDb as unknown as {
          transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
        }
      ).transaction = async (callback) => {
        const savepoint = `sp_f113_${++txDepth}`;
        if (txDepth === 1) {
          await pg.exec('BEGIN');
          if (authState.executionRole === 'medicina_app') {
            await pg.exec('SET LOCAL ROLE medicina_app;');
            if (authState.currentProfile) {
              await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
                authState.currentProfile.id,
                authState.currentProfile.papel,
              ]);
            }
          } else if (authState.executionRole === 'medicina_worker') {
            await pg.exec('SET LOCAL ROLE medicina_worker;');
          }
        } else {
          await pg.exec(`SAVEPOINT ${savepoint}`);
        }
        try {
          const result = await callback(proxyDb);
          await pg.exec(txDepth === 1 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
          txDepth--;
          return result;
        } catch (err) {
          await pg.exec(txDepth === 1 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`);
          txDepth--;
          throw err;
        }
      };

      authState.dbInstance = proxyDb;
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      if (pg) {
        await pg.close();
      }
    });

    beforeEach(async () => {
      authState.currentProfile = RESPONSAVEL_1;
      authState.executionRole = 'postgres';
      simulatedBucket.objects.clear();
      await pg.exec('RESET ROLE;');
      await pg.exec(`
        DELETE FROM public.acervo_jobs
         WHERE arquivo_id NOT IN (
           '60000000-0000-4000-8000-000000000001',
           '60000000-0000-4000-8000-000000000002'
         );
        DELETE FROM public.acervo_chunks
         WHERE arquivo_id NOT IN (
           '60000000-0000-4000-8000-000000000001',
           '60000000-0000-4000-8000-000000000002'
         );
        DELETE FROM public.acervo_paginas
         WHERE arquivo_id NOT IN (
           '60000000-0000-4000-8000-000000000001',
           '60000000-0000-4000-8000-000000000002'
         );
        DELETE FROM public.acervo_arquivos
         WHERE id NOT IN (
           '60000000-0000-4000-8000-000000000001',
           '60000000-0000-4000-8000-000000000002'
         );
      `);
    });

    const makeValidPdfBuffer = (tag: string) =>
      Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Title (${tag}) >>\nendobj\n%%EOF\n`);

    const vetorEixo = (eixo: number) =>
      Array.from({ length: 1536 }, (_, idx) => (idx === eixo ? 1 : 0));

    it('1. Valida sequência completa de migrations (F1.03-R a F1.12), RLS forçado em 100% das tabelas e privilégios mínimos dos papéis', async () => {
      // Nenhuma tabela em public deve estar sem RLS habilitado e forçado
      const tabelasSemRls = await pg.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'r'
            AND (c.relrowsecurity = false OR c.relforcerowsecurity = false)`
      );
      expect(tabelasSemRls.rows).toEqual([]);

      // Verifica que os 4 papéis possuem NOSUPERUSER e NOBYPASSRLS
      const roles = await pg.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolname, rolsuper, rolbypassrls
           FROM pg_roles
          WHERE rolname IN ('medicina_app', 'medicina_auth', 'medicina_worker', 'medicina_anon')
          ORDER BY rolname`
      );
      expect(roles.rows).toEqual([
        { rolname: 'medicina_anon', rolsuper: false, rolbypassrls: false },
        { rolname: 'medicina_app', rolsuper: false, rolbypassrls: false },
        { rolname: 'medicina_auth', rolsuper: false, rolbypassrls: false },
        { rolname: 'medicina_worker', rolsuper: false, rolbypassrls: false },
      ]);

      // Nenhuma função do schema medicina pode ter EXECUTE concedido a PUBLIC / medicina_anon
      const funcoesPublicas = await pg.query<{ proname: string }>(
        `SELECT p.proname
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'medicina'
            AND has_function_privilege('medicina_anon', p.oid, 'EXECUTE')`
      );
      expect(funcoesPublicas.rows).toEqual([]);
    });

    it('2. Verifica imediatamente a integridade SHA-256 do objeto após OBJECT_EXISTS antes de adotar no banco', async () => {
      authState.executionRole = 'medicina_app';
      authState.currentProfile = RESPONSAVEL_1;

      const pdfReal = makeValidPdfBuffer('F1.13 Documento Integro');
      const hashEsperado = crypto.createHash('sha256').update(pdfReal).digest('hex');
      const filePath = buildDeterministicAcervoStoragePath(hashEsperado);

      // Caso A: o objeto existente em `acervo/<sha256>.pdf` no Storage foi corrompido ou adulterado
      simulatedBucket.objects.set(filePath, {
        body: makeValidPdfBuffer('CONTEUDO CORROMPIDO DIFERENTE DO HASH DA CHAVE'),
        contentType: 'application/pdf',
      });

      const resCorrompido = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Apostila Corrompida no Storage',
        'apostila',
        1,
        'enem',
        'corrompida.pdf',
        pdfReal
      );

      expect(resCorrompido).toEqual({
        ok: false,
        code: 'CONFLICT',
        message:
          'O objeto existente no armazenamento diverge do conteúdo enviado (falha de integridade SHA-256). Nenhum cadastro foi realizado.',
      });

      const checkDbCorrompido = await pg.query(
        `SELECT id FROM public.acervo_arquivos WHERE hash_conteudo = $1`,
        [hashEsperado]
      );
      expect(checkDbCorrompido.rows).toHaveLength(0);

      // Caso B: o objeto existente em `acervo/<sha256>.pdf` possui conteúdo íntegro (SHA-256 e tamanho idênticos)
      simulatedBucket.objects.set(filePath, {
        body: pdfReal,
        contentType: 'application/pdf',
      });

      const resIntegro = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Apostila Íntegra Reconciliada',
        'apostila',
        1,
        'enem',
        'integra.pdf',
        pdfReal
      );

      expect(resIntegro).toMatchObject({
        ok: true,
        data: {
          uploadStatus: 'concluido',
          processamentoStatus: 'aguardando',
          reconciliacao: 'objeto_existente_adotado',
        },
      });
    });

    it('3. Executa pipeline sob papel medicina_worker (NOBYPASSRLS) e busca híbrida sob medicina_app para responsável e estudante vinculada', async () => {
      // 3.1 Confirma que `medicina_worker` não tem acesso a tabelas pessoais/sensíveis
      await pg.exec('SET ROLE medicina_worker;');
      await expect(pg.query('SELECT * FROM public.perfis')).rejects.toThrow();
      await expect(pg.query('SELECT * FROM public.sessoes')).rejects.toThrow();
      await expect(pg.query('SELECT * FROM public.checkins')).rejects.toThrow();
      await expect(pg.query('SELECT * FROM public.curadoria_fila')).rejects.toThrow();
      await pg.exec('RESET ROLE;');

      // 3.2 Upload autenticado pelo Responsável 1 sob `medicina_app` + RLS
      authState.executionRole = 'medicina_app';
      authState.currentProfile = RESPONSAVEL_1;

      const pdfBuffer = makeValidPdfBuffer('F1.13 Pipeline Homologacao');
      const uploadRes = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Tratado de Citologia e Mitocôndrias',
        'livro',
        2,
        'enem',
        'citologia-homologacao.pdf',
        pdfBuffer
      );
      expect(uploadRes.ok).toBe(true);
      if (!uploadRes.ok) return;
      const arquivoId = uploadRes.data.arquivoId;

      // 3.3 Worker independente executa sob `medicina_worker` (NOBYPASSRLS)
      authState.executionRole = 'medicina_worker';
      authState.currentProfile = null;

      const workerRes = await processarProximoJobAcervo('worker-homolog-1', {
        arquivoId,
        extrairTexto: async () => [
          {
            numero: 12,
            texto:
              'Citologia Ficticia: respiração celular aeróbica, ciclo de Krebs e cadeia respiratória nas mitocôndrias.',
            metodo: 'nativo',
            confianca: 1.0,
          },
        ],
        gerarEmbeddingReal: async () => vetorEixo(9),
      });

      expect(workerRes.processado).toBe(true);
      expect(workerRes.statusFinal).toBe('concluido');
      expect(workerRes.etapaAtual).toBe('concluido');

      // 3.4 Estudante 1 (vinculada ao Responsável 1) sob `medicina_app`:
      // - NÃO pode fazer SELECT direto em `acervo_arquivos` (Cenário C14 da F1.04 preservado: 0 linhas)
      // - PODE executar `buscarNoAcervo` via `medicina.fn_busca_hibrida_acervo`
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
        ESTUDANTE_1.id,
        'estudante',
      ]);
      const directAcervoSelect = await pg.query('SELECT id FROM public.acervo_arquivos');
      const directChunksSelect = await pg.query('SELECT id FROM public.acervo_chunks');
      await pg.exec('COMMIT;');

      expect(directAcervoSelect.rows).toHaveLength(0);
      expect(directChunksSelect.rows).toHaveLength(0);

      authState.executionRole = 'medicina_app';
      authState.currentProfile = ESTUDANTE_1;

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: { values: vetorEixo(9) } }),
      } as Response);

      const buscaEstudante1 = await buscarNoAcervo('mitocôndrias respiração celular', DISCIPLINA_BIOLOGIA);
      expect(buscaEstudante1).toHaveLength(1);
      expect(buscaEstudante1[0]).toMatchObject({
        arquivoId,
        arquivoTitulo: 'Tratado de Citologia e Mitocôndrias',
        paginaInicial: 12,
        paginaFinal: 12,
      });

      // 3.5 Estudante 2 (sem vínculo com Responsável 1) recebe 0 resultados sob `medicina_app`
      authState.currentProfile = ESTUDANTE_2;
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: { values: vetorEixo(9) } }),
      } as Response);

      const buscaEstudante2 = await buscarNoAcervo('mitocôndrias respiração celular', DISCIPLINA_BIOLOGIA);
      expect(buscaEstudante2).toEqual([]);

      // 3.6 Tentativa de falsificar perfil_id na função `medicina.fn_busca_hibrida_acervo` sob `medicina_app` dispara 42501
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
        ESTUDANTE_2.id,
        'estudante',
      ]);
      await expect(
        pg.query(
          `SELECT * FROM medicina.fn_busca_hibrida_acervo('mitocondrias', $1::vector(1536), NULL, 5, 0.1, 'estudante', $2::uuid)`,
          [`[${vetorEixo(9).join(',')}]`, ESTUDANTE_1.id]
        )
      ).rejects.toThrow(/Conflito de identidade RLS/);
      await pg.exec('ROLLBACK;');
    });

    it('4. Bloqueia card FSRS gerado por IA sem proveniência e valida rollback reverso completo + reaplicação idempotente (F1.12 -> F1.04)', async () => {
      // 4.1 Constraint `cards_gerado_proveniencia_check` rejeita card com origem='gerado' e fonte_chunk_ids vazio
      await expect(
        pg.query(
          `INSERT INTO public.cards (
             perfil_id, topico_id, frente, verso, origem, status, suspenso, fonte_chunk_ids,
             due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state
           ) VALUES (
             $1, $2, 'Pergunta sem fonte', 'Resposta', 'gerado', 'aprovado', false, '[]'::jsonb,
             now(), 1.0, 5.0, 0, 1, 0, 0, 'new'
           )`,
          [ESTUDANTE_1.id, TOPICO_CITOLOGIA]
        )
      ).rejects.toThrow();

      // 4.2 Rollback reverso completo: F1.12 -> F1.11 -> F1.10 -> F1.09 -> F1.04
      await pg.exec(f112SearchRollbackSql);
      await pg.exec(f111QueueRollbackSql);
      await pg.exec(f110StorageRollbackSql);
      await pg.exec(f109RollbackSql);
      await pg.exec(f104RollbackSql);

      const rlsAtivoAposRollback = await pg.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = true`
      );
      expect(Number(rlsAtivoAposRollback.rows[0]?.cnt)).toBe(0);

      // 4.3 Reaplicação completa em ordem canônica: F1.04 -> F1.09 -> F1.10 -> F1.11 -> F1.12
      await pg.exec(f104ProposalSql);
      await pg.exec(f109ProposalSql);
      await pg.exec(f110StorageProposalSql);
      await pg.exec(f111QueueProposalSql);
      await pg.exec(f112SearchProposalSql);

      // Reaplicação idempotente adicional de cada proposta sobre o estado já migrado
      await pg.exec(f104ProposalSql);
      await pg.exec(f109ProposalSql);
      await pg.exec(f110StorageProposalSql);
      await pg.exec(f111QueueProposalSql);
      await pg.exec(f112SearchProposalSql);

      const tabelasSemRlsAposReaplicacao = await pg.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'r'
            AND (c.relrowsecurity = false OR c.relforcerowsecurity = false)`
      );
      expect(tabelasSemRlsAposReaplicacao.rows).toEqual([]);
    });
  }
);
