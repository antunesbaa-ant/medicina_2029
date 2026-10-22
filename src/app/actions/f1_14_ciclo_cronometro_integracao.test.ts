import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import * as schema from '../../db/schema';

const MODULE_ROOT =
  process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';
const PGLITE_INDEX = path.join(MODULE_ROOT, '@electric-sql/pglite/dist/index.js');
const PGLITE_VECTOR = path.join(
  MODULE_ROOT,
  '@electric-sql/pglite-pgvector/dist/index.js'
);
const HAS_PGLITE = existsSync(PGLITE_INDEX) && existsSync(PGLITE_VECTOR);

const ESTUDANTE_1 = {
  id: '10000000-0000-4000-8000-000000000001',
  authUserId: 'a0000000-0000-4000-8000-000000000001',
  nome: 'Estudante Ficticia 1 F1.14',
  email: 'estudante1.f104@example.invalid',
  papel: 'estudante' as const,
};

const ESTUDANTE_2 = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'a0000000-0000-4000-8000-000000000002',
  nome: 'Estudante Ficticia 2 F1.14',
  email: 'estudante2.f104@example.invalid',
  papel: 'estudante' as const,
};

const RESPONSAVEL_1 = {
  id: '20000000-0000-4000-8000-000000000001',
  authUserId: 'b0000000-0000-4000-8000-000000000001',
  nome: 'Responsavel Ficticio 1 F1.14',
  email: 'responsavel1.f104@example.invalid',
  papel: 'responsavel' as const,
};

const CICLO_E1 = '40000000-0000-4000-8000-000000000001';
const BLOCO_E1_ORDEM_1 = '41000000-0000-4000-8000-000000000001';
const BLOCO_E1_ORDEM_2 = '41000000-0000-4000-8000-000000000011';
const BLOCO_E2_ORDEM_1 = '41000000-0000-4000-8000-000000000002';
const DISCIPLINA_BIOLOGIA = '30000000-0000-4000-8000-000000000001';
const TOPICO_CITOLOGIA = '31000000-0000-4000-8000-000000000001';

const state = vi.hoisted(() => ({
  currentProfile: null as
    | typeof ESTUDANTE_1
    | typeof ESTUDANTE_2
    | typeof RESPONSAVEL_1
    | null,
  simulateDbFailure: false,
  dbInstance: null as unknown,
}));

vi.mock('../../lib/authorization', () => ({
  requireAuthenticatedProfile: vi.fn(async () => {
    if (!state.currentProfile) {
      const err = new Error('Autenticação necessária.') as Error & { code: string };
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    return state.currentProfile;
  }),
  requireRole: vi.fn(async (expectedRole: 'estudante' | 'responsavel') => {
    if (!state.currentProfile) {
      const err = new Error('Autenticação necessária.') as Error & { code: string };
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    if (state.currentProfile.papel !== expectedRole) {
      const err = new Error('Acesso não autorizado.') as Error & { code: string };
      err.code = 'FORBIDDEN';
      throw err;
    }
    return state.currentProfile;
  }),
  requireStudentScope: vi.fn(async () => {
    if (!state.currentProfile) {
      const err = new Error('Autenticação necessária.') as Error & { code: string };
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    if (state.currentProfile.papel === 'estudante') {
      return state.currentProfile;
    }
    return ESTUDANTE_1;
  }),
  requireManagedStudentProfile: vi.fn(async () => {
    if (!state.currentProfile || state.currentProfile.papel !== 'responsavel') {
      const err = new Error('Acesso não autorizado.') as Error & { code: string };
      err.code = 'FORBIDDEN';
      throw err;
    }
    return ESTUDANTE_1;
  }),
  assertOwnership: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        if (state.simulateDbFailure) {
          throw new Error('Conexão PostgreSQL indisponível (simulação de falha de banco).');
        }
        const instance = state.dbInstance as Record<PropertyKey, unknown> | null;
        if (!instance) {
          throw new Error('PGlite dbInstance não inicializado.');
        }
        const value = instance[prop];
        return typeof value === 'function' ? value.bind(instance) : value;
      },
    }
  ),
}));

