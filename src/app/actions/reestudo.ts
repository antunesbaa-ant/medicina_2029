'use server';

import { db } from '../../db';
import { cicloBlocos, cicloEstado, ciclos, topicos } from '../../db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';

// 1. Injetar Re-estudo de um tópico crítico como o próximo bloco do ciclo
export async function injetarTopicoNoCiclo(
  topicoId: string,
  duracaoMin: number = 50
): Promise<{ sucesso: boolean; mensagem: string }> {
  try {
    // A. Busca o tópico para descobrir a disciplinaId
    const [topico] = await db
      .select({
        disciplinaId: topicos.disciplinaId,
        nome: topicos.nome
      })
      .from(topicos)
      .where(eq(topicos.id, topicoId))
      .limit(1);

    if (!topico) {
      return { sucesso: false, mensagem: 'Tópico não encontrado.' };
    }

    // B. Busca o ciclo ativo
    const [cicloAtivo] = await db
      .select({ id: ciclos.id })
      .from(ciclos)
      .where(eq(ciclos.ativo, true))
      .limit(1);

    if (!cicloAtivo) {
      return { sucesso: false, mensagem: 'Não há nenhum ciclo ativo para injetar o re-estudo.' };
    }

    // C. Busca a próxima ordem (ponteiro atual)
    const [estado] = await db
      .select({ proximaOrdem: cicloEstado.proximaOrdem })
      .from(cicloEstado)
      .where(eq(cicloEstado.cicloId, cicloAtivo.id))
      .limit(1);

    const proximaOrdem = estado ? estado.proximaOrdem : 1;

    // D. Abre espaço na fila: incrementa ordem de todos os blocos >= proximaOrdem
    await db
      .update(cicloBlocos)
      .set({ ordem: sql`ordem + 1` })
      .where(
        and(
          eq(cicloBlocos.cicloId, cicloAtivo.id),
          gte(cicloBlocos.ordem, proximaOrdem)
        )
      );

    // E. Insere o novo bloco de re-estudo (tipo 'conteudo') com ordem = proximaOrdem
    await db.insert(cicloBlocos).values({
      cicloId: cicloAtivo.id,
      ordem: proximaOrdem,
      disciplinaId: topico.disciplinaId,
      tipo: 'conteudo',
      estiloAlvo: 'enem',
      duracaoMin
    });

    return {
      sucesso: true,
      mensagem: `Tópico "${topico.nome}" injetado com sucesso como o próximo bloco da sua fila de estudos!`
    };
  } catch (error: any) {
    console.error('Erro ao injetar re-estudo no ciclo:', error);
    return { sucesso: false, mensagem: error.message || 'Erro ao injetar bloco.' };
  }
}
