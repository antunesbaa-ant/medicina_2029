import { createHash } from 'node:crypto';

export const EXPORT_APP_NAME = 'Medicina 2029';
export const EXPORT_FORMAT_VERSION = 1;
export const EXPORT_TYPE = 'exportacao_administrativa_pessoal' as const;
export const EXPORT_HASH_ALGORITHM = 'SHA-256' as const;

export const EXPORT_COLLECTION_FIELDS = {
  perfis: ['id', 'nome', 'papel', 'criadoEm'],
  responsavelEstudante: ['vinculoId', 'responsavelPerfilId', 'estudantePerfilId', 'criadoEm'],
  generos: ['id', 'nome', 'finalidade', 'interlocutor', 'estrutura', 'marcasLinguagem', 'erroQueDescaracteriza', 'fichaCompleta'],
  disciplinas: ['id', 'nome', 'area', 'corHex', 'ordem'],
  topicos: ['id', 'disciplinaId', 'nome', 'seriePrevista', 'incidenciaEnem', 'incidenciaUece', 'preRequisitoTopicoId', 'ordem', 'coberturaMaterial'],
  materiais: ['id', 'topicoId', 'titulo', 'corpo', 'tipo', 'tempoLeituraMin', 'status', 'origem', 'fonteChunkIds', 'geradoEm', 'aprovadoPor', 'aprovadoEm', 'versao'],
  perguntasAtivas: ['id', 'topicoId', 'pergunta', 'resposta', 'estilo', 'status', 'fonteChunkIds'],
  questoes: ['id', 'procedencia', 'fonte', 'ano', 'fase', 'numero', 'disciplinaId', 'estilo', 'dificuldade', 'enunciado', 'alternativas', 'gabarito', 'resolucao', 'imagemUrl', 'status', 'arquivoOrigemId', 'fonteChunkIds', 'confiancaGeracao', 'ativa'],
  questaoTopicos: ['questaoId', 'topicoId'],
  curadoriaFila: ['id', 'artefatoTipo', 'artefatoId', 'topicoId', 'prioridade', 'criadoEm', 'revisadoEm', 'decisao', 'motivoRejeicao', 'editado'],
  sessoes: ['id', 'perfilId', 'cicloBlocoId', 'topicoId', 'iniciadaEm', 'encerradaEm', 'segundosEfetivos', 'segundosPausa', 'etapaAtingida', 'concluida', 'notaLivre'],
  ciclos: ['id', 'estudantePerfilId', 'nome', 'anoLetivo', 'ativo', 'blocosPrevistosSemana', 'criadoEm'],
  cicloBlocos: ['id', 'cicloId', 'ordem', 'disciplinaId', 'tipo', 'estiloAlvo', 'duracaoMin'],
  cicloEstado: ['cicloId', 'proximaOrdem'],
  tentativas: ['id', 'perfilId', 'questaoId', 'sessaoId', 'simuladoId', 'alternativaMarcada', 'correta', 'segundos', 'confianca', 'criadoEm'],
  erros: ['id', 'perfilId', 'questaoId', 'tentativaId', 'descricaoLivre', 'disciplinaId', 'topicoId', 'estilo', 'tipoErro', 'conceitoCorreto', 'criadoEm', 'resolvidoEm', 'vezesRevisado'],
  cards: ['id', 'perfilId', 'topicoId', 'frente', 'verso', 'origem', 'status', 'suspenso', 'fonteChunkIds', 'due', 'stability', 'difficulty', 'elapsedDays', 'scheduledDays', 'reps', 'lapses', 'state', 'lastReview'],
  cardRevisoes: ['id', 'cardId', 'revisadoEm', 'rating', 'stateAnterior', 'stabilityAnterior', 'duracaoMs'],
  checkins: ['id', 'perfilId', 'data', 'horasSono', 'exercicioMin', 'humor', 'energia', 'notaLivre'],
  redacoes: ['id', 'perfilId', 'formato', 'generoId', 'tema', 'escritaEm', 'texto', 'arquivoUrl', 'minutosGastos', 'notaTotal', 'competencias', 'corrigidaPor', 'reescritadeId', 'observacoes'],
  repertorios: ['id', 'perfilId', 'referencia', 'resumo2Linhas', 'temasAplicaveis', 'categoria', 'criadoEm'],
  simulados: ['id', 'perfilId', 'formato', 'data', 'condicoesReais', 'duracaoMin', 'local', 'composicaoProcedencia'],
  simuladoQuestoes: ['simuladoId', 'questaoId', 'ordem', 'area'],
  simuladoAreas: ['id', 'simuladoId', 'area', 'acertos', 'total', 'notaEstimada'],
  simuladoAnalise: ['id', 'simuladoId', 'concluida', 'tresAssuntosFracos', 'errosEstrategia', 'minutosAnalise', 'realizadaEm'],
  revisoesTrimestrais: ['id', 'estudantePerfilId', 'registradaPorPerfilId', 'trimestre', 'ano', 'aderenciaPct', 'cardsAtrasados', 'mediaEnem', 'acertoUecePct', 'divergenciaTrilhos', 'tipoErroPredominante', 'redacoesEscritas', 'redacoesReescritas', 'mediaSono', 'conversa', 'decisoes', 'fechadaEm'],
  livros: ['id', 'perfilId', 'titulo', 'autor', 'anoPlano', 'iniciadoEm', 'concluidoEm', 'notas'],
  acervoArquivos: ['id', 'disciplinaId', 'titulo', 'tipoMaterial', 'autorFonte', 'serieAlvo', 'vestibular', 'filePath', 'mime', 'tamanhoBytes', 'paginas', 'enviadoPor', 'enviadoEm', 'statusProcessamento', 'erroProcessamento', 'hashConteudo'],
  acervoPaginas: ['id', 'arquivoId', 'numero', 'textoExtraido', 'metodoExtracao', 'confiancaOcr', 'imagemPath'],
  acervoChunks: ['id', 'arquivoId', 'paginaInicial', 'paginaFinal', 'ordem', 'texto', 'tipoConteudo', 'topicoId', 'confiancaClassificacao', 'embedding', 'tokens'],
  acervoFiguras: ['id', 'arquivoId', 'pagina', 'bbox', 'imagemPath', 'legenda', 'chunkId'],
  geracoes: ['id', 'tipoArtefato', 'topicoId', 'arquivoIds', 'chunkIds', 'modelo', 'promptVersao', 'custoTokens', 'iniciadaEm', 'concluidaEm', 'status', 'itensGerados', 'itensAprovados', 'itensRejeitados']
} as const;

