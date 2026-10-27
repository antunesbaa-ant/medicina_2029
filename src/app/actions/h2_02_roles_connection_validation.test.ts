import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  verifySingleRoleSessionConnection,
  verifyRoleTransactionConnection,
  verifyAllStagingRoles,
  buildRolePoolerUrl,
  EXPECTED_ROLES,
  TARGET_SESSION_PORT,
  TARGET_TRANSACTION_PORT,
  CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256,
} from '../../../scripts/db/verify-staging-roles-connection.mjs';

const moduleRoot = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';

if (!fs.existsSync(moduleRoot)) {
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

function stripOuterTransaction(sql: string): string {
  return sql
    .replace(/^(\s*BEGIN\s*;)+/gi, '')
    .replace(/(\s*COMMIT\s*;)+\s*$/gi, '')
    .trim();
}

/**
 * Cria banco PostgreSQL descartável (PGlite) com as 9 migrações canônicas
 */
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
    const raw = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
    const clean = stripOuterTransaction(raw);
    await pglite.exec(clean);
    await pglite.exec('COMMIT;').catch(() => {});
  }

  return pglite;
}

/**
 * Cria mock do client sql para simular conexões autenticadas com suporte a transações
 */
function createRoleSqlMock(pg: PGliteInstance, roleName: string) {
  const sqlMock: any = async (strings: TemplateStringsArray, ...values: any[]) => {
    await pg.exec(`SET ROLE ${roleName};`).catch(() => {});
    try {
      let query = strings[0];
      const params: any[] = [];
      for (let i = 0; i < values.length; i++) {
        params.push(values[i]);
        query += `$${i + 1}` + strings[i + 1];
      }
      const res = await pg.query(query, params);
      return res.rows;
    } finally {
      await pg.exec('RESET ROLE;').catch(() => {});
    }
  };

  sqlMock.begin = async (callback: (tx: any) => Promise<any>) => {
    await pg.exec(`SET ROLE ${roleName};`).catch(() => {});
    await pg.exec('BEGIN;');
    try {
      const txMock: any = async (strings: TemplateStringsArray, ...values: any[]) => {
        let query = strings[0];
        const params: any[] = [];
        for (let i = 0; i < values.length; i++) {
          params.push(values[i]);
          query += `$${i + 1}` + strings[i + 1];
        }
        const res = await pg.query(query, params);
        return res.rows;
      };
      const result = await callback(txMock);
      await pg.exec('COMMIT;');
      return result;
    } catch (err) {
      await pg.exec('ROLLBACK;').catch(() => {});
      throw err;
    } finally {
      await pg.exec('RESET ROLE;').catch(() => {});
    }
  };

  sqlMock.end = async () => {};
  return sqlMock;
}

