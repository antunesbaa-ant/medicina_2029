'use server';

import { db } from '../../db';
import { acervoArquivos, acervoPaginas, disciplinas } from '../../db/schema';
import { and, eq } from 'drizzle-orm';
import crypto from 'crypto';
import {
  DEFAULT_SIGNED_URL_SECONDS,
  MAX_SIGNED_URL_SECONDS,
  MIN_SIGNED_URL_SECONDS,
  StorageOperationError,
  downloadFromSupabaseStorage,
  obterUrlAssinadaSupabase,
  uploadToSupabaseStorage,
} from '../../lib/supabaseStorage';
import {
  buildDeterministicAcervoStoragePath,
  reconciliarSnapshotsAcervo,
  type ObjetoStorageSnapshot,
  type RelatorioReconciliacaoAcervo,
} from '../../lib/acervoReconciliacao';
import {
  acervoJobs,
  enfileirarJobIngestaoAcervo,
  reenfileirarJobAcervoDoResponsavel,
  type EtapaJobAcervo,
  type JobAcervoSnapshot,
  type StatusJobAcervo,
} from '../../lib/acervoPipelineWorker';
import { requireAuthenticatedProfile, requireRole } from '../../lib/authorization';
import {
  logOperationalFailure,
  operationFailure,
  operationSuccess,
  type OperationResult,
} from '../../lib/operation-result';
import { enviarArquivoInputSchema, v } from '../../lib/validation';

export interface UploadConfirmado {
  arquivoId: string;
  uploadStatus: 'concluido';
  processamentoStatus: 'aguardando';
  mensagem: string;
  reconciliacao?: 'novo_upload' | 'objeto_existente_adotado';
}

export interface UrlAssinadaAcervoConfirmada {
  arquivoId: string;
  signedUrl: string;
  expiraEmSegundos: number;
}

export interface JobAcervoConfirmado {
  jobId: string;
  arquivoId: string;
  status: StatusJobAcervo;
  etapaAtual: EtapaJobAcervo;
}

type TipoMaterialAcervo =
  | 'livro'
  | 'apostila'
  | 'slide'
  | 'lista_exercicios'
  | 'anotacao_aula'
  | 'prova_oficial'
  | 'resumo_proprio'
  | 'outro';

function isPostgresUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const pgErr = error as { code?: string; message?: string };
  return pgErr.code === '23505' || /duplicate key value violates unique constraint/i.test(pgErr.message ?? '');
}