export type ExportCollectionName = keyof typeof EXPORT_COLLECTION_FIELDS;
export type ExportCollections = Record<ExportCollectionName, Array<Record<string, unknown>>>;

/** Limites defensivos do validador. Não representam capacidade de backup. */
export const MAX_EXPORT_JSON_BYTES = 10 * 1024 * 1024;
export const MAX_EXPORT_RECORDS = 100_000;
export const MAX_EXPORT_NESTING_DEPTH = 20;
const MAX_VALIDATION_NODES = 500_000;
const MAX_VALIDATION_ERRORS = 100;

type FieldKind = 'uuid' | 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'json';
type FieldRule = Readonly<{ kind: FieldKind; nullable?: true; values?: readonly string[] }>;
type CollectionContract = Readonly<Record<string, FieldRule>>;

const uuid = (): FieldRule => ({ kind: 'uuid' });
const string = (values?: readonly string[]): FieldRule => ({ kind: 'string', values });
const integer = (): FieldRule => ({ kind: 'integer' });
const number = (): FieldRule => ({ kind: 'number' });
const boolean = (): FieldRule => ({ kind: 'boolean' });
const date = (): FieldRule => ({ kind: 'date' });
const json = (): FieldRule => ({ kind: 'json' });
const nullable = (rule: FieldRule): FieldRule => ({ ...rule, nullable: true });

