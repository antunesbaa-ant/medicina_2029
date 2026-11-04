#!/usr/bin/env node

/**
 * MEDICINA 2029 — H2.04-T3-R2
 * Lançador Seguro de Homologação Web no Staging (Preflight & Server Launcher)
 *
 * Valida de forma estrita (fail-closed) as configurações do ambiente antes
 * de inicializar o servidor de desenvolvimento Next.js para testes de login:
 *   - Projeto Supabase exato: ynfocaorhadizlvbnzrt
 *   - Host e porta canônicos: aws-0-us-east-1.pooler.supabase.com:5432 (Session Pooler)
 *   - Segregação de papéis: medicina_app (app) e medicina_auth (auth)
 *   - Ausência absoluta de fallbacks para localhost ou medicina_dev
 *   - Validação do certificado TLS raiz (prod-ca-2021.crt) via fingerprint SHA-256
 *   - Entropia e integridade do NEXTAUTH_SECRET (>= 32 chars) e NEXTAUTH_URL
 *   - Configura compulsoriamente NODE_EXTRA_CA_CERTS no processo antes de iniciar o Next.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { resolveCaCertificate } from './test-staging-connection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../..');
export const DEFAULT_ENV_FILE = path.join(PROJECT_ROOT, '.env.local');

export const TARGET_HOST = 'aws-0-us-east-1.pooler.supabase.com';
export const TARGET_PORT = 5432;
export const TARGET_DB = 'postgres';
export const TARGET_PROJECT_REF = 'ynfocaorhadizlvbnzrt';
export const DEFAULT_LOCAL_HOST = '127.0.0.1';
export const DEFAULT_LOCAL_PORT = '3000';

export const CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256 = Object.freeze(
  '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA'
);

/**
 * Constrói os argumentos de execução do Next.js dev server com amarração estrita em 127.0.0.1
 * @param {string} [host]
 * @param {string} [port]
 * @returns {string[]}
 */
export function buildNextDevArgs(host = DEFAULT_LOCAL_HOST, port = DEFAULT_LOCAL_PORT) {
  return ['next', 'dev', '-H', String(host), '-p', String(port)];
}

const INSECURE_DEFAULT_SECRETS = new Set([
  'secret',
  'password',
  'change-me',
  '12345678',
  'nextauth_secret',
  'sua_chave_secreta_aqui',
]);

/**
 * Faz o parse simples e seguro de um arquivo .env sem expor valores
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseEnvContent(content) {
  const result = {};
  if (!content) return result;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }
  return result;
}

/**
 * Valida estritamente uma URL de conexão PostgreSQL para staging
 * @param {string} urlStr
 * @param {string} expectedRole
 * @param {string} varName
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDatabaseUrl(urlStr, expectedRole, varName) {
  const errors = [];
  if (!urlStr || typeof urlStr !== 'string') {
    errors.push(`${varName} não está configurada.`);
    return { valid: false, errors };
  }

  try {
    const parsed = new URL(urlStr);
    const protocol = parsed.protocol.replace(':', '');
    if (protocol !== 'postgres' && protocol !== 'postgresql') {
      errors.push(`${varName}: protocolo inválido "${parsed.protocol}". Esperado "postgresql:".`);
    }

    if (parsed.hostname.toLowerCase() !== TARGET_HOST) {
      errors.push(`${varName}: hostname incorreto "${parsed.hostname}". Esperado "${TARGET_HOST}".`);
    }

    const port = parsed.port ? parseInt(parsed.port, 10) : 5432;
    if (port !== TARGET_PORT) {
      errors.push(
        `${varName}: porta incorreta "${port}". O Session Pooler exige porta 5432 (porta 6543 incompatível com prepared statements).`
      );
    }

    const dbName = parsed.pathname.replace(/^\//, '');
    if (dbName.toLowerCase() !== TARGET_DB) {
      errors.push(`${varName}: database incorreto "${dbName}". Esperado "${TARGET_DB}".`);
    }

    const rawUser = decodeURIComponent(parsed.username || '');
    const expectedUsername = `${expectedRole}.${TARGET_PROJECT_REF}`;
    if (rawUser.toLowerCase() !== expectedUsername) {
      errors.push(
        `${varName}: usuário incorreto "${rawUser}". Esperado "${expectedUsername}" (role "${expectedRole}" no projeto "${TARGET_PROJECT_REF}").`
      );
    }

    if (!parsed.password) {
      errors.push(`${varName}: senha ausente na URL de conexão.`);
    }

    const sslmode = parsed.searchParams.get('sslmode');
    if (!sslmode || (sslmode !== 'require' && sslmode !== 'verify-full' && sslmode !== 'verify-ca')) {
      errors.push(
        `${varName}: parâmetro sslmode ausente ou inseguro. Esperado "?sslmode=require" (obtido: "${sslmode || 'nenhum'}").`
      );
    }

    if (/localhost|127\.0\.0\.1|medicina_dev/i.test(urlStr)) {
      errors.push(`${varName}: contém referências residuais a ambiente de desenvolvimento local (medicina_dev).`);
    }
  } catch (err) {
    errors.push(`${varName}: formato de URL PostgreSQL inválido.`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Executa a auditoria completa de preflight antes de inicializar o servidor
 * @param {object} options
 * @param {string} [options.envFilePath]
 * @param {string} [options.caCertPath]
 * @param {Function} [options.logger]
 * @returns {{ valid: boolean, errors: string[], warnings: string[], caPath: string | null }}
 */
