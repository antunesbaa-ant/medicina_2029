-- ============================================================================
-- MEDICINA 2029 — TAREFA F1.10
-- PROPOSTA DE BUCKET PRIVADO E POLICIES DO SUPABASE STORAGE (ACERVO)
-- ============================================================================
-- IMPORTANTE:
-- 1. Esta proposta fica FORA do journal automático do Drizzle e NÃO deve ser
--    aplicada automaticamente em produção ou no Supabase remoto sem janela aprovada.
-- 2. Garante que o bucket `acervo` seja estritamente PRIVADO (`public = false`),
--    com limite de 20 MiB (`20971520` bytes) e restrito a `application/pdf`.
-- 3. Nega qualquer leitura/escrita anônima ou pública permanente e proíbe
--    sobrescrita silenciosa (`UPDATE` bloqueado; `upsert: false`).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. PREFLIGHT: diagnóstico sem efeitos colaterais
DO $$
BEGIN
  IF to_regclass('public.perfis') IS NULL
     OR to_regclass('public.acervo_arquivos') IS NULL
     OR to_regclass('public.responsavel_estudante') IS NULL
  THEN
    RAISE EXCEPTION
      'F1.10 Storage Policies abortada: tabelas base ou expansão F1.03-R ausentes.'
      USING ERRCODE = 'P0001';
  END IF;

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
END
$$;

-- 2. ESTRUTURA COMPATÍVEL DE STORAGE (PARA AMBIENTE ISOLADO / PGLITE SE AUSENTE)
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  owner uuid,
  public boolean DEFAULT false NOT NULL,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  bucket_id text NOT NULL REFERENCES storage.buckets(id) ON DELETE RESTRICT,
  name text NOT NULL,
  owner uuid,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT storage_objects_bucket_name_unique UNIQUE (bucket_id, name)
);

-- 3. FUNÇÕES AUXILIARES DE CONTEXTO E VALIDAÇÃO DE CHAVE (SCHEMA medicina)
CREATE SCHEMA IF NOT EXISTS medicina;

CREATE OR REPLACE FUNCTION medicina.current_perfil_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public, medicina, pg_temp
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

CREATE OR REPLACE FUNCTION medicina.current_papel()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, medicina, pg_temp
AS $$
DECLARE
  v_val text;
BEGIN
  v_val := current_setting('medicina.current_papel', true);
  IF v_val IN ('estudante', 'responsavel') THEN
    RETURN v_val;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION medicina.is_estudante()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, medicina, pg_temp
AS $$
  SELECT COALESCE(medicina.current_papel() = 'estudante' AND medicina.current_perfil_id() IS NOT NULL, false);
$$;

CREATE OR REPLACE FUNCTION medicina.is_responsavel()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, medicina, pg_temp
AS $$
  SELECT COALESCE(medicina.current_papel() = 'responsavel' AND medicina.current_perfil_id() IS NOT NULL, false);
$$;

