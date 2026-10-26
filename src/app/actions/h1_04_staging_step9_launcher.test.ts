import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import {
  executeControlledStep9Migration,
  TARGET_PROJECT_REF,
  TARGET_HOST,
  TARGET_PORT,
  TARGET_DB,
  TARGET_ROLE,
  TARGET_USERNAME,
  TARGET_STEP,
  TARGET_SCRIPT_NAME,
  EXPECTED_CONFIRMATION_TOKEN,
  RUNNER_COMMAND,
  RUNNER_ARGS,
} from '../../../scripts/db/apply-staging-step9.mjs';

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

async function createSupabaseSimulatedDbWithSteps1To8Applied(): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
  const db = new PGlite({
    extensions: { vector },
  });

  // Configuração inicial simulando Supabase gerenciado
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;

    -- Simula catálogo nativo do Supabase Storage gerenciado
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
    { ordem: 8, relPath: 'docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql' },
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
      begin: async <T>(cb: (tx: SqlAdapter) => Promise<T>): Promise<T> => {
        await db.exec('BEGIN;');
        try {
          const res = await cb(sqlAdapter);
          await db.exec('COMMIT;');
          return res;
        } catch (err) {
          try {
            await db.exec('ROLLBACK;');
          } catch {}
          throw err;
        }
      },
    }
  );

  return { db, sql: sqlAdapter };
}

