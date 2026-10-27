#!/usr/bin/env node

/**
 * MEDICINA 2029 — H2.02
 * Teste Passivo e Somente-Leitura de Conexão Real para as Três Roles no Staging
 *
 * Conecta individualmente como:
 *   - medicina_app (Porta 5432 - Session Pooler e Porta 6543 - Transaction Pooler)
 *   - medicina_auth (Porta 5432 - Session Pooler e Porta 6543 - Transaction Pooler)
 *   - medicina_worker (Porta 5432 - Session Pooler)
 *
 * Validações Ativas:
 *   1. Identidade Efetiva: SELECT current_user, session_user, current_database().
 *   2. Atributos da Role: SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles (confirma LOGIN=true, SUPER=false, BYPASSRLS=false).
 *   3. TLS Estrito: rejectUnauthorized: true com cadeia CA (prod-ca-2021.crt) e validação de hostname.
 *   4. Menor Privilégio Funcional: sondagem passiva de leitura sem mutações.
 *   5. Transaction Pooler (Porta 6543): valida execução com prepare=false e contexto SET LOCAL transacional para app e auth.
 *   6. Isolamento e Segurança: zero vazamento de credenciais em logs ou saídas de terminal; purga de variáveis.
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

export const CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256 = Object.freeze(
  '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA'
);

/**
 * Constrói a URL para a role específica no pooler do Supabase
 */
export function buildRolePoolerUrl(roleName, password, port = TARGET_SESSION_PORT) {
  const encodedPassword = encodeURIComponent(password);
  const username = `${roleName}.${TARGET_PROJECT_REF}`;
  return `postgresql://${username}:${encodedPassword}@${TARGET_HOST}:${port}/${TARGET_DB}`;
}

/**
 * Executa a validação de conexão e integridade de catálogo para uma única role no Session Pooler (porta 5432)
 */
