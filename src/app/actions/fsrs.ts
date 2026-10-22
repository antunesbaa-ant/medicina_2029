'use server';

import { db } from '../../db';
import { cards, cardRevisoes, topicos, disciplinas } from '../../db/schema';
import { eq, and, lte, desc } from 'drizzle-orm';
import { FSRS, Card as FSRSCard, State, Rating } from 'ts-fsrs';
import { obterEstadoFSRS, obterRatingFSRS } from '../../lib/studysystem';
import { requireRole } from '../../lib/authorization';
import {
  PublicOperationError,
  logOperationalFailure,
  type OperationErrorCode,
} from '../../lib/operation-result';
import { registrarRevisaoCardInputSchema } from '../../lib/validation';
import { applyRlsContext } from '../../db/rls-context';

// 1. Obter Cards Due (Vencidos) do Estudante
export async function obterCardsParaRevisao() {
  const perfil = await requireRole('estudante');

  try {
    const list = await db
      .select({
        id: cards.id,
        frente: cards.frente,
        verso: cards.verso,
        state: cards.state,
        stability: cards.stability,
        difficulty: cards.difficulty,
        elapsedDays: cards.elapsedDays,
        scheduledDays: cards.scheduledDays,
        reps: cards.reps,
        lapses: cards.lapses,
        due: cards.due,
        lastReview: cards.lastReview,
        topicoId: cards.topicoId,
        topicoNome: topicos.nome,
        disciplinaNome: disciplinas.nome,
        corHex: disciplinas.corHex
      })
      .from(cards)
      .innerJoin(topicos, eq(cards.topicoId, topicos.id))
      .innerJoin(disciplinas, eq(topicos.disciplinaId, disciplinas.id))
      .where(
        and(
          eq(cards.perfilId, perfil.id),
          eq(cards.status, 'aprovado'),
          eq(cards.suspenso, false),
          lte(cards.due, new Date())
        )
      )
      .orderBy(cards.due);

    return list;
  } catch (error) {
    if (error instanceof PublicOperationError) throw error;
    logOperationalFailure('fsrs.list_due', 'persistence');
    throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível carregar os cards para revisão.');
  }
}

export type ResultadoRevisaoCard =
  | { sucesso: true; mensagem: string; idempotente?: boolean }
  | { sucesso: false; mensagem: string; code: OperationErrorCode };

