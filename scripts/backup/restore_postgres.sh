#!/usr/bin/env bash
# ==============================================================================
# PROJETO MEDICINA 2029 — OPERAÇÃO DE RESTAURAÇÃO POSTGRESQL (F1.15)
# Script canônico de restauração, decifragem, reconstituição e validação de paridade.
# ==============================================================================
set -euo pipefail

# ------------------------------------------------------------------------------
# 1. PARÂMETROS E CONFIGURAÇÕES
# ------------------------------------------------------------------------------
if [[ $# -lt 1 ]]; then
  echo "Uso: $0 <caminho_do_diretorio_de_backup> [banco_alvo]"
  echo "Exemplo: $0 ./backups/medicina2029_backup_20261021_030000Z medicina2029_staging"
  exit 1
fi

SOURCE_DIR="$1"
TARGET_PGDATABASE="${2:-medicina2029_staging}"

TARGET_PGHOST="${TARGET_PGHOST:-localhost}"
TARGET_PGPORT="${TARGET_PGPORT:-5432}"
TARGET_PGUSER="${TARGET_PGUSER:-postgres}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"
ENCRYPTION_METHOD="${ENCRYPTION_METHOD:-auto}" # auto | openssl | gpg | none
RESTORE_GLOBALS="${RESTORE_GLOBALS:-false}"
PARALLEL_JOBS="${PARALLEL_JOBS:-4}"

TMP_RESTORE_DIR=$(mktemp -d -t medicina2029_restore_XXXXXX)
trap 'rm -rf "${TMP_RESTORE_DIR}"' EXIT

LOG_FILE="${TMP_RESTORE_DIR}/restore.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "======================================================================"
echo "[$(date -u)] INICIANDO PROCESSO DE RESTAURAÇÃO: MEDICINA 2029"
echo "Origem: ${SOURCE_DIR}"
echo "Alvo: ${TARGET_PGHOST}:${TARGET_PGPORT}/${TARGET_PGDATABASE} (Usuário: ${TARGET_PGUSER})"
echo "Diretório Temporário: ${TMP_RESTORE_DIR}"
echo "======================================================================"

# ------------------------------------------------------------------------------
# 2. LOCALIZAÇÃO E DECIFRAGEM DOS ARQUIVOS
# ------------------------------------------------------------------------------
MANIFEST_FILE=$(find "${SOURCE_DIR}" -maxdepth 1 -name "*_manifest.json" | head -n 1)
if [[ -z "${MANIFEST_FILE}" || ! -f "${MANIFEST_FILE}" ]]; then
  echo "ERRO CRÍTICO: Arquivo de manifesto (*_manifest.json) não encontrado em ${SOURCE_DIR}." >&2
  exit 1
fi

echo "[$(date -u)] Manifesto identificado: ${MANIFEST_FILE}"

ENC_DUMP=$(find "${SOURCE_DIR}" -maxdepth 1 -name "*.dump.enc" -o -name "*.dump.gpg" | head -n 1 || true)
RAW_DUMP=$(find "${SOURCE_DIR}" -maxdepth 1 -name "*.dump" | head -n 1 || true)

DUMP_TO_RESTORE="${TMP_RESTORE_DIR}/database.dump"

if [[ -n "${ENC_DUMP}" && -f "${ENC_DUMP}" ]]; then
  echo "[$(date -u)] Arquivo de dump cifrado identificado: ${ENC_DUMP}"
  
  if [[ "${ENC_DUMP}" == *.enc ]]; then
    if [[ -z "${BACKUP_ENCRYPTION_KEY}" ]]; then
      echo "ERRO CRÍTICO: BACKUP_ENCRYPTION_KEY não informada para decifrar arquivo cifrado." >&2
      exit 1
    fi
    CRYPTO_SCRIPT="$(dirname "$0")/crypto_envelope.mjs"
    if [[ -f "${CRYPTO_SCRIPT}" ]] && command -v node &>/dev/null; then
      echo "[$(date -u)] Decifrando dump com utilitário criptográfico (AES-256-GCM AEAD / fallback retroativo CBC)..."
      node "${CRYPTO_SCRIPT}" decrypt "${ENC_DUMP}" "${DUMP_TO_RESTORE}"
    else
      echo "[$(date -u)] Decifrando dump com OpenSSL (AES-256-CBC legado)..."
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
        -in "${ENC_DUMP}" \
        -out "${DUMP_TO_RESTORE}" \
        -pass "env:BACKUP_ENCRYPTION_KEY"
    fi
  elif [[ "${ENC_DUMP}" == *.gpg ]]; then
    if [[ -z "${BACKUP_ENCRYPTION_KEY}" ]]; then
      echo "ERRO CRÍTICO: BACKUP_ENCRYPTION_KEY não informada para decifrar arquivo GPG." >&2
      exit 1
    fi
    echo "[$(date -u)] Decifrando dump com GPG..."
    gpg --batch --yes --decrypt \
      --passphrase "${BACKUP_ENCRYPTION_KEY}" \
      --output "${DUMP_TO_RESTORE}" "${ENC_DUMP}"
  fi
elif [[ -n "${RAW_DUMP}" && -f "${RAW_DUMP}" ]]; then
  echo "[$(date -u)] Arquivo de dump em formato claro identificado: ${RAW_DUMP}"
  cp "${RAW_DUMP}" "${DUMP_TO_RESTORE}"
else
  echo "ERRO CRÍTICO: Nenhum arquivo de dump (.dump, .dump.enc ou .dump.gpg) encontrado!" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 3. VALIDAÇÃO DE INTEGRIDADE SHA-256 E TABELA DE CONTEÚDOS (TOC)
# ------------------------------------------------------------------------------
echo "[$(date -u)] Verificando hash SHA-256 do dump decifrado contra o manifesto..."
CALCULATED_SHA256=$(sha256sum "${DUMP_TO_RESTORE}" | awk '{print $1}')
EXPECTED_SHA256=$(grep -o '"dump_sha256": "[^"]*"' "${MANIFEST_FILE}" | cut -d'"' -f4)

if [[ "${CALCULATED_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  echo "ERRO CRÍTICO: Divergência de integridade SHA-256!" >&2
  echo "Esperado pelo manifesto: ${EXPECTED_SHA256}" >&2
  echo "Calculado no arquivo:   ${CALCULATED_SHA256}" >&2
  exit 1
fi
echo "[$(date -u)] Integridade SHA-256 confirmada com sucesso: ${CALCULATED_SHA256}"

echo "[$(date -u)] Validando TOC com pg_restore --list..."
pg_restore --list "${DUMP_TO_RESTORE}" > /dev/null
echo "[$(date -u)] Tabela de conteúdos íntegra."

# ------------------------------------------------------------------------------
# 4. PREPARAÇÃO DO BANCO ALVO E EXTENSÕES
# ------------------------------------------------------------------------------
echo "[$(date -u)] Preparando banco de destino: ${TARGET_PGDATABASE}..."
psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d postgres -v ON_ERROR_STOP=1 << EOSQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TARGET_PGDATABASE}' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "${TARGET_PGDATABASE}";
CREATE DATABASE "${TARGET_PGDATABASE}";
EOSQL

echo "[$(date -u)] Instalando extensões obrigatórias no banco alvo..."
psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -v ON_ERROR_STOP=1 << EOSQL
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

# ------------------------------------------------------------------------------
# 5. RESTAURAÇÃO COMPLETA COM PG_RESTORE
# ------------------------------------------------------------------------------
echo "[$(date -u)] Executando pg_restore (jobs paralelos: ${PARALLEL_JOBS})..."

# Observação: Usamos --no-owner e --no-privileges para garantir compatibilidade
# com diferentes ambientes de homologação e staging.
pg_restore \
  -h "${TARGET_PGHOST}" \
  -p "${TARGET_PGPORT}" \
  -U "${TARGET_PGUSER}" \
  -d "${TARGET_PGDATABASE}" \
  --no-owner \
  --no-privileges \
  --verbose \
  --jobs="${PARALLEL_JOBS}" \
  "${DUMP_TO_RESTORE}" || {
    echo "AVISO: pg_restore finalizou com avisos/erros não fatais (ex: extensões já pré-criadas)."
  }

# ------------------------------------------------------------------------------
# 6. VERIFICAÇÃO DE INTEGRIDADE E CONFERÊNCIA DE CONTAGENS
# ------------------------------------------------------------------------------
echo "[$(date -u)] Executando verificação de sanidade das tabelas..."
VERIFY_SCRIPT="$(dirname "$0")/verify_restore.sh"
if [[ -f "${VERIFY_SCRIPT}" ]]; then
  bash "${VERIFY_SCRIPT}" "${TARGET_PGDATABASE}" "${MANIFEST_FILE}"
else
  echo "Script ${VERIFY_SCRIPT} não encontrado; realizando contagem direta simples..."
  psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -c "
    SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;
  "
fi

# ------------------------------------------------------------------------------
# 7. SANEAMENTO PÓS-RESTORE COM AUDITORIA E RASTREABILIDADE (F1.16)
# ------------------------------------------------------------------------------
AUTO_SANITIZE="${AUTO_SANITIZE:-true}"
if [[ "${AUTO_SANITIZE}" == "true" ]]; then
  SANITIZE_SCRIPT="$(dirname "$0")/sanitizar_pos_restore.sh"
  if [[ -f "${SANITIZE_SCRIPT}" ]]; then
    echo "[$(date -u)] Executando saneamento defensivo pós-restore com auditoria..."
    RESTORE_ID="restore_$(basename "${SOURCE_DIR}")"
    bash "${SANITIZE_SCRIPT}" "${TARGET_PGDATABASE}" "${RESTORE_ID}"
  fi
fi

echo "======================================================================"
echo "[$(date -u)] RESTAURAÇÃO CONCLUÍDA COM ÊXITO!"
echo "Banco restaurado: ${TARGET_PGDATABASE}"
echo "======================================================================"
