import * as pdfParseModule from 'pdf-parse';
import { db } from '../db';
import { acervoArquivos, acervoChunks, topicos } from '../db/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import crypto from 'crypto';
import {
  EXPECTED_EMBEDDING_DIMENSION,
  GeminiEmbeddingError,
  GeminiOcrError,
  extrairTextoOcrGemini,
  gerarEmbeddingGemini,
  type PaginaOcrExtraida,
} from './gemini';

export interface ProcessamentoStatus {
  etapa: 'aguardando' | 'extraindo' | 'segmentando' | 'classificando' | 'indexando' | 'concluido' | 'falhou';
  progresso: number;
  mensagem: string;
}

export interface PaginaExtraidaPDF {
  numero: number;
  texto: string;
  metodo: 'nativo' | 'ocr' | 'visao';
  confianca: number;
}

export interface OpcoesExtracaoPDF {
  /**
   * Provedor de OCR para páginas digitalizadas (sem texto nativo extraível).
   * Quando omitido, utiliza `extrairTextoOcrGemini` caso `GEMINI_API_KEY` esteja configurada.
   */
  executarOcrDocumento?: (
    pdfBuffer: Buffer,
    paginasAlvo: readonly number[]
  ) => Promise<PaginaOcrExtraida[]>;
  /**
   * Parser nativo opcional para injeção em testes.
   */
  parsePdfNativo?: (buffer: Buffer) => Promise<{ text: string; numpages?: number }>;
  /**
   * Quando false, desativa o acionamento automático de OCR por variável de ambiente.
   */
  habilitarOcrAutomatico?: boolean;
}

function resolverPdfParserPadrao(): (buffer: Buffer) => Promise<{ text: string; numpages?: number }> {
  type PdfParser = (buffer: Buffer) => Promise<{ text: string; numpages?: number }>;

  // 1. Suporte a pdf-parse v1 ou mock funcional com export default
  try {
    let pdfParse: unknown = pdfParseModule;
    for (let depth = 0; depth < 2 && typeof pdfParse !== 'function'; depth++) {
      pdfParse = (pdfParse as { default?: unknown })?.default;
    }
    if (typeof pdfParse === 'function') {
      return pdfParse as PdfParser;
    }
  } catch {
    // segue para avaliar classe de parser
  }

  // 2. Suporte a pdf-parse v2 (PDFParse class com Uint8Array)
  try {
    const mod = pdfParseModule as Record<string, unknown>;
    const candidateClass = mod['PDFParse'];
    if (typeof candidateClass === 'function') {
      return async (buffer: Buffer) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parser = new (candidateClass as any)(new Uint8Array(buffer));
        const result = await parser.getText();
        return {
          text: result.text ?? '',
          numpages: typeof result.total === 'number' ? result.total : (result.pages?.length ?? 1),
        };
      };
    }
  } catch {
    // vitest mock proxy ou classe indisponível
  }

  throw new Error('PDF parser indisponível.');
}

/**
 * 1. Extração de PDF Digital + OCR sob demanda para páginas digitalizadas.
 * - Preserva o número exato (1-based) de cada página do documento.
 * - Aciona OCR quando páginas não possuem camada de texto nativo e um provedor OCR está disponível.
 * - Nunca inventa texto quando uma página está em branco ou quando a extração/OCR falha.
 */
