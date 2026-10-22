#!/usr/bin/env bash
# ==============================================================================
# PROJETO MEDICINA 2029 — VALIDAÇÃO DA ROTINA DE CIFRAGEM OPENSSL (F1.15 / F1.16)
# ==============================================================================
# Validação ponta a ponta:
# 1. Gera dump sintético de dados pseudo-aleatórios com metadados.
# 2. Calcula e armazena hash SHA-256 do arquivo original.
# 3. Executa cifragem simétrica via OpenSSL conforme backup_postgres.sh:
#    openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt
# 4. Executa decifragem via OpenSSL conforme restore_postgres.sh:
#    openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000
# 5. Calcula hash SHA-256 do arquivo decifrado.
# 6. Compara os hashes e atesta 100% de paridade binária idêntica.
# ==============================================================================
set -euo pipefail

TEST_DIR=$(mktemp -d -t medicina2029_crypto_test_XXXXXX)
trap 'rm -rf "${TEST_DIR}"' EXIT

BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-medicina2029_master_audit_key_f116_test_$(date +%s)}"
export BACKUP_ENCRYPTION_KEY

ORIG_DUMP="${TEST_DIR}/synthetic_medicina_db.dump"
ENC_DUMP="${TEST_DIR}/synthetic_medicina_db.dump.enc"
DEC_DUMP="${TEST_DIR}/decrypted_medicina_db.dump"

echo "======================================================================"
echo "[$(date -u)] TESTE DE CIFRAGEM E DECIFRAGEM ROUND-TRIP (OPENSSL AES-256)"
echo "Diretório Temporário: ${TEST_DIR}"
echo "======================================================================"

# 1. Gera dump sintético (128 KiB de conteúdo simulando PostgreSQL TOC + dados)
echo "[1/5] Gerando arquivo de dump sintético..."
cat << 'EOMOCK' > "${ORIG_DUMP}"
PGDMP-MOCK-HEADER-v18.6
TOC: public.perfis, public.sessoes, public.acervo_arquivos, public.acervo_chunks
EOMOCK
# Adiciona 128 KiB de dados determinísticos
dd if=/dev/urandom bs=1024 count=128 >> "${ORIG_DUMP}" 2>/dev/null

ORIG_SIZE=$(wc -c < "${ORIG_DUMP}" | tr -d ' ')
ORIG_SHA256=$(openssl dgst -sha256 "${ORIG_DUMP}" | awk '{print $NF}')
echo "  Tamanho original: ${ORIG_SIZE} bytes"
echo "  Hash original SHA-256: ${ORIG_SHA256}"

# 2. Cifragem com OpenSSL conforme scripts/backup/backup_postgres.sh
echo "[2/5] Executando cifragem AES-256-CBC (PBKDF2, 100.000 iterações)..."
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
  -in "${ORIG_DUMP}" \
  -out "${ENC_DUMP}" \
  -pass "env:BACKUP_ENCRYPTION_KEY"

ENC_SIZE=$(wc -c < "${ENC_DUMP}" | tr -d ' ')
echo "  Arquivo cifrado gerado (${ENC_SIZE} bytes)."

# 3. Decifragem com OpenSSL conforme scripts/backup/restore_postgres.sh
echo "[3/5] Executando decifragem com a chave mestra..."
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  -in "${ENC_DUMP}" \
  -out "${DEC_DUMP}" \
  -pass "env:BACKUP_ENCRYPTION_KEY"

DEC_SIZE=$(wc -c < "${DEC_DUMP}" | tr -d ' ')
DEC_SHA256=$(openssl dgst -sha256 "${DEC_DUMP}" | awk '{print $NF}')
echo "  Arquivo decifrado recuperado (${DEC_SIZE} bytes)."
echo "  Hash decifrado SHA-256: ${DEC_SHA256}"

# 4. Verificação estrita de igualdade
echo "[4/5] Comparando somas criptográficas e igualdade de bytes..."
if [[ "${ORIG_SHA256}" != "${DEC_SHA256}" ]]; then
  echo "ERRO CRÍTICO: Divergência de hash SHA-256 entre original e decifrado!" >&2
  exit 1
fi

if ! cmp -s "${ORIG_DUMP}" "${DEC_DUMP}"; then
  echo "ERRO CRÍTICO: Conteúdo binário divergiu após decifragem!" >&2
  exit 1
fi

# 5. Teste negativo com chave incorreta (deve falhar e não produzir dados válidos)
echo "[5/5] Testando rejeição defensiva com chave incorreta (fail-closed)..."
INVALID_DEC="${TEST_DIR}/invalid.dump"
if openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
    -in "${ENC_DUMP}" \
    -out "${INVALID_DEC}" \
    -pass "pass:chave_completamente_incorreta_e_invalida" 2>/dev/null; then
  echo "ERRO CRÍTICO: Decifragem com chave incorreta deveria ter falhado!" >&2
  exit 1
else
  echo "  [OK] Decifragem com chave incorreta foi sumariamente rejeitada pelo OpenSSL."
fi

echo "======================================================================"
echo "[$(date -u)] SUCESSO: CIFRAGEM E DECIFRAGEM 100% ÍNTEGRA E IDÊNTICA AO ORIGINAL!"
echo "SHA-256 Verificado: ${ORIG_SHA256}"
echo "======================================================================"
