'use server';

import { db } from '../../db';
import { sessoes, cicloBlocos, cicloEstado, erros, questoes } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { validarConclusaoSessao, calcularProximaOrdem } from '../../lib/studysystem';

export async function iniciarSessao(
  perfilId: string,
  cicloBlocoId: string,
  topicoId: string
): Promise<string> {
  try {
    const [sessaoInserida] = await db
      .insert(sessoes)
      .values({
        perfilId,
        cicloBlocoId,
        topicoId,
        iniciadaEm: new Date(),
        segundosEfetivos: 0,
        segundosPausa: 0,
        etapaAtingida: 'revisao',
        concluida: false,
      })
      .returning();

    if (!sessaoInserida) {
      throw new Error('Não foi possível iniciar a sessão');
    }

    return sessaoInserida.id;
  } catch (error) {
    console.warn('Banco offline ou indisponível ao iniciar sessão. Usando mock.');
    // Retorna um ID de sessão mockado
    return `sessao-mock-${Date.now()}`;
  }
}

export interface DadosAtualizacaoSessao {
  etapaAtingida?: 'revisao' | 'conteudo' | 'questoes' | 'registro';
  segundosEfetivos?: number;
  segundosPausa?: number;
  notaLivre?: string;
}

export async function atualizarSessao(
  sessaoId: string,
  dados: DadosAtualizacaoSessao
): Promise<typeof sessoes.$inferSelect> {
  try {
    const [sessaoAtualizada] = await db
      .update(sessoes)
      .set({
        ...(dados.etapaAtingida && { etapaAtingida: dados.etapaAtingida }),
        ...(dados.segundosEfetivos !== undefined && { segundosEfetivos: dados.segundosEfetivos }),
        ...(dados.segundosPausa !== undefined && { segundosPausa: dados.segundosPausa }),
        ...(dados.notaLivre !== undefined && { notaLivre: dados.notaLivre }),
      })
      .where(eq(sessoes.id, sessaoId))
      .returning();

    if (!sessaoAtualizada) {
      throw new Error(`Sessão ${sessaoId} não encontrada para atualização`);
    }

    return sessaoAtualizada;
  } catch (error) {
    console.warn('Banco offline ao atualizar sessão. Usando mock.');
    return {
      id: sessaoId,
      perfilId: '00000000-0000-0000-0000-000000000001',
      cicloBlocoId: 'b-1',
      topicoId: 't-mat-1',
      iniciadaEm: new Date(),
      encerradaEm: null,
      segundosEfetivos: dados.segundosEfetivos ?? 0,
      segundosPausa: dados.segundosPausa ?? 0,
      etapaAtingida: dados.etapaAtingida ?? 'revisao',
      concluida: false,
      notaLivre: dados.notaLivre ?? null,
    };
  }
}

export interface ErroParaRegistrar {
  questaoId: string;
  tentativaId: string;
  tipoErro: 'conteudo' | 'interpretacao' | 'distracao' | 'calculo' | 'tempo';
  descricaoLivre?: string;
  conceitoCorreto?: string;
}

export interface DadosFinalizacaoSessao {
  encerradaEm?: Date;
  segundosEfetivos?: number;
  segundosPausa?: number;
  etapaAtingida: 'revisao' | 'conteudo' | 'questoes' | 'registro';
  notaLivre?: string;
  errosParaRegistrar?: ErroParaRegistrar[];
}

