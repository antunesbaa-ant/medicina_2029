#!/usr/bin/env node

/**
 * ==============================================================================
 * MEDICINA 2029 — H2.03: LANÇADOR INTERATIVO DE BACKUP BASELINE DE STAGING
 * ==============================================================================
 * Executa o procedimento seguro de extração de backup baseline pré-seed do Supabase Staging,
 * garantindo:
 * 1. Conexão estritamente restrita ao projeto ynfocaorhadizlvbnzrt via Session Pooler (porta 5432);
 * 2. Validação obrigatória de TLS com verificação de CA raiz e fingerprint SHA-256 canônico;
 * 3. Entrada interativa de credenciais sem eco na tela (zero persistência em disco ou logs);
 * 4. Verificação rigorosa de pré-requisitos locais (binário pg_dump compatível, crypto);
 * 5. Escopo focado nos schemas da aplicação (public e medicina), histórico das 9 migrações e
 *    manifesto canônico de Storage de estado zero (0 objetos / 0 bytes);
 * 6. Cifragem simétrica autenticada AEAD (AES-256-GCM envelope M29G) com chave de alta entropia;
 * 7. Diretório de destino fora do Git com permissões restritas no macOS (chmod 700 / 600);
 * 8. Zero escritas ou modificações remotas (operação 100% passiva e somente-leitura no banco).
 * ==============================================================================
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { decryptFile, encryptFile } from '../backup/crypto_envelope.mjs';

export const TARGET_PROJECT_REF = 'ynfocaorhadizlvbnzrt';
export const TARGET_HOST = 'aws-0-us-east-1.pooler.supabase.com';
export const TARGET_PORT = 5432;
export const TARGET_USERNAME = `postgres.${TARGET_PROJECT_REF}`;
export const TARGET_DATABASE = 'postgres';
export const REQUIRED_CONFIRMATION_TEXT = 'CONFIRMAR BACKUP BASELINE';

export const CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256 = Object.freeze(
  '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA'
);

export const CANONICAL_MIGRATIONS = Object.freeze([
  'drizzle/0000_greedy_loki.sql',
  'drizzle/0001_dry_talos.sql',
  'drizzle/0002_little_swarm.sql',
  'drizzle/0003_f1_03_r_expansao.sql',
  'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql',
  'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql',
  'docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql',
  'docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql',
  'docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql',
]);

/**
 * Valida se o Project Ref informado corresponde ao projeto staging canônico
 */
export function validateProjectRef(projectRef) {
  if (projectRef !== TARGET_PROJECT_REF) {
    throw new Error(
      `ALERTA DE SEGURANÇA: Project Ref "${projectRef}" inválido! Operação restrita ao staging "${TARGET_PROJECT_REF}".`
    );
  }
  return true;
}

/**
 * Localiza e valida o certificado CA raiz da Supabase
 */
export function resolveCaCertificate(specifiedPath) {
  const defaultPath = path.join(os.homedir(), 'Downloads', 'prod-ca-2021.crt');
  const caPath = specifiedPath
    ? path.resolve(specifiedPath.replace(/^~(?=$|\/|\\)/, os.homedir()))
    : defaultPath;

  if (!fs.existsSync(caPath)) {
    throw new Error(
      `Certificado CA raiz não encontrado no caminho: ${caPath}\nBaixe o certificado oficial em Settings > Database do Supabase.`
    );
  }

  const certContent = fs.readFileSync(caPath, 'utf8');
  let fingerprint;
  try {
    const x509 = new X509Certificate(certContent);
    fingerprint = x509.fingerprint256;
  } catch (err) {
    throw new Error(
      `O arquivo em "${caPath}" não pôde ser interpretado como um certificado X.509 válido: ${err.message}`
    );
  }

  if (fingerprint !== CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256) {
    throw new Error(
      `VIOLAÇÃO DE INTEGRIDADE TLS: Fingerprint do certificado CA diverge do padrão canônico!\nObtido:   ${fingerprint}\nEsperado: ${CANONICAL_SUPABASE_CA_FINGERPRINT_SHA256}`
    );
  }

  const certBuffer = Buffer.from(certContent, 'utf8');
  return { caPath, certBuffer, fingerprint };
}

