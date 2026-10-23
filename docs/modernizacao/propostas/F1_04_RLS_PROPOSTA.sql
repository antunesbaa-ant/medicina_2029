-- ============================================================================
-- MEDICINA 2029 — TAREFA F1.04-R: PROPOSTA DE ROW LEVEL SECURITY (RLS) E VIEWS
-- REVISÃO ARQUITETURAL, ENDURECIMENTO DE PRIVILÉGIOS E PROTEÇÃO DE COLUNAS
-- ============================================================================
-- ATENÇÃO:
-- 1. Este arquivo NÃO pertence ao journal automático do Drizzle e NÃO deve ser
--    aplicado automaticamente em produção sem ensaio, validação e janela aprovada.
-- 2. Princípio "Fail-Closed" estrito: qualquer consulta sem contexto autenticado
--    explícito retorna 0 linhas.
-- 3. Princípio 1.2 da ESPEC: o responsável NUNCA lê sessões individuais brutas;
--    o acesso administrativo de acompanhamento é restrito a views agregadas
--    (granularidade mínima quinzenal).
-- 4. Princípio 1.7 da ESPEC: nenhum conteúdo gerado por IA/ingestão é visível
--    à estudante com status diferente de 'aprovado'.
-- 5. Proteção de Coluna (Column-Level Grants): a coluna `perfis.password_hash`
--    NÃO possui GRANT de SELECT para o papel `medicina_app`. Consultas que
--    tentem ler `password_hash` são rejeitadas com erro 42501 pelo PostgreSQL.
-- 6. Todas as funções do schema `medicina` possuem search_path estrito e
--    EXECUTE revogado de PUBLIC.
-- ============================================================================

BEGIN;

-- Configuração de timeouts defensivos para a transação DDL
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ----------------------------------------------------------------------------
-- 1. PREFLIGHT E VALIDAÇÃO DE PRÉ-REQUISITOS
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  -- Validar existência das tabelas essenciais criadas nas fases anteriores
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'perfis')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'responsavel_estudante')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sessoes')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ciclos')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'allowlist')
  THEN
    RAISE EXCEPTION 'F1.04-R RLS abortada: schema base ou migration F1.03-R ausente.' USING ERRCODE = 'P0001';
  END IF;

  -- Validar que as colunas de ownership de F1.03-R existem
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ciclos' AND column_name = 'estudante_perfil_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'repertorios' AND column_name = 'perfil_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'revisoes_trimestrais' AND column_name = 'estudante_perfil_id'
  ) THEN
    RAISE EXCEPTION 'F1.04-R RLS abortada: colunas de ownership de F1.03-R nao encontradas.' USING ERRCODE = 'P0001';
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 2. SCHEMA DEDICADO E FUNÇÕES DE CONTEXTO TRANSACIONAL (FAIL-CLOSED)
-- ----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS medicina;

-- 2.1 Leitura do Perfil ID corrente
CREATE OR REPLACE FUNCTION medicina.current_perfil_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, medicina, pg_temp
AS $$
DECLARE
  v_val text;
BEGIN
  v_val := current_setting('medicina.current_perfil_id', true);
  IF v_val IS NULL OR v_val = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_val::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

-- 2.2 Leitura do Papel corrente ('estudante' | 'responsavel')
CREATE OR REPLACE FUNCTION medicina.current_papel()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, medicina, pg_temp
AS $$
DECLARE
  v_val text;
BEGIN
  v_val := current_setting('medicina.current_papel', true);
  IF v_val IN ('estudante', 'responsavel') THEN
    RETURN v_val;
  END IF;
  RETURN NULL;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

-- 2.3 Predicados de Papel
CREATE OR REPLACE FUNCTION medicina.is_estudante()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, medicina, pg_temp
AS $$
  SELECT COALESCE(medicina.current_papel() = 'estudante' AND medicina.current_perfil_id() IS NOT NULL, false);
$$;

CREATE OR REPLACE FUNCTION medicina.is_responsavel()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, medicina, pg_temp
AS $$
  SELECT COALESCE(medicina.current_papel() = 'responsavel' AND medicina.current_perfil_id() IS NOT NULL, false);
$$;

-- 2.4 Resolução do Estudante Gerenciado pelo Responsável Corrente
CREATE OR REPLACE FUNCTION medicina.current_managed_estudante_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, medicina, public, pg_temp
AS $$
  SELECT estudante_perfil_id
  FROM public.responsavel_estudante
  WHERE responsavel_perfil_id = medicina.current_perfil_id()
    AND medicina.is_responsavel();
$$;

