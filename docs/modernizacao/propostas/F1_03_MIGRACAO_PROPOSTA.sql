-- MEDICINA 2029 — F1.03
-- PROPOSTA DE MIGRACAO. NAO pertence ao journal Drizzle e NAO deve ser aplicada
-- antes de auditoria read-only, backup validado, revisao humana e teste em banco
-- descartavel dedicado.
--
-- Objetivos:
--   * vinculo explicito 1:1 entre o unico responsavel e a unica estudante;
--   * ownership de ciclos, repertorios e revisoes trimestrais;
--   * FKs ausentes e constraints de unicidade prioritarias;
--   * nenhum ID existente e alterado.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- FASE 0 — abortar diante de cardinalidade ou dados ambiguos.
DO $$
BEGIN
  IF (SELECT count(*) FROM perfis WHERE papel = 'estudante') <> 1 THEN
    RAISE EXCEPTION 'F1.03 abortada: esperado exatamente um perfil estudante.';
  END IF;

  IF (SELECT count(*) FROM perfis WHERE papel = 'responsavel') <> 1 THEN
    RAISE EXCEPTION 'F1.03 abortada: esperado exatamente um perfil responsavel.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM perfis interno
    JOIN perfis externo ON externo.auth_user_id = interno.id
    WHERE externo.id <> interno.id
  ) THEN
    RAISE EXCEPTION 'F1.03 abortada: colisao cruzada entre id e auth_user_id.';
  END IF;

  IF EXISTS (SELECT 1 FROM ciclo_blocos GROUP BY ciclo_id, ordem HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM questao_topicos GROUP BY questao_id, topico_id HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM simulado_questoes GROUP BY simulado_id, questao_id HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM simulado_questoes GROUP BY simulado_id, ordem HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM simulado_areas GROUP BY simulado_id, area HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM simulado_analise GROUP BY simulado_id HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM acervo_paginas GROUP BY arquivo_id, numero HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM acervo_chunks GROUP BY arquivo_id, ordem HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM revisoes_trimestrais GROUP BY ano, trimestre HAVING count(*) > 1)
  THEN
    RAISE EXCEPTION 'F1.03 abortada: existem duplicidades que impedem constraints.';
  END IF;
END
$$;

