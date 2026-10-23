-- ============================================================================
-- MEDICINA 2029 — TAREFA F1.10
-- ROLLBACK ATÔMICO DAS POLICIES DO SUPABASE STORAGE (ACERVO)
-- ============================================================================
-- Reverte as policies, constraints e função auxiliar criadas por
-- F1_10_STORAGE_POLICIES_PROPOSTA.sql, mantendo o bucket `acervo` como privado
-- (`public = false`) para nunca expor documentos privados durante rollback.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS acervo_objects_responsavel_delete_unlinked ON storage.objects;
DROP POLICY IF EXISTS acervo_objects_responsavel_insert ON storage.objects;
DROP POLICY IF EXISTS acervo_objects_worker_select ON storage.objects;
DROP POLICY IF EXISTS acervo_objects_responsavel_select ON storage.objects;
DROP POLICY IF EXISTS acervo_buckets_select_authenticated ON storage.buckets;

DO $$
BEGIN
  IF to_regnamespace('storage') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_worker') THEN
      REVOKE ALL ON ALL TABLES IN SCHEMA storage FROM medicina_worker;
      REVOKE ALL ON SCHEMA storage FROM medicina_worker;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_app') THEN
      REVOKE ALL ON ALL TABLES IN SCHEMA storage FROM medicina_app;
      REVOKE ALL ON SCHEMA storage FROM medicina_app;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
    BEGIN
      ALTER TABLE storage.buckets DROP CONSTRAINT IF EXISTS storage_buckets_acervo_private_check;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE WARNING 'AVISO DE PRIVILÉGIO PENDENTE NO ROLLBACK: Não foi possível remover constraint em storage.buckets (role: %)', current_user;
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
    BEGIN
      UPDATE storage.buckets
      SET public = false
      WHERE id = 'acervo';
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE WARNING 'AVISO DE PRIVILÉGIO PENDENTE NO ROLLBACK: Não foi possível atualizar storage.buckets (role: %)', current_user;
    END;
  END IF;
END $$;

DROP FUNCTION IF EXISTS medicina.is_valid_acervo_storage_path(text);

COMMIT;
