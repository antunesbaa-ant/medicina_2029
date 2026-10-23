/**
 * MEDICINA 2029 — H1.02
 * Orquestrador de Execução do Worker sob Demanda (Sem VM Permanente)
 *
 * Permite processamento pontual de lotes de ingestão em staging ou desenvolvimento,
 * impondo limites rígidos de jobs executados e tempo máximo seguro de operação.
 */

import crypto from 'crypto';
import {
  processarProximoJobAcervo,
  type ResultadoProcessamentoWorker,
  type WorkerPipelineDependencies,
} from './acervoPipelineWorker';
import { assertStagingIsolation, isStagingEnvironment } from './envGuard';

export interface WorkerOnDemandOptions {
  maxJobs?: number;
  maxDurationMs?: number;
  workerId?: string;
  exitOnEmptyQueue?: boolean;
  idleDelayMs?: number;
  deps?: WorkerPipelineDependencies;
  onJobProcessed?: (res: ResultadoProcessamentoWorker, index: number) => void;
}

export interface WorkerOnDemandSummary {
  workerId: string;
  totalProcessados: number;
  concluidos: number;
  falhos: number;
  reagendados: number;
  motivoParada: 'max_jobs_atingido' | 'tempo_limite_atingido' | 'fila_vazia';
  duracaoMs: number;
  iniciadoEm: Date;
  finalizadoEm: Date;
  jobs: ResultadoProcessamentoWorker[];
}

export const DEFAULT_ON_DEMAND_MAX_JOBS = 10;
export const DEFAULT_ON_DEMAND_MAX_DURATION_MS = 60_000; // 60 segundos
export const MIN_ON_DEMAND_DURATION_MS = 10;
export const MAX_ON_DEMAND_DURATION_MS = 600_000; // 10 minutos teto máximo

/**
 * Executa o worker sob demanda de forma controlada e segura.
 */
export async function executarWorkerSobDemanda(
  options: WorkerOnDemandOptions = {}
): Promise<WorkerOnDemandSummary> {
  // 1. Em staging, assegura o isolamento fail-closed antes de iniciar
  if (isStagingEnvironment()) {
    assertStagingIsolation();
  }

  const workerId = options.workerId ?? `worker-ondemand-${crypto.randomUUID().slice(0, 8)}`;
  const maxJobs = Math.max(1, options.maxJobs ?? (Number(process.env.WORKER_MAX_JOBS) || DEFAULT_ON_DEMAND_MAX_JOBS));

  const rawMaxDuration = options.maxDurationMs ?? (Number(process.env.WORKER_MAX_DURATION_MS) || DEFAULT_ON_DEMAND_MAX_DURATION_MS);
  const maxDurationMs = Math.min(MAX_ON_DEMAND_DURATION_MS, Math.max(MIN_ON_DEMAND_DURATION_MS, rawMaxDuration));

  const exitOnEmptyQueue = options.exitOnEmptyQueue ?? true;
  const idleDelayMs = options.idleDelayMs ?? 500;

  const iniciadoEm = new Date();
  const startTime = Date.now();
  const deadline = startTime + maxDurationMs;

  const jobsProcessados: ResultadoProcessamentoWorker[] = [];
  let concluidos = 0;
  let falhos = 0;
  let reagendados = 0;
  let motivoParada: WorkerOnDemandSummary['motivoParada'] = 'max_jobs_atingido';

  while (jobsProcessados.length < maxJobs) {
    // Checagem estrita de tempo máximo seguro
    if (Date.now() >= deadline) {
      motivoParada = 'tempo_limite_atingido';
      break;
    }

    const resultado = await processarProximoJobAcervo(workerId, options.deps);

    if (!resultado.processado) {
      if (exitOnEmptyQueue) {
        motivoParada = 'fila_vazia';
        break;
      }
      // Se não for para sair imediatamente com a fila vazia, aguarda pequeno delay ou encerra se estourar o prazo
      if (Date.now() + idleDelayMs >= deadline) {
        motivoParada = 'tempo_limite_atingido';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
      continue;
    }

    jobsProcessados.push(resultado);

    if (resultado.statusFinal === 'concluido') {
      concluidos++;
    } else if (resultado.statusFinal === 'falhou') {
      falhos++;
    } else if (resultado.reagendado) {
      reagendados++;
    }

    if (options.onJobProcessed) {
      options.onJobProcessed(resultado, jobsProcessados.length);
    }
  }

  if (jobsProcessados.length >= maxJobs && motivoParada !== 'tempo_limite_atingido') {
    motivoParada = 'max_jobs_atingido';
  }

  const finalizadoEm = new Date();
  const duracaoMs = Date.now() - startTime;

  return {
    workerId,
    totalProcessados: jobsProcessados.length,
    concluidos,
    falhos,
    reagendados,
    motivoParada,
    duracaoMs,
    iniciadoEm,
    finalizadoEm,
    jobs: jobsProcessados,
  };
}
