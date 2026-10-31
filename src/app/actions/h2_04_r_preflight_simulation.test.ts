/**
 * ==============================================================================
 * MEDICINA 2029 — H2.04-R: SIMULAÇÃO DE PREFLIGHT DA HOMOLOGAÇÃO FUNCIONAL
 * ==============================================================================
 * Testes Automatizados em PostgreSQL Descartável (PGlite com pgvector):
 * 1. Provisionamento inicial com as 3 personas sintéticas (Alice, Bruno, Carlos)
 * 2. Repetição do provisionamento (Idempotência absoluta e zero colisão)
 * 3. Falha parcial simulada e reversão atômica (Rollback sem deixar registros órfãos)
 * 4. Geração de registros operacionais (sessões, tentativas, erros, idempotência, figuras)
 * 5. Limpeza completa (Cleanup com expurgo de metadados e acionamento de Storage)
 * 6. Comprovação de retorno estrito ao estado baseline inicial (Zero resíduo, allowlist e migrações preservadas)
 * ==============================================================================
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  PERSONA_ALICE,
  PERSONA_BRUNO,
  PERSONA_CARLOS,
  STAGING_ALICE_CICLO_ID,
  STAGING_CARLOS_CICLO_ID,
  provisionHomologationData,
  cleanupHomologationData,
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

describe.skipIf(!HAS_PGLITE)('MEDICINA 2029 — H2.04-R: Simulação de Preflight em PostgreSQL Descartável', () => {
  let pg: PGliteInstance;
  let sqlAdapter: any;

  const projectRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../');
  const readSql = (relPath: string) =>
    readFileSync(path.join(projectRoot, relPath), 'utf8').replaceAll(
      '--> statement-breakpoint',
      '\n'
    );

  const createSqlAdapter = (db: PGliteInstance) => {
    const executeQuery = async (strings: TemplateStringsArray, values: unknown[]) => {
      let query = strings[0];
      const params: any[] = [];
      let paramIdx = 1;
      for (let i = 0; i < values.length; i++) {
        let val: any = values[i];
        if (val && typeof val.then === 'function') {
          val = await val;
        }
        if (val && typeof val === 'object' && val.isSqlFragment) {
          query += val.text + strings[i + 1];
        } else {
          params.push(val);
          query += `$${paramIdx++}` + strings[i + 1];
        }
      }
      const res = await db.query(query, params);
      return res.rows;
    };

    const adapter: any = (strings: TemplateStringsArray | any[], ...values: any[]) => {
      // Suporte a fragmentos como ${sql(array)} retornado sincronamente
      if (!strings || !('raw' in strings)) {
        const arr = Array.isArray(strings) ? strings : [strings];
        return {
          isSqlFragment: true,
          text: `(${arr.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ')})`,
        };
      }
      return executeQuery(strings as TemplateStringsArray, values);
    };

    adapter.begin = async (fn: (tx: any) => Promise<any>) => {
      await db.exec('BEGIN;');
      try {
        const res = await fn(adapter);
        await db.exec('COMMIT;');
        return res;
      } catch (err) {
        await db.exec('ROLLBACK;');
        throw err;
      }
    };

    return adapter;
  };

  beforeAll(async () => {
    const { PGlite } = await import(pathToFileURL(PGLITE_INDEX).href);
    const { vector } = await import(pathToFileURL(PGLITE_VECTOR).href);
    pg = await PGlite.create({ extensions: { vector } });
    sqlAdapter = createSqlAdapter(pg);

    // 1. Catálogo Storage simulado e tabela de migrações
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
      VALUES ('acervo', 'acervo', false, 20971520, ARRAY['application/pdf']::text[])
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS public._medicina_staging_migrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ordem integer NOT NULL UNIQUE,
        rel_path text NOT NULL UNIQUE,
        sha256 text NOT NULL,
        aplicado_em timestamptz DEFAULT now() NOT NULL,
        executado_por text NOT NULL,
        tamanho_bytes integer NOT NULL
      );
    `);

    // 2. Aplicação das 9 migrações estruturais canônicas (exatamente como em Staging)
    await pg.exec(readSql('drizzle/0000_greedy_loki.sql'));
    await pg.exec(readSql('drizzle/0001_dry_talos.sql'));
    await pg.exec(readSql('drizzle/0002_little_swarm.sql'));
    await pg.exec(readSql('drizzle/0003_f1_03_r_expansao.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'));

    // Registra as 9 migrações no histórico baseline
    for (let i = 1; i <= 9; i++) {
      await pg.exec(`
        INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
        VALUES (${i}, 'migracao_etapa_${i}.sql', repeat('${i}', 64), 'postgres.ynfocaorhadizlvbnzrt', 1024)
        ON CONFLICT (ordem) DO NOTHING;
      `);
    }
  });

  afterAll(async () => {
    if (pg) {
      await pg.close();
    }
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 1: PROVISIONAMENTO INICIAL
  // ----------------------------------------------------------------------------
  it('1. Provisionamento inicial insere 3 personas, allowlist, ciclos, cards e acervo', async () => {
    const logs: string[] = [];
    const result = await provisionHomologationData({
      sql: sqlAdapter,
      student1Password: 'senha_alice_sintetica_1',
      responsiblePassword: 'senha_bruno_sintetico_1',
      student2Password: 'senha_carlos_sintetico_1',
      logger: (msg: string) => logs.push(msg),
    });

    expect(result.success).toBe(true);
    expect(result.perfis).toBe(3);
    expect(result.ciclos).toBe(2);
    expect(result.blocos).toBe(56);
    expect(result.cards).toBe(5);
    expect(result.arquivos).toBe(1);

    // Valida no banco as 3 personas
    const perfisRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.perfis WHERE id IN ('${PERSONA_ALICE.id}', '${PERSONA_BRUNO.id}', '${PERSONA_CARLOS.id}');`
    );
    expect(Number(perfisRes.rows[0].count)).toBe(3);

    // Valida allowlist: deve conter os 2 e-mails originais + os 3 sintéticos (total = 5)
    const allowRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.allowlist WHERE email IN ('${PERSONA_ALICE.email}', '${PERSONA_BRUNO.email}', '${PERSONA_CARLOS.email}');`
    );
    expect(Number(allowRes.rows[0].count)).toBe(3);

    const allowTotal = await pg.query<{ count: string }>('SELECT count(*) as count FROM public.allowlist;');
    expect(Number(allowTotal.rows[0].count)).toBe(5);

    // Valida vínculo tutelar
    const vinculoRes = await pg.query<{ responsavel_perfil_id: string; estudante_perfil_id: string }>(
      'SELECT responsavel_perfil_id, estudante_perfil_id FROM public.responsavel_estudante WHERE vinculo_id = 1;'
    );
    expect(vinculoRes.rows[0].responsavel_perfil_id).toBe(PERSONA_BRUNO.id);
    expect(vinculoRes.rows[0].estudante_perfil_id).toBe(PERSONA_ALICE.id);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 2: REPETIÇÃO (IDEMPOTÊNCIA ABSOLUTA)
  // ----------------------------------------------------------------------------
  it('2. Repetição da provisão executa sem erro e mantém contagens rigorosamente íntegras', async () => {
    const logs: string[] = [];
    // Executa a segunda vez exatamente igual
    const result2 = await provisionHomologationData({
      sql: sqlAdapter,
      student1Password: 'senha_alice_sintetica_2',
      responsiblePassword: 'senha_bruno_sintetico_2',
      student2Password: 'senha_carlos_sintetico_2',
      logger: (msg: string) => logs.push(msg),
    });

    expect(result2.success).toBe(true);

    // Confirma que perfis continuam sendo exatamente 3 (sem duplicidade)
    const perfisCount = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.perfis WHERE id IN ('${PERSONA_ALICE.id}', '${PERSONA_BRUNO.id}', '${PERSONA_CARLOS.id}');`
    );
    expect(Number(perfisCount.rows[0].count)).toBe(3);

    // Confirma que ciclos continuam sendo exatamente 2
    const ciclosCount = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.ciclos WHERE id IN ('${STAGING_ALICE_CICLO_ID}', '${STAGING_CARLOS_CICLO_ID}');`
    );
    expect(Number(ciclosCount.rows[0].count)).toBe(2);

    // Confirma que blocos continuam 56 (28 Alice + 28 Carlos)
    const blocosCount = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.ciclo_blocos WHERE ciclo_id IN ('${STAGING_ALICE_CICLO_ID}', '${STAGING_CARLOS_CICLO_ID}');`
    );
    expect(Number(blocosCount.rows[0].count)).toBe(56);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 3: FALHA PARCIAL SIMULADA E ROLLBACK ATÔMICO
  // ----------------------------------------------------------------------------
  it('3. Falha no meio da transação reverte todas as mutações via ROLLBACK atômico', async () => {
    // Captura estado antes da tentativa de falha
    const perfisAntes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.perfis WHERE id = '99999999-9999-4000-8000-000000000099';`
    );
    expect(Number(perfisAntes.rows[0].count)).toBe(0);

    let falhaCapturada = false;
    try {
      await sqlAdapter.begin(async (tx: any) => {
        // Passo 1: Insere perfil temporário
        await tx`
          INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
          VALUES ('99999999-9999-4000-8000-000000000099'::uuid, '99999999-9999-4000-8000-000000000099'::uuid, 'Fantasma', 'fantasma@staging.test', 'hash', 'estudante');
        `;

        // Passo 2: Força erro fatal de violação de constraint (ordem nula ou chave estrangeira inexistente)
        await tx`
          INSERT INTO public.ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana)
          VALUES ('88888888-8888-4000-8000-000000000088'::uuid, '00000000-0000-4000-8000-000000000000'::uuid, 'Ciclo Invalido', 2027, true, 28);
        `;
      });
    } catch (err: any) {
      falhaCapturada = true;
      expect(err.message).toMatch(/violat|foreign key|constraint/i);
    }

    expect(falhaCapturada).toBe(true);

    // Comprova que o ROLLBACK reverteu o Passo 1: 'Fantasma' não existe no banco
    const perfisDepois = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.perfis WHERE id = '99999999-9999-4000-8000-000000000099';`
    );
    expect(Number(perfisDepois.rows[0].count)).toBe(0);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 4: SIMULAÇÃO DE CARGA OPERACIONAL (ENTIDADES FILHAS VINCULADAS)
  // ----------------------------------------------------------------------------
  it('4. Simula geração operacional de entidades filhas (sessões, tentativas, erros, idempotência e figuras)', async () => {
    // 4.0 Questão didática pré-existente
    await pg.exec(`
      INSERT INTO public.questoes (id, disciplina_id, procedencia, fonte, estilo, enunciado, alternativas, gabarito)
      VALUES (
        '70000000-0000-4000-8000-000000000001',
        'd0000000-0000-4000-8000-000000000002',
        'oficial',
        'ENEM',
        'enem',
        'Enunciado de biologia citologia',
        '{"A": "Opcao A", "B": "Opcao B"}'::jsonb,
        'A'
      )
      ON CONFLICT (id) DO NOTHING;
    `);

    // 4.1 Sessão de estudo para Alice
    const sessaoId = '51000000-0000-4000-8000-000000000001';
    await pg.exec(`
      INSERT INTO public.sessoes (id, perfil_id, ciclo_bloco_id, topico_id, etapa_atingida, iniciada_em, concluida)
      VALUES ('${sessaoId}', '${PERSONA_ALICE.id}', '41000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000003', 'registro', now(), true)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 4.2 Tentativa de questão vinculada à sessão e ao perfil de Alice (confiança válida: 'certeza')
    const tentativaId = '61000000-0000-4000-8000-000000000001';
    await pg.exec(`
      INSERT INTO public.tentativas (id, perfil_id, questao_id, sessao_id, alternativa_marcada, correta, segundos, confianca)
      VALUES ('${tentativaId}', '${PERSONA_ALICE.id}', '70000000-0000-4000-8000-000000000001', '${sessaoId}', 'A', false, 45, 'certeza')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 4.3 Erro pedagógico registrado a partir da tentativa
    await pg.exec(`
      INSERT INTO public.erros (id, perfil_id, questao_id, tentativa_id, disciplina_id, topico_id, estilo, tipo_erro, descricao_livre)
      VALUES (
        '81000000-0000-4000-8000-000000000001',
        '${PERSONA_ALICE.id}',
        '70000000-0000-4000-8000-000000000001',
        '${tentativaId}',
        'd0000000-0000-4000-8000-000000000002',
        'e0000000-0000-4000-8000-000000000003',
        'enem',
        'interpretacao',
        'Erro de leitura sintética'
      )
      ON CONFLICT (id) DO NOTHING;
    `);

    // 4.4 Operação idempotente no ledger persistido
    await pg.exec(`
      INSERT INTO public.operacoes_idempotentes (id, perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
      VALUES ('91000000-0000-4000-8000-000000000001', '${PERSONA_ALICE.id}', 'sessao.iniciar', 'idem_key_alice_001', repeat('a', 64), '{"ok": true}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 4.5 Figura extraída de arquivo didático de Bruno
    await pg.exec(`
      INSERT INTO public.acervo_figuras (id, arquivo_id, pagina, bbox, imagem_path, legenda)
      VALUES ('f4000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 1, '{"x": 10, "y": 20}'::jsonb, 'acervo/fig_citologia.png', 'Esquema de mitocôndria')
      ON CONFLICT (id) DO NOTHING;
    `);

    const sessoesRes = await pg.query<{ count: string }>(`SELECT count(*) as count FROM public.sessoes WHERE perfil_id = '${PERSONA_ALICE.id}';`);
    const tentativasRes = await pg.query<{ count: string }>(`SELECT count(*) as count FROM public.tentativas WHERE perfil_id = '${PERSONA_ALICE.id}';`);
    const errosRes = await pg.query<{ count: string }>(`SELECT count(*) as count FROM public.erros WHERE perfil_id = '${PERSONA_ALICE.id}';`);
    const idemRes = await pg.query<{ count: string }>(`SELECT count(*) as count FROM public.operacoes_idempotentes WHERE perfil_id = '${PERSONA_ALICE.id}';`);
    const figRes = await pg.query<{ count: string }>(`SELECT count(*) as count FROM public.acervo_figuras WHERE id = 'f4000000-0000-4000-8000-000000000001';`);

    expect(Number(sessoesRes.rows[0].count)).toBe(1);
    expect(Number(tentativasRes.rows[0].count)).toBe(1);
    expect(Number(errosRes.rows[0].count)).toBe(1);
    expect(Number(idemRes.rows[0].count)).toBe(1);
    expect(Number(figRes.rows[0].count)).toBe(1);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 5: LIMPEZA COMPLETA (CLEANUP TEARDOWN)
  // ----------------------------------------------------------------------------
  it('5. Procedimento de limpeza completa expurga 100% dos dados sintéticos respeitando foreign keys e bloqueia operações físicas de storage', async () => {
    const deletedStoragePaths: string[][] = [];
    const mockStorageClient = {
      storage: {
        from: (bucket: string) => ({
          remove: async (paths: string[]) => {
            deletedStoragePaths.push(paths);
            return { error: null };
          },
        }),
      },
    };

    const cleanupLogs: string[] = [];
    const cleanupResult = await cleanupHomologationData({
      sql: sqlAdapter,
      storageClient: mockStorageClient,
      logger: (msg: string) => cleanupLogs.push(msg),
    });

    expect(cleanupResult.success).toBe(true);
    expect(cleanupResult.cleanedPerfis).toBe(3);
    expect(cleanupResult.cleanedEmails).toBe(3);

    // Valida que operações físicas de Storage foram bloqueadas/desabilitadas na H2.04-R2 (100% transacional no Postgres)
    expect(deletedStoragePaths.length).toBe(0);
    expect(cleanupLogs.some((l) => l.includes('Storage') && l.includes('desabilitada'))).toBe(true);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 6: VERIFICAÇÃO DE RETORNO ESTREITO AO ESTADO BASELINE INICIAL
  // ----------------------------------------------------------------------------
  it('6. Comprova retorno estrito ao estado inicial: Zero resíduo sintético e baseline 100% preservado', async () => {
    const syntheticPerfis = [PERSONA_ALICE.id, PERSONA_BRUNO.id, PERSONA_CARLOS.id];
    const syntheticEmails = [PERSONA_ALICE.email, PERSONA_BRUNO.email, PERSONA_CARLOS.email];

    // 6.1 Contagem de perfis sintéticos = 0
    const perfisRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.perfis WHERE id IN ('${syntheticPerfis.join("','")}');`
    );
    expect(Number(perfisRes.rows[0].count)).toBe(0);

    // 6.2 Contagem de e-mails sintéticos na allowlist = 0
    const allowRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.allowlist WHERE email IN ('${syntheticEmails.join("','")}');`
    );
    expect(Number(allowRes.rows[0].count)).toBe(0);

    // 6.3 Allowlist original intacta (e-mails do baseline 0000_greedy_loki.sql preservados)
    const originalAllowRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.allowlist WHERE email IN ('estudante@medicina2029.com.br', 'responsavel@medicina2029.com.br');`
    );
    expect(Number(originalAllowRes.rows[0].count)).toBe(2);

    // 6.4 Contagem de ciclos de Alice e Carlos = 0
    const ciclosRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.ciclos WHERE estudante_perfil_id IN ('${syntheticPerfis.join("','")}');`
    );
    expect(Number(ciclosRes.rows[0].count)).toBe(0);

    // 6.5 Contagem de cards de Alice e Carlos = 0
    const cardsRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.cards WHERE perfil_id IN ('${syntheticPerfis.join("','")}');`
    );
    expect(Number(cardsRes.rows[0].count)).toBe(0);

    // 6.6 Contagem de arquivos e jobs do acervo sintético = 0
    const arquivosRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.acervo_arquivos WHERE enviado_por IN ('${syntheticPerfis.join("','")}');`
    );
    expect(Number(arquivosRes.rows[0].count)).toBe(0);

    const jobsRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.acervo_jobs WHERE enviado_por IN ('${syntheticPerfis.join("','")}');`
    );
    expect(Number(jobsRes.rows[0].count)).toBe(0);

    // 6.7 Entidades filhas operacionais = 0
    const sessoesRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.sessoes WHERE perfil_id IN ('${syntheticPerfis.join("','")}');`
    );
    expect(Number(sessoesRes.rows[0].count)).toBe(0);

    const tentativasRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.tentativas WHERE perfil_id IN ('${syntheticPerfis.join("','")}');`
    );
    expect(Number(tentativasRes.rows[0].count)).toBe(0);

    const errosRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.erros WHERE perfil_id IN ('${syntheticPerfis.join("','")}');`
    );
    expect(Number(errosRes.rows[0].count)).toBe(0);

    const idemRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.operacoes_idempotentes WHERE perfil_id IN ('${syntheticPerfis.join("','")}');`
    );
    expect(Number(idemRes.rows[0].count)).toBe(0);

    const vinculosRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.responsavel_estudante WHERE responsavel_perfil_id IN ('${syntheticPerfis.join("','")}') OR estudante_perfil_id IN ('${syntheticPerfis.join("','")}');`
    );
    expect(Number(vinculosRes.rows[0].count)).toBe(0);

    // 6.8 Tabela de migrações canônicas intacta com as 9 migrações registradas
    const migCount = await pg.query<{ count: string }>(
      'SELECT count(*) as count FROM public._medicina_staging_migrations;'
    );
    expect(Number(migCount.rows[0].count)).toBe(9);

    // 6.9 Catálogo pedagógico (disciplinas e tópicos) preservado
    const discCount = await pg.query<{ count: string }>('SELECT count(*) as count FROM public.disciplinas;');
    expect(Number(discCount.rows[0].count)).toBeGreaterThanOrEqual(5);

    const topCount = await pg.query<{ count: string }>('SELECT count(*) as count FROM public.topicos;');
    expect(Number(topCount.rows[0].count)).toBeGreaterThanOrEqual(10);
  });
});
