import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gerarArtefatosGeminiComFallback } from './gemini';

describe('Segurança de Provedores de IA — Google Gemini (F1.06)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('deve utilizar o gerador determinístico inteligente quando GEMINI_API_KEY estiver ausente', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const resultado = await gerarArtefatosGeminiComFallback('Texto de fisiologia celular', 'Citologia');

    expect(resultado).toBeDefined();
    expect(resultado.resumo.titulo).toContain('Citologia');
    expect(resultado.flashcards.length).toBe(3);
    expect(resultado.questoes.length).toBe(2);
    // Nenhum erro de vazamento ou crash
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('deve REJEITAR estritamente ANTHROPIC_API_KEY e não usá-la como credencial do Gemini', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-secret-key-12345';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const resultado = await gerarArtefatosGeminiComFallback('Texto de genética médica', 'Genética');

    // Não deve invocar fetch com a chave da Anthropic
    expect(fetchSpy).not.toHaveBeenCalled();

    // Deve emitir aviso de segurança explicitando a rejeição de chave cruzada
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0][0];
    expect(warnMsg).toContain('ANTHROPIC_API_KEY detectada no ambiente');
    expect(warnMsg).toContain('expressamente rejeitadas para o serviço Gemini');
    // A chave secreta real NUNCA pode constar na mensagem de log
    expect(warnMsg).not.toContain('sk-ant-test-secret-key-12345');

    // Deve retornar o mock determinístico de forma segura
    expect(resultado.resumo.titulo).toContain('Genética');
  });

  it('deve transmitir GEMINI_API_KEY exclusivamente via cabeçalho x-goog-api-key e nunca na URL', async () => {
    process.env.GEMINI_API_KEY = 'ai-gemini-legitimate-secret-key-abc';

    const mockResponseJson = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  resumo: { titulo: 'Resumo API', corpo: 'Corpo gerado por IA', tempoLeituraMin: 5 },
                  flashcards: [{ pergunta: 'P1?', resposta: 'R1.' }],
                  questoes: [{ enunciado: 'E1?', alternativas: [{ letra: 'A', texto: 'Alt A' }], gabarito: 'A', resolucao: 'Res A' }]
                })
              }
            ]
          }
        }
      ]
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponseJson
    } as Response);

    const resultado = await gerarArtefatosGeminiComFallback('Texto de anatomia', 'Anatomia');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [requestUrl, requestOptions] = fetchSpy.mock.calls[0];

    // A URL NÃO PODE conter a query string com a chave
    expect(requestUrl as string).not.toContain('key=');
    expect(requestUrl as string).not.toContain('ai-gemini-legitimate-secret-key-abc');

    // A chave deve constar exclusivamente no cabeçalho x-goog-api-key
    const headers = (requestOptions as RequestInit)?.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('ai-gemini-legitimate-secret-key-abc');

    expect(resultado.resumo.titulo).toBe('Resumo API');
  });

  it('não deve vazar segredos quando a API do Gemini retornar erro HTTP (ex: 401 ou 500)', async () => {
    process.env.GEMINI_API_KEY = 'ai-gemini-failing-secret-xyz';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized'
    } as Response);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const resultado = await gerarArtefatosGeminiComFallback('Texto patologia', 'Patologia');

    // Fallback seguro gerado com sucesso
    expect(resultado).toBeDefined();
    expect(resultado.resumo.titulo).toContain('Patologia');

    // Mensagens de log de erro nunca revelam a chave
    warnSpy.mock.calls.forEach((args) => {
      const msg = args.join(' ');
      expect(msg).not.toContain('ai-gemini-failing-secret-xyz');
    });
  });

  it('não deve vazar segredos quando fetch disparar exceção de rede', async () => {
    process.env.GEMINI_API_KEY = 'ai-gemini-network-error-key';

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Connection timeout to generativelanguage.googleapis.com'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const resultado = await gerarArtefatosGeminiComFallback('Texto imunologia', 'Imunologia');

    expect(resultado).toBeDefined();
    expect(resultado.resumo.titulo).toContain('Imunologia');

    warnSpy.mock.calls.forEach((args) => {
      const msg = args.join(' ');
      expect(msg).not.toContain('ai-gemini-network-error-key');
    });
  });
});
