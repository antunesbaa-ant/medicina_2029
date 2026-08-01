import { pgTable, uuid, varchar, text, integer, timestamp, boolean, jsonb, pgEnum, customType, doublePrecision } from 'drizzle-orm/pg-core';

// Custom type for pgvector
const vector = customType<{ data: number[] }>({
  dataType() {
    return 'vector(1536)';
  },
  toDriver(value: number[]): string {
    return JSON.stringify(value);
  },
  fromDriver(value: unknown): number[] {
    if (typeof value === 'string') {
      return value.slice(1, -1).split(',').map(Number);
    }
    return value as number[];
  }
});

// Enums
export const papelEnum = pgEnum('papel_enum', ['estudante', 'responsavel']);
export const areaEnum = pgEnum('area_enum', ['linguagens', 'humanas', 'natureza', 'matematica', 'redacao']);
export const coberturaMaterialEnum = pgEnum('cobertura_material_enum', ['sem_fonte', 'parcial', 'coberto']);
export const tipoBlocoEnum = pgEnum('tipo_bloco_enum', [
  'conteudo',
  'questoes',
  'redacao',
  'caderno_erros',
  'revisao_srs',
  'lingua_estrangeira'
]);
export const estiloAlvoEnum = pgEnum('estilo_alvo_enum', ['enem', 'conteudista', 'misto']);
export const etapaAtingidaEnum = pgEnum('etapa_atingida_enum', ['revisao', 'conteudo', 'questoes', 'registro']);
export const tipoMaterialEnum = pgEnum('tipo_material_enum', ['resumo', 'formulario', 'mapa_mental', 'esquema']);
export const statusMaterialEnum = pgEnum('status_material_enum', ['rascunho', 'em_revisao', 'aprovado', 'rejeitado', 'desatualizado']);
export const origemMaterialEnum = pgEnum('origem_material_enum', ['manual', 'gerado']);
export const procedenciaQuestaoEnum = pgEnum('procedencia_questao_enum', ['oficial', 'extraida', 'gerada']);
export const statusQuestaoEnum = pgEnum('status_questao_enum', ['rascunho', 'em_revisao', 'aprovado', 'rejeitado']);
export const confiancaTentativaEnum = pgEnum('confianca_tentativa_enum', ['certeza', 'duvida', 'chute']);
export const tipoErroEnum = pgEnum('tipo_erro_enum', ['conteudo', 'interpretacao', 'distracao', 'calculo', 'tempo']);
export const formatoRedacaoEnum = pgEnum('formato_redacao_enum', ['enem', 'genero_uece']);
export const formatoSimuladoEnum = pgEnum('formato_simulado_enum', ['enem', 'uece_1fase', 'uece_2fase', 'privada']);
export const tipoAcervoMaterialEnum = pgEnum('tipo_acervo_material_enum', [
  'livro',
  'apostila',
  'slide',
  'lista_exercicios',
  'anotacao_aula',
  'prova_oficial',
  'resumo_proprio',
  'outro'
]);
export const statusProcessamentoEnum = pgEnum('status_processamento_enum', [
  'aguardando',
  'extraindo',
  'segmentando',
  'classificando',
  'indexando',
  'concluido',
  'falhou'
]);
export const metodoExtracaoEnum = pgEnum('metodo_extracao_enum', ['nativo', 'ocr', 'visao']);
export const tipoConteudoChunkEnum = pgEnum('tipo_conteudo_chunk_enum', [
  'exposicao_teorica',
  'exemplo_resolvido',
  'questao',
  'exercicio',
  'definicao',
  'formula',
  'figura_legenda'
]);
export const decisaoCuradoriaEnum = pgEnum('decisao_curadoria_enum', ['pendente', 'aprovado', 'rejeitado', 'editado_e_aprovado']);

// 4.1 Base curricular
export const perfis = pgTable('perfis', {
  id: uuid('id').primaryKey().defaultRandom(),
  authUserId: uuid('auth_user_id').notNull().unique(),
  nome: varchar('nome', { length: 255 }).notNull(),
  papel: papelEnum('papel').notNull(),
  criadoEm: timestamp('criado_em').defaultNow().notNull()
});

