import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import {
  executeControlledStep8Migration,
  TARGET_PROJECT_REF,
  TARGET_HOST,
  TARGET_PORT,
  TARGET_USERNAME,
  TARGET_STEP,
  TARGET_SCRIPT_NAME,
  EXPECTED_CONFIRMATION_TOKEN,
  RUNNER_COMMAND,
  RUNNER_ARGS,
} from '../../../scripts/db/apply-staging-step8.mjs';

import { stripOuterTransaction, getMigrationManifest } from '../../../scripts/db/migrate-staging.mjs';

const moduleRoot = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';

if (!existsSync(moduleRoot)) {
  throw new Error(`Diretório de módulos isolados não encontrado em ${moduleRoot}.`);
}

const importFromRoot = (pkgPath: string) => import(pathToFileURL(path.join(moduleRoot, pkgPath)).href);

const [{ PGlite }, { vector }] = await Promise.all([
  importFromRoot('@electric-sql/pglite/dist/index.js'),
  importFromRoot('@electric-sql/pglite-pgvector/dist/index.js'),
]);

interface SqlAdapter {
  (strings: TemplateStringsArray | string, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  unsafe: (queryText: string) => Promise<unknown[]>;
  reserve?: () => Promise<SqlAdapter>;
  release?: () => void;
  begin?: <T>(cb: (tx: SqlAdapter) => Promise<T>) => Promise<T>;
}

interface PGliteInstance {
  exec: (query: string) => Promise<unknown>;
  query: (query: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

async function createSupabaseSimulatedDbWithSteps1To7Applied(): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
  const db = new PGlite({
    extensions: { vector },
  });

  // Configuração inicial simulando Supabase gerenciado
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;

    -- Simula catálogo nativo do Supabase Storage gerenciado exigido pela etapa 7
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL UNIQUE,
      public boolean DEFAULT false NOT NULL,
      file_size_limit bigint,
      allowed_mime_types text[],
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL
    );
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('acervo', 'acervo', false, 20971520, ARRAY['application/pdf']::text[])
    ON CONFLICT (id) DO UPDATE SET public = false;
  `);

  // 1. Aplica tabela de histórico de migrações
  await db.exec(`
    CREATE TABLE public._medicina_staging_migrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ordem integer NOT NULL UNIQUE,
      rel_path text NOT NULL UNIQUE,
      sha256 text NOT NULL,
      aplicado_em timestamptz DEFAULT now() NOT NULL,
      executado_por text NOT NULL,
      tamanho_bytes integer NOT NULL
    );
  `);

  const initialMigrations = [
    { ordem: 1, relPath: 'drizzle/0000_greedy_loki.sql' },
    { ordem: 2, relPath: 'drizzle/0001_dry_talos.sql' },
    { ordem: 3, relPath: 'drizzle/0002_little_swarm.sql' },
    { ordem: 4, relPath: 'drizzle/0003_f1_03_r_expansao.sql' },
    { ordem: 5, relPath: 'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql' },
    { ordem: 6, relPath: 'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql' },
    { ordem: 7, relPath: 'docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql' },
  ];

  const manifest = getMigrationManifest();

  for (const m of initialMigrations) {
    const rawSql = readFileSync(path.resolve(process.cwd(), m.relPath), 'utf8');
    const cleanSql = stripOuterTransaction(rawSql);
    await db.exec(cleanSql);

    const mInfo = manifest.find((item) => item.ordem === m.ordem)!;
    await db.exec(`
      INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
      VALUES (${m.ordem}, '${m.relPath}', '${mInfo.sha256}', 'postgres', ${mInfo.tamanhoBytes});
    `);
  }

  const sqlAdapter: SqlAdapter = Object.assign(
    async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      let queryText = '';
      if (typeof strings === 'string') {
        queryText = strings;
      } else {
        queryText = strings[0];
        for (let i = 0; i < values.length; i++) {
          const val = values[i];
          if (typeof val === 'number') {
            queryText += String(val) + strings[i + 1];
          } else if (typeof val === 'string') {
            queryText += `'${val.replace(/'/g, "''")}'` + strings[i + 1];
          } else if (val === null || val === undefined) {
            queryText += 'NULL' + strings[i + 1];
          } else {
            queryText += `'${JSON.stringify(val).replace(/'/g, "''")}'` + strings[i + 1];
          }
        }
      }
      const res = await db.query(queryText);
      return res.rows;
    },
    {
      unsafe: async (queryText: string) => {
        await db.exec(queryText);
        return [];
      },
      reserve: async () => {
        const reservedConnection = Object.assign(
          async (strings: TemplateStringsArray | string, ...values: unknown[]) => sqlAdapter(strings, ...values),
          {
            unsafe: sqlAdapter.unsafe,
            release: () => {},
          }
        );
        return reservedConnection as unknown as SqlAdapter;
      },
      release: () => {},
    }
  );

  return { db, sql: sqlAdapter };
}

