import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import {
  executeControlledStep2Migration,
  TARGET_PROJECT_REF,
  TARGET_HOST,
  TARGET_PORT,
  TARGET_USERNAME,
  TARGET_STEP,
  TARGET_SCRIPT_NAME,
} from '../../../scripts/db/apply-staging-step2.mjs';

import { stripOuterTransaction } from '../../../scripts/db/migrate-staging.mjs';

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

async function createSupabaseSimulatedDbWithStep0Applied(): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
  const db = new PGlite({
    extensions: { vector },
  });

  // Configuração inicial simulando Supabase gerenciado
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;
  `);

  // 1. Aplica tabela de histórico
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

  // 2. Aplica DDL da migração 0000
  const sql0Path = path.resolve(process.cwd(), 'drizzle/0000_greedy_loki.sql');
  const rawSql0 = readFileSync(sql0Path, 'utf8');
  const cleanSql0 = stripOuterTransaction(rawSql0);
  await db.exec(cleanSql0);

  // 3. Registra migração 0000 no histórico
  await db.exec(`
    INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
    VALUES (
      1,
      'drizzle/0000_greedy_loki.sql',
      'b1cf8d6741894a52543ca0edf7212dee9ee8945051cd01148ea60a3cbaf4b4c6',
      'postgres',
      24043
    );
  `);

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
      // Emula fielmente o driver postgres (porsager/postgres): sql.reserve() retorna
      // conexão dedicada sem o método .begin()
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

describe('MEDICINA 2029 — Lançador Seguro da Migração 0001 (apply-staging-step2.mjs)', () => {
  it('1. Valida metadados e parâmetros operacionais fixos do lançador', () => {
    expect(TARGET_PROJECT_REF).toBe('ynfocaorhadizlvbnzrt');
    expect(TARGET_HOST).toBe('aws-0-us-east-1.pooler.supabase.com');
    expect(TARGET_PORT).toBe(5432);
    expect(TARGET_USERNAME).toBe('postgres.ynfocaorhadizlvbnzrt');
    expect(TARGET_STEP).toBe(2);
    expect(TARGET_SCRIPT_NAME).toBe('drizzle/0001_dry_talos.sql');
  });

  it('2. Rejeita execução se confirmação humana explícita não for exatamente "CONFIRMAR"', async () => {
    const invalidConfirmations = ['sim', 'yes', 'CONFIRMA', 's', '', 'confirmar'];

    for (const conf of invalidConfirmations) {
      await expect(
        executeControlledStep2Migration({
          confirmation: conf,
          password: 'dummy',
        })
      ).rejects.toThrowError(/OPERAÇÃO CANCELADA: Confirmação humana explícita não fornecida/);
    }
  });

  it('3. Rejeita se o arquivo de certificado CA TLS não for localizado', async () => {
    await expect(
      executeControlledStep2Migration({
        confirmation: 'CONFIRMAR',
        password: 'dummy',
        caCertPath: '/caminho/comprovadamente/inexistente/ca.crt',
      })
    ).rejects.toThrowError(/Arquivo de certificado CA TLS não encontrado/);
  });

  it('4. Executa exclusivamente a migração 0001 com 0000 previamente aplicada', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithStep0Applied();
    const logs: string[] = [];

    // Confere estado prévio: 1 migração registrada e colunas email/password_hash ausentes
    const preHistory = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(preHistory.rows[0].cnt).toBe(1);

    const preCols = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'perfis' AND column_name IN ('email', 'password_hash');"
    );
    expect(preCols.rows.length).toBe(0);

    // Executa o lançador da etapa 2
    const result = await executeControlledStep2Migration({
      confirmation: 'CONFIRMAR',
      sqlInstance: sql,
      logger: (msg: string) => logs.push(msg),
    });

    expect(result.success).toBe(true);
    expect(result.appliedCount).toBe(1);
    expect(result.skippedCount).toBe(1); // 0000 pulada!
    expect(result.step).toBe(2);
    expect(result.scriptName).toBe('drizzle/0001_dry_talos.sql');

    // 1. Confirma que a migração 0000 foi pulada e não reaplicada
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0000_greedy_loki.sql'))).toBe(true);

    // 2. Confirma histórico final com exatamente 2 registros ordenados
    const historyRes = await db.query('SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations ORDER BY ordem ASC;');
    expect(historyRes.rows.length).toBe(2);
    expect(historyRes.rows[0].ordem).toBe(1);
    expect(historyRes.rows[0].rel_path).toBe('drizzle/0000_greedy_loki.sql');
    expect(historyRes.rows[1].ordem).toBe(2);
    expect(historyRes.rows[1].rel_path).toBe('drizzle/0001_dry_talos.sql');
    expect(historyRes.rows[1].sha256).toBe('8e82452e0071ee1ce5a1e38569ef8f69a0851ae3d8e229ebfd1b4969e3db9180');

    // 3. Confirma que as colunas email e password_hash foram criadas em perfis
    const postCols = await db.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'perfis' AND column_name IN ('email', 'password_hash') ORDER BY column_name ASC;"
    );
    expect(postCols.rows.length).toBe(2);
    expect(postCols.rows[0].column_name).toBe('email');
    expect(postCols.rows[1].column_name).toBe('password_hash');

    // 4. Confirma restrição UNIQUE em perfis(email)
    const uniqueConst = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'public.perfis'::regclass AND conname = 'perfis_email_unique';"
    );
    expect(uniqueConst.rows.length).toBe(1);

    // 5. Confirma que a migração 0002 NÃO foi executada (coluna vestibular em acervo_arquivos não existe)
    const colVestibular = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'acervo_arquivos' AND column_name = 'vestibular';"
    );
    expect(colVestibular.rows.length).toBe(0);

    // 6. Confirma parada obrigatória no portão operacional (untilStep = 2)
    expect(logs.some((l) => l.includes('[STOP] Interrupção planejada no portão operacional (untilStep = 2)'))).toBe(true);
  });

  it('5. Demonstra idempotência completa em re-execução (ambas as etapas puladas com segurança)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithStep0Applied();

    // Primeira execução do step 2
    await executeControlledStep2Migration({
      confirmation: 'CONFIRMAR',
      sqlInstance: sql,
      logger: () => {},
    });

    // Segunda execução consecutiva
    const logs2: string[] = [];
    const retryResult = await executeControlledStep2Migration({
      confirmation: 'CONFIRMAR',
      sqlInstance: sql,
      logger: (msg: string) => logs2.push(msg),
    });

    expect(retryResult.appliedCount).toBe(0);
    expect(retryResult.skippedCount).toBe(2); // Ambas 0000 e 0001 puladas!
    expect(logs2.some((l) => l.includes('[SKIP]') && l.includes('0001_dry_talos.sql'))).toBe(true);

    // Total de registros permanece 2
    const countRes = await db.query('SELECT count(*)::int AS total FROM public._medicina_staging_migrations;');
    expect(countRes.rows[0].total).toBe(2);
  });

  it('6. Falha durante DDL de 0001 reverte transação atomicamente via ROLLBACK', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithStep0Applied();

    // Adaptador que simula erro durante o DDL de perfis
    const failDdlAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => sql(strings, ...values),
      {
        unsafe: async (query: string) => {
          if (query.includes('ALTER TABLE "perfis" ADD COLUMN "email"')) {
            throw new Error('SIMULATED_DDL_ERROR: Falha intencional de DDL durante alteração de perfis.');
          }
          return sql.unsafe(query);
        },
        reserve: async () => failDdlAdapter,
        release: () => {},
      }
    );

    await expect(
      executeControlledStep2Migration({
        confirmation: 'CONFIRMAR',
        sqlInstance: failDdlAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_DDL_ERROR/);

    // Comprova que o ROLLBACK manteve perfis intacto e histórico com apenas 1 registro
    const cols = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'perfis' AND column_name = 'email';"
    );
    expect(cols.rows.length).toBe(0); // Coluna email não foi adicionada!

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(1); // Histórico preservado com apenas etapa 1!
  });

  it('7. Falha durante tracking de 0001 reverte transação atomicamente desfazendo as colunas criadas', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithStep0Applied();

    // Adaptador que simula erro no INSERT de tracking da etapa 2
    const failTrackingAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
        const q = typeof strings === 'string' ? strings : strings[0];
        if (q.includes('INSERT INTO public._medicina_staging_migrations')) {
          throw new Error('SIMULATED_TRACKING_FAILURE: Falha ao inserir registro da migração 2.');
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
      executeControlledStep2Migration({
        confirmation: 'CONFIRMAR',
        sqlInstance: failTrackingAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_TRACKING_FAILURE/);

    // Comprova que as colunas em perfis foram desfeitas pelo ROLLBACK atômico
    const cols = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'perfis' AND column_name IN ('email', 'password_hash');"
    );
    expect(cols.rows.length).toBe(0);

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(1);
  });
});
