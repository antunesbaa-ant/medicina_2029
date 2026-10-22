import crypto from 'crypto';

export interface ArtefatosGerados {
  resumo: { titulo: string; corpo: string; tempoLeituraMin: number };
  flashcards: Array<{ pergunta: string; resposta: string }>;
  questoes: Array<{
    enunciado: string;
    alternativas: Array<{ letra: string; texto: string }>;
    gabarito: string;
    resolucao: string;
  }>;
}

export type GeminiGenerationErrorCode =
  | 'MISSING_API_KEY'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR';

export class GeminiGenerationError extends Error {
  constructor(readonly code: GeminiGenerationErrorCode) {
    super('Não foi possível gerar os artefatos por inteligência artificial.');
    this.name = 'GeminiGenerationError';
  }
}

export type GeminiEmbeddingErrorCode =
  | 'MISSING_API_KEY'
  | 'EMPTY_INPUT'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'DIMENSION_MISMATCH'
  | 'NETWORK_ERROR';

export class GeminiEmbeddingError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: GeminiEmbeddingErrorCode,
    message = 'Não foi possível gerar o embedding semântico.'
  ) {
    super(message);
    this.name = 'GeminiEmbeddingError';
    this.retryable = code === 'HTTP_ERROR' || code === 'TIMEOUT' || code === 'NETWORK_ERROR';
  }
}

export type GeminiOcrErrorCode =
  | 'MISSING_API_KEY'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR';

export class GeminiOcrError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: GeminiOcrErrorCode,
    message = 'Não foi possível executar o OCR do documento PDF.'
  ) {
    super(message);
    this.name = 'GeminiOcrError';
    this.retryable = code === 'HTTP_ERROR' || code === 'TIMEOUT' || code === 'NETWORK_ERROR';
  }
}

export interface PaginaOcrExtraida {
  numero: number;
  texto: string;
  confianca: number;
}

export const EXPECTED_EMBEDDING_DIMENSION = 1536;
export const DEFAULT_GEMINI_GENERATION_MODEL = 'gemini-2.5-flash';
export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GEMINI_TIMEOUT_MS = 30_000;
const GEMINI_EMBEDDING_TIMEOUT_MS = 20_000;
const GEMINI_OCR_TIMEOUT_MS = 45_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolverChaveGemini(explicitKey?: string): string | null {
  if (!explicitKey && !process.env.GEMINI_API_KEY && (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)) {
    console.warn('[gemini] provider_key_rejected');
  }
  const key = (explicitKey ?? process.env.GEMINI_API_KEY)?.trim();
  return key && key.length > 0 ? key : null;
}

function isArtefatosGerados(value: unknown): value is ArtefatosGerados {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ArtefatosGerados>;
  if (
    !candidate.resumo ||
    !isNonEmptyString(candidate.resumo.titulo) ||
    !isNonEmptyString(candidate.resumo.corpo) ||
    !Number.isFinite(candidate.resumo.tempoLeituraMin) ||
    !Array.isArray(candidate.flashcards) ||
    candidate.flashcards.length === 0 ||
    !Array.isArray(candidate.questoes) ||
    candidate.questoes.length === 0
  ) return false;

  return candidate.flashcards.every(
    item => isNonEmptyString(item?.pergunta) && isNonEmptyString(item?.resposta)
  ) && candidate.questoes.every(questao =>
    isNonEmptyString(questao?.enunciado) &&
    Array.isArray(questao?.alternativas) &&
    questao.alternativas.length > 0 &&
    questao.alternativas.every(
      alternativa => isNonEmptyString(alternativa?.letra) && isNonEmptyString(alternativa?.texto)
    ) &&
    isNonEmptyString(questao?.gabarito) &&
    isNonEmptyString(questao?.resolucao)
  );
}

/**
 * Gera artefatos exclusivamente pelo Gemini. Falhas reais nunca são substituídas
 * por conteúdo fictício. A exceção pública é categorizada e não contém detalhes
 * do provedor, credenciais ou payloads.
 */
