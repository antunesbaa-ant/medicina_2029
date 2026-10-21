'use server';

import { db } from '../../db';
import { simulados, simuladoAreas, simuladoAnalise } from '../../db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { requireRole } from '../../lib/authorization';
import {
  PublicOperationError,
  logOperationalFailure,
  operationFailure,
  operationSuccess,
  type OperationResult,
} from '../../lib/operation-result';
import { registrarSimuladoInputSchema } from '../../lib/validation';

export interface SimuladoAreaInput {
  area: string; // Ex: Linguagens, Matemática, Natureza, Humanas
  acertos: number;
  total: number;
}

export interface RegistrarSimuladoInput {
  formato: 'enem' | 'uece_1fase' | 'uece_2fase' | 'privada';
  data: string; // ISO string
  condicoesReais: boolean;
  duracaoMin: number;
  local: string;
  composicaoProcedencia: unknown;
  areas: SimuladoAreaInput[];
}

// 1. Listar simulados e suas análises
export async function listarSimulados() {
  const perfil = await requireRole('estudante');

  return listarSimuladosDoPerfil(perfil.id);
}

async function listarSimuladosDoPerfil(perfilId: string) {
  try {
    const list = await db
      .select()
      .from(simulados)
      .where(eq(simulados.perfilId, perfilId))
      .orderBy(desc(simulados.data));

    const results = [];
    for (const sim of list) {
      const areasDb = await db
        .select()
        .from(simuladoAreas)
        .where(eq(simuladoAreas.simuladoId, sim.id));

      const [analiseDb] = await db
        .select()
        .from(simuladoAnalise)
        .where(eq(simuladoAnalise.simuladoId, sim.id))
        .limit(1);

      results.push({
        ...sim,
        areas: areasDb,
        analise: analiseDb || null
      });
    }

    return results;
  } catch {
    logOperationalFailure('simulados.list', 'persistence');
    throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível carregar os simulados.');
  }
}

export async function registrarSimulado(
  dados: RegistrarSimuladoInput
): Promise<OperationResult<{ simuladoId: string; analiseStatus: 'pendente' }>> {
  const perfil = await requireRole('estudante');

  const validacao = registrarSimuladoInputSchema.safeParse(dados);
  if (!validacao.ok) {
    return operationFailure('VALIDATION_ERROR', validacao.message);
  }
  const validado = validacao.data;

  try {
    return await db.transaction(async (tx) => {
      // Serializa por estudante inclusive quando ainda não existe linha para bloquear.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`simulado:${perfil.id}`}::text, 0))`
      );

      const existentes = await tx
        .select({ id: simulados.id, analiseConcluida: simuladoAnalise.concluida })
        .from(simulados)
        .leftJoin(simuladoAnalise, eq(simuladoAnalise.simuladoId, simulados.id))
        .where(eq(simulados.perfilId, perfil.id));

      if (existentes.some((simulado) => simulado.analiseConcluida !== true)) {
        return operationFailure('CONFLICT', 'Não é permitido registrar um novo simulado enquanto houver uma análise pendente.');
      }

      const [novoSimulado] = await tx
        .insert(simulados)
        .values({
          perfilId: perfil.id,
          formato: validado.formato,
          data: validado.data,
          condicoesReais: validado.condicoesReais,
          duracaoMin: validado.duracaoMin,
          local: validado.local,
          composicaoProcedencia: validado.composicaoProcedencia
        })
        .returning();

      if (!novoSimulado) {
        throw new Error('simulado_insert_not_confirmed');
      }

      for (const area of validado.areas) {
        const pct = (area.acertos / area.total) * 100;
        const [areaInserida] = await tx
          .insert(simuladoAreas)
          .values({
            simuladoId: novoSimulado.id,
            area: area.area,
            acertos: area.acertos,
            total: area.total,
            notaEstimada: Math.round(pct * 8.5),
          })
          .returning({ id: simuladoAreas.id });

        if (!areaInserida) {
          throw new Error('simulado_area_insert_not_confirmed');
        }
      }

      return operationSuccess({ simuladoId: novoSimulado.id, analiseStatus: 'pendente' });
    });
  } catch (error) {
    if (error instanceof PublicOperationError) {
      return operationFailure(error.code, error.message);
    }
    logOperationalFailure('simulados.insert', 'persistence');
    return operationFailure('PERSISTENCE_ERROR', 'Não foi possível registrar o simulado. Tente novamente.');
  }
}
