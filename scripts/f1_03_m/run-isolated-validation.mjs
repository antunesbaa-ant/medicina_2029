import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const runtimeRoot = '/tmp/medicina_2029_embedded_pg_runtime';
const runtimePackage = path.join(runtimeRoot, 'package.json');
const runtimeRequire = createRequire(runtimePackage);
const EmbeddedPostgres = runtimeRequire('embedded-postgres').default;

const readProjectFile = (relativePath) =>
  readFileSync(path.join(projectRoot, relativePath), 'utf8');

const migration0000 = readProjectFile('drizzle/0000_greedy_loki.sql');
const migration0001 = readProjectFile('drizzle/0001_dry_talos.sql');
const migration0002 = readProjectFile('drizzle/0002_little_swarm.sql');
const auditSql = readProjectFile('docs/modernizacao/sql/F1_03_AUDITORIA_READONLY.sql');
const proposalSql = readProjectFile('docs/modernizacao/propostas/F1_03_MIGRACAO_PROPOSTA.sql');
const fixturesSql = readProjectFile('tests/integration/f1_03_m/fixtures.sql');
const physicalRollbackSql = readProjectFile('tests/integration/f1_03_m/rollback_fisico.sql');

const fixtureTables = [
  'perfis', 'disciplinas', 'topicos', 'ciclos', 'ciclo_blocos', 'ciclo_estado',
  'sessoes', 'cards', 'card_revisoes', 'acervo_arquivos', 'acervo_paginas',
  'acervo_chunks', 'questoes', 'questao_topicos', 'simulados',
  'simulado_questoes', 'simulado_areas', 'simulado_analise', 'tentativas',
  'erros', 'generos', 'redacoes', 'repertorios', 'revisoes_trimestrais',
  'checkins', 'livros'
];

const results = {
  environment: {},
  exactMigrations: {},
  structuralHarness: {},
  audit: {},
  proposal: {},
  negativeScenarios: [],
  rollback: {},
  cleanup: {}
};

function sanitizeError(error) {
  return {
    code: error?.code ?? null,
    message: String(error?.message ?? error).split('\n')[0]
  };
}

async function findFreePort() {
  for (let port = 55439; port <= 55449; port += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('Nenhuma porta exclusiva livre no intervalo F1.03-M.');
}

function makeStructuralBaseline() {
  const withoutExtension = migration0000.replace(
    'CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint\n',
    ''
  );
  const vectorOccurrences = (withoutExtension.match(/vector\(1536\)/g) ?? []).length;
  if (vectorOccurrences !== 1) {
    throw new Error(`Esperada uma coluna vector(1536); encontradas ${vectorOccurrences}.`);
  }
  return withoutExtension.replace('vector(1536)', 'text');
}

async function queryRows(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows;
}

async function resetPublicSchema(client) {
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

async function loadStructuralBaseline(client) {
  await resetPublicSchema(client);
  await client.query(makeStructuralBaseline());
  await client.query(migration0001);
  await client.query(migration0002);
}

async function tableSnapshot(client) {
  const snapshot = {};
  for (const table of fixtureTables) {
    const rows = await queryRows(client, `SELECT count(*)::integer AS count FROM ${table}`);
    snapshot[table] = rows[0].count;
  }
  return snapshot;
}

async function expectFailure(client, sql, expectedCodes = []) {
  try {
    await client.query(sql);
    return { failed: false, error: null };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    const sanitized = sanitizeError(error);
    return {
      failed: true,
      expectedCode: expectedCodes.length === 0 || expectedCodes.includes(sanitized.code),
      error: sanitized
    };
  }
}

async function assertProposalRolledBack(client) {
  const rows = await queryRows(
    client,
    "SELECT to_regclass('public.responsavel_estudante') IS NULL AS rolled_back"
  );
  return rows[0].rolled_back;
}

async function runRejectedScenario(client, candidateProposal, name, setupSql) {
  await loadStructuralBaseline(client);
  await client.query(setupSql);
  const outcome = await expectFailure(client, candidateProposal);
  results.negativeScenarios.push({
    name,
    expected: 'rejeicao atomica',
    passed: outcome.failed && await assertProposalRolledBack(client),
    outcome
  });
}

const profileSql = {
  student: `INSERT INTO perfis (id, auth_user_id, nome, email, papel) VALUES
    ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Estudante Teste', 'student@example.invalid', 'estudante');`,
  responsible: `INSERT INTO perfis (id, auth_user_id, nome, email, papel) VALUES
    ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Responsavel Teste', 'responsible@example.invalid', 'responsavel');`
};

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'medicina_2029_f103m_'));
const dataDir = path.join(tempRoot, 'data');
const socketDir = path.join(tempRoot, 'socket');
mkdirSync(socketDir, { recursive: true });
const port = await findFreePort();
const database = 'medicina_2029_f103m_validation';
const user = 'f103m_test_user';
const password = 'f103m_disposable_password';
let server;
let client;

