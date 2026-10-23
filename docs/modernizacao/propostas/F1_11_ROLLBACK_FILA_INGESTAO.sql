-- ============================================================================
-- MEDICINA 2029 — TAREFA F1.11
-- ROLLBACK ATÔMICO DA PROPOSTA DE FILA DURÁVEL DE INGESTÃO DO ACERVO
-- ============================================================================
-- Reverte integralmente a tabela `public.acervo_jobs`, seus índices, policies
-- e as constraints adicionadas por F1_11_FILA_INGESTAO_PROPOSTA.sql.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS disciplinas_worker_select_policy ON public.disciplinas;
DROP POLICY IF EXISTS topicos_worker_select_policy ON public.topicos;
DROP POLICY IF EXISTS acervo_chunks_worker_all_policy ON public.acervo_chunks;
DROP POLICY IF EXISTS acervo_paginas_worker_all_policy ON public.acervo_paginas;
DROP POLICY IF EXISTS acervo_arquivos_worker_update_policy ON public.acervo_arquivos;
DROP POLICY IF EXISTS acervo_arquivos_worker_select_policy ON public.acervo_arquivos;

DROP TABLE IF EXISTS public.acervo_jobs;

ALTER TABLE public.acervo_chunks
  DROP CONSTRAINT IF EXISTS acervo_chunks_arquivo_ordem_unique;

ALTER TABLE public.acervo_paginas
  DROP CONSTRAINT IF EXISTS acervo_paginas_arquivo_numero_unique;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_worker') THEN
    -- Só remove a role caso o schema medicina (F1.04) não esteja presente;
    -- caso F1.04 ainda esteja ativo, a remoção da role é delegada ao F1_04_ROLLBACK_RLS.sql.
    IF to_regnamespace('medicina') IS NULL THEN
      IF to_regnamespace('storage') IS NOT NULL THEN
        REVOKE ALL ON ALL TABLES IN SCHEMA storage FROM medicina_worker;
        REVOKE ALL ON SCHEMA storage FROM medicina_worker;
      END IF;
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM medicina_worker;
      REVOKE ALL ON SCHEMA public FROM medicina_worker;
      DROP ROLE medicina_worker;
    END IF;
  END IF;
END
$$;

COMMIT;
