#!/usr/bin/env bash
# ==============================================================================
# PROJETO MEDICINA 2029 — OPERAÇÃO DE RESTAURAÇÃO POSTGRESQL (F1.15)
# Script canônico de restauração, decifragem, reconstituição e validação de paridade.
# ==============================================================================
set -euo pipefail

# ------------------------------------------------------------------------------
# 1. PARÂMETROS E CONFIGURAÇÕES
# ------------------------------------------------------------------------------
# Inclui diretórios padrão do libpq no macOS se presentes
if [[ -d "/opt/homebrew/opt/libpq/bin" ]]; then
  export PATH="/opt/homebrew/opt/libpq/bin:${PATH}"
elif [[ -d "/usr/local/opt/libpq/bin" ]]; then
  export PATH="/usr/local/opt/libpq/bin:${PATH}"
fi

if [[ $# -lt 1 ]]; then
  echo "Uso: $0 <caminho_do_diretorio_de_backup> [banco_alvo]"
  echo "Exemplo: $0 ./backups/medicina2029_backup_20261021_030000Z medicina2029_staging"
  exit 1
fi

SOURCE_DIR="$1"
TARGET_PGDATABASE="${2:-medicina2029_staging}"

TARGET_PGHOST="${TARGET_PGHOST:-127.0.0.1}"
TARGET_PGPORT="${TARGET_PGPORT:-5433}"
TARGET_PGUSER="${TARGET_PGUSER:-postgres}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"
ENCRYPTION_METHOD="${ENCRYPTION_METHOD:-auto}" # auto | openssl | gpg | none
RESTORE_GLOBALS="${RESTORE_GLOBALS:-false}"
PARALLEL_JOBS="${PARALLEL_JOBS:-4}"

# SALVAGUARDA DE SEGURANÇA: Bloqueio estrito contra restauração no Supabase remoto ou qualquer host externo (FAIL-CLOSED)
if [[ "${TARGET_PGHOST}" =~ supabase\.co || "${TARGET_PGHOST}" =~ pooler\.supabase\.com || "${TARGET_PGHOST}" =~ aws-0-us-east-1 ]]; then
  echo "======================================================================" >&2
  echo "VIOLAÇÃO CRÍTICA DE SEGURANÇA (FAIL-CLOSED):" >&2
  echo "É terminantemente proibido utilizar o Supabase remoto como destino" >&2
  echo "de restauração de backup! Alvo informado: ${TARGET_PGHOST}" >&2
  echo "A restauração deve ocorrer exclusivamente em PostgreSQL descartável local." >&2
  echo "======================================================================" >&2
  exit 1
fi

if [[ "${TARGET_PGHOST}" != "127.0.0.1" && "${TARGET_PGHOST}" != "localhost" ]]; then
  echo "======================================================================" >&2
  echo "VIOLAÇÃO DE ISOLAMENTO LOCAL (FAIL-CLOSED):" >&2
  echo "A restauração só é permitida em loopback local (127.0.0.1 ou localhost)." >&2
  echo "Host externo/não-local expressamente recusado: ${TARGET_PGHOST}" >&2
  echo "======================================================================" >&2
  exit 1
fi

TMP_RESTORE_DIR=$(mktemp -d -t medicina2029_restore_XXXXXX)
chmod 700 "${TMP_RESTORE_DIR}"
cleanup() {
  unset BACKUP_ENCRYPTION_KEY 2>/dev/null || true
  if [[ -d "${TMP_RESTORE_DIR}" ]]; then
    rm -rf "${TMP_RESTORE_DIR}"
  fi
}
trap cleanup EXIT INT TERM HUP

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
ENC_DUMP=$(find "${SOURCE_DIR}" -maxdepth 1 \( -name "*.dump.enc" -o -name "*.dump.gpg" \) | head -n 1 || true)
RAW_DUMP=$(find "${SOURCE_DIR}" -maxdepth 1 -name "*.dump" | head -n 1 || true)
RAW_MANIFEST=$(find "${SOURCE_DIR}" -maxdepth 1 -name "*_manifest.json" | head -n 1 || true)
ENC_MANIFEST=$(find "${SOURCE_DIR}" -maxdepth 1 -name "*_manifest.json.enc" | head -n 1 || true)

# Se necessário, solicita senha interativa sem eco ou lê de stdin redirecionado
if [[ (-n "${ENC_DUMP}" || -n "${ENC_MANIFEST}") && -z "${BACKUP_ENCRYPTION_KEY}" ]]; then
  if [[ -t 0 ]]; then
    echo -n "🔑 Digite a chave mestra de descriptografia do backup: "
    read -r -s BACKUP_ENCRYPTION_KEY
    echo ""
  else
    read -r BACKUP_ENCRYPTION_KEY || true
  fi

  if [[ -z "${BACKUP_ENCRYPTION_KEY}" ]]; then
    echo "ERRO CRÍTICO: Chave mestra de descriptografia não informada (nem interativamente, nem via pipe stdin, nem no ambiente)." >&2
    exit 1
  fi
fi

# Decifra ou localiza o manifesto
MANIFEST_FILE="${TMP_RESTORE_DIR}/manifest.json"
if [[ -n "${RAW_MANIFEST}" && -f "${RAW_MANIFEST}" ]]; then
  echo "[$(date -u)] Manifesto em texto claro identificado: ${RAW_MANIFEST}"
  cp "${RAW_MANIFEST}" "${MANIFEST_FILE}"
elif [[ -n "${ENC_MANIFEST}" && -f "${ENC_MANIFEST}" ]]; then
  echo "[$(date -u)] Decifrando manifesto criptografado (${ENC_MANIFEST})..."
  CRYPTO_SCRIPT="$(dirname "$0")/crypto_envelope.mjs"
  if ! printf '%s' "${BACKUP_ENCRYPTION_KEY}" | node "${CRYPTO_SCRIPT}" decrypt "${ENC_MANIFEST}" "${MANIFEST_FILE}" --key-stdin; then
    echo "ERRO CRÍTICO: Falha na descriptografia do manifesto. Operação abortada sumariamente." >&2
    exit 2
  fi
else
  echo "ERRO CRÍTICO: Arquivo de manifesto (*_manifest.json ou *_manifest.json.enc) não encontrado em ${SOURCE_DIR}." >&2
  exit 1
fi

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
      if ! printf '%s' "${BACKUP_ENCRYPTION_KEY}" | node "${CRYPTO_SCRIPT}" decrypt "${ENC_DUMP}" "${DUMP_TO_RESTORE}" --key-stdin; then
        echo "ERRO CRÍTICO: Falha na descriptografia do dump. Operação abortada sumariamente." >&2
        exit 2
      fi
    else
      echo "[$(date -u)] Decifrando dump com OpenSSL (AES-256-CBC legado)..."
      if ! printf '%s' "${BACKUP_ENCRYPTION_KEY}" | openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
        -in "${ENC_DUMP}" \
        -out "${DUMP_TO_RESTORE}" \
        -pass stdin; then
        echo "ERRO CRÍTICO: Falha na descriptografia com OpenSSL. Operação abortada sumariamente." >&2
        exit 2
      fi
    fi
  elif [[ "${ENC_DUMP}" == *.gpg ]]; then
    if [[ -z "${BACKUP_ENCRYPTION_KEY}" ]]; then
      echo "ERRO CRÍTICO: BACKUP_ENCRYPTION_KEY não informada para decifrar arquivo GPG." >&2
      exit 1
    fi
    echo "[$(date -u)] Decifrando dump com GPG..."
    if ! printf '%s' "${BACKUP_ENCRYPTION_KEY}" | gpg --batch --yes --decrypt \
      --passphrase-fd 0 \
      --output "${DUMP_TO_RESTORE}" "${ENC_DUMP}"; then
      echo "ERRO CRÍTICO: Falha na descriptografia com GPG. Operação abortada sumariamente." >&2
      exit 2
    fi
  fi
elif [[ -n "${RAW_DUMP}" && -f "${RAW_DUMP}" ]]; then
  echo "[$(date -u)] Arquivo de dump em formato claro identificado: ${RAW_DUMP}"
  cp "${RAW_DUMP}" "${DUMP_TO_RESTORE}"
else
  echo "ERRO CRÍTICO: Nenhum arquivo de dump (.dump, .dump.enc ou .dump.gpg) encontrado!" >&2
  exit 1
fi

# PURGA DA CHAVE: A chave foi transmitida estritamente via descritor IPC anônimo (stdin).
# Eliminamos a chave imediatamente da memória do processo shell antes de qualquer validação ou conexão.
unset BACKUP_ENCRYPTION_KEY

# ------------------------------------------------------------------------------
# 3. VALIDAÇÃO DE INTEGRIDADE SHA-256 E TABELA DE CONTEÚDOS (TOC)
# ------------------------------------------------------------------------------
echo "[$(date -u)] Verificando hash SHA-256 do dump decifrado contra o manifesto..."
if command -v sha256sum &>/dev/null; then
  CALCULATED_SHA256=$(sha256sum "${DUMP_TO_RESTORE}" | awk '{print $1}')
else
  CALCULATED_SHA256=$(shasum -a 256 "${DUMP_TO_RESTORE}" | awk '{print $1}')
fi
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
# 4. PREPARAÇÃO DO BANCO ALVO E DEPENDÊNCIAS (H2.03-R2A)
# ------------------------------------------------------------------------------
echo "[$(date -u)] Preparando banco de destino e dependências no ambiente descartável: ${TARGET_PGDATABASE}..."
psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d postgres -v ON_ERROR_STOP=1 << EOSQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TARGET_PGDATABASE}' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "${TARGET_PGDATABASE}";
CREATE DATABASE "${TARGET_PGDATABASE}";

-- Prepara roles técnicas locais NOLOGIN para satisfazer integridade de catálogo/RLS
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_app') THEN
    CREATE ROLE medicina_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_auth') THEN
    CREATE ROLE medicina_auth NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_worker') THEN
    CREATE ROLE medicina_worker NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END \$\$;
EOSQL

echo "[$(date -u)] Configurando schema extensions, extensões e search_path no banco alvo..."
psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -v ON_ERROR_STOP=1 << EOSQL
-- Schema extensions isolado idêntico à convenção Supabase
CREATE SCHEMA IF NOT EXISTS extensions;

-- Instalação de extensões obrigatórias no schema extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;

-- Configuração de search_path compatível
ALTER DATABASE "${TARGET_PGDATABASE}" SET search_path TO public, extensions;

-- Remove o schema public vazio inicial gerado pelo template para permitir que pg_restore recrie public e medicina de forma limpa
DROP SCHEMA IF EXISTS public CASCADE;
EOSQL

# ------------------------------------------------------------------------------
# 5. RESTAURAÇÃO COMPLETA COM PG_RESTORE (EXIGÊNCIA DE ERRO FATAL EM FALHA)
# ------------------------------------------------------------------------------
echo "[$(date -u)] Executando pg_restore (jobs paralelos: ${PARALLEL_JOBS})..."

# Exigir pg_restore com erro fatal em falha. Não declarar sucesso com erros ignorados.
if ! pg_restore \
  -h "${TARGET_PGHOST}" \
  -p "${TARGET_PGPORT}" \
  -U "${TARGET_PGUSER}" \
  -d "${TARGET_PGDATABASE}" \
  --no-owner \
  --no-privileges \
  --verbose \
  --jobs="${PARALLEL_JOBS}" \
  "${DUMP_TO_RESTORE}"; then
  echo "======================================================================" >&2
  echo "ERRO FATAL: pg_restore falhou durante a reconstituição dos objetos!" >&2
  echo "Operação abortada sumariamente (fail-closed)." >&2
  echo "======================================================================" >&2
  exit 1
fi
echo "[$(date -u)] pg_restore concluído com código de saída ZERO (100% de sucesso sem erros ignorados)."

# LIMPEZA IMEDIATA: Remoção imediata do dump decifrado após a restauração
if [[ -f "${DUMP_TO_RESTORE}" ]]; then
  rm -f "${DUMP_TO_RESTORE}"
  echo "[$(date -u)] Arquivo de dump temporário decifrado removido com sucesso (zero cópias claras mantidas)."
fi

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
