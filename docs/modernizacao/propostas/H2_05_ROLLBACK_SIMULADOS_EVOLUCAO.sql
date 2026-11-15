-- ==============================================================================
-- MEDICINA 2029 — H2.05: ROLLBACK DA CORREÇÃO DE SIMULADOS EVOLUÇÃO
-- ==============================================================================
-- Restaura o estado anterior da função medicina.fn_simulados_evolucao e da view.
-- ==============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION medicina.fn_simulados_evolucao()
RETURNS TABLE (
  simulado_id uuid,
  data date,
  formato text,
  condicoes_reais boolean,
  duracao_min integer,
  total_questoes bigint,
  total_acertos bigint,
  percentual_acerto numeric,
  nota_estimada real,
  analise_concluida boolean,
  tres_assuntos_fracos jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, medicina, public, pg_temp
AS $$
DECLARE
  v_estudante_id uuid;
BEGIN
  IF medicina.is_estudante() THEN
    v_estudante_id := medicina.current_perfil_id();
  ELSIF medicina.is_responsavel() THEN
    v_estudante_id := medicina.current_managed_estudante_id();
  ELSE
    RETURN;
  END IF;

  IF v_estudante_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    s.id AS simulado_id,
    s.data,
    s.formato::text,
    s.condicoes_reais,
    s.duracao_min,
    count(t.id) AS total_questoes,
    count(t.id) FILTER (WHERE t.correta = true) AS total_acertos,
    round(
      (count(t.id) FILTER (WHERE t.correta = true)::numeric / NULLIF(count(t.id), 0)::numeric) * 100.0,
      2
    ) AS percentual_acerto,
    avg(sa.nota_estimated)::real AS nota_estimada,
    COALESCE(san.concluida, false) AS analise_concluida,
    san.tres_assuntos_fracos
  FROM public.simulados s
  LEFT JOIN public.tentativas t ON t.simulado_id = s.id
  LEFT JOIN public.simulado_areas sa ON sa.simulado_id = s.id
  LEFT JOIN public.simulado_analise san ON san.simulado_id = s.id
  WHERE s.perfil_id = v_estudante_id
  GROUP BY s.id, s.data, s.formato, s.condicoes_reais, s.duracao_min, san.concluida, san.tres_assuntos_fracos
  ORDER BY s.data DESC;
END;
$$;

CREATE OR REPLACE VIEW public.vw_simulados_evolucao AS
SELECT * FROM medicina.fn_simulados_evolucao();

COMMIT;
