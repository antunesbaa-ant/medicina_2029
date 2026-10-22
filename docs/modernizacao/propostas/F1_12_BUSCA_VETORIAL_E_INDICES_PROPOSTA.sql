-- ============================================================================
-- MEDICINA 2029 — TAREFA F1.12
-- PROPOSTA DE MIGRAÇÃO: ÍNDICES DE BUSCA VETORIAL/TEXTUAL E PROVENIÊNCIA
-- ============================================================================
-- ATENÇÃO:
-- 1. Proposta versionada FORA do journal automático do Drizzle.
-- 2. Não executar automaticamente em produção sem homologação prévia.
-- 3. Confirma compatibilidade dimensional de `acervo_chunks.embedding` com
--    `vector(1536)` (`gemini-embedding-001` com `outputDimensionality = 1536`).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. PREFLIGHT: VERIFICAÇÃO DE EXTENSÃO PGVECTOR E DIMENSÃO VECTOR(1536)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_formatted_type TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'PREFLIGHT F1.12 FALHOU: extensão pgvector não está instalada.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_formatted_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'acervo_chunks'
     AND a.attname = 'embedding'
     AND NOT a.attisdropped;

  IF v_formatted_type IS DISTINCT FROM 'vector(1536)' THEN
    RAISE EXCEPTION 'PREFLIGHT F1.12 FALHOU: coluna public.acervo_chunks.embedding esperada como vector(1536), encontrada: %',
      COALESCE(v_formatted_type, 'AUSENTE')
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 2. ÍNDICES DE BUSCA HÍBRIDA (HNSW COSSENO + GIN TSVECTOR PORTUGUÊS)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS acervo_chunks_embedding_hnsw_idx
  ON public.acervo_chunks
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS acervo_chunks_texto_fts_idx
  ON public.acervo_chunks
  USING gin (to_tsvector('portuguese', texto));

