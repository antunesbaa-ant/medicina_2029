-- ============================================================================
-- MEDICINA 2029 — TAREFA F1.10 (H1.07-R)
-- PROPOSTA DE VALIDAÇÃO DE STORAGE E INTEGRIDADE DE DOMÍNIO (ACERVO)
-- ============================================================================
-- COMPATIBILIDADE NATIVA COM SUPABASE CLOUD:
-- 1. O schema `storage` e as tabelas `storage.buckets` e `storage.objects` são
--    gerenciados nativamente pela infraestrutura do Supabase Cloud e pertencem
--    ao superuser interno `supabase_storage_admin`.
-- 2. A role administrativa de conexão (`postgres.ynfocaorhadizlvbnzrt`) NÃO possui
--    ownership sobre `storage.buckets` nem `storage.objects`. DDLs estruturais
--    ou mutações no schema `storage` são proibidos nesta migração.
-- 3. O bucket `acervo` já foi previamente provisionado via Supabase Dashboard /
--    Storage Management API com `public = false`, limite de 20 MiB (20971520 bytes)
--    e restrição estrita a MIME `application/pdf`.
-- 4. A aplicação utiliza NextAuth na camada web e `SUPABASE_SERVICE_ROLE_KEY`
--    no backend (App Router / Server Actions). Não há conexões diretas de
--    usuários finais via Supabase Auth JWT ao gateway HTTP do Supabase Storage.
--    Em uploads via service_role, `storage.objects.owner_id` fica NULL ou com ID
--    da service_role; policies de RLS que avaliem `medicina.current_perfil_id()`
--    são inoperantes no gateway HTTP do Supabase Storage e foram eliminadas.
-- 5. Esta migração estabelece a integridade relacional no schema de domínio (`public`):
--    a) Preflight Fail-Closed: valida existência de perfis, acervo_arquivos,
--       responsavel_estudante, integridade dos registros existentes e confirma
--       no catálogo `storage.buckets` que o bucket `acervo` existe e é privado.
--    b) Função canônica e imutável `medicina.is_valid_acervo_storage_path(text)`.
--    c) Concessão de privilégios de execução estritos (`medicina_app`, `medicina_worker`)
--       e revogação explícita de `PUBLIC`.
--    d) Constraint de integridade de formato diretamente em `public.acervo_arquivos`
--       (`acervo_arquivos_file_path_format_check`) via NOT VALID + VALIDATE CONSTRAINT.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. PREFLIGHT DIAGNÓSTICO FAIL-CLOSED
DO $$
DECLARE
  v_bucket_ok boolean;
BEGIN
  -- 1.1 Verifica se as tabelas base de domínio e perfis existem
  IF to_regclass('public.perfis') IS NULL
     OR to_regclass('public.acervo_arquivos') IS NULL
     OR to_regclass('public.responsavel_estudante') IS NULL
  THEN
    RAISE EXCEPTION
      'F1.10 Storage Policies abortada: tabelas base ou expansão F1.03-R ausentes.'
      USING ERRCODE = 'P0001';
  END IF;

  -- 1.2 Verifica se em public.acervo_arquivos há violação de mime, tamanho ou path traversal
  IF EXISTS (
    SELECT 1
    FROM public.acervo_arquivos
    WHERE mime <> 'application/pdf'
       OR tamanho_bytes <= 0
       OR tamanho_bytes > 20971520
       OR file_path LIKE '%..%'
       OR file_path LIKE '%\%'
  ) THEN
    RAISE EXCEPTION
      'F1.10 Storage Policies abortada: existem registros em acervo_arquivos fora dos limites de MIME, tamanho ou caminho seguro.'
      USING ERRCODE = 'P0001';
  END IF;

  -- 1.3 Verifica se no catálogo storage.buckets o bucket acervo existe e possui public = false
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'Bucket acervo inexistente ou não configurado como privado'
      USING ERRCODE = 'P0001';
  END IF;

  EXECUTE '
    SELECT EXISTS (
      SELECT 1
      FROM storage.buckets
      WHERE id = ''acervo'' AND public = false
    )
  ' INTO v_bucket_ok;

  IF NOT COALESCE(v_bucket_ok, false) THEN
    RAISE EXCEPTION
      'Bucket acervo inexistente ou não configurado como privado'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

-- 2. FUNÇÃO CANÔNICA DE VALIDAÇÃO DE CAMINHO (SCHEMA medicina)
CREATE SCHEMA IF NOT EXISTS medicina;

CREATE OR REPLACE FUNCTION medicina.is_valid_acervo_storage_path(p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, medicina, pg_temp
AS $$
  SELECT
    p_name IS NOT NULL
    AND char_length(p_name) BETWEEN 12 AND 512
    AND p_name LIKE 'acervo/%.pdf'
    AND strpos(p_name, '..') = 0
    AND strpos(p_name, '//') = 0
    AND strpos(p_name, '\') = 0
    AND p_name ~ '^acervo/[0-9a-f]{64}(_[A-Za-z0-9._-]+)?\.pdf$';
$$;

-- 3. CONCESSÃO DE PRIVILÉGIOS ESTREITOS DE EXECUÇÃO
REVOKE ALL ON FUNCTION medicina.is_valid_acervo_storage_path(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_app') THEN
    GRANT USAGE ON SCHEMA medicina TO medicina_app;
    GRANT EXECUTE ON FUNCTION medicina.is_valid_acervo_storage_path(text) TO medicina_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_worker') THEN
    GRANT USAGE ON SCHEMA medicina TO medicina_worker;
    GRANT EXECUTE ON FUNCTION medicina.is_valid_acervo_storage_path(text) TO medicina_worker;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_anon') THEN
    REVOKE ALL ON FUNCTION medicina.is_valid_acervo_storage_path(text) FROM medicina_anon;
  END IF;
END
$$;

-- 4. INTEGRIDADE NO SCHEMA DE DOMÍNIO (public.acervo_arquivos)
ALTER TABLE public.acervo_arquivos
  DROP CONSTRAINT IF EXISTS acervo_arquivos_file_path_format_check;

ALTER TABLE public.acervo_arquivos
  ADD CONSTRAINT acervo_arquivos_file_path_format_check
  CHECK (medicina.is_valid_acervo_storage_path(file_path)) NOT VALID;

ALTER TABLE public.acervo_arquivos
  VALIDATE CONSTRAINT acervo_arquivos_file_path_format_check;

COMMIT;
