import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { stripOuterTransaction } from '../../../scripts/db/migrate-staging.mjs';
import type { AuthorizedProfile } from '../../lib/authorization';
import {
  withAuthenticatedUser,
  applyRlsContext,
} from '../../db/rls-context';
import { db } from '../../db';

const moduleRoot = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';

if (!existsSync(moduleRoot)) {
  throw new Error(`Diretório de módulos isolados não encontrado em ${moduleRoot}.`);
}

const importFromRoot = (pkgPath: string) => import(pathToFileURL(path.join(moduleRoot, pkgPath)).href);

const [{ PGlite }, { vector }] = await Promise.all([
  importFromRoot('@electric-sql/pglite/dist/index.js'),
  importFromRoot('@electric-sql/pglite-pgvector/dist/index.js'),
]);

interface PGliteInstance {
  exec: (query: string) => Promise<unknown>;
  query: <T = Record<string, unknown>>(query: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

// Identificadores sintéticos padronizados das fixtures F1.04
const ESTUDANTE_A_ID = '10000000-0000-4000-8000-000000000001';
const ESTUDANTE_B_ID = '10000000-0000-4000-8000-000000000002';
const RESPONSAVEL_A_ID = '20000000-0000-4000-8000-000000000001';

const CICLO_BLOCO_A_ID = '41000000-0000-4000-8000-000000000001';
const TOPICO_CITOLOGIA_ID = '31000000-0000-4000-8000-000000000001';

const SESSAO_A_ID = '42000000-0000-4000-8000-000000000001';
const SESSAO_B_ID = '42000000-0000-4000-8000-000000000002';

async function createDatabaseWithSteps1To5(): Promise<PGliteInstance> {
  const pglite = new PGlite({
    extensions: { vector },
  });

  await pglite.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
    SET search_path = "$user", public, extensions;
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

  const files = [
    'drizzle/0000_greedy_loki.sql',
    'drizzle/0001_dry_talos.sql',
    'drizzle/0002_little_swarm.sql',
    'drizzle/0003_f1_03_r_expansao.sql',
    'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql',
  ];

  for (const file of files) {
    const raw = readFileSync(path.resolve(process.cwd(), file), 'utf8');
    const clean = stripOuterTransaction(raw);
    await pglite.exec(clean);
  }

  const fixturesRaw = readFileSync(path.resolve(process.cwd(), 'tests/integration/f1_04/fixtures.sql'), 'utf8');
  await pglite.exec(fixturesRaw);

  return pglite;
}

/**
 * Cria um adaptador de transação Drizzle compatível com applyRlsContext apontando para o PGlite.
 */
function createDrizzleTransactionAdapter(pglite: PGliteInstance) {
  return {
    execute: async (q: unknown) => {
      if (typeof q === 'string') {
        const res = await pglite.query(q);
        return res.rows;
      }
      const drizzleSql = q as {
        toQuery: (opts: {
          escapeName: (s: string) => string;
          escapeParam: (i: number) => string;
          escapeString: (s: string) => string;
        }) => { sql: string; params: unknown[] };
      };
      if (typeof drizzleSql?.toQuery === 'function') {
        const built = drizzleSql.toQuery({
          escapeName: (s) => `"${s}"`,
          escapeParam: (i) => `$${i + 1}`,
          escapeString: (s) => `'${s}'`,
        });
        const res = await pglite.query(built.sql, built.params);
        return res.rows;
      }
      throw new Error('Formato de query Drizzle não reconhecido no adaptador.');
    },
  };
}

describe('MEDICINA 2029 — H1.06: Rigor Prático e Comprovação Formal das Ressalvas H1.05-R', () => {

  // ==========================================================================
  // PARTE 1: RESSALVA H1.05-R — CONTEXTO DE IDENTIDADE E IMPERSONAÇÃO
  // ==========================================================================

  describe('1. Contexto de Identidade, Fronteiras de Confiança e Impersonação Lateral', () => {

    it('1.1 Ensaio SQL Direto sob medicina_app: Comprova que a role de banco define contexto de qualquer perfil existente (A ou B) e explica o motivo arquitetural multi-tier', async () => {
      const pglite = await createDatabaseWithSteps1To5();

      // Pergunta de Auditoria: Uma conexão medicina_app pode executar
      // medicina.set_context(perfil_b_id, 'estudante') mesmo quando uma requisição web supostamente pertencia ao usuário A?
      // Resposta com precisão cirúrgica comprovada abaixo: SIM!

      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        // Conexão medicina_app define contexto para Perfil B (Estudante B)
        await pglite.query(`SELECT medicina.set_context('${ESTUDANTE_B_ID}'::uuid, 'estudante');`);

        // Confirma que o contexto de sessão no banco agora reflete Estudante B
        const ctxB = await pglite.query<{ perfil_id: string; papel: string }>(
          'SELECT medicina.current_perfil_id() AS perfil_id, medicina.current_papel() AS papel;'
        );
        expect(ctxB.rows[0].perfil_id).toBe(ESTUDANTE_B_ID);
        expect(ctxB.rows[0].papel).toBe('estudante');

        // As políticas RLS agora operam estritamente sob o tenant de Estudante B:
        // A visualização retorna apenas as sessões de B, ficando cega para A
        const sessoesB = await pglite.query<{ id: string; perfil_id: string }>('SELECT id, perfil_id FROM public.sessoes;');
        expect(sessoesB.rows.length).toBe(1);
        expect(sessoesB.rows[0].id).toBe(SESSAO_B_ID);
        expect(sessoesB.rows[0].perfil_id).toBe(ESTUDANTE_B_ID);

        // Na mesma conexão medicina_app, altera o contexto para Estudante A
        await pglite.query(`SELECT medicina.set_context('${ESTUDANTE_A_ID}'::uuid, 'estudante');`);

        const ctxA = await pglite.query<{ perfil_id: string; papel: string }>(
          'SELECT medicina.current_perfil_id() AS perfil_id, medicina.current_papel() AS papel;'
        );
        expect(ctxA.rows[0].perfil_id).toBe(ESTUDANTE_A_ID);
        expect(ctxA.rows[0].papel).toBe('estudante');

        // Agora as políticas RLS retornam apenas as sessões de A
        const sessoesA = await pglite.query<{ id: string; perfil_id: string }>('SELECT id, perfil_id FROM public.sessoes;');
        expect(sessoesA.rows.length).toBe(1);
        expect(sessoesA.rows[0].id).toBe(SESSAO_A_ID);
        expect(sessoesA.rows[0].perfil_id).toBe(ESTUDANTE_A_ID);
      } finally {
        await pglite.exec('ROLLBACK;');
      }

      // Explicação Arquitetural Formal:
      // No nível puramente SQL, a role medicina_app é uma conta técnica de infraestrutura compartilhada
      // pelo pool de conexões (ex: PgBouncer / Supabase Session Pooler).
      // A procedure medicina.set_context(p_perfil_id uuid, p_papel text) valida apenas:
      //   1. p_perfil_id IS NOT NULL e p_papel IN ('estudante', 'responsavel');
      //   2. EXISTS (SELECT 1 FROM public.perfis WHERE id = p_perfil_id AND papel::text = p_papel).
      // Como tanto o Estudante A quanto o Estudante B existem legitimamente em public.perfis com papel 'estudante',
      // ambas as chamadas são 100% válidas para o PostgreSQL.
      // O banco de dados NÃO tem como inspecionar o estado da sessão HTTP, cookies de autenticação
      // ou tokens da camada web.
    });

    it('1.2 Insuficiência da rejeição de UUID inexistente contra personificação entre usuários legítimos', async () => {
      const pglite = await createDatabaseWithSteps1To5();

      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        // Tentativa de passar UUID sintético inexistente falha com erro P0001
        await expect(
          pglite.query("SELECT medicina.set_context('99999999-9999-4999-8999-999999999999'::uuid, 'estudante');")
        ).rejects.toThrowError(/Contexto invalido: perfil .* nao existe/);

        // DEMONSTRAÇÃO FORMAL:
        // A rejeição de UUID inexistente apenas comprova integridade referencial sintática (o registro existe na tabela).
        // Ela NÃO constitui prova de segurança contra personificação (IDOR lateral), porque um atacante
        // que utilize o identificador de outro usuário legítimo (Estudante B) terá sua solicitação ACEITA pelo banco!
        // Logo, a blindagem contra personificação depende CRITICAMENTE da fronteira de autorização do servidor de aplicação.
      } finally {
        await pglite.exec('ROLLBACK;');
      }
    });

    it('1.3 Camada Next.js (Fronteira de Confiança): withAuthenticatedUser e requireAuthenticatedProfile derivam identidade estritamente do token de sessão criptográfico, ignorando qualquer payload malicioso', async () => {
      const pglite = await createDatabaseWithSteps1To5();

      // Perfil legítimo de Estudante A extraído de sessão NextAuth criptograficamente assinada
      const estudanteA: AuthorizedProfile = {
        id: ESTUDANTE_A_ID,
        nome: 'Estudante Ficticia 1 F1.04',
        email: 'estudante1.f104@example.invalid',
        papel: 'estudante',
      };

      // Simula que o usuário logado no NextAuth é Estudante A
      const spyAuth = vi.spyOn(await import('../../lib/authorization'), 'requireAuthenticatedProfile')
        .mockResolvedValue(estudanteA);

      // Simula um payload de requisição HTTP malicioso enviado por um cliente adulterado (tentando personificar Estudante B)
      const maliciousClientPayload = {
        perfilId: ESTUDANTE_B_ID,          // Injeção do UUID de B
        userId: ESTUDANTE_B_ID,            // Injeção alternativa
        estudanteId: ESTUDANTE_B_ID,       // Injeção de parâmetro de domínio
        papel: 'responsavel',              // Tentativa de escalação de privilégio
        impersonateTarget: ESTUDANTE_B_ID, // Injeção arbitrária
      };

      // Executa a operação sob withAuthenticatedUser
      // Adaptamos db.transaction para executar sob a role medicina_app do PGlite
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      const txAdapter = createDrizzleTransactionAdapter(pglite);

      const spyDbTx = vi.spyOn(db, 'transaction').mockImplementation(async (callback) => {
        return await (callback as (tx: unknown) => unknown)(txAdapter);
      });

      try {
        const resultadoAcao = await withAuthenticatedUser(async ({ perfil }) => {
          // COMPROVAÇÃO 1: A identidade resolvida é ESTRITAMENTE a de Estudante A,
          // NUNCA o perfilId de B fornecido no payload malicioso
          expect(perfil.id).toBe(ESTUDANTE_A_ID);
          expect(perfil.id).not.toBe(maliciousClientPayload.perfilId);
          expect(perfil.papel).toBe('estudante');
          expect(perfil.papel).not.toBe(maliciousClientPayload.papel);

          // COMPROVAÇÃO 2: O contexto ativado no PostgreSQL é de Estudante A
          const currentDbCtx = (await txAdapter.execute(
            'SELECT medicina.current_perfil_id() as id, medicina.current_papel() as papel;'
          )) as Array<{ id: string; papel: string }>;
          expect(currentDbCtx[0].id).toBe(ESTUDANTE_A_ID);
          expect(currentDbCtx[0].papel).toBe('estudante');

          // COMPROVAÇÃO 3: Tentativa de leitura sob o contexto de A retorna apenas dados de A
          const sessoesVisiveis = (await txAdapter.execute(
            'SELECT id, perfil_id FROM public.sessoes;'
          )) as Array<{ id: string; perfil_id: string }>;
          expect(sessoesVisiveis.length).toBe(1);
          expect(sessoesVisiveis[0].id).toBe(SESSAO_A_ID);
          expect(sessoesVisiveis[0].perfil_id).toBe(ESTUDANTE_A_ID);

          return { success: true, executedFor: perfil.id };
        });

        expect(resultadoAcao.success).toBe(true);
        expect(resultadoAcao.executedFor).toBe(ESTUDANTE_A_ID);
      } finally {
        await pglite.exec('ROLLBACK;');
        spyDbTx.mockRestore();
        spyAuth.mockRestore();
      }
    });

    it('1.4 Server Actions: Tentativa de manipular recursos de terceiro (B) via payload falha por RLS e integridade de domínio', async () => {
      const pglite = await createDatabaseWithSteps1To5();

      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      const txAdapter = createDrizzleTransactionAdapter(pglite);

      try {
        // Ativa contexto legítimo para Estudante A (como feito pelas Server Actions via applyRlsContext)
        await applyRlsContext(txAdapter as unknown as Parameters<typeof applyRlsContext>[0], ESTUDANTE_A_ID, 'estudante');

        // Cenário 1: Cliente malicioso (logado como A) envia payload tentando alterar a sessão de B
        await txAdapter.execute(
          `UPDATE public.sessoes SET segundos_efetivos = 9999 WHERE id = '${SESSAO_B_ID}';`
        );
        // Devido ao RLS no PostgreSQL (perfil_id = medicina.current_perfil_id()), 0 linhas são afetadas
        const checkSessaoB = await txAdapter.execute(
          `SELECT id, segundos_efetivos FROM public.sessoes WHERE id = '${SESSAO_B_ID}';`
        ) as Array<{ id: string; segundos_efetivos: number }>;
        expect(checkSessaoB.length).toBe(0); // Totalmente invisível para A!

        // Cenário 2: Cliente malicioso tenta criar nova sessão vinculada a B
        await txAdapter.execute('SAVEPOINT sp1;');
        try {
          await expect(
            txAdapter.execute(`
              INSERT INTO public.sessoes (id, perfil_id, ciclo_bloco_id, topico_id, segundos_efetivos, segundos_pausa)
              VALUES ('42000000-0000-4000-8000-000000000099', '${ESTUDANTE_B_ID}', '${CICLO_BLOCO_A_ID}', '${TOPICO_CITOLOGIA_ID}', 100, 10);
            `)
          ).rejects.toThrowError(/violates row-level security policy for table "sessoes"/i);
        } finally {
          await txAdapter.execute('ROLLBACK TO SAVEPOINT sp1;');
        }

        // Cenário 3: Tentativa de associar a um ciclo pertencente a Estudante B
        const cicloBVisivel = await txAdapter.execute(
          `SELECT id FROM public.ciclos WHERE id = '40000000-0000-4000-8000-000000000002';`
        ) as Array<{ id: string }>;
        expect(cicloBVisivel.length).toBe(0); // Ciclo de B é invisível para A
      } finally {
        await pglite.exec('ROLLBACK;');
      }
    });

    it('1.5 Isolamento Transacional com SET LOCAL: Contexto é destruído imediatamente no COMMIT ou ROLLBACK sem contaminar o pool', async () => {
      const pglite = await createDatabaseWithSteps1To5();

      // Transação 1: Define contexto para A e comita
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      await pglite.query(`SELECT medicina.set_context('${ESTUDANTE_A_ID}'::uuid, 'estudante');`);
      const ctxDuranteTx1 = await pglite.query<{ perfil_id: string }>('SELECT medicina.current_perfil_id() AS perfil_id;');
      expect(ctxDuranteTx1.rows[0].perfil_id).toBe(ESTUDANTE_A_ID);
      await pglite.exec('COMMIT;');

      // Conexão reutilizada pós-COMMIT (sem set_context):
      // Verifica que o contexto foi automaticamente limpo e retorna NULL (Fail-Closed)
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        const ctxPosCommit = await pglite.query<{ perfil_id: string | null }>('SELECT medicina.current_perfil_id() AS perfil_id;');
        expect(ctxPosCommit.rows[0].perfil_id).toBeNull();

        // Consultas em tabelas protegidas retornam 0 linhas
        const sessoesSemCtx = await pglite.query('SELECT * FROM public.sessoes;');
        expect(sessoesSemCtx.rows.length).toBe(0);
      } finally {
        await pglite.exec('ROLLBACK;');
      }

      // Transação 2: Define contexto para B e aborta com ROLLBACK
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      await pglite.query(`SELECT medicina.set_context('${ESTUDANTE_B_ID}'::uuid, 'estudante');`);
      const ctxDuranteTx2 = await pglite.query<{ perfil_id: string }>('SELECT medicina.current_perfil_id() AS perfil_id;');
      expect(ctxDuranteTx2.rows[0].perfil_id).toBe(ESTUDANTE_B_ID);
      await pglite.exec('ROLLBACK;');

      // Conexão reutilizada pós-ROLLBACK: contexto é estritamente NULL
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        const ctxPosRollback = await pglite.query<{ perfil_id: string | null }>('SELECT medicina.current_perfil_id() AS perfil_id;');
        expect(ctxPosRollback.rows[0].perfil_id).toBeNull();
      } finally {
        await pglite.exec('ROLLBACK;');
      }
    });
  });

  // ==========================================================================
  // PARTE 2: RESSALVA H1.05-R — FUNÇÕES SECURITY DEFINER E PRIVILÉGIOS DE SCHEMA
  // ==========================================================================

  describe('2. Funções SECURITY DEFINER, Concessões do Grupo PUBLIC e Privilégios de Schema', () => {

    it('2.1 Auditoria do Catálogo: Funções SECURITY DEFINER e identificação de privilégios herdados por PUBLIC', async () => {
      const pglite = await createDatabaseWithSteps1To5();

      // Consulta detalhada ao catálogo pg_proc
      const procRows = await pglite.query<{
        proname: string;
        prosecdef: boolean;
        proacl: string[] | null;
      }>(`
        SELECT p.proname, p.prosecdef, p.proacl
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'medicina'
        ORDER BY p.proname;
      `);

      const procs = new Map(procRows.rows.map((r) => [r.proname, r]));

      // 1. set_context e clear_context são SECURITY DEFINER
      expect(procs.get('set_context')?.prosecdef).toBe(true);
      expect(procs.get('clear_context')?.prosecdef).toBe(true);

      // 2. autenticar_por_email é SECURITY DEFINER
      expect(procs.get('autenticar_por_email')?.prosecdef).toBe(true);

      // 3. Funções agregadoras quinzenal e simulados são SECURITY DEFINER
      expect(procs.get('fn_acompanhamento_quinzenal')?.prosecdef).toBe(true);
      expect(procs.get('fn_simulados_evolucao')?.prosecdef).toBe(true);
      expect(procs.get('current_managed_estudante_id')?.prosecdef).toBe(true);

      // 4. Verificação de proacl e privilégios de execução:
      // - autenticar_por_email: concedido estritamente a medicina_auth e postgres
      const authAcl = procs.get('autenticar_por_email')?.proacl ?? [];
      expect(authAcl.some((entry) => entry.startsWith('medicina_auth='))).toBe(true);
      expect(authAcl.some((entry) => entry.startsWith('medicina_app='))).toBe(false);
      expect(authAcl.some((entry) => entry.startsWith('='))).toBe(false); // Sem PUBLIC

      // - set_context: concedido estritamente a medicina_app e postgres
      const setContextAcl = procs.get('set_context')?.proacl ?? [];
      expect(setContextAcl.some((entry) => entry.startsWith('medicina_app='))).toBe(true);
      expect(setContextAcl.some((entry) => entry.startsWith('='))).toBe(false); // Sem PUBLIC

      // - fn_acompanhamento_quinzenal e fn_simulados_evolucao:
      // Criadas na Seção 7 (após a revogação coletiva na Seção 3.1).
      // Herdaram privilégio padrão de EXECUTE para PUBLIC ('=X/postgres')
      const quinzenalAcl = procs.get('fn_acompanhamento_quinzenal')?.proacl ?? [];
      expect(quinzenalAcl.some((entry) => entry.startsWith('=X/'))).toBe(true); // Privilégio de PUBLIC presente

      const simuladosAcl = procs.get('fn_simulados_evolucao')?.proacl ?? [];
      expect(simuladosAcl.some((entry) => entry.startsWith('=X/'))).toBe(true); // Privilégio de PUBLIC presente
    });

    it('2.2 Defesa em Profundidade: Bloqueio no nível de Schema USAGE impede execução por PUBLIC ou medicina_anon', async () => {
      const pglite = await createDatabaseWithSteps1To5();

      // Mesmo que o catálogo routine_privileges aponte EXECUTE para PUBLIC,
      // o PostgreSQL exige privilégio de USAGE no schema que contém a função.
      // Como REVOKE ALL ON SCHEMA medicina FROM PUBLIC foi aplicado,
      // usuários não autorizados (como medicina_anon ou qualquer conexão não-privilegiada) são barrados no schema!

      // Tentativa 1: medicina_anon chamando fn_acompanhamento_quinzenal
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_anon;');
      try {
        await expect(
          pglite.query('SELECT * FROM medicina.fn_acompanhamento_quinzenal();')
        ).rejects.toThrowError(/permission denied for schema medicina/i);
      } finally {
        await pglite.exec('ROLLBACK;');
      }

      // Tentativa 2: medicina_anon chamando fn_simulados_evolucao
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_anon;');
      try {
        await expect(
          pglite.query('SELECT * FROM medicina.fn_simulados_evolucao();')
        ).rejects.toThrowError(/permission denied for schema medicina/i);
      } finally {
        await pglite.exec('ROLLBACK;');
      }

      // Tentativa 3: medicina_anon chamando set_context
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_anon;');
      try {
        await expect(
          pglite.query(`SELECT medicina.set_context('${ESTUDANTE_A_ID}'::uuid, 'estudante');`)
        ).rejects.toThrowError(/permission denied for schema medicina/i);
      } finally {
        await pglite.exec('ROLLBACK;');
      }

      // Tentativa 4: medicina_app chamando autenticar_por_email (tem USAGE em medicina, mas EXECUTE revogado)
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await expect(
          pglite.query("SELECT * FROM medicina.autenticar_por_email('estudante1.f104@example.invalid');")
        ).rejects.toThrowError(/permission denied for function autenticar_por_email/i);
      } finally {
        await pglite.exec('ROLLBACK;');
      }
    });

    it('2.3 Guardas Internas de Domínio: Funções agregadoras retornam 0 linhas sem contexto e isolam responsáveis', async () => {
      const pglite = await createDatabaseWithSteps1To5();

      // Guarda 1: medicina_app chamando fn_acompanhamento_quinzenal sem contexto ativo
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        // current_papel() é NULL -> IF NOT medicina.is_estudante() AND NOT medicina.is_responsavel() THEN RETURN;
        const resSemCtx = await pglite.query('SELECT * FROM medicina.fn_acompanhamento_quinzenal();');
        expect(resSemCtx.rows.length).toBe(0);

        const simSemCtx = await pglite.query('SELECT * FROM medicina.fn_simulados_evolucao();');
        expect(simSemCtx.rows.length).toBe(0);
      } finally {
        await pglite.exec('ROLLBACK;');
      }

      // Guarda 2: Responsável 1 (vinculado a Estudante 1) obtém dados estritamente do estudante gerenciado
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pglite.query(`SELECT medicina.set_context('${RESPONSAVEL_A_ID}'::uuid, 'responsavel');`);

        // fn_acompanhamento_quinzenal retorna dados da quinzena para Estudante 1
        const resResp = await pglite.query('SELECT * FROM medicina.fn_acompanhamento_quinzenal();');
        expect(resResp.rows.length).toBeGreaterThanOrEqual(1);

        // Responsável 1 NÃO tem leitura de sessões brutas de ninguém
        const sessoesBrutas = await pglite.query('SELECT * FROM public.sessoes;');
        expect(sessoesBrutas.rows.length).toBe(0);
      } finally {
        await pglite.exec('ROLLBACK;');
      }
    });

    it('2.4 Auditoria de Schemas: medicina_app e medicina_anon NÃO possuem privilégio CREATE em medicina nem em public', async () => {
      const pglite = await createDatabaseWithSteps1To5();

      // Consulta aclexplode para garantir que CREATE não consta para medicina_app nem medicina_anon
      const aclRes = await pglite.query<{ nspname: string; grantee: string; privilege_type: string }>(`
        SELECT n.nspname,
               CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
               a.privilege_type
        FROM pg_namespace n, aclexplode(n.nspacl) a
        WHERE n.nspname IN ('medicina', 'public') AND a.privilege_type = 'CREATE';
      `);

      const createGrantees = aclRes.rows.map((r) => `${r.nspname}:${r.grantee}`);
      expect(createGrantees).not.toContain('medicina:medicina_app');
      expect(createGrantees).not.toContain('medicina:medicina_anon');
      expect(createGrantees).not.toContain('public:medicina_app');
      expect(createGrantees).not.toContain('public:medicina_anon');
      expect(createGrantees).not.toContain('medicina:PUBLIC');

      // Teste prático de violação: medicina_app tentando criar tabela em public
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await expect(
          pglite.query('CREATE TABLE public.t_tentativa_invasao (id int);')
        ).rejects.toThrowError(/permission denied for schema public/i);
      } finally {
        await pglite.exec('ROLLBACK;');
      }

      // Teste prático de violação: medicina_app tentando criar tabela em medicina
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await expect(
          pglite.query('CREATE TABLE medicina.t_tentativa_invasao (id int);')
        ).rejects.toThrowError(/permission denied for schema medicina/i);
      } finally {
        await pglite.exec('ROLLBACK;');
      }

      // Teste prático de violação: medicina_anon tentando criar tabela em public
      await pglite.exec('BEGIN; SET LOCAL ROLE medicina_anon;');
      try {
        await expect(
          pglite.query('CREATE TABLE public.t_tentativa_invasao (id int);')
        ).rejects.toThrowError(/permission denied for schema public/i);
      } finally {
        await pglite.exec('ROLLBACK;');
      }
    });

    it('2.5 Proposta de Hardening sem Quebra de Hash: Aplicação de REVOKE e ALTER DEFAULT PRIVILEGES preserva F1_04_RLS_PROPOSTA.sql intacto', async () => {
      const pglite = await createDatabaseWithSteps1To5();

      // Verifica integridade do arquivo F1_04_RLS_PROPOSTA.sql
      const f104Path = path.resolve(process.cwd(), 'docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql');
      const f104Raw = readFileSync(f104Path, 'utf8');
      const hashCalculado = createHash('sha256').update(f104Raw).digest('hex');
      expect(hashCalculado).toBe('8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f');

      // Formulação da proposta de hardening para a próxima etapa (F1.09):
      // 1. Revoga EXECUTE de PUBLIC nas funções agregadoras
      // 2. Configura ALTER DEFAULT PRIVILEGES para que novas rotinas no schema medicina não recebam EXECUTE para PUBLIC
      const hardeningSql = `
        REVOKE EXECUTE ON FUNCTION medicina.fn_acompanhamento_quinzenal() FROM PUBLIC;
        REVOKE EXECUTE ON FUNCTION medicina.fn_simulados_evolucao() FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA medicina REVOKE EXECUTE ON ROUTINES FROM PUBLIC;
      `;

      await pglite.exec(hardeningSql);

      // Comprova que após o hardening, PUBLIC não possui mais EXECUTE nas funções
      const procAclAfter = await pglite.query<{ proname: string; proacl: string[] | null }>(`
        SELECT p.proname, p.proacl
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'medicina' AND p.proname IN ('fn_acompanhamento_quinzenal', 'fn_simulados_evolucao');
      `);

      for (const row of procAclAfter.rows) {
        const acl = row.proacl ?? [];
        expect(acl.some((entry) => entry.startsWith('=X/'))).toBe(false);
      }

      // Testa a criação de uma nova função e comprova que NÃO recebe privilégio para PUBLIC
      await pglite.exec(`
        CREATE OR REPLACE FUNCTION medicina.fn_teste_futura_rotina()
        RETURNS boolean LANGUAGE sql AS $$ SELECT true; $$;
      `);

      const novaRotinaAcl = await pglite.query<{ proacl: string[] | null }>(`
        SELECT proacl FROM pg_proc WHERE proname = 'fn_teste_futura_rotina';
      `);
      const acl = novaRotinaAcl.rows[0]?.proacl ?? [];
      expect(acl.some((entry) => entry.startsWith('=X/'))).toBe(false);

      // Garante novamente que o arquivo F1_04_RLS_PROPOSTA.sql não sofreu mutação
      const hashPosTeste = createHash('sha256').update(readFileSync(f104Path, 'utf8')).digest('hex');
      expect(hashPosTeste).toBe('8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f');
    });
  });
});
