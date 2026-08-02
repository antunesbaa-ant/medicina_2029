'use server';

import { db } from '../../db';
import { ciclos, cicloBlocos, cicloEstado, disciplinas, topicos } from '../../db/schema';
import { eq, asc } from 'drizzle-orm';
import { MOCK_CICLO_ATIVO, MOCK_BLOCOS, MOCK_TOPICOS } from '../../lib/mocks';

export interface CicloAtivoData {
  ciclo: typeof ciclos.$inferSelect;
  blocos: Array<typeof cicloBlocos.$inferSelect & {
    disciplina: typeof disciplinas.$inferSelect;
  }>;
  proximaOrdem: number;
}

export async function obterCicloAtivo(): Promise<CicloAtivoData | null> {
  try {
    // 1. Busca o ciclo ativo
    const [cicloAtivo] = await db
      .select()
      .from(ciclos)
      .where(eq(ciclos.ativo, true))
      .limit(1);

    if (!cicloAtivo) {
      // Se estiver vazio no banco mas a conexão funcionar
      return {
        ciclo: MOCK_CICLO_ATIVO,
        blocos: MOCK_BLOCOS,
        proximaOrdem: 1
      };
    }

    // 2. Busca os blocos vinculados ordenados por ordem com as disciplinas correspondentes
    const blocos = await db
      .select({
        id: cicloBlocos.id,
        cicloId: cicloBlocos.cicloId,
        ordem: cicloBlocos.ordem,
        disciplinaId: cicloBlocos.disciplinaId,
        tipo: cicloBlocos.tipo,
        estiloAlvo: cicloBlocos.estiloAlvo,
        duracaoMin: cicloBlocos.duracaoMin,
        disciplina: disciplinas,
      })
      .from(cicloBlocos)
      .where(eq(cicloBlocos.cicloId, cicloAtivo.id))
      .innerJoin(disciplinas, eq(cicloBlocos.disciplinaId, disciplinas.id))
      .orderBy(asc(cicloBlocos.ordem));

    // 3. Busca o estado do ciclo (proxima_ordem)
    const [estado] = await db
      .select()
      .from(cicloEstado)
      .where(eq(cicloEstado.cicloId, cicloAtivo.id))
      .limit(1);

    const proximaOrdem = estado ? estado.proximaOrdem : 1;

    return {
      ciclo: cicloAtivo,
      blocos,
      proximaOrdem,
    };
  } catch (error) {
    console.warn('Banco offline ou indisponível. Usando mock data para ciclo.');
    // Retorna o ciclo mockado padrão (resiliência frontend)
    return {
      ciclo: MOCK_CICLO_ATIVO,
      blocos: MOCK_BLOCOS,
      proximaOrdem: 1,
    };
  }
}

export async function obterTopicosPorDisciplina(disciplinaId: string) {
  try {
    const list = await db
      .select()
      .from(topicos)
      .where(eq(topicos.disciplinaId, disciplinaId))
      .orderBy(asc(topicos.ordem));
    
    if (list.length > 0) return list;
    return MOCK_TOPICOS[disciplinaId] || [];
  } catch (error) {
    return MOCK_TOPICOS[disciplinaId] || [];
  }
}

