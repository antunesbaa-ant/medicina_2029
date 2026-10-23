import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  getMigrationManifest,
  executeStagingMigrations,
  extractDatabaseRole,
  assertCanRunStagingMigrationsCli,
  stripOuterTransaction,
} from '../../../scripts/db/migrate-staging.mjs';

const projectRoot = process.cwd();
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
  begin: <T>(cb: (tx: SqlAdapter) => Promise<T>) => Promise<T>;
  reserve?: () => Promise<SqlAdapter>;
  release?: () => void;
}

interface PGliteInstance {
  exec: (query: string) => Promise<unknown>;
  query: (query: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Cria uma instância isolada do PostgreSQL descartável simulando a arquitetura do Supabase gerenciado:
 * - Extensão `vector` criada no schema `extensions`.
 * - `search_path` padrão com `"$user", public, extensions`.
 */
async function createSupabaseSimulatedDb(): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
  const db = new PGlite({
    extensions: { vector },
  });

  // Configuração inicial simulando Supabase gerenciado
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;
  `);

  // Adapta a interface do PGlite para satisfazer as chamadas de template string e unsafe do postgres.js
  const sqlAdapter: SqlAdapter = Object.assign(
    async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      let queryText = '';
      if (typeof strings === 'string') {
        queryText = strings;
      } else {
        queryText = strings.reduce((acc, str, i) => acc + str + (values[i] !== undefined ? `$${i + 1}` : ''), '');
      }
      const res = await db.query(queryText, values);
      return res.rows as Record<string, unknown>[];
    },
    {
      unsafe: async (queryText: string) => {
        await db.exec(queryText);
        return [];
      },
      begin: async <T>(cb: (tx: SqlAdapter) => Promise<T>): Promise<T> => {
        await db.exec('BEGIN;');
        try {
          const res = await cb(sqlAdapter);
          await db.exec('COMMIT;');
          return res;
        } catch (err) {
          await db.exec('ROLLBACK;');
          throw err;
        }
      },
      reserve: async () => sqlAdapter,
      release: () => {},
    }
  );

  return { db, sql: sqlAdapter };
}

describe('MEDICINA 2029 — H1.04-R3: Fechamento dos Riscos do Runner e Modo Somente-Leitura', () => {
  describe('1. Validações Estáticas, Parser e Utilitários do Runner', () => {
    it('carrega o manifesto com exatamente 9 migrações e hashes calculados', () => {
      const manifest = getMigrationManifest();
      expect(manifest).toHaveLength(9);
      for (const m of manifest) {
        expect(m.ordem).toBeGreaterThan(0);
        expect(m.sha256).toHaveLength(64);
        expect(m.tamanhoBytes).toBeGreaterThan(0);
        expect(existsSync(m.fullPath)).toBe(true);
      }
    });

    it('stripOuterTransaction remove blocos externos BEGIN/COMMIT sem corromper o conteúdo interno', () => {
      const raw = `
        -- Comentário inicial
        BEGIN;
        SET LOCAL lock_timeout = '5s';
        CREATE TABLE teste (id int);
        COMMIT;
        -- Comentário final
      `;
      const stripped = stripOuterTransaction(raw);
      expect(stripped).not.toMatch(/^\s*BEGIN/i);
      expect(stripped).not.toMatch(/COMMIT\s*;?\s*$/i);
      expect(stripped).toContain("SET LOCAL lock_timeout = '5s';");
      expect(stripped).toContain('CREATE TABLE teste (id int);');
    });

    it('extrai corretamente papéis diretos e com pooler no extractDatabaseRole', () => {
      expect(extractDatabaseRole('postgresql://medicina_app:secret@localhost:5432/db')).toBe('medicina_app');
      expect(extractDatabaseRole('postgresql://medicina_worker.proj_ref:secret@pooler.supabase.com:6543/postgres')).toBe(
        'medicina_worker'
      );
      expect(extractDatabaseRole('postgres://postgres:pwd@db.host.com/db')).toBe('postgres');
      expect(extractDatabaseRole('')).toBeNull();
    });

    it('bloqueia o runner se alimentado com roles restritas de runtime no modo --apply', () => {
      expect(() => {
        assertCanRunStagingMigrationsCli({
          APP_ENV: 'staging',
          CONFIRM_STAGING_MIGRATIONS: 'true',
          DATABASE_URL: 'postgres://medicina_app:pwd@staging-db:5432/postgres',
        });
      }).toThrow(/VIOLAÇÃO DE PRIVILÉGIO/);
    });

    it('permite credenciais de somente leitura no modo --check-db', () => {
      expect(() => {
        assertCanRunStagingMigrationsCli(
          {
            APP_ENV: 'staging',
            CONFIRM_STAGING_MIGRATIONS: 'true',
            DATABASE_URL: 'postgres://medicina_reader:pwd@staging-db:5432/postgres',
          },
          { isCheckDb: true }
        );
      }).not.toThrow();
    });
  });

  describe('2. Modo --check-db: Inspeção Estritamente Passiva e Somente-Leitura (H1.04-R3)', () => {
    it('a) --check-db em banco vazio: não modifica o catálogo, não cria a tabela de histórico e aponta 9 pendências', async () => {
      const { sql, db } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();

      // Snapshot pré-inspeção do catálogo
      const preTables = await db.query("SELECT count(*)::int as cnt FROM information_schema.tables WHERE table_schema = 'public';");
      const preHistory = await db.query("SELECT to_regclass('public._medicina_staging_migrations') as tbl;");
      expect(preHistory.rows[0].tbl).toBeNull();

      const logs: string[] = [];
      const res = await executeStagingMigrations({
        sql,
        manifest,
        isDryRun: true,
        logger: (msg: string) => logs.push(msg),
      });

      expect(res.appliedCount).toBe(0);
      expect(res.skippedCount).toBe(0);
      expect(res.pendingCount).toBe(9);
      expect(res.historyTableExists).toBe(false);

      // Confere mensagem exigida
      expect(logs.some((l) => l.includes('Banco sem histórico de migrações. Nove migrações pendentes.'))).toBe(true);

      // Snapshot pós-inspeção: catálogo continua 100% inalterado
      const postTables = await db.query("SELECT count(*)::int as cnt FROM information_schema.tables WHERE table_schema = 'public';");
      const postHistory = await db.query("SELECT to_regclass('public._medicina_staging_migrations') as tbl;");

      expect(postTables.rows[0].cnt).toBe(preTables.rows[0].cnt);
      expect(postHistory.rows[0].tbl).toBeNull(); // Nenhuma tabela criada!
    });

    it('b) --check-db com histórico existente: lê corretamente migrações aplicadas e pendentes', async () => {
      const { sql } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();

      // Aplica as primeiras 4 migrações via --apply
      await executeStagingMigrations({
        sql,
        manifest: manifest.slice(0, 4),
        isDryRun: false,
        logger: () => {},
      });

      // Executa --check-db
      const logs: string[] = [];
      const res = await executeStagingMigrations({
        sql,
        manifest,
        isDryRun: true,
        logger: (msg: string) => logs.push(msg),
      });

      expect(res.historyTableExists).toBe(true);
      expect(res.appliedCount).toBe(0);
      expect(res.skippedCount).toBe(4);
      expect(res.pendingCount).toBe(5);
      expect(logs.some((l) => l.includes('[SKIP]') && l.includes('0003_f1_03_r_expansao.sql'))).toBe(true);
      expect(logs.some((l) => l.includes('[PENDING]') && l.includes('F1_04_RLS_PROPOSTA.sql'))).toBe(true);
    });

    it('c) --check-db com histórico inconsistente: aborta fail-closed com erro explicativo sem alterar dados', async () => {
      const { sql, db } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();

      // Aplica migrações 1 a 3
      await executeStagingMigrations({
        sql,
        manifest: manifest.slice(0, 3),
        isDryRun: false,
        logger: () => {},
      });

      // Corrompe hash da migração 2 no banco
      await db.query(
        "UPDATE public._medicina_staging_migrations SET sha256 = 'divergenthashfake1234567890123456789012345678901234567890123456' WHERE ordem = 2;"
      );

      // Invocação em --check-db deve detectar a violação e abortar
      await expect(
        executeStagingMigrations({
          sql,
          manifest,
          isDryRun: true,
          logger: () => {},
        })
      ).rejects.toThrowError(/DIVERGÊNCIA DE INTEGRIDADE/);

      // Catálogo e dados permanecem íntegros
      const countRes = await db.query('SELECT count(*)::int as total FROM public._medicina_staging_migrations;');
      expect(countRes.rows[0].total).toBe(3);
    });

    it('d) --check-db com credenciais estritamente somente-leitura: execução com sucesso absoluto sem DDL/DML', async () => {
      const { sql } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();

      // Cria adaptador estritamente somente-leitura: qualquer comando DDL ou DML dispara erro
      const readOnlySqlAdapter: SqlAdapter = Object.assign(
        async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
          const q = (typeof strings === 'string' ? strings : strings[0]).trim().toUpperCase();
          if (
            q.startsWith('INSERT') ||
            q.startsWith('UPDATE') ||
            q.startsWith('DELETE') ||
            q.startsWith('CREATE') ||
            q.startsWith('ALTER') ||
            q.startsWith('DROP') ||
            q.startsWith('LOCK')
          ) {
            throw new Error(`READ_ONLY_VIOLATION: Operação mutativa "${q.slice(0, 15)}..." não permitida em credencial somente-leitura.`);
          }
          return sql(strings, ...values);
        },
        {
          unsafe: async (queryText: string) => {
            const q = queryText.trim().toUpperCase();
            if (
              q.startsWith('INSERT') ||
              q.startsWith('UPDATE') ||
              q.startsWith('DELETE') ||
              q.startsWith('CREATE') ||
              q.startsWith('ALTER') ||
              q.startsWith('DROP')
            ) {
              throw new Error(`READ_ONLY_VIOLATION: Operação mutativa "${q.slice(0, 15)}..." não permitida em credencial somente-leitura.`);
            }
            return sql.unsafe(queryText);
          },
          begin: async () => {
            throw new Error('READ_ONLY_VIOLATION: Transação com escrita iniciada indevidamente em somente-leitura.');
          },
          reserve: async () => readOnlySqlAdapter,
          release: () => {},
        }
      );

      // Execução de --check-db sob o adaptador somente-leitura deve concluir com êxito
      const res = await executeStagingMigrations({
        sql: readOnlySqlAdapter,
        manifest,
        isDryRun: true,
        logger: () => {},
      });

      expect(res.isDryRun).toBe(true);
      expect(res.pendingCount).toBe(9);
    });
  });

  describe('3. Modo --apply: Atomicidade Transacional e Rastreamento Preservados', () => {
    it('aplica os 9 scripts com sucesso registrando cada um no histórico', async () => {
      const { sql, db } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();

      const logs: string[] = [];
      const res = await executeStagingMigrations({
        sql,
        manifest,
        isDryRun: false,
        logger: (msg: string) => logs.push(msg),
      });

      expect(res.total).toBe(9);
      expect(res.appliedCount).toBe(9);
      expect(res.skippedCount).toBe(0);

      // Confere tabela de histórico
      const history = await db.query('SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations ORDER BY ordem ASC;');
      expect(history.rows).toHaveLength(9);
      expect(history.rows[0].rel_path).toBe('drizzle/0000_greedy_loki.sql');
      expect(history.rows[8].rel_path).toBe('docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql');
    });

    it('demonstra idempotência completa pulando com segurança scripts já aplicados (retry)', async () => {
      const { sql } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();

      // Primeira execução
      await executeStagingMigrations({ sql, manifest, isDryRun: false, logger: () => {} });

      // Segunda execução imediata
      const logs: string[] = [];
      const retryRes = await executeStagingMigrations({
        sql,
        manifest,
        isDryRun: false,
        logger: (msg: string) => logs.push(msg),
      });

      expect(retryRes.appliedCount).toBe(0);
      expect(retryRes.skippedCount).toBe(9);
      expect(logs.some((l) => l.includes('[SKIP]'))).toBe(true);
    });

    it('aborta transacionalmente diante de erro DDL sem gravar tracking nem deixar schema corrompido', async () => {
      const { sql, db } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();

      // Aplica até a etapa 3
      await executeStagingMigrations({ sql, manifest: manifest.slice(0, 3), isDryRun: false, logger: () => {} });

      // Manifest com etapa 4 corrompida com erro de sintaxe SQL
      const corruptedManifest = [
        ...manifest.slice(0, 3),
        {
          ordem: 4,
          relPath: 'drizzle/corrupted.sql',
          fullPath: path.resolve(projectRoot, 'drizzle/0003_f1_03_r_expansao.sql'),
          tamanhoBytes: 100,
          sha256: 'abc123hash',
        },
      ];

      const failSqlAdapter: SqlAdapter = Object.assign(
        async (strings: TemplateStringsArray | string, ...values: unknown[]) => sql(strings, ...values),
        {
          unsafe: async (query: string) => {
            if (query.includes('responsavel_estudante')) {
              throw new Error('SIMULATED_SQL_SYNTAX_ERROR: Falha intencional de DDL.');
            }
            return sql.unsafe(query);
          },
          begin: async <T>(cb: (tx: SqlAdapter) => Promise<T>): Promise<T> => {
            return sql.begin(async () => cb(failSqlAdapter));
          },
          reserve: async () => failSqlAdapter,
          release: () => {},
        }
      );

      // Execução deve abortar
      await expect(
        executeStagingMigrations({ sql: failSqlAdapter, manifest: corruptedManifest, isDryRun: false, logger: () => {} })
      ).rejects.toThrow(/SIMULATED_SQL_SYNTAX_ERROR/);

      // Histórico continua contendo exatamente 3 etapas (etapa 4 NÃO foi registrada)
      const countRes = await db.query('SELECT count(*)::int as total FROM public._medicina_staging_migrations;');
      expect(countRes.rows[0].total).toBe(3);

      // Tabela responsavel_estudante NÃO deve ter sido persistida (rollback limpo)
      const tableCheck = await db.query("SELECT to_regclass('public.responsavel_estudante') as tbl;");
      expect(tableCheck.rows[0].tbl).toBeNull();
    });

    it('reverte o DDL transacionalmente se a gravação do tracking falhar na mesma transação', async () => {
      const { sql, db } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();

      // Aplica etapas 1 e 2
      await executeStagingMigrations({ sql, manifest: manifest.slice(0, 2), isDryRun: false, logger: () => {} });

      // Simula falha especificamente no INSERT da tabela de histórico durante a etapa 3
      const failTrackingAdapter: SqlAdapter = Object.assign(
        async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
          const q = typeof strings === 'string' ? strings : strings[0];
          if (q.includes('INSERT INTO public._medicina_staging_migrations') && values.includes(3)) {
            throw new Error('SIMULATED_TRACKING_INSERT_FAILURE: Falha ao gravar histórico.');
          }
          return sql(strings, ...values);
        },
        {
          unsafe: sql.unsafe,
          begin: async <T>(cb: (tx: SqlAdapter) => Promise<T>): Promise<T> => {
            return sql.begin(async () => cb(failTrackingAdapter));
          },
          reserve: async () => failTrackingAdapter,
          release: () => {},
        }
      );

      await expect(
        executeStagingMigrations({ sql: failTrackingAdapter, manifest, isDryRun: false, logger: () => {} })
      ).rejects.toThrow(/SIMULATED_TRACKING_INSERT_FAILURE/);

      // Confere que a coluna vestibular NÃO foi persistida em acervo_arquivos devido ao rollback atômico
      const colCheck = await db.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'acervo_arquivos' AND column_name = 'vestibular';
      `);
      expect(colCheck.rows).toHaveLength(0);

