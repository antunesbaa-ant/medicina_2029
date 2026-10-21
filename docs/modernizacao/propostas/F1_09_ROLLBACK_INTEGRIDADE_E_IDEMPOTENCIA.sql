-- ============================================================================
-- MEDICINA 2029 — F1.09
-- ROLLBACK ATÔMICO DA PROPOSTA DE INTEGRIDADE E IDEMPOTÊNCIA PERSISTENTE
-- ============================================================================
-- Reverte integralmente todos os objetos, constraints, índices e colunas
-- adicionados por F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql, preservando
-- intacta a expansão F1.03-R (0003_f1_03_r_expansao.sql).
-- ============================================================================

BEGIN;

ALTER TABLE "acervo_arquivos" DROP CONSTRAINT IF EXISTS "acervo_arquivos_tamanho_serie_check";
ALTER TABLE "checkins" DROP CONSTRAINT IF EXISTS "checkins_limites_dominio_check";
ALTER TABLE "redacoes" DROP CONSTRAINT IF EXISTS "redacoes_limites_e_genero_check";
ALTER TABLE "simulado_areas" DROP CONSTRAINT IF EXISTS "simulado_areas_acertos_total_check";
ALTER TABLE "simulados" DROP CONSTRAINT IF EXISTS "simulados_duracao_limites_check";
ALTER TABLE "card_revisoes" DROP CONSTRAINT IF EXISTS "card_revisoes_duracao_rating_check";
ALTER TABLE "sessoes" DROP CONSTRAINT IF EXISTS "sessoes_ordem_temporal_check";
ALTER TABLE "sessoes" DROP CONSTRAINT IF EXISTS "sessoes_tempos_limites_check";

ALTER TABLE "acervo_arquivos" DROP CONSTRAINT IF EXISTS "acervo_arquivos_hash_conteudo_unique";
ALTER TABLE "curadoria_fila" DROP CONSTRAINT IF EXISTS "curadoria_fila_artefato_unique";
ALTER TABLE "erros" DROP CONSTRAINT IF EXISTS "erros_tentativa_id_unique";
DROP INDEX IF EXISTS "sessoes_uma_aberta_por_bloco_topico_uidx";

DROP INDEX IF EXISTS "geracoes_chave_idempotencia_uidx";
ALTER TABLE "geracoes" DROP COLUMN IF EXISTS "chave_idempotencia";

DROP INDEX IF EXISTS "card_revisoes_card_chave_idempotencia_uidx";
ALTER TABLE "card_revisoes" DROP COLUMN IF EXISTS "chave_idempotencia";

DROP TABLE IF EXISTS "operacoes_idempotentes";

COMMIT;
