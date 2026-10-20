'use server';

import { db } from '../../db';
import { checkins } from '../../db/schema';
import { requireRole } from '../../lib/authorization';
import {
  logOperationalFailure,
  operationFailure,
  operationSuccess,
  type OperationResult,
} from '../../lib/operation-result';

export interface DadosCheckin {
  horasSono: number;
  exercicioMin: number;
  humor: number;
  energia: number;
  notaLivre?: string;
}

export async function registrarCheckin(
  dados: DadosCheckin
): Promise<OperationResult<{ checkin: typeof checkins.$inferSelect }>> {
  const perfil = await requireRole('estudante');

  try {
    const [novoCheckin] = await db
      .insert(checkins)
      .values({
        perfilId: perfil.id,
        data: new Date(),
        horasSono: dados.horasSono,
        exercicioMin: dados.exercicioMin,
        humor: dados.humor,
        energia: dados.energia,
        notaLivre: dados.notaLivre || null,
      })
      .returning();

    if (!novoCheckin) {
      logOperationalFailure('checkin.insert_without_returning', 'persistence');
      return operationFailure('PERSISTENCE_ERROR', 'Não foi possível confirmar o check-in. Tente novamente.');
    }

    return operationSuccess({ checkin: novoCheckin });
  } catch {
    logOperationalFailure('checkin.insert', 'persistence');
    return operationFailure('PERSISTENCE_ERROR', 'Não foi possível registrar o check-in. Tente novamente.');
  }
}