export async function extrairTextoPDF(
  pdfBuffer: Buffer,
  opcoes?: OpcoesExtracaoPDF
): Promise<PaginaExtraidaPDF[]> {
  const parser = opcoes?.parsePdfNativo ?? resolverPdfParserPadrao();
  const result = await parser(pdfBuffer);
  const rawText = typeof result?.text === 'string' ? result.text : '';

  const rawSegments = rawText.split('\f');
  // Remove o segmento vazio final produzido por quebra de página (\f) no fim do fluxo
  if (
    rawSegments.length > 1 &&
    rawSegments[rawSegments.length - 1]!.trim().length === 0 &&
    (result.numpages === undefined || rawSegments.length > result.numpages)
  ) {
    rawSegments.pop();
  }

  const totalPaginas = Math.max(
    typeof result.numpages === 'number' && result.numpages > 0 ? result.numpages : 0,
    rawSegments.length
  );

  const paginasPorNumero = new Map<number, PaginaExtraidaPDF>();
  const paginasSemTextoNativo: number[] = [];

  for (let idx = 0; idx < totalPaginas; idx++) {
    const numeroPagina = idx + 1;
    const textoNativo = (rawSegments[idx] ?? '').trim();

    if (textoNativo.length > 0) {
      paginasPorNumero.set(numeroPagina, {
        numero: numeroPagina,
        texto: textoNativo,
        metodo: 'nativo',
        confianca: textoNativo.length < 50 ? 0.5 : 1.0,
      });
    } else {
      paginasSemTextoNativo.push(numeroPagina);
    }
  }

  // Se houver páginas sem texto nativo (PDF digitalizado total ou parcial),
  // aciona o provedor de OCR configurado sem jamais fabricar texto em caso de falha.
  const provedorOcr =
    opcoes?.executarOcrDocumento ??
    (opcoes?.habilitarOcrAutomatico !== false && Boolean(process.env.GEMINI_API_KEY?.trim())
      ? (buf: Buffer, pags: readonly number[]) => extrairTextoOcrGemini(buf, pags)
      : null);

  if (paginasSemTextoNativo.length > 0 && provedorOcr) {
    const paginasOcr = await provedorOcr(pdfBuffer, paginasSemTextoNativo);
    const alvosSet = new Set(paginasSemTextoNativo);

    for (const ocrPag of paginasOcr) {
      if (!alvosSet.has(ocrPag.numero)) continue;
      const textoOcrLimpo = ocrPag.texto.trim();
      if (textoOcrLimpo.length > 0) {
        paginasPorNumero.set(ocrPag.numero, {
          numero: ocrPag.numero,
          texto: textoOcrLimpo,
          metodo: 'ocr',
          confianca: Math.max(0, Math.min(1, ocrPag.confianca)),
        });
      }
    }
  }

  // Fallback defensivo caso o parser nativo retorne texto sem delimitador \f e totalPaginas = 0
  if (paginasPorNumero.size === 0 && rawText.trim().length > 0) {
    paginasPorNumero.set(1, {
      numero: 1,
      texto: rawText.trim(),
      metodo: 'nativo',
      confianca: rawText.trim().length < 50 ? 0.5 : 1.0,
    });
  }

  return Array.from(paginasPorNumero.values()).sort((a, b) => a.numero - b.numero);
}

// 2. Segmentação Semântica
// Chunks de 500 a 1000 tokens (cerca de 2000 a 4000 caracteres) com ~15% de sobreposição
export interface ChunkSegmentado {
  paginaInicial: number;
  paginaFinal: number;
  ordem: number;
  texto: string;
  tipoConteudo: 'exposicao_teorica' | 'exemplo_resolvido' | 'questao' | 'exercicio' | 'definicao' | 'formula' | 'figura_legenda';
  tokens: number;
}

export function segmentarTexto(
  paginas: Array<{ numero: number; texto: string }>,
  maxChars: number = 3000,
  overlap: number = 450
): ChunkSegmentado[] {
  const chunks: ChunkSegmentado[] = [];
  let ordem = 1;

  // Junta o texto com marcações de página para poder rastrear onde cada trecho começa/termina
  let textoAcumulado = '';
  const mapaCaracteresPagina: Array<{ index: number; pagina: number }> = [];

  for (const p of paginas) {
    const textoPagina = p.texto.trim();
    if (!textoPagina) continue;

    const startIdx = textoAcumulado.length;
    textoAcumulado += textoPagina + '\n\n';
    const endIdx = textoAcumulado.length;

    for (let i = startIdx; i < endIdx; i++) {
      mapaCaracteresPagina.push({ index: i, pagina: p.numero });
    }
  }

  let cursor = 0;
  const totalLength = textoAcumulado.length;

  while (cursor < totalLength) {
    let end = Math.min(cursor + maxChars, totalLength);

    // Ajusta o final do chunk para uma quebra de linha ou parágrafo, respeitando os limites semânticos
    if (end < totalLength) {
      const ultimaQuebra = textoAcumulado.lastIndexOf('\n', end);
      if (ultimaQuebra > cursor + maxChars * 0.5) {
        end = ultimaQuebra;
      }
    }

    const chunkText = textoAcumulado.slice(cursor, end).trim();
    if (chunkText.length > 0) {
      // Determina a página inicial e final do chunk a partir do mapeamento de caracteres
      const pagInicial = mapaCaracteresPagina[cursor]?.pagina ?? 1;
      const pagFinal = mapaCaracteresPagina[Math.min(end - 1, totalLength - 1)]?.pagina ?? pagInicial;

      // Classifica o tipo de conteúdo com base em indicadores estruturais do trecho
      let tipoConteudo: ChunkSegmentado['tipoConteudo'] = 'exposicao_teorica';
      const textLower = chunkText.toLowerCase();
      if (textLower.includes('exercício') || textLower.includes('exercicios') || textLower.includes('questões')) {
        tipoConteudo = 'exercicio';
      } else if (textLower.includes('gabarito') || textLower.includes('resolução') || textLower.includes('exemplo')) {
        tipoConteudo = 'exemplo_resolvido';
      } else if (textLower.includes('fórmula') || textLower.includes('definimos') || textLower.includes('constante')) {
        tipoConteudo = 'formula';
      }

      chunks.push({
        paginaInicial: pagInicial,
        paginaFinal: pagFinal,
        ordem,
        texto: chunkText,
        tipoConteudo,
        tokens: Math.ceil(chunkText.length / 4),
      });

      ordem++;
    }

    cursor += maxChars - overlap;
    if (cursor >= totalLength || maxChars - overlap <= 0) break;
  }

  return chunks;
}