// 1. Enviar Arquivo e Enfileirar Job Durável (sem Promise solta / sem fallback efêmero)
export async function enviarArquivo(
  disciplinaId: string,
  titulo: string,
  tipoMaterial: TipoMaterialAcervo,
  serieAlvo: number,
  vestibular: string,
  nomeArquivo: string,
  base64DataOuBinario: string | Buffer | Uint8Array | ArrayBuffer
): Promise<OperationResult<UploadConfirmado>> {
  const perfil = await requireRole('responsavel');

  const uploadPayload =
    typeof base64DataOuBinario === 'string'
      ? { nomeArquivo, base64Data: base64DataOuBinario }
      : { nomeArquivo, fileData: base64DataOuBinario };

  const validacao = enviarArquivoInputSchema.safeParse({
    disciplinaId,
    titulo,
    tipoMaterial,
    serieAlvo,
    vestibular,
    upload: uploadPayload,
  });
  if (!validacao.ok) {
    return operationFailure('VALIDATION_ERROR', validacao.message);
  }

  const {
    disciplinaId: disciplinaIdValida,
    titulo: tituloValido,
    tipoMaterial: tipoMaterialValido,
    serieAlvo: serieAlvoValida,
    vestibular: vestibularValido,
    upload: { fileBuffer },
  } = validacao.data;

  try {
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Verificar se já existe um arquivo com esse hash no banco (Deduplicação sem tocar objetos existentes)
    const arquivosExistentes = await db
      .select({ id: acervoArquivos.id })
      .from(acervoArquivos)
      .where(eq(acervoArquivos.hashConteudo, hash))
      .limit(1);

    if (arquivosExistentes.length > 0) {
      return operationFailure('CONFLICT', 'Este arquivo já foi enviado anteriormente.');
    }

    // Chave canônica e determinística baseada exclusivamente no hash SHA-256 do conteúdo validado
    const filePath = buildDeterministicAcervoStoragePath(hash);
    let reutilizouObjetoExistente = false;

    try {
      const storagePath = await uploadToSupabaseStorage(filePath, fileBuffer, 'application/pdf', {
        upsert: false,
      });
      if (!storagePath || typeof storagePath !== 'string') {
        logOperationalFailure('acervo.upload.storage_invalid_response', 'external_service');
        return operationFailure(
          'EXTERNAL_SERVICE_ERROR',
          'Resposta inválida do serviço de armazenamento. Nenhum processamento foi iniciado.'
        );
      }
    } catch (error) {
      if (error instanceof StorageOperationError && error.code === 'OBJECT_EXISTS') {
        // F1.13: Verifica imediatamente a integridade (tamanho e SHA-256) do objeto
        // pré-existente no Storage antes de adotá-lo no banco de dados.
        let bytesArmazenados: Buffer;
        try {
          bytesArmazenados = await downloadFromSupabaseStorage(filePath);
        } catch {
          logOperationalFailure('acervo.upload.storage_adopt_verify', 'external_service');
          return operationFailure(
            'EXTERNAL_SERVICE_ERROR',
            'O arquivo já consta no armazenamento, mas não foi possível verificar sua integridade. Nenhum processamento foi iniciado.'
          );
        }

        const hashArmazenado = crypto.createHash('sha256').update(bytesArmazenados).digest('hex');
        if (
          bytesArmazenados.length !== fileBuffer.length ||
          hashArmazenado.toLowerCase() !== hash.toLowerCase()
        ) {
          logOperationalFailure('acervo.upload.storage_hash_mismatch', 'external_service');
          return operationFailure(
            'CONFLICT',
            'O objeto existente no armazenamento diverge do conteúdo enviado (falha de integridade SHA-256). Nenhum cadastro foi realizado.'
          );
        }

        reutilizouObjetoExistente = true;
      } else if (error instanceof StorageOperationError && error.code === 'INVALID_RESPONSE') {
        logOperationalFailure('acervo.upload.storage_invalid_response', 'external_service');
        return operationFailure(
          'EXTERNAL_SERVICE_ERROR',
          'Resposta inválida do serviço de armazenamento. Nenhum processamento foi iniciado.'
        );
      } else {
        logOperationalFailure('acervo.upload.storage', 'external_service');
        return operationFailure(
          'EXTERNAL_SERVICE_ERROR',
          'Não foi possível armazenar o arquivo. Nenhum processamento foi iniciado.'
        );
      }
    }

    let novoArquivo: { id: string } | undefined;
    try {
      [novoArquivo] = await db
        .insert(acervoArquivos)
        .values({
          disciplinaId: disciplinaIdValida,
          titulo: tituloValido,
          tipoMaterial: tipoMaterialValido,
          serieAlvo: serieAlvoValida,
          vestibular: vestibularValido,
          filePath,
          mime: 'application/pdf',
          tamanhoBytes: fileBuffer.length,
          enviadoPor: perfil.id,
          statusProcessamento: 'aguardando',
          hashConteudo: hash,
        })
        .returning({ id: acervoArquivos.id });
    } catch (insertError) {
      if (isPostgresUniqueViolation(insertError)) {
        return operationFailure('CONFLICT', 'Este arquivo já foi enviado anteriormente.');
      }
      logOperationalFailure('acervo.upload.metadata', 'persistence');
      return operationFailure(
        'PERSISTENCE_ERROR',
        'O arquivo foi armazenado, mas o cadastro não foi concluído. Não reenvie antes de verificar o acervo.'
      );
    }

    if (!novoArquivo || !novoArquivo.id) {
      logOperationalFailure('acervo.upload.metadata_missing', 'persistence');
      return operationFailure(
        'PERSISTENCE_ERROR',
        'O arquivo foi armazenado, mas o cadastro não foi confirmado. Não reenvie antes de verificar o acervo.'
      );
    }

    // F1.11: Registra o job persistente na fila PostgreSQL (`public.acervo_jobs`).
    // Proíbe fallback silencioso para execução efêmera em memória caso a fila falhe.
    try {
      await enfileirarJobIngestaoAcervo(novoArquivo.id, perfil.id);
    } catch {
      logOperationalFailure('acervo.upload.queue', 'persistence');
      try {
        await db
          .update(acervoArquivos)
          .set({
            statusProcessamento: 'falhou',
            erroProcessamento:
              'Arquivo cadastrado, mas o registro do job durável na fila falhou. Solicite a retomada no acervo.',
          })
          .where(eq(acervoArquivos.id, novoArquivo.id));
      } catch {
        logOperationalFailure('acervo.upload.queue_failure_status', 'persistence');
      }
      return operationFailure(
        'PERSISTENCE_ERROR',
        'O arquivo foi armazenado e cadastrado, mas não foi possível enfileirar o job durável de processamento. Utilize a retomada no acervo.'
      );
    }

    return operationSuccess({
      arquivoId: novoArquivo.id,
      uploadStatus: 'concluido',
      processamentoStatus: 'aguardando',
      mensagem: reutilizouObjetoExistente
        ? 'Upload confirmado (objeto pré-existente reconciliado). O processamento está pendente e pode ser acompanhado no acervo.'
        : 'Upload confirmado. O processamento está pendente e pode ser acompanhado no acervo.',
      ...(reutilizouObjetoExistente ? { reconciliacao: 'objeto_existente_adotado' as const } : {}),
    });
  } catch {
    logOperationalFailure('acervo.upload', 'persistence');
    return operationFailure('PERSISTENCE_ERROR', 'Não foi possível concluir o envio do arquivo.');
  }
}

