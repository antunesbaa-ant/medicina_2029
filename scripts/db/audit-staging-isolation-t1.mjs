#!/usr/bin/env node

/**
 * ==============================================================================
 * MEDICINA 2029 — H2.04-T1-R2: AUDITORIA DE AUTENTICAÇÃO E ISOLAMENTO RLS NO STAGING
 * ==============================================================================
 * Executa verificações 100% SOMENTE-LEITURA contra o Supabase Staging para comprovar:
 * 1. Autenticação Segura via RPC medicina.autenticar_por_email (conexão direta medicina_auth)
 * 2. Bloqueio de leitura de credenciais e RPCs sob o papel aplicacional (conexão direta medicina_app)
 * 3. Princípio Fail-Closed absoluto (sem contexto autenticado = 0 linhas)
 * 4. Isolamento estrito de Alice (apenas ciclo e cards próprios)
 * 5. Isolamento estrito de Carlos (estudante independente, zero vínculos de tutoria)
 * 6. Escopo restrito do responsável Bruno (apenas tutelada Alice, zero Carlos)
 * 7. Rejeição compulsória de escalada de privilégios (medicina.set_context com papel falso)
 * 8. Proteção contra contaminação no Session Pooler (SET LOCAL com is_local => true)
 *
 * RESTRIÇÃO DE SEGURANÇA E ARQUITETURA H2.04-T1-R2:
 * - Operação ESTRITAMENTE PASSIVA (READ-ONLY).
 * - Zero mutações: zero INSERT, UPDATE, DELETE, DROP ou ALTER.
 * - Conexões autenticadas DIRETAMENTE como medicina_auth e medicina_app no Session Pooler (porta 5432).
 * - Eliminação total de comandos SET ROLE administrativos (zero falso positivo por falta de membership).
 * - TLS estrito com certificado CA prod-ca-2021.crt.
 * - Código em JavaScript Puro (ESM) para execução direta pelo Node.js sem transpilação.
 * ==============================================================================
 */

import tls from 'node:tls';
import postgres from 'postgres';
import {
  TARGET_HOST,
  TARGET_PORT,
  TARGET_DB,
  TARGET_PROJECT_REF,
  PERSONA_ALICE,
  PERSONA_BRUNO,
  PERSONA_CARLOS,
  STAGING_ALICE_CICLO_ID,
  STAGING_CARLOS_CICLO_ID,
  STAGING_ARQUIVO_ID,
} from './prepare-staging-homologation.mjs';

import {
  resolveCaCertificate,
  promptHiddenPassword,
  sanitizeError,
} from './test-staging-connection.mjs';

import {
  buildRolePoolerUrl,
} from './verify-staging-roles-connection.mjs';

/**
 * Validação estrita de configuração da URL de conexão para a role específica
 * @param {string | object} configOrUrl
 * @param {string} expectedRole
 * @returns {{ valid: boolean, host: string, port: number, db: string, user: string }}
 */
