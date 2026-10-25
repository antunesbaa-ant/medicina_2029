import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import {
  executeStagingMigrations,
  getMigrationManifest,
  stripOuterTransaction,
} from '../../../scripts/db/migrate-staging.mjs';

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

function createSqlAdapter(db: PGliteInstance): SqlAdapter {
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
  return sqlAdapter;
}

/**
 * Cria banco PostgreSQL descartável (PGlite) com etapas 1 a 6 aplicadas sequencialmente
 * e simula o catálogo gerenciado do Supabase Cloud (storage.buckets com bucket acervo privado).
 */
async function createSupabaseSimulatedDbWithSteps1To6Applied(options?: {
  bucketPublic?: boolean;
  omitBucket?: boolean;
  omitStorageCatalog?: boolean;
}): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
  const db = new PGlite({
    extensions: { vector },
  });

  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;
  `);

  // 1. Tabela de controle de migrações de staging
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

  // 2. Aplicação sequencial das migrações 1 a 6
  const initialMigrations = [
    { file: 'drizzle/0000_greedy_loki.sql', ordem: 1 },
    { file: 'drizzle/0001_dry_talos.sql', ordem: 2 },
    { file: 'drizzle/0002_little_swarm.sql', ordem: 3 },
    { file: 'drizzle/0003_f1_03_r_expansao.sql', ordem: 4 },
    { file: 'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql', ordem: 5 },
    { file: 'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql', ordem: 6 },
  ];

  const manifest = getMigrationManifest();

  for (const m of initialMigrations) {
    const rawSql = readFileSync(path.resolve(process.cwd(), m.file), 'utf8');
    const cleanSql = stripOuterTransaction(rawSql);
    await db.exec(cleanSql);

    const mInfo = manifest.find((item) => item.ordem === m.ordem)!;
    await db.exec(`
      INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
      VALUES (${m.ordem}, '${m.file}', '${mInfo.sha256}', 'postgres', ${mInfo.tamanhoBytes});
    `);
  }

  // 3. Simulação do Catálogo Nativo do Supabase Storage
  if (!options?.omitStorageCatalog) {
    await db.exec(`
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
    `);

    if (!options?.omitBucket) {
      const isPublic = options?.bucketPublic ?? false;
      await db.exec(`
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES ('acervo', 'acervo', ${isPublic}, 20971520, ARRAY['application/pdf']::text[])
        ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;
      `);
    }
  }

  const sqlAdapter = createSqlAdapter(db);
  return { db, sql: sqlAdapter };
}

describe('MEDICINA 2029 — H1.07-R: Ciclo de Vida e Validação de Storage F1.10 em PostgreSQL Descartável', () => {
  it('1. Aplica sequencialmente as etapas 1 a 6 e executa F1.10 com sucesso mantendo isolamento da etapa 8', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    const logs: string[] = [];

    // Confere estado inicial: exatamente 6 migrações no histórico
    const preHistory = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(preHistory.rows[0].cnt).toBe(6);

    // Confere que a função de validação de storage e a constraint ainda não existem
    const preProc = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(preProc.rows[0].fn).toBeNull();

    const preConstraint = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'acervo_arquivos_file_path_format_check';"
    );
    expect(preConstraint.rows.length).toBe(0);

    // Executa o runner com portão operacional estrito untilStep = 7
    const manifest = getMigrationManifest();
    const result = await executeStagingMigrations({
      sql,
      manifest,
      isDryRun: false,
      untilStep: 7,
      logger: (msg: string) => logs.push(msg),
    });

    expect(result.appliedCount).toBe(1);
    expect(result.skippedCount).toBe(6);
    expect(result.total).toBe(9);

    // Confirma que as etapas 1 a 6 foram devidamente puladas com [SKIP]
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0000_greedy_loki.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0001_dry_talos.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0002_little_swarm.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0003_f1_03_r_expansao.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('F1_04_RLS_PROPOSTA.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'))).toBe(true);

    // Confirma que a tabela de histórico contém exatamente 7 registros ordenados
    const historyRes = await db.query(
      'SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations ORDER BY ordem ASC;'
    );
    expect(historyRes.rows.length).toBe(7);
    expect(historyRes.rows.map((r) => r.ordem)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(historyRes.rows[6].rel_path).toBe('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql');

    const expectedSha256 = manifest.find((m) => m.ordem === 7)?.sha256;
    expect(historyRes.rows[6].sha256).toBe(expectedSha256);

    // Confirma criação da função de validação no schema medicina
    const procCheck = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(procCheck.rows[0].fn).not.toBeNull();

    // Confirma criação e validação da constraint em public.acervo_arquivos
    const constraintCheck = await db.query(`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conrelid = 'public.acervo_arquivos'::regclass
        AND conname = 'acervo_arquivos_file_path_format_check';
    `);
    expect(constraintCheck.rows.length).toBe(1);
    expect(constraintCheck.rows[0].convalidated).toBe(true);

    // Confirma que a etapa 8 (F1_11_FILA_INGESTAO_PROPOSTA.sql / acervo_jobs) NÃO foi executada
    const jobsCheck = await db.query("SELECT to_regclass('public.acervo_jobs') as tbl;");
    expect(jobsCheck.rows[0].tbl).toBeNull();

    // Confirma parada obrigatória no portão operacional (untilStep = 7)
    expect(logs.some((l) => l.includes('[STOP] Interrupção planejada no portão operacional (untilStep = 7)'))).toBe(true);
  });

  it('2. Preflight Fail-Closed: Aborta com código P0001 se o bucket "acervo" for ausente ou público', async () => {
    // 2.1 Caso A: Bucket acervo ausente no catálogo
    const { sql: sqlMissingBucket } = await createSupabaseSimulatedDbWithSteps1To6Applied({ omitBucket: true });
    await expect(
      executeStagingMigrations({
        sql: sqlMissingBucket,
        untilStep: 7,
        logger: () => {},
      })
    ).rejects.toThrowError(/Bucket acervo inexistente ou não configurado como privado/);

    // 2.2 Caso B: Bucket acervo configurado com public = true
    const { sql: sqlPublicBucket } = await createSupabaseSimulatedDbWithSteps1To6Applied({ bucketPublic: true });
    await expect(
      executeStagingMigrations({
        sql: sqlPublicBucket,
        untilStep: 7,
        logger: () => {},
      })
    ).rejects.toThrowError(/Bucket acervo inexistente ou não configurado como privado/);

    // 2.3 Caso C: Catálogo storage.buckets ausente
    const { sql: sqlMissingCatalog } = await createSupabaseSimulatedDbWithSteps1To6Applied({ omitStorageCatalog: true });
    await expect(
      executeStagingMigrations({
        sql: sqlMissingCatalog,
        untilStep: 7,
        logger: () => {},
      })
    ).rejects.toThrowError(/Bucket acervo inexistente ou não configurado como privado/);
  });

  it('3. Preflight Fail-Closed: Aborta com erro P0001 se existirem dados anômalos em acervo_arquivos', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();

    // Cria perfil e disciplina válidos para permitir inserção de dados legados
    await db.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, papel)
      VALUES ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Resp Legado', 'responsavel')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.disciplinas (id, nome, area, cor_hex, ordem)
      VALUES ('00000000-0000-0000-0000-000000000001', 'Biologia', 'natureza', '#00FF00', 1)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Insere registro com MIME inválido em public.acervo_arquivos
    await db.exec(`
      INSERT INTO public.acervo_arquivos (
        disciplina_id, titulo, tipo_material, serie_alvo, file_path, mime, tamanho_bytes, enviado_por, hash_conteudo
      ) VALUES (
        '00000000-0000-0000-0000-000000000001', 'Legado Inválido', 'livro', 1,
        'acervo/${'a'.repeat(64)}.doc', 'application/msword', 5000,
        '10000000-0000-0000-0000-000000000001', '${'a'.repeat(64)}'
      );
    `);

    await expect(
      executeStagingMigrations({
        sql,
        untilStep: 7,
        logger: () => {},
      })
    ).rejects.toThrowError(/F1\.10 Storage Policies abortada: existem registros em acervo_arquivos fora dos limites/);
  });

  it('4. Validação da Constraint de Integridade acervo_arquivos_file_path_format_check', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    // Registra dados base para testes de INSERT
    const perfilId = '10000000-0000-0000-0000-000000000001';
    const disciplinaId = '00000000-0000-0000-0000-000000000001';

    await db.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, papel)
      VALUES ('${perfilId}', '${perfilId}', 'Responsável Validador', 'responsavel')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.disciplinas (id, nome, area, cor_hex, ordem)
      VALUES ('${disciplinaId}', 'Matemática', 'matematica', '#0000FF', 1)
      ON CONFLICT (id) DO NOTHING;
    `);

    const validHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    // 4.1 Rejeita Directory Traversal ("..")
    await expect(
      db.exec(`
        INSERT INTO public.acervo_arquivos (
          disciplina_id, titulo, tipo_material, serie_alvo, file_path, mime, tamanho_bytes, enviado_por, hash_conteudo
        ) VALUES (
          '${disciplinaId}', 'Ataque Traversal', 'livro', 1,
          'acervo/../arquivo.pdf', 'application/pdf', 1024,
          '${perfilId}', '${validHash}'
        );
      `)
    ).rejects.toThrowError(/acervo_arquivos_file_path_format_check/);

    // 4.2 Rejeita extensão não-PDF (".doc")
    await expect(
      db.exec(`
        INSERT INTO public.acervo_arquivos (
          disciplina_id, titulo, tipo_material, serie_alvo, file_path, mime, tamanho_bytes, enviado_por, hash_conteudo
        ) VALUES (
          '${disciplinaId}', 'Documento Word', 'livro', 1,
          'acervo/invalido.doc', 'application/pdf', 1024,
          '${perfilId}', '${validHash}'
        );
      `)
    ).rejects.toThrowError(/acervo_arquivos_file_path_format_check/);

    // 4.3 Rejeita caminhos com contra-barra ("\")
    await expect(
      db.exec(`
        INSERT INTO public.acervo_arquivos (
          disciplina_id, titulo, tipo_material, serie_alvo, file_path, mime, tamanho_bytes, enviado_por, hash_conteudo
        ) VALUES (
          '${disciplinaId}', 'Contra Barra', 'livro', 1,
          E'acervo\\\\${validHash}.pdf', 'application/pdf', 1024,
          '${perfilId}', '${validHash}'
        );
      `)
    ).rejects.toThrowError(/acervo_arquivos_file_path_format_check/);

    // 4.4 Rejeita barras duplas ("//")
    await expect(
      db.exec(`
        INSERT INTO public.acervo_arquivos (
          disciplina_id, titulo, tipo_material, serie_alvo, file_path, mime, tamanho_bytes, enviado_por, hash_conteudo
        ) VALUES (
          '${disciplinaId}', 'Barra Dupla', 'livro', 1,
          'acervo//${validHash}.pdf', 'application/pdf', 1024,
          '${perfilId}', '${validHash}'
        );
      `)
    ).rejects.toThrowError(/acervo_arquivos_file_path_format_check/);

    // 4.5 Aceita caminho canônico determinístico (acervo/<sha256>.pdf)
    const canonicalPath = `acervo/${validHash}.pdf`;
    await db.exec(`
      INSERT INTO public.acervo_arquivos (
        disciplina_id, titulo, tipo_material, serie_alvo, file_path, mime, tamanho_bytes, enviado_por, hash_conteudo
      ) VALUES (
        '${disciplinaId}', 'Arquivo Canônico Válido', 'livro', 1,
        '${canonicalPath}', 'application/pdf', 2048,
        '${perfilId}', '${validHash}'
      );
    `);

    const insertedRow = await db.query(`SELECT file_path FROM public.acervo_arquivos WHERE file_path = '${canonicalPath}';`);
    expect(insertedRow.rows.length).toBe(1);
    expect(insertedRow.rows[0].file_path).toBe(canonicalPath);

    // 4.6 Aceita caminho canônico com sufixo de desambiguação
    const disambiguatedHash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const disambiguatedPath = `acervo/${disambiguatedHash}_versao-1.0.pdf`;
    await db.exec(`
      INSERT INTO public.acervo_arquivos (
        disciplina_id, titulo, tipo_material, serie_alvo, file_path, mime, tamanho_bytes, enviado_por, hash_conteudo
      ) VALUES (
        '${disciplinaId}', 'Arquivo Desambiguado Válido', 'apostila', 2,
        '${disambiguatedPath}', 'application/pdf', 4096,
        '${perfilId}', '${disambiguatedHash}'
      );
    `);

    const insertedDisambiguated = await db.query(
      `SELECT file_path FROM public.acervo_arquivos WHERE file_path = '${disambiguatedPath}';`
    );
    expect(insertedDisambiguated.rows.length).toBe(1);
  });

  it('5. Validação da Função Canônica medicina.is_valid_acervo_storage_path (Propriedades e Privilégios)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    // 5.1 Volatilidade IMMUTABLE e search_path seguro
    const procRes = await db.query(`
      SELECT
        p.provolatile,
        p.prosecdef,
        p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'medicina' AND p.proname = 'is_valid_acervo_storage_path';
    `);
    expect(procRes.rows.length).toBe(1);
    expect(procRes.rows[0].provolatile).toBe('i'); // 'i' = IMMUTABLE
    expect(procRes.rows[0].prosecdef).toBe(false); // NÃO é SECURITY DEFINER
    expect(procRes.rows[0].proconfig).toEqual(['search_path=pg_catalog, medicina, pg_temp']);

    // 5.2 Avaliação direta da função SQL para cenários de fronteira
    const hash64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    const testCases = [
      { path: `acervo/${hash64}.pdf`, expected: true },
      { path: `acervo/${hash64}_anexo.pdf`, expected: true },
      { path: `acervo/${hash64}_123-abc.pdf`, expected: true },
      { path: `acervo/${hash64}.PDF`, expected: false }, // maiúsculas rejeitadas
      { path: `acervo/${hash64.toUpperCase()}.pdf`, expected: false }, // hex em maiúsculas rejeitado
      { path: 'acervo/../arquivo.pdf', expected: false },
      { path: 'acervo//dupla.pdf', expected: false },
      { path: 'acervo\\barra.pdf', expected: false },
      { path: 'arquivo.pdf', expected: false },
      { path: `outrobucket/${hash64}.pdf`, expected: false },
      { path: null, expected: false },
      { path: '', expected: false },
    ];

    for (const tc of testCases) {
      const q = tc.path === null
        ? 'SELECT medicina.is_valid_acervo_storage_path(NULL) AS valid;'
        : `SELECT medicina.is_valid_acervo_storage_path('${tc.path}') AS valid;`;
      const res = await db.query(q);
      expect(res.rows[0].valid).toBe(tc.expected);
    }
  });

  it('6. Rollback Atômico e Simétrico (F1_10_ROLLBACK_STORAGE_POLICIES.sql)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    // Confirma estado pré-rollback
    const preProc = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(preProc.rows[0].fn).not.toBeNull();

    const preConstraint = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'acervo_arquivos_file_path_format_check';"
    );
    expect(preConstraint.rows.length).toBe(1);

    // Executa rollback atômico
    const rollbackSql = readFileSync(
      path.resolve(process.cwd(), 'docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql'),
      'utf8'
    );
    await db.exec(rollbackSql);

    // Confirma que a constraint foi removida
    const postConstraint = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'acervo_arquivos_file_path_format_check';"
    );
    expect(postConstraint.rows.length).toBe(0);

    // Confirma que a função foi removida
    const postProc = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(postProc.rows[0].fn).toBeNull();

    // Confirma que a tabela public.acervo_arquivos continua existindo e operacional
    const tableCheck = await db.query("SELECT to_regclass('public.acervo_arquivos') as tbl;");
    expect(tableCheck.rows[0].tbl).not.toBeNull();

    // Idempotência do rollback: executar novamente não deve gerar erros
    await expect(db.exec(rollbackSql)).resolves.not.toThrow();
  });

  it('7. Re-execução Idempotente e Reversibilidade da Migração F1.10', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();

    // 1. Aplicação inicial
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    // 2. Re-execução imediata do runner com untilStep = 7 (deve pular as 7 etapas)
    const retryLogs: string[] = [];
    const retryResult = await executeStagingMigrations({
      sql,
      untilStep: 7,
      logger: (msg: string) => retryLogs.push(msg),
    });

    expect(retryResult.appliedCount).toBe(0);
    expect(retryResult.skippedCount).toBe(7);
    expect(retryLogs.filter((l) => l.includes('[SKIP]')).length).toBe(7);

    // 3. Rollback atômico
    const rollbackSql = readFileSync(
      path.resolve(process.cwd(), 'docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql'),
      'utf8'
    );
    await db.exec(rollbackSql);

    // 4. Remove o registro da etapa 7 do histórico para permitir reaplicação
    await db.exec("DELETE FROM public._medicina_staging_migrations WHERE ordem = 7;");

    // 5. Reaplicação com sucesso
    const reapplyResult = await executeStagingMigrations({
      sql,
      untilStep: 7,
      logger: () => {},
    });

    expect(reapplyResult.appliedCount).toBe(1);
    expect(reapplyResult.skippedCount).toBe(6);

    const reapplyProc = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(reapplyProc.rows[0].fn).not.toBeNull();

    const reapplyConstraint = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'acervo_arquivos_file_path_format_check';"
    );
    expect(reapplyConstraint.rows.length).toBe(1);
  });

  it('8. Probe 7: Detecta estado intermediário fail-closed (constraint presente sem histórico)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();

    // Aplica apenas a função e a constraint manualmente sem gravar na tabela de histórico
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS medicina;
      CREATE OR REPLACE FUNCTION medicina.is_valid_acervo_storage_path(p_name text)
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true; $$;

      ALTER TABLE public.acervo_arquivos
        ADD CONSTRAINT acervo_arquivos_file_path_format_check
        CHECK (medicina.is_valid_acervo_storage_path(file_path)) NOT VALID;
    `);

    await expect(
      executeStagingMigrations({
        sql,
        untilStep: 7,
        logger: () => {},
      })
    ).rejects.toThrowError(/ESTADO INTERMEDIÁRIO DETECTADO.*migração \[7\]/);
  });
});
