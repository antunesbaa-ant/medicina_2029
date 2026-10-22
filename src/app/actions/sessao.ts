'use server';

import { db } from '../../db';
import {
  sessoes,
  ciclos,
  cicloBlocos,
  cicloEstado,
  disciplinas,
  erros,
  questoes,
  tentativas,
  topicos,
} from '../../db/schema';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { validarConclusaoSessao, calcularProximaOrdem } from '../../lib/studysystem';
import { requireRole } from '../../lib/authorization';
import { PublicOperationError, logOperationalFailure } from '../../lib/operation-result';
import {
  iniciarSessaoInputSchema,
  atualizarSessaoInputSchema,
  concluirSessaoInputSchema,
  obterEstadoSessaoCronometroInputSchema,
  sincronizarCheckpointSessaoInputSchema,
} from '../../lib/validation';
import {
  calcularTetoSegundosDecorridosServidor,
  etapaMaisAvancada,
  type BlocoSugeridoServidor,
  type EstadoServidorCronometro,
  type EtapaPedagogicaSessao,
} from '../../lib/cicloCronometroReconciliacao';
import { applyRlsContext } from '../../db/rls-context';

export async function iniciarSessao(
  cicloBlocoId: string,
  topicoId: string
): Promise<string> {
  const perfil = await requireRole('estudante');
  const validado = iniciarSessaoInputSchema.parse({ cicloBlocoId, topicoId });

  try {
    return await db.transaction(async (tx) => {
      await applyRlsContext(tx, perfil.id, perfil.papel);

      // O advisory lock por perfil e bloco/tópico serializa cliques duplos e abas concorrentes
      // mesmo quando ainda não existe linha em public.sessoes para bloquear.
      await tx.execute(sql`
        SELECT
          pg_advisory_xact_lock(hashtextextended(${perfil.id}::text, 0)),
          pg_advisory_xact_lock(
            hashtextextended(concat_ws(':', ${perfil.id}::text, ${validado.cicloBlocoId}::text, ${validado.topicoId}::text), 0)
          );
      `);

      const [sessaoAberta] = await tx
        .select({
          id: sessoes.id,
          cicloBlocoId: sessoes.cicloBlocoId,
          topicoId: sessoes.topicoId,
        })
        .from(sessoes)
        .where(
          and(
            eq(sessoes.perfilId, perfil.id),
            isNull(sessoes.encerradaEm)
          )
        )
        .limit(1);

      if (sessaoAberta) {
        const mesmoBloco =
          !sessaoAberta.cicloBlocoId || sessaoAberta.cicloBlocoId === validado.cicloBlocoId;
        const mesmoTopico =
          !sessaoAberta.topicoId || sessaoAberta.topicoId === validado.topicoId;

        if (mesmoBloco && mesmoTopico) {
          return sessaoAberta.id;
        }

        throw new PublicOperationError(
          'CONFLICT',
          'Já existe outra sessão de estudo em andamento para este perfil. Retome ou encerre a sessão aberta antes de iniciar outra.'
        );
      }

      // Integridade relacional: verifica que o bloco pertence a ciclo do perfil
      // autorizado (compatível com expansão F1.03-R) e que o tópico é da mesma disciplina.
      const [vinculoBlocoTopico] = await tx
        .select({
          blocoId: cicloBlocos.id,
          estudantePerfilId: ciclos.estudantePerfilId,
          blocoDisciplinaId: cicloBlocos.disciplinaId,
          topicoDisciplinaId: topicos.disciplinaId,
        })
        .from(cicloBlocos)
        .innerJoin(ciclos, eq(cicloBlocos.cicloId, ciclos.id))
        .innerJoin(topicos, eq(topicos.id, validado.topicoId))
        .where(
          and(
            eq(cicloBlocos.id, validado.cicloBlocoId),
            eq(cicloBlocos.disciplinaId, topicos.disciplinaId),
            or(eq(ciclos.estudantePerfilId, perfil.id), isNull(ciclos.estudantePerfilId))
          )
        )
        .limit(1);

      if (
        !vinculoBlocoTopico ||
        (vinculoBlocoTopico.estudantePerfilId &&
          vinculoBlocoTopico.estudantePerfilId !== perfil.id) ||
        (vinculoBlocoTopico.blocoDisciplinaId &&
          vinculoBlocoTopico.topicoDisciplinaId &&
          vinculoBlocoTopico.blocoDisciplinaId !== vinculoBlocoTopico.topicoDisciplinaId)
      ) {
        throw new PublicOperationError(
          'NOT_FOUND',
          'Bloco do ciclo ou tópico não encontrado ou acesso não permitido.'
        );
      }

      const [sessaoInserida] = await tx
        .insert(sessoes)
        .values({
          perfilId: perfil.id,
          cicloBlocoId: validado.cicloBlocoId,
          topicoId: validado.topicoId,
          iniciadaEm: new Date(),
          segundosEfetivos: 0,
          segundosPausa: 0,
          etapaAtingida: 'revisao',
          concluida: false,
        })
        .returning();

      if (!sessaoInserida) {
        logOperationalFailure('sessao.start_without_returning', 'persistence');
        throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível confirmar o início da sessão.');
      }

      return sessaoInserida.id;
    });
  } catch (error) {
    if (error instanceof PublicOperationError) throw error;
    logOperationalFailure('sessao.start', 'persistence');
    throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível iniciar a sessão.');
  }
}

