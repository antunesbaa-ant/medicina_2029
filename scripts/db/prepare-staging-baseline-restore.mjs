#!/usr/bin/env node

/**
 * ==============================================================================
 * MEDICINA 2029 — H2.03-R2A: AJUSTES FINAIS DA RESTAURAÇÃO ISOLADA
 * ==============================================================================
 * Script de diagnóstico, matriz de compatibilidade e preparação segura do
 * procedimento de restauração descartável do dump baseline.
 *
 * Princípios de Segurança e Governança (H2.03-R2A):
 * 1. NUNCA tocar no Supabase remoto (fail-closed contra qualquer endpoint externo).
 * 2. Isolamento estrito: bind exclusivo em 127.0.0.1 e porta 5433.
 * 3. Autenticação SCRAM-SHA-256 com senha aleatória efêmera (zero senhas em CLI/history/reports).
 * 4. Matriz de compatibilidade: pg_dump 18.6 -> PostgreSQL 18 + pgvector 0.8.2 (paridade de staging).
 * 5. Pré-restauração: roles NOLOGIN, schema extensions, extensões e search_path public, extensions.
 * 6. Restauração do dump REAL com erro fatal em falha (sem ignorar erros).
 * 7. Comparação de contagens contra o inventário real do manifesto (allowlist = 2, 34 tabelas = 0).
 * 8. Distinção rigorosa dos 4 estágios da recuperação.
 * ==============================================================================
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  findLatestBaselineBackup,
  verifyBackupFilesAndHeaders,
  diagnoseRestoreInfrastructure,
  validateRestoreTarget,
  EXPECTED_MIGRATIONS_COUNT,
  MIN_DOMAIN_TABLES_COUNT,
} from './verify-staging-baseline-backup.mjs';

export const COMPATIBILITY_MATRIX = {
  sourceDb: {
    engine: 'Supabase Managed PostgreSQL',
    version: '15.8',
    platform: 'x86_64-pc-linux-gnu',
    pgvectorVersion: '0.8.2',
  },
  dumpTool: {
    client: 'pg_dump / libpq',
    version: '18.6',
    platform: 'macOS arm64 (Darwin)',
  },
  restoreTool: {
    client: 'pg_restore / libpq',
    version: '18.6',
    platform: 'macOS arm64 (Darwin)',
  },
  destinations: {
    pg18: {
      version: '18',
      image: 'pgvector/pgvector:0.8.2-pg18-trixie',
      alternativeImage: 'pgvector/pgvector:pg18-trixie',
      status: 'RECOMENDADO / COMPATIBILIDADE PLENA (PARIDADE 100%)',
      compatible: true,
      pgvectorVersion: '0.8.2',
      notes: 'Mesma versão principal do pg_dump 18.6 e versão exata do pgvector 0.8.2 de staging; compatibilidade plena com catálogo e índices HNSW.',
    },
    pg17: {
      version: '17',
      image: 'pgvector/pgvector:0.8.2-pg17-trixie',
      status: 'COMPATIBILIDADE PARCIAL',
      compatible: false,
      notes: 'Downgrade de versão principal; risco moderado de incompatibilidade com diretivas do pg_dump 18.',
    },
    pg16: {
      version: '16',
      image: 'pgvector/pgvector:0.8.2-pg16-trixie',
      status: 'NÃO GARANTIDO / RISCO DE FALHA',
      compatible: false,
      notes: 'Dumps gerados por pg_dump 18 não possuem compatibilidade oficial com servidores PG 16 (downgrade de 2 versões maiores).',
    },
    pg15: {
      version: '15',
      image: 'pgvector/pgvector:0.8.2-pg15-trixie',
      status: 'NÃO SUPORTADO PELO PG_RESTORE 18',
      compatible: false,
      notes: 'Incompatibilidade direta de arquivo dump custom (-Fc) ao restaurar em servidor inferior.',
    },
  },
};

export const ISOLATED_ENV_CONFIG = {
  host: '127.0.0.1',
  port: 5433,
  database: 'medicina2029_restore_teste',
  containerName: 'pg-test-restore',
  recommendedImage: 'pgvector/pgvector:0.8.2-pg18-trixie',
  authMethod: 'scram-sha-256',
  passwordSecretMount: '/run/secrets/pg_password',
};

export const STAGES_DISTINCTION = {
  stage1: {
    id: 'PREPARACAO_SCRIPTS',
    title: '1. Preparação dos Scripts',
    status: 'CONCLUÍDO E HOMOLOGADO',
    description: 'Ferramental local ajustado, blindado com fail-closed, porta 5433, autenticação SCRAM-SHA-256 efêmera e testes unitários 100% aprovados.',
  },
  stage2: {
    id: 'DUMP_RESTAURADO',
    title: '2. Dump Restaurado',
    status: 'AGUARDANDO AUTORIZAÇÃO HUMANA',
    description: 'Execução do pg_restore com código de saída ZERO no PostgreSQL descartável local, recriando schemas public e medicina a partir do dump real.',
  },
  stage3: {
    id: 'INTEGRIDADE_CONFERIDA',
    title: '3. Integridade Conferida',
    status: 'AGUARDANDO EXECUÇÃO PÓS-RESTORE',
    description: 'Auditoria automatizada das 7 dimensões via verify_restore.sh contra o manifesto real (allowlist = 2, 34 tabelas = 0, RLS, funções, HNSW, 9 migrações).',
  },
  stage4: {
    id: 'RECUPERACAO_INTEGRAL_SUPABASE',
    title: '4. Recuperação Integral do Supabase',
    status: 'PROCEDIMENTOS SEPARADOS DOCUMENTADOS',
    description: 'Reconstituição completa de desastre em nuvem envolvendo roles técnicas, privilégios DDL, schemas internos (auth/storage) e binários do Storage.',
  },
};

export const SEPARATE_PROCEDURES_DOCUMENTATION = {
  technicalRoles: {
    roles: ['medicina_app', 'medicina_auth', 'medicina_worker'],
    reason: 'pg_dump executa com --no-owner e --no-privileges; roles de cluster não são exportadas.',
    procedure: 'Executar scripts/db/configure-staging-roles.mjs com credenciais efêmeras caso a aplicação vá conectar.',
  },
  omittedPrivileges: {
    scope: 'GRANT / REVOKE de tabelas, sequences e schemas',
    reason: 'Omitidos do dump de aplicação para portabilidade entre ambientes.',
    procedure: 'Reaplicar DDL de permissões de papéis técnicos após a restauração dos objetos.',
  },
  managedSchemas: {
    schemas: ['auth', 'storage', 'realtime', 'vault', 'pgsodium'],
    reason: 'Schemas internos gerenciados pela plataforma Supabase. O dump de aplicação foca em public e medicina.',
    procedure: 'Em desastre integral, schemas do sistema são gerados pela infraestrutura Supabase CLI / migrations da plataforma.',
  },
  storageBinaries: {
    bucket: 'acervo',
    reason: 'pg_dump extrai dados tabulares relacionais, nunca arquivos binários do S3/Storage.',
    procedure: 'Baseline possui 0 objetos no acervo. Quando houver arquivos, restaurar via S3 sync / reconcile_storage.sh.',
  },
};

export const APTO_CRITERIA = [
  '1. Ambiente 100% isolado (bind exclusivo em 127.0.0.1 e porta 5433, zero exposição externa).',
  '2. Autenticação SCRAM-SHA-256 com senha efêmera em arquivo restrito 0600 (zero senhas em CLI/history/reports).',
  '3. Fail-closed ativo (recusa comprovada de qualquer destino remoto ou Supabase).',
  '4. Paridade de versões respeitada (PostgreSQL 18 destino e pgvector 0.8.2 para dump gerado por pg_dump 18.6).',
  '5. Pré-restauração local: roles NOLOGIN criadas, schema extensions criado e search_path public, extensions definido.',
  '6. Dump REAL decifrado temporariamente e restaurado com pg_restore exigindo código de saída ZERO (erro fatal em falha).',
  '7. Todas as 4 extensões presentes: vector (0.8.2), unaccent, pgcrypto, uuid-ossp.',
  '8. Todas as 35 tabelas de domínio presentes no schema public + schema medicina.',
  '9. Paridade exata de contagens contra o inventário real do manifesto: public.allowlist = 2, 34 tabelas = 0 registros.',
  '10. 100% das tabelas de domínio com RLS ativado (relrowsecurity = true no catálogo pg_class) e políticas auditadas.',
  '11. Funções críticas existentes: autenticar_por_email, fn_busca_hibrida_acervo, gerar_hash_questao, etc.',
  '12. Índice vetorial HNSW em acervo_chunks.embedding presente com vector_cosine_ops.',
  '13. Tabela _medicina_staging_migrations presente com exatamente as 9 migrações canônicas ordenadas.',
  '14. Limpeza completa imediata dos arquivos temporários decifrados e segredos efêmeros.',
  '15. Destruição do contêiner temporário (docker stop pg-test-restore) sem persistência residual em disco.',
];

/**
 * Monta o plano operacional revisado com comandos seguros prontos para o operador
 */
