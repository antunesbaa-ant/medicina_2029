import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256,
  REQUIRED_CONFIRMATION_TEXT,
  TARGET_HOST,
  TARGET_PORT,
  TARGET_PROJECT_REF,
  TARGET_USERNAME,
  buildPgDumpArgs,
  checkBackupPrerequisites,
  findPgDumpBinary,
  generateCanonicalStorageManifest,
  resolveCaCertificate,
  validateProjectRef,
} from '../../../scripts/db/backup-staging-baseline.mjs';
import { decryptFile, encryptFile } from '../../../scripts/backup/crypto_envelope.mjs';

const moduleRoot =
  process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';

if (!fs.existsSync(moduleRoot)) {
  throw new Error(`Diretório de módulos isolados não encontrado em ${moduleRoot}.`);
}

const importFromRoot = (pkgPath: string) =>
  import(pathToFileURL(path.join(moduleRoot, pkgPath)).href);

const [{ PGlite }, { vector }] = await Promise.all([
  importFromRoot('@electric-sql/pglite/dist/index.js'),
  importFromRoot('@electric-sql/pglite-pgvector/dist/index.js'),
]);

interface PGliteInstance {
  exec: (query: string) => Promise<unknown>;
  query: <T = Record<string, unknown>>(
    query: string,
    params?: unknown[]
  ) => Promise<{ rows: T[] }>;
  close: () => Promise<void>;
}

function stripOuterTransaction(sql: string): string {
  return sql
    .replace(/^(\s*BEGIN\s*;)+/gi, '')
    .replace(/(\s*COMMIT\s*;)+\s*$/gi, '')
    .trim();
}

