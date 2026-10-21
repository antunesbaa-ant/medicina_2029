import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import * as schema from '../../db/schema';

const MODULE_ROOT = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';
const PGLITE_INDEX = path.join(MODULE_ROOT, '@electric-sql/pglite/dist/index.js');
const PGLITE_VECTOR = path.join(MODULE_ROOT, '@electric-sql/pglite-pgvector/dist/index.js');
const HAS_PGLITE = existsSync(PGLITE_INDEX) && existsSync(PGLITE_VECTOR);

const ESTUDANTE_1 = {
  id: '10000000-0000-4000-8000-000000000001',
  authUserId: 'a0000000-0000-4000-8000-000000000001',
  nome: 'Estudante Ficticia 1 F1.04',
  email: 'estudante1.f104@example.invalid',
  papel: 'estudante' as const,
};

const RESPONSAVEL_1 = {
  id: '20000000-0000-4000-8000-000000000001',
  authUserId: 'b0000000-0000-4000-8000-000000000001',
  nome: 'Responsavel Ficticio 1 F1.04',
  email: 'responsavel1.f104@example.invalid',
  papel: 'responsavel' as const,
};

const RESPONSAVEL_2 = {
  id: '20000000-0000-4000-8000-000000000002',
  authUserId: 'b0000000-0000-4000-8000-000000000002',
  nome: 'Responsavel Ficticio 2 F1.04',
  email: 'responsavel2.f104@example.invalid',
  papel: 'responsavel' as const,
};

const DISCIPLINA_BIOLOGIA = '30000000-0000-4000-8000-000000000001';
const TOPICO_CITOLOGIA = '31000000-0000-4000-8000-000000000001';

const simulatedBucket = vi.hoisted(() => ({
  objects: new Map<string, { body: Buffer; contentType: string }>(),
}));

const authState = vi.hoisted(() => ({
  currentProfile: null as
    | {
        id: string;
        authUserId: string;
        nome: string;
        email: string | null;
        papel: 'estudante' | 'responsavel';
      }
    | null,
  dbInstance: null as unknown,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    storage: {
      from: (bucketName: string) => ({
        upload: async (
          key: string,
          body: Buffer,
          options?: { contentType?: string; upsert?: boolean }
        ) => {
          if (bucketName !== 'acervo') {
            return { data: null, error: { message: 'Bucket inválido' } };
          }
          const upsert = options?.upsert ?? false;
          if (!upsert && simulatedBucket.objects.has(key)) {
            return {
              data: null,
              error: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' },
            };
          }
          simulatedBucket.objects.set(key, {
            body: Buffer.from(body),
            contentType: options?.contentType ?? 'application/pdf',
          });
          return { data: { path: key }, error: null };
        },
        download: async (key: string) => {
          const obj = simulatedBucket.objects.get(key);
          if (!obj) {
            return { data: null, error: { message: 'Object not found' } };
          }
          return {
            data: new Blob([new Uint8Array(obj.body)], { type: obj.contentType }),
            error: null,
          };
        },
        createSignedUrl: async (key: string, expiresIn: number) => {
          if (!simulatedBucket.objects.has(key)) {
            return { data: null, error: { message: 'Object not found' } };
          }
          return {
            data: {
              signedUrl: `https://storage.example.invalid/storage/v1/object/sign/acervo/${key}?token=signed_${expiresIn}`,
            },
            error: null,
          };
        },
      }),
    },
  })),
}));

