-- ==============================================================================
-- MEDICINA 2029 — H2.05: CORREÇÃO DA FUNÇÃO EVOLUTIVA DE SIMULADOS (PROPOSTA)
-- ==============================================================================
-- Diagnóstico do Erro 42804:
-- A função medicina.fn_simulados_evolucao() declara na cláusula RETURNS TABLE a
-- coluna `data date`, porém a instrução SELECT interna projeta `s.data`, que na
-- tabela public.simulados é do tipo `timestamp without time zone`.
-- No PostgreSQL 17, a divergência de tipos entre a tupla de retorno e o tipo
-- declarado da coluna resulta em erro 42804 ao invocar a view public.vw_simulados_evolucao.
--
-- Correção Mínima:
-- 1. Aplicar cast explícito `s.data::date AS data` na projeção da consulta;
-- 2. Manter estritamente a assinatura, contratos de segurança (SECURITY DEFINER)
--    e search_path defensivo;
-- 3. Revogar privilégios do pseudo-papel PUBLIC e conceder EXECUTE exclusivamente
--    para a role autenticada medicina_app.
--
-- ATENÇÃO: ARQUIVO PREPARATÓRIO LOCAL. NÃO EXECUTAR NO SUPABASE STAGING SEM AUTORIZAÇÃO.
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
    s.data::date AS data,
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

-- Permissões mínimas estritas
REVOKE ALL ON FUNCTION medicina.fn_simulados_evolucao() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medicina.fn_simulados_evolucao() TO medicina_app;

-- Revalidação da view pública dependente
CREATE OR REPLACE VIEW public.vw_simulados_evolucao AS
SELECT * FROM medicina.fn_simulados_evolucao();

REVOKE ALL ON TABLE public.vw_simulados_evolucao FROM PUBLIC;
GRANT SELECT ON TABLE public.vw_simulados_evolucao TO medicina_app;

COMMIT;
