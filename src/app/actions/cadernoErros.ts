'use server';

import { db } from '../../db';
import { erros, topicos, disciplinas } from '../../db/schema';
import { eq, and, sql, isNull, isNotNull } from 'drizzle-orm';

export interface FiltrosCadernoErros {
  disciplinaId?: string;
  tipoErro?: 'conteudo' | 'interpretacao' | 'distracao' | 'calculo' | 'tempo';
  resolvido?: boolean;
}

// 1. Obter Erros do Caderno
export async function obterCadernoErros(filtros?: FiltrosCadernoErros) {
  try {
    const conditions = [];

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
  } catch (error) {
    console.error('Erro ao obter caderno de erros:', error);
    return [];
  }
}

// 2. Marcar erro como resolvido
export async function resolverErro(erroId: string): Promise<{ sucesso: boolean; mensagem: string }> {
  try {
    await db
      .update(erros)
      .set({ resolvidoEm: new Date() })
      .where(eq(erros.id, erroId));

    return { sucesso: true, mensagem: 'Erro marcado como resolvido e assimilado.' };
  } catch (error: any) {
    console.error('Erro ao resolver erro:', error);
    return { sucesso: false, mensagem: error.message || 'Erro ao atualizar status.' };
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
}): Promise<{ sucesso: boolean; mensagem: string }> {
  try {
    const estudantePerfilId = '00000000-0000-0000-0000-000000000001'; // Maria
    
    // Inserir uma questão mockada para vincular (já que erro exige questaoId)
    // No caderno de erros manual, criamos uma referência fictícia
    const mockQuestaoId = '00000000-0000-0000-0000-000000000000'; // ID zerado mockado no seed

    // Para evitar quebrar chave estrangeira no Drizzle,
    // buscamos a primeira questão disponível ou criamos com id fixado se necessário
    const [mockTentativa] = await db
      .insert(erros)
      .values({
        perfilId: estudantePerfilId,
        questaoId: mockQuestaoId,
        tentativaId: mockQuestaoId, // mock no banco
        descricaoLivre: dados.descricaoLivre,
        disciplinaId: dados.disciplinaId,
        topicoId: dados.topicoId,
        estilo: dados.estilo,
        tipoErro: dados.tipoErro,
        conceitoCorreto: dados.conceitoCorreto
      })
      .returning();

    return { sucesso: true, mensagem: 'Erro registrado manualmente no seu Caderno de Erros.' };
  } catch (error: any) {
    console.error('Erro ao registrar erro manual:', error);
    return { sucesso: false, mensagem: error.message || 'Erro ao registrar erro.' };
  }
}