export interface DadosAtualizacaoSessao {
  etapaAtingida?: 'revisao' | 'conteudo' | 'questoes' | 'registro';
  segundosEfetivos?: number;
  segundosPausa?: number;
  notaLivre?: string;
}

export async function atualizarSessao(
  sessaoId: string,
  dados: DadosAtualizacaoSessao
): Promise<typeof sessoes.$inferSelect> {
  const perfil = await requireRole('estudante');
  const { sessaoId: sessaoIdValido, dados: dadosValidos } = atualizarSessaoInputSchema.parse({
    sessaoId,
    dados,
  });

  try {
    const executarAtualizacao = async (executor: typeof db) => {
      const [sessaoAtualizada] = await executor
        .update(sessoes)
        .set({
          ...(dadosValidos.etapaAtingida && { etapaAtingida: dadosValidos.etapaAtingida }),
          ...(dadosValidos.segundosEfetivos !== undefined && { segundosEfetivos: dadosValidos.segundosEfetivos }),
          ...(dadosValidos.segundosPausa !== undefined && { segundosPausa: dadosValidos.segundosPausa }),
          ...(dadosValidos.notaLivre !== undefined && { notaLivre: dadosValidos.notaLivre }),
        })
        .where(and(
          eq(sessoes.id, sessaoIdValido),
          eq(sessoes.perfilId, perfil.id),
          isNull(sessoes.encerradaEm)
        ))
        .returning();

      if (!sessaoAtualizada) {
        throw new PublicOperationError('NOT_FOUND', 'Sessão não encontrada ou acesso não permitido.');
      }

      return sessaoAtualizada;
    };

    if (typeof (db as unknown as { transaction?: unknown }).transaction === 'function') {
      return await db.transaction(async (tx) => {
        await applyRlsContext(tx, perfil.id, perfil.papel);
        return await executarAtualizacao(tx as unknown as typeof db);
      });
    }

    return await executarAtualizacao(db);
  } catch (error) {
    if (error instanceof PublicOperationError) throw error;
    logOperationalFailure('sessao.update', 'persistence');
    throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível atualizar a sessão.');
  }
}

export interface DadosCheckpointSessao {
  etapaAtual: EtapaPedagogicaSessao;
  etapaEsperada?: EtapaPedagogicaSessao;
  segundosEfetivos: number;
  segundosPausa: number;
  emPausa?: boolean;
  notaLivre?: string;
}

export interface ResultadoCheckpointSessao {
  statusSessao: 'em_andamento' | 'pausada' | 'concluida';
  sessao: typeof sessoes.$inferSelect;
  reconciliado: boolean;
  motivoReconciliacao?: 'SESSAO_JA_ENCERRADA' | 'ETAPA_JA_AVANCADA';
}

/**
 * F1.14 — Sincroniza checkpoint periódico ou transição de etapa do cronômetro
 * diretamente no PostgreSQL com bloqueio transacional (`FOR UPDATE`), progressão
 * monotônica de etapa/tempo e proteção contra avanço duplo em cliques ou abas simultâneas.
 */
