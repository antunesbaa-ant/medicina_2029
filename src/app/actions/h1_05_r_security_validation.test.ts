import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

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

interface PGliteInstance {
  exec: (query: string) => Promise<unknown>;
  query: <T = Record<string, unknown>>(query: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

const S1_ID = '10000000-0000-4000-8000-000000000001';
const S2_ID = '10000000-0000-4000-8000-000000000002';
const R1_ID = '20000000-0000-4000-8000-000000000001';

async function createDatabaseWithSteps1To5(): Promise<PGliteInstance> {
  const db = new PGlite({
    extensions: { vector },
  });

  await db.exec(`
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
  `);

  const files = [
    'drizzle/0000_greedy_loki.sql',
    'drizzle/0001_dry_talos.sql',
    'drizzle/0002_little_swarm.sql',
    'drizzle/0003_f1_03_r_expansao.sql',
    'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql',
  ];

  for (const file of files) {
    const raw = readFileSync(path.resolve(process.cwd(), file), 'utf8');
    const clean = stripOuterTransaction(raw);
    await db.exec(clean);
  }

  // Aplica as fixtures padronizadas de teste de segurança F1.04
  const fixturesRaw = readFileSync(path.resolve(process.cwd(), 'tests/integration/f1_04/fixtures.sql'), 'utf8');
  await db.exec(fixturesRaw);

  return db;
}

describe('MEDICINA 2029 — H1.05-R: Fechamento da Validação de Segurança RLS', () => {
  it('1. Impersonação de perfil: set_context rejeita UUID inexistente ou papel incompatível', async () => {
    const db = await createDatabaseWithSteps1To5();

    // 1.1 Rejeita UUID sintético arbitrário inexistente na base
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await expect(
        db.query("SELECT medicina.set_context('99999999-9999-4999-8999-999999999999'::uuid, 'estudante');")
      ).rejects.toThrowError(/Contexto invalido: perfil .* nao existe/);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 1.2 Rejeita perfil legítimo de estudante tentando ser setado como responsavel
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await expect(
        db.query(`SELECT medicina.set_context('${S1_ID}'::uuid, 'responsavel');`)
      ).rejects.toThrowError(/Contexto invalido: perfil .* com papel responsavel nao existe/);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 1.3 Rejeita papel inválido / SQL injection
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await expect(
        db.query(`SELECT medicina.set_context('${S1_ID}'::uuid, 'admin');`)
      ).rejects.toThrowError(/Papel invalido: admin/);
    } finally {
      await db.exec('ROLLBACK;');
    }
  });

  it('2. Isolamento Cross-Tenant sob medicina_app: Estudante 1 não lê nem altera dados de Estudante 2', async () => {
    const db = await createDatabaseWithSteps1To5();

    // Sessão sob contexto de Estudante 1
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.query(`SELECT medicina.set_context('${S1_ID}'::uuid, 'estudante');`);

      // 2.1 Leitura: visualiza apenas sua própria sessão (S1), nunca a sessão de S2
      const sessoesRes = await db.query<{ id: string; perfil_id: string }>('SELECT id, perfil_id FROM public.sessoes;');
      expect(sessoesRes.rows.length).toBe(1);
      expect(sessoesRes.rows[0].id).toBe('42000000-0000-4000-8000-000000000001');
      expect(sessoesRes.rows[0].perfil_id).toBe(S1_ID);

      // 2.2 Mutação Indireta: tentativa de alterar sessão pertencente a S2 afeta 0 linhas
      await db.query(
        `UPDATE public.sessoes SET segundos_efetivos = 9999 WHERE id = '42000000-0000-4000-8000-000000000002';`
      );
      const checkS2 = await db.query<{ segundos_efetivos: number }>(
        `SELECT segundos_efetivos FROM public.sessoes WHERE id = '42000000-0000-4000-8000-000000000002';`
      );
      expect(checkS2.rows.length).toBe(0); // Invisível para S1!

      // 2.3 Tentativa de INSERT com owner forjado (perfil_id = S2) é barrada por WITH CHECK (42501)
      await expect(
        db.query(`
          INSERT INTO public.sessoes (id, perfil_id, ciclo_bloco_id, topico_id, segundos_efetivos, segundos_pausa)
          VALUES ('42000000-0000-4000-8000-000000000003', '${S2_ID}', '41000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 100, 10);
        `)
      ).rejects.toThrowError(/violates row-level security policy for table "sessoes"/i);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // Sessão sob contexto de Estudante 2
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.query(`SELECT medicina.set_context('${S2_ID}'::uuid, 'estudante');`);

      const sessoesRes = await db.query<{ id: string; perfil_id: string }>('SELECT id, perfil_id FROM public.sessoes;');
      expect(sessoesRes.rows.length).toBe(1);
      expect(sessoesRes.rows[0].id).toBe('42000000-0000-4000-8000-000000000002');
      expect(sessoesRes.rows[0].perfil_id).toBe(S2_ID);
    } finally {
      await db.exec('ROLLBACK;');
    }
  });

  it('3. Princípio 1.2 da ESPEC: Responsável 1 tem zero leitura de sessões brutas e acessa apenas view agregada', async () => {
    const db = await createDatabaseWithSteps1To5();

    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.query(`SELECT medicina.set_context('${R1_ID}'::uuid, 'responsavel');`);

      // Leitura de sessões individuais brutas retorna 0 linhas
      const rawSessoes = await db.query('SELECT * FROM public.sessoes;');
      expect(rawSessoes.rows.length).toBe(0);

      // Acesso à view agregada quinzenal é permitido
      const viewRes = await db.query('SELECT * FROM public.vw_acompanhamento_quinzenal;');
      expect(viewRes.rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await db.exec('ROLLBACK;');
    }
  });

  it('4. Privilégios de Autenticação: medicina_app não pode executar autenticar_por_email', async () => {
    const db = await createDatabaseWithSteps1To5();

    // 4.1 Sob medicina_app: bloqueio explícito (42501)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await expect(
        db.query("SELECT * FROM medicina.autenticar_por_email('estudante1.f104@example.invalid');")
      ).rejects.toThrowError(/permission denied for function autenticar_por_email/i);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 4.2 Sob medicina_anon: bloqueio explícito (42501 de schema ou function)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_anon;');
    try {
      await expect(
        db.query("SELECT * FROM medicina.autenticar_por_email('estudante1.f104@example.invalid');")
      ).rejects.toThrowError(/permission denied for (function autenticar_por_email|schema medicina)/i);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 4.3 Sob medicina_auth: execução autorizada para e-mail na allowlist
    await db.exec('BEGIN; SET LOCAL ROLE medicina_auth;');
    try {
      const authRes = await db.query<{ id: string; email: string; password_hash: string }>(
        "SELECT id, email, password_hash FROM medicina.autenticar_por_email('estudante1.f104@example.invalid');"
      );
      expect(authRes.rows.length).toBe(1);
      expect(authRes.rows[0].id).toBe(S1_ID);
      expect(authRes.rows[0].password_hash).toBeTruthy();

      // 4.4 Anti-enumeração: e-mail fora da allowlist retorna 0 linhas
      const foraAllowlist = await db.query(
        "SELECT * FROM medicina.autenticar_por_email('invasor@example.invalid');"
      );
      expect(foraAllowlist.rows.length).toBe(0);
    } finally {
      await db.exec('ROLLBACK;');
    }
  });

  it('5. Proteção de Coluna: password_hash é estritamente inacessível para medicina_app', async () => {
    const db = await createDatabaseWithSteps1To5();

    // 5.1 SELECT password_hash é bloqueado mesmo para o próprio dono do perfil
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.query(`SELECT medicina.set_context('${S1_ID}'::uuid, 'estudante');`);
      await expect(
        db.query('SELECT password_hash FROM public.perfis;')
      ).rejects.toThrowError(/permission denied for (column password_hash|table perfis)/i);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 5.2 SELECT * em perfis é bloqueado (força seleção de colunas permitidas ou view)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.query(`SELECT medicina.set_context('${S1_ID}'::uuid, 'estudante');`);
      await expect(
        db.query('SELECT * FROM public.perfis;')
      ).rejects.toThrowError(/permission denied for table perfis/i);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 5.3 Consumo de colunas permitidas e view funciona
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.query(`SELECT medicina.set_context('${S1_ID}'::uuid, 'estudante');`);
      const safeCols = await db.query<{ id: string; email: string }>('SELECT id, email FROM public.perfis;');
      expect(safeCols.rows.length).toBe(1);
      expect(safeCols.rows[0].id).toBe(S1_ID);

      const safeView = await db.query<{ id: string; email: string }>('SELECT id, email FROM public.vw_perfis;');
      expect(safeView.rows.length).toBe(1);
      expect(safeView.rows[0].id).toBe(S1_ID);
    } finally {
      await db.exec('ROLLBACK;');
    }
  });

  it('6. Proteção de Schemas: medicina_app e medicina_anon não possuem privilégio CREATE', async () => {
    const db = await createDatabaseWithSteps1To5();

    // medicina_app tentando criar tabela no schema medicina
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await expect(
        db.query('CREATE TABLE medicina.teste_invasao (id int);')
      ).rejects.toThrowError(/permission denied for schema medicina/i);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // medicina_anon tentando criar tabela no schema public
    await db.exec('BEGIN; SET LOCAL ROLE medicina_anon;');
    try {
      await expect(
        db.query('CREATE TABLE public.teste_invasao (id int);')
      ).rejects.toThrowError(/permission denied for schema public/i);
    } finally {
      await db.exec('ROLLBACK;');
    }
  });
});
