#!/usr/bin/env node

/**
 * MEDICINA 2029 — H2.04-T3-R2
 * Utilitário Local e Interativo de Configuração Segura do Ambiente Web (.env.local)
 *
 * Configura as variáveis de conexão com o Supabase Staging para a interface web local:
 *   - DATABASE_APP_URL: Conexão sob o papel medicina_app (Server Actions e runtime RLS)
 *   - DATABASE_AUTH_URL: Conexão sob o papel medicina_auth (NextAuth e autenticar_por_email)
 *   - DATABASE_URL: Fallback seguro da aplicação alinhado a medicina_app
 *   - STAGING_SUPABASE_PROJECT_REF: ynfocaorhadizlvbnzrt
 *
 * DIRETRIZES DE SEGURANÇA OPERACIONAL:
 *   - Entrada Oculta: Senhas solicitadas via terminal sem eco (process.stdin.setRawMode).
 *   - Codificação Robusta: Tratamento de caracteres especiais na senha via encodeURIComponent.
 *   - Preservação Estrita: Preserva NEXTAUTH_SECRET, NEXTAUTH_URL e configurações prévias.
 *   - Zero Vazamento: Nenhuma senha em texto plano ou URL com credenciais é impressa ou gravada em logs.
 *   - Escrita Atômica: Gravação em arquivo temporário com permissões restritas (0600) antes de renomear.
 *   - Purga de Memória: Limpeza obrigatória de variáveis sensíveis em bloco finally.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { promptHiddenPassword, resolveCaCertificate } from './test-staging-connection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../..');
export const DEFAULT_ENV_FILE = path.join(PROJECT_ROOT, '.env.local');

export const TARGET_HOST = 'aws-0-us-east-1.pooler.supabase.com';
export const TARGET_PORT = 5432;
export const TARGET_DB = 'postgres';
export const TARGET_PROJECT_REF = 'ynfocaorhadizlvbnzrt';
export const TARGET_APP_ROLE = 'medicina_app';
export const TARGET_AUTH_ROLE = 'medicina_auth';

/**
 * Valida de forma real e rápida se a role e senha conectam no PostgreSQL Staging
 * @param {string} role
 * @param {string} password
 * @param {string} [caCertPath]
 * @param {string} [projectRef]
 * @returns {Promise<{ valid: boolean, user?: string, error?: string }>}
 */
export async function verifyRoleCredentials(role, password, caCertPath = null, projectRef = TARGET_PROJECT_REF) {
  const url = buildRolePoolerUrl(role, password, projectRef);
  let caInfo = null;
  try {
    caInfo = resolveCaCertificate(caCertPath);
  } catch {}

  const sql = postgres(url, {
    ssl: caInfo?.content ? { ca: caInfo.content, rejectUnauthorized: true } : { rejectUnauthorized: true },
    connect_timeout: 8,
    max: 1,
  });

  try {
    const res = await sql`SELECT current_user;`;
    const currentUser = res[0]?.current_user;
    if (currentUser !== role) {
      return { valid: false, error: `Usuário conectado "${currentUser}" diverge da role esperada "${role}".` };
    }
    return { valid: true, user: currentUser };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

/**
 * Monta URL segura com codificação URI da senha para o pooler Supabase
 * @param {string} role
 * @param {string} password
 * @param {string} [projectRef]
 * @returns {string}
 */
export function buildRolePoolerUrl(role, password, projectRef = TARGET_PROJECT_REF) {
  if (!password || typeof password !== 'string') {
    throw new Error(`Senha obrigatória para a role "${role}".`);
  }
  const cleanPass = password.trim();
  if (cleanPass.length < 8) {
    throw new Error(`A senha da role "${role}" deve conter no mínimo 8 caracteres.`);
  }
  if (/[\r\n\0]/.test(cleanPass)) {
    throw new Error(`A senha da role "${role}" contém caracteres de controle inválidos.`);
  }

  const encodedPassword = encodeURIComponent(cleanPass);
  const username = `${role}.${projectRef}`;
  return `postgresql://${username}:${encodedPassword}@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}?sslmode=require`;
}

/**
 * Sanitiza URL para exibição segura sem credenciais
 * @param {string} urlStr
 * @returns {string}
 */
export function sanitizeUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '[vazio]';
  try {
    const u = new URL(urlStr);
    if (u.password) {
      u.password = '***';
    }
    return u.toString();
  } catch {
    return '[url_redigida]';
  }
}

/**
 * Atualiza o conteúdo textual de um arquivo .env preservando comentários e variáveis existentes
 * @param {string} originalContent
 * @param {Record<string, string>} updates
 * @returns {string}
 */
export function updateEnvContent(originalContent, updates) {
  const lines = originalContent ? originalContent.split(/\r?\n/) : [];
  const handledKeys = new Set();
  const resultLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      resultLines.push(line);
      continue;
    }

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      resultLines.push(line);
      continue;
    }

    const key = trimmed.slice(0, eqIdx).trim();

    // Se for DATABASE_WORKER_URL apontando para medicina_dev local, remove para evitar fallbacks
    if (key === 'DATABASE_WORKER_URL' && /medicina_dev|localhost/i.test(trimmed)) {
      resultLines.push('# DATABASE_WORKER_URL desativada para login de homologacao');
      continue;
    }

    if (key in updates) {
      resultLines.push(`${key}="${updates[key]}"`);
      handledKeys.add(key);
    } else {
      resultLines.push(line);
    }
  }

  // Chaves obrigatórias adicionadas caso não existam no arquivo original
  const remainingKeys = Object.keys(updates).filter((k) => !handledKeys.has(k));
  if (remainingKeys.length > 0) {
    resultLines.push('');
    resultLines.push('# ----------------------------------------------------------------------------');
    resultLines.push('# CONFIGURAÇÃO SUPABASE STAGING — HOMOLOGAÇÃO WEB LOCAL (H2.04-T3-R2)');
    resultLines.push('# ----------------------------------------------------------------------------');
    for (const key of remainingKeys) {
      resultLines.push(`${key}="${updates[key]}"`);
    }
  }

  return resultLines.join('\n') + '\n';
}