function normalizarTermos(texto: string): string[] {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
}

// 3. Classificação por Tópico
// Retorna o topicoId mais provável da disciplina verificando correspondência normalizada
export async function classificarTópicoChunk(
  chunkText: string,
  disciplinaId: string
): Promise<{ topicoId: string | null; confianca: number }> {
  const topicosDisponiveis = await db
    .select({ id: topicos.id, nome: topicos.nome })
    .from(topicos)
    .where(eq(topicos.disciplinaId, disciplinaId));

  if (topicosDisponiveis.length === 0) {
    return { topicoId: null, confianca: 0 };
  }

  let melhorTopicoId: string | null = null;
  let maiorScore = 0;
  const chunkWords = new Set(normalizarTermos(chunkText));
  const chunkWordsArray = Array.from(chunkWords);

  for (const t of topicosDisponiveis) {
    const topicoWords = normalizarTermos(t.nome);
    let matches = 0;

    for (const tw of topicoWords) {
      if (chunkWords.has(tw) || chunkWordsArray.some((cw) => cw.includes(tw) || tw.includes(cw))) {
        matches++;
      }
    }

    const score = topicoWords.length > 0 ? matches / topicoWords.length : 0;
    if (score > maiorScore) {
      maiorScore = score;
      melhorTopicoId = t.id;
    }
  }

  const confianca = maiorScore;
  const topicoId = confianca >= 0.38 ? melhorTopicoId : null;

  return { topicoId, confianca };
}

/**
 * 4. Provedor Real de Embeddings (1536 dimensões).
 * Nunca utiliza vetores hash ou simulados no runtime.
 */
export async function gerarEmbeddingReal(texto: string): Promise<number[]> {
  return gerarEmbeddingGemini(texto, { expectedDimension: EXPECTED_EMBEDDING_DIMENSION });
}

/**
 * Fixture determinística EXCLUSIVA para testes unitários sem chave de API.
 * Proibido o uso no runtime de ingestão ou busca.
 */
export function gerarMockEmbedding(texto: string, dim: number = EXPECTED_EMBEDDING_DIMENSION): number[] {
  const hash = crypto.createHash('sha256').update(texto).digest();
  const vector: number[] = [];

  for (let i = 0; i < dim; i++) {
    const val = hash.readUInt8(i % 32) / 255;
    vector.push((val - 0.5) * 2);
  }

  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  return vector.map((v) => v / magnitude);
}

// 5. Busca Híbrida Semântica + Textual com Proveniência e Controle de Acesso
export interface ResultadoBusca {
  chunkId: string;
  arquivoId: string;
  arquivoTitulo: string;
  autorFonte?: string | null;
  tipoMaterial?: string;
  disciplinaId?: string;
  topicoId?: string | null;
  paginaInicial: number;
  paginaFinal: number;
  ordem?: number;
  texto: string;
  similaridade: number;
  scoreVetorial?: number;
  scoreTextual?: number;
}

export class EmbeddingServiceUnavailableError extends Error {
  readonly code: string;

  constructor(code = 'EMBEDDING_UNAVAILABLE', message = 'O serviço de embeddings não está disponível.') {
    super(message);
    this.name = 'EmbeddingServiceUnavailableError';
    this.code = code;
  }
}

export interface OpcoesBuscaHibridaAcervo {
  papel?: 'estudante' | 'responsavel';
  perfilId?: string;
  minSimilaridade?: number;
  gerarEmbeddingQuery?: (query: string) => Promise<number[]>;
}

function serializarVetorPgvector(vetor: readonly number[]): string {
  if (
    !Array.isArray(vetor) ||
    vetor.length !== EXPECTED_EMBEDDING_DIMENSION ||
    !vetor.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    throw new EmbeddingServiceUnavailableError(
      'DIMENSION_MISMATCH',
      `Dimensão de embedding incompatível com vector(${EXPECTED_EMBEDDING_DIMENSION}).`
    );
  }
  return `[${vetor.map((v) => Number(v.toFixed(8))).join(',')}]`;
}

