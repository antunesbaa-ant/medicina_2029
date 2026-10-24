import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

import {
  executeControlledStep1Migration,
  TARGET_PROJECT_REF,
  TARGET_HOST,
  TARGET_PORT,
  TARGET_USERNAME,
  TARGET_STEP,
  TARGET_SCRIPT_NAME,
} from '../../../scripts/db/apply-staging-step1.mjs';

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

async function createSupabaseSimulatedDb(): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
  const db = new PGlite({
    extensions: { vector },
  });

  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;
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
      // uma conexão dedicada para queries e unsafe, mas NÃO possui o método .begin()!
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

describe('MEDICINA 2029 — Lançador Seguro da Migração 0000 (apply-staging-step1.mjs)', () => {
  it('1. Valida metadados e parâmetros operacionais fixos do lançador', () => {
    expect(TARGET_PROJECT_REF).toBe('ynfocaorhadizlvbnzrt');
    expect(TARGET_HOST).toBe('aws-0-us-east-1.pooler.supabase.com');
    expect(TARGET_PORT).toBe(5432);
    expect(TARGET_USERNAME).toBe('postgres.ynfocaorhadizlvbnzrt');
    expect(TARGET_STEP).toBe(1);
    expect(TARGET_SCRIPT_NAME).toBe('drizzle/0000_greedy_loki.sql');
  });

  it('2. Rejeita execução se confirmação humana explícita não for exatamente "CONFIRMAR"', async () => {
    const invalidConfirmations = ['sim', 'yes', 'CONFIRMA', 's', '', 'confirmar'];

    for (const conf of invalidConfirmations) {
      await expect(
        executeControlledStep1Migration({
          confirmation: conf,
          password: 'dummy',
        })
      ).rejects.toThrowError(/OPERAÇÃO CANCELADA: Confirmação humana explícita não fornecida/);
    }
  });

  it('3. Rejeita se o arquivo de certificado CA TLS não for localizado', async () => {
    await expect(
      executeControlledStep1Migration({
        confirmation: 'CONFIRMAR',
        password: 'dummy',
        caCertPath: '/caminho/comprovadamente/inexistente/ca.crt',
      })
    ).rejects.toThrowError(/Arquivo de certificado CA TLS não encontrado/);
  });

  it('4. Executa a primeira migração controlada em PostgreSQL descartável com sucesso (banco limpo)', async () => {
    const { db, sql } = await createSupabaseSimulatedDb();
    const logs: string[] = [];

    const result = await executeControlledStep1Migration({
      confirmation: 'CONFIRMAR',
      sqlInstance: sql,
      logger: (msg: string) => logs.push(msg),
    });

    expect(result.success).toBe(true);
    expect(result.appliedCount).toBe(1);
    expect(result.step).toBe(1);
    expect(result.scriptName).toBe('drizzle/0000_greedy_loki.sql');

    // 1. Confirma histórico de migrações: exatamente 1 registro
    const historyRes = await db.query('SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations;');
    expect(historyRes.rows.length).toBe(1);
    expect(historyRes.rows[0].ordem).toBe(1);
    expect(historyRes.rows[0].rel_path).toBe('drizzle/0000_greedy_loki.sql');

    // 2. Confirma contagem de tabelas em public: 32 da aplicação + 1 de tracking = 33
    const tablesRes = await db.query(
      "SELECT count(*)::int AS cnt FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';"
    );
    expect(tablesRes.rows[0].cnt).toBe(33);

    // 3. Confirma que a tabela allowlist possui exatamente os 2 e-mails sintéticos autorizados
    const allowlistRes = await db.query('SELECT email FROM public.allowlist ORDER BY email ASC;');
    expect(allowlistRes.rows.length).toBe(2);
    expect(allowlistRes.rows[0].email).toBe('estudante@medicina2029.com.br');
    expect(allowlistRes.rows[1].email).toBe('responsavel@medicina2029.com.br');

    // 4. Confirma que a etapa 2 NÃO foi executada (coluna email em perfis ainda não existe)
    const perfisCols = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'perfis' AND column_name = 'email';"
    );
    expect(perfisCols.rows.length).toBe(0);

    // 5. Confirma presença da mensagem de interrupção operacional planejada nos logs
    expect(logs.some((l) => l.includes('[STOP] Interrupção planejada no portão operacional (untilStep = 1)'))).toBe(true);
  });

  it('5. Cenário Real do Staging: histórico previamente criado e vazio não impede a execução da migração 0000', async () => {
    const { db, sql } = await createSupabaseSimulatedDb();

    // 1. Simula o estado exato do banco remoto: _medicina_staging_migrations existe e está vazia
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

    // Confere estado pré-migração idêntico ao reportado no Supabase SQL Editor:
    const preCount = await db.query(
      "SELECT count(*)::int AS cnt FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';"
    );
    expect(preCount.rows[0].cnt).toBe(1); // Apenas _medicina_staging_migrations

    const preRows = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(preRows.rows[0].cnt).toBe(0); // Tabela vazia

    const prePerfis = await db.query("SELECT to_regclass('public.perfis') as tbl;");
    expect(prePerfis.rows[0].tbl).toBeNull(); // perfis não existe

    const preAcervo = await db.query("SELECT to_regclass('public.acervo_arquivos') as tbl;");
    expect(preAcervo.rows[0].tbl).toBeNull(); // acervo_arquivos não existe

    // 2. Executa a migração através do lançador seguro
    const logs: string[] = [];
    const result = await executeControlledStep1Migration({
      confirmation: 'CONFIRMAR',
      sqlInstance: sql,
      logger: (msg: string) => logs.push(msg),
    });

    expect(result.success).toBe(true);
    expect(result.appliedCount).toBe(1);
    expect(result.step).toBe(1);

    // 3. Confirma pós-migração: 32 tabelas de negócio criadas + 1 de tracking = 33 tabelas
    const postCount = await db.query(
      "SELECT count(*)::int AS cnt FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';"
    );
    expect(postCount.rows[0].cnt).toBe(33);

    // Confirma que perfis e acervo_arquivos agora existem
    const postPerfis = await db.query("SELECT to_regclass('public.perfis') as tbl;");
    expect(postPerfis.rows[0].tbl).not.toBeNull();

    const postAcervo = await db.query("SELECT to_regclass('public.acervo_arquivos') as tbl;");
    expect(postAcervo.rows[0].tbl).not.toBeNull();

    // Confirma que _medicina_staging_migrations possui exatamente 1 registro
    const postHistory = await db.query('SELECT ordem, rel_path FROM public._medicina_staging_migrations;');
    expect(postHistory.rows.length).toBe(1);
    expect(postHistory.rows[0].ordem).toBe(1);
    expect(postHistory.rows[0].rel_path).toBe('drizzle/0000_greedy_loki.sql');

    // Confirma que a migração 0001 NÃO foi aplicada
    const perfisCols = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'perfis' AND column_name = 'email';"
    );
    expect(perfisCols.rows.length).toBe(0);
  });

  it('6. Demonstra idempotência completa do lançador em re-execução (retry)', async () => {
    const { db, sql } = await createSupabaseSimulatedDb();

    // Primeira execução
    await executeControlledStep1Migration({
      confirmation: 'CONFIRMAR',
      sqlInstance: sql,
      logger: () => {},
    });

    // Segunda execução consecutiva
    const logs2: string[] = [];
    const retryResult = await executeControlledStep1Migration({
      confirmation: 'CONFIRMAR',
      sqlInstance: sql,
      logger: (msg: string) => logs2.push(msg),
    });

    expect(retryResult.appliedCount).toBe(0);
    expect(retryResult.skippedCount).toBe(1);
    expect(logs2.some((l) => l.includes('[SKIP]') && l.includes('0000_greedy_loki.sql'))).toBe(true);

    // Total de registros no histórico permanece exatamente 1
    const countRes = await db.query('SELECT count(*)::int AS total FROM public._medicina_staging_migrations;');
    expect(countRes.rows[0].total).toBe(1);
  });

  it('7. Falha durante DDL reverte transação atomicamente via ROLLBACK sem deixar tabelas orfãs', async () => {
    const { db, sql } = await createSupabaseSimulatedDb();

    // Cria adaptador que lança erro durante o DDL da tabela acervo_arquivos
    const failDdlAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => sql(strings, ...values),
      {
        unsafe: async (query: string) => {
          if (query.includes('CREATE TABLE "acervo_arquivos"')) {
            throw new Error('SIMULATED_DDL_ERROR: Falha intencional de sintaxe ou privilégio durante DDL.');
          }
          return sql.unsafe(query);
        },
        reserve: async () => failDdlAdapter,
        release: () => {},
      }
    );

    await expect(
      executeControlledStep1Migration({
        confirmation: 'CONFIRMAR',
        sqlInstance: failDdlAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_DDL_ERROR/);

    // Comprova que o ROLLBACK reverteu tudo: nenhuma tabela foi criada e nenhum histórico foi salvo
    const tablesCount = await db.query(
      "SELECT count(*)::int AS cnt FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';"
    );
    // Apenas a tabela de histórico (criada antes da tentativa) existe
    expect(tablesCount.rows[0].cnt).toBe(1);

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(0); // Tracking não foi gravado!
  });

  it('8. Falha durante tracking reverte transação atomicamente via ROLLBACK desfazendo o DDL', async () => {
    const { db, sql } = await createSupabaseSimulatedDb();

    // Cria adaptador que lança erro no INSERT de tracking
    const failTrackingAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
        const q = typeof strings === 'string' ? strings : strings[0];
        if (q.includes('INSERT INTO public._medicina_staging_migrations')) {
          throw new Error('SIMULATED_TRACKING_FAILURE: Falha intencional ao inserir registro no histórico.');
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
      executeControlledStep1Migration({
        confirmation: 'CONFIRMAR',
        sqlInstance: failTrackingAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_TRACKING_FAILURE/);

    // Comprova que o DDL foi completamente revertido pelo ROLLBACK
    const perfisCheck = await db.query("SELECT to_regclass('public.perfis') as tbl;");
    expect(perfisCheck.rows[0].tbl).toBeNull(); // Tabela perfis desfeita!

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(0);
  });
});