// 1.1 Transporte binário via FormData (evita inflação de ~33% do base64 na Server Action)
export async function enviarArquivoFormData(
  formData: FormData
): Promise<OperationResult<UploadConfirmado>> {
  await requireRole('responsavel');

  if (!(formData instanceof FormData)) {
    return operationFailure('VALIDATION_ERROR', 'Formulário de upload inválido.');
  }

  const disciplinaId = String(formData.get('disciplinaId') ?? '');
  const titulo = String(formData.get('titulo') ?? '');
  const tipoMaterial = String(formData.get('tipoMaterial') ?? '') as TipoMaterialAcervo;
  const serieAlvoRaw = Number(formData.get('serieAlvo'));
  const vestibular = String(formData.get('vestibular') ?? '');
  const arquivo = formData.get('file');

  if (!arquivo || typeof (arquivo as File).arrayBuffer !== 'function') {
    return operationFailure('VALIDATION_ERROR', 'Arquivo PDF é obrigatório para o envio.');
  }

  const fileObj = arquivo as File;
  const arrayBuffer = await fileObj.arrayBuffer();
  const fileBuffer = Buffer.from(new Uint8Array(arrayBuffer));

  return enviarArquivo(
    disciplinaId,
    titulo,
    tipoMaterial,
    serieAlvoRaw,
    vestibular,
    fileObj.name || 'documento.pdf',
    fileBuffer
  );
}

// 2. Consultar job durável do arquivo (restrito ao responsável proprietário)
export async function obterStatusJobAcervo(
  arquivoId: string
): Promise<OperationResult<JobAcervoSnapshot>> {
  const perfil = await requireRole('responsavel');
  const idCheck = v.uuid('ID do arquivo').safeParse(arquivoId);
  if (!idCheck.ok) {
    return operationFailure('VALIDATION_ERROR', idCheck.message);
  }

  try {
    const [job] = await db
      .select()
      .from(acervoJobs)
      .where(and(eq(acervoJobs.arquivoId, idCheck.data), eq(acervoJobs.enviadoPor, perfil.id)))
      .limit(1);

    if (!job || job.enviadoPor !== perfil.id) {
      return operationFailure('NOT_FOUND', 'Job ou arquivo não encontrado ou acesso não autorizado.');
    }

    return operationSuccess(job as JobAcervoSnapshot);
  } catch {
    logOperationalFailure('acervo.job.status', 'persistence');
    return operationFailure('PERSISTENCE_ERROR', 'Não foi possível consultar o status do job do arquivo.');
  }
}

