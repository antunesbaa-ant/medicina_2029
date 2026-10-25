-- ============================================================================
-- MEDICINA 2029 — TAREFA F1.10 (H1.07-R)
-- ROLLBACK ATÔMICO DA VALIDAÇÃO DE STORAGE E INTEGRIDADE DE DOMÍNIO (ACERVO)
-- ============================================================================
-- Reverte a constraint de formato de caminho em public.acervo_arquivos e a
-- função canônica medicina.is_valid_acervo_storage_path criadas por
-- F1_10_STORAGE_POLICIES_PROPOSTA.sql de forma 100% limpa, segura e simétrica,
-- sem intervenções no schema gerenciado `storage`.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. Remove a constraint de validação de caminho em public.acervo_arquivos
ALTER TABLE IF EXISTS public.acervo_arquivos
  DROP CONSTRAINT IF EXISTS acervo_arquivos_file_path_format_check;

-- 2. Remove a função canônica de validação de caminho
DROP FUNCTION IF EXISTS medicina.is_valid_acervo_storage_path(text);

COMMIT;
