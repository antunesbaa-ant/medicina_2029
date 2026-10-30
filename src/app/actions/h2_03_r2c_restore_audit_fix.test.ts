/**
 * ==============================================================================
 * MEDICINA 2029 — H2.03-R2C: TESTES DA CORREÇÃO DA AUDITORIA DO BACKUP RESTAURADO
 * ==============================================================================
 * Validação direcionada das correções de catálogo pg_class (relrowsecurity /
 * relforcerowsecurity), modo read-only estrito, compatibilidade preventiva
 * das etapas 4 a 7 e auto-descoberta segura de manifesto.
 * ==============================================================================
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleRoot =
  process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';

const importFromRoot = (pkgPath: string) =>
  import(pathToFileURL(path.join(moduleRoot, pkgPath)).href);

const [{ PGlite }] = await Promise.all([
  importFromRoot('@electric-sql/pglite/dist/index.js'),
]);

interface PGliteInstance {
  exec: (query: string) => Promise<unknown>;
  query: <T = Record<string, unknown>>(
    query: string,
    params?: unknown[]
  ) => Promise<{ rows: T[] }>;
  close: () => Promise<void>;
}

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../../');
const VERIFY_SCRIPT = path.join(PROJECT_ROOT, 'scripts/backup/verify_restore.sh');
const CRYPTO_SCRIPT = path.join(PROJECT_ROOT, 'scripts/backup/crypto_envelope.mjs');

describe('MEDICINA 2029 — H2.03-R2C: Correção da Auditoria de Backup Restaurado', () => {
  let tmpDir: string;
  let pglite: PGliteInstance;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm29_r2c_test_'));
    fs.chmodSync(tmpDir, 0o700);
    pglite = new PGlite();
  });

  afterEach(async () => {
    try {
      await pglite.close();
    } catch {}
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
  });

  // ---------------------------------------------------------------------------
  // 1. CORREÇÃO DOS NOMES DE COLUNAS RLS NO CATÁLOGO PG_CLASS
  // ---------------------------------------------------------------------------
  describe('1. Consulta de Catálogo RLS em pg_class (relrowsecurity / relforcerowsecurity)', () => {
    it('1.1 Script verify_restore.sh utiliza relrowsecurity e relforcerowsecurity', () => {
      const scriptContent = fs.readFileSync(VERIFY_SCRIPT, 'utf8');

      // Não deve consultar 'rowsecurity, forcerowsecurity' diretamente em pg_class
      expect(scriptContent).not.toMatch(/SELECT\s+relname,\s*rowsecurity,\s*forcerowsecurity\s+FROM\s+pg_class/i);

      // Deve consultar relrowsecurity e relforcerowsecurity
      expect(scriptContent).toMatch(/SELECT\s+relname,\s*relrowsecurity,\s*relforcerowsecurity\s+FROM\s+pg_class/i);
    });

    it('1.2 Executa com sucesso a query corrigida contra motor PostgreSQL real (PGlite)', async () => {
      // Cria tabela de domínio de teste e habilita RLS
      await pglite.exec(`
        CREATE TABLE public.perfis (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          email text NOT NULL
        );
        ALTER TABLE public.perfis ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.perfis FORCE ROW LEVEL SECURITY;
      `);

      // Executa a query exata do script verify_restore.sh
      const res = await pglite.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(`
        SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
        JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
        WHERE pg_namespace.nspname = 'public'
          AND relkind = 'r'
        ORDER BY relname;
      `);

      expect(res.rows.length).toBe(1);
      expect(res.rows[0].relname).toBe('perfis');
      expect(res.rows[0].relrowsecurity).toBe(true);
      expect(res.rows[0].relforcerowsecurity).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. MODO ESTRITAMENTE DE LEITURA (READ-ONLY)
  // ---------------------------------------------------------------------------
  describe('2. Verificação de Operação Read-Only do Script de Auditoria', () => {
    it('2.1 verify_restore.sh não contém comandos destrutivos de DDL ou DML', () => {
      const scriptContent = fs.readFileSync(VERIFY_SCRIPT, 'utf8');

      // Não pode conter DROP DATABASE ou CREATE DATABASE
      expect(scriptContent).not.toMatch(/\bDROP\s+DATABASE\b/i);
      expect(scriptContent).not.toMatch(/\bCREATE\s+DATABASE\b/i);

      // Não pode conter pg_restore
      expect(scriptContent).not.toMatch(/\bpg_restore\b/i);

      // Não pode conter comandos de escrita ou destruição DDL/DML
      expect(scriptContent).not.toMatch(/\bDROP\s+TABLE\b/i);
      expect(scriptContent).not.toMatch(/\bTRUNCATE\b/i);
      expect(scriptContent).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(scriptContent).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(scriptContent).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);

      // Confirma que o script executa múltiplas consultas de leitura (SELECT)
      const selectMatches = scriptContent.match(/\bSELECT\s+/gi) || [];
      expect(selectMatches.length).toBeGreaterThan(10);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. AUTO-DESCOBERTA E DECIFRAGEM SEGURA DO MANIFESTO
  // ---------------------------------------------------------------------------
  describe('3. Resolução Segura de Manifesto Cifrado e Auto-Descoberta', () => {
    it('3.1 Decifra manifesto cifrado (*_manifest.json.enc) via pipe stdin em memória temporária', () => {
      const testKey = 'm29_r2c_secret_audit_key_1234567890';
      const manifestPlain = JSON.stringify({
        app: 'Medicina 2029',
        task: 'H2.03-R2C',
        table_row_counts: {
          'public.allowlist': 2,
          'public.perfis': 0,
        },
      });

      const manifestPath = path.join(tmpDir, 'test_manifest.json');
      const manifestEnc = path.join(tmpDir, 'test_manifest.json.enc');
      fs.writeFileSync(manifestPath, manifestPlain, 'utf8');

      // Cifra
      spawnSync('node', [CRYPTO_SCRIPT, 'encrypt', manifestPath, manifestEnc, '--key-stdin'], {
        input: testKey,
        encoding: 'utf8',
      });
      fs.unlinkSync(manifestPath);

      // Testa script auxiliar de decifragem segura via stdin
      const decOut = path.join(tmpDir, 'recovered_manifest.json');
      const res = spawnSync('node', [CRYPTO_SCRIPT, 'decrypt', manifestEnc, decOut, '--key-stdin'], {
        input: testKey,
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);

      const parsed = JSON.parse(fs.readFileSync(decOut, 'utf8'));
      expect(parsed.table_row_counts['public.allowlist']).toBe(2);
    });

    it('3.2 Localiza corretamente o backup baseline real de 27/10/2026 no sistema', () => {
      const baselineDir = path.join(os.homedir(), '.medicina2029', 'backups');
      if (fs.existsSync(baselineDir)) {
        const entries = fs.readdirSync(baselineDir)
          .filter(d => d.startsWith('medicina2029_staging_baseline_20261027'));
        expect(entries.length).toBeGreaterThan(0);
        const backupPath = path.join(baselineDir, entries[0]);
        const files = fs.readdirSync(backupPath);
        expect(files.some(f => f.endsWith('_manifest.json.enc'))).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. REVISÃO PREVENTIVA DAS ETAPAS 4 A 7 E CONSTRAINTS
  // ---------------------------------------------------------------------------
  describe('4. Auditoria Preventiva de Compatibilidade (Etapas 4 a 7)', () => {
    it('4.1 Auditoria de Constraints estruturais (PK e FK via pg_constraint)', async () => {
      await pglite.exec(`
        CREATE TABLE public.perfis (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          email text NOT NULL
        );
        CREATE TABLE public.ciclos (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          perfil_id uuid REFERENCES public.perfis(id)
        );
      `);

      const pkRes = await pglite.query<{ count: string }>(`
        SELECT count(*)::text as count FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.contype = 'p';
      `);
      expect(parseInt(pkRes.rows[0].count, 10)).toBe(2);

      const fkRes = await pglite.query<{ count: string }>(`
        SELECT count(*)::text as count FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.contype = 'f';
      `);
      expect(parseInt(fkRes.rows[0].count, 10)).toBe(1);
    });

    it('4.2 Valida catálogo de funções críticas em pg_proc', async () => {
      await pglite.exec(`
        CREATE SCHEMA medicina;
        CREATE FUNCTION medicina.autenticar_por_email(p_email text) RETURNS text LANGUAGE sql AS 'SELECT p_email';
        CREATE FUNCTION public.fn_busca_hibrida_acervo(termo text) RETURNS text LANGUAGE sql AS 'SELECT termo';
      `);

      const res = await pglite.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = 'autenticar_por_email' AND n.nspname IN ('medicina', 'public')
        ) as exists;
      `);
      expect(res.rows[0].exists).toBe(true);
    });

    it('4.3 Valida catálogo de índices em pg_indexes', async () => {
      await pglite.exec(`
        CREATE TABLE public.acervo_chunks (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          embedding text
        );
        CREATE INDEX idx_mock_vector ON public.acervo_chunks(embedding);
      `);

      const res = await pglite.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'acervo_chunks'
            AND indexname = 'idx_mock_vector'
        ) as exists;
      `);
      expect(res.rows[0].exists).toBe(true);
    });

    it('4.4 Valida integridade referencial da consulta de sessões sem erro de coluna', async () => {
      await pglite.exec(`
        CREATE TABLE public.perfis (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
        CREATE TABLE public.ciclo_blocos (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
        CREATE TABLE public.topicos (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
        CREATE TABLE public.sessoes (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          perfil_id uuid REFERENCES public.perfis(id),
          ciclo_bloco_id uuid REFERENCES public.ciclo_blocos(id),
          topico_id uuid REFERENCES public.topicos(id)
        );
      `);

      const res = await pglite.query<{ count: string }>(`
        SELECT count(*)::text as count FROM public.sessoes s
        LEFT JOIN public.perfis p ON p.id = s.perfil_id
        LEFT JOIN public.ciclo_blocos b ON b.id = s.ciclo_bloco_id
        LEFT JOIN public.topicos t ON t.id = s.topico_id
        WHERE p.id IS NULL OR b.id IS NULL OR t.id IS NULL;
      `);
      expect(parseInt(res.rows[0].count, 10)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. SALVAGUARDAS DE SEGURANÇA E FAIL-CLOSED
  // ---------------------------------------------------------------------------
  describe('5. Salvaguardas Fail-Closed e Bloqueio de Hosts Externos', () => {
    it('5.1 Rejeita sumariamente execução apontando para o Supabase remoto', () => {
      const res = spawnSync(
        'bash',
        [VERIFY_SCRIPT, 'medicina2029_staging'],
        {
          env: {
            ...process.env,
            TARGET_PGHOST: 'db.projectref.supabase.co',
            TARGET_PGPORT: '5432',
          },
          encoding: 'utf8',
        }
      );

      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('VIOLAÇÃO CRÍTICA DE SEGURANÇA (FAIL-CLOSED)');
      expect(res.stderr).toContain('Supabase remoto');
    });

    it('5.2 Rejeita sumariamente execução apontando para qualquer IP não-loopback', () => {
      const res = spawnSync(
        'bash',
        [VERIFY_SCRIPT, 'medicina2029_staging'],
        {
          env: {
            ...process.env,
            TARGET_PGHOST: '10.0.0.50',
            TARGET_PGPORT: '5432',
          },
          encoding: 'utf8',
        }
      );

      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('VIOLAÇÃO DE ISOLAMENTO LOCAL (FAIL-CLOSED)');
    });
  });
});