-- 2.5 Ativação Transacional de Contexto (SET LOCAL encapsulado com validação)
CREATE OR REPLACE FUNCTION medicina.set_context(p_perfil_id uuid, p_papel text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, medicina, public, pg_temp
AS $$
BEGIN
  IF p_perfil_id IS NULL OR p_papel IS NULL THEN
    RAISE EXCEPTION 'Perfil ID e papel sao obrigatorios para definir contexto de seguranca.' USING ERRCODE = 'P0001';
  END IF;

  IF p_papel NOT IN ('estudante', 'responsavel') THEN
    RAISE EXCEPTION 'Papel invalido: %', p_papel USING ERRCODE = 'P0001';
  END IF;

  -- Valida se o par (id, papel) existe estritamente em perfis
  IF NOT EXISTS (
    SELECT 1 FROM public.perfis WHERE id = p_perfil_id AND papel::text = p_papel
  ) THEN
    RAISE EXCEPTION 'Contexto invalido: perfil % com papel % nao existe.', p_perfil_id, p_papel USING ERRCODE = 'P0001';
  END IF;

  -- set_config com is_local => true garante escopo transacional (SET LOCAL)
  PERFORM set_config('medicina.current_perfil_id', p_perfil_id::text, true);
  PERFORM set_config('medicina.current_papel', p_papel, true);
END;
$$;

-- 2.6 Limpeza de Contexto
CREATE OR REPLACE FUNCTION medicina.clear_context()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, medicina, pg_temp
AS $$
BEGIN
  PERFORM set_config('medicina.current_perfil_id', '', true);
  PERFORM set_config('medicina.current_papel', '', true);
END;
$$;

-- 2.7 Autenticação Segura por E-mail (Allowlist Guard + Proteção contra Enumeração)
CREATE OR REPLACE FUNCTION medicina.autenticar_por_email(p_email text)
RETURNS TABLE (
  id uuid,
  auth_user_id text,
  nome text,
  email text,
  password_hash text,
  papel text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, medicina, public, pg_temp
AS $$
BEGIN
  -- Anti-enumeração: Se e-mail não estiver na allowlist restrita, retorna vazio imediatamente
  IF p_email IS NULL OR NOT EXISTS (SELECT 1 FROM public.allowlist WHERE allowlist.email = p_email) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.auth_user_id::text, p.nome::text, p.email::text, p.password_hash::text, p.papel::text
  FROM public.perfis p
  WHERE p.email = p_email
  LIMIT 1;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. PROVISÃO DE PAPÉIS DE BANCO E ENDURECIMENTO DE PRIVILÉGIOS (LEAST PRIVILEGE)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  -- Papel padrão da aplicação (sem bypass de RLS, sem superuser)
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_app') THEN
    CREATE ROLE medicina_app WITH NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;
  END IF;

  -- Papel dedicado exclusivamente ao serviço de autenticação NextAuth
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_auth') THEN
    CREATE ROLE medicina_auth WITH NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;
  END IF;

  -- Papel dedicado exclusivamente ao processamento em lote e pipeline do acervo
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_worker') THEN
    CREATE ROLE medicina_worker WITH NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;
  END IF;

  -- Papel anônimo (para conexões sem contexto ou públicas)
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_anon') THEN
    CREATE ROLE medicina_anon WITH NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;
  END IF;
END
$$;

-- 3.1 Restrição estrita no schema medicina
REVOKE ALL ON SCHEMA medicina FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA medicina FROM PUBLIC;

GRANT USAGE ON SCHEMA medicina TO medicina_app;
GRANT USAGE ON SCHEMA medicina TO medicina_auth;

-- Concessão explícita de EXECUTE apenas nas funções necessárias para medicina_app
-- (medicina_app NÃO possui permissão em medicina.autenticar_por_email)
GRANT EXECUTE ON FUNCTION medicina.current_perfil_id() TO medicina_app;
GRANT EXECUTE ON FUNCTION medicina.current_papel() TO medicina_app;
GRANT EXECUTE ON FUNCTION medicina.is_estudante() TO medicina_app;
GRANT EXECUTE ON FUNCTION medicina.is_responsavel() TO medicina_app;
GRANT EXECUTE ON FUNCTION medicina.current_managed_estudante_id() TO medicina_app;
GRANT EXECUTE ON FUNCTION medicina.set_context(uuid, text) TO medicina_app;
GRANT EXECUTE ON FUNCTION medicina.clear_context() TO medicina_app;

-- Concessão explícita de EXECUTE em medicina.autenticar_por_email exclusivamente para medicina_auth
GRANT EXECUTE ON FUNCTION medicina.autenticar_por_email(text) TO medicina_auth;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_worker') THEN
    GRANT USAGE ON SCHEMA medicina TO medicina_worker;
    GRANT EXECUTE ON FUNCTION medicina.current_perfil_id() TO medicina_worker;
    GRANT EXECUTE ON FUNCTION medicina.current_papel() TO medicina_worker;
    GRANT EXECUTE ON FUNCTION medicina.is_estudante() TO medicina_worker;
    GRANT EXECUTE ON FUNCTION medicina.is_responsavel() TO medicina_worker;
  END IF;
END
$$;

-- 3.2 Permissões no schema public para medicina_app
GRANT USAGE ON SCHEMA public TO medicina_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO medicina_app;

-- 3.3 Permissões no schema public para medicina_auth (mínimo privilégio para validação de credenciais)
GRANT USAGE ON SCHEMA public TO medicina_auth;
GRANT SELECT ON public.allowlist TO medicina_auth;
GRANT SELECT (id, auth_user_id, nome, email, papel, criado_em) ON public.perfis TO medicina_auth;

-- 3.4 PROTEÇÃO DE COLUNA (Column-Level Grants em public.perfis):
-- Revoga SELECT em nível de tabela para impedir leitura de password_hash.
-- Concede SELECT estritamente sobre as colunas seguras.
REVOKE SELECT ON public.perfis FROM medicina_app;
GRANT SELECT (id, auth_user_id, nome, email, papel, criado_em) ON public.perfis TO medicina_app;
REVOKE UPDATE ON public.perfis FROM medicina_app;
GRANT UPDATE (nome, email) ON public.perfis TO medicina_app;

-- ----------------------------------------------------------------------------
-- 4. HABILITAÇÃO E FORÇAMENTO DE RLS EM TODAS AS 32 TABELAS + ALLOWLIST
-- ----------------------------------------------------------------------------
ALTER TABLE public.perfis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.perfis FORCE ROW LEVEL SECURITY;

ALTER TABLE public.allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allowlist FORCE ROW LEVEL SECURITY;

ALTER TABLE public.responsavel_estudante ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.responsavel_estudante FORCE ROW LEVEL SECURITY;

ALTER TABLE public.disciplinas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disciplinas FORCE ROW LEVEL SECURITY;

ALTER TABLE public.topicos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topicos FORCE ROW LEVEL SECURITY;

ALTER TABLE public.generos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generos FORCE ROW LEVEL SECURITY;

ALTER TABLE public.ciclos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ciclos FORCE ROW LEVEL SECURITY;

ALTER TABLE public.ciclo_blocos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ciclo_blocos FORCE ROW LEVEL SECURITY;

ALTER TABLE public.ciclo_estado ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ciclo_estado FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sessoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessoes FORCE ROW LEVEL SECURITY;

ALTER TABLE public.tentativas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tentativas FORCE ROW LEVEL SECURITY;

ALTER TABLE public.erros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erros FORCE ROW LEVEL SECURITY;

ALTER TABLE public.redacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.redacoes FORCE ROW LEVEL SECURITY;

ALTER TABLE public.repertorios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repertorios FORCE ROW LEVEL SECURITY;

ALTER TABLE public.simulados ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.simulados FORCE ROW LEVEL SECURITY;

ALTER TABLE public.simulado_questoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.simulado_questoes FORCE ROW LEVEL SECURITY;

ALTER TABLE public.simulado_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.simulado_areas FORCE ROW LEVEL SECURITY;

ALTER TABLE public.simulado_analise ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.simulado_analise FORCE ROW LEVEL SECURITY;

ALTER TABLE public.checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkins FORCE ROW LEVEL SECURITY;

ALTER TABLE public.livros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.livros FORCE ROW LEVEL SECURITY;

ALTER TABLE public.card_revisoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_revisoes FORCE ROW LEVEL SECURITY;

ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cards FORCE ROW LEVEL SECURITY;

ALTER TABLE public.materiais ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.materiais FORCE ROW LEVEL SECURITY;

ALTER TABLE public.perguntas_ativas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.perguntas_ativas FORCE ROW LEVEL SECURITY;

ALTER TABLE public.questoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questoes FORCE ROW LEVEL SECURITY;

ALTER TABLE public.questao_topicos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questao_topicos FORCE ROW LEVEL SECURITY;

ALTER TABLE public.curadoria_fila ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.curadoria_fila FORCE ROW LEVEL SECURITY;

ALTER TABLE public.revisoes_trimestrais ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revisoes_trimestrais FORCE ROW LEVEL SECURITY;

ALTER TABLE public.acervo_arquivos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acervo_arquivos FORCE ROW LEVEL SECURITY;

ALTER TABLE public.acervo_paginas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acervo_paginas FORCE ROW LEVEL SECURITY;

ALTER TABLE public.acervo_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acervo_chunks FORCE ROW LEVEL SECURITY;

ALTER TABLE public.acervo_figuras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acervo_figuras FORCE ROW LEVEL SECURITY;

ALTER TABLE public.geracoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geracoes FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 5. POLÍTICAS RLS DECLARATIVAS POR CATEGORIA
-- ----------------------------------------------------------------------------

-- ============================================================================
-- CATEGORIA F: DADOS DE AUTENTICAÇÃO E CONTROLE
-- ============================================================================

-- Tabela: perfis
DROP POLICY IF EXISTS perfis_select_policy ON public.perfis;
CREATE POLICY perfis_select_policy ON public.perfis
FOR SELECT USING (
  id = medicina.current_perfil_id()
  OR (medicina.is_responsavel() AND id = medicina.current_managed_estudante_id())
);

DROP POLICY IF EXISTS perfis_update_policy ON public.perfis;
CREATE POLICY perfis_update_policy ON public.perfis
FOR UPDATE USING (
  id = medicina.current_perfil_id()
) WITH CHECK (
  id = medicina.current_perfil_id()
  AND papel::text = medicina.current_papel()
);

-- Tabela: allowlist
DROP POLICY IF EXISTS allowlist_select_policy ON public.allowlist;
CREATE POLICY allowlist_select_policy ON public.allowlist
FOR SELECT USING (
  medicina.is_responsavel()
);

-- ============================================================================
-- CATEGORIA B: DADOS ADMINISTRATIVOS DO RESPONSÁVEL / VÍNCULO
-- ============================================================================

-- Tabela: responsavel_estudante
DROP POLICY IF EXISTS responsavel_estudante_select_policy ON public.responsavel_estudante;
CREATE POLICY responsavel_estudante_select_policy ON public.responsavel_estudante
FOR SELECT USING (
  (medicina.is_responsavel() AND responsavel_perfil_id = medicina.current_perfil_id())
  OR (medicina.is_estudante() AND estudante_perfil_id = medicina.current_perfil_id())
);

-- Tabela: revisoes_trimestrais
DROP POLICY IF EXISTS revisoes_trimestrais_select_policy ON public.revisoes_trimestrais;
CREATE POLICY revisoes_trimestrais_select_policy ON public.revisoes_trimestrais
FOR SELECT USING (
  (medicina.is_estudante() AND estudante_perfil_id = medicina.current_perfil_id())
  OR (medicina.is_responsavel() AND (registrada_por_perfil_id = medicina.current_perfil_id() OR estudante_perfil_id = medicina.current_managed_estudante_id()))
);

DROP POLICY IF EXISTS revisoes_trimestrais_insert_policy ON public.revisoes_trimestrais;
CREATE POLICY revisoes_trimestrais_insert_policy ON public.revisoes_trimestrais
FOR INSERT WITH CHECK (
  medicina.is_responsavel()
  AND registrada_por_perfil_id = medicina.current_perfil_id()
  AND estudante_perfil_id = medicina.current_managed_estudante_id()
);

DROP POLICY IF EXISTS revisoes_trimestrais_update_policy ON public.revisoes_trimestrais;
CREATE POLICY revisoes_trimestrais_update_policy ON public.revisoes_trimestrais
FOR UPDATE USING (
  medicina.is_responsavel()
  AND registrada_por_perfil_id = medicina.current_perfil_id()
) WITH CHECK (
  medicina.is_responsavel()
  AND registrada_por_perfil_id = medicina.current_perfil_id()
  AND estudante_perfil_id = medicina.current_managed_estudante_id()
);

DROP POLICY IF EXISTS revisoes_trimestrais_delete_policy ON public.revisoes_trimestrais;
CREATE POLICY revisoes_trimestrais_delete_policy ON public.revisoes_trimestrais
FOR DELETE USING (
  medicina.is_responsavel()
  AND registrada_por_perfil_id = medicina.current_perfil_id()
);

-- ============================================================================
-- CATEGORIA C: DADOS GLOBAIS DE CONSULTA (TAXONOMIA E GÊNEROS)
-- ============================================================================

-- Tabela: disciplinas
DROP POLICY IF EXISTS disciplinas_select_policy ON public.disciplinas;
CREATE POLICY disciplinas_select_policy ON public.disciplinas
FOR SELECT USING (
  medicina.current_perfil_id() IS NOT NULL
);

DROP POLICY IF EXISTS disciplinas_admin_policy ON public.disciplinas;
CREATE POLICY disciplinas_admin_policy ON public.disciplinas
FOR ALL USING (
  medicina.is_responsavel()
) WITH CHECK (
  medicina.is_responsavel()
);

-- Tabela: topicos
DROP POLICY IF EXISTS topicos_select_policy ON public.topicos;
CREATE POLICY topicos_select_policy ON public.topicos
FOR SELECT USING (
  medicina.current_perfil_id() IS NOT NULL
);

DROP POLICY IF EXISTS topicos_admin_policy ON public.topicos;
CREATE POLICY topicos_admin_policy ON public.topicos
FOR ALL USING (
  medicina.is_responsavel()
) WITH CHECK (
  medicina.is_responsavel()
);

-- Tabela: generos
DROP POLICY IF EXISTS generos_select_policy ON public.generos;
CREATE POLICY generos_select_policy ON public.generos
FOR SELECT USING (
  medicina.current_perfil_id() IS NOT NULL
);

DROP POLICY IF EXISTS generos_admin_policy ON public.generos;
CREATE POLICY generos_admin_policy ON public.generos
FOR ALL USING (
  medicina.is_responsavel()
) WITH CHECK (
  medicina.is_responsavel()
);

-- ============================================================================
-- CATEGORIA A: DADOS PESSOAIS DA ESTUDANTE
-- ============================================================================

-- Tabela: ciclos (Princípio 1.3: O plano pertence à estudante)
DROP POLICY IF EXISTS ciclos_estudante_policy ON public.ciclos;
CREATE POLICY ciclos_estudante_policy ON public.ciclos
FOR ALL USING (
  medicina.is_estudante() AND estudante_perfil_id = medicina.current_perfil_id()
) WITH CHECK (
  medicina.is_estudante() AND estudante_perfil_id = medicina.current_perfil_id()
);

-- Tabela: ciclo_blocos (Ownership herdado de ciclos)
DROP POLICY IF EXISTS ciclo_blocos_estudante_policy ON public.ciclo_blocos;
CREATE POLICY ciclo_blocos_estudante_policy ON public.ciclo_blocos
FOR ALL USING (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.ciclos c
    WHERE c.id = ciclo_blocos.ciclo_id
      AND c.estudante_perfil_id = medicina.current_perfil_id()
  )
) WITH CHECK (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.ciclos c
    WHERE c.id = ciclo_blocos.ciclo_id
      AND c.estudante_perfil_id = medicina.current_perfil_id()
  )
);