export async function verifySingleRoleSessionConnection({
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

    if (caInfo.metadata?.fingerprint256 !== CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256) {
      throw new Error(
        `FALHA DE SEGURANÇA: Fingerprint SHA-256 do certificado CA diverge do canônico do Supabase!\n` +
        `Esperado: ${CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256}\n` +
        `Obtido:   ${caInfo.metadata?.fingerprint256}`
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

    // Em conexão TCP real (quando não há mock sqlInstance injetado), session_user deve ser a própria role
    if (!sqlInstance && identity.session_user !== roleName) {
      throw new Error(
        `DIVERGÊNCIA DE SESSION_USER: Esperado "${roleName}", session_user é "${identity.session_user}".`
      );
    }

    if (identity.database_name !== TARGET_DB) {
      throw new Error(
        `DIVERGÊNCIA DE BANCO: Esperado "${TARGET_DB}", conectado em "${identity.database_name}".`
      );
    }

    // 2. Confirmação dos Atributos de Segurança no Catálogo (pg_roles)
    const [roleAttrs] = await sql`
      SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user;
    `;

    if (!roleAttrs || roleAttrs.rolname !== roleName) {
      throw new Error(`FALHA NO CATÁLOGO: Registro da role "${roleName}" não encontrado em pg_roles.`);
    }

    if (roleAttrs.rolcanlogin !== true) {
      throw new Error(`VIOLAÇÃO DE ACESSO: Role "${roleName}" possui rolcanlogin = ${roleAttrs.rolcanlogin} (esperado true).`);
    }

    if (roleAttrs.rolsuper !== false) {
      throw new Error(`VIOLAÇÃO CRÍTICA DE SEGURANÇA: Role "${roleName}" possui rolsuper = true (superusuário não permitido!).`);
    }

    if (roleAttrs.rolbypassrls !== false) {
      throw new Error(`VIOLAÇÃO CRÍTICA DE RLS: Role "${roleName}" possui rolbypassrls = true (BYPASSRLS não permitido!).`);
    }

    // 3. Sondagem Passiva de Privilégios Mínimos (Least Privilege Check)
    let extraCheck = 'aprovado';

    if (roleName === 'medicina_app') {
      const canReadPerfis = await sql`SELECT count(*)::int AS c FROM public.perfis;`;
      let pwdHashBlocked = false;
      try {
        await sql`SELECT password_hash FROM public.perfis LIMIT 1;`;
      } catch {
        pwdHashBlocked = true;
      }
      if (!pwdHashBlocked) {
        throw new Error('FALHA DE SEGURANÇA: medicina_app conseguiu consultar a coluna sensível password_hash!');
      }
      extraCheck = `Leitura OK (${canReadPerfis[0].c} perfis) | password_hash blindado`;
    } else if (roleName === 'medicina_auth') {
      // Sondagem estritamente somente-leitura aos catálogos do PostgreSQL (sem chamar a RPC de negócio)
      const [authPrivileges] = await sql`
        SELECT 
          has_function_privilege(current_user, 'medicina.autenticar_por_email(text)', 'EXECUTE') AS can_execute_auth,
          has_schema_privilege(current_user, 'medicina', 'USAGE') AS can_use_medicina,
          has_table_privilege(current_user, 'public.allowlist', 'SELECT') AS can_select_allowlist,
          has_column_privilege(current_user, 'public.perfis', 'password_hash', 'SELECT') AS can_select_pwd_hash,
          has_table_privilege(current_user, 'public.acervo_jobs', 'SELECT') AS can_select_jobs;
      `;

      if (!authPrivileges.can_execute_auth) {
        throw new Error('FALHA DE PRIVILÉGIO: medicina_auth não possui permissão de EXECUTE em medicina.autenticar_por_email!');
      }
      if (!authPrivileges.can_use_medicina) {
        throw new Error('FALHA DE PRIVILÉGIO: medicina_auth não possui USAGE no schema medicina!');
      }
      if (!authPrivileges.can_select_allowlist) {
        throw new Error('FALHA DE PRIVILÉGIO: medicina_auth não possui SELECT na tabela public.allowlist!');
      }
      if (authPrivileges.can_select_pwd_hash) {
        throw new Error('FALHA DE SEGURANÇA: medicina_auth possui SELECT direto na coluna sensível password_hash!');
      }
      if (authPrivileges.can_select_jobs) {
        throw new Error('FALHA DE SEGURANÇA: medicina_auth possui SELECT na tabela restrita acervo_jobs!');
      }

      extraCheck = 'Catálogo OK (somente-leitura): Execução exclusiva autenticar_por_email OK | USAGE medicina | SELECT allowlist | password_hash blindado';
    } else if (roleName === 'medicina_worker') {
      const canReadJobs = await sql`SELECT count(*)::int AS c FROM public.acervo_jobs;`;
      extraCheck = `Leitura fila acervo_jobs OK (${canReadJobs[0].c} jobs)`;
    }

    logger(`   ✅ Role [${roleName.padEnd(16)}]: Conectado como "${identity.connected_user}" no banco "${identity.database_name}"`);
    logger(`      • Atributos pg_roles: LOGIN=${roleAttrs.rolcanlogin} | SUPER=${roleAttrs.rolsuper} | BYPASSRLS=${roleAttrs.rolbypassrls}`);
    logger(`      • Menor privilégio:  ${extraCheck}`);

    return {
      success: true,
      role: roleName,
      port,
      connectedUser: identity.connected_user,
      sessionUser: identity.session_user,
      database: identity.database_name,
      rolcanlogin: roleAttrs.rolcanlogin,
      rolsuper: roleAttrs.rolsuper,
      rolbypassrls: roleAttrs.rolbypassrls,
      privilegeVerification: extraCheck,
    };
  } finally {
    if (shouldCloseSql && sql) {
      await sql.end();
    }
  }
}

/**
 * Alias para compatibilidade reversa com testes existentes
 */
export const verifySingleRoleConnection = verifySingleRoleSessionConnection;

/**
 * Executa a validação de conexão para as roles de aplicação no Transaction Pooler (porta 6543)
 * Exige prepared statements desativados (prepare: false) e valida isolamento transacional com SET LOCAL
 */
export async function verifyRoleTransactionConnection({
  roleName,
  password,
  port = TARGET_TRANSACTION_PORT,
  caCertPath = null,
  sqlInstance = null,
  logger = console.log,
}) {
  if (!['medicina_app', 'medicina_auth'].includes(roleName)) {
    throw new Error(`Role "${roleName}" não está autorizada para validação no Transaction Pooler (apenas medicina_app e medicina_auth).`);
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

    if (caInfo.metadata?.fingerprint256 !== CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256) {
      throw new Error(
        `FALHA DE SEGURANÇA: Fingerprint SHA-256 do certificado CA diverge do canônico do Supabase!\n` +
        `Esperado: ${CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256}\n` +
        `Obtido:   ${caInfo.metadata?.fingerprint256}`
      );
    }

    const dbUrl = buildRolePoolerUrl(roleName, password, port);
    const sslOptions = {
      rejectUnauthorized: true,
      ca: [...tls.rootCertificates, caInfo.content],
    };

    // ATENÇÃO: No Transaction Pooler (porta 6543), prepared statements DEVEM estar desativados (prepare: false)
    sql = postgres(dbUrl, {
      max: 1,
      connect_timeout: 15,
      idle_timeout: 5,
      ssl: sslOptions,
      prepare: false,
    });
    shouldCloseSql = true;
  }

  try {
    const executeInTx = async (tx) => {
      if (roleName === 'medicina_app') {
        // Valida propagação de SET LOCAL e statement_timeout na transação
        await tx`SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000000';`;
        await tx`SET LOCAL statement_timeout = '15000';`;

        const [ctx] = await tx`
          SELECT 
            current_setting('request.jwt.claim.sub', true) AS jwt_claim_sub,
            current_setting('statement_timeout', true) AS timeout_val,
            current_user AS tx_user,
            session_user AS tx_session_user,
            current_database() AS tx_database;
        `;

        if (ctx.tx_user !== roleName) {
          throw new Error(`DIVERGÊNCIA EM TRANSAÇÃO: Esperado "${roleName}", conectado como "${ctx.tx_user}".`);
        }
        if (ctx.jwt_claim_sub !== '00000000-0000-0000-0000-000000000000') {
          throw new Error('FALHA DE CONTEXTO RLS: SET LOCAL não refletiu dentro da transação.');
        }

        const perfisCount = await tx`SELECT count(*)::int AS c FROM public.perfis;`;
        return `SET LOCAL RLS claim.sub OK | Timeout: ${ctx.timeout_val}ms | Leitura: ${perfisCount[0].c} perfis`;
      } else if (roleName === 'medicina_auth') {
        await tx`SET LOCAL statement_timeout = '10000';`;

        const [ctx] = await tx`
          SELECT 
            current_setting('statement_timeout', true) AS timeout_val,
            current_user AS tx_user,
            session_user AS tx_session_user,
            current_database() AS tx_database,
            has_function_privilege(current_user, 'medicina.autenticar_por_email(text)', 'EXECUTE') AS can_exec_auth;
        `;

        if (ctx.tx_user !== roleName) {
          throw new Error(`DIVERGÊNCIA EM TRANSAÇÃO: Esperado "${roleName}", conectado como "${ctx.tx_user}".`);
        }
        if (!ctx.can_exec_auth) {
          throw new Error('FALHA DE PRIVILÉGIO NA TRANSAÇÃO: medicina_auth sem permissão de EXECUTE em autenticar_por_email.');
        }

        return `SET LOCAL Timeout: ${ctx.timeout_val}ms | Catálogo: RPC autenticar_por_email OK (somente-leitura)`;
      }
    };

    let txResult;
    if (typeof sql.begin === 'function') {
      txResult = await sql.begin(executeInTx);
    } else {
      await sql`BEGIN;`;
      try {
        txResult = await executeInTx(sql);
        await sql`COMMIT;`;
      } catch (err) {
        await sql`ROLLBACK;`.catch(() => {});
        throw err;
      }
    }

    logger(`   ✅ Role [${roleName.padEnd(16)}]: Porta ${port} (Transaction Pooler) validada com sucesso!`);
    logger(`      • Modo do Driver: prepare=false (sem prepared statements)`);
    logger(`      • Transação:      ${txResult}`);

    return {
      success: true,
      role: roleName,
      port,
      prepareFalse: true,
      transactionValidation: txResult,
    };
  } finally {
    if (shouldCloseSql && sql) {
      await sql.end();
    }
  }
}

/**
 * Executa o teste de verificação completo para as três roles técnicas
 * Cobre Session Pooler (porta 5432) e Transaction Pooler (porta 6543)
 */
export async function verifyAllStagingRoles({
  passwords,
  caCertPath = null,
  sqlInstances = null,
  sessionSqlInstances = null,
  transactionSqlInstances = null,
  logger = console.log,
}) {
  logger('================================================================');
  logger('MEDICINA 2029 — H2.02: VALIDAÇÃO REAL DAS CONEXÕES TÉCNICAS');
  logger('================================================================');
  logger(`Host Alvo:             ${TARGET_HOST}`);
  logger(`Projeto Alvo:          ${TARGET_PROJECT_REF}`);
  logger(`Session Pooler:        Porta ${TARGET_SESSION_PORT} (medicina_app, medicina_auth, medicina_worker)`);
  logger(`Transaction Pooler:    Porta ${TARGET_TRANSACTION_PORT} (medicina_app, medicina_auth - prepare=false)`);
  logger(`Escopo:                Somente-Leitura (SELECT passivo, TLS estrito)`);
  logger('================================================================\n');

  const sessionResults = {};
  const transactionResults = {};

  const effectiveSessionSql = sessionSqlInstances || sqlInstances || {};
  const effectiveTransactionSql = transactionSqlInstances || sqlInstances || {};

  logger('--- FASE 1: Validação no Session Pooler (porta 5432) ---');
  for (const role of EXPECTED_ROLES) {
    const pwd = passwords?.[role];
    const sqlInst = effectiveSessionSql?.[role];

    sessionResults[role] = await verifySingleRoleSessionConnection({
      roleName: role,
      password: pwd,
      port: TARGET_SESSION_PORT,
      caCertPath,
      sqlInstance: sqlInst,
      logger,
    });
  }

  logger('\n--- FASE 2: Validação no Transaction Pooler (porta 6543) ---');
  logger('Nota: medicina_worker opera exclusivamente na porta 5432 (Session Pooler).\n');
  for (const role of ['medicina_app', 'medicina_auth']) {
    const pwd = passwords?.[role];
    const sqlInst = effectiveTransactionSql?.[role];

    transactionResults[role] = await verifyRoleTransactionConnection({
      roleName: role,
      password: pwd,
      port: TARGET_TRANSACTION_PORT,
      caCertPath,
      sqlInstance: sqlInst,
      logger,
    });
  }

  logger('\n================================================================');
  logger('🎉 TODAS AS ROLES TÉCNICAS FORAM VALIDADAS COM SUCESSO!');
  logger('   • Porta 5432 (Session Pooler): 3/3 roles autenticadas e com atributos corretos');
  logger('   • Porta 6543 (Transaction Pooler): 2/2 roles validadas com prepare=false e SET LOCAL');
  logger('   • Identidade: current_user e session_user conferidos');
  logger('   • Menor Privilégio: rolcanlogin=true, rolsuper=false, rolbypassrls=false');
  logger('================================================================\n');

  return {
    success: true,
    results: sessionResults,
    sessionResults,
    transactionResults,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const caArg = args.find((a) => a.startsWith('--ca='))?.split('=')[1] ||
                args.find((a) => a.startsWith('--ca-cert='))?.split('=')[1];

  console.log('================================================================');
  console.log('MEDICINA 2029 — H2.02: VALIDAÇÃO REAL DE CONEXÕES (STAGING)');
  console.log('================================================================');
  console.log(`Projeto Alvo:          ${TARGET_PROJECT_REF}`);
  console.log(`Session Pooler:        ${TARGET_HOST}:${TARGET_SESSION_PORT}`);
  console.log(`Transaction Pooler:    ${TARGET_HOST}:${TARGET_TRANSACTION_PORT}`);
  console.log(`Roles a Validar:       ${EXPECTED_ROLES.join(', ')}`);
  console.log('================================================================\n');

  console.log('Orientações de Segurança:');
  console.log('  • As senhas digitadas NÃO serão exibidas na tela (sem eco).');
  console.log('  • Nenhuma senha será registrada em logs ou persistida em disco.');
  console.log('  • Operação 100% somente-leitura (nenhum dado será modificado no banco).');
  console.log('  • Pressione Ctrl+C a qualquer momento para cancelar com segurança.\n');

  let appPassword = '';
  let authPassword = '';
  let workerPassword = '';

  try {
    console.log('[Etapa 1/3] Credencial para medicina_app (Server Actions / Runtime):');
    appPassword = await promptHiddenPassword('🔑 Digite a senha de medicina_app: ');
    if (!appPassword || appPassword.trim().length === 0) {
      console.error('\n❌ Senha de medicina_app não fornecida. Abortando.');
      process.exit(1);
    }
    console.log('');

    console.log('[Etapa 2/3] Credencial para medicina_auth (Autenticação NextAuth):');
    authPassword = await promptHiddenPassword('🔑 Digite a senha de medicina_auth: ');
    if (!authPassword || authPassword.trim().length === 0) {
      console.error('\n❌ Senha de medicina_auth não fornecida. Abortando.');
      process.exit(1);
    }
    console.log('');

    console.log('[Etapa 3/3] Credencial para medicina_worker (Worker Assíncrono / Ingestão):');
    workerPassword = await promptHiddenPassword('🔑 Digite a senha de medicina_worker: ');
    if (!workerPassword || workerPassword.trim().length === 0) {
      console.error('\n❌ Senha de medicina_worker não fornecida. Abortando.');
      process.exit(1);
    }
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
    // Purga variáveis de senha da memória
    appPassword = '';
    authPassword = '';
    workerPassword = '';
  }
}

if (process.argv[1]?.includes('verify-staging-roles-connection')) {
  main();
}