import {
  obterCicloAtivo,
  obterTopicosPorDisciplina,
  obterProgressoSemanalCiclo,
  atualizarPonteiroCiclo,
} from './ciclo';
import {
  iniciarSessao,
  atualizarSessao,
  concluirSessao,
  obterEstadoSessaoCronometro,
  sincronizarCheckpointSessao,
} from './sessao';
import {
  TEMPO_ETAPAS,
  reconciliarEstadoCronometroComServidor,
  type CacheLocalCronometro,
} from '../../lib/cicloCronometroReconciliacao';

describe.skipIf(!HAS_PGLITE)(
  'F1.14 — Estado Server-Side do Ciclo e Cronômetro (PostgreSQL Real PGlite + Reconciliação)',
  () => {
    let pg: {
      exec: (sql: string) => Promise<unknown>;
      query: <T = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ) => Promise<{ rows: T[] }>;
      close: () => Promise<void>;
    };

    const rootDir = process.cwd();
    const readSql = (relPath: string) =>
      readFileSync(path.join(rootDir, relPath), 'utf8').replaceAll(
        '--> statement-breakpoint',
        '\n'
      );

    const sql0000 = readSql('drizzle/0000_greedy_loki.sql');
    const sql0001 = readSql('drizzle/0001_dry_talos.sql');
    const sql0002 = readSql('drizzle/0002_little_swarm.sql');
    const sql0003 = readSql('drizzle/0003_f1_03_r_expansao.sql');
    const fixturesSql = readSql('tests/integration/f1_04/fixtures.sql');
    const f109ProposalSql = readSql(
      'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'
    );

    let txDepth = 0;

    beforeAll(async () => {
      const { PGlite, types } = await import(pathToFileURL(PGLITE_INDEX).href);
      const { vector } = await import(pathToFileURL(PGLITE_VECTOR).href);
      pg = await PGlite.create({ extensions: { vector } });

      await pg.exec(sql0000);
      await pg.exec(sql0001);
      await pg.exec(sql0002);
      await pg.exec(sql0003);
      await pg.exec(fixturesSql);
      await pg.exec(f109ProposalSql);

      // Adiciona um segundo bloco no ciclo da Estudante 1 para testar avanço e retrocesso do ponteiro
      await pg.exec(`
        INSERT INTO public.ciclo_blocos (id, ciclo_id, ordem, disciplina_id, tipo, estilo_alvo, duracao_min)
        VALUES ('${BLOCO_E1_ORDEM_2}', '${CICLO_E1}', 2, '${DISCIPLINA_BIOLOGIA}', 'questoes', 'enem', 50)
        ON CONFLICT (id) DO NOTHING;
      `);

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

      const rawQuery = (
        pg as unknown as {
          query: (
            sql: string,
            params?: unknown[],
            options?: {
              rowMode: 'array' | 'object';
              parsers: Record<number, (v: unknown) => unknown>;
            }
          ) => Promise<{ rows: unknown[] }>;
        }
      ).query.bind(pg);

      const proxyDb = drizzle(
        async (queryStr, params, method) => {
          if (state.simulateDbFailure) {
            throw new Error('Conexão PostgreSQL interrompida.');
          }
          const rowMode = method === 'all' ? 'array' : 'object';
          const res = await rawQuery(queryStr, params, { rowMode, parsers });
          return { rows: res.rows };
        },
        { schema }
      );

      (
        proxyDb as unknown as {
          transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
        }
      ).transaction = async (callback) => {
        if (state.simulateDbFailure) {
          throw new Error('Conexão PostgreSQL interrompida ao abrir transação.');
        }
        const savepoint = `sp_f114_${++txDepth}`;
        await pg.exec(txDepth === 1 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        try {
          const result = await callback(proxyDb);
          await pg.exec(txDepth === 1 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
          txDepth--;
          return result;
        } catch (err) {
          await pg.exec(
            txDepth === 1 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`
          );
          txDepth--;
          throw err;
        }
      };

      state.dbInstance = proxyDb;
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      if (pg) {
        await pg.close();
      }
    });

    beforeEach(async () => {
      state.currentProfile = ESTUDANTE_1;
      state.simulateDbFailure = false;
      // Limpa sessões criadas durante cada teste (preservando a sessão histórica encerrada da fixture)
      await pg.exec(`
        DELETE FROM public.sessoes
         WHERE id NOT IN (
           '42000000-0000-4000-8000-000000000001',
           '42000000-0000-4000-8000-000000000002'
         );
        UPDATE public.ciclo_estado
           SET proxima_ordem = 1
         WHERE ciclo_id = '${CICLO_E1}';
      `);
    });

    it('1. Início, recuperação de sessão, refresh da página e reconexão convergem para o estado persistido no PostgreSQL', async () => {
      // Estado inicial antes de abrir sessão: `nao_iniciada` com bloco sugerido do ciclo ativo
      const estadoPreInicio = await obterEstadoSessaoCronometro();
      expect(estadoPreInicio.statusSessao).toBe('nao_iniciada');
      expect(estadoPreInicio.sessao).toBeNull();
      expect(estadoPreInicio.blocoSugerido).toMatchObject({
        blocoId: BLOCO_E1_ORDEM_1,
        topicoId: TOPICO_CITOLOGIA,
        ordem: 1,
      });

      // Inicia sessão real no PostgreSQL
      const sessaoId = await iniciarSessao(BLOCO_E1_ORDEM_1, TOPICO_CITOLOGIA);
      expect(sessaoId).toBeTruthy();

      // Checkpoint periódico: avança de `revisao` para `conteudo` com 300s efetivos
      const cp1 = await sincronizarCheckpointSessao(sessaoId, {
        etapaAtual: 'conteudo',
        etapaEsperada: 'revisao',
        segundosEfetivos: 300,
        segundosPausa: 0,
        emPausa: false,
        notaLivre: 'Revisão concluída',
      });
      expect(cp1.statusSessao).toBe('em_andamento');
      expect(cp1.reconciliado).toBe(false);
      expect(cp1.sessao.etapaAtingida).toBe('conteudo');

      // Simula refresh da página (F5) ou troca de dispositivo (sem cache local):
      // `obterEstadoSessaoCronometro` recupera a sessão aberta real do PostgreSQL
      const estadoAposRefresh = await obterEstadoSessaoCronometro();
      expect(estadoAposRefresh.statusSessao).toBe('em_andamento');
      expect(estadoAposRefresh.sessao).toMatchObject({
        id: sessaoId,
        cicloBlocoId: BLOCO_E1_ORDEM_1,
        topicoId: TOPICO_CITOLOGIA,
        etapaAtingida: 'conteudo',
        notaLivre: 'Revisão concluída',
      });

      const reconciliadoSemCache = reconciliarEstadoCronometroComServidor({
        servidor: estadoAposRefresh,
        cacheLocal: null,
      });
      expect(reconciliadoSemCache.statusSessao).toBe('pausada');
      expect(reconciliadoSemCache.sessaoId).toBe(sessaoId);
      expect(reconciliadoSemCache.etapa).toBe('conteudo');
    });

    it('2. Clique duplo e duas operações simultâneas não criam sessões duplicadas nem avançam duas etapas/ordens', async () => {
      // Clique duplo em iniciarSessao retorna a mesma sessão sem duplicar linha
      const sessaoIdA = await iniciarSessao(BLOCO_E1_ORDEM_1, TOPICO_CITOLOGIA);
      const sessaoIdB = await iniciarSessao(BLOCO_E1_ORDEM_1, TOPICO_CITOLOGIA);
      expect(sessaoIdB).toBe(sessaoIdA);

      // Tentativa de iniciar outra sessão simultânea em bloco diferente para o mesmo perfil é bloqueada com CONFLICT
      await expect(
        iniciarSessao(BLOCO_E1_ORDEM_2, TOPICO_CITOLOGIA)
      ).rejects.toMatchObject({
        code: 'CONFLICT',
      });

      // Duas abas tentam avançar a etapa a partir de `etapaEsperada: 'revisao'`:
      // Aba 1 avança para `conteudo`
      const avancoAba1 = await sincronizarCheckpointSessao(sessaoIdA, {
        etapaAtual: 'conteudo',
        etapaEsperada: 'revisao',
        segundosEfetivos: 120,
        segundosPausa: 0,
      });
      expect(avancoAba1.reconciliado).toBe(false);
      expect(avancoAba1.sessao.etapaAtingida).toBe('conteudo');

      // Aba 2 (desatualizada, ainda achando que estava em `revisao`) envia o mesmo avanço ou tenta pular:
      // O servidor detecta `etapaBanco ('conteudo') !== etapaEsperada ('revisao')` e reconcilia sem pular para `questoes`
      const avancoAba2 = await sincronizarCheckpointSessao(sessaoIdA, {
        etapaAtual: 'conteudo',
        etapaEsperada: 'revisao',
        segundosEfetivos: 115,
        segundosPausa: 0,
      });
      expect(avancoAba2.reconciliado).toBe(true);
      expect(avancoAba2.motivoReconciliacao).toBe('ETAPA_JA_AVANCADA');
      expect(avancoAba2.sessao.etapaAtingida).toBe('conteudo');

      // Duas abas tentam avançar o ponteiro do ciclo a partir de `ordemEsperada: 1`:
      const ponteiroAba1 = await atualizarPonteiroCiclo(CICLO_E1, 'avancar', {
        ordemEsperada: 1,
      });
      expect(ponteiroAba1).toEqual({
        cicloId: CICLO_E1,
        proximaOrdem: 2,
        totalBlocos: 2,
        reconciliado: false,
      });

      // Aba 2 (ainda com ordemEsperada: 1) converge para 2 sem voltar a 1
      const ponteiroAba2 = await atualizarPonteiroCiclo(CICLO_E1, 'avancar', {
        ordemEsperada: 1,
      });
      expect(ponteiroAba2).toEqual({
        cicloId: CICLO_E1,
        proximaOrdem: 2,
        totalBlocos: 2,
        reconciliado: true,
      });
    });

    it('3. Estado local desatualizado (sessão encerrada ou etapa avançada em outro dispositivo) é descartado na reconciliação', async () => {
      const sessaoId = await iniciarSessao(BLOCO_E1_ORDEM_1, TOPICO_CITOLOGIA);

      // Conclui a sessão no servidor (etapa 'registro' -> avança ponteiro do ciclo de 1 para 2)
      const concluida = await concluirSessao(sessaoId, {
        etapaAtingida: 'registro',
        segundosEfetivos: 1800,
        segundosPausa: 60,
        notaLivre: 'Sessão concluída na Aba 1',
      });
      expect(concluida.concluida).toBe(true);

      // Verifica que o ponteiro no PostgreSQL avançou para 2
      const cicloAtualizado = await obterCicloAtivo();
      expect(cicloAtualizado?.proximaOrdem).toBe(2);

      const progressoSemanal = await obterProgressoSemanalCiclo();
      expect(progressoSemanal.concluidosSemana).toBeGreaterThanOrEqual(1);
      expect(progressoSemanal.sessaoAbertaId).toBeNull();

      // Aba 2 possui um localStorage antigo dizendo que a sessão ainda estava rodando na etapa 'conteudo'
      const cacheLocalFantasma: CacheLocalCronometro = {
        sessaoId,
        blocoId: BLOCO_E1_ORDEM_1,
        topicoId: TOPICO_CITOLOGIA,
        disciplinaNome: 'Biologia',
        topicoNome: 'Citologia',
        etapaAtual: 'conteudo',
        tempoRestante: TEMPO_ETAPAS.conteudo - 100,
        estaRodando: true,
        segundosEfetivos: 400,
        segundosPausa: 0,
        timestampUltimoTick: Date.now() - 30_000,
      };

      const estadoServidor = await obterEstadoSessaoCronometro({ sessaoId });
      expect(estadoServidor.statusSessao).toBe('concluida');

      const reconciliacao = reconciliarEstadoCronometroComServidor({
        servidor: estadoServidor,
        cacheLocal: cacheLocalFantasma,
      });

      expect(reconciliacao.statusSessao).toBe('concluida');
      expect(reconciliacao.estaRodando).toBe(false);
      expect(reconciliacao.cacheLocalDescartado).toBe(true);
      expect(reconciliacao.motivoDescarteCache).toBe('SESSAO_ENCERRADA_NO_SERVIDOR');

      // Tentativa de enviar checkpoint tardio da Aba 2 para a sessão já encerrada não altera o banco
      const cpTardio = await sincronizarCheckpointSessao(sessaoId, {
        etapaAtual: 'conteudo',
        segundosEfetivos: 9999,
        segundosPausa: 0,
      });
      expect(cpTardio.statusSessao).toBe('concluida');
      expect(cpTardio.motivoReconciliacao).toBe('SESSAO_JA_ENCERRADA');
      expect(cpTardio.sessao.segundosEfetivos).toBe(1800);
    });

    it('4. Falha do banco e encerramento prematuro não usam mocks nem produzem avanço fictício do ciclo', async () => {
      // Encerramento prematuro na etapa 'questoes' -> concluida = false e ponteiro permanece em 1
      const sessaoIncompletaId = await iniciarSessao(BLOCO_E1_ORDEM_1, TOPICO_CITOLOGIA);
      const sessaoIncompleta = await concluirSessao(sessaoIncompletaId, {
        etapaAtingida: 'questoes',
        segundosEfetivos: 600,
        segundosPausa: 0,
      });
      expect(sessaoIncompleta.concluida).toBe(false);

      const cicloAposPrematuro = await obterCicloAtivo();
      expect(cicloAposPrematuro?.proximaOrdem).toBe(1);

      // Simula falha de conexão com o PostgreSQL: nenhuma action deve retornar mock silencioso
      state.simulateDbFailure = true;

      await expect(obterCicloAtivo()).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
      });
      await expect(obterTopicosPorDisciplina(DISCIPLINA_BIOLOGIA)).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
      });
      await expect(obterProgressoSemanalCiclo()).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
      });
      await expect(obterEstadoSessaoCronometro()).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
      });
      await expect(
        atualizarPonteiroCiclo(CICLO_E1, 'avancar')
      ).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
      });

      // Restaura conexão e confirma que o ponteiro no PostgreSQL permaneceu intacto em 1
      state.simulateDbFailure = false;
      const cicloAposFalha = await obterCicloAtivo();
      expect(cicloAposFalha?.proximaOrdem).toBe(1);
    });

    it('5. Garante ownership, autorização por papel e rejeição de campos de identidade enviados pelo cliente', async () => {
      const sessaoEstudante1 = await iniciarSessao(BLOCO_E1_ORDEM_1, TOPICO_CITOLOGIA);

      // Estudante 2 não consegue sincronizar checkpoint, atualizar ou concluir a sessão da Estudante 1
      state.currentProfile = ESTUDANTE_2;
      await expect(
        sincronizarCheckpointSessao(sessaoEstudante1, {
          etapaAtual: 'conteudo',
          segundosEfetivos: 100,
          segundosPausa: 0,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(
        atualizarSessao(sessaoEstudante1, { etapaAtingida: 'conteudo' })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(
        concluirSessao(sessaoEstudante1, { etapaAtingida: 'registro' })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // Estudante 2 não consegue mover o ponteiro do ciclo da Estudante 1
      await expect(
        atualizarPonteiroCiclo(CICLO_E1, 'avancar')
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // Estudante 1 não consegue iniciar sessão em bloco da Estudante 2
      state.currentProfile = ESTUDANTE_1;
      await expect(
        iniciarSessao(BLOCO_E2_ORDEM_1, TOPICO_CITOLOGIA)
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // Responsável não pode iniciar sessão de estudo nem alterar ponteiro de execução da estudante
      state.currentProfile = RESPONSAVEL_1;
      await expect(
        iniciarSessao(BLOCO_E1_ORDEM_1, TOPICO_CITOLOGIA)
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        atualizarPonteiroCiclo(CICLO_E1, 'avancar')
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      // Tentativa de injetar perfilId ou papel no payload do cliente é rejeitada pelo schema F1.09/F1.14
      state.currentProfile = ESTUDANTE_1;
      await expect(
        sincronizarCheckpointSessao(sessaoEstudante1, {
          etapaAtual: 'conteudo',
          segundosEfetivos: 100,
          segundosPausa: 0,
          perfilId: ESTUDANTE_2.id,
        } as unknown as Parameters<typeof sincronizarCheckpointSessao>[1])
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  }
);
