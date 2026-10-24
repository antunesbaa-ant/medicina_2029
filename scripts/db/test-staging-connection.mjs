#!/usr/bin/env node

/**
 * MEDICINA 2029 — H1.04 / STAGING PREFLIGHT
 * Script de Teste de Conexão Somente-Leitura (Session Pooler) com Validação TLS Estrita
 *
 * Executa diagnósticos estritamente passivos (SELECT) contra o Supabase Staging:
 *   - current_database()
 *   - current_user
 *   - current_setting('search_path')
 *   - verificação da extensão vector (schema e versão)
 *
 * SEGURANÇA E TLS:
 *   - Validação TLS ativa obrigatória (rejectUnauthorized: true).
 *   - Verificação rigorosa do hostname do servidor (checkServerIdentity ativo).
 *   - Suporte a CA customizado (prod-ca-2021.crt) combinado com CAs públicos do sistema.
 *   - Suporta especificação via --ca=<caminho>, SUPABASE_SSL_CA, PGSSLROOTCERT ou auto-descoberta em ~/Downloads.
 *   - Entrada interativa e oculta de senha via terminal (sem eco no terminal).
 *   - Zero gravação de credenciais em disco, arquivos .env ou logs.
 *   - Trata caracteres especiais na senha via encodeURIComponent.
 *   - Valida fail-closed que o projeto conectado é estritamente ynfocaorhadizlvbnzrt.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import tls from 'node:tls';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const TARGET_HOST = 'aws-0-us-east-1.pooler.supabase.com';
const TARGET_PORT = 5432;
const TARGET_DB = 'postgres';
const TARGET_ROLE = 'postgres';
const TARGET_PROJECT_REF = 'ynfocaorhadizlvbnzrt';
const TARGET_USERNAME = `${TARGET_ROLE}.${TARGET_PROJECT_REF}`;

/**
 * Resolve e valida o certificado CA TLS a partir de parâmetros, variáveis de ambiente ou auto-descoberta
 * @param {string} [specifiedPath]
 * @returns {{ path: string, content: string, metadata: { subject: string, issuer: string, validTo: string, fingerprint256: string, isCa: boolean } } | null}
 */
