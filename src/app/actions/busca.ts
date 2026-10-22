'use server';

import {
  buscaHibridaAcervo,
  EmbeddingServiceUnavailableError,
  GeminiEmbeddingError,
  type OpcoesBuscaHibridaAcervo,
  type ResultadoBusca,
} from '../../lib/ingestion';
import { requireAuthenticatedProfile } from '../../lib/authorization';
import { PublicOperationError, logOperationalFailure } from '../../lib/operation-result';
import { v } from '../../lib/validation';

export async function buscarNoAcervo(
  query: string,
  disciplinaId?: string,
  opcoes?: Pick<OpcoesBuscaHibridaAcervo, 'gerarEmbeddingQuery' | 'minSimilaridade'>
): Promise<ResultadoBusca[]> {
  const perfil = await requireAuthenticatedProfile();

  if (typeof query !== 'string') {
    throw new PublicOperationError('VALIDATION_ERROR', 'Termo de busca inválido.');
  }

  const queryLimpa = query.trim();
  if (!queryLimpa) {
    return [];
  }

  if (queryLimpa.length > 500) {
    throw new PublicOperationError(
      'VALIDATION_ERROR',
      'O termo de busca excede o tamanho máximo permitido (500 caracteres).'
    );
  }

  let disciplinaIdValida: string | undefined;
  if (disciplinaId !== undefined && disciplinaId.trim() !== '') {
    const check = v.uuid('ID da disciplina').safeParse(disciplinaId);
    if (!check.ok) {
      throw new PublicOperationError('VALIDATION_ERROR', check.message);
    }
    disciplinaIdValida = check.data;
  }

  try {
    return await buscaHibridaAcervo(queryLimpa, disciplinaIdValida, 5, {
      papel: perfil.papel,
      perfilId: perfil.id,
      gerarEmbeddingQuery: opcoes?.gerarEmbeddingQuery,
      minSimilaridade: opcoes?.minSimilaridade,
    });
  } catch (error) {
    if (error instanceof EmbeddingServiceUnavailableError || error instanceof GeminiEmbeddingError) {
      logOperationalFailure('acervo.search.embedding', 'external_service');
      throw new PublicOperationError(
        'EXTERNAL_SERVICE_ERROR',
        'A busca semântica está temporariamente indisponível.'
      );
    }
    logOperationalFailure('acervo.search', 'persistence');
    throw new PublicOperationError(
      'PERSISTENCE_ERROR',
      'Não foi possível realizar a busca. Tente novamente.'
    );
  }
}
