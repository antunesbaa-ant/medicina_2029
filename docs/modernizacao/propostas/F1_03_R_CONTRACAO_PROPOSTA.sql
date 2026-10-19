-- MEDICINA 2029 — F1.03-R
-- PROPOSTA DE CONTRACAO. NAO pertence ao journal Drizzle e NAO deve ser
-- executada automaticamente. Exige autorizacao especifica apos:
--   1. aplicacao compativel implantada;
--   2. backfill concluido e auditado;
--   3. zero valores invalidos ou nulos;
--   4. integracao PostgreSQL e pgvector aprovadas;
--   5. backup/restore integral validado;
--   6. rollback ensaiado;
--   7. aprovacao humana especifica.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF (SELECT count(*) FROM perfis WHERE papel = 'estudante') <> 1
    OR (SELECT count(*) FROM perfis WHERE papel = 'responsavel') <> 1
    OR (SELECT count(*) FROM responsavel_estudante) <> 1
  THEN
    RAISE EXCEPTION
      'F1.03-R contracao abortada: cardinalidade de perfis/vinculo invalida.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM responsavel_estudante v
    JOIN perfis responsavel ON responsavel.id = v.responsavel_perfil_id
    JOIN perfis estudante ON estudante.id = v.estudante_perfil_id
    WHERE responsavel.papel <> 'responsavel'
       OR estudante.papel <> 'estudante'
       OR responsavel.id = estudante.id
  ) THEN
    RAISE EXCEPTION
      'F1.03-R contracao abortada: vinculo possui papeis incompatíveis.';
  END IF;

  IF EXISTS (SELECT 1 FROM ciclos WHERE estudante_perfil_id IS NULL)
    OR EXISTS (SELECT 1 FROM repertorios WHERE perfil_id IS NULL)
    OR EXISTS (
      SELECT 1 FROM revisoes_trimestrais
      WHERE estudante_perfil_id IS NULL OR registrada_por_perfil_id IS NULL
    )
  THEN
    RAISE EXCEPTION
      'F1.03-R contracao abortada: backfill de ownership incompleto.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ciclos c
    JOIN perfis p ON p.id = c.estudante_perfil_id
    WHERE p.papel <> 'estudante'
  ) OR EXISTS (
    SELECT 1 FROM repertorios r
    JOIN perfis p ON p.id = r.perfil_id
    WHERE p.papel <> 'estudante'
  ) OR EXISTS (
    SELECT 1 FROM revisoes_trimestrais r
    JOIN perfis estudante ON estudante.id = r.estudante_perfil_id
    JOIN perfis responsavel ON responsavel.id = r.registrada_por_perfil_id
    WHERE estudante.papel <> 'estudante' OR responsavel.papel <> 'responsavel'
  ) THEN
    RAISE EXCEPTION
      'F1.03-R contracao abortada: owner com papel incompatível.';
  END IF;

  IF EXISTS (SELECT 1 FROM ciclo_blocos GROUP BY ciclo_id, ordem HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM questao_topicos GROUP BY questao_id, topico_id HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM simulado_questoes GROUP BY simulado_id, questao_id HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM simulado_questoes GROUP BY simulado_id, ordem HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM simulado_areas GROUP BY simulado_id, area HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM simulado_analise GROUP BY simulado_id HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM acervo_paginas GROUP BY arquivo_id, numero HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM acervo_chunks GROUP BY arquivo_id, ordem HAVING count(*) > 1)
    OR EXISTS (
      SELECT 1 FROM revisoes_trimestrais
      GROUP BY estudante_perfil_id, ano, trimestre HAVING count(*) > 1
    )
  THEN
    RAISE EXCEPTION
      'F1.03-R contracao abortada: duplicidades impedem constraints.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ciclos
    WHERE ativo
    GROUP BY estudante_perfil_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'F1.03-R contracao abortada: mais de um ciclo ativo por estudante.';
  END IF;
END
$$;

ALTER TABLE ciclos ALTER COLUMN estudante_perfil_id SET NOT NULL;
ALTER TABLE repertorios ALTER COLUMN perfil_id SET NOT NULL;
ALTER TABLE revisoes_trimestrais ALTER COLUMN estudante_perfil_id SET NOT NULL;
ALTER TABLE revisoes_trimestrais ALTER COLUMN registrada_por_perfil_id SET NOT NULL;

ALTER TABLE ciclo_blocos ADD CONSTRAINT ciclo_blocos_ciclo_ordem_unique
  UNIQUE (ciclo_id, ordem);
ALTER TABLE questao_topicos ADD CONSTRAINT questao_topicos_pk
  PRIMARY KEY (questao_id, topico_id);
ALTER TABLE simulado_questoes ADD CONSTRAINT simulado_questoes_pk
  PRIMARY KEY (simulado_id, questao_id);
ALTER TABLE simulado_questoes ADD CONSTRAINT simulado_questoes_simulado_ordem_unique
  UNIQUE (simulado_id, ordem);
ALTER TABLE simulado_areas ADD CONSTRAINT simulado_areas_simulado_area_unique
  UNIQUE (simulado_id, area);
ALTER TABLE simulado_analise ADD CONSTRAINT simulado_analise_simulado_unique
  UNIQUE (simulado_id);
ALTER TABLE acervo_paginas ADD CONSTRAINT acervo_paginas_arquivo_numero_unique
  UNIQUE (arquivo_id, numero);
ALTER TABLE acervo_chunks ADD CONSTRAINT acervo_chunks_arquivo_ordem_unique
  UNIQUE (arquivo_id, ordem);
ALTER TABLE revisoes_trimestrais ADD CONSTRAINT revisoes_trimestrais_periodo_unique
  UNIQUE (estudante_perfil_id, ano, trimestre);

CREATE UNIQUE INDEX ciclos_um_ativo_por_estudante_idx
  ON ciclos (estudante_perfil_id)
  WHERE ativo;

COMMIT;

-- Observacao de integridade semantica:
-- PostgreSQL nao aceita subqueries em CHECK. Sem redundar o papel nas tabelas
-- ou introduzir trigger, a imutabilidade dos papeis continua garantida pelo
-- preflight e pela camada server-side. Uma garantia adicional no banco deve ser
-- decidida em tarefa propria, sem trigger improvisado.
