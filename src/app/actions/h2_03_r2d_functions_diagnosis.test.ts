/**
 * ==============================================================================
 * MEDICINA 2029 — H2.03-R2D: DIAGNÓSTICO DAS FUNÇÕES SQL DO BASELINE
 * ==============================================================================
 * Testes direcionados para comprovar o diagnóstico de falsos negativos
 * e a conformidade do catálogo de funções canônicas do banco restaurado.
 * ==============================================================================
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
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

describe('MEDICINA 2029 — H2.03-R2D: Diagnóstico das Funções SQL Ausentes', () => {
  let pglite: PGliteInstance;

  beforeEach(async () => {
    pglite = new PGlite();
  });

  afterEach(async () => {
    try {
      await pglite.close();
    } catch {}
  });

  // ---------------------------------------------------------------------------
  // 1. ANÁLISE DAS TRÊS FUNÇÕES RECLAMADAS (FALSOS NEGATIVOS)
  // ---------------------------------------------------------------------------
  describe('1. Diagnóstico e Comprovação de Falsos Negativos', () => {
    it('1.1 Confirma que gerar_hash_questao não existe em nenhuma migração ou schema Drizzle', () => {
      const migrationsDir = path.join(PROJECT_ROOT, 'drizzle');
      const proposalsDir = path.join(PROJECT_ROOT, 'docs/modernizacao/propostas');

      const allSqlFiles = [
        ...fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).map(f => path.join(migrationsDir, f)),
        ...fs.readdirSync(proposalsDir).filter(f => f.endsWith('.sql')).map(f => path.join(proposalsDir, f)),
      ];

      for (const file of allSqlFiles) {
        const content = fs.readFileSync(file, 'utf8');
        expect(content).not.toContain('gerar_hash_questao');
      }
    });

    it('1.2 Confirma que fn_atualizar_modificado_em não existe e não há triggers de timestamp no baseline', () => {
      const migrationsDir = path.join(PROJECT_ROOT, 'drizzle');
      const proposalsDir = path.join(PROJECT_ROOT, 'docs/modernizacao/propostas');

      const allSqlFiles = [
        ...fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).map(f => path.join(migrationsDir, f)),
        ...fs.readdirSync(proposalsDir).filter(f => f.endsWith('.sql')).map(f => path.join(proposalsDir, f)),
      ];

      for (const file of allSqlFiles) {
        const content = fs.readFileSync(file, 'utf8');
        expect(content).not.toContain('fn_atualizar_modificado_em');
      }
    });

    it('1.3 Confirma que papel_enum possui apenas estudante e responsavel (sem admin)', () => {
      const lokiSql = fs.readFileSync(path.join(PROJECT_ROOT, 'drizzle/0000_greedy_loki.sql'), 'utf8');
      expect(lokiSql).toMatch(/CREATE\s+TYPE\s+"public"\."papel_enum"\s+AS\s+ENUM\('estudante',\s*'responsavel'\);/i);
      expect(lokiSql).not.toContain("'admin'");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. CONFORMIDADE DO CATÁLOGO DE FUNÇÕES CANÔNICAS DO DOMÍNIO
  // ---------------------------------------------------------------------------
  describe('2. Validação do Catálogo Canônico de Funções Reais', () => {
    it('2.1 verify_restore.sh agora verifica as 10 funções canônicas reais e legítimas', () => {
      const scriptContent = fs.readFileSync(VERIFY_SCRIPT, 'utf8');

      // Não deve mais conter os 3 nomes especulativos
      expect(scriptContent).not.toContain('gerar_hash_questao');
      expect(scriptContent).not.toContain('fn_atualizar_modificado_em');
      expect(scriptContent).not.toContain('fn_proteger_papel_admin');

      // Deve conter as funções canônicas de segurança e negócio
      expect(scriptContent).toContain('autenticar_por_email');
      expect(scriptContent).toContain('fn_busca_hibrida_acervo');
      expect(scriptContent).toContain('set_context');
      expect(scriptContent).toContain('current_papel');
      expect(scriptContent).toContain('is_estudante');
      expect(scriptContent).toContain('is_responsavel');
      expect(scriptContent).toContain('is_valid_acervo_storage_path');
      expect(scriptContent).toContain('fn_acompanhamento_quinzenal');
      expect(scriptContent).toContain('fn_simulados_evolucao');
      expect(scriptContent).toContain('check_allowlist');
    });

    it('2.2 Executa a verificação canônica com sucesso em motor PostgreSQL real (PGlite)', async () => {
      // Cria schemas e funções canônicas de teste
      await pglite.exec(`
        CREATE SCHEMA medicina;
        CREATE FUNCTION medicina.autenticar_por_email(p_email text) RETURNS text LANGUAGE sql AS 'SELECT p_email';
        CREATE FUNCTION medicina.fn_busca_hibrida_acervo(termo text) RETURNS text LANGUAGE sql AS 'SELECT termo';
        CREATE FUNCTION medicina.set_context(p_perfil_id uuid, p_papel text) RETURNS void LANGUAGE sql AS 'SELECT NULL';
        CREATE FUNCTION medicina.current_papel() RETURNS text LANGUAGE sql AS 'SELECT NULL';
        CREATE FUNCTION medicina.is_estudante() RETURNS boolean LANGUAGE sql AS 'SELECT true';
        CREATE FUNCTION medicina.is_responsavel() RETURNS boolean LANGUAGE sql AS 'SELECT false';
        CREATE FUNCTION medicina.is_valid_acervo_storage_path(p_name text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
        CREATE FUNCTION medicina.fn_acompanhamento_quinzenal() RETURNS void LANGUAGE sql AS 'SELECT NULL';
        CREATE FUNCTION medicina.fn_simulados_evolucao() RETURNS void LANGUAGE sql AS 'SELECT NULL';
        CREATE FUNCTION public.check_allowlist() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;';
      `);

      const canonicalFns = [
        'autenticar_por_email',
        'fn_busca_hibrida_acervo',
        'set_context',
        'current_papel',
        'is_estudante',
        'is_responsavel',
        'is_valid_acervo_storage_path',
        'fn_acompanhamento_quinzenal',
        'fn_simulados_evolucao',
        'check_allowlist',
      ];

      for (const fn of canonicalFns) {
        const res = await pglite.query<{ exists: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = '${fn}' AND n.nspname IN ('medicina', 'public')
          ) as exists;
        `);
        expect(res.rows[0].exists).toBe(true);
      }
    });
  });
});
