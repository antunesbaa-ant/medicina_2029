import crypto from 'crypto';
import { and, asc, eq, inArray, lte, or } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { acervoArquivos, acervoChunks, acervoPaginas, perfis } from '../db/schema';
import {
  EXPECTED_EMBEDDING_DIMENSION,
  GeminiEmbeddingError,
  GeminiOcrError,
  classificarTópicoChunk,
  extrairTextoPDF,
  gerarEmbeddingReal as gerarEmbeddingRealPadrao,
  segmentarTexto,
  type ChunkSegmentado,
} from './ingestion';
import { downloadFromSupabaseStorage } from './supabaseStorage';
import { assertStagingIsolation, isStagingEnvironment } from './envGuard';

export type StatusJobAcervo = 'aguardando' | 'em_execucao' | 'concluido' | 'falhou';
export type EtapaJobAcervo = 'extracao' | 'segmentacao' | 'classificacao' | 'indexacao' | 'concluido';

export const DEFAULT_LEASE_DURATION_MS = 60_000;
export const DEFAULT_MAX_TENTATIVAS = 3;
export const DEFAULT_BASE_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 300_000;

/**
 * Definição Drizzle da tabela `public.acervo_jobs` (proposta em F1_11_FILA_INGESTAO_PROPOSTA.sql).
 * Mantida neste módulo para preservar `src/db/schema.ts` e o journal `drizzle-kit check` intactos
 * enquanto a migration permanece fora do journal automático.
 */
export const acervoJobs = pgTable('acervo_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  arquivoId: uuid('arquivo_id')
    .references(() => acervoArquivos.id, { onDelete: 'cascade' })
    .notNull(),
  enviadoPor: uuid('enviado_por')
    .references(() => perfis.id, { onDelete: 'restrict' })
    .notNull(),
  status: varchar('status', { length: 30 }).default('aguardando').notNull(),
  etapaAtual: varchar('etapa_atual', { length: 30 }).default('extracao').notNull(),
  tentativas: integer('tentativas').default(0).notNull(),
  maxTentativas: integer('max_tentativas').default(DEFAULT_MAX_TENTATIVAS).notNull(),
  proximaExecucaoEm: timestamp('proxima_execucao_em').defaultNow().notNull(),
  lockedBy: varchar('locked_by', { length: 128 }),
  lockedAt: timestamp('locked_at'),
  heartbeatAt: timestamp('heartbeat_at'),
  leaseExpiresAt: timestamp('lease_expires_at'),
  ultimoErroCodigo: varchar('ultimo_erro_codigo', { length: 80 }),
  ultimoErroMensagem: text('ultimo_erro_mensagem'),
  iniciadoEm: timestamp('iniciado_em'),
  concluidoEm: timestamp('concluido_em'),
  criadoEm: timestamp('criado_em').defaultNow().notNull(),
  atualizadoEm: timestamp('atualizado_em').defaultNow().notNull(),
});

export interface JobAcervoSnapshot {
  id: string;
  arquivoId: string;
  enviadoPor: string;
  status: StatusJobAcervo;
  etapaAtual: EtapaJobAcervo;
  tentativas: number;
  maxTentativas: number;
  proximaExecucaoEm: Date;
  lockedBy: string | null;
  lockedAt: Date | null;
  heartbeatAt: Date | null;
  leaseExpiresAt: Date | null;
  ultimoErroCodigo: string | null;
  ultimoErroMensagem: string | null;
  iniciadoEm: Date | null;
  concluidoEm: Date | null;
  criadoEm: Date;
  atualizadoEm: Date;
}

export class QueuePersistenceError extends Error {
  readonly code = 'QUEUE_PERSISTENCE_ERROR';

  constructor(message = 'Não foi possível persistir o job na fila durável.') {
    super(message);
    this.name = 'QueuePersistenceError';
  }
}

export class LeaseLostError extends Error {
  readonly code = 'LEASE_LOST';

  constructor(message = 'O lease de execução deste job expirou ou foi assumido por outro worker.') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export class NonRetryablePipelineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NonRetryablePipelineError';
    this.code = code;
  }
}

export interface WorkerPipelineDependencies {
  now?: () => Date;
  leaseDurationMs?: number;
  baseBackoffMs?: number;
  downloadPdf?: (filePath: string) => Promise<Buffer>;
  extrairTexto?: (
    pdfBuffer: Buffer
  ) => Promise<Array<{ numero: number; texto: string; metodo: 'nativo' | 'ocr' | 'visao'; confianca: number }>>;
  segmentar?: (paginas: Array<{ numero: number; texto: string }>) => ChunkSegmentado[];
  classificarChunk?: (
    chunkText: string,
    disciplinaId: string
  ) => Promise<{ topicoId: string | null; confianca: number }>;
  /**
   * Provedor real de embeddings (F1.12). Quando indefinido, a etapa `indexacao`
   * nunca declara conclusão fictícia e encerra o job com falha explícita preservando
   * as etapas anteriores já concluídas.
   */
  gerarEmbeddingReal?: ((texto: string) => Promise<number[]>) | null;
  onBeforeStage?: (etapa: EtapaJobAcervo, job: JobAcervoSnapshot) => Promise<void> | void;
}

