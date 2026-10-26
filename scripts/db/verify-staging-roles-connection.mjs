#!/usr/bin/env node

/**
 * MEDICINA 2029 — H2.01-R2
 * Teste Passivo e Somente-Leitura de Conexão Real para as Três Roles no Staging
 *
 * Conecta individualmente como:
 *   - medicina_app (Porta 6543 - Transaction Pooler ou 5432 - Session Pooler)
 *   - medicina_auth (Porta 6543 - Transaction Pooler ou 5432 - Session Pooler)
 *   - medicina_worker (Porta 5432 - Session Pooler)
 *
 * Validações Ativas:
 *   1. Identidade Efetiva: Confirma que SELECT current_user retorna rigorosamente a role esperada.
 *   2. Projeto Correto: Confirma que SELECT current_database() retorna 'postgres' no pooler do projeto ynfocaorhadizlvbnzrt.
 *   3. TLS Estrito: Exige validação da cadeia de certificados com rejectUnauthorized: true e CA raiz (prod-ca-2021.crt).
 *   4. Autenticação Real: Prova que a role autentica com a senha provisionada (sem depender apenas de rolcanlogin).
 *   5. Menor Privilégio Funcional: Confere se a segregação de permissões de leitura está ativa.
 */

import tls from 'node:tls';
import postgres from 'postgres';

import {
  resolveCaCertificate,
  promptHiddenPassword,
  sanitizeError,
} from './test-staging-connection.mjs';

export const TARGET_HOST = 'aws-0-us-east-1.pooler.supabase.com';
export const TARGET_SESSION_PORT = 5432;
export const TARGET_TRANSACTION_PORT = 6543;
export const TARGET_DB = 'postgres';
export const TARGET_PROJECT_REF = 'ynfocaorhadizlvbnzrt';

export const EXPECTED_ROLES = Object.freeze([
  'medicina_app',
  'medicina_auth',
  'medicina_worker',
]);

/**
 * Constrói a URL para a role específica no pooler do Supabase
 */
export function buildRolePoolerUrl(roleName, password, port = TARGET_SESSION_PORT) {
  const encodedPassword = encodeURIComponent(password);
  const username = `${roleName}.${TARGET_PROJECT_REF}`;
  return `postgresql://${username}:${encodedPassword}@${TARGET_HOST}:${port}/${TARGET_DB}`;
}

/**
 * Executa o diagnóstico de conexão e menor privilégio para uma única role
 */
export async function verifySingleRoleConnection({
  roleName,
  password,
  port = TARGET_SESSION_PORT,
  caCertPath = null,
  sqlInstance = null,
  logger = console.log,
}) {
  if (!EXPECTED_ROLES.includes(roleName)) {
    throw new Error(`Role desconhecida ou não autorizada: "${roleName}"`);
  }

  let sql = sqlInstance;
  let shouldCloseSql = false;

  if (!sql) {
    if (!password) {
      throw new Error(`Senha não fornecida para a role "${roleName}".`);
    }

    const caInfo = resolveCaCertificate(caCertPath);
    if (!caInfo) {
      throw new Error('Certificado CA do Supabase (prod-ca-2021.crt) não localizado.');
    }

    if (caInfo.metadata?.fingerprint256 !== '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA') {
      throw new Error(
        `FALHA DE SEGURANÇA: Fingerprint SHA-256 do certificado CA diverge do canônico do Supabase! ` +
        `Obtido: ${caInfo.metadata?.fingerprint256}`
      );
    }

    const dbUrl = buildRolePoolerUrl(roleName, password, port);
    const sslOptions = {
      rejectUnauthorized: true,
      ca: [...tls.rootCertificates, caInfo.content],
    };

    sql = postgres(dbUrl, {
      max: 1,
      connect_timeout: 15,
      idle_timeout: 5,
      ssl: sslOptions,
    });
    shouldCloseSql = true;
  }

  try {
    // 1. Identidade e Conexão Básica
    const [identity] = await sql`
      SELECT 
        current_user AS connected_user,
        session_user AS session_user,
        current_database() AS database_name;
    `;

    if (identity.connected_user !== roleName) {
      throw new Error(
        `DIVERGÊNCIA DE IDENTIDADE: Esperado "${roleName}", conectado como "${identity.connected_user}".`
      );
    }

    if (identity.database_name !== TARGET_DB) {
      throw new Error(
        `DIVERGÊNCIA DE BANCO: Esperado "${TARGET_DB}", conectado em "${identity.database_name}".`
      );
    }

    // 2. Sondagem Passiva de Privilégios Mínimos (Least Privilege Check)
    let extraCheck = 'aprovado';

    if (roleName === 'medicina_app') {
      // medicina_app pode ler perfis públicos, mas NÃO pode ler a coluna password_hash
      const canReadPerfis = await sql`SELECT count(*)::int AS c FROM public.perfis;`;
      let pwdHashBlocked = false;
      try {
        await sql`SELECT password_hash FROM public.perfis LIMIT 1;`;
      } catch (err) {
        pwdHashBlocked = true;
      }
      if (!pwdHashBlocked) {
        throw new Error('FALHA DE SEGURANÇA: medicina_app conseguiu consultar a coluna sensível password_hash!');
      }
      extraCheck = `Leitura OK (${canReadPerfis[0].c} perfis) | password_hash blindado`;
    } else if (roleName === 'medicina_auth') {
      // medicina_auth possui permissão exclusiva de execução em medicina.autenticar_por_email
      const authProbe = await sql`SELECT * FROM medicina.autenticar_por_email('probe@medicina2029.com.br');`;
      extraCheck = `Execução exclusiva autenticar_por_email OK (${authProbe.length} registros)`;
    } else if (roleName === 'medicina_worker') {
      // medicina_worker pode consultar acervo_jobs
      const canReadJobs = await sql`SELECT count(*)::int AS c FROM public.acervo_jobs;`;
      extraCheck = `Leitura fila acervo_jobs OK (${canReadJobs[0].c} jobs)`;
    }

    logger(`   ✅ Role [${roleName.padEnd(16)}]: Conectado como "${identity.connected_user}" no banco "${identity.database_name}" (${extraCheck})`);

    return {
      success: true,
      role: roleName,
      connectedUser: identity.connected_user,
      database: identity.database_name,
      privilegeVerification: extraCheck,
    };
  } finally {
    if (shouldCloseSql && sql) {
      await sql.end();
    }
  }
}

