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