export const disciplinas = pgTable('disciplinas', {
  id: uuid('id').primaryKey().defaultRandom(),
  nome: varchar('nome', { length: 255 }).notNull(),
  area: areaEnum('area').notNull(),
  corHex: varchar('cor_hex', { length: 7 }).notNull(),
  ordem: integer('ordem').notNull()
});

export const topicos = pgTable('topicos', {
  id: uuid('id').primaryKey().defaultRandom(),
  disciplinaId: uuid('disciplina_id').references(() => disciplinas.id).notNull(),
  nome: varchar('nome', { length: 255 }).notNull(),
  seriePrevista: integer('serie_prevista').notNull(), // 1, 2, 3
  incidenciaEnem: integer('incidencia_enem').notNull(), // 1..5
  incidenciaUece: integer('incidencia_uece').notNull(), // 1..5
  preRequisitoTopicoId: uuid('pre_requisito_topico_id'),
  ordem: integer('ordem').notNull(),
  coberturaMaterial: coberturaMaterialEnum('cobertura_material').default('sem_fonte').notNull()
});

// 4.2 Ciclo de estudos — modelar como FILA, não como calendário
export const ciclos = pgTable('ciclos', {
  id: uuid('id').primaryKey().defaultRandom(),
  nome: varchar('nome', { length: 255 }).notNull(),
  anoLetivo: integer('ano_letivo').notNull(),
  ativo: boolean('ativo').default(false).notNull(),
  blocosPrevistosSemana: integer('blocos_previstos_semana').notNull(),
  criadoEm: timestamp('criado_em').defaultNow().notNull()
});

export const cicloBlocos = pgTable('ciclo_blocos', {
  id: uuid('id').primaryKey().defaultRandom(),
  cicloId: uuid('ciclo_id').references(() => ciclos.id).notNull(),
  ordem: integer('ordem').notNull(),
  disciplinaId: uuid('disciplina_id').references(() => disciplinas.id).notNull(),
  tipo: tipoBlocoEnum('tipo').notNull(),
  estiloAlvo: estiloAlvoEnum('estilo_alvo').notNull(),
  duracaoMin: integer('duracao_min').notNull()
});

export const cicloEstado = pgTable('ciclo_estado', {
  cicloId: uuid('ciclo_id').references(() => ciclos.id).primaryKey(),
  proximaOrdem: integer('proxima_ordem').notNull()
});

// 4.3 Sessões e cronômetro
export const sessoes = pgTable('sessoes', {
  id: uuid('id').primaryKey().defaultRandom(),
  perfilId: uuid('perfil_id').references(() => perfis.id).notNull(),
  cicloBlocoId: uuid('ciclo_bloco_id').references(() => cicloBlocos.id).notNull(),
  topicoId: uuid('topico_id').references(() => topicos.id).notNull(),
  iniciadaEm: timestamp('iniciada_em').notNull(),
  encerradaEm: timestamp('encerrada_em'),
  segundosEfetivos: integer('segundos_efetivos').default(0).notNull(),
  segundosPausa: integer('segundos_pausa').default(0).notNull(),
  etapaAtingida: etapaAtingidaEnum('etapa_atingida').notNull(), // revisao, conteudo, questoes, registro
  concluida: boolean('concluida').default(false).notNull(),
  notaLivre: text('nota_livre')
});

// 4.4 Conteúdo teórico e recuperação ativa
export const materiais = pgTable('materiais', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicoId: uuid('topico_id').references(() => topicos.id).notNull(),
  titulo: varchar('titulo', { length: 255 }).notNull(),
  corpo: text('corpo').notNull(),
  tipo: tipoMaterialEnum('tipo').notNull(), // resumo, formulario, mapa_mental, esquema
  tempoLeituraMin: integer('tempo_leitura_min').notNull(),
  status: statusMaterialEnum('status').default('rascunho').notNull(),
  origem: origemMaterialEnum('origem').notNull(),
  fonteChunkIds: jsonb('fonte_chunk_ids'), // uuid[]
  geradoEm: timestamp('gerado_em').defaultNow().notNull(),
  aprovadoPor: uuid('aprovado_por').references(() => perfis.id),
  aprovadoEm: timestamp('aprovado_em'),
  versao: integer('versao').default(1).notNull()
});