export function generateOperatorCommands(backupPath) {
  const cfg = ISOLATED_ENV_CONFIG;

  const startContainerScript = `# 1. Cria diretório temporário restrito (0700) e arquivos de senha efêmera (0600)
SEC_TMP=$(mktemp -d -t m29_sec_XXXXXX)
chmod 700 "\${SEC_TMP}"
PG_PASS_FILE="\${SEC_TMP}/.pg_pass"
openssl rand -hex 32 > "\${PG_PASS_FILE}"
chmod 600 "\${PG_PASS_FILE}"

# 2. Configura PGPASSFILE temporário para autenticação SCRAM-SHA-256 sem expor senha em CLI/history
export PGPASSFILE="\${SEC_TMP}/.pgpass"
echo "${cfg.host}:${cfg.port}:*:postgres:$(cat "\${PG_PASS_FILE}")" > "\${PGPASSFILE}"
chmod 600 "\${PGPASSFILE}"

# 3. Inicia contêiner PostgreSQL 18 com pgvector 0.8.2, SCRAM-SHA-256 e bind estrito em 127.0.0.1:5433
docker run --rm -d \\
  --name ${cfg.containerName} \\
  -p ${cfg.host}:${cfg.port}:5432 \\
  -v "\${PG_PASS_FILE}:${cfg.passwordSecretMount}:ro" \\
  -e POSTGRES_PASSWORD_FILE=${cfg.passwordSecretMount} \\
  -e POSTGRES_INITDB_ARGS="--auth-host=scram-sha-256 --auth-local=scram-sha-256" \\
  ${cfg.recommendedImage}`;

  const restoreCmd = `TARGET_PGHOST=${cfg.host} \\
TARGET_PGPORT=${cfg.port} \\
TARGET_PGUSER=postgres \\
bash scripts/backup/restore_postgres.sh \\
  "${backupPath}" \\
  ${cfg.database}`;

  const verifyCmd = `TARGET_PGHOST=${cfg.host} \\
TARGET_PGPORT=${cfg.port} \\
TARGET_PGUSER=postgres \\
bash scripts/backup/verify_restore.sh \\
  ${cfg.database}`;

  const cleanupScript = `# Destrói contêiner descartável e purga credenciais efêmeras
docker stop ${cfg.containerName}
rm -rf "\${SEC_TMP}"
unset PGPASSFILE`;

  return {
    startContainerScript,
    restoreCmd,
    verifyCmd,
    cleanupScript,
  };
}