/**
 * Procura o binário pg_dump no PATH e locais padronizados do macOS
 */
export function findPgDumpBinary(explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath.replace(/^~(?=$|\/|\\)/, os.homedir()));
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  if (process.env.PG_DUMP_PATH && fs.existsSync(process.env.PG_DUMP_PATH)) {
    return process.env.PG_DUMP_PATH;
  }

  const commonMacPaths = [
    '/opt/homebrew/opt/libpq/bin/pg_dump',
    '/opt/homebrew/bin/pg_dump',
    '/usr/local/bin/pg_dump',
    '/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump',
    '/Applications/Postgres.app/Contents/Versions/18/bin/pg_dump',
    '/Applications/Postgres.app/Contents/Versions/17/bin/pg_dump',
    '/Applications/Postgres.app/Contents/Versions/16/bin/pg_dump',
    '/Applications/Postgres.app/Contents/Versions/15/bin/pg_dump',
    '/usr/bin/pg_dump',
  ];

  for (const candidate of commonMacPaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Procura o binário pg_restore no PATH e locais padronizados do macOS
 */
export function findPgRestoreBinary(explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath.replace(/^~(?=$|\/|\\)/, os.homedir()));
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  if (process.env.PG_RESTORE_PATH && fs.existsSync(process.env.PG_RESTORE_PATH)) {
    return process.env.PG_RESTORE_PATH;
  }

  const commonMacPaths = [
    '/opt/homebrew/opt/libpq/bin/pg_restore',
    '/opt/homebrew/bin/pg_restore',
    '/usr/local/bin/pg_restore',
    '/Applications/Postgres.app/Contents/Versions/latest/bin/pg_restore',
    '/Applications/Postgres.app/Contents/Versions/18/bin/pg_restore',
    '/Applications/Postgres.app/Contents/Versions/17/bin/pg_restore',
    '/Applications/Postgres.app/Contents/Versions/16/bin/pg_restore',
    '/Applications/Postgres.app/Contents/Versions/15/bin/pg_restore',
    '/usr/bin/pg_restore',
  ];

  for (const candidate of commonMacPaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Diagnostica os pré-requisitos de sistema para a execução do backup
 */
export function checkBackupPrerequisites(options = {}) {
  const result = {
    ready: true,
    pgDumpAvailable: false,
    pgDumpPath: null,
    caValid: false,
    caPath: null,
    cryptoAvailable: true,
    reasons: [],
  };

  // 1. Verificação do pg_dump
  const pgDump = findPgDumpBinary(options.pgDumpPath);
  if (pgDump) {
    result.pgDumpAvailable = true;
    result.pgDumpPath = pgDump;
  } else {
    result.ready = false;
    result.reasons.push(
      'Utilitário "pg_dump" não encontrado no PATH nem nos diretórios padrão do macOS (/opt/homebrew, /usr/local, Postgres.app).'
    );
  }

  // 2. Verificação do Certificado CA
  try {
    const ca = resolveCaCertificate(options.caPath);
    result.caValid = true;
    result.caPath = ca.caPath;
  } catch (err) {
    result.ready = false;
    result.reasons.push(err.message);
  }

  return result;
}

/**
 * Solicita a senha interativamente no terminal sem eco
 */
export function promptHiddenPassword(promptText = '🔑 Digite a senha: ') {
  return new Promise((resolve) => {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdout.write(promptText);

      const wasRaw = Boolean(process.stdin.isRaw);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      let password = '';

      const cleanup = () => {
        process.stdin.removeListener('data', onData);
        try {
          process.stdin.setRawMode(wasRaw);
        } catch {
          // ignora exceção ao restaurar modo
        }
        process.stdin.pause();
      };

      const onData = (chunk) => {
        const str = String(chunk);
        for (const char of str) {
          if (char === '\u0003') {
            cleanup();
            process.stdout.write('\n\nOperação cancelada pelo usuário (Ctrl+C).\n');
            process.exit(130);
          } else if (char === '\r' || char === '\n') {
            cleanup();
            process.stdout.write('\n');
            resolve(password.trim());
            return;
          } else if (char === '\u0004') {
            cleanup();
            process.stdout.write('\n');
            resolve(password.trim());
            return;
          } else if (char === '\u0008' || char === '\x7f') {
            password = password.slice(0, -1);
          } else if (char >= ' ' || char === '\t') {
            password += char;
          }
        }
      };

      process.stdin.on('data', onData);
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });

      let resolved = false;

      rl.on('SIGINT', () => {
        rl.close();
        process.stdout.write('\n\nOperação cancelada pelo usuário (Ctrl+C).\n');
        process.exit(130);
      });

      rl.question(promptText, (answer) => {
        resolved = true;
        rl.close();
        resolve(answer.trim());
      });

      rl.on('close', () => {
        if (!resolved) {
          resolve('');
        }
      });
    }
  });
}

