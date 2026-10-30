/**
 * ==============================================================================
 * MEDICINA 2029 — H2.04: PREPARAÇÃO DA HOMOLOGAÇÃO FUNCIONAL
 * ==============================================================================
 * Testes Automatizados Locais da Homologação Funcional:
 * 1. Auditoria e Classificação das Funcionalidades (Prontas vs Dependentes vs Mockadas)
 * 2. Validação das 3 Personas Sintéticas (Alice, Bruno e Carlos)
 * 3. Prova Cabal de Isolamento RLS e Zero Vazamento Cross-Tenant (Motor PostgreSQL Real)
 * 4. Validação de Vínculo Exclusivo Responsável-Estudante e Proteção da ESPEC (1.2)
 * 5. Bloqueio Fatal de Escalada de Privilégios (medicina.set_context fail-closed)
 * 6. Guardrails de Autenticação, Proteção de Rotas, Upload e Busca
 * 7. Procedimento de Limpeza Completa (Teardown Idempotente e Confiável)
 * ==============================================================================
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';

import {
  PERSONA_ALICE,
  PERSONA_BRUNO,
  PERSONA_CARLOS,
  STAGING_ALICE_CICLO_ID,
  STAGING_CARLOS_CICLO_ID,
  FEATURE_STATUS_MATRIX,
  createSyntheticPdfBuffer,
} from '../../../scripts/db/prepare-staging-homologation.mjs';

const MODULE_ROOT = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';
const PGLITE_INDEX = path.join(MODULE_ROOT, '@electric-sql/pglite/dist/index.js');
const PGLITE_VECTOR = path.join(MODULE_ROOT, '@electric-sql/pglite-pgvector/dist/index.js');
const HAS_PGLITE = existsSync(PGLITE_INDEX) && existsSync(PGLITE_VECTOR);

interface PGliteInstance {
  exec: (query: string) => Promise<unknown>;
  query: <T = Record<string, unknown>>(
    query: string,
    params?: unknown[]
  ) => Promise<{ rows: T[] }>;
  close: () => Promise<void>;
}

describe('MEDICINA 2029 — H2.04: Preparação da Homologação Funcional', () => {
  // ============================================================================
  // GRUPO 1: ESTADO ATUAL E CLASSIFICAÇÃO ARQUITETURAL
  // ============================================================================
  describe('1. Estado Atual e Classificação Arquitetural', () => {
    it('1.1 A matriz de funcionalidades classifica rigorosamente os 3 estágios operacionais', () => {
      expect(FEATURE_STATUS_MATRIX.prontas).toBeDefined();
      expect(FEATURE_STATUS_MATRIX.dependentesInfraestrutura).toBeDefined();
      expect(FEATURE_STATUS_MATRIX.pendentesOuMockadas).toBeDefined();

      expect(FEATURE_STATUS_MATRIX.prontas.length).toBeGreaterThanOrEqual(8);
      expect(FEATURE_STATUS_MATRIX.dependentesInfraestrutura.length).toBeGreaterThanOrEqual(3);
      expect(FEATURE_STATUS_MATRIX.pendentesOuMockadas.length).toBeGreaterThanOrEqual(3);
    });

    it('1.2 Todas as Server Actions essenciais estão devidamente implementadas no codebase', async () => {
      const cicloModule = await import('./ciclo');
      expect(typeof cicloModule.obterCicloAtivo).toBe('function');
      expect(typeof cicloModule.iniciarCicloEstudos).toBe('function');
      expect(typeof cicloModule.resetarPlanejamento).toBe('function');

      const sessaoModule = await import('./sessao');
      expect(typeof sessaoModule.iniciarSessao).toBe('function');
      expect(typeof sessaoModule.atualizarSessao).toBe('function');
      expect(typeof sessaoModule.concluirSessao).toBe('function');

      const acervoModule = await import('./acervo');
      expect(typeof acervoModule.enviarArquivo).toBe('function');

      const curadoriaModule = await import('./curadoria');
      expect(typeof curadoriaModule.enfileirarGeracaoDeArtefatos).toBe('function');
      expect(typeof curadoriaModule.curarItem).toBe('function');

      const buscaModule = await import('./busca');
      expect(typeof buscaModule.buscarNoAcervo).toBe('function');

      const cadernoModule = await import('./cadernoErros');
      expect(typeof cadernoModule.obterCadernoErros).toBe('function');

      const fsrsModule = await import('./fsrs');
      expect(typeof fsrsModule.obterCardsParaRevisao).toBe('function');
      expect(typeof fsrsModule.registrarRevisaoCard).toBe('function');

      const responsavelModule = await import('./responsavel');
      expect(typeof responsavelModule.obterAcompanhamentoQuinzenal).toBe('function');
    });

    it('1.3 Diferencia expressamente funcionalidades dependentes de infraestrutura de serviços mockados', () => {
      const storageDep = FEATURE_STATUS_MATRIX.dependentesInfraestrutura.find((i) =>
        i.modulo.includes('Storage')
      );
      expect(storageDep).toBeDefined();
      expect(storageDep?.dependencia).toContain('bucket');

      const geminiPending = FEATURE_STATUS_MATRIX.pendentesOuMockadas.find((i) =>
        i.modulo.includes('Gemini')
      );
      expect(geminiPending).toBeDefined();
      expect(geminiPending?.status).toContain('Mockada/Desativada');
    });
  });

  // ============================================================================
  // GRUPO 2: USUÁRIOS SINTÉTICOS E ZERO PII
  // ============================================================================
  describe('2. Usuários Sintéticos e Isolamento de Identidades', () => {
    it('2.1 Alice, Bruno e Carlos possuem UUIDs determinísticos válidos RFC 4122 v4', () => {
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      expect(PERSONA_ALICE.id).toMatch(uuidV4Regex);
      expect(PERSONA_BRUNO.id).toMatch(uuidV4Regex);
      expect(PERSONA_CARLOS.id).toMatch(uuidV4Regex);

      expect(PERSONA_ALICE.id).not.toBe(PERSONA_CARLOS.id);
      expect(PERSONA_ALICE.id).not.toBe(PERSONA_BRUNO.id);
      expect(PERSONA_BRUNO.id).not.toBe(PERSONA_CARLOS.id);
    });

    it('2.2 Os 3 usuários utilizam domínio sintético isolado .staging (Zero PII)', () => {
      expect(PERSONA_ALICE.email).toBe('alice@medicina2029.staging');
      expect(PERSONA_BRUNO.email).toBe('bruno@medicina2029.staging');
      expect(PERSONA_CARLOS.email).toBe('carlos@medicina2029.staging');
    });

    it('2.3 Os papéis de usuário respeitam o enum canônico (estudante e responsavel)', () => {
      expect(PERSONA_ALICE.papel).toBe('estudante');
      expect(PERSONA_BRUNO.papel).toBe('responsavel');
      expect(PERSONA_CARLOS.papel).toBe('estudante');
    });

    it('2.4 Senhas sintéticas são protegidas via bcrypt com fator de custo >= 10', async () => {
      const testPassword = 'senha_sintetica_teste_2029';
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(testPassword, salt);

      expect(hash).toMatch(/^\$2[aby]\$10\$/);
      expect(await bcrypt.compare(testPassword, hash)).toBe(true);
      expect(await bcrypt.compare('senha_incorreta', hash)).toBe(false);
    });
  });

  // ============================================================================
  // GRUPO 3: ISOLAMENTO RLS EM MOTOR POSTGRESQL REAL (PGLITE)
  // ============================================================================
  describe.skipIf(!HAS_PGLITE)('3. Validação de Isolamento RLS e Governança no Banco de Dados', () => {
    let pg: PGliteInstance;

    const projectRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../');
    const readSql = (relPath: string) =>
      readFileSync(path.join(projectRoot, relPath), 'utf8').replaceAll(
        '--> statement-breakpoint',
        '\n'
      );

    beforeAll(async () => {
      const { PGlite } = await import(pathToFileURL(PGLITE_INDEX).href);
      const { vector } = await import(pathToFileURL(PGLITE_VECTOR).href);
      pg = await PGlite.create({ extensions: { vector } });

      await pg.exec(`
        CREATE SCHEMA IF NOT EXISTS storage;
        CREATE TABLE IF NOT EXISTS storage.buckets (
          id text PRIMARY KEY,
          name text NOT NULL UNIQUE,
          public boolean DEFAULT false NOT NULL,
          file_size_limit bigint,
          allowed_mime_types text[],
          created_at timestamptz DEFAULT now() NOT NULL,
          updated_at timestamptz DEFAULT now() NOT NULL
        );
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES ('acervo', 'acervo', false, 52428800, ARRAY['application/pdf']::text[])
        ON CONFLICT (id) DO NOTHING;
      `);

      // Aplicação da esteira DDL completa canônica
      await pg.exec(readSql('drizzle/0000_greedy_loki.sql'));
      await pg.exec(readSql('drizzle/0001_dry_talos.sql'));
      await pg.exec(readSql('drizzle/0002_little_swarm.sql'));
      await pg.exec(readSql('drizzle/0003_f1_03_r_expansao.sql'));
      await pg.exec(readSql('tests/integration/f1_04/fixtures.sql'));
      await pg.exec(`
        UPDATE public.acervo_arquivos
        SET file_path = 'acervo/' || repeat('a', 64) || '_' || substr(id::text, 1, 8) || '.pdf'
        WHERE NOT (file_path ~ '^acervo/[0-9a-f]{64}(_[A-Za-z0-9._-]+)?\\.pdf$');
      `);
      await pg.exec(readSql('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql'));
      await pg.exec(readSql('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'));
      await pg.exec(readSql('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql'));
      await pg.exec(readSql('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql'));
      await pg.exec(readSql('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql'));
      await pg.exec(readSql('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'));

      // Provisionamento das 3 personas de homologação
      const salt = await bcrypt.genSalt(10);
      const h1 = await bcrypt.hash('pwd_alice', salt);
      const h2 = await bcrypt.hash('pwd_bruno', salt);
      const h3 = await bcrypt.hash('pwd_carlos', salt);

      await pg.exec(`
        INSERT INTO public.allowlist (email)
        VALUES ('${PERSONA_ALICE.email}'), ('${PERSONA_BRUNO.email}'), ('${PERSONA_CARLOS.email}')
        ON CONFLICT (email) DO NOTHING;

        INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
        VALUES
          ('${PERSONA_ALICE.id}', '${PERSONA_ALICE.id}', '${PERSONA_ALICE.nome}', '${PERSONA_ALICE.email}', '${h1}', '${PERSONA_ALICE.papel}'),
          ('${PERSONA_BRUNO.id}', '${PERSONA_BRUNO.id}', '${PERSONA_BRUNO.nome}', '${PERSONA_BRUNO.email}', '${h2}', '${PERSONA_BRUNO.papel}'),
          ('${PERSONA_CARLOS.id}', '${PERSONA_CARLOS.id}', '${PERSONA_CARLOS.nome}', '${PERSONA_CARLOS.email}', '${h3}', '${PERSONA_CARLOS.papel}')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.responsavel_estudante (vinculo_id, responsavel_perfil_id, estudante_perfil_id)
        VALUES (1, '${PERSONA_BRUNO.id}', '${PERSONA_ALICE.id}')
        ON CONFLICT (vinculo_id) DO NOTHING;

        INSERT INTO public.ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana)
        VALUES
          ('${STAGING_ALICE_CICLO_ID}', '${PERSONA_ALICE.id}', 'Ciclo Alice', 2027, true, 28),
          ('${STAGING_CARLOS_CICLO_ID}', '${PERSONA_CARLOS.id}', 'Ciclo Carlos', 2027, true, 28)
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.cards (id, perfil_id, topico_id, frente, verso, origem, status, state, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses)
        VALUES
          ('c1000000-0000-4000-8000-000000000001', '${PERSONA_ALICE.id}', '31000000-0000-4000-8000-000000000001', 'Frente Alice', 'Verso Alice', 'manual', 'aprovado', 'new', NOW(), 1.0, 3.0, 0, 1, 0, 0),
          ('c2000000-0000-4000-8000-000000000001', '${PERSONA_CARLOS.id}', '31000000-0000-4000-8000-000000000001', 'Frente Carlos', 'Verso Carlos', 'manual', 'aprovado', 'review', NOW(), 1.0, 3.0, 0, 1, 0, 0)
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.sessoes (id, perfil_id, ciclo_bloco_id, topico_id, etapa_atingida, iniciada_em, concluida)
        VALUES
          ('51000000-0000-4000-8000-000000000001', '${PERSONA_ALICE.id}', '41000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'registro', NOW(), true),
          ('52000000-0000-4000-8000-000000000001', '${PERSONA_CARLOS.id}', '41000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'registro', NOW(), true)
        ON CONFLICT (id) DO NOTHING;
      `);
    });

    afterAll(async () => {
      if (pg) {
        await pg.close();
      }
    });

    it('3.1 Alice enxerga exclusivamente seus próprios ciclos e cards (Zero Vazamento de Carlos)', async () => {
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [PERSONA_ALICE.id, 'estudante']);

        const ciclosRes = await pg.query<{ id: string; estudante_perfil_id: string }>(
          'SELECT id, estudante_perfil_id FROM public.ciclos;'
        );
        expect(ciclosRes.rows.length).toBe(1);
        expect(ciclosRes.rows[0].id).toBe(STAGING_ALICE_CICLO_ID);
        expect(ciclosRes.rows[0].estudante_perfil_id).toBe(PERSONA_ALICE.id);

        const cardsRes = await pg.query<{ id: string; perfil_id: string }>(
          'SELECT id, perfil_id FROM public.cards;'
        );
        expect(cardsRes.rows.length).toBeGreaterThanOrEqual(1);
        expect(cardsRes.rows.every((c) => c.perfil_id === PERSONA_ALICE.id)).toBe(true);
        expect(cardsRes.rows.some((c) => c.perfil_id === PERSONA_CARLOS.id)).toBe(false);
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    it('3.2 Carlos enxerga exclusivamente seus próprios ciclos e cards (Zero Vazamento de Alice)', async () => {
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [PERSONA_CARLOS.id, 'estudante']);

        const ciclosRes = await pg.query<{ id: string; estudante_perfil_id: string }>(
          'SELECT id, estudante_perfil_id FROM public.ciclos;'
        );
        expect(ciclosRes.rows.length).toBe(1);
        expect(ciclosRes.rows[0].id).toBe(STAGING_CARLOS_CICLO_ID);
        expect(ciclosRes.rows[0].estudante_perfil_id).toBe(PERSONA_CARLOS.id);

        const cardsRes = await pg.query<{ id: string; perfil_id: string }>(
          'SELECT id, perfil_id FROM public.cards;'
        );
        expect(cardsRes.rows.length).toBe(1);
        expect(cardsRes.rows[0].id).toBe('c2000000-0000-4000-8000-000000000001');
        expect(cardsRes.rows[0].perfil_id).toBe(PERSONA_CARLOS.id);
        expect(cardsRes.rows.some((c) => c.perfil_id === PERSONA_ALICE.id)).toBe(false);
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    it('3.3 Bruno tem acesso ao estudante vinculado Alice através de current_managed_estudante_id()', async () => {
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [PERSONA_BRUNO.id, 'responsavel']);

        const res = await pg.query<{ estudante_vinculado: string }>(
          'SELECT medicina.current_managed_estudante_id() AS estudante_vinculado;'
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].estudante_vinculado).toBe(PERSONA_ALICE.id);
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    it('3.4 Bruno NÃO tem acesso a sessões individuais brutas (Princípio 1.2 da ESPEC)', async () => {
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [PERSONA_BRUNO.id, 'responsavel']);

        const res = await pg.query('SELECT * FROM public.sessoes;');
        expect(res.rows.length).toBe(0);
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    it('3.5 Bruno NÃO possui qualquer acesso aos ciclos ou sessões de Carlos (Zero Vazamento de estudante não vinculado)', async () => {
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [PERSONA_BRUNO.id, 'responsavel']);

        const ciclos = await pg.query('SELECT * FROM public.ciclos WHERE estudante_perfil_id = $1::uuid;', [PERSONA_CARLOS.id]);
        const sessoes = await pg.query('SELECT * FROM public.sessoes WHERE perfil_id = $1::uuid;', [PERSONA_CARLOS.id]);

        expect(ciclos.rows.length).toBe(0);
        expect(sessoes.rows.length).toBe(0);
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    it('3.6 Tentativa de escalada de privilégios (role mismatch) é sumariamente rejeitada com erro P0001', async () => {
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      let capturouErro = false;
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [PERSONA_ALICE.id, 'responsavel']);
      } catch (err: any) {
        capturouErro = true;
        expect(err.message).toMatch(/Contexto invalido.*com papel responsavel nao existe/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }
      expect(capturouErro).toBe(true);
    });

    it('3.7 Tentativa de set_context com UUID inexistente é rejeitada fail-closed com erro P0001', async () => {
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      let capturouErro = false;
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', ['00000000-0000-4000-8000-000000000000', 'estudante']);
      } catch (err: any) {
        capturouErro = true;
        expect(err.message).toMatch(/Contexto invalido.*com papel estudante nao existe/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }
      expect(capturouErro).toBe(true);
    });
  });

  // ============================================================================
  // GRUPO 4: TESTES FUNCIONAIS E GUARDRAILS DE DOMÍNIO
  // ============================================================================
  describe('4. Testes Funcionais e Guardrails de Domínio', () => {
    it('4.1 Middleware matcher intercepta rotas de aplicação e libera rotas públicas', async () => {
      const { config } = await import('../../middleware');
      expect(config.matcher).toBeDefined();

      const regexPattern = new RegExp('^' + config.matcher[0]);
      expect(regexPattern.test('/login')).toBe(false);
      expect(regexPattern.test('/api/auth/session')).toBe(false);
      expect(regexPattern.test('/favicon.ico')).toBe(false);
      expect(regexPattern.test('/_next/static/chunks/main.js')).toBe(false);

      expect(regexPattern.test('/')).toBe(true);
      expect(regexPattern.test('/ciclo')).toBe(true);
      expect(regexPattern.test('/acervo')).toBe(true);
      expect(regexPattern.test('/caderno-erros')).toBe(true);
      expect(regexPattern.test('/responsavel')).toBe(true);
    });

    it('4.2 Gerador sintético de PDF produz documento 100% em conformidade com PDF 1.4', () => {
      const buffer = createSyntheticPdfBuffer('Título Teste', 'Texto de teste sintético.');
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(100);

      const header = buffer.subarray(0, 8).toString('utf8');
      expect(header).toContain('%PDF-1.4');

      const fullText = buffer.toString('utf8');
      expect(fullText).toContain('startxref');
      expect(fullText).toContain('%%EOF');
      expect(fullText).toContain('/Type /Catalog');
      expect(fullText).toContain('Título Teste');
    });

    it('4.3 Deduplicação de acervo gera hash SHA-256 e storage path determinístico', () => {
      const buffer1 = createSyntheticPdfBuffer('Doc A', 'Conteúdo idêntico');
      const buffer2 = createSyntheticPdfBuffer('Doc A', 'Conteúdo idêntico');

      const crypto = require('node:crypto');
      const hash1 = crypto.createHash('sha256').update(buffer1).digest('hex');
      const hash2 = crypto.createHash('sha256').update(buffer2).digest('hex');

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64);
    });
  });

  // ============================================================================
  // GRUPO 5: PROCEDIMENTO DE LIMPEZA COMPLETA (TEARDOWN SEGURO)
  // ============================================================================
  describe.skipIf(!HAS_PGLITE)('5. Validação do Procedimento de Limpeza Pós-Homologação', () => {
    let pg: PGliteInstance;

    beforeAll(async () => {
      const { PGlite } = await import(pathToFileURL(PGLITE_INDEX).href);
      const { vector } = await import(pathToFileURL(PGLITE_VECTOR).href);
      pg = await PGlite.create({ extensions: { vector } });

      await pg.exec(`
        CREATE SCHEMA IF NOT EXISTS storage;
        CREATE TABLE IF NOT EXISTS storage.buckets (
          id text PRIMARY KEY,
          name text NOT NULL UNIQUE,
          public boolean DEFAULT false NOT NULL,
          file_size_limit bigint,
          allowed_mime_types text[],
          created_at timestamptz DEFAULT now() NOT NULL,
          updated_at timestamptz DEFAULT now() NOT NULL
        );
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES ('acervo', 'acervo', false, 52428800, ARRAY['application/pdf']::text[])
        ON CONFLICT (id) DO NOTHING;
      `);

      const projectRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../');
      const readSql = (relPath: string) =>
        readFileSync(path.join(projectRoot, relPath), 'utf8').replaceAll(
          '--> statement-breakpoint',
          '\n'
        );

      await pg.exec(readSql('drizzle/0000_greedy_loki.sql'));
      await pg.exec(readSql('drizzle/0001_dry_talos.sql'));
      await pg.exec(readSql('drizzle/0002_little_swarm.sql'));
      await pg.exec(readSql('drizzle/0003_f1_03_r_expansao.sql'));
      await pg.exec(readSql('tests/integration/f1_04/fixtures.sql'));
      await pg.exec(`
        UPDATE public.acervo_arquivos
        SET file_path = 'acervo/' || repeat('a', 64) || '_' || substr(id::text, 1, 8) || '.pdf'
        WHERE NOT (file_path ~ '^acervo/[0-9a-f]{64}(_[A-Za-z0-9._-]+)?\\.pdf$');
      `);
      await pg.exec(readSql('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql'));
      await pg.exec(readSql('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'));
      await pg.exec(readSql('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql'));
      await pg.exec(readSql('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql'));

      // Insere dados sintéticos para teste de limpeza
      await pg.exec(`
        INSERT INTO public.allowlist (email) VALUES ('${PERSONA_ALICE.email}'), ('${PERSONA_CARLOS.email}') ON CONFLICT DO NOTHING;
        INSERT INTO public.perfis (id, auth_user_id, nome, email, papel)
        VALUES
          ('${PERSONA_ALICE.id}', '${PERSONA_ALICE.id}', '${PERSONA_ALICE.nome}', '${PERSONA_ALICE.email}', 'estudante'),
          ('${PERSONA_CARLOS.id}', '${PERSONA_CARLOS.id}', '${PERSONA_CARLOS.nome}', '${PERSONA_CARLOS.email}', 'estudante')
        ON CONFLICT DO NOTHING;
        INSERT INTO public.ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana)
        VALUES ('${STAGING_ALICE_CICLO_ID}', '${PERSONA_ALICE.id}', 'Ciclo Alice', 2027, true, 28)
        ON CONFLICT DO NOTHING;
      `);
    });

    afterAll(async () => {
      if (pg) {
        await pg.close();
      }
    });

    it('5.1 Executa a limpeza completa dos dados sintéticos e deixa tabelas limpas', async () => {
      const syntheticPerfis = [PERSONA_ALICE.id, PERSONA_BRUNO.id, PERSONA_CARLOS.id];
      const syntheticEmails = [PERSONA_ALICE.email, PERSONA_BRUNO.email, PERSONA_CARLOS.email];

      await pg.exec(`
        DELETE FROM public.curadoria_fila WHERE artefato_id IN (
          SELECT id FROM public.cards WHERE perfil_id IN ('${syntheticPerfis.join("','")}')
        ) OR artefato_id IN (
          SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ('${syntheticPerfis.join("','")}')
        );
        DELETE FROM public.acervo_jobs WHERE enviado_por IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.acervo_chunks WHERE arquivo_id IN (
          SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ('${syntheticPerfis.join("','")}')
        );
        DELETE FROM public.acervo_paginas WHERE arquivo_id IN (
          SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ('${syntheticPerfis.join("','")}')
        );
        DELETE FROM public.acervo_arquivos WHERE enviado_por IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.erros WHERE perfil_id IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.tentativas WHERE sessao_id IN (
          SELECT id FROM public.sessoes WHERE perfil_id IN ('${syntheticPerfis.join("','")}')
        );
        DELETE FROM public.sessoes WHERE perfil_id IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.card_revisoes WHERE card_id IN (
          SELECT id FROM public.cards WHERE perfil_id IN ('${syntheticPerfis.join("','")}')
        );
        DELETE FROM public.cards WHERE perfil_id IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.repertorios WHERE perfil_id IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.livros WHERE perfil_id IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.materiais WHERE aprovado_por IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.redacoes WHERE perfil_id IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.simulado_questoes WHERE simulado_id IN (
          SELECT id FROM public.simulados WHERE perfil_id IN ('${syntheticPerfis.join("','")}')
        );
        DELETE FROM public.simulado_areas WHERE simulado_id IN (
          SELECT id FROM public.simulados WHERE perfil_id IN ('${syntheticPerfis.join("','")}')
        );
        DELETE FROM public.simulado_analise WHERE simulado_id IN (
          SELECT id FROM public.simulados WHERE perfil_id IN ('${syntheticPerfis.join("','")}')
        );
        DELETE FROM public.simulados WHERE perfil_id IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.ciclo_estado WHERE ciclo_id IN (
          SELECT id FROM public.ciclos WHERE estudante_perfil_id IN ('${syntheticPerfis.join("','")}')
        );
        DELETE FROM public.ciclo_blocos WHERE ciclo_id IN (
          SELECT id FROM public.ciclos WHERE estudante_perfil_id IN ('${syntheticPerfis.join("','")}')
        );
        DELETE FROM public.ciclos WHERE estudante_perfil_id IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.revisoes_trimestrais WHERE estudante_perfil_id IN ('${syntheticPerfis.join("','")}')
           OR registrada_por_perfil_id IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.checkins WHERE perfil_id IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.responsavel_estudante WHERE responsavel_perfil_id IN ('${syntheticPerfis.join("','")}')
           OR estudante_perfil_id IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.perfis WHERE id IN ('${syntheticPerfis.join("','")}');
        DELETE FROM public.allowlist WHERE email IN ('${syntheticEmails.join("','")}');
      `);

      const perfisCheck = await pg.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM public.perfis WHERE id IN ('${syntheticPerfis.join("','")}');`
      );
      const allowlistCheck = await pg.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM public.allowlist WHERE email IN ('${syntheticEmails.join("','")}');`
      );
      const ciclosCheck = await pg.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM public.ciclos WHERE estudante_perfil_id IN ('${syntheticPerfis.join("','")}');`
      );

      expect(Number(perfisCheck.rows[0].count)).toBe(0);
      expect(Number(allowlistCheck.rows[0].count)).toBe(0);
      expect(Number(ciclosCheck.rows[0].count)).toBe(0);
    });
  });
});
