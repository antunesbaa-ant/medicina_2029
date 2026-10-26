import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import {
  executeStagingMigrations,
  getMigrationManifest,
  stripOuterTransaction,
} from '../../../scripts/db/migrate-staging.mjs';

const moduleRoot = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';

if (!existsSync(moduleRoot)) {
  throw new Error(`Diretório de módulos isolados não encontrado em ${moduleRoot}.`);
}

const importFromRoot = (pkgPath: string) => import(pathToFileURL(path.join(moduleRoot, pkgPath)).href);

const [{ PGlite }, { vector }] = await Promise.all([
  importFromRoot('@electric-sql/pglite/dist/index.js'),
  importFromRoot('@electric-sql/pglite-pgvector/dist/index.js'),
]);

interface SqlAdapter {
  (strings: TemplateStringsArray | string, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  unsafe: (queryText: string) => Promise<unknown[]>;
  reserve?: () => Promise<SqlAdapter>;
  release?: () => void;
  begin?: <T>(cb: (tx: SqlAdapter) => Promise<T>) => Promise<T>;
}

interface PGliteInstance {
  exec: (query: string) => Promise<unknown>;
  query: (query: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

function createSqlAdapter(db: PGliteInstance): SqlAdapter {
  const sqlAdapter: SqlAdapter = Object.assign(
    async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      let queryText = '';
      if (typeof strings === 'string') {
        queryText = strings;
      } else {
        queryText = strings[0];
        for (let i = 0; i < values.length; i++) {
          const val = values[i];
          if (typeof val === 'number') {
            queryText += String(val) + strings[i + 1];
          } else if (typeof val === 'string') {
            queryText += `'${val.replace(/'/g, "''")}'` + strings[i + 1];
          } else if (val === null || val === undefined) {
            queryText += 'NULL' + strings[i + 1];
          } else {
            queryText += `'${JSON.stringify(val).replace(/'/g, "''")}'` + strings[i + 1];
          }
        }
      }
      const res = await db.query(queryText);
      return res.rows;
    },
    {
      unsafe: async (queryText: string) => {
        await db.exec(queryText);
        return [];
      },
      reserve: async () => {
        const reservedConnection = Object.assign(
          async (strings: TemplateStringsArray | string, ...values: unknown[]) => sqlAdapter(strings, ...values),
          {
            unsafe: sqlAdapter.unsafe,
            release: () => {},
          }
        );
        return reservedConnection as unknown as SqlAdapter;
      },
      release: () => {},
    }
  );
  return sqlAdapter;
}

const RESPONSAVEL_1 = {
  id: '20000000-0000-4000-8000-000000000001',
  authUserId: 'b0000000-0000-4000-8000-000000000001',
  nome: 'Responsavel 1',
  papel: 'responsavel' as const,
};

const RESPONSAVEL_2 = {
  id: '20000000-0000-4000-8000-000000000002',
  authUserId: 'b0000000-0000-4000-8000-000000000002',
  nome: 'Responsavel 2',
  papel: 'responsavel' as const,
};

const ESTUDANTE_1 = {
  id: '10000000-0000-4000-8000-000000000001',
  authUserId: 'a0000000-0000-4000-8000-000000000001',
  nome: 'Estudante 1',
  papel: 'estudante' as const,
};

const DISCIPLINA_BIOLOGIA = '30000000-0000-4000-8000-000000000001';
const TOPICO_CITOLOGIA = '31000000-0000-4000-8000-000000000001';
const ARQUIVO_1_ID = '60000000-0000-4000-8000-000000000001';
const ARQUIVO_2_ID = '60000000-0000-4000-8000-000000000002';

/**
 * Cria banco PostgreSQL descartável (PGlite) com etapas 1 a 7 aplicadas sequencialmente,
 * simulando o catálogo de storage e dados de teste canônicos.
 */
async function createSimulatedDbWithSteps1To7Applied(): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
  const db = new PGlite({
    extensions: { vector },
  });

  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;

