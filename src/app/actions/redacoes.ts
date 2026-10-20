'use server';

import { db } from '../../db';
import { redacoes, generos, repertorios } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';
import { requireRole } from '../../lib/authorization';
import {
  PublicOperationError,
  logOperationalFailure,
  operationFailure,
  operationSuccess,
  type OperationResult,
} from '../../lib/operation-result';

export interface RegistrarRedacaoInput {
  formato: 'enem' | 'genero_uece';
  generoId?: string;
  tema: string;
  texto: string;
  minutosGastos: number;
}

export interface RegistrarRepertorioInput {
  referencia: string;
  resumo2Linhas: string;
  temasAplicaveis: string[];
  categoria: string;
}

// 1. Obter todos os Gêneros UECE cadastrados
export async function obterGenerosUECE() {
  await requireRole('estudante');

  try {
    return await db.select().from(generos);
  } catch {
    logOperationalFailure('redacoes.generos.list', 'persistence');
    throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível carregar os gêneros de redação.');
  }
}

// 2. Obter Repertório cadastrado
export async function obterRepertorios() {
  const perfil = await requireRole('estudante');

  try {
    const list = await db
      .select()
      .from(repertorios)
      .where(eq(repertorios.perfilId, perfil.id))
      .orderBy(desc(repertorios.criadoEm));

    return list;
  } catch {
    logOperationalFailure('redacoes.repertorios.list', 'persistence');
    throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível carregar os repertórios.');
  }
}

// 3. Obter redações escritas pela estudante
export async function obterRedacoes() {
  const perfil = await requireRole('estudante');

  try {
    const list = await db
      .select({
        id: redacoes.id,
        formato: redacoes.formato,
        tema: redacoes.tema,
        texto: redacoes.texto,
        minutosGastos: redacoes.minutosGastos,
        notaTotal: redacoes.notaTotal,
        escritaEm: redacoes.escritaEm,
        generoNome: generos.nome
      })
      .from(redacoes)
      .leftJoin(generos, eq(redacoes.generoId, generos.id))
      .where(eq(redacoes.perfilId, perfil.id))
      .orderBy(desc(redacoes.escritaEm));

    return list;
  } catch {
    logOperationalFailure('redacoes.list', 'persistence');
    throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível carregar as redações.');
  }
}

// 4. Registrar nova Redação
export async function registrarRedacao(
  dados: RegistrarRedacaoInput
): Promise<OperationResult<{ redacaoId: string }>> {
  const perfil = await requireRole('estudante');

  try {
    const [nova] = await db
      .insert(redacoes)
      .values({
        perfilId: perfil.id,
        formato: dados.formato,
        generoId: dados.generoId || null,
        tema: dados.tema,
        texto: dados.texto,
        minutosGastos: dados.minutosGastos,
        escritaEm: new Date(),
        notaTotal: null,
      })
      .returning();

    if (!nova) {
      logOperationalFailure('redacoes.insert_without_returning', 'persistence');
      return operationFailure('PERSISTENCE_ERROR', 'Não foi possível confirmar o registro da redação.');
    }

    return operationSuccess({ redacaoId: nova.id });
  } catch {
    logOperationalFailure('redacoes.insert', 'persistence');
    return operationFailure('PERSISTENCE_ERROR', 'Não foi possível salvar a redação. Tente novamente.');
  }
}

// 5. Registrar Repertório Sociocultural
export async function registrarRepertorio(
  dados: RegistrarRepertorioInput
): Promise<OperationResult<{ repertorioId: string }>> {
  const perfil = await requireRole('estudante');

  try {
    const [novo] = await db
      .insert(repertorios)
      .values({
        perfilId: perfil.id,
        referencia: dados.referencia,
        resumo2Linhas: dados.resumo2Linhas,
        temasAplicaveis: dados.temasAplicaveis,
        categoria: dados.categoria,
      })
      .returning({ id: repertorios.id });

    if (!novo) {
      logOperationalFailure('redacoes.repertorio.insert_without_returning', 'persistence');
      return operationFailure('PERSISTENCE_ERROR', 'Não foi possível confirmar o repertório.');
    }

    return operationSuccess({ repertorioId: novo.id });
  } catch {
    logOperationalFailure('redacoes.repertorio.insert', 'persistence');
    return operationFailure('PERSISTENCE_ERROR', 'Não foi possível salvar o repertório. Tente novamente.');
  }
}
