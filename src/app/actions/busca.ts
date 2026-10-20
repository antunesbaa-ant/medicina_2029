'use server';

import {
  buscaHibridaAcervo,
  EmbeddingServiceUnavailableError,
  type ResultadoBusca,
} from '../../lib/ingestion';
import { requireAuthenticatedProfile } from '../../lib/authorization';
import { PublicOperationError, logOperationalFailure } from '../../lib/operation-result';

export async function buscarNoAcervo(
  query: string,
  disciplinaId?: string
): Promise<ResultadoBusca[]> {
  await requireAuthenticatedProfile();

  try {
    if (!query.trim()) return [];
    return await buscaHibridaAcervo(query.trim(), disciplinaId);
  } catch (error) {
    if (error instanceof EmbeddingServiceUnavailableError) {
      logOperationalFailure('acervo.search.embedding', 'external_service');
      throw new PublicOperationError(
        'EXTERNAL_SERVICE_ERROR',
        'A busca semântica está temporariamente indisponível.'
      );
    }
    logOperationalFailure('acervo.search', 'persistence');
    throw new PublicOperationError('PERSISTENCE_ERROR', 'Não foi possível realizar a busca. Tente novamente.');
  }
}
