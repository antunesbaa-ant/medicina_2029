'use server';

import { db } from '../../db';
import { cicloBlocos, cicloEstado, ciclos, topicos } from '../../db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import { requireRole } from '../../lib/authorization';
import { injetarTopicoInputSchema } from '../../lib/validation';

// 1. Injetar Re-estudo de um tópico crítico como o próximo bloco do ciclo
export async function injetarTopicoNoCiclo(
  topicoId: string,
  duracaoMin: number = 50
): Promise<{ sucesso: boolean; mensagem: string }> {
  const estudante = await requireRole('estudante');

  const validacao = injetarTopicoInputSchema.safeParse({ topicoId, duracaoMin });
  if (!validacao.ok) {
    return { sucesso: false, mensagem: validacao.message };
  }
  const { topicoId: topicoIdValido, duracaoMin: duracaoValida } = validacao.data;

  try {
    return await db.transaction(async (tx) => {
      // A. Busca o tópico para descobrir a disciplinaId
      const [topico] = await tx
        .select({
          disciplinaId: topicos.disciplinaId,
          nome: topicos.nome
        })
        .from(topicos)
        .where(eq(topicos.id, topicoIdValido))
        .limit(1);

      if (!topico) {
        return { sucesso: false, mensagem: 'Tópico não encontrado.' };
      }

      // B. Busca o ciclo ativo pertencente à estudante autenticada
      const [cicloAtivo] = await tx
        .select({ id: ciclos.id })
        .from(ciclos)
        .where(and(
          eq(ciclos.ativo, true),
          eq(ciclos.estudantePerfilId, estudante.id)
        ))
        .limit(1);

      if (!cicloAtivo) {
        return { sucesso: false, mensagem: 'Não há nenhum ciclo ativo para injetar o re-estudo.' };
      }

      // C. Busca a próxima ordem e o limite atual da fila
      const [estado] = await tx
        .select({ proximaOrdem: cicloEstado.proximaOrdem })
        .from(cicloEstado)
        .where(eq(cicloEstado.cicloId, cicloAtivo.id))
        .limit(1);
      const [limiteFila] = await tx
        .select({ maiorOrdem: sql<number>`coalesce(max(${cicloBlocos.ordem}), 0)::int` })
        .from(cicloBlocos)
        .where(eq(cicloBlocos.cicloId, cicloAtivo.id))
        .limit(1);

      const proximaOrdem = estado ? estado.proximaOrdem : 1;
      const deslocamentoSeguro = Math.max((limiteFila?.maiorOrdem ?? 0) + 1, 1);

      // D. Move primeiro para uma faixa livre e depois para a posição final.
      // Isso permanece compatível com a unique (ciclo_id, ordem) da contração.
      await tx
        .update(cicloBlocos)
        .set({ ordem: sql`${cicloBlocos.ordem} + ${deslocamentoSeguro}` })
        .where(and(
          eq(cicloBlocos.cicloId, cicloAtivo.id),
          gte(cicloBlocos.ordem, proximaOrdem)
        ));
      await tx
        .update(cicloBlocos)
        .set({ ordem: sql`${cicloBlocos.ordem} - ${deslocamentoSeguro - 1}` })
        .where(and(
          eq(cicloBlocos.cicloId, cicloAtivo.id),
          gte(cicloBlocos.ordem, proximaOrdem + deslocamentoSeguro)
        ));

      // E. Insere o novo bloco dentro da mesma transação da reordenação
      await tx.insert(cicloBlocos).values({
        cicloId: cicloAtivo.id,
        ordem: proximaOrdem,
        disciplinaId: topico.disciplinaId,
        tipo: 'conteudo',
        estiloAlvo: 'enem',
        duracaoMin: duracaoValida
      });

      return {
        sucesso: true,
        mensagem: `Tópico "${topico.nome}" injetado com sucesso como o próximo bloco da sua fila de estudos!`
      };
    });
  } catch (error) {
    console.error('Erro ao injetar re-estudo no ciclo:', error);
    return { sucesso: false, mensagem: 'Erro ao injetar bloco.' };
  }
}
