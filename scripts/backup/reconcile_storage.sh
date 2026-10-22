#!/usr/bin/env bash
# ==============================================================================
# PROJETO MEDICINA 2029 — RECONCILIAÇÃO BANCO POSTGRESQL VS STORAGE (F1.15)
# Script de auditoria cruzada entre metadados (acervo_arquivos) e binários no Storage.
# ==============================================================================
set -euo pipefail

TARGET_PGDATABASE="${1:-medicina2029}"
TARGET_PGHOST="${TARGET_PGHOST:-localhost}"
TARGET_PGPORT="${TARGET_PGPORT:-5432}"
TARGET_PGUSER="${TARGET_PGUSER:-postgres}"

echo "======================================================================"
echo "[$(date -u)] RECONCILIAÇÃO POSTGRESQL (acervo_arquivos) VS STORAGE PRIVADO"
echo "Banco: ${TARGET_PGDATABASE}"
echo "======================================================================"

REPORT_FILE="./storage_reconciliation_$(date -u +"%Y%m%d_%H%M%SZ").csv"

echo "id,titulo,file_path,tamanho_bytes,hash_conteudo,status_storage" > "${REPORT_FILE}"

echo "[$(date -u)] Extraindo lista de arquivos registrados no acervo..."

ROWS=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -F"|" -c "
  SELECT id, titulo, file_path, tamanho_bytes, hash_conteudo
  FROM public.acervo_arquivos
  ORDER BY enviado_em DESC;
")

TOTAL_FILES=0
MISSING_FILES=0

while IFS='|' read -r id titulo file_path tamanho_bytes hash_conteudo; do
  if [[ -z "${id}" ]]; then
    continue
  fi
  TOTAL_FILES=$((TOTAL_FILES + 1))
  
  # Caso o ambiente possua storage.objects no próprio PostgreSQL (mock ou Supabase nativo):
  STORAGE_EXISTS=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
    SELECT CASE WHEN to_regclass('storage.objects') IS NOT NULL THEN (
      SELECT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'acervo' AND name = '${file_path}')
    ) ELSE NULL END;
  " || echo "")

  STATUS="UNKNOWN"
  if [[ "${STORAGE_EXISTS}" == "t" ]]; then
    STATUS="SYNCHRONIZED"
  elif [[ "${STORAGE_EXISTS}" == "f" ]]; then
    STATUS="MISSING_IN_STORAGE"
    MISSING_FILES=$((MISSING_FILES + 1))
  else
    STATUS="STORAGE_OBJECTS_TABLE_NOT_LOCAL"
  fi

  echo "${id},\"${titulo}\",\"${file_path}\",${tamanho_bytes},${hash_conteudo},${STATUS}" >> "${REPORT_FILE}"
done <<< "${ROWS}"

echo "======================================================================"
echo "Total de arquivos no acervo: ${TOTAL_FILES}"
echo "Arquivos com status ausente no schema storage: ${MISSING_FILES}"
echo "Relatório gravado em: ${REPORT_FILE}"
echo "======================================================================"
