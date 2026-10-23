#!/usr/bin/env bash
# ==============================================================================
# PROJETO MEDICINA 2029 — VALIDAÇÃO DA ROTINA DE CIFRAGEM NATIVA (F1.15 / H0.01)
# ==============================================================================
# Validação ponta a ponta:
# 1. Gera dump sintético de dados pseudo-aleatórios com metadados.
# 2. Cifragem simétrica autenticada AEAD (AES-256-GCM com Tag 128-bit) via crypto_envelope.mjs.
# 3. Decifragem autenticada e verificação de integridade estrita SHA-256 (byte-a-byte).
# 4. Testes de inviolabilidade criptográfica (Tamper Resistance):
#    a) Bit-flip no ciphertext (detecção e rejeição imediata via Tag GHASH).
#    b) Adulteração da Tag de autenticação (rejeição imediata).
#    c) Adulteração do IV/Nonce (rejeição imediata).
#    d) Decifragem com chave incorreta (fail-closed defensivo).
# 5. Compatibilidade retroativa com arquivos legados OpenSSL AES-256-CBC (PBKDF2).
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRYPTO_SCRIPT="${SCRIPT_DIR}/crypto_envelope.mjs"

if [[ ! -f "${CRYPTO_SCRIPT}" ]]; then
  echo "ERRO CRÍTICO: Utilitário ${CRYPTO_SCRIPT} não encontrado!" >&2
  exit 1
fi

TEST_DIR=$(mktemp -d -t medicina2029_crypto_test_XXXXXX)
trap 'rm -rf "${TEST_DIR}"' EXIT

BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-medicina2029_master_audit_key_h001_test_$(date +%s)}"
export BACKUP_ENCRYPTION_KEY

ORIG_DUMP="${TEST_DIR}/synthetic_medicina_db.dump"
GCM_ENC_DUMP="${TEST_DIR}/synthetic_medicina_db.dump.m29g"
GCM_DEC_DUMP="${TEST_DIR}/decrypted_medicina_db.dump"

echo "======================================================================"
echo "[$(date -u)] TESTE CRIPTOGRÁFICO INTEGRAL: AEAD AES-256-GCM & RETRO-CBC"
echo "Diretório Temporário: ${TEST_DIR}"
echo "======================================================================"

# 1. Gera dump sintético (128 KiB de conteúdo simulando PostgreSQL TOC + dados)
echo "[1/6] Gerando arquivo de dump sintético (128 KiB com metadados)..."
cat << 'EOMOCK' > "${ORIG_DUMP}"
PGDMP-MOCK-HEADER-v18.6
TOC: public.perfis, public.sessoes, public.acervo_arquivos, public.acervo_chunks
EOMOCK
dd if=/dev/urandom bs=1024 count=128 >> "${ORIG_DUMP}" 2>/dev/null

ORIG_SIZE=$(wc -c < "${ORIG_DUMP}" | tr -d ' ')
ORIG_SHA256=$(openssl dgst -sha256 "${ORIG_DUMP}" | awk '{print $NF}')
echo "  Tamanho original: ${ORIG_SIZE} bytes"
echo "  Hash original SHA-256: ${ORIG_SHA256}"

# 2. Cifragem AEAD com AES-256-GCM via crypto_envelope.mjs
echo "[2/6] Executando cifragem AEAD (AES-256-GCM, PBKDF2 100k, Nonce 96-bit, Tag 128-bit)..."
node "${CRYPTO_SCRIPT}" encrypt "${ORIG_DUMP}" "${GCM_ENC_DUMP}"
GCM_ENC_SIZE=$(wc -c < "${GCM_ENC_DUMP}" | tr -d ' ')
echo "  Envelope binário AEAD gerado (${GCM_ENC_SIZE} bytes)."

# 3. Decifragem AEAD com AES-256-GCM e verificação de paridade
echo "[3/6] Executando decifragem AEAD e verificando autenticidade..."
node "${CRYPTO_SCRIPT}" decrypt "${GCM_ENC_DUMP}" "${GCM_DEC_DUMP}"

GCM_DEC_SIZE=$(wc -c < "${GCM_DEC_DUMP}" | tr -d ' ')
GCM_DEC_SHA256=$(openssl dgst -sha256 "${GCM_DEC_DUMP}" | awk '{print $NF}')

if [[ "${ORIG_SHA256}" != "${GCM_DEC_SHA256}" ]]; then
  echo "ERRO CRÍTICO: Divergência de hash SHA-256 no round-trip AES-256-GCM!" >&2
  exit 1
fi
if ! cmp -s "${ORIG_DUMP}" "${GCM_DEC_DUMP}"; then
  echo "ERRO CRÍTICO: Conteúdo binário divergiu após decifragem GCM!" >&2
  exit 1
fi
echo "  [OK] Autenticidade e paridade byte-a-byte 100% verificadas (SHA-256 idêntico)."

# 4. Testes de Violação e Detecção de Adulteração (Bit-Flipping Attacks)
echo "[4/6] Executando auditoria contra adulteração de blocos (Bit-Flipping / Tamper Resistance)..."

