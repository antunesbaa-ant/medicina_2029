-- ============================================================================
-- MEDICINA 2029 — TAREFA F1.12
-- ROLLBACK DA PROPOSTA: ÍNDICES DE BUSCA VETORIAL/TEXTUAL E PROVENIÊNCIA
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS medicina.fn_busca_hibrida_acervo(
  text,
  vector,
  uuid,
  integer,
  double precision,
  text,
  uuid
);

ALTER TABLE IF EXISTS public.cards
  DROP CONSTRAINT IF EXISTS cards_gerado_proveniencia_check;

ALTER TABLE IF EXISTS public.questoes
  DROP CONSTRAINT IF EXISTS questoes_gerada_proveniencia_check;

ALTER TABLE IF EXISTS public.materiais
  DROP CONSTRAINT IF EXISTS materiais_gerado_proveniencia_check;

DROP INDEX IF EXISTS public.acervo_chunks_texto_fts_idx;
DROP INDEX IF EXISTS public.acervo_chunks_embedding_hnsw_idx;

COMMIT;