export function auditStagingWebPreflight(options = {}) {
  const envFilePath = path.resolve(options.envFilePath || DEFAULT_ENV_FILE);
  const logger = typeof options.logger === 'function' ? options.logger : console.log;
  const errors = [];
  const warnings = [];

  // 1. Verificação da existência do .env.local
  if (!fs.existsSync(envFilePath)) {
    errors.push(
      `Arquivo .env.local ausente em "${envFilePath}".\n` +
      `   👉 Execute primeiro: node scripts/db/configure-staging-web-env.mjs`
    );
    return { valid: false, errors, warnings, caPath: null };
  }

  // 2. Verificação de permissões do arquivo (exige 0600)
  try {
    const stats = fs.statSync(envFilePath);
    const mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warnings.push(`Permissões do arquivo .env.local estão em ${mode.toString(8)}. Ajustando automaticamente para 0600.`);
      fs.chmodSync(envFilePath, 0o600);
    }
  } catch {
    // ignora em sistemas que não suportam chmod POSIX
  }

  const content = fs.readFileSync(envFilePath, 'utf8');
  const env = parseEnvContent(content);

  // 3. Validação das conexões de banco de dados
  const appRes = validateDatabaseUrl(env.DATABASE_APP_URL, 'medicina_app', 'DATABASE_APP_URL');
  if (!appRes.valid) errors.push(...appRes.errors);

  const authRes = validateDatabaseUrl(env.DATABASE_AUTH_URL, 'medicina_auth', 'DATABASE_AUTH_URL');
  if (!authRes.valid) errors.push(...authRes.errors);

  if (env.DATABASE_URL) {
    if (/localhost|127\.0\.0\.1|medicina_dev/i.test(env.DATABASE_URL)) {
      errors.push('DATABASE_URL (fallback): aponta para base local medicina_dev. Deve ser alinhada ao staging.');
    }
  }

  // 4. Validação de ausência de referências a desenvolvimento residual
  for (const [k, v] of Object.entries(env)) {
    if (k.endsWith('_URL') && /medicina_dev/i.test(v)) {
      errors.push(`Variável ${k} contém referência proibida a "medicina_dev".`);
    }
  }

  // 5. Validação do NEXTAUTH_SECRET
  const secret = (env.NEXTAUTH_SECRET || '').trim();
  if (!secret) {
    errors.push('NEXTAUTH_SECRET ausente no arquivo .env.local.');
  } else if (secret.length < 32) {
    errors.push(`NEXTAUTH_SECRET possui entropia insuficiente (${secret.length} caracteres; mínimo exigido: 32).`);
  } else if (INSECURE_DEFAULT_SECRETS.has(secret.toLowerCase())) {
    errors.push('NEXTAUTH_SECRET utiliza um valor padrão inseguro conhecido.');
  }

  // 6. Validação do NEXTAUTH_URL
  const nextAuthUrl = (env.NEXTAUTH_URL || '').trim();
  if (!nextAuthUrl) {
    errors.push('NEXTAUTH_URL ausente no arquivo .env.local.');
  } else {
    try {
      const parsedUrl = new URL(nextAuthUrl);
      if (parsedUrl.hostname !== 'localhost' && parsedUrl.hostname !== '127.0.0.1') {
        warnings.push(`NEXTAUTH_URL configurada para host externo: "${nextAuthUrl}".`);
      }
      const expectedHost = options.targetHost || DEFAULT_LOCAL_HOST;
      if (parsedUrl.hostname !== expectedHost) {
        warnings.push(
          `Discrepância de Host: NEXTAUTH_URL está configurada para "${parsedUrl.hostname}", mas o Next.js escuta em "${expectedHost}". Para evitar rejeição de cookies de sessão no Safari, alinhe NEXTAUTH_URL para "http://${expectedHost}:3000".`
        );
      }
    } catch {
      errors.push(`NEXTAUTH_URL inválida: "${nextAuthUrl}".`);
    }
  }

  // 7. Validação do Certificado TLS CA do Supabase
  let caInfo = null;
  try {
    caInfo = resolveCaCertificate(options.caCertPath || env.SUPABASE_SSL_CA || env.NODE_EXTRA_CA_CERTS);
    if (!caInfo) {
      errors.push(
        'Certificado TLS CA do Supabase (prod-ca-2021.crt) não localizado em ~/Downloads ou caminho configurado.'
      );
    } else if (caInfo.metadata?.fingerprint256 !== CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256) {
      errors.push(
        `FALHA DE SEGURANÇA TLS: Fingerprint do certificado CA diverge do canônico!\n` +
        `Esperado: ${CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256}\n` +
        `Obtido:   ${caInfo.metadata?.fingerprint256}`
      );
    }
  } catch (err) {
    errors.push(`Erro ao validar certificado CA TLS: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    caPath: caInfo ? caInfo.path : null,
  };
}

/**
 * Testa de forma rápida e segura a conectividade real de medicina_app e medicina_auth com TLS
 * @param {Record<string, string>} env
 * @param {string|null} caPath
 * @returns {Promise<{ app: boolean, auth: boolean, errors: string[] }>}
 */
export async function verifyPreflightConnections(env, caPath = null) {
  const results = { app: false, auth: false, errors: [] };
  let caContent = null;
  if (caPath && fs.existsSync(caPath)) {
    try {
      caContent = fs.readFileSync(caPath, 'utf8');
    } catch {}
  }

  // 1. Testar DATABASE_APP_URL
  if (env.DATABASE_APP_URL) {
    try {
      const sqlApp = postgres(env.DATABASE_APP_URL, {
        ssl: caContent ? { ca: caContent, rejectUnauthorized: true } : { rejectUnauthorized: true },
        connect_timeout: 8,
        max: 1,
      });
      const res = await sqlApp`SELECT current_user;`;
      await sqlApp.end({ timeout: 2 }).catch(() => {});
      if (res[0]?.current_user === 'medicina_app') {
        results.app = true;
      } else {
        results.errors.push(`DATABASE_APP_URL conectou como "${res[0]?.current_user}", esperado "medicina_app".`);
      }
    } catch (err) {
      results.errors.push(`DATABASE_APP_URL falhou na autenticação PostgreSQL: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    results.errors.push('DATABASE_APP_URL ausente no arquivo de ambiente.');
  }

  // 2. Testar DATABASE_AUTH_URL
  if (env.DATABASE_AUTH_URL) {
    try {
      const sqlAuth = postgres(env.DATABASE_AUTH_URL, {
        ssl: caContent ? { ca: caContent, rejectUnauthorized: true } : { rejectUnauthorized: true },
        connect_timeout: 8,
        max: 1,
      });
      const res = await sqlAuth`SELECT current_user;`;
      await sqlAuth.end({ timeout: 2 }).catch(() => {});
      if (res[0]?.current_user === 'medicina_auth') {
        results.auth = true;
      } else {
        results.errors.push(`DATABASE_AUTH_URL conectou como "${res[0]?.current_user}", esperado "medicina_auth".`);
      }
    } catch (err) {
      results.errors.push(`DATABASE_AUTH_URL falhou na autenticação PostgreSQL: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    results.errors.push('DATABASE_AUTH_URL ausente no arquivo de ambiente.');
  }

  return results;
}

// Execução direta via CLI
const isDirectCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  (async () => {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      console.log(`
MEDICINA 2029 — Lançador Seguro de Homologação Web Staging

Uso:
  node scripts/db/launch-staging-web.mjs [opções]

Opções:
  --check-only          Executa apenas a validação de preflight e encerra com código 0
  --skip-verify-conn    Pula a validação ativa de conexão PostgreSQL
  --env-file=<caminho>  Especifica caminho alternativo para o arquivo .env
  --ca=<caminho>        Especifica caminho customizado para o certificado CA TLS
  --host=<ip>           Interface de rede local do Next.js (padrão estrito: 127.0.0.1)
  --port=<porta>        Porta local do Next.js (padrão: 3000)
  --help, -h            Exibe esta mensagem de ajuda
`);
      process.exit(0);
    }

    const isCheckOnly = process.argv.includes('--check-only') || process.argv.includes('--dry-run');
    const envFileArg = process.argv.find((a) => a.startsWith('--env-file='));
    const envFilePath = envFileArg ? envFileArg.split('=')[1] : undefined;
    const caArg = process.argv.find((a) => a.startsWith('--ca='));
    const caCertPath = caArg ? caArg.split('=')[1] : undefined;
    const hostArg = process.argv.find((a) => a.startsWith('--host=') || a.startsWith('--hostname='));
    const targetHost = hostArg ? hostArg.split('=')[1] : DEFAULT_LOCAL_HOST;
    const portArg = process.argv.find((a) => a.startsWith('--port='));
    const targetPort = portArg ? portArg.split('=')[1] : DEFAULT_LOCAL_PORT;

    console.log('================================================================');
    console.log('MEDICINA 2029 — PREFLIGHT DE HOMOLOGAÇÃO WEB STAGING (H2.04-T3-R2)');
    console.log('================================================================');

    const preflight = auditStagingWebPreflight({ envFilePath, caCertPath, targetHost, targetPort });

    if (preflight.warnings.length > 0) {
      for (const w of preflight.warnings) {
        console.warn(`⚠️  ${w}`);
      }
    }

    if (!preflight.valid) {
      console.error('\n❌ PREFLIGHT REPROVADO (FAIL-CLOSED):');
      for (const err of preflight.errors) {
        console.error(`   • ${err}`);
      }
      console.error('\nO servidor Next.js NÃO será iniciado até a resolução dos itens acima.\n');
      process.exit(1);
    }

    const envContent = fs.readFileSync(envFilePath || DEFAULT_ENV_FILE, 'utf8');
    const env = parseEnvContent(envContent);

    const shouldVerifyConn = !process.argv.includes('--skip-verify-conn') && !process.env.VITEST;
    if (shouldVerifyConn) {
      console.log('⏳ Verificando autenticação real com PostgreSQL (medicina_app e medicina_auth)...');
      const connCheck = await verifyPreflightConnections(env, preflight.caPath);
      if (!connCheck.app || !connCheck.auth) {
        console.error('\n❌ PREFLIGHT REPROVADO: FALHA DE CONEXÃO COM POSTGRESQL');
        for (const err of connCheck.errors) {
          console.error(`   • ${err}`);
        }
        console.error('\n💡 Ação recomendada: Execute `npm run config:staging:web` para reconfigurar as senhas das roles no `.env.local`.\n');
        process.exit(1);
      }
      console.log('   ✅ Conexões medicina_app e medicina_auth autenticadas com sucesso no PostgreSQL!\n');
    }

    console.log('\n✅ PREFLIGHT APROVADO COM SUCESSO:');
    console.log(`• Projeto Supabase: ${TARGET_PROJECT_REF}`);
    console.log(`• Session Pooler:   ${TARGET_HOST}:${TARGET_PORT}`);
    console.log(`• Role App:         medicina_app.${TARGET_PROJECT_REF}`);
    console.log(`• Role Auth:        medicina_auth.${TARGET_PROJECT_REF}`);
    console.log(`• Certificado CA:   ${preflight.caPath} (SHA-256 verificado)`);
    console.log(`• NextAuth:         Protegido com segredo de alta entropia`);
    console.log(`• Fallback Dev:     Zero referências a localhost/medicina_dev`);
    console.log('================================================================\n');

    if (isCheckOnly) {
      console.log('ℹ️  Modo --check-only ativo. Encerramento com sucesso sem iniciar o servidor.');
      process.exit(0);
    }

    console.log(`🚀 Iniciando Next.js dev server exclusivamente em http://${targetHost}:${targetPort} com TLS estrito...\n`);

    const childEnv = {
      ...process.env,
      NODE_EXTRA_CA_CERTS: preflight.caPath,
      HOSTNAME: targetHost,
      PORT: targetPort,
    };

    const devArgs = buildNextDevArgs(targetHost, targetPort);
    const child = spawn('npx', devArgs, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: childEnv,
    });

    child.on('error', (err) => {
      console.error(`\n❌ Falha ao iniciar processo Next.js: ${err.message}`);
      process.exit(1);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        console.log(`\nServidor Next.js encerrado com sinal: ${signal}`);
      } else {
        console.log(`\nServidor Next.js finalizado com código: ${code}`);
      }
      process.exit(code ?? 0);
    });
  })().catch((err) => {
    console.error('\n❌ Erro inesperado durante o preflight:');
    console.error(`   ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