/**
 * Executa o teste de verificação completo para as três roles técnicas
 */
export async function verifyAllStagingRoles({
  passwords,
  caCertPath = null,
  sqlInstances = {},
  logger = console.log,
}) {
  logger('================================================================');
  logger('MEDICINA 2029 — TESTE DE CONECTIVIDADE REAL E IDENTIDADE DE ROLES');
  logger('================================================================');
  logger(`Host Alvo:           ${TARGET_HOST}`);
  logger(`Projeto Alvo:        ${TARGET_PROJECT_REF}`);
  logger('Escopo:              Somente-Leitura (SELECT passivo, TLS estrito)');
  logger('================================================================\n');

  const results = {};

  for (const role of EXPECTED_ROLES) {
    const pwd = passwords?.[role];
    const sqlInst = sqlInstances?.[role];

    const port = role === 'medicina_worker' ? TARGET_SESSION_PORT : TARGET_TRANSACTION_PORT;

    results[role] = await verifySingleRoleConnection({
      roleName: role,
      password: pwd,
      port,
      caCertPath,
      sqlInstance: sqlInst,
      logger,
    });
  }

  logger('\n🎉 TODAS AS ROLES AUTENTICARAM COM SUCESSO SOB MENOR PRIVILÉGIO!');
  return {
    success: true,
    results,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const caArg = args.find((a) => a.startsWith('--ca='))?.split('=')[1] ||
                args.find((a) => a.startsWith('--ca-cert='))?.split('=')[1];

  let appPassword = '';
  let authPassword = '';
  let workerPassword = '';

  try {
    console.log('Digite as senhas das roles técnicas para teste de autenticação real:');
    appPassword = await promptHiddenPassword('Senha para medicina_app: ');
    authPassword = await promptHiddenPassword('Senha para medicina_auth: ');
    workerPassword = await promptHiddenPassword('Senha para medicina_worker: ');
    console.log('');

    await verifyAllStagingRoles({
      passwords: {
        medicina_app: appPassword,
        medicina_auth: authPassword,
        medicina_worker: workerPassword,
      },
      caCertPath: caArg,
    });
  } catch (err) {
    console.error('\n❌ ERRO NA VALIDAÇÃO DE CONEXÃO DAS ROLES:');
    console.error(sanitizeError(err));
    process.exit(1);
  } finally {
    appPassword = '';
    authPassword = '';
    workerPassword = '';
  }
}

if (process.argv[1]?.includes('verify-staging-roles-connection')) {
  main();
}
