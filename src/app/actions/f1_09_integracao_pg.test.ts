import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import * as schema from '../../db/schema';

const MODULE_ROOT = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';
const PGLITE_INDEX = path.join(MODULE_ROOT, '@electric-sql/pglite/dist/index.js');
const PGLITE_VECTOR = path.join(MODULE_ROOT, '@electric-sql/pglite-pgvector/dist/index.js');
const HAS_PGLITE = existsSync(PGLITE_INDEX) && existsSync(PGLITE_VECTOR);

const ESTUDANTE_A = {
  id: '10000000-0000-4000-8000-000000000001',
  authUserId: 'a0000000-0000-4000-8000-000000000001',
  nome: 'Estudante Ficticia 1 F1.04',
  email: 'estudante1.f104@example.invalid',
  papel: 'estudante' as const,
};

const RESPONSAVEL_A = {
  id: '20000000-0000-4000-8000-000000000001',
  authUserId: 'b0000000-0000-4000-8000-000000000001',
  nome: 'Responsavel Ficticio 1 F1.04',
  email: 'responsavel1.f104@example.invalid',
  papel: 'responsavel' as const,
};

const state = vi.hoisted(() => ({
  currentProfile: {
    id: '10000000-0000-4000-8000-000000000001',
    authUserId: 'a0000000-0000-4000-8000-000000000001',
    nome: 'Estudante Ficticia 1 F1.04',
    email: 'estudante1.f104@example.invalid',
    papel: 'estudante' as 'estudante' | 'responsavel',
  },
  managedStudent: {
    id: '10000000-0000-4000-8000-000000000001',
    authUserId: 'a0000000-0000-4000-8000-000000000001',
    nome: 'Estudante Ficticia 1 F1.04',
    email: 'estudante1.f104@example.invalid',
    papel: 'estudante' as const,
  },
  dbInstance: null as unknown,
}));

vi.mock('../../lib/authorization', () => ({
  requireAuthenticatedProfile: vi.fn(async () => state.currentProfile),
  requireRole: vi.fn(async (expectedRole: 'estudante' | 'responsavel') => {
    if (state.currentProfile.papel !== expectedRole) {
      const err = new Error('Acesso não autorizado.') as Error & { code: string };
      err.code = 'FORBIDDEN';
      throw err;
    }
    return state.currentProfile;
  }),
  requireManagedStudentProfile: vi.fn(async () => state.managedStudent),
  assertOwnership: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        const instance = state.dbInstance as Record<PropertyKey, unknown> | null;
        if (!instance) {
          throw new Error('PGlite dbInstance não inicializado.');
        }
        const value = instance[prop];
        return typeof value === 'function' ? value.bind(instance) : value;
      },
    },
  ),
}));

vi.mock('../../lib/gemini', () => ({
  GeminiGenerationError: class GeminiGenerationError extends Error {},
  gerarArtefatosGemini: vi.fn(async () => ({
    resumo: {
      titulo: 'Resumo sintético Citologia',
      corpo: 'Corpo sintético gerado em teste isolado.',
      tempoLeituraMin: 10,
    },
    flashcards: [
      {
        pergunta: 'Qual a organela responsável pela respiração celular?',
        resposta: 'Mitocôndria',
      },
    ],
    questoes: [],
  })),
}));

import { iniciarSessao, atualizarSessao, concluirSessao } from './sessao';
import { registrarRevisaoCard } from './fsrs';
import { registrarSimulado } from './simulados';
import { registrarRedacao } from './redacoes';
import { enfileirarGeracaoDeArtefatos } from './curadoria';