export interface ResultadoProcessamentoWorker {
  processado: boolean;
  jobId: string | null;
  arquivoId: string | null;
  statusFinal: StatusJobAcervo | null;
  etapaAtual: EtapaJobAcervo | null;
  tentativas: number;
  reagendado: boolean;
  erroCodigo: string | null;
  mensagem: string;
}

export function calcularBackoffMs(
  tentativa: number,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS
): number {
  const exp = Math.max(0, tentativa - 1);
  return Math.min(baseBackoffMs * Math.pow(2, exp), MAX_BACKOFF_MS);
}

export function sanitizarErroJobAcervo(error: unknown): {
  codigo: string;
  mensagemPublica: string;
  retentavel: boolean;
} {
  if (error instanceof NonRetryablePipelineError) {
    return {
      codigo: error.code,
      mensagemPublica: sanitizarTextoErro(error.message),
      retentavel: false,
    };
  }

  if (error instanceof LeaseLostError) {
    return {
      codigo: error.code,
      mensagemPublica: 'Execução interrompida por perda ou expiração de lease.',
      retentavel: true,
    };
  }

  if (error instanceof GeminiEmbeddingError) {
    if (error.code === 'MISSING_API_KEY') {
      return {
        codigo: 'EMBEDDING_PROVIDER_UNAVAILABLE',
        mensagemPublica:
          'Provedor real de embeddings indisponível. Extração, segmentação e classificação foram preservadas para retomada na etapa de indexação.',
        retentavel: false,
      };
    }
    if (error.code === 'DIMENSION_MISMATCH') {
      return {
        codigo: 'EMBEDDING_DIMENSION_MISMATCH',
        mensagemPublica: sanitizarTextoErro(error.message),
        retentavel: false,
      };
    }
    return {
      codigo: `EMBEDDING_${error.code}`,
      mensagemPublica: error.retryable
        ? 'Falha transitória no provedor de embeddings. Os vetores já persistidos foram preservados para retomada.'
        : sanitizarTextoErro(error.message),
      retentavel: error.retryable,
    };
  }

  if (error instanceof GeminiOcrError) {
    if (error.code === 'MISSING_API_KEY') {
      return {
        codigo: 'OCR_PROVIDER_UNAVAILABLE',
        mensagemPublica: 'Provedor de OCR indisponível para documento digitalizado.',
        retentavel: false,
      };
    }
    return {
      codigo: `OCR_${error.code}`,
      mensagemPublica: error.retryable
        ? 'Falha transitória no serviço de OCR. O trabalho foi reagendado.'
        : sanitizarTextoErro(error.message),
      retentavel: error.retryable,
    };
  }

  const rawMsg = error instanceof Error ? error.message : '';
  if (/embedding_provider_not_configured|serviço de embeddings/i.test(rawMsg)) {
    return {
      codigo: 'EMBEDDING_PROVIDER_UNAVAILABLE',
      mensagemPublica:
        'Provedor real de embeddings indisponível. Extração, segmentação e classificação foram preservadas para retomada na etapa de indexação.',
      retentavel: false,
    };
  }

  return {
    codigo: 'PIPELINE_STEP_ERROR',
    mensagemPublica:
      'Falha transitória durante o processamento do documento. O trabalho permanece preservado para retomada.',
    retentavel: true,
  };
}

function sanitizarTextoErro(text: string): string {
  return text
    .replace(/postgresql:\/\/[^\s]+/gi, '[REDACTED_DB_URL]')
    .replace(/(?:key|token|secret|password|credential|credencial|bearer)\s*[=:]\s*[^\s,;]+/gi, '[REDACTED_SECRET]')
    .slice(0, 500);
}

/**
 * Registra de forma durável e idempotente o job de ingestão para um arquivo recém-confirmado.
 * Não permite fallback silencioso para execução em memória caso a persistência falhe.
 */
