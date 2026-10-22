-- ============================================================================
-- MEDICINA 2029 — F1.09
-- PROPOSTA DE VALIDAÇÃO DE DOMÍNIO, UNICIDADES E IDEMPOTÊNCIA PERSISTENTE
-- ============================================================================
-- IMPORTANTE:
-- 1. Esta proposta fica FORA do journal automático do Drizzle e NÃO deve ser
--    aplicada automaticamente em produção.
-- 2. Preserva integralmente a compatibilidade da expansão F1.03-R
--    (0003_f1_03_r_expansao.sql) e NÃO antecipa a contração NOT NULL de
--    F1_03_R_CONTRACAO_PROPOSTA.sql.
-- 3. Todas as colunas de chave idempotente adicionadas às tabelas históricas
--    são NULLABLE, preservando registros anteriores sem exigir backfill artificial.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. PREFLIGHT: diagnóstico sem efeitos colaterais antes de qualquer DDL
DO $$
BEGIN
  IF to_regclass('public.responsavel_estudante') IS NULL THEN
    RAISE EXCEPTION
      'F1.09 abortada: a expansão F1.03-R (tabela responsavel_estudante) é pré-requisito.';
  END IF;

  -- 1.1 Verificação de duplicidades históricas para os novos índices/uniques
  IF EXISTS (
    SELECT 1
    FROM sessoes
    WHERE encerrada_em IS NULL
    GROUP BY perfil_id, ciclo_bloco_id, topico_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'F1.09 abortada: existem sessões abertas duplicadas para o mesmo perfil, bloco e tópico.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM erros
    GROUP BY tentativa_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'F1.09 abortada: existem múltiplos registros de erro para a mesma tentativa_id.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM curadoria_fila
    GROUP BY artefato_tipo, artefato_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'F1.09 abortada: existem itens duplicados na fila de curadoria para o mesmo artefato.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM acervo_arquivos
    GROUP BY hash_conteudo
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'F1.09 abortada: existem arquivos duplicados no acervo com o mesmo hash_conteudo.';
  END IF;

  -- 1.2 Verificação de limites de domínio nos dados existentes
  IF EXISTS (
    SELECT 1
    FROM sessoes
    WHERE segundos_efetivos < 0
       OR segundos_efetivos > 86400
       OR segundos_pausa < 0
       OR segundos_pausa > 86400
       OR (encerrada_em IS NOT NULL AND encerrada_em < iniciada_em)
  ) THEN
    RAISE EXCEPTION
      'F1.09 abortada: sessões históricas possuem tempos fora dos limites ou ordem temporal inválida.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM card_revisoes
    WHERE duracao_ms < 0
       OR duracao_ms > 3600000
       OR rating NOT IN ('again', 'hard', 'good', 'easy')
  ) THEN
    RAISE EXCEPTION
      'F1.09 abortada: revisões FSRS históricas possuem duração ou rating inválidos.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM simulados
    WHERE duracao_min <= 0 OR duracao_min > 720
  ) OR EXISTS (
    SELECT 1
    FROM simulado_areas
    WHERE total <= 0 OR total > 200 OR acertos < 0 OR acertos > total
  ) THEN
    RAISE EXCEPTION
      'F1.09 abortada: simulados ou áreas históricas possuem durações, totais ou acertos inválidos.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM redacoes
    WHERE minutos_gastos <= 0
       OR minutos_gastos > 600
       OR (nota_total IS NOT NULL AND (nota_total < 0 OR nota_total > 1000))
       OR (formato = 'genero_uece' AND genero_id IS NULL)
  ) THEN
    RAISE EXCEPTION
      'F1.09 abortada: redações históricas violam limites de tempo, nota ou obrigatoriedade de gênero UECE.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM checkins
    WHERE horas_sono < 0
       OR horas_sono > 24
       OR exercicio_min < 0
       OR exercicio_min > 1440
       OR humor NOT BETWEEN 1 AND 5
       OR energia NOT BETWEEN 1 AND 5
  ) THEN
    RAISE EXCEPTION
      'F1.09 abortada: check-ins históricos possuem valores fora das faixas válidas.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM acervo_arquivos
    WHERE tamanho_bytes <= 0
       OR tamanho_bytes > 20971520
       OR serie_alvo NOT BETWEEN 0 AND 3
  ) THEN
    RAISE EXCEPTION
      'F1.09 abortada: arquivos históricos possuem tamanho_bytes ou serie_alvo inválidos.';
  END IF;
