-- ============================================================================
-- MEDICINA 2029 — TAREFA F1.11
-- ROLLBACK ATÔMICO DA PROPOSTA DE FILA DURÁVEL DE INGESTÃO DO ACERVO
-- ============================================================================
-- Reverte integralmente a tabela `public.acervo_jobs`, seus índices, policies
-- e as constraints adicionadas por F1_11_FILA_INGESTAO_PROPOSTA.sql.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS public.acervo_jobs;

ALTER TABLE public.acervo_chunks
  DROP CONSTRAINT IF EXISTS acervo_chunks_arquivo_ordem_unique;

ALTER TABLE public.acervo_paginas
  DROP CONSTRAINT IF EXISTS acervo_paginas_arquivo_numero_unique;

COMMIT;