export const perguntasAtivas = pgTable('perguntas_ativas', {
  id: uuid('id').primaryKey().defaultRandom(),
  topicoId: uuid('topico_id').references(() => topicos.id).notNull(),
  pergunta: text('pergunta').notNull(),
  resposta: text('resposta').notNull(),
  estilo: estiloAlvoEnum('estilo').notNull(),
  status: statusMaterialEnum('status').default('rascunho').notNull(),
  fonteChunkIds: jsonb('fonte_chunk_ids') // uuid[]
});

// 4.5 Repetição espaçada (FSRS)
export const cards = pgTable('cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  perfilId: uuid('perfil_id').references(() => perfis.id).notNull(),
  topicoId: uuid('topico_id').references(() => topicos.id).notNull(),
  frente: text('frente').notNull(),
  verso: text('verso').notNull(),
  origem: varchar('origem', { length: 50 }).notNull(), // manual, material, erro, questao, gerado
  status: statusMaterialEnum('status').default('aprovado').notNull(),
  suspenso: boolean('suspenso').default(false).notNull(),
  fonteChunkIds: jsonb('fonte_chunk_ids'), // uuid[]
  due: timestamp('due').notNull(),
  stability: doublePrecision('stability').notNull(),
  difficulty: doublePrecision('difficulty').notNull(),
  elapsedDays: integer('elapsed_days').notNull(),
  scheduledDays: integer('scheduled_days').notNull(),
  reps: integer('reps').notNull(),
  lapses: integer('lapses').notNull(),
  state: varchar('state', { length: 50 }).notNull(), // new, learning, review, relearning
  lastReview: timestamp('last_review')
});

export const cardRevisoes = pgTable('card_revisoes', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').references(() => cards.id).notNull(),
  revisadoEm: timestamp('revisado_em').notNull(),
  rating: varchar('rating', { length: 50 }).notNull(), // again, hard, good, easy
  stateAnterior: varchar('state_anterior', { length: 50 }).notNull(),
  stabilityAnterior: doublePrecision('stability_anterior').notNull(),
  duracaoMs: integer('duracao_ms').notNull()
});

// 4.6 Banco de questões
export const questoes = pgTable('questoes', {
  id: uuid('id').primaryKey().defaultRandom(),
  procedencia: procedenciaQuestaoEnum('procedencia').notNull(), // oficial, extraida, gerada
  fonte: varchar('fonte', { length: 100 }).notNull(), // ENEM, UECE, UNIFOR, UNICHRISTUS, etc.
  ano: integer('ano'),
  fase: varchar('fase', { length: 50 }),
  numero: integer('numero'),
  disciplinaId: uuid('disciplina_id').references(() => disciplinas.id).notNull(),
  estilo: estiloAlvoEnum('estilo').notNull(), // enem, conteudista, misto
  dificuldade: varchar('dificuldade', { length: 50 }),
  enunciado: text('enunciado').notNull(),
  alternativas: jsonb('alternativas').notNull(), // [{letra, texto}]
  gabarito: varchar('gabarito', { length: 10 }).notNull(),
  resolucao: text('resolucao'),
  imagemUrl: varchar('imagem_url', { length: 1000 }),
  status: statusQuestaoEnum('status').default('rascunho').notNull(),
  arquivoOrigemId: uuid('arquivo_origem_id'),
  fonteChunkIds: jsonb('fonte_chunk_ids'), // uuid[]
  confiancaGeracao: doublePrecision('confianca_geracao'),
  ativa: boolean('ativa').default(true).notNull()
});

export const questaoTopicos = pgTable('questao_topicos', {
  questaoId: uuid('questao_id').references(() => questoes.id).notNull(),
  topicoId: uuid('topico_id').references(() => topicos.id).notNull()
});

