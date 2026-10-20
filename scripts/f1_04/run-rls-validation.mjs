// ============================================================================
// MEDICINA 2029 — F1.04
// RLS & Views Security Validation Runner
// ============================================================================
// Validação automatizada em ambiente PostgreSQL 18.6 isolado e descartável (PGlite WASM)
// com pgvector e papéis de privilégio mínimo (NOBYPASSRLS).
//
// Cobre as Etapas 8, 9, 10 e 11 + Revisões F1.04-R e F1.04-C:
// - Migrations históricas (0000, 0001, 0002)
// - Expansão compatível F1.03-R (0003_f1_03_r_expansao.sql)
// - Proposta RLS F1.04-C (F1_04_RLS_PROPOSTA.sql)
// - Fixtures artificiais de teste (tests/integration/f1_04/fixtures.sql)
// - Validação das 18 situações de segurança da Etapa 9 (1 a 18)
// - Validação dos 8 cenários de auditoria F1.04-R (R1 a R8)
// - Validação dos 15 cenários de conformidade e privilégios F1.04-C (C1 a C15)
// - Total de 41 cenários de segurança, privilégios mínimos e isolamento
// - Rollback atômico e re-aplicação (F1_04_ROLLBACK_RLS.sql)
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const moduleRoot = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';

if (!existsSync(moduleRoot)) {
  throw new Error(
    `Diretório de módulos isolados não encontrado em ${moduleRoot}. Instale @electric-sql/pglite em diretório temporário fora do repositório.`
  );
}

const importFromRoot = (pkgPath) => import(pathToFileURL(path.join(moduleRoot, pkgPath)).href);

const [{ PGlite }, { vector }] = await Promise.all([
  importFromRoot('@electric-sql/pglite/dist/index.js'),
  importFromRoot('@electric-sql/pglite-pgvector/dist/index.js')
]);

const readProjectFile = (relPath) => readFileSync(path.join(projectRoot, relPath), 'utf8');

// Arquivos SQL do pipeline
const sql0000 = readProjectFile('drizzle/0000_greedy_loki.sql');
const sql0001 = readProjectFile('drizzle/0001_dry_talos.sql');
const sql0002 = readProjectFile('drizzle/0002_little_swarm.sql');
const sql0003 = readProjectFile('drizzle/0003_f1_03_r_expansao.sql');
const sqlProposal = readProjectFile('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql');
const sqlRollback = readProjectFile('docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql');
const sqlFixtures = readProjectFile('tests/integration/f1_04/fixtures.sql');

// Constantes de Identidade (Fixtures Artificiais - example.invalid)
const S1_ID = '10000000-0000-4000-8000-000000000001'; // Estudante 1
const R1_ID = '20000000-0000-4000-8000-000000000001'; // Responsável 1 (vinculado a Estudante 1)
const S2_ID = '10000000-0000-4000-8000-000000000002'; // Estudante 2 (cross-tenant)
const R2_ID = '20000000-0000-4000-8000-000000000002'; // Responsável 2 (sem vínculo com Estudante 1)

// Relatório estruturado de resultados
const testResults = {
  timestamp: new Date().toISOString(),
  environment: {
    engine: 'PGlite PostgreSQL 18.6 (WASM)',
    extensions: ['vector 0.8.7'],
    storage: 'Em memória (descartável)',
    productionAccessed: false,
    realDataUsed: false
  },
  migrations: {},
  scenarios: [],
  rollback: {},
  summary: {
    total: 0,
    passed: 0,
    failed: 0
  }
};

function recordTest(scenarioNumber, title, passed, details) {
  testResults.summary.total++;
  if (passed) {
    testResults.summary.passed++;
    console.log(`  [PASS] Cenário ${scenarioNumber}: ${title}`);
  } else {
    testResults.summary.failed++;
    console.error(`  [FAIL] Cenário ${scenarioNumber}: ${title} — ${details.error || 'Falha de asserção'}`);
  }
  testResults.scenarios.push({
    scenario: scenarioNumber,
    title,
    passed,
    details
  });
}

