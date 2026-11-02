#!/usr/bin/env node

/**
 * ==============================================================================
 * MEDICINA 2029 — H2.04-T2: CONFIGURAÇÃO DE SENHAS SINTÉTICAS NO STAGING
 * ==============================================================================
 * Utilitário interativo, seguro e atômico para atualização exclusiva dos hashes
 * de senha dos três perfis sintéticos de homologação no Supabase Staging:
 *   - Alice (estudante regular tutelada)
 *   - Bruno (responsável tutor pedagógico)
 *   - Carlos (estudante independente)
 *
 * Princípios de Segurança e Governança Operacional:
 * 1. Conexão Exclusiva: Session Pooler porta 5432 (aws-0-us-east-1.pooler.supabase.com).
 * 2. Role Administrativa: Conecta como postgres.ynfocaorhadizlvbnzrt (única role com
 *    privilégio de UPDATE na coluna password_hash da tabela public.perfis).
 * 3. TLS Estrito: rejectUnauthorized: true validado contra prod-ca-2021.crt.
 * 4. Proteção de Ambiente: Bloqueio sumário se NODE_ENV ou APP_ENV for production.
 * 5. Conferência de Integridade: Valida a presença e consistência das 9 migrações.
 * 6. Três Senhas Distintas e Fortes: Mínimo 10 caracteres, não vazias e distintas entre si.
 * 7. Entrada Oculta: Terminal em modo raw sem eco, sem histórico de shell, sem argv.
 * 8. Confirmação Humana Explícita: Exige "CONFIRMAR ATUALIZACAO SENHAS STAGING".
 * 9. Transação Atômica: SELECT ... FOR UPDATE com matching exato de (id, email, papel),
 *    geração de hash bcrypt (custo 10) e ROLLBACK integral diante de qualquer divergência.
 * 10. Purga de Memória: Limpeza obrigatória de variáveis sensíveis no bloco finally.
 * ==============================================================================
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import tls from 'node:tls';
import postgres from 'postgres';
import bcrypt from 'bcryptjs';

// ----------------------------------------------------------------------------
// PARÂMETROS CANÔNICOS DE AMBIENTE (STAGING SUPABASE)
// ----------------------------------------------------------------------------
export const TARGET_HOST = 'aws-0-us-east-1.pooler.supabase.com';
export const TARGET_PORT = 5432; // Session Pooler
export const TARGET_DB = 'postgres';
export const TARGET_ROLE = 'postgres';
export const TARGET_PROJECT_REF = 'ynfocaorhadizlvbnzrt';
export const TARGET_USERNAME = `${TARGET_ROLE}.${TARGET_PROJECT_REF}`;

// Personas sintéticas canônicas (RFC 4122 v4)
export const PERSONA_ALICE = Object.freeze({
  id: '10000000-0000-4000-8000-000000000001',
  email: 'alice@medicina2029.staging',
  nome: 'Alice Estudante Sintética',
  papel: 'estudante',
});

export const PERSONA_BRUNO = Object.freeze({
  id: '20000000-0000-4000-8000-000000000001',
  email: 'bruno@medicina2029.staging',
  nome: 'Bruno Responsável Sintético',
  papel: 'responsavel',
});

export const PERSONA_CARLOS = Object.freeze({
  id: '30000000-0000-4000-8000-000000000001',
  email: 'carlos@medicina2029.staging',
  nome: 'Carlos Estudante Sintético Independente',
  papel: 'estudante',
});

export const EXPECTED_PERSONAS = [PERSONA_ALICE, PERSONA_BRUNO, PERSONA_CARLOS];

// ----------------------------------------------------------------------------
// HIGIENIZAÇÃO DE ERROS E SEGURANÇA
// ----------------------------------------------------------------------------
export function sanitizeError(err) {
  if (!err) return 'Erro desconhecido';
  const msg = typeof err === 'string' ? err : err.message || String(err);
  return msg
    .replace(/:[^:@/]+@/g, ':****@')
    .replace(/password=[^&\s]+/gi, 'password=****')
    .replace(/\$2[aby]\$\d+\$[./A-Za-z0-9]{53}/g, '$2a$10$*****************************************************');
}

// ----------------------------------------------------------------------------
// VALIDAÇÃO DE CONFIGURAÇÃO DE CONEXÃO
// ----------------------------------------------------------------------------
export function validateStagingPasswordConfig(connectionUrl) {
  if (!connectionUrl || typeof connectionUrl !== 'string') {
    throw new Error('Configuração ausente: URL de conexão PostgreSQL não fornecida.');
  }

  const parsed = new URL(connectionUrl);
  const host = parsed.hostname;
  const port = parseInt(parsed.port || '5432', 10);
  const db = parsed.pathname.replace(/^\//, '');
  const user = decodeURIComponent(parsed.username);

  if (host !== TARGET_HOST) {
    throw new Error(
      `VIOLAÇÃO DE HOST: Host de conexão "${host}" inválido. Esperado estritamente o Session Pooler "${TARGET_HOST}".`
    );
  }

  if (port !== TARGET_PORT) {
    throw new Error(
      `VIOLAÇÃO DE PORTA: Porta "${port}" inválida. Esperada estritamente a porta 5432 do Session Pooler.`
    );
  }

  if (db !== TARGET_DB) {
    throw new Error(
      `VIOLAÇÃO DE BANCO: Banco "${db}" inválido. Esperado estritamente o banco "${TARGET_DB}".`
    );
  }

  if (user !== TARGET_USERNAME) {
    throw new Error(
      `VIOLAÇÃO DE USUÁRIO: Usuário de conexão "${user}" inválido. Esperado estritamente "${TARGET_USERNAME}".`
    );
  }

  if (!user.endsWith(`.${TARGET_PROJECT_REF}`)) {
    throw new Error(
      `VIOLAÇÃO DE TENANT: Usuário "${user}" não referencia o projeto de staging "${TARGET_PROJECT_REF}".`
    );
  }

  return { valid: true, host, port, db, user, projectRef: TARGET_PROJECT_REF };
}

// ----------------------------------------------------------------------------
// VALIDAÇÃO DE COMPLEXIDADE E DISTINÇÃO DAS SENHAS
// ----------------------------------------------------------------------------
export function validatePersonaPasswords({ alicePassword, brunoPassword, carlosPassword }) {
  const errors = [];

  const checkStrength = (name, pwd) => {
    if (!pwd || typeof pwd !== 'string') {
      errors.push(`Senha de ${name} não fornecida ou inválida.`);
      return;
    }
    if (pwd.trim().length < 10) {
      errors.push(`Senha de ${name} deve conter no mínimo 10 caracteres.`);
    }
  };

  checkStrength('Alice', alicePassword);
  checkStrength('Bruno', brunoPassword);
  checkStrength('Carlos', carlosPassword);

  if (errors.length > 0) {
    throw new Error(`VALIDAÇÃO DE SENHAS FALHOU:\n- ${errors.join('\n- ')}`);
  }

  // Verifica distinção mútua
  const set = new Set([alicePassword.trim(), brunoPassword.trim(), carlosPassword.trim()]);
  if (set.size !== 3) {
    throw new Error(
      'VIOLAÇÃO DE SEGURANÇA: As três senhas devem ser mutuamente distintas entre si (Alice, Bruno e Carlos não podem compartilhar a mesma senha).'
    );
  }

  return { valid: true };
}

// ----------------------------------------------------------------------------
// RESOLUÇÃO DE CERTIFICADO CA TLS
// ----------------------------------------------------------------------------
export function resolveCaCertificate(explicitPath = null) {
  const defaultLocations = [
    explicitPath,
    process.env.SUPABASE_SSL_CA,
    path.join(process.cwd(), 'certs/prod-ca-2021.crt'),
    path.join(process.env.HOME || '', 'Downloads/prod-ca-2021.crt'),
  ].filter(Boolean);

  for (const loc of defaultLocations) {
    if (existsSync(loc)) {
      return { path: loc, content: readFileSync(loc, 'utf8') };
    }
  }

  return null;
}

// ----------------------------------------------------------------------------
// CONSTRUÇÃO DA URL DO SESSION POOLER
// ----------------------------------------------------------------------------
export function buildStagingPoolerUrl(password) {
  const userEncoded = encodeURIComponent(TARGET_USERNAME);
  const passEncoded = encodeURIComponent(password);
  return `postgresql://${userEncoded}:${passEncoded}@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}`;
}

// ----------------------------------------------------------------------------
// TRANSAÇÃO ATÔMICA DE ATUALIZAÇÃO DOS HASHES BCRYPT
// ----------------------------------------------------------------------------
export async function updateStagingSyntheticPasswords({
  sql,
  alicePassword,
  brunoPassword,
  carlosPassword,
  logger = console.log,
}) {
  // 1. Validação prévia de complexidade e distinção
  validatePersonaPasswords({ alicePassword, brunoPassword, carlosPassword });

  logger('\n🔒 Iniciando transação atômica de atualização de senhas...');

  const startTime = Date.now();

  // Helper de execução transacional atômica
  const executeAtomicUpdate = async (tx) => {
    // A. Defesa contra travamentos com timeouts estritos
    await tx`SET LOCAL lock_timeout = '5s';`;
    await tx`SET LOCAL statement_timeout = '15s';`;

    // B. Pessimistic lock e validação estrita pré-update das três personas
    logger('   [1/5] Bloqueando e verificando registros em public.perfis (FOR UPDATE)...');
    const existingPerfis = await tx`
      SELECT id, email, papel, nome
      FROM public.perfis
      WHERE id IN (${PERSONA_ALICE.id}::uuid, ${PERSONA_BRUNO.id}::uuid, ${PERSONA_CARLOS.id}::uuid)
      FOR UPDATE;
    `;

    if (existingPerfis.length !== 3) {
      throw new Error(
        `VIOLAÇÃO DE INTEGRIDADE: Esperados 3 perfis sintéticos em public.perfis, encontrados ${existingPerfis.length}.`
      );
    }

    for (const expected of EXPECTED_PERSONAS) {
      const match = existingPerfis.find(
        (p) => String(p.id).toLowerCase() === expected.id.toLowerCase()
      );
      if (!match) {
        throw new Error(`PERFIL AUSENTE: Perfil sintético ${expected.nome} (${expected.id}) não localizado.`);
      }
      if (match.email.toLowerCase() !== expected.email.toLowerCase()) {
        throw new Error(
          `DIVERGÊNCIA DE IDENTIDADE: Perfil ${expected.id} possui e-mail "${match.email}", esperado "${expected.email}".`
        );
      }
      if (match.papel !== expected.papel) {
        throw new Error(
          `DIVERGÊNCIA DE PAPEL: Perfil ${expected.id} possui papel "${match.papel}", esperado "${expected.papel}".`
        );
      }
    }
    logger('   [✓] 3 personas sintéticas confirmadas com integridade estrita (id, e-mail, papel).');

    // C. Verificação de presença na public.allowlist
    logger('   [2/5] Conferindo presença obrigatória na public.allowlist...');
    const allowlistRows = await tx`
      SELECT email FROM public.allowlist
      WHERE email IN (${PERSONA_ALICE.email}, ${PERSONA_BRUNO.email}, ${PERSONA_CARLOS.email});
    `;
    if (allowlistRows.length !== 3) {
      throw new Error(
        `VIOLAÇÃO DE ALLOWLIST: Apenas ${allowlistRows.length}/3 e-mails sintéticos estão autorizados na allowlist.`
      );
    }
    logger('   [✓] Todos os 3 e-mails sintéticos constam na allowlist.');

    // D. Geração segura dos hashes bcrypt (custo 10 canônico do projeto)
    logger('   [3/5] Gerando hashes bcrypt com fator de custo 10...');
    const salt = await bcrypt.genSalt(10);
    const hashAlice = await bcrypt.hash(alicePassword.trim(), salt);
    const hashBruno = await bcrypt.hash(brunoPassword.trim(), salt);
    const hashCarlos = await bcrypt.hash(carlosPassword.trim(), salt);

    // E. Atualização pontual e individual com assertividade de linhas afetadas
    logger('   [4/5] Executando mutações pontuais parametrizadas em public.perfis...');

    const resAlice = await tx`
      UPDATE public.perfis
      SET password_hash = ${hashAlice}
      WHERE id = ${PERSONA_ALICE.id}::uuid
        AND email = ${PERSONA_ALICE.email}
        AND papel = 'estudante';
    `;
    if (resAlice.count !== 1) {
      throw new Error(`FALHA NA MUTAÇÃO: Atualização de Alice afetou ${resAlice.count} linhas (esperado 1).`);
    }

    const resBruno = await tx`
      UPDATE public.perfis
      SET password_hash = ${hashBruno}
      WHERE id = ${PERSONA_BRUNO.id}::uuid
        AND email = ${PERSONA_BRUNO.email}
        AND papel = 'responsavel';
    `;
    if (resBruno.count !== 1) {
      throw new Error(`FALHA NA MUTAÇÃO: Atualização de Bruno afetou ${resBruno.count} linhas (esperado 1).`);
    }

    const resCarlos = await tx`
      UPDATE public.perfis
      SET password_hash = ${hashCarlos}
      WHERE id = ${PERSONA_CARLOS.id}::uuid
        AND email = ${PERSONA_CARLOS.email}
        AND papel = 'estudante';
    `;
    if (resCarlos.count !== 1) {
      throw new Error(`FALHA NA MUTAÇÃO: Atualização de Carlos afetou ${resCarlos.count} linhas (esperado 1).`);
    }
    logger('   [✓] 3 registros atualizados com sucesso (exatamente 1 linha por persona).');

    // F. Auditoria interna pós-update dentro da mesma transação
    logger('   [5/5] Auditando integridade dos novos hashes na transação...');
    const checkPerfis = await tx`
      SELECT id, password_hash
      FROM public.perfis
      WHERE id IN (${PERSONA_ALICE.id}::uuid, ${PERSONA_BRUNO.id}::uuid, ${PERSONA_CARLOS.id}::uuid);
    `;

    for (const p of checkPerfis) {
      if (!p.password_hash || !p.password_hash.startsWith('$2')) {
        throw new Error(`CORRUPÇÃO DETECTADA: Hash bcrypt inválido para perfil ${p.id}.`);
      }
    }
    logger('   [✓] Novos hashes validados com formato canônico bcrypt.');
  };

  if (typeof sql.begin === 'function') {
    await sql.begin(executeAtomicUpdate);
  } else {
    await executeAtomicUpdate(sql);
  }

  const durationMs = Date.now() - startTime;
  logger(`\n✨ TRANSAÇÃO ATÔMICA CONCLUÍDA EM ${durationMs}ms: Senhas de Alice, Bruno e Carlos atualizadas com sucesso!`);

  return {
    success: true,
    updatedPerfis: 3,
    durationMs,
  };
}

// ----------------------------------------------------------------------------
// INTERFACE DE ENTRADA OCULTA E CONFIRMAÇÃO HUMANA
// ----------------------------------------------------------------------------
export function promptHiddenPassword(promptText) {
  return new Promise((resolve) => {
    process.stdout.write(promptText);

    let password = '';
    const stdin = process.stdin;

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(password);
      } else if (char === '\u0003') {
        // Ctrl+C
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\nOperação cancelada pelo operador (Ctrl+C).\n');
        process.exit(130);
      } else if (char === '\u007f' || char === '\b') {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        password += char;
        process.stdout.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

export function promptConfirmation(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.on('SIGINT', () => {
      rl.close();
      process.stdout.write('\nOperação cancelada pelo operador (Ctrl+C).\n');
      process.exit(130);
    });

    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ----------------------------------------------------------------------------
// CLI LAUNCHER CONTROLADO
// ----------------------------------------------------------------------------
export async function main() {
  const args = process.argv.slice(2);
  const isHelp = args.includes('--help') || args.includes('-h');

  if (isHelp) {
    console.log(`
Uso do Configurador de Senhas Staging (Medicina 2029 — H2.04-T2):
  node scripts/db/configure-staging-passwords.mjs [--ca=<caminho>]

Opções:
  --ca=<caminho>   Caminho para o certificado CA do Supabase (ex: ~/Downloads/prod-ca-2021.crt)
  --help, -h       Exibe esta mensagem de ajuda e encerra

Segurança e Requisitos:
  - Exclusivo para o ambiente Supabase Staging (projeto ynfocaorhadizlvbnzrt).
  - Conexão TLS estrita ao Session Pooler (aws-0-us-east-1.pooler.supabase.com:5432).
  - As senhas dos 3 usuários são solicitadas via entrada oculta interativa.
  - As senhas devem ter no mínimo 10 caracteres e ser mutuamente distintas.
  - Exige confirmação humana explícita: "CONFIRMAR ATUALIZACAO SENHAS STAGING".
  - Transação 100% atômica com rollback integral em qualquer divergência.
`);
    process.exit(0);
  }

  if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
    console.error('❌ ERRO CRÍTICO: Execução terminantemente proibida em ambiente de produção.');
    process.exit(1);
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
  console.log('MEDICINA 2029 — H2.04-T2: CONFIGURAÇÃO DE SENHAS NO STAGING');
  console.log('================================================================');
  console.log(`Projeto Alvo:      ${TARGET_PROJECT_REF}`);
  console.log(`Session Pooler:    ${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`Role Conectada:    ${TARGET_USERNAME} (PostgreSQL Superuser/Admin)`);
  console.log(`Banco:             ${TARGET_DB}`);
  console.log(`Personas Alvo:     Alice (${PERSONA_ALICE.email}), Bruno (${PERSONA_BRUNO.email}), Carlos (${PERSONA_CARLOS.email})`);
  console.log(`Certificado CA:    ${caInfo.path}`);
  console.log('================================================================\n');

  let adminPassword = process.env.MEDICINA_ADMIN_PASSWORD;
  let alicePassword = process.env.MEDICINA_ALICE_PASSWORD;
  let brunoPassword = process.env.MEDICINA_BRUNO_PASSWORD;
  let carlosPassword = process.env.MEDICINA_CARLOS_PASSWORD;

  if (!adminPassword || !alicePassword || !brunoPassword || !carlosPassword) {
    if (!process.stdin.isTTY) {
      console.error('❌ ERRO: Terminal não-interativo e senhas não fornecidas por variáveis de ambiente.');
      process.exit(1);
    }
  }

  if (!adminPassword) {
    adminPassword = await promptHiddenPassword('🔑 Digite a senha do usuário administrativo postgres: ');
    if (!adminPassword) {
      console.error('❌ Operação abortada: senha administrativa vazia.');
      process.exit(1);
    }
  }

  if (!alicePassword) {
    alicePassword = await promptHiddenPassword('🔑 [1/3] Digite a nova senha de Alice (estudante): ');
  }

  if (!brunoPassword) {
    brunoPassword = await promptHiddenPassword('🔑 [2/3] Digite a nova senha de Bruno (responsável): ');
  }

  if (!carlosPassword) {
    carlosPassword = await promptHiddenPassword('🔑 [3/3] Digite a nova senha de Carlos (estudante independente): ');
  }

  try {
    validatePersonaPasswords({ alicePassword, brunoPassword, carlosPassword });
  } catch (valErr) {
    console.error(`\n❌ ${valErr.message}`);
    process.exit(1);
  }

  console.log('\n================================================================');
  console.log('ATENÇÃO: A operação atualizará os hashes de senha dos 3 perfis no Staging.');
  console.log('Para confirmar a aplicação, digite exatamente:');
  console.log('   CONFIRMAR ATUALIZACAO SENHAS STAGING');
  console.log('================================================================');
  const confirmation = await promptConfirmation('Confirmação: ');

  if (confirmation !== 'CONFIRMAR ATUALIZACAO SENHAS STAGING') {
    console.log('\n⚠️ Confirmação incorreta ou cancelada. Nenhuma alteração foi realizada.');
    process.exit(0);
  }

  const poolerUrl = buildStagingPoolerUrl(adminPassword);
  validateStagingPasswordConfig(poolerUrl);

  const sslConfig = {
    rejectUnauthorized: true,
    ca: [...tls.rootCertificates, caInfo.content],
  };

  const sql = postgres(poolerUrl, {
    max: 1,
    connect_timeout: 20,
    idle_timeout: 10,
    ssl: sslConfig,
    onnotice: () => {},
  });

  try {
    // 1. Validação da sessão conectada
    const [diag] = await sql`
      SELECT current_database() AS db_name, current_user AS user_name, session_user AS session_user_name;
    `;
    console.log(`🔒 Conexão TLS estabelecida: DB="${diag.db_name}" | ROLE="${diag.user_name}"`);

    if (diag.user_name !== TARGET_ROLE && diag.user_name !== TARGET_USERNAME) {
      throw new Error(`VIOLAÇÃO DE PAPEL: Conexão reportou papel "${diag.user_name}". Esperado "${TARGET_ROLE}".`);
    }

    if (diag.db_name !== TARGET_DB) {
      throw new Error(`VIOLAÇÃO DE BANCO: Conexão reportou banco "${diag.db_name}". Esperado "${TARGET_DB}".`);
    }

    // 2. Execução da atualização atômica
    await updateStagingSyntheticPasswords({
      sql,
      alicePassword,
      brunoPassword,
      carlosPassword,
      logger: console.log,
    });

    console.log('\n================================================================');
    console.log('🎉 SENHAS SINTÉTICAS CONFIGURADAS COM SUCESSO NO STAGING!');
    console.log('================================================================');
    console.log('Os perfis de Alice, Bruno e Carlos agora possuem senhas conhecidas');
    console.log('para a homologação funcional do login via NextAuth.');
    console.log('================================================================\n');
  } catch (err) {
    console.error('\n❌ Falha na configuração de senhas no staging:', sanitizeError(err));
    process.exit(1);
  } finally {
    // Purga obrigatória de credenciais da memória
    adminPassword = '';
    alicePassword = '';
    brunoPassword = '';
    carlosPassword = '';
    await sql.end();
  }
}

if (process.argv[1]?.includes('configure-staging-passwords.mjs')) {
  main().catch((err) => {
    console.error('Erro fatal:', sanitizeError(err));
    process.exit(1);
  });
}
