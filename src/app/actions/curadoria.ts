'use server';

import { db } from '../../db';
import {
  curadoriaFila,
  materiais,
  perguntasAtivas,
  questoes,
  topicos,
  disciplinas,
  acervoChunks,
  acervoArquivos,
  cards,
  geracoes,
} from '../../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { GeminiGenerationError, gerarArtefatosGemini } from '../../lib/gemini';
import {
  AuthorizationError,
  requireManagedStudentProfile,
  requireRole,
} from '../../lib/authorization';
import {
  logOperationalFailure,
  operationFailure,
  operationSuccess,
  type OperationResult,
} from '../../lib/operation-result';
import {
  enfileirarGeracaoInputSchema,
  curarItemInputSchema,
} from '../../lib/validation';

interface GeracaoConfirmada {
  itensGerados: number;
  status: 'pendente_curadoria';
  mensagem: string;
}

interface DadosEdicaoCuradoria {
  titulo?: string;
  corpo?: string;
  pergunta?: string;
  resposta?: string;
  enunciado?: string;
  alternativas?: unknown;
  gabarito?: string;
}

// 1. Enfileirar Geração de Artefatos a partir do Arquivo
export async function enfileirarGeracaoDeArtefatos(
  arquivoId: string
): Promise<OperationResult<GeracaoConfirmada>> {
  const responsavel = await requireRole('responsavel');

  const validacao = enfileirarGeracaoInputSchema.safeParse({ arquivoId });
  if (!validacao.ok) {
    return operationFailure('VALIDATION_ERROR', validacao.message);
  }
  const { arquivoId: arquivoIdValido } = validacao.data;

  try {
    const [arquivo] = await db
      .select({
        id: acervoArquivos.id,
        enviadoPor: acervoArquivos.enviadoPor,
        statusProcessamento: acervoArquivos.statusProcessamento,
      })
      .from(acervoArquivos)
      .where(and(
        eq(acervoArquivos.id, arquivoIdValido),
        eq(acervoArquivos.enviadoPor, responsavel.id)
      ))
      .limit(1);

    if (!arquivo || (arquivo.enviadoPor && arquivo.enviadoPor !== responsavel.id)) {
      return operationFailure('NOT_FOUND', 'Arquivo não encontrado.');
    }
    if (arquivo.statusProcessamento !== 'concluido') {
      return operationFailure(
        'CONFLICT',
        'O processamento do arquivo ainda não foi concluído com sucesso.'
      );
    }

    const [geracaoExistente] = await db
      .select({ itensGerados: geracoes.itensGerados })
      .from(geracoes)
      .where(and(
        eq(geracoes.arquivoIds, [arquivoIdValido]),
        eq(geracoes.status, 'concluida')
      ))
      .limit(1);
    if (geracaoExistente) {
      return operationSuccess({
        itensGerados: geracaoExistente.itensGerados,
        status: 'pendente_curadoria',
        mensagem: 'Os artefatos deste arquivo já foram gerados e permanecem disponíveis para revisão.',
      });
    }

    // 1. Busca os chunks do arquivo que possuem tópicos associados
    const chunks = await db
      .select({
        texto: acervoChunks.texto,
        topicoId: acervoChunks.topicoId,
        topicoNome: topicos.nome,
        disciplinaId: topicos.disciplinaId,
      })
      .from(acervoChunks)
      .innerJoin(topicos, eq(acervoChunks.topicoId, topicos.id))
      .where(eq(acervoChunks.arquivoId, arquivoIdValido));

    if (chunks.length === 0) {
      return operationFailure('NOT_FOUND', 'Não há conteúdo classificado disponível para geração.');
    }

    // 2. Agrupa o texto por tópico
    const chunksPorTopico = new Map<string, { texto: string; topicoNome: string; disciplinaId: string }>();
    for (const c of chunks) {
      if (c.topicoId) {
        const prev = chunksPorTopico.get(c.topicoId) || {
          texto: '',
          topicoNome: c.topicoNome,
          disciplinaId: c.disciplinaId,
        };
        chunksPorTopico.set(c.topicoId, {
          texto: prev.texto + '\n' + c.texto,
          topicoNome: c.topicoNome,
          disciplinaId: c.disciplinaId,
        });
      }
    }

    if (chunksPorTopico.size === 0) {
      return operationFailure('NOT_FOUND', 'Não há conteúdo classificado disponível para geração.');
    }

    // Geração externa ocorre antes da transação: não é possível torná-la atômica com PostgreSQL.
    const gerados: Array<{
      topicoId: string;
      disciplinaId: string;
      artefatos: Awaited<ReturnType<typeof gerarArtefatosGemini>>;
    }> = [];
    for (const [topicoId, data] of chunksPorTopico.entries()) {
      try {
        gerados.push({
          topicoId,
          disciplinaId: data.disciplinaId,
          artefatos: await gerarArtefatosGemini(data.texto, data.topicoNome),
        });
      } catch (error) {
        if (error instanceof GeminiGenerationError) {
          logOperationalFailure('curadoria.generation.provider', 'external_service');
          return operationFailure(
            'EXTERNAL_SERVICE_ERROR',
            'O serviço de inteligência artificial não concluiu a geração. Nenhum artefato foi salvo.'
          );
        }
        throw error;
      }
    }

    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`curadoria-geracao:${arquivoIdValido}`}::text, 0))`
      );

      const [concorrente] = await tx
        .select({ itensGerados: geracoes.itensGerados })
        .from(geracoes)
        .where(and(
          eq(geracoes.arquivoIds, [arquivoIdValido]),
          eq(geracoes.status, 'concluida')
        ))
        .limit(1);
      if (concorrente) {
        return operationSuccess({
          itensGerados: concorrente.itensGerados,
          status: 'pendente_curadoria',
          mensagem: 'Os artefatos deste arquivo já foram gerados e permanecem disponíveis para revisão.',
        });
      }

      let itensGerados = 0;
      for (const { topicoId, disciplinaId, artefatos } of gerados) {

        // A. Gravar Resumo
        const [resumo] = await tx
          .insert(materiais)
          .values({
            topicoId,
            titulo: artefatos.resumo.titulo,
            corpo: artefatos.resumo.corpo,
            tipo: 'resumo',
            tempoLeituraMin: artefatos.resumo.tempoLeituraMin,
            status: 'rascunho',
            origem: 'gerado'
          })
          .returning({ id: materiais.id });
        if (!resumo) throw new Error('material_insert_not_confirmed');

        const [filaResumo] = await tx.insert(curadoriaFila).values({
          artefatoTipo: 'resumo',
          artefatoId: resumo.id,
          topicoId,
          prioridade: 2,
          decisao: 'pendente'
        }).returning({ id: curadoriaFila.id });
        if (!filaResumo) throw new Error('queue_insert_not_confirmed');
        itensGerados++;

        // B. Gravar Flashcards
        for (const fc of artefatos.flashcards) {
          const [card] = await tx
            .insert(perguntasAtivas)
            .values({
              topicoId,
              pergunta: fc.pergunta,
              resposta: fc.resposta,
              estilo: 'enem',
              status: 'rascunho'
            })
            .returning({ id: perguntasAtivas.id });
          if (!card) throw new Error('flashcard_insert_not_confirmed');

          const [filaCard] = await tx.insert(curadoriaFila).values({
            artefatoTipo: 'flashcard',
            artefatoId: card.id,
            topicoId,
            prioridade: 1,
            decisao: 'pendente'
          }).returning({ id: curadoriaFila.id });
          if (!filaCard) throw new Error('queue_insert_not_confirmed');
          itensGerados++;
        }

        // C. Gravar Questoes
        for (const q of artefatos.questoes) {
          const [questao] = await tx
            .insert(questoes)
            .values({
              procedencia: 'gerada',
              fonte: 'Google Gemini',
              disciplinaId,
              estilo: 'enem',
              enunciado: q.enunciado,
              alternativas: q.alternativas,
              gabarito: q.gabarito,
              resolucao: q.resolucao,
              status: 'rascunho',
              arquivoOrigemId: arquivoIdValido
            })
            .returning({ id: questoes.id });
          if (!questao) throw new Error('question_insert_not_confirmed');

          const [filaQuestao] = await tx.insert(curadoriaFila).values({
            artefatoTipo: 'questao',
            artefatoId: questao.id,
            topicoId,
            prioridade: 3,
            decisao: 'pendente'
          }).returning({ id: curadoriaFila.id });
          if (!filaQuestao) throw new Error('queue_insert_not_confirmed');
          itensGerados++;
        }
      }

      const [geracaoRegistrada] = await tx.insert(geracoes).values({
        tipoArtefato: 'lote_curadoria',
        topicoId: gerados[0].topicoId,
        arquivoIds: [arquivoIdValido],
        chunkIds: [],
        modelo: 'gemini',
        promptVersao: 'f1.07',
        custoTokens: 0,
        iniciadaEm: new Date(),
        concluidaEm: new Date(),
        status: 'concluida',
        itensGerados,
      }).returning({ id: geracoes.id });
      if (!geracaoRegistrada) throw new Error('generation_insert_not_confirmed');

      return operationSuccess({
        itensGerados,
        status: 'pendente_curadoria',
        mensagem: 'Artefatos gerados como rascunho e enviados para revisão do responsável.',
      });
    });
  } catch {
    logOperationalFailure('curadoria.generation.persistence', 'persistence');
    return operationFailure(
      'PERSISTENCE_ERROR',
      'Não foi possível salvar os artefatos gerados. Nenhuma alteração do lote foi confirmada.'
    );
  }
}

// 2. Obter Fila de Curadoria Pendente com Joins
export async function obterFilaCuradoria() {
  await requireRole('responsavel');

  const itens = await db
    .select({
      curadoriaId: curadoriaFila.id,
      artefatoTipo: curadoriaFila.artefatoTipo,
      artefatoId: curadoriaFila.artefatoId,
      topicoId: curadoriaFila.topicoId,
      topicoNome: topicos.nome,
      disciplinaNome: disciplinas.nome,
      prioridade: curadoriaFila.prioridade,
      criadoEm: curadoriaFila.criadoEm
    })
    .from(curadoriaFila)
    .innerJoin(topicos, eq(curadoriaFila.topicoId, topicos.id))
    .innerJoin(disciplinas, eq(topicos.disciplinaId, disciplinas.id))
    .where(eq(curadoriaFila.decisao, 'pendente'))
    .orderBy(curadoriaFila.prioridade);

  const list: Array<(typeof itens)[number] & { conteudo: unknown }> = [];
  
  for (const item of itens) {
    let detalhe: unknown = null;

    if (item.artefatoTipo === 'resumo') {
      const [res] = await db
        .select()
        .from(materiais)
        .where(eq(materiais.id, item.artefatoId))
        .limit(1);
      detalhe = res;
    } else if (item.artefatoTipo === 'flashcard') {
      const [res] = await db
        .select()
        .from(perguntasAtivas)
        .where(eq(perguntasAtivas.id, item.artefatoId))
        .limit(1);
      detalhe = res;
    } else if (item.artefatoTipo === 'questao') {
      const [res] = await db
        .select()
        .from(questoes)
        .where(eq(questoes.id, item.artefatoId))
        .limit(1);
      detalhe = res;
    }

    if (detalhe) {
      list.push({
        ...item,
        conteudo: detalhe
      });
    }
  }

  return list;
}

// 3. Decisão de Curadoria (Aprovar / Rejeitar / Editar e Aprovar)
export async function curarItem(
  curadoriaId: string,
  decisao: 'aprovado' | 'rejeitado' | 'editado_e_aprovado',
  novosDados?: DadosEdicaoCuradoria | null,
  motivoRejeicao?: string
): Promise<OperationResult<{ curadoriaId: string; decisao: typeof decisao; mensagem: string }>> {
  const responsavel = await requireRole('responsavel');

  const validacao = curarItemInputSchema.safeParse({
    curadoriaId,
    decisao,
    novosDados,
    motivoRejeicao,
  });
  if (!validacao.ok) {
    return operationFailure('VALIDATION_ERROR', validacao.message);
  }
  const {
    curadoriaId: curadoriaIdValido,
    decisao: decisaoValida,
    novosDados: dadosEditadosValidos,
    motivoRejeicao: motivoValido,
  } = validacao.data;

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`curadoria-decisao:${curadoriaIdValido}`}::text, 0))`
      );

      const [item] = await tx
        .select()
        .from(curadoriaFila)
        .where(eq(curadoriaFila.id, curadoriaIdValido))
        .limit(1);

      if (!item) {
        return operationFailure('NOT_FOUND', 'Item de curadoria não encontrado.');
      }

      if (item.decisao !== 'pendente') {
        if (item.decisao === decisaoValida) {
          return operationSuccess({
            curadoriaId: curadoriaIdValido,
            decisao: decisaoValida,
            mensagem: 'Esta decisão de curadoria já havia sido salva.',
          });
        }
        return operationFailure('CONFLICT', 'O item já recebeu outra decisão de curadoria.');
      }

      const editado = decisaoValida === 'editado_e_aprovado';
      if (editado) {
        if (
          item.artefatoTipo === 'resumo' &&
          dadosEditadosValidos?.titulo === undefined &&
          dadosEditadosValidos?.corpo === undefined
        ) {
          return operationFailure('VALIDATION_ERROR', 'Informe título ou corpo para editar um resumo.');
        }
        if (
          item.artefatoTipo === 'flashcard' &&
          dadosEditadosValidos?.pergunta === undefined &&
          dadosEditadosValidos?.resposta === undefined
        ) {
          return operationFailure('VALIDATION_ERROR', 'Informe pergunta ou resposta para editar um flashcard.');
        }
        if (
          item.artefatoTipo === 'questao' &&
          dadosEditadosValidos?.enunciado === undefined &&
          dadosEditadosValidos?.alternativas === undefined &&
          dadosEditadosValidos?.gabarito === undefined
        ) {
          return operationFailure('VALIDATION_ERROR', 'Informe enunciado, alternativas ou gabarito para editar uma questão.');
        }
      }

      const estudante = item.artefatoTipo === 'flashcard' && decisaoValida !== 'rejeitado'
        ? await requireManagedStudentProfile()
        : null;

      // 1. Atualiza o artefato de origem verificando consistência relacional (topicoId)
      if (item.artefatoTipo === 'resumo') {
        const [materialAtualizado] = await tx
          .update(materiais)
          .set({
            status: decisaoValida === 'rejeitado' ? 'rejeitado' : 'aprovado',
            titulo: editado && dadosEditadosValidos?.titulo ? dadosEditadosValidos.titulo : undefined,
            corpo: editado && dadosEditadosValidos?.corpo ? dadosEditadosValidos.corpo : undefined,
            aprovadoPor: decisaoValida === 'rejeitado' ? null : responsavel.id,
            aprovadoEm: decisaoValida === 'rejeitado' ? null : new Date()
          })
          .where(and(
            eq(materiais.id, item.artefatoId),
            eq(materiais.topicoId, item.topicoId)
          ))
          .returning({ id: materiais.id });
        if (!materialAtualizado) {
          return operationFailure('NOT_FOUND', 'O artefato associado não foi encontrado.');
        }
      } else if (item.artefatoTipo === 'flashcard') {
        const [flashcardAtualizado] = await tx
          .update(perguntasAtivas)
          .set({
            status: decisaoValida === 'rejeitado' ? 'rejeitado' : 'aprovado',
            pergunta: editado && dadosEditadosValidos?.pergunta ? dadosEditadosValidos.pergunta : undefined,
            resposta: editado && dadosEditadosValidos?.resposta ? dadosEditadosValidos.resposta : undefined
          })
          .where(and(
            eq(perguntasAtivas.id, item.artefatoId),
            eq(perguntasAtivas.topicoId, item.topicoId)
          ))
          .returning({ id: perguntasAtivas.id });
        if (!flashcardAtualizado) {
          return operationFailure('NOT_FOUND', 'O artefato associado não foi encontrado.');
        }

        // Se aprovado, insere o flashcard na tabela de FSRS `cards` para estudos do estudante
        if (decisaoValida === 'aprovado' || decisaoValida === 'editado_e_aprovado') {
          const [flashcard] = await tx
            .select()
            .from(perguntasAtivas)
            .where(eq(perguntasAtivas.id, item.artefatoId))
            .limit(1);
          if (!flashcard) throw new Error('approved_flashcard_not_found');

          // Criar card de repetição FSRS
          const [cardCriado] = await tx.insert(cards).values({
            perfilId: estudante!.id,
            topicoId: item.topicoId,
            frente: flashcard.pergunta,
            verso: flashcard.resposta,
            origem: 'gerado',
            status: 'aprovado',
            suspenso: false,
            due: new Date(), // Vence hoje imediatamente
            stability: 1.0,
            difficulty: 5.0,
            elapsedDays: 0,
            scheduledDays: 0,
            reps: 0,
            lapses: 0,
            state: 'new'
          }).returning({ id: cards.id });
          if (!cardCriado) throw new Error('fsrs_card_insert_not_confirmed');
        }
      } else if (item.artefatoTipo === 'questao') {
        const [questaoAtualizada] = await tx
          .update(questoes)
          .set({
            status: decisaoValida === 'rejeitado' ? 'rejeitado' : 'aprovado',
            enunciado: editado && dadosEditadosValidos?.enunciado ? dadosEditadosValidos.enunciado : undefined,
            alternativas: editado && dadosEditadosValidos?.alternativas ? dadosEditadosValidos.alternativas : undefined,
            gabarito: editado && dadosEditadosValidos?.gabarito ? dadosEditadosValidos.gabarito : undefined
          })
          .where(eq(questoes.id, item.artefatoId))
          .returning({ id: questoes.id });
        if (!questaoAtualizada) {
          return operationFailure('NOT_FOUND', 'O artefato associado não foi encontrado.');
        }
      } else {
        return operationFailure('VALIDATION_ERROR', 'Tipo de artefato de curadoria inválido.');
      }

      // 2. Atualiza a fila de curadoria
      const [filaAtualizada] = await tx
        .update(curadoriaFila)
        .set({
          decisao: decisaoValida,
          revisadoEm: new Date(),
          motivoRejeicao: decisaoValida === 'rejeitado' ? (motivoValido ?? null) : null,
          editado
        })
        .where(and(
          eq(curadoriaFila.id, curadoriaIdValido),
          eq(curadoriaFila.decisao, 'pendente')
        ))
        .returning({ id: curadoriaFila.id });
      if (!filaAtualizada) throw new Error('curation_queue_update_not_confirmed');

      return operationSuccess({
        curadoriaId: curadoriaIdValido,
        decisao: decisaoValida,
        mensagem: 'Decisão de curadoria salva com sucesso.',
      });
    });
  } catch (error) {
    if (error instanceof AuthorizationError) throw error;
    logOperationalFailure('curadoria.decision', 'persistence');
    return operationFailure(
      'PERSISTENCE_ERROR',
      'Não foi possível salvar a decisão de curadoria. Nenhuma alteração foi confirmada.'
    );
  }
}
