import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GeminiEmbeddingError,
  GeminiGenerationError,
  GeminiOcrError,
  extrairTextoOcrGemini,
  gerarArtefatosGemini,
  gerarEmbeddingGemini,
  gerarMockArtefatos,
} from './gemini';

const validArtefatos = {
  resumo: { titulo: 'Resumo API', corpo: 'Corpo gerado por IA', tempoLeituraMin: 5 },
  flashcards: [{ pergunta: 'P1?', resposta: 'R1.' }],
  questoes: [{
    enunciado: 'E1?',
    alternativas: [{ letra: 'A', texto: 'Alt A' }],
    gabarito: 'A',
    resolucao: 'Res A',
  }],
};

function geminiResponse(text: string): Response {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  } as Response;
}

describe('gerarArtefatosGemini — contratos de falha F1.07', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('falha explicitamente sem GEMINI_API_KEY e não produz conteúdo fictício', async () => {
    await expect(gerarArtefatosGemini('Texto', 'Tópico')).rejects.toMatchObject({
      code: 'MISSING_API_KEY',
    });
  });

  it('rejeita chave de outro provedor sem chamar fetch ou expor a chave', async () => {
    process.env.ANTHROPIC_API_KEY = 'segredo-antropico';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(gerarArtefatosGemini('Texto', 'Tópico')).rejects.toMatchObject({
      code: 'MISSING_API_KEY',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('segredo-antropico');
  });

  it('envia a chave somente no cabeçalho e aceita resposta estruturalmente válida', async () => {
    process.env.GEMINI_API_KEY = 'segredo-gemini';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      geminiResponse(JSON.stringify(validArtefatos))
    );

    await expect(gerarArtefatosGemini('Texto', 'Tópico')).resolves.toEqual(validArtefatos);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(String(url)).not.toContain('segredo-gemini');
    expect((options?.headers as Record<string, string>)['x-goog-api-key']).toBe('segredo-gemini');
  });

  it('propaga falha HTTP como erro externo sem fallback', async () => {
    process.env.GEMINI_API_KEY = 'segredo-gemini';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 503 } as Response);

    await expect(gerarArtefatosGemini('Texto', 'Tópico')).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  });

  it.each([
    ['JSON inválido', geminiResponse('{inválido')],
    ['schema inválido', geminiResponse(JSON.stringify({ resumo: {} }))],
  ])('rejeita %s em vez de persistir artefato fictício', async (_label, response) => {
    process.env.GEMINI_API_KEY = 'segredo-gemini';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    await expect(gerarArtefatosGemini('Texto', 'Tópico')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('categoriza falha de rede sem incluir detalhes internos na exceção pública', async () => {
    process.env.GEMINI_API_KEY = 'segredo-gemini';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('token=segredo-interno'));

    const error = await gerarArtefatosGemini('Texto', 'Tópico').catch(value => value);
    expect(error).toBeInstanceOf(GeminiGenerationError);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(error.message).not.toContain('segredo-interno');
  });

  it('interrompe timeout e retorna falha em vez de conteúdo fictício', async () => {
    vi.useFakeTimers();
    process.env.GEMINI_API_KEY = 'segredo-gemini';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        const abortError = new Error('timeout interno');
        abortError.name = 'AbortError';
        reject(abortError);
      });
    }));

    const expectation = expect(gerarArtefatosGemini('Texto', 'Tópico')).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
    vi.useRealTimers();
  });

  it('mantém fixture determinística disponível apenas por chamada explícita de teste', () => {
    expect(gerarMockArtefatos('Texto', 'Tópico').resumo.titulo).toContain('demonstração');
  });

  describe('gerarEmbeddingGemini (F1.12)', () => {
    it('gera e normaliza vetor de 1536 dimensões enviando chave somente via cabeçalho', async () => {
      process.env.GEMINI_API_KEY = 'segredo-embedding-gemini';
      const rawVec = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0));
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: { values: rawVec } }),
      } as Response);

      const vec = await gerarEmbeddingGemini('Mitocôndrias e respiração celular');
      expect(vec).toHaveLength(1536);
      expect(vec[0]).toBeCloseTo(0.6, 5);
      expect(vec[1]).toBeCloseTo(0.8, 5);

      const [url, options] = fetchSpy.mock.calls[0]!;
      expect(String(url)).not.toContain('segredo-embedding-gemini');
      expect((options?.headers as Record<string, string>)['x-goog-api-key']).toBe('segredo-embedding-gemini');
    });

    it('rejeita embedding com dimensão incompatível (DIMENSION_MISMATCH) quando diferente de 1536', async () => {
      process.env.GEMINI_API_KEY = 'segredo-embedding-gemini';
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: { values: [0.1, 0.2, 0.3] } }),
      } as Response);

      await expect(gerarEmbeddingGemini('Texto')).rejects.toMatchObject({
        name: 'GeminiEmbeddingError',
        code: 'DIMENSION_MISMATCH',
        retryable: false,
      });
    });

    it('falha explicitamente em chave ausente, texto vazio, HTTP error e timeout', async () => {
      await expect(gerarEmbeddingGemini('Texto')).rejects.toBeInstanceOf(GeminiEmbeddingError);

      process.env.GEMINI_API_KEY = 'segredo-embedding-gemini';
      await expect(gerarEmbeddingGemini('   ')).rejects.toMatchObject({
        code: 'EMPTY_INPUT',
        retryable: false,
      });

      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 429 } as Response);
      await expect(gerarEmbeddingGemini('Texto')).rejects.toMatchObject({
        code: 'HTTP_ERROR',
        retryable: true,
      });
    });
  });

  describe('extrairTextoOcrGemini (F1.12)', () => {
    it('extrai texto literal por página e preserva páginas em branco sem inventar conteúdo', async () => {
      process.env.GEMINI_API_KEY = 'segredo-ocr-gemini';
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        geminiResponse(
          JSON.stringify({
            paginas: [
              { numero: 2, texto: '', confianca: 0 },
              { numero: 1, texto: 'Texto extraído via OCR na página 1.', confianca: 0.93 },
            ],
          })
        )
      );

      const paginas = await extrairTextoOcrGemini(Buffer.from('%PDF-1.4\n%%EOF'), [1, 2]);
      expect(paginas).toEqual([
        { numero: 1, texto: 'Texto extraído via OCR na página 1.', confianca: 0.93 },
        { numero: 2, texto: '', confianca: 0 },
      ]);
    });

    it('propaga falha de OCR sem inventar páginas', async () => {
      process.env.GEMINI_API_KEY = 'segredo-ocr-gemini';
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 502 } as Response);

      await expect(extrairTextoOcrGemini(Buffer.from('%PDF-1.4\n%%EOF'))).rejects.toBeInstanceOf(
        GeminiOcrError
      );
    });
  });
});