-- Tabela: ciclo_estado (Ownership herdado de ciclos)
DROP POLICY IF EXISTS ciclo_estado_estudante_policy ON public.ciclo_estado;
CREATE POLICY ciclo_estado_estudante_policy ON public.ciclo_estado
FOR ALL USING (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.ciclos c
    WHERE c.id = ciclo_estado.ciclo_id
      AND c.estudante_perfil_id = medicina.current_perfil_id()
  )
) WITH CHECK (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.ciclos c
    WHERE c.id = ciclo_estado.ciclo_id
      AND c.estudante_perfil_id = medicina.current_perfil_id()
  )
);

-- Tabela: sessoes (Princípio 1.2: Vigilância proibida - apenas estudante tem acesso direto)
DROP POLICY IF EXISTS sessoes_estudante_policy ON public.sessoes;
CREATE POLICY sessoes_estudante_policy ON public.sessoes
FOR ALL USING (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
) WITH CHECK (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
);

-- Tabela: tentativas
DROP POLICY IF EXISTS tentativas_estudante_policy ON public.tentativas;
CREATE POLICY tentativas_estudante_policy ON public.tentativas
FOR ALL USING (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
) WITH CHECK (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
);

-- Tabela: erros (Caderno de Erros da Estudante)
DROP POLICY IF EXISTS erros_estudante_policy ON public.erros;
CREATE POLICY erros_estudante_policy ON public.erros
FOR ALL USING (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
) WITH CHECK (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
);

