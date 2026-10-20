'use server';

import { db } from '../../db';
import { erros, topicos, disciplinas } from '../../db/schema';
import { eq, and, sql, isNull, isNotNull } from 'drizzle-orm';
import { requireRole } from '../../lib/authorization';
import {
  PublicOperationError,
  logOperationalFailure,
  operationFailure,
  operationSuccess,
  type OperationResult,
} from '../../lib/operation-result';

export interface FiltrosCadernoErros {
  disciplinaId?: string;
  tipoErro?: 'conteudo' | 'interpretacao' | 'distracao' | 'calculo' | 'tempo';
  resolvido?: boolean;
}

// 1. Obter Erros do Caderno
export async function obterCadernoErros(filtros?: FiltrosCadernoErros) {
  const perfil = await requireRole('estudante');

  try {
    const conditions = [eq(erros.perfilId, perfil.id)];

    if (filtros?.disciplinaId) {
      conditions.push(eq(erros.disciplinaId, filtros.disciplinaId));
    }
    if (filtros?.tipoErro) {
      conditions.push(eq(erros.tipoErro, filtros.tipoErro));
    }
    if (filtros?.resolvido !== undefined) {
      if (filtros.resolvido) {
        conditions.push(isNotNull(erros.resolvidoEm));
      } else {
        conditions.push(isNull(erros.resolvidoEm));
      }
    }

    const list = await db
      .select({
        id: erros.id,
        descricaoLivre: erros.descricaoLivre,
        tipoErro: erros.tipoErro,
        conceitoCorreto: erros.conceitoCorreto,
        criadoEm: erros.criadoEm,
        resolvidoEm: erros.resolvidoEm,
        vezesRevisado: erros.vezesRevisado,
        topicoId: erros.topicoId,
        topicoNome: topicos.nome,
        disciplinaId: erros.disciplinaId,
        disciplinaNome: disciplinas.nome,
        corHex: disciplinas.corHex
      })
      .from(erros)
      .innerJoin(topicos, eq(erros.topicoId, topicos.id))
      .innerJoin(disciplinas, eq(erros.disciplinaId, disciplinas.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(sql`${erros.resolvidoEm} is not null`, erros.criadoEm);

    return list;
  } catch {
    logOperationalFailure('caderno_erros.list', 'persistence');
    throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível carregar o caderno de erros.');
  }
}

// 2. Marcar erro como resolvido
export async function resolverErro(
  erroId: string
): Promise<OperationResult<{ erroId: string }>> {
  const perfil = await requireRole('estudante');

  try {
    const [erroAtualizado] = await db
      .update(erros)
      .set({ resolvidoEm: new Date() })
      .where(and(eq(erros.id, erroId), eq(erros.perfilId, perfil.id)))
      .returning({ id: erros.id });

    if (!erroAtualizado) {
      return operationFailure('NOT_FOUND', 'Registro não encontrado ou acesso não permitido.');
    }

    return operationSuccess({ erroId: erroAtualizado.id });
  } catch {
    logOperationalFailure('caderno_erros.resolve', 'persistence');
    return operationFailure('PERSISTENCE_ERROR', 'Não foi possível atualizar o registro. Tente novamente.');
  }
}

// 3. Registrar Erro Manual
export async function registrarErroManual(dados: {
  descricaoLivre: string;
  topicoId: string;
  disciplinaId: string;
  estilo: 'enem' | 'conteudista' | 'misto';
  tipoErro: 'conteudo' | 'interpretacao' | 'distracao' | 'calculo' | 'tempo';
  conceitoCorreto: string;
}): Promise<OperationResult<never>> {
  await requireRole('estudante');
  void dados;

  return operationFailure(
    'VALIDATION_ERROR',
    'O registro manual exige uma questão e uma tentativa persistidas. Registre o erro durante uma sessão de estudo.'
  );
}
