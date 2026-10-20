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

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GEMINI_TIMEOUT_MS = 30_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
  if (!process.env.GEMINI_API_KEY && process.env.ANTHROPIC_API_KEY) {
    console.warn('[gemini] provider_key_rejected');
  }

  const apiKey = process.env.GEMINI_API_KEY;
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