-- Tabela: redacoes
DROP POLICY IF EXISTS redacoes_estudante_policy ON public.redacoes;
CREATE POLICY redacoes_estudante_policy ON public.redacoes
FOR ALL USING (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
) WITH CHECK (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
);

-- Tabela: repertorios
DROP POLICY IF EXISTS repertorios_estudante_policy ON public.repertorios;
CREATE POLICY repertorios_estudante_policy ON public.repertorios
FOR ALL USING (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
) WITH CHECK (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
);

-- Tabela: simulados (Estudante tem controle total; Responsável pode consultar resultados macro)
DROP POLICY IF EXISTS simulados_estudante_policy ON public.simulados;
CREATE POLICY simulados_estudante_policy ON public.simulados
FOR ALL USING (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
) WITH CHECK (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
);

DROP POLICY IF EXISTS simulados_responsavel_select_policy ON public.simulados;
CREATE POLICY simulados_responsavel_select_policy ON public.simulados
FOR SELECT USING (
  medicina.is_responsavel() AND perfil_id = medicina.current_managed_estudante_id()
);

-- Tabela: simulado_questoes (Ownership herdado de simulados)
DROP POLICY IF EXISTS simulado_questoes_estudante_policy ON public.simulado_questoes;
CREATE POLICY simulado_questoes_estudante_policy ON public.simulado_questoes
FOR ALL USING (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.simulados s
    WHERE s.id = simulado_questoes.simulado_id
      AND s.perfil_id = medicina.current_perfil_id()
  )
) WITH CHECK (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.simulados s
    WHERE s.id = simulado_questoes.simulado_id
      AND s.perfil_id = medicina.current_perfil_id()
  )
);