    -- Catálogo de Storage simulado para atender à validação da etapa 7
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
    VALUES ('acervo', 'acervo', false, 20971520, ARRAY['application/pdf']::text[])
    ON CONFLICT (id) DO UPDATE SET public = false;

    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      bucket_id text NOT NULL REFERENCES storage.buckets(id) ON DELETE RESTRICT,
      name text NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL
    );
  `);

  // Tabela de rastreamento de migrações de staging
  await db.exec(`
    CREATE TABLE public._medicina_staging_migrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ordem integer NOT NULL UNIQUE,
      rel_path text NOT NULL UNIQUE,
      sha256 text NOT NULL,
      aplicado_em timestamptz DEFAULT now() NOT NULL,
      executado_por text NOT NULL,
      tamanho_bytes integer NOT NULL
    );
  `);

  const initialMigrations = [
    { ordem: 1, relPath: 'drizzle/0000_greedy_loki.sql' },
    { ordem: 2, relPath: 'drizzle/0001_dry_talos.sql' },
    { ordem: 3, relPath: 'drizzle/0002_little_swarm.sql' },
    { ordem: 4, relPath: 'drizzle/0003_f1_03_r_expansao.sql' },
    { ordem: 5, relPath: 'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql' },
    { ordem: 6, relPath: 'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql' },
    { ordem: 7, relPath: 'docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql' },
  ];

  const manifest = getMigrationManifest();

  for (const m of initialMigrations) {
    const rawSql = readFileSync(path.resolve(process.cwd(), m.relPath), 'utf8');
    const cleanSql = stripOuterTransaction(rawSql);
    await db.exec(cleanSql);

    const mInfo = manifest.find((item) => item.ordem === m.ordem)!;
    await db.exec(`
      INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
      VALUES (${m.ordem}, '${m.relPath}', '${mInfo.sha256}', 'postgres', ${mInfo.tamanhoBytes});
    `);
  }

  // Seed de dados canônicos em conformidade com RLS e formato seguro de storage
  await db.exec(`
    INSERT INTO public.perfis (id, auth_user_id, nome, papel) VALUES
      ('${RESPONSAVEL_1.id}', '${RESPONSAVEL_1.authUserId}', '${RESPONSAVEL_1.nome}', '${RESPONSAVEL_1.papel}'),
      ('${RESPONSAVEL_2.id}', '${RESPONSAVEL_2.authUserId}', '${RESPONSAVEL_2.nome}', '${RESPONSAVEL_2.papel}'),
      ('${ESTUDANTE_1.id}', '${ESTUDANTE_1.authUserId}', '${ESTUDANTE_1.nome}', '${ESTUDANTE_1.papel}')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.disciplinas (id, nome, area, cor_hex, ordem) VALUES
      ('${DISCIPLINA_BIOLOGIA}', 'Biologia', 'natureza', '#22C55E', 1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.topicos (id, disciplina_id, nome, serie_prevista, incidencia_enem, incidencia_uece, ordem) VALUES
      ('${TOPICO_CITOLOGIA}', '${DISCIPLINA_BIOLOGIA}', 'Citologia', 1, 3, 3, 1)
    ON CONFLICT (id) DO NOTHING;

    -- Arquivo 1 do Responsável 1 com caminho e hash canônicos
    INSERT INTO public.acervo_arquivos (
      id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular,
      file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo
    ) VALUES (
      '${ARQUIVO_1_ID}', '${DISCIPLINA_BIOLOGIA}', 'Apostila Citologia R1', 'apostila', 1, 'ENEM',
      'acervo/1111111111111111111111111111111111111111111111111111111111111111.pdf',
      'application/pdf', 2048, 1, '${RESPONSAVEL_1.id}', 'concluido',
      '1111111111111111111111111111111111111111111111111111111111111111'
    ) ON CONFLICT (id) DO NOTHING;

    -- Arquivo 2 do Responsável 2 com caminho e hash canônicos
    INSERT INTO public.acervo_arquivos (
      id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular,
      file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo
    ) VALUES (
      '${ARQUIVO_2_ID}', '${DISCIPLINA_BIOLOGIA}', 'Apostila Citologia R2', 'apostila', 1, 'ENEM',
      'acervo/2222222222222222222222222222222222222222222222222222222222222222.pdf',
      'application/pdf', 4096, 1, '${RESPONSAVEL_2.id}', 'aguardando',
      '2222222222222222222222222222222222222222222222222222222222222222'
    ) ON CONFLICT (id) DO NOTHING;
  `);

  const sqlAdapter = createSqlAdapter(db);
  return { db, sql: sqlAdapter };
}

describe('MEDICINA 2029 — H1.08: Ciclo de Vida e Segurança da Migração F1.11 (Fila de Ingestão) em PGlite', () => {
  it('1. Replay das etapas 1 a 7 e aplicação exclusiva de F1.11 com parada estrita em untilStep=8', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To7Applied();
    const logs: string[] = [];

    // Confere estado inicial: exatamente 7 migrações registradas
    const preRes = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(preRes.rows[0].cnt).toBe(7);

    // Executa o runner com portão operacional estrito untilStep = 8
    const manifest = getMigrationManifest();
    const result = await executeStagingMigrations({
      sql,
      manifest,
      isDryRun: false,
      untilStep: 8,
      logger: (msg: string) => logs.push(msg),
    });

    expect(result.appliedCount).toBe(1);
    expect(result.skippedCount).toBe(7);
    expect(result.total).toBe(9);

    // Confirma que as etapas 1 a 7 foram puladas com [SKIP]
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0000_greedy_loki.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0001_dry_talos.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0002_little_swarm.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0003_f1_03_r_expansao.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('F1_04_RLS_PROPOSTA.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('F1_10_STORAGE_POLICIES_PROPOSTA.sql'))).toBe(true);

    // Confirma histórico com exatamente 8 registros ordenados
    const historyRes = await db.query(
      'SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations ORDER BY ordem ASC;'
    );
    expect(historyRes.rows.length).toBe(8);
    expect(historyRes.rows.map((r) => r.ordem)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(historyRes.rows[7].rel_path).toBe('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql');

    const expectedSha256 = manifest.find((m) => m.ordem === 8)?.sha256;
    expect(historyRes.rows[7].sha256).toBe(expectedSha256);

    // Confirma criação física da tabela pública acervo_jobs
    const tableCheck = await db.query("SELECT to_regclass('public.acervo_jobs') as tbl;");
    expect(tableCheck.rows[0].tbl).not.toBeNull();

    // Confirma interrupção planejada no portão operacional (untilStep = 8)
    expect(logs.some((l) => l.includes('[STOP] Interrupção planejada no portão operacional (untilStep = 8)'))).toBe(true);

    // Confirma ausência absoluta de qualquer objeto da etapa 9 (F1.12)
    const step9Check = await db.query("SELECT 1 FROM pg_proc WHERE proname = 'fn_busca_hibrida_acervo';");
    expect(step9Check.rows.length).toBe(0);

    const step9History = await db.query("SELECT 1 FROM public._medicina_staging_migrations WHERE ordem = 9;");
    expect(step9History.rows.length).toBe(0);
  });

  it('2. Backfill determinístico de registros históricos em acervo_arquivos para acervo_jobs', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To7Applied();
    await executeStagingMigrations({ sql, untilStep: 8, logger: () => {} });

    // Verifica que os dois arquivos pré-existentes foram mapeados para acervo_jobs
    const jobsRes = await db.query(`
      SELECT arquivo_id, enviado_por, status, etapa_atual, tentativas, max_tentativas
      FROM public.acervo_jobs
      ORDER BY arquivo_id;
    `);

    expect(jobsRes.rows.length).toBe(2);

    // Arquivo 1 (estava como concluido) -> status concluido, etapa concluido, tentativas 1
    const job1 = jobsRes.rows.find((j) => j.arquivo_id === ARQUIVO_1_ID);
    expect(job1).toBeDefined();
    expect(job1?.enviado_por).toBe(RESPONSAVEL_1.id);
    expect(job1?.status).toBe('concluido');
    expect(job1?.etapa_atual).toBe('concluido');
    expect(job1?.tentativas).toBe(1);

    // Arquivo 2 (estava como aguardando) -> status aguardando, etapa extracao, tentativas 0
    const job2 = jobsRes.rows.find((j) => j.arquivo_id === ARQUIVO_2_ID);
    expect(job2).toBeDefined();
    expect(job2?.enviado_por).toBe(RESPONSAVEL_2.id);
    expect(job2?.status).toBe('aguardando');
    expect(job2?.etapa_atual).toBe('extracao');
    expect(job2?.tentativas).toBe(0);
  });

  it('3. Teste de RLS em acervo_jobs: isolamento estrito entre responsáveis, rejeição de estudante e bypass do worker', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To7Applied();
    await executeStagingMigrations({ sql, untilStep: 8, logger: () => {} });

    // 3.1 Responsável 1 sob medicina_app: vê apenas seus próprios jobs e não pode modificar jobs de terceiros
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.query('SELECT medicina.set_context($1::uuid, $2::text);', [RESPONSAVEL_1.id, RESPONSAVEL_1.papel]);

      const resp1Jobs = await db.query('SELECT arquivo_id, enviado_por FROM public.acervo_jobs;');
      expect(resp1Jobs.rows.length).toBe(1);
      expect(resp1Jobs.rows[0].arquivo_id).toBe(ARQUIVO_1_ID);
      expect(resp1Jobs.rows[0].enviado_por).toBe(RESPONSAVEL_1.id);

      // Tentativa de UPDATE no job do Responsável 2 afeta zero linhas
      const updateCross = await db.query(
        "UPDATE public.acervo_jobs SET status = 'concluido' WHERE arquivo_id = $1::uuid RETURNING id;",
        [ARQUIVO_2_ID]
      );
      expect(updateCross.rows.length).toBe(0);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 3.2 Responsável 2 sob medicina_app: vê apenas o job do Responsável 2
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.query('SELECT medicina.set_context($1::uuid, $2::text);', [RESPONSAVEL_2.id, RESPONSAVEL_2.papel]);

      const resp2Jobs = await db.query('SELECT arquivo_id, enviado_por FROM public.acervo_jobs;');
      expect(resp2Jobs.rows.length).toBe(1);
      expect(resp2Jobs.rows[0].arquivo_id).toBe(ARQUIVO_2_ID);
      expect(resp2Jobs.rows[0].enviado_por).toBe(RESPONSAVEL_2.id);

      // Tentativa de UPDATE no job do Responsável 1 afeta zero linhas
      const updateCross = await db.query(
        "UPDATE public.acervo_jobs SET status = 'concluido' WHERE arquivo_id = $1::uuid RETURNING id;",
        [ARQUIVO_1_ID]
      );
      expect(updateCross.rows.length).toBe(0);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 3.3 Estudante sob medicina_app: 0 linhas visíveis e INSERT negado por RLS fail-closed
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.query('SELECT medicina.set_context($1::uuid, $2::text);', [ESTUDANTE_1.id, ESTUDANTE_1.papel]);

      const estudanteJobs = await db.query('SELECT id FROM public.acervo_jobs;');
      expect(estudanteJobs.rows.length).toBe(0);

      // INSERT deve falhar por violação de política RLS
      await expect(
        db.exec(`
          INSERT INTO public.acervo_jobs (arquivo_id, enviado_por, status)
          VALUES ('${ARQUIVO_1_ID}', '${ESTUDANTE_1.id}', 'aguardando');
        `)
      ).rejects.toThrowError(/violates row-level security policy|permission denied/i);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 3.4 Worker independente (current_user = 'medicina_worker'): lê e atualiza todos os jobs
    await db.exec('SET ROLE medicina_worker;');
    try {
      const workerJobs = await db.query('SELECT arquivo_id, status FROM public.acervo_jobs ORDER BY arquivo_id;');
      expect(workerJobs.rows.length).toBe(2);

      // Worker atualiza o job do arquivo 2 para em_execucao com controle de lease
      await db.exec(`
        UPDATE public.acervo_jobs
        SET status = 'em_execucao',
            locked_by = 'test-worker-1',
            locked_at = now(),
            lease_expires_at = now() + interval '60 seconds'
        WHERE arquivo_id = '${ARQUIVO_2_ID}';
      `);

      const updatedJob = await db.query(`SELECT status, locked_by FROM public.acervo_jobs WHERE arquivo_id = '${ARQUIVO_2_ID}';`);
      expect(updatedJob.rows[0].status).toBe('em_execucao');
      expect(updatedJob.rows[0].locked_by).toBe('test-worker-1');
    } finally {
      await db.exec('RESET ROLE;');
    }
  });

  it('4. Teste de integridade de unicidade: UNIQUE em acervo_jobs, acervo_paginas e acervo_chunks', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To7Applied();
    await executeStagingMigrations({ sql, untilStep: 8, logger: () => {} });

    // 4.1 UNIQUE(arquivo_id) em acervo_jobs
    await expect(
      db.exec(`
        INSERT INTO public.acervo_jobs (arquivo_id, enviado_por, status)
        VALUES ('${ARQUIVO_1_ID}', '${RESPONSAVEL_1.id}', 'aguardando');
      `)
    ).rejects.toThrowError(/duplicate key value|acervo_jobs_arquivo_id_unique/i);

    // 4.2 UNIQUE(arquivo_id, numero) em acervo_paginas
    await db.exec(`
      INSERT INTO public.acervo_paginas (id, arquivo_id, numero, texto_extraido)
      VALUES (gen_random_uuid(), '${ARQUIVO_1_ID}', 1, 'Texto da Pagina 1');
    `);

    await expect(
      db.exec(`
        INSERT INTO public.acervo_paginas (id, arquivo_id, numero, texto_extraido)
        VALUES (gen_random_uuid(), '${ARQUIVO_1_ID}', 1, 'Texto Duplicado Pagina 1');
      `)
    ).rejects.toThrowError(/duplicate key value|acervo_paginas_arquivo_numero_unique/i);

    // 4.3 UNIQUE(arquivo_id, ordem) em acervo_chunks
    await db.exec(`
      INSERT INTO public.acervo_chunks (id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo)
      VALUES (gen_random_uuid(), '${ARQUIVO_1_ID}', 1, 1, 1, 'Chunk 1', 'exposicao_teorica');
    `);

    await expect(
      db.exec(`
        INSERT INTO public.acervo_chunks (id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo)
        VALUES (gen_random_uuid(), '${ARQUIVO_1_ID}', 1, 1, 1, 'Chunk 1 Duplicado', 'exposicao_teorica');
      `)
    ).rejects.toThrowError(/duplicate key value|acervo_chunks_arquivo_ordem_unique/i);
  });

  it('5. Teste de concorrência e lease: disputa de jobs via SKIP LOCKED e recuperação de lease expirado', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To7Applied();
    await executeStagingMigrations({ sql, untilStep: 8, logger: () => {} });

    // Cria um terceiro arquivo e job para ter múltiplos jobs disputáveis
    const ARQUIVO_3_ID = '60000000-0000-4000-8000-000000000003';
    await db.exec(`
      INSERT INTO public.acervo_arquivos (
        id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular,
        file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo
      ) VALUES (
        '${ARQUIVO_3_ID}', '${DISCIPLINA_BIOLOGIA}', 'Apostila 3', 'apostila', 1, 'ENEM',
        'acervo/3333333333333333333333333333333333333333333333333333333333333333.pdf',
        'application/pdf', 2048, 1, '${RESPONSAVEL_1.id}', 'aguardando',
        '3333333333333333333333333333333333333333333333333333333333333333'
      );

      INSERT INTO public.acervo_jobs (arquivo_id, enviado_por, status, etapa_atual, tentativas, proxima_execucao_em)
      VALUES ('${ARQUIVO_3_ID}', '${RESPONSAVEL_1.id}', 'aguardando', 'extracao', 0, now());
    `);

    // 5.1 Dois workers simultâneos consultando jobs claimable com SKIP LOCKED
    // Worker 1 bloqueia o primeiro job
    await db.exec('BEGIN;');
    const claimWorker1 = await db.query(`
      SELECT id, arquivo_id FROM public.acervo_jobs
      WHERE status = 'aguardando' AND proxima_execucao_em <= now()
      ORDER BY proxima_execucao_em ASC, criado_em ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1;
    `);
    expect(claimWorker1.rows.length).toBe(1);
    const lockedJobId1 = claimWorker1.rows[0].id;

    // Worker 1 assume o job com lease
    await db.exec(`
      UPDATE public.acervo_jobs
      SET status = 'em_execucao',
          locked_by = 'worker-alpha',
          locked_at = now(),
          lease_expires_at = now() + interval '60 seconds'
      WHERE id = '${lockedJobId1}';
    `);
    await db.exec('COMMIT;');

    // Worker 2 tenta reivindicar: pula o job do worker 1 e adquire o próximo disponível
    await db.exec('BEGIN;');
    const claimWorker2 = await db.query(`
      SELECT id, arquivo_id FROM public.acervo_jobs
      WHERE status = 'aguardando' AND proxima_execucao_em <= now()
      ORDER BY proxima_execucao_em ASC, criado_em ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1;
    `);
    expect(claimWorker2.rows.length).toBe(1);
    const lockedJobId2 = claimWorker2.rows[0].id;
    expect(lockedJobId2).not.toBe(lockedJobId1);

    await db.exec(`
      UPDATE public.acervo_jobs
      SET status = 'em_execucao',
          locked_by = 'worker-beta',
          locked_at = now(),
          lease_expires_at = now() + interval '60 seconds'
      WHERE id = '${lockedJobId2}';
    `);
    await db.exec('COMMIT;');

    // 5.2 Recuperação de Lease Expirado
    // Simula que o Worker Alpha crashou e o lease expirou há 10 segundos (mantendo locked_at <= lease_expires_at)
    await db.exec(`
      UPDATE public.acervo_jobs
      SET locked_at = now() - interval '70 seconds',
          lease_expires_at = now() - interval '10 seconds'
      WHERE id = '${lockedJobId1}';
    `);

    // Consulta de candidatos elegíveis inclui jobs com lease expirado
    const expiredCandidates = await db.query(`
      SELECT id, locked_by
      FROM public.acervo_jobs
      WHERE (status = 'aguardando' AND proxima_execucao_em <= now())
         OR (status = 'em_execucao' AND lease_expires_at <= now());
    `);
    expect(expiredCandidates.rows.some((j) => j.id === lockedJobId1)).toBe(true);

    // Worker Gamma recupera o job expirado com atomicidade
    await db.exec(`
      UPDATE public.acervo_jobs
      SET status = 'em_execucao',
          locked_by = 'worker-gamma',
          locked_at = now(),
          lease_expires_at = now() + interval '60 seconds',
          tentativas = tentativas + 1,
          atualizado_em = now()
      WHERE id = '${lockedJobId1}'
        AND status = 'em_execucao'
        AND lease_expires_at <= now();
    `);

    const recoveredJob = await db.query(`
      SELECT status, locked_by, tentativas
      FROM public.acervo_jobs
      WHERE id = '${lockedJobId1}';
    `);
    expect(recoveredJob.rows[0].status).toBe('em_execucao');
    expect(recoveredJob.rows[0].locked_by).toBe('worker-gamma');
    expect(recoveredJob.rows[0].tentativas).toBeGreaterThan(0);
  });

  it('6. Teste de Rollback (F1_11_ROLLBACK_FILA_INGESTAO.sql) e Reversibilidade Simétrica', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To7Applied();
    await executeStagingMigrations({ sql, untilStep: 8, logger: () => {} });

    // Confere que acervo_jobs e constraints existem antes do rollback
    const preTable = await db.query("SELECT to_regclass('public.acervo_jobs') as tbl;");
    expect(preTable.rows[0].tbl).not.toBeNull();

    // Aplica o script de rollback
    const rollbackSql = readFileSync(
      path.resolve(process.cwd(), 'docs/modernizacao/propostas/F1_11_ROLLBACK_FILA_INGESTAO.sql'),
      'utf8'
    );
    await db.exec(stripOuterTransaction(rollbackSql));

    // 1. Confirma que a tabela acervo_jobs foi removida
    const postTable = await db.query("SELECT to_regclass('public.acervo_jobs') as tbl;");
    expect(postTable.rows[0].tbl).toBeNull();

    // 2. Confirma que as constraints de unicidade foram removidas
    const postCstPaginas = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'acervo_paginas_arquivo_numero_unique';"
    );
    expect(postCstPaginas.rows.length).toBe(0);

    const postCstChunks = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'acervo_chunks_arquivo_ordem_unique';"
    );
    expect(postCstChunks.rows.length).toBe(0);

    // 3. Remove registro do histórico e re-executa a migração 8 para demonstrar reversibilidade
    await db.exec("DELETE FROM public._medicina_staging_migrations WHERE ordem = 8;");

    const reResult = await executeStagingMigrations({ sql, untilStep: 8, logger: () => {} });
    expect(reResult.appliedCount).toBe(1);
    expect(reResult.skippedCount).toBe(7);

    // Confirma que acervo_jobs foi recriada perfeitamente
    const finalTable = await db.query("SELECT to_regclass('public.acervo_jobs') as tbl;");
    expect(finalTable.rows[0].tbl).not.toBeNull();

    const finalHistory = await db.query("SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;");
    expect(finalHistory.rows[0].cnt).toBe(8);
  });
});
