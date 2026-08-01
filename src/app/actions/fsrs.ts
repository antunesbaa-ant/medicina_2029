'use server';

import { db } from '../../db';
import { cards, cardRevisoes, topicos, disciplinas } from '../../db/schema';
import { eq, and, lte, sql } from 'drizzle-orm';
import { FSRS, Card as FSRSCard, State, Rating } from 'ts-fsrs';
import { obterEstadoFSRS, obterRatingFSRS } from '../../lib/studysystem';

// 1. Obter Cards Due (Vencidos) do Estudante
export async function obterCardsParaRevisao() {
  try {
    const estudantePerfilId = '00000000-0000-0000-0000-000000000001'; // Maria

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
          eq(cards.perfilId, estudantePerfilId),
          eq(cards.status, 'aprovado'),
          eq(cards.suspenso, false),
          lte(cards.due, new Date())
        )
      )
      .orderBy(cards.due);

    return list;
  } catch (error) {
    console.error('Erro ao buscar cards due:', error);
    return [];
  }
}

// 2. Registrar Revisão Espaçada (FSRS)
export async function registrarRevisaoCard(
  cardId: string,
  ratingStr: 'again' | 'hard' | 'good' | 'easy',
  duracaoMs: number
): Promise<{ sucesso: boolean; mensagem: string }> {
  try {
    // A. Busca o card do banco
    const [cardDb] = await db
      .select()
      .from(cards)
      .where(eq(cards.id, cardId))
      .limit(1);

    if (!cardDb) {
      return { sucesso: false, mensagem: 'Card não encontrado.' };
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
      learning_steps: 0
    };

    // C. Instancia e calcula novos parâmetros
    const f = new FSRS({});
    const now = new Date();
    const ratingVal = obterRatingFSRS(ratingStr);
    
    // Calcula a nova programação
    const scheduler = f.repeat(cardFSRS, now);
    const result = (scheduler as any)[ratingVal];

    // D. Atualiza o card no banco de dados
    const stateMapping: Record<number, string> = {
      [State.New]: 'new',
      [State.Learning]: 'learning',
      [State.Review]: 'review',
      [State.Relearning]: 'relearning'
    };

    const nextState = stateMapping[result.card.state as number] || 'review';

    await db
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
        lastReview: now
      })
      .where(eq(cards.id, cardId));

    // E. Registra o Log da Revisão
    await db.insert(cardRevisoes).values({
      cardId: cardId,
      revisadoEm: now,
      rating: ratingStr,
      stateAnterior: cardDb.state,
      stabilityAnterior: cardDb.stability,
      duracaoMs: duracaoMs
    });

    return {
      sucesso: true,
      mensagem: `Card revisado com sucesso. Próxima revisão agendada para: ${result.card.due.toLocaleDateString('pt-BR')}`
    };
  } catch (error: any) {
    console.error('Erro ao salvar revisão de card:', error);
    return { sucesso: false, mensagem: error.message || 'Erro ao registrar revisão.' };
  }
}
