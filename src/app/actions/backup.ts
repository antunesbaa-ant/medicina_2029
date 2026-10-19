'use server';

import { db } from '../../db';
import { getTableColumns, type Table } from 'drizzle-orm';
import {
  acervoArquivos,
  acervoChunks,
  acervoFiguras,
  acervoPaginas,
  cards,
  cardRevisoes,
  checkins,
  cicloBlocos,
  cicloEstado,
  ciclos,
  curadoriaFila,
  disciplinas,
  erros,
  geracoes,
  generos,
  livros,
  materiais,
  perfis,
  perguntasAtivas,
  questaoTopicos,
  questoes,
  redacoes,
  repertorios,
  responsavelEstudante,
  revisoesTrimestrais,
  sessoes,
  simuladoAnalise,
  simuladoAreas,
  simuladoQuestoes,
  simulados,
  tentativas,
  topicos
} from '../../db/schema';
import {
  criarExportacaoSegura,
  EXPORT_COLLECTION_FIELDS,
  type ExportCollections,
  validarExportacaoSegura,
  type ExportValidationResult
} from '../../lib/exportacao-segura';
import { requireRole } from '../../lib/authorization';

function selectAllowedFields<TTable extends Table, TKey extends keyof TTable['_']['columns']>(
  table: TTable,
  fields: readonly TKey[]
): Pick<TTable['_']['columns'], TKey> {
  const columns = getTableColumns(table);
  return Object.fromEntries(fields.map((field) => [field, columns[field]])) as Pick<
    TTable['_']['columns'],
    TKey
  >;
}

function toRecords(rows: readonly object[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row }));
}

