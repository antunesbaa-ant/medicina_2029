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

async function createSupabaseSimulatedDbWithSteps1To5Applied(): Promise<{ db: PGliteInstance; sql: SqlAdapter }> {
  const db = new PGlite({
    extensions: { vector },
  });

  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;
  `);

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
    { file: 'drizzle/0000_greedy_loki.sql', ordem: 1, sha256: 'b1cf8d6741894a52543ca0edf7212dee9ee8945051cd01148ea60a3cbaf4b4c6', bytes: 24043 },
    { file: 'drizzle/0001_dry_talos.sql', ordem: 2, sha256: '8e82452e0071ee1ce5a1e38569ef8f69a0851ae3d8e229ebfd1b4969e3db9180', bytes: 238 },
    { file: 'drizzle/0002_little_swarm.sql', ordem: 3, sha256: 'c3ce3d3b1335bedb2deb46e2c14c018fe15370b60e7fdc415def17cb9de0343b', bytes: 66 },
    { file: 'drizzle/0003_f1_03_r_expansao.sql', ordem: 4, sha256: '32be49be0da8ed6c675657ef0ecf14f54951491df0176cb66f1a450b8bab4e3f', bytes: 11541 },
    { file: 'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql', ordem: 5, sha256: '8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f', bytes: 45758 },
  ];

  for (const m of initialMigrations) {
    const rawSql = readFileSync(path.resolve(process.cwd(), m.file), 'utf8');
    const cleanSql = stripOuterTransaction(rawSql);
    await db.exec(cleanSql);

    await db.exec(`
      INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
      VALUES (${m.ordem}, '${m.file}', '${m.sha256}', 'postgres', ${m.bytes});
    `);
  }

  const sqlAdapter = createSqlAdapter(db);
  return { db, sql: sqlAdapter };
}

describe('MEDICINA 2029 — H1.06: Ciclo de Vida e Integridade da Migração F1.09 em PostgreSQL Descartável', () => {
  it('1. Aplicação Sequencial das Etapas 1 a 6 e confirmação de isolamento estrito da Etapa 7', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();
    const logs: string[] = [];

    // Confere estado inicial: exatamente 5 migrações no histórico
    const preRes = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(preRes.rows[0].cnt).toBe(5);

    // Executa runner com untilStep = 6
    const manifest = getMigrationManifest();
    const result = await executeStagingMigrations({
      sql,
      manifest,
      isDryRun: false,
      untilStep: 6,
      logger: (msg: string) => logs.push(msg),
    });

    expect(result.appliedCount).toBe(1);
    expect(result.skippedCount).toBe(5);

    // Confirma que a tabela de histórico contém exatamente 6 registros ordenados
    const historyRes = await db.query(
      'SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations ORDER BY ordem ASC;'
    );
    expect(historyRes.rows.length).toBe(6);
    expect(historyRes.rows.map((r) => r.ordem)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(historyRes.rows[5].rel_path).toBe('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql');
    expect(historyRes.rows[5].sha256).toBe('96187040783e236b64bb70c15b9bf57c7ad39feb3d100a571bfa0e01eb5b55d1');

    // Confirma que a etapa 7 (F1_10_STORAGE_POLICIES_PROPOSTA.sql) NÃO foi aplicada
    const step7ProcCheck = await db.query("SELECT to_regprocedure('medicina.is_valid_acervo_storage_path(text)') as fn;");
    expect(step7ProcCheck.rows[0].fn).toBeNull();

    // Confirma parada obrigatória no portão operacional (untilStep = 6)
    expect(logs.some((l) => l.includes('[STOP] Interrupção planejada no portão operacional (untilStep = 6)'))).toBe(true);
  });

  it('2. Estrutura Canônica da Tabela operacoes_idempotentes (colunas, PK e check constraints)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();
    await executeStagingMigrations({ sql, untilStep: 6, logger: () => {} });

    // 2.1 Validação de colunas e tipos
    const colsRes = await db.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'operacoes_idempotentes'
      ORDER BY ordinal_position;
    `);

    const colMap = new Map(colsRes.rows.map((r) => [r.column_name, r]));
    expect(colMap.get('id')?.is_nullable).toBe('NO');
    expect(colMap.get('perfil_id')?.is_nullable).toBe('NO');
    expect(colMap.get('escopo')?.is_nullable).toBe('NO');
    expect(colMap.get('chave_idempotencia')?.is_nullable).toBe('NO');
    expect(colMap.get('payload_hash')?.is_nullable).toBe('NO');
    expect(colMap.get('recurso_id')?.is_nullable).toBe('YES');
    expect(colMap.get('resposta_resumo')?.is_nullable).toBe('NO');
    expect(colMap.get('criado_em')?.is_nullable).toBe('NO');

    // 2.2 Primary Key
    const pkRes = await db.query(`
      SELECT conname, contype
      FROM pg_constraint
      WHERE conrelid = 'public.operacoes_idempotentes'::regclass AND contype = 'p';
    `);
    expect(pkRes.rows.length).toBe(1);

    // 2.3 Unique Constraint (perfil_id, escopo, chave_idempotencia)
    const uqRes = await db.query(`
      SELECT conname, contype
      FROM pg_constraint
      WHERE conrelid = 'public.operacoes_idempotentes'::regclass AND conname = 'operacoes_idempotentes_perfil_escopo_chave_unique';
    `);
    expect(uqRes.rows.length).toBe(1);
    expect(uqRes.rows[0].contype).toBe('u');

    // 2.4 Check Constraint de Escopo
    const scopeCheck = await db.query(`
      SELECT conname, contype
      FROM pg_constraint
      WHERE conrelid = 'public.operacoes_idempotentes'::regclass AND conname = 'operacoes_idempotentes_escopo_check';
    `);
    expect(scopeCheck.rows.length).toBe(1);

    // 2.5 Check Constraint de Payload Hash (exatamente 64 caracteres)
    const hashCheck = await db.query(`
      SELECT conname, contype
      FROM pg_constraint
      WHERE conrelid = 'public.operacoes_idempotentes'::regclass AND conname = 'operacoes_idempotentes_payload_hash_check';
    `);
    expect(hashCheck.rows.length).toBe(1);
  });

  it('3. Validação de integridade de domínio da tabela operacoes_idempotentes (Check Constraints)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();
    await executeStagingMigrations({ sql, untilStep: 6, logger: () => {} });

    const perfilId = '10000000-0000-4000-8000-000000000001';
    await db.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES ('${perfilId}', 'a0000000-0000-4000-8000-000000000001', 'Estudante Teste', 'estudante@test.com', 'hash', 'estudante')
      ON CONFLICT DO NOTHING;
    `);

    // 3.1 Rejeita escopo inválido
    await expect(
      db.query(`
        INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
        VALUES ('${perfilId}', 'escopo.invalido', 'key-1', '${'a'.repeat(64)}', '{"ok": true}');
      `)
    ).rejects.toThrowError(/operacoes_idempotentes_escopo_check/);

    // 3.2 Aceita todos os 9 escopos canônicos
    const canonicalScopes = [
      'sessao.iniciar',
      'sessao.concluir',
      'fsrs.revisar',
      'simulado.registrar',
      'curadoria.gerar',
      'curadoria.decidir',
      'redacao.registrar',
      'repertorio.registrar',
      'acervo.upload',
    ];

    for (const [idx, scope] of canonicalScopes.entries()) {
      await db.query(`
        INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
        VALUES ('${perfilId}', '${scope}', 'canonical-key-${idx}', '${'b'.repeat(64)}', '{"scope": "${scope}"}');
      `);
    }

    const insertedCount = await db.query(`
      SELECT count(*)::int AS cnt FROM public.operacoes_idempotentes WHERE chave_idempotencia LIKE 'canonical-key-%';
    `);
    expect(insertedCount.rows[0].cnt).toBe(9);

    // 3.3 Rejeita payload_hash com tamanho menor que 64 (CHECK constraint)
    await expect(
      db.query(`
        INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
        VALUES ('${perfilId}', 'sessao.iniciar', 'bad-hash-short', '${'c'.repeat(63)}', '{"ok": true}');
      `)
    ).rejects.toThrowError(/operacoes_idempotentes_payload_hash_check/);

    // 3.4 Rejeita payload_hash com tamanho maior que 64 (varchar length violation)
    await expect(
      db.query(`
        INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
        VALUES ('${perfilId}', 'sessao.iniciar', 'bad-hash-long', '${'d'.repeat(65)}', '{"ok": true}');
      `)
    ).rejects.toThrowError(/value too long for type character varying\(64\)|operacoes_idempotentes_payload_hash_check/);
  });

  it('4. Comportamento de Concorrência e Idempotência Persistente (chave duplicada vs ON CONFLICT)', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();
    await executeStagingMigrations({ sql, untilStep: 6, logger: () => {} });

    const perfil1 = '10000000-0000-4000-8000-000000000001';
    const perfil2 = '10000000-0000-4000-8000-000000000002';

    await db.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES
        ('${perfil1}', 'a0000000-0000-4000-8000-000000000001', 'Estudante 1', 'estudante1@test.com', 'hash', 'estudante'),
        ('${perfil2}', 'a0000000-0000-4000-8000-000000000002', 'Estudante 2', 'estudante2@test.com', 'hash', 'estudante')
      ON CONFLICT DO NOTHING;
    `);

    // Inserção da primeira operação
    const hash = 'e'.repeat(64);
    await db.query(`
      INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
      VALUES ('${perfil1}', 'sessao.iniciar', 'tx-idempotent-key', '${hash}', '{"sessionId": "s-123"}');
    `);

    // 4.1 Tentativa de inserção duplicada crua deve falhar com violação de unicidade
    await expect(
      db.query(`
        INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
        VALUES ('${perfil1}', 'sessao.iniciar', 'tx-idempotent-key', '${hash}', '{"sessionId": "s-456"}');
      `)
    ).rejects.toThrowError(/operacoes_idempotentes_perfil_escopo_chave_unique/);

    // 4.2 Inserção com ON CONFLICT DO NOTHING é idempotente e bem-sucedida (0 novas linhas)
    const onConflictRes = await db.query(`
      INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
      VALUES ('${perfil1}', 'sessao.iniciar', 'tx-idempotent-key', '${hash}', '{"sessionId": "s-ignored"}')
      ON CONFLICT (perfil_id, escopo, chave_idempotencia) DO NOTHING
      RETURNING id;
    `);
    expect(onConflictRes.rows.length).toBe(0);

    // 4.3 Isolamento por perfil: a MESMA chave para um perfil DIFERENTE é permitida
    const perfil2Res = await db.query(`
      INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
      VALUES ('${perfil2}', 'sessao.iniciar', 'tx-idempotent-key', '${hash}', '{"sessionId": "s-perfil2"}')
      RETURNING id;
    `);
    expect(perfil2Res.rows.length).toBe(1);

    // 4.4 Isolamento por escopo: a MESMA chave para um escopo DIFERENTE do mesmo perfil é permitida
    const diffScopeRes = await db.query(`
      INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
      VALUES ('${perfil1}', 'sessao.concluir', 'tx-idempotent-key', '${hash}', '{"sessionId": "s-concluida"}')
      RETURNING id;
    `);
    expect(diffScopeRes.rows.length).toBe(1);
  });

  it('5. Integridade Referencial e Foreign Key em operacoes_idempotentes', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();
    await executeStagingMigrations({ sql, untilStep: 6, logger: () => {} });

    const perfilId = '10000000-0000-4000-8000-000000000001';
    await db.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES ('${perfilId}', 'a0000000-0000-4000-8000-000000000001', 'Estudante Teste', 'estudante@test.com', 'hash', 'estudante')
      ON CONFLICT DO NOTHING;
    `);

    // 5.1 Rejeita perfil_id inexistente (FK violation)
    const fakePerfilId = '99999999-9999-4999-8999-999999999999';
    await expect(
      db.query(`
        INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
        VALUES ('${fakePerfilId}', 'sessao.iniciar', 'fake-key', '${'f'.repeat(64)}', '{"ok": true}');
      `)
    ).rejects.toThrowError(/operacoes_idempotentes_perfil_id_perfis_id_fk/);

    // 5.2 ON DELETE RESTRICT: não permite deletar o perfil com operações idempotentes associadas
    await db.query(`
      INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
      VALUES ('${perfilId}', 'sessao.iniciar', 'valid-key', '${'f'.repeat(64)}', '{"ok": true}');
    `);

    await expect(
      db.query(`DELETE FROM public.perfis WHERE id = '${perfilId}';`)
    ).rejects.toThrowError(/operacoes_idempotentes_perfil_id_perfis_id_fk/);
  });

  it('6. Novas Unicidades e Índices Parciais de Idempotência em Tabelas Pré-existentes', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();
    await executeStagingMigrations({ sql, untilStep: 6, logger: () => {} });

    // 6.1 card_revisoes: coluna chave_idempotencia e índice parcial único
    const cardCol = await db.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'card_revisoes' AND column_name = 'chave_idempotencia';
    `);
    expect(cardCol.rows.length).toBe(1);

    const cardUidx = await db.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'card_revisoes' AND indexname = 'card_revisoes_card_chave_idempotencia_uidx';
    `);
    expect(cardUidx.rows.length).toBe(1);
    expect(cardUidx.rows[0].indexdef).toContain('WHERE (chave_idempotencia IS NOT NULL)');

    // 6.2 geracoes: coluna chave_idempotencia e índice parcial único
    const genCol = await db.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'geracoes' AND column_name = 'chave_idempotencia';
    `);
    expect(genCol.rows.length).toBe(1);

    const genUidx = await db.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'geracoes' AND indexname = 'geracoes_chave_idempotencia_uidx';
    `);
    expect(genUidx.rows.length).toBe(1);
    expect(genUidx.rows[0].indexdef).toContain('WHERE (chave_idempotencia IS NOT NULL)');

    // 6.3 sessoes: índice parcial de apenas UMA sessão aberta por perfil, bloco e tópico
    const sessUidx = await db.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'sessoes' AND indexname = 'sessoes_uma_aberta_por_bloco_topico_uidx';
    `);
    expect(sessUidx.rows.length).toBe(1);
    expect(sessUidx.rows[0].indexdef).toContain('WHERE (encerrada_em IS NULL)');

    // 6.4 Unicidades em erros, curadoria_fila e acervo_arquivos
    const uqConstraints = await db.query(`
      SELECT conname, contype
      FROM pg_constraint
      WHERE conname IN (
        'erros_tentativa_id_unique',
        'curadoria_fila_artefato_unique',
        'acervo_arquivos_hash_conteudo_unique'
      )
      ORDER BY conname;
    `);
    expect(uqConstraints.rows.length).toBe(3);
    for (const r of uqConstraints.rows) {
      expect(r.contype).toBe('u');
    }
  });

  it('7. Constraints de Domínio e Validação Temporal Adicionadas pela F1.09', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();
    await executeStagingMigrations({ sql, untilStep: 6, logger: () => {} });

    // 7.1 Confirma que todas as 8 constraints de domínio foram criadas e validadas no catálogo
    const expectedDomainChecks = [
      'sessoes_tempos_limites_check',
      'sessoes_ordem_temporal_check',
      'card_revisoes_duracao_rating_check',
      'simulados_duracao_limites_check',
      'simulado_areas_acertos_total_check',
      'redacoes_limites_e_genero_check',
      'checkins_limites_dominio_check',
      'acervo_arquivos_tamanho_serie_check',
    ];

    for (const chk of expectedDomainChecks) {
      const res = await db.query(
        "SELECT conname, convalidated FROM pg_constraint WHERE conname = $1 AND contype = 'c';",
        [chk]
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].conname).toBe(chk);
      expect(res.rows[0].convalidated).toBe(true);
    }

    const perfilId = '10000000-0000-4000-8000-000000000001';
    await db.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES ('${perfilId}', 'a0000000-0000-4000-8000-000000000001', 'Estudante Teste', 'estudante@test.com', 'hash', 'estudante')
      ON CONFLICT DO NOTHING;
    `);

    // 7.2 Testa violação de domínio em checkins: horas_sono > 24
    await expect(
      db.query(`
        INSERT INTO public.checkins (perfil_id, data, horas_sono, exercicio_min, humor, energia)
        VALUES ('${perfilId}', now(), 25, 30, 3, 3);
      `)
    ).rejects.toThrowError(/checkins_limites_dominio_check/);

    // 7.3 Testa violação de domínio em checkins: humor fora da faixa [1, 5]
    await expect(
      db.query(`
        INSERT INTO public.checkins (perfil_id, data, horas_sono, exercicio_min, humor, energia)
        VALUES ('${perfilId}', now(), 8, 30, 6, 3);
      `)
    ).rejects.toThrowError(/checkins_limites_dominio_check/);

    // 7.4 Testa violação de domínio em simulados: duracao_min <= 0
    await expect(
      db.query(`
        INSERT INTO public.simulados (perfil_id, formato, data, condicoes_reais, duracao_min, local, composicao_procedencia)
        VALUES ('${perfilId}', 'enem', now(), true, 0, 'Casa', '{}');
      `)
    ).rejects.toThrowError(/simulados_duracao_limites_check/);

    // 7.5 Testa violação de domínio em simulados: duracao_min > 720
    await expect(
      db.query(`
        INSERT INTO public.simulados (perfil_id, formato, data, condicoes_reais, duracao_min, local, composicao_procedencia)
        VALUES ('${perfilId}', 'enem', now(), true, 721, 'Casa', '{}');
      `)
    ).rejects.toThrowError(/simulados_duracao_limites_check/);
  });

  it('8. Permissões de Acesso e Isolamento RLS por Perfil sob medicina_app', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();
    await executeStagingMigrations({ sql, untilStep: 6, logger: () => {} });

    // 8.1 Confirma RLS e FORCE RLS ativos em operacoes_idempotentes
    const rlsCheck = await db.query(`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname = 'operacoes_idempotentes' AND relnamespace = 'public'::regnamespace;
    `);
    expect(rlsCheck.rows[0].relrowsecurity).toBe(true);
    expect(rlsCheck.rows[0].relforcerowsecurity).toBe(true);

    // 8.2 Confirma política RLS operacoes_idempotentes_own_policy
    const policyCheck = await db.query(`
      SELECT polname, polcmd
      FROM pg_policy
      WHERE polrelid = 'public.operacoes_idempotentes'::regclass AND polname = 'operacoes_idempotentes_own_policy';
    `);
    expect(policyCheck.rows.length).toBe(1);

    const perfil1 = '10000000-0000-4000-8000-000000000001';
    const perfil2 = '10000000-0000-4000-8000-000000000002';
    await db.exec(`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES
        ('${perfil1}', 'a0000000-0000-4000-8000-000000000001', 'Estudante 1', 'estudante1@test.com', 'hash', 'estudante'),
        ('${perfil2}', 'a0000000-0000-4000-8000-000000000002', 'Estudante 2', 'estudante2@test.com', 'hash', 'estudante')
      ON CONFLICT DO NOTHING;
    `);

    // 8.3 Conexão sob papel medicina_app sem contexto -> Fail-Closed (0 registros)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      const semContexto = await db.query('SELECT * FROM public.operacoes_idempotentes;');
      expect(semContexto.rows.length).toBe(0);
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 8.4 Contexto Estudante 1: insere e visualiza sua própria operação
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${perfil1}'::uuid, 'estudante');`);
      await db.exec(`
        INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
        VALUES ('${perfil1}', 'sessao.iniciar', 'p1-key-rls', '${'1'.repeat(64)}', '{"user": 1}');
      `);

      const r1 = await db.query('SELECT * FROM public.operacoes_idempotentes;');
      expect(r1.rows.length).toBe(1);
      expect(r1.rows[0].perfil_id).toBe(perfil1);
    } finally {
      await db.exec('COMMIT;');
    }

    // 8.5 Contexto Estudante 2: isolamento cross-tenant (não enxerga operações do Estudante 1)
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${perfil2}'::uuid, 'estudante');`);
      const r2 = await db.query('SELECT * FROM public.operacoes_idempotentes;');
      expect(r2.rows.length).toBe(0); // Zero vazamento de dados cross-tenant!
    } finally {
      await db.exec('ROLLBACK;');
    }

    // 8.6 Tentativa de Estudante 1 inserir operação para Estudante 2 é bloqueada pelo WITH CHECK da policy RLS
    await db.exec('BEGIN; SET LOCAL ROLE medicina_app;');
    try {
      await db.exec(`SELECT medicina.set_context('${perfil1}'::uuid, 'estudante');`);
      await expect(
        db.query(`
          INSERT INTO public.operacoes_idempotentes (perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo)
          VALUES ('${perfil2}', 'sessao.iniciar', 'p2-hijack-key', '${'2'.repeat(64)}', '{"user": 2}');
        `)
      ).rejects.toThrowError(/violates row-level security policy for table "operacoes_idempotentes"/);
    } finally {
      await db.exec('ROLLBACK;');
    }
  });

  it('9. Atomicidade e Rollback Transacional em Falha de Execução', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();

    // Adaptador com falha proposital durante o DDL da F1.09
    const failingAdapter: SqlAdapter = Object.assign(
      async (strings: TemplateStringsArray | string, ...values: unknown[]) => sql(strings, ...values),
      {
        unsafe: async (query: string) => {
          if (query.includes('operacoes_idempotentes')) {
            throw new Error('ATOMIC_ROLLBACK_TEST: Falha intencional de DDL.');
          }
          return sql.unsafe(query);
        },
        reserve: async () => failingAdapter,
        release: () => {},
      }
    );

    const manifest = getMigrationManifest();
    await expect(
      executeStagingMigrations({
        sql: failingAdapter,
        manifest,
        untilStep: 6,
        logger: () => {},
      })
    ).rejects.toThrowError(/ATOMIC_ROLLBACK_TEST/);

    // Confirma que a tabela operacoes_idempotentes NÃO foi persistida
    const tblCheck = await db.query("SELECT to_regclass('public.operacoes_idempotentes') as tbl;");
    expect(tblCheck.rows[0].tbl).toBeNull();

    // Confirma que o histórico permaneceu intacto com as 5 migrações anteriores
    const historyCount = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(historyCount.rows[0].cnt).toBe(5);
  });

  it('10. Idempotência Completa e Preservação de Estado na Reexecução', async () => {
    const { db, sql } = await createSupabaseSimulatedDbWithSteps1To5Applied();
    const manifest = getMigrationManifest();

    // Primeira aplicação da etapa 6
    const firstRun = await executeStagingMigrations({
      sql,
      manifest,
      untilStep: 6,
      logger: () => {},
    });
    expect(firstRun.appliedCount).toBe(1);
    expect(firstRun.skippedCount).toBe(5);

    // Reexecução imediata
    const retryLogs: string[] = [];
    const retryRun = await executeStagingMigrations({
      sql,
      manifest,
      untilStep: 6,
      logger: (msg: string) => retryLogs.push(msg),
    });

    expect(retryRun.appliedCount).toBe(0);
    expect(retryRun.skippedCount).toBe(6);
    expect(retryLogs.filter((l) => l.includes('[SKIP]')).length).toBe(6);

    const finalHistory = await db.query('SELECT count(*)::int AS cnt FROM public._medicina_staging_migrations;');
    expect(finalHistory.rows[0].cnt).toBe(6);
  });
});
