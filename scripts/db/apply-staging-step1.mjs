#!/usr/bin/env node

/**
 * MEDICINA 2029 — H1.04 / STAGING MIGRATION
 * Lançador Seguro e Interativo da Primeira Migração (0000_greedy_loki.sql)
 *
 * Aplica exclusivamente a primeira migração no Supabase Staging de forma controlada:
 *   - Fixa o projeto ynfocaorhadizlvbnzrt e Session Pooler aws-0-us-east-1.pooler.supabase.com:5432.
 *   - Utiliza a role administrativa postgres.ynfocaorhadizlvbnzrt.
 *   - Restringe o escopo rigorosamente com --until-step=1 (bloqueia etapas 2 a 9).
 *   - Exige confirmação humana explícita ("CONFIRMAR") antes de qualquer escrita.
 *   - Entrada oculta de senha no terminal (sem eco, sem histórico de shell, sem argv de processo).
 *   - Validação TLS estrita com rejectUnauthorized: true e cadeia CA (prod-ca-2021.crt).
 *   - Execução in-process direta: a senha NUNCA é repassada via argumentos de processo ou salva em disco.
 */

import tls from 'node:tls';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

import {
  executeStagingMigrations,
  getMigrationManifest,
  assertCanRunStagingMigrationsCli,
} from './migrate-staging.mjs';

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
export const TARGET_STEP = 1;
export const TARGET_SCRIPT_NAME = 'drizzle/0000_greedy_loki.sql';

/**
 * Solicita confirmação humana explícita no terminal
 * @param {string} promptText
 * @returns {Promise<string>}
 */
export function promptConfirmation(promptText = 'Digite "CONFIRMAR" para prosseguir: ') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Executa a primeira migração com salvaguardas fail-closed e escopo estrito
 * @param {object} params
 * @param {string} [params.password]
 * @param {string} [params.caCertPath]
 * @param {string} params.confirmation
 * @param {any} [params.sqlInstance] - Instância mock/PGlite para testes automatizados
 * @param {function} [params.logger]
 */
