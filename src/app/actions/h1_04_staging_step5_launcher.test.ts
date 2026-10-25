import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import {
  executeControlledStep5Migration,
  TARGET_PROJECT_REF,
  TARGET_HOST,
  TARGET_PORT,
  TARGET_USERNAME,
  TARGET_STEP,
  TARGET_SCRIPT_NAME,
} from '../../../scripts/db/apply-staging-step5.mjs';

import { stripOuterTransaction } from '../../../scripts/db/migrate-staging.mjs';

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

async function createSupabaseSimulatedDbWithSteps1To4Applied(): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
  const db = new PGlite({
    extensions: { vector },
  });

  // Configuração inicial simulando Supabase gerenciado
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;
  `);

  // 1. Aplica tabela de histórico de migrações
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

  // 2. Aplica DDL da migração 0000
  const sql0Path = path.resolve(process.cwd(), 'drizzle/0000_greedy_loki.sql');
  const cleanSql0 = stripOuterTransaction(readFileSync(sql0Path, 'utf8'));
  await db.exec(cleanSql0);

  // 3. Registra migração 0000 no histórico
  await db.exec(`
    INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
    VALUES (
      1,
      'drizzle/0000_greedy_loki.sql',
      'b1cf8d6741894a52543ca0edf7212dee9ee8945051cd01148ea60a3cbaf4b4c6',
      'postgres',
      24043
    );
  `);

  // 4. Aplica DDL da migração 0001
  const sql1Path = path.resolve(process.cwd(), 'drizzle/0001_dry_talos.sql');
  const cleanSql1 = stripOuterTransaction(readFileSync(sql1Path, 'utf8'));
  await db.exec(cleanSql1);

  // 5. Registra migração 0001 no histórico
  await db.exec(`
    INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
    VALUES (
      2,
      'drizzle/0001_dry_talos.sql',
      '8e82452e0071ee1ce5a1e38569ef8f69a0851ae3d8e229ebfd1b4969e3db9180',
      'postgres',
      238
    );
  `);

  // 6. Aplica DDL da migração 0002
  const sql2Path = path.resolve(process.cwd(), 'drizzle/0002_little_swarm.sql');
  const cleanSql2 = stripOuterTransaction(readFileSync(sql2Path, 'utf8'));
  await db.exec(cleanSql2);

  // 7. Registra migração 0002 no histórico
  await db.exec(`
    INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
    VALUES (
      3,
      'drizzle/0002_little_swarm.sql',
      'c3ce3d3b1335bedb2deb46e2c14c018fe15370b60e7fdc415def17cb9de0343b',
      'postgres',
      66
    );
  `);

  // 8. Aplica DDL da migração 0003
  const sql3Path = path.resolve(process.cwd(), 'drizzle/0003_f1_03_r_expansao.sql');
  const cleanSql3 = stripOuterTransaction(readFileSync(sql3Path, 'utf8'));
  await db.exec(cleanSql3);

  // 9. Registra migração 0003 no histórico
  await db.exec(`
    INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
    VALUES (
      4,
      'drizzle/0003_f1_03_r_expansao.sql',
      '32be49be0da8ed6c675657ef0ecf14f54951491df0176cb66f1a450b8bab4e3f',
      'postgres',
      11541
    );
  `);

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

  return { db, sql: sqlAdapter };
}

describe('MEDICINA 2029 — Lançador Seguro da Migração F1.04 RLS (apply-staging-step5.mjs)', () => {
  it('1. Valida metadados e parâmetros operacionais fixos do lançador', () => {
    expect(TARGET_PROJECT_REF).toBe('ynfocaorhadizlvbnzrt');
    expect(TARGET_HOST).toBe('aws-0-us-east-1.pooler.supabase.com');
    expect(TARGET_PORT).toBe(5432);
    expect(TARGET_USERNAME).toBe('postgres.ynfocaorhadizlvbnzrt');
    expect(TARGET_STEP).toBe(5);
    expect(TARGET_SCRIPT_NAME).toBe('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql');
  });

  it('2. Rejeita execução se confirmação humana explícita não for exatamente "CONFIRMAR"', async () => {
    const invalidConfirmations = ['sim', 'yes', 'CONFIRMA', 's', '', 'confirmar'];

    for (const conf of invalidConfirmations) {
      await expect(
        executeControlledStep5Migration({
          confirmation: conf,
          password: 'dummy',
        })
      ).rejects.toThrowError(/OPERAÇÃO CANCELADA: Confirmação humana explícita não fornecida/);
    }
  });

  it('3. Rejeita se o arquivo de certificado CA TLS não for localizado', async () => {
    await expect(
      executeControlledStep5Migration({
        confirmation: 'CONFIRMAR',
        password: 'dummy',
        caCertPath: '/caminho/comprovadamente/inexistente/ca.crt',
      })
    ).rejects.toThrowError(/Arquivo de certificado CA TLS não encontrado/);
  });

  it('4. Validação individual das 10 Foreign Keys criadas na migração 0003 antes do RLS', async () => {
    const { db } = await createSupabaseSimulatedDbWithSteps1To4Applied();

    const expectedFks = [
      'responsavel_estudante_responsavel_perfil_id_perfis_id_fk',
      'responsavel_estudante_estudante_perfil_id_perfis_id_fk',
      'ciclos_estudante_perfil_id_perfis_id_fk',
      'questoes_arquivo_origem_id_acervo_arquivos_id_fk',
      'redacoes_reescrita_de_id_redacoes_id_fk',
      'repertorios_perfil_id_perfis_id_fk',
      'revisoes_trimestrais_estudante_perfil_id_perfis_id_fk',
      'revisoes_trimestrais_registrada_por_perfil_id_perfis_id_fk',
      'tentativas_simulado_id_simulados_id_fk',
      'topicos_pre_requisito_topico_id_topicos_id_fk',
    ];

    for (const fkName of expectedFks) {
      const res = await db.query(
        "SELECT conname, convalidated FROM pg_constraint WHERE conname = $1 AND contype = 'f';",
        [fkName]
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].conname).toBe(fkName);
      expect(res.rows[0].convalidated).toBe(true);
    }
  });

  it('5. Executa exclusivamente a migração 5 (F1.04 RLS) com etapas 1 a 4 previamente aplicadas', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To4Applied();
    const logs: string[] = [];

    // Confere estado prévio: 4 migrações no histórico e schema medicina inexistente
    const preHistory = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(preHistory.rows[0].cnt).toBe(4);

    const preSchema = await db.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'medicina';");
    expect(preSchema.rows.length).toBe(0);

    // Executa o lançador da etapa 5
    const result = await executeControlledStep5Migration({
      confirmation: 'CONFIRMAR',
      sqlInstance: sql,
      logger: (msg: string) => logs.push(msg),
    });

    expect(result.success).toBe(true);
    expect(result.appliedCount).toBe(1);
    expect(result.skippedCount).toBe(4); // 0000, 0001, 0002 e 0003 todas puladas!
    expect(result.step).toBe(5);
    expect(result.scriptName).toBe('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql');

    // 1. Confirma que as migrações 0000 a 0003 foram puladas
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0000_greedy_loki.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0001_dry_talos.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0002_little_swarm.sql'))).toBe(true);
    expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0003_f1_03_r_expansao.sql'))).toBe(true);

    // 2. Confirma histórico final com exatamente 5 registros ordenados
    const historyRes = await db.query(
      'SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations ORDER BY ordem ASC;'
    );
    expect(historyRes.rows.length).toBe(5);
    expect(historyRes.rows[4].ordem).toBe(5);
    expect(historyRes.rows[4].rel_path).toBe('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql');
    expect(historyRes.rows[4].sha256).toBe('8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f');

    // 3. Confirma criação de schema e funções do medicina
    const schemaCheck = await db.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'medicina';");
    expect(schemaCheck.rows.length).toBe(1);

    const fnCheck = await db.query("SELECT to_regprocedure('medicina.set_context(uuid,text)') as fn;");
    expect(fnCheck.rows[0].fn).not.toBeNull();

    // 4. Confirma criação dos papéis dedicados de privilégio mínimo
    const rolesRes = await db.query(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('medicina_app', 'medicina_auth', 'medicina_worker', 'medicina_anon') ORDER BY rolname;"
    );
    expect(rolesRes.rows.length).toBe(4);
    for (const r of rolesRes.rows) {
      expect(r.rolsuper).toBe(false); // Nenhum é superuser
      expect(r.rolbypassrls).toBe(false); // Nenhum dá bypass em RLS
    }

    // 5. Confirma criação das views
    const viewsRes = await db.query(
      "SELECT table_name FROM information_schema.views WHERE table_schema = 'public' AND table_name IN ('vw_perfis', 'vw_acompanhamento_quinzenal', 'vw_simulados_evolucao', 'vw_revisoes_trimestrais');"
    );
    expect(viewsRes.rows.length).toBe(4);

    // 6. Confirma que a etapa 6 (F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql) NÃO foi executada
    const constraintCheck = await db.query("SELECT 1 FROM pg_constraint WHERE conname = 'acervo_arquivos_storage_path_uniq';");
    expect(constraintCheck.rows.length).toBe(0);

    // 7. Confirma parada obrigatória no portão operacional (untilStep = 5)
    expect(logs.some((l) => l.includes('[STOP] Interrupção planejada no portão operacional (untilStep = 5)'))).toBe(true);
  });

  it('6. Cenários Negativos de RLS e Proteção de Coluna sob papel medicina_app', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To4Applied();

    // Aplica etapa 5
    await executeControlledStep5Migration({
      confirmation: 'CONFIRMAR',
      sqlInstance: sql,
      logger: () => {},
    });

    // Popula perfis com fixtures para teste sob RLS
    await db.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES
        ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Estudante Teste 1', 'estudante1@example.invalid', '$2b$10$dummyhash1', 'estudante'),
        ('10000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'Estudante Teste 2', 'estudante2@example.invalid', '$2b$10$dummyhash2', 'estudante'),
        ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Responsavel Teste 1', 'responsavel1@example.invalid', '$2b$10$dummyhash3', 'responsavel')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.responsavel_estudante (responsavel_perfil_id, estudante_perfil_id)
      VALUES ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001')
      ON CONFLICT DO NOTHING;
    `);

    // 6.1 Cenário Negativo: Conexão medicina_app sem chamar set_context em transação -> Fail-Closed (0 linhas)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      const semContexto = await db.query('SELECT id, nome, papel FROM public.perfis;');
      expect(semContexto.rows.length).toBe(0);

      const viewSemContexto = await db.query('SELECT * FROM public.vw_perfis;');
      expect(viewSemContexto.rows.length).toBe(0);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 6.2 Cenário Negativo: Tentativa de ler password_hash é barrada por Column-Level Grant (42501)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await expect(
        db.query('SELECT password_hash FROM public.perfis;')
      ).rejects.toThrowError(/permission denied for table|permission denied for column password_hash/i);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 6.3 Cenário Negativo: Tentativa de SELECT * em perfis é barrada por Column-Level Grant (42501)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await expect(
        db.query('SELECT * FROM public.perfis;')
      ).rejects.toThrowError(/permission denied for table/i);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 6.4 Cenário Negativo: Tentativa de executar autenticar_por_email é barrada para medicina_app
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await expect(
        db.query("SELECT * FROM medicina.autenticar_por_email('estudante1@example.invalid');")
      ).rejects.toThrowError(/permission denied for function autenticar_por_email/i);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 6.5 Com contexto de Estudante 1 dentro de transação: lê apenas seu próprio perfil na view segura ou colunas permitidas
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec("SELECT medicina.set_context('10000000-0000-4000-8000-000000000001'::uuid, 'estudante');");
      const comContexto = await db.query('SELECT id, nome, papel FROM public.perfis;');
      expect(comContexto.rows.length).toBe(1);
      expect(comContexto.rows[0].id).toBe('10000000-0000-4000-8000-000000000001');

      // 6.6 Limpa contexto: volta imediatamente a Fail-Closed (0 linhas)
      await db.exec('SELECT medicina.clear_context();');
      const posLimpeza = await db.query('SELECT id, nome, papel FROM public.perfis;');
      expect(posLimpeza.rows.length).toBe(0);
    } finally {
      await db.exec('ROLLBACK;');
    }
  });

  it('7. Demonstra idempotência completa em re-execução (todas as 5 etapas puladas com segurança)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To4Applied();

    // Primeira execução do step 5
    await executeControlledStep5Migration({
      confirmation: 'CONFIRMAR',
      sqlInstance: sql,
      logger: () => {},
    });

    // Segunda execução consecutiva
    const logs2: string[] = [];
    const retryResult = await executeControlledStep5Migration({
      confirmation: 'CONFIRMAR',
      sqlInstance: sql,
      logger: (msg: string) => logs2.push(msg),
    });

    expect(retryResult.appliedCount).toBe(0);
    expect(retryResult.skippedCount).toBe(5); // 0000 a F1.04 todas puladas!
    expect(logs2.some((l) => l.includes('[SKIP]') && l.includes('F1_04_RLS_PROPOSTA.sql'))).toBe(true);

    // Total de registros permanece 5
    const countRes = await db.query('SELECT count(*)::int AS total FROM public._medicina_staging_migrations;');
    expect(countRes.rows[0].total).toBe(5);
  });

  it('8. Falha durante DDL de 0005 reverte transação atomicamente via ROLLBACK', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To4Applied();

    // Adaptador que simula erro durante o DDL da etapa 5
    const failDdlAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => sql(strings, ...values),
      {
        unsafe: async (query: string) => {
          if (query.includes('CREATE SCHEMA IF NOT EXISTS medicina')) {
            throw new Error('SIMULATED_DDL_ERROR: Falha de DDL durante criação do schema medicina.');
          }
          return sql.unsafe(query);
        },
        reserve: async () => failDdlAdapter,
        release: () => {},
      }
    );

    await expect(
      executeControlledStep5Migration({
        confirmation: 'CONFIRMAR',
        sqlInstance: failDdlAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_DDL_ERROR/);

    // Comprova que o ROLLBACK reverteu o schema medicina e histórico permanece com 4 registros
    const schemaCheck = await db.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'medicina';");
    expect(schemaCheck.rows.length).toBe(0);

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(4); // Apenas etapas 1 a 4!
  });

  it('9. Falha durante tracking de 0005 reverte transação atomicamente desfazendo os objetos de RLS', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To4Applied();

    // Adaptador que simula erro no INSERT de tracking da etapa 5
    const failTrackingAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
        const q = typeof strings === 'string' ? strings : strings[0];
        if (q.includes('INSERT INTO public._medicina_staging_migrations')) {
          throw new Error('SIMULATED_TRACKING_FAILURE: Falha ao inserir registro da migração 5 no histórico.');
        }
        return sql(strings, ...values);
      },
      {
        unsafe: sql.unsafe,
        reserve: async () => failTrackingAdapter,
        release: () => {},
      }
    );

    await expect(
      executeControlledStep5Migration({
        confirmation: 'CONFIRMAR',
        sqlInstance: failTrackingAdapter,
        logger: () => {},
      })
    ).rejects.toThrowError(/SIMULATED_TRACKING_FAILURE/);

    // Comprova que o schema medicina foi desfeito pelo ROLLBACK atômico
    const schemaCheck = await db.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'medicina';");
    expect(schemaCheck.rows.length).toBe(0);

    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(4);
  });
});