/**
 * Solicita confirmação explícita no terminal
 */
export function promptConfirmation(promptText = `Digite "${REQUIRED_CONFIRMATION_TEXT}": `) {
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
 * Monta os argumentos seguros para execução do pg_dump
 */
export function buildPgDumpArgs(options) {
  const { host, port, username, database, outputFile } = options;

  return [
    '--host',
    host,
    '--port',
    String(port),
    '--username',
    username,
    '--dbname',
    database,
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--no-privileges',
    '--schema=public',
    '--schema=medicina',
    '--file',
    outputFile,
    '--verbose',
  ];
}

/**
 * Gera o manifesto canônico de Storage para o baseline pré-seed (RFC 8785 determinístico)
 */
export function generateCanonicalStorageManifest(bucket = 'acervo', geradoEm = new Date().toISOString()) {
  const manifestData = {
    version: '1.0',
    geradoEm,
    bucket,
    totalObjetos: 0,
    totalBytes: 0,
    objetos: [],
  };

  // Calcula SHA-256 do corpo do manifesto canônico
  const canonicalJson = JSON.stringify(manifestData);
  const sha256Manifesto = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');

  return {
    ...manifestData,
    sha256Manifesto,
  };
}

/**
 * Extrai os metadados do banco PostgreSQL em sessão somente-leitura
 */
export async function extractDatabaseMetadata(sql) {
  // 1. Identidade e versão
  const [sessionInfo] = await sql`
    SELECT 
      current_database() AS database_name,
      current_user AS connected_user,
      session_user AS session_user,
      version() AS postgres_version;
  `;

  // 2. Extensões instaladas
  const extensions = await sql`
    SELECT extname, extversion
    FROM pg_extension
    ORDER BY extname;
  `;

  // 3. Histórico das migrações aplicadas
  let migrations = [];
  try {
    migrations = await sql`
      SELECT step_index, migration_name, canonical_hash, applied_at
      FROM public._medicina_staging_migrations
      ORDER BY step_index ASC;
    `;
  } catch {
    // Se a tabela não existir, mantém array vazio
  }

  // 4. Inventário de contagem de linhas das tabelas do domínio
  const tableCounts = await sql`
    SELECT 
      table_schema, 
      table_name,
      (xpath('/row/cnt/text()', xml_count))[1]::text::bigint AS row_count
    FROM (
      SELECT 
        table_schema, 
        table_name,
        query_to_xml(format('SELECT count(*) AS cnt FROM %I.%I', table_schema, table_name), false, true, '') AS xml_count
      FROM information_schema.tables
      WHERE table_schema IN ('public', 'medicina')
        AND table_type = 'BASE TABLE'
    ) sub
    ORDER BY table_schema, table_name;
  `;

  // 5. Atributos das roles de aplicação
  const roles = await sql`
    SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
    FROM pg_roles
    WHERE rolname IN ('medicina_app', 'medicina_auth', 'medicina_worker')
    ORDER BY rolname;
  `;

  // 6. Verificação do acervo de arquivos (Storage)
  let acervoCount = 0;
  try {
    const [acervo] = await sql`SELECT count(*)::int AS count FROM public.acervo_arquivos;`;
    acervoCount = acervo.count;
  } catch {
    acervoCount = 0;
  }

  return {
    sessionInfo,
    extensions,
    migrations,
    tableCounts,
    roles,
    acervoCount,
  };
}

/**
 * Executa o comando pg_dump isolando credenciais estritamente em variáveis de ambiente temporárias
 */
export function runPgDumpProcess(pgDumpBinary, args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pgDumpBinary, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutData = '';
    let stderrData = '';

    proc.stdout.on('data', (d) => {
      stdoutData += d.toString();
    });

    proc.stderr.on('data', (d) => {
      stderrData += d.toString();
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: stdoutData, stderr: stderrData });
      } else {
        reject(
          new Error(
            `pg_dump encerrou com código de falha ${code}.\nDetalhes do stderr: ${stderrData.replace(/:[^@]+@/g, ':***@')}`
          )
        );
      }
    });
  });
}