/**
 * Contrato fechado do formato 1. Todos os campos selecionados pela exportação devem
 * existir no JSON; campos nullable são representados explicitamente por `null`.
 */
export const EXPORT_COLLECTION_CONTRACTS: Record<ExportCollectionName, CollectionContract> = {
  perfis: { id: uuid(), nome: string(), papel: string(['estudante', 'responsavel']), criadoEm: date() },
  responsavelEstudante: { vinculoId: integer(), responsavelPerfilId: uuid(), estudantePerfilId: uuid(), criadoEm: date() },
  generos: { id: uuid(), nome: string(), finalidade: string(), interlocutor: string(), estrutura: string(), marcasLinguagem: string(), erroQueDescaracteriza: string(), fichaCompleta: boolean() },
  disciplinas: { id: uuid(), nome: string(), area: string(['linguagens', 'humanas', 'natureza', 'matematica', 'redacao']), corHex: string(), ordem: integer() },
  topicos: { id: uuid(), disciplinaId: uuid(), nome: string(), seriePrevista: integer(), incidenciaEnem: integer(), incidenciaUece: integer(), preRequisitoTopicoId: nullable(uuid()), ordem: integer(), coberturaMaterial: string(['sem_fonte', 'parcial', 'coberto']) },
  materiais: { id: uuid(), topicoId: uuid(), titulo: string(), corpo: string(), tipo: string(['resumo', 'formulario', 'mapa_mental', 'esquema']), tempoLeituraMin: integer(), status: string(['rascunho', 'em_revisao', 'aprovado', 'rejeitado', 'desatualizado']), origem: string(['manual', 'gerado']), fonteChunkIds: nullable(json()), geradoEm: date(), aprovadoPor: nullable(uuid()), aprovadoEm: nullable(date()), versao: integer() },
  perguntasAtivas: { id: uuid(), topicoId: uuid(), pergunta: string(), resposta: string(), estilo: string(['enem', 'conteudista', 'misto']), status: string(['rascunho', 'em_revisao', 'aprovado', 'rejeitado', 'desatualizado']), fonteChunkIds: nullable(json()) },
  questoes: { id: uuid(), procedencia: string(['oficial', 'extraida', 'gerada']), fonte: string(), ano: nullable(integer()), fase: nullable(string()), numero: nullable(integer()), disciplinaId: uuid(), estilo: string(['enem', 'conteudista', 'misto']), dificuldade: nullable(string()), enunciado: string(), alternativas: json(), gabarito: string(), resolucao: nullable(string()), imagemUrl: nullable(string()), status: string(['rascunho', 'em_revisao', 'aprovado', 'rejeitado']), arquivoOrigemId: nullable(uuid()), fonteChunkIds: nullable(json()), confiancaGeracao: nullable(number()), ativa: boolean() },
  questaoTopicos: { questaoId: uuid(), topicoId: uuid() },
  curadoriaFila: { id: uuid(), artefatoTipo: string(), artefatoId: uuid(), topicoId: uuid(), prioridade: integer(), criadoEm: date(), revisadoEm: nullable(date()), decisao: string(['pendente', 'aprovado', 'rejeitado', 'editado_e_aprovado']), motivoRejeicao: nullable(string()), editado: boolean() },
  sessoes: { id: uuid(), perfilId: uuid(), cicloBlocoId: uuid(), topicoId: uuid(), iniciadaEm: date(), encerradaEm: nullable(date()), segundosEfetivos: integer(), segundosPausa: integer(), etapaAtingida: string(['revisao', 'conteudo', 'questoes', 'registro']), concluida: boolean(), notaLivre: nullable(string()) },
  ciclos: { id: uuid(), estudantePerfilId: nullable(uuid()), nome: string(), anoLetivo: integer(), ativo: boolean(), blocosPrevistosSemana: integer(), criadoEm: date() },
  cicloBlocos: { id: uuid(), cicloId: uuid(), ordem: integer(), disciplinaId: uuid(), tipo: string(['conteudo', 'questoes', 'redacao', 'caderno_erros', 'revisao_srs', 'lingua_estrangeira']), estiloAlvo: string(['enem', 'conteudista', 'misto']), duracaoMin: integer() },
  cicloEstado: { cicloId: uuid(), proximaOrdem: integer() },
  tentativas: { id: uuid(), perfilId: uuid(), questaoId: uuid(), sessaoId: nullable(uuid()), simuladoId: nullable(uuid()), alternativaMarcada: string(), correta: boolean(), segundos: integer(), confianca: string(['certeza', 'duvida', 'chute']), criadoEm: date() },
  erros: { id: uuid(), perfilId: uuid(), questaoId: uuid(), tentativaId: uuid(), descricaoLivre: nullable(string()), disciplinaId: uuid(), topicoId: uuid(), estilo: string(['enem', 'conteudista', 'misto']), tipoErro: string(['conteudo', 'interpretacao', 'distracao', 'calculo', 'tempo']), conceitoCorreto: nullable(string()), criadoEm: date(), resolvidoEm: nullable(date()), vezesRevisado: integer() },
  cards: { id: uuid(), perfilId: uuid(), topicoId: uuid(), frente: string(), verso: string(), origem: string(), status: string(['rascunho', 'em_revisao', 'aprovado', 'rejeitado', 'desatualizado']), suspenso: boolean(), fonteChunkIds: nullable(json()), due: date(), stability: number(), difficulty: number(), elapsedDays: integer(), scheduledDays: integer(), reps: integer(), lapses: integer(), state: string(), lastReview: nullable(date()) },
  cardRevisoes: { id: uuid(), cardId: uuid(), revisadoEm: date(), rating: string(), stateAnterior: string(), stabilityAnterior: number(), duracaoMs: integer() },
  checkins: { id: uuid(), perfilId: uuid(), data: date(), horasSono: number(), exercicioMin: integer(), humor: integer(), energia: integer(), notaLivre: nullable(string()) },
  redacoes: { id: uuid(), perfilId: uuid(), formato: string(['enem', 'genero_uece']), generoId: nullable(uuid()), tema: string(), escritaEm: date(), texto: nullable(string()), arquivoUrl: nullable(string()), minutosGastos: integer(), notaTotal: nullable(integer()), competencias: nullable(json()), corrigidaPor: nullable(string()), reescritadeId: nullable(uuid()), observacoes: nullable(string()) },
  repertorios: { id: uuid(), perfilId: nullable(uuid()), referencia: string(), resumo2Linhas: string(), temasAplicaveis: json(), categoria: string(), criadoEm: date() },
  simulados: { id: uuid(), perfilId: uuid(), formato: string(['enem', 'uece_1fase', 'uece_2fase', 'privada']), data: date(), condicoesReais: boolean(), duracaoMin: integer(), local: string(), composicaoProcedencia: json() },
  simuladoQuestoes: { simuladoId: uuid(), questaoId: uuid(), ordem: integer(), area: string() },
  simuladoAreas: { id: uuid(), simuladoId: uuid(), area: string(), acertos: integer(), total: integer(), notaEstimada: nullable(integer()) },
  simuladoAnalise: { id: uuid(), simuladoId: uuid(), concluida: boolean(), tresAssuntosFracos: json(), errosEstrategia: nullable(string()), minutosAnalise: integer(), realizadaEm: date() },
  revisoesTrimestrais: { id: uuid(), estudantePerfilId: nullable(uuid()), registradaPorPerfilId: nullable(uuid()), trimestre: integer(), ano: integer(), aderenciaPct: number(), cardsAtrasados: integer(), mediaEnem: nullable(number()), acertoUecePct: nullable(number()), divergenciaTrilhos: nullable(number()), tipoErroPredominante: nullable(string(['conteudo', 'interpretacao', 'distracao', 'calculo', 'tempo'])), redacoesEscritas: integer(), redacoesReescritas: integer(), mediaSono: number(), conversa: string(), decisoes: string(), fechadaEm: date() },
  livros: { id: uuid(), perfilId: uuid(), titulo: string(), autor: string(), anoPlano: integer(), iniciadoEm: nullable(date()), concluidoEm: nullable(date()), notas: nullable(string()) },
  acervoArquivos: { id: uuid(), disciplinaId: uuid(), titulo: string(), tipoMaterial: string(['livro', 'apostila', 'slide', 'lista_exercicios', 'anotacao_aula', 'prova_oficial', 'resumo_proprio', 'outro']), autorFonte: nullable(string()), serieAlvo: integer(), vestibular: nullable(string()), filePath: string(), mime: string(), tamanhoBytes: integer(), paginas: nullable(integer()), enviadoPor: uuid(), enviadoEm: date(), statusProcessamento: string(['aguardando', 'extraindo', 'segmentando', 'classificando', 'indexando', 'concluido', 'falhou']), erroProcessamento: nullable(string()), hashConteudo: string() },
  acervoPaginas: { id: uuid(), arquivoId: uuid(), numero: integer(), textoExtraido: nullable(string()), metodoExtracao: nullable(string(['nativo', 'ocr', 'visao'])), confiancaOcr: nullable(number()), imagemPath: nullable(string()) },
  acervoChunks: { id: uuid(), arquivoId: uuid(), paginaInicial: integer(), paginaFinal: integer(), ordem: integer(), texto: string(), tipoConteudo: string(['exposicao_teorica', 'exemplo_resolvido', 'questao', 'exercicio', 'definicao', 'formula', 'figura_legenda']), topicoId: nullable(uuid()), confiancaClassificacao: nullable(number()), embedding: nullable(json()), tokens: nullable(integer()) },
  acervoFiguras: { id: uuid(), arquivoId: uuid(), pagina: integer(), bbox: json(), imagemPath: string(), legenda: nullable(string()), chunkId: nullable(uuid()) },
  geracoes: { id: uuid(), tipoArtefato: string(), topicoId: uuid(), arquivoIds: json(), chunkIds: json(), modelo: string(), promptVersao: string(), custoTokens: integer(), iniciadaEm: date(), concluidaEm: nullable(date()), status: string(), itensGerados: integer(), itensAprovados: integer(), itensRejeitados: integer() }
};

