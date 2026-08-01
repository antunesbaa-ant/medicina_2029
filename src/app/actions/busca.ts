'use server';

import { buscaHibridaAcervo, type ResultadoBusca } from '../../lib/ingestion';

export async function buscarNoAcervo(
  query: string,
  disciplinaId?: string
): Promise<ResultadoBusca[]> {
  try {
    if (!query.trim()) return [];
    return await buscaHibridaAcervo(query.trim(), disciplinaId);
  } catch (error) {
    console.error('Erro ao buscar no acervo:', error);
    return [];
  }
}