/**
 * Diagnóstico completo da preparação H2.03-R2A
 */
export function runPreparationAudit(customBackupDir) {
  const latestBackup = findLatestBaselineBackup(customBackupDir);
  const filesInfo = verifyBackupFilesAndHeaders(latestBackup.fullPath);
  const infraDiagnosis = diagnoseRestoreInfrastructure();
  const commands = generateOperatorCommands(latestBackup.fullPath);

  // Validação de isolamento do alvo
  validateRestoreTarget(ISOLATED_ENV_CONFIG.host);

  return {
    latestBackup,
    filesInfo,
    infraDiagnosis,
    compatibilityMatrix: COMPATIBILITY_MATRIX,
    isolatedConfig: ISOLATED_ENV_CONFIG,
    stagesDistinction: STAGES_DISTINCTION,
    separateProcedures: SEPARATE_PROCEDURES_DOCUMENTATION,
    aptoCriteria: APTO_CRITERIA,
    commands,
  };
}

/**
 * Execução CLI
 */
async function main() {
  console.log('================================================================');
  console.log('MEDICINA 2029 — H2.03-R2A: AJUSTES FINAIS DA RESTAURAÇÃO ISOLADA');
  console.log('================================================================\n');

  const audit = runPreparationAudit();

  console.log('📁 BACKUP BASELINE AUDITADO:');
  console.log(`   Caminho: ${audit.latestBackup.fullPath}`);
  console.log(`   Dump Cifrado: ${audit.filesInfo.encDump.name} (${audit.filesInfo.encDump.sizeBytes} bytes)`);
  console.log(`   Hash SHA-256: ${audit.filesInfo.encDump.sha256}`);
  console.log(`   Envelope M29G: v${audit.filesInfo.encDump.header.version} (AES-256-GCM AEAD)\n`);

  console.log('🔄 MATRIZ DE COMPATIBILIDADE DE VERSÕES:');
  console.log(`   • PostgreSQL Origem (Supabase): ${COMPATIBILITY_MATRIX.sourceDb.version} (pgvector ${COMPATIBILITY_MATRIX.sourceDb.pgvectorVersion})`);
  console.log(`   • Ferramenta de Dump:           ${COMPATIBILITY_MATRIX.dumpTool.version} (${COMPATIBILITY_MATRIX.dumpTool.client})`);
  console.log(`   • Ferramenta de Restore:        ${COMPATIBILITY_MATRIX.restoreTool.version} (${COMPATIBILITY_MATRIX.restoreTool.client})`);
  console.log(`   • Destino Recomendado:          PostgreSQL 18 com pgvector ${COMPATIBILITY_MATRIX.destinations.pg18.pgvectorVersion} (${COMPATIBILITY_MATRIX.destinations.pg18.image}) -> ✅ 100% PARIDADE`);
  console.log(`   • Alerta sobre Servidor PG 16:  ${COMPATIBILITY_MATRIX.destinations.pg16.notes}\n`);

  console.log('🔒 ISOLAMENTO E POLÍTICA DE SEGURANÇA:');
  console.log(`   • Bind de Rede:     ${audit.isolatedConfig.host}:${audit.isolatedConfig.port} (Apenas loopback)`);
  console.log(`   • Autenticação:     SCRAM-SHA-256 via POSTGRES_PASSWORD_FILE e PGPASSFILE efêmero (Zero senhas em CLI/history)`);
  console.log(`   • Salvaguarda:      Fail-closed sumário contra qualquer host externo ou Supabase remoto\n`);

  console.log('📋 COMANDOS PREPARADOS PARA O OPERADOR (APÓS AUTORIZAÇÃO HUMANA):\n');
  console.log('1. Subir contêiner descartável isolado com SCRAM-SHA-256:');
  console.log(`${audit.commands.startContainerScript}\n`);
  console.log('2. Executar restauração do dump REAL (com erro fatal em falha):');
  console.log(`${audit.commands.restoreCmd}\n`);
  console.log('3. Executar auditoria de sanidade contra o inventário real:');
  console.log(`${audit.commands.verifyCmd}\n`);
  console.log('4. Destruir ambiente descartável e limpar segredos:');
  console.log(`${audit.commands.cleanupScript}\n`);

  console.log('================================================================');
  console.log('STATUS DA TAREFA: AJUSTES H2.03-R2A APLICADOS. AGUARDANDO AUTORIZAÇÃO HUMANA.');
  console.log('================================================================');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('\nErro inesperado na preparação:', err.message);
    process.exit(1);
  });
}
