-- MEDICINA 2029 — F1.03-R
-- ROLLBACK FISICO SOMENTE DA CONTRACAO, para ensaio isolado.
-- Mantem tabela, owners, FKs e dados criados pela expansao. Executar esta
-- reversao antes de voltar operacionalmente para a aplicacao anterior.

BEGIN;

DROP INDEX IF EXISTS ciclos_um_ativo_por_estudante_idx;

ALTER TABLE revisoes_trimestrais DROP CONSTRAINT IF EXISTS revisoes_trimestrais_periodo_unique;
ALTER TABLE acervo_chunks DROP CONSTRAINT IF EXISTS acervo_chunks_arquivo_ordem_unique;
ALTER TABLE acervo_paginas DROP CONSTRAINT IF EXISTS acervo_paginas_arquivo_numero_unique;
ALTER TABLE simulado_analise DROP CONSTRAINT IF EXISTS simulado_analise_simulado_unique;
ALTER TABLE simulado_areas DROP CONSTRAINT IF EXISTS simulado_areas_simulado_area_unique;
ALTER TABLE simulado_questoes DROP CONSTRAINT IF EXISTS simulado_questoes_simulado_ordem_unique;
ALTER TABLE simulado_questoes DROP CONSTRAINT IF EXISTS simulado_questoes_pk;
ALTER TABLE questao_topicos DROP CONSTRAINT IF EXISTS questao_topicos_pk;
ALTER TABLE ciclo_blocos DROP CONSTRAINT IF EXISTS ciclo_blocos_ciclo_ordem_unique;

ALTER TABLE revisoes_trimestrais ALTER COLUMN registrada_por_perfil_id DROP NOT NULL;
ALTER TABLE revisoes_trimestrais ALTER COLUMN estudante_perfil_id DROP NOT NULL;
ALTER TABLE repertorios ALTER COLUMN perfil_id DROP NOT NULL;
ALTER TABLE ciclos ALTER COLUMN estudante_perfil_id DROP NOT NULL;

COMMIT;