export async function sincronizarCheckpointSessao(
  sessaoId: string,
  dados: DadosCheckpointSessao
): Promise<ResultadoCheckpointSessao> {
  const perfil = await requireRole('estudante');
  const { sessaoId: sessaoIdValido, dados: dadosValidos } =
    sincronizarCheckpointSessaoInputSchema.parse({ sessaoId, dados });

  try {
    return await db.transaction(async (tx) => {
      await applyRlsContext(tx, perfil.id, perfil.papel);

      const [sessaoAtual] = await tx
        .select()
        .from(sessoes)
        .where(and(eq(sessoes.id, sessaoIdValido), eq(sessoes.perfilId, perfil.id)))
        .limit(1)
        .for('update');

      if (!sessaoAtual || (sessaoAtual.perfilId && sessaoAtual.perfilId !== perfil.id)) {
        throw new PublicOperationError(
          'NOT_FOUND',
          'Sessão não encontrada ou acesso não permitido.'
        );
      }

      // Se a sessão já foi encerrada em outra aba/dispositivo, retorna o estado
      // encerrado real sem modificar a linha nem inventar tempo adicional.
      if (sessaoAtual.encerradaEm) {
        return {
          statusSessao: 'concluida',
          sessao: sessaoAtual,
          reconciliado: true,
          motivoReconciliacao: 'SESSAO_JA_ENCERRADA',
        };
      }

      const etapaBanco = (sessaoAtual.etapaAtingida ?? 'revisao') as EtapaPedagogicaSessao;
      const tetoSegundos = calcularTetoSegundosDecorridosServidor(
        sessaoAtual.iniciadaEm,
        Date.now()
      );

      const segundosEfetivosConsolidados = Math.max(
        sessaoAtual.segundosEfetivos ?? 0,
        Math.min(tetoSegundos, dadosValidos.segundosEfetivos)
      );
      const segundosPausaConsolidados = Math.max(
        sessaoAtual.segundosPausa ?? 0,
        Math.min(tetoSegundos, dadosValidos.segundosPausa)
      );

      // Se a requisição tentava uma transição de etapa a partir de `etapaEsperada`,
      // mas outra aba/clique já mudou a etapa no banco, evita avanço duplo e converge.
      if (
        dadosValidos.etapaEsperada !== undefined &&
        etapaBanco !== dadosValidos.etapaEsperada
      ) {
        const etapaConvergida = etapaMaisAvancada(etapaBanco, dadosValidos.etapaEsperada);
        const [sessaoReconciliada] = await tx
          .update(sessoes)
          .set({
            etapaAtingida: etapaConvergida,
            segundosEfetivos: segundosEfetivosConsolidados,
            segundosPausa: segundosPausaConsolidados,
            ...(dadosValidos.notaLivre !== undefined && { notaLivre: dadosValidos.notaLivre }),
          })
          .where(and(eq(sessoes.id, sessaoIdValido), eq(sessoes.perfilId, perfil.id)))
          .returning();

        return {
          statusSessao: dadosValidos.emPausa ? 'pausada' : 'em_andamento',
          sessao: sessaoReconciliada ?? sessaoAtual,
          reconciliado: true,
          motivoReconciliacao: 'ETAPA_JA_AVANCADA',
        };
      }

      const novaEtapa = etapaMaisAvancada(etapaBanco, dadosValidos.etapaAtual);

      const [sessaoAtualizada] = await tx
        .update(sessoes)
        .set({
          etapaAtingida: novaEtapa,
          segundosEfetivos: segundosEfetivosConsolidados,
          segundosPausa: segundosPausaConsolidados,
          ...(dadosValidos.notaLivre !== undefined && { notaLivre: dadosValidos.notaLivre }),
        })
        .where(
          and(
            eq(sessoes.id, sessaoIdValido),
            eq(sessoes.perfilId, perfil.id),
            isNull(sessoes.encerradaEm)
          )
        )
        .returning();

      if (!sessaoAtualizada) {
        throw new PublicOperationError(
          'PERSISTENCE_ERROR',
          'Não foi possível sincronizar o progresso da sessão.'
        );
      }

      return {
        statusSessao: dadosValidos.emPausa ? 'pausada' : 'em_andamento',
        sessao: sessaoAtualizada,
        reconciliado: false,
      };
    });
  } catch (error) {
    if (error instanceof PublicOperationError) throw error;
    logOperationalFailure('sessao.checkpoint', 'persistence');
    throw new PublicOperationError(
      'PERSISTENCE_ERROR',
      'Não foi possível sincronizar a sessão com o servidor.'
    );
  }
}

