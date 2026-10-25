import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import {
  executeControlledStep7Migration,
  TARGET_PROJECT_REF,
  TARGET_HOST,
  TARGET_PORT,
  TARGET_USERNAME,
  TARGET_STEP,
  TARGET_SCRIPT_NAME,
  EXPECTED_CONFIRMATION_TOKEN,
  RUNNER_COMMAND,
  RUNNER_ARGS,
} from '../../../scripts/db/apply-staging-step7.mjs';

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

async function createSupabaseSimulatedDbWithSteps1To6Applied(): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
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
    {
      ordem: 1,
      relPath: 'drizzle/0000_greedy_loki.sql',
      sha256: 'b1cf8d6741894a52543ca0edf7212dee9ee8945051cd01148ea60a3cbaf4b4c6',
      bytes: 24043,
    },
    {
      ordem: 2,
      relPath: 'drizzle/0001_dry_talos.sql',
      sha256: '8e82452e0071ee1ce5a1e38569ef8f69a0851ae3d8e229ebfd1b4969e3db9180',
      bytes: 238,
    },
    {
      ordem: 3,
      relPath: 'drizzle/0002_little_swarm.sql',
      sha256: 'c3ce3d3b1335bedb2deb46e2c14c018fe15370b60e7fdc415def17cb9de0343b',
      bytes: 66,
    },
    {
      ordem: 4,
      relPath: 'drizzle/0003_f1_03_r_expansao.sql',
      sha256: '32be49be0da8ed6c675657ef0ecf14f54951491df0176cb66f1a450b8bab4e3f',
      bytes: 11541,
    },
    {
      ordem: 5,
      relPath: 'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql',
      sha256: '8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f',
      bytes: 45758,
    },
    {
      ordem: 6,
      relPath: 'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql',
      sha256: '96187040783e236b64bb70c15b9bf57c7ad39feb3d100a571bfa0e01eb5b55d1',
      bytes: 11303,
    },
  ];

  for (const m of initialMigrations) {
    const rawSql = readFileSync(path.resolve(process.cwd(), m.relPath), 'utf8');
    const cleanSql = stripOuterTransaction(rawSql);
    await db.exec(cleanSql);

    await db.exec(`
      INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
      VALUES (${m.ordem}, '${m.relPath}', '${m.sha256}', 'postgres', ${m.bytes});
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

describe('MEDICINA 2029 — Lançador Seguro da Migração F1.10 Políticas de Storage (apply-staging-step7.mjs)', () => {
  it('1. Valida metadados e parâmetros operacionais fixos do lançador', () => {
    expect(TARGET_PROJECT_REF).toBe('ynfocaorhadizlvbnzrt');
    expect(TARGET_HOST).toBe('aws-0-us-east-1.pooler.supabase.com');
    expect(TARGET_PORT).toBe(5432);
    expect(TARGET_USERNAME).toBe('postgres.ynfocaorhadizlvbnzrt');
    expect(TARGET_STEP).toBe(7);
    expect(TARGET_SCRIPT_NAME).toBe('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql');
    expect(EXPECTED_CONFIRMATION_TOKEN).toBe('APLICAR ETAPA 7 EM STAGING');
    expect(RUNNER_ARGS).toEqual(['--apply', '--until-step=7']);
    expect(RUNNER_COMMAND).toBe('CONFIRM_STAGING_MIGRATIONS=true node scripts/db/migrate-staging.mjs --apply --until-step=7');
  });

  it('2. Rejeita execução se confirmação humana explícita não for exatamente "APLICAR ETAPA 7 EM STAGING"', async () => {
    const invalidConfirmations = [
      'CONFIRMAR',
      'sim',
      'yes',
      'APLICAR ETAPA 7',
      'aplicar etapa 7 em staging',
      's',
      '',
      'APLICAR',
    ];

    for (const conf of invalidConfirmations) {
      await expect(
        executeControlledStep7Migration({
          confirmation: conf,
          password: 'dummy',
        })
      ).rejects.toThrowError(/OPERAÇÃO CANCELADA: Confirmação humana explícita não fornecida/);
    }
  });

  it('3. Rejeita se o arquivo de certificado CA TLS não for localizado', async () => {
    await expect(
      executeControlledStep7Migration({
        confirmation: 'APLICAR ETAPA 7 EM STAGING',
        password: 'dummy',
        caCertPath: '/caminho/comprovadamente/inexistente/ca.crt',
      })
    ).rejects.toThrowError(/Arquivo de certificado CA TLS não encontrado/);
  });

  it('4. Executa exclusivamente a migração 7 (F1.10) com etapas 1 a 6 previamente aplicadas', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    const logs: string[] = [];

    // Confere estado prévio: 6 migrações no histórico e função de storage inexistente
    const preHistory = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(preHistory.rows[0].cnt).toBe(6);

    const preProc = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(preProc.rows[0].fn).toBeNull();

    // Executa o lançador da etapa 7
    const result = await executeControlledStep7Migration({
      confirmation: 'APLICAR ETAPA 7 EM STAGING',
      sqlInstance: sql,
      logger: (msg: string) => logs.push(msg),
    });

    expect(result.success).toBe(true);
    expect(result.appliedCount).toBe(1);
    expect(result.skippedCount).toBe(6); // 0000, 0001, 0002, 0003, F1.04 RLS e F1.09 Integridade todas puladas!
    expect(result.step).toBe(7);
    expect(result.scriptName).toBe('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql');

    // 1. Confirma que as migrações 1 a 6 foram puladas com [SKIP]
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0000_greedy_loki.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0001_dry_talos.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0002_little_swarm.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0003_f1_03_r_expansao.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('F1_04_RLS_PROPOSTA.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'))).toBe(true);

    // 2. Confirma histórico final com exatamente 7 registros ordenados
    const historyRes = await db.query(
      'SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations ORDER BY ordem ASC;'
    );
    expect(historyRes.rows.length).toBe(7);
    expect(historyRes.rows[6].ordem).toBe(7);
    expect(historyRes.rows[6].rel_path).toBe('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql');
    const manifest = getMigrationManifest();
    const expectedSha256 = manifest.find((m) => m.ordem === 7)?.sha256;
    expect(historyRes.rows[6].sha256).toBe(expectedSha256);

    // 3. Confirma criação da função de storage e constraint em public.acervo_arquivos
    const procCheck = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(procCheck.rows[0].fn).not.toBeNull();

    const constraintCheck = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'acervo_arquivos_file_path_format_check';"
    );
    expect(constraintCheck.rows.length).toBe(1);

    const bucketCheck = await db.query("SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'acervo';");
    expect(bucketCheck.rows.length).toBe(1);
    expect(bucketCheck.rows[0].public).toBe(false);

    // 4. Confirma parada obrigatória no portão operacional (untilStep = 7)
    expect(logs.some((l) => l.includes('[STOP] Interrupção planejada no portão operacional (untilStep = 7)'))).toBe(true);

    // 5. Confirma que a etapa 8 (F1_11_FILA_INGESTAO_PROPOSTA.sql / acervo_jobs) NÃO foi executada
    const jobsCheck = await db.query("SELECT to_regclass('public.acervo_jobs') as tbl;");
    expect(jobsCheck.rows[0].tbl).toBeNull();
  });

  it('5. Demonstra idempotência completa em re-execução (todas as 7 etapas puladas com segurança)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();

    // Primeira aplicação da etapa 7
    await executeControlledStep7Migration({
      confirmation: 'APLICAR ETAPA 7 EM STAGING',
      sqlInstance: sql,
      logger: () => {},
    });

    // Re-execução imediata
    const retryLogs: string[] = [];
    const retryResult = await executeControlledStep7Migration({
      confirmation: 'APLICAR ETAPA 7 EM STAGING',
      sqlInstance: sql,
      logger: (msg: string) => retryLogs.push(msg),
    });

    expect(retryResult.success).toBe(true);
    expect(retryResult.appliedCount).toBe(0);
    expect(retryResult.skippedCount).toBe(7); // Todas as 7 etapas puladas!
    expect(retryLogs.filter((l) => l.includes('[SKIP]')).length).toBe(7);

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(7);
  });

  it('6. Falha durante DDL de 0007 reverte transação atomicamente via ROLLBACK', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();

    // Adaptador que simula erro durante o DDL da função is_valid_acervo_storage_path
    const failDdlAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => sql(strings, ...values),
      {
        unsafe: async (query: string) => {
          if (query.includes('is_valid_acervo_storage_path')) {
            throw new Error('SIMULATED_DDL_ERROR: Falha de DDL durante migração F1.10.');
          }
          return sql.unsafe(query);
        },
        reserve: async () => failDdlAdapter,
        release: () => {},
      }
    );

    await expect(
      executeControlledStep7Migration({
        confirmation: 'APLICAR ETAPA 7 EM STAGING',
        sqlInstance: failDdlAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_DDL_ERROR/);

    // Comprova que o ROLLBACK reverteu e a função não existe, mantendo 6 migrações no histórico
    const procCheck = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(procCheck.rows[0].fn).toBeNull();

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(6); // Apenas etapas 1 a 6!
  });

  it('7. Falha durante tracking de 0007 reverte transação atomicamente desfazendo os objetos de F1.10', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();

    // Adaptador que simula erro no INSERT de tracking da etapa 7
    const failTrackingAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
        const q = typeof strings === 'string' ? strings : strings[0];
        if (q.includes('INSERT INTO public._medicina_staging_migrations')) {
          throw new Error('SIMULATED_TRACKING_FAILURE: Falha ao inserir registro da migração 7 no histórico.');
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
      executeControlledStep7Migration({
        confirmation: 'APLICAR ETAPA 7 EM STAGING',
        sqlInstance: failTrackingAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_TRACKING_FAILURE/);

    // Comprova que a função foi desfeita pelo ROLLBACK atômico
    const procCheck = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(procCheck.rows[0].fn).toBeNull();

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(6);
  });

  it('8. Preflight Fail-Closed: Rejeita aplicação se o bucket "acervo" for ausente ou público', async () => {
    // 8.1 Caso ausente
    const { db: dbMissing, sql: sqlMissing } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await dbMissing.exec("DELETE FROM storage.buckets WHERE id = 'acervo';");

    await expect(
      executeControlledStep7Migration({
        confirmation: 'APLICAR ETAPA 7 EM STAGING',
        sqlInstance: sqlMissing,
        logger: () => {},
      })
    ).rejects.toThrowError(/Bucket acervo inexistente ou não configurado como privado/);

    // 8.2 Caso público
    const { db: dbPublic, sql: sqlPublic } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await dbPublic.exec("UPDATE storage.buckets SET public = true WHERE id = 'acervo';");

    await expect(
      executeControlledStep7Migration({
        confirmation: 'APLICAR ETAPA 7 EM STAGING',
        sqlInstance: sqlPublic,
        logger: () => {},
      })
    ).rejects.toThrowError(/Bucket acervo inexistente ou não configurado como privado/);
  });

  it('9. Probe 7: Detecta estado intermediário e aborta fail-closed se objetos existirem sem tracking', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();

    // Simula objeto intermediário criado externamente sem gravação no histórico
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS medicina;
      CREATE OR REPLACE FUNCTION medicina.is_valid_acervo_storage_path(p_name text)
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true; $$;
    `);

    await expect(
      executeControlledStep7Migration({
        confirmation: 'APLICAR ETAPA 7 EM STAGING',
        sqlInstance: sql,
        logger: () => {},
      })
    ).rejects.toThrowError(/ESTADO INTERMEDIÁRIO DETECTADO.*migração \[7\]/);
  });
});
