'use server';

import { db } from '../../db';
import {
  perfis,
  disciplinas,
  topicos,
  materiais,
  perguntasAtivas,
  questoes,
  curadoriaFila,
  sessoes,
  ciclos,
  cicloBlocos,
  tentativas,
  erros,
  cards,
  cardRevisoes,
  checkins,
  redacoes,
  repertorios,
  simulados,
  simuladoAreas,
  simuladoAnalise,
  revisoesTrimestrais,
  livros,
  generos
} from '../../db/schema';
import { sql } from 'drizzle-orm';

export interface BackupData {
  perfis: any[];
  generos: any[];
  disciplinas: any[];
  topicos: any[];
  materiais: any[];
  perguntasAtivas: any[];
  questoes: any[];
  curadoriaFila: any[];
  sessoes: any[];
  ciclos: any[];
  cicloBlocos: any[];
  tentativas: any[];
  erros: any[];
  cards: any[];
  cardRevisoes: any[];
  checkins: any[];
  redacoes: any[];
  repertorios: any[];
  simulados: any[];
  simuladoAreas: any[];
  simuladoAnalise: any[];
  revisoesTrimestrais: any[];
  livros: any[];
}

// 1. Exportar todos os dados do banco como JSON estruturado
export async function exportarDadosCompletos(): Promise<string> {
  try {
    const backup: BackupData = {
      perfis: await db.select().from(perfis),
      generos: await db.select().from(generos),
      disciplinas: await db.select().from(disciplinas),
      topicos: await db.select().from(topicos),
      materiais: await db.select().from(materiais),
      perguntasAtivas: await db.select().from(perguntasAtivas),
      questoes: await db.select().from(questoes),
      curadoriaFila: await db.select().from(curadoriaFila),
      sessoes: await db.select().from(sessoes),
      ciclos: await db.select().from(ciclos),
      cicloBlocos: await db.select().from(cicloBlocos),
      tentativas: await db.select().from(tentativas),
      erros: await db.select().from(erros),
      cards: await db.select().from(cards),
      cardRevisoes: await db.select().from(cardRevisoes),
      checkins: await db.select().from(checkins),
      redacoes: await db.select().from(redacoes),
      repertorios: await db.select().from(repertorios),
      simulados: await db.select().from(simulados),
      simuladoAreas: await db.select().from(simuladoAreas),
      simuladoAnalise: await db.select().from(simuladoAnalise),
      revisoesTrimestrais: await db.select().from(revisoesTrimestrais),
      livros: await db.select().from(livros)
    };

    return JSON.stringify(backup, null, 2);
  } catch (error) {
    console.error('Erro ao gerar export de dados:', error);
    throw new Error('Falha ao exportar base de dados.');
  }
}

// 2. Restaurar dados em uma base limpa (Critério de Aceite)
export async function restaurarDadosCompletos(jsonStr: string): Promise<{ sucesso: boolean; mensagem: string }> {
  try {
    const backup: BackupData = JSON.parse(jsonStr);

    // Deleta tabelas na ordem correta de chaves estrangeiras
    await db.transaction(async (tx) => {
      console.log('Limpando tabelas para restauração de backup...');
      
      await tx.delete(simuladoAnalise);
      await tx.delete(simuladoAreas);
      await tx.delete(simulados);
      await tx.delete(cardRevisoes);
      await tx.delete(cards);
      await tx.delete(tentativas);
      await tx.delete(erros);
      await tx.delete(redacoes);
      await tx.delete(repertorios);
      await tx.delete(livros);
      await tx.delete(checkins);
      await tx.delete(revisoesTrimestrais);
      await tx.delete(sessoes);
      await tx.delete(cicloBlocos);
      await tx.delete(ciclos);
      await tx.delete(curadoriaFila);
      await tx.delete(perguntasAtivas);
      await tx.delete(questoes);
      await tx.delete(materiais);
      await tx.delete(topicos);
      await tx.delete(disciplinas);
      await tx.delete(generos);
      await tx.delete(perfis);

      console.log('Reinserindo dados restaurados...');

      // Insere dados respeitando a ordem de chaves estrangeiras
      if (backup.perfis?.length) await tx.insert(perfis).values(backup.perfis);
      if (backup.generos?.length) await tx.insert(generos).values(backup.generos);
      if (backup.disciplinas?.length) await tx.insert(disciplinas).values(backup.disciplinas);
      if (backup.topicos?.length) await tx.insert(topicos).values(backup.topicos);
      if (backup.materiais?.length) await tx.insert(materiais).values(backup.materiais);
      if (backup.perguntasAtivas?.length) await tx.insert(perguntasAtivas).values(backup.perguntasAtivas);
      if (backup.questoes?.length) await tx.insert(questoes).values(backup.questoes);
      if (backup.curadoriaFila?.length) await tx.insert(curadoriaFila).values(backup.curadoriaFila);
      if (backup.sessoes?.length) await tx.insert(sessoes).values(backup.sessoes);
      if (backup.ciclos?.length) await tx.insert(ciclos).values(backup.ciclos);
      if (backup.cicloBlocos?.length) await tx.insert(cicloBlocos).values(backup.cicloBlocos);
      if (backup.tentativas?.length) await tx.insert(tentativas).values(backup.tentativas);
      if (backup.erros?.length) await tx.insert(erros).values(backup.erros);
      if (backup.cards?.length) await tx.insert(cards).values(backup.cards);
      if (backup.cardRevisoes?.length) await tx.insert(cardRevisoes).values(backup.cardRevisoes);
      if (backup.checkins?.length) await tx.insert(checkins).values(backup.checkins);
      if (backup.redacoes?.length) await tx.insert(redacoes).values(backup.redacoes);
      if (backup.repertorios?.length) await tx.insert(repertorios).values(backup.repertorios);
      if (backup.simulados?.length) await tx.insert(simulados).values(backup.simulados);
      if (backup.simuladoAreas?.length) await tx.insert(simuladoAreas).values(backup.simuladoAreas);
      if (backup.simuladoAnalise?.length) await tx.insert(simuladoAnalise).values(backup.simuladoAnalise);
      if (backup.revisoesTrimestrais?.length) await tx.insert(revisoesTrimestrais).values(backup.revisoesTrimestrais);
      if (backup.livros?.length) await tx.insert(livros).values(backup.livros);
    });

    return { sucesso: true, mensagem: 'Base de dados restaurada com sucesso a partir do backup.' };
  } catch (error: any) {
    console.error('Erro ao restaurar backup:', error);
    return { sucesso: false, mensagem: error.message || 'Falha ao restaurar base de dados.' };
  }
}
