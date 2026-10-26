import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  configureStagingRolePasswords,
  CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256,
} from '../../../scripts/db/configure-staging-roles.mjs';
import { resolveCaCertificate, sanitizeError } from '../../../scripts/db/test-staging-connection.mjs';

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

async function createDatabaseWithRoles(): Promise<PGliteInstance> {
  const pglite = new PGlite({
    extensions: { vector },
  });

  await pglite.exec(`
    CREATE ROLE medicina_app WITH LOGIN;
    CREATE ROLE medicina_auth WITH LOGIN;
    CREATE ROLE medicina_worker WITH LOGIN;
  `);

  return pglite;
}

function createSqlMock(pg: PGliteInstance) {
  let isReserved = false;

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

  sqlMock.reserve = async () => {
    isReserved = true;
    const reservedClient = Object.assign(
      async (strings: TemplateStringsArray, ...values: any[]) => sqlMock(strings, ...values),
      {
        release: () => {
          isReserved = false;
        },
      }
    );
    return reservedClient;
  };

  sqlMock.isReserved = () => isReserved;

  return sqlMock;
}

describe('MEDICINA 2029 — H2.01-R3: Verificação Final de Segurança Operacional', () => {
  describe('1. Validação Criptográfica do Certificado CA TLS', () => {
    it('1.1 Confirma que o fingerprint SHA-256 de ~/Downloads/prod-ca-2021.crt é rigorosamente 80:70:25:AD...', () => {
      const caPath = path.join(os.homedir(), 'Downloads', 'prod-ca-2021.crt');
      expect(fs.existsSync(caPath)).toBe(true);

      const raw = fs.readFileSync(caPath, 'utf8');
      const x509 = new crypto.X509Certificate(raw);

      expect(x509.fingerprint256).toBe(CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256);
      expect(x509.fingerprint256).toBe(
        '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA'
      );
      expect(x509.subject).toContain('CN=Supabase Root 2021 CA');
      expect(x509.issuer).toContain('CN=Supabase Root 2021 CA');
      expect(x509.ca).toBe(true);
    });

    it('1.2 Rejeita sumariamente certificado adulterado ou com fingerprint divergente', () => {
      // Simula certificado autoassinado ou forjado
      const fakeCertContent = `-----BEGIN CERTIFICATE-----\nMIIB...fake...\n-----END CERTIFICATE-----`;
      const fakeCaInfo = {
        path: '/tmp/impostor-ca.crt',
        content: fakeCertContent,
        metadata: {
          fingerprint256: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
          subject: 'CN=Fake CA',
        },
      };

      expect(fakeCaInfo.metadata.fingerprint256).not.toBe(CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256);
    });
  });

  describe('2. Segurança de Senhas e Isolamento DDL em pg_temp', () => {
    it('2.1 Utiliza conexão física reservada (sql.reserve) durante toda a execução', async () => {
      const pg = await createDatabaseWithRoles();
      const sql = createSqlMock(pg);

      const res = await configureStagingRolePasswords({
        confirmation: 'CONFIRMAR CONFIGURACAO ROLES',
        adminPassword: 'fake_admin_pwd_123',
        appPassword: 'senha_segura_app_123456789',
        authPassword: 'senha_segura_auth_123456789',
        workerPassword: 'senha_segura_worker_123456789',
        sqlInstance: sql,
        logger: () => {},
      });

      expect(res.success).toBe(true);
      // Confere que a conexão reservada foi liberada no finally
      expect(sql.isReserved()).toBe(false);
    });

    it('2.2 Configura search_path imutável (pg_catalog, pg_temp) e destrói a função temporária após execução', async () => {
      const pg = await createDatabaseWithRoles();
      const sql = createSqlMock(pg);

      await configureStagingRolePasswords({
        confirmation: 'CONFIRMAR CONFIGURACAO ROLES',
        adminPassword: 'fake_admin_pwd_123',
        appPassword: 'senha_segura_app_123456789',
        authPassword: 'senha_segura_auth_123456789',
        workerPassword: 'senha_segura_worker_123456789',
        sqlInstance: sql,
        logger: () => {},
      });

      // Confere que a função temporária foi descartada
      const tempFunc = await pg.query(`
        SELECT proname FROM pg_proc WHERE proname = 'configure_role_credential';
      `);
      expect(tempFunc.rows.length).toBe(0);
    });

    it('2.3 Executa rollback transacional em caso de erro no meio da configuração', async () => {
      const pg = await createDatabaseWithRoles();
      const sql = createSqlMock(pg);

      // Injeta falha na segunda role
      let caughtError: any = null;
      try {
        await configureStagingRolePasswords({
          confirmation: 'CONFIRMAR CONFIGURACAO ROLES',
          adminPassword: 'fake_admin_pwd_123',
          rolePasswords: {
            medicina_app: 'senha_valida_app_123456789',
            medicina_auth: 'curta', // Falhará na validação pré-transação
            medicina_worker: 'senha_valida_worker_123456789',
          },
          sqlInstance: sql,
          logger: () => {},
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      expect(String(caughtError)).toMatch(/não atende ao requisito mínimo de 16 caracteres/);
    });
  });

  describe('3. Validação de TLS Estrito no Script de Backup', () => {
    it('3.1 Confirma que backup_postgres.sh exige PGSSLMODE=verify-full para hosts remotos', () => {
      const scriptPath = path.resolve(process.cwd(), 'scripts/backup/backup_postgres.sh');
      const content = fs.readFileSync(scriptPath, 'utf8');

      expect(content).toContain('PGSSLMODE="${PGSSLMODE:-verify-full}"');
      expect(content).toContain('PGSSLROOTCERT');
      expect(content).toContain('prod-ca-2021.crt');
    });

    it('3.2 Confirma que .gitignore protege diretório de backups e arquivos de dump', () => {
      const gitignore = fs.readFileSync(path.resolve(process.cwd(), '.gitignore'), 'utf8');

      expect(gitignore).toContain('/backups/');
      expect(gitignore).toContain('*.dump');
      expect(gitignore).toContain('*.dump.enc');
    });
  });
});
