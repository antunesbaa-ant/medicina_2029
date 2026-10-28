import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decryptFile, encryptFile } from '../../../scripts/backup/crypto_envelope.mjs';
import {
  findPgRestoreBinary,
  TARGET_HOST,
  TARGET_PROJECT_REF,
} from '../../../scripts/db/backup-staging-baseline.mjs';
import {
  diagnoseRestoreInfrastructure,
  EXPECTED_MIGRATIONS_COUNT,
  findLatestBaselineBackup,
  MIN_DOMAIN_TABLES_COUNT,
  validateRestoreTarget,
  verifyBackupFilesAndHeaders,
  verifyDecryptionAndManifest,
} from '../../../scripts/db/verify-staging-baseline-backup.mjs';

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

describe('MEDICINA 2029 — H2.03-R: Validação do Backup Baseline e Estratégia de Recuperação', () => {
  describe('1. Localização, Permissões e Integridade Física dos Arquivos (BACKUP GERADO)', () => {
    it('1.1 Localiza o backup baseline mais recente em ~/.medicina2029/backups/', () => {
      const backupInfo = findLatestBaselineBackup();
      expect(backupInfo).toBeDefined();
      expect(backupInfo.dirName).toMatch(/^medicina2029_staging_baseline_/);
      expect(fs.existsSync(backupInfo.fullPath)).toBe(true);
    });

    it('1.2 Valida permissões restritas (0700 dir, 0600 arquivos) e presença dos 4 artefatos', () => {
      const backupInfo = findLatestBaselineBackup();
      const filesInfo = verifyBackupFilesAndHeaders(backupInfo.fullPath);

      expect(filesInfo.dirMode).toBe('700');
      expect(filesInfo.encDump.mode).toBe('600');
      expect(filesInfo.encManifest.mode).toBe('600');
      expect(filesInfo.encDump.sizeBytes).toBeGreaterThan(50_000);
      expect(filesInfo.encManifest.sizeBytes).toBeGreaterThan(1_000);
    });

    it('1.3 Valida hashes SHA-256 dos arquivos cifrados contra os arquivos .sha256', () => {
      const backupInfo = findLatestBaselineBackup();
      const filesInfo = verifyBackupFilesAndHeaders(backupInfo.fullPath);

      // Lê diretamente os arquivos .sha256 e compara com os calculados
      const dumpShaFile = fs.readFileSync(`${filesInfo.encDump.path}.sha256`, 'utf8');
      const manifestShaFile = fs.readFileSync(`${filesInfo.encManifest.path}.sha256`, 'utf8');

      expect(dumpShaFile.trim().split(/\s+/)[0]).toBe(filesInfo.encDump.sha256);
      expect(manifestShaFile.trim().split(/\s+/)[0]).toBe(filesInfo.encManifest.sha256);
    });

    it('1.4 Valida cabeçalho do envelope binário M29G v1 (Magic bytes, Salt, IV, Tag GHASH)', () => {
      const backupInfo = findLatestBaselineBackup();
      const filesInfo = verifyBackupFilesAndHeaders(backupInfo.fullPath);

      expect(filesInfo.encDump.header.magic).toBe('M29G');
      expect(filesInfo.encDump.header.version).toBe(1);
      expect(filesInfo.encDump.header.saltHex).toHaveLength(32); // 16 bytes
      expect(filesInfo.encDump.header.ivHex).toHaveLength(24); // 12 bytes
      expect(filesInfo.encDump.header.authTagHex).toHaveLength(32); // 16 bytes

      expect(filesInfo.encManifest.header.magic).toBe('M29G');
      expect(filesInfo.encManifest.header.version).toBe(1);
    });
  });

  describe('2. Integridade Criptográfica AEAD e Fail-Closed Defensivo (BACKUP ÍNTEGRO)', () => {
    it('2.1 Executa decifragem e validação completa em backup sintético com manifesto íntegro', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm29_synth_test_'));
      try {
        fs.chmodSync(tmpDir, 0o700);
        const testKey = 'uma_chave_mestra_de_teste_segura_2029';

        // Cria dump claro sintético e calcula SHA-256
        const clearDumpPath = path.join(tmpDir, 'test_baseline.dump');
        const clearDumpContent = Buffer.from('PGDMP-SYNTHETIC-HEADER-FOR-TESTING');
        fs.writeFileSync(clearDumpPath, clearDumpContent, { mode: 0o600 });
        const dumpSha256 = createHash('sha256').update(clearDumpContent).digest('hex');

        // Cria manifesto claro sintético
        const clearManifestPath = path.join(tmpDir, 'test_baseline_manifest.json');
        const synthManifest = {
          app: 'Medicina 2029',
          environment: 'staging',
          project_ref: TARGET_PROJECT_REF,
          task: 'H2.03',
          backup_id: 'test_baseline',
          timestamp_utc: new Date().toISOString(),
          dump_file: 'test_baseline.dump',
          dump_size_bytes: clearDumpContent.length,
          dump_sha256: dumpSha256,
          postgres_version: 'PostgreSQL 15.8 on x86_64-pc-linux-gnu',
          migrations: Array.from({ length: 9 }, (_, i) => ({
            step_index: i + 1,
            migration_name: `migration_0${i + 1}.sql`,
            canonical_hash: `hash_${i + 1}`,
          })),
          table_row_counts: Object.fromEntries(
            Array.from({ length: 35 }, (_, i) => [`public.table_${i + 1}`, 0])
          ),
          roles_verification: [
            { rolname: 'medicina_app' },
            { rolname: 'medicina_auth' },
            { rolname: 'medicina_worker' },
          ],
          storage: {
            version: '1.0',
            bucket: 'acervo',
            totalObjetos: 0,
            totalBytes: 0,
            objetos: [],
          },
        };
        fs.writeFileSync(clearManifestPath, JSON.stringify(synthManifest), { mode: 0o600 });

        // Cifra ambos os arquivos
        const encDumpPath = `${clearDumpPath}.enc`;
        const encManifestPath = `${clearManifestPath}.enc`;
        await encryptFile(clearDumpPath, encDumpPath, testKey);
        await encryptFile(clearManifestPath, encManifestPath, testKey);

        // Gera arquivos .sha256
        const dumpEncSha = createHash('sha256').update(fs.readFileSync(encDumpPath)).digest('hex');
        const manifestEncSha = createHash('sha256').update(fs.readFileSync(encManifestPath)).digest('hex');
        fs.writeFileSync(`${encDumpPath}.sha256`, `${dumpEncSha}  ${path.basename(encDumpPath)}\n`);
        fs.writeFileSync(`${encManifestPath}.sha256`, `${manifestEncSha}  ${path.basename(encManifestPath)}\n`);

        // Remove arquivos claros
        fs.unlinkSync(clearDumpPath);
        fs.unlinkSync(clearManifestPath);

        // Executa a verificação
        const result = await verifyDecryptionAndManifest(tmpDir, testKey, { skipToc: true });
        expect(result.manifest.projectRef).toBe(TARGET_PROJECT_REF);
        expect(result.manifest.migrationsCount).toBe(9);
        expect(result.manifest.tablesCount).toBe(35);
        expect(result.manifest.storage.totalObjetos).toBe(0);
        expect(result.clearDumpVerification.matchesManifest).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('2.2 Rejeita decifragem fail-closed quando chave incorreta é fornecida', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm29_wrong_key_test_'));
      try {
        fs.chmodSync(tmpDir, 0o700);
        const correctKey = 'chave_correta_super_segura_2029';
        const wrongKey = 'chave_incorreta_totalmente_errada_2029';

        const clearDump = path.join(tmpDir, 'test.dump');
        const clearManifest = path.join(tmpDir, 'test_manifest.json');
        fs.writeFileSync(clearDump, 'DATA', { mode: 0o600 });
        fs.writeFileSync(clearManifest, JSON.stringify({ project_ref: TARGET_PROJECT_REF }), { mode: 0o600 });

        await encryptFile(clearDump, `${clearDump}.enc`, correctKey);
        await encryptFile(clearManifest, `${clearManifest}.enc`, correctKey);

        const dumpSha = createHash('sha256').update(fs.readFileSync(`${clearDump}.enc`)).digest('hex');
        const manifestSha = createHash('sha256').update(fs.readFileSync(`${clearManifest}.enc`)).digest('hex');
        fs.writeFileSync(`${clearDump}.enc.sha256`, `${dumpSha}  test.dump.enc\n`);
        fs.writeFileSync(`${clearManifest}.enc.sha256`, `${manifestSha}  test_manifest.json.enc\n`);

        fs.unlinkSync(clearDump);
        fs.unlinkSync(clearManifest);

        await expect(verifyDecryptionAndManifest(tmpDir, wrongKey, { skipToc: true })).rejects.toThrow(
          /FALHA CRÍTICA DE AUTENTICAÇÃO AEAD/
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('2.3 Detecta e rejeita adulteração de hash SHA-256 do dump decifrado', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm29_hash_mismatch_test_'));
      try {
        fs.chmodSync(tmpDir, 0o700);
        const key = 'chave_mestra_para_teste_de_hash_2029';

        const clearDump = path.join(tmpDir, 'test.dump');
        const clearManifest = path.join(tmpDir, 'test_manifest.json');
        fs.writeFileSync(clearDump, 'DUMP_ORIGINAL', { mode: 0o600 });

        // Grava manifesto com hash divergente
        fs.writeFileSync(
          clearManifest,
          JSON.stringify({
            app: 'Medicina 2029',
            environment: 'staging',
            project_ref: TARGET_PROJECT_REF,
            task: 'H2.03',
            migrations: Array.from({ length: 9 }, () => ({})),
            table_row_counts: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`tbl_${i}`, 0])),
            storage: { totalObjetos: 0, totalBytes: 0 },
            dump_sha256: '0000000000000000000000000000000000000000000000000000000000000000',
          }),
          { mode: 0o600 }
        );

        await encryptFile(clearDump, `${clearDump}.enc`, key);
        await encryptFile(clearManifest, `${clearManifest}.enc`, key);

        const dSha = createHash('sha256').update(fs.readFileSync(`${clearDump}.enc`)).digest('hex');
        const mSha = createHash('sha256').update(fs.readFileSync(`${clearManifest}.enc`)).digest('hex');
        fs.writeFileSync(`${clearDump}.enc.sha256`, `${dSha}  test.dump.enc\n`);
        fs.writeFileSync(`${clearManifest}.enc.sha256`, `${mSha}  test_manifest.json.enc\n`);

        fs.unlinkSync(clearDump);
        fs.unlinkSync(clearManifest);

        await expect(verifyDecryptionAndManifest(tmpDir, key)).rejects.toThrow(
          /VIOLAÇÃO DE INTEGRIDADE DO DUMP DECIFRADO/
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('3. Salvaguardas de Segurança e Diagnóstico de Infraestrutura Isolada', () => {
    it('3.1 Bloqueia sumariamente qualquer tentativa de restauração apontando para o Supabase remoto', () => {
      expect(() => validateRestoreTarget(TARGET_HOST)).toThrow(/BLOQUEIO CRÍTICO DE SEGURANÇA/);
      expect(() => validateRestoreTarget('db.ynfocaorhadizlvbnzrt.supabase.co')).toThrow(
        /BLOQUEIO CRÍTICO DE SEGURANÇA/
      );
      expect(() => validateRestoreTarget('aws-0-us-east-1.pooler.supabase.com')).toThrow(
        /BLOQUEIO CRÍTICO DE SEGURANÇA/
      );
      expect(validateRestoreTarget('localhost')).toBe(true);
      expect(validateRestoreTarget('127.0.0.1')).toBe(true);
    });

    it('3.2 Diagnostica ferramentas e reporta com precisão o bloqueador de PostgreSQL local', () => {
      const diag = diagnoseRestoreInfrastructure();
      expect(diag.hasPgRestore).toBe(true);
      expect(diag.pgRestorePath).toMatch(/pg_restore$/);

      // No ambiente atual, não há PostgreSQL server local ativo nem Docker rodando
      expect(diag.hasLocalPostgresServer).toBe(false);
      expect(diag.hasDocker).toBe(false);
      expect(diag.blockers.length).toBeGreaterThan(0);
      expect(diag.recommendedAction).toContain('NUNCA executar restauração apontando para o host remoto');
    });

    it('3.3 Confirma que o binário pg_restore do macOS (libpq 18.6) está instalado e funcional', () => {
      const pgRestore = findPgRestoreBinary();
      expect(pgRestore).toBeTruthy();
      const output = execFileSync(pgRestore!, ['--version'], { encoding: 'utf8' });
      expect(output).toContain('pg_restore (PostgreSQL) 18.');
    });
  });

  describe('4. Validação de Restauração em PostgreSQL Descartável (PGlite + pgvector)', () => {
    it('4.1 Restaura o DDL completo das 9 migrações e valida conformidade estrutural', async () => {
      const pglite = new PGlite({
        extensions: { vector },
      });

      try {
        await pglite.exec(`
          CREATE SCHEMA IF NOT EXISTS extensions;
          CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
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
          SET search_path = "$user", public, extensions;
        `);

        // 1. Aplica migrações 0..3 (Drizzle core)
        const ddlFiles = [
          'drizzle/0000_greedy_loki.sql',
          'drizzle/0001_dry_talos.sql',
          'drizzle/0002_little_swarm.sql',
          'drizzle/0003_f1_03_r_expansao.sql',
        ];

        for (const file of ddlFiles) {
          const sql = fs
            .readFileSync(path.resolve(process.cwd(), file), 'utf8')
            .replaceAll('--> statement-breakpoint', '\n');
          await pglite.exec(stripOuterTransaction(sql));
        }

        // 2. Aplica propostas 4..8 de modernização
        const proposalFiles = [
          'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql',
          'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql',
          'docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql',
          'docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql',
          'docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql',
        ];

        for (const file of proposalFiles) {
          const sql = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
          await pglite.exec(stripOuterTransaction(sql));
        }

        // 3. Valida schemas public e medicina
        const schemasRes = await pglite.query<{ nspname: string }>(`
          SELECT nspname FROM pg_namespace WHERE nspname IN ('public', 'medicina') ORDER BY nspname;
        `);
        expect(schemasRes.rows.map((r) => r.nspname)).toEqual(['medicina', 'public']);

        // 4. Valida funções críticas
        const fnRes = await pglite.query<{ proname: string }>(`
          SELECT proname FROM pg_proc WHERE proname IN ('autenticar_por_email', 'fn_busca_hibrida_acervo');
        `);
        const fnNames = fnRes.rows.map((r) => r.proname);
        expect(fnNames).toContain('autenticar_por_email');
        expect(fnNames).toContain('fn_busca_hibrida_acervo');

        // 5. Valida inventário de 32+ tabelas do domínio
        const tablesRes = await pglite.query<{ tablename: string }>(`
          SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
        `);
        expect(tablesRes.rows.length).toBeGreaterThanOrEqual(MIN_DOMAIN_TABLES_COUNT);

        // 6. Confirma estado pré-seed (acervo_arquivos e acervo_jobs vazios)
        const acervoCount = await pglite.query<{ count: string }>(
          'SELECT count(*) AS count FROM public.acervo_arquivos;'
        );
        expect(Number(acervoCount.rows[0].count)).toBe(0);

        const jobsCount = await pglite.query<{ count: string }>(
          'SELECT count(*) AS count FROM public.acervo_jobs;'
        );
        expect(Number(jobsCount.rows[0].count)).toBe(0);

        // 7. Confirma RLS ativo nas tabelas críticas
        const rlsRes = await pglite.query<{ tablename: string; rowsecurity: boolean }>(`
          SELECT tablename, rowsecurity
          FROM pg_tables
          WHERE schemaname = 'public'
            AND tablename IN ('perfis', 'acervo_arquivos', 'acervo_jobs', 'tentativas');
        `);
        for (const row of rlsRes.rows) {
          expect(row.rowsecurity).toBe(true);
        }
      } finally {
        await pglite.close();
      }
    });

    it('4.2 Rejeita inserção inconsistente fail-closed por foreign key e constraint de tipo', async () => {
      const pglite = new PGlite({
        extensions: { vector },
      });

      try {
        await pglite.exec(`
          CREATE SCHEMA IF NOT EXISTS extensions;
          CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
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
          SET search_path = "$user", public, extensions;
        `);

        const sql0000 = fs
          .readFileSync(path.resolve(process.cwd(), 'drizzle/0000_greedy_loki.sql'), 'utf8')
          .replaceAll('--> statement-breakpoint', '\n');
        await pglite.exec(stripOuterTransaction(sql0000));

        // Tentar inserir sessão com perfil inexistente deve falhar com FK violation
        await expect(
          pglite.exec(`
            INSERT INTO public.sessoes (
              id, perfil_id, tipo, duracao_planejada_min, criado_em, atualizado_em
            ) VALUES (
              gen_random_uuid(),
              '00000000-0000-0000-0000-000000000999',
              'conteudo',
              50,
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

  describe('5. Rastreabilidade de Scripts e Ferramentas Canônicas de Recuperação', () => {
    it('5.1 Confirma presença e permissões executáveis dos scripts de backup e recuperação', () => {
      const expectedScripts = [
        'scripts/backup/crypto_envelope.mjs',
        'scripts/backup/restore_postgres.sh',
        'scripts/backup/verify_restore.sh',
        'scripts/backup/sanitizar_pos_restore.sh',
        'scripts/backup/test_crypto_roundtrip.sh',
        'scripts/db/backup-staging-baseline.mjs',
        'scripts/db/verify-staging-baseline-backup.mjs',
      ];

      for (const relPath of expectedScripts) {
        const fullPath = path.resolve(process.cwd(), relPath);
        expect(fs.existsSync(fullPath)).toBe(true);
        const stat = fs.statSync(fullPath);
        // Verifica se tem permissão de execução
        expect(stat.mode & 0o111).toBeGreaterThan(0);
      }
    });
  });
});