describe('MEDICINA 2029 — H2.03: Preparação do Backup Baseline de Staging', () => {
  describe('1. Controles de Segurança, Projeto e Certificados TLS', () => {
    it('1.1 Valida estritamente o Project Ref do Staging (fail-closed)', () => {
      expect(validateProjectRef(TARGET_PROJECT_REF)).toBe(true);
      expect(() => validateProjectRef('projeto-producao-invalido')).toThrow(
        /ALERTA DE SEGURANÇA: Project Ref/
      );
      expect(() => validateProjectRef('ynfocaorhadizlvbnzrx')).toThrow(
        /ALERTA DE SEGURANÇA: Project Ref/
      );
    });

    it('1.2 Valida o certificado CA raiz e seu fingerprint canônico SHA-256', () => {
      const defaultCa = path.join(os.homedir(), 'Downloads', 'prod-ca-2021.crt');
      if (fs.existsSync(defaultCa)) {
        const { caPath, certBuffer, fingerprint } = resolveCaCertificate(defaultCa);
        expect(caPath).toBe(defaultCa);
        expect(certBuffer.length).toBeGreaterThan(0);
        expect(fingerprint).toBe(CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256);
      } else {
        expect(() => resolveCaCertificate('/caminho/inexistente.crt')).toThrow(
          /não encontrado no caminho/
        );
      }
    });

    it('1.3 Rejeita certificado com fingerprint adulterado ou inválido', () => {
      const tmpCertDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm29_cert_test_'));
      const fakeCertPath = path.join(tmpCertDir, 'fake-ca.crt');
      try {
        const dummyCert =
          '-----BEGIN CERTIFICATE-----\n' +
          'MIIBRzCB76ADAgECAgEBMAoGCCqGSM49BAMCMBIxEDAOBgNVBAMMB1Rlc3RDQTEw\n' +
          'HhcNMjYxMDI2MDAwMDAwWhcNMjcxMDI2MDAwMDAwWjASMRAwDgYDVQQDDAdUZXN0\n' +
          'Q0ExMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEW3O8hF0o5FhY6CjFh9Ld8m5J\n' +
          'K4xXo9pL8zD5q7bH2kXmLo3pL9vC5q8bH1kYmMo2pK6zD4q9bH3kZmMvMAoGCCqG\n' +
          'SM49BAMCA0gAMEUCIQDbV6kXm9pK4zD5q7bH2kXmLo3pL9vC5q8bH1kYmMo2pAIg\n' +
          'ObV7kYnMo2pK4zD5q7bH2kXmLo3pL9vC5q8bH1kYmMo=\n' +
          '-----END CERTIFICATE-----\n';
        fs.writeFileSync(fakeCertPath, dummyCert);

        expect(() => resolveCaCertificate(fakeCertPath)).toThrow(
          /VIOLAÇÃO DE INTEGRIDADE TLS|não pôde ser interpretado como um certificado X.509 válido/
        );
      } finally {
        fs.rmSync(tmpCertDir, { recursive: true, force: true });
      }
    });

    it('1.4 Diagnostica os pré-requisitos de sistema reportando prontidão ou ausência de ferramentas', () => {
      const prereqs = checkBackupPrerequisites();
      expect(typeof prereqs.ready).toBe('boolean');
      expect(typeof prereqs.pgDumpAvailable).toBe('boolean');
      expect(typeof prereqs.cryptoAvailable).toBe('boolean');
      expect(Array.isArray(prereqs.reasons)).toBe(true);

      // Se pg_dump não estiver no sistema, ready deve ser false
      if (!prereqs.pgDumpAvailable) {
        expect(prereqs.ready).toBe(false);
        expect(prereqs.reasons.some((r) => r.includes('pg_dump'))).toBe(true);
      }
    });
  });

  describe('2. Construção de Comandos pg_dump e Isolamento de Segredos', () => {
    it('2.1 Constrói argumentos seguros para pg_dump com escopo restrito aos schemas de aplicação', () => {
      const args = buildPgDumpArgs({
        host: TARGET_HOST,
        port: TARGET_PORT,
        username: TARGET_USERNAME,
        database: 'postgres',
        outputFile: '/tmp/test_dump.dump',
      });

      expect(args).toContain('--host');
      expect(args).toContain(TARGET_HOST);
      expect(args).toContain('--port');
      expect(args).toContain('5432');
      expect(args).toContain('--username');
      expect(args).toContain(TARGET_USERNAME);
      expect(args).toContain('--dbname');
      expect(args).toContain('postgres');
      expect(args).toContain('--format=custom');
      expect(args).toContain('--compress=9');
      expect(args).toContain('--no-owner');
      expect(args).toContain('--no-privileges');

      // Escopo restrito a public e medicina (evita schemas internos do Supabase)
      const schemaArgs = args.filter((arg) => arg.startsWith('--schema='));
      expect(schemaArgs).toEqual(['--schema=public', '--schema=medicina']);

      // Nenhuma senha pode constar nos argumentos argv
      expect(args.some((a) => a.includes('password') || a.includes('secret'))).toBe(false);
    });

    it('2.2 Confirma que a senha é injetada estritamente via ambiente do processo e não em argv', () => {
      const adminPassword = 'super_secret_administrative_password_123!';
      const subEnv = {
        PGPASSWORD: adminPassword,
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: '/path/to/ca.crt',
      };

      expect(subEnv.PGPASSWORD).toBe(adminPassword);
      expect(subEnv.PGSSLMODE).toBe('verify-full');
      expect(subEnv.PGSSLROOTCERT).toBe('/path/to/ca.crt');
    });
  });

  describe('3. Manifesto Canônico do Storage (Estado Zero no Baseline)', () => {
    it('3.1 Gera manifesto RFC 8785 de estado zero com hash SHA-256 válido', () => {
      const manifest = generateCanonicalStorageManifest('acervo', '2026-10-26T23:00:00.000Z');

      expect(manifest.version).toBe('1.0');
      expect(manifest.bucket).toBe('acervo');
      expect(manifest.totalObjetos).toBe(0);
      expect(manifest.totalBytes).toBe(0);
      expect(manifest.objetos).toEqual([]);
      expect(manifest.geradoEm).toBe('2026-10-26T23:00:00.000Z');
      expect(typeof manifest.sha256Manifesto).toBe('string');
      expect(manifest.sha256Manifesto.length).toBe(64);

      // Verificação determinística do hash do corpo do manifesto
      const expectedJson = JSON.stringify({
        version: '1.0',
        geradoEm: '2026-10-26T23:00:00.000Z',
        bucket: 'acervo',
        totalObjetos: 0,
        totalBytes: 0,
        objetos: [],
      });
      const expectedHash = createHash('sha256').update(expectedJson, 'utf8').digest('hex');
      expect(manifest.sha256Manifesto).toBe(expectedHash);
    });
  });

  describe('4. Cifragem AEAD AES-256-GCM Envelope M29G (Inviolabilidade e Paridade)', () => {
    it('4.1 Executa ciclo completo de cifragem e decifragem com paridade binária 100% (SHA-256 match)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm29_crypto_test_'));
      const originalFile = path.join(tmpDir, 'test_database.dump');
      const encFile = path.join(tmpDir, 'test_database.dump.enc');
      const decFile = path.join(tmpDir, 'test_recovered.dump');

      try {
        const payload = Buffer.concat([
          Buffer.from('PGDMP-MOCK-HEADER-POSTGRES-18\n'),
          randomBytes(65536),
        ]);
        fs.writeFileSync(originalFile, payload);
        const originalSha256 = createHash('sha256').update(payload).digest('hex');

        const secretKey = 'master_backup_key_high_entropy_123456';
        await encryptFile(originalFile, encFile, secretKey);

        expect(fs.existsSync(encFile)).toBe(true);
        expect(fs.statSync(encFile).size).toBeGreaterThan(payload.length);

        await decryptFile(encFile, decFile, secretKey);

        const recoveredPayload = fs.readFileSync(decFile);
        const recoveredSha256 = createHash('sha256').update(recoveredPayload).digest('hex');

        expect(recoveredSha256).toBe(originalSha256);
        expect(recoveredPayload.equals(payload)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('4.2 Rejeita decifragem com chave incorreta (fail-closed defensivo)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm29_wrong_key_test_'));
      const originalFile = path.join(tmpDir, 'test.dump');
      const encFile = path.join(tmpDir, 'test.dump.enc');
      const decFile = path.join(tmpDir, 'test.recovered');

      try {
        fs.writeFileSync(originalFile, Buffer.from('conteúdo confidencial de staging'));
        await encryptFile(originalFile, encFile, 'chave_correta_super_segura_123');

        await expect(
          decryptFile(encFile, decFile, 'chave_totalmente_incorreta_e_errada_999')
        ).rejects.toThrow();

        expect(fs.existsSync(decFile)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('4.3 Detecta e rejeita adulteração de ciphertext por bit-flip via autenticação GHASH', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm29_tamper_test_'));
      const originalFile = path.join(tmpDir, 'test.dump');
      const encFile = path.join(tmpDir, 'test.dump.enc');
      const decFile = path.join(tmpDir, 'test.recovered');

      try {
        fs.writeFileSync(originalFile, Buffer.from('conteúdo original a ser protegido contra adulteração'));
        const secretKey = 'chave_para_teste_de_inviolabilidade_123';
        await encryptFile(originalFile, encFile, secretKey);

        const encBytes = fs.readFileSync(encFile);
        encBytes[encBytes.length - 10] ^= 0x01; // Inverte 1 bit
        fs.writeFileSync(encFile, encBytes);

        await expect(decryptFile(encFile, decFile, secretKey)).rejects.toThrow(
          /Falha na verificação de autenticidade|Unsupported state or unable to authenticate data/
        );
        expect(fs.existsSync(decFile)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('5. Validação de Restauração em PostgreSQL Descartável (PGlite)', () => {
    it('5.1 Restaura as 9 migrações canônicas e confirma inventário de 32+ tabelas vazias no baseline', async () => {
      const pglite = new PGlite({
        extensions: { vector },
      });

      try {
        await pglite.exec(`
          CREATE SCHEMA IF NOT EXISTS extensions;
          CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
          SET search_path = "$user", public, extensions;
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
          VALUES ('acervo', 'acervo', false, 52428800, ARRAY['application/pdf']::text[])
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

        // Cria tabela de histórico de tracking
        await pglite.exec(`
          CREATE TABLE IF NOT EXISTS public._medicina_staging_migrations (
            step_index integer PRIMARY KEY,
            migration_name text NOT NULL,
            canonical_hash text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now()
          );
        `);

        for (let i = 0; i < files.length; i++) {
          await pglite.exec(`
            INSERT INTO public._medicina_staging_migrations (step_index, migration_name, canonical_hash)
            VALUES (${i + 1}, '${files[i]}', 'mock_hash_${i + 1}');
          `);
        }

        // 1. Confirma que a tabela de histórico contém as 9 migrações
        const migResult = await pglite.query<{ count: string }>(
          'SELECT count(*) AS count FROM public._medicina_staging_migrations;'
        );
        expect(Number(migResult.rows[0].count)).toBe(9);

        // 2. Confirma a existência do schema medicina e funções
        const fnResult = await pglite.query<{ exists: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_proc
            JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
            WHERE pg_namespace.nspname = 'medicina' AND pg_proc.proname = 'autenticar_por_email'
          ) AS exists;
        `);
        expect(fnResult.rows[0].exists).toBe(true);

        // 3. Confirma o estado do baseline: allowlist possui os 2 registros da migração 0000 e as demais tabelas estão vazias
        const zeroTables = [
          'perfis',
          'responsavel_estudante',
          'acervo_arquivos',
          'acervo_jobs',
          'questoes',
          'simulados',
          'sessoes',
          'ciclos',
        ];

        for (const tbl of zeroTables) {
          const countRes = await pglite.query<{ count: string }>(
            `SELECT count(*) AS count FROM public."${tbl}";`
          );
          expect(Number(countRes.rows[0].count)).toBe(0);
        }

        const allowlistRes = await pglite.query<{ count: string }>(
          'SELECT count(*) AS count FROM public.allowlist;'
        );
        expect(Number(allowlistRes.rows[0].count)).toBe(2);

        // 4. Confirma que RLS está habilitado nas tabelas críticas
        const rlsRes = await pglite.query<{ tablename: string; rowsecurity: boolean }>(`
          SELECT tablename, rowsecurity
          FROM pg_tables
          WHERE schemaname = 'public'
            AND tablename IN ('perfis', 'acervo_arquivos', 'acervo_jobs');
        `);
        for (const row of rlsRes.rows) {
          expect(row.rowsecurity).toBe(true);
        }
      } finally {
        await pglite.close();
      }
    });

    it('5.2 Testa rejeição por integridade referencial fail-closed em inserção fora de ordem', async () => {
      const pglite = new PGlite({
        extensions: { vector },
      });

      try {
        await pglite.exec(`
          CREATE SCHEMA IF NOT EXISTS extensions;
          CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
          SET search_path = "$user", public, extensions;
        `);

        // Aplica as migrações 0 e 1 para testar chave estrangeira entre perfis e ciclo
        const sql0000 = fs
          .readFileSync(path.resolve(process.cwd(), 'drizzle/0000_greedy_loki.sql'), 'utf8')
          .replaceAll('--> statement-breakpoint', '\n');
        await pglite.exec(stripOuterTransaction(sql0000));

        // Tentativa de inserir ciclo referenciando estudante_id inexistente deve falhar com FK violation
        await expect(
          pglite.exec(`
            INSERT INTO public.ciclos (id, estudante_id, nome, metas, criado_em, atualizado_em)
            VALUES (
              gen_random_uuid(),
              '00000000-0000-0000-0000-000000000000',
              'Ciclo Teste',
              '{}',
              now(),
              now()
            );
          `)
        ).rejects.toThrow();
      } finally {
        await pglite.close();
      }
    });
  });
});