describe('MEDICINA 2029 — H2.02: Validação Real das Conexões Técnicas', () => {
  describe('1. Validação no Session Pooler (porta 5432)', () => {
    it('1.1 medicina_app: Conecta, valida identidade, rolcanlogin=true, rolsuper=false, rolbypassrls=false e menor privilégio', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      const sqlApp = createRoleSqlMock(pg, 'medicina_app');

      const res = await verifySingleRoleSessionConnection({
        roleName: 'medicina_app',
        password: 'senha_teste_mock_16chars',
        sqlInstance: sqlApp,
        logger: () => {},
      });

      expect(res.success).toBe(true);
      expect(res.connectedUser).toBe('medicina_app');
      expect(res.database).toBe('postgres');
      expect(res.rolcanlogin).toBe(true);
      expect(res.rolsuper).toBe(false);
      expect(res.rolbypassrls).toBe(false);
      expect(res.privilegeVerification).toContain('password_hash blindado');
    });

    it('1.2 medicina_auth: Conecta, valida identidade, rolcanlogin=true, rolsuper=false, rolbypassrls=false e menor privilégio', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      const sqlAuth = createRoleSqlMock(pg, 'medicina_auth');

      const res = await verifySingleRoleSessionConnection({
        roleName: 'medicina_auth',
        password: 'senha_teste_mock_16chars',
        sqlInstance: sqlAuth,
        logger: () => {},
      });

      expect(res.success).toBe(true);
      expect(res.connectedUser).toBe('medicina_auth');
      expect(res.database).toBe('postgres');
      expect(res.rolcanlogin).toBe(true);
      expect(res.rolsuper).toBe(false);
      expect(res.rolbypassrls).toBe(false);
      expect(res.privilegeVerification).toContain('Execução exclusiva autenticar_por_email OK');
    });

    it('1.3 medicina_worker: Conecta, valida identidade, rolcanlogin=true, rolsuper=false, rolbypassrls=false e menor privilégio', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      const sqlWorker = createRoleSqlMock(pg, 'medicina_worker');

      const res = await verifySingleRoleSessionConnection({
        roleName: 'medicina_worker',
        password: 'senha_teste_mock_16chars',
        sqlInstance: sqlWorker,
        logger: () => {},
      });

      expect(res.success).toBe(true);
      expect(res.connectedUser).toBe('medicina_worker');
      expect(res.database).toBe('postgres');
      expect(res.rolcanlogin).toBe(true);
      expect(res.rolsuper).toBe(false);
      expect(res.rolbypassrls).toBe(false);
      expect(res.privilegeVerification).toContain('Leitura fila acervo_jobs OK');
    });
  });

  describe('2. Salvaguardas Fail-Closed de Atributos e Privilégios de Role', () => {
    it('2.1 Rejeita sumariamente tentativa de validação para role não autorizada', async () => {
      await expect(
        verifySingleRoleSessionConnection({
          roleName: 'postgres', // Não autorizada na lista EXPECTED_ROLES
          password: 'senha_teste_mock_16chars',
          logger: () => {},
        })
      ).rejects.toThrow(/Role desconhecida ou não autorizada/);
    });

    it('2.2 Bloqueia e falha se a role for superusuário (rolsuper=true)', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      // Cria role com superusuário para testar o fail-closed
      await pg.exec('CREATE ROLE medicina_app_super WITH LOGIN SUPERUSER;');
      const sqlMock: any = async () => [
        { connected_user: 'medicina_app', session_user: 'postgres', database_name: 'postgres' },
      ];
      // Simula retorno de rolsuper=true
      sqlMock.queryOverride = true;
      const patchedSql: any = async (strings: TemplateStringsArray) => {
        if (strings[0].includes('current_user AS connected_user')) {
          return [{ connected_user: 'medicina_app', session_user: 'postgres', database_name: 'postgres' }];
        }
        if (strings[0].includes('FROM pg_roles')) {
          return [{ rolname: 'medicina_app', rolcanlogin: true, rolsuper: true, rolbypassrls: false }];
        }
        return [];
      };

      await expect(
        verifySingleRoleSessionConnection({
          roleName: 'medicina_app',
          password: 'senha_teste_mock_16chars',
          sqlInstance: patchedSql,
          logger: () => {},
        })
      ).rejects.toThrow(/VIOLAÇÃO CRÍTICA DE SEGURANÇA.*superusuário não permitido/);
    });

    it('2.3 Bloqueia e falha se a role possuir bypass de RLS (rolbypassrls=true)', async () => {
      const patchedSql: any = async (strings: TemplateStringsArray) => {
        if (strings[0].includes('current_user AS connected_user')) {
          return [{ connected_user: 'medicina_app', session_user: 'postgres', database_name: 'postgres' }];
        }
        if (strings[0].includes('FROM pg_roles')) {
          return [{ rolname: 'medicina_app', rolcanlogin: true, rolsuper: false, rolbypassrls: true }];
        }
        return [];
      };

      await expect(
        verifySingleRoleSessionConnection({
          roleName: 'medicina_app',
          password: 'senha_teste_mock_16chars',
          sqlInstance: patchedSql,
          logger: () => {},
        })
      ).rejects.toThrow(/VIOLAÇÃO CRÍTICA DE RLS.*BYPASSRLS não permitido/);
    });

    it('2.4 Bloqueia e falha se a role não tiver permissão de login (rolcanlogin=false)', async () => {
      const patchedSql: any = async (strings: TemplateStringsArray) => {
        if (strings[0].includes('current_user AS connected_user')) {
          return [{ connected_user: 'medicina_app', session_user: 'postgres', database_name: 'postgres' }];
        }
        if (strings[0].includes('FROM pg_roles')) {
          return [{ rolname: 'medicina_app', rolcanlogin: false, rolsuper: false, rolbypassrls: false }];
        }
        return [];
      };

      await expect(
        verifySingleRoleSessionConnection({
          roleName: 'medicina_app',
          password: 'senha_teste_mock_16chars',
          sqlInstance: patchedSql,
          logger: () => {},
        })
      ).rejects.toThrow(/VIOLAÇÃO DE ACESSO.*rolcanlogin = false/);
    });
  });

  describe('3. Validação no Transaction Pooler (porta 6543)', () => {
    it('3.1 medicina_app: Executa na porta 6543 com prepare=false e contexto SET LOCAL transacional', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      const sqlApp = createRoleSqlMock(pg, 'medicina_app');

      const res = await verifyRoleTransactionConnection({
        roleName: 'medicina_app',
        password: 'senha_teste_mock_16chars',
        sqlInstance: sqlApp,
        logger: () => {},
      });

      expect(res.success).toBe(true);
      expect(res.port).toBe(TARGET_TRANSACTION_PORT);
      expect(res.prepareFalse).toBe(true);
      expect(res.transactionValidation).toContain('SET LOCAL RLS claim.sub OK');
    });

    it('3.2 medicina_auth: Executa na porta 6543 com prepare=false e contexto SET LOCAL transacional', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      const sqlAuth = createRoleSqlMock(pg, 'medicina_auth');

      const res = await verifyRoleTransactionConnection({
        roleName: 'medicina_auth',
        password: 'senha_teste_mock_16chars',
        sqlInstance: sqlAuth,
        logger: () => {},
      });

      expect(res.success).toBe(true);
      expect(res.port).toBe(TARGET_TRANSACTION_PORT);
      expect(res.prepareFalse).toBe(true);
      expect(res.transactionValidation).toContain('RPC autenticar_por_email OK');
    });

    it('3.3 medicina_worker: É bloqueada de execução no Transaction Pooler (dedicada exclusivamente à porta 5432)', async () => {
      await expect(
        verifyRoleTransactionConnection({
          roleName: 'medicina_worker' as any,
          password: 'senha_teste_mock_16chars',
          logger: () => {},
        })
      ).rejects.toThrow(/não está autorizada para validação no Transaction Pooler/);
    });
  });

  describe('4. Orquestrador Geral verifyAllStagingRoles e Configuração de URLs', () => {
    it('4.1 Constrói URLs de pooler devidamente formatadas com codificação percentual de senha', () => {
      const url5432 = buildRolePoolerUrl('medicina_app', 'P@ssw0rd#123;Com$imbolo', TARGET_SESSION_PORT);
      expect(url5432).toContain('postgresql://medicina_app.ynfocaorhadizlvbnzrt:');
      expect(url5432).toContain(':5432/postgres');
      expect(url5432).toContain('P%40ssw0rd%23123%3BCom%24imbolo');

      const url6543 = buildRolePoolerUrl('medicina_auth', 'P@ssw0rd#123;Com$imbolo', TARGET_TRANSACTION_PORT);
      expect(url6543).toContain('postgresql://medicina_auth.ynfocaorhadizlvbnzrt:');
      expect(url6543).toContain(':6543/postgres');
    });

    it('4.2 Orquestrador verifyAllStagingRoles executa as duas fases com sucesso sob mocks', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      const sqlApp = createRoleSqlMock(pg, 'medicina_app');
      const sqlAuth = createRoleSqlMock(pg, 'medicina_auth');
      const sqlWorker = createRoleSqlMock(pg, 'medicina_worker');

      const res = await verifyAllStagingRoles({
        passwords: {
          medicina_app: 'fake_pass_app_16chars',
          medicina_auth: 'fake_pass_auth_16chars',
          medicina_worker: 'fake_pass_worker_16chars',
        },
        sessionSqlInstances: {
          medicina_app: sqlApp,
          medicina_auth: sqlAuth,
          medicina_worker: sqlWorker,
        },
        transactionSqlInstances: {
          medicina_app: sqlApp,
          medicina_auth: sqlAuth,
        },
        logger: () => {},
      });

      expect(res.success).toBe(true);
      expect(Object.keys(res.sessionResults)).toEqual(EXPECTED_ROLES);
      expect(Object.keys(res.transactionResults)).toEqual(['medicina_app', 'medicina_auth']);
    });
  });
});
