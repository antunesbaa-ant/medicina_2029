'use server';

import { db } from '../../db';
import { acervoArquivos, acervoPaginas, acervoChunks, disciplinas } from '../../db/schema';
import { and, eq } from 'drizzle-orm';
import { extrairTextoPDF, segmentarTexto, classificarTópicoChunk } from '../../lib/ingestion';
import crypto from 'crypto';
import { uploadToSupabaseStorage } from '../../lib/supabaseStorage';
import { requireAuthenticatedProfile, requireRole } from '../../lib/authorization';
import {
  logOperationalFailure,
  operationFailure,
  operationSuccess,
  type OperationResult,
} from '../../lib/operation-result';

export interface UploadConfirmado {
  arquivoId: string;
  uploadStatus: 'concluido';
  processamentoStatus: 'aguardando';
  mensagem: string;
}

// 1. Enviar e Processar Arquivo (Pipeline completo)
export async function enviarArquivo(
  disciplinaId: string,
  titulo: string,
  tipoMaterial: 'livro' | 'apostila' | 'slide' | 'lista_exercicios' | 'anotacao_aula' | 'prova_oficial' | 'resumo_proprio' | 'outro',
  serieAlvo: number,
  vestibular: string,
  nomeArquivo: string,
  base64Data: string // Recebe em base64 para facilitar trânsito
): Promise<OperationResult<UploadConfirmado>> {
  const perfil = await requireRole('responsavel');

  try {
    const fileBuffer = Buffer.from(base64Data, 'base64');
    if (fileBuffer.length === 0) {
      return operationFailure('VALIDATION_ERROR', 'O arquivo enviado está vazio ou inválido.');
    }
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Verificar se já existe um arquivo com esse hash (Deduplicação)
    const arquivosExistentes = await db
      .select({ id: acervoArquivos.id })
      .from(acervoArquivos)
      .where(eq(acervoArquivos.hashConteudo, hash))
      .limit(1);

    if (arquivosExistentes.length > 0) {
      return operationFailure('CONFLICT', 'Este arquivo já foi enviado anteriormente.');
    }

    const filePath = `acervo/${hash}_${nomeArquivo}`;

    try {
      await uploadToSupabaseStorage(filePath, fileBuffer, 'application/pdf');
    } catch {
      logOperationalFailure('acervo.upload.storage', 'external_service');
      return operationFailure(
        'EXTERNAL_SERVICE_ERROR',
        'Não foi possível armazenar o arquivo. Nenhum processamento foi iniciado.'
      );
    }

    let novoArquivo: { id: string } | undefined;
    try {
      [novoArquivo] = await db
        .insert(acervoArquivos)
        .values({
          disciplinaId,
          titulo,
          tipoMaterial,
          serieAlvo,
          vestibular,
          filePath,
          mime: 'application/pdf',
          tamanhoBytes: fileBuffer.length,
          enviadoPor: perfil.id,
          statusProcessamento: 'aguardando',
          hashConteudo: hash
        })
        .returning({ id: acervoArquivos.id });
    } catch {
      logOperationalFailure('acervo.upload.metadata', 'persistence');
      return operationFailure(
        'PERSISTENCE_ERROR',
        'O arquivo foi armazenado, mas o cadastro não foi concluído. Não reenvie antes de verificar o acervo.'
      );
    }

    if (!novoArquivo) {
      logOperationalFailure('acervo.upload.metadata_missing', 'persistence');
      return operationFailure(
        'PERSISTENCE_ERROR',
        'O arquivo foi armazenado, mas o cadastro não foi confirmado. Não reenvie antes de verificar o acervo.'
      );
    }

    // Execução efêmera preservada até a F1.11; o retorno confirma somente upload e metadados.
    void processarArquivoPipeline(novoArquivo.id, fileBuffer).catch(() => {
      logOperationalFailure('acervo.pipeline.unhandled', 'internal');
    });

    return operationSuccess({
      arquivoId: novoArquivo.id,
      uploadStatus: 'concluido',
      processamentoStatus: 'aguardando',
      mensagem: 'Upload confirmado. O processamento está pendente e pode ser acompanhado no acervo.',
    });
  } catch {
    logOperationalFailure('acervo.upload', 'persistence');
    return operationFailure('PERSISTENCE_ERROR', 'Não foi possível concluir o envio do arquivo.');
  }
}

