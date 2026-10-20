-- ============================================================================
-- MEDICINA 2029 — TAREFA F1.04-R: SCRIPT DE ROLLBACK DE RLS E VIEWS
-- REVERSÃO TOTAL DA PROPOSTA F1_04_RLS_PROPOSTA.sql
-- ============================================================================
-- ATENÇÃO:
-- 1. Este script reverte integralmente todas as alterações introduzidas por
--    F1_04_RLS_PROPOSTA.sql (F1.04 e F1.04-R).
-- 2. Deve ser executado em transação única e apenas sob procedimento autorizado.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ----------------------------------------------------------------------------
-- 1. REMOÇÃO DAS VIEWS E FUNÇÕES
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.vw_revisoes_trimestrais CASCADE;
DROP VIEW IF EXISTS public.vw_simulados_evolucao CASCADE;
DROP VIEW IF EXISTS public.vw_acompanhamento_quinzenal CASCADE;
DROP VIEW IF EXISTS public.vw_perfis CASCADE;

-- ----------------------------------------------------------------------------
-- 2. REMOÇÃO DAS POLÍTICAS RLS EM TODAS AS TABELAS
-- ----------------------------------------------------------------------------

-- Categoria F: Autenticação
DROP POLICY IF EXISTS perfis_select_policy ON public.perfis;
DROP POLICY IF EXISTS perfis_update_policy ON public.perfis;
DROP POLICY IF EXISTS allowlist_select_policy ON public.allowlist;

-- Categoria B: Vínculo e Administrativo
DROP POLICY IF EXISTS responsavel_estudante_select_policy ON public.responsavel_estudante;
DROP POLICY IF EXISTS revisoes_trimestrais_select_policy ON public.revisoes_trimestrais;
DROP POLICY IF EXISTS revisoes_trimestrais_insert_policy ON public.revisoes_trimestrais;
DROP POLICY IF EXISTS revisoes_trimestrais_update_policy ON public.revisoes_trimestrais;
DROP POLICY IF EXISTS revisoes_trimestrais_delete_policy ON public.revisoes_trimestrais;

-- Categoria C: Taxonomia e Catálogos Globais
DROP POLICY IF EXISTS disciplinas_select_policy ON public.disciplinas;
DROP POLICY IF EXISTS disciplinas_admin_policy ON public.disciplinas;
DROP POLICY IF EXISTS topicos_select_policy ON public.topicos;
DROP POLICY IF EXISTS topicos_admin_policy ON public.topicos;
DROP POLICY IF EXISTS generos_select_policy ON public.generos;
DROP POLICY IF EXISTS generos_admin_policy ON public.generos;

-- Categoria A: Dados Pessoais da Estudante
DROP POLICY IF EXISTS ciclos_estudante_policy ON public.ciclos;
DROP POLICY IF EXISTS ciclo_blocos_estudante_policy ON public.ciclo_blocos;
DROP POLICY IF EXISTS ciclo_estado_estudante_policy ON public.ciclo_estado;
DROP POLICY IF EXISTS sessoes_estudante_policy ON public.sessoes;
DROP POLICY IF EXISTS tentativas_estudante_policy ON public.tentativas;
DROP POLICY IF EXISTS erros_estudante_policy ON public.erros;
DROP POLICY IF EXISTS redacoes_estudante_policy ON public.redacoes;
DROP POLICY IF EXISTS repertorios_estudante_policy ON public.repertorios;
DROP POLICY IF EXISTS simulados_estudante_policy ON public.simulados;
DROP POLICY IF EXISTS simulados_responsavel_select_policy ON public.simulados;
DROP POLICY IF EXISTS simulado_questoes_estudante_policy ON public.simulado_questoes;
DROP POLICY IF EXISTS simulado_questoes_responsavel_select_policy ON public.simulado_questoes;
DROP POLICY IF EXISTS simulado_areas_estudante_policy ON public.simulado_areas;
DROP POLICY IF EXISTS simulado_areas_responsavel_select_policy ON public.simulado_areas;
DROP POLICY IF EXISTS simulado_analise_estudante_policy ON public.simulado_analise;
DROP POLICY IF EXISTS simulado_analise_responsavel_select_policy ON public.simulado_analise;
DROP POLICY IF EXISTS checkins_estudante_policy ON public.checkins;
DROP POLICY IF EXISTS livros_estudante_policy ON public.livros;
DROP POLICY IF EXISTS livros_responsavel_select_policy ON public.livros;
DROP POLICY IF EXISTS card_revisoes_estudante_select_policy ON public.card_revisoes;
DROP POLICY IF EXISTS card_revisoes_estudante_insert_policy ON public.card_revisoes;

