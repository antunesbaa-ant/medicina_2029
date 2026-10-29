import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findLatestBaselineBackup,
  verifyBackupFilesAndHeaders,
  validateRestoreTarget,
  diagnoseRestoreInfrastructure,
  EXPECTED_MIGRATIONS_COUNT,
  MIN_DOMAIN_TABLES_COUNT,
} from '../../../scripts/db/verify-staging-baseline-backup.mjs';
import {
  runPreparationAudit,
  COMPATIBILITY_MATRIX,
  ISOLATED_ENV_CONFIG,
  STAGES_DISTINCTION,
  SEPARATE_PROCEDURES_DOCUMENTATION,
  APTO_CRITERIA,
  generateOperatorCommands,
} from '../../../scripts/db/prepare-staging-baseline-restore.mjs';

describe('MEDICINA 2029 — H2.03-R2A: Ajustes Finais da Restauração Isolada', () => {
  describe('1. Inspeção dos Scripts de Restauração e Salvaguardas de Segurança', () => {
    it('1.1 Confirma que restore_postgres.sh recusa sumariamente qualquer host remoto ou Supabase', () => {
      const scriptPath = path.resolve('scripts/backup/restore_postgres.sh');
      expect(fs.existsSync(scriptPath)).toBe(true);

      const content = fs.readFileSync(scriptPath, 'utf8');

      // Rejeição contra Supabase
      expect(content).toContain('supabase\\.co');
      expect(content).toContain('pooler\\.supabase\\.com');

      // Rejeição contra qualquer host não-local
      expect(content).toContain('"${TARGET_PGHOST}" != "127.0.0.1"');
      expect(content).toContain('"${TARGET_PGHOST}" != "localhost"');

      // Testa execução simulada com host remoto
      const resRemote = spawnSync('bash', [scriptPath, '/tmp/fakedir'], {
        env: { ...process.env, TARGET_PGHOST: 'aws-0-us-east-1.pooler.supabase.com' },
        encoding: 'utf8',
      });
      expect(resRemote.status).not.toBe(0);
      expect(resRemote.stderr).toContain('VIOLAÇÃO CRÍTICA DE SEGURANÇA');

      const resExternal = spawnSync('bash', [scriptPath, '/tmp/fakedir'], {
        env: { ...process.env, TARGET_PGHOST: '192.168.1.150' },
        encoding: 'utf8',
      });
      expect(resExternal.status).not.toBe(0);
      expect(resExternal.stderr).toContain('VIOLAÇÃO DE ISOLAMENTO LOCAL');
    });

    it('1.2 Confirma que verify_restore.sh recusa sumariamente qualquer host remoto ou Supabase', () => {
      const scriptPath = path.resolve('scripts/backup/verify_restore.sh');
      expect(fs.existsSync(scriptPath)).toBe(true);

      const content = fs.readFileSync(scriptPath, 'utf8');
      expect(content).toContain('supabase\\.co');
      expect(content).toContain('127.0.0.1');

      const resRemote = spawnSync('bash', [scriptPath, 'test_db'], {
        env: { ...process.env, TARGET_PGHOST: 'remote-database.internal' },
        encoding: 'utf8',
      });
      expect(resRemote.status).not.toBe(0);
      expect(resRemote.stderr).toContain('VIOLAÇÃO DE ISOLAMENTO LOCAL');
    });

    it('1.3 Confirma porta padrão 5433 para isolamento e ausência de senhas fixas', () => {
      const restoreScript = fs.readFileSync('scripts/backup/restore_postgres.sh', 'utf8');
      const verifyScript = fs.readFileSync('scripts/backup/verify_restore.sh', 'utf8');

      expect(restoreScript).toContain('TARGET_PGPORT="${TARGET_PGPORT:-5433}"');
      expect(verifyScript).toContain('TARGET_PGPORT="${TARGET_PGPORT:-5433}"');

      // Nenhuma senha fixa em código
      expect(restoreScript).not.toMatch(/postgres_descartavel/i);
      expect(restoreScript).not.toMatch(/POSTGRES_PASSWORD=[a-zA-Z0-9_-]+/);
      expect(verifyScript).not.toMatch(/postgres_descartavel/i);
    });

    it('1.4 Confirma rotina de limpeza imediata e trap com múltiplos sinais em restore_postgres.sh', () => {
      const restoreScript = fs.readFileSync('scripts/backup/restore_postgres.sh', 'utf8');
      expect(restoreScript).toContain('trap cleanup EXIT INT TERM HUP');
      expect(restoreScript).toContain('rm -f "${DUMP_TO_RESTORE}"');
      expect(restoreScript).toContain('zero cópias claras mantidas');
    });
  });

  describe('2. Contagens do Baseline e Inventário Real (Ajuste R2A.1)', () => {
    it('2.1 Identifica os 2 registros canônicos de e-mail na tabela allowlist da migração 0000', () => {
      const mig0000 = fs.readFileSync('drizzle/0000_greedy_loki.sql', 'utf8');
      expect(mig0000).toContain('CREATE TABLE IF NOT EXISTS public.allowlist');
      expect(mig0000).toContain('estudante@medicina2029.com.br');
      expect(mig0000).toContain('responsavel@medicina2029.com.br');
    });

    it('2.2 Confirma que verify_restore.sh compara contagens com o mapa real do manifesto quando fornecido', () => {
      const verifyScript = fs.readFileSync('scripts/backup/verify_restore.sh', 'utf8');
      expect(verifyScript).toContain('table_row_counts');
      expect(verifyScript).toContain('MANIFEST_MAP');
      expect(verifyScript).toContain('MANIFEST_FILE');
    });

    it('2.3 Confirma validação sem presunção: allowlist = 2, migrations = 9 e 34 tabelas = 0', () => {
      const verifyScript = fs.readFileSync('scripts/backup/verify_restore.sh', 'utf8');
      expect(verifyScript).toContain('public.allowlist: 2 registros canônicos');
      expect(verifyScript).toContain('estudante@medicina2029.com.br');
      expect(verifyScript).toContain('responsavel@medicina2029.com.br');
    });
  });

  describe('3. Autenticação Local SCRAM-SHA-256 e Senha Efêmera (Ajuste R2A.2)', () => {
    it('3.1 Substitui trust por SCRAM-SHA-256 e segredo em arquivo restrito (0600)', () => {
      expect(ISOLATED_ENV_CONFIG.authMethod).toBe('scram-sha-256');

      const commands = generateOperatorCommands('/tmp/fake-baseline');
      expect(commands.startContainerScript).toContain('openssl rand -hex 32');
      expect(commands.startContainerScript).toContain('POSTGRES_PASSWORD_FILE=/run/secrets/pg_password');
      expect(commands.startContainerScript).toContain('--auth-host=scram-sha-256');
      expect(commands.startContainerScript).toContain('PGPASSFILE');
      expect(commands.startContainerScript).not.toContain('POSTGRES_HOST_AUTH_METHOD=trust');
    });

    it('3.2 Garante bind estrito em 127.0.0.1:5433 e purga de credenciais no cleanup', () => {
      const commands = generateOperatorCommands('/tmp/fake-baseline');
      expect(commands.startContainerScript).toContain('-p 127.0.0.1:5433:5432');
      expect(commands.cleanupScript).toContain('docker stop pg-test-restore');
      expect(commands.cleanupScript).toContain('rm -rf "${SEC_TMP}"');
      expect(commands.cleanupScript).toContain('unset PGPASSFILE');
    });

    it('3.3 Garante que a função validateRestoreTarget aceita apenas loopback', () => {
      expect(validateRestoreTarget('127.0.0.1')).toBe(true);
      expect(validateRestoreTarget('localhost')).toBe(true);
      expect(() => validateRestoreTarget('aws-0-us-east-1.pooler.supabase.com')).toThrow();
      expect(() => validateRestoreTarget('ynfocaorhadizlvbnzrt.supabase.co')).toThrow();
      expect(() => validateRestoreTarget('10.0.0.1')).toThrow();
      expect(() => validateRestoreTarget('example.com')).toThrow();
    });
  });

  describe('4. Dependências de Restauração e Paridade pgvector 0.8.2 (Ajuste R2A.3)', () => {
    it('4.1 Prepara roles técnicas locais NOLOGIN no banco descartável antes do pg_restore', () => {
      const restoreScript = fs.readFileSync('scripts/backup/restore_postgres.sh', 'utf8');
      expect(restoreScript).toContain('CREATE ROLE medicina_app NOLOGIN');
      expect(restoreScript).toContain('CREATE ROLE medicina_auth NOLOGIN');
      expect(restoreScript).toContain('CREATE ROLE medicina_worker NOLOGIN');
      expect(restoreScript).toContain('CREATE ROLE anon NOLOGIN');
      expect(restoreScript).toContain('CREATE ROLE authenticated NOLOGIN');
      expect(restoreScript).toContain('CREATE ROLE service_role NOLOGIN');
    });

    it('4.2 Prepara schema extensions, extensões e search_path public, extensions', () => {
      const restoreScript = fs.readFileSync('scripts/backup/restore_postgres.sh', 'utf8');
      expect(restoreScript).toContain('CREATE SCHEMA IF NOT EXISTS extensions;');
      expect(restoreScript).toContain('CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;');
      expect(restoreScript).toContain('SET search_path TO public, extensions;');
      expect(restoreScript).toContain('DROP SCHEMA IF EXISTS public CASCADE;');
    });

    it('4.3 Fixa imagem Docker de PostgreSQL 18 com pgvector 0.8.2 para paridade exata com staging', () => {
      expect(COMPATIBILITY_MATRIX.sourceDb.pgvectorVersion).toBe('0.8.2');
      expect(COMPATIBILITY_MATRIX.destinations.pg18.pgvectorVersion).toBe('0.8.2');
      expect(ISOLATED_ENV_CONFIG.recommendedImage).toContain('0.8.2-pg18');
    });

    it('4.4 Adverte formalmente sobre falta de compatibilidade garantida do pg_dump 18 com servidor 16', () => {
      const pg16Info = COMPATIBILITY_MATRIX.destinations.pg16;
      expect(pg16Info.compatible).toBe(false);
      expect(pg16Info.status).toContain('NÃO GARANTIDO');
      expect(pg16Info.notes).toContain('Dumps gerados por pg_dump 18 não possuem compatibilidade oficial com servidores PG 16');
    });
  });

  describe('5. Validação com Erro Fatal e Distinção de Estágios (Ajuste R2A.4)', () => {
    it('5.1 Exige pg_restore com erro fatal em falha (sem ignorar erros ou emitir apenas aviso)', () => {
      const restoreScript = fs.readFileSync('scripts/backup/restore_postgres.sh', 'utf8');
      expect(restoreScript).toContain('if ! pg_restore');
      expect(restoreScript).toContain('ERRO FATAL: pg_restore falhou durante a reconstituição');
      expect(restoreScript).toContain('exit 1');
      expect(restoreScript).not.toContain('AVISO: pg_restore finalizou com avisos/erros não fatais');
    });

    it('5.2 Distingue com precisão os 4 estágios da recuperação', () => {
      expect(STAGES_DISTINCTION.stage1.id).toBe('PREPARACAO_SCRIPTS');
      expect(STAGES_DISTINCTION.stage2.id).toBe('DUMP_RESTAURADO');
      expect(STAGES_DISTINCTION.stage3.id).toBe('INTEGRIDADE_CONFERIDA');
      expect(STAGES_DISTINCTION.stage4.id).toBe('RECUPERAÇÃO_INTEGRAL_SUPABASE'.replace('ÇÃO', 'CAO'));
    });

    it('5.3 Aponta comandos operacionais para o dump REAL decifrado temporariamente', () => {
      const audit = runPreparationAudit();
      expect(audit.latestBackup.dirName).toMatch(/^medicina2029_staging_baseline_/);
      expect(audit.commands.restoreCmd).toContain(audit.latestBackup.fullPath);
      expect(audit.commands.restoreCmd).toContain('scripts/backup/restore_postgres.sh');
    });
  });

  describe('6. Cobertura das 7 Dimensões e Critérios APTO Consolidados', () => {
    it('6.1 Confirma validação das 4 extensões com auditoria de versão do pgvector', () => {
      const verifyScript = fs.readFileSync('scripts/backup/verify_restore.sh', 'utf8');
      expect(verifyScript).toContain('vector');
      expect(verifyScript).toContain('unaccent');
      expect(verifyScript).toContain('pgcrypto');
      expect(verifyScript).toContain('uuid-ossp');
      expect(verifyScript).toContain('PGVECTOR_VERSION');
    });

    it('6.2 Confirma validação de funções críticas, RLS e índices HNSW', () => {
      const verifyScript = fs.readFileSync('scripts/backup/verify_restore.sh', 'utf8');
      expect(verifyScript).toContain('fn_busca_hibrida_acervo');
      expect(verifyScript).toContain('autenticar_por_email');
      expect(verifyScript).toContain('vector_cosine_ops');
      expect(verifyScript).toContain('rowsecurity');
    });

    it('6.3 Confirma histórico com 9 migrações e valida catálogo de critérios APTO/NÃO APTO', () => {
      const verifyScript = fs.readFileSync('scripts/backup/verify_restore.sh', 'utf8');
      expect(verifyScript).toContain('_medicina_staging_migrations');
      expect(verifyScript).toContain('MIGRATION_COUNT}" -eq 9');

      expect(APTO_CRITERIA.length).toBe(15);
      expect(APTO_CRITERIA[1]).toContain('SCRAM-SHA-256');
      expect(APTO_CRITERIA[8]).toContain('allowlist = 2');
    });
  });
});