export async function enfileirarJobIngestaoAcervo(
  arquivoId: string,
  enviadoPor: string,
  opcoes?: { maxTentativas?: number; now?: Date }
): Promise<{ id: string; status: StatusJobAcervo; etapaAtual: EtapaJobAcervo }> {
  const now = opcoes?.now ?? new Date();
  const maxTentativas = opcoes?.maxTentativas ?? DEFAULT_MAX_TENTATIVAS;

  try {
    const inseridos = await db
      .insert(acervoJobs)
      .values({
        arquivoId,
        enviadoPor,
        status: 'aguardando',
        etapaAtual: 'extracao',
        tentativas: 0,
        maxTentativas,
        proximaExecucaoEm: now,
        criadoEm: now,
        atualizadoEm: now,
      })
      .onConflictDoNothing()
      .returning({
        id: acervoJobs.id,
        status: acervoJobs.status,
        etapaAtual: acervoJobs.etapaAtual,
      });

    const jobInserido = inseridos[0];
    if (jobInserido && jobInserido.id) {
      return {
        id: jobInserido.id,
        status: (jobInserido.status as StatusJobAcervo) ?? 'aguardando',
        etapaAtual: (jobInserido.etapaAtual as EtapaJobAcervo) ?? 'extracao',
      };
    }

    // Caso o job já existisse para este arquivoId (idempotência por arquivo), recupera o existente do mesmo responsável
    const existentes = await db
      .select({
        id: acervoJobs.id,
        status: acervoJobs.status,
        etapaAtual: acervoJobs.etapaAtual,
      })
      .from(acervoJobs)
      .where(and(eq(acervoJobs.arquivoId, arquivoId), eq(acervoJobs.enviadoPor, enviadoPor)))
      .limit(1);

    const existente = existentes[0];
    if (!existente || !existente.id) {
      throw new QueuePersistenceError();
    }

    return {
      id: existente.id,
      status: existente.status as StatusJobAcervo,
      etapaAtual: existente.etapaAtual as EtapaJobAcervo,
    };
  } catch (error) {
    if (error instanceof QueuePersistenceError) {
      throw error;
    }
    throw new QueuePersistenceError();
  }
}

/**
 * Recupera jobs cujo lease expirou (`status = 'em_execucao'` e `lease_expires_at <= now`).
 * - Se `tentativas < max_tentativas`, devolve para `'aguardando'` preservando `etapa_atual`;
 * - Se `tentativas >= max_tentativas`, encerra como `'falhou'` sem tentar novamente.
 */
export async function recuperarJobsComLeaseVencido(opcoes?: {
  now?: Date;
  baseBackoffMs?: number;
}): Promise<{ reenfileirados: string[]; esgotados: string[] }> {
  const now = opcoes?.now ?? new Date();
  const baseBackoffMs = opcoes?.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;

  const vencidos = await db
    .select()
    .from(acervoJobs)
    .where(and(eq(acervoJobs.status, 'em_execucao'), lte(acervoJobs.leaseExpiresAt, now)));

  const reenfileirados: string[] = [];
  const esgotados: string[] = [];

  for (const job of vencidos) {
    if (job.tentativas >= job.maxTentativas) {
      const [atualizado] = await db
        .update(acervoJobs)
        .set({
          status: 'falhou',
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          ultimoErroCodigo: 'LEASE_EXPIRED_MAX_RETRIES',
          ultimoErroMensagem:
            'Processamento interrompido: limite de tentativas excedido após expiração do lease.',
          atualizadoEm: now,
        })
        .where(
          and(
            eq(acervoJobs.id, job.id),
            eq(acervoJobs.status, 'em_execucao'),
            lte(acervoJobs.leaseExpiresAt, now)
          )
        )
        .returning({ id: acervoJobs.id });

      if (atualizado) {
        await db
          .update(acervoArquivos)
          .set({
            statusProcessamento: 'falhou',
            erroProcessamento:
              'Processamento interrompido: limite de tentativas excedido após expiração do lease.',
          })
          .where(eq(acervoArquivos.id, job.arquivoId));
        esgotados.push(job.id);
      }
    } else {
      const backoffMs = calcularBackoffMs(job.tentativas, baseBackoffMs);
      const proximaExecucaoEm = new Date(now.getTime() + backoffMs);

      const [atualizado] = await db
        .update(acervoJobs)
        .set({
          status: 'aguardando',
          proximaExecucaoEm,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          ultimoErroCodigo: 'LEASE_EXPIRED_RECOVERED',
          ultimoErroMensagem:
            'Lease vencido; trabalho recuperado para retomada a partir da última etapa confirmada.',
          atualizadoEm: now,
        })
        .where(
          and(
            eq(acervoJobs.id, job.id),
            eq(acervoJobs.status, 'em_execucao'),
            lte(acervoJobs.leaseExpiresAt, now)
          )
        )
        .returning({ id: acervoJobs.id });

      if (atualizado) {
        await db
          .update(acervoArquivos)
          .set({
            statusProcessamento: 'aguardando',
          })
          .where(eq(acervoArquivos.id, job.arquivoId));
        reenfileirados.push(job.id);
      }
    }
  }

  return { reenfileirados, esgotados };
}