describe.skipIf(!HAS_PGLITE)('F1.09 — Integração em PostgreSQL descartável (PGlite)', () => {
  let pg: {
    exec: (sql: string) => Promise<unknown>;
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  };

  const rootDir = process.cwd();
  const readSql = (relPath: string) =>
    readFileSync(path.join(rootDir, relPath), 'utf8').replaceAll('--> statement-breakpoint', '\n');

  const sql0000 = readSql('drizzle/0000_greedy_loki.sql');
  const sql0001 = readSql('drizzle/0001_dry_talos.sql');
  const sql0002 = readSql('drizzle/0002_little_swarm.sql');
  const sql0003 = readSql('drizzle/0003_f1_03_r_expansao.sql');
  const fixturesSql = readSql('tests/integration/f1_04/fixtures.sql');
  const proposalSql = readSql('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql');
  const rollbackSql = readSql('docs/modernizacao/propostas/F1_09_ROLLBACK_INTEGRIDADE_E_IDEMPOTENCIA.sql');

  beforeAll(async () => {
    const { PGlite, types } = await import(pathToFileURL(PGLITE_INDEX).href);
    const { vector } = await import(pathToFileURL(PGLITE_VECTOR).href);
    pg = await PGlite.create({ extensions: { vector } });

    await pg.exec(sql0000);
    await pg.exec(sql0001);
    await pg.exec(sql0002);
    await pg.exec(sql0003);
    await pg.exec(fixturesSql);
    await pg.exec(proposalSql);

    const parsers = {
      [types.TIMESTAMP]: (value: unknown) => value,
      [types.TIMESTAMPTZ]: (value: unknown) => value,
      [types.INTERVAL]: (value: unknown) => value,
      [types.DATE]: (value: unknown) => value,
      1231: (value: unknown) => value,
      1115: (value: unknown) => value,
      1185: (value: unknown) => value,
      1187: (value: unknown) => value,
      1182: (value: unknown) => value,
    };

    const proxyDb = drizzle(
      async (queryStr, params, method) => {
        const rowMode = method === 'all' ? 'array' : 'object';
        const res = await (pg as unknown as {
          query: (
            sql: string,
            params?: unknown[],
            options?: { rowMode: 'array' | 'object'; parsers: Record<number, (v: unknown) => unknown> },
          ) => Promise<{ rows: unknown[] }>;
        }).query(queryStr, params, { rowMode, parsers });
        return { rows: res.rows };
      },
      { schema },
    );

    let txDepth = 0;
    (proxyDb as unknown as { transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).transaction =
      async (callback) => {
        const savepoint = `sp_f109_${++txDepth}`;
        await pg.exec(txDepth === 1 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        try {
          const result = await callback(proxyDb);
          await pg.exec(txDepth === 1 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
          txDepth--;
          return result;
        } catch (err) {
          await pg.exec(txDepth === 1 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`);
          txDepth--;
          throw err;
        }
      };

    state.dbInstance = proxyDb;
  });

  afterAll(async () => {
    if (pg) {
      await pg.close();
    }
  });

  beforeEach(() => {
    state.currentProfile = ESTUDANTE_A;
    state.managedStudent = ESTUDANTE_A;
  });

  it('aplica a proposta SQL F1.09, valida constraints relacionais/domínio e suporta rollback reversível', async () => {
    // 1. Verifica que a tabela operacoes_idempotentes foi criada
    const tableCheck = await pg.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'operacoes_idempotentes'
      ) AS exists
    `);
    expect(tableCheck.rows[0]?.exists).toBe(true);

    // 2. Verifica rejeição de acertos > total no banco (CHECK constraint)
    await expect(
      pg.exec(`
        INSERT INTO public.simulado_areas (simulado_id, area, total, acertos)
        VALUES ('73000000-0000-4000-8000-000000000001', 'natureza', 10, 11)
      `),
    ).rejects.toThrow(/simulado_areas_acertos_total_check/);

    // 3. Verifica rejeição de redação genero_uece sem genero_id no banco (CHECK constraint)
    await expect(
      pg.exec(`
        INSERT INTO public.redacoes (perfil_id, formato, genero_id, tema, escrita_em, texto, minutos_gastos)
        VALUES ('${ESTUDANTE_A.id}', 'genero_uece', NULL, 'Tema UECE', now(), 'Texto válido para teste', 45)
      `),
    ).rejects.toThrow(/redacoes_limites_e_genero_check/);

    // 4. Verifica unicidade de erro por tentativa_id no banco
    await expect(
      pg.exec(`
        INSERT INTO public.erros (
          perfil_id, questao_id, tentativa_id, disciplina_id, topico_id, estilo, tipo_erro
        )
        VALUES (
          '${ESTUDANTE_A.id}',
          '70000000-0000-4000-8000-000000000001',
          '71000000-0000-4000-8000-000000000001',
          '30000000-0000-4000-8000-000000000001',
          '31000000-0000-4000-8000-000000000001',
          'enem',
          'conteudo'
        )
      `),
    ).rejects.toThrow(/erros_tentativa_id_unique/);

    // 5. Verifica compatibilidade com a expansão F1.03-R (estudante_perfil_id NULL continua permitido)
    await pg.exec(`
      INSERT INTO public.ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana)
      VALUES ('40000000-0000-4000-8000-000000000099', NULL, 'Ciclo Legado Compatível', 2026, false, 5);
      DELETE FROM public.ciclos WHERE id = '40000000-0000-4000-8000-000000000099';
    `);

    // 6. Executa rollback completo e reaplica a proposta sem erro
    await pg.exec(rollbackSql);
    const afterRollback = await pg.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'operacoes_idempotentes'
      ) AS exists
    `);
    expect(afterRollback.rows[0]?.exists).toBe(false);

    await pg.exec(proposalSql);
    const afterReapply = await pg.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'operacoes_idempotentes'
      ) AS exists
    `);
    expect(afterReapply.rows[0]?.exists).toBe(true);
  });

  it('garante integridade relacional e ausência de escrita em referências inexistentes ou ownership incorreto', async () => {
    const countSessoesBefore = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.sessoes`,
    );

    // Ownership incorreto: Estudante A tentando iniciar sessão no bloco do ciclo da Estudante B
    await expect(
      iniciarSessao(
        '41000000-0000-4000-8000-000000000002', // bloco da Estudante B
        '31000000-0000-4000-8000-000000000001',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Referência inexistente: topicoId que não existe no banco
    await expect(
      iniciarSessao(
        '41000000-0000-4000-8000-000000000001',
        '31000000-0000-4000-8000-000000000099',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const countSessoesAfter = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.sessoes`,
    );
    expect(countSessoesAfter.rows[0]?.count).toBe(countSessoesBefore.rows[0]?.count);

    // Ownership incorreto em FSRS: Estudante A tentando revisar card da Estudante B
    const revisoesBefore = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.card_revisoes`,
    );
    const revisaoAlheia = await registrarRevisaoCard(
      '50000000-0000-4000-8000-000000000002', // card da Estudante B
      'good',
      1500,
    );
    expect(revisaoAlheia).toMatchObject({ sucesso: false, code: 'NOT_FOUND' });
    const revisoesAfter = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.card_revisoes`,
    );
    expect(revisoesAfter.rows[0]?.count).toBe(revisoesBefore.rows[0]?.count);

    // Referência inexistente em redação UECE (generoId inexistente)
    const redacoesBefore = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.redacoes`,
    );
    const redacaoGeneroInexistente = await registrarRedacao({
      formato: 'genero_uece',
      generoId: '81000000-0000-4000-8000-000000000099',
      tema: 'Tema válido sobre saúde pública',
      texto: 'A'.repeat(120),
      minutosGastos: 50,
    });
    expect(redacaoGeneroInexistente).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const redacoesAfter = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.redacoes`,
    );
    expect(redacoesAfter.rows[0]?.count).toBe(redacoesBefore.rows[0]?.count);
  });

  it('protege ciclo de sessão, repetição idempotente e rejeição de conflito em PostgreSQL real', async () => {
    const BLOCO_A = '41000000-0000-4000-8000-000000000001';
    const TOPICO_A = '31000000-0000-4000-8000-000000000001';

    // Inicia sessão válida e verifica que repetição retorna a mesma sessão aberta
    const sessaoId1 = await iniciarSessao(BLOCO_A, TOPICO_A);
    const sessaoId2 = await iniciarSessao(BLOCO_A, TOPICO_A);
    expect(sessaoId2).toBe(sessaoId1);

    // Conclui sessão
    const conclusao1 = await concluirSessao(sessaoId1, {
      etapaAtingida: 'revisao',
    });
    expect(conclusao1).toMatchObject({ id: sessaoId1, etapaAtingida: 'revisao' });

    // Repetição idempotente com a mesma etapa
    const conclusaoReplay = await concluirSessao(sessaoId1, {
      etapaAtingida: 'revisao',
    });
    expect(conclusaoReplay).toMatchObject({ id: sessaoId1, etapaAtingida: 'revisao' });

    // Conflito de dados: tentativa de concluir sessão já encerrada com etapa divergente
    await expect(
      concluirSessao(sessaoId1, {
        etapaAtingida: 'questoes',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // Impede atualizar cronômetro de sessão já encerrada
    await expect(
      atualizarSessao(sessaoId1, { segundosEfetivos: 900 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('garante idempotência de revisão FSRS, geração em curadoria e validação transacional de simulado', async () => {
    // 1. Revisão FSRS + replay idempotente
    const CARD_A = '50000000-0000-4000-8000-000000000001';
    const rev1 = await registrarRevisaoCard(CARD_A, 'good', 2000);
    expect(rev1.sucesso).toBe(true);

    const revCountAfterFirst = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.card_revisoes WHERE card_id = $1`,
      [CARD_A],
    );

    const rev2 = await registrarRevisaoCard(CARD_A, 'good', 2000);
    expect(rev2.sucesso).toBe(true);

    const revCountAfterReplay = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.card_revisoes WHERE card_id = $1`,
      [CARD_A],
    );
    expect(revCountAfterReplay.rows[0]?.count).toBe(revCountAfterFirst.rows[0]?.count);

    // 2. Simulado: rejeita áreas duplicadas sem persistir cabeçalho
    const simuladosBefore = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.simulados`,
    );
    const simuladoDuplicado = await registrarSimulado({
      formato: 'enem',
      data: '2026-04-10T10:00:00.000Z',
      condicoesReais: true,
      duracaoMin: 180,
      local: 'Casa',
      composicaoProcedencia: { oficial: 1 },
      areas: [
        { area: 'Natureza', total: 45, acertos: 35 },
        { area: 'natureza', total: 45, acertos: 30 },
      ],
    });
    expect(simuladoDuplicado).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    const simuladosAfter = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.simulados`,
    );
    expect(simuladosAfter.rows[0]?.count).toBe(simuladosBefore.rows[0]?.count);

    // 3. Curadoria: responsável enfileira geração do arquivo R1 e replay retorna a mesma geração sem duplicar fila
    state.currentProfile = RESPONSAVEL_A;
    state.managedStudent = ESTUDANTE_A;
    const ARQUIVO_R1 = '60000000-0000-4000-8000-000000000001';
    const geracao1 = await enfileirarGeracaoDeArtefatos(ARQUIVO_R1);
    expect(geracao1).toMatchObject({ ok: true });

    const filaCountAfterFirst = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.curadoria_fila`,
    );

    const geracao2 = await enfileirarGeracaoDeArtefatos(ARQUIVO_R1);
    expect(geracao2).toMatchObject({
      ok: true,
      data: {
        status: 'pendente_curadoria',
      },
    });

    const filaCountAfterReplay = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.curadoria_fila`,
    );
    expect(filaCountAfterReplay.rows[0]?.count).toBe(filaCountAfterFirst.rows[0]?.count);
  });
});