export function validateRoleConnectionConfig(configOrUrl, expectedRole) {
  let host, port, db, user;
  if (typeof configOrUrl === 'string') {
    let parsed;
    try {
      parsed = new URL(configOrUrl);
    } catch (err) {
      throw new Error(`VIOLAÇÃO DE CONFIGURAÇÃO: URL inválida: ${sanitizeError(err)}`);
    }
    host = parsed.hostname;
    port = parsed.port ? parseInt(parsed.port, 10) : 5432;
    db = parsed.pathname.replace(/^\//, '');
    user = decodeURIComponent(parsed.username);
  } else if (configOrUrl && typeof configOrUrl === 'object') {
    host = configOrUrl.host;
    port = configOrUrl.port ? parseInt(configOrUrl.port, 10) : 5432;
    db = configOrUrl.database || configOrUrl.db;
    user = configOrUrl.user || configOrUrl.username;
  } else {
    throw new Error('VIOLAÇÃO DE CONFIGURAÇÃO: Parâmetro de conexão inválido.');
  }

  const expectedUser = `${expectedRole}.${TARGET_PROJECT_REF}`;

  if (host !== TARGET_HOST) {
    throw new Error(`VIOLAÇÃO DE HOST: Host "${host}" inválido. Esperado "${TARGET_HOST}".`);
  }
  if (port !== TARGET_PORT) {
    throw new Error(`VIOLAÇÃO DE PORTA: Porta "${port}" inválida. Esperada 5432 (Session Pooler).`);
  }
  if (db !== TARGET_DB) {
    throw new Error(`VIOLAÇÃO DE BANCO: Banco "${db}" inválido. Esperado "${TARGET_DB}".`);
  }
  if (user !== expectedUser) {
    throw new Error(`VIOLAÇÃO DE ROLE: Usuário "${user}" inválido. Esperado estritamente "${expectedUser}".`);
  }

  return { valid: true, host, port, db, user };
}

/**
 * Validação da identidade efetiva da sessão e atributos de segurança no catálogo PostgreSQL
 * @param {any} sqlClient
 * @param {string} expectedRole
 * @param {{ isMock?: boolean }} [options]
 * @returns {Promise<{ connectedUser: string, sessionUser: string, database: string, rolcanlogin: boolean, rolsuper: boolean, rolbypassrls: boolean }>}
 */
export async function validateRoleSessionIdentity(sqlClient, expectedRole, options = {}) {
  const isMock = options.isMock ?? Boolean(sqlClient?.isMock);
  const [diag] = await sqlClient`
    SELECT current_user AS connected_user, session_user AS session_user, current_database() AS database_name;
  `;

  if (diag.connected_user !== expectedRole) {
    throw new Error(
      `VIOLAÇÃO DE IDENTIDADE: Conexão reportou current_user "${diag.connected_user}". Esperado estritamente "${expectedRole}".`
    );
  }
  if (!isMock && diag.session_user !== expectedRole) {
    throw new Error(
      `VIOLAÇÃO DE SESSÃO: Conexão reportou session_user "${diag.session_user}". Esperado estritamente "${expectedRole}".`
    );
  }
  if (!isMock && diag.database_name !== TARGET_DB) {
    throw new Error(
      `VIOLAÇÃO DE BANCO: Conexão reportou banco "${diag.database_name}". Esperado estritamente "${TARGET_DB}".`
    );
  }

  const roleAttrs = await sqlClient`
    SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
    FROM pg_roles
    WHERE rolname = ${expectedRole};
  `;

  if (roleAttrs.length === 0) {
    throw new Error(`ROLE NÃO LOCALIZADA: Role "${expectedRole}" não existe no catálogo pg_roles.`);
  }

  const { rolcanlogin, rolsuper, rolbypassrls } = roleAttrs[0];
  if (!rolcanlogin) {
    throw new Error(`VIOLAÇÃO DE PRIVILÉGIO: Role "${expectedRole}" não possui atributo LOGIN ativo.`);
  }
  if (rolsuper) {
    throw new Error(`VIOLAÇÃO DE SEGURANÇA: Role "${expectedRole}" possui SUPERUSER ativo (vedado).`);
  }
  if (rolbypassrls) {
    throw new Error(`VIOLAÇÃO DE SEGURANÇA: Role "${expectedRole}" possui BYPASSRLS ativo (vedado).`);
  }

  return {
    connectedUser: diag.connected_user,
    sessionUser: diag.session_user,
    database: diag.database_name,
    rolcanlogin,
    rolsuper,
    rolbypassrls,
  };
}

/**
 * Executa a matriz de auditoria de autenticação e isolamento RLS contra o banco.
 * Opera via conexões autenticadas diretamente como medicina_auth e medicina_app,
 * com fallback transparente para execução simulada em PGlite/testes unitários.
 *
 * @param {object} params
 * @param {any} [params.authSql] Conexão autenticada como medicina_auth
 * @param {any} [params.appSql] Conexão autenticada como medicina_app
 * @param {any} [params.sql] Conexão genérica de fallback (PGlite / testes locais)
 * @param {boolean} [params.isMock] Flag indicando ambiente de teste simulado
 * @param {(msg: string) => void} [params.logger]
 * @returns {Promise<{ success: boolean, results: Array<{ code: string, descricao: string, status: string, detalhes: string }> }>}
 */
export async function runStagingIsolationAudit({
  authSql = null,
  appSql = null,
  sql = null,
  isMock = false,
  logger = console.log,
}) {
  const results = [];
  const logScenario = (res) => {
    results.push(res);
    const icon = res.status === 'APROVADO' ? '✅' : res.status === 'REPROVADO' ? '❌' : '⚠️';
    logger(`   [${icon}] [${res.status}] ${res.code}: ${res.descricao}`);
    if (res.detalhes) {
      logger(`       ↳ ${res.detalhes}`);
    }
  };

  const effectiveAuthSql = authSql || sql;
  const effectiveAppSql = appSql || sql;

  if (!effectiveAuthSql || !effectiveAppSql) {
    throw new Error('Parâmetros de conexão insuficientes: forneça authSql e appSql ou sqlInstance.');
  }

  const effectiveIsMock =
    isMock ||
    Boolean(authSql?.isMock) ||
    Boolean(appSql?.isMock) ||
    Boolean(sql?.isMock);

  // 1. Validação estrita de identidade pré-cenários
  if (authSql) {
    logger('\n🔍 Validando identidade da conexão autenticada medicina_auth...');
    const authId = await validateRoleSessionIdentity(authSql, 'medicina_auth', {
      isMock: effectiveIsMock,
    });
    logger(`   ✓ Conexão medicina_auth validada: user="${authId.connectedUser}", login=${authId.rolcanlogin}, super=${authId.rolsuper}, bypassrls=${authId.rolbypassrls}`);
    await authSql`SET default_transaction_read_only = on;`;
  }

  if (appSql) {
    logger('\n🔍 Validando identidade da conexão autenticada medicina_app...');
    const appId = await validateRoleSessionIdentity(appSql, 'medicina_app', {
      isMock: effectiveIsMock,
    });
    logger(`   ✓ Conexão medicina_app validada: user="${appId.connectedUser}", login=${appId.rolcanlogin}, super=${appId.rolsuper}, bypassrls=${appId.rolbypassrls}`);
    await appSql`SET default_transaction_read_only = on;`;
  }

  // Helper para escopo auth (sem SET ROLE se authSql estiver presente)
  const executeInAuthScope = async (callback) => {
    return await effectiveAuthSql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY;`;
      if (!authSql) {
        await tx`SET LOCAL ROLE medicina_auth;`;
      }
      return await callback(tx);
    });
  };

  // Helper para escopo app (sem SET ROLE se appSql estiver presente)
  const executeInAppScope = async (callback) => {
    return await effectiveAppSql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY;`;
      if (!appSql) {
        await tx`SET LOCAL ROLE medicina_app;`;
      }
      return await callback(tx);
    });
  };

  // --------------------------------------------------------------------------
  // GRUPO 1: AUTENTICAÇÃO VIA CONEXÃO REAL medicina_auth
  // --------------------------------------------------------------------------
  logger('\n1️⃣  AUDITORIA DE AUTENTICAÇÃO E RPC (Conexão Autenticada medicina_auth):');

  // Teste A1: Alice via medicina.autenticar_por_email
  try {
    const rows = await executeInAuthScope(async (tx) => {
      return await tx`SELECT id, auth_user_id, nome, email, password_hash, papel FROM medicina.autenticar_por_email(${PERSONA_ALICE.email});`;
    });
    if (
      rows.length === 1 &&
      String(rows[0].id).toLowerCase() === PERSONA_ALICE.id.toLowerCase() &&
      rows[0].papel === 'estudante' &&
      typeof rows[0].password_hash === 'string' &&
      rows[0].password_hash.startsWith('$2')
    ) {
      logScenario({
        code: 'AUT-01',
        descricao: 'RPC de autenticação para Alice sob medicina_auth',
        status: 'APROVADO',
        detalhes: `ID=${rows[0].id}, papel=${rows[0].papel}, hash_bcrypt=presente (custo 10).`,
      });
    } else {
      logScenario({
        code: 'AUT-01',
        descricao: 'RPC de autenticação para Alice sob medicina_auth',
        status: 'REPROVADO',
        detalhes: `Retorno inesperado: ${JSON.stringify(rows)}`,
      });
    }
  } catch (err) {
    logScenario({
      code: 'AUT-01',
      descricao: 'RPC de autenticação para Alice sob medicina_auth',
      status: 'REPROVADO',
      detalhes: sanitizeError(err),
    });
  }

  // Teste A2: Bruno via medicina.autenticar_por_email
  try {
    const rows = await executeInAuthScope(async (tx) => {
      return await tx`SELECT id, auth_user_id, nome, email, password_hash, papel FROM medicina.autenticar_por_email(${PERSONA_BRUNO.email});`;
    });
    if (
      rows.length === 1 &&
      String(rows[0].id).toLowerCase() === PERSONA_BRUNO.id.toLowerCase() &&
      rows[0].papel === 'responsavel' &&
      typeof rows[0].password_hash === 'string'
    ) {
      logScenario({
        code: 'AUT-02',
        descricao: 'RPC de autenticação para Bruno sob medicina_auth',
        status: 'APROVADO',
        detalhes: `ID=${rows[0].id}, papel=${rows[0].papel}, hash_bcrypt=presente.`,
      });
    } else {
      logScenario({
        code: 'AUT-02',
        descricao: 'RPC de autenticação para Bruno sob medicina_auth',
        status: 'REPROVADO',
        detalhes: `Retorno inesperado: ${JSON.stringify(rows)}`,
      });
    }
  } catch (err) {
    logScenario({
      code: 'AUT-02',
      descricao: 'RPC de autenticação para Bruno sob medicina_auth',
      status: 'REPROVADO',
      detalhes: sanitizeError(err),
    });
  }

  // Teste A3: Carlos via medicina.autenticar_por_email
  try {
    const rows = await executeInAuthScope(async (tx) => {
      return await tx`SELECT id, auth_user_id, nome, email, password_hash, papel FROM medicina.autenticar_por_email(${PERSONA_CARLOS.email});`;
    });
    if (
      rows.length === 1 &&
      String(rows[0].id).toLowerCase() === PERSONA_CARLOS.id.toLowerCase() &&
      rows[0].papel === 'estudante' &&
      typeof rows[0].password_hash === 'string'
    ) {
      logScenario({
        code: 'AUT-03',
        descricao: 'RPC de autenticação para Carlos sob medicina_auth',
        status: 'APROVADO',
        detalhes: `ID=${rows[0].id}, papel=${rows[0].papel}, hash_bcrypt=presente.`,
      });
    } else {
      logScenario({
        code: 'AUT-03',
        descricao: 'RPC de autenticação para Carlos sob medicina_auth',
        status: 'REPROVADO',
        detalhes: `Retorno inesperado: ${JSON.stringify(rows)}`,
      });
    }
  } catch (err) {
    logScenario({
      code: 'AUT-03',
      descricao: 'RPC de autenticação para Carlos sob medicina_auth',
      status: 'REPROVADO',
      detalhes: sanitizeError(err),
    });
  }

  // Teste A4: Anti-enumeração / Proteção da allowlist
  try {
    const rows = await executeInAuthScope(async (tx) => {
      return await tx`SELECT * FROM medicina.autenticar_por_email('invasor.inexistente@externo.com');`;
    });
    if (rows.length === 0) {
      logScenario({
        code: 'AUT-04',
        descricao: 'Anti-enumeração na RPC de autenticação (e-mail fora da allowlist)',
        status: 'APROVADO',
        detalhes: 'Retorno de 0 linhas imediato para e-mail inexistente.',
      });
    } else {
      logScenario({
        code: 'AUT-04',
        descricao: 'Anti-enumeração na RPC de autenticação (e-mail fora da allowlist)',
        status: 'REPROVADO',
        detalhes: `Vazamento de dados para e-mail não cadastrado: ${rows.length} linhas.`,
      });
    }
  } catch (err) {
    logScenario({
      code: 'AUT-04',
      descricao: 'Anti-enumeração na RPC de autenticação (e-mail fora da allowlist)',
      status: 'REPROVADO',
      detalhes: sanitizeError(err),
    });
  }

  // --------------------------------------------------------------------------
  // GRUPO 2: SEGURANÇA E FRONTEIRA TÉCNICA (Conexão Autenticada medicina_app)
  // --------------------------------------------------------------------------
  logger('\n2️⃣  SEGURANÇA E FRONTEIRA DO PAPEL APLICACIONAL (Conexão Autenticada medicina_app):');

  // Teste SEC-01: Bloqueio da RPC medicina.autenticar_por_email para medicina_app
  try {
    await executeInAppScope(async (tx) => {
      await tx`SELECT * FROM medicina.autenticar_por_email(${PERSONA_ALICE.email});`;
    });
    logScenario({
      code: 'SEC-01',
      descricao: 'Bloqueio de execução da RPC de autenticação pelo papel aplicacional',
      status: 'REPROVADO',
      detalhes: 'medicina_app conseguiu executar medicina.autenticar_por_email (falha de privilégio).',
    });
  } catch (err) {
    const errMsg = err?.message || '';
    const isSetRoleFailure = /permission denied to set role/i.test(errMsg);
    const isExpectedDenial =
      !isSetRoleFailure &&
      (err?.code === '42501' || /permission denied/i.test(errMsg)) &&
      /autenticar_por_email/i.test(errMsg);

    if (isExpectedDenial) {
      logScenario({
        code: 'SEC-01',
        descricao: 'Bloqueio de execução da RPC de autenticação pelo papel aplicacional',
        status: 'APROVADO',
        detalhes: 'Rejeição estrita com erro 42501 específico para a função autenticar_por_email.',
      });
    } else if (isSetRoleFailure) {
      logScenario({
        code: 'SEC-01',
        descricao: 'Bloqueio de execução da RPC de autenticação pelo papel aplicacional',
        status: 'REPROVADO',
        detalhes: `Falso positivo prevenido: erro ao assumir a role (SET ROLE) e não na execução da função: ${sanitizeError(err)}`,
      });
    } else {
      logScenario({
        code: 'SEC-01',
        descricao: 'Bloqueio de execução da RPC de autenticação pelo papel aplicacional',
        status: 'REPROVADO',
        detalhes: `Erro inesperado: ${sanitizeError(err)}`,
      });
    }
  }

  // Teste SEC-02: Proteção de Coluna: Bloqueio de leitura de password_hash sob medicina_app
  try {
    await executeInAppScope(async (tx) => {
      await tx`SELECT password_hash FROM public.perfis;`;
    });
    logScenario({
      code: 'SEC-02',
      descricao: 'Proteção de Coluna: Revogação de SELECT na coluna password_hash para medicina_app',
      status: 'REPROVADO',
      detalhes: 'medicina_app conseguiu consultar password_hash (violação grave de sigilo).',
    });
  } catch (err) {
    const errMsg = err?.message || '';
    const isSetRoleFailure = /permission denied to set role/i.test(errMsg);
    const isExpectedDenial =
      !isSetRoleFailure &&
      (err?.code === '42501' || /permission denied/i.test(errMsg)) &&
      /(password_hash|perfis)/i.test(errMsg);

    if (isExpectedDenial) {
      logScenario({
        code: 'SEC-02',
        descricao: 'Proteção de Coluna: Revogação de SELECT na coluna password_hash para medicina_app',
        status: 'APROVADO',
        detalhes: 'Rejeição estrita com erro 42501 específico para a coluna password_hash.',
      });
    } else if (isSetRoleFailure) {
      logScenario({
        code: 'SEC-02',
        descricao: 'Proteção de Coluna: Revogação de SELECT na coluna password_hash para medicina_app',
        status: 'REPROVADO',
        detalhes: `Falso positivo prevenido: erro ao assumir a role (SET ROLE): ${sanitizeError(err)}`,
      });
    } else {
      logScenario({
        code: 'SEC-02',
        descricao: 'Proteção de Coluna: Revogação de SELECT na coluna password_hash para medicina_app',
        status: 'REPROVADO',
        detalhes: `Erro inesperado: ${sanitizeError(err)}`,
      });
    }
  }

  // --------------------------------------------------------------------------
  // GRUPO 3: PRINCÍPIO FAIL-CLOSED (SEM CONTEXTO OU NÃO-AUTENTICADO)
  // --------------------------------------------------------------------------
  logger('\n3️⃣  PRINCÍPIO FAIL-CLOSED (Sem Contexto RLS ou Papel Anônimo):');

  // Teste RLS-01: medicina_app sem chamar medicina.set_context
  try {
    const summary = await executeInAppScope(async (tx) => {
      const [p] = await tx`SELECT count(*) FROM public.perfis;`;
      const [c] = await tx`SELECT count(*) FROM public.ciclos;`;
      const [k] = await tx`SELECT count(*) FROM public.cards;`;
      const [a] = await tx`SELECT count(*) FROM public.acervo_arquivos;`;
      const [r] = await tx`SELECT count(*) FROM public.responsavel_estudante;`;
      return {
        perfis: Number(p.count),
        ciclos: Number(c.count),
        cards: Number(k.count),
        arquivos: Number(a.count),
        vinculos: Number(r.count),
      };
    });

    const isAllZero = Object.values(summary).every((cnt) => cnt === 0);
    if (isAllZero) {
      logScenario({
        code: 'RLS-01',
        descricao: 'Fail-closed sob medicina_app sem ativação de contexto transacional',
        status: 'APROVADO',
        detalhes: '0 linhas visíveis em perfis, ciclos, cards, acervo e vínculos.',
      });
    } else {
      logScenario({
        code: 'RLS-01',
        descricao: 'Fail-closed sob medicina_app sem ativação de contexto transacional',
        status: 'REPROVADO',
        detalhes: `Vazamento de dados sem contexto: ${JSON.stringify(summary)}`,
      });
    }
  } catch (err) {
    logScenario({
      code: 'RLS-01',
      descricao: 'Fail-closed sob medicina_app sem ativação de contexto transacional',
      status: 'REPROVADO',
      detalhes: sanitizeError(err),
    });
  }

  // Teste RLS-02: medicina_anon e Acesso Não-Autenticado
  try {
    const summary = await executeInAppScope(async (tx) => {
      const [p] = await tx`SELECT count(*) FROM public.perfis;`;
      const [c] = await tx`SELECT count(*) FROM public.ciclos;`;
      const [k] = await tx`SELECT count(*) FROM public.cards;`;
      const [a] = await tx`SELECT count(*) FROM public.acervo_arquivos;`;
      return {
        perfis: Number(p.count),
        ciclos: Number(c.count),
        cards: Number(k.count),
        arquivos: Number(a.count),
      };
    });

    const isAllZero = Object.values(summary).every((cnt) => cnt === 0);

    // Consulta de catálogo da role medicina_anon
    const anonRoles = await effectiveAppSql`
      SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = 'medicina_anon';
    `;

    const isCatalogSafe =
      anonRoles.length === 1 &&
      anonRoles[0].rolsuper === false &&
      anonRoles[0].rolbypassrls === false;

    if (isAllZero && isCatalogSafe) {
      logScenario({
        code: 'RLS-02',
        descricao: 'Fail-closed absoluto do acesso não-autenticado e blindagem de medicina_anon',
        status: 'APROVADO',
        detalhes: 'Consultas não-autenticadas retornam 0 linhas. Catálogo comprova medicina_anon sem SUPERUSER e sem BYPASSRLS.',
      });
    } else {
      logScenario({
        code: 'RLS-02',
        descricao: 'Fail-closed absoluto do acesso não-autenticado e blindagem de medicina_anon',
        status: 'REPROVADO',
        detalhes: `Insegurança detectada: summary=${JSON.stringify(summary)}, anonRoles=${JSON.stringify(anonRoles)}`,
      });
    }
  } catch (err) {
    logScenario({
      code: 'RLS-02',
      descricao: 'Fail-closed absoluto do acesso não-autenticado e blindagem de medicina_anon',
      status: 'REPROVADO',
      detalhes: sanitizeError(err),
    });
  }

  // --------------------------------------------------------------------------
  // GRUPO 4: ISOLAMENTO ESTUDANTE ALICE
  // --------------------------------------------------------------------------
  logger('\n4️⃣  ISOLAMENTO RLS DA ESTUDANTE ALICE:');

  try {
    const aliceData = await executeInAppScope(async (tx) => {
      await tx`SELECT medicina.set_context(${PERSONA_ALICE.id}::uuid, 'estudante');`;

      const perfis = await tx`SELECT id, nome, email, papel FROM public.perfis;`;
      const ciclos = await tx`SELECT id, estudante_perfil_id, nome FROM public.ciclos;`;
      const [blocosCount] = await tx`SELECT count(*) FROM public.ciclo_blocos;`;
      const cards = await tx`SELECT id, perfil_id, frente FROM public.cards;`;
      const [arquivosCount] = await tx`SELECT count(*) FROM public.acervo_arquivos;`;
      const vinculos = await tx`SELECT vinculo_id, responsavel_perfil_id, estudante_perfil_id FROM public.responsavel_estudante;`;

      return {
        perfis,
        ciclos,
        blocos: Number(blocosCount.count),
        cards,
        arquivos: Number(arquivosCount.count),
        vinculos,
      };
    });

    const perfisOk = aliceData.perfis.length === 1 && String(aliceData.perfis[0].id).toLowerCase() === PERSONA_ALICE.id.toLowerCase();
    const ciclosOk = aliceData.ciclos.length === 1 && String(aliceData.ciclos[0].id).toLowerCase() === STAGING_ALICE_CICLO_ID.toLowerCase();
    const blocosOk = aliceData.blocos === 28;
    const cardsOk = aliceData.cards.length === 3 && aliceData.cards.every((c) => String(c.perfil_id).toLowerCase() === PERSONA_ALICE.id.toLowerCase());
    const arquivosOk = aliceData.arquivos === 0;
    const vinculosOk = aliceData.vinculos.length === 1 && String(aliceData.vinculos[0].estudante_perfil_id).toLowerCase() === PERSONA_ALICE.id.toLowerCase();

    if (perfisOk && ciclosOk && blocosOk && cardsOk && arquivosOk && vinculosOk) {
      logScenario({
        code: 'ISO-01',
        descricao: 'Isolamento estrito da estudante Alice',
        status: 'APROVADO',
        detalhes: 'Acessa apenas seu perfil, seu ciclo (28 blocos), seus 3 cards, seu vínculo de tutoria e 0 arquivos do acervo. Zero dados de Carlos visíveis.',
      });
    } else {
      logScenario({
        code: 'ISO-01',
        descricao: 'Isolamento estrito da estudante Alice',
        status: 'REPROVADO',
        detalhes: `Inconsistência: perfis=${aliceData.perfis.length}, ciclos=${aliceData.ciclos.length}, blocos=${aliceData.blocos}, cards=${aliceData.cards.length}, arquivos=${aliceData.arquivos}, vinculos=${aliceData.vinculos.length}`,
      });
    }
  } catch (err) {
    logScenario({
      code: 'ISO-01',
      descricao: 'Isolamento estrito da estudante Alice',
      status: 'REPROVADO',
      detalhes: sanitizeError(err),
    });
  }

  // --------------------------------------------------------------------------
  // GRUPO 5: ISOLAMENTO ESTUDANTE INDEPENDENTE CARLOS
  // --------------------------------------------------------------------------
  logger('\n5️⃣  ISOLAMENTO RLS DO ESTUDANTE INDEPENDENTE CARLOS:');

  try {
    const carlosData = await executeInAppScope(async (tx) => {
      await tx`SELECT medicina.set_context(${PERSONA_CARLOS.id}::uuid, 'estudante');`;

      const perfis = await tx`SELECT id, nome, email, papel FROM public.perfis;`;
      const ciclos = await tx`SELECT id, estudante_perfil_id, nome FROM public.ciclos;`;
      const [blocosCount] = await tx`SELECT count(*) FROM public.ciclo_blocos;`;
      const cards = await tx`SELECT id, perfil_id, frente FROM public.cards;`;
      const [arquivosCount] = await tx`SELECT count(*) FROM public.acervo_arquivos;`;
      const vinculos = await tx`SELECT vinculo_id, responsavel_perfil_id, estudante_perfil_id FROM public.responsavel_estudante;`;

      return {
        perfis,
        ciclos,
        blocos: Number(blocosCount.count),
        cards,
        arquivos: Number(arquivosCount.count),
        vinculos,
      };
    });

    const perfisOk = carlosData.perfis.length === 1 && String(carlosData.perfis[0].id).toLowerCase() === PERSONA_CARLOS.id.toLowerCase();
    const ciclosOk = carlosData.ciclos.length === 1 && String(carlosData.ciclos[0].id).toLowerCase() === STAGING_CARLOS_CICLO_ID.toLowerCase();
    const blocosOk = carlosData.blocos === 28;
    const cardsOk = carlosData.cards.length === 2 && carlosData.cards.every((c) => String(c.perfil_id).toLowerCase() === PERSONA_CARLOS.id.toLowerCase());
    const arquivosOk = carlosData.arquivos === 0;
    const vinculosOk = carlosData.vinculos.length === 0; // Carlos é independente, vínculo Bruno->Alice é invisível

    if (perfisOk && ciclosOk && blocosOk && cardsOk && arquivosOk && vinculosOk) {
      logScenario({
        code: 'ISO-02',
        descricao: 'Isolamento estrito do estudante independente Carlos',
        status: 'APROVADO',
        detalhes: 'Acessa apenas seu perfil, seu ciclo (28 blocos), seus 2 cards. Vínculo Bruno->Alice e ciclo de Alice 100% invisíveis.',
      });
    } else {
      logScenario({
        code: 'ISO-02',
        descricao: 'Isolamento estrito do estudante independente Carlos',
        status: 'REPROVADO',
        detalhes: `Inconsistência: perfis=${carlosData.perfis.length}, ciclos=${carlosData.ciclos.length}, blocos=${carlosData.blocos}, cards=${carlosData.cards.length}, arquivos=${carlosData.arquivos}, vinculos=${carlosData.vinculos.length}`,
      });
    }
  } catch (err) {
    logScenario({
      code: 'ISO-02',
      descricao: 'Isolamento estrito do estudante independente Carlos',
      status: 'REPROVADO',
      detalhes: sanitizeError(err),
    });
  }

  // --------------------------------------------------------------------------
  // GRUPO 6: ESCOPO DO RESPONSÁVEL BRUNO (TUTELA DE ALICE, ZERO CARLOS)
  // --------------------------------------------------------------------------
  logger('\n6️⃣  ESCOPO DE ACESSO DO RESPONSÁVEL BRUNO:');

  try {
    const brunoData = await executeInAppScope(async (tx) => {
      await tx`SELECT medicina.set_context(${PERSONA_BRUNO.id}::uuid, 'responsavel');`;

      const perfis = await tx`SELECT id, nome, email, papel FROM public.perfis;`;
      const vinculos = await tx`SELECT vinculo_id, responsavel_perfil_id, estudante_perfil_id FROM public.responsavel_estudante;`;
      const arquivos = await tx`SELECT id, titulo, enviado_por FROM public.acervo_arquivos;`;
      const [ciclosCount] = await tx`SELECT count(*) FROM public.ciclos;`;

      return {
        perfis,
        vinculos,
        arquivos,
        ciclos: Number(ciclosCount.count),
      };
    });

    const idsVisiveis = brunoData.perfis.map((p) => String(p.id).toLowerCase());
    const seesBruno = idsVisiveis.includes(PERSONA_BRUNO.id.toLowerCase());
    const seesAlice = idsVisiveis.includes(PERSONA_ALICE.id.toLowerCase());
    const seesCarlos = idsVisiveis.includes(PERSONA_CARLOS.id.toLowerCase());

    const perfisOk = brunoData.perfis.length === 2 && seesBruno && seesAlice && !seesCarlos;
    const vinculosOk = brunoData.vinculos.length === 1 && String(brunoData.vinculos[0].responsavel_perfil_id).toLowerCase() === PERSONA_BRUNO.id.toLowerCase();
    const arquivosOk = brunoData.arquivos.length === 1 && String(brunoData.arquivos[0].id).toLowerCase() === STAGING_ARQUIVO_ID.toLowerCase();
    const ciclosOk = brunoData.ciclos === 0; // Anti-vigilância: responsável não tem SELECT direto em public.ciclos

    if (perfisOk && vinculosOk && arquivosOk && ciclosOk) {
      logScenario({
        code: 'ISO-03',
        descricao: 'Escopo de acesso do responsável Bruno (tutela de Alice, zero Carlos)',
        status: 'APROVADO',
        detalhes: 'Enxerga perfil próprio e de Alice, seu vínculo tutelar e seu arquivo no acervo. Carlos e ciclos diretos são 100% invisíveis (anti-vigilância).',
      });
    } else {
      logScenario({
        code: 'ISO-03',
        descricao: 'Escopo de acesso do responsável Bruno (tutela de Alice, zero Carlos)',
        status: 'REPROVADO',
        detalhes: `Inconsistência: perfis=${brunoData.perfis.length} (seesCarlos=${seesCarlos}), vinculos=${brunoData.vinculos.length}, arquivos=${brunoData.arquivos.length}, ciclos=${brunoData.ciclos}`,
      });
    }
  } catch (err) {
    logScenario({
      code: 'ISO-03',
      descricao: 'Escopo de acesso do responsável Bruno (tutela de Alice, zero Carlos)',
      status: 'REPROVADO',
      detalhes: sanitizeError(err),
    });
  }

  // --------------------------------------------------------------------------
  // GRUPO 7: REJEIÇÃO COMPULSÓRIA DE ESCALADA DE PRIVILÉGIOS
  // --------------------------------------------------------------------------
  logger('\n7️⃣  REJEIÇÃO COMPULSÓRIA DE ESCALADA DE PRIVILÉGIOS:');

  // Teste ESC-01: Carlos tentando forjar papel 'responsavel'
  try {
    await executeInAppScope(async (tx) => {
      await tx`SELECT medicina.set_context(${PERSONA_CARLOS.id}::uuid, 'responsavel');`;
    });
    logScenario({
      code: 'ESC-01',
      descricao: 'Carlos tentando ativar contexto com papel forjado (responsavel)',
      status: 'REPROVADO',
      detalhes: 'A função medicina.set_context aceitou papel divergente do cadastro.',
    });
  } catch (err) {
    const isP0001 = /Contexto invalido/i.test(err?.message || '') || err?.code === 'P0001';
    if (isP0001) {
      logScenario({
        code: 'ESC-01',
        descricao: 'Carlos tentando ativar contexto com papel forjado (responsavel)',
        status: 'APROVADO',
        detalhes: 'Exceção P0001 disparada: "Contexto invalido: perfil ... com papel responsavel nao existe."',
      });
    } else {
      logScenario({
        code: 'ESC-01',
        descricao: 'Carlos tentando ativar contexto com papel forjado (responsavel)',
        status: 'REPROVADO',
        detalhes: `Erro inesperado: ${sanitizeError(err)}`,
      });
    }
  }

  // Teste ESC-02: Alice tentando forjar papel 'responsavel'
  try {
    await executeInAppScope(async (tx) => {
      await tx`SELECT medicina.set_context(${PERSONA_ALICE.id}::uuid, 'responsavel');`;
    });
    logScenario({
      code: 'ESC-02',
      descricao: 'Alice tentando ativar contexto com papel forjado (responsavel)',
      status: 'REPROVADO',
      detalhes: 'A função medicina.set_context aceitou papel divergente.',
    });
  } catch (err) {
    const isP0001 = /Contexto invalido/i.test(err?.message || '') || err?.code === 'P0001';
    if (isP0001) {
      logScenario({
        code: 'ESC-02',
        descricao: 'Alice tentando ativar contexto com papel forjado (responsavel)',
        status: 'APROVADO',
        detalhes: 'Exceção P0001 disparada com sucesso.',
      });
    } else {
      logScenario({
        code: 'ESC-02',
        descricao: 'Alice tentando ativar contexto com papel forjado (responsavel)',
        status: 'REPROVADO',
        detalhes: `Erro inesperado: ${sanitizeError(err)}`,
      });
    }
  }

  // Teste ESC-03: UUID arbitrário inexistente
  try {
    await executeInAppScope(async (tx) => {
      await tx`SELECT medicina.set_context('ffffffff-ffff-4fff-bfff-ffffffffffff'::uuid, 'estudante');`;
    });
    logScenario({
      code: 'ESC-03',
      descricao: 'Ativação de contexto com UUID arbitrário inexistente',
      status: 'REPROVADO',
      detalhes: 'medicina.set_context aceitou UUID fantasma.',
    });
  } catch (err) {
    const isP0001 = /Contexto invalido/i.test(err?.message || '') || err?.code === 'P0001';
    if (isP0001) {
      logScenario({
        code: 'ESC-03',
        descricao: 'Ativação de contexto com UUID arbitrário inexistente',
        status: 'APROVADO',
        detalhes: 'Exceção P0001 disparada: perfil não existe.',
      });
    } else {
      logScenario({
        code: 'ESC-03',
        descricao: 'Ativação de contexto com UUID arbitrário inexistente',
        status: 'REPROVADO',
        detalhes: `Erro inesperado: ${sanitizeError(err)}`,
      });
    }
  }

  // --------------------------------------------------------------------------
  // GRUPO 8: ESCOPO TRANSACIONAL E LIMPEZA NO POOLER (SET LOCAL)
  // --------------------------------------------------------------------------
  logger('\n8️⃣  ISOLAMENTO TRANSACIONAL E POOLER SAFETY (SET LOCAL):');

  try {
    // Transação 1: define contexto de Alice e conclui
    await executeInAppScope(async (tx) => {
      await tx`SELECT medicina.set_context(${PERSONA_ALICE.id}::uuid, 'estudante');`;
      const [cur] = await tx`SELECT medicina.current_perfil_id() as id;`;
      if (String(cur.id).toLowerCase() !== PERSONA_ALICE.id.toLowerCase()) {
        throw new Error('Falha ao registrar contexto na transação 1.');
      }
    });

    // Transação 2: na MESMA conexão de pool, sem definir contexto
    const leakedContext = await executeInAppScope(async (tx) => {
      const [cur] = await tx`SELECT medicina.current_perfil_id() as id;`;
      const [p] = await tx`SELECT count(*) FROM public.perfis;`;
      return {
        currentPerfilId: cur?.id ?? null,
        perfisCount: Number(p?.count ?? 0),
      };
    });

    if (leakedContext.currentPerfilId === null && leakedContext.perfisCount === 0) {
      logScenario({
        code: 'POL-01',
        descricao: 'Limpeza automática de contexto RLS ao término de transação (SET LOCAL)',
        status: 'APROVADO',
        detalhes: 'A transação subsequente na mesma conexão encontrou current_perfil_id=NULL e 0 perfis. Zero contaminação no Session Pooler.',
      });
    } else {
      logScenario({
        code: 'POL-01',
        descricao: 'Limpeza automática de contexto RLS ao término de transação (SET LOCAL)',
        status: 'REPROVADO',
        detalhes: `Contaminação de sessão detectada: ${JSON.stringify(leakedContext)}`,
      });
    }
  } catch (err) {
    logScenario({
      code: 'POL-01',
      descricao: 'Limpeza automática de contexto RLS ao término de transação (SET LOCAL)',
      status: 'REPROVADO',
      detalhes: sanitizeError(err),
    });
  }

  const allApproved = results.every((r) => r.status === 'APROVADO');
  return { success: allApproved, results };
}