/**
 * Reivindica atomicamente o próximo job disponível para um worker independente.
 * Combina seleção ordenada de candidatos com compare-and-swap atômico (`tentativas` + estado do lease),
 * garantindo que dois workers concorrentes jamais assumam o mesmo job simultaneamente.
 */
export async function reivindicarProximoJobAcervo(
  workerId: string,
  opcoes?: {
    now?: Date;
    leaseDurationMs?: number;
    arquivoId?: string;
  }
): Promise<JobAcervoSnapshot | null> {
  const trimmedWorkerId = workerId.trim();
  if (!trimmedWorkerId) {
    throw new Error('Identificador do worker (workerId) é obrigatório.');
  }

  const now = opcoes?.now ?? new Date();
  const leaseDurationMs = opcoes?.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  const candidatos = await db
    .select()
    .from(acervoJobs)
    .where(
      and(
        opcoes?.arquivoId ? eq(acervoJobs.arquivoId, opcoes.arquivoId) : undefined,
        or(
          and(eq(acervoJobs.status, 'aguardando'), lte(acervoJobs.proximaExecucaoEm, now)),
          and(eq(acervoJobs.status, 'em_execucao'), lte(acervoJobs.leaseExpiresAt, now))
        )
      )
    )
    .orderBy(asc(acervoJobs.proximaExecucaoEm), asc(acervoJobs.criadoEm))
    .limit(5);

  for (const candidato of candidatos) {
    if (candidato.tentativas >= candidato.maxTentativas) {
      // Se estava em_execucao com lease vencido e já atingiu maxTentativas, encerra como falhou
      if (candidato.status === 'em_execucao') {
        await recuperarJobsComLeaseVencido({ now });
      }
      continue;
    }

    const [reivindicado] = await db
      .update(acervoJobs)
      .set({
        status: 'em_execucao',
        tentativas: candidato.tentativas + 1,
        lockedBy: trimmedWorkerId,
        lockedAt: now,
        heartbeatAt: now,
        leaseExpiresAt,
        iniciadoEm: candidato.iniciadoEm ?? now,
        atualizadoEm: now,
      })
      .where(
        and(
          eq(acervoJobs.id, candidato.id),
          eq(acervoJobs.tentativas, candidato.tentativas),
          or(
            and(eq(acervoJobs.status, 'aguardando'), lte(acervoJobs.proximaExecucaoEm, now)),
            and(eq(acervoJobs.status, 'em_execucao'), lte(acervoJobs.leaseExpiresAt, now))
          )
        )
      )
      .returning();

    if (reivindicado) {
      return reivindicado as JobAcervoSnapshot;
    }
  }

  return null;
}

/**
 * Renova o heartbeat e o lease do worker para o job em execução.
 * Lança `LeaseLostError` caso o lease tenha expirado ou sido assumido por outro worker.
 */
export async function renovarHeartbeatJobAcervo(
  jobId: string,
  workerId: string,
  opcoes?: { now?: Date; leaseDurationMs?: number }
): Promise<Date> {
  const now = opcoes?.now ?? new Date();
  const leaseDurationMs = opcoes?.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const novoLeaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  const [renovado] = await db
    .update(acervoJobs)
    .set({
      heartbeatAt: now,
      leaseExpiresAt: novoLeaseExpiresAt,
      atualizadoEm: now,
    })
    .where(
      and(
        eq(acervoJobs.id, jobId),
        eq(acervoJobs.status, 'em_execucao'),
        eq(acervoJobs.lockedBy, workerId)
      )
    )
    .returning({ id: acervoJobs.id, leaseExpiresAt: acervoJobs.leaseExpiresAt });

  if (!renovado) {
    throw new LeaseLostError();
  }

  return renovado.leaseExpiresAt ?? novoLeaseExpiresAt;
}

async function avancarEtapaJobComLease(
  jobId: string,
  workerId: string,
  novaEtapa: EtapaJobAcervo,
  now: Date,
  leaseDurationMs: number
): Promise<void> {
  const novoLeaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
  const [atualizado] = await db
    .update(acervoJobs)
    .set({
      etapaAtual: novaEtapa,
      heartbeatAt: now,
      leaseExpiresAt: novoLeaseExpiresAt,
      atualizadoEm: now,
    })
    .where(
      and(
        eq(acervoJobs.id, jobId),
        eq(acervoJobs.status, 'em_execucao'),
        eq(acervoJobs.lockedBy, workerId)
      )
    )
    .returning({ id: acervoJobs.id });

  if (!atualizado) {
    throw new LeaseLostError();
  }
}