vi.mock('../../lib/authorization', () => ({
  requireAuthenticatedProfile: vi.fn(async () => {
    if (!authState.currentProfile) {
      const err = new Error('Autenticação necessária.') as Error & { code: string };
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    return authState.currentProfile;
  }),
  requireRole: vi.fn(async (expectedRole: 'estudante' | 'responsavel') => {
    if (!authState.currentProfile) {
      const err = new Error('Autenticação necessária.') as Error & { code: string };
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    if (authState.currentProfile.papel !== expectedRole) {
      const err = new Error('Acesso não autorizado.') as Error & { code: string };
      err.code = 'FORBIDDEN';
      throw err;
    }
    return authState.currentProfile;
  }),
  requireManagedStudentProfile: vi.fn(async () => ESTUDANTE_1),
  assertOwnership: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        const instance = authState.dbInstance as Record<PropertyKey, unknown> | null;
        if (!instance) {
          throw new Error('PGlite dbInstance não inicializado.');
        }
        const value = instance[prop];
        return typeof value === 'function' ? value.bind(instance) : value;
      },
    }
  ),
}));

import { resetSupabaseClientCache } from '../../lib/supabaseStorage';
import {
  LeaseLostError,
  calcularBackoffMs,
  enfileirarJobIngestaoAcervo,
  processarProximoJobAcervo,
  recuperarJobsComLeaseVencido,
  renovarHeartbeatJobAcervo,
} from '../../lib/acervoPipelineWorker';
import {
  enviarArquivo,
  obterStatusJobAcervo,
  retomarProcessamentoArquivoAcervo,
} from './acervo';

