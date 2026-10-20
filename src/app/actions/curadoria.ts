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
  cards
} from '../../db/schema';
import { eq, and } from 'drizzle-orm';
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

interface GeracaoConfirmada {
  itensGerados: number;
  status: 'pendente_curadoria';
  mensagem: string;
}

// 1. Enfileirar Geração de Artefatos a partir do Arquivo
export async function enfileirarGeracaoDeArtefatos(
  arquivoId: string
): Promise<OperationResult<GeracaoConfirmada>> {
  const responsavel = await requireRole('responsavel');
  let itensGerados = 0;

  try {
    const [arquivo] = await db
      .select({ id: acervoArquivos.id, statusProcessamento: acervoArquivos.statusProcessamento })
      .from(acervoArquivos)
      .where(and(
        eq(acervoArquivos.id, arquivoId),
        eq(acervoArquivos.enviadoPor, responsavel.id)
      ))
      .limit(1);

    if (!arquivo) {
      return operationFailure('NOT_FOUND', 'Arquivo não encontrado.');
    }
    if (arquivo.statusProcessamento !== 'concluido') {
      return operationFailure(
        'CONFLICT',
        'O processamento do arquivo ainda não foi concluído com sucesso.'
      );
    }

    // 1. Busca os chunks do arquivo que possuem tópicos associados
    const chunks = await db
      .select({
        texto: acervoChunks.texto,
        topicoId: acervoChunks.topicoId,
        topicoNome: topicos.nome
      })
      .from(acervoChunks)
      .innerJoin(topicos, eq(acervoChunks.topicoId, topicos.id))
      .where(eq(acervoChunks.arquivoId, arquivoId));

    if (chunks.length === 0) {
      return operationFailure('NOT_FOUND', 'Não há conteúdo classificado disponível para geração.');
    }

    // 2. Agrupa o texto por tópico
    const chunksPorTopico = new Map<string, { texto: string; topicoNome: string }>();
    for (const c of chunks) {
      if (c.topicoId) {
        const prev = chunksPorTopico.get(c.topicoId) || { texto: '', topicoNome: c.topicoNome };
        chunksPorTopico.set(c.topicoId, {
          texto: prev.texto + '\n' + c.texto,
          topicoNome: c.topicoNome
        });
      }
    }

    // 3. Para cada tópico, gera os artefatos com Gemini (Antigravity engine)
    for (const [topicoId, data] of chunksPorTopico.entries()) {
      let artefatos;
      try {
        artefatos = await gerarArtefatosGemini(data.texto, data.topicoNome);
      } catch (error) {
        if (error instanceof GeminiGenerationError) {
          logOperationalFailure('curadoria.generation.provider', 'external_service');
          return operationFailure(
            'EXTERNAL_SERVICE_ERROR',
            itensGerados > 0
              ? 'A geração foi interrompida após persistência parcial. Revise a fila antes de tentar novamente.'
              : 'O serviço de inteligência artificial não concluiu a geração. Tente novamente mais tarde.'
          );
        }
        throw error;
      }

      // A. Gravar Resumo
      const [resumo] = await db
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

      const [filaResumo] = await db.insert(curadoriaFila).values({
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
        const [card] = await db
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

        const [filaCard] = await db.insert(curadoriaFila).values({
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
        // Busca a disciplina do tópico
        const [topico] = await db
          .select({ disciplinaId: topicos.disciplinaId })
          .from(topicos)
          .where(eq(topicos.id, topicoId))
          .limit(1);
        if (!topico) throw new Error('topic_not_found');

        const [questao] = await db
          .insert(questoes)
          .values({
            procedencia: 'gerada',
            fonte: 'Google Gemini',
            disciplinaId: topico.disciplinaId,
            estilo: 'enem',
            enunciado: q.enunciado,
            alternativas: q.alternativas,
            gabarito: q.gabarito,
            resolucao: q.resolucao,
            status: 'rascunho',
            arquivoOrigemId: arquivoId
          })
          .returning({ id: questoes.id });
        if (!questao) throw new Error('question_insert_not_confirmed');

        const [filaQuestao] = await db.insert(curadoriaFila).values({
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

    return operationSuccess({
      itensGerados,
      status: 'pendente_curadoria',
      mensagem: 'Artefatos gerados como rascunho e enviados para revisão do responsável.',
    });
  } catch {
    logOperationalFailure('curadoria.generation.persistence', 'persistence');
    return operationFailure(
      'PERSISTENCE_ERROR',
      itensGerados > 0
        ? 'A geração teve persistência parcial. Revise a fila antes de tentar novamente.'
        : 'Não foi possível salvar os artefatos gerados.'
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

  const list: any[] = [];
  
  for (const item of itens) {
    let detalhe: any = null;

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
  novosDados?: any,
  motivoRejeicao?: string
): Promise<OperationResult<{ curadoriaId: string; decisao: typeof decisao; mensagem: string }>> {
  const responsavel = await requireRole('responsavel');
  let artefatoAlterado = false;

  try {
    const [item] = await db
      .select()
      .from(curadoriaFila)
      .where(eq(curadoriaFila.id, curadoriaId))
      .limit(1);

    if (!item) {
      return operationFailure('NOT_FOUND', 'Item de curadoria não encontrado.');
    }

    const editado = decisao === 'editado_e_aprovado';
    const estudante = item.artefatoTipo === 'flashcard' && decisao !== 'rejeitado'
      ? await requireManagedStudentProfile()
      : null;

    // 1. Atualiza o artefato de origem
    if (item.artefatoTipo === 'resumo') {
      const [materialAtualizado] = await db
        .update(materiais)
        .set({
          status: decisao === 'rejeitado' ? 'rejeitado' : 'aprovado',
          titulo: editado && novosDados?.titulo ? novosDados.titulo : undefined,
          corpo: editado && novosDados?.corpo ? novosDados.corpo : undefined,
          aprovadoPor: decisao === 'rejeitado' ? null : responsavel.id,
          aprovadoEm: decisao === 'rejeitado' ? null : new Date()
        })
        .where(eq(materiais.id, item.artefatoId))
        .returning({ id: materiais.id });
      if (!materialAtualizado) {
        return operationFailure('NOT_FOUND', 'O artefato associado não foi encontrado.');
      }
      artefatoAlterado = true;
    } else if (item.artefatoTipo === 'flashcard') {
      const [flashcardAtualizado] = await db
        .update(perguntasAtivas)
        .set({
          status: decisao === 'rejeitado' ? 'rejeitado' : 'aprovado',
          pergunta: editado && novosDados?.pergunta ? novosDados.pergunta : undefined,
          resposta: editado && novosDados?.resposta ? novosDados.resposta : undefined
        })
        .where(eq(perguntasAtivas.id, item.artefatoId))
        .returning({ id: perguntasAtivas.id });
      if (!flashcardAtualizado) {
        return operationFailure('NOT_FOUND', 'O artefato associado não foi encontrado.');
      }
      artefatoAlterado = true;

      // Se aprovado, insere o flashcard na tabela de FSRS `cards` para estudos do estudante
      if (decisao === 'aprovado' || decisao === 'editado_e_aprovado') {
        const [flashcard] = await db
          .select()
          .from(perguntasAtivas)
          .where(eq(perguntasAtivas.id, item.artefatoId))
          .limit(1);
        if (!flashcard) throw new Error('approved_flashcard_not_found');

        // Criar card de repetição FSRS
        const [cardCriado] = await db.insert(cards).values({
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
      const [questaoAtualizada] = await db
        .update(questoes)
        .set({
          status: decisao === 'rejeitado' ? 'rejeitado' : 'aprovado',
          enunciado: editado && novosDados?.enunciado ? novosDados.enunciado : undefined,
          alternativas: editado && novosDados?.alternativas ? novosDados.alternativas : undefined,
          gabarito: editado && novosDados?.gabarito ? novosDados.gabarito : undefined
        })
        .where(eq(questoes.id, item.artefatoId))
        .returning({ id: questoes.id });
      if (!questaoAtualizada) {
        return operationFailure('NOT_FOUND', 'O artefato associado não foi encontrado.');
      }
      artefatoAlterado = true;
    } else {
      return operationFailure('VALIDATION_ERROR', 'Tipo de artefato de curadoria inválido.');
    }

    // 2. Atualiza a fila de curadoria
    const [filaAtualizada] = await db
      .update(curadoriaFila)
      .set({
        decisao,
        revisadoEm: new Date(),
        motivoRejeicao: decisao === 'rejeitado' ? motivoRejeicao : null,
        editado
      })
      .where(eq(curadoriaFila.id, curadoriaId))
      .returning({ id: curadoriaFila.id });
    if (!filaAtualizada) throw new Error('curation_queue_update_not_confirmed');

    return operationSuccess({
      curadoriaId,
      decisao,
      mensagem: 'Decisão de curadoria salva com sucesso.',
    });
  } catch (error) {
    if (error instanceof AuthorizationError) throw error;
    logOperationalFailure('curadoria.decision', 'persistence');
    return operationFailure(
      'PERSISTENCE_ERROR',
      artefatoAlterado
        ? 'A decisão teve persistência parcial. Atualize a fila antes de tentar novamente.'
        : 'Não foi possível salvar a decisão de curadoria.'
    );
  }
}