      // Histórico continua em 2
      const countRes = await db.query('SELECT count(*)::int as total FROM public._medicina_staging_migrations;');
      expect(countRes.rows[0].total).toBe(2);
    });

    it('detecta estado intermediário fail-closed caso objetos já existam sem registro de tracking', async () => {
      const { sql, db } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();

      // Aplica até a etapa 7
      await executeStagingMigrations({ sql, manifest: manifest.slice(0, 7), isDryRun: false, logger: () => {} });

      // Simula que a tabela `acervo_jobs` da etapa 8 foi criada fora do runner ou em falha não-atômica anterior
      await db.exec(`
        CREATE TABLE IF NOT EXISTS public.acervo_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          arquivo_id uuid NOT NULL
        );
      `);

      // Quando o runner tenta inspecionar ou aplicar a etapa 8, o probe intercepta o estado intermediário
      await expect(
        executeStagingMigrations({ sql, manifest, isDryRun: false, logger: () => {} })
      ).rejects.toThrowError(/ESTADO INTERMEDIÁRIO DETECTADO.*F1_11_FILA_INGESTAO/);
    });

    it('bloqueia execução concorrente via advisory lock no modo --apply', async () => {
      const { sql } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();

      // Simula que o advisory lock já está ocupado por outro processo
      const lockedSqlAdapter: SqlAdapter = Object.assign(
        async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
          const q = typeof strings === 'string' ? strings : strings[0];
          if (q.includes('pg_try_advisory_lock')) {
            return [{ locked: false }];
          }
          return sql(strings, ...values);
        },
        {
          unsafe: sql.unsafe,
          begin: sql.begin,
          reserve: async () => lockedSqlAdapter,
          release: () => {},
        }
      );

      await expect(
        executeStagingMigrations({ sql: lockedSqlAdapter, manifest, isDryRun: false, logger: () => {} })
      ).rejects.toThrowError(/CONCORRÊNCIA BLOQUEADA.*advisory lock/);
    });
  });

  describe('4. Segregação e Criação das Roles (medicina_worker)', () => {
    it('cria as 3 roles com NOBYPASSRLS e aplica grants corretos', async () => {
      const { sql, db } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();
      await executeStagingMigrations({ sql, manifest, isDryRun: false, logger: () => {} });

      const rolesRes = await db.query(`
        SELECT rolname, rolsuper, rolbypassrls, rolcanlogin 
        FROM pg_roles 
        WHERE rolname IN ('medicina_app', 'medicina_auth', 'medicina_worker')
        ORDER BY rolname ASC;
      `);

      expect(rolesRes.rows).toHaveLength(3);
      for (const r of rolesRes.rows) {
        expect(r.rolsuper).toBe(false);
        expect(r.rolbypassrls).toBe(false);
        expect(r.rolcanlogin).toBe(true);
      }

      // Teste negativo: medicina_worker NÃO possui privilégios de leitura em geracoes nem curadoria_fila
      const permsRes = await db.query(`
        SELECT has_table_privilege('medicina_worker', 'public.geracoes', 'SELECT') as pode_ler_geracoes,
               has_table_privilege('medicina_worker', 'public.curadoria_fila', 'SELECT') as pode_ler_curadoria;
      `);
      expect(permsRes.rows[0].pode_ler_geracoes).toBe(false);
      expect(permsRes.rows[0].pode_ler_curadoria).toBe(false);

      // Teste positivo: medicina_worker pode manipular acervo_jobs
      const workerJobPerms = await db.query(`
        SELECT has_table_privilege('medicina_worker', 'public.acervo_jobs', 'SELECT') as pode_ler_jobs,
               has_table_privilege('medicina_worker', 'public.acervo_jobs', 'UPDATE') as pode_update_jobs;
      `);
      expect(workerJobPerms.rows[0].pode_ler_jobs).toBe(true);
      expect(workerJobPerms.rows[0].pode_update_jobs).toBe(true);
    });
  });

  describe('5. Supabase Storage e Políticas RLS sem DDL de Catálogo', () => {
    it('configura o bucket acervo como privado e aplica policies em storage.objects sem falha de ownership', async () => {
      const { sql, db } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();
      await executeStagingMigrations({ sql, manifest, isDryRun: false, logger: () => {} });

      // Confere bucket
      const bucketRes = await db.query("SELECT id, name, public, file_size_limit FROM storage.buckets WHERE id = 'acervo';");
      expect(bucketRes.rows).toHaveLength(1);
      expect(bucketRes.rows[0].public).toBe(false);
      expect(bucketRes.rows[0].file_size_limit).toBe(20971520);

      // Confere policies em storage.objects
      const polRes = await db.query(`
        SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';
      `);
      const policyNames = (polRes.rows as { policyname: string }[]).map((p) => p.policyname);
      expect(policyNames).toContain('acervo_objects_responsavel_select');
      expect(policyNames).toContain('acervo_objects_worker_select');
      expect(policyNames).toContain('acervo_objects_responsavel_insert');
      expect(policyNames).toContain('acervo_objects_responsavel_delete_unlinked');
    });
  });

  describe('6. PGVector e Busca Híbrida Real (Operador <=> e search_path)', () => {
    it('executa busca vetorial 1536-d sob RLS com sucesso absoluto via operador <=>', async () => {
      const { sql, db } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();
      await executeStagingMigrations({ sql, manifest, isDryRun: false, logger: () => {} });

      // Insere dados sintéticos para o teste de busca
      const perfilEstudante = '10000000-0000-4000-8000-000000000001';
      const perfilResp = '20000000-0000-4000-8000-000000000001';

      await db.exec(`
        INSERT INTO public.perfis (id, auth_user_id, nome, email, papel)
        VALUES ('${perfilEstudante}', '${perfilEstudante}', 'Alice Estudante', 'alice@teste.com', 'estudante'),
               ('${perfilResp}', '${perfilResp}', 'Bruno Responsável', 'bruno@teste.com', 'responsavel')
        ON CONFLICT DO NOTHING;

        INSERT INTO public.responsavel_estudante (vinculo_id, responsavel_perfil_id, estudante_perfil_id)
        VALUES (1, '${perfilResp}', '${perfilEstudante}')
        ON CONFLICT DO NOTHING;

        INSERT INTO public.disciplinas (id, nome, area, cor_hex, ordem)
        VALUES ('30000000-0000-4000-8000-000000000001', 'Biologia', 'natureza', '#10B981', 1)
        ON CONFLICT DO NOTHING;

        INSERT INTO public.topicos (id, disciplina_id, nome, serie_prevista, incidencia_enem, incidencia_uece, ordem)
        VALUES ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Citologia', 1, 5, 5, 1)
        ON CONFLICT DO NOTHING;

        INSERT INTO public.acervo_arquivos (
          id, disciplina_id, titulo, tipo_material, serie_alvo, file_path, mime, tamanho_bytes,
          enviado_por, status_processamento, hash_conteudo
        ) VALUES (
          '50000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Biologia Celular',
          'livro', 1, 'acervo/livro_citologia.pdf', 'application/pdf', 1048576,
          '${perfilResp}', 'concluido', 'hashcitologia123'
        ) ON CONFLICT DO NOTHING;
      `);

      // Insere chunks com embedding 1536-d
      const vecA = '[' + Array(1536).fill('0.05').join(',') + ']';
      await db.exec(`
        INSERT INTO public.acervo_chunks (
          id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo, topico_id, embedding
        ) VALUES (
          '60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 1, 2, 1,
          'A membrana plasmática e a mitocôndria são estruturas celulares fundamentais para a respiração.',
          'exposicao_teorica', '40000000-0000-4000-8000-000000000001', '${vecA}'::extensions.vector
        ) ON CONFLICT DO NOTHING;
      `);

      // Executa a busca através da função híbrida
      const queryVec = '[' + Array(1536).fill('0.05').join(',') + ']';
      const searchRes = await db.query(`
        SELECT chunk_id, arquivo_titulo, texto, similaridade, score_vetorial
        FROM medicina.fn_busca_hibrida_acervo(
          p_query := 'mitocôndria respiração celular',
          p_query_vector := '${queryVec}'::extensions.vector,
          p_disciplina_id := '30000000-0000-4000-8000-000000000001'::uuid,
          p_limit := 5,
          p_min_similaridade := 0.1,
          p_papel := 'responsavel',
          p_perfil_id := '${perfilResp}'::uuid
        );
      `);

      expect(searchRes.rows).toHaveLength(1);
      expect(searchRes.rows[0].arquivo_titulo).toBe('Biologia Celular');
      expect(searchRes.rows[0].similaridade).toBeGreaterThan(0.5);
    });
  });

  describe('7. Rollback Completo em Banco Descartável', () => {
    it('executa os rollbacks canônicos desfazendo views e funções de forma limpa', async () => {
      const { sql, db } = await createSupabaseSimulatedDb();
      const manifest = getMigrationManifest();
      await executeStagingMigrations({ sql, manifest, isDryRun: false, logger: () => {} });

      // Executa rollback de F1.12
      const sqlF112Rollback = readFileSync(
        path.join(projectRoot, 'docs/modernizacao/propostas/F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql'),
        'utf8'
      );
      await db.exec(sqlF112Rollback);

      // Executa rollback de F1.11
      const sqlF111Rollback = readFileSync(
        path.join(projectRoot, 'docs/modernizacao/propostas/F1_11_ROLLBACK_FILA_INGESTAO.sql'),
        'utf8'
      );
      await db.exec(sqlF111Rollback);

      // Executa rollback de F1.10
      const sqlF110Rollback = readFileSync(
        path.join(projectRoot, 'docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql'),
        'utf8'
      );
      await db.exec(sqlF110Rollback);

      // Executa rollback de F1.09
      const sqlF109Rollback = readFileSync(
        path.join(projectRoot, 'docs/modernizacao/propostas/F1_09_ROLLBACK_INTEGRIDADE_E_IDEMPOTENCIA.sql'),
        'utf8'
      );
      await db.exec(sqlF109Rollback);

      // Executa rollback de F1.04
      const sqlF104Rollback = readFileSync(
        path.join(projectRoot, 'docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql'),
        'utf8'
      );
      await db.exec(sqlF104Rollback);

      // Confere que o schema medicina foi removido
      const schemaRes = await db.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'medicina';");
      expect(schemaRes.rows).toHaveLength(0);

      // Confere que a função fn_busca_hibrida_acervo não existe mais
      const fnRes = await db.query("SELECT to_regprocedure('medicina.fn_busca_hibrida_acervo(text,extensions.vector,uuid,integer,double precision,text,uuid)');");
      expect(fnRes.rows[0].to_regprocedure).toBeNull();
    });
  });
});
