#!/usr/bin/env node

/**
 * MEDICINA 2029 — H2.01-R2
 * Utilitário Interativo e Seguro para Configuração de Senhas das Roles no Staging
 *
 * Configura as senhas de login das roles técnicas no PostgreSQL do Supabase Staging:
 *   - medicina_app (Server Actions e runtime da aplicação)
 *   - medicina_auth (Autenticação restrita NextAuth)
 *   - medicina_worker (Pipeline de ingestão e worker assíncrono)
 *
 * Salvaguardas de Segurança e Correção DDL:
 *   - DDL Parametrizado e Seguro: PostgreSQL não aceita placeholders $1 convencionais em
 *     ALTER ROLE ... PASSWORD. A configuração é executada via função temporária de sessão
 *     (pg_temp.configure_role_credential) usando format() com %I (identificador seguro)
 *     e %L (literal seguro via quote_literal), transmitindo as senhas como parâmetros de bind,
 *     eliminando qualquer risco de SQL injection ou quebra com caracteres especiais.
 *   - Allowlist Rígida de Roles: Bloqueio sumário contra qualquer role fora de ALLOWED_STAGING_ROLES.
 *   - Confirmação Humana Obrigatória: Exige digitação de "CONFIRMAR CONFIGURACAO ROLES".
 *   - Conexão TLS Estrita: rejectUnauthorized: true com cadeia CA (prod-ca-2021.crt) e validação de hostname.
 *   - Entrada Oculta: Senhas digitadas sem eco, sem histórico de shell, sem argv de processo.
 *   - Validação de Complexidade: Mínimo de 16 caracteres não vazios.
 *   - Purga de Memória: Limpeza forçada de todas as strings de senha no bloco finally.
 */

import tls from 'node:tls';
import readline from 'node:readline';
import postgres from 'postgres';

import {
  resolveCaCertificate,
  promptHiddenPassword,
  buildStagingPoolerUrl,
  sanitizeError,
} from './test-staging-connection.mjs';

export const TARGET_HOST = 'aws-0-us-east-1.pooler.supabase.com';
export const TARGET_PORT = 5432;
export const TARGET_DB = 'postgres';
export const TARGET_ROLE = 'postgres';
export const TARGET_PROJECT_REF = 'ynfocaorhadizlvbnzrt';
export const TARGET_USERNAME = `${TARGET_ROLE}.${TARGET_PROJECT_REF}`;

export const ALLOWED_STAGING_ROLES = Object.freeze([
  'medicina_app',
  'medicina_auth',
  'medicina_worker',
]);

export const CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256 = Object.freeze(
  '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA'
);

export const ROLE_DESCRIPTIONS = Object.freeze({
  medicina_app: 'Server Actions, runtime principal e queries sob contexto RLS',
  medicina_auth: 'Autenticação restrita NextAuth e conferência de allowlist',
  medicina_worker: 'Worker assíncrono e pipeline de ingestão de documentos do acervo',
});

/**
 * Solicita confirmação humana explícita no terminal
 */
export function promptConfirmation(promptText = 'Digite "CONFIRMAR CONFIGURACAO ROLES" para prosseguir: ') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.on('SIGINT', () => {
      rl.close();
      process.stdout.write('\n\nOperação cancelada pelo usuário (Ctrl+C).\n');
      process.exit(130);
    });

    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Solicita senha oculta com confirmação defensiva
 */
export async function promptPasswordWithConfirmation(roleName) {
  while (true) {
    const pwd1 = await promptHiddenPassword(`🔑 Digite a nova senha para [${roleName}]: `);
    if (!pwd1 || pwd1.length < 16) {
      console.log('⚠️  A senha deve conter no mínimo 16 caracteres. Tente novamente.\n');
      continue;
    }

    const pwd2 = await promptHiddenPassword(`🔑 Confirme a nova senha para [${roleName}]: `);
    if (pwd1 !== pwd2) {
      console.log('❌ As senhas não conferem. Tente novamente.\n');
      continue;
    }

    console.log(`   ✓ Senha para [${roleName}] validada localmente.`);
    return pwd1;
  }
}

/**
 * Executa a configuração das senhas das roles com salvaguardas fail-closed
 */