const FORBIDDEN_FIELDS = new Set([
  'authuserid',
  'auth_user_id',
  'password',
  'passwordhash',
  'password_hash',
  'senha',
  'senhahash',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'cookie',
  'secret',
  'segredo',
  'apikey',
  'api_key',
  'credential',
  'credentials',
  'credencial',
  'credenciais'
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isForbiddenField(field: string): boolean {
  const normalized = field.toLowerCase();
  const compact = normalized.replace(/[_\-\s]/g, '');
  return FORBIDDEN_FIELDS.has(normalized)
    || compact.endsWith('password')
    || compact.endsWith('passwordhash')
    || compact.endsWith('senha')
    || compact.endsWith('senhahash')
    || compact.endsWith('token')
    || compact.endsWith('secret')
    || compact.endsWith('segredo')
    || compact.includes('apikey')
    || compact.endsWith('credential')
    || compact.endsWith('credencial')
    || compact.endsWith('cookie');
}

export interface ExportManifest {
  aplicativo: typeof EXPORT_APP_NAME;
  versaoFormato: typeof EXPORT_FORMAT_VERSION;
  exportadoEm: string;
  tipoExportacao: typeof EXPORT_TYPE;
  colecoesIncluidas: ExportCollectionName[];
  quantidades: Record<ExportCollectionName, number>;
  segredosExcluidos: true;
  objetosStorageIncluidos: false;
  restauravelAutomaticamente: false;
  algoritmoIntegridade: typeof EXPORT_HASH_ALGORITHM;
  hashIntegridade: string;
}

export interface SafeExportFile {
  manifesto: ExportManifest;
  dados: ExportCollections;
}

export type ExportValidationResult =
  | { valido: true; arquivo: SafeExportFile }
  | { valido: false; erros: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeForDeterministicSerialization(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForDeterministicSerialization);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, normalizeForDeterministicSerialization(value[key])])
    );
  }
  return value;
}

