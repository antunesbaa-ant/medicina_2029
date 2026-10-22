#!/usr/bin/env bash
# ==============================================================================
# PROJETO MEDICINA 2029 — OPERAÇÃO DE BACKUP NATIVO POSTGRESQL (F1.15)
# Script canônico de backup lógico completo, catalogação de metadados e cifragem.
# ==============================================================================
set -euo pipefail

# ------------------------------------------------------------------------------
# 1. CONFIGURAÇÕES E VARIÁVEIS DE AMBIENTE (SEM SEGREDOS HARDCODED)
# ------------------------------------------------------------------------------
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-medicina2029}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"
ENCRYPTION_METHOD="${ENCRYPTION_METHOD:-openssl}" # openssl | gpg | none
RETENTION_DAYS="${RETENTION_DAYS:-7}"

TIMESTAMP=$(date -u +"%Y%m%d_%H%M%SZ")
BACKUP_PREFIX="medicina2029_backup_${TIMESTAMP}"
RUN_DIR="${BACKUP_DIR}/${BACKUP_PREFIX}"

mkdir -p "${RUN_DIR}"
chmod 700 "${RUN_DIR}"

LOG_FILE="${RUN_DIR}/backup.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "======================================================================"
echo "[$(date -u)] INICIANDO BACKUP OPERACIONAL NATIVO: MEDICINA 2029"
echo "Host: ${PGHOST}:${PGPORT} | Banco: ${PGDATABASE} | Usuário: ${PGUSER}"
echo "Destino: ${RUN_DIR}"
echo "======================================================================"

# ------------------------------------------------------------------------------
# 2. PRÉ-VALIDAÇÃO DE DEPENDÊNCIAS
# ------------------------------------------------------------------------------
for cmd in pg_dump pg_dumpall psql sha256sum; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERRO CRÍTICO: Comando obrigatório '${cmd}' não encontrado no PATH." >&2
    exit 1
  fi
done

if [[ "${ENCRYPTION_METHOD}" == "openssl" ]]; then
  if ! command -v openssl &>/dev/null; then
    echo "ERRO CRÍTICO: openssl solicitado para cifragem mas não instalado." >&2
    exit 1
  fi
  if [[ -z "${BACKUP_ENCRYPTION_KEY}" ]]; then
    echo "ERRO CRÍTICO: BACKUP_ENCRYPTION_KEY deve estar definida para ENCRYPTION_METHOD=openssl." >&2
    exit 1
  fi
elif [[ "${ENCRYPTION_METHOD}" == "gpg" ]]; then
  if ! command -v gpg &>/dev/null; then
    echo "ERRO CRÍTICO: gpg solicitado para cifragem mas não instalado." >&2
    exit 1
  fi
fi

# ------------------------------------------------------------------------------
# 3. EXTRAÇÃO DO MANIFESTO DE CONTAGENS E VERSÕES DE SCHEMA
# ------------------------------------------------------------------------------
MANIFEST_FILE="${RUN_DIR}/${BACKUP_PREFIX}_manifest.json"
echo "[$(date -u)] Coletando metadados e contagens de linhas do banco..."

psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 -t -A -F"," << 'EOSQL' > "${RUN_DIR}/row_counts.csv"
SELECT relname, n_live_tup
FROM pg_stat_user_tables
ORDER BY relname;
EOSQL

EXTENSIONS_JSON=$(psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 -t -A << 'EOSQL'
SELECT json_agg(json_build_object('name', extname, 'version', extversion))
FROM pg_extension;
EOSQL
)

POSTGRES_VERSION=$(psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 -t -A -c "SELECT version();")

# ------------------------------------------------------------------------------
# 4. BACKUP DE GLOBAIS E PAPÉIS (ROLES, PASSWORDS, PRIVILÉGIOS GLOBAIS)
# ------------------------------------------------------------------------------
GLOBALS_FILE="${RUN_DIR}/${BACKUP_PREFIX}_globals.sql"
echo "[$(date -u)] Executando pg_dumpall --globals-only..."
pg_dumpall \
  -h "${PGHOST}" \
  -p "${PGPORT}" \
  -U "${PGUSER}" \
  --globals-only \
  --file="${GLOBALS_FILE}"

sha256sum "${GLOBALS_FILE}" > "${GLOBALS_FILE}.sha256"
echo "[$(date -u)] Globais exportados com sucesso."

# ------------------------------------------------------------------------------
# 5. BACKUP NATIVO DO BANCO (FORMATO CUSTOMIZADO COMPRIMIDO -Fc)
# ------------------------------------------------------------------------------
DUMP_FILE="${RUN_DIR}/${BACKUP_PREFIX}_database.dump"
echo "[$(date -u)] Executando pg_dump (-Fc, --compress=9, --no-owner, --no-privileges)..."

pg_dump \
  -h "${PGHOST}" \
  -p "${PGPORT}" \
  -U "${PGUSER}" \
  -d "${PGDATABASE}" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --verbose \
  --file="${DUMP_FILE}"

