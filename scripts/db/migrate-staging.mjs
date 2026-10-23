#!/usr/bin/env node

/**
 * MEDICINA 2029 — H1.04-R3
 * Runner Controlado de Migrações DDL para Ambiente de Staging
 *
 * Aplica a sequência canônica de migrações DDL e propostas de modernização
 * exclusivamente sob ambiente de homologação autorizado (fail-closed).
 *
 * MODOS DE EXECUÇÃO:
 *   1. Offline (--dry-run / padrão):
 *      Validação estática 100% offline dos manifestos e hashes locais.
 *      Zero conexões de rede ou chamadas de banco de dados.
 *   2. Online Somente-Leitura (--check-db):
 *      Inspeção estritamente passiva via SELECT e consultas ao catálogo.
 *      Verifica to_regclass sem criar tabelas, roles, extensões ou locks.
 *   3. Aplicação Efetiva (--apply):
 *      Execução DDL transacional atômica (DDL + gravação no histórico)
 *      com lock consultivo em conexão dedicada e criação da tabela de tracking.
 *
 * Uso:
 *   node scripts/db/migrate-staging.mjs                  (offline: validação local sem conexão)
 *   node scripts/db/migrate-staging.mjs --dry-run        (offline: validação local sem conexão)
 *   CONFIRM_STAGING_MIGRATIONS=true node scripts/db/migrate-staging.mjs --check-db
 *   CONFIRM_STAGING_MIGRATIONS=true node scripts/db/migrate-staging.mjs --apply
 *   CONFIRM_STAGING_MIGRATIONS=true node scripts/db/migrate-staging.mjs --apply --until-step=5
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

export const CANONICAL_MIGRATIONS = [
  'drizzle/0000_greedy_loki.sql',
  'drizzle/0001_dry_talos.sql',
  'drizzle/0002_little_swarm.sql',
  'drizzle/0003_f1_03_r_expansao.sql',
  'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql',
  'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql',
  'docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql',
  'docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql',
  'docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql',
];

export const MIGRATIONS_ADVISORY_LOCK_ID = 20290001;

/**
 * Remove BEGIN/COMMIT externos de scripts SQL para permitir encapsulamento
 * transacional atômico pelo runner (DDL + gravação na tabela de histórico)
 * @param {string} sqlContent
 * @returns {string}
 */