try {
  server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: false,
    postgresFlags: ['-h', '127.0.0.1', '-k', socketDir],
    onLog: () => {},
    onError: () => {}
  });
  await server.initialise();
  await server.start();
  await server.createDatabase(database);
  client = server.getPgClient(database, '127.0.0.1');
  await client.connect();

  const environmentRows = await queryRows(
    client,
    `SELECT current_database() AS database, current_user AS username,
            inet_server_addr()::text AS address, current_setting('server_version') AS version`
  );
  results.environment = {
    ...environmentRows[0],
    port,
    dataDirectoryWasUnique: true,
    usedExistingDatabase: false,
    usedEnvironmentDatabaseUrl: false,
    pgvectorAvailable: false
  };

  await resetPublicSchema(client);
  const exactMigrationOutcome = await expectFailure(client, migration0000, ['0A000', '58P01']);
  results.exactMigrations = {
    attempted: true,
    migration0000: exactMigrationOutcome,
    migration0001: { attempted: false, reason: '0000 falhou antes' },
    migration0002: { attempted: false, reason: '0000 falhou antes' },
    faithfulValidationComplete: false
  };

  await loadStructuralBaseline(client);
  const baselineCatalog = await queryRows(
    client,
    `SELECT
       (SELECT count(*)::integer FROM information_schema.tables WHERE table_schema = 'public') AS public_tables,
       (SELECT count(*)::integer FROM allowlist) AS allowlist_rows,
       (SELECT count(*)::integer FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'perfis'::regclass) AS perfis_user_triggers,
       (SELECT count(*)::integer FROM pg_proc WHERE proname = 'check_allowlist') AS allowlist_functions`
  );
  results.structuralHarness = {
    postgresReal: true,
    adaptation: 'somente CREATE EXTENSION vector removida e vector(1536) substituido por text',
    ...baselineCatalog[0]
  };

  await client.query(fixturesSql);
  const identityRows = await queryRows(
    client,
    'SELECT count(*)::integer AS count FROM perfis WHERE id = auth_user_id'
  );
  if (identityRows[0].count !== 0) throw new Error('Fixture violou id != auth_user_id.');

  const beforeAudit = await tableSnapshot(client);
  await client.query(auditSql);
  const afterAudit = await tableSnapshot(client);
  const cleanAuditRows = await queryRows(
    client,
    `SELECT
       (SELECT count(*) FROM perfis WHERE id = auth_user_id)::integer AS same_identity,
       (SELECT count(*) FROM questoes q LEFT JOIN acervo_arquivos a ON a.id = q.arquivo_origem_id WHERE q.arquivo_origem_id IS NOT NULL AND a.id IS NULL)::integer AS missing_file,
       (SELECT count(*) FROM cards c JOIN perfis p ON p.id = c.perfil_id WHERE p.papel <> 'estudante')::integer AS wrong_card_role`
  );
  results.audit.cleanFixture = {
    executedReadOnlyScript: true,
    noCountChanges: JSON.stringify(beforeAudit) === JSON.stringify(afterAudit),
    ...cleanAuditRows[0]
  };

  await loadStructuralBaseline(client);
  await client.query(`${profileSql.student}${profileSql.responsible}
    INSERT INTO disciplinas (id, nome, area, cor_hex, ordem) VALUES
      ('30000000-0000-4000-8000-000000000001', 'Disciplina', 'natureza', '#123456', 1);
    INSERT INTO topicos (id, disciplina_id, nome, serie_prevista, incidencia_enem, incidencia_uece, ordem, cobertura_material)
      VALUES ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Topico', 1, 1, 1, 1, 'sem_fonte');
    INSERT INTO cards (id, perfil_id, topico_id, frente, verso, origem, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state)
      VALUES ('50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'F', 'V', 'manual', now(), 1, 1, 0, 1, 0, 0, 'new');
    INSERT INTO questoes (id, procedencia, fonte, disciplina_id, estilo, enunciado, alternativas, gabarito, arquivo_origem_id)
      VALUES ('70000000-0000-4000-8000-000000000001', 'oficial', 'TESTE', '30000000-0000-4000-8000-000000000001', 'enem', 'E', '[]'::jsonb, 'A', '69999999-0000-4000-8000-000000000001');`);
  await client.query(auditSql);
  const controlledRows = await queryRows(
    client,
    `SELECT
       (SELECT count(*) FROM cards c JOIN perfis p ON p.id = c.perfil_id WHERE p.papel <> 'estudante')::integer AS wrong_card_role,
       (SELECT count(*) FROM questoes q LEFT JOIN acervo_arquivos a ON a.id = q.arquivo_origem_id WHERE q.arquivo_origem_id IS NOT NULL AND a.id IS NULL)::integer AS missing_file`
  );
  results.audit.controlledInconsistencies = {
    executedReadOnlyScript: true,
    ...controlledRows[0],
    detectedExpectedProblems: controlledRows[0].wrong_card_role === 1 && controlledRows[0].missing_file === 1
  };

  await loadStructuralBaseline(client);
  await client.query(fixturesSql);
  const exactProposalOutcome = await expectFailure(client, proposalSql, ['42601']);
  results.proposal.exactSql = exactProposalOutcome;

  const candidateProposal = proposalSql;
  await loadStructuralBaseline(client);
  await client.query(fixturesSql);
  const snapshotBeforeMigration = await tableSnapshot(client);
  const idsBefore = await queryRows(client, 'SELECT id::text, auth_user_id::text FROM perfis ORDER BY id');
  await client.query(candidateProposal);
  const snapshotAfterMigration = await tableSnapshot(client);
  const idsAfter = await queryRows(client, 'SELECT id::text, auth_user_id::text FROM perfis ORDER BY id');
  const postRows = await queryRows(
    client,
    `SELECT
       (SELECT count(*) FROM responsavel_estudante)::integer AS links,
       (SELECT count(*) FROM ciclos WHERE estudante_perfil_id IS NULL)::integer AS cycles_without_owner,
       (SELECT count(*) FROM repertorios WHERE perfil_id IS NULL)::integer AS repertoires_without_owner,
       (SELECT count(*) FROM revisoes_trimestrais WHERE estudante_perfil_id IS NULL OR registrada_por_perfil_id IS NULL)::integer AS reviews_without_owner,
       (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' AND c.contype = 'f' AND NOT c.convalidated)::integer AS unvalidated_fks`
  );
  results.proposal.exactStructuralExercise = {
    completed: true,
    preservedCounts: JSON.stringify(snapshotBeforeMigration) === JSON.stringify(snapshotAfterMigration),
    preservedProfileIds: JSON.stringify(idsBefore) === JSON.stringify(idsAfter),
    ...postRows[0]
  };

  const invalidFk = await expectFailure(
    client,
    `INSERT INTO tentativas (perfil_id, questao_id, simulado_id, alternativa_marcada, correta, segundos, confianca)
     VALUES ('10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001',
             '79999999-0000-4000-8000-000000000001', 'A', true, 10, 'certeza')`,
    ['23503']
  );
  const duplicatePeriod = await expectFailure(
    client,
    `INSERT INTO revisoes_trimestrais
       (trimestre, ano, aderencia_pct, cards_atrasados, redacoes_escritas, redacoes_reescritas,
        media_sono, conversa, decisoes, estudante_perfil_id, registrada_por_perfil_id)
     VALUES (1, 2027, 1, 0, 0, 0, 8, 'x', 'x',
             '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001')`,
    ['23505']
  );
  const legacyCycle = await expectFailure(
    client,
    "INSERT INTO ciclos (nome, ano_letivo, ativo, blocos_previstos_semana) VALUES ('Legado', 2027, false, 1)",
    ['23502']
  );
  const legacyRepertoire = await expectFailure(
    client,
    "INSERT INTO repertorios (referencia, resumo_2_linhas, temas_aplicaveis, categoria) VALUES ('r', 'r', '[]'::jsonb, 'r')",
    ['23502']
  );
  const legacyReview = await expectFailure(
    client,
    "INSERT INTO revisoes_trimestrais (trimestre, ano, aderencia_pct, cards_atrasados, redacoes_escritas, redacoes_reescritas, media_sono, conversa, decisoes) VALUES (2, 2027, 1, 0, 0, 0, 8, 'x', 'x')",
    ['23502']
  );
  await client.query(`BEGIN;
    UPDATE responsavel_estudante
    SET responsavel_perfil_id = '10000000-0000-4000-8000-000000000001',
        estudante_perfil_id = '20000000-0000-4000-8000-000000000001';
    ROLLBACK;`);
  results.proposal.constraintExercise = {
    invalidFkRejected: invalidFk,
    duplicatePeriodRejected: duplicatePeriod,
    legacyWritesRejected: {
      ciclos: legacyCycle,
      repertorios: legacyRepertoire,
      revisoesTrimestrais: legacyReview
    },
    invertedRolesInLinkAcceptedByDatabase: true
  };

  await runRejectedScenario(client, candidateProposal, 'nenhuma estudante', profileSql.responsible);
  await runRejectedScenario(client, candidateProposal, 'mais de uma estudante', `${profileSql.student}${profileSql.responsible}
    INSERT INTO perfis (id, auth_user_id, nome, email, papel) VALUES
      ('10000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'Estudante 2', 'student2@example.invalid', 'estudante');`);
  await runRejectedScenario(client, candidateProposal, 'nenhum responsavel', profileSql.student);
  await runRejectedScenario(client, candidateProposal, 'mais de um responsavel', `${profileSql.student}${profileSql.responsible}
    INSERT INTO perfis (id, auth_user_id, nome, email, papel) VALUES
      ('20000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'Responsavel 2', 'responsible2@example.invalid', 'responsavel');`);
  await runRejectedScenario(client, candidateProposal, 'colisao cruzada id/auth_user_id', `
    INSERT INTO perfis (id, auth_user_id, nome, email, papel) VALUES
      ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Estudante', 'student@example.invalid', 'estudante'),
      ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Responsavel', 'responsible@example.invalid', 'responsavel');`);
  await runRejectedScenario(client, candidateProposal, 'relacao orfa em FK proposta', `${profileSql.student}${profileSql.responsible}
    INSERT INTO disciplinas (id, nome, area, cor_hex, ordem) VALUES
      ('30000000-0000-4000-8000-000000000001', 'D', 'natureza', '#123456', 1);
    INSERT INTO topicos (id, disciplina_id, nome, serie_prevista, incidencia_enem, incidencia_uece, pre_requisito_topico_id, ordem, cobertura_material)
      VALUES ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'T', 1, 1, 1, '31999999-0000-4000-8000-000000000001', 1, 'sem_fonte');`);
  await runRejectedScenario(client, candidateProposal, 'duplicidade que impede unique', `${profileSql.student}${profileSql.responsible}
    INSERT INTO revisoes_trimestrais (id, trimestre, ano, aderencia_pct, cards_atrasados, redacoes_escritas, redacoes_reescritas, media_sono, conversa, decisoes) VALUES
      ('83000000-0000-4000-8000-000000000001', 1, 2027, 1, 0, 0, 0, 8, 'x', 'x'),
      ('83000000-0000-4000-8000-000000000002', 1, 2027, 1, 0, 0, 0, 8, 'x', 'x');`);
  await runRejectedScenario(client, candidateProposal, 'mais de um ciclo ativo', `${profileSql.student}${profileSql.responsible}
    INSERT INTO ciclos (id, nome, ano_letivo, ativo, blocos_previstos_semana) VALUES
      ('40000000-0000-4000-8000-000000000001', 'C1', 2027, true, 1),
      ('40000000-0000-4000-8000-000000000002', 'C2', 2027, true, 1);`);

  await loadStructuralBaseline(client);
  await client.query(`INSERT INTO perfis (id, auth_user_id, nome, email, papel) VALUES
    ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Estudante', 'student@example.invalid', 'estudante'),
    ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Responsavel', 'responsible@example.invalid', 'responsavel');`);
  const sameIdAccepted = await expectFailure(client, candidateProposal);
  results.negativeScenarios.push({
    name: 'id igual a auth_user_id na mesma linha',
    expected: 'rejeicao',
    passed: false,
    outcome: sameIdAccepted,
    observed: 'proposta aceitou o estado incompatível'
  });

  await loadStructuralBaseline(client);
  await client.query(`${profileSql.student}${profileSql.responsible}
    INSERT INTO checkins (perfil_id, data, horas_sono, exercicio_min, humor, energia)
      VALUES ('20000000-0000-4000-8000-000000000001', now(), 8, 0, 3, 3);`);
  const wrongOwnerAccepted = await expectFailure(client, candidateProposal);
  results.negativeScenarios.push({
    name: 'owner com papel incompatível',
    expected: 'rejeicao',
    passed: false,
    outcome: wrongOwnerAccepted,
    observed: 'proposta aceitou owner responsavel em dado da estudante'
  });

  await loadStructuralBaseline(client);
  await client.query(fixturesSql);
  const rollbackSnapshotBefore = await tableSnapshot(client);
  const rollbackIdsBefore = await queryRows(client, 'SELECT id::text FROM perfis ORDER BY id');
  await client.query(candidateProposal);
  await client.query(physicalRollbackSql);
  const rollbackSnapshotAfter = await tableSnapshot(client);
  const rollbackIdsAfter = await queryRows(client, 'SELECT id::text FROM perfis ORDER BY id');
  const rollbackShapeRows = await queryRows(
    client,
    `SELECT
       to_regclass('public.responsavel_estudante') IS NULL AS link_removed,
       NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ciclos' AND column_name = 'estudante_perfil_id') AS cycle_owner_removed`
  );
  await client.query(candidateProposal);
  const rebuiltRows = await queryRows(client, "SELECT to_regclass('public.responsavel_estudante') IS NOT NULL AS rebuilt");
  results.rollback = {
    physical: {
      executed: true,
      preservedCounts: JSON.stringify(rollbackSnapshotBefore) === JSON.stringify(rollbackSnapshotAfter),
      preservedProfileIds: JSON.stringify(rollbackIdsBefore) === JSON.stringify(rollbackIdsAfter),
      ...rollbackShapeRows[0],
      reconstructable: rebuiltRows[0].rebuilt
    },
    operational: {
      executedAsLegacyWriteProbe: true,
      compatible: false,
      reason: 'NOT NULL impede inserts da versao anterior'
    },
    backupRestore: {
      executed: false,
      reason: 'runtime isolado nao inclui pg_dump/pg_restore'
    }
  };
} finally {
  if (client) await client.end().catch(() => {});
  if (server) await server.stop().catch(() => {});
  rmSync(tempRoot, { recursive: true, force: true });
  results.cleanup = {
    stoppedDedicatedCluster: true,
    removedExactTemporaryDirectory: true,
    temporaryDataRecoverable: false
  };
}

console.log(JSON.stringify(results, null, 2));
