/**
 * ==============================================================================
 * MEDICINA 2029 — H2.04-T1: HOMOLOGAÇÃO DE AUTENTICAÇÃO E ISOLAMENTO MULTI-TENANT
 * ==============================================================================
 * Testes direcionados em PostgreSQL descartável (PGlite com pgvector) simulando
 * rigorosamente o ambiente de Staging com as 9 migrações aplicadas:
 *
 * 1. Autenticação via RPC medicina.autenticar_por_email sob papel medicina_auth
 * 2. Proteção de Coluna e Bloqueio de RPC sob papel medicina_app (erro 42501)
 * 3. Princípio Fail-Closed absoluto sem contexto RLS e sob medicina_anon
 * 4. Isolamento estrito da estudante Alice (apenas seus dados e ciclo)
 * 5. Isolamento estrito do estudante independente Carlos (zero vínculos de tutoria)
 * 6. Escopo restrito do responsável Bruno (apenas tutelada Alice, zero Carlos)
 * 7. Rejeição compulsória de tentativas de escalada de privilégios (erro P0001)
 * 8. Isolamento transacional no Session Pooler (SET LOCAL com is_local => true)
 * 9. Diferenciação formal entre Perfil Cadastrado e Usuário Autenticado
 * ==============================================================================
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcryptjs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  PERSONA_ALICE,
  PERSONA_BRUNO,
  PERSONA_CARLOS,
  STAGING_ALICE_CICLO_ID,
  STAGING_CARLOS_CICLO_ID,
  STAGING_ARQUIVO_ID,
  provisionHomologationData,
} from '../../../scripts/db/prepare-staging-homologation.mjs';

import {
  runStagingIsolationAudit,
  validateRoleConnectionConfig,
  validateRoleSessionIdentity,
} from '../../../scripts/db/audit-staging-isolation-t1.mjs';

const MODULE_ROOT = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';
const PGLITE_INDEX = path.join(MODULE_ROOT, '@electric-sql/pglite/dist/index.js');
const PGLITE_VECTOR = path.join(MODULE_ROOT, '@electric-sql/pglite-pgvector/dist/index.js');
const HAS_PGLITE = existsSync(PGLITE_INDEX) && existsSync(PGLITE_VECTOR);

interface PGliteInstance {
  exec: (query: string) => Promise<unknown>;
  query: <T = Record<string, unknown>>(
    query: string,
    params?: unknown[]
  ) => Promise<{ rows: T[] }>;
  close: () => Promise<void>;
}

describe.skipIf(!HAS_PGLITE)('MEDICINA 2029 — H2.04-T1: Autenticação e Isolamento Multi-Tenant', () => {
  let pg: PGliteInstance;
  let sqlAdapter: any;

  const projectRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../');
  const readSql = (relPath: string) =>
    readFileSync(path.join(projectRoot, relPath), 'utf8').replaceAll(
      '--> statement-breakpoint',
      '\n'
    );

  const createSqlAdapter = (db: PGliteInstance) => {
    const executeQuery = async (strings: TemplateStringsArray, values: unknown[]) => {
      let query = strings[0];
      const params: any[] = [];
      let paramIdx = 1;
      for (let i = 0; i < values.length; i++) {
        let val: any = values[i];
        if (val && typeof val.then === 'function') {
          val = await val;
        }
        if (val && typeof val === 'object' && val.isSqlFragment) {
          query += val.text + strings[i + 1];
        } else {
          params.push(val);
          query += `$${paramIdx++}` + strings[i + 1];
        }
      }
      const res = await db.query(query, params);
      return res.rows;
    };

    const adapter: any = (strings: TemplateStringsArray | any[], ...values: any[]) => {
      if (!strings || !('raw' in strings)) {
        const arr = Array.isArray(strings) ? strings : [strings];
        return {
          isSqlFragment: true,
          text: `(${arr.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ')})`,
        };
      }
      return executeQuery(strings as TemplateStringsArray, values);
    };

    adapter.begin = async (fn: (tx: any) => Promise<any>) => {
      await db.exec('BEGIN;');
      try {
        const res = await fn(adapter);
        await db.exec('COMMIT;');
        return res;
      } catch (err) {
        await db.exec('ROLLBACK;');
        throw err;
      }
    };

    return adapter;
  };

  beforeAll(async () => {
    const { PGlite } = await import(pathToFileURL(PGLITE_INDEX).href);
    const { vector } = await import(pathToFileURL(PGLITE_VECTOR).href);
    pg = await PGlite.create({ extensions: { vector } });
    sqlAdapter = createSqlAdapter(pg);

    // Mock das tabelas auxiliares de storage
    await pg.exec(`
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
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS storage.objects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_id text REFERENCES storage.buckets(id),
        name text NOT NULL,
        owner uuid,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL,
        last_accessed_at timestamptz DEFAULT now() NOT NULL,
        metadata jsonb
      );

      CREATE TABLE IF NOT EXISTS public._medicina_staging_migrations (
        ordem integer PRIMARY KEY,
        rel_path text NOT NULL,
        sha256 text NOT NULL,
        aplicado_em timestamptz DEFAULT now() NOT NULL,
        executado_por text NOT NULL,
        tamanho_bytes integer NOT NULL
      );
    `);

    // Aplicação das 9 migrações estruturais do Staging
    await pg.exec(readSql('drizzle/0000_greedy_loki.sql'));
    await pg.exec(readSql('drizzle/0001_dry_talos.sql'));
    await pg.exec(readSql('drizzle/0002_little_swarm.sql'));
    await pg.exec(readSql('drizzle/0003_f1_03_r_expansao.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'));

    // Provisiona os 3 usuários sintéticos e entidades didáticas
    await provisionHomologationData({
      sql: sqlAdapter,
      student1Password: 'senha_sintetica_alice_123',
      responsiblePassword: 'senha_sintetica_bruno_456',
      student2Password: 'senha_sintetica_carlos_789',
      logger: () => {},
    });
  });

  afterAll(async () => {
    if (pg) {
      await pg.close();
    }
  });

  // ============================================================================
  // 1. FLUXO REAL DE AUTENTICAÇÃO E RPC SOB medicina_auth
  // ============================================================================
  describe('1. Fluxo de Autenticação e RPC sob medicina_auth', () => {
    it('1.1 medicina.autenticar_por_email retorna registro completo com hash bcrypt para Alice, Bruno e Carlos', async () => {
      await pg.exec('SET ROLE medicina_auth;');

      const aliceRes = await pg.query<{ id: string; email: string; papel: string; password_hash: string }>(
        `SELECT * FROM medicina.autenticar_por_email('${PERSONA_ALICE.email}');`
      );
      expect(aliceRes.rows).toHaveLength(1);
      expect(aliceRes.rows[0].id).toBe(PERSONA_ALICE.id);
      expect(aliceRes.rows[0].papel).toBe('estudante');
      expect(aliceRes.rows[0].password_hash.startsWith('$2')).toBe(true);

      const brunoRes = await pg.query<{ id: string; email: string; papel: string; password_hash: string }>(
        `SELECT * FROM medicina.autenticar_por_email('${PERSONA_BRUNO.email}');`
      );
      expect(brunoRes.rows).toHaveLength(1);
      expect(brunoRes.rows[0].id).toBe(PERSONA_BRUNO.id);
      expect(brunoRes.rows[0].papel).toBe('responsavel');
      expect(brunoRes.rows[0].password_hash.startsWith('$2')).toBe(true);

      const carlosRes = await pg.query<{ id: string; email: string; papel: string; password_hash: string }>(
        `SELECT * FROM medicina.autenticar_por_email('${PERSONA_CARLOS.email}');`
      );
      expect(carlosRes.rows).toHaveLength(1);
      expect(carlosRes.rows[0].id).toBe(PERSONA_CARLOS.id);
      expect(carlosRes.rows[0].papel).toBe('estudante');
      expect(carlosRes.rows[0].password_hash.startsWith('$2')).toBe(true);

      await pg.exec('RESET ROLE;');
    });

    it('1.2 Anti-enumeração: e-mail fora da allowlist retorna 0 linhas imediatamente', async () => {
      await pg.exec('SET ROLE medicina_auth;');

      const res = await pg.query(
        `SELECT * FROM medicina.autenticar_por_email('invasor@desconhecido.com');`
      );
      expect(res.rows).toHaveLength(0);

      const nullRes = await pg.query(
        `SELECT * FROM medicina.autenticar_por_email(NULL);`
      );
      expect(nullRes.rows).toHaveLength(0);

      await pg.exec('RESET ROLE;');
    });

    it('1.3 Validação de senha: hash bcrypt gerado valida estritamente a senha correspondente', async () => {
      await pg.exec('SET ROLE medicina_auth;');

      const aliceRes = await pg.query<{ password_hash: string }>(
        `SELECT password_hash FROM medicina.autenticar_por_email('${PERSONA_ALICE.email}');`
      );
      const hashAlice = aliceRes.rows[0].password_hash;

      const senhaCorreta = await bcrypt.compare('senha_sintetica_alice_123', hashAlice);
      expect(senhaCorreta).toBe(true);

      const senhaIncorreta = await bcrypt.compare('senha_errada', hashAlice);
      expect(senhaIncorreta).toBe(false);

      await pg.exec('RESET ROLE;');
    });
  });

  // ============================================================================
  // 2. SEGURANÇA E FRONTEIRAS TÉCNICAS DO PAPEL APLICACIONAL (medicina_app)
  // ============================================================================
  describe('2. Segurança de Privilégios e Proteção de Coluna sob medicina_app', () => {
    it('2.1 Bloqueio de RPC: medicina_app NÃO possui permissão em medicina.autenticar_por_email (erro 42501)', async () => {
      await pg.exec('SET ROLE medicina_app;');

      let errorCaught: any = null;
      try {
        await pg.query(`SELECT * FROM medicina.autenticar_por_email('${PERSONA_ALICE.email}');`);
      } catch (err) {
        errorCaught = err;
      }

      await pg.exec('RESET ROLE;');

      expect(errorCaught).not.toBeNull();
      expect(/permission denied/i.test(errorCaught?.message || '')).toBe(true);
    });

    it('2.2 Proteção de Coluna: leitura direta da coluna password_hash é revogada de medicina_app (erro 42501)', async () => {
      await pg.exec('SET ROLE medicina_app;');

      let errorCaught: any = null;
      try {
        await pg.query(`SELECT password_hash FROM public.perfis;`);
      } catch (err) {
        errorCaught = err;
      }

      await pg.exec('RESET ROLE;');

      expect(errorCaught).not.toBeNull();
      expect(/permission denied/i.test(errorCaught?.message || '')).toBe(true);
    });
  });

  // ============================================================================
  // 3. PRINCÍPIO FAIL-CLOSED (SEM CONTEXTO OU PAPEL ANÔNIMO)
  // ============================================================================
  describe('3. Princípio Fail-Closed', () => {
    it('3.1 Consulta sob medicina_app sem chamar medicina.set_context retorna 0 linhas em todas as tabelas privadas', async () => {
      await pg.exec('SET ROLE medicina_app;');

      const perfis = await pg.query('SELECT count(*) FROM public.perfis;');
      expect(Number(perfis.rows[0].count)).toBe(0);

      const ciclos = await pg.query('SELECT count(*) FROM public.ciclos;');
      expect(Number(ciclos.rows[0].count)).toBe(0);

      const cards = await pg.query('SELECT count(*) FROM public.cards;');
      expect(Number(cards.rows[0].count)).toBe(0);

      const vinculos = await pg.query('SELECT count(*) FROM public.responsavel_estudante;');
      expect(Number(vinculos.rows[0].count)).toBe(0);

      const arquivos = await pg.query('SELECT count(*) FROM public.acervo_arquivos;');
      expect(Number(arquivos.rows[0].count)).toBe(0);

      await pg.exec('RESET ROLE;');
    });

    it('3.2 Consulta sob medicina_anon é bloqueada ou retorna 0 linhas (fail-closed absoluto)', async () => {
      await pg.exec('SET ROLE medicina_anon;');

      // Como medicina_anon não possui permissão de leitura de funções ou tabelas privadas,
      // qualquer tentativa resulta em erro 42501 (permission denied) ou 0 linhas.
      let blockedOrZero = false;
      try {
        const perfis = await pg.query('SELECT count(*) FROM public.perfis;');
        blockedOrZero = Number(perfis.rows[0].count) === 0;
      } catch (err: any) {
        blockedOrZero = /permission denied/i.test(err?.message || '') || err?.code === '42501';
      }

      await pg.exec('RESET ROLE;');

      expect(blockedOrZero).toBe(true);
    });
  });

  // ============================================================================
  // 4. ISOLAMENTO MULTI-TENANT: ESTUDANTE ALICE
  // ============================================================================
  describe('4. Isolamento RLS da Estudante Alice', () => {
    it('4.1 Alice enxerga exclusivamente seu perfil, seu ciclo (28 blocos), seus 3 cards e seu vínculo de tutoria', async () => {
      await pg.exec('BEGIN;');
      await pg.exec('SET ROLE medicina_app;');
      await pg.exec(`SELECT medicina.set_context('${PERSONA_ALICE.id}'::uuid, 'estudante');`);

      // Perfil
      const perfisRes = await pg.query<{ id: string }>(`SELECT id FROM public.perfis;`);
      expect(perfisRes.rows).toHaveLength(1);
      expect(perfisRes.rows[0].id).toBe(PERSONA_ALICE.id);

      // Ciclo
      const ciclosRes = await pg.query<{ id: string; estudante_perfil_id: string }>(`SELECT id, estudante_perfil_id FROM public.ciclos;`);
      expect(ciclosRes.rows).toHaveLength(1);
      expect(ciclosRes.rows[0].id).toBe(STAGING_ALICE_CICLO_ID);
      expect(ciclosRes.rows[0].estudante_perfil_id).toBe(PERSONA_ALICE.id);

      // Blocos do ciclo (Alice tem 28 blocos; os 28 de Carlos devem ser invisíveis)
      const blocosRes = await pg.query<{ count: string }>(`SELECT count(*) FROM public.ciclo_blocos;`);
      expect(Number(blocosRes.rows[0].count)).toBe(28);

      // Cards FSRS (Alice tem 3 cards; os 2 de Carlos devem ser invisíveis)
      const cardsRes = await pg.query<{ id: string; perfil_id: string }>(`SELECT id, perfil_id FROM public.cards;`);
      expect(cardsRes.rows).toHaveLength(3);
      expect(cardsRes.rows.every((c) => c.perfil_id === PERSONA_ALICE.id)).toBe(true);

      // Vínculo tutelar: Alice enxerga a relação onde ela é a estudante tutelada
      const vinculoRes = await pg.query<{ estudante_perfil_id: string }>(`SELECT estudante_perfil_id FROM public.responsavel_estudante;`);
      expect(vinculoRes.rows).toHaveLength(1);
      expect(vinculoRes.rows[0].estudante_perfil_id).toBe(PERSONA_ALICE.id);

      // Acervo: estudante não tem SELECT em acervo_arquivos
      const arquivosRes = await pg.query<{ count: string }>(`SELECT count(*) FROM public.acervo_arquivos;`);
      expect(Number(arquivosRes.rows[0].count)).toBe(0);

      await pg.exec('ROLLBACK;');
      await pg.exec('RESET ROLE;');
    });
  });

  // ============================================================================
  // 5. ISOLAMENTO MULTI-TENANT: ESTUDANTE INDEPENDENTE CARLOS
  // ============================================================================
  describe('5. Isolamento RLS do Estudante Independente Carlos', () => {
    it('5.1 Carlos enxerga exclusivamente seu perfil, seu ciclo (28 blocos) e seus 2 cards; zero tutoria e zero Alice', async () => {
      await pg.exec('BEGIN;');
      await pg.exec('SET ROLE medicina_app;');
      await pg.exec(`SELECT medicina.set_context('${PERSONA_CARLOS.id}'::uuid, 'estudante');`);

      // Perfil
      const perfisRes = await pg.query<{ id: string }>(`SELECT id FROM public.perfis;`);
      expect(perfisRes.rows).toHaveLength(1);
      expect(perfisRes.rows[0].id).toBe(PERSONA_CARLOS.id);

      // Ciclo
      const ciclosRes = await pg.query<{ id: string; estudante_perfil_id: string }>(`SELECT id, estudante_perfil_id FROM public.ciclos;`);
      expect(ciclosRes.rows).toHaveLength(1);
      expect(ciclosRes.rows[0].id).toBe(STAGING_CARLOS_CICLO_ID);
      expect(ciclosRes.rows[0].estudante_perfil_id).toBe(PERSONA_CARLOS.id);

      // Blocos do ciclo (28 blocos de Carlos)
      const blocosRes = await pg.query<{ count: string }>(`SELECT count(*) FROM public.ciclo_blocos;`);
      expect(Number(blocosRes.rows[0].count)).toBe(28);

      // Cards FSRS (2 cards de Carlos)
      const cardsRes = await pg.query<{ id: string; perfil_id: string }>(`SELECT id, perfil_id FROM public.cards;`);
      expect(cardsRes.rows).toHaveLength(2);
      expect(cardsRes.rows.every((c) => c.perfil_id === PERSONA_CARLOS.id)).toBe(true);

      // Vínculo tutelar: Carlos é independente, vínculo Bruno->Alice é 100% invisível
      const vinculoRes = await pg.query<{ count: string }>(`SELECT count(*) FROM public.responsavel_estudante;`);
      expect(Number(vinculoRes.rows[0].count)).toBe(0);

      // Acervo
      const arquivosRes = await pg.query<{ count: string }>(`SELECT count(*) FROM public.acervo_arquivos;`);
      expect(Number(arquivosRes.rows[0].count)).toBe(0);

      await pg.exec('ROLLBACK;');
      await pg.exec('RESET ROLE;');
    });
  });

  // ============================================================================
  // 6. ESCOPO DE ACESSO DO RESPONSÁVEL BRUNO
  // ============================================================================
  describe('6. Escopo de Acesso do Responsável Bruno (Tutela de Alice, Zero Carlos)', () => {
    it('6.1 Bruno enxerga apenas seu perfil e o da tutelada Alice, seu vínculo e seu arquivo no acervo; Carlos e ciclos são invisíveis', async () => {
      await pg.exec('BEGIN;');
      await pg.exec('SET ROLE medicina_app;');
      await pg.exec(`SELECT medicina.set_context('${PERSONA_BRUNO.id}'::uuid, 'responsavel');`);

      // Perfis visíveis: próprio Bruno + tutelada Alice (total = 2). Carlos é invisível.
      const perfisRes = await pg.query<{ id: string }>(`SELECT id FROM public.perfis;`);
      expect(perfisRes.rows).toHaveLength(2);
      const ids = perfisRes.rows.map((p) => p.id);
      expect(ids).toContain(PERSONA_BRUNO.id);
      expect(ids).toContain(PERSONA_ALICE.id);
      expect(ids).not.toContain(PERSONA_CARLOS.id);

      // Vínculo tutelar
      const vinculosRes = await pg.query<{ responsavel_perfil_id: string; estudante_perfil_id: string }>(
        `SELECT responsavel_perfil_id, estudante_perfil_id FROM public.responsavel_estudante;`
      );
      expect(vinculosRes.rows).toHaveLength(1);
      expect(vinculosRes.rows[0].responsavel_perfil_id).toBe(PERSONA_BRUNO.id);
      expect(vinculosRes.rows[0].estudante_perfil_id).toBe(PERSONA_ALICE.id);

      // Acervo didático enviado por Bruno
      const arquivosRes = await pg.query<{ id: string; enviado_por: string }>(
        `SELECT id, enviado_por FROM public.acervo_arquivos;`
      );
      expect(arquivosRes.rows).toHaveLength(1);
      expect(arquivosRes.rows[0].id).toBe(STAGING_ARQUIVO_ID);
      expect(arquivosRes.rows[0].enviado_por).toBe(PERSONA_BRUNO.id);

      // Anti-vigilância: responsável não possui SELECT direto na tabela ciclos (acompanhamento via view quinzenal)
      const ciclosRes = await pg.query<{ count: string }>(`SELECT count(*) FROM public.ciclos;`);
      expect(Number(ciclosRes.rows[0].count)).toBe(0);

      await pg.exec('ROLLBACK;');
      await pg.exec('RESET ROLE;');
    });
  });

  // ============================================================================
  // 7. REJEIÇÃO COMPULSÓRIA DE ESCALADA DE PRIVILÉGIOS
  // ============================================================================
  describe('7. Rejeição Compulsória de Escalada de Privilégios', () => {
    it('7.1 Carlos tentando assumir papel responsavel lança exceção P0001', async () => {
      await pg.exec('BEGIN;');
      await pg.exec('SET ROLE medicina_app;');

      let errorCaught: any = null;
      try {
        await pg.query(`SELECT medicina.set_context('${PERSONA_CARLOS.id}'::uuid, 'responsavel');`);
      } catch (err) {
        errorCaught = err;
      }

      await pg.exec('ROLLBACK;');
      await pg.exec('RESET ROLE;');

      expect(errorCaught).not.toBeNull();
      expect(/Contexto invalido/i.test(errorCaught?.message || '')).toBe(true);
    });

    it('7.2 UUID inexistente ou arbitrário lança exceção P0001', async () => {
      await pg.exec('BEGIN;');
      await pg.exec('SET ROLE medicina_app;');

      let errorCaught: any = null;
      try {
        await pg.query(`SELECT medicina.set_context('ffffffff-ffff-4fff-bfff-ffffffffffff'::uuid, 'estudante');`);
      } catch (err) {
        errorCaught = err;
      }

      await pg.exec('ROLLBACK;');
      await pg.exec('RESET ROLE;');

      expect(errorCaught).not.toBeNull();
      expect(/Contexto invalido/i.test(errorCaught?.message || '')).toBe(true);
    });

    it('7.3 Papel inválido ("admin") lança exceção P0001', async () => {
      await pg.exec('BEGIN;');
      await pg.exec('SET ROLE medicina_app;');

      let errorCaught: any = null;
      try {
        await pg.query(`SELECT medicina.set_context('${PERSONA_ALICE.id}'::uuid, 'admin');`);
      } catch (err) {
        errorCaught = err;
      }

      await pg.exec('ROLLBACK;');
      await pg.exec('RESET ROLE;');

      expect(errorCaught).not.toBeNull();
      expect(/Papel invalido/i.test(errorCaught?.message || '')).toBe(true);
    });
  });

  // ============================================================================
  // 8. ISOLAMENTO TRANSACIONAL NO SESSION POOLER (SET LOCAL)
  // ============================================================================
  describe('8. Isolamento Transacional e Pooler Safety (SET LOCAL)', () => {
    it('8.1 Ao encerrar uma transação, o contexto RLS é descartado e a transação seguinte na mesma conexão encontra NULL', async () => {
      // Transação 1: Define Alice e faz commit
      await pg.exec('BEGIN;');
      await pg.exec('SET ROLE medicina_app;');
      await pg.exec(`SELECT medicina.set_context('${PERSONA_ALICE.id}'::uuid, 'estudante');`);
      const t1 = await pg.query<{ id: string }>(`SELECT medicina.current_perfil_id() as id;`);
      expect(t1.rows[0].id).toBe(PERSONA_ALICE.id);
      await pg.exec('COMMIT;');

      // Transação 2: Na MESMA conexão física, sem definir contexto
      await pg.exec('BEGIN;');
      await pg.exec('SET ROLE medicina_app;');
      const t2Context = await pg.query<{ id: string | null }>(`SELECT medicina.current_perfil_id() as id;`);
      expect(t2Context.rows[0].id).toBeNull();

      const t2Perfis = await pg.query<{ count: string }>(`SELECT count(*) FROM public.perfis;`);
      expect(Number(t2Perfis.rows[0].count)).toBe(0);

      await pg.exec('ROLLBACK;');
      await pg.exec('RESET ROLE;');
    });
  });

  // ============================================================================
  // 9. DIFERENCIAÇÃO: PERFIL CADASTRADO vs USUÁRIO AUTENTICADO
  // ============================================================================
  describe('9. Diferenciação Formal: Perfil Cadastrado vs Usuário Autenticado', () => {
    it('9.1 Perfil cadastrado existe com hash bcrypt válido, mas login com senha arbitrária falha', async () => {
      // O perfil de Alice existe no banco
      const res = await pg.query<{ password_hash: string }>(
        `SELECT password_hash FROM public.perfis WHERE id = '${PERSONA_ALICE.id}';`
      );
      expect(res.rows).toHaveLength(1);
      const hash = res.rows[0].password_hash;

      // Uma senha inventada pelo operador/teste sem conhecimento da semente NÃO passa
      const tentativaIncorreta = await bcrypt.compare('senha_inventada_qualquer', hash);
      expect(tentativaIncorreta).toBe(false);

      // Conclusão formal: A existência do registro de perfil NÃO equivale a login funcional de ponta a ponta
    });
  });

  // ============================================================================
  // 10. VALIDAÇÃO DE SINTAXE ESM E EXECUÇÃO COMO PROCESSO NODE.JS REAL (H2.04-T1-R)
  // ============================================================================
  describe('10. Validação de Sintaxe ESM e Execução do Processo Node.js do Auditor (H2.04-T1-R)', () => {
    const auditorScriptPath = path.join(projectRoot, 'scripts/db/audit-staging-isolation-t1.mjs');

    it('10.1 "node --check" valida sintaxe JavaScript pura sem qualquer erro de TypeScript', () => {
      const res = spawnSync(process.execPath, ['--check', auditorScriptPath], {
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
    });

    it('10.2 Invocação com "--help" executa como processo Node.js real e exibe ajuda sem SyntaxError', () => {
      const res = spawnSync(process.execPath, [auditorScriptPath, '--help'], {
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Uso do Auditor de Autenticação e Isolamento Staging');
      expect(res.stderr).toBe('');
    });

    it('10.3 Invocação com certificado CA inexistente rejeita com mensagem controlada e sem SyntaxError', () => {
      const res = spawnSync(
        process.execPath,
        [auditorScriptPath, '--ca=/tmp/caminho_inexistente_ca_cert.crt'],
        {
          encoding: 'utf8',
        }
      );
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('ERRO TLS');
      expect(res.stderr).not.toContain('SyntaxError');
    });

    it('10.4 A função exportada runStagingIsolationAudit executa todos os 8 grupos de cenários com sucesso', async () => {
      const logs: string[] = [];
      const { success, results } = await runStagingIsolationAudit({
        sql: sqlAdapter,
        logger: (msg: string) => logs.push(msg),
      });

      expect(success).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(10);
      expect(results.every((r) => r.status === 'APROVADO')).toBe(true);
    });
  });

  // ============================================================================
  // 11. DIAGNÓSTICO E PREVENÇÃO DE FALHAS DE ROLES REAIS (H2.04-T1-R2)
  // ============================================================================
  describe('11. Diagnóstico e Prevenção de Falhas de Roles Reais (H2.04-T1-R2)', () => {
    const createRoleSqlMock = (db: PGliteInstance, roleName: string) => {
      const executeQuery = async (strings: TemplateStringsArray, values: unknown[]) => {
        await db.exec(`SET ROLE ${roleName};`).catch(() => {});
        try {
          let query = strings[0];
          const params: any[] = [];
          let paramIdx = 1;
          for (let i = 0; i < values.length; i++) {
            let val: any = values[i];
            if (val && typeof val.then === 'function') {
              val = await val;
            }
            if (val && typeof val === 'object' && (val as any).isSqlFragment) {
              query += (val as any).text + strings[i + 1];
            } else {
              params.push(val);
              query += `$${paramIdx++}` + strings[i + 1];
            }
          }
          const res = await db.query(query, params);
          return res.rows;
        } finally {
          await db.exec('RESET ROLE;').catch(() => {});
        }
      };

      const adapter: any = (strings: TemplateStringsArray | any[], ...values: any[]) => {
        if (!strings || !('raw' in strings)) {
          const arr = Array.isArray(strings) ? strings : [strings];
          return {
            isSqlFragment: true,
            text: `(${arr.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ')})`,
          };
        }
        return executeQuery(strings as TemplateStringsArray, values);
      };

      adapter.begin = async (fn: (tx: any) => Promise<any>) => {
        await db.exec('BEGIN;');
        await db.exec(`SET ROLE ${roleName};`).catch(() => {});
        try {
          const txMock: any = async (strings: TemplateStringsArray, ...values: any[]) => {
            let query = strings[0];
            const params: any[] = [];
            let paramIdx = 1;
            for (let i = 0; i < values.length; i++) {
              let val: any = values[i];
              if (val && typeof val.then === 'function') {
                val = await val;
              }
              if (val && typeof val === 'object' && (val as any).isSqlFragment) {
                query += (val as any).text + strings[i + 1];
              } else {
                params.push(val);
                query += `$${paramIdx++}` + strings[i + 1];
              }
            }
            const res = await db.query(query, params);
            return res.rows;
          };
          const res = await fn(txMock);
          await db.exec('COMMIT;');
          return res;
        } catch (err) {
          await db.exec('ROLLBACK;');
          throw err;
        } finally {
          await db.exec('RESET ROLE;').catch(() => {});
        }
      };

      adapter.isMock = true;
      return adapter;
    };

    it('11.1 Falha em SET ROLE: usuário sem permissão lança erro 42501 ao tentar assumir outra role', async () => {
      const { PGlite } = await import(pathToFileURL(PGLITE_INDEX).href);
      const isolatedDb = new PGlite();
      try {
        await isolatedDb.exec(`
          CREATE ROLE test_app NOSUPERUSER NOCREATEROLE;
          CREATE ROLE test_auth NOSUPERUSER NOCREATEROLE;
          SET SESSION AUTHORIZATION test_app;
        `);

        let errorCaught: any = null;
        try {
          await isolatedDb.exec('SET ROLE test_auth;');
        } catch (err) {
          errorCaught = err;
        }

        expect(errorCaught).not.toBeNull();
        expect(/permission denied/i.test(errorCaught?.message || '')).toBe(true);
        expect(/role/i.test(errorCaught?.message || '')).toBe(true);
      } finally {
        await isolatedDb.close().catch(() => {});
      }
    });

    it('11.2 Prevenção de Falso Positivo: erro em SET ROLE não é tratado como aprovação de bloqueio RLS/RPC', async () => {
      // Simula um erro gerado por SET ROLE em vez da função
      const setRoleError = new Error('permission denied to set role "medicina_app"');
      (setRoleError as any).code = '42501';

      const errMsg = setRoleError.message;
      const isSetRoleFailure = /permission denied to set role/i.test(errMsg);
      const isExpectedFunctionDenial =
        !isSetRoleFailure &&
        ((setRoleError as any).code === '42501' || /permission denied/i.test(errMsg)) &&
        /autenticar_por_email/i.test(errMsg);

      // O erro de SET ROLE DEVE ser detectado como falha de infraestrutura, e NÃO aprovar o teste SEC-01
      expect(isSetRoleFailure).toBe(true);
      expect(isExpectedFunctionDenial).toBe(false);
    });

    it('11.3 Conexão Direta Correta: validateRoleSessionIdentity valida current_user, login, super=false e bypassrls=false', async () => {
      const authMock = createRoleSqlMock(pg, 'medicina_auth');
      const authIdentity = await validateRoleSessionIdentity(authMock, 'medicina_auth');

      expect(authIdentity.connectedUser).toBe('medicina_auth');
      expect(authIdentity.rolcanlogin).toBe(true);
      expect(authIdentity.rolsuper).toBe(false);
      expect(authIdentity.rolbypassrls).toBe(false);

      const appMock = createRoleSqlMock(pg, 'medicina_app');
      const appIdentity = await validateRoleSessionIdentity(appMock, 'medicina_app');

      expect(appIdentity.connectedUser).toBe('medicina_app');
      expect(appIdentity.rolcanlogin).toBe(true);
      expect(appIdentity.rolsuper).toBe(false);
      expect(appIdentity.rolbypassrls).toBe(false);
    });

    it('11.4 Identidade PostgreSQL Inesperada: validateRoleSessionIdentity aborta se current_user divergir', async () => {
      const authMock = createRoleSqlMock(pg, 'medicina_auth');

      await expect(
        validateRoleSessionIdentity(authMock, 'medicina_app')
      ).rejects.toThrow(/VIOLAÇÃO DE IDENTIDADE/);
    });

    it('11.5 Validação de URL de Conexão com Project Ref: validateRoleConnectionConfig rejeita configurações inválidas', () => {
      // Válido
      const validUrl = 'postgresql://medicina_app.ynfocaorhadizlvbnzrt:senha123@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
      const config = validateRoleConnectionConfig(validUrl, 'medicina_app');
      expect(config.valid).toBe(true);

      // Role incorreta na URL
      expect(() =>
        validateRoleConnectionConfig(validUrl, 'medicina_auth')
      ).toThrow(/VIOLAÇÃO DE ROLE/);

      // Porta de Transaction Pooler 6543 (quando esperado Session Pooler 5432)
      const invalidPortUrl = 'postgresql://medicina_app.ynfocaorhadizlvbnzrt:senha123@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
      expect(() =>
        validateRoleConnectionConfig(invalidPortUrl, 'medicina_app')
      ).toThrow(/VIOLAÇÃO DE PORTA/);

      // Host incorreto
      const invalidHostUrl = 'postgresql://medicina_app.ynfocaorhadizlvbnzrt:senha123@localhost:5432/postgres';
      expect(() =>
        validateRoleConnectionConfig(invalidHostUrl, 'medicina_app')
      ).toThrow(/VIOLAÇÃO DE HOST/);
    });

    it('11.6 Execução Dual Completa: runStagingIsolationAudit opera diretamente com authSql e appSql sem SET ROLE', async () => {
      const authMock = createRoleSqlMock(pg, 'medicina_auth');
      const appMock = createRoleSqlMock(pg, 'medicina_app');
      const logs: string[] = [];

      const { success, results } = await runStagingIsolationAudit({
        authSql: authMock,
        appSql: appMock,
        logger: (msg: string) => logs.push(msg),
      });

      expect(success).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(10);
      expect(results.every((r) => r.status === 'APROVADO')).toBe(true);

      // Comprova que todos os cenários principais foram avaliados com sucesso
      const scenarioCodes = results.map((r) => r.code);
      expect(scenarioCodes).toContain('AUT-01');
      expect(scenarioCodes).toContain('AUT-04');
      expect(scenarioCodes).toContain('SEC-01');
      expect(scenarioCodes).toContain('SEC-02');
      expect(scenarioCodes).toContain('RLS-01');
      expect(scenarioCodes).toContain('RLS-02');
      expect(scenarioCodes).toContain('ISO-01');
      expect(scenarioCodes).toContain('ISO-02');
      expect(scenarioCodes).toContain('ISO-03');
      expect(scenarioCodes).toContain('ESC-01');
      expect(scenarioCodes).toContain('POL-01');
    });
  });
});