async function runValidation() {
  console.log('====================================================================');
  console.log('MEDICINA 2029 — SUÍTE DE TESTES RLS E PROTEÇÃO POSTGRESQL (F1.04)');
  console.log('====================================================================\n');

  console.log('1. Inicializando instância isolada do PostgreSQL em memória...');
  const db = await PGlite.create({ extensions: { vector } });

  try {
    // ------------------------------------------------------------------------
    // ETAPA 8: APLICAÇÃO DO SCHEMA, PROPOSTA RLS E FIXTURES
    // ------------------------------------------------------------------------
    console.log('2. Aplicando migrações históricas e expansão...');
    await db.exec(sql0000);
    await db.exec(sql0001);
    await db.exec(sql0002);
    await db.exec(sql0003);
    testResults.migrations.historicalAndExpansion = 'OK';
    console.log('   Migrations 0000-0003 aplicadas com sucesso.');

    console.log('3. Aplicando Proposta RLS e Views (F1_04_RLS_PROPOSTA.sql)...');
    await db.exec(sqlProposal);
    testResults.migrations.rlsProposal = 'OK';
    console.log('   Proposta RLS aplicada com sucesso.');

    console.log('4. Aplicando Fixtures de Teste (tests/integration/f1_04/fixtures.sql)...');
    await db.exec(sqlFixtures);
    testResults.migrations.fixtures = 'OK';
    console.log('   Fixtures aplicadas com sucesso.\n');

    // ------------------------------------------------------------------------
    // PREPARAÇÃO DE PAPEL DE MÍNIMO PRIVILÉGIO (medicina_app)
    // ------------------------------------------------------------------------
    console.log('5. Ativando papel medicina_app (NOBYPASSRLS, NOSUPERUSER)...');
    await db.exec('SET ROLE medicina_app;');
    const whoami = await db.query('SELECT current_user, session_user;');
    console.log(`   Usuário ativo no PostgreSQL: ${whoami.rows[0].current_user} (session: ${whoami.rows[0].session_user})\n`);

    console.log('====================================================================');
    console.log('EXECUTANDO A MATRIZ DE 18 SITUAÇÕES DE SEGURANÇA (ETAPA 9)');
    console.log('====================================================================\n');

    // Helper para rodar query transacional com contexto
    async function queryWithContext(perfilId, papel, queryFn) {
      return await db.transaction(async (tx) => {
        if (perfilId && papel) {
          await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [perfilId, papel]);
        }
        return await queryFn(tx);
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 1: Usuário não autenticado (sem contexto) -> fail-closed (0 linhas)
    // ------------------------------------------------------------------------
    {
      const resSessoes = await db.query('SELECT * FROM sessoes;');
      const resCards = await db.query('SELECT * FROM cards;');
      const resRedacoes = await db.query('SELECT * FROM redacoes;');
      const resCheckins = await db.query('SELECT * FROM checkins;');
      const passed = resSessoes.rows.length === 0 &&
                     resCards.rows.length === 0 &&
                     resRedacoes.rows.length === 0 &&
                     resCheckins.rows.length === 0;
      recordTest(1, 'Usuário não autenticado (sem contexto) -> bloqueado por padrão (0 linhas)', passed, {
        sessoesRows: resSessoes.rows.length,
        cardsRows: resCards.rows.length,
        redacoesRows: resRedacoes.rows.length,
        checkinsRows: resCheckins.rows.length
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 2: Estudante autenticada -> lê e escreve apenas seus dados pessoais e conteúdos aprovados
    // ------------------------------------------------------------------------
    {
      let s1SessoesCount = 0;
      let s1CardsCount = 0;
      let s1MateriaisCount = 0;
      let insertSuccess = false;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
        const sessoes = await tx.query('SELECT * FROM sessoes;');
        s1SessoesCount = sessoes.rows.length;

        const cards = await tx.query('SELECT * FROM cards;');
        s1CardsCount = cards.rows.length;

        const mat = await tx.query('SELECT * FROM materiais;');
        s1MateriaisCount = mat.rows.length;

        // Escrita legítima de nova sessão
        const novoId = '42000000-0000-4000-8000-000000000099';
        await tx.query(`
          INSERT INTO sessoes (
            id, perfil_id, ciclo_bloco_id, topico_id, iniciada_em, encerrada_em,
            segundos_efetivos, segundos_pausa, etapa_atingida, concluida, nota_livre
          ) VALUES (
            $1, $2, '41000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001',
            now(), now() + interval '50 min', 3000, 0, 'registro', true, 'Nova sessao legitima S1'
          );
        `, [novoId, S1_ID]);
        insertSuccess = true;
      });

      const passed = s1SessoesCount === 1 && s1CardsCount === 1 && s1MateriaisCount === 1 && insertSuccess;
      recordTest(2, 'Estudante autenticada -> lê e escreve seus dados pessoais e conteúdos aprovados', passed, {
        sessoesLidas: s1SessoesCount,
        cardsLidos: s1CardsCount,
        materiaisLidos: s1MateriaisCount,
        escritaLegitimaAceita: insertSuccess
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 3: Responsável autenticado -> acervo próprio, curadoria, views agregadas; NÃO lê sessões brutas
    // ------------------------------------------------------------------------
    {
      let sessoesBrutasLidas = -1;
      let acervoArquivosLidos = -1;
      let curadoriaLida = -1;
      let viewAgregadaLida = -1;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [R1_ID, 'responsavel']);
        
        // Bloqueio de vigilância (Princípio 1.2 da ESPEC)
        const sess = await tx.query('SELECT * FROM sessoes;');
        sessoesBrutasLidas = sess.rows.length;

        // Acervo que o próprio responsável enviou
        const acervo = await tx.query('SELECT * FROM acervo_arquivos;');
        acervoArquivosLidos = acervo.rows.length;

        // Fila de curadoria
        const cur = await tx.query('SELECT * FROM curadoria_fila;');
        curadoriaLida = cur.rows.length;

        // View agregada quinzenal
        const view = await tx.query('SELECT * FROM vw_acompanhamento_quinzenal;');
        viewAgregadaLida = view.rows.length;
      });

      const passed = sessoesBrutasLidas === 0 && acervoArquivosLidos === 1 && curadoriaLida >= 1 && viewAgregadaLida === 2;
      recordTest(3, 'Responsável autenticado -> lê acervo próprio e view agregada; zero sessões brutas', passed, {
        sessoesBrutas: sessoesBrutasLidas,
        acervoArquivos: acervoArquivosLidos,
        curadoriaFila: curadoriaLida,
        quinzenasAgregadas: viewAgregadaLida
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 4: Identidade sem vínculo autorizado -> responsável 2 não lê dados da estudante 1
    // ------------------------------------------------------------------------
    {
      let viewR2Rows = [];
      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [R2_ID, 'responsavel']);
        const view = await tx.query('SELECT * FROM vw_acompanhamento_quinzenal;');
        viewR2Rows = view.rows;
      });

      // R2 não tem vínculo em responsavel_estudante -> current_managed_estudante_id() é NULL -> 0 linhas
      const passed = viewR2Rows.length === 0;
      recordTest(4, 'Identidade sem vínculo autorizado -> responsável 2 não lê dados da estudante 1', passed, {
        linhasViewResponsavelNaoVinculado: viewR2Rows.length
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 5: Acesso a registros de outro perfil -> estudante 1 tenta ler registros da estudante 2 -> 0 linhas
    // ------------------------------------------------------------------------
    {
      let sessoesOutroPerfil = -1;
      let cardsOutroPerfil = -1;
      let redacoesOutroPerfil = -1;
      let checkinsOutroPerfil = -1;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
        const s = await tx.query('SELECT * FROM sessoes WHERE perfil_id = $1;', [S2_ID]);
        sessoesOutroPerfil = s.rows.length;

        const c = await tx.query('SELECT * FROM cards WHERE perfil_id = $1;', [S2_ID]);
        cardsOutroPerfil = c.rows.length;

        const r = await tx.query('SELECT * FROM redacoes WHERE perfil_id = $1;', [S2_ID]);
        redacoesOutroPerfil = r.rows.length;

        const ch = await tx.query('SELECT * FROM checkins WHERE perfil_id = $1;', [S2_ID]);
        checkinsOutroPerfil = ch.rows.length;
      });

      const passed = sessoesOutroPerfil === 0 && cardsOutroPerfil === 0 && redacoesOutroPerfil === 0 && checkinsOutroPerfil === 0;
      recordTest(5, 'Acesso a registros de outro perfil -> estudante 1 tenta ler registros de estudante 2 -> zero linhas', passed, {
        sessoesE2: sessoesOutroPerfil,
        cardsE2: cardsOutroPerfil,
        redacoesE2: redacoesOutroPerfil,
        checkinsE2: checkinsOutroPerfil
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 6: Tentativa de INSERT com owner falso -> rejeitado por WITH CHECK
    // ------------------------------------------------------------------------
    {
      let rejected = false;
      let errorCode = null;

      try {
        await db.transaction(async (tx) => {
          await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
          // Estudante 1 tenta inserir sessão atribuindo perfil_id da Estudante 2
          await tx.query(`
            INSERT INTO sessoes (
              id, perfil_id, ciclo_bloco_id, topico_id, iniciada_em, encerrada_em,
              segundos_efetivos, segundos_pausa, etapa_atingida, concluida, nota_livre
            ) VALUES (
              '42000000-0000-4000-8000-000000000066', $1, '41000000-0000-4000-8000-000000000001',
              '31000000-0000-4000-8000-000000000001', now(), now() + interval '30 min',
              1800, 0, 'registro', true, 'Sessao forjada'
            );
          `, [S2_ID]);
        });
      } catch (err) {
        rejected = true;
        errorCode = err.code;
      }

      const passed = rejected && errorCode === '42501';
      recordTest(6, 'Tentativa de INSERT com owner falso -> rejeitado por WITH CHECK (erro 42501)', passed, {
        rejeitado: rejected,
        codigoErro: errorCode
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 7: Tentativa de UPDATE indevido -> zero linhas afetadas ou erro
    // ------------------------------------------------------------------------
    {
      let rowsAffected = -1;
      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
        // Tenta alterar nota_livre da sessão da Estudante 2
        const res = await tx.query(`
          UPDATE sessoes
          SET nota_livre = 'Tentativa de alteracao indevida'
          WHERE perfil_id = $1;
        `, [S2_ID]);
        rowsAffected = res.affectedRows ?? 0;
      });

      const passed = rowsAffected === 0;
      recordTest(7, 'Tentativa de UPDATE indevido -> zero linhas afetadas', passed, {
        linhasAfetadas: rowsAffected
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 8: Tentativa de DELETE indevido -> zero linhas afetadas ou erro
    // ------------------------------------------------------------------------
    {
      let rowsAffected = -1;
      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
        // Tenta deletar sessão pertencente à Estudante 2
        const res = await tx.query(`
          DELETE FROM sessoes
          WHERE perfil_id = $1;
        `, [S2_ID]);
        rowsAffected = res.affectedRows ?? 0;
      });

      const passed = rowsAffected === 0;
      recordTest(8, 'Tentativa de DELETE indevido -> zero linhas afetadas', passed, {
        linhasAfetadas: rowsAffected
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 9: Leitura de conteúdos não aprovados -> estudante não lê materiais/questões rascunho
    // ------------------------------------------------------------------------
    {
      let materiaisLidos = [];
      let questoesLidas = [];
      let perguntasLidas = [];

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
        const m = await tx.query('SELECT id, status FROM materiais;');
        materiaisLidos = m.rows;

        const q = await tx.query('SELECT id, status FROM questoes;');
        questoesLidas = q.rows;

        const p = await tx.query('SELECT id, status FROM perguntas_ativas;');
        perguntasLidas = p.rows;
      });

      const materiaisAprovadosApenas = materiaisLidos.length === 1 && materiaisLidos[0].status === 'aprovado';
      const questoesAprovadasApenas = questoesLidas.length === 1 && questoesLidas[0].status === 'aprovado';
      const perguntasAprovadasApenas = perguntasLidas.length === 1 && perguntasLidas[0].status === 'aprovado';

      const passed = materiaisAprovadosApenas && questoesAprovadasApenas && perguntasAprovadasApenas;
      recordTest(9, 'Leitura de conteúdos não aprovados -> estudante não lê materiais/questões rascunho', passed, {
        materiaisRetornados: materiaisLidos,
        questoesRetornadas: questoesLidas,
        perguntasRetornadas: perguntasLidas
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 10: Consulta de indicadores agregados -> responsável consulta view agregada com sucesso
    // ------------------------------------------------------------------------
    {
      let viewRows = [];
      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [R1_ID, 'responsavel']);
        const res = await tx.query('SELECT * FROM vw_acompanhamento_quinzenal;');
        viewRows = res.rows;
      });

      const passed = viewRows.length === 2 &&
                     Number(viewRows[0].blocos_concluidos) >= 1 &&
                     Number(viewRows[0].media_horas_sono) > 0;
      recordTest(10, 'Consulta de indicadores agregados -> responsável consulta view agregada com sucesso', passed, {
        quinzenasRetornadas: viewRows.length,
        quinzenaMaisRecente: viewRows[0]
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 11: Acesso a dados de autenticação -> password_hash não é exposto indevidamente
    // ------------------------------------------------------------------------
    {
      let viewPerfisColunas = [];
      let hashVazado = true;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
        const res = await tx.query('SELECT * FROM vw_perfis;');
        if (res.rows.length > 0) {
          viewPerfisColunas = Object.keys(res.rows[0]);
          hashVazado = 'password_hash' in res.rows[0];
        }
      });

      const passed = !hashVazado && !viewPerfisColunas.includes('password_hash');
      recordTest(11, 'Acesso a dados de autenticação -> password_hash não é exposto na view de perfis', passed, {
        colunasExpostasNaView: viewPerfisColunas,
        campoPasswordHashOmitido: !hashVazado
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 12: Tentativa de contornar policies via subqueries ou joins -> rejeitado pelo RLS
    // ------------------------------------------------------------------------
    {
      let joinRows = -1;
      let subqueryRows = -1;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);

        // Tentativa 1: Join malicioso tentando ler dados da Estudante 2
        const j = await tx.query(`
          SELECT s.id, s.nota_livre
          FROM sessoes s
          JOIN perfis p ON p.id = s.perfil_id
          WHERE s.perfil_id = $1;
        `, [S2_ID]);
        joinRows = j.rows.length;

        // Tentativa 2: Subquery maliciosa
        const sq = await tx.query(`
          SELECT count(*) as cnt
          FROM sessoes
          WHERE id IN (
            SELECT id FROM sessoes WHERE perfil_id = $1
          );
        `, [S2_ID]);
        subqueryRows = Number(sq.rows[0].cnt);
      });

      const passed = joinRows === 0 && subqueryRows === 0;
      recordTest(12, 'Tentativa de contornar policies via subqueries ou joins -> rejeitado pelo RLS', passed, {
        linhasViaJoin: joinRows,
        linhasViaSubquery: subqueryRows
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 13: Operações com contexto ausente -> fail-closed
    // ------------------------------------------------------------------------
    {
      let sessoesSemContexto = -1;
      let cardsSemContexto = -1;

      // Executa sem chamar set_context
      const s = await db.query('SELECT count(*) as cnt FROM sessoes;');
      sessoesSemContexto = Number(s.rows[0].cnt);

      const c = await db.query('SELECT count(*) as cnt FROM cards;');
      cardsSemContexto = Number(c.rows[0].cnt);

      const passed = sessoesSemContexto === 0 && cardsSemContexto === 0;
      recordTest(13, 'Operações com contexto ausente -> fail-closed (0 linhas)', passed, {
        sessoesRetornadas: sessoesSemContexto,
        cardsRetornados: cardsSemContexto
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 14: Operações com contexto inválido -> fail-closed
    // ------------------------------------------------------------------------
    {
      let contextExceptionThrown = false;
      let zeroRowsReturned = false;

      // 14.1 Chamada com perfil inexistente deve lançar exceção
      try {
        await db.query(`
          SELECT medicina.set_context('00000000-0000-0000-0000-000000000000'::uuid, 'estudante');
        `);
      } catch (err) {
        contextExceptionThrown = true;
      }

      // 14.2 Se alguém tentar forjar via set_config direto um valor que não existe na base
      await db.transaction(async (tx) => {
        await tx.query("SELECT set_config('medicina.current_perfil_id', '00000000-0000-0000-0000-000000000000', true);");
        await tx.query("SELECT set_config('medicina.current_papel', 'estudante', true);");
        const s = await tx.query('SELECT count(*) as cnt FROM sessoes;');
        zeroRowsReturned = Number(s.rows[0].cnt) === 0;
      });

      const passed = contextExceptionThrown && zeroRowsReturned;
      recordTest(14, 'Operações com contexto inválido -> fail-closed (rejeição / 0 linhas)', passed, {
        excecaoContextoInexistente: contextExceptionThrown,
        zeroLinhasContextoForjado: zeroRowsReturned
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 15: Transações sucessivas com perfis distintos na mesma conexão -> SET LOCAL limpa contexto
    // ------------------------------------------------------------------------
    {
      let t1Rows = -1;
      let t2Rows = -1;
      let t3Rows = -1;

      // Transação 1: Estudante 1
      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
        const res = await tx.query('SELECT count(*) as cnt FROM sessoes;');
        t1Rows = Number(res.rows[0].cnt);
      });

      // Transação 2: Imediatamente a seguir, SEM contexto (simula reuse de conexão pelo pool)
      await db.transaction(async (tx) => {
        const res = await tx.query('SELECT count(*) as cnt FROM sessoes;');
        t2Rows = Number(res.rows[0].cnt);
      });

      // Transação 3: Estudante 2
      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S2_ID, 'estudante']);
        const res = await tx.query('SELECT count(*) as cnt FROM sessoes;');
        t3Rows = Number(res.rows[0].cnt);
      });

      const passed = t1Rows >= 1 && t2Rows === 0 && t3Rows >= 1;
      recordTest(15, 'Transações sucessivas com perfis distintos na mesma conexão -> sem vazamento de contexto', passed, {
        transacao1Estudante1: t1Rows,
        transacao2SemContexto: t2Rows,
        transacao3Estudante2: t3Rows
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 16: Reutilização de conexões -> garantia de isolamento entre sessões
    // ------------------------------------------------------------------------
    {
      // Limpeza forçada de sessão
      await db.exec('DISCARD ALL;');
      await db.exec('SET ROLE medicina_app;');

      const s = await db.query('SELECT count(*) as cnt FROM sessoes;');
      const c = await db.query('SELECT count(*) as cnt FROM cards;');
      const passed = Number(s.rows[0].cnt) === 0 && Number(c.rows[0].cnt) === 0;
      recordTest(16, 'Reutilização de conexões -> garantia de isolamento entre sessões pós-DISCARD', passed, {
        sessoesPosDiscard: Number(s.rows[0].cnt),
        cardsPosDiscard: Number(c.rows[0].cnt)
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 17: Operações envolvendo tabelas relacionadas (cadeia de ownership)
    // ------------------------------------------------------------------------
    {
      let revisoesE1 = -1;
      let revisoesE2 = -1;
      let insertRevisaoE2Rejected = false;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);

        // Estudante 1 deve ver apenas revisões dos seus próprios cards
        const r1 = await tx.query('SELECT * FROM card_revisoes WHERE card_id = $1;', ['50000000-0000-4000-8000-000000000001']);
        revisoesE1 = r1.rows.length;

        // Estudante 1 tenta consultar revisões do card da Estudante 2
        const r2 = await tx.query('SELECT * FROM card_revisoes WHERE card_id = $1;', ['50000000-0000-4000-8000-000000000002']);
        revisoesE2 = r2.rows.length;

        // Estudante 1 tenta inserir revisão apontando para card da Estudante 2
        try {
          await tx.query(`
            INSERT INTO card_revisoes (
              id, card_id, revisado_em, rating, state_anterior, stability_anterior, duracao_ms
            ) VALUES (
              '51000000-0000-4000-8000-000000000088', '50000000-0000-4000-8000-000000000002',
              now(), 'good', 'review', 1.0, 1000
            );
          `);
        } catch (err) {
          insertRevisaoE2Rejected = true;
        }
      });

      const passed = revisoesE1 === 1 && revisoesE2 === 0 && insertRevisaoE2Rejected;
      recordTest(17, 'Cadeia de ownership em tabelas filhas (card_revisoes) -> herança estrita do card', passed, {
        revisoesCardProprio: revisoesE1,
        revisoesCardOutroPerfil: revisoesE2,
        insercaoFilhaIndevidaRejeitada: insertRevisaoE2Rejected
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO 18: Tentativas de executar consultas por papéis com privilégios insuficientes
    // ------------------------------------------------------------------------
    {
      let ddlBlocked = false;
      let ddlErrorCode = null;

      // Papel medicina_app tenta executar DDL destrutivo (DROP TABLE ou desabilitar RLS)
      try {
        await db.query('ALTER TABLE sessoes DISABLE ROW LEVEL SECURITY;');
      } catch (err) {
        ddlBlocked = true;
        ddlErrorCode = err.code;
      }

      const passed = ddlBlocked && (ddlErrorCode === '42501' || ddlErrorCode === '0P000');
      recordTest(18, 'Consultas por papéis com privilégios insuficientes -> DDL/Bypass bloqueado pelo PostgreSQL', passed, {
        ddlBloqueado: ddlBlocked,
        codigoErro: ddlErrorCode
      });
    }

    // ========================================================================
    // CENÁRIOS ADICIONAIS DE REVISÃO E AUDITORIA (F1.04-R: R1 a R8)
    // ========================================================================
    console.log('\n====================================================================');
    console.log('EXECUTANDO CENÁRIOS ADICIONAIS DE REVISÃO E AUDITORIA (F1.04-R: R1-R8)');
    console.log('====================================================================\n');

    // ------------------------------------------------------------------------
    // CENÁRIO R1: Falsificação de contexto com UUID válido (Trust Model da Aplicação)
    // ------------------------------------------------------------------------
    {
      // O banco valida se o UUID existe e corresponde ao papel.
      // Se um cliente sob medicina_app assertar S2_ID (que existe como estudante),
      // o banco isola estritamente para S2_ID e NÃO vaza dados de S1_ID.
      // Isso comprova o modelo de confiança: a camada de aplicação autentica o usuário,
      // e o RLS no PostgreSQL garante que cada contexto só acessa seus próprios dados.
      let s2SessoesCount = 0;
      let s1SessoesUnderS2Count = 0;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S2_ID, 'estudante']);
        const resS2 = await tx.query('SELECT * FROM sessoes;');
        s2SessoesCount = resS2.rows.length;

        const resS1 = await tx.query('SELECT * FROM sessoes WHERE perfil_id = $1;', [S1_ID]);
        s1SessoesUnderS2Count = resS1.rows.length;
      });

      const passed = s2SessoesCount > 0 && s1SessoesUnderS2Count === 0;
      recordTest('R1', 'Falsificação de contexto com UUID válido -> isolamento no contexto assertado e proteção contra cross-tenant', passed, {
        sessoesS2: s2SessoesCount,
        sessoesS1AcessadasSobS2: s1SessoesUnderS2Count
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO R2: Incoerência de papel (role mismatch) -> rejeição P0001 no set_context
    // ------------------------------------------------------------------------
    {
      let mismatchBlocked = false;
      let mismatchCode = null;
      let nonExistentBlocked = false;
      let nonExistentCode = null;

      // Estudante 1 tenta se declarar como responsável
      try {
        await db.transaction(async (tx) => {
          await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'responsavel']);
        });
      } catch (err) {
        mismatchBlocked = true;
        mismatchCode = err.code;
      }

      // UUID inexistente tenta se declarar como estudante
      try {
        await db.transaction(async (tx) => {
          await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', ['00000000-0000-4000-8000-000000000000', 'estudante']);
        });
      } catch (err) {
        nonExistentBlocked = true;
        nonExistentCode = err.code;
      }

      const passed = mismatchBlocked && mismatchCode === 'P0001' && nonExistentBlocked && nonExistentCode === 'P0001';
      recordTest('R2', 'Incoerência de papel e UUID inexistente -> rejeição explícita P0001 no set_context', passed, {
        mismatchBloqueado: mismatchBlocked,
        codigoErroMismatch: mismatchCode,
        inexistenteBloqueado: nonExistentBlocked,
        codigoErroInexistente: nonExistentCode
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO R3: Tentativa direta de SELECT password_hash em perfis -> rejeição 42501 (Column Grant)
    // ------------------------------------------------------------------------
    {
      let hashAccessBlocked = false;
      let hashErrorCode = null;
      let allowedQuerySuccess = false;

      // Papel medicina_app tenta ler a coluna password_hash diretamente
      try {
        await db.query('SELECT password_hash FROM perfis;');
      } catch (err) {
        hashAccessBlocked = true;
        hashErrorCode = err.code;
      }

      // Colunas permitidas (id, nome, email, papel) devem ser consultáveis dentro de contexto
      try {
        await db.transaction(async (tx) => {
          await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
          const res = await tx.query('SELECT id, nome, email, papel FROM perfis;');
          allowedQuerySuccess = res.rows.length === 1 && res.rows[0].id === S1_ID;
        });
      } catch (err) {
        allowedQuerySuccess = false;
      }

      const passed = hashAccessBlocked && hashErrorCode === '42501' && allowedQuerySuccess;
      recordTest('R3', 'Tentativa direta de SELECT password_hash -> rejeição 42501 (Column-Level Grant defensivo)', passed, {
        hashAcessoBloqueado: hashAccessBlocked,
        codigoErro: hashErrorCode,
        leituraColunasPermitidas: allowedQuerySuccess
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO R4: Tentativa de EXECUTE em medicina.set_context por medicina_anon -> rejeição 42501
    // ------------------------------------------------------------------------
    {
      let anonContextBlocked = false;
      let anonContextErrorCode = null;
      let anonPerfisBlocked = false;
      let anonPerfisErrorCode = null;

      await db.exec('SET ROLE medicina_anon;');

      // Papel medicina_anon tenta executar set_context
      try {
        await db.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
      } catch (err) {
        anonContextBlocked = true;
        anonContextErrorCode = err.code;
      }

      // Papel medicina_anon tenta ler perfis
      try {
        await db.query('SELECT * FROM perfis;');
      } catch (err) {
        anonPerfisBlocked = true;
        anonPerfisErrorCode = err.code;
      }

      // Restaura papel para medicina_app
      await db.exec('SET ROLE medicina_app;');

      const passed = anonContextBlocked && anonContextErrorCode === '42501' && anonPerfisBlocked && anonPerfisErrorCode === '42501';
      recordTest('R4', 'Tentativa de chamada por papel medicina_anon -> rejeição 42501 por ausência de privilégio', passed, {
        chamadaContextBloqueada: anonContextBlocked,
        codigoErroContext: anonContextErrorCode,
        leituraPerfisBloqueada: anonPerfisBlocked,
        codigoErroPerfis: anonPerfisErrorCode
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO R5: Execução fora de bloco transacional -> fail-closed via is_local (0 linhas)
    // ------------------------------------------------------------------------
    {
      // Chamada a set_context fora de BEGIN...COMMIT autocomita e descarta o contexto
      await db.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);

      // Consultas subsequentes fora de transação não mantêm o contexto
      const sessoesForaTx = await db.query('SELECT * FROM sessoes;');
      const cardsForaTx = await db.query('SELECT * FROM cards;');
      const currentPerfilForaTx = await db.query('SELECT medicina.current_perfil_id() as pid;');

      const passed = sessoesForaTx.rows.length === 0 &&
                     cardsForaTx.rows.length === 0 &&
                     currentPerfilForaTx.rows[0].pid === null;

      recordTest('R5', 'Execução fora de bloco transacional -> fail-closed imediato via is_local = true (0 linhas)', passed, {
        sessoesForaTx: sessoesForaTx.rows.length,
        cardsForaTx: cardsForaTx.rows.length,
        currentPerfilId: currentPerfilForaTx.rows[0].pid
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO R6: Anti-enumeração na autenticação por e-mail -> e-mail fora da allowlist retorna 0 linhas
    // ------------------------------------------------------------------------
    {
      await db.exec('SET ROLE medicina_auth;');

      // estudante2 existe em perfis, mas NÃO consta na allowlist
      const resE2 = await db.query('SELECT * FROM medicina.autenticar_por_email($1::text);', ['estudante2.f104@example.invalid']);
      // e-mail inexistente
      const resInexistente = await db.query('SELECT * FROM medicina.autenticar_por_email($1::text);', ['inexistente.f104@example.invalid']);

      await db.exec('SET ROLE medicina_app;');

      const passed = resE2.rows.length === 0 && resInexistente.rows.length === 0;
      recordTest('R6', 'Anti-enumeração na autenticação por e-mail -> e-mail fora da allowlist retorna 0 linhas', passed, {
        retornoEmailForaAllowlist: resE2.rows.length,
        retornoEmailInexistente: resInexistente.rows.length
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO R7: Autenticação por e-mail para usuário na allowlist -> retorna credencial para NextAuth
    // ------------------------------------------------------------------------
    {
      await db.exec('SET ROLE medicina_auth;');

      // estudante1 consta na allowlist e existe em perfis
      const resE1 = await db.query('SELECT * FROM medicina.autenticar_por_email($1::text);', ['estudante1.f104@example.invalid']);

      await db.exec('SET ROLE medicina_app;');

      const row = resE1.rows[0];
      const passed = resE1.rows.length === 1 &&
                     row.id === S1_ID &&
                     row.email === 'estudante1.f104@example.invalid' &&
                     row.papel === 'estudante' &&
                     typeof row.password_hash === 'string' &&
                     row.password_hash.startsWith('$2a$');

      recordTest('R7', 'Autenticação por e-mail na allowlist -> retorna credenciais de forma segura via SECURITY DEFINER', passed, {
        linhasRetornadas: resE1.rows.length,
        perfilId: row ? row.id : null,
        email: row ? row.email : null,
        papel: row ? row.papel : null,
        hashPresente: row ? !!row.password_hash : false
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO R8: Isolamento estrito em subqueries, joins e views agregadas cross-tenant -> 0 linhas
    // ------------------------------------------------------------------------
    {
      let joinCrossTenantRows = 0;
      let subqueryCrossTenantRows = 0;
      let viewTrimestraisCrossTenantRows = 0;
      let viewTrimestraisProprioRows = 0;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);

        // JOIN tentando acessar sessões do Estudante 2
        const resJoin = await tx.query(`
          SELECT s.id, s.perfil_id, p.nome
          FROM sessoes s
          JOIN perfis p ON s.perfil_id = p.id
          WHERE p.id = $1;
        `, [S2_ID]);
        joinCrossTenantRows = resJoin.rows.length;

        // Subquery tentando filtrar registros do Estudante 2
        const resSub = await tx.query(`
          SELECT *
          FROM sessoes
          WHERE perfil_id IN (SELECT id FROM perfis WHERE id = $1);
        `, [S2_ID]);
        subqueryCrossTenantRows = resSub.rows.length;

        // View de revisões trimestrais para Estudante 2
        const resViewCross = await tx.query(`
          SELECT *
          FROM vw_revisoes_trimestrais
          WHERE estudante_perfil_id = $1;
        `, [S2_ID]);
        viewTrimestraisCrossTenantRows = resViewCross.rows.length;

        // View de revisões trimestrais para Estudante 1 (própria)
        const resViewProprio = await tx.query(`
          SELECT *
          FROM vw_revisoes_trimestrais;
        `);
        viewTrimestraisProprioRows = resViewProprio.rows.length;
      });

      const passed = joinCrossTenantRows === 0 &&
                     subqueryCrossTenantRows === 0 &&
                     viewTrimestraisCrossTenantRows === 0 &&
                     viewTrimestraisProprioRows === 1;

      recordTest('R8', 'Isolamento estrito em subqueries, joins e views (vw_revisoes_trimestrais) -> 0 linhas vazadas', passed, {
        joinCrossTenant: joinCrossTenantRows,
        subqueryCrossTenant: subqueryCrossTenantRows,
        viewTrimestraisCrossTenant: viewTrimestraisCrossTenantRows,
        viewTrimestraisProprio: viewTrimestraisProprioRows
      });
    }

    // ========================================================================
    // CENÁRIOS ADICIONAIS DE CONFORMIDADE E PRIVILÉGIOS (F1.04-C: C1 a C15)
    // ========================================================================
    console.log('\n====================================================================');
    console.log('EXECUTANDO CENÁRIOS ADICIONAIS DE CONFORMIDADE E PRIVILÉGIOS (F1.04-C: C1-C15)');
    console.log('====================================================================\n');

    // ------------------------------------------------------------------------
    // CENÁRIO C1: Identidade retirada exclusivamente da sessão validada
    // (tentativa de injetar ID de outro usuário via parâmetro ou body é rejeitada/ignorada)
    // ------------------------------------------------------------------------
    {
      let injectedReadRows = 0;
      let injectedInsertBlocked = false;
      let injectedInsertErrorCode = null;

      await db.transaction(async (tx) => {
        // Sessão autenticada define contexto de Estudante 1
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);

        // Parâmetro malicioso tentando ler sessões de Estudante 2
        const resRead = await tx.query('SELECT * FROM sessoes WHERE perfil_id = $1;', [S2_ID]);
        injectedReadRows = resRead.rows.length;

        // Payload malicioso tentando criar sessão pertencente a Estudante 2
        try {
          await tx.query(`
            INSERT INTO sessoes (
              id, perfil_id, ciclo_bloco_id, topico_id, iniciada_em, concluida
            ) VALUES (
              '42000000-0000-4000-8000-000000000091', $1, '41000000-0000-4000-8000-000000000001',
              '31000000-0000-4000-8000-000000000001', now(), true
            );
          `, [S2_ID]);
        } catch (err) {
          injectedInsertBlocked = true;
          injectedInsertErrorCode = err.code;
        }
      });

      const passed = injectedReadRows === 0 && injectedInsertBlocked && injectedInsertErrorCode === '42501';
      recordTest('C1', 'Identidade da sessão validada -> tentativa de injetar ID alheio é bloqueada por RLS', passed, {
        leituraInjetadaLinhas: injectedReadRows,
        insercaoInjetadaBloqueada: injectedInsertBlocked,
        codigoErroInsercao: injectedInsertErrorCode
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C2: ID fornecido pelo cliente não substitui a identidade autenticada
    // ------------------------------------------------------------------------
    {
      let spoofedUpdateRows = 0;
      let legitimateUpdateRows = 0;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);

        // Tentativa de alterar registro passando perfil_id do Estudante 2 no WHERE
        const resSpoof = await tx.query(`
          UPDATE sessoes SET nota_livre = 'hackeado'
          WHERE perfil_id = $1;
        `, [S2_ID]);
        spoofedUpdateRows = resSpoof.rowCount ?? resSpoof.rows.length;

        // Atualização legítima passando o próprio perfil autenticado
        const resLegit = await tx.query(`
          UPDATE sessoes SET nota_livre = 'legitimo'
          WHERE perfil_id = $1 AND id = '42000000-0000-4000-8000-000000000001';
        `, [S1_ID]);
        legitimateUpdateRows = resLegit.rowCount ?? resLegit.rows.length;
      });

      const passed = spoofedUpdateRows === 0 && legitimateUpdateRows === 1;
      recordTest('C2', 'ID fornecido pelo cliente não substitui identidade autenticada -> update indevido afeta 0 linhas', passed, {
        linhasAfetadasSpoof: spoofedUpdateRows,
        linhasAfetadasLegitimo: legitimateUpdateRows
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C3: Papel fornecido pelo cliente não modifica a autorização
    // (ex.: estudante tentar se passar por responsável)
    // ------------------------------------------------------------------------
    {
      let roleSpoofBlocked = false;
      let roleSpoofErrorCode = null;
      let isRespUnderStudent = true;

      // Estudante tenta configurar contexto alegando papel de responsável
      try {
        await db.transaction(async (tx) => {
          await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'responsavel']);
        });
      } catch (err) {
        roleSpoofBlocked = true;
        roleSpoofErrorCode = err.code;
      }

      // Sob contexto legítimo de estudante, verifica se is_responsavel é estritamente false
      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
        const res = await tx.query('SELECT medicina.is_responsavel() as is_resp;');
        isRespUnderStudent = res.rows[0].is_resp;
      });

      const passed = roleSpoofBlocked && roleSpoofErrorCode === 'P0001' && isRespUnderStudent === false;
      recordTest('C3', 'Papel fornecido pelo cliente não modifica autorização -> rejeição P0001 e is_responsavel falso', passed, {
        trocaPapelBloqueada: roleSpoofBlocked,
        codigoErro: roleSpoofErrorCode,
        isResponsavelSobEstudante: isRespUnderStudent
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C4: Estudante não assume outro perfil em queries ou mutations
    // ------------------------------------------------------------------------
    {
      let selectS2 = 0;
      let updateS2 = 0;
      let deleteS2 = 0;
      let insertS2Blocked = false;
      let insertS2ErrorCode = null;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);

        const rSelect = await tx.query('SELECT * FROM sessoes WHERE perfil_id = $1;', [S2_ID]);
        selectS2 = rSelect.rows.length;

        const rUpdate = await tx.query("UPDATE cards SET frente = 'hacked' WHERE perfil_id = $1;", [S2_ID]);
        updateS2 = rUpdate.rowCount ?? rUpdate.rows.length;

        const rDelete = await tx.query('DELETE FROM checkins WHERE perfil_id = $1;', [S2_ID]);
        deleteS2 = rDelete.rowCount ?? rDelete.rows.length;

        try {
          await tx.query(`
            INSERT INTO cards (
              id, perfil_id, topico_id, frente, verso, status
            ) VALUES (
              '50000000-0000-4000-8000-000000000092', $1, '31000000-0000-4000-8000-000000000001',
              'Frente Fake', 'Verso Fake', 'aprovado'
            );
          `, [S2_ID]);
        } catch (err) {
          insertS2Blocked = true;
          insertS2ErrorCode = err.code;
        }
      });

      const passed = selectS2 === 0 && updateS2 === 0 && deleteS2 === 0 && insertS2Blocked && insertS2ErrorCode === '42501';
      recordTest('C4', 'Estudante não assume outro perfil em nenhuma operação CRUD -> zero linhas ou erro 42501', passed, {
        selectOutroPerfil: selectS2,
        updateOutroPerfil: updateS2,
        deleteOutroPerfil: deleteS2,
        insertOutroPerfilBloqueado: insertS2Blocked,
        codigoErroInsert: insertS2ErrorCode
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C5: Responsável não assume outro perfil em consultas
    // ------------------------------------------------------------------------
    {
      let revisoesS2Rows = 0;
      let revisoesS1Rows = 0;
      let acervoR2Rows = 0;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [R1_ID, 'responsavel']);

        // Tentativa de consultar revisões da estudante 2 (sem vínculo com Responsável 1)
        const rS2 = await tx.query('SELECT * FROM revisoes_trimestrais WHERE estudante_perfil_id = $1;', [S2_ID]);
        revisoesS2Rows = rS2.rows.length;

        // Consulta de revisões da estudante 1 (vinculada a Responsável 1)
        const rS1 = await tx.query('SELECT * FROM revisoes_trimestrais WHERE estudante_perfil_id = $1;', [S1_ID]);
        revisoesS1Rows = rS1.rows.length;

        // Tentativa de consultar arquivo de acervo enviado por outro responsável (Responsável 2)
        const rAcervo = await tx.query('SELECT * FROM acervo_arquivos WHERE enviado_por = $1;', [R2_ID]);
        acervoR2Rows = rAcervo.rows.length;
      });

      const passed = revisoesS2Rows === 0 && revisoesS1Rows === 1 && acervoR2Rows === 0;
      recordTest('C5', 'Responsável não assume outro perfil -> acessa apenas estudante vinculada e acervo próprio', passed, {
        revisoesEstudanteNaoVinculada: revisoesS2Rows,
        revisoesEstudanteVinculada: revisoesS1Rows,
        acervoOutroResponsavel: acervoR2Rows
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C6: Login legítimo continua 100% funcional
    // ------------------------------------------------------------------------
    {
      await db.exec('SET ROLE medicina_auth;');

      const resEstudante = await db.query('SELECT * FROM medicina.autenticar_por_email($1::text);', ['estudante1.f104@example.invalid']);
      const resResponsavel = await db.query('SELECT * FROM medicina.autenticar_por_email($1::text);', ['responsavel1.f104@example.invalid']);

      await db.exec('SET ROLE medicina_app;');

      const rowE = resEstudante.rows[0];
      const rowR = resResponsavel.rows[0];

      const passed = resEstudante.rows.length === 1 &&
                     rowE.id === S1_ID &&
                     rowE.papel === 'estudante' &&
                     typeof rowE.password_hash === 'string' &&
                     resResponsavel.rows.length === 1 &&
                     rowR.id === R1_ID &&
                     rowR.papel === 'responsavel' &&
                     typeof rowR.password_hash === 'string';

      recordTest('C6', 'Login legítimo continua 100% funcional -> autentica estudante e responsável na allowlist', passed, {
        estudanteAutenticada: resEstudante.rows.length === 1,
        responsavelAutenticado: resResponsavel.rows.length === 1
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C7: Consultas comuns (medicina_app) não expõem hashes de senha (erro 42501)
    // ------------------------------------------------------------------------
    {
      let selectHashBlocked = false;
      let selectHashErrorCode = null;
      let selectStarBlocked = false;
      let selectStarErrorCode = null;

      try {
        await db.query('SELECT password_hash FROM perfis;');
      } catch (err) {
        selectHashBlocked = true;
        selectHashErrorCode = err.code;
      }

      try {
        await db.query('SELECT * FROM perfis;');
      } catch (err) {
        selectStarBlocked = true;
        selectStarErrorCode = err.code;
      }

      const passed = selectHashBlocked && selectHashErrorCode === '42501' && selectStarBlocked && selectStarErrorCode === '42501';
      recordTest('C7', 'Consultas cotidianas medicina_app não expõem password_hash -> rejeição 42501 por coluna', passed, {
        selectHashBloqueado: selectHashBlocked,
        codigoErroHash: selectHashErrorCode,
        selectStarBloqueado: selectStarBlocked,
        codigoErroStar: selectStarErrorCode
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C8: Funções de autenticação respeitam privilégios mínimos
    // (somente role de auth pode executar autenticar_por_email)
    // ------------------------------------------------------------------------
    {
      let appBlocked = false;
      let appErrorCode = null;
      let anonBlocked = false;
      let anonErrorCode = null;
      let authSuccess = false;

      // medicina_app tenta executar autenticar_por_email
      try {
        await db.query('SELECT * FROM medicina.autenticar_por_email($1::text);', ['estudante1.f104@example.invalid']);
      } catch (err) {
        appBlocked = true;
        appErrorCode = err.code;
      }

      // medicina_anon tenta executar autenticar_por_email
      await db.exec('SET ROLE medicina_anon;');
      try {
        await db.query('SELECT * FROM medicina.autenticar_por_email($1::text);', ['estudante1.f104@example.invalid']);
      } catch (err) {
        anonBlocked = true;
        anonErrorCode = err.code;
      }

      // medicina_auth executa autenticar_por_email com sucesso
      await db.exec('SET ROLE medicina_auth;');
      try {
        const res = await db.query('SELECT * FROM medicina.autenticar_por_email($1::text);', ['estudante1.f104@example.invalid']);
        authSuccess = res.rows.length === 1;
      } catch (err) {
        authSuccess = false;
      }

      await db.exec('SET ROLE medicina_app;');

      const passed = appBlocked && appErrorCode === '42501' && anonBlocked && anonErrorCode === '42501' && authSuccess;
      recordTest('C8', 'Privilégio mínimo na autenticação -> somente medicina_auth executa autenticar_por_email', passed, {
        appBloqueado: appBlocked,
        codigoErroApp: appErrorCode,
        anonBloqueado: anonBlocked,
        codigoErroAnon: anonErrorCode,
        authSucesso: authSuccess
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C9: Operações sem sessão/contexto são negadas fail-closed (0 linhas ou exceção)
    // ------------------------------------------------------------------------
    {
      let insertBlocked = false;
      let insertErrorCode = null;

      const rSessoes = await db.query('SELECT count(*) as cnt FROM sessoes;');
      const rCards = await db.query('SELECT count(*) as cnt FROM cards;');
      const rPerfis = await db.query('SELECT count(*) as cnt FROM perfis;');

      try {
        await db.query(`
          INSERT INTO sessoes (
            id, perfil_id, ciclo_bloco_id, topico_id, iniciada_em, concluida
          ) VALUES (
            '42000000-0000-4000-8000-000000000093', '${S1_ID}', '41000000-0000-4000-8000-000000000001',
            '31000000-0000-4000-8000-000000000001', now(), true
          );
        `);
      } catch (err) {
        insertBlocked = true;
        insertErrorCode = err.code;
      }

      const passed = Number(rSessoes.rows[0].cnt) === 0 &&
                     Number(rCards.rows[0].cnt) === 0 &&
                     Number(rPerfis.rows[0].cnt) === 0 &&
                     insertBlocked && insertErrorCode === '42501';

      recordTest('C9', 'Operações sem sessão/contexto são negadas fail-closed -> 0 linhas lidas e erro 42501 no insert', passed, {
        sessoesLidas: Number(rSessoes.rows[0].cnt),
        cardsLidos: Number(rCards.rows[0].cnt),
        perfisLidos: Number(rPerfis.rows[0].cnt),
        insercaoBloqueada: insertBlocked,
        codigoErro: insertErrorCode
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C10: Transações encerram corretamente com commit/rollback e limpeza de contexto
    // ------------------------------------------------------------------------
    {
      // 1. Transação que sofre ROLLBACK
      try {
        await db.transaction(async (tx) => {
          await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
          await tx.query(`
            INSERT INTO sessoes (
              id, perfil_id, ciclo_bloco_id, topico_id, iniciada_em, concluida
            ) VALUES (
              '42000000-0000-4000-8000-000000000094', '${S1_ID}', '41000000-0000-4000-8000-000000000001',
              '31000000-0000-4000-8000-000000000001', now(), true
            );
          `);
          throw new Error('Rollback intencional de teste C10');
        });
      } catch {
        // Exceção esperada para disparar rollback
      }

      // Verifica pós-rollback
      const pidAposRollback = await db.query('SELECT medicina.current_perfil_id() as pid;');
      const sessoesAposRollback = await db.query('SELECT * FROM sessoes WHERE id = $1;', ['42000000-0000-4000-8000-000000000094']);

      // 2. Transação que conclui com COMMIT
      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
        await tx.query('SELECT medicina.clear_context();');
      });

      const pidAposCommit = await db.query('SELECT medicina.current_perfil_id() as pid;');

      const passed = pidAposRollback.rows[0].pid === null &&
                     sessoesAposRollback.rows.length === 0 &&
                     pidAposCommit.rows[0].pid === null;

      recordTest('C10', 'Transações encerram corretamente com commit/rollback e limpeza de contexto -> sem vazamentos', passed, {
        perfilIdAposRollback: pidAposRollback.rows[0].pid,
        registroPersistiuAposRollback: sessoesAposRollback.rows.length > 0,
        perfilIdAposCommit: pidAposCommit.rows[0].pid
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C11: Conexões reutilizadas não carregam contexto da requisição anterior pós-DISCARD
    // ------------------------------------------------------------------------
    {
      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
      });

      // Emula reset de conexão efetuado por connection poolers (ex.: PgBouncer)
      await db.exec('DISCARD ALL;');
      await db.exec('SET ROLE medicina_app;');

      const pidPostDiscard = await db.query('SELECT medicina.current_perfil_id() as pid, medicina.current_papel() as papel;');
      const sessoesPostDiscard = await db.query('SELECT count(*) as cnt FROM sessoes;');

      const passed = pidPostDiscard.rows[0].pid === null &&
                     pidPostDiscard.rows[0].papel === null &&
                     Number(sessoesPostDiscard.rows[0].cnt) === 0;

      recordTest('C11', 'Conexões reutilizadas não carregam contexto pós-DISCARD ALL -> isolamento perfeito de pool', passed, {
        perfilIdPosDiscard: pidPostDiscard.rows[0].pid,
        papelPosDiscard: pidPostDiscard.rows[0].papel,
        sessoesVisiveis: Number(sessoesPostDiscard.rows[0].cnt)
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C12: Queries protegidas não executam sem contexto apropriado
    // ------------------------------------------------------------------------
    {
      // Tentativas de consulta sem contexto em tabelas protegidas
      const rAnalise = await db.query('SELECT count(*) as cnt FROM simulado_analise;');
      const rErros = await db.query('SELECT count(*) as cnt FROM erros;');
      const rCheckins = await db.query('SELECT count(*) as cnt FROM checkins;');
      const rRepertorios = await db.query('SELECT count(*) as cnt FROM repertorios;');

      // Consulta dentro de contexto de estudante
      let analiseSobContexto = 0;
      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);
        const res = await tx.query('SELECT count(*) as cnt FROM simulado_analise;');
        analiseSobContexto = Number(res.rows[0].cnt);
      });

      const passed = Number(rAnalise.rows[0].cnt) === 0 &&
                     Number(rErros.rows[0].cnt) === 0 &&
                     Number(rCheckins.rows[0].cnt) === 0 &&
                     Number(rRepertorios.rows[0].cnt) === 0 &&
                     analiseSobContexto === 1;

      recordTest('C12', 'Queries protegidas não retornam dados sem contexto apropriado -> retorno exclusivo sob auth', passed, {
        analiseSemContexto: Number(rAnalise.rows[0].cnt),
        errosSemContexto: Number(rErros.rows[0].cnt),
        checkinsSemContexto: Number(rCheckins.rows[0].cnt),
        repertoriosSemContexto: Number(rRepertorios.rows[0].cnt),
        analiseSobContexto
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C13: Painel do responsável consome apenas informações agregadas permitidas
    // (vw_acompanhamento_quinzenal), sem acesso a sessões individuais (Princípio 1.2)
    // ------------------------------------------------------------------------
    {
      let rawSessoesCount = 0;
      let rawCheckinsCount = 0;
      let aggregatedViewRows = 0;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [R1_ID, 'responsavel']);

        // Responsável NUNCA lê sessões individuais brutas
        const rSessoes = await tx.query('SELECT * FROM sessoes;');
        rawSessoesCount = rSessoes.rows.length;

        // Responsável NUNCA lê checkins individuais brutos
        const rCheckins = await tx.query('SELECT * FROM checkins;');
        rawCheckinsCount = rCheckins.rows.length;

        // Responsável lê exclusivamente a view agregada quinzenal autorizada
        const rView = await tx.query('SELECT * FROM vw_acompanhamento_quinzenal;');
        aggregatedViewRows = rView.rows.length;
      });

      const passed = rawSessoesCount === 0 && rawCheckinsCount === 0 && aggregatedViewRows > 0;
      recordTest('C13', 'Princípio 1.2: Responsável tem zero acesso a sessões brutas e consome apenas view quinzenal', passed, {
        sessoesBrutasVisiveis: rawSessoesCount,
        checkinsBrutosVisiveis: rawCheckinsCount,
        quinzenasAgregadasVisiveis: aggregatedViewRows
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C14: Operações administrativas não são acessíveis por estudantes
    // ------------------------------------------------------------------------
    {
      let filaRows = 0;
      let acervoRows = 0;
      let managedEstudanteId = 'not-null';
      let insertFilaBlocked = false;
      let insertFilaErrorCode = null;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);

        const rFila = await tx.query('SELECT * FROM curadoria_fila;');
        filaRows = rFila.rows.length;

        const rAcervo = await tx.query('SELECT * FROM acervo_arquivos;');
        acervoRows = rAcervo.rows.length;

        const rManaged = await tx.query('SELECT medicina.current_managed_estudante_id() as mid;');
        managedEstudanteId = rManaged.rows[0].mid;

        try {
          await tx.query(`
            INSERT INTO curadoria_fila (
              id, artefato_tipo, artefato_id, topico_id, prioridade
            ) VALUES (
              '92000000-0000-4000-8000-000000000095', 'questao', '70000000-0000-4000-8000-000000000001',
              '31000000-0000-4000-8000-000000000001', 1
            );
          `);
        } catch (err) {
          insertFilaBlocked = true;
          insertFilaErrorCode = err.code;
        }
      });

      const passed = filaRows === 0 && acervoRows === 0 && managedEstudanteId === null && insertFilaBlocked && insertFilaErrorCode === '42501';
      recordTest('C14', 'Operações administrativas e de curadoria são inacessíveis para estudantes -> isolamento total', passed, {
        filaCuradoriaLida: filaRows,
        acervoLido: acervoRows,
        managedEstudanteId,
        insertFilaBloqueado: insertFilaBlocked,
        codigoErroInsert: insertFilaErrorCode
      });
    }

    // ------------------------------------------------------------------------
    // CENÁRIO C15: Rejeição de falsos sucessos (operações que falham em autorização/RLS
    // não retornam status 200/ok: true)
    // ------------------------------------------------------------------------
    {
      let updateRowCount = -1;
      let deleteRowCount = -1;
      let insertBlocked = false;
      let insertErrorCode = null;

      await db.transaction(async (tx) => {
        await tx.query('SELECT medicina.set_context($1::uuid, $2::text);', [S1_ID, 'estudante']);

        // Tentativa de UPDATE em sessão de outro usuário: o banco deve retornar rowCount = 0
        const rUpdate = await tx.query("UPDATE sessoes SET nota_livre = 'fake' WHERE perfil_id = $1;", [S2_ID]);
        updateRowCount = rUpdate.rowCount ?? rUpdate.rows.length;

        // Tentativa de DELETE em redação de outro usuário: deve retornar rowCount = 0
        const rDelete = await tx.query('DELETE FROM redacoes WHERE perfil_id = $1;', [S2_ID]);
        deleteRowCount = rDelete.rowCount ?? rDelete.rows.length;

        // Tentativa de INSERT com owner forjado: deve lançar erro 42501 e NÃO passar silenciosamente
        try {
          await tx.query(`
            INSERT INTO sessoes (
              id, perfil_id, ciclo_bloco_id, topico_id, iniciada_em, concluida
            ) VALUES (
              '42000000-0000-4000-8000-000000000096', '${S2_ID}', '41000000-0000-4000-8000-000000000001',
              '31000000-0000-4000-8000-000000000001', now(), true
            );
          `);
        } catch (err) {
          insertBlocked = true;
          insertErrorCode = err.code;
        }
      });

      // A rejeição de falsos sucessos exige:
      // 1. Mutações não autorizadas afetam rigorosamente 0 linhas (rowCount === 0)
      // 2. Inserções não autorizadas disparam exceção 42501 no banco
      const passed = updateRowCount === 0 && deleteRowCount === 0 && insertBlocked && insertErrorCode === '42501';
      recordTest('C15', 'Rejeição de falsos sucessos -> mutações indevidas reportam 0 linhas e inserts disparam 42501', passed, {
        linhasAfetadasUpdate: updateRowCount,
        linhasAfetadasDelete: deleteRowCount,
        insercaoInvalidaDisparouErro: insertBlocked,
        codigoErro: insertErrorCode
      });
    }

    // ------------------------------------------------------------------------
    // ENSAIO DE ROLLBACK E RE-APLICAÇÃO (ETAPA 11)
    // ------------------------------------------------------------------------
    console.log('\n====================================================================');
    console.log('ENSAIO DE ROLLBACK E RE-APLICAÇÃO DO RLS');
    console.log('====================================================================\n');

    console.log('6. Executando script de rollback (F1_04_ROLLBACK_RLS.sql)...');
    await db.exec('RESET ROLE;');
    await db.exec(sqlRollback);
    testResults.rollback.executed = true;
    console.log('   Rollback executado com sucesso.');

    // Verificar se views foram removidas
    const viewsRemovidas = await db.query(`
      SELECT count(*) as cnt
      FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name IN ('vw_perfis', 'vw_acompanhamento_quinzenal', 'vw_simulados_evolucao', 'vw_revisoes_trimestrais');
    `);
    const viewsCount = Number(viewsRemovidas.rows[0].cnt);
    console.log(`   Views restantes após rollback (esperado 0): ${viewsCount}`);
    testResults.rollback.viewsRemovidas = viewsCount === 0;

    // Verificar se RLS foi desabilitado
    const rlsStatus = await db.query(`
      SELECT count(*) as cnt
      FROM pg_tables
      WHERE schemaname = 'public' AND rowsecurity = true;
    `);
    const tablesWithRls = Number(rlsStatus.rows[0].cnt);
    console.log(`   Tabelas com RLS ativo após rollback (esperado 0): ${tablesWithRls}`);
    testResults.rollback.rlsDesabilitado = tablesWithRls === 0;

    // Verificar se papel medicina_auth foi removido
    const authRoleStatus = await db.query(`
      SELECT count(*) as cnt FROM pg_roles WHERE rolname = 'medicina_auth';
    `);
    const authRoleCount = Number(authRoleStatus.rows[0].cnt);
    console.log(`   Papel medicina_auth restante após rollback (esperado 0): ${authRoleCount}`);
    testResults.rollback.authRoleRemovido = authRoleCount === 0;

    console.log('7. Re-aplicando F1_04_RLS_PROPOSTA.sql para comprovar idempotência...');
    await db.exec(sqlProposal);
    console.log('   Re-aplicação concluída com sucesso!');
    testResults.rollback.reapplicationSuccessful = true;

    // Resumo final
    console.log('\n====================================================================');
    console.log('RESUMO DOS RESULTADOS DA SUÍTE DE TESTES RLS');
    console.log('====================================================================');
    console.log(`Total de Cenários Avaliados: ${testResults.summary.total}`);
    console.log(`Cenários Aprovados:          ${testResults.summary.passed}`);
    console.log(`Cenários Reprovados:         ${testResults.summary.failed}`);
    console.log(`Taxa de Sucesso:             ${((testResults.summary.passed / testResults.summary.total) * 100).toFixed(1)}%`);
    console.log('====================================================================\n');

    if (testResults.summary.failed > 0) {
      throw new Error(`Falha na validação de segurança: ${testResults.summary.failed} cenário(s) falharam.`);
    }

  } finally {
    await db.close();
  }

  return testResults;
}

// Execução
runValidation().then((res) => {
  console.log('VALIDAÇÃO RLS CONCLUÍDA COM ÊXITO TOTAL.');
}).catch((err) => {
  console.error('ERRO FATAL NA EXECUÇÃO DO RUNNER:', err);
  process.exit(1);
});