async function atualizarStatusArquivoAcervo(
  arquivoId: string,
  statusProcessamento:
    | 'aguardando'
    | 'extraindo'
    | 'segmentando'
    | 'classificando'
    | 'indexando'
    | 'concluido'
    | 'falhou',
  extras?: { paginas?: number; erroProcessamento?: string | null }
): Promise<void> {
  const [confirmado] = await db
    .update(acervoArquivos)
    .set({
      statusProcessamento,
      ...(extras?.paginas !== undefined ? { paginas: extras.paginas } : {}),
      ...(extras?.erroProcessamento !== undefined
        ? { erroProcessamento: extras.erroProcessamento }
        : {}),
    })
    .where(eq(acervoArquivos.id, arquivoId))
    .returning({ id: acervoArquivos.id });

  if (!confirmado) {
    throw new NonRetryablePipelineError(
      'SOURCE_FILE_NOT_FOUND',
      'Registro do arquivo não encontrado em acervo_arquivos.'
    );
  }
}

/**
 * Executa um ciclo do worker independente para processar o próximo job elegível.
 * - Cada etapa (`extracao`, `segmentacao`, `classificacao`, `indexacao`) é idempotente e retomável;
 * - Resultados já persistidos em `acervo_paginas` e `acervo_chunks` são preservados;
 * - Na ausência de provedor real de embeddings, a etapa `indexacao` nunca declara conclusão fictícia.
 */
