'use server';

import { db } from '../../db';
import { sessoes, cicloBlocos, cicloEstado, erros, questoes, tentativas } from '../../db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { validarConclusaoSessao, calcularProximaOrdem } from '../../lib/studysystem';
import { requireRole } from '../../lib/authorization';
import { PublicOperationError, logOperationalFailure } from '../../lib/operation-result';

export async function iniciarSessao(
  cicloBlocoId: string,
  topicoId: string
): Promise<string> {
  const perfil = await requireRole('estudante');

  try {
    return await db.transaction(async (tx) => {
      // O advisory lock cobre também a concorrência quando ainda não existe
      // linha para bloquear, evitando duas sessões abertas para o mesmo bloco.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(concat_ws(':', ${perfil.id}::text, ${cicloBlocoId}::text, ${topicoId}::text), 0)
        );
      `);

      const [sessaoAberta] = await tx
        .select({ id: sessoes.id })
        .from(sessoes)
        .where(and(
          eq(sessoes.perfilId, perfil.id),
          eq(sessoes.cicloBlocoId, cicloBlocoId),
          eq(sessoes.topicoId, topicoId),
          isNull(sessoes.encerradaEm)
        ))
        .limit(1);

      if (sessaoAberta) return sessaoAberta.id;

      const [sessaoInserida] = await tx
        .insert(sessoes)
        .values({
          perfilId: perfil.id,
          cicloBlocoId,
          topicoId,
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

  try {
    const [sessaoAtualizada] = await db
      .update(sessoes)
      .set({
        ...(dados.etapaAtingida && { etapaAtingida: dados.etapaAtingida }),
        ...(dados.segundosEfetivos !== undefined && { segundosEfetivos: dados.segundosEfetivos }),
        ...(dados.segundosPausa !== undefined && { segundosPausa: dados.segundosPausa }),
        ...(dados.notaLivre !== undefined && { notaLivre: dados.notaLivre }),
      })
      .where(and(eq(sessoes.id, sessaoId), eq(sessoes.perfilId, perfil.id)))
      .returning();

    if (!sessaoAtualizada) {
      throw new PublicOperationError('NOT_FOUND', 'Sessão não encontrada ou acesso não permitido.');
    }

    return sessaoAtualizada;
  } catch (error) {
    if (error instanceof PublicOperationError) throw error;
    logOperationalFailure('sessao.update', 'persistence');
    throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível atualizar a sessão.');
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

  try {
    return await db.transaction(async (tx) => {
      // O lock serializa duplo clique/duas abas. encerradaEm funciona como marcador
      // idempotente compatível com o schema atual, sem exigir migration.
      const [dadosSessao] = await tx
        .select({
          sessao: sessoes,
          bloco: cicloBlocos,
        })
        .from(sessoes)
        .where(and(eq(sessoes.id, sessaoId), eq(sessoes.perfilId, perfil.id)))
        .innerJoin(cicloBlocos, eq(sessoes.cicloBlocoId, cicloBlocos.id))
        .limit(1)
        .for('update');

      if (!dadosSessao) {
        throw new PublicOperationError('NOT_FOUND', 'Sessão não encontrada ou acesso não permitido.');
      }

      const { sessao, bloco } = dadosSessao;
      if (sessao.encerradaEm) {
        return sessao;
      }

      // 2. Valida conclusão de acordo com a etapa atingida
      const concluida = validarConclusaoSessao(dadosFinalizacao.etapaAtingida);

      const errosValidados: Array<ErroParaRegistrar & { disciplinaId: string; estilo: 'enem' | 'conteudista' | 'misto' }> = [];
      for (const erro of dadosFinalizacao.errosParaRegistrar ?? []) {
        const [questao] = await tx
          .select({ disciplinaId: questoes.disciplinaId, estilo: questoes.estilo })
          .from(questoes)
          .where(eq(questoes.id, erro.questaoId))
          .limit(1);

        const [tentativa] = await tx
          .select({ id: tentativas.id })
          .from(tentativas)
          .where(
            and(
              eq(tentativas.id, erro.tentativaId),
              eq(tentativas.perfilId, perfil.id),
              eq(tentativas.sessaoId, sessaoId),
              eq(tentativas.questaoId, erro.questaoId)
            )
          )
          .limit(1);

        if (!questao || !tentativa) {
          throw new PublicOperationError('NOT_FOUND', 'Registro relacionado não encontrado ou acesso não permitido.');
        }

        errosValidados.push({ ...erro, ...questao });
      }

      // 3. Atualiza os dados da sessão no banco
      const [sessaoConcluida] = await tx
        .update(sessoes)
        .set({
          encerradaEm: dadosFinalizacao.encerradaEm || new Date(),
          segundosEfetivos: dadosFinalizacao.segundosEfetivos ?? sessao.segundosEfetivos,
          segundosPausa: dadosFinalizacao.segundosPausa ?? sessao.segundosPausa,
          etapaAtingida: dadosFinalizacao.etapaAtingida,
          notaLivre: dadosFinalizacao.notaLivre ?? sessao.notaLivre,
          concluida,
        })
        .where(and(eq(sessoes.id, sessaoId), eq(sessoes.perfilId, perfil.id)))
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