export async function iniciarCicloEstudos(): Promise<{ sucesso: boolean; mensagem: string; cicloId?: string }> {
  try {
    return await db.transaction(async (tx) => {
      // 1. Set all existing cycles to active=false
      await tx
        .update(ciclos)
        .set({ ativo: false });

      // 2. Create a new active cycle
      const [novoCiclo] = await tx
        .insert(ciclos)
        .values({
          nome: 'Ciclo Principal - 2027',
          anoLetivo: 2027,
          ativo: true,
          blocosPrevistosSemana: 28,
          criadoEm: new Date(),
        })
        .returning();

      if (!novoCiclo) {
        throw new Error('Não foi possível criar o novo ciclo.');
      }

      // 3. Fetch all disciplines to map their IDs
      const listDisciplinas = await tx
        .select()
        .from(disciplinas);

      if (listDisciplinas.length === 0) {
        throw new Error('Nenhuma disciplina cadastrada no banco de dados para criar os blocos.');
      }

      // Helper function to map discipline name to its ID in db
      const obterDisciplinaId = (nome: string): string => {
        const nomeNorm = nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        for (const d of listDisciplinas) {
          const dbNomeNorm = d.nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          if (dbNomeNorm === nomeNorm) {
            return d.id;
          }
        }
        // Fallback: return the first discipline if no match
        return listDisciplinas[0].id;
      };

      // 4. Balanced 28 study blocks curriculum (at least 50% question-solving / error revision)
      // We will have exactly 15 blocks as 'questoes' or 'caderno_erros' (53.6%)
      const blocosConfig = [
        { nomeDisc: 'Matemática', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Biologia', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Redação', tipo: 'redacao' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Química', tipo: 'conteudo' as const, estiloAlvo: 'conteudista' as const, duracaoMin: 50 },
        { nomeDisc: 'Matemática', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Física', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Linguagens', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Química', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Matemática', tipo: 'caderno_erros' as const, estiloAlvo: 'misto' as const, duracaoMin: 50 },
        { nomeDisc: 'Biologia', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'História', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Língua Estrangeira', tipo: 'lingua_estrangeira' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Física', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Geografia', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Matemática', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Biologia', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Filosofia', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Química', tipo: 'questoes' as const, estiloAlvo: 'conteudista' as const, duracaoMin: 50 },
        { nomeDisc: 'Física', tipo: 'questoes' as const, estiloAlvo: 'conteudista' as const, duracaoMin: 50 },
        { nomeDisc: 'Redação', tipo: 'redacao' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Sociologia', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Matemática', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Biologia', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Linguagens', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Química', tipo: 'caderno_erros' as const, estiloAlvo: 'misto' as const, duracaoMin: 50 },
        { nomeDisc: 'Física', tipo: 'caderno_erros' as const, estiloAlvo: 'misto' as const, duracaoMin: 50 },
        { nomeDisc: 'História', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Matemática', tipo: 'revisao_srs' as const, estiloAlvo: 'misto' as const, duracaoMin: 50 },
      ];

      // 5. Populate cicloBlocos
      for (let i = 0; i < blocosConfig.length; i++) {
        const config = blocosConfig[i];
        const disciplinaId = obterDisciplinaId(config.nomeDisc);
        await tx.insert(cicloBlocos).values({
          cicloId: novoCiclo.id,
          ordem: i + 1,
          disciplinaId,
          tipo: config.tipo,
          estiloAlvo: config.estiloAlvo,
          duracaoMin: config.duracaoMin
        });
      }

      // 6. Insert cicloEstado starting at proximaOrdem = 1
      await tx.insert(cicloEstado).values({
        cicloId: novoCiclo.id,
        proximaOrdem: 1,
      });

      return {
        sucesso: true,
        mensagem: 'Novo ciclo de estudos ativo e fila com 28 blocos configurada com sucesso!',
        cicloId: novoCiclo.id
      };
    });
  } catch (error: any) {
    console.error('Erro ao iniciar ciclo de estudos:', error);
    return {
      sucesso: false,
      mensagem: error.message || 'Erro interno ao iniciar ciclo de estudos.'
    };
  }
}

export async function resetarPlanejamento(): Promise<{ sucesso: boolean; mensagem: string }> {
  try {
    return await db.transaction(async (tx) => {
      // 1. Set all cycles to active=false
      await tx
        .update(ciclos)
        .set({ ativo: false });

      // 2. Delete/clear all cicloEstado entries so that there is no active cycle state
      await tx.delete(cicloEstado);

      return {
        sucesso: true,
        mensagem: 'Planejamento resetado com sucesso. Nenhum ciclo está ativo.'
      };
    });
  } catch (error: any) {
    console.error('Erro ao resetar planejamento:', error);
    return {
      sucesso: false,
      mensagem: error.message || 'Erro interno ao resetar planejamento.'
    };
  }
}