describe('MEDICINA 2029 — Lançador Seguro da Migração F1.11 Fila de Ingestão (apply-staging-step8.mjs)', () => {
  it('1. Valida metadados e parâmetros operacionais fixos do lançador', () => {
    expect(TARGET_PROJECT_REF).toBe('ynfocaorhadizlvbnzrt');
    expect(TARGET_HOST).toBe('aws-0-us-east-1.pooler.supabase.com');
    expect(TARGET_PORT).toBe(5432);
    expect(TARGET_USERNAME).toBe('postgres.ynfocaorhadizlvbnzrt');
    expect(TARGET_STEP).toBe(8);
    expect(TARGET_SCRIPT_NAME).toBe('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql');
    expect(EXPECTED_CONFIRMATION_TOKEN).toBe('APLICAR ETAPA 8 EM STAGING');
    expect(RUNNER_ARGS).toEqual(['--apply', '--until-step=8']);
    expect(RUNNER_COMMAND).toBe('CONFIRM_STAGING_MIGRATIONS=true node scripts/db/migrate-staging.mjs --apply --until-step=8');
  });

  it('2. Rejeita execução se confirmação humana explícita não for exatamente "APLICAR ETAPA 8 EM STAGING"', async () => {
    const invalidConfirmations = [
      'CONFIRMAR',
      'sim',
      'yes',
      'APLICAR ETAPA 8',
      'aplicar etapa 8 em staging',
      's',
      '',
      'APLICAR',
      'APLICAR ETAPA 7 EM STAGING',
    ];

    for (const conf of invalidConfirmations) {
      await expect(
        executeControlledStep8Migration({
          confirmation: conf,
          password: 'dummy',
        })
      ).rejects.toThrowError(/OPERAÇÃO CANCELADA: Confirmação humana explícita não fornecida/);
    }
  });

  it('3. Rejeita se o arquivo de certificado CA TLS não for localizado', async () => {
    await expect(
      executeControlledStep8Migration({
        confirmation: 'APLICAR ETAPA 8 EM STAGING',
        password: 'dummy',
        caCertPath: '/caminho/comprovadamente/inexistente/ca.crt',
      })
    ).rejects.toThrowError(/Arquivo de certificado CA TLS não encontrado/);
  });

  it('4. Executa exclusivamente a migração 8 (F1.11) com etapas 1 a 7 previamente aplicadas', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To7Applied();
    const logs: string[] = [];

    // Confere estado prévio: 7 migrações no histórico e tabela acervo_jobs inexistente
    const preHistory = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(preHistory.rows[0].cnt).toBe(7);

    const preTable = await db.query("SELECT to_regclass('public.acervo_jobs') as tbl;");
    expect(preTable.rows[0].tbl).toBeNull();

    // Executa o lançador da etapa 8
    const result = await executeControlledStep8Migration({
      confirmation: 'APLICAR ETAPA 8 EM STAGING',
      sqlInstance: sql,
      logger: (msg: string) => logs.push(msg),
    });

    expect(result.success).toBe(true);
    expect(result.appliedCount).toBe(1);
    expect(result.skippedCount).toBe(7); // Etapas 1 a 7 todas puladas!
    expect(result.step).toBe(8);
    expect(result.scriptName).toBe('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql');

    // 1. Confirma que as migrações 1 a 7 foram puladas com [SKIP]
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0000_greedy_loki.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0001_dry_talos.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0002_little_swarm.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0003_f1_03_r_expansao.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('F1_04_RLS_PROPOSTA.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('F1_10_STORAGE_POLICIES_PROPOSTA.sql'))).toBe(true);

    // 2. Confirma histórico final com exatamente 8 registros ordenados
    const historyRes = await db.query(
      'SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations ORDER BY ordem ASC;'
    );
    expect(historyRes.rows.length).toBe(8);
    expect(historyRes.rows[7].ordem).toBe(8);
    expect(historyRes.rows[7].rel_path).toBe('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql');
    const manifest = getMigrationManifest();
    const expectedSha256 = manifest.find((m) => m.ordem === 8)?.sha256;
    expect(historyRes.rows[7].sha256).toBe(expectedSha256);

    // 3. Confirma criação da tabela acervo_jobs e constraints de unicidade
    const tableCheck = await db.query("SELECT to_regclass('public.acervo_jobs') as tbl;");
    expect(tableCheck.rows[0].tbl).not.toBeNull();

    const uqPaginasCheck = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'acervo_paginas_arquivo_numero_unique';"
    );
    expect(uqPaginasCheck.rows.length).toBe(1);

    const uqChunksCheck = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'acervo_chunks_arquivo_ordem_unique';"
    );
    expect(uqChunksCheck.rows.length).toBe(1);

    // 4. Confirma parada obrigatória no portão operacional (untilStep = 8)
    expect(logs.some((l) => l.includes('[STOP] Interrupção planejada no portão operacional (untilStep = 8)'))).toBe(true);

    // 5. Confirma que a etapa 9 (F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql / fn_busca_hibrida_acervo) NÃO foi executada
    const searchProcCheck = await db.query("SELECT 1 FROM pg_proc WHERE proname = 'fn_busca_hibrida_acervo';");
    expect(searchProcCheck.rows.length).toBe(0);
  });

  it('5. Demonstra idempotência completa em re-execução (todas as 8 etapas puladas com segurança)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To7Applied();

    // Primeira aplicação da etapa 8
    await executeControlledStep8Migration({
      confirmation: 'APLICAR ETAPA 8 EM STAGING',
      sqlInstance: sql,
      logger: () => {},
    });

    // Re-execução imediata
    const retryLogs: string[] = [];
    const retryResult = await executeControlledStep8Migration({
      confirmation: 'APLICAR ETAPA 8 EM STAGING',
      sqlInstance: sql,
      logger: (msg: string) => retryLogs.push(msg),
    });

    expect(retryResult.success).toBe(true);
    expect(retryResult.appliedCount).toBe(0);
    expect(retryResult.skippedCount).toBe(8); // Todas as 8 etapas puladas!
    expect(retryLogs.filter((l) => l.includes('[SKIP]')).length).toBe(8);

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(8);
  });

  it('6. Falha durante DDL da etapa 8 reverte transação atomicamente via ROLLBACK', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To7Applied();

    // Adaptador que simula erro durante o DDL da tabela acervo_jobs
    const failDdlAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => sql(strings, ...values),
      {
        unsafe: async (query: string) => {
          if (query.includes('CREATE TABLE IF NOT EXISTS public.acervo_jobs')) {
            throw new Error('SIMULATED_DDL_ERROR: Falha de DDL durante migração F1.11.');
          }
          return sql.unsafe(query);
        },
        reserve: async () => failDdlAdapter,
        release: () => {},
      }
    );

    await expect(
      executeControlledStep8Migration({
        confirmation: 'APLICAR ETAPA 8 EM STAGING',
        sqlInstance: failDdlAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_DDL_ERROR/);

    // Comprova que o ROLLBACK reverteu e a tabela não existe, mantendo 7 migrações no histórico
    const tableCheck = await db.query("SELECT to_regclass('public.acervo_jobs') as tbl;");
    expect(tableCheck.rows[0].tbl).toBeNull();

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(7); // Apenas etapas 1 a 7!
  });

  it('7. Falha durante tracking da etapa 8 reverte transação atomicamente desfazendo os objetos de F1.11', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To7Applied();

    // Adaptador que simula erro no INSERT de tracking da etapa 8
    const failTrackingAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
        const q = typeof strings === 'string' ? strings : strings[0];
        if (q.includes('INSERT INTO public._medicina_staging_migrations')) {
          throw new Error('SIMULATED_TRACKING_FAILURE: Falha ao inserir registro da migração 8 no histórico.');
        }
        return sql(strings, ...values);
      },
      {
        unsafe: sql.unsafe,
        reserve: async () => failTrackingAdapter,
        release: () => {},
      }
    );

    await expect(
      executeControlledStep8Migration({
        confirmation: 'APLICAR ETAPA 8 EM STAGING',
        sqlInstance: failTrackingAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_TRACKING_FAILURE/);

    // Comprova que a tabela acervo_jobs foi desfeita pelo ROLLBACK atômico
    const tableCheck = await db.query("SELECT to_regclass('public.acervo_jobs') as tbl;");
    expect(tableCheck.rows[0].tbl).toBeNull();

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(7);
  });

  it('8. Probe 8: Detecta estado intermediário e aborta fail-closed se acervo_jobs existir sem tracking', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To7Applied();

    // Simula tabela acervo_jobs criada externamente sem gravação no histórico
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.acervo_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        arquivo_id uuid NOT NULL
      );
    `);

    await expect(
      executeControlledStep8Migration({
        confirmation: 'APLICAR ETAPA 8 EM STAGING',
        sqlInstance: sql,
        logger: () => {},
      })
    ).rejects.toThrowError(/ESTADO INTERMEDIÁRIO DETECTADO.*migração \[8\]/);
  });

  it('9. Garantia estrita de que a etapa 9 (F1.12) NÃO é executada (--until-step=8)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To7Applied();

    const result = await executeControlledStep8Migration({
      confirmation: 'APLICAR ETAPA 8 EM STAGING',
      sqlInstance: sql,
      logger: () => {},
    });

    expect(result.success).toBe(true);

    // Confirma que a tabela de histórico NÃO possui a ordem 9
    const step9History = await db.query(
      'SELECT 1 FROM public._medicina_staging_migrations WHERE ordem = 9;'
    );
    expect(step9History.rows.length).toBe(0);

    // Confirma ausência de objetos da etapa 9 (fn_busca_hibrida_acervo)
    const procCheck = await db.query("SELECT 1 FROM pg_proc WHERE proname = 'fn_busca_hibrida_acervo';");
    expect(procCheck.rows.length).toBe(0);
  });
});