export async function executeControlledStep1Migration({
  password,
  caCertPath,
  confirmation,
  sqlInstance = null,
  logger = console.log,
}) {
  // 1. Validação de confirmação humana explícita
  if (confirmation !== 'CONFIRMAR') {
    throw new Error(
      `OPERAÇÃO CANCELADA: Confirmação humana explícita não fornecida (esperado "CONFIRMAR", recebido "${confirmation}"). ` +
      'Nenhuma conexão ou modificação foi realizada.'
    );
  }

  // 2. Configuração de ambiente in-process
  process.env.APP_ENV = 'staging';
  process.env.CONFIRM_STAGING_MIGRATIONS = 'true';
  process.env.STAGING_SUPABASE_PROJECT_REF = TARGET_PROJECT_REF;
  process.env.CONFIRM_ISOLATED_STAGING_ENVIRONMENT = 'true';

  // 3. Resolução do Certificado CA TLS
  let caInfo = null;
  if (!sqlInstance) {
    caInfo = resolveCaCertificate(caCertPath);
    if (!caInfo) {
      throw new Error(
        'CERTIFICADO TLS AUSENTE: O certificado CA do Supabase (prod-ca-2021.crt) não foi localizado. ' +
        'Coloque o arquivo em ~/Downloads/prod-ca-2021.crt ou passe --ca=<caminho>.'
      );
    }
  }

  // 4. Conexão dedicada com o banco de dados
  let sql = sqlInstance;
  let shouldCloseSql = false;

  if (!sql) {
    if (!password) {
      throw new Error('Senha administrativa não fornecida.');
    }

    const dbUrl = buildStagingPoolerUrl(password);
    process.env.DATABASE_MIGRATION_URL = dbUrl;

    // Valida salvaguardas fail-closed antes de abrir conexão
    assertCanRunStagingMigrationsCli(process.env, { isCheckDb: false });

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

  try {
    logger('🔒 Conexão TLS estabelecida. Iniciando execução controlada da migração 1...');

    const manifest = getMigrationManifest();
    const step1Manifest = manifest.filter((m) => m.ordem === TARGET_STEP);

    if (step1Manifest.length === 0 || step1Manifest[0].relPath !== TARGET_SCRIPT_NAME) {
      throw new Error(
        `DIVERGÊNCIA DE MANIFESTO: Etapa ${TARGET_STEP} esperava "${TARGET_SCRIPT_NAME}", mas não foi encontrada no manifesto canônico.`
      );
    }

    // Executa exclusivamente o runner com untilStep = 1 (portão operacional estrito)
    const result = await executeStagingMigrations({
      sql,
      manifest,
      isDryRun: false,
      untilStep: TARGET_STEP,
      logger,
    });

    return {
      success: true,
      appliedCount: result.appliedCount,
      skippedCount: result.skippedCount,
      totalExpected: result.total,
      historyTableExists: result.historyTableExists,
      step: TARGET_STEP,
      scriptName: TARGET_SCRIPT_NAME,
      summary: result,
    };
  } finally {
    if (shouldCloseSql && sql) {
      await sql.end();
    }
    // Purga a URL com senha da memória do ambiente
    delete process.env.DATABASE_MIGRATION_URL;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const caArg = args.find((a) => a.startsWith('--ca='))?.split('=')[1] ||
                args.find((a) => a.startsWith('--ca-cert='))?.split('=')[1];

  console.log('================================================================');
  console.log('MEDICINA 2029 — LANÇADOR SEGURO DA MIGRAÇÃO 0000 (STAGING)');
  console.log('================================================================');
  console.log(`Projeto Alvo:        ${TARGET_PROJECT_REF}`);
  console.log(`Session Pooler:      ${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`Usuário:             ${TARGET_USERNAME}`);
  console.log(`Banco:               ${TARGET_DB}`);
  console.log(`Escopo Restrito:     Etapa ${TARGET_STEP}/9 (${TARGET_SCRIPT_NAME})`);
  console.log(`Portão Operacional:  --until-step=${TARGET_STEP} (Bloqueio estrito de 0001 a 0012)`);
  console.log('================================================================\n');

  // 1. Resolução do Certificado TLS CA
  let caInfo = null;
  try {
    caInfo = resolveCaCertificate(caArg);
  } catch (caErr) {
    console.error('\n❌ ERRO NA CONFIGURAÇÃO DO CERTIFICADO TLS:');
    console.error(caErr instanceof Error ? caErr.message : String(caErr));
    process.exit(1);
  }

  if (caInfo) {
    console.log(`• Certificado CA:    ${caInfo.path}`);
    console.log(`  Emissor:           ${caInfo.metadata.issuer.replace(/\n/g, ', ')}`);
    console.log(`  Fingerprint SHA:   ${caInfo.metadata.fingerprint256}`);
    console.log('  Validação TLS:     rejectUnauthorized: true (ESTRITO ATIVO)');
  } else {
    console.error('\n❌ ERRO: Certificado TLS CA (prod-ca-2021.crt) não encontrado.');
    console.error('👉 Baixe o certificado do painel Supabase e mantenha em ~/Downloads/prod-ca-2021.crt ou passe --ca=<caminho>.');
    process.exit(1);
  }

  // 2. Entrada interativa e oculta da senha
  if (!process.stdin.isTTY) {
    console.error('\n❌ ERRO: O lançador exige um terminal interativo TTY para entrada segura da senha.');
    process.exit(1);
  }

  console.log('\n💡 Digite a senha administrativa de staging.');
  console.log('🔒 A senha NÃO será exibida na tela e NÃO será gravada em histórico, argv ou disco.\n');

  const password = await promptHiddenPassword('🔑 Senha de postgres: ');
  if (!password) {
    console.error('\n❌ Operação abortada: senha vazia.');
    process.exit(1);
  }

  // 3. Revisão prévia e confirmação humana explícita
  console.log('\n----------------------------------------------------------------');
  console.log('📋 REVISÃO DA OPERAÇÃO DE MIGRAÇÃO:');
  console.log('• Script a ser aplicado:    drizzle/0000_greedy_loki.sql');
  console.log('• Objetos a serem criados:  32 tabelas + 20 enums + tabela _medicina_staging_migrations');
  console.log('• Carga inicial:            2 e-mails sintéticos em public.allowlist');
  console.log('• Próximas etapas:          PAUSADAS (etapas 2 a 9 não serão executadas)');
  console.log('----------------------------------------------------------------');
  console.log('⚠️  ATENÇÃO: A primeira migração modificará o schema do banco de staging.');

  const confirmation = await promptConfirmation('\n👉 Digite exatamente "CONFIRMAR" para executar a migração: ');

  if (confirmation !== 'CONFIRMAR') {
    console.error('\n❌ Operação cancelada pelo operador. Nenhuma modificação foi executada no banco.');
    process.exit(0);
  }

  console.log('\n🚀 Confirmação recebida. Executando primeira migração controlada...\n');

  try {
    const result = await executeControlledStep1Migration({
      password,
      caCertPath: caArg,
      confirmation,
      logger: console.log,
    });

    console.log('\n================================================================');
    console.log('🎉 MIGRAÇÃO 0000 APLICADA COM SUCESSO NO SUPABASE STAGING!');
    console.log('================================================================');
    console.log(`• Script Aplicado:      ${result.scriptName}`);
    console.log(`• Total Aplicadas:      ${result.appliedCount}`);
    console.log(`• Total Já Existentes:  ${result.skippedCount}`);
    console.log(`• Portão Operacional:   Interrompido com segurança após a etapa 1.`);
    console.log(`• Tracking Registrado:  public._medicina_staging_migrations atualizada.`);
    console.log('================================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ FALHA NA EXECUÇÃO DA MIGRAÇÃO CONTROLADA:');
    console.error(sanitizeError(err));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