export function serializarDeterministicamente(value: unknown): string {
  return JSON.stringify(normalizeForDeterministicSerialization(value));
}

export function calcularHashIntegridade(dados: ExportCollections): string {
  return createHash('sha256')
    .update(serializarDeterministicamente(dados), 'utf8')
    .digest('hex');
}

function findForbiddenFields(
  value: unknown,
  path = '$',
  errors: string[] = []
): string[] {
  if (errors.length >= MAX_VALIDATION_ERRORS) return errors;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && errors.length < MAX_VALIDATION_ERRORS; index += 1) {
      findForbiddenFields(value[index], `${path}[${index}]`, errors);
    }
    return errors;
  }
  if (!isPlainObject(value)) return errors;

  for (const [key, child] of Object.entries(value)) {
    if (errors.length >= MAX_VALIDATION_ERRORS) break;
    if (isForbiddenField(key)) {
      errors.push(`Campo proibido encontrado em ${path}.${key}.`);
    }
    findForbiddenFields(child, `${path}.${key}`, errors);
  }
  return errors;
}

function inspectStructure(value: unknown, allowDates = false): string | null {
  const seen = new WeakSet<object>();
  let nodes = 0;

  function visit(current: unknown, depth: number): boolean {
    nodes += 1;
    if (nodes > MAX_VALIDATION_NODES || depth > MAX_EXPORT_NESTING_DEPTH) return false;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return true;
    if (typeof current === 'number') return Number.isFinite(current);
    if (typeof current !== 'object') return false;
    if (current instanceof Date) return allowDates && !Number.isNaN(current.getTime());
    if (seen.has(current)) return false;
    seen.add(current);

    if (Array.isArray(current)) return current.every((child) => visit(child, depth + 1));
    if (!isPlainObject(current)) return false;
    return Object.values(current).every((child) => visit(child, depth + 1));
  }

  return visit(value, 0) ? null : 'Estrutura excede os limites permitidos ou contém valor inválido.';
}