// 2.1 Retomar/reenfileirar processamento durável do arquivo a partir da última etapa confirmada
export async function retomarProcessamentoArquivoAcervo(
  arquivoId: string
): Promise<OperationResult<JobAcervoConfirmado>> {
  const perfil = await requireRole('responsavel');
  const idCheck = v.uuid('ID do arquivo').safeParse(arquivoId);
  if (!idCheck.ok) {
    return operationFailure('VALIDATION_ERROR', idCheck.message);
  }

  try {
    const [arquivo] = await db
      .select({
        id: acervoArquivos.id,
        enviadoPor: acervoArquivos.enviadoPor,
      })
      .from(acervoArquivos)
      .where(and(eq(acervoArquivos.id, idCheck.data), eq(acervoArquivos.enviadoPor, perfil.id)))
      .limit(1);

    if (!arquivo || arquivo.enviadoPor !== perfil.id) {
      return operationFailure('NOT_FOUND', 'Arquivo não encontrado ou acesso não autorizado.');
    }

    const reagendado = await reenfileirarJobAcervoDoResponsavel(arquivo.id, perfil.id);
    if (reagendado) {
      return operationSuccess({
        jobId: reagendado.id,
        arquivoId: reagendado.arquivoId,
        status: reagendado.status,
        etapaAtual: reagendado.etapaAtual,
      });
    }

    const criado = await enfileirarJobIngestaoAcervo(arquivo.id, perfil.id);
    return operationSuccess({
      jobId: criado.id,
      arquivoId: arquivo.id,
      status: criado.status,
      etapaAtual: criado.etapaAtual,
    });
  } catch {
    logOperationalFailure('acervo.job.resume', 'persistence');
    return operationFailure(
      'PERSISTENCE_ERROR',
      'Não foi possível reenfileirar o job de processamento deste arquivo.'
    );
  }
}

// 3. Obter status do arquivo
export async function obterAcervoStatus(arquivoId: string) {
  const perfil = await requireRole('responsavel');
  const arquivoIdValido = v.uuid('ID do arquivo').parse(arquivoId);

  const [arquivo] = await db
    .select()
    .from(acervoArquivos)
    .where(and(eq(acervoArquivos.id, arquivoIdValido), eq(acervoArquivos.enviadoPor, perfil.id)))
    .limit(1);

  if (!arquivo) return null;

  const paginasDb = await db
    .select({ numero: acervoPaginas.numero, textoExtraido: acervoPaginas.textoExtraido })
    .from(acervoPaginas)
    .where(eq(acervoPaginas.arquivoId, arquivoIdValido))
    .orderBy(acervoPaginas.numero);

  return {
    ...arquivo,
    paginasLista: paginasDb,
  };
}