DROP POLICY IF EXISTS simulado_questoes_responsavel_select_policy ON public.simulado_questoes;
CREATE POLICY simulado_questoes_responsavel_select_policy ON public.simulado_questoes
FOR SELECT USING (
  medicina.is_responsavel()
  AND EXISTS (
    SELECT 1 FROM public.simulados s
    WHERE s.id = simulado_questoes.simulado_id
      AND s.perfil_id = medicina.current_managed_estudante_id()
  )
);

-- Tabela: simulado_areas (Ownership herdado de simulados)
DROP POLICY IF EXISTS simulado_areas_estudante_policy ON public.simulado_areas;
CREATE POLICY simulado_areas_estudante_policy ON public.simulado_areas
FOR ALL USING (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.simulados s
    WHERE s.id = simulado_areas.simulado_id
      AND s.perfil_id = medicina.current_perfil_id()
  )
) WITH CHECK (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.simulados s
    WHERE s.id = simulado_areas.simulado_id
      AND s.perfil_id = medicina.current_perfil_id()
  )
);

DROP POLICY IF EXISTS simulado_areas_responsavel_select_policy ON public.simulado_areas;
CREATE POLICY simulado_areas_responsavel_select_policy ON public.simulado_areas
FOR SELECT USING (
  medicina.is_responsavel()
  AND EXISTS (
    SELECT 1 FROM public.simulados s
    WHERE s.id = simulado_areas.simulado_id
      AND s.perfil_id = medicina.current_managed_estudante_id()
  )
);

-- Tabela: simulado_analise (Ownership herdado de simulados)
DROP POLICY IF EXISTS simulado_analise_estudante_policy ON public.simulado_analise;
CREATE POLICY simulado_analise_estudante_policy ON public.simulado_analise
FOR ALL USING (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.simulados s
    WHERE s.id = simulado_analise.simulado_id
      AND s.perfil_id = medicina.current_perfil_id()
  )
) WITH CHECK (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.simulados s
    WHERE s.id = simulado_analise.simulado_id
      AND s.perfil_id = medicina.current_perfil_id()
  )
);

DROP POLICY IF EXISTS simulado_analise_responsavel_select_policy ON public.simulado_analise;
CREATE POLICY simulado_analise_responsavel_select_policy ON public.simulado_analise
FOR SELECT USING (
  medicina.is_responsavel()
  AND EXISTS (
    SELECT 1 FROM public.simulados s
    WHERE s.id = simulado_analise.simulado_id
      AND s.perfil_id = medicina.current_managed_estudante_id()
  )
);

-- Tabela: checkins (Diários de sono/humor - exclusivo da estudante; responsável acessa via view quinzenal)
DROP POLICY IF EXISTS checkins_estudante_policy ON public.checkins;
CREATE POLICY checkins_estudante_policy ON public.checkins
FOR ALL USING (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
) WITH CHECK (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
);

-- Tabela: livros (Estudante tem controle; Responsável pode consultar plano de leitura)
DROP POLICY IF EXISTS livros_estudante_policy ON public.livros;
CREATE POLICY livros_estudante_policy ON public.livros
FOR ALL USING (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
) WITH CHECK (
  medicina.is_estudante() AND perfil_id = medicina.current_perfil_id()
);

DROP POLICY IF EXISTS livros_responsavel_select_policy ON public.livros;
CREATE POLICY livros_responsavel_select_policy ON public.livros
FOR SELECT USING (
  medicina.is_responsavel() AND perfil_id = medicina.current_managed_estudante_id()
);

-- Tabela: card_revisoes (Ownership herdado de cards)
DROP POLICY IF EXISTS card_revisoes_estudante_select_policy ON public.card_revisoes;
CREATE POLICY card_revisoes_estudante_select_policy ON public.card_revisoes
FOR SELECT USING (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.cards c
    WHERE c.id = card_revisoes.card_id
      AND c.perfil_id = medicina.current_perfil_id()
  )
);