# 4a. Bit-flip no Ciphertext
CORRUPT_CIPHER="${TEST_DIR}/corrupt_ciphertext.m29g"
cp "${GCM_ENC_DUMP}" "${CORRUPT_CIPHER}"
node -e "
const fs = require('fs');
const buf = fs.readFileSync('${CORRUPT_CIPHER}');
buf[60] ^= 0x01; // Inverte 1 bit no ciphertext
fs.writeFileSync('${CORRUPT_CIPHER}', buf);
"
if node "${CRYPTO_SCRIPT}" decrypt "${CORRUPT_CIPHER}" "${TEST_DIR}/fail.out" 2>/dev/null; then
  echo "ERRO DE SEGURANÇA: Bit-flip no ciphertext foi aceito indevidamente!" >&2
  exit 1
else
  echo "  [OK] Bit-flip no ciphertext sumariamente detectado e rejeitado (AEAD GHASH)."
fi

# 4b. Adulteração na Tag de Autenticação
CORRUPT_TAG="${TEST_DIR}/corrupt_tag.m29g"
cp "${GCM_ENC_DUMP}" "${CORRUPT_TAG}"
node -e "
const fs = require('fs');
const buf = fs.readFileSync('${CORRUPT_TAG}');
buf[35] ^= 0x01; // Inverte 1 bit na Tag
fs.writeFileSync('${CORRUPT_TAG}', buf);
"
if node "${CRYPTO_SCRIPT}" decrypt "${CORRUPT_TAG}" "${TEST_DIR}/fail.out" 2>/dev/null; then
  echo "ERRO DE SEGURANÇA: Adulteração na Tag de autenticação foi aceita indevidamente!" >&2
  exit 1
else
  echo "  [OK] Adulteração na Tag de autenticação rejeitada."
fi

# 4c. Adulteração no IV/Nonce
CORRUPT_IV="${TEST_DIR}/corrupt_iv.m29g"
cp "${GCM_ENC_DUMP}" "${CORRUPT_IV}"
node -e "
const fs = require('fs');
const buf = fs.readFileSync('${CORRUPT_IV}');
buf[25] ^= 0x01; // Inverte 1 bit no IV
fs.writeFileSync('${CORRUPT_IV}', buf);
"
if node "${CRYPTO_SCRIPT}" decrypt "${CORRUPT_IV}" "${TEST_DIR}/fail.out" 2>/dev/null; then
  echo "ERRO DE SEGURANÇA: Adulteração no IV foi aceita indevidamente!" >&2
  exit 1
else
  echo "  [OK] Adulteração no IV sumariamente rejeitada."
fi

# 5. Teste de Rejeição com Chave Incorreta
echo "[5/6] Testando rejeição defensiva com chave incorreta (fail-closed)..."
if BACKUP_ENCRYPTION_KEY="chave_completamente_incorreta_e_invalida" \
    node "${CRYPTO_SCRIPT}" decrypt "${GCM_ENC_DUMP}" "${TEST_DIR}/fail.out" 2>/dev/null; then
  echo "ERRO CRÍTICO: Decifragem com chave incorreta deveria ter falhado!" >&2
  exit 1
else
  echo "  [OK] Decifragem com chave incorreta rejeitada sem liberação de dados claros."
fi

# 6. Teste de Compatibilidade Retroativa (Backwards Compatibility) com OpenSSL AES-256-CBC
echo "[6/6] Validando compatibilidade retroativa com arquivos legados OpenSSL AES-256-CBC..."
LEGACY_ENC="${TEST_DIR}/legacy_backup.dump.enc"
LEGACY_DEC="${TEST_DIR}/legacy_recovered.dump"

openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
  -in "${ORIG_DUMP}" \
  -out "${LEGACY_ENC}" \
  -pass "env:BACKUP_ENCRYPTION_KEY"

node "${CRYPTO_SCRIPT}" decrypt "${LEGACY_ENC}" "${LEGACY_DEC}" 2> "${TEST_DIR}/legacy_warning.log"

if ! grep -q "LEGACY WARNING" "${TEST_DIR}/legacy_warning.log"; then
  echo "AVISO: Log de aviso sobre formato legado CBC não foi emitido."
fi

LEGACY_DEC_SHA256=$(openssl dgst -sha256 "${LEGACY_DEC}" | awk '{print $NF}')
if [[ "${ORIG_SHA256}" != "${LEGACY_DEC_SHA256}" ]]; then
  echo "ERRO CRÍTICO: Falha na recuperação de backup legado OpenSSL CBC!" >&2
  exit 1
fi
echo "  [OK] Backup legado OpenSSL CBC decifrado com sucesso e paridade SHA-256 confirmada."

echo "======================================================================"
echo "[$(date -u)] SUCESSO PLENO: CRIPTOGRAFIA AUTENTICADA AEAD E RETRO-CBC HOMOLOGADAS!"
echo "SHA-256 Verificado: ${ORIG_SHA256}"
echo "======================================================================"