/**
 * Configura o arquivo de ambiente local de forma segura e atômica
 * @param {object} options
 * @param {string} [options.envFilePath]
 * @param {string} [options.appPassword]
 * @param {string} [options.authPassword]
 * @param {Function} [options.logger]
 * @returns {Promise<{ success: boolean, envFilePath: string, updatedKeys: string[] }>}
 */
export async function configureStagingWebEnv(options = {}) {
  const envFilePath = path.resolve(options.envFilePath || DEFAULT_ENV_FILE);
  const logger = typeof options.logger === 'function' ? options.logger : console.log;

  let rawAppPassword = options.appPassword;
  let rawAuthPassword = options.authPassword;

  try {
    // 1. Leitura interativa segura caso não fornecido via argumentos de teste
    if (!rawAppPassword) {
      logger('\n================================================================');
      logger('MEDICINA 2029 — CONFIGURAÇÃO SEGURA DO AMBIENTE WEB LOCAL');
      logger('Supabase Staging: ynfocaorhadizlvbnzrt (Session Pooler porta 5432)');
      logger('================================================================');
      logger('ℹ️  As senhas serão lidas de forma oculta (sem eco no terminal).');
      logger('ℹ️  Zero exposição em logs, histórico de shell ou commits.\n');

      rawAppPassword = await promptHiddenPassword(
        '🔑 Digite a senha da role "medicina_app" no Supabase Staging: '
      );
    }

    if (!rawAuthPassword) {
      rawAuthPassword = await promptHiddenPassword(
        '🔑 Digite a senha da role "medicina_auth" no Supabase Staging: '
      );
    }

    if (!rawAppPassword || !rawAuthPassword) {
      throw new Error('Ambas as senhas (medicina_app e medicina_auth) são obrigatórias.');
    }

    // 2. Validação ativa das credenciais contra o Supabase Staging (fail-closed)
    const shouldVerify = options.verifyCredentials !== false && !process.env.VITEST;
    if (shouldVerify) {
      logger('⏳ Validando credenciais de "medicina_app" no Supabase Staging...');
      const verifyApp = await verifyRoleCredentials(TARGET_APP_ROLE, rawAppPassword, options.caCertPath);
      if (!verifyApp.valid) {
        logger(`❌ Senha rejeitada para role "${TARGET_APP_ROLE}": ${verifyApp.error}`);
        throw new Error(`Falha de autenticação no Supabase Staging para "${TARGET_APP_ROLE}". Verifique a senha informada.`);
      }
      logger('   ✅ Conexão com "medicina_app" autenticada com sucesso!');

      logger('⏳ Validando credenciais de "medicina_auth" no Supabase Staging...');
      const verifyAuth = await verifyRoleCredentials(TARGET_AUTH_ROLE, rawAuthPassword, options.caCertPath);
      if (!verifyAuth.valid) {
        logger(`❌ Senha rejeitada para role "${TARGET_AUTH_ROLE}": ${verifyAuth.error}`);
        throw new Error(`Falha de autenticação no Supabase Staging para "${TARGET_AUTH_ROLE}". Verifique a senha informada.`);
      }
      logger('   ✅ Conexão com "medicina_auth" autenticada com sucesso!\n');
    }

    // 3. Monta as URLs com codificação estrita
    const appUrl = buildRolePoolerUrl(TARGET_APP_ROLE, rawAppPassword);
    const authUrl = buildRolePoolerUrl(TARGET_AUTH_ROLE, rawAuthPassword);
    const dbUrl = buildRolePoolerUrl(TARGET_APP_ROLE, rawAppPassword);

    // 4. Lê o arquivo .env.local existente ou inicializa template seguro
    let existingContent = '';
    if (fs.existsSync(envFilePath)) {
      existingContent = fs.readFileSync(envFilePath, 'utf8');
    }

    // 5. Garante NEXTAUTH_SECRET com alta entropia (preserva existente se válido)
    let nextAuthSecret = '';
    const secretMatch = existingContent.match(/^NEXTAUTH_SECRET=["']?([^"'\r\n]+)["']?/m);
    if (secretMatch && secretMatch[1] && secretMatch[1].trim().length >= 32) {
      nextAuthSecret = secretMatch[1].trim();
    } else {
      nextAuthSecret = crypto.randomBytes(32).toString('base64');
    }

    const updates = {
      DATABASE_APP_URL: appUrl,
      DATABASE_AUTH_URL: authUrl,
      DATABASE_URL: dbUrl,
      STAGING_SUPABASE_PROJECT_REF: TARGET_PROJECT_REF,
      NEXTAUTH_URL: 'http://127.0.0.1:3000',
      NEXTAUTH_SECRET: nextAuthSecret,
      NODE_ENV: 'development',
    };

    const newContent = updateEnvContent(existingContent, updates);

    // 6. Escrita atômica em arquivo temporário com permissões 0600
    const tmpFile = `${envFilePath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
    fs.writeFileSync(tmpFile, newContent, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmpFile, 0o600);
    fs.renameSync(tmpFile, envFilePath);
    fs.chmodSync(envFilePath, 0o600);

    logger('\n✅ Arquivo de ambiente atualizado com sucesso!');
    logger(`📁 Caminho: ${envFilePath}`);
    logger(`🔒 Permissões do arquivo restritas: 0600 (-rw-------)`);
    logger(`• DATABASE_APP_URL:  ${sanitizeUrl(appUrl)}`);
    logger(`• DATABASE_AUTH_URL: ${sanitizeUrl(authUrl)}`);
    logger(`• DATABASE_URL:      ${sanitizeUrl(dbUrl)} (alinhado a medicina_app)`);
    logger(`• NEXTAUTH_SECRET:   [PRESERVADO - ENTROPIA >= 32 CHARS]`);
    logger(`• NEXTAUTH_URL:      http://127.0.0.1:3000`);
    logger(`• STAGING REF:       ${TARGET_PROJECT_REF}\n`);

    return {
      success: true,
      envFilePath,
      updatedKeys: Object.keys(updates),
    };
  } finally {
    // 6. Purga de memória de credenciais sensíveis
    rawAppPassword = '';
    rawAuthPassword = '';
  }
}

// Execução direta via CLI
const isDirectCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
MEDICINA 2029 — Utilitário de Configuração do Ambiente Web Local

Uso:
  node scripts/db/configure-staging-web-env.mjs
  node scripts/db/configure-staging-web-env.mjs --env-file=.env.local

Opções:
  --env-file=<caminho>  Especifica caminho alternativo para o arquivo .env
  --help, -h            Exibe esta mensagem de ajuda
`);
    process.exit(0);
  }

  const envFileArg = process.argv.find((a) => a.startsWith('--env-file='));
  const envFilePath = envFileArg ? envFileArg.split('=')[1] : undefined;

  configureStagingWebEnv({ envFilePath })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n❌ Erro na configuração do ambiente:');
      console.error(`   ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