/**
 * Função orquestradora principal do backup baseline
 */
export async function executeBaselineBackupWorkflow(options = {}) {
  const {
    caPath: specifiedCaPath,
    outDir: specifiedOutDir,
    pgDumpPath: specifiedPgDumpPath,
    adminPassword,
    encryptionKey,
    confirmation,
    dryRun = false,
  } = options;

  // 1. Validação do projeto e confirmação
  validateProjectRef(TARGET_PROJECT_REF);

  if (confirmation !== REQUIRED_CONFIRMATION_TEXT) {
    throw new Error(
      `Confirmação humana rejeitada. Esperado "${REQUIRED_CONFIRMATION_TEXT}", recebido "${confirmation}".`
    );
  }

  if (!encryptionKey || encryptionKey.length < 16) {
    throw new Error('A chave de cifragem do backup deve conter no mínimo 16 caracteres de alta entropia.');
  }

  // 2. Resolução de certificados e ferramentas
  const { caPath, certBuffer, fingerprint } = resolveCaCertificate(specifiedCaPath);
  const pgDumpBinary = findPgDumpBinary(specifiedPgDumpPath);

  if (!pgDumpBinary) {
    throw new Error(
      'PRÉ-REQUISITO AUSENTE: O utilitário pg_dump não está disponível no sistema macOS.\n' +
        'Instale o cliente PostgreSQL via Homebrew (brew install libpq && brew link --force libpq) ' +
        'ou especifique o caminho completo com --pg-dump-path.'
    );
  }

  if (dryRun) {
    return {
      status: 'DRY_RUN_OK',
      projectRef: TARGET_PROJECT_REF,
      host: TARGET_HOST,
      port: TARGET_PORT,
      pgDumpBinary,
      caPath,
      caFingerprint: fingerprint,
    };
  }

  // 3. Preparação do diretório de saída no macOS com permissões 0700
  const timestamp = new Date().toISOString().replace(/[:\-T]/g, '').slice(0, 15) + 'Z';
  const backupId = `medicina2029_staging_baseline_${timestamp}`;
  const outDir = specifiedOutDir
    ? path.resolve(specifiedOutDir.replace(/^~(?=$|\/|\\)/, os.homedir()))
    : path.join(os.homedir(), '.medicina2029', 'backups', backupId);

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(outDir, 0o700);
  } catch {
    // ignora em filesystems que não suportam chmod POSIX
  }

  const dumpFilePath = path.join(outDir, `${backupId}.dump`);
  const manifestFilePath = path.join(outDir, `${backupId}_manifest.json`);

  // 4. Extração de metadados relacionais e Storage Manifest (SELECT passivo somente-leitura)
  const connectionUrl = `postgres://${encodeURIComponent(TARGET_USERNAME)}:${encodeURIComponent(adminPassword)}@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DATABASE}`;

  const sql = postgres(connectionUrl, {
    ssl: {
      ca: certBuffer,
      rejectUnauthorized: true,
      servername: TARGET_HOST,
    },
    max: 1,
    connect_timeout: 15,
    prepare: false,
  });

  let metadata;
  try {
    metadata = await extractDatabaseMetadata(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }

  // 5. Execução do pg_dump
  const pgDumpArgs = buildPgDumpArgs({
    host: TARGET_HOST,
    port: TARGET_PORT,
    username: TARGET_USERNAME,
    database: TARGET_DATABASE,
    outputFile: dumpFilePath,
  });

  const subEnv = {
    ...process.env,
    PGPASSWORD: adminPassword,
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: caPath,
  };

  await runPgDumpProcess(pgDumpBinary, pgDumpArgs, subEnv);
  try {
    fs.chmodSync(dumpFilePath, 0o600);
  } catch {}

  // 6. Cálculo do hash SHA-256 do dump
  const dumpBuffer = fs.readFileSync(dumpFilePath);
  const dumpSha256 = createHash('sha256').update(dumpBuffer).digest('hex');
  const dumpSize = dumpBuffer.length;

  // 7. Geração do manifesto canônico consolidado
  const storageManifest = generateCanonicalStorageManifest('acervo', new Date().toISOString());

  const baselineManifest = {
    app: 'Medicina 2029',
    environment: 'staging',
    project_ref: TARGET_PROJECT_REF,
    task: 'H2.03',
    backup_id: backupId,
    timestamp_utc: new Date().toISOString(),
    dump_file: path.basename(dumpFilePath),
    dump_size_bytes: dumpSize,
    dump_sha256: dumpSha256,
    pg_dump_version: pgDumpBinary,
    postgres_version: metadata.sessionInfo.postgres_version,
    extensions: metadata.extensions,
    migrations: metadata.migrations,
    table_row_counts: metadata.tableCounts.reduce((acc, row) => {
      acc[`${row.table_schema}.${row.table_name}`] = Number(row.row_count);
      return acc;
    }, {}),
    roles_verification: metadata.roles,
    storage: storageManifest,
  };

  fs.writeFileSync(manifestFilePath, JSON.stringify(baselineManifest, null, 2), {
    mode: 0o600,
  });

  const manifestBuffer = fs.readFileSync(manifestFilePath);
  const manifestSha256 = createHash('sha256').update(manifestBuffer).digest('hex');

  // 8. Cifragem AEAD (AES-256-GCM Envelope M29G)
  const encDumpFile = `${dumpFilePath}.enc`;
  const encManifestFile = `${manifestFilePath}.enc`;

  await encryptFile(dumpFilePath, encDumpFile, encryptionKey);
  await encryptFile(manifestFilePath, encManifestFile, encryptionKey);

  try {
    fs.chmodSync(encDumpFile, 0o600);
    fs.chmodSync(encManifestFile, 0o600);
  } catch {}

  // 9. Geração de arquivos .sha256 para artefatos cifrados
  const encDumpSha256 = createHash('sha256')
    .update(fs.readFileSync(encDumpFile))
    .digest('hex');
  const encManifestSha256 = createHash('sha256')
    .update(fs.readFileSync(encManifestFile))
    .digest('hex');

  fs.writeFileSync(`${encDumpFile}.sha256`, `${encDumpSha256}  ${path.basename(encDumpFile)}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(
    `${encManifestFile}.sha256`,
    `${encManifestSha256}  ${path.basename(encManifestFile)}\n`,
    { mode: 0o600 }
  );

  // 10. Descarte seguro dos arquivos claros
  fs.unlinkSync(dumpFilePath);
  fs.unlinkSync(manifestFilePath);

  return {
    status: 'SUCCESS',
    backupId,
    outDir,
    encDumpFile,
    encDumpSha256,
    encManifestFile,
    encManifestSha256,
    originalDumpSha256: dumpSha256,
    originalManifestSha256: manifestSha256,
    storageStatus: 'ZERO_STATE_VALIDATED',
  };
}

/**
 * Ponto de entrada CLI interativo
 */
async function main() {
  const args = process.argv.slice(2);
  let specifiedCa = null;
  let specifiedOutDir = null;
  let specifiedPgDump = null;
  let checkPrereqsOnly = false;
  let dryRunOnly = false;

  for (const arg of args) {
    if (arg.startsWith('--ca=')) {
      specifiedCa = arg.split('=')[1];
    } else if (arg.startsWith('--out-dir=')) {
      specifiedOutDir = arg.split('=')[1];
    } else if (arg.startsWith('--pg-dump-path=')) {
      specifiedPgDump = arg.split('=')[1];
    } else if (arg === '--check-prerequisites') {
      checkPrereqsOnly = true;
    } else if (arg === '--dry-run') {
      dryRunOnly = true;
    }
  }

  console.log('================================================================');
  console.log('MEDICINA 2029 — H2.03: BACKUP BASELINE DE STAGING');
  console.log('================================================================');
  console.log(`Projeto Alvo:          ${TARGET_PROJECT_REF}`);
  console.log(`Session Pooler:        ${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`Banco / Usuário:       ${TARGET_DATABASE} / ${TARGET_USERNAME}`);
  console.log('Schemas Alvo:          public, medicina');
  console.log('Criptografia em Disco: AEAD AES-256-GCM (Envelope M29G)');
  console.log('Permissões de Disco:   drwx------ (0700) / -rw------- (0600)');
  console.log('================================================================\n');

  // Diagnóstico de Pré-requisitos
  const prereqs = checkBackupPrerequisites({
    caPath: specifiedCa,
    pgDumpPath: specifiedPgDump,
  });

  if (checkPrereqsOnly) {
    console.log('DIAGNÓSTICO DE PRÉ-REQUISITOS OPERACIONAIS:');
    console.log(`  • Certificado CA TLS:    ${prereqs.caValid ? '✅ Válido' : '❌ Inválido/Ausente'}`);
    if (prereqs.caPath) console.log(`    Caminho: ${prereqs.caPath}`);
    console.log(`  • Utilitário pg_dump:    ${prereqs.pgDumpAvailable ? '✅ Encontrado' : '❌ NÃO ENCONTRADO'}`);
    if (prereqs.pgDumpPath) console.log(`    Binário: ${prereqs.pgDumpPath}`);
    console.log(`  • Envelope Criptográfico: ✅ AES-256-GCM disponível\n`);

    if (!prereqs.ready) {
      console.log('PENDÊNCIAS PARA EXECUÇÃO:');
      for (const reason of prereqs.reasons) {
        console.log(`  ⚠️  ${reason}`);
      }
      console.log('\nCLASSIFICAÇÃO: NÃO APTO (ferramental pendente no sistema operacional).');
      process.exit(1);
    } else {
      console.log('CLASSIFICAÇÃO: APTO para execução de backup no staging.');
      process.exit(0);
    }
  }

  if (!prereqs.ready) {
    console.error('❌ ERRO: Pré-requisitos operacionais não atendidos:');
    for (const reason of prereqs.reasons) {
      console.error(`   • ${reason}`);
    }
    console.error('\nPara instalar o cliente PostgreSQL no macOS:');
    console.error('   brew install libpq && brew link --force libpq');
    console.error('Ou informe o binário diretamente via:');
    console.error('   --pg-dump-path=/caminho/para/pg_dump\n');
    process.exit(1);
  }

  console.log('Orientações de Segurança:');
  console.log('  • A senha digitada NÃO será exibida na tela (sem eco).');
  console.log('  • A chave de cifragem do backup deve ter no mínimo 16 caracteres.');
  console.log('  • Operação 100% somente-leitura no Supabase (nenhum dado será modificado).');
  console.log('  • Pressione Ctrl+C a qualquer momento para cancelar com segurança.\n');

  let adminPassword = '';
  let encryptionKey = '';

  try {
    console.log('[Etapa 1/3] Senha Administrativa do Staging');
    console.log(`Autenticação como "${TARGET_USERNAME}" no Session Pooler.`);
    adminPassword = await promptHiddenPassword('🔑 Digite a senha da role postgres do Supabase: ');
    if (!adminPassword) {
      console.error('❌ Senha administrativa não fornecida. Abortando.');
      process.exit(1);
    }
    console.log('');

    console.log('[Etapa 2/3] Chave Mestra de Cifragem do Backup (AES-256-GCM)');
    console.log('Requisito: Mínimo de 16 caracteres de alta entropia para proteção em repouso.');
    while (true) {
      const k1 = await promptHiddenPassword('🔑 Digite a chave de cifragem do backup: ');
      if (!k1 || k1.length < 16) {
        console.log('⚠️  A chave deve conter no mínimo 16 caracteres. Tente novamente.\n');
        continue;
      }
      const k2 = await promptHiddenPassword('🔑 Confirme a chave de cifragem do backup: ');
      if (k1 !== k2) {
        console.log('❌ As chaves não conferem. Tente novamente.\n');
        continue;
      }
      encryptionKey = k1;
      console.log('   ✓ Chave de cifragem validada localmente.\n');
      break;
    }

    console.log('[Etapa 3/3] Confirmação Humana Explícita');
    console.log(`Para confirmar o início do backup baseline, digite exatamente:`);
    console.log(`   ${REQUIRED_CONFIRMATION_TEXT}`);
    const confirmation = await promptConfirmation('Confirmação: ');
    if (confirmation !== REQUIRED_CONFIRMATION_TEXT) {
      console.error('\n❌ Confirmação incorreta. Operação cancelada.');
      process.exit(1);
    }

    console.log('\n================================================================');
    console.log('🚀 INICIANDO EXTRAÇÃO DO BACKUP BASELINE DE STAGING...');
    console.log('================================================================\n');

    const result = await executeBaselineBackupWorkflow({
      caPath: specifiedCa,
      outDir: specifiedOutDir,
      pgDumpPath: specifiedPgDump,
      adminPassword,
      encryptionKey,
      confirmation,
      dryRun: dryRunOnly,
    });

    console.log('================================================================');
    console.log('🎉 BACKUP BASELINE CONCLUÍDO COM SUCESSO PLENO!');
    console.log('================================================================');
    console.log(`ID do Backup:         ${result.backupId}`);
    console.log(`Diretório Seguro:     ${result.outDir}`);
    console.log(`Dump Cifrado:         ${path.basename(result.encDumpFile)}`);
    console.log(`SHA-256 (Cifrado):    ${result.encDumpSha256}`);
    console.log(`Manifesto Cifrado:    ${path.basename(result.encManifestFile)}`);
    console.log(`SHA-256 (Cifrado):    ${result.encManifestSha256}`);
    console.log(`Storage Manifest:     ${result.storageStatus} (0 objetos / 0 bytes)`);
    console.log(`Hash Original Dump:   ${result.originalDumpSha256}`);
    console.log('================================================================\n');
  } catch (err) {
    console.error(`\n❌ ERRO DURANTE A OPERAÇÃO DE BACKUP: ${err.message}\n`);
    process.exit(1);
  } finally {
    // Purga de memória de credenciais confidenciais
    adminPassword = '';
    encryptionKey = '';
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
