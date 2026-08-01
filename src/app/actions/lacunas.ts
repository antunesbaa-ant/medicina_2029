'use server';

import { db } from '../../db';
import { erros, topicos, disciplinas, materiais, questoes } from '../../db/schema';
import { eq, sql, desc, and } from 'drizzle-orm';

export interface LacunaData {
  topicoId: string;
  topicoNome: string;
  disciplinaNome: string;
  corHex: string;
  totalErros: number;
  tipoErroFrequente: string;
  temResumoAprovado: boolean;
  totalQuestoesDisponiveis: number;
}

// 1. Obter Painel de Lacunas
export async function obterLacunasEstudo(): Promise<LacunaData[]> {
  try {
    // Busca contagem de erros agrupados por tópico
    const errosPorTopico = await db
      .select({
        topicoId: erros.topicoId,
        totalErros: sql<number>`count(${erros.id})::int`,
        // Agrupa e encontra o tipo de erro mais comum
        tipoErroFrequente: sql<string>`mode() within group (order by ${erros.tipoErro})`
      })
      .from(erros)
      .groupBy(erros.topicoId)
      .orderBy(desc(sql`count(${erros.id})`))
      .limit(10);

    const list: LacunaData[] = [];

    for (const item of errosPorTopico) {
      // Detalhes do tópico
      const [topico] = await db
        .select({
          nome: topicos.nome,
          disciplinaId: topicos.disciplinaId,
          disciplinaNome: disciplinas.nome,
          corHex: disciplinas.corHex
        })
        .from(topicos)
        .innerJoin(disciplinas, eq(topicos.disciplinaId, disciplinas.id))
        .where(eq(topicos.id, item.topicoId))
        .limit(1);

      if (!topico) continue;

      // Verificar se possui resumo aprovado
      const resumosDisponiveis = await db
        .select({ id: materiais.id })
        .from(materiais)
        .where(
          and(
            eq(materiais.topicoId, item.topicoId),
            eq(materiais.status, 'aprovado'),
            eq(materiais.tipo, 'resumo')
          )
        )
        .limit(1);

      // Contar questões aprovadas para o tópico
      const [questoesCount] = await db
        .select({ count: sql<number>`count(${questoes.id})::int` })
        .from(questoes)
        .where(
          and(
            eq(questoes.disciplinaId, topico.disciplinaId), // Simplificando vínculo ao tópico pela disciplina
            eq(questoes.status, 'aprovado')
          )
        );

      list.push({
        topicoId: item.topicoId,
        topicoNome: topico.nome,
        disciplinaNome: topico.disciplinaNome,
        corHex: topico.corHex,
        totalErros: item.totalErros,
        tipoErroFrequente: item.tipoErroFrequente,
        temResumoAprovado: resumosDisponiveis.length > 0,
        totalQuestoesDisponiveis: questoesCount?.count || 0
      });
    }

    // Se estiver vazio (ex: banco sem erros registrados), retorna mocks realistas para demonstração
    if (list.length === 0) {
      return [
        {
          topicoId: 'mock-topico-1',
          topicoNome: 'Ciclo de Krebs e Fosforilação Oxidativa',
          disciplinaNome: 'Biologia',
          corHex: '#17607A',
          totalErros: 7,
          tipoErroFrequente: 'conteudo',
          temResumoAprovado: true,
          totalQuestoesDisponiveis: 5
        },
        {
          topicoId: 'mock-topico-2',
          topicoNome: 'Estequiometria e Reações Redox',
          disciplinaNome: 'Química',
          corHex: '#C98A2E',
          totalErros: 4,
          tipoErroFrequente: 'calculo',
          temResumoAprovado: false,
          totalQuestoesDisponiveis: 3
        },
        {
          topicoId: 'mock-topico-3',
          topicoNome: 'Divisão Celular e Citogenética',
          disciplinaNome: 'Biologia',
          corHex: '#17607A',
          totalErros: 3,
          tipoErroFrequente: 'interpretacao',
          temResumoAprovado: true,
          totalQuestoesDisponiveis: 2
        }
      ];
    }

    return list;
  } catch (error) {
    console.error('Erro ao buscar lacunas de estudo:', error);
    return [];
  }
}

// 2. Obter resumo aprovado para o tópico
export async function obterResumoAprovado(topicoId: string) {
  const [resumo] = await db
    .select()
    .from(materiais)
    .where(
      and(
        eq(materiais.topicoId, topicoId),
        eq(materiais.status, 'aprovado'),
        eq(materiais.tipo, 'resumo')
      )
    )
    .limit(1);
  return resumo || null;
}
