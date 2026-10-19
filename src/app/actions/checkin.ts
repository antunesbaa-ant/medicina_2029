'use server';

import { db } from '../../db';
import { checkins } from '../../db/schema';
import { requireRole } from '../../lib/authorization';

export interface DadosCheckin {
  horasSono: number;
  exercicioMin: number;
  humor: number;
  energia: number;
  notaLivre?: string;
}

export async function registrarCheckin(dados: DadosCheckin) {
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

    return { sucesso: true, checkin: novoCheckin };
  } catch (error) {
    console.error('Erro ao registrar check-in:', error);
    return { sucesso: false, mensagem: 'Erro ao registrar check-in.' };
  }
}