/**
 * F1.14 — Recupera o estado autoritativo da sessão e do cronômetro a partir do PostgreSQL
 * após atualização de página (F5), reconexão, retorno ao aplicativo ou troca de dispositivo.
 */
export async function obterEstadoSessaoCronometro(opcoes?: {
  sessaoId?: string;
  cicloBlocoId?: string;
  topicoId?: string;
}): Promise<EstadoServidorCronometro> {
  const perfil = await requireRole('estudante');
  const validado = obterEstadoSessaoCronometroInputSchema.parse(opcoes ?? {});

  try {
    // 1. Verifica se existe uma sessão aberta (`encerrada_em IS NULL`) para a estudante autenticada
    const [aberta] = await db
      .select({
        sessao: sessoes,
        bloco: cicloBlocos,
        ciclo: ciclos,
        disciplina: disciplinas,
        topico: topicos,
      })
      .from(sessoes)
      .innerJoin(cicloBlocos, eq(sessoes.cicloBlocoId, cicloBlocos.id))
      .innerJoin(ciclos, eq(cicloBlocos.cicloId, ciclos.id))
      .innerJoin(disciplinas, eq(cicloBlocos.disciplinaId, disciplinas.id))
      .innerJoin(topicos, eq(sessoes.topicoId, topicos.id))
      .where(and(eq(sessoes.perfilId, perfil.id), isNull(sessoes.encerradaEm)))
      .limit(1);

    if (aberta) {
      const [estadoCiclo] = await db
        .select({ proximaOrdem: cicloEstado.proximaOrdem })
        .from(cicloEstado)
        .where(eq(cicloEstado.cicloId, aberta.ciclo.id))
        .limit(1);

      return {
        statusSessao: 'em_andamento',
        sessao: {
          id: aberta.sessao.id,
          cicloBlocoId: aberta.bloco.id,
          topicoId: aberta.topico.id,
          disciplinaId: aberta.disciplina.id,
          disciplinaNome: aberta.disciplina.nome,
          topicoNome: aberta.topico.nome,
          iniciadaEm: aberta.sessao.iniciadaEm,
          encerradaEm: null,
          etapaAtingida: (aberta.sessao.etapaAtingida ?? 'revisao') as EtapaPedagogicaSessao,
          segundosEfetivos: aberta.sessao.segundosEfetivos ?? 0,
          segundosPausa: aberta.sessao.segundosPausa ?? 0,
          concluida: Boolean(aberta.sessao.concluida),
          notaLivre: aberta.sessao.notaLivre ?? null,
        },
        blocoSugerido: null,
        proximaOrdemCiclo: estadoCiclo?.proximaOrdem ?? aberta.bloco.ordem,
        serverTimestampMs: Date.now(),
      };
    }

    // 2. Se não há sessão aberta, mas o cliente enviou um `sessaoId` do cache local,
    //    verifica se essa sessão já foi encerrada no banco (estado local desatualizado).
    if (validado.sessaoId) {
      const [encerrada] = await db
        .select({
          sessao: sessoes,
          bloco: cicloBlocos,
          ciclo: ciclos,
          disciplina: disciplinas,
          topico: topicos,
        })
        .from(sessoes)
        .innerJoin(cicloBlocos, eq(sessoes.cicloBlocoId, cicloBlocos.id))
        .innerJoin(ciclos, eq(cicloBlocos.cicloId, ciclos.id))
        .innerJoin(disciplinas, eq(cicloBlocos.disciplinaId, disciplinas.id))
        .innerJoin(topicos, eq(sessoes.topicoId, topicos.id))
        .where(and(eq(sessoes.id, validado.sessaoId), eq(sessoes.perfilId, perfil.id)))
        .limit(1);

      const pediuNovoBlocoExplicitamente =
        Boolean(validado.cicloBlocoId) && validado.cicloBlocoId !== encerrada?.bloco.id;

      if (encerrada && encerrada.sessao.encerradaEm && !pediuNovoBlocoExplicitamente) {
        const [estadoCiclo] = await db
          .select({ proximaOrdem: cicloEstado.proximaOrdem })
          .from(cicloEstado)
          .where(eq(cicloEstado.cicloId, encerrada.ciclo.id))
          .limit(1);

        return {
          statusSessao: 'concluida',
          sessao: {
            id: encerrada.sessao.id,
            cicloBlocoId: encerrada.bloco.id,
            topicoId: encerrada.topico.id,
            disciplinaId: encerrada.disciplina.id,
            disciplinaNome: encerrada.disciplina.nome,
            topicoNome: encerrada.topico.nome,
            iniciadaEm: encerrada.sessao.iniciadaEm,
            encerradaEm: encerrada.sessao.encerradaEm,
            etapaAtingida: (encerrada.sessao.etapaAtingida ?? 'revisao') as EtapaPedagogicaSessao,
            segundosEfetivos: encerrada.sessao.segundosEfetivos ?? 0,
            segundosPausa: encerrada.sessao.segundosPausa ?? 0,
            concluida: Boolean(encerrada.sessao.concluida),
            notaLivre: encerrada.sessao.notaLivre ?? null,
          },
          blocoSugerido: null,
          proximaOrdemCiclo: estadoCiclo?.proximaOrdem ?? 1,
          serverTimestampMs: Date.now(),
        };
      }
    }

    // 3. Nenhuma sessão em andamento: resolve o próximo bloco real do ciclo ativo no PostgreSQL
    const [cicloAtivo] = await db
      .select()
      .from(ciclos)
      .where(and(eq(ciclos.ativo, true), eq(ciclos.estudantePerfilId, perfil.id)))
      .limit(1);

    if (!cicloAtivo) {
      return {
        statusSessao: 'nao_iniciada',
        sessao: null,
        blocoSugerido: null,
        proximaOrdemCiclo: 1,
        serverTimestampMs: Date.now(),
      };
    }

    const blocos = await db
      .select({
        bloco: cicloBlocos,
        disciplina: disciplinas,
      })
      .from(cicloBlocos)
      .innerJoin(disciplinas, eq(cicloBlocos.disciplinaId, disciplinas.id))
      .where(eq(cicloBlocos.cicloId, cicloAtivo.id))
      .orderBy(asc(cicloBlocos.ordem));

    const [estadoCiclo] = await db
      .select({ proximaOrdem: cicloEstado.proximaOrdem })
      .from(cicloEstado)
      .where(eq(cicloEstado.cicloId, cicloAtivo.id))
      .limit(1);

    const ordemBruta = estadoCiclo?.proximaOrdem ?? 1;
    const proximaOrdemCiclo =
      blocos.length > 0 && (ordemBruta < 1 || ordemBruta > blocos.length) ? 1 : ordemBruta;

    const itemBloco =
      (validado.cicloBlocoId
        ? blocos.find((b) => b.bloco.id === validado.cicloBlocoId)
        : undefined) ??
      blocos.find((b) => b.bloco.ordem === proximaOrdemCiclo) ??
      blocos[0];

    let blocoSugerido: BlocoSugeridoServidor | null = null;
    if (itemBloco) {
      const topicosDisciplina = await db
        .select()
        .from(topicos)
        .where(eq(topicos.disciplinaId, itemBloco.disciplina.id))
        .orderBy(asc(topicos.ordem));

      const topicoEscolhido =
        (validado.topicoId
          ? topicosDisciplina.find((t) => t.id === validado.topicoId)
          : undefined) ?? topicosDisciplina[0];

      if (topicoEscolhido) {
        blocoSugerido = {
          blocoId: itemBloco.bloco.id,
          cicloId: cicloAtivo.id,
          ordem: itemBloco.bloco.ordem,
          disciplinaId: itemBloco.disciplina.id,
          disciplinaNome: itemBloco.disciplina.nome,
          topicoId: topicoEscolhido.id,
          topicoNome: topicoEscolhido.nome,
        };
      }
    }

    return {
      statusSessao: 'nao_iniciada',
      sessao: null,
      blocoSugerido,
      proximaOrdemCiclo,
      serverTimestampMs: Date.now(),
    };
  } catch (error) {
    if (error instanceof PublicOperationError) throw error;
    logOperationalFailure('sessao.obter_estado_cronometro', 'persistence');
    throw new PublicOperationError(
      'PERSISTENCE_ERROR',
      'Não foi possível recuperar o estado da sessão no servidor.'
    );
  }
}