-- Categoria D: Conteúdos Sujeitos à Curadoria
DROP POLICY IF EXISTS materiais_estudante_select_policy ON public.materiais;
DROP POLICY IF EXISTS materiais_responsavel_admin_policy ON public.materiais;
DROP POLICY IF EXISTS perguntas_ativas_estudante_select_policy ON public.perguntas_ativas;
DROP POLICY IF EXISTS perguntas_ativas_responsavel_admin_policy ON public.perguntas_ativas;
DROP POLICY IF EXISTS cards_estudante_select_policy ON public.cards;
DROP POLICY IF EXISTS cards_estudante_insert_policy ON public.cards;
DROP POLICY IF EXISTS cards_estudante_update_policy ON public.cards;
DROP POLICY IF EXISTS cards_estudante_delete_policy ON public.cards;
DROP POLICY IF EXISTS cards_responsavel_admin_policy ON public.cards;
DROP POLICY IF EXISTS questoes_estudante_select_policy ON public.questoes;
DROP POLICY IF EXISTS questoes_responsavel_admin_policy ON public.questoes;
DROP POLICY IF EXISTS questao_topicos_estudante_select_policy ON public.questao_topicos;
DROP POLICY IF EXISTS questao_topicos_responsavel_admin_policy ON public.questao_topicos;
DROP POLICY IF EXISTS curadoria_fila_responsavel_admin_policy ON public.curadoria_fila;

-- Categoria E: Dados Técnicos e Acervo
DROP POLICY IF EXISTS acervo_arquivos_responsavel_policy ON public.acervo_arquivos;
DROP POLICY IF EXISTS acervo_paginas_responsavel_policy ON public.acervo_paginas;
DROP POLICY IF EXISTS acervo_chunks_responsavel_policy ON public.acervo_chunks;
DROP POLICY IF EXISTS acervo_figuras_responsavel_policy ON public.acervo_figuras;
DROP POLICY IF EXISTS geracoes_responsavel_admin_policy ON public.geracoes;

-- ----------------------------------------------------------------------------
-- 3. DESABILITAÇÃO DE RLS EM TODAS AS 32 TABELAS + ALLOWLIST
-- ----------------------------------------------------------------------------
ALTER TABLE public.perfis NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.perfis DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.allowlist NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.allowlist DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.responsavel_estudante NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.responsavel_estudante DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.disciplinas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.disciplinas DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.topicos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.topicos DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.generos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.generos DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.ciclos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ciclos DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.ciclo_blocos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ciclo_blocos DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.ciclo_estado NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ciclo_estado DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.sessoes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sessoes DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.tentativas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tentativas DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.erros NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.erros DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.redacoes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.redacoes DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.repertorios NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.repertorios DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.simulados NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.simulados DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.simulado_questoes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.simulado_questoes DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.simulado_areas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.simulado_areas DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.simulado_analise NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.simulado_analise DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.checkins NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.checkins DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.livros NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.livros DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.card_revisoes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.card_revisoes DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.cards NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.cards DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.materiais NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.materiais DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.perguntas_ativas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.perguntas_ativas DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.questoes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.questoes DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.questao_topicos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.questao_topicos DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.curadoria_fila NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.curadoria_fila DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.revisoes_trimestrais NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.revisoes_trimestrais DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.acervo_arquivos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.acervo_arquivos DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.acervo_paginas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.acervo_paginas DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.acervo_chunks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.acervo_chunks DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.acervo_figuras NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.acervo_figuras DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.geracoes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.geracoes DISABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 4. REMOÇÃO DO SCHEMA DEDICADO MEDICINA E FUNÇÕES
-- ----------------------------------------------------------------------------
DROP SCHEMA IF EXISTS medicina CASCADE;

-- ----------------------------------------------------------------------------
-- 5. REVOGAÇÃO DE PERMISSÕES E PAPÉIS
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_app') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM medicina_app;
    REVOKE ALL ON SCHEMA public FROM medicina_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM medicina_anon;
    REVOKE ALL ON SCHEMA public FROM medicina_anon;
  END IF;
END
$$;

COMMIT;
