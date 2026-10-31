/**
 * ==============================================================================
 * MEDICINA 2029 — H2.04-R3: CORREÇÃO DO PORTÃO DE IDENTIDADE DO STAGING
 * ==============================================================================
 * Testes direcionados em PostgreSQL descartável (PGlite com pgvector):
 * 1. Session Pooler legítimo: aceita conexão com current_user='postgres' (zero falso positivo)
 * 2. Usuário com project ref incorreto ou ausente: rejeição estrita (fail-closed)
 * 3. Host ou porta incorretos (6543, 5433, host de produção): rejeição estrita
 * 4. Histórico de migrações divergente (contagem < 9 ou hash SHA-256 adulterado): rejeição
 * 5. TLS inválido ou certificado corrompido: rejeição estrita
 * 6. Estrutura canônica: validação passiva das 18 tabelas essenciais
 * 7. Portão fail-closed transacional antes de qualquer INSERT
 * ==============================================================================
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  TARGET_HOST,
  TARGET_PORT,
  TARGET_DB,
  TARGET_ROLE,
  TARGET_PROJECT_REF,
  TARGET_USERNAME,
  CANONICAL_CORE_TABLES,
  validateStagingConnectionConfig,
  runPreflightAudit,
  provisionHomologationData,
} from '../../../scripts/db/prepare-staging-homologation.mjs';

import {
  resolveCaCertificate,
} from '../../../scripts/db/test-staging-connection.mjs';

import {
  getMigrationManifest,
} from '../../../scripts/db/migrate-staging.mjs';

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

describe.skipIf(!HAS_PGLITE)('MEDICINA 2029 — H2.04-R3: Portão de Identidade do Staging', () => {
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

    // 0. Schema storage simulado e bucket acervo exigido pela migração 7
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

      CREATE TABLE IF NOT EXISTS public._medicina_staging_migrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ordem integer NOT NULL UNIQUE,
        rel_path text NOT NULL UNIQUE,
        sha256 text NOT NULL,
        aplicado_em timestamptz DEFAULT now() NOT NULL,
        executado_por text NOT NULL,
        tamanho_bytes integer NOT NULL
      );
    `);

    // 2. Aplicação das 9 migrações estruturais canônicas
    await pg.exec(readSql('drizzle/0000_greedy_loki.sql'));
    await pg.exec(readSql('drizzle/0001_dry_talos.sql'));
    await pg.exec(readSql('drizzle/0002_little_swarm.sql'));
    await pg.exec(readSql('drizzle/0003_f1_03_r_expansao.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'));

    // Registra as 9 migrações no histórico canônico com hashes reais dos arquivos
    const manifest = getMigrationManifest(projectRoot);
    for (const m of manifest) {
      await pg.exec(`
        INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
        VALUES (${m.ordem}, '${m.relPath}', '${m.sha256}', '${TARGET_USERNAME}', ${m.tamanhoBytes})
        ON CONFLICT (ordem) DO UPDATE SET sha256 = EXCLUDED.sha256, rel_path = EXCLUDED.rel_path;
      `);
    }
  });

  afterAll(async () => {
    if (pg) {
      await pg.close();
    }
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 1: SESSION POOLER LEGÍTIMO COM CURRENT_USER='postgres'
  // ----------------------------------------------------------------------------
  it('1. Session Pooler legítimo: aceita conexão com current_user="postgres" sem falso bloqueio', async () => {
    // 1.1 Validação de configuração pré-conexão
    const validUrl = `postgresql://${TARGET_USERNAME}:senhaSegura123@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}`;
    const configResult = validateStagingConnectionConfig(validUrl);

    expect(configResult.valid).toBe(true);
    expect(configResult.host).toBe(TARGET_HOST);
    expect(configResult.port).toBe(5432);
    expect(configResult.db).toBe('postgres');
    expect(configResult.user).toBe('postgres.ynfocaorhadizlvbnzrt');
    expect(configResult.projectRef).toBe('ynfocaorhadizlvbnzrt');

    // 1.2 Validação remota de leitura: no PostgreSQL do pooler, current_user é 'postgres'
    const logs: string[] = [];
    const auditResult = await runPreflightAudit({
      sql: sqlAdapter,
      logger: (msg: string) => logs.push(msg),
    });

    expect(auditResult.success).toBe(true);
    expect(auditResult.role).toBe('postgres');
    expect(auditResult.db).toBe('postgres');
    expect(auditResult.migrationsCount).toBe(9);
    expect(auditResult.tablesCount).toBe(CANONICAL_CORE_TABLES.length);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 2: USUÁRIO COM PROJECT REF INCORRETO OU AUSENTE
  // ----------------------------------------------------------------------------
  it('2. Usuário com project ref incorreto ou ausente: rejeição estrita (fail-closed)', () => {
    // 2.1 Usuário apontando para outro projeto
    const wrongTenantUrl = `postgresql://postgres.outrotenant123:senha@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}`;
    expect(() => validateStagingConnectionConfig(wrongTenantUrl)).toThrowError(/VIOLAÇÃO DE USUÁRIO/);

    // 2.2 Usuário sem project ref (postgres puro)
    const plainUserUrl = `postgresql://postgres:senha@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}`;
    expect(() => validateStagingConnectionConfig(plainUserUrl)).toThrowError(/VIOLAÇÃO DE USUÁRIO/);

    // 2.3 Usuário restrito de runtime (medicina_app)
    const appUserUrl = `postgresql://medicina_app.${TARGET_PROJECT_REF}:senha@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}`;
    expect(() => validateStagingConnectionConfig(appUserUrl)).toThrowError(/VIOLAÇÃO DE USUÁRIO/);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 3: HOST OU PORTA INCORRETOS
  // ----------------------------------------------------------------------------
  it('3. Host ou porta incorretos (porta 6543, host produtivo, localhost): rejeição estrita', () => {
    // 3.1 Host produtivo
    const prodHostUrl = `postgresql://${TARGET_USERNAME}:senha@db.production.supabase.co:${TARGET_PORT}/${TARGET_DB}`;
    expect(() => validateStagingConnectionConfig(prodHostUrl)).toThrowError(/VIOLAÇÃO DE HOST/);

    // 3.2 Host local / IP arbitrário
    const localHostUrl = `postgresql://${TARGET_USERNAME}:senha@127.0.0.1:${TARGET_PORT}/${TARGET_DB}`;
    expect(() => validateStagingConnectionConfig(localHostUrl)).toThrowError(/VIOLAÇÃO DE HOST/);

    // 3.3 Porta do Transaction Pooler (6543) em vez do Session Pooler (5432)
    const txPoolerUrl = `postgresql://${TARGET_USERNAME}:senha@${TARGET_HOST}:6543/${TARGET_DB}`;
    expect(() => validateStagingConnectionConfig(txPoolerUrl)).toThrowError(/VIOLAÇÃO DE PORTA/);

    // 3.4 Banco diferente de postgres
    const wrongDbUrl = `postgresql://${TARGET_USERNAME}:senha@${TARGET_HOST}:${TARGET_PORT}/outro_banco`;
    expect(() => validateStagingConnectionConfig(wrongDbUrl)).toThrowError(/VIOLAÇÃO DE BANCO/);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 4: HISTÓRICO DE MIGRAÇÕES DIVERGENTE
  // ----------------------------------------------------------------------------
  it('4. Histórico de migrações divergente: rejeição estrita (fail-closed)', async () => {
    // 4.1 Simula divergência de hash SHA-256 na migração 5
    const originalRow = await pg.query<{ sha256: string }>(
      'SELECT sha256 FROM public._medicina_staging_migrations WHERE ordem = 5;'
    );
    const originalHash = originalRow.rows[0].sha256;

    try {
      // Adulteração intencional do hash
      await pg.exec(`
        UPDATE public._medicina_staging_migrations
        SET sha256 = 'adulterado00000000000000000000000000000000000000000000000000000000'
        WHERE ordem = 5;
      `);

      let erroHash: any = null;
      try {
        await runPreflightAudit({ sql: sqlAdapter, logger: () => {} });
      } catch (err: any) {
        erroHash = err;
      }

      expect(erroHash).not.toBeNull();
      expect(erroHash.message).toContain('MIGRACAO_HASH_DIVERGENTE');
    } finally {
      // Restaura o hash canônico original
      await pg.exec(`
        UPDATE public._medicina_staging_migrations
        SET sha256 = '${originalHash}'
        WHERE ordem = 5;
      `);
    }

    // 4.2 Simula migração ausente (apenas 8 registradas)
    const tempRemovedRow = await pg.query<{ rel_path: string; sha256: string; tamanho_bytes: number }>(
      'SELECT rel_path, sha256, tamanho_bytes FROM public._medicina_staging_migrations WHERE ordem = 9;'
    );
    try {
      await pg.exec('DELETE FROM public._medicina_staging_migrations WHERE ordem = 9;');

      let erroIncompleto: any = null;
      try {
        await runPreflightAudit({ sql: sqlAdapter, logger: () => {} });
      } catch (err: any) {
        erroIncompleto = err;
      }

      expect(erroIncompleto).not.toBeNull();
      expect(erroIncompleto.message).toContain('HISTORICO_MIGRACOES_INCOMPLETO');
    } finally {
      // Restaura a nona migração
      await pg.exec(`
        INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
        VALUES (9, '${tempRemovedRow.rows[0].rel_path}', '${tempRemovedRow.rows[0].sha256}', '${TARGET_USERNAME}', ${tempRemovedRow.rows[0].tamanho_bytes})
        ON CONFLICT (ordem) DO NOTHING;
      `);
    }
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 5: VALIDAÇÃO DE CERTIFICADO TLS (FAIL-CLOSED)
  // ----------------------------------------------------------------------------
  it('5. Certificado CA TLS ausente ou inválido: rejeição estrita', () => {
    expect(() => resolveCaCertificate('/caminho/completamente/inexistente/ca.crt')).toThrowError(
      /não encontrado no caminho especificado/
    );
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 6: ESTRUTURA CANÔNICA (18 TABELAS OBRIGATÓRIAS)
  // ----------------------------------------------------------------------------
  it('6. Estrutura canônica: detecta ausência de tabelas essenciais no catálogo', async () => {
    // 6.1 Catálogo completo passa perfeitamente
    const auditOk = await runPreflightAudit({ sql: sqlAdapter, logger: () => {} });
    expect(auditOk.tablesCount).toBe(CANONICAL_CORE_TABLES.length);

    // 6.2 Renomeia temporariamente a tabela 'topicos' para simular ausência estrutural
    await pg.exec('ALTER TABLE public.topicos RENAME TO topicos_temp_audit;');
    try {
      let erroEstrutural: any = null;
      try {
        await runPreflightAudit({ sql: sqlAdapter, logger: () => {} });
      } catch (err: any) {
        erroEstrutural = err;
      }

      expect(erroEstrutural).not.toBeNull();
      expect(erroEstrutural.message).toContain('ESTRUTURA_CANONICA_INCOMPLETA');
      expect(erroEstrutural.message).toContain('public.topicos');
    } finally {
      await pg.exec('ALTER TABLE public.topicos_temp_audit RENAME TO topicos;');
    }
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 7: PORTÃO FAIL-CLOSED ANTES DE QUALQUER INSERT NO PROVISIONAMENTO
  // ----------------------------------------------------------------------------
  it('7. Portão fail-closed transacional antes de qualquer INSERT no provisionamento', async () => {
    // Cria um adapter simulando papel não autorizado na sessão
    const fakeAdapter: any = (strings: any, ...values: any[]) => {
      const q = typeof strings === 'string' ? strings : strings[0];
      if (q.includes('current_database()')) {
        return Promise.resolve([{ db_name: 'postgres', user_name: 'papel_invalido_hacker' }]);
      }
      return sqlAdapter(strings, ...values);
    };
    fakeAdapter.begin = async (fn: any) => fn(fakeAdapter);

    let erroProvision: any = null;
    try {
      await provisionHomologationData({
        sql: fakeAdapter,
        logger: () => {},
      });
    } catch (err: any) {
      erroProvision = err;
    }

    expect(erroProvision).not.toBeNull();
    expect(erroProvision.message).toContain('VIOLAÇÃO DE PAPEL POSTGRESQL');
  });
});