export const tentativas = pgTable('tentativas', {
  id: uuid('id').primaryKey().defaultRandom(),
  perfilId: uuid('perfil_id').references(() => perfis.id).notNull(),
  questaoId: uuid('questao_id').references(() => questoes.id).notNull(),
  sessaoId: uuid('sessao_id').references(() => sessoes.id),
  simuladoId: uuid('simulado_id'),
  alternativaMarcada: varchar('alternativa_marcada', { length: 10 }).notNull(),
  correta: boolean('correta').notNull(),
  segundos: integer('segundos').notNull(),
  confianca: confiancaTentativaEnum('confianca').notNull(), // certeza, duvida, chute
  criadoEm: timestamp('criado_em').defaultNow().notNull()
});

// 4.7 Caderno de erros
export const erros = pgTable('erros', {
  id: uuid('id').primaryKey().defaultRandom(),
  perfilId: uuid('perfil_id').references(() => perfis.id).notNull(),
  questaoId: uuid('questao_id').references(() => questoes.id).notNull(),
  tentativaId: uuid('tentativa_id').references(() => tentativas.id).notNull(),
  descricaoLivre: text('descricao_livre'),
  disciplinaId: uuid('disciplina_id').references(() => disciplinas.id).notNull(),
  topicoId: uuid('topico_id').references(() => topicos.id).notNull(),
  estilo: estiloAlvoEnum('estilo').notNull(),
  tipoErro: tipoErroEnum('tipo_erro').notNull(), // conteudo, interpretacao, distracao, calculo, tempo
  conceitoCorreto: text('conceito_correto'),
  criadoEm: timestamp('criado_em').defaultNow().notNull(),
  resolvidoEm: timestamp('resolvido_em'),
  vezesRevisado: integer('vezes_revisado').default(0).notNull()
});

// 4.8 Redação
export const generos = pgTable('generos', {
  id: uuid('id').primaryKey().defaultRandom(),
  nome: varchar('nome', { length: 100 }).notNull(),
  finalidade: text('finalidade').notNull(),
  interlocutor: varchar('interlocutor', { length: 255 }).notNull(),
  estrutura: text('estrutura').notNull(),
  marcasLinguagem: text('marcas_linguagem').notNull(),
  erroQueDescaracteriza: text('erro_que_descaracteriza').notNull(),
  fichaCompleta: boolean('ficha_completa').default(false).notNull()
});

export const redacoes = pgTable('redacoes', {
  id: uuid('id').primaryKey().defaultRandom(),
  perfilId: uuid('perfil_id').references(() => perfis.id).notNull(),
  formato: formatoRedacaoEnum('formato').notNull(), // enem, genero_uece
  generoId: uuid('genero_id').references(() => generos.id),
  tema: varchar('tema', { length: 500 }).notNull(),
  escritaEm: timestamp('escrita_em').notNull(),
  texto: text('texto'),
  arquivoUrl: varchar('arquivo_url', { length: 1000 }),
  minutosGastos: integer('minutos_gastos').notNull(),
  notaTotal: integer('nota_total'),
  competencias: jsonb('competencias'),
  corrigidaPor: varchar('corrigida_por', { length: 255 }),
  reescritadeId: uuid('reescrita_de_id'),
  observacoes: text('observacoes')
});

export const repertorios = pgTable('repertorios', {
  id: uuid('id').primaryKey().defaultRandom(),
  referencia: text('referencia').notNull(),
  resumo2Linhas: text('resumo_2_linhas').notNull(),
  temasAplicaveis: jsonb('temas_aplicaveis').notNull(),
  categoria: varchar('categoria', { length: 100 }).notNull(),
  criadoEm: timestamp('criado_em').defaultNow().notNull()
});

// 4.9 Simulados
export const simulados = pgTable('simulados', {
  id: uuid('id').primaryKey().defaultRandom(),
  perfilId: uuid('perfil_id').references(() => perfis.id).notNull(),
  formato: formatoSimuladoEnum('formato').notNull(), // enem, uece_1fase, uece_2fase, privada
  data: timestamp('data').notNull(),
  condicoesReais: boolean('condicoes_reais').notNull(),
  duracaoMin: integer('duracao_min').notNull(),
  local: varchar('local', { length: 255 }).notNull(),
  composicaoProcedencia: jsonb('composicao_procedencia').notNull()
});