export async function exportarDadosCompletos(): Promise<string> {
  await requireRole('responsavel');

  try {
    const dados: ExportCollections = {
      perfis: toRecords(await db.select(selectAllowedFields(perfis, EXPORT_COLLECTION_FIELDS.perfis)).from(perfis)),
      responsavelEstudante: toRecords(await db.select(selectAllowedFields(responsavelEstudante, EXPORT_COLLECTION_FIELDS.responsavelEstudante)).from(responsavelEstudante)),
      generos: toRecords(await db.select(selectAllowedFields(generos, EXPORT_COLLECTION_FIELDS.generos)).from(generos)),
      disciplinas: toRecords(await db.select(selectAllowedFields(disciplinas, EXPORT_COLLECTION_FIELDS.disciplinas)).from(disciplinas)),
      topicos: toRecords(await db.select(selectAllowedFields(topicos, EXPORT_COLLECTION_FIELDS.topicos)).from(topicos)),
      materiais: toRecords(await db.select(selectAllowedFields(materiais, EXPORT_COLLECTION_FIELDS.materiais)).from(materiais)),
      perguntasAtivas: toRecords(await db.select(selectAllowedFields(perguntasAtivas, EXPORT_COLLECTION_FIELDS.perguntasAtivas)).from(perguntasAtivas)),
      questoes: toRecords(await db.select(selectAllowedFields(questoes, EXPORT_COLLECTION_FIELDS.questoes)).from(questoes)),
      questaoTopicos: toRecords(await db.select(selectAllowedFields(questaoTopicos, EXPORT_COLLECTION_FIELDS.questaoTopicos)).from(questaoTopicos)),
      curadoriaFila: toRecords(await db.select(selectAllowedFields(curadoriaFila, EXPORT_COLLECTION_FIELDS.curadoriaFila)).from(curadoriaFila)),
      sessoes: toRecords(await db.select(selectAllowedFields(sessoes, EXPORT_COLLECTION_FIELDS.sessoes)).from(sessoes)),
      ciclos: toRecords(await db.select(selectAllowedFields(ciclos, EXPORT_COLLECTION_FIELDS.ciclos)).from(ciclos)),
      cicloBlocos: toRecords(await db.select(selectAllowedFields(cicloBlocos, EXPORT_COLLECTION_FIELDS.cicloBlocos)).from(cicloBlocos)),
      cicloEstado: toRecords(await db.select(selectAllowedFields(cicloEstado, EXPORT_COLLECTION_FIELDS.cicloEstado)).from(cicloEstado)),
      tentativas: toRecords(await db.select(selectAllowedFields(tentativas, EXPORT_COLLECTION_FIELDS.tentativas)).from(tentativas)),
      erros: toRecords(await db.select(selectAllowedFields(erros, EXPORT_COLLECTION_FIELDS.erros)).from(erros)),
      cards: toRecords(await db.select(selectAllowedFields(cards, EXPORT_COLLECTION_FIELDS.cards)).from(cards)),
      cardRevisoes: toRecords(await db.select(selectAllowedFields(cardRevisoes, EXPORT_COLLECTION_FIELDS.cardRevisoes)).from(cardRevisoes)),
      checkins: toRecords(await db.select(selectAllowedFields(checkins, EXPORT_COLLECTION_FIELDS.checkins)).from(checkins)),
      redacoes: toRecords(await db.select(selectAllowedFields(redacoes, EXPORT_COLLECTION_FIELDS.redacoes)).from(redacoes)),
      repertorios: toRecords(await db.select(selectAllowedFields(repertorios, EXPORT_COLLECTION_FIELDS.repertorios)).from(repertorios)),
      simulados: toRecords(await db.select(selectAllowedFields(simulados, EXPORT_COLLECTION_FIELDS.simulados)).from(simulados)),
      simuladoQuestoes: toRecords(await db.select(selectAllowedFields(simuladoQuestoes, EXPORT_COLLECTION_FIELDS.simuladoQuestoes)).from(simuladoQuestoes)),
      simuladoAreas: toRecords(await db.select(selectAllowedFields(simuladoAreas, EXPORT_COLLECTION_FIELDS.simuladoAreas)).from(simuladoAreas)),
      simuladoAnalise: toRecords(await db.select(selectAllowedFields(simuladoAnalise, EXPORT_COLLECTION_FIELDS.simuladoAnalise)).from(simuladoAnalise)),
      revisoesTrimestrais: toRecords(await db.select(selectAllowedFields(revisoesTrimestrais, EXPORT_COLLECTION_FIELDS.revisoesTrimestrais)).from(revisoesTrimestrais)),
      livros: toRecords(await db.select(selectAllowedFields(livros, EXPORT_COLLECTION_FIELDS.livros)).from(livros)),
      acervoArquivos: toRecords(await db.select(selectAllowedFields(acervoArquivos, EXPORT_COLLECTION_FIELDS.acervoArquivos)).from(acervoArquivos)),
      acervoPaginas: toRecords(await db.select(selectAllowedFields(acervoPaginas, EXPORT_COLLECTION_FIELDS.acervoPaginas)).from(acervoPaginas)),
      acervoChunks: toRecords(await db.select(selectAllowedFields(acervoChunks, EXPORT_COLLECTION_FIELDS.acervoChunks)).from(acervoChunks)),
      acervoFiguras: toRecords(await db.select(selectAllowedFields(acervoFiguras, EXPORT_COLLECTION_FIELDS.acervoFiguras)).from(acervoFiguras)),
      geracoes: toRecords(await db.select(selectAllowedFields(geracoes, EXPORT_COLLECTION_FIELDS.geracoes)).from(geracoes))
    };

    return JSON.stringify(criarExportacaoSegura(dados), null, 2);
  } catch {
    console.error('Falha interna ao gerar exportação administrativa segura.');
    throw new Error('Falha ao exportar base de dados.');
  }
}

export async function validarArquivoExportacao(jsonStr: string): Promise<ExportValidationResult> {
  await requireRole('responsavel');
  return validarExportacaoSegura(jsonStr);
}

export async function restaurarDadosCompletos(
  jsonStr: string
): Promise<{ sucesso: false; mensagem: string }> {
  await requireRole('responsavel');
  void jsonStr;

  return {
    sucesso: false,
    mensagem: 'Restauração indisponível por segurança. O arquivo não foi aplicado.'
  };
}