function valueMatchesRule(value: unknown, rule: FieldRule): boolean {
  if (value === null) return rule.nullable === true;
  switch (rule.kind) {
    case 'uuid':
      return typeof value === 'string' && UUID_PATTERN.test(value);
    case 'string':
      return typeof value === 'string' && (!rule.values || rule.values.includes(value));
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
        && !Number.isNaN(Date.parse(value));
    case 'json':
      return true; // A inspeção estrutural anterior já exige JSON finito e acíclico.
  }
}

function describeRule(rule: FieldRule): string {
  return rule.values ? 'valor enumerado' : rule.kind;
}

export function criarExportacaoSegura(
  dados: ExportCollections,
  exportedAt = new Date()
): SafeExportFile {
  if (inspectStructure(dados, true)) {
    throw new Error('Os dados excedem os limites seguros de exportação.');
  }
  const totalRecords = Object.values(dados).reduce(
    (total, records) => total + (Array.isArray(records) ? records.length : MAX_EXPORT_RECORDS + 1),
    0
  );
  if (totalRecords > MAX_EXPORT_RECORDS) {
    throw new Error('Os dados excedem os limites seguros de exportação.');
  }
  if (findForbiddenFields(dados).length > 0) {
    throw new Error('Os dados contêm campos proibidos para exportação.');
  }
  const colecoesIncluidas = Object.keys(EXPORT_COLLECTION_FIELDS) as ExportCollectionName[];
  const normalizedData = normalizeForDeterministicSerialization(dados) as ExportCollections;
  const quantidades = Object.fromEntries(
    colecoesIncluidas.map((collection) => [collection, normalizedData[collection].length])
  ) as Record<ExportCollectionName, number>;

  const file: SafeExportFile = {
    manifesto: {
      aplicativo: EXPORT_APP_NAME,
      versaoFormato: EXPORT_FORMAT_VERSION,
      exportadoEm: exportedAt.toISOString(),
      tipoExportacao: EXPORT_TYPE,
      colecoesIncluidas,
      quantidades,
      segredosExcluidos: true,
      objetosStorageIncluidos: false,
      restauravelAutomaticamente: false,
      algoritmoIntegridade: EXPORT_HASH_ALGORITHM,
      hashIntegridade: calcularHashIntegridade(normalizedData)
    },
    dados: normalizedData
  };
  if (Buffer.byteLength(JSON.stringify(file), 'utf8') > MAX_EXPORT_JSON_BYTES) {
    throw new Error('Os dados excedem os limites seguros de exportação.');
  }
  return file;
}

