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
import { gerarArtefatosClaudeComFallback } from '../../lib/claude';

// 1. Enfileirar Geração de Artefatos a partir do Arquivo
export async function enfileirarGeracaoDeArtefatos(arquivoId: string): Promise<{ sucesso: boolean; mensagem: string }> {
  try {
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
      return {
        sucesso: false,
        mensagem: 'Não foram encontrados chunks com tópicos classificados neste arquivo.'
      };
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

    // 3. Para cada tópico, gera os artefatos com Claude
    for (const [topicoId, data] of chunksPorTopico.entries()) {
      const artefatos = await gerarArtefatosClaudeComFallback(data.texto, data.topicoNome);

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
        .returning();

      await db.insert(curadoriaFila).values({
        artefatoTipo: 'resumo',
        artefatoId: resumo.id,
        topicoId,
        prioridade: 2,
        decisao: 'pendente'
      });

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
          .returning();

        await db.insert(curadoriaFila).values({
          artefatoTipo: 'flashcard',
          artefatoId: card.id,
          topicoId,
          prioridade: 1,
          decisao: 'pendente'
        });
      }

      // C. Gravar Questoes
      for (const q of artefatos.questoes) {
        // Busca a disciplina do tópico
        const [topico] = await db
          .select({ disciplinaId: topicos.disciplinaId })
          .from(topicos)
          .where(eq(topicos.id, topicoId))
          .limit(1);

        const [questao] = await db
          .insert(questoes)
          .values({
            procedencia: 'gerada',
            fonte: 'Claude AI',
            disciplinaId: topico.disciplinaId,
            estilo: 'enem',
            enunciado: q.enunciado,
            alternativas: q.alternativas,
            gabarito: q.gabarito,
            resolucao: q.resolucao,
            status: 'rascunho',
            arquivoOrigemId: arquivoId
          })
          .returning();

        await db.insert(curadoriaFila).values({
          artefatoTipo: 'questao',
          artefatoId: questao.id,
          topicoId,
          prioridade: 3,
          decisao: 'pendente'
        });
      }
    }

    return {
      sucesso: true,
      mensagem: 'Artefatos gerados e enviados para a fila de curadoria do responsável.'
    };
  } catch (error: any) {
    console.error('Erro ao gerar artefatos:', error);
    return {
      sucesso: false,
      mensagem: error.message || 'Erro interno ao enfileirar geração de artefatos.'
    };
  }
}

// 2. Obter Fila de Curadoria Pendente com Joins
export async function obterFilaCuradoria() {
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
): Promise<{ sucesso: boolean; mensagem: string }> {
  try {
    const [item] = await db
      .select()
      .from(curadoriaFila)
      .where(eq(curadoriaFila.id, curadoriaId))
      .limit(1);

    if (!item) {
      return { sucesso: false, mensagem: 'Item de curadoria não encontrado.' };
    }

    const editado = decisao === 'editado_e_aprovado';

    // 1. Atualiza o artefato de origem
    if (item.artefatoTipo === 'resumo') {
      await db
        .update(materiais)
        .set({
          status: decisao === 'rejeitado' ? 'rejeitado' : 'aprovado',
          titulo: editado && novosDados?.titulo ? novosDados.titulo : undefined,
          corpo: editado && novosDados?.corpo ? novosDados.corpo : undefined
        })
        .where(eq(materiais.id, item.artefatoId));
    } else if (item.artefatoTipo === 'flashcard') {
      await db
        .update(perguntasAtivas)
        .set({
          status: decisao === 'rejeitado' ? 'rejeitado' : 'aprovado',
          pergunta: editado && novosDados?.pergunta ? novosDados.pergunta : undefined,
          resposta: editado && novosDados?.resposta ? novosDados.resposta : undefined
        })
        .where(eq(perguntasAtivas.id, item.artefatoId));

      // Se aprovado, insere o flashcard na tabela de FSRS `cards` para estudos do estudante
      if (decisao === 'aprovado' || decisao === 'editado_e_aprovado') {
        const [flashcard] = await db
          .select()
          .from(perguntasAtivas)
          .where(eq(perguntasAtivas.id, item.artefatoId))
          .limit(1);

        const responsavelPerfilId = '00000000-0000-0000-0000-000000000002'; // Bruno (Responsável)
        const estudantePerfilId = '00000000-0000-0000-0000-000000000001'; // Maria (Estudante)

        // Criar card de repetição FSRS
        await db.insert(cards).values({
          perfilId: estudantePerfilId,
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
        });
      }
    } else if (item.artefatoTipo === 'questao') {
      await db
        .update(questoes)
        .set({
          status: decisao === 'rejeitado' ? 'rejeitado' : 'aprovado',
          enunciado: editado && novosDados?.enunciado ? novosDados.enunciado : undefined,
          alternativas: editado && novosDados?.alternativas ? novosDados.alternativas : undefined,
          gabarito: editado && novosDados?.gabarito ? novosDados.gabarito : undefined
        })
        .where(eq(questoes.id, item.artefatoId));
    }

    // 2. Atualiza a fila de curadoria
    await db
      .update(curadoriaFila)
      .set({
        decisao,
        revisadoEm: new Date(),
        motivoRejeicao: decisao === 'rejeitado' ? motivoRejeicao : null,
        editado
      })
      .where(eq(curadoriaFila.id, curadoriaId));

    return { sucesso: true, mensagem: `Item curado com sucesso (${decisao}).` };
  } catch (error: any) {
    console.error('Erro na curadoria do item:', error);
    return { sucesso: false, mensagem: error.message || 'Erro ao salvar decisão de curadoria.' };
  }
}