export async function concluirSessao(
  sessaoId: string,
  dadosFinalizacao: DadosFinalizacaoSessao
): Promise<typeof sessoes.$inferSelect> {
  try {
    // 1. Busca a sessão e seu bloco para obter dados de referência (perfilId, cicloBlocoId, etc.)
    const [dadosSessao] = await db
      .select({
        sessao: sessoes,
        bloco: cicloBlocos,
      })
      .from(sessoes)
      .where(eq(sessoes.id, sessaoId))
      .innerJoin(cicloBlocos, eq(sessoes.cicloBlocoId, cicloBlocos.id))
      .limit(1);

    if (!dadosSessao) {
      throw new Error(`Sessão ${sessaoId} não encontrada ou sem bloco correspondente`);
    }

    const { sessao, bloco } = dadosSessao;

    // 2. Valida conclusão de acordo com a etapa atingida
    const concluida = validarConclusaoSessao(dadosFinalizacao.etapaAtingida);

    // 3. Atualiza os dados da sessão no banco
    const [sessaoConcluida] = await db
      .update(sessoes)
      .set({
        encerradaEm: dadosFinalizacao.encerradaEm || new Date(),
        segundosEfetivos: dadosFinalizacao.segundosEfetivos ?? sessao.segundosEfetivos,
        segundosPausa: dadosFinalizacao.segundosPausa ?? sessao.segundosPausa,
        etapaAtingida: dadosFinalizacao.etapaAtingida,
        notaLivre: dadosFinalizacao.notaLivre ?? sessao.notaLivre,
        concluida,
      })
      .where(eq(sessoes.id, sessaoId))
      .returning();

    // 4. Registra os erros, se houver
    if (dadosFinalizacao.errosParaRegistrar && dadosFinalizacao.errosParaRegistrar.length > 0) {
      for (const erro of dadosFinalizacao.errosParaRegistrar) {
        // Busca a questão para obter a disciplinaId e estilo
        const [questao] = await db
          .select({
            disciplinaId: questoes.disciplinaId,
            estilo: questoes.estilo,
          })
          .from(questoes)
          .where(eq(questoes.id, erro.questaoId))
          .limit(1);

        if (!questao) {
          throw new Error(`Questão ${erro.questaoId} não encontrada para o registro de erro`);
        }

        await db.insert(erros).values({
          perfilId: sessao.perfilId,
          questaoId: erro.questaoId,
          tentativaId: erro.tentativaId,
          descricaoLivre: erro.descricaoLivre || null,
          disciplinaId: questao.disciplinaId,
          topicoId: sessao.topicoId,
          estilo: questao.estilo,
          tipoErro: erro.tipoErro,
          conceitoCorreto: erro.conceitoCorreto || null,
          criadoEm: new Date(),
          vezesRevisado: 0,
        });
      }
    }

    // 5. Avança o ponteiro proximaOrdem no cicloEstado
    // Busca a quantidade total de blocos daquele ciclo
    const blocosDoCiclo = await db
      .select({ id: cicloBlocos.id })
      .from(cicloBlocos)
      .where(eq(cicloBlocos.cicloId, bloco.cicloId));

    const totalBlocos = blocosDoCiclo.length;
    const proximaOrdem = calcularProximaOrdem(bloco.ordem, totalBlocos);

    await db
      .insert(cicloEstado)
      .values({
        cicloId: bloco.cicloId,
        proximaOrdem,
      })
      .onConflictDoUpdate({
        target: cicloEstado.cicloId,
        set: { proximaOrdem },
      });

    return sessaoConcluida;
  } catch (error) {
    console.warn('Banco offline ao concluir sessão. Usando mock.');
    const concluida = validarConclusaoSessao(dadosFinalizacao.etapaAtingida);
    return {
      id: sessaoId,
      perfilId: '00000000-0000-0000-0000-000000000001',
      cicloBlocoId: 'b-1',
      topicoId: 't-mat-1',
      iniciadaEm: new Date(Date.now() - 3600 * 1000),
      encerradaEm: dadosFinalizacao.encerradaEm || new Date(),
      segundosEfetivos: dadosFinalizacao.segundosEfetivos ?? 3000,
      segundosPausa: dadosFinalizacao.segundosPausa ?? 0,
      etapaAtingida: dadosFinalizacao.etapaAtingida,
      concluida,
      notaLivre: dadosFinalizacao.notaLivre ?? null,
    };
  }
}