-- FASE A — expansao aditiva.
CREATE TABLE responsavel_estudante (
  vinculo_id smallint PRIMARY KEY DEFAULT 1,
  responsavel_perfil_id uuid NOT NULL UNIQUE,
  estudante_perfil_id uuid NOT NULL UNIQUE,
  criado_em timestamp DEFAULT now() NOT NULL,
  CONSTRAINT responsavel_estudante_singleton_check CHECK (vinculo_id = 1),
  CONSTRAINT responsavel_estudante_ids_distintos_check
    CHECK (responsavel_perfil_id <> estudante_perfil_id),
  CONSTRAINT responsavel_estudante_responsavel_fk
    FOREIGN KEY (responsavel_perfil_id) REFERENCES perfis(id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT responsavel_estudante_estudante_fk
    FOREIGN KEY (estudante_perfil_id) REFERENCES perfis(id) ON DELETE RESTRICT NOT VALID
);

INSERT INTO responsavel_estudante (responsavel_perfil_id, estudante_perfil_id)
SELECT responsavel.id, estudante.id
FROM perfis responsavel
CROSS JOIN perfis estudante
WHERE responsavel.papel = 'responsavel'
  AND estudante.papel = 'estudante';

ALTER TABLE ciclos ADD COLUMN estudante_perfil_id uuid;
ALTER TABLE repertorios ADD COLUMN perfil_id uuid;
ALTER TABLE revisoes_trimestrais ADD COLUMN estudante_perfil_id uuid;
ALTER TABLE revisoes_trimestrais ADD COLUMN registrada_por_perfil_id uuid;

ALTER TABLE ciclos ADD CONSTRAINT ciclos_estudante_perfil_fk
  FOREIGN KEY (estudante_perfil_id) REFERENCES perfis(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE repertorios ADD CONSTRAINT repertorios_perfil_fk
  FOREIGN KEY (perfil_id) REFERENCES perfis(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE revisoes_trimestrais ADD CONSTRAINT revisoes_trimestrais_estudante_fk
  FOREIGN KEY (estudante_perfil_id) REFERENCES perfis(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE revisoes_trimestrais ADD CONSTRAINT revisoes_trimestrais_registrada_por_fk
  FOREIGN KEY (registrada_por_perfil_id) REFERENCES perfis(id) ON DELETE RESTRICT NOT VALID;

-- Backfill deterministico: a FASE 0 garante uma unica linha por papel.
UPDATE ciclos
SET estudante_perfil_id = (SELECT id FROM perfis WHERE papel = 'estudante')
WHERE estudante_perfil_id IS NULL;

UPDATE repertorios
SET perfil_id = (SELECT id FROM perfis WHERE papel = 'estudante')
WHERE perfil_id IS NULL;

UPDATE revisoes_trimestrais
SET
  estudante_perfil_id = (SELECT id FROM perfis WHERE papel = 'estudante'),
  registrada_por_perfil_id = (SELECT id FROM perfis WHERE papel = 'responsavel')
WHERE estudante_perfil_id IS NULL OR registrada_por_perfil_id IS NULL;

-- FKs relacionais hoje ausentes.
ALTER TABLE topicos ADD CONSTRAINT topicos_pre_requisito_fk
  FOREIGN KEY (pre_requisito_topico_id) REFERENCES topicos(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE questoes ADD CONSTRAINT questoes_arquivo_origem_fk
  FOREIGN KEY (arquivo_origem_id) REFERENCES acervo_arquivos(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE tentativas ADD CONSTRAINT tentativas_simulado_fk
  FOREIGN KEY (simulado_id) REFERENCES simulados(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE redacoes ADD CONSTRAINT redacoes_reescrita_de_fk
  FOREIGN KEY (reescrita_de_id) REFERENCES redacoes(id) ON DELETE SET NULL NOT VALID;

-- FASE B — validar antes de contrair.
ALTER TABLE responsavel_estudante VALIDATE CONSTRAINT responsavel_estudante_responsavel_fk;
ALTER TABLE responsavel_estudante VALIDATE CONSTRAINT responsavel_estudante_estudante_fk;
ALTER TABLE ciclos VALIDATE CONSTRAINT ciclos_estudante_perfil_fk;
ALTER TABLE repertorios VALIDATE CONSTRAINT repertorios_perfil_fk;
ALTER TABLE revisoes_trimestrais VALIDATE CONSTRAINT revisoes_trimestrais_estudante_fk;
ALTER TABLE revisoes_trimestrais VALIDATE CONSTRAINT revisoes_trimestrais_registrada_por_fk;
ALTER TABLE topicos VALIDATE CONSTRAINT topicos_pre_requisito_fk;
ALTER TABLE questoes VALIDATE CONSTRAINT questoes_arquivo_origem_fk;
ALTER TABLE tentativas VALIDATE CONSTRAINT tentativas_simulado_fk;
ALTER TABLE redacoes VALIDATE CONSTRAINT redacoes_reescrita_de_fk;

ALTER TABLE ciclos ALTER COLUMN estudante_perfil_id SET NOT NULL;
ALTER TABLE repertorios ALTER COLUMN perfil_id SET NOT NULL;
ALTER TABLE revisoes_trimestrais ALTER COLUMN estudante_perfil_id SET NOT NULL;
ALTER TABLE revisoes_trimestrais ALTER COLUMN registrada_por_perfil_id SET NOT NULL;

-- Unicidades coerentes com o modelo atual.
ALTER TABLE ciclo_blocos ADD CONSTRAINT ciclo_blocos_ciclo_ordem_unique UNIQUE (ciclo_id, ordem);
ALTER TABLE questao_topicos ADD CONSTRAINT questao_topicos_pk PRIMARY KEY (questao_id, topico_id);
ALTER TABLE simulado_questoes ADD CONSTRAINT simulado_questoes_pk PRIMARY KEY (simulado_id, questao_id);
ALTER TABLE simulado_questoes ADD CONSTRAINT simulado_questoes_simulado_ordem_unique UNIQUE (simulado_id, ordem);
ALTER TABLE simulado_areas ADD CONSTRAINT simulado_areas_simulado_area_unique UNIQUE (simulado_id, area);
ALTER TABLE simulado_analise ADD CONSTRAINT simulado_analise_simulado_unique UNIQUE (simulado_id);
ALTER TABLE acervo_paginas ADD CONSTRAINT acervo_paginas_arquivo_numero_unique UNIQUE (arquivo_id, numero);
ALTER TABLE acervo_chunks ADD CONSTRAINT acervo_chunks_arquivo_ordem_unique UNIQUE (arquivo_id, ordem);
ALTER TABLE revisoes_trimestrais ADD CONSTRAINT revisoes_trimestrais_periodo_unique
  UNIQUE (estudante_perfil_id, ano, trimestre);

CREATE UNIQUE INDEX ciclos_um_ativo_por_estudante_idx
  ON ciclos (estudante_perfil_id)
  WHERE ativo;

COMMIT;

-- ROLLBACK OPERACIONAL RECOMENDADO
-- 1. Reverter primeiro a aplicacao para a versao que nao depende das colunas novas.
-- 2. Manter tabela/colunas aditivas sem uso enquanto se valida que nenhuma escrita nova
--    depende delas; este e o rollback preferencial e nao perde informacao.
-- 3. Somente com export e aprovacao explicita, remover fisicamente na ordem inversa:
--    indices/uniques, FKs novas, colunas de ownership e responsavel_estudante.
-- 4. Nunca alterar perfis.id ou auth_user_id no rollback.
