-- ============================================================================
-- MEDICINA 2029 — TAREFA F1.11
-- PROPOSTA DE FILA DURÁVEL POSTGRESQL E PIPELINE RETOMÁVEL DO ACERVO
-- ============================================================================
-- IMPORTANTE:
-- 1. Esta proposta fica FORA do journal automático do Drizzle e NÃO deve ser
--    aplicada automaticamente em produção sem backup validado e janela aprovada.
-- 2. Substitui o processamento assíncrono efêmero em memória por jobs
--    persistidos na tabela `public.acervo_jobs`, com controle de lease,
--    heartbeat, backoff exponencial, retomada por etapa e erros sanitizados.
-- 3. Adiciona constraints UNIQUE em `acervo_paginas (arquivo_id, numero)` e
--    `acervo_chunks (arquivo_id, ordem)` para garantir idempotência física
--    na retomada de extração, segmentação e classificação.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. PREFLIGHT: diagnóstico sem efeitos colaterais antes de qualquer DDL
DO $$
BEGIN
  IF to_regclass('public.perfis') IS NULL
     OR to_regclass('public.acervo_arquivos') IS NULL
     OR to_regclass('public.acervo_paginas') IS NULL
     OR to_regclass('public.acervo_chunks') IS NULL
     OR to_regclass('public.responsavel_estudante') IS NULL
  THEN
    RAISE EXCEPTION
      'F1.11 abortada: tabelas base do acervo ou expansão F1.03-R ausentes.'
      USING ERRCODE = 'P0001';
  END IF;

  -- 1.1 Verifica duplicidades históricas em acervo_paginas (arquivo_id, numero)
  IF EXISTS (
    SELECT 1
    FROM public.acervo_paginas
    GROUP BY arquivo_id, numero
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'F1.11 abortada: existem páginas duplicadas para o mesmo (arquivo_id, numero) em acervo_paginas.'
      USING ERRCODE = 'P0001';
  END IF;

  -- 1.2 Verifica duplicidades históricas em acervo_chunks (arquivo_id, ordem)
  IF EXISTS (
    SELECT 1
    FROM public.acervo_chunks
    GROUP BY arquivo_id, ordem
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'F1.11 abortada: existem chunks duplicados para o mesmo (arquivo_id, ordem) em acervo_chunks.'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

-- 2. UNICIDADES DE SAÍDA POR ETAPA (GARANTIA DE RETOMADA IDEMPOTENTE)
ALTER TABLE public.acervo_paginas
  DROP CONSTRAINT IF EXISTS acervo_paginas_arquivo_numero_unique;
ALTER TABLE public.acervo_paginas
  ADD CONSTRAINT acervo_paginas_arquivo_numero_unique UNIQUE (arquivo_id, numero);

ALTER TABLE public.acervo_chunks
  DROP CONSTRAINT IF EXISTS acervo_chunks_arquivo_ordem_unique;
ALTER TABLE public.acervo_chunks
  ADD CONSTRAINT acervo_chunks_arquivo_ordem_unique UNIQUE (arquivo_id, ordem);

-- 3. TABELA DE FILA DURÁVEL DE INGESTÃO (`public.acervo_jobs`)
CREATE TABLE IF NOT EXISTS public.acervo_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  arquivo_id uuid NOT NULL REFERENCES public.acervo_arquivos(id) ON DELETE CASCADE,
  enviado_por uuid NOT NULL REFERENCES public.perfis(id) ON DELETE RESTRICT,
  status varchar(30) DEFAULT 'aguardando' NOT NULL,
  etapa_atual varchar(30) DEFAULT 'extracao' NOT NULL,
  tentativas integer DEFAULT 0 NOT NULL,
  max_tentativas integer DEFAULT 3 NOT NULL,
  proxima_execucao_em timestamp DEFAULT now() NOT NULL,
  locked_by varchar(128),
  locked_at timestamp,
  heartbeat_at timestamp,
  lease_expires_at timestamp,
  ultimo_erro_codigo varchar(80),
  ultimo_erro_mensagem text,
  iniciado_em timestamp,
  concluido_em timestamp,
  criado_em timestamp DEFAULT now() NOT NULL,
  atualizado_em timestamp DEFAULT now() NOT NULL,
  CONSTRAINT acervo_jobs_arquivo_id_unique UNIQUE (arquivo_id),
  CONSTRAINT acervo_jobs_status_check
    CHECK (status IN ('aguardando', 'em_execucao', 'concluido', 'falhou')),
  CONSTRAINT acervo_jobs_etapa_atual_check
    CHECK (etapa_atual IN ('extracao', 'segmentacao', 'classificacao', 'indexacao', 'concluido')),
  CONSTRAINT acervo_jobs_tentativas_check
    CHECK (tentativas >= 0 AND max_tentativas BETWEEN 1 AND 10 AND tentativas <= max_tentativas + 1),
  CONSTRAINT acervo_jobs_lease_consistency_check
    CHECK (
      status <> 'em_execucao'
      OR (
        locked_by IS NOT NULL
        AND locked_at IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at >= locked_at
      )
    ),
  CONSTRAINT acervo_jobs_concluido_consistency_check
    CHECK (
      status <> 'concluido'
      OR (
        etapa_atual = 'concluido'
        AND concluido_em IS NOT NULL
        AND locked_by IS NULL
        AND lease_expires_at IS NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS acervo_jobs_claimable_idx
  ON public.acervo_jobs (proxima_execucao_em, criado_em)
  WHERE status IN ('aguardando', 'em_execucao');

CREATE INDEX IF NOT EXISTS acervo_jobs_enviado_por_idx
  ON public.acervo_jobs (enviado_por, criado_em DESC);

-- 4. BACKFILL DETERMINÍSTICO DE ARQUIVOS EXISTENTES EM `acervo_arquivos`
INSERT INTO public.acervo_jobs (
  arquivo_id,
  enviado_por,
  status,
  etapa_atual,
  tentativas,
  max_tentativas,
  proxima_execucao_em,
  ultimo_erro_codigo,
  ultimo_erro_mensagem,
  iniciado_em,
  concluido_em,
  criado_em,
  atualizado_em
)
SELECT
  a.id AS arquivo_id,
  a.enviado_por,
  CASE
    WHEN a.status_processamento = 'concluido' THEN 'concluido'
    WHEN a.status_processamento = 'falhou' THEN 'falhou'
    ELSE 'aguardando'
  END AS status,
  CASE
    WHEN a.status_processamento = 'concluido' THEN 'concluido'
    WHEN a.status_processamento = 'indexando' THEN 'indexacao'
    WHEN a.status_processamento = 'classificando' THEN 'classificacao'
    WHEN a.status_processamento = 'segmentando' THEN 'segmentacao'
    ELSE 'extracao'
  END AS etapa_atual,
  CASE
    WHEN a.status_processamento IN ('concluido', 'falhou') THEN 1
    ELSE 0
  END AS tentativas,
  3 AS max_tentativas,
  now() AS proxima_execucao_em,
  CASE
    WHEN a.status_processamento = 'falhou' THEN 'LEGACY_PIPELINE_FAILED'
    ELSE NULL
  END AS ultimo_erro_codigo,
  a.erro_processamento AS ultimo_erro_mensagem,
  a.enviado_em AS iniciado_em,
  CASE
    WHEN a.status_processamento = 'concluido' THEN a.enviado_em
    ELSE NULL
  END AS concluido_em,
  a.enviado_em AS criado_em,
  now() AS atualizado_em
FROM public.acervo_arquivos a
ON CONFLICT (arquivo_id) DO NOTHING;

-- 5. PRIVILÉGIOS E RLS COMPATÍVEIS (QUANDO OS PAPÉIS DA F1.04 ESTIVEREM PRESENTES)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.acervo_jobs TO medicina_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_anon') THEN
    REVOKE ALL ON public.acervo_jobs FROM medicina_anon;
  END IF;

  -- Se o RLS já estiver habilitado em public.acervo_arquivos (F1.04 aplicada),
  -- habilita RLS fail-closed equivalente em public.acervo_jobs.
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'acervo_arquivos'
      AND c.relrowsecurity = true
  ) THEN
    ALTER TABLE public.acervo_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.acervo_jobs FORCE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS acervo_jobs_responsavel_all ON public.acervo_jobs;
    CREATE POLICY acervo_jobs_responsavel_all
      ON public.acervo_jobs
      FOR ALL
      USING (
        medicina.is_responsavel()
        AND enviado_por = medicina.current_perfil_id()
      )
      WITH CHECK (
        medicina.is_responsavel()
        AND enviado_por = medicina.current_perfil_id()
      );
  END IF;
END
$$;

COMMIT;