export const simuladoQuestoes = pgTable('simulado_questoes', {
  simuladoId: uuid('simulado_id').references(() => simulados.id).notNull(),
  questaoId: uuid('questao_id').references(() => questoes.id).notNull(),
  ordem: integer('ordem').notNull(),
  area: varchar('area', { length: 100 }).notNull()
});

export const simuladoAreas = pgTable('simulado_areas', {
  id: uuid('id').primaryKey().defaultRandom(),
  simuladoId: uuid('simulado_id').references(() => simulados.id).notNull(),
  area: varchar('area', { length: 100 }).notNull(),
  acertos: integer('acertos').notNull(),
  total: integer('total').notNull(),
  notaEstimada: integer('nota_estimated')
});

export const simuladoAnalise = pgTable('simulado_analise', {
  id: uuid('id').primaryKey().defaultRandom(),
  simuladoId: uuid('simulado_id').references(() => simulados.id).notNull(),
  concluida: boolean('concluida').default(false).notNull(),
  tresAssuntosFracos: jsonb('tres_assuntos_fracos').notNull(),
  errosEstrategia: text('erros_estrategia'),
  minutosAnalise: integer('minutos_analise').notNull(),
  realizadaEm: timestamp('realizada_em').notNull()
});

// 4.10 Bem-estar, revisão trimestral e leitura
export const checkins = pgTable('checkins', {
  id: uuid('id').primaryKey().defaultRandom(),
  perfilId: uuid('perfil_id').references(() => perfis.id).notNull(),
  data: timestamp('data').notNull(),
  horasSono: doublePrecision('horas_sono').notNull(),
  exercicioMin: integer('exercicio_min').notNull(),
  humor: integer('humor').notNull(),
  energia: integer('energia').notNull(),
  notaLivre: text('nota_livre')
});

export const revisoesTrimestrais = pgTable('revisoes_trimestrais', {
  id: uuid('id').primaryKey().defaultRandom(),
  trimestre: integer('trimestre').notNull(),
  ano: integer('ano').notNull(),
  aderenciaPct: doublePrecision('aderencia_pct').notNull(),
  cardsAtrasados: integer('cards_atrasados').notNull(),
  mediaEnem: doublePrecision('media_enem'),
  acertoUecePct: doublePrecision('acerto_uece_pct'),
  divergenciaTrilhos: doublePrecision('divergencia_trilhos'),
  tipoErroPredominante: tipoErroEnum('tipo_erro_predominante'),
  redacoesEscritas: integer('redacoes_escritas').notNull(),
  redacoesReescritas: integer('redacoes_reescritas').notNull(),
  mediaSono: doublePrecision('media_sono').notNull(),
  conversa: text('conversa').notNull(),
  decisoes: text('decisoes').notNull(),
  fechadaEm: timestamp('fechada_em').defaultNow().notNull()
});

export const livros = pgTable('livros', {
  id: uuid('id').primaryKey().defaultRandom(),
  perfilId: uuid('perfil_id').references(() => perfis.id).notNull(),
  titulo: varchar('titulo', { length: 255 }).notNull(),
  autor: varchar('autor', { length: 255 }).notNull(),
  anoPlano: integer('ano_plano').notNull(),
  iniciadoEm: timestamp('iniciado_em'),
  concluidoEm: timestamp('concluido_em'),
  notas: text('notas')
});

