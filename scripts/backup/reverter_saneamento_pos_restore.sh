#!/usr/bin/env bash
# ==============================================================================
# PROJETO MEDICINA 2029 — REVERSÃO DE SANEAMENTO PÓS-RESTORE (F1.16)
# ==============================================================================
# Procedimento de auditoria forense:
# Restaura o estado anterior exato de sessões e jobs a partir da tabela
# public.auditoria_saneamento_restore para um dado restauracao_id.
# ==============================================================================
set -euo pipefail

TARGET_PGDATABASE="${1:-medicina2029_staging}"
RESTORE_ID="${2:-}"

TARGET_PGHOST="${TARGET_PGHOST:-localhost}"
TARGET_PGPORT="${TARGET_PGPORT:-5432}"
TARGET_PGUSER="${TARGET_PGUSER:-postgres}"

if [[ -z "${RESTORE_ID}" ]]; then
  echo "Uso: $0 <banco_alvo> <restauracao_id>"
  echo "Exemplo: $0 medicina2029_staging restore_20261021_030000Z"
  exit 1
fi

echo "======================================================================"
echo "[$(date -u)] REVERTENDO SANEAMENTO PÓS-RESTORE (AUDITORIA FORENSE)"
echo "Banco: ${TARGET_PGHOST}:${TARGET_PGPORT}/${TARGET_PGDATABASE}"
echo "Identificador da Restauração a Reverter: ${RESTORE_ID}"
echo "======================================================================"

psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -v ON_ERROR_STOP=1 << EOSQL
BEGIN;

-- 1. Valida existência da tabela de auditoria
IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'auditoria_saneamento_restore') THEN
  RAISE EXCEPTION 'Tabela public.auditoria_saneamento_restore não existe.';
END IF;

-- 2. Reverte sessões
UPDATE public.sessoes s
SET
  encerrada_em = (a.estado_anterior->>'encerrada_em')::timestamptz,
  concluida = (a.estado_anterior->>'concluida')::boolean,
  nota_livre = a.estado_anterior->>'nota_livre'
FROM public.auditoria_saneamento_restore a
WHERE a.tabela = 'sessoes'
  AND a.restauracao_id = '${RESTORE_ID}'
  AND s.id = a.registro_id;

-- 3. Reverte jobs se existirem
IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'acervo_jobs') THEN
  UPDATE public.acervo_jobs j
  SET
    status = a.estado_anterior->>'status',
    locked_by = a.estado_anterior->>'locked_by',
    locked_at = (a.estado_anterior->>'locked_at')::timestamptz,
    lease_expires_at = (a.estado_anterior->>'lease_expires_at')::timestamptz,
    ultimo_erro_codigo = a.estado_anterior->>'ultimo_erro_codigo',
    ultimo_erro_mensagem = a.estado_anterior->>'ultimo_erro_mensagem'
  FROM public.auditoria_saneamento_restore a
  WHERE a.tabela = 'acervo_jobs'
    AND a.restauracao_id = '${RESTORE_ID}'
    AND j.id = a.registro_id;
END IF;

COMMIT;
EOSQL

echo "[$(date -u)] REVERSÃO DO SANEAMENTO CONCLUÍDA COM ÊXITO."