export function validarExportacaoSegura(input: unknown): ExportValidationResult {
  const errors: string[] = [];
  const addError = (message: string): void => {
    if (errors.length < MAX_VALIDATION_ERRORS) errors.push(message);
  };
  let parsed: unknown = input;

  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_EXPORT_JSON_BYTES) {
      return { valido: false, erros: ['Arquivo excede o tamanho máximo permitido.'] };
    }
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      return { valido: false, erros: ['Arquivo JSON malformado.'] };
    }
  }

  const structureError = inspectStructure(parsed);
  if (structureError) return { valido: false, erros: [structureError] };
  if (typeof input !== 'string') {
    let serializedSize = 0;
    try {
      serializedSize = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
    } catch {
      return { valido: false, erros: ['Estrutura do arquivo inválida.'] };
    }
    if (serializedSize > MAX_EXPORT_JSON_BYTES) {
      return { valido: false, erros: ['Arquivo excede o tamanho máximo permitido.'] };
    }
  }

  if (!isPlainObject(parsed)) {
    return { valido: false, erros: ['Estrutura raiz inválida.'] };
  }

  const rootKeys = Object.keys(parsed).sort();
  if (rootKeys.join(',') !== 'dados,manifesto') {
    addError('A raiz deve conter exclusivamente manifesto e dados.');
  }

  const manifest = parsed.manifesto;
  const data = parsed.dados;
  if (!isPlainObject(manifest)) addError('Manifesto ausente ou inválido.');
  if (!isPlainObject(data)) addError('Dados ausentes ou inválidos.');
  if (!isPlainObject(manifest) || !isPlainObject(data)) {
    return { valido: false, erros: errors.concat(findForbiddenFields(parsed)) };
  }

  const expectedManifestKeys = [
    'algoritmoIntegridade',
    'aplicativo',
    'colecoesIncluidas',
    'exportadoEm',
    'hashIntegridade',
    'objetosStorageIncluidos',
    'quantidades',
    'restauravelAutomaticamente',
    'segredosExcluidos',
    'tipoExportacao',
    'versaoFormato'
  ];
  if (Object.keys(manifest).sort().join(',') !== expectedManifestKeys.join(',')) {
    addError('Estrutura do manifesto inválida.');
  }

  if (manifest.aplicativo !== EXPORT_APP_NAME) addError('Aplicativo do manifesto inválido.');
  if (manifest.versaoFormato !== EXPORT_FORMAT_VERSION) addError('Versão de formato desconhecida.');
  if (manifest.tipoExportacao !== EXPORT_TYPE) addError('Tipo de exportação inválido.');
  if (manifest.segredosExcluidos !== true) addError('O manifesto não confirma a exclusão de segredos.');
  if (manifest.objetosStorageIncluidos !== false) addError('Indicação de objetos do Storage inválida.');
  if (manifest.restauravelAutomaticamente !== false) addError('A exportação não pode declarar restauração automática.');
  if (manifest.algoritmoIntegridade !== EXPORT_HASH_ALGORITHM) addError('Algoritmo de integridade inválido.');
  if (typeof manifest.exportadoEm !== 'string' || Number.isNaN(Date.parse(manifest.exportadoEm))) {
    addError('Data de exportação inválida.');
  }
  if (typeof manifest.hashIntegridade !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.hashIntegridade)) {
    addError('Hash de integridade inválido.');
  }

  const collectionNames = Object.keys(EXPORT_COLLECTION_FIELDS) as ExportCollectionName[];
  if (!Array.isArray(manifest.colecoesIncluidas)
    || manifest.colecoesIncluidas.length !== collectionNames.length
    || manifest.colecoesIncluidas.some((name, index) => name !== collectionNames[index])) {
    addError('Lista de coleções ausente, incompleta ou fora da ordem canônica.');
  }
  if (!isPlainObject(manifest.quantidades)) {
    addError('Quantidades do manifesto ausentes ou inválidas.');
  } else if (Object.keys(manifest.quantidades).sort().join(',') !== [...collectionNames].sort().join(',')) {
    addError('Mapa de quantidades contém coleções ausentes ou desconhecidas.');
  }

  const actualDataKeys = Object.keys(data);
  if (actualDataKeys.length !== collectionNames.length
    || collectionNames.some((name) => !Object.prototype.hasOwnProperty.call(data, name))) {
    addError('Coleções obrigatórias ausentes ou desconhecidas.');
  }

  const totalRecords = collectionNames.reduce((total, collection) => {
    const records = data[collection];
    return total + (Array.isArray(records) ? records.length : 0);
  }, 0);
  if (totalRecords > MAX_EXPORT_RECORDS) {
    return { valido: false, erros: ['Arquivo excede o número máximo de registros permitido.'] };
  }

  for (const collection of collectionNames) {
    const records = data[collection];
    if (!Array.isArray(records)) {
      addError(`Coleção ${collection} deve ser uma lista.`);
      continue;
    }
    if (isPlainObject(manifest.quantidades) && manifest.quantidades[collection] !== records.length) {
      addError(`Quantidade inconsistente na coleção ${collection}.`);
    }
    if (isPlainObject(manifest.quantidades)) {
      const declared = manifest.quantidades[collection];
      if (!Number.isInteger(declared) || Number(declared) < 0 || Number(declared) > MAX_EXPORT_RECORDS) {
        addError(`Quantidade inválida na coleção ${collection}.`);
      }
    }

    const allowed = new Set<string>(EXPORT_COLLECTION_FIELDS[collection]);
    const contract = EXPORT_COLLECTION_CONTRACTS[collection];
    records.forEach((record, index) => {
      if (errors.length >= MAX_VALIDATION_ERRORS) return;
      if (!isPlainObject(record)) {
        addError(`Registro inválido em ${collection}[${index}].`);
        return;
      }
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) addError(`Campo não permitido em ${collection}[${index}].${key}.`);
      }
      for (const [key, rule] of Object.entries(contract)) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
          addError(`Campo obrigatório ausente em ${collection}[${index}].${key}.`);
        } else if (!valueMatchesRule(record[key], rule)) {
          if (rule.kind === 'uuid') {
            addError(`UUID inválido em ${collection}[${index}].${key}.`);
          } else {
            addError(`Tipo ou ${describeRule(rule)} inválido em ${collection}[${index}].${key}.`);
          }
        }
      }
      if (collection === 'responsavelEstudante' && record.vinculoId !== 1) {
        addError(`Identificador numérico inválido em ${collection}[${index}].vinculoId.`);
      }
    });
  }

  for (const error of findForbiddenFields(parsed)) addError(error);

  if (typeof manifest.hashIntegridade === 'string') {
    const computedHash = calcularHashIntegridade(data as ExportCollections);
    if (computedHash !== manifest.hashIntegridade) errors.push('Hash de integridade divergente.');
  }

  if (errors.length > 0) return { valido: false, erros: [...new Set(errors)] };
  return { valido: true, arquivo: parsed as unknown as SafeExportFile };
}
