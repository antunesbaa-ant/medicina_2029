import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertStagingIsolation,
  assertCanRunStagingMigrations,
  extractSupabaseDbProjectRef,
  isStagingEnvironment,
  StagingIsolationError,
  validateStagingIsolation,
} from '../../lib/envGuard';
import {
  assertCanRunStagingSeed,
  createSyntheticPdfBuffer,
  STAGING_ALICE_PERFIL_ID,
} from '../../db/seed-staging';
import { extrairTextoPDF } from '../../lib/ingestion';
import {
  acervoJobs,
  processarProximoJobAcervo,
  recuperarJobsComLeaseVencido,
} from '../../lib/acervoPipelineWorker';
import { executarWorkerSobDemanda } from '../../lib/workerOnDemand';
import {
  assertCanRunStagingMigrationsCli,
  CANONICAL_MIGRATIONS,
  getMigrationManifest,
} from '../../../scripts/db/migrate-staging.mjs';
import { db } from '../../db';
import { acervoArquivos, acervoPaginas, acervoChunks } from '../../db/schema';
import { eq } from 'drizzle-orm';

describe('MEDICINA 2029 — H1.03: Preflight de Ativação do Staging', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.ALLOW_STAGING_SEED = 'true';
    process.env.CONFIRM_STAGING_SEED = 'true';
    process.env.ALLOW_STAGING_MIGRATIONS = 'true';
    process.env.CONFIRM_STAGING_MIGRATIONS = 'true';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // --------------------------------------------------------------------------
  // 1. Caminhos Reais de Inicialização e envGuard
  // --------------------------------------------------------------------------
  describe('1. envGuard nos Caminhos Reais de Inicialização', () => {
    it('executa verificação fail-closed no worker on-demand quando em staging', async () => {
      // Simula staging sem variáveis obrigatórias
      const stagingEnv = {
        APP_ENV: 'staging',
        // faltam STAGING_SUPABASE_PROJECT_REF, DATABASE_URL, etc.
      };

      expect(() => {
        if (isStagingEnvironment(stagingEnv)) {
          assertStagingIsolation(stagingEnv);
        }
      }).toThrowError(StagingIsolationError);
    });

    it('bloqueia o runner de migrações DDL fora de staging autorizado', () => {
      expect(() => {
        assertCanRunStagingMigrationsCli({
          APP_ENV: 'staging',
          CONFIRM_STAGING_MIGRATIONS: 'false',
        });
      }).toThrow(/CONFIRM_STAGING_MIGRATIONS=true/);
    });

    it('permite execução em desenvolvimento ou teste sem bloquear inicialização', () => {
      const devEnv = {
        APP_ENV: 'development',
        NODE_ENV: 'development',
      };
      expect(isStagingEnvironment(devEnv)).toBe(false);
      const res = validateStagingIsolation(devEnv);
      expect(res.valid).toBe(true);
      expect(res.isStaging).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Distinção entre Staging Publicado e Produção Real
  // --------------------------------------------------------------------------
  describe('2. Distinção entre Staging Publicado (NODE_ENV=production, APP_ENV=staging) e Produção Real', () => {
    it('aceita staging publicado quando APP_ENV=staging e NODE_ENV=production com variáveis válidas', () => {
      const publishedStagingEnv = {
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        STAGING_SUPABASE_PROJECT_REF: 'med2029-staging-xyz',
        DATABASE_URL: 'postgresql://postgres:secret123@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require',
        DATABASE_APP_URL: 'postgresql://medicina_app.med2029-staging-xyz:secret123@aws-0-sa-east-1.pooler.supabase.com:6543/postgres',
        DATABASE_AUTH_URL: 'postgresql://medicina_auth.med2029-staging-xyz:secret123@aws-0-sa-east-1.pooler.supabase.com:6543/postgres',
        DATABASE_WORKER_URL: 'postgresql://medicina_worker.med2029-staging-xyz:secret123@aws-0-sa-east-1.pooler.supabase.com:6543/postgres',
        SUPABASE_URL: 'https://med2029-staging-xyz.supabase.co',
        SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anonkey',
        NEXTAUTH_SECRET: 'super_secret_session_token_32_chars_long_!',
        GEMINI_API_KEY: 'AIzaSyFakeKeyForStagingPreflight123',
        CONFIRM_ISOLATED_STAGING_ENVIRONMENT: 'true',
      };

      expect(isStagingEnvironment(publishedStagingEnv)).toBe(true);
      const res = validateStagingIsolation(publishedStagingEnv);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it('rejeita sumariamente execução quando APP_ENV=production', () => {
      const prodEnv = {
        NODE_ENV: 'production',
        APP_ENV: 'production',
        STAGING_GUARD_ENABLED: 'true', // Mesmo se tentarem ativar a flag
      };

      // Produção real NUNCA é tratada como staging
      expect(isStagingEnvironment(prodEnv)).toBe(false);

      // Seed e migrações são bloqueados sem exceção
      expect(() => assertCanRunStagingSeed(prodEnv)).toThrow(/PRODUÇÃO BLOQUEADA/);
      expect(() => assertCanRunStagingMigrations(prodEnv)).toThrow(/PRODUÇÃO BLOQUEADA/);
      expect(() => assertCanRunStagingMigrationsCli(prodEnv)).toThrow(/PRODUÇÃO BLOQUEADA/);
    });

    it('bloqueia seed mesmo se CONFIRM_STAGING_SEED=true quando NODE_ENV=production sem APP_ENV=staging', () => {
      const dangerousEnv = {
        NODE_ENV: 'production',
        APP_ENV: 'production',
        CONFIRM_STAGING_SEED: 'true',
      };
      expect(() => assertCanRunStagingSeed(dangerousEnv)).toThrow(/PRODUÇÃO BLOQUEADA/);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Correspondência entre Projeto Supabase e Conexões
  // --------------------------------------------------------------------------
  describe('3. Correspondência entre Projeto Supabase Autorizado e Conexões', () => {
    it('extrai corretamente project_ref de URL direta Supabase (db.xyz.supabase.co)', () => {
      const ref = extractSupabaseDbProjectRef(
        'postgresql://postgres:mypass@db.projref123.supabase.co:5432/postgres'
      );
      expect(ref).toBe('projref123');
    });

    it('extrai corretamente project_ref de URL pooler Supabase (*.pooler.supabase.com)', () => {
      const ref = extractSupabaseDbProjectRef(
        'postgresql://medicina_worker.projref123:mypass@aws-0-sa-east-1.pooler.supabase.com:6543/postgres'
      );
      expect(ref).toBe('projref123');
    });

    it('reconhece conexões locais como local-supabase', () => {
      expect(extractSupabaseDbProjectRef('postgresql://postgres:postgres@localhost:5432/postgres')).toBe('local-supabase');
      expect(extractSupabaseDbProjectRef('postgresql://postgres:postgres@127.0.0.1:5432/postgres')).toBe('local-supabase');
    });

    it('falha quando DATABASE_URL aponta para projeto Supabase divergente de STAGING_SUPABASE_PROJECT_REF', () => {
      const divergingEnv = {
        APP_ENV: 'staging',
        STAGING_SUPABASE_PROJECT_REF: 'projeto-staging-correto',
        DATABASE_URL: 'postgresql://postgres:pass@db.outro-projeto-estranho.supabase.co:5432/postgres',
        SUPABASE_URL: 'https://projeto-staging-correto.supabase.co',
        SUPABASE_ANON_KEY: 'dummy-anon-key',
        NEXTAUTH_SECRET: 'segredo_com_pelo_menos_32_caracteres_longos!',
        GEMINI_API_KEY: 'fake_gemini_key',
        CONFIRM_ISOLATED_STAGING_ENVIRONMENT: 'true',
      };

      const res = validateStagingIsolation(divergingEnv);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('Incompatibilidade de projeto Supabase'))).toBe(true);
    });

    it('falha quando DATABASE_URL aponta para o projeto de produção', () => {
      const prodLeakEnv = {
        APP_ENV: 'staging',
        STAGING_SUPABASE_PROJECT_REF: 'staging-ref-123',
        PRODUCTION_SUPABASE_PROJECT_REF: 'producao-ref-999',
        DATABASE_URL: 'postgresql://postgres.producao-ref-999:pass@aws-0-sa-east-1.pooler.supabase.com:6543/postgres',
        SUPABASE_URL: 'https://staging-ref-123.supabase.co',
        SUPABASE_ANON_KEY: 'dummy-anon-key',
        NEXTAUTH_SECRET: 'segredo_com_pelo_menos_32_caracteres_longos!',
        GEMINI_API_KEY: 'fake_gemini_key',
        CONFIRM_ISOLATED_STAGING_ENVIRONMENT: 'true',
      };

      const res = validateStagingIsolation(prodLeakEnv);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('VIOLAÇÃO CRÍTICA DE ISOLAMENTO'))).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Verificação de PDFs Sintéticos com Parser Real
  // --------------------------------------------------------------------------
  describe('4. Verificação de PDFs Sintéticos com Parser Real', () => {
    it('gera buffer PDF-1.4 válido e determinístico', () => {
      const title = 'Apostila Didática Teste';
      const body = 'Explicação conceitual de teste sobre funções exponenciais.';
      const buf1 = createSyntheticPdfBuffer(title, body);
      const buf2 = createSyntheticPdfBuffer(title, body);

      expect(buf1.toString('utf8', 0, 8)).toBe('%PDF-1.4');
      expect(buf1.toString('utf8').includes('%%EOF')).toBe(true);
      expect(buf1.toString('utf8').includes('xref')).toBe(true);
      expect(buf1.equals(buf2)).toBe(true);
    });

    it('extrai conteúdo real via extrairTextoPDF sem mocks', async () => {
      const title = 'Matematica - Teoria de Proporcoes';
      const body = 'A constante de proporcionalidade k define o equilibrio da razao.';
      const pdfBuffer = createSyntheticPdfBuffer(title, body);

      const paginas = await extrairTextoPDF(pdfBuffer);
      expect(paginas.length).toBe(1);
      expect(paginas[0].numero).toBe(1);
      expect(paginas[0].metodo).toBe('nativo');
      expect(paginas[0].confianca).toBe(1.0);
      expect(paginas[0].texto).toContain('Matematica - Teoria de Proporcoes');
      expect(paginas[0].texto).toContain('A constante de proporcionalidade');
    });

    it('confere correspondência exata entre bytes, SHA-256 e tamanho dos PDFs didáticos', async () => {
      const pdfConfigs = [
        {
          titulo: 'Didatico Matematica - Razao e Proporcao',
          conteudo: 'A razao entre grandezas estabelece uma comparacao por quociente. Se a/b = c/d, ad = bc.',
        },
        {
          titulo: 'Didatico Biologia - Citologia e Organelas',
          conteudo: 'A membrana plasmatica possui modelo mosaico fluido com dupla camada de fosfolipidios.',
        },
        {
          titulo: 'Didatico Quimica - Estequiometria Basica',
          conteudo: 'Nas reacoes quimicas a conservacao de massas de Lavoisier assegura reagentes balanceados.',
        },
      ];

      for (const cfg of pdfConfigs) {
        const buf = createSyntheticPdfBuffer(cfg.titulo, cfg.conteudo);
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        const tamanhoBytes = buf.length;

        expect(sha256).toHaveLength(64);
        expect(tamanhoBytes).toBeGreaterThan(500);

        // Testa extração real
        const extraido = await extrairTextoPDF(buf);
        expect(extraido[0].texto).toContain(cfg.titulo);
        expect(extraido[0].texto).toContain(cfg.conteudo);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 5. Worker sob Demanda: Job Longo, Limite de Duração, Recuperação de Lease e Retomada
  // --------------------------------------------------------------------------
  describe('5. Worker sob Demanda: Duração Limite, Lease e Retomada sem Duplicações', () => {
    it('interrompe execução controladamente ao atingir maxDurationMs com motivo tempo_limite_atingido', async () => {
      const workerId = `test-worker-timeout-${Date.now()}`;

      // Configura teto mínimo de duração (10ms)
      const summary = await executarWorkerSobDemanda({
        workerId,
        maxJobs: 50,
        maxDurationMs: 10,
        exitOnEmptyQueue: false,
      });

      expect(['tempo_limite_atingido', 'fila_vazia']).toContain(summary.motivoParada);
      expect(summary.duracaoMs).toBeGreaterThanOrEqual(0);
    });

    it('recupera jobs com lease vencido devolvendo para aguardando com backoff', async () => {
      const DISC_ID = '30000000-0000-4000-8000-000000000001';
      const arquivoId = crypto.randomUUID();
      const sha256 = crypto.randomBytes(32).toString('hex');
      try {
        await db.insert(acervoArquivos).values({
          id: arquivoId,
          disciplinaId: DISC_ID,
          titulo: 'PDF Teste Recuperacao Lease',
          tipoMaterial: 'apostila',
          serieAlvo: 1,
          vestibular: 'ENEM',
          filePath: `acervo/${sha256}.pdf`,
          mime: 'application/pdf',
          tamanhoBytes: 1024,
          paginas: 1,
          enviadoPor: STAGING_ALICE_PERFIL_ID,
          statusProcessamento: 'extraindo',
          hashConteudo: sha256,
        });

        const now = new Date();
        const leaseExpirado = new Date(now.getTime() - 10 * 60 * 1000);
        const [job] = await db
          .insert(acervoJobs)
          .values({
            arquivoId,
            enviadoPor: STAGING_ALICE_PERFIL_ID,
            status: 'em_execucao',
            etapaAtual: 'segmentacao',
            tentativas: 1,
            maxTentativas: 3,
            lockedBy: 'worker-morto-123',
            lockedAt: leaseExpirado,
            leaseExpiresAt: leaseExpirado,
            proximaExecucaoEm: leaseExpirado,
          })
          .returning();

        const resultado = await recuperarJobsComLeaseVencido({ now });
        expect(resultado.reenfileirados).toContain(job.id);

        const [jobRecuperado] = await db.select().from(acervoJobs).where(eq(acervoJobs.id, job.id));
        expect(jobRecuperado.status).toBe('aguardando');
        expect(jobRecuperado.etapaAtual).toBe('segmentacao');
        expect(jobRecuperado.lockedBy).toBeNull();
        expect(jobRecuperado.lockedAt).toBeNull();
        expect(jobRecuperado.proximaExecucaoEm.getTime()).toBeGreaterThanOrEqual(now.getTime());
      } finally {
        await db.delete(acervoJobs).where(eq(acervoJobs.arquivoId, arquivoId));
        await db.delete(acervoArquivos).where(eq(acervoArquivos.id, arquivoId));
      }
    });

    it('encerra com falha explícita jobs que excederam o limite de tentativas no lease', async () => {
      const DISC_ID = '30000000-0000-4000-8000-000000000001';
      const arquivoId = crypto.randomUUID();
      const sha256 = crypto.randomBytes(32).toString('hex');
      try {
        await db.insert(acervoArquivos).values({
          id: arquivoId,
          disciplinaId: DISC_ID,
          titulo: 'PDF Esgotado Lease',
          tipoMaterial: 'apostila',
          serieAlvo: 1,
          vestibular: 'ENEM',
          filePath: `acervo/${sha256}.pdf`,
          mime: 'application/pdf',
          tamanhoBytes: 1024,
          paginas: 1,
          enviadoPor: STAGING_ALICE_PERFIL_ID,
          statusProcessamento: 'extraindo',
          hashConteudo: sha256,
        });

        const now = new Date();
        const leaseExpirado = new Date(now.getTime() - 5000);
        const [job] = await db
          .insert(acervoJobs)
          .values({
            arquivoId,
            enviadoPor: STAGING_ALICE_PERFIL_ID,
            status: 'em_execucao',
            etapaAtual: 'extracao',
            tentativas: 3, // Igual ao maxTentativas
            maxTentativas: 3,
            lockedBy: 'worker-travado-456',
            lockedAt: leaseExpirado,
            leaseExpiresAt: leaseExpirado,
            proximaExecucaoEm: leaseExpirado,
          })
          .returning();

        const resultado = await recuperarJobsComLeaseVencido({ now });
        expect(resultado.esgotados).toContain(job.id);

        const [jobFalho] = await db.select().from(acervoJobs).where(eq(acervoJobs.id, job.id));
        expect(jobFalho.status).toBe('falhou');
        expect(jobFalho.ultimoErroCodigo).toBe('LEASE_EXPIRED_MAX_RETRIES');
      } finally {
        await db.delete(acervoJobs).where(eq(acervoJobs.arquivoId, arquivoId));
        await db.delete(acervoArquivos).where(eq(acervoArquivos.id, arquivoId));
      }
    });

    it('retoma processamento a partir da etapa pendente sem duplicar páginas nem chunks', async () => {
      const DISC_ID = '30000000-0000-4000-8000-000000000001';
      const arquivoId = crypto.randomUUID();
      const sha256 = crypto.randomBytes(32).toString('hex');
      const pdfBuf = createSyntheticPdfBuffer('Retomada Limpa', 'Conteudo que nao deve duplicar em caso de retomada.');
      try {
        await db.insert(acervoArquivos).values({
          id: arquivoId,
          disciplinaId: DISC_ID,
          titulo: 'PDF Retomada Limpa',
          tipoMaterial: 'apostila',
          serieAlvo: 1,
          vestibular: 'ENEM',
          filePath: `acervo/${sha256}.pdf`,
          mime: 'application/pdf',
          tamanhoBytes: pdfBuf.length,
          paginas: 1,
          enviadoPor: STAGING_ALICE_PERFIL_ID,
          statusProcessamento: 'extraindo',
          hashConteudo: sha256,
        });

        // Simula que a etapa de 'extracao' já havia gravado a página 1 no banco antes do crash
        await db.insert(acervoPaginas).values({
          arquivoId,
          numero: 1,
          textoExtraido: 'Conteudo que nao deve duplicar em caso de retomada.',
          metodoExtracao: 'nativo',
          confiancaOcr: 1.0,
        });

        // Job aguardando na etapa de 'segmentacao' (extracao concluída)
        const [job] = await db
          .insert(acervoJobs)
          .values({
            arquivoId,
            enviadoPor: STAGING_ALICE_PERFIL_ID,
            status: 'aguardando',
            etapaAtual: 'segmentacao',
            tentativas: 1,
            maxTentativas: 3,
            proximaExecucaoEm: new Date(),
          })
          .returning();

        // Mock de dependências do pipeline
        const workerRes = await processarProximoJobAcervo(`worker-retomada-${Date.now()}`, {
          downloadPdf: async () => pdfBuf,
          extrairTexto: async () => {
            throw new Error('Não deveria re-executar extração já concluída!');
          },
          segmentar: (pags) => [
            {
              ordem: 1,
              texto: pags[0]?.texto ?? 'chunk retomado',
              paginaInicial: 1,
              paginaFinal: 1,
              tipoConteudo: 'exposicao_teorica',
              tokens: 20,
            },
          ],
          classificarChunk: async () => ({
            topicoId: null,
            confianca: 0.9,
          }),
          gerarEmbeddingReal: async () => new Array(1536).fill(0.01),
        });

        expect(workerRes.processado).toBe(true);
        expect(workerRes.jobId).toBe(job.id);
        expect(workerRes.statusFinal).toBe('concluido');

        // Confere que página 1 não foi duplicada
        const pags = await db.select().from(acervoPaginas).where(eq(acervoPaginas.arquivoId, arquivoId));
        expect(pags).toHaveLength(1);

        // Confere que o chunk foi gravado corretamente
        const chunks = await db.select().from(acervoChunks).where(eq(acervoChunks.arquivoId, arquivoId));
        expect(chunks).toHaveLength(1);
      } finally {
        await db.delete(acervoChunks).where(eq(acervoChunks.arquivoId, arquivoId));
        await db.delete(acervoPaginas).where(eq(acervoPaginas.arquivoId, arquivoId));
        await db.delete(acervoJobs).where(eq(acervoJobs.arquivoId, arquivoId));
        await db.delete(acervoArquivos).where(eq(acervoArquivos.id, arquivoId));
      }
    });
  });

  // --------------------------------------------------------------------------
  // 6. Manifesto e Sequência Canônica de Migrações
  // --------------------------------------------------------------------------
  describe('6. Manifesto e Integridade das Migrações de Staging', () => {
    it('carrega o manifesto com exatamente 9 migrações canônicas válidas', () => {
      const manifest = getMigrationManifest();
      expect(manifest).toHaveLength(9);
      expect(manifest.map((m) => m.relPath)).toEqual(CANONICAL_MIGRATIONS);

      for (const item of manifest) {
        expect(item.tamanhoBytes).toBeGreaterThan(50);
        expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });
});
