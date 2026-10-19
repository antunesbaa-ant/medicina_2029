-- MEDICINA 2029 — F1.03-M
-- Rollback FISICO da proposta F1.03, somente para ambiente descartavel.
-- Nao equivale a rollback operacional da aplicacao nem a restauracao de backup.

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

ALTER TABLE redacoes DROP CONSTRAINT IF EXISTS redacoes_reescrita_de_fk;
ALTER TABLE tentativas DROP CONSTRAINT IF EXISTS tentativas_simulado_fk;
ALTER TABLE questoes DROP CONSTRAINT IF EXISTS questoes_arquivo_origem_fk;
ALTER TABLE topicos DROP CONSTRAINT IF EXISTS topicos_pre_requisito_fk;

ALTER TABLE revisoes_trimestrais DROP CONSTRAINT IF EXISTS revisoes_trimestrais_registrada_por_fk;
ALTER TABLE revisoes_trimestrais DROP CONSTRAINT IF EXISTS revisoes_trimestrais_estudante_fk;
ALTER TABLE repertorios DROP CONSTRAINT IF EXISTS repertorios_perfil_fk;
ALTER TABLE ciclos DROP CONSTRAINT IF EXISTS ciclos_estudante_perfil_fk;

ALTER TABLE revisoes_trimestrais DROP COLUMN IF EXISTS registrada_por_perfil_id;
ALTER TABLE revisoes_trimestrais DROP COLUMN IF EXISTS estudante_perfil_id;
ALTER TABLE repertorios DROP COLUMN IF EXISTS perfil_id;
ALTER TABLE ciclos DROP COLUMN IF EXISTS estudante_perfil_id;

DROP TABLE IF EXISTS responsavel_estudante;

COMMIT;