// 2. Registrar Revisão Espaçada (FSRS)
export async function registrarRevisaoCard(
  cardId: string,
  ratingStr: 'again' | 'hard' | 'good' | 'easy',
  duracaoMs: number
): Promise<ResultadoRevisaoCard> {
  const perfil = await requireRole('estudante');

  const validacao = registrarRevisaoCardInputSchema.safeParse({
    cardId,
    ratingStr,
    duracaoMs,
  });
  if (!validacao.ok) {
    return {
      sucesso: false,
      code: 'VALIDATION_ERROR',
      mensagem: validacao.message,
    };
  }

  const { cardId: cardIdValido, ratingStr: ratingValido, duracaoMs: duracaoValida } =
    validacao.data;

  try {
    return await db.transaction(async (tx) => {
      await applyRlsContext(tx, perfil.id, perfil.papel);

      // O lock impede que duas abas calculem o próximo estado a partir da
      // mesma versão do card.
      const [cardDb] = await tx
        .select()
        .from(cards)
        .where(and(eq(cards.id, cardIdValido), eq(cards.perfilId, perfil.id)))
        .limit(1)
        .for('update');

      if (!cardDb || (cardDb.perfilId && cardDb.perfilId !== perfil.id)) {
        return {
          sucesso: false,
          code: 'NOT_FOUND',
          mensagem: 'Registro não encontrado ou acesso não permitido.',
        };
      }

      if (cardDb.suspenso === true || (cardDb.status && cardDb.status !== 'aprovado')) {
        return {
          sucesso: false,
          code: 'CONFLICT',
          mensagem: 'Este card não está elegível para revisão.',
        };
      }

      const now = new Date();

      // Sem alterar o schema, o estado já persistido é a chave idempotente do
      // domínio: um card reagendado para o futuro não pode receber nova revisão.
      // Se o último log coincide com o payload, trata-se de retry da operação já
      // confirmada; payload divergente é conflito, nunca uma segunda gravação.
      if (cardDb.lastReview && new Date(cardDb.due).getTime() > now.getTime()) {
        const [ultimaRevisao] = await tx
          .select({
            revisadoEm: cardRevisoes.revisadoEm,
            rating: cardRevisoes.rating,
          })
          .from(cardRevisoes)
          .where(eq(cardRevisoes.cardId, cardIdValido))
          .orderBy(desc(cardRevisoes.revisadoEm))
          .limit(1);

        const mesmaRevisao = ultimaRevisao
          && ultimaRevisao.rating === ratingValido
          && new Date(ultimaRevisao.revisadoEm).getTime() === new Date(cardDb.lastReview).getTime();

        if (mesmaRevisao) {
          return {
            sucesso: true,
            idempotente: true,
            mensagem: `Card já revisado. Próxima revisão agendada para: ${new Date(cardDb.due).toLocaleDateString('pt-BR')}`,
          };
        }

        return {
          sucesso: false,
          code: 'CONFLICT',
          mensagem: 'Este card já foi revisado e teve seu agendamento atualizado.',
        };
      }

      // B. Mapeia para tipo FSRSCard
      const cardFSRS: FSRSCard = {
        due: new Date(cardDb.due),
        stability: cardDb.stability,
        difficulty: cardDb.difficulty,
        elapsed_days: cardDb.elapsedDays,
        scheduled_days: cardDb.scheduledDays,
        reps: cardDb.reps,
        lapses: cardDb.lapses,
        state: obterEstadoFSRS(cardDb.state),
        last_review: cardDb.lastReview ? new Date(cardDb.lastReview) : undefined,
        learning_steps: 0,
      };

      // C. Instancia e calcula novos parâmetros
      const f = new FSRS({});
      const ratingVal = obterRatingFSRS(ratingValido) as
        | Rating.Again
        | Rating.Hard
        | Rating.Good
        | Rating.Easy;
      const scheduler = f.repeat(cardFSRS, now);
      const result = scheduler[ratingVal];

      // D. Atualiza o card no banco de dados
      const stateMapping: Record<number, string> = {
        [State.New]: 'new',
        [State.Learning]: 'learning',
        [State.Review]: 'review',
        [State.Relearning]: 'relearning',
      };
      const nextState = stateMapping[result.card.state as number] || 'review';

      const [cardAtualizado] = await tx
        .update(cards)
        .set({
          stability: result.card.stability,
          difficulty: result.card.difficulty,
          elapsedDays: result.card.elapsed_days,
          scheduledDays: result.card.scheduled_days,
          reps: result.card.reps,
          lapses: result.card.lapses,
          state: nextState,
          due: result.card.due,
          lastReview: now,
        })
        .where(and(eq(cards.id, cardIdValido), eq(cards.perfilId, perfil.id)))
        .returning({ id: cards.id });

      if (!cardAtualizado) {
        throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível confirmar a atualização do card.');
      }

      // E. Registra o Log da Revisão
      const [revisaoInserida] = await tx
        .insert(cardRevisoes)
        .values({
          cardId: cardIdValido,
          revisadoEm: now,
          rating: ratingValido,
          stateAnterior: cardDb.state,
          stabilityAnterior: cardDb.stability,
          duracaoMs: duracaoValida,
        })
        .returning({ id: cardRevisoes.id });

      if (!revisaoInserida) {
        throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível confirmar o histórico da revisão.');
      }

      return {
        sucesso: true,
        mensagem: `Card revisado com sucesso. Próxima revisão agendada para: ${result.card.due.toLocaleDateString('pt-BR')}`,
      };
    });
  } catch (error) {
    if (error instanceof PublicOperationError) {
      return { sucesso: false, code: error.code, mensagem: error.message };
    }
    logOperationalFailure('fsrs.review', 'persistence');
    return { sucesso: false, code: 'PERSISTENCE_ERROR', mensagem: 'Erro ao registrar revisão.' };
  }
}
