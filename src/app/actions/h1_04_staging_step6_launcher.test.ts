import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import {
  executeControlledStep6Migration,
  TARGET_PROJECT_REF,
  TARGET_HOST,
  TARGET_PORT,
  TARGET_USERNAME,
  TARGET_STEP,
  TARGET_SCRIPT_NAME,
  EXPECTED_CONFIRMATION_TOKEN,
  RUNNER_COMMAND,
  RUNNER_ARGS,
} from '../../../scripts/db/apply-staging-step6.mjs';

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

async function createSupabaseSimulatedDbWithSteps1To5Applied(): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
  const db = new PGlite({
    extensions: { vector },
  });

  // Configuração inicial simulando Supabase gerenciado
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;
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

  // 2. Aplica DDL da migração 0000
  const sql0Path = path.resolve(process.cwd(), 'drizzle/0000_greedy_loki.sql');
  const cleanSql0 = stripOuterTransaction(readFileSync(sql0Path, 'utf8'));
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

  // 4. Aplica DDL da migração 0001
  const sql1Path = path.resolve(process.cwd(), 'drizzle/0001_dry_talos.sql');
  const cleanSql1 = stripOuterTransaction(readFileSync(sql1Path, 'utf8'));
  await db.exec(cleanSql1);

  // 5. Registra migração 0001 no histórico
  await db.exec(`
    INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
    VALUES (
      2,
      'drizzle/0001_dry_talos.sql',
      '8e82452e0071ee1ce5a1e38569ef8f69a0851ae3d8e229ebfd1b4969e3db9180',
      'postgres',
      238
    );
  `);

  // 6. Aplica DDL da migração 0002
  const sql2Path = path.resolve(process.cwd(), 'drizzle/0002_little_swarm.sql');
  const cleanSql2 = stripOuterTransaction(readFileSync(sql2Path, 'utf8'));
  await db.exec(cleanSql2);

  // 7. Registra migração 0002 no histórico
  await db.exec(`
    INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
    VALUES (
      3,
      'drizzle/0002_little_swarm.sql',
      'c3ce3d3b1335bedb2deb46e2c14c018fe15370b60e7fdc415def17cb9de0343b',
      'postgres',
      66
    );
  `);

  // 8. Aplica DDL da migração 0003
  const sql3Path = path.resolve(process.cwd(), 'drizzle/0003_f1_03_r_expansao.sql');
  const cleanSql3 = stripOuterTransaction(readFileSync(sql3Path, 'utf8'));
  await db.exec(cleanSql3);

  // 9. Registra migração 0003 no histórico
  await db.exec(`
    INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
    VALUES (
      4,
      'drizzle/0003_f1_03_r_expansao.sql',
      '32be49be0da8ed6c675657ef0ecf14f54951491df0176cb66f1a450b8bab4e3f',
      'postgres',
      11541
    );
  `);

  // 10. Aplica DDL da migração 5 (F1.04 RLS)
  const sql4Path = path.resolve(process.cwd(), 'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql');
  const cleanSql4 = stripOuterTransaction(readFileSync(sql4Path, 'utf8'));
  await db.exec(cleanSql4);

  // 11. Registra migração 5 no histórico
  await db.exec(`
    INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
    VALUES (
      5,
      'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql',
      '8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f',
      'postgres',
      45758
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

describe('MEDICINA 2029 — Lançador Seguro da Migração F1.09 Integridade e Idempotência (apply-staging-step6.mjs)', () => {
  it('1. Valida metadados e parâmetros operacionais fixos do lançador', () => {
    expect(TARGET_PROJECT_REF).toBe('ynfocaorhadizlvbnzrt');
    expect(TARGET_HOST).toBe('aws-0-us-east-1.pooler.supabase.com');
    expect(TARGET_PORT).toBe(5432);
    expect(TARGET_USERNAME).toBe('postgres.ynfocaorhadizlvbnzrt');
    expect(TARGET_STEP).toBe(6);
    expect(TARGET_SCRIPT_NAME).toBe('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql');
    expect(EXPECTED_CONFIRMATION_TOKEN).toBe('APLICAR ETAPA 6 EM STAGING');
    expect(RUNNER_ARGS).toEqual(['--apply', '--until-step=6']);
    expect(RUNNER_COMMAND).toBe('CONFIRM_STAGING_MIGRATIONS=true node scripts/db/migrate-staging.mjs --apply --until-step=6');
  });

  it('2. Rejeita execução se confirmação humana explícita não for exatamente "APLICAR ETAPA 6 EM STAGING"', async () => {
    const invalidConfirmations = [
      'CONFIRMAR',
      'sim',
      'yes',
      'APLICAR ETAPA 6',
      'aplicar etapa 6 em staging',
      's',
      '',
      'APLICAR',
    ];

    for (const conf of invalidConfirmations) {
      await expect(
        executeControlledStep6Migration({
          confirmation: conf,
          password: 'dummy',
        })
      ).rejects.toThrowError(/OPERAÇÃO CANCELADA: Confirmação humana explícita não fornecida/);
    }
  });

  it('3. Rejeita se o arquivo de certificado CA TLS não for localizado', async () => {
    await expect(
      executeControlledStep6Migration({
        confirmation: 'APLICAR ETAPA 6 EM STAGING',
        password: 'dummy',
        caCertPath: '/caminho/comprovadamente/inexistente/ca.crt',
      })
    ).rejects.toThrowError(/Arquivo de certificado CA TLS não encontrado/);
  });

  it('4. Executa exclusivamente a migração 6 (F1.09) com etapas 1 a 5 previamente aplicadas', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();
    const logs: string[] = [];

    // Confere estado prévio: 5 migrações no histórico e tabela operacoes_idempotentes inexistente
    const preHistory = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(preHistory.rows[0].cnt).toBe(5);

    const preTable = await db.query("SELECT to_regclass('public.operacoes_idempotentes') as tbl;");
    expect(preTable.rows[0].tbl).toBeNull();

    // Executa o lançador da etapa 6
    const result = await executeControlledStep6Migration({
      confirmation: 'APLICAR ETAPA 6 EM STAGING',
      sqlInstance: sql,
      logger: (msg: string) => logs.push(msg),
    });

    expect(result.success).toBe(true);
    expect(result.appliedCount).toBe(1);
    expect(result.skippedCount).toBe(5); // 0000, 0001, 0002, 0003 e F1.04 RLS todas puladas!
    expect(result.step).toBe(6);
    expect(result.scriptName).toBe('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql');

    // 1. Confirma que as migrações 1 a 5 foram puladas
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0000_greedy_loki.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0001_dry_talos.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0002_little_swarm.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0003_f1_03_r_expansao.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('F1_04_RLS_PROPOSTA.sql'))).toBe(true);

    // 2. Confirma histórico final com exatamente 6 registros ordenados
    const historyRes = await db.query(
      'SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations ORDER BY ordem ASC;'
    );
    expect(historyRes.rows.length).toBe(6);
    expect(historyRes.rows[5].ordem).toBe(6);
    expect(historyRes.rows[5].rel_path).toBe('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql');
    expect(historyRes.rows[5].sha256).toBe('96187040783e236b64bb70c15b9bf57c7ad39feb3d100a571bfa0e01eb5b55d1');

    // 3. Confirma criação da tabela operacoes_idempotentes
    const tableCheck = await db.query("SELECT to_regclass('public.operacoes_idempotentes') as tbl;");
    expect(tableCheck.rows[0].tbl).not.toBeNull();

    // 4. Confirma parada obrigatória no portão operacional (untilStep = 6)
    expect(logs.some((l) => l.includes('[STOP] Interrupção planejada no portão operacional (untilStep = 6)'))).toBe(true);

    // 5. Confirma que a etapa 7 (F1_10_STORAGE_POLICIES_PROPOSTA.sql) NÃO foi executada
    const storageCheck = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(storageCheck.rows[0].fn).toBeNull();
  });

  it('5. Demonstra idempotência completa em re-execução (todas as 6 etapas puladas com segurança)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();

    // Primeira aplicação da etapa 6
    await executeControlledStep6Migration({
      confirmation: 'APLICAR ETAPA 6 EM STAGING',
      sqlInstance: sql,
      logger: () => {},
    });

    // Re-execução imediata
    const retryLogs: string[] = [];
    const retryResult = await executeControlledStep6Migration({
      confirmation: 'APLICAR ETAPA 6 EM STAGING',
      sqlInstance: sql,
      logger: (msg: string) => retryLogs.push(msg),
    });

    expect(retryResult.success).toBe(true);
    expect(retryResult.appliedCount).toBe(0);
    expect(retryResult.skippedCount).toBe(6); // Todas as 6 etapas puladas!
    expect(retryLogs.filter((l) => l.includes('[SKIP]')).length).toBe(6);

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(6);
  });

  it('6. Falha durante DDL de 0006 reverte transação atomicamente via ROLLBACK', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();

    // Adaptador que simula erro durante o DDL da tabela operacoes_idempotentes
    const failDdlAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => sql(strings, ...values),
      {
        unsafe: async (query: string) => {
          if (query.includes('operacoes_idempotentes')) {
            throw new Error('SIMULATED_DDL_ERROR: Falha de DDL durante migração F1.09.');
          }
          return sql.unsafe(query);
        },
        reserve: async () => failDdlAdapter,
        release: () => {},
      }
    );

    await expect(
      executeControlledStep6Migration({
        confirmation: 'APLICAR ETAPA 6 EM STAGING',
        sqlInstance: failDdlAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_DDL_ERROR/);

    // Comprova que o ROLLBACK reverteu a criação da tabela e o histórico permanece com 5 registros
    const tblCheck = await db.query("SELECT to_regclass('public.operacoes_idempotentes') as tbl;");
    expect(tblCheck.rows[0].tbl).toBeNull();

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(5); // Apenas etapas 1 a 5!
  });

  it('7. Falha durante tracking de 0006 reverte transação atomicamente desfazendo os objetos de F1.09', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();

    // Adaptador que simula erro no INSERT de tracking da etapa 6
    const failTrackingAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
        const q = typeof strings === 'string' ? strings : strings[0];
        if (q.includes('INSERT INTO public._medicina_staging_migrations')) {
          throw new Error('SIMULATED_TRACKING_FAILURE: Falha ao inserir registro da migração 6 no histórico.');
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
      executeControlledStep6Migration({
        confirmation: 'APLICAR ETAPA 6 EM STAGING',
        sqlInstance: failTrackingAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_TRACKING_FAILURE/);

    // Comprova que a tabela operacoes_idempotentes foi desfeita pelo ROLLBACK atômico
    const tblCheck = await db.query("SELECT to_regclass('public.operacoes_idempotentes') as tbl;");
    expect(tblCheck.rows[0].tbl).toBeNull();

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(5);
  });
});
