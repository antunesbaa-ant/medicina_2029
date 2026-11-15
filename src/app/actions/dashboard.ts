'use server';

import { db } from '../../db';
import {
  sessoes,
  tentativas,
  questoes,
  erros,
  cards,
  checkins,
  redacoes,
  simulados,
  simuladoAreas,
  curadoriaFila,
  topicos,
  disciplinas
} from '../../db/schema';
import { eq, and, lte, gte, sql, desc } from 'drizzle-orm';
import { calcularDivergenciaTrilhos } from '../../lib/studysystem';
import { requireRole, AuthorizationError } from '../../lib/authorization';
import { applyRlsContext } from '../../db/rls-context';

export interface DashboardMetrics {
  aderencia: {
    valor: number;
    previsto: number;
    realizado: number;
    alerta: boolean;
    mensagem: string;
  };
  divergencia: {
    enemPct: number;
    conteudistaPct: number;
    valor: number;
    alerta: boolean;
    diagnostico: string;
  };
  perfilErro: {
    distribuicao: Array<{ tipo: string; porcentagem: number; contagem: number }>;
    alerta: boolean;
    tipoAlerta: string;
  };
  filaRevisao: {
    totalCardsDue: number;
    alerta: boolean;
  };
  sono: {
    mediaHoras: number;
    alerta: boolean;
  };
  redacoes: {
    escritas: number;
    reescritas: number;
    meta: number;
    alerta: boolean;
  };
  simuladosEvolucao: Array<{
    data: string;
    mediaGlobal: number;
    areas: Array<{ area: string; acertosPct: number }>;
  }>;
  saudeCuradoria: {
    pendentes: number;
    idadeMinimaDias: number;
    alerta: boolean;
  };
}

