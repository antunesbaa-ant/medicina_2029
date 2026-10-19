-- MEDICINA 2029 — F1.03-R
-- EXPANSAO ADITIVA. Esta migration mantem os novos owners nullable para que a
-- versao anterior da aplicacao continue apta a escrever durante a transicao.
-- A contracao fica deliberadamente fora do journal automatico.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint

-- Preflight: aceita uma base realmente vazia (0 estudante + 0 responsavel) ou
-- exatamente o par previsto. Estados parciais, ambiguos ou semanticamente
-- inconsistentes abortam antes de qualquer DDL.
DO $$
DECLARE
  estudantes integer := (SELECT count(*) FROM perfis WHERE papel = 'estudante');
  responsaveis integer := (SELECT count(*) FROM perfis WHERE papel = 'responsavel');
BEGIN
  IF NOT (
    (estudantes = 0 AND responsaveis = 0)
    OR (estudantes = 1 AND responsaveis = 1)
  ) THEN
    RAISE EXCEPTION
      'F1.03-R abortada: esperado banco vazio ou exatamente um estudante e um responsavel.';
  END IF;

  IF estudantes = 0 AND responsaveis = 0 AND (
    EXISTS (SELECT 1 FROM ciclos)
    OR EXISTS (SELECT 1 FROM repertorios)
    OR EXISTS (SELECT 1 FROM revisoes_trimestrais)
  ) THEN
    RAISE EXCEPTION
      'F1.03-R abortada: dados sem par de perfis impedem backfill deterministico.';
  END IF;

  -- id = auth_user_id na propria linha nao e, isoladamente, invalido. A
  -- colisao abaixo envolve dois perfis distintos e torna a identidade ambigua.
  IF EXISTS (
    SELECT 1
    FROM perfis interno
    JOIN perfis externo ON externo.auth_user_id = interno.id
    WHERE externo.id <> interno.id
  ) THEN
    RAISE EXCEPTION
      'F1.03-R abortada: colisao cruzada entre id e auth_user_id de perfis distintos.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT perfil_id FROM sessoes
      UNION ALL SELECT perfil_id FROM cards
      UNION ALL SELECT perfil_id FROM tentativas
      UNION ALL SELECT perfil_id FROM erros
      UNION ALL SELECT perfil_id FROM redacoes
      UNION ALL SELECT perfil_id FROM simulados
      UNION ALL SELECT perfil_id FROM checkins
      UNION ALL SELECT perfil_id FROM livros
    ) dado
    LEFT JOIN perfis p ON p.id = dado.perfil_id
    WHERE p.id IS NULL OR p.papel <> 'estudante'
  ) OR EXISTS (
    SELECT 1
    FROM acervo_arquivos a
    LEFT JOIN perfis p ON p.id = a.enviado_por
    WHERE p.id IS NULL OR p.papel <> 'responsavel'
  ) OR EXISTS (
    SELECT 1
    FROM materiais m
    LEFT JOIN perfis p ON p.id = m.aprovado_por
    WHERE m.aprovado_por IS NOT NULL
      AND (p.id IS NULL OR p.papel <> 'responsavel')
  ) THEN
    RAISE EXCEPTION
      'F1.03-R abortada: ownership existente possui papel incompatível.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM topicos filho
    LEFT JOIN topicos pai ON pai.id = filho.pre_requisito_topico_id
    WHERE filho.pre_requisito_topico_id IS NOT NULL AND pai.id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM questoes q
    LEFT JOIN acervo_arquivos a ON a.id = q.arquivo_origem_id
    WHERE q.arquivo_origem_id IS NOT NULL AND a.id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM tentativas t
    LEFT JOIN simulados s ON s.id = t.simulado_id
    WHERE t.simulado_id IS NOT NULL AND s.id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM redacoes filha
    LEFT JOIN redacoes original ON original.id = filha.reescrita_de_id
    WHERE filha.reescrita_de_id IS NOT NULL AND original.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'F1.03-R abortada: registro orfao impede a criacao das novas FKs.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM tentativas t
    JOIN sessoes s ON s.id = t.sessao_id
    WHERE t.perfil_id <> s.perfil_id
  ) OR EXISTS (
    SELECT 1 FROM tentativas t
    JOIN simulados s ON s.id = t.simulado_id
    WHERE t.perfil_id <> s.perfil_id
  ) OR EXISTS (
    SELECT 1 FROM erros e
    JOIN tentativas t ON t.id = e.tentativa_id
    WHERE e.perfil_id <> t.perfil_id OR e.questao_id <> t.questao_id
  ) OR EXISTS (
    SELECT 1 FROM redacoes filha
    JOIN redacoes original ON original.id = filha.reescrita_de_id
    WHERE filha.perfil_id <> original.perfil_id OR filha.id = original.id
  ) OR EXISTS (
    SELECT 1 FROM sessoes s
    JOIN ciclo_blocos b ON b.id = s.ciclo_bloco_id
    JOIN topicos t ON t.id = s.topico_id
    WHERE b.disciplina_id <> t.disciplina_id
  ) OR EXISTS (
    SELECT 1 FROM acervo_figuras f
    JOIN acervo_chunks c ON c.id = f.chunk_id
    WHERE f.arquivo_id <> c.arquivo_id
  ) OR EXISTS (
    SELECT 1 FROM topicos WHERE id = pre_requisito_topico_id
  ) THEN
    RAISE EXCEPTION
      'F1.03-R abortada: relacao pai-filho ou ownership transitivo inconsistente.';
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
    RAISE EXCEPTION
      'F1.03-R abortada: duplicidades impedem as constraints da contracao.';
  END IF;

  IF (SELECT count(*) FROM ciclos WHERE ativo) > 1 THEN
    RAISE EXCEPTION
      'F1.03-R abortada: mais de um ciclo ativo impede ownership inequivoco.';
  END IF;
