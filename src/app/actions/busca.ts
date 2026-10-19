'use server';

import { buscaHibridaAcervo, type ResultadoBusca } from '../../lib/ingestion';
import { requireAuthenticatedProfile } from '../../lib/authorization';

export async function buscarNoAcervo(
  query: string,
  disciplinaId?: string
): Promise<ResultadoBusca[]> {
  await requireAuthenticatedProfile();

  try {
    if (!query.trim()) return [];
    return await buscaHibridaAcervo(query.trim(), disciplinaId);
  } catch (error) {
    console.error('Erro ao buscar no acervo:', error);
    return [];
  }
}