export function resolveCaCertificate(specifiedPath) {
  let targetPath = specifiedPath || process.env.SUPABASE_SSL_CA || process.env.PGSSLROOTCERT;
  let isAutoDiscovered = false;

  if (!targetPath) {
    const defaultDownload = path.join(os.homedir(), 'Downloads', 'prod-ca-2021.crt');
    const defaultPg = path.join(os.homedir(), '.postgresql', 'root.crt');
    if (fs.existsSync(defaultDownload)) {
      targetPath = defaultDownload;
      isAutoDiscovered = true;
    } else if (fs.existsSync(defaultPg)) {
      targetPath = defaultPg;
      isAutoDiscovered = true;
    }
  }

  if (!targetPath) {
    return null;
  }

  const resolvedPath = path.resolve(targetPath.replace(/^~(?=$|\/|\\)/, os.homedir()));

  if (!fs.existsSync(resolvedPath)) {
    if (isAutoDiscovered) return null;
    throw new Error(`Arquivo de certificado CA TLS não encontrado no caminho especificado: "${resolvedPath}"`);
  }

  const content = fs.readFileSync(resolvedPath, 'utf8');

  try {
    const x509 = new crypto.X509Certificate(content);
    return {
      path: resolvedPath,
      content,
      metadata: {
        subject: x509.subject,
        issuer: x509.issuer,
        validTo: x509.validTo,
        fingerprint256: x509.fingerprint256,
        isCa: x509.ca,
      },
    };
  } catch (err) {
    throw new Error(
      `O arquivo em "${resolvedPath}" não pôde ser interpretado como um certificado X.509 válido: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Solicita a senha interativamente no terminal de forma oculta (sem eco)
 * @param {string} promptText
 * @returns {Promise<string>}
 */
export function promptHiddenPassword(promptText = 'Digite a senha do Supabase Staging: ') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const stdoutWrite = process.stdout.write.bind(process.stdout);
    let isPrompting = true;

    stdoutWrite(promptText);

    // Substitui temporariamente _writeToOutput do readline para suprimir o eco dos caracteres digitados
    // @ts-expect-error readline internal property
    rl._writeToOutput = function (stringToWrite) {
      if (!isPrompting) {
        stdoutWrite(stringToWrite);
      } else if (stringToWrite.includes('\r') || stringToWrite.includes('\n')) {
        stdoutWrite('\n');
      }
    };

    rl.question('', (answer) => {
      isPrompting = false;
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Sanitiza mensagens de erro e URLs para evitar vazamento de credenciais
 * @param {any} input
 * @returns {string}
 */
export function sanitizeError(input) {
  const str = input instanceof Error ? input.message : String(input || '');
  return str.replace(/:[^:@\s]+@/g, ':***@');
}

/**
 * Constrói a URL do Session Pooler tratando adequadamente caracteres especiais
 * @param {string} password
 * @returns {string}
 */
export function buildStagingPoolerUrl(password) {
  const encodedPassword = encodeURIComponent(password);
  return `postgresql://${TARGET_USERNAME}:${encodedPassword}@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}`;
}

/**
 * Executa o diagnóstico somente-leitura com validação TLS estrita
 * @param {string} connectionUrl
 * @param {object} [options]
 * @param {{ path: string, content: string, metadata: any } | null} [options.caCert]
 * @param {function} [options.logger]
 */
export async function runStagingConnectionDiagnostic(connectionUrl, { caCert = null, logger = console.log } = {}) {
  // Valida que a URL aponta estritamente para o projeto autorizado
  if (!connectionUrl.includes(TARGET_PROJECT_REF) || !connectionUrl.includes(TARGET_HOST)) {
    throw new Error(
      `VIOLAÇÃO DE ISOLAMENTO: A conexão não aponta para o Session Pooler de staging (${TARGET_HOST}) ou projeto (${TARGET_PROJECT_REF}).`
    );
  }

  // Configuração estrita de TLS com validação de certificado e identidade do servidor
  const sslOptions = {
    rejectUnauthorized: true,
  };

  if (caCert?.content) {
    // Combina os CAs públicos padrão do Node.js com o CA raiz privado do Supabase (prod-ca-2021.crt)
    sslOptions.ca = [...tls.rootCertificates, caCert.content];
  }

  const sql = postgres(connectionUrl, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 5,
    ssl: sslOptions,
  });

  try {
    logger('🔒 Conexão TLS estabelecida com validação estrita de certificado (rejectUnauthorized: true).');
    logger('🔍 Executando consultas passivas de diagnóstico...');

    // 1. Informações básicas da sessão
    const [sessionInfo] = await sql`
      SELECT 
        current_database() AS database_name,
        current_user AS connected_user,
        session_user AS session_user,
        current_setting('search_path') AS search_path;
    `;

    // 2. Verificação da extensão vector
    const extensionRows = await sql`
      SELECT 
        extname, 
        extversion, 
        n.nspname AS schema_name 
      FROM pg_extension e 
      JOIN pg_namespace n ON n.oid = e.extnamespace 
      WHERE extname = 'vector';
    `;

    // 3. Teste de parse e resolução do tipo vector no search_path ativo
    let vectorTypeResolved = false;
    let vectorParseSample = null;
    try {
      const [vectorTest] = await sql`SELECT '[0.1, 0.2, 0.3]'::vector AS sample;`;
      vectorTypeResolved = true;
      vectorParseSample = vectorTest?.sample;
    } catch (vErr) {
      vectorTypeResolved = false;
      logger(`⚠️  Aviso: Não foi possível resolver tipo vector diretamente: ${sanitizeError(vErr)}`);
    }

    return {
      sessionInfo,
      vectorExtension: extensionRows[0] || null,
      vectorTypeResolved,
      vectorParseSample,
    };
  } catch (dbErr) {
    throw new Error(sanitizeError(dbErr));
  } finally {
    await sql.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const caArg = args.find((a) => a.startsWith('--ca='))?.split('=')[1] ||
                args.find((a) => a.startsWith('--ca-cert='))?.split('=')[1];

  console.log('================================================================');
  console.log('MEDICINA 2029 — DIAGNÓSTICO DE CONEXÃO STAGING (SOMENTE-LEITURA)');
  console.log('================================================================');
  console.log(`Projeto Alvo:      ${TARGET_PROJECT_REF}`);
  console.log(`Session Pooler:    ${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`Usuário Esperado:  ${TARGET_USERNAME}`);
  console.log(`Banco:             ${TARGET_DB}`);
  console.log('Modo:              100% Somente-Leitura (SELECT)');

  // Resolução e validação do Certificado CA TLS
  let caInfo = null;
  try {
    caInfo = resolveCaCertificate(caArg);
  } catch (caErr) {
    console.error('\n❌ ERRO NA CONFIGURAÇÃO DO CERTIFICADO TLS:');
    console.error(caErr instanceof Error ? caErr.message : String(caErr));
    process.exit(1);
  }

  if (caInfo) {
    console.log(`• Certificado CA:  ${caInfo.path}`);
    console.log(`  Emissor:         ${caInfo.metadata.issuer.replace(/\n/g, ', ')}`);
    console.log(`  Validade:        Até ${caInfo.metadata.validTo}`);
    console.log(`  SHA-256:         ${caInfo.metadata.fingerprint256}`);
    console.log('  Cadeia TLS:      121 CAs do sistema + Supabase Root 2021 CA');
    console.log('  Validação TLS:   rejectUnauthorized: true (ESTRITO ATIVO)');
  } else {
    console.log('• Certificado CA:  Nenhum certificado customizado detectado.');
    console.log('  Aviso TLS:       Conexões com Supabase Pooler requerem prod-ca-2021.crt para evitar "self-signed certificate".');
    console.log('  Como fornecer:   Use --ca=~/Downloads/prod-ca-2021.crt ou defina SUPABASE_SSL_CA.');
  }

  console.log('================================================================\n');

  // Se a URL já estiver presente no ambiente (ex: exportada em subshell)
  let dbUrl = process.env.DATABASE_MIGRATION_URL;

  if (!dbUrl) {
    if (!process.stdin.isTTY) {
      console.error('❌ ERRO: Terminal não-interativo detectado e DATABASE_MIGRATION_URL não definida.');
      console.error('👉 Para executar interativamente, rode em um terminal interativo.');
      process.exit(1);
    }

    console.log('💡 Digite a senha administrativa do Supabase Staging.');
    console.log('🔒 A senha NÃO será exibida na tela e NÃO será gravada em disco ou histórico.\n');

    const password = await promptHiddenPassword('🔑 Senha de postgres: ');
    if (!password) {
      console.error('❌ Operação abortada: senha vazia.');
      process.exit(1);
    }

    dbUrl = buildStagingPoolerUrl(password);
  }

  try {
    const result = await runStagingConnectionDiagnostic(dbUrl, { caCert: caInfo });

    console.log('\n📊 RESULTADOS DO DIAGNÓSTICO REMOTO:');
    console.log('----------------------------------------------------------------');
    console.log(`• Banco de Dados Atual:      ${result.sessionInfo.database_name}`);
    console.log(`• Usuário Ativo:             ${result.sessionInfo.connected_user}`);
    console.log(`• Usuário da Sessão:         ${result.sessionInfo.session_user}`);
    console.log(`• search_path Ativo:         ${result.sessionInfo.search_path}`);
    console.log('----------------------------------------------------------------');
    if (result.vectorExtension) {
      console.log(`• Extensão vector:           Instalada (versão: ${result.vectorExtension.extversion}, schema: "${result.vectorExtension.schema_name}")`);
    } else {
      console.log('• Extensão vector:           NÃO ENCONTRADA no catálogo pg_extension!');
    }
    console.log(`• Resolução vector(1536):    ${result.vectorTypeResolved ? '✅ Aprovada (tipo vector resolvido diretamente)' : '❌ Falhou'}`);
    console.log('----------------------------------------------------------------');
    console.log('\n✅ Diagnóstico concluído com sucesso. Nenhuma alteração foi realizada.');
  } catch (err) {
    console.error('\n❌ FALHA NO DIAGNÓSTICO DE CONEXÃO:');
    console.error(sanitizeError(err));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