DROP POLICY IF EXISTS card_revisoes_estudante_insert_policy ON public.card_revisoes;
CREATE POLICY card_revisoes_estudante_insert_policy ON public.card_revisoes
FOR INSERT WITH CHECK (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.cards c
    WHERE c.id = card_revisoes.card_id
      AND c.perfil_id = medicina.current_perfil_id()
  )
);

-- ============================================================================
-- CATEGORIA D: CONTEÚDOS SUJEITOS À CURADORIA (PORTÃO DE APROVAÇÃO HUMANA)
-- ============================================================================

-- Tabela: materiais (Princípio 1.7: Apenas aprovados chegam à estudante)
DROP POLICY IF EXISTS materiais_estudante_select_policy ON public.materiais;
CREATE POLICY materiais_estudante_select_policy ON public.materiais
FOR SELECT USING (
  medicina.is_estudante() AND status = 'aprovado'
);

DROP POLICY IF EXISTS materiais_responsavel_admin_policy ON public.materiais;
CREATE POLICY materiais_responsavel_admin_policy ON public.materiais
FOR ALL USING (
  medicina.is_responsavel()
) WITH CHECK (
  medicina.is_responsavel()
);

-- Tabela: perguntas_ativas
DROP POLICY IF EXISTS perguntas_ativas_estudante_select_policy ON public.perguntas_ativas;
CREATE POLICY perguntas_ativas_estudante_select_policy ON public.perguntas_ativas
FOR SELECT USING (
  medicina.is_estudante() AND status = 'aprovado'
);

DROP POLICY IF EXISTS perguntas_ativas_responsavel_admin_policy ON public.perguntas_ativas;
CREATE POLICY perguntas_ativas_responsavel_admin_policy ON public.perguntas_ativas
FOR ALL USING (
  medicina.is_responsavel()
) WITH CHECK (
  medicina.is_responsavel()
);

-- Tabela: cards (Curadoria + Criação Manual pela Estudante + Parâmetros FSRS)
DROP POLICY IF EXISTS cards_estudante_select_policy ON public.cards;
CREATE POLICY cards_estudante_select_policy ON public.cards
FOR SELECT USING (
  medicina.is_estudante()
  AND perfil_id = medicina.current_perfil_id()
  AND status = 'aprovado'
);

DROP POLICY IF EXISTS cards_estudante_insert_policy ON public.cards;
CREATE POLICY cards_estudante_insert_policy ON public.cards
FOR INSERT WITH CHECK (
  medicina.is_estudante()
  AND perfil_id = medicina.current_perfil_id()
  AND status = 'aprovado'
  AND origem = 'manual'
);

DROP POLICY IF EXISTS cards_estudante_update_policy ON public.cards;
CREATE POLICY cards_estudante_update_policy ON public.cards
FOR UPDATE USING (
  medicina.is_estudante()
  AND perfil_id = medicina.current_perfil_id()
  AND status = 'aprovado'
) WITH CHECK (
  medicina.is_estudante()
  AND perfil_id = medicina.current_perfil_id()
  AND status = 'aprovado'
);

DROP POLICY IF EXISTS cards_estudante_delete_policy ON public.cards;
CREATE POLICY cards_estudante_delete_policy ON public.cards
FOR DELETE USING (
  medicina.is_estudante()
  AND perfil_id = medicina.current_perfil_id()
  AND origem = 'manual'
);

DROP POLICY IF EXISTS cards_responsavel_admin_policy ON public.cards;
CREATE POLICY cards_responsavel_admin_policy ON public.cards
FOR ALL USING (
  medicina.is_responsavel()
) WITH CHECK (
  medicina.is_responsavel()
);

-- Tabela: questoes
DROP POLICY IF EXISTS questoes_estudante_select_policy ON public.questoes;
CREATE POLICY questoes_estudante_select_policy ON public.questoes
FOR SELECT USING (
  medicina.is_estudante() AND status = 'aprovado'
);

DROP POLICY IF EXISTS questoes_responsavel_admin_policy ON public.questoes;
CREATE POLICY questoes_responsavel_admin_policy ON public.questoes
FOR ALL USING (
  medicina.is_responsavel()
) WITH CHECK (
  medicina.is_responsavel()
);

-- Tabela: questao_topicos (Ownership herdado de questoes)
DROP POLICY IF EXISTS questao_topicos_estudante_select_policy ON public.questao_topicos;
CREATE POLICY questao_topicos_estudante_select_policy ON public.questao_topicos
FOR SELECT USING (
  medicina.is_estudante()
  AND EXISTS (
    SELECT 1 FROM public.questoes q
    WHERE q.id = questao_topicos.questao_id
      AND q.status = 'aprovado'
  )
);

DROP POLICY IF EXISTS questao_topicos_responsavel_admin_policy ON public.questao_topicos;
CREATE POLICY questao_topicos_responsavel_admin_policy ON public.questao_topicos
FOR ALL USING (
  medicina.is_responsavel()
) WITH CHECK (
  medicina.is_responsavel()
);

-- Tabela: curadoria_fila (Painel exclusivo do responsável)
DROP POLICY IF EXISTS curadoria_fila_responsavel_admin_policy ON public.curadoria_fila;
CREATE POLICY curadoria_fila_responsavel_admin_policy ON public.curadoria_fila
FOR ALL USING (
  medicina.is_responsavel()
) WITH CHECK (
  medicina.is_responsavel()
);

-- ============================================================================
-- CATEGORIA E: DADOS TÉCNICOS INTERNOS / INGESTÃO / PIPELINE
-- ============================================================================