CREATE OR REPLACE FUNCTION medicina.is_valid_acervo_storage_path(p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, medicina, pg_temp
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

REVOKE ALL ON FUNCTION medicina.current_perfil_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION medicina.current_papel() FROM PUBLIC;
REVOKE ALL ON FUNCTION medicina.is_estudante() FROM PUBLIC;
REVOKE ALL ON FUNCTION medicina.is_responsavel() FROM PUBLIC;
REVOKE ALL ON FUNCTION medicina.is_valid_acervo_storage_path(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_app') THEN
    GRANT USAGE ON SCHEMA medicina TO medicina_app;
    GRANT EXECUTE ON FUNCTION medicina.current_perfil_id() TO medicina_app;
    GRANT EXECUTE ON FUNCTION medicina.current_papel() TO medicina_app;
    GRANT EXECUTE ON FUNCTION medicina.is_estudante() TO medicina_app;
    GRANT EXECUTE ON FUNCTION medicina.is_responsavel() TO medicina_app;
    GRANT USAGE ON SCHEMA storage TO medicina_app;
    GRANT SELECT ON storage.buckets TO medicina_app;
    GRANT SELECT, INSERT, DELETE ON storage.objects TO medicina_app;
    GRANT EXECUTE ON FUNCTION medicina.is_valid_acervo_storage_path(text) TO medicina_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_worker') THEN
    GRANT USAGE ON SCHEMA medicina TO medicina_worker;
    GRANT EXECUTE ON FUNCTION medicina.current_perfil_id() TO medicina_worker;
    GRANT EXECUTE ON FUNCTION medicina.current_papel() TO medicina_worker;
    GRANT EXECUTE ON FUNCTION medicina.is_estudante() TO medicina_worker;
    GRANT EXECUTE ON FUNCTION medicina.is_responsavel() TO medicina_worker;
    GRANT USAGE ON SCHEMA storage TO medicina_worker;
    GRANT SELECT ON storage.buckets, storage.objects TO medicina_worker;
    GRANT EXECUTE ON FUNCTION medicina.is_valid_acervo_storage_path(text) TO medicina_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_anon') THEN
    REVOKE ALL ON SCHEMA storage FROM medicina_anon;
    REVOKE ALL ON storage.buckets, storage.objects FROM medicina_anon;
    REVOKE ALL ON FUNCTION medicina.is_valid_acervo_storage_path(text) FROM medicina_anon;
  END IF;
END
$$;

-- 4. CONFIGURAÇÃO ESTRITA DO BUCKET PRIVADO `acervo`
ALTER TABLE storage.buckets DROP CONSTRAINT IF EXISTS storage_buckets_acervo_private_check;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('acervo', 'acervo', false, 20971520, ARRAY['application/pdf']::text[])
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = false,
  file_size_limit = 20971520,
  allowed_mime_types = ARRAY['application/pdf']::text[],
  updated_at = now();

ALTER TABLE storage.buckets
  ADD CONSTRAINT storage_buckets_acervo_private_check
  CHECK (
    id <> 'acervo'
    OR (
      public = false
      AND file_size_limit = 20971520
      AND allowed_mime_types = ARRAY['application/pdf']::text[]
    )
  );

-- 5. ATIVAÇÃO DE RLS E POLICIES FAIL-CLOSED NO STORAGE
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.buckets FORCE ROW LEVEL SECURITY;

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS acervo_buckets_select_authenticated ON storage.buckets;
DROP POLICY IF EXISTS acervo_objects_responsavel_select ON storage.objects;
DROP POLICY IF EXISTS acervo_objects_worker_select ON storage.objects;
DROP POLICY IF EXISTS acervo_objects_responsavel_insert ON storage.objects;
DROP POLICY IF EXISTS acervo_objects_responsavel_delete_unlinked ON storage.objects;

-- 5.1 Leitura de metadados do bucket restrita a perfis autenticados (ou worker) e bucket privado
CREATE POLICY acervo_buckets_select_authenticated
  ON storage.buckets
  FOR SELECT
  USING (
    id = 'acervo'
    AND public = false
    AND (medicina.current_perfil_id() IS NOT NULL OR current_user = 'medicina_worker')
  );

-- 5.2 Leitura de objetos do acervo restrita ao responsável proprietário
CREATE POLICY acervo_objects_responsavel_select
  ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'acervo'
    AND medicina.is_responsavel()
    AND medicina.is_valid_acervo_storage_path(name)
    AND (
      owner = medicina.current_perfil_id()
      OR EXISTS (
        SELECT 1
        FROM public.acervo_arquivos a
        WHERE a.file_path = storage.objects.name
          AND a.enviado_por = medicina.current_perfil_id()
      )
    )
  );

-- 5.2.1 Leitura somente-leitura para o worker de ingestão sobre objetos registrados em acervo_arquivos
CREATE POLICY acervo_objects_worker_select
  ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'acervo'
    AND current_user = 'medicina_worker'
    AND medicina.is_valid_acervo_storage_path(name)
    AND EXISTS (
      SELECT 1
      FROM public.acervo_arquivos a
      WHERE a.file_path = storage.objects.name
    )
  );

-- 5.3 Upload de novos objetos restrito a responsável autenticado (sem UPDATE / upsert: false)
CREATE POLICY acervo_objects_responsavel_insert
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'acervo'
    AND medicina.is_responsavel()
    AND medicina.is_valid_acervo_storage_path(name)
    AND (owner IS NULL OR owner = medicina.current_perfil_id())
    AND COALESCE(metadata->>'mimetype', 'application/pdf') = 'application/pdf'
    AND COALESCE((metadata->>'size')::bigint, 1) BETWEEN 1 AND 20971520
  );

-- 5.4 Exclusão manual permitida apenas ao responsável proprietário quando o objeto
--     NÃO está vinculado a nenhum registro em public.acervo_arquivos
CREATE POLICY acervo_objects_responsavel_delete_unlinked
  ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'acervo'
    AND medicina.is_responsavel()
    AND owner = medicina.current_perfil_id()
    AND NOT EXISTS (
      SELECT 1
      FROM public.acervo_arquivos a
      WHERE a.file_path = storage.objects.name
    )
  );

COMMIT;
