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

async function queryWithContext<T = Record<string, unknown>>(
  db: PGliteInstance,
  perfilId: string,
  papel: string,
  queryText: string
): Promise<T[]> {
  await db.exec('BEGIN;');
  try {
    await db.exec(`SELECT medicina.set_context('${perfilId}'::uuid, '${papel}');`);
    const res = await db.query(queryText);
    await db.exec('COMMIT;');
    return res.rows as unknown as T[];
  } catch (err) {
    await db.exec('ROLLBACK;');
    throw err;
  }
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

const ESTUDANTE_2 = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'a0000000-0000-4000-8000-000000000002',
  nome: 'Estudante 2',
  papel: 'estudante' as const,
};

const DISCIPLINA_BIOLOGIA = '30000000-0000-4000-8000-000000000001';
const TOPICO_CITOLOGIA = '31000000-0000-4000-8000-000000000001';
const ARQUIVO_1_ID = '60000000-0000-4000-8000-000000000001';
const ARQUIVO_2_ID = '60000000-0000-4000-8000-000000000002';

/**
 * Gera um vetor unitário normalizado de 1536 dimensões a partir de uma semente
 */
function generateNormalizedVector(seed: number, dimension = 1536): string {
  const vec: number[] = [];
  let sumSq = 0;
  for (let i = 0; i < dimension; i++) {
    const val = Math.sin(seed * (i + 1));
    vec.push(val);
    sumSq += val * val;
  }
  const norm = Math.sqrt(sumSq);
  const normalized = vec.map((v) => (v / norm).toFixed(6));
  return `[${normalized.join(',')}]`;
}

/**
 * Cria banco PostgreSQL descartável (PGlite) com etapas 1 a 8 aplicadas sequencialmente,
 * simulando o catálogo de storage e dados de teste canônicos.
 */