END
$$;

-- 2. LEDGER E CHAVES PERSISTIDAS DE IDEMPOTÊNCIA (ADITIVO E COMPATÍVEL)
CREATE TABLE IF NOT EXISTS "operacoes_idempotentes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "perfil_id" uuid NOT NULL,
  "escopo" varchar(100) NOT NULL,
  "chave_idempotencia" varchar(128) NOT NULL,
  "payload_hash" varchar(64) NOT NULL,
  "recurso_id" uuid,
  "resposta_resumo" jsonb NOT NULL,
  "criado_em" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "operacoes_idempotentes_perfil_id_perfis_id_fk"
    FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "operacoes_idempotentes_perfil_escopo_chave_unique"
    UNIQUE ("perfil_id", "escopo", "chave_idempotencia"),
  CONSTRAINT "operacoes_idempotentes_payload_hash_check"
    CHECK (char_length("payload_hash") = 64),
  CONSTRAINT "operacoes_idempotentes_escopo_check"
    CHECK ("escopo" IN (
      'sessao.iniciar',
      'sessao.concluir',
      'fsrs.revisar',
      'simulado.registrar',
      'curadoria.gerar',
      'curadoria.decidir',
      'redacao.registrar',
      'repertorio.registrar',
      'acervo.upload'
    ))
);

ALTER TABLE "card_revisoes" ADD COLUMN IF NOT EXISTS "chave_idempotencia" varchar(128);
CREATE UNIQUE INDEX IF NOT EXISTS "card_revisoes_card_chave_idempotencia_uidx"
  ON "card_revisoes" ("card_id", "chave_idempotencia")
  WHERE "chave_idempotencia" IS NOT NULL;

ALTER TABLE "geracoes" ADD COLUMN IF NOT EXISTS "chave_idempotencia" varchar(128);
CREATE UNIQUE INDEX IF NOT EXISTS "geracoes_chave_idempotencia_uidx"
  ON "geracoes" ("chave_idempotencia")
  WHERE "chave_idempotencia" IS NOT NULL;

-- 3. UNICIDADES NECESSÁRIAS (COMPATÍVEIS COM A EXPANSÃO F1.03-R)
CREATE UNIQUE INDEX IF NOT EXISTS "sessoes_uma_aberta_por_bloco_topico_uidx"
  ON "sessoes" ("perfil_id", "ciclo_bloco_id", "topico_id")
  WHERE "encerrada_em" IS NULL;

ALTER TABLE "erros" DROP CONSTRAINT IF EXISTS "erros_tentativa_id_unique";
ALTER TABLE "erros"
  ADD CONSTRAINT "erros_tentativa_id_unique" UNIQUE ("tentativa_id");

ALTER TABLE "curadoria_fila" DROP CONSTRAINT IF EXISTS "curadoria_fila_artefato_unique";
ALTER TABLE "curadoria_fila"
  ADD CONSTRAINT "curadoria_fila_artefato_unique" UNIQUE ("artefato_tipo", "artefato_id");

ALTER TABLE "acervo_arquivos" DROP CONSTRAINT IF EXISTS "acervo_arquivos_hash_conteudo_unique";
ALTER TABLE "acervo_arquivos"
  ADD CONSTRAINT "acervo_arquivos_hash_conteudo_unique" UNIQUE ("hash_conteudo");

-- 4. CONSTRAINTS DE INTEGRIDADE DE DOMÍNIO (NOT VALID + VALIDATE CONSTRAINT)
ALTER TABLE "sessoes" DROP CONSTRAINT IF EXISTS "sessoes_tempos_limites_check";
ALTER TABLE "sessoes"
  ADD CONSTRAINT "sessoes_tempos_limites_check"
  CHECK (
    "segundos_efetivos" >= 0 AND "segundos_efetivos" <= 86400
    AND "segundos_pausa" >= 0 AND "segundos_pausa" <= 86400
  ) NOT VALID;

ALTER TABLE "sessoes" DROP CONSTRAINT IF EXISTS "sessoes_ordem_temporal_check";
ALTER TABLE "sessoes"
  ADD CONSTRAINT "sessoes_ordem_temporal_check"
  CHECK ("encerrada_em" IS NULL OR "encerrada_em" >= "iniciada_em") NOT VALID;