export async function processarProximoJobAcervo(
  workerId: string,
  deps?: WorkerPipelineDependencies & { arquivoId?: string }
): Promise<ResultadoProcessamentoWorker> {
  if (isStagingEnvironment()) {
    assertStagingIsolation();
  }
  const nowFn = deps?.now ?? (() => new Date());
  const leaseDurationMs = deps?.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const baseBackoffMs = deps?.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const downloadPdf = deps?.downloadPdf ?? downloadFromSupabaseStorage;
  const extrairTexto = deps?.extrairTexto ?? extrairTextoPDF;
  const segmentar = deps?.segmentar ?? segmentarTexto;
  const classificarChunk = deps?.classificarChunk ?? classificarTópicoChunk;
  const gerarEmbeddingReal =
    deps && 'gerarEmbeddingReal' in deps
      ? deps.gerarEmbeddingReal ?? null
      : process.env.GEMINI_API_KEY?.trim()
        ? gerarEmbeddingRealPadrao
        : null;

  const job = await reivindicarProximoJobAcervo(workerId, {
    now: nowFn(),
    leaseDurationMs,
    arquivoId: deps?.arquivoId,
  });

  if (!job) {
    return {
      processado: false,
      jobId: null,
      arquivoId: null,
      statusFinal: null,
      etapaAtual: null,
      tentativas: 0,
      reagendado: false,
      erroCodigo: null,
      mensagem: 'Nenhum job elegível disponível na fila.',
    };
  }

  let etapaCorrente: EtapaJobAcervo = job.etapaAtual;

  try {
    const [arquivo] = await db
      .select({
        id: acervoArquivos.id,
        disciplinaId: acervoArquivos.disciplinaId,
        filePath: acervoArquivos.filePath,
        hashConteudo: acervoArquivos.hashConteudo,
        paginas: acervoArquivos.paginas,
        enviadoPor: acervoArquivos.enviadoPor,
      })
      .from(acervoArquivos)
      .where(and(eq(acervoArquivos.id, job.arquivoId), eq(acervoArquivos.enviadoPor, job.enviadoPor)))
      .limit(1);

    if (!arquivo) {
      throw new NonRetryablePipelineError(
        'SOURCE_FILE_NOT_FOUND',
        'Arquivo de origem não encontrado ou vínculo de ownership inválido.'
      );
    }

    // ------------------------------------------------------------------------
    // ETAPA 1: EXTRAÇÃO DE PÁGINAS (IDEMPOTENTE E RETOMÁVEL)
    // ------------------------------------------------------------------------
    if (etapaCorrente === 'extracao') {
      await renovarHeartbeatJobAcervo(job.id, workerId, { now: nowFn(), leaseDurationMs });
      if (deps?.onBeforeStage) {
        await deps.onBeforeStage('extracao', { ...job, etapaAtual: 'extracao' });
      }
      await atualizarStatusArquivoAcervo(arquivo.id, 'extraindo', { erroProcessamento: null });

      const paginasExistentes = await db
        .select({
          numero: acervoPaginas.numero,
          textoExtraido: acervoPaginas.textoExtraido,
        })
        .from(acervoPaginas)
        .where(eq(acervoPaginas.arquivoId, arquivo.id))
        .orderBy(asc(acervoPaginas.numero));

      const extracaoCompletaExistente =
        arquivo.paginas !== null &&
        arquivo.paginas > 0 &&
        paginasExistentes.length === arquivo.paginas;

      if (!extracaoCompletaExistente) {
        const pdfBuffer = await downloadPdf(arquivo.filePath);
        const hashObtido = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

        if (hashObtido.toLowerCase() !== arquivo.hashConteudo.toLowerCase()) {
          throw new NonRetryablePipelineError(
            'STORAGE_HASH_MISMATCH',
            'O conteúdo do objeto no Storage diverge do hash SHA-256 registrado para o arquivo.'
          );
        }

        const paginasExtraidas = await extrairTexto(pdfBuffer);
        if (paginasExtraidas.length === 0) {
          throw new NonRetryablePipelineError(
            'EMPTY_EXTRACTION',
            'Nenhum texto pôde ser extraído do documento PDF.'
          );
        }

        const numerosJaPersistidos = new Set(paginasExistentes.map((p) => p.numero));
        for (const p of paginasExtraidas) {
          if (numerosJaPersistidos.has(p.numero)) {
            continue;
          }
          await db
            .insert(acervoPaginas)
            .values({
              arquivoId: arquivo.id,
              numero: p.numero,
              textoExtraido: p.texto,
              metodoExtracao: p.metodo,
              confiancaOcr: p.confianca,
            })
            .onConflictDoNothing();
        }

        await atualizarStatusArquivoAcervo(arquivo.id, 'extraindo', {
          paginas: paginasExtraidas.length,
        });
      }

      etapaCorrente = 'segmentacao';
      await avancarEtapaJobComLease(job.id, workerId, etapaCorrente, nowFn(), leaseDurationMs);
    }

    // ------------------------------------------------------------------------
    // ETAPA 2: SEGMENTAÇÃO EM CHUNKS (IDEMPOTENTE E RETOMÁVEL)
    // ------------------------------------------------------------------------
    if (etapaCorrente === 'segmentacao') {
      await renovarHeartbeatJobAcervo(job.id, workerId, { now: nowFn(), leaseDurationMs });
      if (deps?.onBeforeStage) {
        await deps.onBeforeStage('segmentacao', { ...job, etapaAtual: 'segmentacao' });
      }

      const paginasPersistidas = await db
        .select({
          numero: acervoPaginas.numero,
          textoExtraido: acervoPaginas.textoExtraido,
        })
        .from(acervoPaginas)
        .where(eq(acervoPaginas.arquivoId, arquivo.id))
        .orderBy(asc(acervoPaginas.numero));

      if (paginasPersistidas.length === 0) {
        throw new Error('Nenhuma página persistida encontrada para segmentação.');
      }

      await atualizarStatusArquivoAcervo(arquivo.id, 'segmentando', {
        paginas: paginasPersistidas.length,
      });

      const chunksEsperados = segmentar(
        paginasPersistidas.map((p) => ({
          numero: p.numero,
          texto: p.textoExtraido ?? '',
        }))
      );

      const chunksExistentes = await db
        .select({ ordem: acervoChunks.ordem })
        .from(acervoChunks)
        .where(eq(acervoChunks.arquivoId, arquivo.id));
      const ordensJaPersistidas = new Set(chunksExistentes.map((c) => c.ordem));

      for (const chunk of chunksEsperados) {
        if (ordensJaPersistidas.has(chunk.ordem)) {
          continue;
        }
        await db
          .insert(acervoChunks)
          .values({
            arquivoId: arquivo.id,
            paginaInicial: chunk.paginaInicial,
            paginaFinal: chunk.paginaFinal,
            ordem: chunk.ordem,
            texto: chunk.texto,
            tipoConteudo: chunk.tipoConteudo,
            topicoId: null,
            confiancaClassificacao: null,
            embedding: null,
            tokens: chunk.tokens,
          })
          .onConflictDoNothing();
      }

      etapaCorrente = 'classificacao';
      await avancarEtapaJobComLease(job.id, workerId, etapaCorrente, nowFn(), leaseDurationMs);
    }

    // ------------------------------------------------------------------------
    // ETAPA 3: CLASSIFICAÇÃO DE TÓPICOS (IDEMPOTENTE E RETOMÁVEL)
    // ------------------------------------------------------------------------
    if (etapaCorrente === 'classificacao') {
      await renovarHeartbeatJobAcervo(job.id, workerId, { now: nowFn(), leaseDurationMs });
      if (deps?.onBeforeStage) {
        await deps.onBeforeStage('classificacao', { ...job, etapaAtual: 'classificacao' });
      }
      await atualizarStatusArquivoAcervo(arquivo.id, 'classificando');

      const chunksDb = await db
        .select({
          id: acervoChunks.id,
          ordem: acervoChunks.ordem,
          texto: acervoChunks.texto,
          confiancaClassificacao: acervoChunks.confiancaClassificacao,
        })
        .from(acervoChunks)
        .where(eq(acervoChunks.arquivoId, arquivo.id))
        .orderBy(asc(acervoChunks.ordem));

      for (const chunk of chunksDb) {
        // Preserva chunks já classificados em execução anterior
        if (chunk.confiancaClassificacao !== null) {
          continue;
        }
        await renovarHeartbeatJobAcervo(job.id, workerId, { now: nowFn(), leaseDurationMs });
        const { topicoId, confianca } = await classificarChunk(chunk.texto, arquivo.disciplinaId);

        await db
          .update(acervoChunks)
          .set({
            topicoId,
            confiancaClassificacao: confianca,
          })
          .where(eq(acervoChunks.id, chunk.id));
      }

      etapaCorrente = 'indexacao';
      await avancarEtapaJobComLease(job.id, workerId, etapaCorrente, nowFn(), leaseDurationMs);
    }

    // ------------------------------------------------------------------------
    // ETAPA 4: INDEXAÇÃO VETORIAL (NUNCA DECLARA CONCLUSÃO FICTÍCIA)
    // ------------------------------------------------------------------------
    if (etapaCorrente === 'indexacao') {
      await renovarHeartbeatJobAcervo(job.id, workerId, { now: nowFn(), leaseDurationMs });
      if (deps?.onBeforeStage) {
        await deps.onBeforeStage('indexacao', { ...job, etapaAtual: 'indexacao' });
      }
      await atualizarStatusArquivoAcervo(arquivo.id, 'indexando');

      if (!gerarEmbeddingReal) {
        throw new NonRetryablePipelineError(
          'EMBEDDING_PROVIDER_UNAVAILABLE',
          'Provedor real de embeddings indisponível. Extração, segmentação e classificação foram preservadas para retomada na etapa de indexação.'
        );
      }

      const chunksParaIndexar = await db
        .select({
          id: acervoChunks.id,
          ordem: acervoChunks.ordem,
          texto: acervoChunks.texto,
          embedding: acervoChunks.embedding,
        })
        .from(acervoChunks)
        .where(eq(acervoChunks.arquivoId, arquivo.id))
        .orderBy(asc(acervoChunks.ordem));

      for (const chunk of chunksParaIndexar) {
        if (chunk.embedding !== null) {
          continue;
        }
        await renovarHeartbeatJobAcervo(job.id, workerId, { now: nowFn(), leaseDurationMs });
        const vetor = await gerarEmbeddingReal(chunk.texto);
        if (
          !Array.isArray(vetor) ||
          vetor.length !== EXPECTED_EMBEDDING_DIMENSION ||
          !vetor.every((v) => typeof v === 'number' && Number.isFinite(v))
        ) {
          throw new NonRetryablePipelineError(
            'EMBEDDING_DIMENSION_MISMATCH',
            `Dimensão de embedding incompatível com vector(${EXPECTED_EMBEDDING_DIMENSION}).`
          );
        }

        await db
          .update(acervoChunks)
          .set({ embedding: vetor })
          .where(eq(acervoChunks.id, chunk.id));
      }

      etapaCorrente = 'concluido';
    }

    // ------------------------------------------------------------------------
    // CONCLUSÃO CONFIRMADA (SOMENTE QUANDO TODAS AS ETAPAS REAIS CONCLUEM)
    // ------------------------------------------------------------------------
    const nowConclusao = nowFn();
    const [jobConcluido] = await db
      .update(acervoJobs)
      .set({
        status: 'concluido',
        etapaAtual: 'concluido',
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        ultimoErroCodigo: null,
        ultimoErroMensagem: null,
        concluidoEm: nowConclusao,
        atualizadoEm: nowConclusao,
      })
      .where(
        and(
          eq(acervoJobs.id, job.id),
          eq(acervoJobs.status, 'em_execucao'),
          eq(acervoJobs.lockedBy, workerId)
        )
      )
      .returning({ id: acervoJobs.id });

    if (!jobConcluido) {
      throw new LeaseLostError();
    }

    await atualizarStatusArquivoAcervo(arquivo.id, 'concluido', {
      erroProcessamento: null,
    });

    return {
      processado: true,
      jobId: job.id,
      arquivoId: job.arquivoId,
      statusFinal: 'concluido',
      etapaAtual: 'concluido',
      tentativas: job.tentativas,
      reagendado: false,
      erroCodigo: null,
      mensagem: 'Processamento do arquivo concluído com sucesso.',
    };
  } catch (error) {
    // Se perdeu o lease para outro worker, não altera o registro do job
    if (error instanceof LeaseLostError) {
      return {
        processado: false,
        jobId: job.id,
        arquivoId: job.arquivoId,
        statusFinal: null,
        etapaAtual: etapaCorrente,
        tentativas: job.tentativas,
        reagendado: false,
        erroCodigo: error.code,
        mensagem: error.message,
      };
    }

    const nowErro = nowFn();
    const erroSanitizado = sanitizarErroJobAcervo(error);
    const podeRetentar = erroSanitizado.retentavel && job.tentativas < job.maxTentativas;

    if (podeRetentar) {
      const backoffMs = calcularBackoffMs(job.tentativas, baseBackoffMs);
      const proximaExecucaoEm = new Date(nowErro.getTime() + backoffMs);

      await db
        .update(acervoJobs)
        .set({
          status: 'aguardando',
          etapaAtual: etapaCorrente,
          proximaExecucaoEm,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          ultimoErroCodigo: erroSanitizado.codigo,
          ultimoErroMensagem: erroSanitizado.mensagemPublica,
          atualizadoEm: nowErro,
        })
        .where(and(eq(acervoJobs.id, job.id), eq(acervoJobs.lockedBy, workerId)));

      try {
        await db
          .update(acervoArquivos)
          .set({
            statusProcessamento: 'aguardando',
            erroProcessamento: erroSanitizado.mensagemPublica,
          })
          .where(eq(acervoArquivos.id, job.arquivoId));
      } catch {
        // Ignora erro secundário se o arquivo não existir
      }

      return {
        processado: true,
        jobId: job.id,
        arquivoId: job.arquivoId,
        statusFinal: 'aguardando',
        etapaAtual: etapaCorrente,
        tentativas: job.tentativas,
        reagendado: true,
        erroCodigo: erroSanitizado.codigo,
        mensagem: erroSanitizado.mensagemPublica,
      };
    }

    // Falha terminal (não retentável ou esgotou maxTentativas): preserva `etapaCorrente`
    await db
      .update(acervoJobs)
      .set({
        status: 'falhou',
        etapaAtual: etapaCorrente,
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        ultimoErroCodigo: erroSanitizado.codigo,
        ultimoErroMensagem: erroSanitizado.mensagemPublica,
        atualizadoEm: nowErro,
      })
      .where(and(eq(acervoJobs.id, job.id), eq(acervoJobs.lockedBy, workerId)));

    try {
      await db
        .update(acervoArquivos)
        .set({
          statusProcessamento: 'falhou',
          erroProcessamento: erroSanitizado.mensagemPublica,
        })
        .where(eq(acervoArquivos.id, job.arquivoId));
    } catch {
      // Ignora erro secundário se o arquivo não existir
    }

    return {
      processado: true,
      jobId: job.id,
      arquivoId: job.arquivoId,
      statusFinal: 'falhou',
      etapaAtual: etapaCorrente,
      tentativas: job.tentativas,
      reagendado: false,
      erroCodigo: erroSanitizado.codigo,
      mensagem: erroSanitizado.mensagemPublica,
    };
  }
}