export function stripOuterTransaction(sqlContent) {
  let content = sqlContent.trim();
  // Strip initial BEGIN;
  content = content.replace(/^(\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*\bBEGIN\s*;\s*/i, (match) => {
    return match.replace(/\bBEGIN\s*;\s*/i, '');
  });
  // Strip trailing COMMIT;
  content = content.replace(/\bCOMMIT\s*;?(\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*$/i, '');
  return content.trim();
}

/**
 * Probes de assinatura para detectar objetos criados sem registro no histórico (consultas estritamente passivas)
 */
export const MIGRATION_PROBES = {
  1: async (sql) => {
    // 0000_greedy_loki.sql: cria tabelas acervo_arquivos e perfis
    const [res] = await sql`SELECT to_regclass('public.acervo_arquivos') as tbl, to_regclass('public.perfis') as tbl2;`;
    return Boolean(res?.tbl || res?.tbl2);
  },
  2: async (sql) => {
    // 0001_dry_talos.sql: adiciona colunas email e password_hash em perfis
    const rows = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'perfis' AND column_name IN ('email', 'password_hash');
    `;
    return rows.length > 0;
  },
  3: async (sql) => {
    // 0002_little_swarm.sql: adiciona coluna vestibular em acervo_arquivos
    const rows = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'acervo_arquivos' AND column_name = 'vestibular';
    `;
    return rows.length > 0;
  },
  4: async (sql) => {
    // 0003_f1_03_r_expansao.sql: cria responsavel_estudante e coluna estudante_perfil_id em ciclos
    const [res] = await sql`SELECT to_regclass('public.responsavel_estudante') as tbl;`;
    return Boolean(res?.tbl);
  },
  5: async (sql) => {
    // F1_04_RLS_PROPOSTA.sql: cria schema medicina e funcao medicina.set_context
    const [res] = await sql`SELECT to_regprocedure('medicina.set_context(uuid,text)') as fn;`;
    return Boolean(res?.fn);
  },
  6: async (sql) => {
    // F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql: constraint acervo_arquivos_storage_path_uniq
    const rows = await sql`
      SELECT 1 FROM pg_constraint WHERE conname = 'acervo_arquivos_storage_path_uniq';
    `;
    return rows.length > 0;
  },
  7: async (sql) => {
    // F1_10_STORAGE_POLICIES_PROPOSTA.sql: funcao medicina.is_valid_acervo_storage_path
    const [res] = await sql`SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;`;
    return Boolean(res?.fn);
  },
  8: async (sql) => {
    // F1_11_FILA_INGESTAO_PROPOSTA.sql: cria acervo_jobs
    const [res] = await sql`SELECT to_regclass('public.acervo_jobs') as tbl;`;
    return Boolean(res?.tbl);
  },
  9: async (sql) => {
    // F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql: cria fn_busca_hibrida_acervo
    const rows = await sql`
      SELECT 1 FROM pg_proc WHERE proname = 'fn_busca_hibrida_acervo';
    `;
    return rows.length > 0;
  },
};

/**
 * @param {string} [root]
 */
export function getMigrationManifest(root = projectRoot) {
  return CANONICAL_MIGRATIONS.map((relPath, index) => {
    const fullPath = path.resolve(root, relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Arquivo de migração não encontrado: ${relPath}`);
    }
    const content = fs.readFileSync(fullPath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return {
      ordem: index + 1,
      relPath,
      fullPath,
      tamanhoBytes: content.length,
      sha256: hash,
    };
  });
}

/**
 * @param {string} [urlStr]
 */
export function extractDatabaseRole(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const parsed = new URL(urlStr);
    const rawUser = decodeURIComponent(parsed.username).trim().toLowerCase();
    if (!rawUser) return null;
    const dotIndex = rawUser.indexOf('.');
    return dotIndex > 0 ? rawUser.slice(0, dotIndex) : rawUser;
  } catch {
    return null;
  }
}

/**
 * Validação de salvaguardas fail-closed para conexões de rede
 * @param {Record<string, string | undefined>} [env]
 * @param {object} [options]
 * @param {boolean} [options.isCheckDb]
 */
export function assertCanRunStagingMigrationsCli(env = process.env, { isCheckDb = false } = {}) {
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  const appEnv = env.APP_ENV?.trim().toLowerCase();
  const dbUrl = env.DATABASE_MIGRATION_URL || env.DATABASE_ADMIN_URL || env.DATABASE_URL || env.DATABASE_APP_URL || '';
  const prodRef = env.PRODUCTION_SUPABASE_PROJECT_REF?.trim();

  // 1. Proibição absoluta em produção
  if (nodeEnv === 'production' && appEnv !== 'staging') {
    throw new Error('PRODUÇÃO BLOQUEADA: É expressamente proibido executar migrações de staging em produção!');
  }
  if (appEnv === 'production') {
    throw new Error('PRODUÇÃO BLOQUEADA: APP_ENV=production detectado. Execução sumariamente abortada!');
  }

  // 2. Exigência de autorização explícita
  const isAuthorized =
    env.CONFIRM_STAGING_MIGRATIONS === 'true' ||
    env.ALLOW_STAGING_MIGRATIONS === 'true' ||
    nodeEnv === 'test';

  if (!isAuthorized) {
    throw new Error(
      'Migrações de staging bloqueadas: requer autorização explícita via variável CONFIRM_STAGING_MIGRATIONS=true.'
    );
  }

  // 3. Bloqueio contra nomes produtivos
  if (prodRef && dbUrl.includes(prodRef)) {
    throw new Error('PRODUÇÃO BLOQUEADA: DATABASE_URL aponta para o projeto de produção!');
  }
  if (dbUrl.includes('medicina_prod') || dbUrl.includes('production')) {
    throw new Error('PRODUÇÃO BLOQUEADA: Nome de banco produtivo detectado em DATABASE_URL!');
  }

  // 4. Bloqueio contra papéis restritos de runtime exclusivamente para --apply (H1.03-R)
  // No modo --check-db (somente leitura), credenciais com permissão de leitura são permitidas.
  if (!isCheckDb) {
    const role = extractDatabaseRole(dbUrl);
    if (role === 'medicina_app' || role === 'medicina_auth' || role === 'medicina_worker') {
      throw new Error(
        `VIOLAÇÃO DE PRIVILÉGIO: O runner de migrações não pode ser executado com papel restrito de runtime ("${role}"). ` +
        'Migrações DDL exigem a role administrativa (ex: "postgres" via DATABASE_MIGRATION_URL).'
      );
    }
  }
}

/**
 * Garante a criação da tabela de histórico de migrações (usado exclusivamente no modo --apply)
 * @param {any} sql
 */
export async function ensureMigrationHistoryTable(sql) {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public._medicina_staging_migrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ordem integer NOT NULL UNIQUE,
      rel_path text NOT NULL UNIQUE,
      sha256 text NOT NULL,
      aplicado_em timestamptz DEFAULT now() NOT NULL,
      executado_por text NOT NULL,
      tamanho_bytes integer NOT NULL
    );
  `);
}

/**
 * Executa as migrações sequencialmente com idempotência, transações atômicas únicas e locks dedicados
 * @param {object} params
 * @param {any} params.sql
 * @param {Array<any>} [params.manifest]
 * @param {boolean} [params.isDryRun]
 * @param {number | null} [params.untilStep]
 * @param {function} [params.logger]
 */
export async function executeStagingMigrations({
  sql,
  manifest = getMigrationManifest(),
  isDryRun = false,
  untilStep = null,
  logger = console.log,
}) {
  // Reserva conexão dedicada se o cliente suportar (ex: postgres.js pool)
  const client = typeof sql.reserve === 'function' ? await sql.reserve() : sql;

  try {
    // 1. Controle de concorrência via lock consultivo exclusivo na conexão dedicada EXCLUSIVAMENTE para mutações (--apply)
    // No modo --check-db (isDryRun), NÃO adquire locks de concorrência nem efetua qualquer mutação
    if (!isDryRun) {
      const [lockRes] = await client`SELECT pg_try_advisory_lock(${MIGRATIONS_ADVISORY_LOCK_ID}) as locked;`;
      if (!lockRes?.locked) {
        throw new Error(
          `CONCORRÊNCIA BLOQUEADA: Outra execução de migrações já está em andamento (advisory lock ${MIGRATIONS_ADVISORY_LOCK_ID} ocupado).`
        );
      }
    }

    try {
      // 2. Verificação passiva da existência da tabela de histórico usando to_regclass (SELECT puro)
      const [tableCheck] = await client`
        SELECT to_regclass('public._medicina_staging_migrations') as tbl;
      `;
      let historyTableExists = Boolean(tableCheck?.tbl);

      // No modo --apply, se a tabela ainda não existir, cria-a dentro do fluxo autorizado
      if (!isDryRun && !historyTableExists) {
        await ensureMigrationHistoryTable(client);
        historyTableExists = true;
      }

      // 3. Lê o histórico existente de forma passiva (SELECT puro)
      let historyRows = [];
      if (historyTableExists) {
        historyRows = await client`
          SELECT ordem, rel_path, sha256, aplicado_em, executado_por
          FROM public._medicina_staging_migrations
          ORDER BY ordem ASC;
        `;
      } else {
        logger('Banco sem histórico de migrações. Nove migrações pendentes.');
      }

      const historyByOrder = new Map(historyRows.map((r) => [r.ordem, r]));

      // Validação de integridade do histórico existente: não pode haver lacuna entre as migrações já gravadas
      if (historyRows.length > 0) {
        const maxApplied = Math.max(...historyRows.map((r) => r.ordem));
        for (let i = 1; i <= maxApplied; i++) {
          if (!historyByOrder.has(i)) {
            throw new Error(
              `ESTADO INCONSISTENTE: Lacuna detectada no histórico de migrações do banco. A migração [${i}] está ausente, mas existem migrações posteriores registradas.`
            );
          }
        }
      }

      const applied = [];
      const skipped = [];
      const plan = [];

      // 4. Validação e execução sequencial
      for (const m of manifest) {
        if (untilStep !== null && m.ordem > untilStep) {
          logger(`  ⏸ [STOP] Interrupção planejada no portão operacional (untilStep = ${untilStep})`);
          break;
        }

        const existing = historyByOrder.get(m.ordem);

        if (existing) {
          // Valida integridade do script previamente aplicado
          if (existing.rel_path !== m.relPath) {
            throw new Error(
              `ESTADO INCONSISTENTE: Ordem ${m.ordem} no banco pertence a "${existing.rel_path}", mas o manifesto atual espera "${m.relPath}".`
            );
          }
          if (existing.sha256 !== m.sha256) {
            throw new Error(
              `DIVERGÊNCIA DE INTEGRIDADE: A migração [${m.ordem}] (${m.relPath}) foi alterada localmente após já ter sido aplicada no banco! ` +
              `(Hash no banco: ${existing.sha256}, Hash local: ${m.sha256}).`
            );
          }
          skipped.push({ ...m, aplicado_em: existing.aplicado_em });
          plan.push({ ordem: m.ordem, relPath: m.relPath, action: 'SKIP', motivo: 'Já aplicada anteriormente' });
          logger(`  ↷ [SKIP] [${m.ordem}/${manifest.length}] ${m.relPath} (já aplicada em ${new Date(existing.aplicado_em).toISOString()})`);
        } else {
          // No modo --apply, se há um salto sem que as anteriores estejam aplicadas no banco ou nesta sessão, aborta
          if (!isDryRun && m.ordem > 1 && !historyByOrder.has(m.ordem - 1) && !applied.some((a) => a.ordem === m.ordem - 1)) {
            throw new Error(
              `ESTADO INCONSISTENTE: Salto de ordem detectado antes de aplicar [${m.ordem}] (${m.relPath}). Migração anterior [${m.ordem - 1}] não foi registrada.`
            );
          }

          // Detecção segura de estado intermediário antes de tentar aplicar (queries passivas ao catálogo)
          const probe = MIGRATION_PROBES[m.ordem];
          if (probe) {
            const hasIntermediateObjects = await probe(client);
            if (hasIntermediateObjects) {
              throw new Error(
                `ESTADO INTERMEDIÁRIO DETECTADO: Os objetos da migração [${m.ordem}] (${m.relPath}) já existem no banco de dados, ` +
                `mas a gravação na tabela _medicina_staging_migrations não foi registrada (possível falha pós-DDL ou execução externa anterior). ` +
                `Ação abortada fail-closed para evitar reaplicação destrutiva ou duplicações. Inspecione o banco antes de prosseguir.`
              );
            }
          }

          if (isDryRun) {
            plan.push({ ordem: m.ordem, relPath: m.relPath, action: 'PENDING', motivo: 'Aguardando aplicação' });
            logger(`  ○ [PENDING] [${m.ordem}/${manifest.length}] ${m.relPath} (aguardando aplicação)`);
          } else {
            logger(`  -> [APPLYING] [${m.ordem}/${manifest.length}] ${m.relPath}...`);
            const rawSqlContent = fs.readFileSync(m.fullPath, 'utf8');
            const cleanSqlContent = stripOuterTransaction(rawSqlContent);

            // Garante transação única e atômica para DDL e inserção de histórico
            await client.begin(async (tx) => {
              await tx.unsafe(cleanSqlContent);
              await tx`
                INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
                VALUES (${m.ordem}, ${m.relPath}, ${m.sha256}, current_user, ${m.tamanhoBytes});
              `;
            });

            applied.push(m);
            plan.push({ ordem: m.ordem, relPath: m.relPath, action: 'APPLIED', motivo: 'Sucesso' });
            logger(`  ✓ [APPLIED] [${m.ordem}/${manifest.length}] ${m.relPath}`);
          }
        }
      }

      return {
        total: manifest.length,
        appliedCount: applied.length,
        skippedCount: skipped.length,
        pendingCount: plan.filter((p) => p.action === 'PENDING').length,
        applied,
        skipped,
        plan,
        isDryRun,
        historyTableExists,
      };
    } finally {
      // Libera o lock consultivo na conexão dedicada apenas se tiver sido adquirido (--apply)
      if (!isDryRun) {
        try {
          await client`SELECT pg_advisory_unlock(${MIGRATIONS_ADVISORY_LOCK_ID});`;
        } catch {
          // Ignora falha de unlock se a conexão foi encerrada
        }
      }
    }
  } finally {
    // Libera a reserva da conexão dedicada caso tenha sido reservada
    if (typeof client.release === 'function') {
      client.release();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply');
  const isCheckDb = args.includes('--check-db') || args.includes('--dry-run-online');
  const untilStepArg = args.find((a) => a.startsWith('--until-step='));
  const untilStep = untilStepArg ? parseInt(untilStepArg.split('=')[1], 10) : null;
  const isOfflineDryRun = !isApply && !isCheckDb;

  console.log('================================================================');
  console.log('MEDICINA 2029 — RUNNER CONTROLADO DE MIGRAÇÕES DE STAGING (H1.04-R3)');
  if (isApply) {
    console.log('Modo: APLICAÇÃO EFETIVA (--apply)');
  } else if (isCheckDb) {
    console.log('Modo: SIMULAÇÃO ONLINE DE LEITURA (--check-db)');
  } else {
    console.log('Modo: PRÉ-VALIDAÇÃO ESTÁTICA OFFLINE (--dry-run)');
  }
  if (untilStep !== null) {
    console.log(`Portão operacional: Interrupção após etapa ${untilStep} (--until-step=${untilStep})`);
  }
  console.log('================================================================');

  try {
    const manifest = getMigrationManifest();
    console.log(`\n📋 Manifesto de Migrações Canônicas (${manifest.length} arquivos):`);
    for (const m of manifest) {
      console.log(`  [${m.ordem}/${manifest.length}] ${m.relPath}`);
      console.log(`       Bytes: ${m.tamanhoBytes} | SHA-256: ${m.sha256.slice(0, 16)}...`);
    }

    // Modo offline puro: NÃO conecta ao banco sob nenhuma circunstância
    if (isOfflineDryRun) {
      console.log('\n✅ Pré-validação estática offline concluída com sucesso.');
      console.log('ℹ️  Todos os 9 arquivos canônicos existem, tamanhos e hashes SHA-256 foram auditados.');
      console.log('💡 Nenhuma conexão de rede foi realizada.');
      console.log('👉 Para inspecionar o banco remoto em modo somente-leitura: use --check-db');
      console.log('👉 Para aplicar as migrações controladamente: use CONFIRM_STAGING_MIGRATIONS=true ... --apply');
      process.exit(0);
    }

    // Valida salvaguardas fail-closed para conexões de rede
    assertCanRunStagingMigrationsCli(process.env, { isCheckDb });

    const dbUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('DATABASE_MIGRATION_URL (ou DATABASE_ADMIN_URL / DATABASE_URL) ausente.');
    }

    console.log(`\n🔒 Salvaguardas aprovadas. Conectando em sessão ${isCheckDb ? 'somente-leitura' : 'dedicada de migração'}...`);
    const { default: postgres } = await import('postgres');
    const sql = postgres(dbUrl, { max: 1 });

    try {
      console.log('🔄 Verificando histórico e executando runner...');
      const summary = await executeStagingMigrations({
        sql,
        manifest,
        isDryRun: !isApply,
        untilStep,
        logger: console.log,
      });

      console.log('\n================================================================');
      console.log(`📊 RESUMO DA EXECUÇÃO: Total: ${summary.total} | Aplicadas: ${summary.appliedCount} | Já Existentes: ${summary.skippedCount} | Pendentes: ${summary.pendingCount}`);
      if (summary.isDryRun) {
        console.log('ℹ️  Modo online de leitura (--check-db): nenhuma alteração de schema foi gravada no banco.');
      } else {
        console.log('🎉 Migrações de staging concluídas com sucesso e registradas atomicamente no histórico!');
      }
      console.log('================================================================');
    } finally {
      await sql.end();
    }
    process.exit(0);
  } catch (err) {
    console.error('\n❌ ERRO NA EXECUÇÃO DAS MIGRAÇÕES DE STAGING:');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Só executa o entrypoint direto se invocado como script CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