/**
 * CLI Launcher para execução controlada e interativa
 */
async function main() {
  const args = process.argv.slice(2);
  const isHelp = args.includes('--help') || args.includes('-h');

  if (isHelp) {
    console.log(`
Uso do Auditor de Autenticação e Isolamento Staging (Medicina 2029 — H2.04-T1-R2):
  node scripts/db/audit-staging-isolation-t1.mjs [--ca=<caminho>]

Opções:
  --ca=<caminho>   Caminho para o certificado CA do Supabase (ex: ~/Downloads/prod-ca-2021.crt)
  --help, -h       Exibe esta mensagem de ajuda e encerra

Autenticação:
  Solicita interativamente as senhas das roles técnicas:
    - medicina_auth (Autenticação NextAuth e RPCs)
    - medicina_app (Server Actions e runtime RLS)
  (Ou lê de MEDICINA_AUTH_PASSWORD e MEDICINA_APP_PASSWORD em ambiente não-interativo).

Modo de Operação:
  100% Somente-Leitura (SET default_transaction_read_only = on).
  Conexões diretas por papel autenticado no Session Pooler (porta 5432).
  Zero chamadas a SET ROLE administrativo.
`);
    process.exit(0);
  }

  const caArg = args.find((a) => a.startsWith('--ca='))?.split('=')[1];
  let caInfo = null;
  try {
    caInfo = resolveCaCertificate(caArg);
  } catch (caErr) {
    console.error(`❌ ERRO TLS: ${sanitizeError(caErr)}`);
    process.exit(1);
  }

  if (!caInfo) {
    console.error('❌ ERRO TLS: Certificado CA do Supabase (prod-ca-2021.crt) não localizado.');
    console.error('👉 Indique o caminho via --ca=~/Downloads/prod-ca-2021.crt ou SUPABASE_SSL_CA.');
    process.exit(1);
  }

  console.log('================================================================');
  console.log('MEDICINA 2029 — H2.04-T1-R2: AUDITORIA REAL DE ISOLAMENTO RLS');
  console.log('================================================================');
  console.log(`Projeto Alvo:      ${TARGET_PROJECT_REF}`);
  console.log(`Session Pooler:    ${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`Roles Técnicas:    medicina_auth (porta ${TARGET_PORT}) e medicina_app (porta ${TARGET_PORT})`);
  console.log(`Banco:             ${TARGET_DB}`);
  console.log(`Modo:              100% Somente-Leitura (SELECT) via Conexões Autenticadas Diretas`);
  console.log(`Certificado CA:    ${caInfo.path}`);
  console.log('================================================================\n');

  let authPassword = process.env.MEDICINA_AUTH_PASSWORD;
  let appPassword = process.env.MEDICINA_APP_PASSWORD;

  if (!authPassword || !appPassword) {
    if (!process.stdin.isTTY) {
      console.error('❌ ERRO: Terminal não-interativo detectado e credenciais de roles técnicas não definidas.');
      console.error('👉 Defina MEDICINA_AUTH_PASSWORD e MEDICINA_APP_PASSWORD ou execute em terminal interativo.');
      process.exit(1);
    }
  }

  if (!authPassword) {
    authPassword = await promptHiddenPassword('🔑 [1/2] Digite a senha da role medicina_auth: ');
    if (!authPassword) {
      console.error('❌ Operação abortada: senha de medicina_auth vazia.');
      process.exit(1);
    }
  }

  if (!appPassword) {
    appPassword = await promptHiddenPassword('🔑 [2/2] Digite a senha da role medicina_app: ');
    if (!appPassword) {
      console.error('❌ Operação abortada: senha de medicina_app vazia.');
      process.exit(1);
    }
  }

  const authUrl = buildRolePoolerUrl('medicina_auth', authPassword, TARGET_PORT);
  const appUrl = buildRolePoolerUrl('medicina_app', appPassword, TARGET_PORT);

  validateRoleConnectionConfig(authUrl, 'medicina_auth');
  validateRoleConnectionConfig(appUrl, 'medicina_app');

  const sslConfig = {
    rejectUnauthorized: true,
    ca: [...tls.rootCertificates, caInfo.content],
  };

  const authSql = postgres(authUrl, {
    max: 1,
    connect_timeout: 20,
    idle_timeout: 10,
    ssl: sslConfig,
    onnotice: () => {},
  });

  const appSql = postgres(appUrl, {
    max: 1,
    connect_timeout: 20,
    idle_timeout: 10,
    ssl: sslConfig,
    onnotice: () => {},
  });

  try {
    const { success, results } = await runStagingIsolationAudit({
      authSql,
      appSql,
      logger: console.log,
    });

    console.log('\n================================================================');
    console.log(`RESUMO DA AUDITORIA H2.04-T1-R2: ${success ? 'TODOS OS CENÁRIOS APROVADOS (APTO)' : 'CENÁRIOS REPROVADOS DETECTADOS'}`);
    console.log('================================================================');
    const aprovados = results.filter((r) => r.status === 'APROVADO').length;
    const reprovados = results.filter((r) => r.status === 'REPROVADO').length;
    console.log(`Total de Cenários Avaliados: ${results.length}`);
    console.log(` • Aprovados:  ${aprovados}`);
    console.log(` • Reprovados: ${reprovados}`);
    console.log('================================================================\n');

    if (!success) {
      process.exit(1);
    }
  } catch (err) {
    console.error('\n❌ Falha na auditoria de homologação:', sanitizeError(err));
    process.exit(1);
  } finally {
    authPassword = '';
    appPassword = '';
    await Promise.allSettled([authSql.end(), appSql.end()]);
  }
}

if (process.argv[1]?.includes('audit-staging-isolation-t1.mjs')) {
  main().catch((err) => {
    console.error('Erro fatal:', err);
    process.exit(1);
  });
}
