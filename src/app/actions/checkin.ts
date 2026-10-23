'use server';

import { db } from '../../db';
import { checkins } from '../../db/schema';
import { requireRole } from '../../lib/authorization';
import { applyRlsContext } from '../../db/rls-context';
import {
  logOperationalFailure,
  operationFailure,
  operationSuccess,
  type OperationResult,
} from '../../lib/operation-result';
import { registrarCheckinInputSchema } from '../../lib/validation';

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

  const validacao = registrarCheckinInputSchema.safeParse(dados);
  if (!validacao.ok) {
    return operationFailure('VALIDATION_ERROR', validacao.message);
  }
  const validado = validacao.data;

  try {
    const novoCheckin = await db.transaction(async (tx) => {
      await applyRlsContext(tx, perfil.id, perfil.papel);

      const [inserted] = await tx
        .insert(checkins)
        .values({
          perfilId: perfil.id,
          data: new Date(),
          horasSono: validado.horasSono,
          exercicioMin: validado.exercicioMin,
          humor: validado.humor,
          energia: validado.energia,
          notaLivre: validado.notaLivre || null,
        })
        .returning();

      return inserted;
    });

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
