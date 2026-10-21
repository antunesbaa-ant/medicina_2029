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
import {
  registrarRedacaoInputSchema,
  registrarRepertorioInputSchema,
} from '../../lib/validation';

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

  const validacao = registrarRedacaoInputSchema.safeParse(dados);
  if (!validacao.ok) {
    return operationFailure('VALIDATION_ERROR', validacao.message);
  }
  const validado = validacao.data;

  try {
    if (validado.generoId) {
      const [generoExistente] = await db
        .select({ id: generos.id })
        .from(generos)
        .where(eq(generos.id, validado.generoId))
        .limit(1);

      if (!generoExistente) {
        return operationFailure('NOT_FOUND', 'Gênero textual não encontrado.');
      }
    }

    const [nova] = await db
      .insert(redacoes)
      .values({
        perfilId: perfil.id,
        formato: validado.formato,
        generoId: validado.generoId || null,
        tema: validado.tema,
        texto: validado.texto,
        minutosGastos: validado.minutosGastos,
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

  const validacao = registrarRepertorioInputSchema.safeParse(dados);
  if (!validacao.ok) {
    return operationFailure('VALIDATION_ERROR', validacao.message);
  }
  const validado = validacao.data;

  try {
    const [novo] = await db
      .insert(repertorios)
      .values({
        perfilId: perfil.id,
        referencia: validado.referencia,
        resumo2Linhas: validado.resumo2Linhas,
        temasAplicaveis: validado.temasAplicaveis,
        categoria: validado.categoria,
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
