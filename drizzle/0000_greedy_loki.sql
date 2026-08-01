CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."area_enum" AS ENUM('linguagens', 'humanas', 'natureza', 'matematica', 'redacao');--> statement-breakpoint
CREATE TYPE "public"."cobertura_material_enum" AS ENUM('sem_fonte', 'parcial', 'coberto');--> statement-breakpoint
CREATE TYPE "public"."confianca_tentativa_enum" AS ENUM('certeza', 'duvida', 'chute');--> statement-breakpoint
CREATE TYPE "public"."decisao_curadoria_enum" AS ENUM('pendente', 'aprovado', 'rejeitado', 'editado_e_aprovado');--> statement-breakpoint
CREATE TYPE "public"."estilo_alvo_enum" AS ENUM('enem', 'conteudista', 'misto');--> statement-breakpoint
CREATE TYPE "public"."etapa_atingida_enum" AS ENUM('revisao', 'conteudo', 'questoes', 'registro');--> statement-breakpoint
CREATE TYPE "public"."formato_redacao_enum" AS ENUM('enem', 'genero_uece');--> statement-breakpoint
CREATE TYPE "public"."formato_simulado_enum" AS ENUM('enem', 'uece_1fase', 'uece_2fase', 'privada');--> statement-breakpoint
CREATE TYPE "public"."metodo_extracao_enum" AS ENUM('nativo', 'ocr', 'visao');--> statement-breakpoint
CREATE TYPE "public"."origem_material_enum" AS ENUM('manual', 'gerado');--> statement-breakpoint
CREATE TYPE "public"."papel_enum" AS ENUM('estudante', 'responsavel');--> statement-breakpoint
CREATE TYPE "public"."procedencia_questao_enum" AS ENUM('oficial', 'extraida', 'gerada');--> statement-breakpoint
CREATE TYPE "public"."status_material_enum" AS ENUM('rascunho', 'em_revisao', 'aprovado', 'rejeitado', 'desatualizado');--> statement-breakpoint
CREATE TYPE "public"."status_processamento_enum" AS ENUM('aguardando', 'extraindo', 'segmentando', 'classificando', 'indexando', 'concluido', 'falhou');--> statement-breakpoint
CREATE TYPE "public"."status_questao_enum" AS ENUM('rascunho', 'em_revisao', 'aprovado', 'rejeitado');--> statement-breakpoint
CREATE TYPE "public"."tipo_acervo_material_enum" AS ENUM('livro', 'apostila', 'slide', 'lista_exercicios', 'anotacao_aula', 'prova_oficial', 'resumo_proprio', 'outro');--> statement-breakpoint
CREATE TYPE "public"."tipo_bloco_enum" AS ENUM('conteudo', 'questoes', 'redacao', 'caderno_erros', 'revisao_srs', 'lingua_estrangeira');--> statement-breakpoint
CREATE TYPE "public"."tipo_conteudo_chunk_enum" AS ENUM('exposicao_teorica', 'exemplo_resolvido', 'questao', 'exercicio', 'definicao', 'formula', 'figura_legenda');--> statement-breakpoint
CREATE TYPE "public"."tipo_erro_enum" AS ENUM('conteudo', 'interpretacao', 'distracao', 'calculo', 'tempo');--> statement-breakpoint
CREATE TYPE "public"."tipo_material_enum" AS ENUM('resumo', 'formulario', 'mapa_mental', 'esquema');--> statement-breakpoint
CREATE TABLE "acervo_arquivos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"disciplina_id" uuid NOT NULL,
	"titulo" varchar(255) NOT NULL,
	"tipo_material" "tipo_acervo_material_enum" NOT NULL,
	"autor_fonte" varchar(255),
	"serie_alvo" integer NOT NULL,
	"file_path" varchar(1000) NOT NULL,
	"mime" varchar(100) NOT NULL,
	"tamanho_bytes" integer NOT NULL,
	"paginas" integer,
	"enviado_por" uuid NOT NULL,
	"enviado_em" timestamp DEFAULT now() NOT NULL,
	"status_processamento" "status_processamento_enum" DEFAULT 'aguardando' NOT NULL,
	"erro_processamento" text,
	"hash_conteudo" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acervo_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arquivo_id" uuid NOT NULL,
	"pagina_inicial" integer NOT NULL,
	"pagina_final" integer NOT NULL,
	"ordem" integer NOT NULL,
	"texto" text NOT NULL,
	"tipo_conteudo" "tipo_conteudo_chunk_enum" NOT NULL,
	"topico_id" uuid,
	"confianca_classificacao" double precision,
	"embedding" vector(1536),
	"tokens" integer
);
--> statement-breakpoint
CREATE TABLE "acervo_figuras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arquivo_id" uuid NOT NULL,
	"pagina" integer NOT NULL,
	"bbox" jsonb NOT NULL,
	"imagem_path" varchar(1000) NOT NULL,
	"legenda" text,
	"chunk_id" uuid
);
--> statement-breakpoint
CREATE TABLE "acervo_paginas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arquivo_id" uuid NOT NULL,
	"numero" integer NOT NULL,
	"texto_extraido" text,
	"metodo_extracao" "metodo_extracao_enum",
	"confianca_ocr" double precision,
	"imagem_path" varchar(1000)
);
--> statement-breakpoint
CREATE TABLE "card_revisoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"revisado_em" timestamp NOT NULL,
	"rating" varchar(50) NOT NULL,
	"state_anterior" varchar(50) NOT NULL,
	"stability_anterior" double precision NOT NULL,
	"duracao_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"perfil_id" uuid NOT NULL,
	"topico_id" uuid NOT NULL,
	"frente" text NOT NULL,
	"verso" text NOT NULL,
	"origem" varchar(50) NOT NULL,
	"status" "status_material_enum" DEFAULT 'aprovado' NOT NULL,
	"suspenso" boolean DEFAULT false NOT NULL,
	"fonte_chunk_ids" jsonb,
	"due" timestamp NOT NULL,
	"stability" double precision NOT NULL,
	"difficulty" double precision NOT NULL,
	"elapsed_days" integer NOT NULL,
	"scheduled_days" integer NOT NULL,
	"reps" integer NOT NULL,
	"lapses" integer NOT NULL,
	"state" varchar(50) NOT NULL,
	"last_review" timestamp
);
--> statement-breakpoint
CREATE TABLE "checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"perfil_id" uuid NOT NULL,
	"data" timestamp NOT NULL,
	"horas_sono" double precision NOT NULL,
	"exercicio_min" integer NOT NULL,
	"humor" integer NOT NULL,
	"energia" integer NOT NULL,
	"nota_livre" text
);
--> statement-breakpoint
CREATE TABLE "ciclo_blocos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ciclo_id" uuid NOT NULL,
	"ordem" integer NOT NULL,
	"disciplina_id" uuid NOT NULL,
	"tipo" "tipo_bloco_enum" NOT NULL,
	"estilo_alvo" "estilo_alvo_enum" NOT NULL,
	"duracao_min" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ciclo_estado" (
	"ciclo_id" uuid PRIMARY KEY NOT NULL,
	"proxima_ordem" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ciclos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" varchar(255) NOT NULL,
	"ano_letivo" integer NOT NULL,
	"ativo" boolean DEFAULT false NOT NULL,
	"blocos_previstos_semana" integer NOT NULL,
	"criado_em" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curadoria_fila" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artefato_tipo" varchar(100) NOT NULL,
	"artefato_id" uuid NOT NULL,
	"topico_id" uuid NOT NULL,
	"prioridade" integer DEFAULT 0 NOT NULL,
	"criado_em" timestamp DEFAULT now() NOT NULL,
	"revisado_em" timestamp,
	"decisao" "decisao_curadoria_enum" DEFAULT 'pendente' NOT NULL,
	"motivo_rejeicao" text,
	"editado" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disciplinas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" varchar(255) NOT NULL,
	"area" "area_enum" NOT NULL,
	"cor_hex" varchar(7) NOT NULL,
	"ordem" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"perfil_id" uuid NOT NULL,
	"questao_id" uuid NOT NULL,
	"tentativa_id" uuid NOT NULL,
	"descricao_livre" text,
	"disciplina_id" uuid NOT NULL,
	"topico_id" uuid NOT NULL,
	"estilo" "estilo_alvo_enum" NOT NULL,
	"tipo_erro" "tipo_erro_enum" NOT NULL,
	"conceito_correto" text,
	"criado_em" timestamp DEFAULT now() NOT NULL,
	"resolvido_em" timestamp,
	"vezes_revisado" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" varchar(100) NOT NULL,
	"finalidade" text NOT NULL,
	"interlocutor" varchar(255) NOT NULL,
	"estrutura" text NOT NULL,
	"marcas_linguagem" text NOT NULL,
	"erro_que_descaracteriza" text NOT NULL,
	"ficha_completa" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geracoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tipo_artefato" varchar(100) NOT NULL,
	"topico_id" uuid NOT NULL,
	"arquivo_ids" jsonb NOT NULL,
	"chunk_ids" jsonb NOT NULL,
	"modelo" varchar(100) NOT NULL,
	"prompt_versao" varchar(50) NOT NULL,
	"custo_tokens" integer NOT NULL,
	"iniciada_em" timestamp NOT NULL,
	"concluida_em" timestamp,
	"status" varchar(50) NOT NULL,
	"itens_gerados" integer DEFAULT 0 NOT NULL,
	"itens_aprovados" integer DEFAULT 0 NOT NULL,
	"itens_rejeitados" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "livros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"perfil_id" uuid NOT NULL,
	"titulo" varchar(255) NOT NULL,
	"autor" varchar(255) NOT NULL,
	"ano_plano" integer NOT NULL,
	"iniciado_em" timestamp,
	"concluido_em" timestamp,
	"notas" text
);
--> statement-breakpoint
CREATE TABLE "materiais" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topico_id" uuid NOT NULL,
	"titulo" varchar(255) NOT NULL,
	"corpo" text NOT NULL,
	"tipo" "tipo_material_enum" NOT NULL,
	"tempo_leitura_min" integer NOT NULL,
	"status" "status_material_enum" DEFAULT 'rascunho' NOT NULL,
	"origem" "origem_material_enum" NOT NULL,
	"fonte_chunk_ids" jsonb,
	"gerado_em" timestamp DEFAULT now() NOT NULL,
	"aprovado_por" uuid,
	"aprovado_em" timestamp,
	"versao" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "perfis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" uuid NOT NULL,
	"nome" varchar(255) NOT NULL,
	"papel" "papel_enum" NOT NULL,
	"criado_em" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "perfis_auth_user_id_unique" UNIQUE("auth_user_id")
);
--> statement-breakpoint
CREATE TABLE "perguntas_ativas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topico_id" uuid NOT NULL,
	"pergunta" text NOT NULL,
	"resposta" text NOT NULL,
	"estilo" "estilo_alvo_enum" NOT NULL,
	"status" "status_material_enum" DEFAULT 'rascunho' NOT NULL,
	"fonte_chunk_ids" jsonb
);
--> statement-breakpoint
CREATE TABLE "questao_topicos" (
	"questao_id" uuid NOT NULL,
	"topico_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procedencia" "procedencia_questao_enum" NOT NULL,
	"fonte" varchar(100) NOT NULL,
	"ano" integer,
	"fase" varchar(50),
	"numero" integer,
	"disciplina_id" uuid NOT NULL,
	"estilo" "estilo_alvo_enum" NOT NULL,
	"dificuldade" varchar(50),
	"enunciado" text NOT NULL,
	"alternativas" jsonb NOT NULL,
	"gabarito" varchar(10) NOT NULL,
	"resolucao" text,
	"imagem_url" varchar(1000),
	"status" "status_questao_enum" DEFAULT 'rascunho' NOT NULL,
	"arquivo_origem_id" uuid,
	"fonte_chunk_ids" jsonb,
	"confianca_geracao" double precision,
	"ativa" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"perfil_id" uuid NOT NULL,
	"formato" "formato_redacao_enum" NOT NULL,
	"genero_id" uuid,
	"tema" varchar(500) NOT NULL,
	"escrita_em" timestamp NOT NULL,
	"texto" text,
	"arquivo_url" varchar(1000),
	"minutos_gastos" integer NOT NULL,
	"nota_total" integer,
	"competencias" jsonb,
	"corrigida_por" varchar(255),
	"reescrita_de_id" uuid,
	"observacoes" text
);
--> statement-breakpoint
CREATE TABLE "repertorios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referencia" text NOT NULL,
	"resumo_2_linhas" text NOT NULL,
	"temas_aplicaveis" jsonb NOT NULL,
	"categoria" varchar(100) NOT NULL,
	"criado_em" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revisoes_trimestrais" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trimestre" integer NOT NULL,
	"ano" integer NOT NULL,
	"aderencia_pct" double precision NOT NULL,
	"cards_atrasados" integer NOT NULL,
	"media_enem" double precision,
	"acerto_uece_pct" double precision,
	"divergencia_trilhos" double precision,
	"tipo_erro_predominante" "tipo_erro_enum",
	"redacoes_escritas" integer NOT NULL,
	"redacoes_reescritas" integer NOT NULL,
	"media_sono" double precision NOT NULL,
	"conversa" text NOT NULL,
	"decisoes" text NOT NULL,
	"fechada_em" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"perfil_id" uuid NOT NULL,
	"ciclo_bloco_id" uuid NOT NULL,
	"topico_id" uuid NOT NULL,
	"iniciada_em" timestamp NOT NULL,
	"encerrada_em" timestamp,
	"segundos_efetivos" integer DEFAULT 0 NOT NULL,
	"segundos_pausa" integer DEFAULT 0 NOT NULL,
	"etapa_atingida" "etapa_atingida_enum" NOT NULL,
	"concluida" boolean DEFAULT false NOT NULL,
	"nota_livre" text
);
--> statement-breakpoint
CREATE TABLE "simulado_analise" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulado_id" uuid NOT NULL,
	"concluida" boolean DEFAULT false NOT NULL,
	"tres_assuntos_fracos" jsonb NOT NULL,
	"erros_estrategia" text,
	"minutos_analise" integer NOT NULL,
	"realizada_em" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simulado_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"simulado_id" uuid NOT NULL,
	"area" varchar(100) NOT NULL,
	"acertos" integer NOT NULL,
	"total" integer NOT NULL,
	"nota_estimated" integer
);
--> statement-breakpoint
CREATE TABLE "simulado_questoes" (
	"simulado_id" uuid NOT NULL,
	"questao_id" uuid NOT NULL,
	"ordem" integer NOT NULL,
	"area" varchar(100) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simulados" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"perfil_id" uuid NOT NULL,
	"formato" "formato_simulado_enum" NOT NULL,
	"data" timestamp NOT NULL,
	"condicoes_reais" boolean NOT NULL,
	"duracao_min" integer NOT NULL,
	"local" varchar(255) NOT NULL,
	"composicao_procedencia" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tentativas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"perfil_id" uuid NOT NULL,
	"questao_id" uuid NOT NULL,
	"sessao_id" uuid,
	"simulado_id" uuid,
	"alternativa_marcada" varchar(10) NOT NULL,
	"correta" boolean NOT NULL,
	"segundos" integer NOT NULL,
	"confianca" "confianca_tentativa_enum" NOT NULL,
	"criado_em" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topicos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"disciplina_id" uuid NOT NULL,
	"nome" varchar(255) NOT NULL,
	"serie_prevista" integer NOT NULL,
	"incidencia_enem" integer NOT NULL,
	"incidencia_uece" integer NOT NULL,
	"pre_requisito_topico_id" uuid,
	"ordem" integer NOT NULL,
	"cobertura_material" "cobertura_material_enum" DEFAULT 'sem_fonte' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acervo_arquivos" ADD CONSTRAINT "acervo_arquivos_disciplina_id_disciplinas_id_fk" FOREIGN KEY ("disciplina_id") REFERENCES "public"."disciplinas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acervo_arquivos" ADD CONSTRAINT "acervo_arquivos_enviado_por_perfis_id_fk" FOREIGN KEY ("enviado_por") REFERENCES "public"."perfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acervo_chunks" ADD CONSTRAINT "acervo_chunks_arquivo_id_acervo_arquivos_id_fk" FOREIGN KEY ("arquivo_id") REFERENCES "public"."acervo_arquivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acervo_chunks" ADD CONSTRAINT "acervo_chunks_topico_id_topicos_id_fk" FOREIGN KEY ("topico_id") REFERENCES "public"."topicos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acervo_figuras" ADD CONSTRAINT "acervo_figuras_arquivo_id_acervo_arquivos_id_fk" FOREIGN KEY ("arquivo_id") REFERENCES "public"."acervo_arquivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acervo_figuras" ADD CONSTRAINT "acervo_figuras_chunk_id_acervo_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."acervo_chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acervo_paginas" ADD CONSTRAINT "acervo_paginas_arquivo_id_acervo_arquivos_id_fk" FOREIGN KEY ("arquivo_id") REFERENCES "public"."acervo_arquivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_revisoes" ADD CONSTRAINT "card_revisoes_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_topico_id_topicos_id_fk" FOREIGN KEY ("topico_id") REFERENCES "public"."topicos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ciclo_blocos" ADD CONSTRAINT "ciclo_blocos_ciclo_id_ciclos_id_fk" FOREIGN KEY ("ciclo_id") REFERENCES "public"."ciclos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ciclo_blocos" ADD CONSTRAINT "ciclo_blocos_disciplina_id_disciplinas_id_fk" FOREIGN KEY ("disciplina_id") REFERENCES "public"."disciplinas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ciclo_estado" ADD CONSTRAINT "ciclo_estado_ciclo_id_ciclos_id_fk" FOREIGN KEY ("ciclo_id") REFERENCES "public"."ciclos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curadoria_fila" ADD CONSTRAINT "curadoria_fila_topico_id_topicos_id_fk" FOREIGN KEY ("topico_id") REFERENCES "public"."topicos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erros" ADD CONSTRAINT "erros_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erros" ADD CONSTRAINT "erros_questao_id_questoes_id_fk" FOREIGN KEY ("questao_id") REFERENCES "public"."questoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erros" ADD CONSTRAINT "erros_tentativa_id_tentativas_id_fk" FOREIGN KEY ("tentativa_id") REFERENCES "public"."tentativas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erros" ADD CONSTRAINT "erros_disciplina_id_disciplinas_id_fk" FOREIGN KEY ("disciplina_id") REFERENCES "public"."disciplinas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erros" ADD CONSTRAINT "erros_topico_id_topicos_id_fk" FOREIGN KEY ("topico_id") REFERENCES "public"."topicos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geracoes" ADD CONSTRAINT "geracoes_topico_id_topicos_id_fk" FOREIGN KEY ("topico_id") REFERENCES "public"."topicos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "livros" ADD CONSTRAINT "livros_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materiais" ADD CONSTRAINT "materiais_topico_id_topicos_id_fk" FOREIGN KEY ("topico_id") REFERENCES "public"."topicos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materiais" ADD CONSTRAINT "materiais_aprovado_por_perfis_id_fk" FOREIGN KEY ("aprovado_por") REFERENCES "public"."perfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "perguntas_ativas" ADD CONSTRAINT "perguntas_ativas_topico_id_topicos_id_fk" FOREIGN KEY ("topico_id") REFERENCES "public"."topicos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questao_topicos" ADD CONSTRAINT "questao_topicos_questao_id_questoes_id_fk" FOREIGN KEY ("questao_id") REFERENCES "public"."questoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questao_topicos" ADD CONSTRAINT "questao_topicos_topico_id_topicos_id_fk" FOREIGN KEY ("topico_id") REFERENCES "public"."topicos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questoes" ADD CONSTRAINT "questoes_disciplina_id_disciplinas_id_fk" FOREIGN KEY ("disciplina_id") REFERENCES "public"."disciplinas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redacoes" ADD CONSTRAINT "redacoes_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redacoes" ADD CONSTRAINT "redacoes_genero_id_generos_id_fk" FOREIGN KEY ("genero_id") REFERENCES "public"."generos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes" ADD CONSTRAINT "sessoes_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes" ADD CONSTRAINT "sessoes_ciclo_bloco_id_ciclo_blocos_id_fk" FOREIGN KEY ("ciclo_bloco_id") REFERENCES "public"."ciclo_blocos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes" ADD CONSTRAINT "sessoes_topico_id_topicos_id_fk" FOREIGN KEY ("topico_id") REFERENCES "public"."topicos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulado_analise" ADD CONSTRAINT "simulado_analise_simulado_id_simulados_id_fk" FOREIGN KEY ("simulado_id") REFERENCES "public"."simulados"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulado_areas" ADD CONSTRAINT "simulado_areas_simulado_id_simulados_id_fk" FOREIGN KEY ("simulado_id") REFERENCES "public"."simulados"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulado_questoes" ADD CONSTRAINT "simulado_questoes_simulado_id_simulados_id_fk" FOREIGN KEY ("simulado_id") REFERENCES "public"."simulados"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulado_questoes" ADD CONSTRAINT "simulado_questoes_questao_id_questoes_id_fk" FOREIGN KEY ("questao_id") REFERENCES "public"."questoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulados" ADD CONSTRAINT "simulados_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tentativas" ADD CONSTRAINT "tentativas_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tentativas" ADD CONSTRAINT "tentativas_questao_id_questoes_id_fk" FOREIGN KEY ("questao_id") REFERENCES "public"."questoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tentativas" ADD CONSTRAINT "tentativas_sessao_id_sessoes_id_fk" FOREIGN KEY ("sessao_id") REFERENCES "public"."sessoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topicos" ADD CONSTRAINT "topicos_disciplina_id_disciplinas_id_fk" FOREIGN KEY ("disciplina_id") REFERENCES "public"."disciplinas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.allowlist (
  email text PRIMARY KEY
);--> statement-breakpoint

INSERT INTO public.allowlist (email) VALUES 
('estudante@medicina2029.com.br'),
('responsavel@medicina2029.com.br')
ON CONFLICT DO NOTHING;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.check_allowlist()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.allowlist WHERE email = NEW.email
  ) THEN
    RAISE EXCEPTION 'Apenas e-mails na allowlist são permitidos.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;--> statement-breakpoint

CREATE OR REPLACE TRIGGER tr_check_allowlist
BEFORE INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.check_allowlist();