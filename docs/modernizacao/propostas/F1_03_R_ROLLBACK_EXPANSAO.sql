-- MEDICINA 2029 — F1.03-R
-- ROLLBACK FISICO DA EXPANSAO, SOMENTE PARA ENSAIO ISOLADO OU INCIDENTE
-- especificamente aprovado. A reversao remove metadados de ownership; por
-- isso, fora de teste, exige backup validado e avaliacao de perda semantica.
-- ATENCAO AO JOURNAL: este script nao remove e nao deve remover automaticamente
-- a entrada 0003 de drizzle.__drizzle_migrations. Depois deste rollback, uma
-- nova execucao do migrator considera a 0003 ja aplicada e nao recria os
-- objetos. A recuperacao exige procedimento controlado e aprovado: restaurar
-- backup consistente ou publicar uma nova migration forward-only. Nunca apague
-- o journal como atalho operacional.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE topicos DROP CONSTRAINT IF EXISTS topicos_pre_requisito_topico_id_topicos_id_fk;
ALTER TABLE tentativas DROP CONSTRAINT IF EXISTS tentativas_simulado_id_simulados_id_fk;
ALTER TABLE revisoes_trimestrais DROP CONSTRAINT IF EXISTS revisoes_trimestrais_registrada_por_perfil_id_perfis_id_fk;
ALTER TABLE revisoes_trimestrais DROP CONSTRAINT IF EXISTS revisoes_trimestrais_estudante_perfil_id_perfis_id_fk;
ALTER TABLE repertorios DROP CONSTRAINT IF EXISTS repertorios_perfil_id_perfis_id_fk;
ALTER TABLE redacoes DROP CONSTRAINT IF EXISTS redacoes_reescrita_de_id_redacoes_id_fk;
ALTER TABLE questoes DROP CONSTRAINT IF EXISTS questoes_arquivo_origem_id_acervo_arquivos_id_fk;
ALTER TABLE ciclos DROP CONSTRAINT IF EXISTS ciclos_estudante_perfil_id_perfis_id_fk;

ALTER TABLE revisoes_trimestrais DROP COLUMN IF EXISTS registrada_por_perfil_id;
ALTER TABLE revisoes_trimestrais DROP COLUMN IF EXISTS estudante_perfil_id;
ALTER TABLE repertorios DROP COLUMN IF EXISTS perfil_id;
ALTER TABLE ciclos DROP COLUMN IF EXISTS estudante_perfil_id;

DROP TABLE IF EXISTS responsavel_estudante;

COMMIT;