// 2. Execução Sequencial do Pipeline de Ingestão
async function processarArquivoPipeline(arquivoId: string, fileBuffer: Buffer) {
  try {
    // Passo 1: Extraindo
    const [extraindo] = await db
      .update(acervoArquivos)
      .set({ statusProcessamento: 'extraindo' })
      .where(eq(acervoArquivos.id, arquivoId))
      .returning({ id: acervoArquivos.id });
    if (!extraindo) throw new Error('status_update_not_confirmed');

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
    const [segmentando] = await db
      .update(acervoArquivos)
      .set({ 
        statusProcessamento: 'segmentando',
        paginas: paginas.length 
      })
      .where(eq(acervoArquivos.id, arquivoId))
      .returning({ id: acervoArquivos.id });
    if (!segmentando) throw new Error('status_update_not_confirmed');

    const chunks = segmentarTexto(paginas);

    // Passo 3: Classificando e Indexando
    // Buscamos o arquivo para obter a disciplinaId
    const [arquivo] = await db
      .select({ disciplinaId: acervoArquivos.disciplinaId })
      .from(acervoArquivos)
      .where(eq(acervoArquivos.id, arquivoId))
      .limit(1);

    if (!arquivo) throw new Error('source_file_not_found');

    const [classificando] = await db
      .update(acervoArquivos)
      .set({ statusProcessamento: 'classificando' })
      .where(eq(acervoArquivos.id, arquivoId))
      .returning({ id: acervoArquivos.id });
    if (!classificando) throw new Error('status_update_not_confirmed');

    for (const chunk of chunks) {
      // Classificação
      const { topicoId, confianca } = await classificarTópicoChunk(chunk.texto, arquivo.disciplinaId);

      await db.insert(acervoChunks).values({
        arquivoId,
        paginaInicial: chunk.paginaInicial,
        paginaFinal: chunk.paginaFinal,
        ordem: chunk.ordem,
        texto: chunk.texto,
        tipoConteudo: chunk.tipoConteudo,
        topicoId,
        confiancaClassificacao: confianca,
        // Embeddings fictícios não são persistidos como índices reais.
        embedding: null,
        tokens: chunk.tokens
      });
    }

    const [indexando] = await db
      .update(acervoArquivos)
      .set({ statusProcessamento: 'indexando' })
      .where(eq(acervoArquivos.id, arquivoId))
      .returning({ id: acervoArquivos.id });
    if (!indexando) throw new Error('status_update_not_confirmed');

    // Não existe provedor real de embeddings neste estágio. Concluir seria falso sucesso.
    throw new Error('embedding_provider_not_configured');

  } catch {
    logOperationalFailure('acervo.pipeline', 'persistence');
    try {
      await db
        .update(acervoArquivos)
        .set({
          statusProcessamento: 'falhou',
          erroProcessamento: 'O processamento não foi concluído. Tente novamente quando o serviço estiver disponível.'
        })
        .where(eq(acervoArquivos.id, arquivoId));
    } catch {
      logOperationalFailure('acervo.pipeline.failure_status', 'persistence');
    }
  }
}

// 3. Obter status do arquivo
export async function obterAcervoStatus(arquivoId: string) {
  const perfil = await requireRole('responsavel');

  const [arquivo] = await db
    .select()
    .from(acervoArquivos)
    .where(and(
      eq(acervoArquivos.id, arquivoId),
      eq(acervoArquivos.enviadoPor, perfil.id)
    ))
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
  const perfil = await requireRole('responsavel');

  return await db
    .select()
    .from(acervoArquivos)
    .where(and(
      eq(acervoArquivos.enviadoPor, perfil.id),
      disciplinaId ? eq(acervoArquivos.disciplinaId, disciplinaId) : undefined
    ))
    .orderBy(acervoArquivos.enviadoEm);
}

// 5. Obter todas as disciplinas
export async function listarDisciplinas() {
  await requireAuthenticatedProfile();

  return await db
    .select({ id: disciplinas.id, nome: disciplinas.nome })
    .from(disciplinas)
    .orderBy(disciplinas.ordem);
}