export async function gerarArtefatosGemini(
  conteudoTexto: string,
  topicoNome: string
): Promise<ArtefatosGerados> {
  const apiKey = resolverChaveGemini();
  if (!apiKey) throw new GeminiGenerationError('MISSING_API_KEY');

  const prompt = `Você é um gerador de materiais didáticos de medicina. Com base no texto a seguir, gere:
1. Um resumo estruturado sobre o tópico "${topicoNome}".
2. 3 flashcards (pergunta e resposta ativa).
3. 2 questões de múltipla escolha (A, B, C, D, E) com enunciado, gabarito e resolução comentada.

Retorne EXCLUSIVAMENTE em formato JSON puro, seguindo este esquema exato:
{
  "resumo": { "titulo": "...", "corpo": "...", "tempoLeituraMin": 5 },
  "flashcards": [ { "pergunta": "...", "resposta": "..." } ],
  "questoes": [ { "enunciado": "...", "alternativas": [ {"letra": "A", "texto": "..."}, ... ], "gabarito": "A", "resolucao": "..." } ]
}

Texto base:\n${conteudoTexto}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[gemini] http_error status=${response.status}`);
      throw new GeminiGenerationError('HTTP_ERROR');
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new GeminiGenerationError('INVALID_RESPONSE');
    }

    const jsonText = (data as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
    })?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!isNonEmptyString(jsonText)) throw new GeminiGenerationError('INVALID_RESPONSE');

    let artefatos: unknown;
    try {
      artefatos = JSON.parse(jsonText);
    } catch {
      throw new GeminiGenerationError('INVALID_RESPONSE');
    }
    if (!isArtefatosGerados(artefatos)) throw new GeminiGenerationError('INVALID_RESPONSE');
    return artefatos;
  } catch (error) {
    if (error instanceof GeminiGenerationError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('[gemini] timeout');
      throw new GeminiGenerationError('TIMEOUT');
    }
    console.warn('[gemini] network_error');
    throw new GeminiGenerationError('NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Gera embedding semântico real via Google Gemini Embedding API (`gemini-embedding-001`),
 * validando estritamente a compatibilidade dimensional com `vector(1536)` e normalizando
 * o vetor resultante para busca por similaridade de cosseno.
 */
export async function gerarEmbeddingGemini(
  texto: string,
  opcoes?: {
    apiKey?: string;
    model?: string;
    expectedDimension?: number;
    timeoutMs?: number;
  }
): Promise<number[]> {
  const apiKey = resolverChaveGemini(opcoes?.apiKey);
  if (!apiKey) {
    throw new GeminiEmbeddingError('MISSING_API_KEY');
  }

  const textoLimpo = typeof texto === 'string' ? texto.trim() : '';
  if (!textoLimpo) {
    throw new GeminiEmbeddingError('EMPTY_INPUT', 'O texto para geração de embedding não pode ser vazio.');
  }

  const model = (opcoes?.model ?? process.env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_GEMINI_EMBEDDING_MODEL).trim();
  const expectedDimension = opcoes?.expectedDimension ?? EXPECTED_EMBEDDING_DIMENSION;
  const timeoutMs = opcoes?.timeoutMs ?? GEMINI_EMBEDDING_TIMEOUT_MS;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        model: `models/${model}`,
        content: {
          parts: [{ text: textoLimpo }],
        },
        outputDimensionality: expectedDimension,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[gemini.embedding] http_error status=${response.status}`);
      throw new GeminiEmbeddingError('HTTP_ERROR');
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new GeminiEmbeddingError('INVALID_RESPONSE');
    }

    const rawValues = (data as { embedding?: { values?: unknown } })?.embedding?.values;
    if (
      !Array.isArray(rawValues) ||
      rawValues.length === 0 ||
      !rawValues.every((v): v is number => typeof v === 'number' && Number.isFinite(v))
    ) {
      throw new GeminiEmbeddingError('INVALID_RESPONSE');
    }

    if (rawValues.length !== expectedDimension) {
      throw new GeminiEmbeddingError(
        'DIMENSION_MISMATCH',
        `Dimensão de embedding incompatível: esperado ${expectedDimension}, recebido ${rawValues.length}.`
      );
    }

    const magnitude = Math.sqrt(rawValues.reduce((acc, val) => acc + val * val, 0));
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
      throw new GeminiEmbeddingError('INVALID_RESPONSE', 'Vetor de embedding nulo ou degenerado.');
    }

    return rawValues.map((val) => val / magnitude);
  } catch (error) {
    if (error instanceof GeminiEmbeddingError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('[gemini.embedding] timeout');
      throw new GeminiEmbeddingError('TIMEOUT');
    }
    console.warn('[gemini.embedding] network_error');
    throw new GeminiEmbeddingError('NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Executa OCR multimodal em páginas digitalizadas de um PDF utilizando Gemini Vision.
 * Nunca inventa ou resume texto: páginas sem texto legível retornam `texto: ""`.
 */
export async function extrairTextoOcrGemini(
  pdfBuffer: Buffer,
  paginasAlvo?: readonly number[],
  opcoes?: {
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
  }
): Promise<PaginaOcrExtraida[]> {
  const apiKey = resolverChaveGemini(opcoes?.apiKey);
  if (!apiKey) {
    throw new GeminiOcrError('MISSING_API_KEY');
  }

  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.byteLength === 0) {
    throw new GeminiOcrError('INVALID_RESPONSE', 'Buffer PDF vazio para OCR.');
  }

  const model = (opcoes?.model ?? process.env.GEMINI_OCR_MODEL ?? DEFAULT_GEMINI_GENERATION_MODEL).trim();
  const timeoutMs = opcoes?.timeoutMs ?? GEMINI_OCR_TIMEOUT_MS;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const filtroPaginasTexto =
    paginasAlvo && paginasAlvo.length > 0
      ? `Extraia exclusivamente as páginas de número: ${paginasAlvo.join(', ')}.`
      : 'Extraia todas as páginas do documento na ordem exata.';

  const prompt = `Você é um motor de OCR literal para documentos acadêmicos em PDF.
${filtroPaginasTexto}
Regras obrigatórias:
1. Transcreva literalmente o texto visível em cada página, preservando a numeração 1-based original da página.
2. NÃO invente, não complete e não resuma nenhum conteúdo. Se uma página estiver em branco ou ilegível, retorne "texto": "" e "confianca": 0.
3. Retorne EXCLUSIVAMENTE um JSON válido no formato:
{
  "paginas": [
    { "numero": 1, "texto": "...", "confianca": 0.95 }
  ]
}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: 'application/pdf',
                  data: pdfBuffer.toString('base64'),
                },
              },
              { text: prompt },
            ],
          },
        ],
        generationConfig: { responseMimeType: 'application/json' },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[gemini.ocr] http_error status=${response.status}`);
      throw new GeminiOcrError('HTTP_ERROR');
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new GeminiOcrError('INVALID_RESPONSE');
    }

    const jsonText = (data as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
    })?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!isNonEmptyString(jsonText)) {
      throw new GeminiOcrError('INVALID_RESPONSE');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new GeminiOcrError('INVALID_RESPONSE');
    }

    const rawPaginas = (parsed as { paginas?: unknown })?.paginas;
    if (!Array.isArray(rawPaginas)) {
      throw new GeminiOcrError('INVALID_RESPONSE');
    }

    const paginasValidas: PaginaOcrExtraida[] = [];
    for (const item of rawPaginas) {
      if (!item || typeof item !== 'object') {
        throw new GeminiOcrError('INVALID_RESPONSE');
      }
      const candidato = item as { numero?: unknown; texto?: unknown; confianca?: unknown };
      if (
        typeof candidato.numero !== 'number' ||
        !Number.isInteger(candidato.numero) ||
        candidato.numero < 1 ||
        typeof candidato.texto !== 'string' ||
        typeof candidato.confianca !== 'number' ||
        !Number.isFinite(candidato.confianca)
      ) {
        throw new GeminiOcrError('INVALID_RESPONSE');
      }

      paginasValidas.push({
        numero: candidato.numero,
        texto: candidato.texto.trim(),
        confianca: Math.max(0, Math.min(1, candidato.confianca)),
      });
    }

    return paginasValidas.sort((a, b) => a.numero - b.numero);
  } catch (error) {
    if (error instanceof GeminiOcrError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('[gemini.ocr] timeout');
      throw new GeminiOcrError('TIMEOUT');
    }
    console.warn('[gemini.ocr] network_error');
    throw new GeminiOcrError('NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

/** @deprecated Use gerarArtefatosGemini. Mantido apenas para consumidores legados. */
export const gerarArtefatosGeminiComFallback = gerarArtefatosGemini;

/** Fixture determinística exclusiva para testes/demonstrações controladas. */
export function gerarMockArtefatos(conteudo: string, topico: string): ArtefatosGerados {
  const hash = crypto.createHash('sha256').update(conteudo).digest('hex').slice(0, 8);
  return {
    resumo: {
      titulo: `Resumo de demonstração: ${topico}`,
      corpo: `Conteúdo fictício para teste controlado. Referência determinística #${hash}.`,
      tempoLeituraMin: 1,
    },
    flashcards: [{ pergunta: `Pergunta de teste sobre ${topico}?`, resposta: 'Resposta fictícia de teste.' }],
    questoes: [{
      enunciado: `Questão fictícia de teste sobre ${topico}.`,
      alternativas: [{ letra: 'A', texto: 'Alternativa fictícia.' }],
      gabarito: 'A',
      resolucao: 'Resolução fictícia de teste.',
    }],
  };
}