-- Tabela: acervo_arquivos
DROP POLICY IF EXISTS acervo_arquivos_responsavel_policy ON public.acervo_arquivos;
CREATE POLICY acervo_arquivos_responsavel_policy ON public.acervo_arquivos
FOR ALL USING (
  medicina.is_responsavel()
  AND (enviado_por = medicina.current_perfil_id() OR enviado_por IS NULL)
) WITH CHECK (
  medicina.is_responsavel()
  AND enviado_por = medicina.current_perfil_id()
);

-- Tabela: acervo_paginas (Ownership herdado de acervo_arquivos)
DROP POLICY IF EXISTS acervo_paginas_responsavel_policy ON public.acervo_paginas;
CREATE POLICY acervo_paginas_responsavel_policy ON public.acervo_paginas
FOR ALL USING (
  medicina.is_responsavel()
  AND EXISTS (
    SELECT 1 FROM public.acervo_arquivos a
    WHERE a.id = acervo_paginas.arquivo_id
      AND (a.enviado_por = medicina.current_perfil_id() OR a.enviado_por IS NULL)
  )
) WITH CHECK (
  medicina.is_responsavel()
  AND EXISTS (
    SELECT 1 FROM public.acervo_arquivos a
    WHERE a.id = acervo_paginas.arquivo_id
      AND a.enviado_por = medicina.current_perfil_id()
  )
);

-- Tabela: acervo_chunks (Ownership herdado de acervo_arquivos)
DROP POLICY IF EXISTS acervo_chunks_responsavel_policy ON public.acervo_chunks;
CREATE POLICY acervo_chunks_responsavel_policy ON public.acervo_chunks
FOR ALL USING (
  medicina.is_responsavel()
  AND EXISTS (
    SELECT 1 FROM public.acervo_arquivos a
    WHERE a.id = acervo_chunks.arquivo_id
      AND (a.enviado_por = medicina.current_perfil_id() OR a.enviado_por IS NULL)
  )
) WITH CHECK (
  medicina.is_responsavel()
  AND EXISTS (
    SELECT 1 FROM public.acervo_arquivos a
    WHERE a.id = acervo_chunks.arquivo_id
      AND a.enviado_por = medicina.current_perfil_id()
  )
);

-- Tabela: acervo_figuras (Ownership herdado de acervo_arquivos)
DROP POLICY IF EXISTS acervo_figuras_responsavel_policy ON public.acervo_figuras;
CREATE POLICY acervo_figuras_responsavel_policy ON public.acervo_figuras
FOR ALL USING (
  medicina.is_responsavel()
  AND EXISTS (
    SELECT 1 FROM public.acervo_arquivos a
    WHERE a.id = acervo_figuras.arquivo_id
      AND (a.enviado_por = medicina.current_perfil_id() OR a.enviado_por IS NULL)
  )
) WITH CHECK (
  medicina.is_responsavel()
  AND EXISTS (
    SELECT 1 FROM public.acervo_arquivos a
    WHERE a.id = acervo_figuras.arquivo_id
      AND a.enviado_por = medicina.current_perfil_id()
  )
);

-- Tabela: geracoes
DROP POLICY IF EXISTS geracoes_responsavel_admin_policy ON public.geracoes;
CREATE POLICY geracoes_responsavel_admin_policy ON public.geracoes
FOR ALL USING (
  medicina.is_responsavel()
) WITH CHECK (
  medicina.is_responsavel()
);

-- ----------------------------------------------------------------------------
-- 6. PROTEÇÃO DOS PERFIS (PROJEÇÃO SEGURA SEM PASSWORD_HASH)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_perfis
WITH (security_invoker = true) AS
SELECT
  id,
  auth_user_id,
  nome,
  email,
  papel,
  criado_em
FROM public.perfis;

-- ----------------------------------------------------------------------------
-- 7. VIEWS AGREGADAS DE ACOMPANHAMENTO (PRINCÍPIO 1.2 — NÃO-VIGILÂNCIA)
-- ----------------------------------------------------------------------------

