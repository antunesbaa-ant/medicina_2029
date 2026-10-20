'use server';

import { db } from '../../db';
import { simulados, simuladoAreas, simuladoAnalise } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';
import { requireRole } from '../../lib/authorization';
import {
  PublicOperationError,
  logOperationalFailure,
  operationFailure,
  operationSuccess,
  type OperationResult,
} from '../../lib/operation-result';

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

  try {
    // Trava de simulados: impede novo simulado com análise pendente
    const simuladosExistentes = await listarSimuladosDoPerfil(perfil.id);
    const temPendente = simuladosExistentes.some(s => !s.analise || !s.analise.concluida);
    if (temPendente) {
      return operationFailure('CONFLICT', 'Não é permitido registrar um novo simulado enquanto houver uma análise pendente.');
    }

    if (dados.areas.some((area) => area.total <= 0 || area.acertos < 0 || area.acertos > area.total)) {
      return operationFailure('VALIDATION_ERROR', 'Os totais e acertos das áreas são inválidos.');
    }

    // A. Inserir simulado principal
    const [novoSimulado] = await db
      .insert(simulados)
      .values({
        perfilId: perfil.id,
        formato: dados.formato,
        data: new Date(dados.data),
        condicoesReais: dados.condicoesReais,
        duracaoMin: dados.duracaoMin,
        local: dados.local,
        composicaoProcedencia: dados.composicaoProcedencia
      })
      .returning();

    if (!novoSimulado) {
      logOperationalFailure('simulados.insert_without_returning', 'persistence');
      return operationFailure('PERSISTENCE_ERROR', 'Não foi possível confirmar o registro do simulado.');
    }

    // B. Inserir áreas
    for (const area of dados.areas) {
      const pct = (area.acertos / area.total) * 100;
      const [areaInserida] = await db
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
        logOperationalFailure('simulados.area_insert_without_returning', 'persistence');
        return operationFailure('PERSISTENCE_ERROR', 'O simulado foi iniciado, mas não foi possível confirmar todas as áreas.');
      }
    }

    return operationSuccess({ simuladoId: novoSimulado.id, analiseStatus: 'pendente' });
  } catch (error) {
    if (error instanceof PublicOperationError) {
      return operationFailure(error.code, error.message);
    }
    logOperationalFailure('simulados.insert', 'persistence');
    return operationFailure('PERSISTENCE_ERROR', 'Não foi possível registrar o simulado. Tente novamente.');
  }
}