ALTER TABLE "card_revisoes" DROP CONSTRAINT IF EXISTS "card_revisoes_duracao_rating_check";
ALTER TABLE "card_revisoes"
  ADD CONSTRAINT "card_revisoes_duracao_rating_check"
  CHECK (
    "duracao_ms" >= 0 AND "duracao_ms" <= 3600000
    AND "rating" IN ('again', 'hard', 'good', 'easy')
  ) NOT VALID;

ALTER TABLE "simulados" DROP CONSTRAINT IF EXISTS "simulados_duracao_limites_check";
ALTER TABLE "simulados"
  ADD CONSTRAINT "simulados_duracao_limites_check"
  CHECK ("duracao_min" > 0 AND "duracao_min" <= 720) NOT VALID;

ALTER TABLE "simulado_areas" DROP CONSTRAINT IF EXISTS "simulado_areas_acertos_total_check";
ALTER TABLE "simulado_areas"
  ADD CONSTRAINT "simulado_areas_acertos_total_check"
  CHECK ("total" > 0 AND "total" <= 200 AND "acertos" >= 0 AND "acertos" <= "total") NOT VALID;

ALTER TABLE "redacoes" DROP CONSTRAINT IF EXISTS "redacoes_limites_e_genero_check";
ALTER TABLE "redacoes"
  ADD CONSTRAINT "redacoes_limites_e_genero_check"
  CHECK (
    "minutos_gastos" > 0 AND "minutos_gastos" <= 600
    AND ("nota_total" IS NULL OR ("nota_total" >= 0 AND "nota_total" <= 1000))
    AND ("formato" <> 'genero_uece' OR "genero_id" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "checkins" DROP CONSTRAINT IF EXISTS "checkins_limites_dominio_check";
ALTER TABLE "checkins"
  ADD CONSTRAINT "checkins_limites_dominio_check"
  CHECK (
    "horas_sono" >= 0 AND "horas_sono" <= 24
    AND "exercicio_min" >= 0 AND "exercicio_min" <= 1440
    AND "humor" BETWEEN 1 AND 5
    AND "energia" BETWEEN 1 AND 5
  ) NOT VALID;

ALTER TABLE "acervo_arquivos" DROP CONSTRAINT IF EXISTS "acervo_arquivos_tamanho_serie_check";
ALTER TABLE "acervo_arquivos"
  ADD CONSTRAINT "acervo_arquivos_tamanho_serie_check"
  CHECK (
    "tamanho_bytes" > 0 AND "tamanho_bytes" <= 20971520
    AND "serie_alvo" BETWEEN 0 AND 3
  ) NOT VALID;

ALTER TABLE "sessoes" VALIDATE CONSTRAINT "sessoes_tempos_limites_check";
ALTER TABLE "sessoes" VALIDATE CONSTRAINT "sessoes_ordem_temporal_check";
ALTER TABLE "card_revisoes" VALIDATE CONSTRAINT "card_revisoes_duracao_rating_check";
ALTER TABLE "simulados" VALIDATE CONSTRAINT "simulados_duracao_limites_check";
ALTER TABLE "simulado_areas" VALIDATE CONSTRAINT "simulado_areas_acertos_total_check";
ALTER TABLE "redacoes" VALIDATE CONSTRAINT "redacoes_limites_e_genero_check";
ALTER TABLE "checkins" VALIDATE CONSTRAINT "checkins_limites_dominio_check";
ALTER TABLE "acervo_arquivos" VALIDATE CONSTRAINT "acervo_arquivos_tamanho_serie_check";

-- 5. PRIVILÉGIOS E RLS COMPATÍVEIS (QUANDO OS PAPÉIS DA F1.04 ESTIVEREM PRESENTES)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.operacoes_idempotentes TO medicina_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_anon') THEN
    REVOKE ALL ON public.operacoes_idempotentes FROM medicina_anon;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'perfis'
      AND c.relrowsecurity = true
  ) AND to_regprocedure('medicina.current_perfil_id()') IS NOT NULL THEN
    ALTER TABLE public.operacoes_idempotentes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.operacoes_idempotentes FORCE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS operacoes_idempotentes_own_policy ON public.operacoes_idempotentes;
    CREATE POLICY operacoes_idempotentes_own_policy
      ON public.operacoes_idempotentes
      FOR ALL
      USING (
        medicina.current_perfil_id() IS NOT NULL
        AND perfil_id = medicina.current_perfil_id()
      )
      WITH CHECK (
        medicina.current_perfil_id() IS NOT NULL
        AND perfil_id = medicina.current_perfil_id()
      );
  END IF;
END
$$;

COMMIT;
