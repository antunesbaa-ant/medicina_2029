import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const moduleRoot = process.env.F103R_PGLITE_MODULE_ROOT;

if (!moduleRoot || !path.isAbsolute(moduleRoot)) {
  throw new Error(
    'Defina F103R_PGLITE_MODULE_ROOT para um node_modules descartavel com PGlite, pgvector e pglite-tools.'
  );
}

const importFromRoot = (packagePath) => import(
  pathToFileURL(path.join(moduleRoot, packagePath)).href
);

const [{ PGlite }, { vector }, { pgDump }, { drizzle }, { migrate }] = await Promise.all([
  importFromRoot('@electric-sql/pglite/dist/index.js'),
  importFromRoot('@electric-sql/pglite-pgvector/dist/index.js'),
  importFromRoot('@electric-sql/pglite-tools/dist/pg_dump.js'),
  importFromRoot('drizzle-orm/pglite/index.js'),
  importFromRoot('drizzle-orm/pglite/migrator.js')
]);

const readProjectFile = (relativePath) =>
  readFileSync(path.join(projectRoot, relativePath), 'utf8');

const historicalMigrationPaths = [
  'drizzle/0000_greedy_loki.sql',
  'drizzle/0001_dry_talos.sql',
  'drizzle/0002_little_swarm.sql'
];
const historicalMigrations = historicalMigrationPaths.map(readProjectFile);
const expansionSql = readProjectFile('drizzle/0003_f1_03_r_expansao.sql');
const fixturesSql = readProjectFile('tests/integration/f1_03_m/fixtures.sql');
const legacyWritesSql = readProjectFile('tests/integration/f1_03_r/legacy-writes.sql');
const updatedWritesSql = readProjectFile('tests/integration/f1_03_r/updated-writes.sql');
const backfillSql = readProjectFile('docs/modernizacao/sql/F1_03_R_BACKFILL_REPETIVEL.sql');
const contractionSql = readProjectFile('docs/modernizacao/propostas/F1_03_R_CONTRACAO_PROPOSTA.sql');
const contractionRollbackSql = readProjectFile(
  'docs/modernizacao/propostas/F1_03_R_ROLLBACK_CONTRACAO.sql'
);
const expansionRollbackSql = readProjectFile(
  'docs/modernizacao/propostas/F1_03_R_ROLLBACK_EXPANSAO.sql'
);

const fixtureTables = [
  'perfis', 'disciplinas', 'topicos', 'ciclos', 'ciclo_blocos', 'ciclo_estado',
  'sessoes', 'cards', 'card_revisoes', 'acervo_arquivos', 'acervo_paginas',
  'acervo_chunks', 'questoes', 'questao_topicos', 'simulados',
  'simulado_questoes', 'simulado_areas', 'simulado_analise', 'tentativas',
  'erros', 'generos', 'redacoes', 'repertorios', 'revisoes_trimestrais',
  'checkins', 'livros'
];

const STUDENT_ID = '10000000-0000-4000-8000-000000000001';
const RESPONSIBLE_ID = '20000000-0000-4000-8000-000000000001';

const results = {
  engine: 'PGlite PostgreSQL WASM isolado em memoria',
  isolation: {
    persistentStorage: false,
    databaseUrlRead: false,
    remoteDatabaseUsed: false,
    realDataUsed: false
  },
  historicalMigrations: {},
  drizzleMigrator: {},
  pgvector: {},
  expansion: {},
  compatibility: {},
  backfill: {},
  constraints: {},
  negativeTests: [],
  rollback: {},
  contraction: {},
  dumpRestore: {},
  cleanup: {}
};