describe('MEDICINA 2029 — Lançador Seguro da Migração F1.12 Busca Vetorial (apply-staging-step9.mjs)', () => {
  it('1. Valida metadados e parâmetros operacionais fixos do lançador', () => {
    expect(TARGET_PROJECT_REF).toBe('ynfocaorhadizlvbnzrt');
    expect(TARGET_HOST).toBe('aws-0-us-east-1.pooler.supabase.com');
    expect(TARGET_PORT).toBe(5432);
    expect(TARGET_DB).toBe('postgres');
    expect(TARGET_ROLE).toBe('postgres');
    expect(TARGET_USERNAME).toBe('postgres.ynfocaorhadizlvbnzrt');
    expect(TARGET_STEP).toBe(9);
    expect(TARGET_SCRIPT_NAME).toBe('docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql');
    expect(EXPECTED_CONFIRMATION_TOKEN).toBe('APLICAR ETAPA 9 EM STAGING');
    expect(RUNNER_COMMAND).toBe('CONFIRM_STAGING_MIGRATIONS=true node scripts/db/migrate-staging.mjs --apply --until-step=9');
    expect(RUNNER_ARGS).toEqual(['--apply', '--until-step=9']);
  });

  it('2. Rejeita execução se confirmação humana explícita não for exatamente "APLICAR ETAPA 9 EM STAGING"', async () => {
    await expect(
      executeControlledStep9Migration({
        confirmation: 'CONFIRMO',
        logger: () => {},
      })
    ).rejects.toThrowError(/OPERAÇÃO CANCELADA.*Confirmação humana explícita não fornecida/);
  });

  it('3. Rejeita se o arquivo de certificado CA TLS não for localizado', async () => {
    await expect(
      executeControlledStep9Migration({
        confirmation: 'APLICAR ETAPA 9 EM STAGING',
        caCertPath: '/tmp/arquivo-inexistente-ca.crt',
        logger: () => {},
      })
    ).rejects.toThrowError(/Arquivo de certificado CA TLS não encontrado/);
  });

  it('4. Executa exclusivamente a migração 9 (F1.12) com etapas 1 a 8 previamente aplicadas', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To8Applied();

    const logs: string[] = [];
    const result = await executeControlledStep9Migration({
      confirmation: 'APLICAR ETAPA 9 EM STAGING',
      sqlInstance: sql,
      logger: (msg: string) => logs.push(msg),
    });

    expect(result.success).toBe(true);
    expect(result.appliedCount).toBe(1); // Exatamente a etapa 9 aplicada
    expect(result.skippedCount).toBe(8); // Etapas 1 a 8 puladas com segurança
    expect(result.pendingCount).toBe(0);

    // Confirma que os 8 scripts anteriores receberam [SKIP]
    const skipLogs = logs.filter((l) => l.includes('[SKIP]'));
    expect(skipLogs.length).toBe(8);

    // Confirma que a etapa 9 foi aplicada com [APPLIED] / [APPLYING]
    const applyLog = logs.find((l) => (l.includes('[APPLIED]') || l.includes('[APPLYING]')) && l.includes('F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'));
    expect(applyLog).toBeDefined();

    // Valida que o histórico de migrações agora possui exatamente 9 registros
    const historyRows = await db.query(
      'SELECT ordem, rel_path, executado_por FROM public._medicina_staging_migrations ORDER BY ordem ASC;'
    );
    expect(historyRows.rows.length).toBe(9);
    expect(historyRows.rows[8].ordem).toBe(9);
    expect(historyRows.rows[8].rel_path).toBe(TARGET_SCRIPT_NAME);
    expect(historyRows.rows[8].executado_por).toBe('postgres');

    // Valida que os objetos de F1.12 foram criados
    const fnCheck = await db.query("SELECT 1 FROM pg_proc WHERE proname = 'fn_busca_hibrida_acervo';");
    expect(fnCheck.rows.length).toBeGreaterThan(0);

    const hnswCheck = await db.query(
      "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'acervo_chunks_embedding_hnsw_idx';"
    );
    expect(hnswCheck.rows.length).toBe(1);

    const ftsCheck = await db.query(
      "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'acervo_chunks_texto_fts_idx';"
    );
    expect(ftsCheck.rows.length).toBe(1);
  });

  it('5. Demonstra idempotência completa em re-execução (todas as 9 etapas puladas com segurança)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To8Applied();

    // Primeira execução aplica a etapa 9
    await executeControlledStep9Migration({
      confirmation: 'APLICAR ETAPA 9 EM STAGING',
      sqlInstance: sql,
      logger: () => {},
    });

    // Segunda execução deve pular todas as 9 migrações sem erro
    const retryLogs: string[] = [];
    const retryResult = await executeControlledStep9Migration({
      confirmation: 'APLICAR ETAPA 9 EM STAGING',
      sqlInstance: sql,
      logger: (msg: string) => retryLogs.push(msg),
    });

    expect(retryResult.appliedCount).toBe(0);
    expect(retryResult.skippedCount).toBe(9); // Todas as 9 etapas puladas!
    expect(retryLogs.filter((l) => l.includes('[SKIP]')).length).toBe(9);

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(9);
  });

  it('6. Falha durante DDL da etapa 9 reverte transação atomicamente via ROLLBACK', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To8Applied();

    // Adaptador que simula erro durante o DDL de F1.12
    const failDdlAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => sql(strings, ...values),
      {
        unsafe: async (query: string) => {
          if (query.includes('CREATE OR REPLACE FUNCTION medicina.fn_busca_hibrida_acervo')) {
            throw new Error('SIMULATED_DDL_ERROR: Falha de DDL durante migração F1.12.');
          }
          await db.exec(query);
          return [];
        },
        reserve: async () => failDdlAdapter,
        release: () => {},
      }
    );

    await expect(
      executeControlledStep9Migration({
        confirmation: 'APLICAR ETAPA 9 EM STAGING',
        sqlInstance: failDdlAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_DDL_ERROR/);

    // Comprova que o ROLLBACK reverteu e a função não existe, mantendo 8 migrações no histórico
    const procCheck = await db.query("SELECT 1 FROM pg_proc WHERE proname = 'fn_busca_hibrida_acervo';");
    expect(procCheck.rows.length).toBe(0);

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(8); // Apenas etapas 1 a 8!
  });

  it('7. Falha durante tracking da etapa 9 reverte transação atomicamente desfazendo os objetos de F1.12', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To8Applied();

    // Adaptador que simula erro no INSERT de tracking da etapa 9
    const failTrackingAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
        const q = typeof strings === 'string' ? strings : strings[0];
        if (q.includes('INSERT INTO public._medicina_staging_migrations')) {
          throw new Error('SIMULATED_TRACKING_FAILURE: Falha ao inserir registro da migração 9 no histórico.');
        }
        return sql(strings, ...values);
      },
      {
        unsafe: async (queryText: string) => {
          await db.exec(queryText);
          return [];
        },
        reserve: async () => failTrackingAdapter,
        release: () => {},
      }
    );

    await expect(
      executeControlledStep9Migration({
        confirmation: 'APLICAR ETAPA 9 EM STAGING',
        sqlInstance: failTrackingAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_TRACKING_FAILURE/);

    // Comprova que a função foi desfeita pelo ROLLBACK atômico
    const procCheck = await db.query("SELECT 1 FROM pg_proc WHERE proname = 'fn_busca_hibrida_acervo';");
    expect(procCheck.rows.length).toBe(0);

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(8);
  });

  it('8. Probe 9: Detecta estado intermediário e aborta fail-closed se fn_busca_hibrida_acervo existir sem tracking', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To8Applied();

    // Simula função criada externamente sem gravação no histórico
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS medicina;
      CREATE OR REPLACE FUNCTION medicina.fn_busca_hibrida_acervo()
      RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END; $$;
    `);

    await expect(
      executeControlledStep9Migration({
        confirmation: 'APLICAR ETAPA 9 EM STAGING',
        sqlInstance: sql,
        logger: () => {},
      })
    ).rejects.toThrowError(/ESTADO INTERMEDIÁRIO DETECTADO.*migração \[9\]/);
  });

  it('9. Conclusão da cadeia: total de 9 migrações registradas e sem pendências', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To8Applied();

    const result = await executeControlledStep9Migration({
      confirmation: 'APLICAR ETAPA 9 EM STAGING',
      sqlInstance: sql,
      logger: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.pendingCount).toBe(0);
    expect(result.total).toBe(9);

    const countRes = await db.query('SELECT count(*)::int AS total FROM public._medicina_staging_migrations;');
    expect(countRes.rows[0].total).toBe(9);
  });
});
