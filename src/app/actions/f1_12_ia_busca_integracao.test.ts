import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

const ESTUDANTE_2 = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'a0000000-0000-4000-8000-000000000002',
  nome: 'Estudante Ficticia 2 F1.04',
  email: 'estudante2.f104@example.invalid',
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
  failNextSelect: false,
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
      }),
    },
  })),
}));

vi.mock('../../lib/authorization', () => {
  class AuthorizationError extends Error {
    readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN';

    constructor(code: 'UNAUTHENTICATED' | 'FORBIDDEN') {
      super(code === 'UNAUTHENTICATED' ? 'Autenticação necessária.' : 'Acesso não autorizado.');
      this.name = 'AuthorizationError';
      this.code = code;
    }
  }

  return {
    AuthorizationError,
    requireAuthenticatedProfile: vi.fn(async () => {
      if (!authState.currentProfile) {
        throw new AuthorizationError('UNAUTHENTICATED');
      }
      return authState.currentProfile;
    }),
    requireRole: vi.fn(async (expectedRole: 'estudante' | 'responsavel') => {
      if (!authState.currentProfile) {
        throw new AuthorizationError('UNAUTHENTICATED');
      }
      if (authState.currentProfile.papel !== expectedRole) {
        throw new AuthorizationError('FORBIDDEN');
      }
      return authState.currentProfile;
    }),
    requireManagedStudentProfile: vi.fn(async () => ESTUDANTE_1),
    assertOwnership: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        const instance = authState.dbInstance as Record<PropertyKey, unknown> | null;
        if (!instance) {
          throw new Error('PGlite dbInstance não inicializado.');
        }
        if (prop === 'select' && authState.failNextSelect) {
          authState.failNextSelect = false;
          return () => {
            throw new Error('Simulated DB SELECT failure during vector search');
          };
        }
        const value = instance[prop];
        return typeof value === 'function' ? value.bind(instance) : value;
      },
    }
  ),
}));

import { resetSupabaseClientCache } from '../../lib/supabaseStorage';
import {
  GeminiEmbeddingError,
  GeminiOcrError,
  extrairTextoPDF,
} from '../../lib/ingestion';
import { processarProximoJobAcervo } from '../../lib/acervoPipelineWorker';
import { enviarArquivo, retomarProcessamentoArquivoAcervo } from './acervo';
import { buscarNoAcervo } from './busca';
import { curarItem, enfileirarGeracaoDeArtefatos, obterFilaCuradoria } from './curadoria';