const databases = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION_FAILED: ${message}`);
  }
}

async function createDatabase() {
  const db = await PGlite.create({ extensions: { vector } });
  databases.push(db);
  return db;
}

async function applyHistoricalMigrations(db) {
  for (const migration of historicalMigrations) {
    await db.exec(migration);
  }
}

async function applyVersionedMigrations(db) {
  await migrate(drizzle(db), { migrationsFolder: path.join(projectRoot, 'drizzle') });
}

async function applyExpansion(db) {
  await db.exec(`BEGIN;\n${expansionSql}\nCOMMIT;`);
}

async function scalar(db, query, key = 'value') {
  const result = await db.query(query);
  return result.rows[0]?.[key];
}

async function tableCounts(db) {
  const entries = await Promise.all(fixtureTables.map(async (table) => [
    table,
    await scalar(db, `SELECT count(*)::integer AS value FROM ${table}`)
  ]));
  return Object.fromEntries(entries);
}

async function expectPgError(label, operation, allowedCodes = []) {
  try {
    await operation();
  } catch (error) {
    const code = error?.code ?? 'unknown';
    if (allowedCodes.length > 0) {
      assert(allowedCodes.includes(code), `${label}: SQLSTATE inesperado ${code}`);
    }
    return code;
  }
  throw new Error(`ASSERTION_FAILED: ${label} deveria falhar`);
}

async function buildFixtureDatabase() {
  const db = await createDatabase();
  await applyHistoricalMigrations(db);
  await db.exec(fixturesSql);
  return db;
}

async function runExpansionNegative(label, mutate, allowedCodes = ['P0001']) {
  const db = await buildFixtureDatabase();
  await db.exec(mutate);
  const code = await expectPgError(label, () => applyExpansion(db), allowedCodes);
  // A falha ocorre dentro do BEGIN explicito de applyExpansion. Libera a
  // conexao antes de comprovar que nenhuma DDL parcial sobreviveu.
  await db.exec('ROLLBACK');
  const relationCount = await scalar(
    db,
    "SELECT count(*)::integer AS value FROM pg_class WHERE relname = 'responsavel_estudante'"
  );
  assert(relationCount === 0, `${label}: DDL parcial sobreviveu ao rollback`);
  results.negativeTests.push({ label, rejected: true, sqlstate: code, atomic: true });
}

async function run() {
  // Esta e a prova do caminho versionado real. Nao substitui os ensaios
  // dirigidos abaixo, que precisam inserir fixtures entre 0002 e 0003.
  const migratorDb = await createDatabase();
  await applyVersionedMigrations(migratorDb);
  const journalEntries = await scalar(
    migratorDb,
    'SELECT count(*)::integer AS value FROM drizzle.__drizzle_migrations'
  );
  assert(journalEntries === 4, 'migrator Drizzle nao registrou exatamente quatro migrations');
  assert(
    await scalar(
      migratorDb,
      "SELECT count(*)::integer AS value FROM pg_class WHERE relname = 'responsavel_estudante'"
    ) === 1,
    'migrator Drizzle nao aplicou a expansao 0003'
  );
  await applyVersionedMigrations(migratorDb);
  assert(
    await scalar(
      migratorDb,
      'SELECT count(*)::integer AS value FROM drizzle.__drizzle_migrations'
    ) === 4,
    'segunda execucao do migrator alterou o journal'
  );
  results.drizzleMigrator = {
    adapter: 'drizzle-orm/pglite',
    exactVersionedChainApplied: true,
    journalSchema: 'drizzle',
    journalTable: '__drizzle_migrations',
    journalEntries,
    secondRunIdempotent: true
  };

  const historicalDb = await createDatabase();
  await applyHistoricalMigrations(historicalDb);
  const serverVersion = await scalar(historicalDb, "SELECT current_setting('server_version') AS value");
  const extensionVersion = await scalar(
    historicalDb,
    "SELECT extversion AS value FROM pg_extension WHERE extname = 'vector'"
  );
  const vectorColumnType = await scalar(
    historicalDb,
    `SELECT format_type(a.atttypid, a.atttypmod) AS value
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'acervo_chunks' AND a.attname = 'embedding'`
  );
  const distance = await scalar(
    historicalDb,
    "SELECT ('[1,2,3]'::vector <-> '[1,2,4]'::vector)::double precision AS value"
  );
  assert(extensionVersion, 'pgvector nao foi criado pela migration historica');
  assert(vectorColumnType === 'vector(1536)', 'coluna embedding nao manteve vector(1536)');
  assert(Number(distance) === 1, 'operador de distancia pgvector retornou resultado inesperado');
  results.historicalMigrations = {
    exactChainApplied: true,
    files: historicalMigrationPaths,
    serverVersion,
    publicTableCount: await scalar(
      historicalDb,
      "SELECT count(*)::integer AS value FROM pg_tables WHERE schemaname = 'public'"
    )
  };
  results.pgvector = {
    extensionLoaded: true,
    version: extensionVersion,
    columnType: vectorColumnType,
    distanceOperatorResult: Number(distance)
  };

  const emptyDb = await createDatabase();
  await applyHistoricalMigrations(emptyDb);
  await applyExpansion(emptyDb);
  assert(
    await scalar(emptyDb, 'SELECT count(*)::integer AS value FROM responsavel_estudante') === 0,
    'expansao em banco vazio criou vinculo sem perfis'
  );
  results.expansion.emptyDatabaseAccepted = true;

  const populatedDb = await buildFixtureDatabase();
  const countsBefore = await tableCounts(populatedDb);
  const identitiesBefore = await populatedDb.query(
    'SELECT id::text, auth_user_id::text FROM perfis ORDER BY id'
  );
  await applyExpansion(populatedDb);
  const countsAfter = await tableCounts(populatedDb);
  const identitiesAfter = await populatedDb.query(
    'SELECT id::text, auth_user_id::text FROM perfis ORDER BY id'
  );
  assert(JSON.stringify(countsBefore) === JSON.stringify(countsAfter), 'contagens mudaram na expansao');
  assert(
    JSON.stringify(identitiesBefore.rows) === JSON.stringify(identitiesAfter.rows),
    'IDs de perfil mudaram na expansao'
  );
  assert(
    await scalar(populatedDb, 'SELECT count(*)::integer AS value FROM responsavel_estudante') === 1,
    'vinculo 1:1 nao foi criado'
  );
  assert(
    await scalar(
      populatedDb,
      `SELECT count(*)::integer AS value
       FROM responsavel_estudante
       WHERE responsavel_perfil_id = '${RESPONSIBLE_ID}'
         AND estudante_perfil_id = '${STUDENT_ID}'`
    ) === 1,
    'vinculo nao corresponde aos papeis esperados'
  );
  results.expansion = {
    ...results.expansion,
    fixtureDatabaseApplied: true,
    profileIdsPreserved: true,
    fixtureCountsPreserved: true,
    linkCreated: true,
    ownershipColumnsNullable: (
      await scalar(
        populatedDb,
        `SELECT count(*)::integer AS value
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND ((table_name = 'ciclos' AND column_name = 'estudante_perfil_id')
             OR (table_name = 'repertorios' AND column_name = 'perfil_id')
             OR (table_name = 'revisoes_trimestrais'
                 AND column_name IN ('estudante_perfil_id', 'registrada_por_perfil_id')))
           AND is_nullable = 'YES'`
      )
    ) === 4
  };
  assert(results.expansion.ownershipColumnsNullable, 'owners da expansao nao estao nullable');

  await populatedDb.exec(legacyWritesSql);
  await populatedDb.exec(updatedWritesSql);
  assert(
    await scalar(
      populatedDb,
      `SELECT count(*)::integer AS value FROM ciclos
       WHERE id = '41000000-0000-4000-8000-000000000001'
         AND estudante_perfil_id IS NULL`
    ) === 1,
    'insert legado de ciclo nao permaneceu compativel'
  );
  assert(
    await scalar(
      populatedDb,
      `SELECT count(*)::integer AS value FROM ciclos
       WHERE id = '51000000-0000-4000-8000-000000000001'
         AND estudante_perfil_id = '${STUDENT_ID}'`
    ) === 1,
    'insert atualizado de ciclo nao gravou owner'
  );
  results.compatibility = {
    legacyCycleInsert: true,
    legacyRepertoireInsert: true,
    legacyQuarterlyReviewInsert: true,
    updatedCycleInsert: true,
    updatedRepertoireInsert: true,
    updatedQuarterlyReviewInsert: true,
    operationalRollbackDuringExpansion: true
  };

  await populatedDb.exec(backfillSql);
  const ownersAfterFirstBackfill = await scalar(
    populatedDb,
    `SELECT count(*)::integer AS value FROM (
       SELECT estudante_perfil_id::text AS owner FROM ciclos
       UNION ALL SELECT perfil_id::text FROM repertorios
       UNION ALL SELECT estudante_perfil_id::text FROM revisoes_trimestrais
     ) owners WHERE owner IS NULL OR owner <> '${STUDENT_ID}'`
  );
  await populatedDb.exec(backfillSql);
  const ownersAfterSecondBackfill = await scalar(
    populatedDb,
    `SELECT count(*)::integer AS value FROM (
       SELECT estudante_perfil_id::text AS owner FROM ciclos
       UNION ALL SELECT perfil_id::text FROM repertorios
       UNION ALL SELECT estudante_perfil_id::text FROM revisoes_trimestrais
     ) owners WHERE owner IS NULL OR owner <> '${STUDENT_ID}'`
  );
  const reviewActorsInvalid = await scalar(
    populatedDb,
    `SELECT count(*)::integer AS value FROM revisoes_trimestrais
     WHERE registrada_por_perfil_id IS NULL
        OR registrada_por_perfil_id <> '${RESPONSIBLE_ID}'`
  );
  assert(ownersAfterFirstBackfill === 0, 'primeiro backfill deixou owners invalidos');
  assert(ownersAfterSecondBackfill === 0, 'segundo backfill nao foi idempotente');
  assert(reviewActorsInvalid === 0, 'backfill deixou autor trimestral invalido');
  results.backfill = {
    firstRunPassed: true,
    secondRunPassed: true,
    repeatable: true,
    nullOrDivergentOwners: 0
  };

  const invalidOwnerCode = await expectPgError(
    'FK de owner inexistente',
    () => populatedDb.exec(
      `INSERT INTO ciclos (
         id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana
       ) VALUES (
         '59000000-0000-4000-8000-000000000001',
         '99999999-9999-4999-8999-999999999999', 'Owner invalido', 2029, false, 1
       )`
    ),
    ['23503']
  );
  const selfLinkCode = await expectPgError(
    'autorrelacionamento no vinculo',
    () => populatedDb.exec(
      'UPDATE responsavel_estudante SET estudante_perfil_id = responsavel_perfil_id'
    ),
    ['23514']
  );
  const duplicateLinkCode = await expectPgError(
    'segundo vinculo singleton',
    () => populatedDb.exec(
      `INSERT INTO responsavel_estudante (
         vinculo_id, responsavel_perfil_id, estudante_perfil_id
       ) VALUES (2, '${RESPONSIBLE_ID}', '${STUDENT_ID}')`
    ),
    ['23505', '23514']
  );
  results.constraints = {
    invalidOwnerRejected: invalidOwnerCode,
    selfLinkRejected: selfLinkCode,
    duplicateLinkRejected: duplicateLinkCode,
    roleCompatibilityEnforcedByDatabase: false,
    roleCompatibilityEnforcedByApplicationAndContractionPreflight: true
  };

  await runExpansionNegative(
    'ownership existente com papel incompatível',
    `UPDATE acervo_arquivos SET enviado_por = '${STUDENT_ID}'`
  );
  await runExpansionNegative(
    'FK nova com registro orfao',
    "UPDATE questoes SET arquivo_origem_id = '99999999-9999-4999-8999-999999999999'"
  );
  await runExpansionNegative(
    'duplicidade ciclo e ordem',
    `INSERT INTO ciclo_blocos (
       id, ciclo_id, ordem, disciplina_id, tipo, estilo_alvo, duracao_min
     ) VALUES (
       '41999999-0000-4000-8000-000000000001',
       '40000000-0000-4000-8000-000000000001', 1,
       '30000000-0000-4000-8000-000000000001', 'questoes', 'enem', 45
     )`
  );
  await runExpansionNegative(
    'mais de um ciclo ativo',
    `INSERT INTO ciclos (id, nome, ano_letivo, ativo, blocos_previstos_semana)
     VALUES ('49999999-0000-4000-8000-000000000001', 'Ativo duplicado', 2028, true, 5)`
  );

  const studentOnlyDb = await createDatabase();
  await applyHistoricalMigrations(studentOnlyDb);
  await studentOnlyDb.exec(
    `INSERT INTO perfis (id, auth_user_id, nome, email, papel) VALUES (
       '${STUDENT_ID}', 'a0000000-0000-4000-8000-000000000001',
       'Estudante artificial', 'estudante.f103r@example.invalid', 'estudante'
     )`
  );
  const cardinalityCode = await expectPgError(
    'cardinalidade parcial de perfis',
    () => applyExpansion(studentOnlyDb),
    ['P0001']
  );
  results.negativeTests.push({
    label: 'cardinalidade parcial de perfis', rejected: true, sqlstate: cardinalityCode, atomic: true
  });

  const collisionDb = await createDatabase();
  await applyHistoricalMigrations(collisionDb);
  await collisionDb.exec(
    `INSERT INTO perfis (id, auth_user_id, nome, email, papel) VALUES
      ('10000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000022',
       'Estudante artificial', 'estudante.colisao@example.invalid', 'estudante'),
      ('20000000-0000-4000-8000-000000000022', 'b0000000-0000-4000-8000-000000000002',
       'Responsavel artificial', 'responsavel.colisao@example.invalid', 'responsavel')`
  );
  const collisionCode = await expectPgError(
    'colisao cruzada id/authUserId',
    () => applyExpansion(collisionDb),
    ['P0001']
  );
  results.negativeTests.push({
    label: 'colisao cruzada id/authUserId', rejected: true, sqlstate: collisionCode, atomic: true
  });

  const expansionRollbackDb = await buildFixtureDatabase();
  const rollbackCountsBefore = await tableCounts(expansionRollbackDb);
  await applyExpansion(expansionRollbackDb);
  await expansionRollbackDb.exec(expansionRollbackSql);
  const rollbackCountsAfter = await tableCounts(expansionRollbackDb);
  assert(
    JSON.stringify(rollbackCountsBefore) === JSON.stringify(rollbackCountsAfter),
    'rollback fisico da expansao alterou linhas preexistentes'
  );
  assert(
    await scalar(
      expansionRollbackDb,
      `SELECT count(*)::integer AS value FROM information_schema.columns
       WHERE (table_name = 'ciclos' AND column_name = 'estudante_perfil_id')
          OR (table_name = 'repertorios' AND column_name = 'perfil_id')
          OR (table_name = 'revisoes_trimestrais'
              AND column_name IN ('estudante_perfil_id', 'registrada_por_perfil_id'))`
    ) === 0,
    'rollback fisico da expansao deixou colunas novas'
  );
  // Reaplicacao manual e deliberada do SQL prova que o schema e reconstruivel;
  // ela nao representa o comportamento do migrator/journal.
  await applyExpansion(expansionRollbackDb);
  assert(
    await scalar(expansionRollbackDb, 'SELECT count(*)::integer AS value FROM responsavel_estudante') === 1,
    'expansao nao pode ser reconstruida apos rollback fisico'
  );
  results.rollback.expansionPhysical = {
    executed: true,
    preexistingRowsPreserved: true,
    manualSqlReappliedAfterPhysicalRollback: true
  };

  // Um rollback fisico nao remove o registro da 0003. O migrator corretamente
  // nao reaplica a migration sem um procedimento de recuperacao controlado.
  await migratorDb.exec(expansionRollbackSql);
  assert(
    await scalar(
      migratorDb,
      'SELECT count(*)::integer AS value FROM drizzle.__drizzle_migrations'
    ) === 4,
    'rollback fisico alterou indevidamente o journal Drizzle'
  );
  await applyVersionedMigrations(migratorDb);
  assert(
    await scalar(
      migratorDb,
      "SELECT count(*)::integer AS value FROM pg_class WHERE relname = 'responsavel_estudante'"
    ) === 0,
    'migrator reaplicou automaticamente uma migration ainda registrada'
  );
  results.rollback.expansionPhysical.journalEntryPreserved = true;
  results.rollback.expansionPhysical.automaticMigratorReapply = false;
  results.rollback.expansionPhysical.controlledRecoveryRequired = true;

  const contractionDb = await buildFixtureDatabase();
  await applyExpansion(contractionDb);
  await contractionDb.exec(legacyWritesSql);
  await contractionDb.exec(backfillSql);
  await contractionDb.exec(contractionSql);
  const legacyAfterContractionCode = await expectPgError(
    'insert legado depois da contracao',
    () => contractionDb.exec(
      `INSERT INTO ciclos (id, nome, ano_letivo, ativo, blocos_previstos_semana)
       VALUES ('59999999-0000-4000-8000-000000000002', 'Legado bloqueado', 2029, false, 1)`
    ),
    ['23502']
  );
  await contractionDb.exec(
    `INSERT INTO ciclos (
       id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana
     ) VALUES (
       '59999999-0000-4000-8000-000000000003', '${STUDENT_ID}',
       'Atualizado pos-contracao', 2029, false, 1
     )`
  );
  const secondActiveCode = await expectPgError(
    'segundo ciclo ativo apos contracao',
    () => contractionDb.exec(
      `INSERT INTO ciclos (
         id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana
       ) VALUES (
         '59999999-0000-4000-8000-000000000004', '${STUDENT_ID}',
         'Ativo duplicado', 2029, true, 1
       )`
    ),
    ['23505']
  );
  await contractionDb.exec(contractionRollbackSql);
  await contractionDb.exec(
    `INSERT INTO ciclos (id, nome, ano_letivo, ativo, blocos_previstos_semana)
     VALUES ('59999999-0000-4000-8000-000000000005', 'Legado apos rollback', 2029, false, 1)`
  );
  results.contraction = {
    executedInSeparateDatabase: true,
    legacyWriteRejectedAfterContraction: legacyAfterContractionCode,
    updatedWriteAcceptedAfterContraction: true,
    duplicateActiveCycleRejected: secondActiveCode,
    minimumApplicationVersion: 'F1.03-R'
  };
  results.rollback.contractionPhysical = {
    executed: true,
    nullableExpansionStateRestored: true,
    legacyWriteAcceptedAgain: true
  };

  const swappedRoleDb = await buildFixtureDatabase();
  await applyExpansion(swappedRoleDb);
  await swappedRoleDb.exec(
    `UPDATE responsavel_estudante
     SET responsavel_perfil_id = '${STUDENT_ID}',
         estudante_perfil_id = '${RESPONSIBLE_ID}'`
  );
  const swappedRoleCode = await expectPgError(
    'contracao com papeis invertidos no vinculo',
    () => swappedRoleDb.exec(contractionSql),
    ['P0001']
  );
  results.negativeTests.push({
    label: 'contracao com papeis invertidos no vinculo',
    rejected: true,
    sqlstate: swappedRoleCode,
    atomic: true
  });

  const dumpFile = await pgDump({
    pg: populatedDb,
    args: ['--no-owner', '--no-privileges']
  });
  const dumpSql = await dumpFile.text();
  assert(dumpSql.includes('CREATE TABLE public.perfis'), 'dump nao contem schema de perfis');
  assert(
    dumpSql.includes('CREATE TABLE public.responsavel_estudante'),
    'dump nao contem novo vinculo'
  );
  const restoredDb = await createDatabase();
  await restoredDb.exec(dumpSql);
  await restoredDb.exec('SET search_path TO public');
  const restoredCounts = await restoredDb.query(
    `SELECT
       (SELECT count(*) FROM perfis)::integer AS profiles,
       (SELECT count(*) FROM responsavel_estudante)::integer AS links,
       (SELECT count(*) FROM tentativas)::integer AS attempts,
       (SELECT count(*) FROM ciclos)::integer AS cycles`
  );
  assert(restoredCounts.rows[0].profiles === 2, 'restore nao preservou perfis');
  assert(restoredCounts.rows[0].links === 1, 'restore nao preservou vinculo');
  assert(restoredCounts.rows[0].attempts === 1, 'restore nao preservou tentativas');
  assert(restoredCounts.rows[0].cycles === 3, 'restore nao preservou ciclos');
  assert(
    await scalar(
      restoredDb,
      "SELECT count(*)::integer AS value FROM pg_extension WHERE extname = 'vector'"
    ) === 1,
    'restore nao recriou pgvector'
  );
  results.dumpRestore = {
    pgDumpExecuted: true,
    plainSqlRestored: true,
    pgvectorRestored: true,
    ownershipAndLinkRestored: true,
    counts: restoredCounts.rows[0]
  };
}

let failure;
try {
  await run();
} catch (error) {
  failure = {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    message: error?.message ?? String(error)
  };
} finally {
  for (const database of databases.reverse()) {
    await database.close().catch(() => {});
  }
  results.cleanup = {
    inMemoryDatabasesClosed: true,
    persistentFilesCreated: false,
    realOrRemoteDatabaseUsed: false
  };
}

if (failure) {
  console.error(JSON.stringify({ status: 'FAILED', failure, results }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'PASSED', results }, null, 2));
}