async function createSimulatedDbWithSteps1To8Applied(): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
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
  `);

  const manifest = getMigrationManifest();
  const sql = createSqlAdapter(db);

  // Aplica etapas 1 a 8
  await executeStagingMigrations({
    sql,
    manifest,
    isDryRun: false,
    untilStep: 8,
    logger: () => {},
  });

  // Popula dados base para testes de busca vetorial e proveniência
  await db.exec(`
    -- Perfis
    INSERT INTO public.perfis (id, auth_user_id, nome, papel)
    VALUES
      ('${RESPONSAVEL_1.id}', '${RESPONSAVEL_1.authUserId}', '${RESPONSAVEL_1.nome}', '${RESPONSAVEL_1.papel}'),
      ('${RESPONSAVEL_2.id}', '${RESPONSAVEL_2.authUserId}', '${RESPONSAVEL_2.nome}', '${RESPONSAVEL_2.papel}'),
      ('${ESTUDANTE_1.id}', '${ESTUDANTE_1.authUserId}', '${ESTUDANTE_1.nome}', '${ESTUDANTE_1.papel}'),
      ('${ESTUDANTE_2.id}', '${ESTUDANTE_2.authUserId}', '${ESTUDANTE_2.nome}', '${ESTUDANTE_2.papel}')
    ON CONFLICT (id) DO NOTHING;

    -- Vínculo familiar: Responsável 1 vinculado à Estudante 1
    INSERT INTO public.responsavel_estudante (responsavel_perfil_id, estudante_perfil_id)
    VALUES ('${RESPONSAVEL_1.id}', '${ESTUDANTE_1.id}')
    ON CONFLICT DO NOTHING;

    -- Vínculo familiar: Responsável 2 vinculado à Estudante 2
    INSERT INTO public.responsavel_estudante (responsavel_perfil_id, estudante_perfil_id)
    VALUES ('${RESPONSAVEL_2.id}', '${ESTUDANTE_2.id}')
    ON CONFLICT DO NOTHING;

    -- Disciplina e Tópico
    INSERT INTO public.disciplinas (id, nome, area, cor_hex, ordem)
    VALUES ('${DISCIPLINA_BIOLOGIA}', 'Biologia Celular', 'natureza', '#2E7D32', 1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.topicos (id, disciplina_id, nome, serie_prevista, incidencia_enem, incidencia_uece, ordem, cobertura_material)
    VALUES ('${TOPICO_CITOLOGIA}', '${DISCIPLINA_BIOLOGIA}', 'Citologia e Membrana', 1, 5, 4, 1, 'coberto')
    ON CONFLICT (id) DO NOTHING;
  `);

  return { db, sql };
}

describe('MEDICINA 2029 — H1.09: Ciclo de Vida e Segurança da Migração F1.12 (Busca Vetorial) em PGlite', () => {
  it('1. Replay das etapas 1 a 8 e aplicação exclusiva de F1.12 com 9 registros no histórico', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To8Applied();

    // Aplica a etapa 9 (F1.12)
    const result = await executeStagingMigrations({
      sql,
      untilStep: 9,
      logger: () => {},
    });

    expect(result.appliedCount).toBe(1);
    expect(result.skippedCount).toBe(8);
    expect(result.total).toBe(9);

    // Valida que exatamente 9 migrações constam na tabela de tracking
    const historyRes = await db.query(
      'SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations ORDER BY ordem ASC;'
    );
    expect(historyRes.rows.length).toBe(9);
    expect(historyRes.rows[8].ordem).toBe(9);
    expect(historyRes.rows[8].rel_path).toBe(
      'docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'
    );
  });

  it('2. Verifica criação dos índices HNSW e GIN FTS e constraints de proveniência', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To8Applied();
    await executeStagingMigrations({ sql, untilStep: 9, logger: () => {} });

    // 2.1 Índice HNSW em acervo_chunks(embedding)
    const hnswRes = await db.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'acervo_chunks'
        AND indexname = 'acervo_chunks_embedding_hnsw_idx';
    `);
    expect(hnswRes.rows.length).toBe(1);
    expect(hnswRes.rows[0].indexdef).toContain('USING hnsw');
    expect(hnswRes.rows[0].indexdef).toContain('vector_cosine_ops');

    // 2.2 Índice GIN FTS em acervo_chunks(to_tsvector)
    const ftsRes = await db.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'acervo_chunks'
        AND indexname = 'acervo_chunks_texto_fts_idx';
    `);
    expect(ftsRes.rows.length).toBe(1);
    expect(ftsRes.rows[0].indexdef).toContain('USING gin');
    expect(ftsRes.rows[0].indexdef).toContain('portuguese');

    // 2.3 Constraints de Proveniência NOT VALID
    const constraintsRes = await db.query(`
      SELECT conname, pg_get_constraintdef(c.oid) as def
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE c.conname IN (
        'materiais_gerado_proveniencia_check',
        'questoes_gerada_proveniencia_check',
        'cards_gerado_proveniencia_check'
      );
    `);
    expect(constraintsRes.rows.length).toBe(3);
    const conNames = constraintsRes.rows.map((r) => r.conname);
    expect(conNames).toContain('materiais_gerado_proveniencia_check');
    expect(conNames).toContain('questoes_gerada_proveniencia_check');
    expect(conNames).toContain('cards_gerado_proveniencia_check');

    // 2.4 Função fn_busca_hibrida_acervo instalada em medicina
    const procRes = await db.query(`
      SELECT p.proname, n.nspname, p.prosecdef
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'medicina' AND p.proname = 'fn_busca_hibrida_acervo';
    `);
    expect(procRes.rows.length).toBe(1);
    expect(procRes.rows[0].prosecdef).toBe(true); // SECURITY DEFINER
  });

  it('3. Validação de Dimensionalidade de Embeddings (1536) e Rejeição de Incompatíveis', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To8Applied();
    await executeStagingMigrations({ sql, untilStep: 9, logger: () => {} });

    // Cria arquivo para associar chunks
    await db.exec(`
      INSERT INTO public.acervo_arquivos (
        id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular,
        file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo
      ) VALUES (
        '${ARQUIVO_1_ID}', '${DISCIPLINA_BIOLOGIA}', 'citologia_bio.pdf', 'apostila', 1, 'ENEM',
        'acervo/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.pdf',
        'application/pdf', 1024, 1, '${RESPONSAVEL_1.id}', 'concluido',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      ) ON CONFLICT (id) DO NOTHING;
    `);

    // 3.1 Vetor com exatamente 1536 dimensões é aceito perfeitamente
    const validVector = generateNormalizedVector(1, 1536);
    await db.exec(`
      INSERT INTO public.acervo_chunks (
        id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo, embedding
      ) VALUES (
        '70000000-0000-4000-8000-000000000001', '${ARQUIVO_1_ID}', 1, 1, 1,
        'A membrana plasmática é composta por bicamada fosfolipídica.',
        'exposicao_teorica', '${validVector}'::vector(1536)
      );
    `);

    const chunkStored = await db.query(
      "SELECT id, texto FROM public.acervo_chunks WHERE id = '70000000-0000-4000-8000-000000000001';"
    );
    expect(chunkStored.rows.length).toBe(1);

    // 3.2 Vetor com dimensão incompatível (ex: 768) é rejeitado pelo PostgreSQL
    const invalidVector768 = generateNormalizedVector(2, 768);
    await expect(
      db.exec(`
        INSERT INTO public.acervo_chunks (
          id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo, embedding
        ) VALUES (
          '70000000-0000-4000-8000-000000000002', '${ARQUIVO_1_ID}', 2, 2, 2,
          'Texto com vetor incompatível.',
          'exposicao_teorica', '${invalidVector768}'::vector(768)
        );
      `)
    ).rejects.toThrow();
  });

  it('4. Teste de Busca Híbrida Real: Pontuação Vetorial + Textual e Tratamento de Vazio', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To8Applied();
    await executeStagingMigrations({ sql, untilStep: 9, logger: () => {} });

    // Insere arquivo concluído com chunks e embeddings
    await db.exec(`
      INSERT INTO public.acervo_arquivos (
        id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular,
        file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo
      ) VALUES (
        '${ARQUIVO_1_ID}', '${DISCIPLINA_BIOLOGIA}', 'citologia_bio.pdf', 'apostila', 1, 'ENEM',
        'acervo/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.pdf',
        'application/pdf', 2048, 2, '${RESPONSAVEL_1.id}', 'concluido',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      ) ON CONFLICT (id) DO NOTHING;
    `);

    const vectorChunk1 = generateNormalizedVector(10, 1536);
    const vectorChunk2 = generateNormalizedVector(50, 1536);

    await db.exec(`
      INSERT INTO public.acervo_chunks (
        id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo, embedding
      ) VALUES
        (
          '70000000-0000-4000-8000-000000000010', '${ARQUIVO_1_ID}', 1, 1, 1,
          'A membrana plasmática possui permeabilidade seletiva e mosaico fluido.',
          'exposicao_teorica', '${vectorChunk1}'::vector(1536)
        ),
        (
          '70000000-0000-4000-8000-000000000020', '${ARQUIVO_1_ID}', 2, 2, 2,
          'Mitocôndrias realizam a respiração celular e produção de ATP.',
          'exposicao_teorica', '${vectorChunk2}'::vector(1536)
        )
      ON CONFLICT DO NOTHING;
    `);

    // 4.1 Busca semântica próxima do chunk 1 sob transação autenticada com contexto RLS
    const queryVector = vectorChunk1;
    const searchRes = await queryWithContext(
      db,
      RESPONSAVEL_1.id,
      'responsavel',
      `
        SELECT chunk_id, texto, score_vetorial, score_textual, similaridade
        FROM medicina.fn_busca_hibrida_acervo(
          p_query := 'membrana plasmática permeabilidade',
          p_query_vector := '${queryVector}'::vector(1536),
          p_disciplina_id := NULL,
          p_limit := 5,
          p_min_similaridade := 0.2,
          p_papel := 'responsavel',
          p_perfil_id := '${RESPONSAVEL_1.id}'
        );
      `
    );

    expect(searchRes.length).toBeGreaterThan(0);
    const topResult = searchRes[0];
    expect(topResult.chunk_id).toBe('70000000-0000-4000-8000-000000000010');
    expect(Number(topResult.score_vetorial)).toBeGreaterThan(0.9); // Quase 1.0 (vetor idêntico)
    expect(Number(topResult.score_textual)).toBeGreaterThan(0); // FTS deu match em 'membrana plasmática'
    expect(Number(topResult.similaridade)).toBeGreaterThan(0.8);

    // 4.2 Tratamento de busca vazia ou parâmetros nulos (retorna 0 linhas, zero erros)
    const emptyRes = await queryWithContext(
      db,
      RESPONSAVEL_1.id,
      'responsavel',
      `
        SELECT * FROM medicina.fn_busca_hibrida_acervo(
          p_query := '',
          p_query_vector := NULL,
          p_papel := 'responsavel',
          p_perfil_id := '${RESPONSAVEL_1.id}'
        );
      `
    );
    expect(emptyRes.length).toBe(0);
  });

  it('5. Teste de RLS e Isolamento Multi-Tenant: Responsável vs Estudante vs Outro Responsável', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To8Applied();
    await executeStagingMigrations({ sql, untilStep: 9, logger: () => {} });

    // Arquivo 1 enviado pelo Responsável 1
    await db.exec(`
      INSERT INTO public.acervo_arquivos (
        id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular,
        file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo
      ) VALUES (
        '${ARQUIVO_1_ID}', '${DISCIPLINA_BIOLOGIA}', 'acervo_resp1.pdf', 'apostila', 1, 'ENEM',
        'acervo/1111111111111111111111111111111111111111111111111111111111111111.pdf',
        'application/pdf', 1024, 1, '${RESPONSAVEL_1.id}', 'concluido',
        '1111111111111111111111111111111111111111111111111111111111111111'
      ) ON CONFLICT (id) DO NOTHING;
    `);

    // Arquivo 2 enviado pelo Responsável 2
    await db.exec(`
      INSERT INTO public.acervo_arquivos (
        id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular,
        file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo
      ) VALUES (
        '${ARQUIVO_2_ID}', '${DISCIPLINA_BIOLOGIA}', 'acervo_resp2.pdf', 'apostila', 1, 'ENEM',
        'acervo/2222222222222222222222222222222222222222222222222222222222222222.pdf',
        'application/pdf', 1024, 1, '${RESPONSAVEL_2.id}', 'concluido',
        '2222222222222222222222222222222222222222222222222222222222222222'
      ) ON CONFLICT (id) DO NOTHING;
    `);

    const vectorR1 = generateNormalizedVector(101, 1536);
    const vectorR2 = generateNormalizedVector(202, 1536);

    await db.exec(`
      INSERT INTO public.acervo_chunks (
        id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo, embedding
      ) VALUES
        ('70000000-0000-4000-8000-000000000101', '${ARQUIVO_1_ID}', 1, 1, 1, 'Conteúdo exclusivo do Responsável 1.', 'exposicao_teorica', '${vectorR1}'::vector(1536)),
        ('70000000-0000-4000-8000-000000000202', '${ARQUIVO_2_ID}', 1, 1, 1, 'Conteúdo exclusivo do Responsável 2.', 'exposicao_teorica', '${vectorR2}'::vector(1536))
      ON CONFLICT DO NOTHING;
    `);

    // 5.1 Responsável 1 pesquisa sob contexto legítimo: encontra chunk do Arquivo 1, NUNCA o Arquivo 2
    const searchResp1 = await queryWithContext(
      db,
      RESPONSAVEL_1.id,
      'responsavel',
      `
        SELECT chunk_id, arquivo_id
        FROM medicina.fn_busca_hibrida_acervo(
          p_query := 'Conteúdo exclusivo',
          p_query_vector := '${vectorR1}'::vector(1536),
          p_papel := 'responsavel',
          p_perfil_id := '${RESPONSAVEL_1.id}'
        );
      `
    );
    expect(searchResp1.length).toBe(1);
    expect(searchResp1[0].arquivo_id).toBe(ARQUIVO_1_ID);

    // 5.2 Responsável 2 pesquisa sob contexto legítimo com o mesmo vetor: encontra APENAS o Arquivo 2
    const searchResp2 = await queryWithContext(
      db,
      RESPONSAVEL_2.id,
      'responsavel',
      `
        SELECT chunk_id, arquivo_id
        FROM medicina.fn_busca_hibrida_acervo(
          p_query := 'Conteúdo exclusivo',
          p_query_vector := '${vectorR2}'::vector(1536),
          p_papel := 'responsavel',
          p_perfil_id := '${RESPONSAVEL_2.id}'
        );
      `
    );
    expect(searchResp2.length).toBe(1);
    expect(searchResp2[0].arquivo_id).toBe(ARQUIVO_2_ID);

    // 5.3 Estudante 1 (vinculada ao Responsável 1) pesquisa sob seu contexto: encontra chunks do Responsável 1
    const searchEst1 = await queryWithContext(
      db,
      ESTUDANTE_1.id,
      'estudante',
      `
        SELECT chunk_id, arquivo_id
        FROM medicina.fn_busca_hibrida_acervo(
          p_query := 'Conteúdo exclusivo',
          p_query_vector := '${vectorR1}'::vector(1536),
          p_papel := 'estudante',
          p_perfil_id := '${ESTUDANTE_1.id}'
        );
      `
    );
    expect(searchEst1.length).toBe(1);
    expect(searchEst1[0].arquivo_id).toBe(ARQUIVO_1_ID);

    // 5.4 Estudante 2 (vinculada ao Responsável 2) tenta buscar chunks do Responsável 1: retorna ZERO registros!
    const searchEst2OnR1 = await queryWithContext(
      db,
      ESTUDANTE_2.id,
      'estudante',
      `
        SELECT chunk_id, arquivo_id
        FROM medicina.fn_busca_hibrida_acervo(
          p_query := 'Conteúdo exclusivo do Responsável 1',
          p_query_vector := '${vectorR1}'::vector(1536),
          p_papel := 'estudante',
          p_perfil_id := '${ESTUDANTE_2.id}'
        );
      `
    );
    expect(searchEst2OnR1.length).toBe(0); // Isolamento multi-tenant garantido!
  });

  it('6. Testes Negativos Obrigatórios de Segurança (H1.09-R: Fail-Closed, Spoofing e SECURITY DEFINER)', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To8Applied();
    await executeStagingMigrations({ sql, untilStep: 9, logger: () => {} });

    // Insere documento de teste de Responsável 1 com hash válido de 64 caracteres hexadecimais
    const validHexHash = '7777777777777777777777777777777777777777777777777777777777777777';
    await db.exec(`
      INSERT INTO public.acervo_arquivos (
        id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular,
        file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo
      ) VALUES (
        '${ARQUIVO_1_ID}', '${DISCIPLINA_BIOLOGIA}', 'segredo_resp1.pdf', 'apostila', 1, 'ENEM',
        'acervo/${validHexHash}.pdf', 'application/pdf', 1024, 1, '${RESPONSAVEL_1.id}', 'concluido', '${validHexHash}'
      ) ON CONFLICT (id) DO NOTHING;
    `);

    const vectorSecret = generateNormalizedVector(777, 1536);
    await db.exec(`
      INSERT INTO public.acervo_chunks (
        id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo, embedding
      ) VALUES (
        '70000000-0000-4000-8000-000000000777', '${ARQUIVO_1_ID}', 1, 1, 1,
        'Dado ultrassecreto do Responsável 1.', 'exposicao_teorica', '${vectorSecret}'::vector(1536)
      ) ON CONFLICT DO NOTHING;
    `);

    // 6.1 NEGATIVO 1: Contexto de autenticação NÃO definido (current_setting vazio)
    // Mesmo informando os parâmetros p_perfil_id e p_papel de Responsável 1, a função opera fail-closed e retorna 0 linhas
    const resNoContext = await db.query(`
      SELECT chunk_id, texto
      FROM medicina.fn_busca_hibrida_acervo(
        p_query := 'ultrassecreto',
        p_query_vector := '${vectorSecret}'::vector(1536),
        p_papel := 'responsavel',
        p_perfil_id := '${RESPONSAVEL_1.id}'
      );
    `);
    expect(resNoContext.rows.length).toBe(0);

    // 6.2 NEGATIVO 2: Contexto legítimo de Responsável 2 tentando forjar p_perfil_id de Responsável 1
    // Deve lançar erro explícito 42501 (Conflito de identidade RLS na busca do acervo)
    await expect(
      queryWithContext(
        db,
        RESPONSAVEL_2.id,
        'responsavel',
        `
          SELECT chunk_id, texto
          FROM medicina.fn_busca_hibrida_acervo(
            p_query := 'ultrassecreto',
            p_query_vector := '${vectorSecret}'::vector(1536),
            p_papel := 'responsavel',
            p_perfil_id := '${RESPONSAVEL_1.id}'
          );
        `
      )
    ).rejects.toThrow(/Conflito de identidade RLS na busca do acervo/);

    // 6.3 NEGATIVO 3: Contexto legítimo de Responsável 2 tentando forjar p_papel = 'estudante'
    // Deve lançar erro explícito 42501 (Conflito de papel RLS na busca do acervo)
    await expect(
      queryWithContext(
        db,
        RESPONSAVEL_2.id,
        'responsavel',
        `
          SELECT chunk_id, texto
          FROM medicina.fn_busca_hibrida_acervo(
            p_query := 'ultrassecreto',
            p_query_vector := '${vectorSecret}'::vector(1536),
            p_papel := 'estudante',
            p_perfil_id := '${RESPONSAVEL_2.id}'
          );
        `
      )
    ).rejects.toThrow(/Conflito de papel RLS na busca do acervo/);

    // 6.4 NEGATIVO 4: Limpeza de contexto (clear_context) seguida de tentativa de consulta
    await db.exec('SELECT medicina.clear_context();');
    const resAfterClear = await db.query(`
      SELECT chunk_id
      FROM medicina.fn_busca_hibrida_acervo(
        p_query := 'ultrassecreto',
        p_query_vector := '${vectorSecret}'::vector(1536),
        p_papel := 'responsavel',
        p_perfil_id := '${RESPONSAVEL_1.id}'
      );
    `);
    expect(resAfterClear.rows.length).toBe(0);

    // 6.5 NEGATIVO 5: Estudante 2 tentando buscar conteúdo do Responsável 1 sob seu contexto
    const resCrossStudent = await queryWithContext(
      db,
      ESTUDANTE_2.id,
      'estudante',
      `
        SELECT chunk_id
        FROM medicina.fn_busca_hibrida_acervo(
          p_query := 'ultrassecreto',
          p_query_vector := '${vectorSecret}'::vector(1536),
          p_papel := 'estudante',
          p_perfil_id := '${ESTUDANTE_2.id}'
        );
      `
    );
    expect(resCrossStudent.length).toBe(0);

    // 6.6 POSITIVO: Responsável 1 com seu contexto legítimo recupera com sucesso
    const resLegitResp1 = await queryWithContext(
      db,
      RESPONSAVEL_1.id,
      'responsavel',
      `
        SELECT chunk_id, texto
        FROM medicina.fn_busca_hibrida_acervo(
          p_query := 'ultrassecreto',
          p_query_vector := '${vectorSecret}'::vector(1536),
          p_papel := 'responsavel',
          p_perfil_id := '${RESPONSAVEL_1.id}'
        );
      `
    );
    expect(resLegitResp1.length).toBe(1);
    expect(resLegitResp1[0].chunk_id).toBe('70000000-0000-4000-8000-000000000777');
  });

  it('7. Teste de Rollback (F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql) e Reversibilidade Simétrica', async () => {
    const { db, sql } = await createSimulatedDbWithSteps1To8Applied();
    await executeStagingMigrations({ sql, untilStep: 9, logger: () => {} });

    // Confere que função e índices existem antes do rollback
    const preProc = await db.query("SELECT 1 FROM pg_proc WHERE proname = 'fn_busca_hibrida_acervo';");
    expect(preProc.rows.length).toBe(1);

    // Aplica o script de rollback
    const rollbackSql = readFileSync(
      path.resolve(process.cwd(), 'docs/modernizacao/propostas/F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql'),
      'utf8'
    );
    await db.exec(stripOuterTransaction(rollbackSql));

    // 1. Confirma que a função foi removida
    const postProc = await db.query("SELECT 1 FROM pg_proc WHERE proname = 'fn_busca_hibrida_acervo';");
    expect(postProc.rows.length).toBe(0);

    // 2. Confirma que os índices foram removidos
    const postHnsw = await db.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = 'acervo_chunks_embedding_hnsw_idx';"
    );
    expect(postHnsw.rows.length).toBe(0);

    const postFts = await db.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = 'acervo_chunks_texto_fts_idx';"
    );
    expect(postFts.rows.length).toBe(0);

    // 3. Remove registro do histórico e re-executa a migração 9 para demonstrar reversibilidade simétrica
    await db.exec('DELETE FROM public._medicina_staging_migrations WHERE ordem = 9;');

    const reResult = await executeStagingMigrations({ sql, untilStep: 9, logger: () => {} });
    expect(reResult.appliedCount).toBe(1);
    expect(reResult.skippedCount).toBe(8);

    // Confirma que os objetos de F1.12 foram recriados perfeitamente
    const finalProc = await db.query("SELECT 1 FROM pg_proc WHERE proname = 'fn_busca_hibrida_acervo';");
    expect(finalProc.rows.length).toBe(1);

    const finalHistory = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(finalHistory.rows[0].cnt).toBe(9);
  });
});