echo "[$(date -u)] pg_dump finalizado. Validando integridade da Tabela de Conteúdos (TOC)..."
TOC_FILE="${RUN_DIR}/${BACKUP_PREFIX}_toc.txt"
pg_restore --list "${DUMP_FILE}" > "${TOC_FILE}"
DUMP_STATUS=$?

if [[ ${DUMP_STATUS} -ne 0 ]]; then
  echo "ERRO CRÍTICO: Validação da TOC do dump falhou com código ${DUMP_STATUS}!" >&2
  exit 1
fi

DUMP_SHA256=$(sha256sum "${DUMP_FILE}" | awk '{print $1}')
echo "${DUMP_SHA256}  $(basename "${DUMP_FILE}")" > "${DUMP_FILE}.sha256"
echo "[$(date -u)] Dump validado. SHA-256: ${DUMP_SHA256}"

# ------------------------------------------------------------------------------
# 6. MONTAGEM DO MANIFESTO JSON CONSOLIDADO
# ------------------------------------------------------------------------------
cat << EOF > "${MANIFEST_FILE}"
{
  "app": "Medicina 2029",
  "task": "F1.15",
  "backup_id": "${BACKUP_PREFIX}",
  "timestamp_utc": "${TIMESTAMP}",
  "database": "${PGDATABASE}",
  "postgres_version": "${POSTGRES_VERSION}",
  "dump_file": "$(basename "${DUMP_FILE}")",
  "dump_sha256": "${DUMP_SHA256}",
  "globals_file": "$(basename "${GLOBALS_FILE}")",
  "extensions": ${EXTENSIONS_JSON},
  "table_row_counts": {
$(awk -F',' '{printf "    \"%s\": %s,\n", $1, $2}' "${RUN_DIR}/row_counts.csv" | sed '$ s/,$//')
  }
}
EOF
rm -f "${RUN_DIR}/row_counts.csv"
sha256sum "${MANIFEST_FILE}" > "${MANIFEST_FILE}.sha256"
echo "[$(date -u)] Manifesto gerado em: ${MANIFEST_FILE}"

# ------------------------------------------------------------------------------
# 7. CIFRAGEM EM REPOUSO (AES-256-GCM / PBKDF2 OU GPG)
# ------------------------------------------------------------------------------
if [[ "${ENCRYPTION_METHOD}" == "openssl" ]]; then
  echo "[$(date -u)] Cifrando dump e globais com OpenSSL (AES-256-CBC com PBKDF2)..."
  
  openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
    -in "${DUMP_FILE}" \
    -out "${DUMP_FILE}.enc" \
    -pass "env:BACKUP_ENCRYPTION_KEY"
  
  openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
    -in "${GLOBALS_FILE}" \
    -out "${GLOBALS_FILE}.enc" \
    -pass "env:BACKUP_ENCRYPTION_KEY"
    
  sha256sum "${DUMP_FILE}.enc" > "${DUMP_FILE}.enc.sha256"
  sha256sum "${GLOBALS_FILE}.enc" > "${GLOBALS_FILE}.enc.sha256"

  # Remover os arquivos claros após cifragem confirmada
  rm -f "${DUMP_FILE}" "${GLOBALS_FILE}"
  echo "[$(date -u)] Arquivos claros removidos após cifragem bem-sucedida."

elif [[ "${ENCRYPTION_METHOD}" == "gpg" ]]; then
  echo "[$(date -u)] Cifrando dump e globais com GPG (AES-256)..."
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase "${BACKUP_ENCRYPTION_KEY}" \
    --output "${DUMP_FILE}.gpg" "${DUMP_FILE}"
    
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase "${BACKUP_ENCRYPTION_KEY}" \
    --output "${GLOBALS_FILE}.gpg" "${GLOBALS_FILE}"

  sha256sum "${DUMP_FILE}.gpg" > "${DUMP_FILE}.gpg.sha256"
  sha256sum "${GLOBALS_FILE}.gpg" > "${GLOBALS_FILE}.gpg.sha256"
  rm -f "${DUMP_FILE}" "${GLOBALS_FILE}"
  echo "[$(date -u)] Arquivos claros removidos após cifragem bem-sucedida."
fi

# ------------------------------------------------------------------------------
# 8. PURGA DE BACKUPS LOCAIS EXPIRADOS (RETENÇÃO)
# ------------------------------------------------------------------------------
echo "[$(date -u)] Verificando backups locais com mais de ${RETENTION_DAYS} dias para expiração..."
find "${BACKUP_DIR}" -maxdepth 1 -type d -name "medicina2029_backup_*" -mtime "+${RETENTION_DAYS}" -exec rm -rf {} + || true

echo "======================================================================"
echo "[$(date -u)] BACKUP OPERACIONAL CONCLUÍDO COM SUCESSO!"
echo "Diretório de Artefatos: ${RUN_DIR}"
echo "======================================================================"