// 1. Obter todas as métricas calculadas
export async function obterMetricasDashboard(): Promise<DashboardMetrics> {
  const perfil = await requireRole('estudante');

  try {
    const estudantePerfilId = perfil.id;

    return await db.transaction(async (tx) => {
      await applyRlsContext(tx, estudantePerfilId, perfil.papel);

      // A. Aderência (últimas 4 semanas)
      const quatroSemanasAtras = new Date();
      quatroSemanasAtras.setDate(quatroSemanasAtras.getDate() - 28);

      const [sessoesCount] = await tx
        .select({ count: sql<number>`count(${sessoes.id})::int` })
        .from(sessoes)
        .where(
          and(
            eq(sessoes.perfilId, estudantePerfilId),
            eq(sessoes.concluida, true),
            gte(sessoes.iniciadaEm, quatroSemanasAtras)
          )
        );

      const realizadoSessoes = sessoesCount?.count || 0;
      const previstoSessoes = 24; // Meta estipulada de 6 blocos por semana
      const aderenciaVal = previstoSessoes > 0 ? (realizadoSessoes / previstoSessoes) * 100 : 0;
      const aderenciaAlerta = aderenciaVal < 70;

      // B. Divergência de trilhos (últimas 300 tentativas com estilo real da questão)
      const tentativasDb = await tx
        .select({
          correta: tentativas.correta,
          estilo: questoes.estilo
        })
        .from(tentativas)
        .innerJoin(questoes, eq(tentativas.questaoId, questoes.id))
        .where(eq(tentativas.perfilId, estudantePerfilId))
        .orderBy(desc(tentativas.criadoEm))
        .limit(300);

      const divObj = calcularDivergenciaTrilhos(tentativasDb);

      // C. Perfil de Erro (últimos 90 dias)
      const noventaDiasAtras = new Date();
      noventaDiasAtras.setDate(noventaDiasAtras.getDate() - 90);

      const errosDb = await tx
        .select({
          tipoErro: erros.tipoErro,
          count: sql<number>`count(${erros.id})::int`
        })
        .from(erros)
        .where(
          and(
            eq(erros.perfilId, estudantePerfilId),
            gte(erros.criadoEm, noventaDiasAtras)
          )
        )
        .groupBy(erros.tipoErro);

      const totalErros = errosDb.reduce((acc, curr) => acc + curr.count, 0);
      const distribuicaoErros = errosDb.map(e => ({
        tipo: e.tipoErro,
        porcentagem: totalErros > 0 ? Math.round((e.count / totalErros) * 100) : 0,
        contagem: e.count
      }));

      const erroDominante = distribuicaoErros.find(d => d.porcentagem > 40);
      const erroAlerta = !!erroDominante;

      // D. Fila de revisão SRS (Due cards)
      const [dueCardsCount] = await tx
        .select({ count: sql<number>`count(${cards.id})::int` })
        .from(cards)
        .where(
          and(
            eq(cards.perfilId, estudantePerfilId),
            eq(cards.status, 'aprovado'),
            eq(cards.suspenso, false),
            lte(cards.due, new Date())
          )
        );

      const totalDue = dueCardsCount?.count || 0;
      const srsAlerta = totalDue > 300;

      // E. Média de sono (últimos 14 dias)
      const quatorzeDiasAtras = new Date();
      quatorzeDiasAtras.setDate(quatorzeDiasAtras.getDate() - 14);

      const [sonoStats] = await tx
        .select({ media: sql<number>`avg(${checkins.horasSono})::float` })
        .from(checkins)
        .where(
          and(
            eq(checkins.perfilId, estudantePerfilId),
            gte(checkins.data, quatorzeDiasAtras)
          )
        );

      const mediaSono = sonoStats?.media ? Math.round(sonoStats.media * 10) / 10 : 0;
      const sonoAlerta = mediaSono > 0 && mediaSono < 7.5;

      // F. Redações vs Meta
      const [redacoesCount] = await tx
        .select({
          count: sql<number>`count(${redacoes.id})::int`,
          reescritas: sql<number>`count(case when ${redacoes.reescritadeId} is not null then 1 end)::int`
        })
        .from(redacoes)
        .where(eq(redacoes.perfilId, estudantePerfilId));

      const escritas = redacoesCount?.count || 0;
      const reescritas = redacoesCount?.reescritas || 0;
      const metaAnual = 40;
      const redacoesAlerta = escritas < 12;

      // G. Saúde da curadoria
      const [curadoriaStats] = await tx
        .select({
          count: sql<number>`count(${curadoriaFila.id})::int`,
          maisAntigo: sql<string>`min(${curadoriaFila.criadoEm})::text`
        })
        .from(curadoriaFila)
        .where(eq(curadoriaFila.decisao, 'pendente'));

      const curadoriaPendentes = curadoriaStats?.count || 0;
      const idadeCuradoriaDias = curadoriaStats?.maisAntigo 
        ? Math.round((Date.now() - new Date(curadoriaStats.maisAntigo).getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      const curadoriaAlerta = curadoriaPendentes > 200 || idadeCuradoriaDias > 30;

      // H. Histórico real de simulados
      let simuladosHistorico: DashboardMetrics['simuladosEvolucao'] = [];
      try {
        const simuladosDb = await tx
          .select({
            id: simulados.id,
            data: simulados.data,
          })
          .from(simulados)
          .where(eq(simulados.perfilId, estudantePerfilId))
          .orderBy(desc(simulados.data))
          .limit(5);

        if (simuladosDb.length > 0) {
          const simuladoIds = simuladosDb.map(s => s.id);
          const areasDb = await tx
            .select({
              simuladoId: simuladoAreas.simuladoId,
              area: simuladoAreas.area,
              acertos: simuladoAreas.acertos,
              total: simuladoAreas.total
            })
            .from(simuladoAreas)
            .where(sql`${simuladoAreas.simuladoId} IN ${simuladoIds}`);

          simuladosHistorico = simuladosDb.map(s => {
            const areasDoSimulado = areasDb.filter(a => a.simuladoId === s.id);
            const totalAcertos = areasDoSimulado.reduce((acc, curr) => acc + curr.acertos, 0);
            const totalQuestoes = areasDoSimulado.reduce((acc, curr) => acc + curr.total, 0);
            const mediaGlobal = totalQuestoes > 0 ? Math.round((totalAcertos / totalQuestoes) * 1000) : 0;
            return {
              data: new Date(s.data).toLocaleDateString('pt-BR'),
              mediaGlobal,
              areas: areasDoSimulado.map(a => ({
                area: a.area,
                acertosPct: a.total > 0 ? Math.round((a.acertos / a.total) * 100) : 0
              }))
            };
          });
        }
      } catch {
        simuladosHistorico = [];
      }

      const mensagemAderencia = realizadoSessoes === 0
        ? 'Nenhuma sessão concluída nas últimas 4 semanas. Inicie seus estudos pelo Ciclo!'
        : aderenciaAlerta
          ? 'Carga horária reduzida ou baixa aderência nas últimas 4 semanas. Recomenda-se regularizar as sessões previstas.'
          : 'Aderência excelente dentro do planejado.';

      return {
        aderencia: {
          valor: Math.round(aderenciaVal),
          previsto: previstoSessoes,
          realizado: realizadoSessoes,
          alerta: aderenciaAlerta,
          mensagem: mensagemAderencia
        },
        divergencia: {
          enemPct: divObj.acertoEnem,
          conteudistaPct: divObj.acertoConteudista,
          valor: divObj.divergencia,
          alerta: divObj.alerta,
          diagnostico: divObj.diagnostico
        },
        perfilErro: {
          distribuicao: distribuicaoErros,
          alerta: erroAlerta,
          tipoAlerta: erroDominante?.tipo || 'conteudo'
        },
        filaRevisao: {
          totalCardsDue: totalDue,
          alerta: srsAlerta
        },
        sono: {
          mediaHoras: mediaSono,
          alerta: sonoAlerta
        },
        redacoes: {
          escritas,
          reescritas,
          meta: metaAnual,
          alerta: redacoesAlerta
        },
        simuladosEvolucao: simuladosHistorico,
        saudeCuradoria: {
          pendentes: curadoriaPendentes,
          idadeMinimaDias: idadeCuradoriaDias,
          alerta: curadoriaAlerta
        }
      };
    });
  } catch (error) {
    if (
      (error instanceof AuthorizationError) ||
      (error as Error)?.name === 'AuthorizationError' ||
      (error as Error)?.message?.includes('Acesso negado')
    ) {
      throw error;
    }
    console.error('Erro ao calcular métricas:', error);
    return obterMetricasDashboardVazias('Não foi possível carregar as métricas em tempo real. Exibindo estado seguro.');
  }
}

// Métricas legítimas vazias para novos estudantes ou situações de fallback seguro
export async function obterMetricasDashboardVazias(mensagemAderencia?: string): Promise<DashboardMetrics> {
  return {
    aderencia: {
      valor: 0,
      previsto: 24,
      realizado: 0,
      alerta: false,
      mensagem: mensagemAderencia || 'Nenhuma sessão concluída nas últimas 4 semanas. Inicie seus estudos pelo Ciclo!'
    },
    divergencia: {
      enemPct: 0,
      conteudistaPct: 0,
      valor: 0,
      alerta: false,
      diagnostico: 'Sem questões suficientes para calcular divergência entre os trilhos.'
    },
    perfilErro: {
      distribuicao: [],
      alerta: false,
      tipoAlerta: 'conteudo'
    },
    filaRevisao: {
      totalCardsDue: 0,
      alerta: false
    },
    sono: {
      mediaHoras: 0,
      alerta: false
    },
    redacoes: {
      escritas: 0,
      reescritas: 0,
      meta: 40,
      alerta: false
    },
    simuladosEvolucao: [],
    saudeCuradoria: {
      pendentes: 0,
      idadeMinimaDias: 0,
      alerta: false
    }
  };
}
