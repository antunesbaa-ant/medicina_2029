/**
 * ==============================================================================
 * MEDICINA 2029 — H2.04-R2: PORTÃO FINAL PARA O PRIMEIRO SEED REMOTO
 * ==============================================================================
 * Testes direcionados em PostgreSQL descartável (PGlite com pgvector):
 * 1. Pré-Voo e Auditoria de Leitura (Ambiente, 9 migrações, baseline, zero colisões)
 * 2. Bloqueio de Colisão por UUID (Abort fail-closed sem modificar dados)
 * 3. Bloqueio de Colisão por E-mail (Abort fail-closed com preservação)
 * 4. Preservação de Dados Externos (Coexistência de dados de terceiros)
 * 5. Reexecução Legítima e Validação Pós-Seed (Idempotência e integridade)
 * 6. Falha Parcial e Atomicidade (Rollback transacional)
 * 7. Bloqueio de Operações Físicas no Supabase Storage
 * 8. Limpeza Segura e Retorno Estrito ao Baseline (Zero resíduo, FKs respeitadas)
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
  STAGING_ARQUIVO_ID,
  STORAGE_OPERATIONS_ENABLED,
  verifySeedIdentityAndCollisions,
  runPreflightAudit,
  validatePostSeedIntegrity,
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

describe.skipIf(!HAS_PGLITE)('MEDICINA 2029 — H2.04-R2: Portão Final para Seed Remoto', () => {
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

    // 1. Schema storage simulado e tabela de migrações canônicas de staging
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

    // 2. Aplicação das 9 migrações estruturais canônicas
    await pg.exec(readSql('drizzle/0000_greedy_loki.sql'));
    await pg.exec(readSql('drizzle/0001_dry_talos.sql'));
    await pg.exec(readSql('drizzle/0002_little_swarm.sql'));
    await pg.exec(readSql('drizzle/0003_f1_03_r_expansao.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'));

    // Registra as 9 migrações no histórico canônico
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
  // CENÁRIO 1: PRÉ-VOO E AUDITORIA EXCLUSIVAMENTE DE LEITURA
  // ----------------------------------------------------------------------------
  it('1. Pré-voo de leitura valida baseline, 9 migrações, allowlist e ausência de colisões', async () => {
    const logs: string[] = [];
    const auditResult = await runPreflightAudit({
      sql: sqlAdapter,
      logger: (msg: string) => logs.push(msg),
    });

    expect(auditResult.success).toBe(true);
    expect(auditResult.migrationsCount).toBe(9);
    expect(auditResult.allowlistCount).toBeGreaterThanOrEqual(2);
    expect(auditResult.nonPrivRolesOk).toBe(true);

    const collisionCheck = await verifySeedIdentityAndCollisions(sqlAdapter);
    expect(collisionCheck.ok).toBe(true);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 2: PROTEÇÃO CONTRA COLISÃO DE UUID (FAIL-CLOSED)
  // ----------------------------------------------------------------------------
  it('2. Bloqueia sumariamente caso o UUID de Alice colida com outro e-mail (fail-closed)', async () => {
    // Insere colisão: perfil com UUID de Alice, mas e-mail externo de terceiro
    await pg.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES ('${PERSONA_ALICE.id}'::uuid, '${PERSONA_ALICE.id}'::uuid, 'Médico Invasor', 'invasor@externo.org', 'hash', 'estudante');
    `);

    let erroDetectado: any = null;
    try {
      await provisionHomologationData({
        sql: sqlAdapter,
        logger: () => {},
      });
    } catch (err: any) {
      erroDetectado = err;
    }

    expect(erroDetectado).not.toBeNull();
    expect(erroDetectado.message).toContain('COLISAO_IDENTIDADE_DETECTADA');
    expect(erroDetectado.message).toContain('invasor@externo.org');

    // Confirma fail-closed: o e-mail não foi alterado e Bruno e Carlos NÃO foram criados
    const checkPerfis = await pg.query<{ email: string }>(
      `SELECT email FROM public.perfis WHERE id = '${PERSONA_ALICE.id}';`
    );
    expect(checkPerfis.rows[0].email).toBe('invasor@externo.org');

    const checkBruno = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.perfis WHERE id = '${PERSONA_BRUNO.id}';`
    );
    expect(Number(checkBruno.rows[0].count)).toBe(0);

    // Remove o registro de colisão para os próximos testes
    await pg.exec(`DELETE FROM public.perfis WHERE id = '${PERSONA_ALICE.id}';`);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 3: PROTEÇÃO CONTRA COLISÃO DE E-MAIL (FAIL-CLOSED)
  // ----------------------------------------------------------------------------
  it('3. Bloqueia sumariamente caso o e-mail de Alice colida com outro UUID', async () => {
    const foreignUuid = '99999999-9999-4000-8000-999999999999';
    await pg.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES ('${foreignUuid}'::uuid, '${foreignUuid}'::uuid, 'Alice Estranha', '${PERSONA_ALICE.email}', 'hash', 'estudante');
    `);

    let erroDetectado: any = null;
    try {
      await provisionHomologationData({
        sql: sqlAdapter,
        logger: () => {},
      });
    } catch (err: any) {
      erroDetectado = err;
    }

    expect(erroDetectado).not.toBeNull();
    expect(erroDetectado.message).toContain('COLISAO_IDENTIDADE_DETECTADA');
    expect(erroDetectado.message).toContain(foreignUuid);

    // Confirma que registro externo não foi modificado
    const checkForeign = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.perfis WHERE id = '${foreignUuid}' AND email = '${PERSONA_ALICE.email}';`
    );
    expect(Number(checkForeign.rows[0].count)).toBe(1);

    // Limpa registro de teste
    await pg.exec(`DELETE FROM public.perfis WHERE id = '${foreignUuid}';`);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 4: PRESERVAÇÃO DE DADOS EXTERNOS PREEXISTENTES
  // ----------------------------------------------------------------------------
  it('4. Preserva integralmente dados externos preexistentes antes e durante o provisionamento', async () => {
    const devPerfilId = 'dddddddd-dddd-4000-8000-dddddddddddd';
    const devCicloId = 'cccccccc-cccc-4000-8000-cccccccccccc';
    const devCardId = 'bbbbbbbb-bbbb-4000-8000-bbbbbbbbbbbb';

    // Insere dados pré-existentes de um desenvolvedor
    await pg.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES ('${devPerfilId}'::uuid, '${devPerfilId}'::uuid, 'Dev Preexistente', 'dev@medicina2029.test', 'hash', 'estudante')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana)
      VALUES ('${devCicloId}'::uuid, '${devPerfilId}'::uuid, 'Ciclo Dev', 2026, true, 10)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Provisiona normalmente as 3 personas sintéticas
    const result = await provisionHomologationData({
      sql: sqlAdapter,
      logger: () => {},
    });
    expect(result.success).toBe(true);

    // Comprova que o perfil e o ciclo do desenvolvedor continuam 100% intactos
    const devCheck = await pg.query<{ nome: string }>(
      `SELECT nome FROM public.perfis WHERE id = '${devPerfilId}';`
    );
    expect(devCheck.rows[0].nome).toBe('Dev Preexistente');

    const cicloCheck = await pg.query<{ nome: string }>(
      `SELECT nome FROM public.ciclos WHERE id = '${devCicloId}';`
    );
    expect(cicloCheck.rows[0].nome).toBe('Ciclo Dev');

    // Executa validação pós-seed das personas sintéticas
    const valResult = await validatePostSeedIntegrity({
      sql: sqlAdapter,
      logger: () => {},
    });
    expect(valResult.success).toBe(true);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 5: REEXECUÇÃO LEGÍTIMA E IDEMPOTÊNCIA COMPROVADA
  // ----------------------------------------------------------------------------
  it('5. Reexecução legítima reconhece identidades canônicas e atualiza idempotentemente sem duplicidades', async () => {
    // Executa novamente a provisão
    const resultReexec = await provisionHomologationData({
      sql: sqlAdapter,
      student1Password: 'senha_nova_alice',
      responsiblePassword: 'senha_nova_bruno',
      student2Password: 'senha_nova_carlos',
      logger: () => {},
    });

    expect(resultReexec.success).toBe(true);

    // Contagens rigorosas
    const perfisRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.perfis WHERE id IN ('${PERSONA_ALICE.id}', '${PERSONA_BRUNO.id}', '${PERSONA_CARLOS.id}');`
    );
    expect(Number(perfisRes.rows[0].count)).toBe(3);

    const ciclosRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.ciclos WHERE id IN ('${STAGING_ALICE_CICLO_ID}', '${STAGING_CARLOS_CICLO_ID}');`
    );
    expect(Number(ciclosRes.rows[0].count)).toBe(2);

    const blocosRes = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.ciclo_blocos WHERE ciclo_id IN ('${STAGING_ALICE_CICLO_ID}', '${STAGING_CARLOS_CICLO_ID}');`
    );
    expect(Number(blocosRes.rows[0].count)).toBe(56);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 6: FALHA PARCIAL E ATOMICIDADE TRANSACIONAL
  // ----------------------------------------------------------------------------
  it('6. Falha no meio da transação reverte todas as mutações via ROLLBACK sem deixar registros órfãos', async () => {
    let falha = false;
    try {
      await sqlAdapter.begin(async (tx: any) => {
        await tx`
          INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
          VALUES ('aaaaaaaa-aaaa-4000-8000-aaaaaaaaaaaa'::uuid, 'aaaaaaaa-aaaa-4000-8000-aaaaaaaaaaaa'::uuid, 'Temp', 'temp@staging.test', 'h', 'estudante');
        `;
        // Força erro com FK nula/inválida
        await tx`
          INSERT INTO public.ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana)
          VALUES ('bbbbbbbb-bbbb-4000-8000-bbbbbbbbbbbb'::uuid, '00000000-0000-4000-8000-000000000000'::uuid, 'Inv', 2026, true, 10);
        `;
      });
    } catch {
      falha = true;
    }

    expect(falha).toBe(true);

    const checkTemp = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.perfis WHERE id = 'aaaaaaaa-aaaa-4000-8000-aaaaaaaaaaaa';`
    );
    expect(Number(checkTemp.rows[0].count)).toBe(0);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 7: BLOQUEIO DE OPERAÇÕES STORAGE
  // ----------------------------------------------------------------------------
  it('7. Operações físicas no Supabase Storage estão desabilitadas por default para garantir atomicidade no PostgreSQL', async () => {
    expect(STORAGE_OPERATIONS_ENABLED).toBe(false);

    const storageRemoveCalls: string[][] = [];
    const mockStorageClient = {
      storage: {
        from: () => ({
          remove: async (paths: string[]) => {
            storageRemoveCalls.push(paths);
            return { error: null };
          },
        }),
      },
    };

    const cleanupLogs: string[] = [];
    await cleanupHomologationData({
      sql: sqlAdapter,
      storageClient: mockStorageClient,
      logger: (msg: string) => cleanupLogs.push(msg),
    });

    // Zero chamadas para a API REST de remoção física de blobs
    expect(storageRemoveCalls.length).toBe(0);
    expect(cleanupLogs.some((l) => l.includes('Storage') && l.includes('desabilitada'))).toBe(true);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 8: LIMPEZA SEGURA E RETORNO AO BASELINE INICIAL
  // ----------------------------------------------------------------------------
  it('8. Limpeza expurga 100% dos dados sintéticos, preserva o usuário desenvolvedor e o baseline', async () => {
    const devPerfilId = 'dddddddd-dddd-4000-8000-dddddddddddd';
    const devCicloId = 'cccccccc-cccc-4000-8000-cccccccccccc';

    // 8.1 Perfis sintéticos foram expurgados
    const perfisCount = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.perfis WHERE id IN ('${PERSONA_ALICE.id}', '${PERSONA_BRUNO.id}', '${PERSONA_CARLOS.id}');`
    );
    expect(Number(perfisCount.rows[0].count)).toBe(0);

    // 8.2 Allowlist sintética foi expurgada
    const allowCount = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.allowlist WHERE email IN ('${PERSONA_ALICE.email}', '${PERSONA_BRUNO.email}', '${PERSONA_CARLOS.email}');`
    );
    expect(Number(allowCount.rows[0].count)).toBe(0);

    // 8.3 Perfil e ciclo do desenvolvedor permanecem 100% PRESERVADOS
    const devCheck = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.perfis WHERE id = '${devPerfilId}';`
    );
    expect(Number(devCheck.rows[0].count)).toBe(1);

    const devCicloCheck = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.ciclos WHERE id = '${devCicloId}';`
    );
    expect(Number(devCicloCheck.rows[0].count)).toBe(1);

    // 8.4 E-mails do baseline inicial permanecem intactos
    const baseAllow = await pg.query<{ count: string }>(
      `SELECT count(*) as count FROM public.allowlist WHERE email IN ('estudante@medicina2029.com.br', 'responsavel@medicina2029.com.br');`
    );
    expect(Number(baseAllow.rows[0].count)).toBe(2);

    // 8.5 As 9 migrações continuam intactas
    const migCheck = await pg.query<{ count: string }>(
      'SELECT count(*) as count FROM public._medicina_staging_migrations;'
    );
    expect(Number(migCheck.rows[0].count)).toBe(9);

    // Limpa dados auxiliares do desenvolvedor para deixar o banco descartável limpo
    await pg.exec(`
      DELETE FROM public.ciclos WHERE id = '${devCicloId}';
      DELETE FROM public.perfis WHERE id = '${devPerfilId}';
    `);
  });
});
