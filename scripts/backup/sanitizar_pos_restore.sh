#!/usr/bin/env bash
# ==============================================================================
# PROJETO MEDICINA 2029 — SANEAMENTO PÓS-RESTORE COM RASTREABILIDADE (F1.15 / F1.16)
# ==============================================================================
# Critério explícito:
# 1. Sessões com encerrada_em IS NULL são determinísticamente encerradas.
# 2. Jobs de acervo com status = 'em_execucao' são rearmados para 'aguardando'.
# 3. Todo o estado anterior é registrado em public.auditoria_saneamento_restore
#    para possibilitar auditoria forense e reversibilidade estrita.
# ==============================================================================
set -euo pipefail

TARGET_PGDATABASE="${1:-medicina2029_staging}"
RESTORE_ID="${2:-restore_$(date -u +%Y%m%d_%H%M%SZ)}"

TARGET_PGHOST="${TARGET_PGHOST:-localhost}"
TARGET_PGPORT="${TARGET_PGPORT:-5432}"
TARGET_PGUSER="${TARGET_PGUSER:-postgres}"

echo "======================================================================"
echo "[$(date -u)] INICIANDO SANEAMENTO OPERACIONAL PÓS-RESTORE"
echo "Banco: ${TARGET_PGHOST}:${TARGET_PGPORT}/${TARGET_PGDATABASE}"
echo "Identificador da Restauração: ${RESTORE_ID}"
echo "======================================================================"

psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -v ON_ERROR_STOP=1 << EOSQL
BEGIN;

-- 1. Cria tabela de auditoria se não existir
CREATE TABLE IF NOT EXISTS public.auditoria_saneamento_restore (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restauracao_id text NOT NULL,
  executado_em timestamptz NOT NULL DEFAULT now(),
  tabela text NOT NULL,
  registro_id uuid NOT NULL,
  estado_anterior jsonb NOT NULL,
  estado_novo jsonb NOT NULL,
  motivo text NOT NULL
);

-- 2. Audita e saneia sessões zumbis (encerrada_em IS NULL)
WITH sessoes_para_sanear AS (
  SELECT
    id,
    encerrada_em,
    concluida,
    nota_livre,
    iniciada_em,
    segundos_efetivos
  FROM public.sessoes
  WHERE encerrada_em IS NULL
  FOR UPDATE
),
registro_auditoria_sessoes AS (
  INSERT INTO public.auditoria_saneamento_restore (
    restauracao_id,
    tabela,
    registro_id,
    estado_anterior,
    estado_novo,
    motivo
  )
  SELECT
    '${RESTORE_ID}',
    'sessoes',
    s.id,
    jsonb_build_object(
      'encerrada_em', s.encerrada_em,
      'concluida', s.concluida,
      'nota_livre', s.nota_livre
    ),
    jsonb_build_object(
      'encerrada_em', COALESCE(s.iniciada_em + (s.segundos_efetivos || ' seconds')::interval, now()),
      'concluida', false,
      'nota_livre', COALESCE(s.nota_livre || ' ', '') || '[SANEAMENTO_POST_RESTORE: restauracao_id=${RESTORE_ID} anterior_encerrada_em=NULL]'
    ),
    'Fechamento defensivo de sessao zumbi aberta no momento do backup'
  FROM sessoes_para_sanear s
  RETURNING registro_id, estado_novo
)
UPDATE public.sessoes s
SET
  encerrada_em = (a.estado_novo->>'encerrada_em')::timestamptz,
  concluida = false,
  nota_livre = a.estado_novo->>'nota_livre'
FROM registro_auditoria_sessoes a
WHERE s.id = a.registro_id;

-- 3. Audita e rearma jobs em voo (status = 'em_execucao') caso a tabela exista
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'acervo_jobs') THEN
    WITH jobs_para_sanear AS (
      SELECT
        id,
        status,
        locked_by,
        locked_at,
        lease_expires_at,
        ultimo_erro_codigo,
        ultimo_erro_mensagem
      FROM public.acervo_jobs
      WHERE status = 'em_execucao'
      FOR UPDATE
    ),
    registro_auditoria_jobs AS (
      INSERT INTO public.auditoria_saneamento_restore (
        restauracao_id,
        tabela,
        registro_id,
        estado_anterior,
        estado_novo,
        motivo
      )
      SELECT
        '${RESTORE_ID}',
        'acervo_jobs',
        j.id,
        jsonb_build_object(
          'status', j.status,
          'locked_by', j.locked_by,
          'locked_at', j.locked_at,
          'lease_expires_at', j.lease_expires_at,
          'ultimo_erro_codigo', j.ultimo_erro_codigo,
          'ultimo_erro_mensagem', j.ultimo_erro_mensagem
        ),
        jsonb_build_object(
          'status', 'aguardando',
          'locked_by', NULL,
          'locked_at', NULL,
          'lease_expires_at', NULL,
          'ultimo_erro_codigo', 'SISTEMA_RESTAURADO',
          'ultimo_erro_mensagem', 'Job reiniciado para a fila devido à recuperação do cluster (Audit: ${RESTORE_ID})'
        ),
        'Rearmamento de job de pipeline em execucao no momento do backup'
      FROM jobs_para_sanear j
      RETURNING registro_id, estado_novo
    )
    UPDATE public.acervo_jobs j
    SET
      status = 'aguardando',
      locked_by = NULL,
      locked_at = NULL,
      lease_expires_at = NULL,
      ultimo_erro_codigo = 'SISTEMA_RESTAURADO',
      ultimo_erro_mensagem = 'Job reiniciado para a fila devido à recuperação do cluster (Audit: ${RESTORE_ID})'
    FROM registro_auditoria_jobs a
    WHERE j.id = a.registro_id;
  END IF;
END \$\$;

COMMIT;
EOSQL

echo "[$(date -u)] SANEAMENTO PÓS-RESTORE CONCLUÍDO E AUDITADO COM SUCESSO."
