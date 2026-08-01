'use server';

import { db } from '../../db';
import { acervoArquivos, acervoPaginas, acervoChunks } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { extrairTextoPDF, segmentarTexto, classificarTópicoChunk, gerarMockEmbedding } from '../../lib/ingestion';
import crypto from 'crypto';

export interface UploadResultado {
  sucesso: boolean;
  mensagem: string;
  arquivoId?: string;
  duplicado?: boolean;
}

// 1. Enviar e Processar Arquivo (Pipeline completo)
export async function enviarArquivo(
  disciplinaId: string,
  titulo: string,
  tipoMaterial: 'livro' | 'apostila' | 'slide' | 'lista_exercicios' | 'anotacao_aula' | 'prova_oficial' | 'resumo_proprio' | 'outro',
  serieAlvo: number,
  nomeArquivo: string,
  base64Data: string, // Recebe em base64 para facilitar trânsito
  perfilId: string
): Promise<UploadResultado> {
  try {
    const fileBuffer = Buffer.from(base64Data, 'base64');
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Verificar se já existe um arquivo com esse hash (Deduplicação)
    const arquivosExistentes = await db
      .select({ id: acervoArquivos.id })
      .from(acervoArquivos)
      .where(eq(acervoArquivos.hashConteudo, hash))
      .limit(1);

    if (arquivosExistentes.length > 0) {
      return {
        sucesso: false,
        mensagem: 'Este arquivo já foi enviado anteriormente (duplicado).',
        arquivoId: arquivosExistentes[0].id,
        duplicado: true
      };
    }

    // Inserir registro com status inicial 'aguardando'
    const filePath = `/storage/acervo/${hash}_${nomeArquivo}`;
    const [novoArquivo] = await db
      .insert(acervoArquivos)
      .values({
        disciplinaId,
        titulo,
        tipoMaterial,
        serieAlvo,
        filePath,
        mime: 'application/pdf',
        tamanhoBytes: fileBuffer.length,
        enviadoPor: perfilId,
        statusProcessamento: 'aguardando',
        hashConteudo: hash
      })
      .returning();

    // Processamento em Background (simulado em Promise para não travar a requisição)
    processarArquivoPipeline(novoArquivo.id, fileBuffer).catch(err => {
      console.error(`Erro no pipeline do arquivo ${novoArquivo.id}:`, err);
    });

    return {
      sucesso: true,
      mensagem: 'Arquivo enviado com sucesso. Processamento iniciado na fila.',
      arquivoId: novoArquivo.id
    };
  } catch (error: any) {
    console.error('Erro no upload de arquivo:', error);
    return {
      sucesso: false,
      mensagem: error.message || 'Erro interno ao fazer upload do arquivo.'
    };
  }
}

// 2. Execução Sequencial do Pipeline de Ingestão
async function processarArquivoPipeline(arquivoId: string, fileBuffer: Buffer) {
  try {
    // Passo 1: Extraindo
    await db
      .update(acervoArquivos)
      .set({ statusProcessamento: 'extraindo' })
      .where(eq(acervoArquivos.id, arquivoId));

    const paginas = await extrairTextoPDF(fileBuffer);

    // Salvar páginas
    for (const p of paginas) {
      await db.insert(acervoPaginas).values({
        arquivoId,
        numero: p.numero,
        textoExtraido: p.texto,
        metodoExtracao: p.metodo,
        confiancaOcr: p.confianca
      });
    }

    // Passo 2: Segmentando
    await db
      .update(acervoArquivos)
      .set({ 
        statusProcessamento: 'segmentando',
        paginas: paginas.length 
      })
      .where(eq(acervoArquivos.id, arquivoId));

    const chunks = segmentarTexto(paginas);

    // Passo 3: Classificando e Indexando
    // Buscamos o arquivo para obter a disciplinaId
    const [arquivo] = await db
      .select({ disciplinaId: acervoArquivos.disciplinaId })
      .from(acervoArquivos)
      .where(eq(acervoArquivos.id, arquivoId))
      .limit(1);

    await db
      .update(acervoArquivos)
      .set({ statusProcessamento: 'classificando' })
      .where(eq(acervoArquivos.id, arquivoId));

    for (const chunk of chunks) {
      // Classificação
      const { topicoId, confianca } = await classificarTópicoChunk(chunk.texto, arquivo?.disciplinaId || 'default-id');

      // Embedding
      const embedding = gerarMockEmbedding(chunk.texto);

      await db.insert(acervoChunks).values({
        arquivoId,
        paginaInicial: chunk.paginaInicial,
        paginaFinal: chunk.paginaFinal,
        ordem: chunk.ordem,
        texto: chunk.texto,
        tipoConteudo: chunk.tipoConteudo,
        topicoId,
        confiancaClassificacao: confianca,
        embedding,
        tokens: chunk.tokens
      });
    }

    // Concluído
    await db
      .update(acervoArquivos)
      .set({ statusProcessamento: 'concluido' })
      .where(eq(acervoArquivos.id, arquivoId));

  } catch (error: any) {
    console.error(`Erro no pipeline para o arquivo ${arquivoId}:`, error);
    await db
      .update(acervoArquivos)
      .set({ 
        statusProcessamento: 'falhou',
        erroProcessamento: error.message || 'Erro desconhecido'
      })
      .where(eq(acervoArquivos.id, arquivoId));
  }
}

// 3. Obter status do arquivo
export async function obterAcervoStatus(arquivoId: string) {
  const [arquivo] = await db
    .select()
    .from(acervoArquivos)
    .where(eq(acervoArquivos.id, arquivoId))
    .limit(1);

  if (!arquivo) return null;

  const paginasDb = await db
    .select({ numero: acervoPaginas.numero, textoExtraido: acervoPaginas.textoExtraido })
    .from(acervoPaginas)
    .where(eq(acervoPaginas.arquivoId, arquivoId))
    .orderBy(acervoPaginas.numero);

  return {
    ...arquivo,
    paginasLista: paginasDb
  };
}

// 4. Listar arquivos do acervo
export async function listarArquivosAcervo(disciplinaId?: string) {
  return await db
    .select()
    .from(acervoArquivos)
    .where(disciplinaId ? eq(acervoArquivos.disciplinaId, disciplinaId) : undefined)
    .orderBy(acervoArquivos.enviadoEm);
}