-- ----------------------------------------------------------------------------
-- 3. CONSTRAINTS DE PROVENIÊNCIA PARA NOVOS ARTEFATOS GERADOS POR IA
-- (NOT VALID preserva compatibilidade com dados históricos legados)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'materiais_gerado_proveniencia_check'
  ) THEN
    ALTER TABLE public.materiais
      ADD CONSTRAINT materiais_gerado_proveniencia_check
      CHECK (
        origem <> 'gerado'
        OR (
          fonte_chunk_ids IS NOT NULL
          AND jsonb_typeof(fonte_chunk_ids) = 'array'
          AND jsonb_array_length(fonte_chunk_ids) > 0
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'questoes_gerada_proveniencia_check'
  ) THEN
    ALTER TABLE public.questoes
      ADD CONSTRAINT questoes_gerada_proveniencia_check
      CHECK (
        procedencia <> 'gerada'
        OR (
          arquivo_origem_id IS NOT NULL
          AND fonte_chunk_ids IS NOT NULL
          AND jsonb_typeof(fonte_chunk_ids) = 'array'
          AND jsonb_array_length(fonte_chunk_ids) > 0
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cards_gerado_proveniencia_check'
  ) THEN
    ALTER TABLE public.cards
      ADD CONSTRAINT cards_gerado_proveniencia_check
      CHECK (
        origem <> 'gerado'
        OR (
          fonte_chunk_ids IS NOT NULL
          AND jsonb_typeof(fonte_chunk_ids) = 'array'
          AND jsonb_array_length(fonte_chunk_ids) > 0
        )
      ) NOT VALID;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 4. FUNÇÃO DE BUSCA HÍBRIDA COMPATÍVEL COM RLS (SECURITY DEFINER ESCOPADO)
-- Permite que a estudante vinculada e o responsável pesquisem os trechos
-- indexados de arquivos concluídos sem abrir SELECT direto em acervo_arquivos.
-- ----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS medicina;

CREATE OR REPLACE FUNCTION medicina.fn_busca_hibrida_acervo(
  p_query text,
  p_query_vector vector(1536),
  p_disciplina_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 5,
  p_min_similaridade double precision DEFAULT 0.2,
  p_papel text DEFAULT NULL,
  p_perfil_id uuid DEFAULT NULL
)
RETURNS TABLE (
  chunk_id uuid,
  arquivo_id uuid,
  arquivo_titulo varchar(500),
  autor_fonte varchar(255),
  tipo_material text,
  disciplina_id uuid,
  topico_id uuid,
  pagina_inicial integer,
  pagina_final integer,
  ordem integer,
  texto text,
  score_vetorial double precision,
  score_textual double precision,
  similaridade double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, medicina, pg_temp
AS $$
DECLARE
  v_ctx_perfil_id uuid := NULL;
  v_ctx_papel text := NULL;
  v_effective_perfil_id uuid;
  v_effective_papel text;
  v_limit integer := GREATEST(1, LEAST(20, COALESCE(p_limit, 5)));
  v_min_sim double precision := COALESCE(p_min_similaridade, 0.2);
BEGIN
  IF p_query IS NULL OR btrim(p_query) = '' OR p_query_vector IS NULL THEN
    RETURN;
  END IF;

  IF to_regprocedure('medicina.current_perfil_id()') IS NOT NULL THEN
    v_ctx_perfil_id := medicina.current_perfil_id();
    v_ctx_papel := medicina.current_papel();
  END IF;

  IF current_user = 'medicina_app' OR v_ctx_perfil_id IS NOT NULL OR v_ctx_papel IS NOT NULL THEN
    IF v_ctx_perfil_id IS NULL OR v_ctx_papel IS NULL THEN
      RETURN;
    END IF;
    IF p_perfil_id IS NOT NULL AND p_perfil_id <> v_ctx_perfil_id THEN
      RAISE EXCEPTION 'Conflito de identidade RLS na busca do acervo.' USING ERRCODE = '42501';
    END IF;
    IF p_papel IS NOT NULL AND p_papel <> v_ctx_papel THEN
      RAISE EXCEPTION 'Conflito de papel RLS na busca do acervo.' USING ERRCODE = '42501';
    END IF;
    v_effective_perfil_id := v_ctx_perfil_id;
    v_effective_papel := v_ctx_papel;
  ELSE
    v_effective_perfil_id := p_perfil_id;
    v_effective_papel := p_papel;
  END IF;

  IF v_effective_perfil_id IS NULL OR v_effective_papel NOT IN ('responsavel', 'estudante') THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    c.id AS chunk_id,
    a.id AS arquivo_id,
    a.titulo AS arquivo_titulo,
    a.autor_fonte,
    a.tipo_material::text AS tipo_material,
    a.disciplina_id,
    c.topico_id,
    c.pagina_inicial,
    c.pagina_final,
    c.ordem,
    c.texto,
    GREATEST(0.0, LEAST(1.0, 1.0 - (c.embedding <=> p_query_vector)))::double precision AS score_vetorial,
    LEAST(1.0, ts_rank_cd(to_tsvector('portuguese', c.texto), plainto_tsquery('portuguese', btrim(p_query))))::double precision AS score_textual,
    LEAST(
      1.0,
      GREATEST(0.0, LEAST(1.0, 1.0 - (c.embedding <=> p_query_vector))) * 0.85
      + LEAST(1.0, ts_rank_cd(to_tsvector('portuguese', c.texto), plainto_tsquery('portuguese', btrim(p_query)))) * 0.15
    )::double precision AS similaridade
  FROM public.acervo_chunks c
  INNER JOIN public.acervo_arquivos a ON a.id = c.arquivo_id
  WHERE c.embedding IS NOT NULL
    AND a.status_processamento = 'concluido'
    AND (p_disciplina_id IS NULL OR a.disciplina_id = p_disciplina_id)
    AND (
      (v_effective_papel = 'responsavel' AND a.enviado_por = v_effective_perfil_id)
      OR (
        v_effective_papel = 'estudante'
        AND EXISTS (
          SELECT 1
          FROM public.responsavel_estudante re
          WHERE re.estudante_perfil_id = v_effective_perfil_id
            AND re.responsavel_perfil_id = a.enviado_por
        )
      )
    )
    AND (
      LEAST(
        1.0,
        GREATEST(0.0, LEAST(1.0, 1.0 - (c.embedding <=> p_query_vector))) * 0.85
        + LEAST(1.0, ts_rank_cd(to_tsvector('portuguese', c.texto), plainto_tsquery('portuguese', btrim(p_query)))) * 0.15
      ) >= v_min_sim
    )
  ORDER BY
    similaridade DESC,
    score_vetorial DESC,
    c.ordem ASC
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA medicina FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_app') THEN
    GRANT USAGE ON SCHEMA medicina TO medicina_app;
    IF to_regprocedure('medicina.current_perfil_id()') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.current_perfil_id() TO medicina_app;
    END IF;
    IF to_regprocedure('medicina.current_papel()') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.current_papel() TO medicina_app;
    END IF;
    IF to_regprocedure('medicina.is_estudante()') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.is_estudante() TO medicina_app;
    END IF;
    IF to_regprocedure('medicina.is_responsavel()') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.is_responsavel() TO medicina_app;
    END IF;
    IF to_regprocedure('medicina.current_managed_estudante_id()') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.current_managed_estudante_id() TO medicina_app;
    END IF;
    IF to_regprocedure('medicina.set_context(uuid, text)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.set_context(uuid, text) TO medicina_app;
    END IF;
    IF to_regprocedure('medicina.clear_context()') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.clear_context() TO medicina_app;
    END IF;
    IF to_regprocedure('medicina.is_valid_acervo_storage_path(text)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.is_valid_acervo_storage_path(text) TO medicina_app;
    END IF;
    GRANT EXECUTE ON FUNCTION medicina.fn_busca_hibrida_acervo(
      text,
      vector,
      uuid,
      integer,
      double precision,
      text,
      uuid
    ) TO medicina_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_auth') THEN
    GRANT USAGE ON SCHEMA medicina TO medicina_auth;
    IF to_regprocedure('medicina.autenticar_por_email(text)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.autenticar_por_email(text) TO medicina_auth;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_worker') THEN
    GRANT USAGE ON SCHEMA medicina TO medicina_worker;
    IF to_regprocedure('medicina.current_perfil_id()') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.current_perfil_id() TO medicina_worker;
    END IF;
    IF to_regprocedure('medicina.current_papel()') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.current_papel() TO medicina_worker;
    END IF;
    IF to_regprocedure('medicina.is_estudante()') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.is_estudante() TO medicina_worker;
    END IF;
    IF to_regprocedure('medicina.is_responsavel()') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.is_responsavel() TO medicina_worker;
    END IF;
    IF to_regprocedure('medicina.is_valid_acervo_storage_path(text)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION medicina.is_valid_acervo_storage_path(text) TO medicina_worker;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_anon') THEN
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA medicina FROM medicina_anon;
  END IF;
END
$$;

COMMIT;