/**
 * Permite que o responsável proprietário reenfileire manualmente um job falho
 * para retomada a partir da etapa em que parou (`etapaAtual` preservada).
 */
export async function reenfileirarJobAcervoDoResponsavel(
  arquivoId: string,
  responsavelId: string,
  now = new Date()
): Promise<JobAcervoSnapshot | null> {
  const [jobExistente] = await db
    .select()
    .from(acervoJobs)
    .where(and(eq(acervoJobs.arquivoId, arquivoId), eq(acervoJobs.enviadoPor, responsavelId)))
    .limit(1);

  if (!jobExistente) {
    return null;
  }

  if (jobExistente.status === 'concluido') {
    return jobExistente as JobAcervoSnapshot;
  }

  // Se o lease ainda estiver ativo em execução, não interrompe o worker ativo
  if (
    jobExistente.status === 'em_execucao' &&
    jobExistente.leaseExpiresAt &&
    jobExistente.leaseExpiresAt > now
  ) {
    return jobExistente as JobAcervoSnapshot;
  }

  const [reagendado] = await db
    .update(acervoJobs)
    .set({
      status: 'aguardando',
      tentativas: 0,
      proximaExecucaoEm: now,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      atualizadoEm: now,
    })
    .where(
      and(
        eq(acervoJobs.id, jobExistente.id),
        eq(acervoJobs.enviadoPor, responsavelId),
        inArray(acervoJobs.status, ['falhou', 'aguardando', 'em_execucao'])
      )
    )
    .returning();

  if (reagendado) {
    await db
      .update(acervoArquivos)
      .set({
        statusProcessamento: 'aguardando',
      })
      .where(and(eq(acervoArquivos.id, arquivoId), eq(acervoArquivos.enviadoPor, responsavelId)));
  }

  return (reagendado as JobAcervoSnapshot) ?? null;
}