describe.skipIf(!HAS_PGLITE)('F1.11 — Fila Durável e Pipeline Retomável (PGlite + Serviços Simulados)', () => {
  let pg: {
    exec: (sql: string) => Promise<unknown>;
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  };

  const rootDir = process.cwd();
  const readSql = (relPath: string) =>
    readFileSync(path.join(rootDir, relPath), 'utf8').replaceAll('--> statement-breakpoint', '\n');

  const sql0000 = readSql('drizzle/0000_greedy_loki.sql');
  const sql0001 = readSql('drizzle/0001_dry_talos.sql');
  const sql0002 = readSql('drizzle/0002_little_swarm.sql');
  const sql0003 = readSql('drizzle/0003_f1_03_r_expansao.sql');
  const fixturesSql = readSql('tests/integration/f1_04/fixtures.sql');
  const f109ProposalSql = readSql('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql');
  const f110StorageProposalSql = readSql('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql');
  const f111QueueProposalSql = readSql('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql');
  const f111QueueRollbackSql = readSql('docs/modernizacao/propostas/F1_11_ROLLBACK_FILA_INGESTAO.sql');

  beforeAll(async () => {
    process.env.SUPABASE_URL = 'https://storage.example.invalid';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-synthetic-test-key';
    delete process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;
    resetSupabaseClientCache();

    const { PGlite, types } = await import(pathToFileURL(PGLITE_INDEX).href);
    const { vector } = await import(pathToFileURL(PGLITE_VECTOR).href);
    pg = await PGlite.create({ extensions: { vector } });

    await pg.exec(sql0000);
    await pg.exec(sql0001);
    await pg.exec(sql0002);
    await pg.exec(sql0003);
    await pg.exec(fixturesSql);
    await pg.exec(f109ProposalSql);
    await pg.exec(f110StorageProposalSql);
    await pg.exec(f111QueueProposalSql);

    const parsers = {
      [types.TIMESTAMP]: (value: unknown) => value,
      [types.TIMESTAMPTZ]: (value: unknown) => value,
      [types.INTERVAL]: (value: unknown) => value,
      [types.DATE]: (value: unknown) => value,
      1231: (value: unknown) => value,
      1115: (value: unknown) => value,
      1185: (value: unknown) => value,
      1187: (value: unknown) => value,
      1182: (value: unknown) => value,
    };

    const proxyDb = drizzle(
      async (queryStr, params, method) => {
        const rowMode = method === 'all' ? 'array' : 'object';
        const res = await (
          pg as unknown as {
            query: (
              sql: string,
              params?: unknown[],
              options?: { rowMode: 'array' | 'object'; parsers: Record<number, (v: unknown) => unknown> }
            ) => Promise<{ rows: unknown[] }>;
          }
        ).query(queryStr, params, { rowMode, parsers });
        return { rows: res.rows };
      },
      { schema }
    );

    authState.dbInstance = proxyDb;
  });

  afterAll(async () => {
    if (pg) {
      await pg.close();
    }
  });

  beforeEach(async () => {
    authState.currentProfile = RESPONSAVEL_1;
    simulatedBucket.objects.clear();
    await pg.exec(`
      DELETE FROM public.acervo_jobs;
      DELETE FROM public.acervo_chunks;
      DELETE FROM public.acervo_paginas;
      DELETE FROM public.acervo_arquivos
       WHERE id NOT IN (
         '60000000-0000-4000-8000-000000000001',
         '60000000-0000-4000-8000-000000000002'
       );
    `);
  });

  const makeValidPdfBase64 = (tag: string) =>
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Title (${tag}) >>\nendobj\n%%EOF\n`).toString('base64');

  const criarEmbeddingSintetico = () => Array.from({ length: 1536 }, (_, idx) => (idx === 0 ? 0.5 : 0.001));

  it('1. Dois workers concorrentes: apenas um worker reivindica e processa o job, sem duplicar páginas ou chunks', async () => {
    const pdfBase64 = makeValidPdfBase64('F1.11 Concorrencia Workers');
    const uploadRes = await enviarArquivo(
      DISCIPLINA_BIOLOGIA,
      'Apostila Concorrência Workers',
      'apostila',
      1,
      'enem',
      'concorrencia.pdf',
      pdfBase64
    );
    expect(uploadRes.ok).toBe(true);
    if (!uploadRes.ok) return;
    const arquivoId = uploadRes.data.arquivoId;

    const deps = {
      extrairTexto: vi.fn(async () => [
        { numero: 1, texto: 'Página 1 sobre biologia celular e mitocôndrias.', metodo: 'nativo' as const, confianca: 100 },
        { numero: 2, texto: 'Página 2 sobre respiração aeróbica e ciclo de Krebs.', metodo: 'nativo' as const, confianca: 100 },
      ]),
      segmentar: vi.fn((paginas: Array<{ numero: number; texto: string }>) =>
        paginas.map((p, i) => ({
          texto: p.texto,
          paginaInicial: p.numero,
          paginaFinal: p.numero,
          ordem: i + 1,
          tipoConteudo: 'exposicao_teorica' as const,
          tokens: 12,
        }))
      ),
      classificarChunk: vi.fn(async () => ({ topicoId: TOPICO_CITOLOGIA, confianca: 92 })),
      gerarEmbeddingReal: vi.fn(async () => criarEmbeddingSintetico()),
    };

    const [resWorker1, resWorker2] = await Promise.all([
      processarProximoJobAcervo('worker-concorrente-1', { ...deps, arquivoId }),
      processarProximoJobAcervo('worker-concorrente-2', { ...deps, arquivoId }),
    ]);

    const vencedores = [resWorker1, resWorker2].filter((r) => r.processado);
    const perdedores = [resWorker1, resWorker2].filter((r) => !r.processado);

    expect(vencedores).toHaveLength(1);
    expect(perdedores).toHaveLength(1);
    expect(vencedores[0]?.statusFinal).toBe('concluido');
    expect(perdedores[0]?.jobId).toBeNull();

    const paginasCount = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.acervo_paginas WHERE arquivo_id = $1`,
      [arquivoId]
    );
    const chunksCount = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.acervo_chunks WHERE arquivo_id = $1`,
      [arquivoId]
    );

    expect(Number(paginasCount.rows[0]?.count)).toBe(2);
    expect(Number(chunksCount.rows[0]?.count)).toBe(2);
    expect(deps.extrairTexto).toHaveBeenCalledTimes(1);
  });

  it('2. Execução duplicada e enfileiramento idempotente: preserva unicidade por arquivo e ignora job já concluído', async () => {
    const pdfBase64 = makeValidPdfBase64('F1.11 Duplicidade Job');
    const uploadRes = await enviarArquivo(
      DISCIPLINA_BIOLOGIA,
      'Livro Idempotência Job',
      'livro',
      2,
      'fuvest',
      'idempotencia.pdf',
      pdfBase64
    );
    expect(uploadRes.ok).toBe(true);
    if (!uploadRes.ok) return;
    const arquivoId = uploadRes.data.arquivoId;

    // Chamadas repetidas de enfileiramento para o mesmo arquivo retornam o mesmo job
    const job1 = await enfileirarJobIngestaoAcervo(arquivoId, RESPONSAVEL_1.id);
    const job2 = await enfileirarJobIngestaoAcervo(arquivoId, RESPONSAVEL_1.id);
    expect(job1.id).toBe(job2.id);

    const deps = {
      extrairTexto: vi.fn(async () => [
        { numero: 1, texto: 'Texto único extraído.', metodo: 'nativo' as const, confianca: 100 },
      ]),
      segmentar: vi.fn(() => [
        {
          texto: 'Texto único extraído.',
          paginaInicial: 1,
          paginaFinal: 1,
          ordem: 1,
          tipoConteudo: 'exposicao_teorica' as const,
          tokens: 10,
        },
      ]),
      classificarChunk: vi.fn(async () => ({ topicoId: TOPICO_CITOLOGIA, confianca: 90 })),
      gerarEmbeddingReal: vi.fn(async () => criarEmbeddingSintetico()),
    };

    const primeiraExecucao = await processarProximoJobAcervo('worker-unico', { ...deps, arquivoId });
    expect(primeiraExecucao.processado).toBe(true);
    expect(primeiraExecucao.statusFinal).toBe('concluido');

    // Segunda execução sobre a fila já concluída não reprocessa nada
    const segundaExecucao = await processarProximoJobAcervo('worker-unico', { ...deps, arquivoId });
    expect(segundaExecucao.processado).toBe(false);
    expect(deps.extrairTexto).toHaveBeenCalledTimes(1);
  });

  it('3. Falha em etapa intermediária e retomada após interrupção: preserva páginas, chunks e classificações anteriores sem reexecutar etapas concluídas', async () => {
    const pdfBase64 = makeValidPdfBase64('F1.11 Falha Intermediaria e Retomada');
    const uploadRes = await enviarArquivo(
      DISCIPLINA_BIOLOGIA,
      'Material Retomável',
      'apostila',
      3,
      'unicamp',
      'retomavel.pdf',
      pdfBase64
    );
    expect(uploadRes.ok).toBe(true);
    if (!uploadRes.ok) return;
    const arquivoId = uploadRes.data.arquivoId;

    const t0 = new Date(Date.now() + 10_000);
    const extrairSpy = vi.fn(async () => [
      { numero: 1, texto: 'Página 1 citologia.', metodo: 'nativo' as const, confianca: 100 },
      { numero: 2, texto: 'Página 2 genética.', metodo: 'nativo' as const, confianca: 100 },
    ]);
    const segmentarSpy = vi.fn(() => [
      {
        texto: 'Chunk 1 citologia.',
        paginaInicial: 1,
        paginaFinal: 1,
        ordem: 1,
        tipoConteudo: 'exposicao_teorica' as const,
        tokens: 15,
      },
      {
        texto: 'Chunk 2 genética.',
        paginaInicial: 2,
        paginaFinal: 2,
        ordem: 2,
        tipoConteudo: 'exposicao_teorica' as const,
        tokens: 15,
      },
    ]);

    let chamadasClassificacao = 0;
    const classificarComFalhaNoSegundoChunk = vi.fn(async () => {
      chamadasClassificacao++;
      if (chamadasClassificacao === 2) {
        throw new Error('Timeout transitório na API de classificação');
      }
      return { topicoId: TOPICO_CITOLOGIA, confianca: 88 };
    });

    // 1ª execução: conclui extracao e segmentacao, classifica o chunk 1 e falha no chunk 2
    const tentativa1 = await processarProximoJobAcervo('worker-1', {
      arquivoId,
      now: () => t0,
      baseBackoffMs: 5_000,
      extrairTexto: extrairSpy,
      segmentar: segmentarSpy,
      classificarChunk: classificarComFalhaNoSegundoChunk,
      gerarEmbeddingReal: async () => criarEmbeddingSintetico(),
    });

    expect(tentativa1.processado).toBe(true);
    expect(tentativa1.statusFinal).toBe('aguardando');
    expect(tentativa1.etapaAtual).toBe('classificacao');
    expect(tentativa1.reagendado).toBe(true);
    expect(tentativa1.tentativas).toBe(1);

    // Páginas e chunks foram preservados, e o chunk 1 já está classificado no banco
    const paginasSalvas = await pg.query<{ numero: number }>(
      `SELECT numero FROM public.acervo_paginas WHERE arquivo_id = $1 ORDER BY numero`,
      [arquivoId]
    );
    expect(paginasSalvas.rows).toHaveLength(2);

    const chunksSalvos = await pg.query<{ ordem: number; confianca_classificacao: number | null }>(
      `SELECT ordem, confianca_classificacao FROM public.acervo_chunks WHERE arquivo_id = $1 ORDER BY ordem`,
      [arquivoId]
    );
    expect(chunksSalvos.rows).toEqual([
      { ordem: 1, confianca_classificacao: 88 },
      { ordem: 2, confianca_classificacao: null },
    ]);

    // Antes do backoff expirar (t0 + 2s < t0 + 5s), o job não é elegível
    const antesDoBackoff = await processarProximoJobAcervo('worker-1', {
      arquivoId,
      now: () => new Date(t0.getTime() + 2_000),
    });
    expect(antesDoBackoff.processado).toBe(false);

    // Após o backoff (t0 + 6s), o worker retoma diretamente em `classificacao`:
    // não baixa nem extrai o PDF de novo, não segmenta de novo, e classifica apenas o chunk 2 pendente!
    const classificarRetomadaSpy = vi.fn(async () => ({ topicoId: TOPICO_CITOLOGIA, confianca: 94 }));
    const tentativa2 = await processarProximoJobAcervo('worker-2', {
      arquivoId,
      now: () => new Date(t0.getTime() + 6_000),
      extrairTexto: extrairSpy,
      segmentar: segmentarSpy,
      classificarChunk: classificarRetomadaSpy,
      gerarEmbeddingReal: async () => criarEmbeddingSintetico(),
    });

    expect(tentativa2.processado).toBe(true);
    expect(tentativa2.statusFinal).toBe('concluido');
    expect(tentativa2.etapaAtual).toBe('concluido');
    expect(tentativa2.tentativas).toBe(2);

    // Extração e segmentação foram executadas apenas na 1ª tentativa
    expect(extrairSpy).toHaveBeenCalledTimes(1);
    expect(segmentarSpy).toHaveBeenCalledTimes(1);
    // Na retomada, apenas o chunk 2 (que estava sem classificação) foi classificado
    expect(classificarRetomadaSpy).toHaveBeenCalledTimes(1);
    expect(classificarRetomadaSpy).toHaveBeenCalledWith('Chunk 2 genética.', DISCIPLINA_BIOLOGIA);
  });

  it('4. Ausência de sucesso fictício sem provedor de embeddings e conclusão real após retomada na etapa de indexação', async () => {
    const pdfBase64 = makeValidPdfBase64('F1.11 Sem Conclusao Ficticia');
    const uploadRes = await enviarArquivo(
      DISCIPLINA_BIOLOGIA,
      'Livro Indexação Honesta',
      'livro',
      1,
      'enem',
      'indexacao-honesta.pdf',
      pdfBase64
    );
    expect(uploadRes.ok).toBe(true);
    if (!uploadRes.ok) return;
    const arquivoId = uploadRes.data.arquivoId;

    const extrairSpy = vi.fn(async () => [
      { numero: 1, texto: 'Conteúdo página 1 para indexação.', metodo: 'nativo' as const, confianca: 100 },
    ]);
    const segmentarSpy = vi.fn(() => [
      {
        texto: 'Conteúdo página 1 para indexação.',
        paginaInicial: 1,
        paginaFinal: 1,
        ordem: 1,
        tipoConteudo: 'exposicao_teorica' as const,
        tokens: 8,
      },
    ]);
    const classificarSpy = vi.fn(async () => ({ topicoId: TOPICO_CITOLOGIA, confianca: 91 }));

    // Sem `gerarEmbeddingReal`, o pipeline avança até `indexacao` e para como `falhou`
    const resSemEmbeddings = await processarProximoJobAcervo('worker-sem-embedding', {
      arquivoId,
      extrairTexto: extrairSpy,
      segmentar: segmentarSpy,
      classificarChunk: classificarSpy,
      gerarEmbeddingReal: null,
    });

    expect(resSemEmbeddings.processado).toBe(true);
    expect(resSemEmbeddings.statusFinal).toBe('falhou');
    expect(resSemEmbeddings.etapaAtual).toBe('indexacao');
    expect(resSemEmbeddings.reagendado).toBe(false);
    expect(resSemEmbeddings.erroCodigo).toBe('EMBEDDING_PROVIDER_UNAVAILABLE');

    // Confirma que `acervo_arquivos` NÃO está marcado como concluído
    const statusArquivo = await pg.query<{ status_processamento: string }>(
      `SELECT status_processamento FROM public.acervo_arquivos WHERE id = $1`,
      [arquivoId]
    );
    expect(statusArquivo.rows[0]?.status_processamento).toBe('falhou');

    // Quando o responsável solicita retomada e o provedor de embeddings está disponível,
    // o job retoma diretamente da etapa `indexacao` sem repetir extração, segmentação ou classificação
    const retomadaAction = await retomarProcessamentoArquivoAcervo(arquivoId);
    expect(retomadaAction).toMatchObject({
      ok: true,
      data: {
        arquivoId,
        status: 'aguardando',
        etapaAtual: 'indexacao',
      },
    });

    const resComEmbeddings = await processarProximoJobAcervo('worker-com-embedding', {
      arquivoId,
      extrairTexto: extrairSpy,
      segmentar: segmentarSpy,
      classificarChunk: classificarSpy,
      gerarEmbeddingReal: async () => criarEmbeddingSintetico(),
    });

    expect(resComEmbeddings.processado).toBe(true);
    expect(resComEmbeddings.statusFinal).toBe('concluido');
    expect(resComEmbeddings.etapaAtual).toBe('concluido');
    expect(extrairSpy).toHaveBeenCalledTimes(1);
    expect(segmentarSpy).toHaveBeenCalledTimes(1);
    expect(classificarSpy).toHaveBeenCalledTimes(1);

    const statusArquivoFinal = await pg.query<{ status_processamento: string }>(
      `SELECT status_processamento FROM public.acervo_arquivos WHERE id = $1`,
      [arquivoId]
    );
    expect(statusArquivoFinal.rows[0]?.status_processamento).toBe('concluido');
  });

  it('5. Lease vencido: recupera trabalho interrompido e bloqueia worker atrasado com LeaseLostError', async () => {
    const pdfBase64 = makeValidPdfBase64('F1.11 Lease Vencido');
    const uploadRes = await enviarArquivo(
      DISCIPLINA_BIOLOGIA,
      'Prova Lease Expirado',
      'apostila',
      3,
      'enem',
      'lease-vencido.pdf',
      pdfBase64
    );
    expect(uploadRes.ok).toBe(true);
    if (!uploadRes.ok) return;
    const arquivoId = uploadRes.data.arquivoId;

    const t0 = new Date('2026-10-20T14:00:00.000Z');

    // Simula worker-lento travado no meio da execução com lease que expira em t0 + 10s
    await pg.query(
      `UPDATE public.acervo_jobs
          SET status = 'em_execucao',
              etapa_atual = 'segmentacao',
              tentativas = 1,
              locked_by = 'worker-lento',
              locked_at = $2,
              heartbeat_at = $2,
              lease_expires_at = $3
        WHERE arquivo_id = $1`,
      [arquivoId, t0.toISOString(), new Date(t0.getTime() + 10_000).toISOString()]
    );

    // Em t0 + 15s o lease está vencido; rotina de recuperação reenfileira preservando `etapa_atual = 'segmentacao'`
    const tRecuperacao = new Date(t0.getTime() + 15_000);
    const recuperados = await recuperarJobsComLeaseVencido({
      now: tRecuperacao,
      baseBackoffMs: 1_000,
    });
    expect(recuperados.reenfileirados).toHaveLength(1);
    expect(recuperados.esgotados).toHaveLength(0);

    // Se o worker-lento acordar atrasado e tentar renovar o heartbeat, recebe LeaseLostError
    const jobRow = await pg.query<{ id: string }>(
      `SELECT id FROM public.acervo_jobs WHERE arquivo_id = $1`,
      [arquivoId]
    );
    const jobId = jobRow.rows[0]!.id;

    await expect(
      renovarHeartbeatJobAcervo(jobId, 'worker-lento', { now: tRecuperacao })
    ).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('6. Limite de tentativas (maxTentativas) e sanitização de erros: encerra como falhou sem vazar segredos', async () => {
    const pdfBase64 = makeValidPdfBase64('F1.11 Max Tentativas');
    const uploadRes = await enviarArquivo(
      DISCIPLINA_BIOLOGIA,
      'Apostila Limite Retries',
      'apostila',
      2,
      'enem',
      'max-tentativas.pdf',
      pdfBase64
    );
    expect(uploadRes.ok).toBe(true);
    if (!uploadRes.ok) return;
    const arquivoId = uploadRes.data.arquivoId;

    // Configura max_tentativas = 2 para validar exaustão rápida
    await pg.query(
      `UPDATE public.acervo_jobs SET max_tentativas = 2 WHERE arquivo_id = $1`,
      [arquivoId]
    );

    const t0 = new Date(Date.now() + 10_000);
    const falhaComSegredo = async (): Promise<never> => {
      throw new Error(
        'Falha na conexão postgresql://postgres:senhaSuperSecreta@db.interno:5432/medicina secret=chave-privada-123'
      );
    };

    // Tentativa 1 (1 < 2) -> reagendado para aguardando com backoff
    const res1 = await processarProximoJobAcervo('worker-retry', {
      arquivoId,
      now: () => t0,
      baseBackoffMs: 1_000,
      extrairTexto: falhaComSegredo,
    });
    expect(res1.statusFinal).toBe('aguardando');
    expect(res1.reagendado).toBe(true);
    expect(res1.tentativas).toBe(1);
    expect(calcularBackoffMs(1, 1_000)).toBe(1_000);
    expect(calcularBackoffMs(2, 1_000)).toBe(2_000);

    // Tentativa 2 (2 == max_tentativas) -> falha terminal (`falhou`, `reagendado: false`)
    const res2 = await processarProximoJobAcervo('worker-retry', {
      arquivoId,
      now: () => new Date(t0.getTime() + 2_000),
      baseBackoffMs: 1_000,
      extrairTexto: falhaComSegredo,
    });
    expect(res2.statusFinal).toBe('falhou');
    expect(res2.reagendado).toBe(false);
    expect(res2.tentativas).toBe(2);

    // Verifica que nenhum segredo vazou no banco e que o job não é mais reivindicado
    const jobFinal = await pg.query<{ status: string; ultimo_erro_mensagem: string }>(
      `SELECT status, ultimo_erro_mensagem FROM public.acervo_jobs WHERE arquivo_id = $1`,
      [arquivoId]
    );
    expect(jobFinal.rows[0]?.status).toBe('falhou');
    expect(jobFinal.rows[0]?.ultimo_erro_mensagem).not.toContain('senhaSuperSecreta');
    expect(jobFinal.rows[0]?.ultimo_erro_mensagem).not.toContain('chave-privada-123');
    expect(jobFinal.rows[0]?.ultimo_erro_mensagem).not.toContain('postgresql://');

    const res3 = await processarProximoJobAcervo('worker-retry', {
      arquivoId,
      now: () => new Date(t0.getTime() + 60_000),
    });
    expect(res3.processado).toBe(false);
  });

  it('7. Ownership e autorização em obterStatusJobAcervo e retomarProcessamentoArquivoAcervo + verificação de hash no worker', async () => {
    const pdfBase64 = makeValidPdfBase64('F1.11 Ownership Job');
    const uploadRes = await enviarArquivo(
      DISCIPLINA_BIOLOGIA,
      'Livro Ownership Job',
      'livro',
      1,
      'enem',
      'ownership-job.pdf',
      pdfBase64
    );
    expect(uploadRes.ok).toBe(true);
    if (!uploadRes.ok) return;
    const arquivoId = uploadRes.data.arquivoId;

    // Estudante -> FORBIDDEN
    authState.currentProfile = ESTUDANTE_1;
    await expect(obterStatusJobAcervo(arquivoId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(retomarProcessamentoArquivoAcervo(arquivoId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    // Outro responsável (RESPONSAVEL_2) -> NOT_FOUND (sem vazamento cross-owner)
    authState.currentProfile = RESPONSAVEL_2;
    expect(await obterStatusJobAcervo(arquivoId)).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await retomarProcessamentoArquivoAcervo(arquivoId)).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });

    // Responsável proprietário (RESPONSAVEL_1) -> autorizado
    authState.currentProfile = RESPONSAVEL_1;
    const statusProprietario = await obterStatusJobAcervo(arquivoId);
    expect(statusProprietario).toMatchObject({
      ok: true,
      data: {
        arquivoId,
        status: 'aguardando',
        etapaAtual: 'extracao',
      },
    });

    // Se o conteúdo no Storage divergir do hash SHA-256 registrado em acervo_arquivos,
    // o worker rejeita imediatamente com STORAGE_HASH_MISMATCH (não retentável)
    const bufferAdulterado = Buffer.from('%PDF-1.4\nconteudo adulterado no bucket\n%%EOF');
    const hashOriginal = crypto
      .createHash('sha256')
      .update(Buffer.from(pdfBase64, 'base64'))
      .digest('hex');
    simulatedBucket.objects.set(`acervo/${hashOriginal}.pdf`, {
      body: bufferAdulterado,
      contentType: 'application/pdf',
    });

    const resAdulterado = await processarProximoJobAcervo('worker-hash-check', { arquivoId });
    expect(resAdulterado.statusFinal).toBe('falhou');
    expect(resAdulterado.reagendado).toBe(false);
    expect(resAdulterado.erroCodigo).toBe('STORAGE_HASH_MISMATCH');
  });

  it('8. Rollback SQL (F1_11_ROLLBACK_FILA_INGESTAO.sql) e reaplicação idempotente com backfill determinístico', async () => {
    await pg.exec(f111QueueRollbackSql);

    const tabelaAposRollback = await pg.query<{ reg: string | null }>(
      `SELECT to_regclass('public.acervo_jobs')::text AS reg`
    );
    expect(tabelaAposRollback.rows[0]?.reg).toBeNull();

    // Reaplica a proposta F1.11 e verifica que a tabela e o backfill dos arquivos de fixture são recriados
    await pg.exec(f111QueueProposalSql);

    const jobsBackfill = await pg.query<{ arquivo_id: string; status: string; etapa_atual: string }>(
      `SELECT arquivo_id::text, status, etapa_atual
         FROM public.acervo_jobs
        WHERE arquivo_id IN (
          '60000000-0000-4000-8000-000000000001',
          '60000000-0000-4000-8000-000000000002'
        )
        ORDER BY arquivo_id`
    );
    expect(jobsBackfill.rows).toHaveLength(2);
  });
});