/**
 * Executa busca semântica vetorial + textual (`pgvector` <=> + `ts_rank_cd` em português)
 * sobre `acervo_chunks` e `acervo_arquivos`.
 * - Preserva filtros de autorização/ownership por perfil (`responsavel` ou `estudante` vinculado).
 * - Retorna proveniência completa (arquivo, fonte/autor, páginas inicial/final, trecho e pontuação).
 * - Diferencia ausência legítima de resultados (`[]`) de falha do provedor ou do banco.
 */
export async function buscaHibridaAcervo(
  query: string,
  disciplinaId?: string,
  limit: number = 5,
  opcoes?: OpcoesBuscaHibridaAcervo
): Promise<ResultadoBusca[]> {
  const queryLimpa = typeof query === 'string' ? query.trim() : '';
  if (!queryLimpa) {
    return [];
  }

  const gerarEmbeddingFn = opcoes?.gerarEmbeddingQuery ?? gerarEmbeddingReal;

  let queryVector: number[];
  try {
    queryVector = await gerarEmbeddingFn(queryLimpa);
  } catch (error) {
    if (error instanceof EmbeddingServiceUnavailableError) {
      throw error;
    }
    if (error instanceof GeminiEmbeddingError) {
      throw new EmbeddingServiceUnavailableError(error.code, error.message);
    }
    throw new EmbeddingServiceUnavailableError('EMBEDDING_PROVIDER_ERROR');
  }

  const vectorLiteral = serializarVetorPgvector(queryVector);
  const limiteSeguro = Math.max(1, Math.min(20, Math.trunc(limit) || 5));
  const minSimilaridade = opcoes?.minSimilaridade ?? 0.2;

  type LinhaBuscaRaw = {
    chunkId: string;
    arquivoId: string;
    arquivoTitulo: string;
    autorFonte: string | null;
    tipoMaterial: string;
    disciplinaId: string;
    topicoId: string | null;
    paginaInicial: number;
    paginaFinal: number;
    ordem: number;
    texto: string;
    scoreVetorial: number;
    scoreTextual: number;
    similaridade: number;
  };

  let linhas: LinhaBuscaRaw[];
  try {
    if (typeof db.transaction === 'function' && opcoes?.perfilId && opcoes?.papel) {
      linhas = await db.transaction(async (tx) => {
        try {
          await tx.execute(
            sql`SELECT medicina.set_context(${opcoes.perfilId}::uuid, ${opcoes.papel}::text);`
          );
        } catch {
          // Em ambientes sem a função medicina.set_context instalada, segue defensivamente
        }
        return await tx
          .select({
            chunkId: sql<string>`r.chunk_id`,
            arquivoId: sql<string>`r.arquivo_id`,
            arquivoTitulo: sql<string>`r.arquivo_titulo`,
            autorFonte: sql<string | null>`r.autor_fonte`,
            tipoMaterial: sql<string>`r.tipo_material`,
            disciplinaId: sql<string>`r.disciplina_id`,
            topicoId: sql<string | null>`r.topico_id`,
            paginaInicial: sql<number>`r.pagina_inicial`,
            paginaFinal: sql<number>`r.pagina_final`,
            ordem: sql<number>`r.ordem`,
            texto: sql<string>`r.texto`,
            scoreVetorial: sql<number>`r.score_vetorial`,
            scoreTextual: sql<number>`r.score_textual`,
            similaridade: sql<number>`r.similaridade`,
          })
          .from(
            sql`medicina.fn_busca_hibrida_acervo(
              ${queryLimpa}::text,
              ${vectorLiteral}::vector(1536),
              ${disciplinaId ?? null}::uuid,
              ${limiteSeguro}::integer,
              ${minSimilaridade}::double precision,
              ${opcoes?.papel ?? null}::text,
              ${opcoes?.perfilId ?? null}::uuid
            ) AS r`
          );
      });
    } else {
      linhas = await db
        .select({
          chunkId: sql<string>`r.chunk_id`,
          arquivoId: sql<string>`r.arquivo_id`,
          arquivoTitulo: sql<string>`r.arquivo_titulo`,
          autorFonte: sql<string | null>`r.autor_fonte`,
          tipoMaterial: sql<string>`r.tipo_material`,
          disciplinaId: sql<string>`r.disciplina_id`,
          topicoId: sql<string | null>`r.topico_id`,
          paginaInicial: sql<number>`r.pagina_inicial`,
          paginaFinal: sql<number>`r.pagina_final`,
          ordem: sql<number>`r.ordem`,
          texto: sql<string>`r.texto`,
          scoreVetorial: sql<number>`r.score_vetorial`,
          scoreTextual: sql<number>`r.score_textual`,
          similaridade: sql<number>`r.similaridade`,
        })
        .from(
          sql`medicina.fn_busca_hibrida_acervo(
            ${queryLimpa}::text,
            ${vectorLiteral}::vector(1536),
            ${disciplinaId ?? null}::uuid,
            ${limiteSeguro}::integer,
            ${minSimilaridade}::double precision,
            ${opcoes?.papel ?? null}::text,
            ${opcoes?.perfilId ?? null}::uuid
          ) AS r`
        );
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error ?? '');
    const fnMissing =
      /fn_busca_hibrida_acervo/i.test(errMsg) &&
      (/does not exist|não existe|42883|3F000/i.test(errMsg) ||
        (error as { code?: string })?.code === '42883' ||
        (error as { code?: string })?.code === '3F000');

    if (!fnMissing) {
      throw error;
    }

    const scoreVetorialExpr = sql<number>`GREATEST(0, LEAST(1, 1 - (${acervoChunks.embedding} <=> ${vectorLiteral}::vector)))`;
    const scoreTextualExpr = sql<number>`LEAST(1, ts_rank_cd(to_tsvector('portuguese', ${acervoChunks.texto}), plainto_tsquery('portuguese', ${queryLimpa})))`;
    const similaridadeHibridaExpr = sql<number>`LEAST(1, (${scoreVetorialExpr}) * 0.85 + (${scoreTextualExpr}) * 0.15)`;

    const filtroOwnership =
      opcoes?.papel === 'responsavel' && opcoes.perfilId
        ? eq(acervoArquivos.enviadoPor, opcoes.perfilId)
        : opcoes?.papel === 'estudante' && opcoes.perfilId
          ? sql`EXISTS (
              SELECT 1
                FROM public.responsavel_estudante re
               WHERE re.estudante_perfil_id = ${opcoes.perfilId}::uuid
                 AND re.responsavel_perfil_id = ${acervoArquivos.enviadoPor}
            )`
          : undefined;

    linhas = await db
      .select({
        chunkId: acervoChunks.id,
        arquivoId: acervoArquivos.id,
        arquivoTitulo: acervoArquivos.titulo,
        autorFonte: acervoArquivos.autorFonte,
        tipoMaterial: acervoArquivos.tipoMaterial,
        disciplinaId: acervoArquivos.disciplinaId,
        topicoId: acervoChunks.topicoId,
        paginaInicial: acervoChunks.paginaInicial,
        paginaFinal: acervoChunks.paginaFinal,
        ordem: acervoChunks.ordem,
        texto: acervoChunks.texto,
        scoreVetorial: scoreVetorialExpr,
        scoreTextual: scoreTextualExpr,
        similaridade: similaridadeHibridaExpr,
      })
      .from(acervoChunks)
      .innerJoin(acervoArquivos, eq(acervoChunks.arquivoId, acervoArquivos.id))
      .where(
        and(
          isNotNull(acervoChunks.embedding),
          eq(acervoArquivos.statusProcessamento, 'concluido'),
          disciplinaId ? eq(acervoArquivos.disciplinaId, disciplinaId) : undefined,
          filtroOwnership,
          sql`(${similaridadeHibridaExpr}) >= ${minSimilaridade}`
        )
      )
      .orderBy(
        sql`${similaridadeHibridaExpr} DESC`,
        sql`${scoreVetorialExpr} DESC`,
        acervoChunks.ordem
      )
      .limit(limiteSeguro);
  }

  return linhas.map((row) => ({
    chunkId: row.chunkId,
    arquivoId: row.arquivoId,
    arquivoTitulo: row.arquivoTitulo,
    autorFonte: row.autorFonte ?? null,
    tipoMaterial: row.tipoMaterial,
    disciplinaId: row.disciplinaId,
    topicoId: row.topicoId ?? null,
    paginaInicial: Number(row.paginaInicial),
    paginaFinal: Number(row.paginaFinal),
    ordem: Number(row.ordem),
    texto: row.texto,
    similaridade: Number(row.similaridade),
    scoreVetorial: Number(row.scoreVetorial),
    scoreTextual: Number(row.scoreTextual),
  }));
}

export { GeminiEmbeddingError, GeminiOcrError, EXPECTED_EMBEDDING_DIMENSION };