export interface ErroParaRegistrar {
  questaoId: string;
  tentativaId: string;
  tipoErro: 'conteudo' | 'interpretacao' | 'distracao' | 'calculo' | 'tempo';
  descricaoLivre?: string;
  conceitoCorreto?: string;
}

export interface DadosFinalizacaoSessao {
  encerradaEm?: Date;
  segundosEfetivos?: number;
  segundosPausa?: number;
  etapaAtingida: 'revisao' | 'conteudo' | 'questoes' | 'registro';
  notaLivre?: string;
  errosParaRegistrar?: ErroParaRegistrar[];
}

export async function concluirSessao(
  sessaoId: string,
  dadosFinalizacao: DadosFinalizacaoSessao
): Promise<typeof sessoes.$inferSelect> {
  const perfil = await requireRole('estudante');
  const { sessaoId: sessaoIdValido, dadosFinalizacao: finalizacaoValida } =
    concluirSessaoInputSchema.parse({ sessaoId, dadosFinalizacao });

  try {
    return await db.transaction(async (tx) => {
      await applyRlsContext(tx, perfil.id, perfil.papel);

      // O lock serializa duplo clique/duas abas. encerradaEm funciona como marcador
      // idempotente compatível com o schema atual, sem exigir migration.
      const [dadosSessao] = await tx
        .select({
          sessao: sessoes,
          bloco: cicloBlocos,
          ciclo: ciclos,
        })
        .from(sessoes)
        .where(
          and(
            eq(sessoes.id, sessaoIdValido),
            eq(sessoes.perfilId, perfil.id),
            or(eq(ciclos.estudantePerfilId, perfil.id), isNull(ciclos.estudantePerfilId))
          )
        )
        .innerJoin(cicloBlocos, eq(sessoes.cicloBlocoId, cicloBlocos.id))
        .innerJoin(ciclos, eq(cicloBlocos.cicloId, ciclos.id))
        .limit(1)
        .for('update');

      if (
        !dadosSessao ||
        (dadosSessao.sessao.perfilId && dadosSessao.sessao.perfilId !== perfil.id) ||
        (dadosSessao.ciclo?.estudantePerfilId &&
          dadosSessao.ciclo.estudantePerfilId !== perfil.id)
      ) {
        throw new PublicOperationError('NOT_FOUND', 'Sessão não encontrada ou acesso não permitido.');
      }

      const { sessao, bloco } = dadosSessao;
      if (sessao.encerradaEm) {
        if (sessao.etapaAtingida && sessao.etapaAtingida !== finalizacaoValida.etapaAtingida) {
          throw new PublicOperationError(
            'CONFLICT',
            'Esta sessão já foi encerrada com estado divergente.'
          );
        }
        return sessao;
      }

      if (
        finalizacaoValida.encerradaEm &&
        sessao.iniciadaEm &&
        finalizacaoValida.encerradaEm.getTime() < new Date(sessao.iniciadaEm).getTime()
      ) {
        throw new PublicOperationError(
          'VALIDATION_ERROR',
          'A data de encerramento não pode ser anterior ao início da sessão.'
        );
      }

      // 2. Valida conclusão de acordo com a etapa atingida
      const concluida = validarConclusaoSessao(finalizacaoValida.etapaAtingida);

      const errosValidados: Array<ErroParaRegistrar & { disciplinaId: string; estilo: 'enem' | 'conteudista' | 'misto' }> = [];
      for (const erro of finalizacaoValida.errosParaRegistrar ?? []) {
        const [questao] = await tx
          .select({ disciplinaId: questoes.disciplinaId, estilo: questoes.estilo })
          .from(questoes)
          .where(eq(questoes.id, erro.questaoId))
          .limit(1);

        const [tentativa] = await tx
          .select({
            id: tentativas.id,
            perfilId: tentativas.perfilId,
            sessaoId: tentativas.sessaoId,
            questaoId: tentativas.questaoId,
            correta: tentativas.correta,
          })
          .from(tentativas)
          .where(
            and(
              eq(tentativas.id, erro.tentativaId),
              eq(tentativas.perfilId, perfil.id),
              eq(tentativas.sessaoId, sessaoIdValido),
              eq(tentativas.questaoId, erro.questaoId)
            )
          )
          .limit(1);

        if (
          !questao ||
          !tentativa ||
          (tentativa.perfilId && tentativa.perfilId !== perfil.id) ||
          (tentativa.sessaoId && tentativa.sessaoId !== sessaoIdValido) ||
          (tentativa.questaoId && tentativa.questaoId !== erro.questaoId)
        ) {
          throw new PublicOperationError('NOT_FOUND', 'Registro relacionado não encontrado ou acesso não permitido.');
        }

        if (bloco.disciplinaId && questao.disciplinaId && bloco.disciplinaId !== questao.disciplinaId) {
          throw new PublicOperationError(
            'VALIDATION_ERROR',
            'A questão informada não pertence à disciplina do bloco da sessão.'
          );
        }

        if (tentativa.correta === true) {
          throw new PublicOperationError(
            'CONFLICT',
            'Não é permitido registrar erro para uma tentativa acertada.'
          );
        }

        errosValidados.push({ ...erro, ...questao });
      }

      // 3. Atualiza os dados da sessão no banco
      const [sessaoConcluida] = await tx
        .update(sessoes)
        .set({
          encerradaEm: finalizacaoValida.encerradaEm || new Date(),
          segundosEfetivos: finalizacaoValida.segundosEfetivos ?? sessao.segundosEfetivos,
          segundosPausa: finalizacaoValida.segundosPausa ?? sessao.segundosPausa,
          etapaAtingida: finalizacaoValida.etapaAtingida,
          notaLivre: finalizacaoValida.notaLivre ?? sessao.notaLivre,
          concluida,
        })
        .where(and(eq(sessoes.id, sessaoIdValido), eq(sessoes.perfilId, perfil.id)))
        .returning();

      if (!sessaoConcluida) {
        logOperationalFailure('sessao.finish_without_returning', 'persistence');
        throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível confirmar a conclusão da sessão.');
      }

      // 4. Registra os erros, se houver
      for (const erro of errosValidados) {
        const [erroInserido] = await tx
          .insert(erros)
          .values({
            perfilId: perfil.id,
            questaoId: erro.questaoId,
            tentativaId: erro.tentativaId,
            descricaoLivre: erro.descricaoLivre || null,
            disciplinaId: erro.disciplinaId,
            topicoId: sessao.topicoId,
            estilo: erro.estilo,
            tipoErro: erro.tipoErro,
            conceitoCorreto: erro.conceitoCorreto || null,
            criadoEm: new Date(),
            vezesRevisado: 0,
          })
          .returning({ id: erros.id });

        if (!erroInserido) {
          throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível confirmar o registro dos erros da sessão.');
        }
      }

      // 5. Apenas uma sessão pedagogicamente concluída avança o ciclo.
      if (concluida) {
        // Serializa conclusões de sessões diferentes do mesmo ciclo. O lock é
        // transacional e não depende da existência prévia de ciclo_estado.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${bloco.cicloId}::text, 0));`);

        const blocosDoCiclo = await tx
          .select({ id: cicloBlocos.id })
          .from(cicloBlocos)
          .where(eq(cicloBlocos.cicloId, bloco.cicloId));

        const totalBlocos = blocosDoCiclo.length;
        const proximaOrdem = calcularProximaOrdem(bloco.ordem, totalBlocos);

        const [ponteiroPersistido] = await tx
          .insert(cicloEstado)
          .values({ cicloId: bloco.cicloId, proximaOrdem })
          .onConflictDoUpdate({
            target: cicloEstado.cicloId,
            set: { proximaOrdem },
          })
          .returning({ cicloId: cicloEstado.cicloId });

        if (!ponteiroPersistido) {
          throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível confirmar o avanço do ciclo.');
        }
      }

      return sessaoConcluida;
    });
  } catch (error) {
    if (error instanceof PublicOperationError) throw error;
    logOperationalFailure('sessao.finish', 'persistence');
    throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível concluir a sessão.');
  }
}