export async function configureStagingRolePasswords({
  confirmation,
  adminPassword,
  appPassword,
  authPassword,
  workerPassword,
  rolePasswords = null,
  caCertPath,
  sqlInstance = null,
  logger = console.log,
}) {
  // 1. Validação de Confirmação Humana
  if (confirmation !== 'CONFIRMAR CONFIGURACAO ROLES') {
    throw new Error(
      `OPERAÇÃO CANCELADA: Confirmação humana explícita não fornecida (esperado "CONFIRMAR CONFIGURACAO ROLES", recebido "${confirmation}").`
    );
  }

  // 2. Mapeamento de senhas a aplicar
  const targetMap = rolePasswords
    ? { ...rolePasswords }
    : {
        medicina_app: appPassword,
        medicina_auth: authPassword,
        medicina_worker: workerPassword,
      };

  // 3. Validação estrita de Allowlist contra injeção de roles
  for (const role of Object.keys(targetMap)) {
    if (!ALLOWED_STAGING_ROLES.includes(role)) {
      throw new Error(`SEGURANÇA BLOQUEADA: A role "${role}" não consta na allowlist de roles autorizadas.`);
    }
    const pwd = targetMap[role];
    if (pwd && pwd.length < 16) {
      throw new Error(`SEGURANÇA BLOQUEADA: A senha para "${role}" não atende ao requisito mínimo de 16 caracteres.`);
    }
  }

  let sql = sqlInstance;
  let shouldCloseSql = false;

  let caInfo = null;
  if (!sql) {
    if (!adminPassword) {
      throw new Error('Senha administrativa não fornecida.');
    }

    caInfo = resolveCaCertificate(caCertPath);
    if (!caInfo) {
      throw new Error(
        'CERTIFICADO TLS AUSENTE: O certificado CA do Supabase (prod-ca-2021.crt) não foi localizado.'
      );
    }

    // Validação estrita do fingerprint criptográfico do certificado CA
    if (caInfo.metadata?.fingerprint256 !== CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256) {
      throw new Error(
        `FALHA DE SEGURANÇA: Fingerprint SHA-256 do certificado CA diverge do certificado canônico do Supabase!\n` +
        `Esperado: ${CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256}\n` +
        `Obtido:   ${caInfo.metadata?.fingerprint256}`
      );
    }

    const dbUrl = buildStagingPoolerUrl(adminPassword);
    const sslOptions = {
      rejectUnauthorized: true,
      ca: [...tls.rootCertificates, caInfo.content],
    };

    sql = postgres(dbUrl, {
      max: 1,
      connect_timeout: 20,
      idle_timeout: 10,
      ssl: sslOptions,
    });
    shouldCloseSql = true;
  }

  // Utiliza conexão física reservada (sql.reserve) para garantir que pg_temp e transações
  // permaneçam vinculadas ao mesmo processo de backend no PostgreSQL
  const connectionHandle = typeof sql.reserve === 'function' ? await sql.reserve() : sql;

  try {
    logger('🔒 Conexão administrativa estabelecida com o Supabase Staging.');
    logger('🔄 Instalando rotina de sessão segura para DDL parametrizado (pg_temp com search_path imutável)...');

    // Criação da função temporária de sessão com search_path seguro e imutável
    await connectionHandle`
      CREATE OR REPLACE FUNCTION pg_temp.configure_role_credential(p_role text, p_password text)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $func$
      BEGIN
        IF p_role NOT IN ('medicina_app', 'medicina_auth', 'medicina_worker') THEN
          RAISE EXCEPTION 'Role % não autorizada para configuração de credenciais', p_role;
        END IF;
        IF p_password IS NULL OR length(p_password) < 16 THEN
          RAISE EXCEPTION 'Senha para % não atende ao requisito mínimo de 16 caracteres', p_role;
        END IF;
        EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', p_role, p_password);
      END;
      $func$;
    `;

    // Aplicação das senhas via transação protegida com rollback em caso de falha intermediária
    await connectionHandle`BEGIN;`;
    try {
      for (const [roleName, password] of Object.entries(targetMap)) {
        if (password) {
          await connectionHandle`SELECT pg_temp.configure_role_credential(${roleName}, ${password});`;
          logger(`   ✅ Senha configurada com sucesso para a role [${roleName}]`);
        }
      }
      await connectionHandle`COMMIT;`;
    } catch (txError) {
      await connectionHandle`ROLLBACK;`.catch(() => {});
      throw txError;
    }

    // Remoção imediata da função temporária
    await connectionHandle`DROP FUNCTION IF EXISTS pg_temp.configure_role_credential(text, text);`.catch(() => {});

    // Conferência do status das roles
    const rolesStatus = await connectionHandle`
      SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname IN ('medicina_app', 'medicina_auth', 'medicina_worker')
      ORDER BY rolname;
    `;

    logger('\n📋 Status de Login das Roles Técnicas:');
    for (const r of rolesStatus) {
      logger(`   • ${r.rolname.padEnd(16)}: LOGIN=${r.rolcanlogin} | SUPER=${r.rolsuper} | BYPASSRLS=${r.rolbypassrls}`);
    }

    return {
      success: true,
      rolesConfigured: rolesStatus.map((r) => r.rolname),
    };
  } finally {
    if (connectionHandle && typeof connectionHandle.release === 'function') {
      await connectionHandle`DROP FUNCTION IF EXISTS pg_temp.configure_role_credential(text, text);`.catch(() => {});
      connectionHandle.release();
    }
    if (shouldCloseSql && sql) {
      await sql.end();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const caArg = args.find((a) => a.startsWith('--ca='))?.split('=')[1] ||
                args.find((a) => a.startsWith('--ca-cert='))?.split('=')[1];

  console.log('================================================================');
  console.log('MEDICINA 2029 — CONFIGURAÇÃO SEGURA DE CREDENCIAIS (STAGING)');
  console.log('================================================================');
  console.log(`Projeto Alvo:        ${TARGET_PROJECT_REF}`);
  console.log(`Session Pooler:      ${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`Administrador:       ${TARGET_USERNAME}`);
  console.log(`Roles a Configurar:  ${ALLOWED_STAGING_ROLES.join(', ')}`);
  console.log('================================================================\n');

  console.log('Orientações de Segurança:');
  console.log('  • As senhas digitadas NÃO serão exibidas na tela (sem eco).');
  console.log('  • Cada senha técnica deve possuir no mínimo 16 caracteres.');
  console.log('  • Pressione Ctrl+C a qualquer momento para cancelar com segurança.\n');

  let adminPassword = '';
  let appPassword = '';
  let authPassword = '';
  let workerPassword = '';

  try {
    console.log('[Etapa 1/4] Senha Administrativa do Staging');
    console.log(`Autenticação primária como "${TARGET_USERNAME}" no Session Pooler.`);
    adminPassword = await promptHiddenPassword('🔑 Digite a senha da role postgres do Supabase: ');
    if (!adminPassword || adminPassword.trim().length === 0) {
      console.error('\n❌ Senha administrativa não fornecida (vazia). Abortando.');
      process.exit(1);
    }
    console.log('');

    console.log('[Etapa 2/4] Nova Senha para medicina_app');
    console.log(`Finalidade: ${ROLE_DESCRIPTIONS.medicina_app}`);
    console.log('Requisito:  Mínimo de 16 caracteres de alta entropia');
    appPassword = await promptPasswordWithConfirmation('medicina_app');
    console.log('');

    console.log('[Etapa 3/4] Nova Senha para medicina_auth');
    console.log(`Finalidade: ${ROLE_DESCRIPTIONS.medicina_auth}`);
    console.log('Requisito:  Mínimo de 16 caracteres de alta entropia');
    authPassword = await promptPasswordWithConfirmation('medicina_auth');
    console.log('');

    console.log('[Etapa 4/4] Nova Senha para medicina_worker');
    console.log(`Finalidade: ${ROLE_DESCRIPTIONS.medicina_worker}`);
    console.log('Requisito:  Mínimo de 16 caracteres de alta entropia');
    workerPassword = await promptPasswordWithConfirmation('medicina_worker');
    console.log('');

    console.log('================================================================');
    console.log('⚠️  CONFIRMAÇÃO DE APLICAÇÃO NO BANCO DE DADOS');
    console.log('As senhas acima serão gravadas no Supabase Staging via transação');
    console.log('protegida com TLS estrito e verificação de integridade.');
    console.log('Para confirmar a aplicação imediata, digite exatamente:');
    console.log('   CONFIRMAR CONFIGURACAO ROLES');
    console.log('================================================================');
    const confirmation = await promptConfirmation('Confirmação: ');

    await configureStagingRolePasswords({
      confirmation,
      adminPassword,
      appPassword,
      authPassword,
      workerPassword,
      caCertPath: caArg,
    });

    console.log('\n================================================================');
    console.log('🎉 CREDENCIAIS CONFIGURADAS COM SUCESSO NO STAGING!');
    console.log('================================================================');
    console.log('Formatos de conexão para as variáveis de ambiente (.env.local / CI):');
    console.log('DATABASE_APP_URL    = postgresql://medicina_app.ynfocaorhadizlvbnzrt:<SUA_SENHA>@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require');
    console.log('DATABASE_AUTH_URL   = postgresql://medicina_auth.ynfocaorhadizlvbnzrt:<SUA_SENHA>@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require');
    console.log('DATABASE_WORKER_URL = postgresql://medicina_worker.ynfocaorhadizlvbnzrt:<SUA_SENHA>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require');
    console.log('================================================================\n');
  } catch (err) {
    console.error('\n❌ ERRO NA CONFIGURAÇÃO DE CREDENCIAIS:');
    console.error(sanitizeError(err));
    process.exit(1);
  } finally {
    // Purga variáveis de senha da memória
    adminPassword = '';
    appPassword = '';
    authPassword = '';
    workerPassword = '';
  }
}

if (process.argv[1]?.includes('configure-staging-roles')) {
  main();
}