describe.skipIf(!HAS_PGLITE)(
  'F1.12 — IA Real, OCR, Proveniência e Busca Semântica (PGlite + pgvector + Serviços Simulados)',
  () => {
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
    const f109ProposalSql = readSql(
      'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'
    );
    const f110StorageProposalSql = readSql(
      'docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql'
    );
    const f111QueueProposalSql = readSql(
      'docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql'
    );
    const f112SearchProposalSql = readSql(
      'docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'
    );
    const f112SearchRollbackSql = readSql(
      'docs/modernizacao/propostas/F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql'
    );

    beforeAll(async () => {
      process.env.SUPABASE_URL = 'https://storage.example.invalid';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-synthetic-test-key';
      process.env.GEMINI_API_KEY = 'gemini-synthetic-test-key';
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
      await pg.exec(f112SearchProposalSql);

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

      let txDepth = 0;
      (
        proxyDb as unknown as {
          transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
        }
      ).transaction = async (callback) => {
        const savepoint = `sp_f112_${++txDepth}`;
        await pg.exec(txDepth === 1 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        try {
          const result = await callback(proxyDb);
          await pg.exec(txDepth === 1 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
          txDepth--;
          return result;
        } catch (err) {
          await pg.exec(txDepth === 1 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`);
          txDepth--;
          throw err;
        }
      };

      authState.dbInstance = proxyDb;
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      if (pg) {
        await pg.close();
      }
    });

    beforeEach(async () => {
      authState.currentProfile = RESPONSAVEL_1;
      authState.failNextSelect = false;
      simulatedBucket.objects.clear();
      await pg.exec(`
        DELETE FROM public.curadoria_fila;
        DELETE FROM public.geracoes;
        DELETE FROM public.cards WHERE frente LIKE '%complexo golgiense%';
        DELETE FROM public.materiais WHERE titulo LIKE '%Golgiense%';
        DELETE FROM public.perguntas_ativas WHERE pergunta LIKE '%complexo golgiense%';
        DELETE FROM public.questoes WHERE enunciado LIKE '%complexo golgiense%';
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

    // Vetores unitários ortogonais em 1536 dimensões para testes determinísticos de similaridade de cosseno
    const vetorEixo = (eixoPrimario: number, pesoPrimario = 1, eixoSecundario = 0, pesoSecundario = 0) => {
      const raw = Array.from({ length: 1536 }, (_, idx) => {
        if (idx === eixoPrimario) return pesoPrimario;
        if (pesoSecundario !== 0 && idx === eixoSecundario) return pesoSecundario;
        return 0;
      });
      const mag = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
      return raw.map((v) => v / mag);
    };

    it('1. PDF digitalizado, falha de OCR, página sem texto e retomada no worker preservando numeração de página', async () => {
      const pdfBase64 = makeValidPdfBase64('F1.12 OCR Digitalizado');
      const uploadRes = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Apostila Digitalizada Citologia',
        'apostila',
        1,
        'enem',
        'digitalizado.pdf',
        pdfBase64
      );
      expect(uploadRes.ok).toBe(true);
      if (!uploadRes.ok) return;
      const arquivoId = uploadRes.data.arquivoId;

      const t0 = new Date(Date.now() + 10_000);

      // 1ª tentativa: OCR falha com timeout -> reagenda na etapa `extracao` sem inventar texto
      const resFalhaOcr = await processarProximoJobAcervo('worker-ocr-1', {
        arquivoId,
        now: () => t0,
        baseBackoffMs: 1_000,
        extrairTexto: (buf) =>
          extrairTextoPDF(buf, {
            parsePdfNativo: async () => ({ text: '\f\f', numpages: 3 }),
            executarOcrDocumento: async () => {
              throw new GeminiOcrError('TIMEOUT');
            },
          }),
      });

      expect(resFalhaOcr.processado).toBe(true);
      expect(resFalhaOcr.statusFinal).toBe('aguardando');
      expect(resFalhaOcr.etapaAtual).toBe('extracao');
      expect(resFalhaOcr.reagendado).toBe(true);
      expect(resFalhaOcr.erroCodigo).toBe('OCR_TIMEOUT');

      // 2ª tentativa após backoff: página 1 tem texto OCR, página 2 está em branco ("") e página 3 tem texto OCR
      const resSucessoOcr = await processarProximoJobAcervo('worker-ocr-2', {
        arquivoId,
        now: () => new Date(t0.getTime() + 2_000),
        extrairTexto: (buf) =>
          extrairTextoPDF(buf, {
            parsePdfNativo: async () => ({ text: '\f\f', numpages: 3 }),
            executarOcrDocumento: async () => [
              {
                numero: 1,
                texto: 'Citologia Ficticia: estudo das organelas citoplasmáticas e mitocôndrias.',
                confianca: 0.94,
              },
              {
                numero: 2,
                texto: '   ',
                confianca: 0,
              },
              {
                numero: 3,
                texto: 'Citologia Ficticia: membrana plasmática e transporte ativo.',
                confianca: 0.91,
              },
            ],
          }),
        gerarEmbeddingReal: async () => vetorEixo(0),
      });

      expect(resSucessoOcr.statusFinal).toBe('concluido');

      const paginas = await pg.query<{ numero: number; metodo_extracao: string; confianca_ocr: number }>(
        `SELECT numero, metodo_extracao, confianca_ocr
           FROM public.acervo_paginas
          WHERE arquivo_id = $1
          ORDER BY numero`,
        [arquivoId]
      );

      // A página 2 em branco não recebe texto inventado e a página 3 mantém seu número original (3)
      expect(paginas.rows).toEqual([
        { numero: 1, metodo_extracao: 'ocr', confianca_ocr: 0.94 },
        { numero: 3, metodo_extracao: 'ocr', confianca_ocr: 0.91 },
      ]);
    });

    it('2. Embedding com dimensão incompatível falha sem retry; falha transitória na indexação preserva vetores já gerados sem custo duplicado', async () => {
      const pdfBase64 = makeValidPdfBase64('F1.12 Embeddings Dimensao e Retomada');
      const uploadRes = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Livro Indexação Resiliente',
        'livro',
        2,
        'enem',
        'indexacao-resiliente.pdf',
        pdfBase64
      );
      expect(uploadRes.ok).toBe(true);
      if (!uploadRes.ok) return;
      const arquivoId = uploadRes.data.arquivoId;

      const t0 = new Date(Date.now() + 10_000);

      // Caso A: provedor retorna vetor com 768 dimensões em vez de 1536 -> falha terminal imediata
      const resDimInvalida = await processarProximoJobAcervo('worker-dim', {
        arquivoId,
        now: () => t0,
        extrairTexto: async () => [
          { numero: 1, texto: 'Citologia Ficticia: ribossomos e síntese proteica.', metodo: 'nativo', confianca: 1 },
          { numero: 2, texto: 'Genetica Ficticia: leis de Mendel e alelos.', metodo: 'nativo', confianca: 1 },
        ],
        segmentar: (pags) =>
          pags.map((p, idx) => ({
            paginaInicial: p.numero,
            paginaFinal: p.numero,
            ordem: idx + 1,
            texto: p.texto,
            tipoConteudo: 'exposicao_teorica',
            tokens: 12,
          })),
        gerarEmbeddingReal: async () => [0.1, 0.2, 0.3], // Dimensão incompatível (3 != 1536)
      });

      expect(resDimInvalida.statusFinal).toBe('falhou');
      expect(resDimInvalida.reagendado).toBe(false);
      expect(resDimInvalida.erroCodigo).toBe('EMBEDDING_DIMENSION_MISMATCH');

      // Caso B: responsável solicita retomada; provedor calcula chunk 1 com sucesso e dá timeout no chunk 2
      await retomarProcessamentoArquivoAcervo(arquivoId);

      const textosIndexadosTentativa1: string[] = [];
      const resTimeoutNoChunk2 = await processarProximoJobAcervo('worker-idx-1', {
        arquivoId,
        now: () => new Date(t0.getTime() + 5_000),
        baseBackoffMs: 1_000,
        gerarEmbeddingReal: async (texto) => {
          textosIndexadosTentativa1.push(texto);
          if (textosIndexadosTentativa1.length === 2) {
            throw new GeminiEmbeddingError('TIMEOUT');
          }
          return vetorEixo(0);
        },
      });

      expect(resTimeoutNoChunk2.statusFinal).toBe('aguardando');
      expect(resTimeoutNoChunk2.etapaAtual).toBe('indexacao');
      expect(resTimeoutNoChunk2.reagendado).toBe(true);
      expect(resTimeoutNoChunk2.erroCodigo).toBe('EMBEDDING_TIMEOUT');
      expect(textosIndexadosTentativa1).toHaveLength(2);

      // Na retomada após backoff, apenas o chunk 2 (que ainda estava com embedding NULL) chama a API!
      const textosIndexadosTentativa2: string[] = [];
      const resRetomadaChunk2 = await processarProximoJobAcervo('worker-idx-2', {
        arquivoId,
        now: () => new Date(t0.getTime() + 10_000),
        gerarEmbeddingReal: async (texto) => {
          textosIndexadosTentativa2.push(texto);
          return vetorEixo(1);
        },
      });

      expect(resRetomadaChunk2.statusFinal).toBe('concluido');
      expect(textosIndexadosTentativa2).toEqual(['Genetica Ficticia: leis de Mendel e alelos.']);
    });

    it('3. Busca semântica real (pgvector + FTS), proveniência, busca sem resultados, falha de provedor/banco e isolamento de ownership', async () => {
      // Responsável 1 envia e processa arquivo com 2 chunks distintos
      authState.currentProfile = RESPONSAVEL_1;
      const upR1 = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Tratado de Biologia Celular R1',
        'livro',
        1,
        'enem',
        'biologia-r1.pdf',
        makeValidPdfBase64('F1.12 Busca R1')
      );
      expect(upR1.ok).toBe(true);
      if (!upR1.ok) return;
      const arquivoR1 = upR1.data.arquivoId;

      await processarProximoJobAcervo('worker-busca-r1', {
        arquivoId: arquivoR1,
        extrairTexto: async () => [
          {
            numero: 10,
            texto: 'Citologia Ficticia: a fosforilação oxidativa ocorre nas cristas mitocondriais gerando ATP.',
            metodo: 'nativo',
            confianca: 1,
          },
          {
            numero: 25,
            texto: 'Genetica Ficticia: segregação independente dos fatores hereditários na meiose.',
            metodo: 'nativo',
            confianca: 1,
          },
        ],
        segmentar: (pags) =>
          pags.map((p, idx) => ({
            paginaInicial: p.numero,
            paginaFinal: p.numero,
            ordem: idx + 1,
            texto: p.texto,
            tipoConteudo: 'exposicao_teorica',
            tokens: 18,
          })),
        gerarEmbeddingReal: async (texto) =>
          texto.includes('mitocondriais') ? vetorEixo(0, 1, 2, 0.2) : vetorEixo(1, 1, 2, 0.2),
      });

      // Responsável 2 envia e processa um arquivo privado dele
      authState.currentProfile = RESPONSAVEL_2;
      const upR2 = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Apostila Exclusiva R2',
        'apostila',
        1,
        'enem',
        'exclusiva-r2.pdf',
        makeValidPdfBase64('F1.12 Busca R2')
      );
      expect(upR2.ok).toBe(true);
      if (!upR2.ok) return;
      const arquivoR2 = upR2.data.arquivoId;

      await processarProximoJobAcervo('worker-busca-r2', {
        arquivoId: arquivoR2,
        extrairTexto: async () => [
          {
            numero: 4,
            texto: 'Conteúdo exclusivo do Responsável 2 sobre botânica criptogâmica.',
            metodo: 'nativo',
            confianca: 1,
          },
        ],
        gerarEmbeddingReal: async () => vetorEixo(5),
      });

      // 3.1 Responsável 1 busca por mitocôndrias -> recebe o chunk da página 10 em 1º lugar com proveniência completa
      authState.currentProfile = RESPONSAVEL_1;
      const resultadosR1 = await buscarNoAcervo('cristas mitocondriais ATP', DISCIPLINA_BIOLOGIA, {
        gerarEmbeddingQuery: async () => vetorEixo(0, 1, 2, 0.2),
      });

      expect(resultadosR1.length).toBeGreaterThanOrEqual(1);
      expect(resultadosR1[0]).toMatchObject({
        arquivoId: arquivoR1,
        arquivoTitulo: 'Tratado de Biologia Celular R1',
        paginaInicial: 10,
        paginaFinal: 10,
        topicoId: TOPICO_CITOLOGIA,
      });
      expect(resultadosR1[0]?.texto).toContain('fosforilação oxidativa');
      expect(resultadosR1[0]?.similaridade).toBeGreaterThan(0.8);

      // 3.2 Estudante 1 (vinculada ao Responsável 1) acessa o acervo do Responsável 1, mas NÃO o do Responsável 2
      authState.currentProfile = ESTUDANTE_1;
      const resultadosEstudante1 = await buscarNoAcervo('cristas mitocondriais', undefined, {
        gerarEmbeddingQuery: async () => vetorEixo(0, 1, 2, 0.2),
      });
      expect(resultadosEstudante1).toHaveLength(1);
      expect(resultadosEstudante1[0]?.arquivoId).toBe(arquivoR1);

      const tentativaCrossTenantEstudante1 = await buscarNoAcervo('botânica criptogâmica', undefined, {
        gerarEmbeddingQuery: async () => vetorEixo(5),
      });
      expect(tentativaCrossTenantEstudante1).toEqual([]);

      // 3.3 Estudante 2 (sem vínculo com Responsável 1) e Responsável 2 não acessam arquivos do Responsável 1
      authState.currentProfile = ESTUDANTE_2;
      const tentativaEstudante2 = await buscarNoAcervo('cristas mitocondriais', undefined, {
        gerarEmbeddingQuery: async () => vetorEixo(0, 1, 2, 0.2),
      });
      expect(tentativaEstudante2).toEqual([]);

      authState.currentProfile = RESPONSAVEL_2;
      const tentativaResponsavel2 = await buscarNoAcervo('cristas mitocondriais', undefined, {
        gerarEmbeddingQuery: async () => vetorEixo(0, 1, 2, 0.2),
      });
      expect(tentativaResponsavel2).toEqual([]);

      // 3.4 Busca sem resultados (vetor ortogonal abaixo do limiar de similaridade) retorna [] sem erro
      authState.currentProfile = RESPONSAVEL_1;
      const semResultados = await buscarNoAcervo('assunto inexistente no acervo', undefined, {
        gerarEmbeddingQuery: async () => vetorEixo(99),
        minSimilaridade: 0.5,
      });
      expect(semResultados).toEqual([]);

      // 3.5 Falha do provedor de embeddings -> EXTERNAL_SERVICE_ERROR
      await expect(
        buscarNoAcervo('termo qualquer', undefined, {
          gerarEmbeddingQuery: async () => {
            throw new GeminiEmbeddingError('TIMEOUT');
          },
        })
      ).rejects.toMatchObject({
        code: 'EXTERNAL_SERVICE_ERROR',
      });

      // 3.6 Falha do banco durante a busca -> PERSISTENCE_ERROR
      authState.failNextSelect = true;
      await expect(
        buscarNoAcervo('termo qualquer', undefined, {
          gerarEmbeddingQuery: async () => vetorEixo(0),
        })
      ).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
      });

      // 3.7 Usuário não autenticado -> UNAUTHENTICATED
      authState.currentProfile = null;
      await expect(buscarNoAcervo('termo qualquer')).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    });

    it('4. Proveniência verificável e ausência de aprovação automática na geração e curadoria', async () => {
      authState.currentProfile = RESPONSAVEL_1;
      process.env.GEMINI_API_KEY = 'synthetic-gemini-key';

      const upRes = await enviarArquivo(
        DISCIPLINA_BIOLOGIA,
        'Manual de Citologia Clínica',
        'livro',
        1,
        'enem',
        'citologia-clinica.pdf',
        makeValidPdfBase64('F1.12 Curadoria Proveniencia')
      );
      expect(upRes.ok).toBe(true);
      if (!upRes.ok) return;
      const arquivoId = upRes.data.arquivoId;

      await processarProximoJobAcervo('worker-curadoria', {
        arquivoId,
        extrairTexto: async () => [
          {
            numero: 7,
            texto: 'Citologia Ficticia: complexo golgiense e secreção celular.',
            metodo: 'nativo',
            confianca: 1,
          },
        ],
        gerarEmbeddingReal: async () => vetorEixo(3),
      });

      const chunksReais = await pg.query<{ id: string }>(
        `SELECT id::text AS id FROM public.acervo_chunks WHERE arquivo_id = $1`,
        [arquivoId]
      );
      expect(chunksReais.rows).toHaveLength(1);
      const chunkIdEsperado = chunksReais.rows[0]!.id;

      // Simula resposta estruturada do Gemini para `enfileirarGeracaoDeArtefatos`
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      resumo: {
                        titulo: 'Resumo Complexo Golgiense',
                        corpo: 'Síntese sobre secreção celular e lisossomos.',
                        tempoLeituraMin: 4,
                      },
                      flashcards: [
                        {
                          pergunta: 'Qual a função principal do complexo golgiense?',
                          resposta: 'Secreção celular, glicosilação e formação de lisossomos.',
                        },
                      ],
                      questoes: [
                        {
                          enunciado: 'Assinale a alternativa correta sobre o complexo golgiense:',
                          alternativas: [
                            { letra: 'A', texto: 'Realiza empacotamento e secreção de proteínas.' },
                            { letra: 'B', texto: 'Realiza fotossíntese.' },
                          ],
                          gabarito: 'A',
                          resolucao: 'O complexo de Golgi processa e endereça vesículas secretoras.',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      } as Response);

      const geracaoRes = await enfileirarGeracaoDeArtefatos(arquivoId);
      expect(geracaoRes).toEqual({
        ok: true,
        data: {
          itensGerados: 3,
          status: 'pendente_curadoria',
          mensagem: 'Artefatos gerados como rascunho e enviados para revisão do responsável.',
        },
      });

      // Verifica no PostgreSQL que NENHUM item foi aprovado automaticamente e TODOS têm proveniência (fonte_chunk_ids)
      const [resumoRow] = (
        await pg.query<{ status: string; origem: string; fonte_chunk_ids: string[] }>(
          `SELECT status::text, origem::text, fonte_chunk_ids
             FROM public.materiais
            WHERE titulo = 'Resumo Complexo Golgiense'`
        )
      ).rows;
      expect(resumoRow).toEqual({
        status: 'rascunho',
        origem: 'gerado',
        fonte_chunk_ids: [chunkIdEsperado],
      });

      const [flashcardRow] = (
        await pg.query<{ id: string; status: string; fonte_chunk_ids: string[] }>(
          `SELECT id::text, status::text, fonte_chunk_ids
             FROM public.perguntas_ativas
            WHERE pergunta LIKE '%complexo golgiense%'`
        )
      ).rows;
      expect(flashcardRow).toMatchObject({
        status: 'rascunho',
        fonte_chunk_ids: [chunkIdEsperado],
      });

      const [questaoRow] = (
        await pg.query<{
          status: string;
          procedencia: string;
          fonte: string;
          arquivo_origem_id: string;
          fonte_chunk_ids: string[];
        }>(
          `SELECT status::text, procedencia::text, fonte, arquivo_origem_id::text, fonte_chunk_ids
             FROM public.questoes
            WHERE arquivo_origem_id = $1`,
          [arquivoId]
        )
      ).rows;
      expect(questaoRow).toEqual({
        status: 'rascunho',
        procedencia: 'gerada',
        fonte: 'Acervo: Manual de Citologia Clínica (p. 7)',
        arquivo_origem_id: arquivoId,
        fonte_chunk_ids: [chunkIdEsperado],
      });

      // Verifica que ao aprovar humanamente o flashcard na curadoria, o card FSRS herda `fonte_chunk_ids`
      const filaPendente = await obterFilaCuradoria();
      const itemFlashcard = filaPendente.find((item) => item.artefatoTipo === 'flashcard');
      expect(itemFlashcard).toBeDefined();

      const aprovacaoRes = await curarItem(itemFlashcard!.curadoriaId, 'aprovado');
      expect(aprovacaoRes.ok).toBe(true);

      const cardsGerados = await pg.query<{ status: string; fonte_chunk_ids: string[] }>(
        `SELECT status::text, fonte_chunk_ids
           FROM public.cards
          WHERE origem = 'gerado' AND frente LIKE '%complexo golgiense%'`
      );
      expect(cardsGerados.rows[0]).toEqual({
        status: 'aprovado',
        fonte_chunk_ids: [chunkIdEsperado],
      });
    });

    it('5. Proposta SQL F1.12: bloqueia artefato gerado sem proveniência e suporta rollback e reaplicação idempotente', async () => {
      // A constraint materiais_gerado_proveniencia_check impede INSERT de resumo gerado com fonte_chunk_ids vazio
      await expect(
        pg.query(
          `INSERT INTO public.materiais (topico_id, titulo, corpo, tipo, tempo_leitura_min, status, origem, fonte_chunk_ids)
           VALUES ($1, 'Resumo Sem Fonte', 'Corpo', 'resumo', 3, 'rascunho', 'gerado', '[]'::jsonb)`,
          [TOPICO_CITOLOGIA]
        )
      ).rejects.toThrow();

      // Executa rollback e reaplicação idempotente
      await pg.exec(f112SearchRollbackSql);
      await pg.exec(f112SearchProposalSql);

      const indices = await pg.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'acervo_chunks'
            AND indexname IN ('acervo_chunks_embedding_hnsw_idx', 'acervo_chunks_texto_fts_idx')
          ORDER BY indexname`
      );
      expect(indices.rows.map((r) => r.indexname)).toEqual([
        'acervo_chunks_embedding_hnsw_idx',
        'acervo_chunks_texto_fts_idx',
      ]);
    });
  }
);
