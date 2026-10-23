import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertStagingIsolation,
  extractSupabaseProjectRef,
  sanitizeUrlForLogging,
  StagingIsolationError,
  validateStagingIsolation,
} from '../../lib/envGuard';
import {
  assertCanRunStagingSeed,
  createSyntheticPdfBuffer,
  seedStaging,
  STAGING_ALICE_EMAIL,
  STAGING_ALICE_PERFIL_ID,
  STAGING_BRUNO_EMAIL,
  STAGING_BRUNO_PERFIL_ID,
  STAGING_CICLO_ID,
} from '../../db/seed-staging';
import { executarWorkerSobDemanda } from '../../lib/workerOnDemand';
import { db } from '../../db';
import {
  perfis,
  responsavelEstudante,
  cicloBlocos,
  cards,
  acervoArquivos,
} from '../../db/schema';
import { acervoJobs } from '../../lib/acervoPipelineWorker';
import { eq } from 'drizzle-orm';

describe('MEDICINA 2029 — H1.02: Preparação Local e Segura do Staging', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    // Configura ambiente controlado para testes
    process.env.ALLOW_STAGING_SEED = 'true';
    process.env.CONFIRM_STAGING_SEED = 'true';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('1. envGuard — Validação e Isolamento Fail-Closed', () => {
    it('ignora validação estrita quando APP_ENV não é staging', () => {
      const res = validateStagingIsolation({
        APP_ENV: 'development',
        NODE_ENV: 'development',
      });
      expect(res.valid).toBe(true);
      expect(res.isStaging).toBe(false);
      expect(res.errors.length).toBe(0);
    });

    it('sanitiza credenciais e senhas em URLs para evitar vazamento em logs', () => {
      const safe = sanitizeUrlForLogging(
        'postgresql://admin_user:super_secret_password_123@aws-0-sa-east-1.pooler.supabase.com:6543/medicina_staging?apikey=secret_token_abc'
      );
      expect(safe).not.toContain('super_secret_password_123');
      expect(safe).not.toContain('secret_token_abc');
      expect(safe).toContain('admin_user:***@aws-0-sa-east-1.pooler.supabase.com:6543/medicina_staging');
    });

    it('extrai corretamente o project_ref de URLs do Supabase', () => {
      expect(extractSupabaseProjectRef('https://medicina-staging-xyz.supabase.co')).toBe('medicina-staging-xyz');
      expect(extractSupabaseProjectRef('http://localhost:54321')).toBe('local-supabase');
      expect(extractSupabaseProjectRef('invalido')).toBeNull();
    });

    it('rejeita inicialização de staging quando STAGING_SUPABASE_PROJECT_REF está ausente', () => {
      const env: Record<string, string | undefined> = {
        NODE_ENV: 'test',
        APP_ENV: 'staging',
        CONFIRM_ISOLATED_STAGING_ENVIRONMENT: 'true',
        DATABASE_URL: 'postgres://postgres:pwd@staging-db:5432/medicina_staging',
        SUPABASE_URL: 'https://medicina-staging.supabase.co',
        SUPABASE_ANON_KEY: 'anon-key-staging',
        NEXTAUTH_SECRET: 'a'.repeat(32),
        GEMINI_API_KEY: 'gemini-key',
      };
      const res = validateStagingIsolation(env);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('STAGING_SUPABASE_PROJECT_REF'))).toBe(true);
    });

    it('rejeita com erro fail-closed se project_ref for idêntico ao de produção', () => {
      const env: Record<string, string | undefined> = {
        NODE_ENV: 'test',
        APP_ENV: 'staging',
        STAGING_SUPABASE_PROJECT_REF: 'medicina-prod-ref',
        PRODUCTION_SUPABASE_PROJECT_REF: 'medicina-prod-ref',
        CONFIRM_ISOLATED_STAGING_ENVIRONMENT: 'true',
        DATABASE_URL: 'postgres://postgres:pwd@staging-db:5432/medicina_staging',
        SUPABASE_URL: 'https://medicina-prod-ref.supabase.co',
        SUPABASE_ANON_KEY: 'anon-key-staging',
        NEXTAUTH_SECRET: 'a'.repeat(32),
        GEMINI_API_KEY: 'gemini-key',
      };
      expect(() => assertStagingIsolation(env)).toThrowError(StagingIsolationError);
      expect(() => assertStagingIsolation(env)).toThrowError(/idêntico ao de produção/);
    });

    it('rejeita se DATABASE_URL contiver o project_ref de produção', () => {
      const env: Record<string, string | undefined> = {
        NODE_ENV: 'test',
        APP_ENV: 'staging',
        STAGING_SUPABASE_PROJECT_REF: 'staging-ref-1234',
        PRODUCTION_SUPABASE_PROJECT_REF: 'prod-secret-ref',
        CONFIRM_ISOLATED_STAGING_ENVIRONMENT: 'true',
        DATABASE_URL: 'postgres://postgres.prod-secret-ref:pwd@pooler.supabase.com:6543/postgres',
        SUPABASE_URL: 'https://staging-ref-1234.supabase.co',
        SUPABASE_ANON_KEY: 'anon-key-staging',
        NEXTAUTH_SECRET: 'a'.repeat(32),
        GEMINI_API_KEY: 'gemini-key',
      };
      const res = validateStagingIsolation(env);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('identificador de projeto produtivo'))).toBe(true);
    });

    it('rejeita se URLs de banco apontarem para bases de dados distintas', () => {
      const env: Record<string, string | undefined> = {
        NODE_ENV: 'test',
        APP_ENV: 'staging',
        STAGING_SUPABASE_PROJECT_REF: 'staging-ref-1234',
        CONFIRM_ISOLATED_STAGING_ENVIRONMENT: 'true',
        DATABASE_APP_URL: 'postgres://app:pwd@staging-host:5432/base_um',
        DATABASE_AUTH_URL: 'postgres://auth:pwd@staging-host:5432/base_dois',
        SUPABASE_URL: 'https://staging-ref-1234.supabase.co',
        SUPABASE_ANON_KEY: 'anon-key-staging',
        NEXTAUTH_SECRET: 'a'.repeat(32),
        GEMINI_API_KEY: 'gemini-key',
      };
      const res = validateStagingIsolation(env);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('Divergência de conexões de banco'))).toBe(true);
    });

    it('rejeita se credenciais obrigatórias estiverem ausentes ou fracas', () => {
      const env: Record<string, string | undefined> = {
        NODE_ENV: 'test',
        APP_ENV: 'staging',
        STAGING_SUPABASE_PROJECT_REF: 'staging-ref-1234',
        CONFIRM_ISOLATED_STAGING_ENVIRONMENT: 'true',
        DATABASE_URL: 'postgres://postgres:pwd@staging-host:5432/medicina_staging',
        SUPABASE_URL: 'https://staging-ref-1234.supabase.co',
        NEXTAUTH_SECRET: 'fraca', // Menos de 32 caracteres
        // SUPABASE_ANON_KEY ausente
        // GEMINI_API_KEY ausente
      };
      const res = validateStagingIsolation(env);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('SUPABASE_ANON_KEY'))).toBe(true);
      expect(res.errors.some((e) => e.includes('NEXTAUTH_SECRET'))).toBe(true);
      expect(res.errors.some((e) => e.includes('GEMINI_API_KEY'))).toBe(true);
    });

    it('aprova configuração completa, consistente e devidamente isolada de staging', () => {
      const env: Record<string, string | undefined> = {
        NODE_ENV: 'test',
        APP_ENV: 'staging',
        STAGING_SUPABASE_PROJECT_REF: 'staging-ref-1234',
        PRODUCTION_SUPABASE_PROJECT_REF: 'prod-ref-9999',
        CONFIRM_ISOLATED_STAGING_ENVIRONMENT: 'true',
        DATABASE_URL: 'postgres://medicina_app.staging-ref-1234:pwd@pooler.supabase.com:6543/postgres',
        DATABASE_APP_URL: 'postgres://medicina_app.staging-ref-1234:pwd@pooler.supabase.com:6543/postgres',
        DATABASE_AUTH_URL: 'postgres://medicina_auth.staging-ref-1234:pwd@pooler.supabase.com:6543/postgres',
        DATABASE_WORKER_URL: 'postgres://medicina_worker.staging-ref-1234:pwd@pooler.supabase.com:6543/postgres',
        SUPABASE_URL: 'https://staging-ref-1234.supabase.co',
        SUPABASE_ANON_KEY: 'anon-staging-key-123',
        NEXTAUTH_SECRET: 'a'.repeat(32),
        NEXTAUTH_URL: 'https://medicina-staging.vercel.app',
        GEMINI_API_KEY: 'gemini-staging-key-valid',
      };
      const config = assertStagingIsolation(env);
      expect(config.isStaging).toBe(true);
      expect(config.stagingProjectRef).toBe('staging-ref-1234');
      expect(config.supabaseUrl).toBe('https://staging-ref-1234.supabase.co');
    });
  });

  describe('2. seed-staging — Salvaguardas, Idempotência e PDFs Válidos', () => {
    it('bloqueia execução do seed se CONFIRM_STAGING_SEED estiver ausente', () => {
      expect(() => {
        assertCanRunStagingSeed({
          NODE_ENV: 'development',
          CONFIRM_STAGING_SEED: 'false',
          ALLOW_STAGING_SEED: 'false',
        });
      }).toThrowError(/requer autorização explícita/);
    });

    it('bloqueia sumariamente execução se NODE_ENV=production ou APP_ENV=production', () => {
      expect(() => {
        assertCanRunStagingSeed({
          NODE_ENV: 'production',
          APP_ENV: 'production',
          CONFIRM_STAGING_SEED: 'true',
        });
      }).toThrowError(/PRODUÇÃO BLOQUEADA/);
    });

    it('bloqueia se DATABASE_URL contiver marcas ou nomes de banco produtivo', () => {
      expect(() => {
        assertCanRunStagingSeed({
          NODE_ENV: 'test',
          CONFIRM_STAGING_SEED: 'true',
          DATABASE_URL: 'postgresql://postgres:pwd@db.host.com:5432/medicina_production',
        });
      }).toThrowError(/Nome de banco produtivo detectado/);
    });

    it('cria buffers de PDF sintético válidos com cabeçalho, xref e trailer %%EOF', () => {
      const title = 'Biologia Celular Teste';
      const body = 'Mitocondrias geram energia ATP via cadeia respiratoria.';
      const pdfBuffer = createSyntheticPdfBuffer(title, body);

      expect(pdfBuffer).toBeInstanceOf(Buffer);
      expect(pdfBuffer.length).toBeGreaterThan(300);

      const pdfStr = pdfBuffer.toString('utf8');
      expect(pdfStr.startsWith('%PDF-1.4')).toBe(true);
      expect(pdfStr).toContain('/Type /Catalog');
      expect(pdfStr).toContain('/Type /Pages');
      expect(pdfStr).toContain('Biologia Celular Teste');
      expect(pdfStr).toContain('xref');
      expect(pdfStr).toContain('trailer');
      expect(pdfStr.trimEnd().endsWith('%%EOF')).toBe(true);

      // Validação do hash SHA-256 e tamanho exato
      const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
      expect(sha256.length).toBe(64);
      const filePath = `acervo/${sha256}_biologia_teste.pdf`;
      expect(filePath).toMatch(/^acervo\/[0-9a-f]{64}(_[A-Za-z0-9._-]+)?\.pdf$/);
    });

    it('executa o seed sintético com sucesso contra o banco de dados descartável', async () => {
      const summary = await seedStaging({
        studentPassword: 'senha_segura_alice_teste_2029',
        responsiblePassword: 'senha_segura_bruno_teste_2029',
      });

      expect(summary.perfisCriados).toBe(2);
      expect(summary.disciplinasCriadas).toBe(5);
      expect(summary.topicosCriados).toBe(10);
      expect(summary.ciclosCriados).toBe(1);
      expect(summary.blocosCriados).toBe(28);
      expect(summary.cardsCriados).toBe(6);
      expect(summary.arquivosCriados).toBe(3);

      // Verificação em banco de Alice
      const [alice] = await db.select().from(perfis).where(eq(perfis.id, STAGING_ALICE_PERFIL_ID));
      expect(alice).toBeDefined();
      expect(alice.email).toBe(STAGING_ALICE_EMAIL);
      expect(alice.papel).toBe('estudante');
      expect(alice.passwordHash).toMatch(/^\$2[aby]\$\d+\$/);

      // Verificação de Bruno
      const [bruno] = await db.select().from(perfis).where(eq(perfis.id, STAGING_BRUNO_PERFIL_ID));
      expect(bruno).toBeDefined();
      expect(bruno.email).toBe(STAGING_BRUNO_EMAIL);
      expect(bruno.papel).toBe('responsavel');

      // Vínculo responsável-estudante
      const [vinculo] = await db
        .select()
        .from(responsavelEstudante)
        .where(eq(responsavelEstudante.estudantePerfilId, STAGING_ALICE_PERFIL_ID));
      expect(vinculo).toBeDefined();
      expect(vinculo.responsavelPerfilId).toBe(STAGING_BRUNO_PERFIL_ID);

      // Ciclo e 28 blocos
      const blocos = await db.select().from(cicloBlocos).where(eq(cicloBlocos.cicloId, STAGING_CICLO_ID));
      expect(blocos.length).toBe(28);

      // 6 Cards FSRS com estados representativos
      const cardsAlice = await db.select().from(cards).where(eq(cards.perfilId, STAGING_ALICE_PERFIL_ID));
      expect(cardsAlice.length).toBe(6);
      const estados = cardsAlice.map((c) => c.state);
      expect(estados).toContain('new');
      expect(estados).toContain('learning');
      expect(estados).toContain('review');
      expect(estados).toContain('relearning');

      // Arquivos de acervo sintéticos
      const arquivos = await db.select().from(acervoArquivos).where(eq(acervoArquivos.enviadoPor, STAGING_BRUNO_PERFIL_ID));
      expect(arquivos.length).toBe(3);
      for (const arq of arquivos) {
        expect(arq.filePath).toMatch(/^acervo\/[0-9a-f]{64}_[A-Za-z0-9._-]+\.pdf$/);
        expect(arq.tamanhoBytes).toBeGreaterThan(300);
        expect(arq.hashConteudo.length).toBe(64);
        expect(arq.mime).toBe('application/pdf');
      }
    });

    it('demonstra idempotência absoluta executando o seed uma segunda vez sem erros nem duplicações', async () => {
      const summary2 = await seedStaging({
        studentPassword: 'senha_segura_alice_teste_2029',
        responsiblePassword: 'senha_segura_bruno_teste_2029',
      });

      expect(summary2.perfisCriados).toBe(2);
      expect(summary2.blocosCriados).toBe(28);
      expect(summary2.cardsCriados).toBe(6);
      expect(summary2.arquivosCriados).toBe(3);

      // Confere que o número total de blocos permanece 28 (sem duplicação)
      const blocos = await db.select().from(cicloBlocos).where(eq(cicloBlocos.cicloId, STAGING_CICLO_ID));
      expect(blocos.length).toBe(28);

      // Confere que o número de cards permanece 6
      const cardsAlice = await db.select().from(cards).where(eq(cards.perfilId, STAGING_ALICE_PERFIL_ID));
      expect(cardsAlice.length).toBe(6);
    });
  });

  describe('3. workerOnDemand — Execução Controlada sem VM Permanente', () => {
    it('encerra de forma limpa quando a fila está vazia (exitOnEmptyQueue)', async () => {
      const summary = await executarWorkerSobDemanda({
        maxJobs: 5,
        maxDurationMs: 10_000,
        exitOnEmptyQueue: true,
      });

      expect(summary.workerId).toMatch(/^worker-ondemand-/);
      expect(summary.motivoParada).toBe('fila_vazia');
      expect(summary.totalProcessados).toBe(0);
      expect(summary.duracaoMs).toBeLessThan(5_000);
    });

    it('respeita o limite estrito de jobs configurado em maxJobs', async () => {
      // Re-agenda os 3 jobs existentes dos 3 arquivos para 'aguardando'
      for (let i = 1; i <= 3; i++) {
        const jobId = `f3000000-0000-4000-8000-${i.toString().padStart(12, '0')}`;
        await db
          .update(acervoJobs)
          .set({
            status: 'aguardando',
            etapaAtual: 'extracao',
            tentativas: 0,
            lockedBy: null,
            leaseExpiresAt: null,
            proximaExecucaoEm: new Date(Date.now() - 1000),
          })
          .where(eq(acervoJobs.id, jobId));
      }

      // Executa limitando a no máximo 2 jobs
      const mockDownload = vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock'));
      const mockExtrair = vi.fn().mockResolvedValue({
        paginas: [{ numero: 1, texto: 'Texto extraido teste', confianca: 1 }],
        metodo: 'nativo' as const,
      });
      const mockSegmentar = vi.fn().mockReturnValue([
        {
          ordem: 1,
          texto: 'Texto extraido teste',
          paginaInicial: 1,
          paginaFinal: 1,
          tokens: 10,
          tipo: 'exposicao_teorica' as const,
        },
      ]);
      const mockClassificar = vi.fn().mockResolvedValue({ topicoId: null, confianca: 0.9 });
      const mockEmbedding = vi.fn().mockResolvedValue(new Array(1536).fill(0.01));

      const summary = await executarWorkerSobDemanda({
        maxJobs: 2, // Limite estrito de 2 jobs
        maxDurationMs: 30_000,
        deps: {
          downloadPdf: mockDownload,
          extrairTexto: mockExtrair,
          segmentar: mockSegmentar,
          classificarChunk: mockClassificar,
          gerarEmbeddingReal: mockEmbedding,
        },
      });

      expect(summary.totalProcessados).toBe(2);
      expect(summary.motivoParada).toBe('max_jobs_atingido');
      expect(summary.concluidos).toBe(2);
    });

    it('interrompe a execução quando atinge o tempo máximo seguro (maxDurationMs)', async () => {
      // Re-agenda jobs 2 e 3 para 'aguardando'
      for (const id of ['f3000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000003']) {
        await db
          .update(acervoJobs)
          .set({
            status: 'aguardando',
            etapaAtual: 'extracao',
            tentativas: 0,
            lockedBy: null,
            leaseExpiresAt: null,
            proximaExecucaoEm: new Date(Date.now() - 1000),
          })
          .where(eq(acervoJobs.id, id));
      }

      const slowDownload = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 60)); // Simula latência de 60ms
        return Buffer.from('%PDF-1.4 mock');
      });

      const summary = await executarWorkerSobDemanda({
        maxJobs: 50,
        maxDurationMs: 30, // Timeout de 30ms (menor que o tempo de 1 job = 60ms)
        exitOnEmptyQueue: false,
        deps: {
          downloadPdf: slowDownload,
          extrairTexto: vi.fn().mockResolvedValue({ paginas: [], metodo: 'nativo' as const }),
          segmentar: vi.fn().mockReturnValue([]),
          classificarChunk: vi.fn().mockResolvedValue({ topicoId: null, confianca: 1 }),
          gerarEmbeddingReal: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
        },
      });

      expect(summary.motivoParada).toBe('tempo_limite_atingido');
    });
  });
});
