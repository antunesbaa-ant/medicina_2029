import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { stripOuterTransaction } from '../../../scripts/db/migrate-staging.mjs';
import {
  configureStagingRolePasswords,
  ALLOWED_STAGING_ROLES,
} from '../../../scripts/db/configure-staging-roles.mjs';
import {
  verifySingleRoleConnection,
  verifyAllStagingRoles,
} from '../../../scripts/db/verify-staging-roles-connection.mjs';
import { executeControlledStagingSeed } from '../../../scripts/db/apply-staging-seed.mjs';
import { sanitizeError } from '../../../scripts/db/test-staging-connection.mjs';

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

/**
 * Cria banco PostgreSQL descartável (PGlite) com o catálogo e as 9 migrações aplicadas
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
    const raw = readFileSync(path.resolve(process.cwd(), file), 'utf8');
    const clean = stripOuterTransaction(raw);
    await pglite.exec(clean);
  }

  return pglite;
}

/**
 * Cria mock do client sql do postgres.js sobre PGlite
 */
function createSqlMock(pg: PGliteInstance) {
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
  return sqlMock;
}

describe('MEDICINA 2029 — H2.01-R2: Validação Final dos Lançadores de Homologação', () => {
  describe('1. configure-staging-roles.mjs — Segurança e Tratamento de DDL', () => {
    it('1.1 Configura senhas complexas contendo caracteres especiais sem quebra de sintaxe nem SQL injection', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      const sql = createSqlMock(pg);

      // Senha contendo apóstrofos, aspas, barras invertidas, ponto-e-vírgula, comentários e símbolos UTF-8
      const complexPassword = "Senha'Complexa\"Com;Barra\\E$Símbolos!#%&*()[]{}~^Áéíóú_2029";

      const res = await configureStagingRolePasswords({
        confirmation: 'CONFIRMAR CONFIGURACAO ROLES',
        adminPassword: 'fake_admin_pwd_123',
        appPassword: complexPassword,
        authPassword: complexPassword,
        workerPassword: complexPassword,
        sqlInstance: sql,
        logger: () => {},
      });

      expect(res.success).toBe(true);
      expect(res.rolesConfigured).toEqual(expect.arrayContaining(['medicina_app', 'medicina_auth', 'medicina_worker']));

      // Confere que a função temporária pg_temp foi destruída após a execução
      const tempFuncExists = await pg.query(`
        SELECT 1 FROM pg_proc WHERE proname = 'configure_role_credential';
      `);
      expect(tempFuncExists.rows.length).toBe(0);
    });

    it('1.2 Bloqueia sumariamente qualquer tentativa de configurar roles fora da allowlist fixa', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      const sql = createSqlMock(pg);

      expect(ALLOWED_STAGING_ROLES).toEqual(['medicina_app', 'medicina_auth', 'medicina_worker']);

      // Tentativa 1: Injeção de role administrativa
      await expect(
        configureStagingRolePasswords({
          confirmation: 'CONFIRMAR CONFIGURACAO ROLES',
          rolePasswords: {
            postgres: 'senha_hacker_123456789',
          },
          sqlInstance: sql,
          logger: () => {},
        })
      ).rejects.toThrowError(/não consta na allowlist de roles autorizadas/);

      // Tentativa 2: SQL Injection no nome da role
      await expect(
        configureStagingRolePasswords({
          confirmation: 'CONFIRMAR CONFIGURACAO ROLES',
          rolePasswords: {
            "medicina_app'; DROP TABLE public.perfis; --": 'senha_hacker_123456789',
          },
          sqlInstance: sql,
          logger: () => {},
        })
      ).rejects.toThrowError(/não consta na allowlist de roles autorizadas/);
    });

    it('1.3 Exige confirmação humana rigorosa ("CONFIRMAR CONFIGURACAO ROLES")', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      const sql = createSqlMock(pg);

      await expect(
        configureStagingRolePasswords({
          confirmation: 'sim', // Incorreto
          appPassword: 'senha_valida_123456789',
          sqlInstance: sql,
          logger: () => {},
        })
      ).rejects.toThrowError(/Confirmação humana explícita não fornecida/);

      await expect(
        configureStagingRolePasswords({
          confirmation: '', // Vazio
          appPassword: 'senha_valida_123456789',
          sqlInstance: sql,
          logger: () => {},
        })
      ).rejects.toThrowError(/Confirmação humana explícita não fornecida/);
    });

    it('1.4 Rejeita senhas curtas ou fracas (menos de 16 caracteres)', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      const sql = createSqlMock(pg);

      await expect(
        configureStagingRolePasswords({
          confirmation: 'CONFIRMAR CONFIGURACAO ROLES',
          appPassword: 'curta',
          sqlInstance: sql,
          logger: () => {},
        })
      ).rejects.toThrowError(/não atende ao requisito mínimo de 16 caracteres/);
    });

    it('1.5 Sanitiza exceções impedindo vazamento de senhas em mensagens de erro ou logs', () => {
      const fakeErrorWithSecret = new Error(
        'Falha ao conectar em postgresql://medicina_app.ynfocaorhadizlvbnzrt:SuperSecretPassword123@aws-0-us-east-1.pooler.supabase.com:5432/postgres'
      );
      const sanitized = sanitizeError(fakeErrorWithSecret);

      expect(sanitized).not.toContain('SuperSecretPassword123');
      expect(sanitized).toContain('medicina_app.ynfocaorhadizlvbnzrt:***@aws-0-us-east-1.pooler.supabase.com');
    });
  });

  describe('2. verify-staging-roles-connection.mjs — Teste de Identidade e Menor Privilégio', () => {
    it('2.1 Valida identidade e menor privilégio para medicina_app (sem acesso a password_hash)', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();

      // Mock para simular conexão autenticada sob role medicina_app
      const sqlApp: any = async (strings: TemplateStringsArray, ...values: any[]) => {
        await pg.exec('SET ROLE medicina_app;');
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
          await pg.exec('RESET ROLE;');
        }
      };

      const result = await verifySingleRoleConnection({
        roleName: 'medicina_app',
        password: 'senha_teste_nao_usada_no_mock_16chars',
        sqlInstance: sqlApp,
        logger: () => {},
      });

      expect(result.success).toBe(true);
      expect(result.connectedUser).toBe('medicina_app');
      expect(result.database).toBe('postgres');
      expect(result.privilegeVerification).toContain('password_hash blindado');
    });

    it('2.2 Valida identidade e menor privilégio para medicina_auth (acesso restrito à allowlist)', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();

      const sqlAuth: any = async (strings: TemplateStringsArray, ...values: any[]) => {
        await pg.exec('SET ROLE medicina_auth;');
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
          await pg.exec('RESET ROLE;');
        }
      };

      const result = await verifySingleRoleConnection({
        roleName: 'medicina_auth',
        password: 'senha_teste_nao_usada_no_mock_16chars',
        sqlInstance: sqlAuth,
        logger: () => {},
      });

      expect(result.success).toBe(true);
      expect(result.connectedUser).toBe('medicina_auth');
      expect(result.privilegeVerification).toContain('Execução exclusiva autenticar_por_email OK');
    });

    it('2.3 Valida identidade e menor privilégio para medicina_worker (acesso à fila acervo_jobs)', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();

      const sqlWorker: any = async (strings: TemplateStringsArray, ...values: any[]) => {
        await pg.exec('SET ROLE medicina_worker;');
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
          await pg.exec('RESET ROLE;');
        }
      };

      const result = await verifySingleRoleConnection({
        roleName: 'medicina_worker',
        password: 'senha_teste_nao_usada_no_mock_16chars',
        sqlInstance: sqlWorker,
        logger: () => {},
      });

      expect(result.success).toBe(true);
      expect(result.connectedUser).toBe('medicina_worker');
      expect(result.privilegeVerification).toContain('Leitura fila acervo_jobs OK');
    });
  });

  describe('3. apply-staging-seed.mjs — Segurança, Idempotência e Sincronização de Storage', () => {
    it('3.1 Executa seed com sincronização de Storage simulada sem referências a PDFs ausentes', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      const sql = createSqlMock(pg);

      // Simulação em memória do cliente de Storage do Supabase
      const uploadedObjects = new Map<string, { buffer: Buffer; contentType: string }>();
      const storageMock = {
        storage: {
          from: (bucket: string) => ({
            upload: async (filePath: string, buffer: Buffer, options: any) => {
              if (bucket !== 'acervo') {
                return { data: null, error: new Error('Bucket desconhecido') };
              }
              uploadedObjects.set(filePath, { buffer, contentType: options.contentType });
              return { data: { path: filePath }, error: null };
            },
          }),
        },
      };

      const seedResult = await executeControlledStagingSeed({
        confirmation: 'CONFIRMAR SEED STAGING',
        sqlInstance: sql,
        storageClient: storageMock as any,
        logger: () => {},
      });

      expect(seedResult.success).toBe(true);
      expect(seedResult.perfis).toBe(2);
      expect(seedResult.arquivos).toBe(3);

      // Confere que os 3 PDFs sintéticos foram efetivamente enviados ao Storage
      expect(uploadedObjects.size).toBe(3);

      // Confere paridade exata entre banco de dados e objetos no Storage
      const arquivosBanco = await pg.query<{ file_path: string; tamanho_bytes: number; hash_conteudo: string }>(`
        SELECT file_path, tamanho_bytes, hash_conteudo FROM public.acervo_arquivos ORDER BY file_path;
      `);
      expect(arquivosBanco.rows.length).toBe(3);

      for (const arq of arquivosBanco.rows) {
        expect(uploadedObjects.has(arq.file_path)).toBe(true);
        const obj = uploadedObjects.get(arq.file_path)!;
        expect(obj.buffer.length).toBe(arq.tamanho_bytes);
        expect(obj.contentType).toBe('application/pdf');

        // Confere que o buffer do PDF começa com %PDF-1.4 e termina com %%EOF
        const str = obj.buffer.toString('utf8');
        expect(str.startsWith('%PDF-1.4')).toBe(true);
        expect(str.trimEnd().endsWith('%%EOF')).toBe(true);
      }
    });

    it('3.2 Bloqueia execução do seed se confirmação humana estiver incorreta', async () => {
      const pg = await createDatabaseWithCanonicalMigrations();
      const sql = createSqlMock(pg);

      await expect(
        executeControlledStagingSeed({
          confirmation: 'CONFIRMAR', // Incompleto
          sqlInstance: sql,
          logger: () => {},
        })
      ).rejects.toThrowError(/Confirmação humana explícita não fornecida/);
    });
  });
});
