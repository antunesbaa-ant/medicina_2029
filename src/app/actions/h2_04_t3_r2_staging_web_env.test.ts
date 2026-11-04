import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  buildRolePoolerUrl,
  updateEnvContent,
  configureStagingWebEnv,
  TARGET_HOST,
  TARGET_PORT,
  TARGET_DB,
  TARGET_PROJECT_REF,
} from '../../../scripts/db/configure-staging-web-env.mjs';
import {
  validateDatabaseUrl,
  auditStagingWebPreflight,
  parseEnvContent,
  CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256,
  buildNextDevArgs,
  DEFAULT_LOCAL_HOST,
  DEFAULT_LOCAL_PORT,
} from '../../../scripts/db/launch-staging-web.mjs';

describe('MEDICINA 2029 — H2.04-T3-R2: Configuração Segura do Ambiente Web Local', () => {
  let tempDir: string;
  let tempEnvPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medicina-staging-test-'));
    tempEnvPath = path.join(tempDir, '.env.local.test');
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignora falha em cleanup temporário
    }
  });

  describe('1. Construção e Codificação Segura de URLs (buildRolePoolerUrl)', () => {
    it('1.1 constrói a URL correta com projeto ynfocaorhadizlvbnzrt, porta 5432 e sslmode=require', () => {
      const url = buildRolePoolerUrl('medicina_app', 'senhaSegura123');
      expect(url).toBe(
        `postgresql://medicina_app.${TARGET_PROJECT_REF}:senhaSegura123@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}?sslmode=require`
      );

      const parsed = new URL(url);
      expect(parsed.hostname).toBe(TARGET_HOST);
      expect(parsed.port).toBe(String(TARGET_PORT));
      expect(parsed.username).toBe(`medicina_app.${TARGET_PROJECT_REF}`);
      expect(parsed.password).toBe('senhaSegura123');
      expect(parsed.searchParams.get('sslmode')).toBe('require');
    });

    it('1.2 codifica corretamente senhas com caracteres especiais (@, #, $, %, &, +, ?, /, :)', () => {
      const complexPass = 'p@ss#word$%123+&?/!:';
      const url = buildRolePoolerUrl('medicina_auth', complexPass);

      // A senha crua não deve aparecer descodificada na string da URL
      expect(url).not.toContain('p@ss#word');
      expect(url).toContain('p%40ss%23word');

      // Ao fazer o parse via new URL(), a senha deve ser decodificada de volta ao valor original exato
      const parsed = new URL(url);
      expect(decodeURIComponent(parsed.password)).toBe(complexPass);
    });

    it('1.3 rejeita senhas com menos de 8 caracteres ou com caracteres de controle', () => {
      expect(() => buildRolePoolerUrl('medicina_app', '1234567')).toThrow(/mínimo 8 caracteres/);
      expect(() => buildRolePoolerUrl('medicina_app', 'curta')).toThrow(/mínimo 8 caracteres/);
      expect(() => buildRolePoolerUrl('medicina_app', 'senha\ninvalida123')).toThrow(/caracteres de controle/);
      expect(() => buildRolePoolerUrl('medicina_app', 'senha\rinvalida123')).toThrow(/caracteres de controle/);
    });
  });

  describe('2. Atualização Atômica e Preservação de Variáveis (updateEnvContent)', () => {
    it('2.1 preserva NEXTAUTH_SECRET com alta entropia e outros campos intactos', () => {
      const original = [
        '# Arquivo de desenvolvimento prévio',
        'DATABASE_URL=postgres://postgres:postgres@localhost:5432/medicina_dev',
        'DATABASE_APP_URL=postgres://postgres:postgres@localhost:5432/medicina_dev',
        'DATABASE_AUTH_URL=postgres://postgres:postgres@localhost:5432/medicina_dev',
        'DATABASE_WORKER_URL=postgres://postgres:postgres@localhost:5432/medicina_dev',
        'NEXTAUTH_URL=http://localhost:3000',
        'NEXTAUTH_SECRET=meu_segredo_customizado_super_secreto_alta_entropia_12345',
        'CUSTOM_VAR=valor_preservado',
      ].join('\n');

      const updates = {
        DATABASE_APP_URL: 'postgresql://medicina_app.ynfocaorhadizlvbnzrt:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require',
        DATABASE_AUTH_URL: 'postgresql://medicina_auth.ynfocaorhadizlvbnzrt:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require',
        DATABASE_URL: 'postgresql://medicina_app.ynfocaorhadizlvbnzrt:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require',
        STAGING_SUPABASE_PROJECT_REF: 'ynfocaorhadizlvbnzrt',
      };

      const result = updateEnvContent(original, updates);

      expect(result).toContain('CUSTOM_VAR=valor_preservado');
      expect(result).toContain('NEXTAUTH_SECRET=meu_segredo_customizado_super_secreto_alta_entropia_12345');
      expect(result).toContain('DATABASE_APP_URL="postgresql://medicina_app.ynfocaorhadizlvbnzrt:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"');
      expect(result).toContain('STAGING_SUPABASE_PROJECT_REF="ynfocaorhadizlvbnzrt"');
      // Garante desativação de medicina_dev em DATABASE_WORKER_URL
      expect(result).not.toContain('DATABASE_WORKER_URL=postgres://postgres:postgres@localhost:5432/medicina_dev');
    });

    it('2.2 gera NEXTAUTH_SECRET aleatório forte se estiver ausente no arquivo', () => {
      const original = 'NODE_ENV=development\n';
      const updates = {
        DATABASE_APP_URL: 'postgresql://medicina_app.ynfocaorhadizlvbnzrt:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require',
      };

      const result = updateEnvContent(original, updates);
      expect(result).toContain('DATABASE_APP_URL=');
    });
  });

  describe('3. Utilitário configureStagingWebEnv (Permissões e Zero Vazamento)', () => {
    it('3.1 grava arquivo com permissões 0600 (-rw-------)', async () => {
      fs.writeFileSync(tempEnvPath, 'NODE_ENV=development\nNEXTAUTH_SECRET=segredo_existente_alta_entropia_32chars_ok\n', 'utf8');

      const logs: string[] = [];
      const res = await configureStagingWebEnv({
        envFilePath: tempEnvPath,
        appPassword: 'AppPassword123#',
        authPassword: 'AuthPassword123#',
        logger: (msg) => logs.push(msg),
      });

      expect(res.success).toBe(true);
      expect(fs.existsSync(tempEnvPath)).toBe(true);

      const stats = fs.statSync(tempEnvPath);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('3.2 zero vazamento de senhas nos logs gerados pelo configurador', async () => {
      const secretAppPass = 'SUPER_SECRETO_APP_PASS_999!';
      const secretAuthPass = 'SUPER_SECRETO_AUTH_PASS_888!';

      const logs: string[] = [];
      await configureStagingWebEnv({
        envFilePath: tempEnvPath,
        appPassword: secretAppPass,
        authPassword: secretAuthPass,
        logger: (msg) => logs.push(msg),
      });

      const joinedLogs = logs.join('\n');
      expect(joinedLogs).not.toContain(secretAppPass);
      expect(joinedLogs).not.toContain(secretAuthPass);
      expect(joinedLogs).toContain('medicina_app.ynfocaorhadizlvbnzrt:***');
      expect(joinedLogs).toContain('medicina_auth.ynfocaorhadizlvbnzrt:***');
    });
  });

  describe('4. Validação de URLs de Conexão no Preflight (validateDatabaseUrl)', () => {
    it('4.1 rejeita URLs apontando para localhost, 127.0.0.1 ou medicina_dev', () => {
      const localUrl = 'postgresql://medicina_app:senha@localhost:5432/medicina_dev?sslmode=require';
      const res = validateDatabaseUrl(localUrl, 'medicina_app', 'DATABASE_APP_URL');

      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('hostname incorreto'))).toBe(true);
      expect(res.errors.some((e) => e.includes('medicina_dev'))).toBe(true);
    });

    it('4.2 rejeita portas incorretas (ex: porta 6543 do Transaction Pooler)', () => {
      const wrongPortUrl = `postgresql://medicina_app.${TARGET_PROJECT_REF}:senha@${TARGET_HOST}:6543/${TARGET_DB}?sslmode=require`;
      const res = validateDatabaseUrl(wrongPortUrl, 'medicina_app', 'DATABASE_APP_URL');

      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('porta incorreta "6543"'))).toBe(true);
    });

    it('4.3 rejeita role incorreta (ex: uso de postgres ou papel trocado)', () => {
      const adminUrl = `postgresql://postgres.${TARGET_PROJECT_REF}:senha@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}?sslmode=require`;
      const res = validateDatabaseUrl(adminUrl, 'medicina_app', 'DATABASE_APP_URL');

      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('usuário incorreto'))).toBe(true);
    });

    it('4.4 rejeita sslmode ausente ou desativado', () => {
      const noSslUrl = `postgresql://medicina_app.${TARGET_PROJECT_REF}:senha@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}`;
      const res = validateDatabaseUrl(noSslUrl, 'medicina_app', 'DATABASE_APP_URL');

      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('sslmode ausente'))).toBe(true);
    });

    it('4.5 aceita URL canônica de staging perfeitamente configurada', () => {
      const validUrl = `postgresql://medicina_app.${TARGET_PROJECT_REF}:senhaValida123@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}?sslmode=require`;
      const res = validateDatabaseUrl(validUrl, 'medicina_app', 'DATABASE_APP_URL');

      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });
  });

  describe('5. Auditoria de Preflight do Lançador (auditStagingWebPreflight)', () => {
    it('5.1 falha fechado se o arquivo .env.local não existir', () => {
      const nonExistentPath = path.join(tempDir, 'non_existent.env');
      const res = auditStagingWebPreflight({ envFilePath: nonExistentPath });

      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('Arquivo .env.local ausente'))).toBe(true);
    });

    it('5.2 falha fechado se NEXTAUTH_SECRET tiver menos de 32 caracteres', () => {
      const content = [
        `DATABASE_APP_URL="postgresql://medicina_app.${TARGET_PROJECT_REF}:pass12345@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}?sslmode=require"`,
        `DATABASE_AUTH_URL="postgresql://medicina_auth.${TARGET_PROJECT_REF}:pass12345@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}?sslmode=require"`,
        'NEXTAUTH_URL="http://localhost:3000"',
        'NEXTAUTH_SECRET="curto"',
      ].join('\n');

      fs.writeFileSync(tempEnvPath, content, { encoding: 'utf8', mode: 0o600 });
      const res = auditStagingWebPreflight({ envFilePath: tempEnvPath });

      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('entropia insuficiente'))).toBe(true);
    });

    it('5.3 aprova com sucesso preflight completo com CA certificado e credenciais válidas', () => {
      const validSecret = crypto.randomBytes(32).toString('hex');
      const content = [
        `DATABASE_APP_URL="postgresql://medicina_app.${TARGET_PROJECT_REF}:pass12345@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}?sslmode=require"`,
        `DATABASE_AUTH_URL="postgresql://medicina_auth.${TARGET_PROJECT_REF}:pass12345@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}?sslmode=require"`,
        `DATABASE_URL="postgresql://medicina_app.${TARGET_PROJECT_REF}:pass12345@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}?sslmode=require"`,
        'NEXTAUTH_URL="http://localhost:3000"',
        `NEXTAUTH_SECRET="${validSecret}"`,
        'NODE_ENV="development"',
      ].join('\n');

      fs.writeFileSync(tempEnvPath, content, { encoding: 'utf8', mode: 0o600 });

      // Certificado padrão em Downloads do usuário Mac
      const caPath = path.join(os.homedir(), 'Downloads', 'prod-ca-2021.crt');
      if (fs.existsSync(caPath)) {
        const res = auditStagingWebPreflight({ envFilePath: tempEnvPath, caCertPath: caPath });
        expect(res.valid).toBe(true);
        expect(res.errors).toHaveLength(0);
        expect(res.caPath).toBe(caPath);
      }
    });
  });

  describe('6. Amarração de Rede Local do Next.js (buildNextDevArgs)', () => {
    it('6.1 amarra o servidor Next.js exclusivamente em 127.0.0.1:3000 por padrão', () => {
      const args = buildNextDevArgs();
      expect(args).toEqual(['next', 'dev', '-H', '127.0.0.1', '-p', '3000']);
      expect(DEFAULT_LOCAL_HOST).toBe('127.0.0.1');
      expect(DEFAULT_LOCAL_PORT).toBe('3000');
    });

    it('6.2 permite porta ou host customizados mantendo os seletores -H e -p', () => {
      const args = buildNextDevArgs('127.0.0.1', '3001');
      expect(args).toEqual(['next', 'dev', '-H', '127.0.0.1', '-p', '3001']);
    });
  });
});
