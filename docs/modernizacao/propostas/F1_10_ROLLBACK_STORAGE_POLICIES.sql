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
DROP POLICY IF EXISTS acervo_objects_responsavel_select ON storage.objects;
DROP POLICY IF EXISTS acervo_buckets_select_authenticated ON storage.buckets;

ALTER TABLE storage.buckets DROP CONSTRAINT IF EXISTS storage_buckets_acervo_private_check;

UPDATE storage.buckets
SET public = false
WHERE id = 'acervo';

DROP FUNCTION IF EXISTS medicina.is_valid_acervo_storage_path(text);

COMMIT;
