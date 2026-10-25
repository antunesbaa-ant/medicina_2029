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

async function createSupabaseSimulatedDbWithSteps1To6Applied(): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
  const db = new PGlite({
    extensions: { vector },
  });

  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;
  `);

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
    { file: 'drizzle/0000_greedy_loki.sql', ordem: 1, sha256: 'b1cf8d6741894a52543ca0edf7212dee9ee8945051cd01148ea60a3cbaf4b4c6', bytes: 24043 },
    { file: 'drizzle/0001_dry_talos.sql', ordem: 2, sha256: '8e82452e0071ee1ce5a1e38569ef8f69a0851ae3d8e229ebfd1b4969e3db9180', bytes: 238 },
    { file: 'drizzle/0002_little_swarm.sql', ordem: 3, sha256: 'c3ce3d3b1335bedb2deb46e2c14c018fe15370b60e7fdc415def17cb9de0343b', bytes: 66 },
    { file: 'drizzle/0003_f1_03_r_expansao.sql', ordem: 4, sha256: '32be49be0da8ed6c675657ef0ecf14f54951491df0176cb66f1a450b8bab4e3f', bytes: 11541 },
    { file: 'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql', ordem: 5, sha256: '8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f', bytes: 45758 },
    { file: 'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql', ordem: 6, sha256: '96187040783e236b64bb70c15b9bf57c7ad39feb3d100a571bfa0e01eb5b55d1', bytes: 11303 },
  ];

  for (const m of initialMigrations) {
    const rawSql = readFileSync(path.resolve(process.cwd(), m.file), 'utf8');
    const cleanSql = stripOuterTransaction(rawSql);
    await db.exec(cleanSql);

    await db.exec(`
      INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
      VALUES (${m.ordem}, '${m.file}', '${m.sha256}', 'postgres', ${m.bytes});
    `);
  }

  const sqlAdapter = createSqlAdapter(db);
  return { db, sql: sqlAdapter };
}

describe('MEDICINA 2029 — H1.07: Ciclo de Vida e Políticas de Storage da Migração F1.10 em PostgreSQL Descartável', () => {
  it('1. Aplicação Sequencial das Etapas 1 a 7 e confirmação de isolamento estrito da Etapa 8', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    const logs: string[] = [];

    // Confere estado inicial: exatamente 6 migrações no histórico
    const preRes = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(preRes.rows[0].cnt).toBe(6);

    // Executa runner com untilStep = 7
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

    // Confirma que a tabela de histórico contém exatamente 7 registros ordenados
    const historyRes = await db.query(
      'SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations ORDER BY ordem ASC;'
    );
    expect(historyRes.rows.length).toBe(7);
    expect(historyRes.rows.map((r) => r.ordem)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(historyRes.rows[6].rel_path).toBe('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql');
    expect(historyRes.rows[6].sha256).toBe('6b79d1bbfe2e18a664d6b383764a66ae8565738682a8f07b1954cfda4a795a9a');

    // Confirma que a função de storage foi criada
    const step7ProcCheck = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(step7ProcCheck.rows[0].fn).not.toBeNull();

    // Confirma que a etapa 8 (F1_11_FILA_INGESTAO_PROPOSTA.sql / acervo_jobs) NÃO foi aplicada
    const step8TableCheck = await db.query("SELECT to_regclass('public.acervo_jobs') as tbl;");
    expect(step8TableCheck.rows[0].tbl).toBeNull();

    // Confirma parada obrigatória no portão operacional (untilStep = 7)
    expect(logs.some((l) => l.includes('[STOP] Interrupção planejada no portão operacional (untilStep = 7)'))).toBe(true);
  });

  it('2. Estrutura Canônica das Tabelas de Storage (storage.buckets e storage.objects)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    // 2.1 Schema storage existe
    const schemaCheck = await db.query("SELECT to_regnamespace('storage') as nsp;");
    expect(schemaCheck.rows[0].nsp).not.toBeNull();

    // 2.2 Colunas e tipos em storage.buckets
    const bucketCols = await db.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'storage' AND table_name = 'buckets'
      ORDER BY ordinal_position;
    `);
    const bucketColMap = new Map(bucketCols.rows.map((r) => [r.column_name, r]));
    expect(bucketColMap.get('id')?.is_nullable).toBe('NO');
    expect(bucketColMap.get('name')?.is_nullable).toBe('NO');
    expect(bucketColMap.get('owner')?.is_nullable).toBe('YES');
    expect(bucketColMap.get('public')?.is_nullable).toBe('NO');
    expect(bucketColMap.get('file_size_limit')?.is_nullable).toBe('YES');
    expect(bucketColMap.get('allowed_mime_types')?.is_nullable).toBe('YES');
    expect(bucketColMap.get('created_at')?.is_nullable).toBe('NO');
    expect(bucketColMap.get('updated_at')?.is_nullable).toBe('NO');

    // 2.3 Colunas e tipos em storage.objects
    const objectCols = await db.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'storage' AND table_name = 'objects'
      ORDER BY ordinal_position;
    `);
    const objectColMap = new Map(objectCols.rows.map((r) => [r.column_name, r]));
    expect(objectColMap.get('id')?.is_nullable).toBe('NO');
    expect(objectColMap.get('bucket_id')?.is_nullable).toBe('NO');
    expect(objectColMap.get('name')?.is_nullable).toBe('NO');
    expect(objectColMap.get('owner')?.is_nullable).toBe('YES');
    expect(objectColMap.get('metadata')?.is_nullable).toBe('NO');
    expect(objectColMap.get('created_at')?.is_nullable).toBe('NO');
    expect(objectColMap.get('updated_at')?.is_nullable).toBe('NO');

    // 2.4 Unique Constraint (bucket_id, name) em storage.objects
    const uqRes = await db.query(`
      SELECT conname, contype
      FROM pg_constraint
      WHERE conrelid = 'storage.objects'::regclass AND conname = 'storage_objects_bucket_name_unique';
    `);
    expect(uqRes.rows.length).toBe(1);
    expect(uqRes.rows[0].contype).toBe('u');

    // 2.5 Foreign Key para storage.buckets com ON DELETE RESTRICT
    const fkRes = await db.query(`
      SELECT conname, confdeltype
      FROM pg_constraint
      WHERE conrelid = 'storage.objects'::regclass AND contype = 'f';
    `);
    expect(fkRes.rows.length).toBe(1);
    expect(fkRes.rows[0].confdeltype).toBe('r'); // 'r' = RESTRICT
  });

  it('3. Configuração e Proteção Física do Bucket "acervo" (Estritamente Privado, 20MB, application/pdf)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    // 3.1 Registro do bucket acervo
    const bucketRow = await db.query("SELECT * FROM storage.buckets WHERE id = 'acervo';");
    expect(bucketRow.rows.length).toBe(1);
    expect(bucketRow.rows[0].name).toBe('acervo');
    expect(bucketRow.rows[0].public).toBe(false);
    expect(bucketRow.rows[0].file_size_limit).toBe(20971520);
    expect(bucketRow.rows[0].allowed_mime_types).toEqual(['application/pdf']);

    // 3.2 Constraint storage_buckets_acervo_private_check ativa
    const chkRes = await db.query(`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conrelid = 'storage.buckets'::regclass AND conname = 'storage_buckets_acervo_private_check';
    `);
    expect(chkRes.rows.length).toBe(1);
    expect(chkRes.rows[0].convalidated).toBe(true);

    // 3.3 Tentativa de tornar bucket acervo público é bloqueada pela CHECK constraint
    await expect(
      db.query("UPDATE storage.buckets SET public = true WHERE id = 'acervo';")
    ).rejects.toThrowError(/storage_buckets_acervo_private_check/);

    // 3.4 Tentativa de alterar limite de tamanho do bucket acervo é bloqueada
    await expect(
      db.query("UPDATE storage.buckets SET file_size_limit = 50000000 WHERE id = 'acervo';")
    ).rejects.toThrowError(/storage_buckets_acervo_private_check/);

    // 3.5 Tentativa de alterar MIME types aceitos do bucket acervo é bloqueada
    await expect(
      db.query("UPDATE storage.buckets SET allowed_mime_types = ARRAY['image/png'] WHERE id = 'acervo';")
    ).rejects.toThrowError(/storage_buckets_acervo_private_check/);
  });

  it('4. Validação Exaustiva da Função medicina.is_valid_acervo_storage_path(text)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    const testPath = async (p: string | null) => {
      const res = await db.query(
        'SELECT medicina.is_valid_acervo_storage_path($1) AS valid;',
        p === null ? [null] : [p]
      );
      return res.rows[0].valid;
    };

    const validHash = '0123456789abcdef'.repeat(4); // 64 caracteres hexadecimais minúsculos

    // Casos Válidos
    expect(await testPath(`acervo/${validHash}.pdf`)).toBe(true);
    expect(await testPath(`acervo/${'a'.repeat(64)}.pdf`)).toBe(true);
    expect(await testPath(`acervo/${'f'.repeat(64)}.pdf`)).toBe(true);
    expect(await testPath(`acervo/${validHash}_capitulo1.pdf`)).toBe(true);
    expect(await testPath(`acervo/${validHash}_Doc.2029-Final_v1.pdf`)).toBe(true);
    expect(await testPath(`acervo/${validHash}_A-Z.0-9_test.pdf`)).toBe(true);

    // Casos Inválidos
    expect(await testPath(null)).toBe(false);
    expect(await testPath('')).toBe(false);
    expect(await testPath(`acervo/${'a'.repeat(63)}.pdf`)).toBe(false); // Hash com 63 chars (curto)
    expect(await testPath(`acervo/${'a'.repeat(65)}.pdf`)).toBe(false); // Hash com 65 chars (longo)
    expect(await testPath(`acervo/${'g'.repeat(64)}.pdf`)).toBe(false); // Caracteres não-hex ('g')
    expect(await testPath(`acervo/${'A'.repeat(64)}.pdf`)).toBe(false); // Hex maiúsculo não permitido
    expect(await testPath(`acervo/../etc/passwd.pdf`)).toBe(false);      // Path traversal com '..'
    expect(await testPath(`acervo//${validHash}.pdf`)).toBe(false);      // Barra dupla '//'
    expect(await testPath(`acervo\\${validHash}.pdf`)).toBe(false);      // Barra invertida '\'
    expect(await testPath(`acervo/${validHash}.png`)).toBe(false);       // Extensão não-pdf (.png)
    expect(await testPath(`acervo/${validHash}.PDF`)).toBe(false);       // Extensão maiúscula (.PDF)
    expect(await testPath(`publico/${validHash}.pdf`)).toBe(false);      // Prefixo diferente de 'acervo/'
    expect(await testPath(`acervo/${validHash};drop.pdf`)).toBe(false);   // Caracteres especiais injetados
    expect(await testPath(`acervo/${validHash} .pdf`)).toBe(false);      // Espaço em branco
  });

  it('5. Permissões Concedidas (Grants) a medicina_app e medicina_worker', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    // 5.1 Privilégios em storage.buckets
    const bucketPrivs = await db.query(`
      SELECT grantee, privilege_type
      FROM information_schema.table_privileges
      WHERE table_schema = 'storage' AND table_name = 'buckets' AND grantee IN ('medicina_app', 'medicina_worker', 'medicina_anon')
      ORDER BY grantee, privilege_type;
    `);

    const appBucketPrivs = bucketPrivs.rows.filter((r) => r.grantee === 'medicina_app').map((r) => r.privilege_type);
    expect(appBucketPrivs).toContain('SELECT');
    expect(appBucketPrivs).not.toContain('INSERT');
    expect(appBucketPrivs).not.toContain('UPDATE');
    expect(appBucketPrivs).not.toContain('DELETE');

    const workerBucketPrivs = bucketPrivs.rows.filter((r) => r.grantee === 'medicina_worker').map((r) => r.privilege_type);
    expect(workerBucketPrivs).toContain('SELECT');

    const anonBucketPrivs = bucketPrivs.rows.filter((r) => r.grantee === 'medicina_anon');
    expect(anonBucketPrivs.length).toBe(0);

    // 5.2 Privilégios em storage.objects
    const objectPrivs = await db.query(`
      SELECT grantee, privilege_type
      FROM information_schema.table_privileges
      WHERE table_schema = 'storage' AND table_name = 'objects' AND grantee IN ('medicina_app', 'medicina_worker', 'medicina_anon')
      ORDER BY grantee, privilege_type;
    `);

    const appObjPrivs = objectPrivs.rows.filter((r) => r.grantee === 'medicina_app').map((r) => r.privilege_type);
    expect(appObjPrivs).toContain('SELECT');
    expect(appObjPrivs).toContain('INSERT');
    expect(appObjPrivs).toContain('DELETE');
    expect(appObjPrivs).not.toContain('UPDATE'); // UPDATE proibido para medicina_app (upsert: false)

    const workerObjPrivs = objectPrivs.rows.filter((r) => r.grantee === 'medicina_worker').map((r) => r.privilege_type);
    expect(workerObjPrivs).toContain('SELECT');
    expect(workerObjPrivs).not.toContain('INSERT');
    expect(workerObjPrivs).not.toContain('UPDATE');
    expect(workerObjPrivs).not.toContain('DELETE');

    const anonObjPrivs = objectPrivs.rows.filter((r) => r.grantee === 'medicina_anon');
    expect(anonObjPrivs.length).toBe(0);

    // 5.3 Privilégios de Execução na função medicina.is_valid_acervo_storage_path
    const procPrivs = await db.query(`
      SELECT grantee
      FROM information_schema.routine_privileges
      WHERE routine_schema = 'medicina' AND routine_name = 'is_valid_acervo_storage_path';
    `);
    const procGrantees = procPrivs.rows.map((r) => r.grantee);
    expect(procGrantees).toContain('medicina_app');
    expect(procGrantees).toContain('medicina_worker');
    expect(procGrantees).not.toContain('PUBLIC');
    expect(procGrantees).not.toContain('medicina_anon');
  });

  it('6. Políticas de RLS em storage.buckets (Fail-Closed e Leitura Autenticada)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    // 6.1 Confirma RLS ativo em storage.buckets
    const rlsCheck = await db.query(`
      SELECT relrowsecurity
      FROM pg_class
      WHERE relname = 'buckets' AND relnamespace = 'storage'::regnamespace;
    `);
    expect(rlsCheck.rows[0].relrowsecurity).toBe(true);

    const resp1 = '10000000-0000-4000-8000-000000000001';
    await db.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES ('${resp1}', 'a0000000-0000-4000-8000-000000000001', 'Resp 1', 'resp1@test.com', 'hash', 'responsavel')
      ON CONFLICT DO NOTHING;
    `);

    // 6.2 Consulta sob medicina_app sem contexto -> 0 linhas (Fail-Closed)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      const unauth = await db.query("SELECT * FROM storage.buckets WHERE id = 'acervo';");
      expect(unauth.rows.length).toBe(0);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 6.3 Consulta sob medicina_app com contexto autenticado -> enxerga o bucket acervo
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp1}'::uuid, 'responsavel');`);
      const authRes = await db.query("SELECT id, public FROM storage.buckets WHERE id = 'acervo';");
      expect(authRes.rows.length).toBe(1);
      expect(authRes.rows[0].id).toBe('acervo');
      expect(authRes.rows[0].public).toBe(false);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 6.4 Consulta sob papel medicina_worker -> enxerga o bucket acervo
    await db.exec('BEGIN; SET LOCAL ROLE medicina_worker;');
    try {
      const workerRes = await db.query("SELECT id, public FROM storage.buckets WHERE id = 'acervo';");
      expect(workerRes.rows.length).toBe(1);
      expect(workerRes.rows[0].id).toBe('acervo');
    } finally {
      await db.exec('ROLLBACK;');
    }
  });

  it('7. Políticas de RLS em storage.objects — Leitura (SELECT) e Isolamento Cross-Tenant', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    const resp1 = '10000000-0000-4000-8000-000000000001';
    const resp2 = '20000000-0000-4000-8000-000000000002';
    const estud1 = '30000000-0000-4000-8000-000000000003';

    await db.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES
        ('${resp1}', 'a0000000-0000-4000-8000-000000000001', 'Resp 1', 'resp1@test.com', 'hash', 'responsavel'),
        ('${resp2}', 'a0000000-0000-4000-8000-000000000002', 'Resp 2', 'resp2@test.com', 'hash', 'responsavel'),
        ('${estud1}', 'a0000000-0000-4000-8000-000000000003', 'Estud 1', 'estud1@test.com', 'hash', 'estudante')
      ON CONFLICT DO NOTHING;
    `);

    const validPath1 = `acervo/${'1'.repeat(64)}.pdf`;

    // 7.1 Insere objeto pertencente a Responsável 1
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp1}'::uuid, 'responsavel');`);
      await db.exec(`
        INSERT INTO storage.objects (bucket_id, name, owner, metadata)
        VALUES ('acervo', '${validPath1}', '${resp1}', '{"mimetype": "application/pdf", "size": 1024}');
      `);
      const r1Res = await db.query('SELECT name, owner FROM storage.objects;');
      expect(r1Res.rows.length).toBe(1);
      expect(r1Res.rows[0].name).toBe(validPath1);
    } finally {
      await db.exec('COMMIT;');
    }

    // 7.2 Responsável 2 tenta ler o objeto -> 0 linhas (Isolamento Cross-Tenant estrito)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp2}'::uuid, 'responsavel');`);
      const r2Res = await db.query('SELECT name FROM storage.objects;');
      expect(r2Res.rows.length).toBe(0);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 7.3 Estudante tenta ler o objeto -> 0 linhas (Estudante não possui acesso direto ao catálogo de storage)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${estud1}'::uuid, 'estudante');`);
      const eRes = await db.query('SELECT name FROM storage.objects;');
      expect(eRes.rows.length).toBe(0);
    } finally {
      await db.exec('ROLLBACK;');
    }
  });

  it('8. Políticas de RLS em storage.objects — Upload (INSERT) com Restrições Estritas', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    const resp1 = '10000000-0000-4000-8000-000000000001';
    const resp2 = '20000000-0000-4000-8000-000000000002';
    const estud1 = '30000000-0000-4000-8000-000000000003';

    await db.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES
        ('${resp1}', 'a0000000-0000-4000-8000-000000000001', 'Resp 1', 'resp1@test.com', 'hash', 'responsavel'),
        ('${resp2}', 'a0000000-0000-4000-8000-000000000002', 'Resp 2', 'resp2@test.com', 'hash', 'responsavel'),
        ('${estud1}', 'a0000000-0000-4000-8000-000000000003', 'Estud 1', 'estud1@test.com', 'hash', 'estudante')
      ON CONFLICT DO NOTHING;
    `);

    // 8.1 Upload válido por Responsável 1
    const validPath = `acervo/${'2'.repeat(64)}.pdf`;
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp1}'::uuid, 'responsavel');`);
      await db.exec(`
        INSERT INTO storage.objects (bucket_id, name, owner, metadata)
        VALUES ('acervo', '${validPath}', '${resp1}', '{"mimetype": "application/pdf", "size": 2048}');
      `);
      const check = await db.query(`SELECT name FROM storage.objects WHERE name = '${validPath}';`);
      expect(check.rows.length).toBe(1);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 8.2 Rejeita upload com MIME inválido (ex: image/png)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp1}'::uuid, 'responsavel');`);
      await expect(
        db.query(`
          INSERT INTO storage.objects (bucket_id, name, owner, metadata)
          VALUES ('acervo', 'acervo/${'3'.repeat(64)}.pdf', '${resp1}', '{"mimetype": "image/png", "size": 1024}');
        `)
      ).rejects.toThrowError(/violates row-level security policy for table "objects"/);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 8.3 Rejeita upload com tamanho superior ao limite de 20 MiB (20971520 bytes)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp1}'::uuid, 'responsavel');`);
      await expect(
        db.query(`
          INSERT INTO storage.objects (bucket_id, name, owner, metadata)
          VALUES ('acervo', 'acervo/${'4'.repeat(64)}.pdf', '${resp1}', '{"mimetype": "application/pdf", "size": 20971521}');
        `)
      ).rejects.toThrowError(/violates row-level security policy for table "objects"/);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 8.4 Rejeita upload com caminho inválido (ex: sem padrão hash)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp1}'::uuid, 'responsavel');`);
      await expect(
        db.query(`
          INSERT INTO storage.objects (bucket_id, name, owner, metadata)
          VALUES ('acervo', 'acervo/invalid_name.pdf', '${resp1}', '{"mimetype": "application/pdf", "size": 1024}');
        `)
      ).rejects.toThrowError(/violates row-level security policy for table "objects"/);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 8.5 Rejeita tentativa de forjar outro owner (owner = resp2 por resp1)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp1}'::uuid, 'responsavel');`);
      await expect(
        db.query(`
          INSERT INTO storage.objects (bucket_id, name, owner, metadata)
          VALUES ('acervo', 'acervo/${'5'.repeat(64)}.pdf', '${resp2}', '{"mimetype": "application/pdf", "size": 1024}');
        `)
      ).rejects.toThrowError(/violates row-level security policy for table "objects"/);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 8.6 Rejeita upload por estudante
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${estud1}'::uuid, 'estudante');`);
      await expect(
        db.query(`
          INSERT INTO storage.objects (bucket_id, name, owner, metadata)
          VALUES ('acervo', 'acervo/${'6'.repeat(64)}.pdf', '${estud1}', '{"mimetype": "application/pdf", "size": 1024}');
        `)
      ).rejects.toThrowError(/violates row-level security policy for table "objects"/);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 8.7 Sobrescrita silenciosa (UPDATE) é bloqueada: medicina_app não possui privilégio de UPDATE
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp1}'::uuid, 'responsavel');`);
      await expect(
        db.query(`UPDATE storage.objects SET metadata = '{"updated": true}' WHERE bucket_id = 'acervo';`)
      ).rejects.toThrowError(/permission denied for table objects/);
    } finally {
      await db.exec('ROLLBACK;');
    }
  });

  it('9. Políticas de RLS em storage.objects — Exclusão (DELETE) Restrita a Objetos Não Vinculados', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    const resp1 = '10000000-0000-4000-8000-000000000001';
    const resp2 = '20000000-0000-4000-8000-000000000002';
    const discId = '40000000-0000-4000-8000-000000000004';

    await db.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES
        ('${resp1}', 'a0000000-0000-4000-8000-000000000001', 'Resp 1', 'resp1@test.com', 'hash', 'responsavel'),
        ('${resp2}', 'a0000000-0000-4000-8000-000000000002', 'Resp 2', 'resp2@test.com', 'hash', 'responsavel')
      ON CONFLICT DO NOTHING;

      INSERT INTO public.disciplinas (id, nome, area, cor_hex, ordem)
      VALUES ('${discId}', 'Biologia', 'natureza', '#00FF00', 1)
      ON CONFLICT DO NOTHING;
    `);

    const unlinkedPath = `acervo/${'7'.repeat(64)}.pdf`;
    const linkedPath = `acervo/${'8'.repeat(64)}.pdf`;

    // Cria os 2 objetos e vincula apenas linkedPath em public.acervo_arquivos
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp1}'::uuid, 'responsavel');`);
      await db.exec(`
        INSERT INTO storage.objects (bucket_id, name, owner, metadata)
        VALUES
          ('acervo', '${unlinkedPath}', '${resp1}', '{"mimetype": "application/pdf", "size": 1024}'),
          ('acervo', '${linkedPath}', '${resp1}', '{"mimetype": "application/pdf", "size": 1024}');
      `);
      await db.exec(`
        INSERT INTO public.acervo_arquivos (id, disciplina_id, titulo, tipo_material, serie_alvo, file_path, mime, tamanho_bytes, enviado_por, hash_conteudo)
        VALUES (gen_random_uuid(), '${discId}', 'Livro Bio', 'apostila', 1, '${linkedPath}', 'application/pdf', 1024, '${resp1}', '${'8'.repeat(64)}');
      `);
    } finally {
      await db.exec('COMMIT;');
    }

    // 9.1 Responsável 2 tenta deletar o objeto desvinculado do Responsável 1 -> 0 linhas deletadas
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp2}'::uuid, 'responsavel');`);
      const delR2 = await db.query(`DELETE FROM storage.objects WHERE name = '${unlinkedPath}' RETURNING name;`);
      expect(delR2.rows.length).toBe(0);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 9.2 Responsável 1 tenta deletar o objeto vinculado em acervo_arquivos -> 0 linhas deletadas (protegido contra orfandade)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp1}'::uuid, 'responsavel');`);
      const delLinked = await db.query(`DELETE FROM storage.objects WHERE name = '${linkedPath}' RETURNING name;`);
      expect(delLinked.rows.length).toBe(0);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 9.3 Responsável 1 deleta o objeto desvinculado -> 1 linha deletada com sucesso
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${resp1}'::uuid, 'responsavel');`);
      const delUnlinked = await db.query(`DELETE FROM storage.objects WHERE name = '${unlinkedPath}' RETURNING name;`);
      expect(delUnlinked.rows.length).toBe(1);
      expect(delUnlinked.rows[0].name).toBe(unlinkedPath);
    } finally {
      await db.exec('COMMIT;');
    }
  });

  it('10. Reversibilidade Atômica via F1_10_ROLLBACK_STORAGE_POLICIES.sql', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    await executeStagingMigrations({ sql, untilStep: 7, logger: () => {} });

    // Confere estado após migração 7
    const preFn = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(preFn.rows[0].fn).not.toBeNull();

    // Executa rollback atômico
    const rollbackSql = readFileSync(path.resolve(process.cwd(), 'docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql'), 'utf8');
    await db.exec(stripOuterTransaction(rollbackSql));

    // 10.1 Confirma que a função auxiliar foi removida
    const postFn = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(postFn.rows[0].fn).toBeNull();

    // 10.2 Confirma que as policies de storage foram removidas
    const postPolicies = await db.query(`
      SELECT polname
      FROM pg_policy
      WHERE polrelid IN ('storage.buckets'::regclass, 'storage.objects'::regclass);
    `);
    expect(postPolicies.rows.length).toBe(0);

    // 10.3 Confirma que a constraint foi removida
    const postConstraint = await db.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'storage.buckets'::regclass AND conname = 'storage_buckets_acervo_private_check';
    `);
    expect(postConstraint.rows.length).toBe(0);

    // 10.4 Confirma que o bucket acervo permanece com public = false (privacidade preservada no rollback)
    const postBucket = await db.query("SELECT public FROM storage.buckets WHERE id = 'acervo';");
    expect(postBucket.rows.length).toBe(1);
    expect(postBucket.rows[0].public).toBe(false);

    // 10.5 Confirma que os grants em storage foram revogados
    const postGrants = await db.query(`
      SELECT grantee, privilege_type
      FROM information_schema.table_privileges
      WHERE table_schema = 'storage' AND grantee IN ('medicina_app', 'medicina_worker');
    `);
    expect(postGrants.rows.length).toBe(0);
  });

  it('11. Idempotência Completa e Preservação de Estado na Re-execução da F1.10', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To6Applied();
    const manifest = getMigrationManifest();

    // Primeira aplicação da etapa 7
    const firstRun = await executeStagingMigrations({
      sql,
      manifest,
      untilStep: 7,
      logger: () => {},
    });
    expect(firstRun.appliedCount).toBe(1);
    expect(firstRun.skippedCount).toBe(6);

    // Re-execução imediata
    const retryLogs: string[] = [];
    const retryRun = await executeStagingMigrations({
      sql,
      manifest,
      untilStep: 7,
      logger: (msg: string) => retryLogs.push(msg),
    });

    expect(retryRun.appliedCount).toBe(0);
    expect(retryRun.skippedCount).toBe(7);
    expect(retryLogs.filter((l) => l.includes('[SKIP]')).length).toBe(7);

    const finalHistory = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(finalHistory.rows[0].cnt).toBe(7);
  });
});