END
$$;
--> statement-breakpoint

CREATE TABLE "responsavel_estudante" (
	"vinculo_id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"responsavel_perfil_id" uuid NOT NULL,
	"estudante_perfil_id" uuid NOT NULL,
	"criado_em" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "responsavel_estudante_responsavel_perfil_id_unique" UNIQUE("responsavel_perfil_id"),
	CONSTRAINT "responsavel_estudante_estudante_perfil_id_unique" UNIQUE("estudante_perfil_id"),
	CONSTRAINT "responsavel_estudante_singleton_check" CHECK ("responsavel_estudante"."vinculo_id" = 1),
	CONSTRAINT "responsavel_estudante_ids_distintos_check" CHECK ("responsavel_estudante"."responsavel_perfil_id" <> "responsavel_estudante"."estudante_perfil_id")
);
--> statement-breakpoint

ALTER TABLE "ciclos" ADD COLUMN "estudante_perfil_id" uuid;
--> statement-breakpoint
ALTER TABLE "repertorios" ADD COLUMN "perfil_id" uuid;
--> statement-breakpoint
ALTER TABLE "revisoes_trimestrais" ADD COLUMN "estudante_perfil_id" uuid;
--> statement-breakpoint
ALTER TABLE "revisoes_trimestrais" ADD COLUMN "registrada_por_perfil_id" uuid;
--> statement-breakpoint

INSERT INTO responsavel_estudante (responsavel_perfil_id, estudante_perfil_id)
SELECT responsavel.id, estudante.id
FROM perfis responsavel
CROSS JOIN perfis estudante
WHERE responsavel.papel = 'responsavel'
  AND estudante.papel = 'estudante';
--> statement-breakpoint

-- Com um unico par validado, o backfill e deterministico. Em base vazia as
-- atualizacoes nao alteram linha alguma.
UPDATE ciclos
SET estudante_perfil_id = (SELECT id FROM perfis WHERE papel = 'estudante')
WHERE estudante_perfil_id IS NULL;
--> statement-breakpoint
UPDATE repertorios
SET perfil_id = (SELECT id FROM perfis WHERE papel = 'estudante')
WHERE perfil_id IS NULL;
--> statement-breakpoint
UPDATE revisoes_trimestrais
SET estudante_perfil_id = (SELECT id FROM perfis WHERE papel = 'estudante'),
    registrada_por_perfil_id = (SELECT id FROM perfis WHERE papel = 'responsavel')