// 4. Gerar URL assinada temporária para leitura privada de documento do acervo
export async function obterUrlLeituraArquivoAcervo(
  arquivoId: string,
  expiracaoSegundos = DEFAULT_SIGNED_URL_SECONDS
): Promise<OperationResult<UrlAssinadaAcervoConfirmada>> {
  const perfil = await requireRole('responsavel');

  const idCheck = v.uuid('ID do arquivo').safeParse(arquivoId);
  if (!idCheck.ok) {
    return operationFailure('VALIDATION_ERROR', idCheck.message);
  }

  const expCheck = v
    .number({
      label: 'Tempo de expiração',
      integer: true,
      min: MIN_SIGNED_URL_SECONDS,
      max: MAX_SIGNED_URL_SECONDS,
    })
    .safeParse(expiracaoSegundos);
  if (!expCheck.ok) {
    return operationFailure('VALIDATION_ERROR', expCheck.message);
  }

  try {
    const [arquivo] = await db
      .select({
        id: acervoArquivos.id,
        filePath: acervoArquivos.filePath,
        enviadoPor: acervoArquivos.enviadoPor,
      })
      .from(acervoArquivos)
      .where(and(eq(acervoArquivos.id, idCheck.data), eq(acervoArquivos.enviadoPor, perfil.id)))
      .limit(1);

    if (!arquivo || arquivo.enviadoPor !== perfil.id) {
      return operationFailure('NOT_FOUND', 'Arquivo não encontrado ou acesso não autorizado.');
    }

    try {
      const signedUrl = await obterUrlAssinadaSupabase(arquivo.filePath, expCheck.data);
      return operationSuccess({
        arquivoId: arquivo.id,
        signedUrl,
        expiraEmSegundos: expCheck.data,
      });
    } catch {
      logOperationalFailure('acervo.signed_url.storage', 'external_service');
      return operationFailure(
        'EXTERNAL_SERVICE_ERROR',
        'Não foi possível gerar o link temporário de leitura para este arquivo.'
      );
    }
  } catch {
    logOperationalFailure('acervo.signed_url.persistence', 'persistence');
    return operationFailure('PERSISTENCE_ERROR', 'Falha ao consultar metadados do arquivo.');
  }
}

// 5. Diagnóstico read-only de reconciliação Banco <-> Storage (sem exclusão automática)
export async function diagnosticarReconciliacaoAcervo(
  objetosStorageSnapshot: readonly ObjetoStorageSnapshot[]
): Promise<OperationResult<RelatorioReconciliacaoAcervo>> {
  const perfil = await requireRole('responsavel');

  if (!Array.isArray(objetosStorageSnapshot) || objetosStorageSnapshot.length > 5000) {
    return operationFailure(
      'VALIDATION_ERROR',
      'Snapshot de objetos do Storage inválido ou excede o limite de inspeção.'
    );
  }

  try {
    const registros = await db
      .select({
        id: acervoArquivos.id,
        filePath: acervoArquivos.filePath,
        hashConteudo: acervoArquivos.hashConteudo,
        tamanhoBytes: acervoArquivos.tamanhoBytes,
        mime: acervoArquivos.mime,
        statusProcessamento: acervoArquivos.statusProcessamento,
        erroProcessamento: acervoArquivos.erroProcessamento,
        enviadoPor: acervoArquivos.enviadoPor,
        enviadoEm: acervoArquivos.enviadoEm,
      })
      .from(acervoArquivos)
      .where(eq(acervoArquivos.enviadoPor, perfil.id));

    const relatorio = reconciliarSnapshotsAcervo(registros, objetosStorageSnapshot);
    return operationSuccess(relatorio);
  } catch {
    logOperationalFailure('acervo.reconciliation', 'persistence');
    return operationFailure(
      'PERSISTENCE_ERROR',
      'Não foi possível gerar o diagnóstico de reconciliação do acervo.'
    );
  }
}

// 6. Listar arquivos do acervo
export async function listarArquivosAcervo(disciplinaId?: string) {
  const perfil = await requireRole('responsavel');
  const disciplinaIdValida =
    disciplinaId !== undefined ? v.uuid('ID da disciplina').parse(disciplinaId) : undefined;

  return await db
    .select()
    .from(acervoArquivos)
    .where(
      and(
        eq(acervoArquivos.enviadoPor, perfil.id),
        disciplinaIdValida ? eq(acervoArquivos.disciplinaId, disciplinaIdValida) : undefined
      )
    )
    .orderBy(acervoArquivos.enviadoEm);
}

// 7. Obter todas as disciplinas
export async function listarDisciplinas() {
  await requireAuthenticatedProfile();

  return await db
    .select({ id: disciplinas.id, nome: disciplinas.nome })
    .from(disciplinas)
    .orderBy(disciplinas.ordem);
}
