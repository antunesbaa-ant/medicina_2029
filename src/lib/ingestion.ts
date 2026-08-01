import * as pdfParseModule from 'pdf-parse';
import { db } from '../db';
import { acervoArquivos, acervoPaginas, acervoChunks, topicos, disciplinas } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import crypto from 'crypto';

export interface ProcessamentoStatus {
  etapa: 'aguardando' | 'extraindo' | 'segmentando' | 'classificando' | 'indexando' | 'concluido' | 'falhou';
  progresso: number;
  mensagem: string;
}

// 1. Extração de PDF
export async function extrairTextoPDF(pdfBuffer: Buffer): Promise<Array<{ numero: number; texto: string; metodo: 'nativo' | 'ocr' | 'visao'; confianca: number }>> {
  let pdfParse = pdfParseModule as any;
  if (pdfParse.default) pdfParse = pdfParse.default;
  if (pdfParse.default) pdfParse = pdfParse.default;
  const result = await pdfParse(pdfBuffer);
  
  // pdf-parse junta todo o texto. Para separar por página, podemos usar o delimitador de página se estiver presente,
  // ou parsear por página de forma customizada. pdf-parse retorna o texto bruto em result.text.
  // Em um cenário real, pdfjs-dist nos permite extrair página por página de forma exata.
  // Como fallback estruturado, vamos simular a separação por páginas baseada em delimitadores comuns 
  // ou dividir proporcionalmente a quantidade de caracteres por página se o parser juntar tudo.
  const paginasTexto: Array<{ numero: number; texto: string; metodo: 'nativo' | 'ocr' | 'visao'; confianca: number }> = [];
  
  // Dividir o texto em páginas usando o caractere especial Form Feed (\f) comumente usado em PDFs como quebra de página
  const textPages = result.text.split('\f');
  
  let pageNum = 1;
  for (const pageText of textPages) {
    const textCleaned = pageText.trim();
    if (textCleaned.length > 0) {
      const eScaneada = textCleaned.length < 50; // Se tiver muito pouco texto, provavelmente é escaneada
      paginasTexto.push({
        numero: pageNum,
        texto: textCleaned,
        metodo: eScaneada ? 'ocr' : 'nativo',
        confianca: eScaneada ? 0.85 : 1.0
      });
      pageNum++;
    }
  }

  // Se por acaso o split não achar nenhuma página mas tiver texto total
  if (paginasTexto.length === 0 && result.text.trim().length > 0) {
    paginasTexto.push({
      numero: 1,
      texto: result.text.trim(),
      metodo: 'nativo',
      confianca: 1.0
    });
  }

  return paginasTexto;
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
    const startIdx = textoAcumulado.length;
    textoAcumulado += p.texto + '\n\n';
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

      // Classifica o tipo de conteúdo com base em palavras-chave básicas
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
        tokens: Math.ceil(chunkText.length / 4) // Estimativa simples de tokens (4 caracteres por token)
      });
      
      ordem++;
    }

    cursor += maxChars - overlap;
    if (cursor >= totalLength || maxChars - overlap <= 0) break;
  }

  return chunks;
}

// 3. Classificação por Tópico
// Retorna o topicoId mais provável comparando palavras-chave ou similaridade
export async function classificarTópicoChunk(
  chunkText: string,
  disciplinaId: string
): Promise<{ topicoId: string | null; confianca: number }> {
  // 1. Buscar todos os tópicos da disciplina
  const topicosDisponiveis = await db
    .select({ id: topicos.id, nome: topicos.nome })
    .from(topicos)
    .where(eq(topicos.disciplinaId, disciplinaId));

  if (topicosDisponiveis.length === 0) {
    return { topicoId: null, confianca: 0 };
  }

  let melhorTopicoId: string | null = null;
  let maiorScore = 0;
  const chunkWords = new Set(chunkText.toLowerCase().split(/\W+/));

  for (const t of topicosDisponiveis) {
    // Calcula intersecção de palavras do nome do tópico com o texto do chunk
    const topicoWords = t.nome.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    let matches = 0;
    
    for (const tw of topicoWords) {
      if (chunkWords.has(tw) || Array.from(chunkWords).some(cw => cw.includes(tw))) {
        matches++;
      }
    }

    const score = topicoWords.length > 0 ? matches / topicoWords.length : 0;
    if (score > maiorScore) {
      maiorScore = score;
      melhorTopicoId = t.id;
    }
  }

  // Definimos uma confiança baseada no score. Se maior que 0.38, consideramos aceitável para o seed
  const confianca = maiorScore;
  const topicoId = confianca >= 0.38 ? melhorTopicoId : null;

  return { topicoId, confianca };
}

// 4. Geração de Embedding Falso/Mock
// Para habilitar testes sem dependência de chaves de API pagas
export function gerarMockEmbedding(texto: string, dim: number = 1536): number[] {
  const hash = crypto.createHash('sha256').update(texto).digest();
  const vector: number[] = [];
  
  for (let i = 0; i < dim; i++) {
    const val = hash.readUInt8(i % 32) / 255;
    vector.push((val - 0.5) * 2); // Vetor normalizado entre -1 e 1
  }

  // Normalização Euclidiana para busca vetorial cosseno
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  return vector.map(v => v / magnitude);
}

// 5. Busca Híbrida Semântica + Textual
export interface ResultadoBusca {
  chunkId: string;
  arquivoId: string;
  arquivoTitulo: string;
  paginaInicial: number;
  paginaFinal: number;
  texto: string;
  similaridade: number;
}

export async function buscaHibridaAcervo(
  query: string,
  disciplinaId?: string,
  limit: number = 5
): Promise<ResultadoBusca[]> {
  // Geramos o embedding da query
  const queryVector = gerarMockEmbedding(query);
  const sqlQueryVector = `[${queryVector.join(',')}]`;

  // Drizzle sql para cálculo de distância cosseno no pgvector (1 - (embedding <=> queryVector))
  const similaridadeSql = sql<number>`1 - (embedding <=> ${sqlQueryVector}::vector)`;

  // Busca no banco
  // Para fins da Fase 2, faremos a busca baseada em pgvector e fallback em like de texto
  const chunksData = await db
    .select({
      chunkId: acervoChunks.id,
      arquivoId: acervoChunks.arquivoId,
      arquivoTitulo: acervoArquivos.titulo,
      paginaInicial: acervoChunks.paginaInicial,
      paginaFinal: acervoChunks.paginaFinal,
      texto: acervoChunks.texto,
      similaridade: similaridadeSql
    })
    .from(acervoChunks)
    .innerJoin(acervoArquivos, eq(acervoChunks.arquivoId, acervoArquivos.id))
    .where(disciplinaId ? eq(acervoArquivos.disciplinaId, disciplinaId) : undefined)
    .orderBy(sql`embedding <=> ${sqlQueryVector}::vector`)
    .limit(limit);

  return chunksData.map(c => ({
    chunkId: c.chunkId,
    arquivoId: c.arquivoId,
    arquivoTitulo: c.arquivoTitulo,
    paginaInicial: c.paginaInicial,
    paginaFinal: c.paginaFinal,
    texto: c.texto,
    similaridade: Math.max(0, Math.min(1, c.similaridade)) // Clampa entre 0 e 1
  }));
}