WHERE estudante_perfil_id IS NULL OR registrada_por_perfil_id IS NULL;
--> statement-breakpoint

-- As FKs sao criadas NOT VALID para evitar varredura sob o lock de criacao;
-- o preflight ja fornece diagnostico e a validacao ocorre nesta mesma migration.
ALTER TABLE "responsavel_estudante" ADD CONSTRAINT "responsavel_estudante_responsavel_perfil_id_perfis_id_fk" FOREIGN KEY ("responsavel_perfil_id") REFERENCES "public"."perfis"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "responsavel_estudante" ADD CONSTRAINT "responsavel_estudante_estudante_perfil_id_perfis_id_fk" FOREIGN KEY ("estudante_perfil_id") REFERENCES "public"."perfis"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "ciclos" ADD CONSTRAINT "ciclos_estudante_perfil_id_perfis_id_fk" FOREIGN KEY ("estudante_perfil_id") REFERENCES "public"."perfis"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "questoes" ADD CONSTRAINT "questoes_arquivo_origem_id_acervo_arquivos_id_fk" FOREIGN KEY ("arquivo_origem_id") REFERENCES "public"."acervo_arquivos"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "redacoes" ADD CONSTRAINT "redacoes_reescrita_de_id_redacoes_id_fk" FOREIGN KEY ("reescrita_de_id") REFERENCES "public"."redacoes"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "repertorios" ADD CONSTRAINT "repertorios_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "revisoes_trimestrais" ADD CONSTRAINT "revisoes_trimestrais_estudante_perfil_id_perfis_id_fk" FOREIGN KEY ("estudante_perfil_id") REFERENCES "public"."perfis"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "revisoes_trimestrais" ADD CONSTRAINT "revisoes_trimestrais_registrada_por_perfil_id_perfis_id_fk" FOREIGN KEY ("registrada_por_perfil_id") REFERENCES "public"."perfis"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "tentativas" ADD CONSTRAINT "tentativas_simulado_id_simulados_id_fk" FOREIGN KEY ("simulado_id") REFERENCES "public"."simulados"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "topicos" ADD CONSTRAINT "topicos_pre_requisito_topico_id_topicos_id_fk" FOREIGN KEY ("pre_requisito_topico_id") REFERENCES "public"."topicos"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint

ALTER TABLE "responsavel_estudante" VALIDATE CONSTRAINT "responsavel_estudante_responsavel_perfil_id_perfis_id_fk";
--> statement-breakpoint
ALTER TABLE "responsavel_estudante" VALIDATE CONSTRAINT "responsavel_estudante_estudante_perfil_id_perfis_id_fk";
--> statement-breakpoint
ALTER TABLE "ciclos" VALIDATE CONSTRAINT "ciclos_estudante_perfil_id_perfis_id_fk";
--> statement-breakpoint
ALTER TABLE "questoes" VALIDATE CONSTRAINT "questoes_arquivo_origem_id_acervo_arquivos_id_fk";
--> statement-breakpoint
ALTER TABLE "redacoes" VALIDATE CONSTRAINT "redacoes_reescrita_de_id_redacoes_id_fk";
--> statement-breakpoint
ALTER TABLE "repertorios" VALIDATE CONSTRAINT "repertorios_perfil_id_perfis_id_fk";
--> statement-breakpoint
ALTER TABLE "revisoes_trimestrais" VALIDATE CONSTRAINT "revisoes_trimestrais_estudante_perfil_id_perfis_id_fk";
--> statement-breakpoint
ALTER TABLE "revisoes_trimestrais" VALIDATE CONSTRAINT "revisoes_trimestrais_registrada_por_perfil_id_perfis_id_fk";
--> statement-breakpoint
ALTER TABLE "tentativas" VALIDATE CONSTRAINT "tentativas_simulado_id_simulados_id_fk";
--> statement-breakpoint
ALTER TABLE "topicos" VALIDATE CONSTRAINT "topicos_pre_requisito_topico_id_topicos_id_fk";