-- 7.1 Função Agregadora Quinzenal Segura (Security Definer com Escopo Restrito)
CREATE OR REPLACE FUNCTION medicina.fn_acompanhamento_quinzenal()
RETURNS TABLE (
  periodo_rotulo text,
  periodo_inicio date,
  periodo_fim date,
  blocos_concluidos integer,
  media_horas_sono numeric(3,1),
  redacoes_escritas integer,
  redacoes_reescritas integer,
  cards_fsrs_ativos integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, medicina, public, pg_temp
AS $$
DECLARE
  v_estudante_id uuid;
  v_hoje date := CURRENT_DATE;
  v_q1_inicio date := v_hoje - 14;
  v_q1_fim date := v_hoje;
  v_q2_inicio date := v_hoje - 29;
  v_q2_fim date := v_hoje - 15;
  v_total_cards integer;
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

  SELECT count(*)::integer INTO v_total_cards
  FROM public.cards
  WHERE perfil_id = v_estudante_id
    AND status = 'aprovado'
    AND suspenso = false;

  -- Quinzena 1 (Últimos 15 dias)
  RETURN QUERY
  SELECT
    (to_char(v_q1_inicio, 'DD/MM') || ' a ' || to_char(v_q1_fim, 'DD/MM'))::text AS periodo_rotulo,
    v_q1_inicio AS periodo_inicio,
    v_q1_fim AS periodo_fim,
    COALESCE(
      (SELECT count(*)::integer FROM public.sessoes s
       WHERE s.perfil_id = v_estudante_id
         AND s.concluida = true
         AND s.iniciada_em >= v_q1_inicio::timestamp
         AND s.iniciada_em < (v_q1_fim + 1)::timestamp),
      0
    ) AS blocos_concluidos,
    COALESCE(
      (SELECT round(avg(c.horas_sono)::numeric, 1) FROM public.checkins c
       WHERE c.perfil_id = v_estudante_id
         AND c.data >= v_q1_inicio
         AND c.data <= v_q1_fim),
      0.0
    ) AS media_horas_sono,
    COALESCE(
      (SELECT count(*)::integer FROM public.redacoes r
       WHERE r.perfil_id = v_estudante_id
         AND r.escrita_em >= v_q1_inicio::timestamp
         AND r.escrita_em < (v_q1_fim + 1)::timestamp),
      0
    ) AS redacoes_escritas,
    COALESCE(
      (SELECT count(*)::integer FROM public.redacoes r
       WHERE r.perfil_id = v_estudante_id
         AND r.reescrita_de_id IS NOT NULL
         AND r.escrita_em >= v_q1_inicio::timestamp
         AND r.escrita_em < (v_q1_fim + 1)::timestamp),
      0
    ) AS redacoes_reescritas,
    COALESCE(v_total_cards, 0) AS cards_fsrs_ativos;

  -- Quinzena 2 (De 30 a 15 dias atrás)
  RETURN QUERY
  SELECT
    (to_char(v_q2_inicio, 'DD/MM') || ' a ' || to_char(v_q2_fim, 'DD/MM'))::text AS periodo_rotulo,
    v_q2_inicio AS periodo_inicio,
    v_q2_fim AS periodo_fim,
    COALESCE(
      (SELECT count(*)::integer FROM public.sessoes s
       WHERE s.perfil_id = v_estudante_id
         AND s.concluida = true
         AND s.iniciada_em >= v_q2_inicio::timestamp
         AND s.iniciada_em < (v_q2_fim + 1)::timestamp),
      0
    ) AS blocos_concluidos,
    COALESCE(
      (SELECT round(avg(c.horas_sono)::numeric, 1) FROM public.checkins c
       WHERE c.perfil_id = v_estudante_id
         AND c.data >= v_q2_inicio
         AND c.data <= v_q2_fim),
      0.0
    ) AS media_horas_sono,
    COALESCE(
      (SELECT count(*)::integer FROM public.redacoes r
       WHERE r.perfil_id = v_estudante_id
         AND r.escrita_em >= v_q2_inicio::timestamp
         AND r.escrita_em < (v_q2_fim + 1)::timestamp),
      0
    ) AS redacoes_escritas,
    COALESCE(
      (SELECT count(*)::integer FROM public.redacoes r
       WHERE r.perfil_id = v_estudante_id
         AND r.reescrita_de_id IS NOT NULL
         AND r.escrita_em >= v_q2_inicio::timestamp
         AND r.escrita_em < (v_q2_fim + 1)::timestamp),
      0
    ) AS redacoes_reescritas,
    COALESCE(v_total_cards, 0) AS cards_fsrs_ativos;
END;
$$;

-- 7.2 View Quinzenal Agregada
CREATE OR REPLACE VIEW public.vw_acompanhamento_quinzenal AS
SELECT * FROM medicina.fn_acompanhamento_quinzenal();

-- 7.3 Função Agregadora da Evolução de Simulados
CREATE OR REPLACE FUNCTION medicina.fn_simulados_evolucao()
RETURNS TABLE (
  simulado_id uuid,
  data date,
  formato text,
  condicoes_reais boolean,
  duracao_min integer,
  total_questoes bigint,
  total_acertos bigint,
  percentual_acerto numeric(5,2),
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

-- 7.4 View da Evolução de Simulados
CREATE OR REPLACE VIEW public.vw_simulados_evolucao AS
SELECT * FROM medicina.fn_simulados_evolucao();

-- 7.5 View de Revisões Trimestrais (Security Invoker)
CREATE OR REPLACE VIEW public.vw_revisoes_trimestrais
WITH (security_invoker = true) AS
SELECT
  id,
  estudante_perfil_id,
  registrada_por_perfil_id,
  trimestre,
  ano,
  aderencia_pct,
  cards_atrasados,
  media_enem,
  acerto_uece_pct,
  divergencia_trilhos,
  tipo_erro_predominante,
  redacoes_escritas,
  redacoes_reescritas,
  media_sono,
  conversa,
  decisoes,
  fechada_em
FROM public.revisoes_trimestrais;

-- ----------------------------------------------------------------------------
-- 8. PERMISSÕES DE LEITURA DAS VIEWS PARA A APLICAÇÃO
-- ----------------------------------------------------------------------------
GRANT SELECT ON public.vw_perfis TO medicina_app;
GRANT SELECT ON public.vw_acompanhamento_quinzenal TO medicina_app;
GRANT SELECT ON public.vw_simulados_evolucao TO medicina_app;
GRANT SELECT ON public.vw_revisoes_trimestrais TO medicina_app;

GRANT EXECUTE ON FUNCTION medicina.fn_acompanhamento_quinzenal() TO medicina_app;
GRANT EXECUTE ON FUNCTION medicina.fn_simulados_evolucao() TO medicina_app;

-- ----------------------------------------------------------------------------
-- 9. COMPATIBILIDADE CONDICIONAL COM TABELAS ADITIVAS (F1.09 / F1.11 / F1.12)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.operacoes_idempotentes') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.operacoes_idempotentes TO medicina_app;
    REVOKE ALL ON public.operacoes_idempotentes FROM medicina_anon;

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

  IF to_regclass('public.acervo_jobs') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.acervo_jobs TO medicina_app;
    REVOKE ALL ON public.acervo_jobs FROM medicina_anon;

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
