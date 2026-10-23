#!/usr/bin/env node

/**
 * MEDICINA 2029 — H1.03
 * Runner Controlado de Migrações DDL para Ambiente de Staging
 *
 * Aplica a sequência canônica de migrações DDL e propostas de modernização
 * exclusivamente sob ambiente de homologação autorizado (fail-closed),
 * bloqueando sumariamente qualquer contato com bases produtivas.
 *
 * Uso:
 *   node scripts/db/migrate-staging.mjs --dry-run
 *   CONFIRM_STAGING_MIGRATIONS=true node scripts/db/migrate-staging.mjs --apply
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
 * @param {Record<string, string | undefined>} [env]
 */
export function assertCanRunStagingMigrationsCli(env = process.env) {
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  const appEnv = env.APP_ENV?.trim().toLowerCase();
  const dbUrl = env.DATABASE_URL || env.DATABASE_APP_URL || '';
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
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run') || !args.includes('--apply');
  const isApply = args.includes('--apply');

  console.log('================================================================');
  console.log('MEDICINA 2029 — RUNNER CONTROLADO DE MIGRAÇÕES DE STAGING');
  console.log(`Modo: ${isApply ? 'APLICAÇÃO EFETIVA (--apply)' : 'SIMULAÇÃO DEFENSIVA (--dry-run)'}`);
  console.log('================================================================');

  try {
    const manifest = getMigrationManifest();
    console.log(`\n📋 Manifesto de Migrações Canônicas (${manifest.length} arquivos):`);
    for (const m of manifest) {
      console.log(`  [${m.ordem}/${manifest.length}] ${m.relPath}`);
      console.log(`       Bytes: ${m.tamanhoBytes} | SHA-256: ${m.sha256.slice(0, 16)}...`);
    }

    if (isDryRun && !isApply) {
      console.log('\n✅ Pré-validação concluída: arquivos existem e hashes foram calculados.');
      console.log('💡 Para aplicar no banco de homologação, defina as variáveis e use --apply.');
      process.exit(0);
    }

    // Se solicitado apply, valida salvaguardas fail-closed
    assertCanRunStagingMigrationsCli(process.env);

    console.log('\n🔒 Salvaguardas aprovadas. Conectando ao banco de staging...');
    // Importação dinâmica do postgres para execução controlada
    const { default: postgres } = await import('postgres');
    const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_APP_URL;
    if (!dbUrl) {
      throw new Error('DATABASE_URL ausente.');
    }

    const sql = postgres(dbUrl, { max: 1 });
    try {
      console.log('🔄 Aplicando migrações em ordem sequencial...');
      for (const m of manifest) {
        const sqlContent = fs.readFileSync(m.fullPath, 'utf8');
        console.log(`  -> Executando [${m.ordem}] ${m.relPath}...`);
        await sql.unsafe(sqlContent);
        console.log(`  ✓ Concluído [${m.ordem}] ${m.relPath}`);
      }
      console.log('\n🎉 Todas as 9 migrações foram aplicadas com sucesso!');
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
