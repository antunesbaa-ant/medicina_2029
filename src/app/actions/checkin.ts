'use server';

import { db } from '../../db';
import { checkins } from '../../db/schema';

export interface DadosCheckin {
  horasSono: number;
  exercicioMin: number;
  humor: number;
  energia: number;
  notaLivre?: string;
}

export async function registrarCheckin(dados: DadosCheckin) {
  try {
    const [novoCheckin] = await db
      .insert(checkins)
      .values({
        perfilId: '00000000-0000-0000-0000-000000000001', // ID do estudante do seed
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
    console.warn('Banco offline ao registrar check-in. Salvando mock local.');
    return {
      sucesso: true,
      mock: true,
      checkin: {
        id: `checkin-mock-${Date.now()}`,
        perfilId: '00000000-0000-0000-0000-000000000001',
        data: new Date(),
        horasSono: dados.horasSono,
        exercicioMin: dados.exercicioMin,
        humor: dados.humor,
        energia: dados.energia,
        notaLivre: dados.notaLivre || null,
      }
    };
  }
}