// 5. MODELO DE DADOS — MOTOR DE INGESTÃO
export const acervoArquivos = pgTable('acervo_arquivos', {
  id: uuid('id').primaryKey().defaultRandom(),
  disciplinaId: uuid('disciplina_id').references(() => disciplinas.id).notNull(),
  titulo: varchar('titulo', { length: 255 }).notNull(),
  tipoMaterial: tipoAcervoMaterialEnum('tipo_material').notNull(),
  autorFonte: varchar('autor_fonte', { length: 255 }),
  serieAlvo: integer('serie_alvo').notNull(),
  filePath: varchar('file_path', { length: 1000 }).notNull(),
  mime: varchar('mime', { length: 100 }).notNull(),
  tamanhoBytes: integer('tamanho_bytes').notNull(),
  paginas: integer('paginas'),
  enviadoPor: uuid('enviado_por').references(() => perfis.id).notNull(),
  enviadoEm: timestamp('enviado_em').defaultNow().notNull(),
  statusProcessamento: statusProcessamentoEnum('status_processamento').default('aguardando').notNull(),
  erroProcessamento: text('erro_processamento'),
  hashConteudo: varchar('hash_conteudo', { length: 64 }).notNull()
});

export const acervoPaginas = pgTable('acervo_paginas', {
  id: uuid('id').primaryKey().defaultRandom(),
  arquivoId: uuid('arquivo_id').references(() => acervoArquivos.id).notNull(),
  numero: integer('numero').notNull(),
  textoExtraido: text('texto_extraido'),
  metodoExtracao: metodoExtracaoEnum('metodo_extracao'),
  confiancaOcr: doublePrecision('confianca_ocr'),
  imagemPath: varchar('imagem_path', { length: 1000 })
});

export const acervoChunks = pgTable('acervo_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  arquivoId: uuid('arquivo_id').references(() => acervoArquivos.id).notNull(),
  paginaInicial: integer('pagina_inicial').notNull(),
  paginaFinal: integer('pagina_final').notNull(),
  ordem: integer('ordem').notNull(),
  texto: text('texto').notNull(),
  tipoConteudo: tipoConteudoChunkEnum('tipo_conteudo').notNull(),
  topicoId: uuid('topico_id').references(() => topicos.id),
  confiancaClassificacao: doublePrecision('confianca_classificacao'),
  embedding: vector('embedding'),
  tokens: integer('tokens')
});

export const acervoFiguras = pgTable('acervo_figuras', {
  id: uuid('id').primaryKey().defaultRandom(),
  arquivoId: uuid('arquivo_id').references(() => acervoArquivos.id).notNull(),
  pagina: integer('pagina').notNull(),
  bbox: jsonb('bbox').notNull(),
  imagemPath: varchar('imagem_path', { length: 1000 }).notNull(),
  legenda: text('legenda'),
  chunkId: uuid('chunk_id').references(() => acervoChunks.id)
});

export const geracoes = pgTable('geracoes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tipoArtefato: varchar('tipo_artefato', { length: 100 }).notNull(),
  topicoId: uuid('topico_id').references(() => topicos.id).notNull(),
  arquivoIds: jsonb('arquivo_ids').notNull(),
  chunkIds: jsonb('chunk_ids').notNull(),
  modelo: varchar('modelo', { length: 100 }).notNull(),
  promptVersao: varchar('prompt_versao', { length: 50 }).notNull(),
  custoTokens: integer('custo_tokens').notNull(),
  iniciadaEm: timestamp('iniciada_em').notNull(),
  concluidaEm: timestamp('concluida_em'),
  status: varchar('status', { length: 50 }).notNull(),
  itensGerados: integer('itens_gerados').default(0).notNull(),
  itensAprovados: integer('itens_aprovados').default(0).notNull(),
  itensRejeitados: integer('itens_rejeitados').default(0).notNull()
});

export const curadoriaFila = pgTable('curadoria_fila', {
  id: uuid('id').primaryKey().defaultRandom(),
  artefatoTipo: varchar('artefato_tipo', { length: 100 }).notNull(),
  artefatoId: uuid('artefato_id').notNull(),
  topicoId: uuid('topico_id').references(() => topicos.id).notNull(),
  prioridade: integer('prioridade').default(0).notNull(),
  criadoEm: timestamp('criado_em').defaultNow().notNull(),
  revisadoEm: timestamp('revisado_em'),
  decisao: decisaoCuradoriaEnum('decisao').default('pendente').notNull(),
  motivoRejeicao: text('motivo_rejeicao'),
  editado: boolean('editado').default(false).notNull()
});
