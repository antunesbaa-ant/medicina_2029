import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { stripOuterTransaction } from '../../../scripts/db/migrate-staging.mjs';
import { executeControlledStagingSeed } from '../../../scripts/db/apply-staging-seed.mjs';

const moduleRoot = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';

if (!existsSync(moduleRoot)) {
  throw new Error(`Diretório de módulos isolados não encontrado em ${moduleRoot}.`);
}

const importFromRoot = (pkgPath: string) => import(pathToFileURL(path.join(moduleRoot, pkgPath)).href);

const [{ PGlite }, { vector }] = await Promise.all([
  importFromRoot('@electric-sql/pglite/dist/index.js'),
  importFromRoot('@electric-sql/pglite-pgvector/dist/index.js'),
]);

interface PGliteInstance {
  exec: (query: string) => Promise<unknown>;
  query: <T = Record<string, unknown>>(query: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

async function createDatabaseWithCanonicalMigrations(): Promise<PGliteInstance> {
  const pglite = new PGlite({
    extensions: { vector },
  });

  await pglite.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;
    CREATE TABLE public._medicina_staging_migrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ordem integer NOT NULL UNIQUE,
      rel_path text NOT NULL UNIQUE,
      sha256 text NOT NULL,
      aplicado_em timestamptz DEFAULT now() NOT NULL,
      executado_por text NOT NULL,
      tamanho_bytes integer NOT NULL
    );
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
    ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;
  `);

  const files = [
    'drizzle/0000_greedy_loki.sql',
    'drizzle/0001_dry_talos.sql',
    'drizzle/0002_little_swarm.sql',
    'drizzle/0003_f1_03_r_expansao.sql',
    'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql',
    'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql',
    'docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql',
    'docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql',
    'docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql',
  ];

  for (const file of files) {
    const raw = readFileSync(path.resolve(process.cwd(), file), 'utf8');
    const clean = stripOuterTransaction(raw);
    await pglite.exec(clean);
  }

  return pglite;
}

describe('MEDICINA 2029 — H2.01-R: Validação de Pré-Requisitos (Seed, Allowlist e Roles)', () => {
  it('1. Confirma existência de check_allowlist() e e-mails originais da migração 0000', async () => {
    const pg = await createDatabaseWithCanonicalMigrations();

    // 1.1 Conferência da função check_allowlist
    const fnRes = await pg.query<{ proname: string; prosecdef: boolean }>(`
      SELECT proname, prosecdef FROM pg_proc WHERE proname = 'check_allowlist';
    `);
    expect(fnRes.rows.length).toBe(1);
    expect(fnRes.rows[0].prosecdef).toBe(true);

    // 1.2 Conferência dos e-mails da migração inicial (0000_greedy_loki.sql)
    const initialAllowlist = await pg.query<{ email: string }>(`
      SELECT email FROM public.allowlist ORDER BY email;
    `);
    const initialEmails = initialAllowlist.rows.map((r) => r.email);
    expect(initialEmails).toContain('estudante@medicina2029.com.br');
    expect(initialEmails).toContain('responsavel@medicina2029.com.br');
  });

  it('2. Demonstra que medicina_app (NOBYPASSRLS) é bloqueada por RLS ao tentar inserir na allowlist e perfis', async () => {
    const pg = await createDatabaseWithCanonicalMigrations();

    // 2.1 medicina_app tentando inserir na allowlist
    let allowlistError: any = null;
    try {
      await pg.exec(`
        BEGIN;
        SET LOCAL ROLE medicina_app;
        INSERT INTO public.allowlist (email) VALUES ('tentativa@hacker.com');
        COMMIT;
      `);
    } catch (err) {
      allowlistError = err;
      await pg.exec('ROLLBACK;');
    }
    expect(allowlistError).toBeDefined();
    expect(String(allowlistError)).toMatch(/row-level security policy for table "allowlist"/);

    // 2.2 medicina_app tentando inserir em perfis
    let perfisError: any = null;
    try {
      await pg.exec(`
        BEGIN;
        SET LOCAL ROLE medicina_app;
        INSERT INTO public.perfis (id, auth_user_id, nome, email, papel)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'Invasor', 'invasor@teste.com', 'estudante');
        COMMIT;
      `);
    } catch (err) {
      perfisError = err;
      await pg.exec('ROLLBACK;');
    }
    expect(perfisError).toBeDefined();
    expect(String(perfisError)).toMatch(/row-level security policy for table "perfis"/);
  });

  it('3. Executa o seed sintético sob conexão administrativa (BYPASSRLS) com sucesso e coexistência na allowlist', async () => {
    const pg = await createDatabaseWithCanonicalMigrations();

    // Wrapper para simular tagged template sql do postgres.js sobre PGlite
    const sqlMock: any = async (strings: TemplateStringsArray, ...values: any[]) => {
      let query = strings[0];
      const params: any[] = [];
      for (let i = 0; i < values.length; i++) {
        params.push(values[i]);
        query += `$${i + 1}` + strings[i + 1];
      }
      const res = await pg.query(query, params);
      return res.rows;
    };

    const result = await executeControlledStagingSeed({
      confirmation: 'CONFIRMAR SEED STAGING',
      sqlInstance: sqlMock,
      logger: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.perfis).toBe(2);
    expect(result.disciplinas).toBe(5);
    expect(result.topicos).toBe(10);
    expect(result.blocos).toBe(28);
    expect(result.cards).toBe(6);
    expect(result.arquivos).toBe(3);

    // Confirma coexistência pacífica na allowlist (e-mails originais + e-mails sintéticos)
    const allowlistRows = await pg.query<{ email: string }>(`SELECT email FROM public.allowlist ORDER BY email;`);
    const allEmails = allowlistRows.rows.map((r) => r.email);

    expect(allEmails).toContain('estudante@medicina2029.com.br');
    expect(allEmails).toContain('responsavel@medicina2029.com.br');
    expect(allEmails).toContain('alice@medicina2029.staging');
    expect(allEmails).toContain('bruno@medicina2029.staging');

    // Confirma existência de Alice e Bruno em perfis
    const perfisRows = await pg.query<{ id: string; nome: string; email: string; papel: string }>(`
      SELECT id, nome, email, papel FROM public.perfis WHERE email IN ('alice@medicina2029.staging', 'bruno@medicina2029.staging');
    `);
    expect(perfisRows.rows.length).toBe(2);
  });

  it('4. Valida fluxo de autenticação sob role medicina_auth e rejeição de e-mails fora da allowlist', async () => {
    const pg = await createDatabaseWithCanonicalMigrations();

    const sqlMock: any = async (strings: TemplateStringsArray, ...values: any[]) => {
      let query = strings[0];
      const params: any[] = [];
      for (let i = 0; i < values.length; i++) {
        params.push(values[i]);
        query += `$${i + 1}` + strings[i + 1];
      }
      const res = await pg.query(query, params);
      return res.rows;
    };

    await executeControlledStagingSeed({
      confirmation: 'CONFIRMAR SEED STAGING',
      sqlInstance: sqlMock,
      logger: () => {},
    });

    // 4.1 Autenticação de Alice via medicina_auth
    await pg.exec('SET ROLE medicina_auth;');
    const authAlice = await pg.query<{ perfil_id: string; email: string; password_hash: string; papel: string }>(`
      SELECT * FROM medicina.autenticar_por_email('alice@medicina2029.staging');
    `);
    expect(authAlice.rows.length).toBe(1);
    expect(authAlice.rows[0].email).toBe('alice@medicina2029.staging');
    expect(authAlice.rows[0].papel).toBe('estudante');
    expect(authAlice.rows[0].password_hash).toMatch(/^\$2[aby]\$\d+\$/);

    // 4.2 Tentativa de autenticar usuário fora da allowlist
    const authInvalido = await pg.query(`
      SELECT * FROM medicina.autenticar_por_email('desconhecido@qualquer.com');
    `);
    expect(authInvalido.rows.length).toBe(0);

    // 4.3 medicina_app não tem permissão para chamar autenticar_por_email
    await pg.exec('RESET ROLE;');
    let appAuthErr: any = null;
    try {
      await pg.exec('SET ROLE medicina_app;');
      await pg.query(`SELECT * FROM medicina.autenticar_por_email('alice@medicina2029.staging');`);
    } catch (err) {
      appAuthErr = err;
    } finally {
      await pg.exec('RESET ROLE;');
    }
    expect(appAuthErr).toBeDefined();
    expect(String(appAuthErr)).toMatch(/permission denied for function autenticar_por_email/);
  });

  it('5. Valida isolamento e governança de contexto RLS sob role medicina_app', async () => {
    const pg = await createDatabaseWithCanonicalMigrations();

    const sqlMock: any = async (strings: TemplateStringsArray, ...values: any[]) => {
      let query = strings[0];
      const params: any[] = [];
      for (let i = 0; i < values.length; i++) {
        params.push(values[i]);
        query += `$${i + 1}` + strings[i + 1];
      }
      const res = await pg.query(query, params);
      return res.rows;
    };

    await executeControlledStagingSeed({
      confirmation: 'CONFIRMAR SEED STAGING',
      sqlInstance: sqlMock,
      logger: () => {},
    });

    // Alice acessa sob seu contexto RLS
    await pg.exec(`
      BEGIN;
      SET LOCAL ROLE medicina_app;
      SELECT medicina.set_context('10000000-0000-4000-8000-000000000001'::uuid, 'estudante');
    `);
    const aliceCards = await pg.query<{ id: string; frente: string }>(`
      SELECT id, frente FROM public.cards;
    `);
    // Alice deve ver seus 6 cards
    expect(aliceCards.rows.length).toBe(6);
    await pg.exec('COMMIT;');

    // Tentativa de Alice ler perfis de terceiros
    await pg.exec(`
      BEGIN;
      SET LOCAL ROLE medicina_app;
      SELECT medicina.set_context('10000000-0000-4000-8000-000000000001'::uuid, 'estudante');
    `);
    const perfisSobAlice = await pg.query<{ id: string; nome: string }>(`
      SELECT id, nome FROM public.perfis;
    `);
    // Alice só pode ler o próprio perfil
    expect(perfisSobAlice.rows.length).toBe(1);
    expect(perfisSobAlice.rows[0].nome).toBe('Alice Estudante Sintética');
    await pg.exec('COMMIT;');

    // Confirmar que password_hash não é acessível para medicina_app (revogado por Column-Level Grants)
    let pwdHashErr: any = null;
    try {
      await pg.exec(`
        BEGIN;
        SET LOCAL ROLE medicina_app;
        SELECT medicina.set_context('10000000-0000-4000-8000-000000000001'::uuid, 'estudante');
      `);
      await pg.query('SELECT password_hash FROM public.perfis;');
      await pg.exec('COMMIT;');
    } catch (err) {
      pwdHashErr = err;
      await pg.exec('ROLLBACK;');
    }
    expect(pwdHashErr).toBeDefined();
    expect(String(pwdHashErr)).toMatch(/permission denied for (column password_hash|table perfis)/);
  });

  it('6. Demonstra idempotência absoluta executando o seed uma segunda vez sem erros', async () => {
    const pg = await createDatabaseWithCanonicalMigrations();

    const sqlMock: any = async (strings: TemplateStringsArray, ...values: any[]) => {
      let query = strings[0];
      const params: any[] = [];
      for (let i = 0; i < values.length; i++) {
        params.push(values[i]);
        query += `$${i + 1}` + strings[i + 1];
      }
      const res = await pg.query(query, params);
      return res.rows;
    };

    const firstRun = await executeControlledStagingSeed({
      confirmation: 'CONFIRMAR SEED STAGING',
      sqlInstance: sqlMock,
      logger: () => {},
    });
    expect(firstRun.success).toBe(true);

    const secondRun = await executeControlledStagingSeed({
      confirmation: 'CONFIRMAR SEED STAGING',
      sqlInstance: sqlMock,
      logger: () => {},
    });
    expect(secondRun.success).toBe(true);

    // Contagens finais devem permanecer idênticas
    const totalPerfis = await pg.query(`SELECT count(*)::int as c FROM public.perfis;`);
    const totalBlocos = await pg.query(`SELECT count(*)::int as c FROM public.ciclo_blocos;`);
    const totalCards = await pg.query(`SELECT count(*)::int as c FROM public.cards;`);

    expect(Number(totalPerfis.rows[0].c)).toBe(2);
    expect(Number(totalBlocos.rows[0].c)).toBe(28);
    expect(Number(totalCards.rows[0].c)).toBe(6);
  });
});
