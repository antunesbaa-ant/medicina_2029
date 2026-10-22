'use server';

import { db } from '../../db';
import {
  ciclos,
  cicloBlocos,
  cicloEstado,
  disciplinas,
  sessoes,
  topicos,
} from '../../db/schema';
import { and, asc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  requireAuthenticatedProfile,
  requireManagedStudentProfile,
  requireRole,
  requireStudentScope,
} from '../../lib/authorization';
import { PublicOperationError, logOperationalFailure } from '../../lib/operation-result';
import { calcularProximaOrdem } from '../../lib/studysystem';
import { atualizarPonteiroCicloInputSchema, v } from '../../lib/validation';
import { applyRlsContext } from '../../db/rls-context';

export interface CicloAtivoData {
  ciclo: typeof ciclos.$inferSelect;
  blocos: Array<
    typeof cicloBlocos.$inferSelect & {
      disciplina: typeof disciplinas.$inferSelect;
    }
  >;
  proximaOrdem: number;
}

export interface ProgressoSemanalCicloData {
  concluidosSemana: number;
  sessaoAbertaId: string | null;
}

export interface ResultadoAtualizacaoPonteiroCiclo {
  cicloId: string;
  proximaOrdem: number;
  totalBlocos: number;
  reconciliado: boolean;
}

export async function obterCicloAtivo(): Promise<CicloAtivoData | null> {
  const estudante = await requireStudentScope();

  try {
    // 1. Busca o ciclo ativo persistido no PostgreSQL (sem fallback para mocks)
    const [cicloAtivo] = await db
      .select()
      .from(ciclos)
      .where(and(eq(ciclos.ativo, true), eq(ciclos.estudantePerfilId, estudante.id)))
      .limit(1);

    if (!cicloAtivo) {
      return null;
    }

    // 2. Busca os blocos vinculados ordenados por ordem com as disciplinas correspondentes
    const blocos = await db
      .select({
        id: cicloBlocos.id,
        cicloId: cicloBlocos.cicloId,
        ordem: cicloBlocos.ordem,
        disciplinaId: cicloBlocos.disciplinaId,
        tipo: cicloBlocos.tipo,
        estiloAlvo: cicloBlocos.estiloAlvo,
        duracaoMin: cicloBlocos.duracaoMin,
        disciplina: disciplinas,
      })
      .from(cicloBlocos)
      .where(eq(cicloBlocos.cicloId, cicloAtivo.id))
      .innerJoin(disciplinas, eq(cicloBlocos.disciplinaId, disciplinas.id))
      .orderBy(asc(cicloBlocos.ordem));

    // 3. Busca o estado persistido do ciclo (proxima_ordem)
    const [estado] = await db
      .select()
      .from(cicloEstado)
      .where(eq(cicloEstado.cicloId, cicloAtivo.id))
      .limit(1);

    const ordemBruta = estado ? estado.proximaOrdem : 1;
    const proximaOrdem =
      blocos.length > 0 && (ordemBruta < 1 || ordemBruta > blocos.length) ? 1 : ordemBruta;

    return {
      ciclo: cicloAtivo,
      blocos,
      proximaOrdem,
    };
  } catch (error) {
    if (error instanceof PublicOperationError) throw error;
    logOperationalFailure('ciclo.obter_ativo', 'persistence');
    throw new PublicOperationError(
      'PERSISTENCE_ERROR',
      'Não foi possível sincronizar o ciclo ativo com o servidor.'
    );
  }
}

export async function obterTopicosPorDisciplina(
  disciplinaId: string
): Promise<Array<typeof topicos.$inferSelect>> {
  await requireAuthenticatedProfile();
  const disciplinaIdValido = v.uuid('ID da disciplina').parse(disciplinaId);

  try {
    return await db
      .select()
      .from(topicos)
      .where(eq(topicos.disciplinaId, disciplinaIdValido))
      .orderBy(asc(topicos.ordem));
  } catch (error) {
    if (error instanceof PublicOperationError) throw error;
    logOperationalFailure('ciclo.topicos_por_disciplina', 'persistence');
    throw new PublicOperationError(
      'PERSISTENCE_ERROR',
      'Não foi possível carregar os tópicos da disciplina.'
    );
  }
}

export async function obterProgressoSemanalCiclo(): Promise<ProgressoSemanalCicloData> {
  const estudante = await requireStudentScope();

  try {
    const seteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const sessoesConcluidasRecentes = await db
      .select({ id: sessoes.id })
      .from(sessoes)
      .where(
        and(
          eq(sessoes.perfilId, estudante.id),
          eq(sessoes.concluida, true),
          gte(sessoes.encerradaEm, seteDiasAtras)
        )
      );

    const [sessaoAberta] = await db
      .select({ id: sessoes.id })
      .from(sessoes)
      .where(and(eq(sessoes.perfilId, estudante.id), isNull(sessoes.encerradaEm)))
      .limit(1);

    return {
      concluidosSemana: sessoesConcluidasRecentes.length,
      sessaoAbertaId: sessaoAberta?.id ?? null,
    };
  } catch (error) {
    if (error instanceof PublicOperationError) throw error;
    logOperationalFailure('ciclo.progresso_semanal', 'persistence');
    throw new PublicOperationError(
      'PERSISTENCE_ERROR',
      'Não foi possível carregar o progresso semanal confirmado no banco.'
    );
  }
}

export async function atualizarPonteiroCiclo(
  cicloId: string,
  acao: 'avancar' | 'retroceder' | 'reiniciar' | 'definir',
  opcoes?: { ordemEsperada?: number; ordemAlvo?: number }
): Promise<ResultadoAtualizacaoPonteiroCiclo> {
  const perfil = await requireRole('estudante');
  const validado = atualizarPonteiroCicloInputSchema.parse({
    cicloId,
    acao,
    ...(opcoes ?? {}),
  });

  try {
    return await db.transaction(async (tx) => {
      await applyRlsContext(tx, perfil.id, perfil.papel);

      // Serializa atualizações concorrentes de ponteiro do mesmo ciclo (clique duplo / multiaba)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${validado.cicloId}::text, 0));`
      );

      const [cicloAlvo] = await tx
        .select({
          id: ciclos.id,
          ativo: ciclos.ativo,
          estudantePerfilId: ciclos.estudantePerfilId,
        })
        .from(ciclos)
        .where(
          and(
            eq(ciclos.id, validado.cicloId),
            eq(ciclos.ativo, true),
            or(eq(ciclos.estudantePerfilId, perfil.id), isNull(ciclos.estudantePerfilId))
          )
        )
        .limit(1);

      if (
        !cicloAlvo ||
        (cicloAlvo.estudantePerfilId && cicloAlvo.estudantePerfilId !== perfil.id)
      ) {
        throw new PublicOperationError(
          'NOT_FOUND',
          'Ciclo ativo não encontrado ou acesso não permitido.'
        );
      }

      const blocosDoCiclo = await tx
        .select({ id: cicloBlocos.id, ordem: cicloBlocos.ordem })
        .from(cicloBlocos)
        .where(eq(cicloBlocos.cicloId, validado.cicloId))
        .orderBy(asc(cicloBlocos.ordem));

      const totalBlocos = blocosDoCiclo.length;
      if (totalBlocos <= 0) {
        throw new PublicOperationError(
          'VALIDATION_ERROR',
          'O ciclo ativo não possui blocos configurados.'
        );
      }

      const [estadoAtualRow] = await tx
        .select({ proximaOrdem: cicloEstado.proximaOrdem })
        .from(cicloEstado)
        .where(eq(cicloEstado.cicloId, validado.cicloId))
        .limit(1);

      const ordemAtualBruta = estadoAtualRow?.proximaOrdem ?? 1;
      const ordemAtual =
        ordemAtualBruta < 1 || ordemAtualBruta > totalBlocos ? 1 : ordemAtualBruta;

      // Se a aba partiu de uma ordemEsperada já superada por outra aba/dispositivo,
      // converge para a ordem persistida no servidor sem aplicar deslocamento duplicado.
      if (validado.ordemEsperada !== undefined && validado.ordemEsperada !== ordemAtual) {
        return {
          cicloId: validado.cicloId,
          proximaOrdem: ordemAtual,
          totalBlocos,
          reconciliado: true,
        };
      }

      let novaOrdem: number;
      switch (validado.acao) {
        case 'reiniciar':
          novaOrdem = 1;
          break;
        case 'avancar':
          novaOrdem = calcularProximaOrdem(ordemAtual, totalBlocos);
          break;
        case 'retroceder':
          novaOrdem = ordemAtual <= 1 ? totalBlocos : ordemAtual - 1;
          break;
        case 'definir': {
          const alvo = validado.ordemAlvo!;
          if (alvo < 1 || alvo > totalBlocos) {
            throw new PublicOperationError(
              'VALIDATION_ERROR',
              `A ordem do bloco deve estar entre 1 e ${totalBlocos}.`
            );
          }
          novaOrdem = alvo;
          break;
        }
      }

      const [ponteiroPersistido] = await tx
        .insert(cicloEstado)
        .values({ cicloId: validado.cicloId, proximaOrdem: novaOrdem })
        .onConflictDoUpdate({
          target: cicloEstado.cicloId,
          set: { proximaOrdem: novaOrdem },
        })
        .returning({
          cicloId: cicloEstado.cicloId,
          proximaOrdem: cicloEstado.proximaOrdem,
        });

      if (!ponteiroPersistido) {
        logOperationalFailure('ciclo.ponteiro_without_returning', 'persistence');
        throw new PublicOperationError(
          'PERSISTENCE_ERROR',
          'Não foi possível confirmar a atualização do ponteiro do ciclo.'
        );
      }

      return {
        cicloId: ponteiroPersistido.cicloId,
        proximaOrdem: ponteiroPersistido.proximaOrdem,
        totalBlocos,
        reconciliado: false,
      };
    });
  } catch (error) {
    if (error instanceof PublicOperationError) throw error;
    logOperationalFailure('ciclo.atualizar_ponteiro', 'persistence');
    throw new PublicOperationError(
      'PERSISTENCE_ERROR',
      'Não foi possível atualizar o ponteiro do ciclo.'
    );
  }
}

export async function iniciarCicloEstudos(): Promise<{
  sucesso: boolean;
  mensagem: string;
  cicloId?: string;
}> {
  const estudante = await requireManagedStudentProfile();

  try {
    return await db.transaction(async (tx) => {
      await applyRlsContext(tx, estudante.id, estudante.papel);

      // 1. Set all existing cycles to active=false
      await tx
        .update(ciclos)
        .set({ ativo: false })
        .where(eq(ciclos.estudantePerfilId, estudante.id));

      // 2. Create a new active cycle
      const [novoCiclo] = await tx
        .insert(ciclos)
        .values({
          nome: 'Ciclo Principal - 2027',
          anoLetivo: 2027,
          ativo: true,
          estudantePerfilId: estudante.id,
          blocosPrevistosSemana: 28,
          criadoEm: new Date(),
        })
        .returning();

      if (!novoCiclo) {
        throw new Error('Não foi possível criar o novo ciclo.');
      }

      // 3. Fetch all disciplines to map their IDs
      const listDisciplinas = await tx.select().from(disciplinas);

      if (listDisciplinas.length === 0) {
        throw new Error('Nenhuma disciplina cadastrada no banco de dados para criar os blocos.');
      }

      // Helper function to map discipline name to its ID in db
      const obterDisciplinaId = (nome: string): string => {
        const nomeNorm = nome
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        for (const d of listDisciplinas) {
          const dbNomeNorm = d.nome
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
          if (dbNomeNorm === nomeNorm) {
            return d.id;
          }
        }
        return listDisciplinas[0].id;
      };

      // 4. Balanced 28 study blocks curriculum (at least 50% question-solving / error revision)
      const blocosConfig = [
        { nomeDisc: 'Matemática', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Biologia', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Redação', tipo: 'redacao' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Química', tipo: 'conteudo' as const, estiloAlvo: 'conteudista' as const, duracaoMin: 50 },
        { nomeDisc: 'Matemática', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Física', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Linguagens', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Química', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Matemática', tipo: 'caderno_erros' as const, estiloAlvo: 'misto' as const, duracaoMin: 50 },
        { nomeDisc: 'Biologia', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'História', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Língua Estrangeira', tipo: 'lingua_estrangeira' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Física', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Geografia', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Matemática', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Biologia', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Filosofia', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Química', tipo: 'questoes' as const, estiloAlvo: 'conteudista' as const, duracaoMin: 50 },
        { nomeDisc: 'Física', tipo: 'questoes' as const, estiloAlvo: 'conteudista' as const, duracaoMin: 50 },
        { nomeDisc: 'Redação', tipo: 'redacao' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Sociologia', tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Matemática', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Biologia', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Linguagens', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Química', tipo: 'caderno_erros' as const, estiloAlvo: 'misto' as const, duracaoMin: 50 },
        { nomeDisc: 'Física', tipo: 'caderno_erros' as const, estiloAlvo: 'misto' as const, duracaoMin: 50 },
        { nomeDisc: 'História', tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50 },
        { nomeDisc: 'Matemática', tipo: 'revisao_srs' as const, estiloAlvo: 'misto' as const, duracaoMin: 50 },
      ];

      // 5. Populate cicloBlocos
      for (let i = 0; i < blocosConfig.length; i++) {
        const config = blocosConfig[i];
        const disciplinaId = obterDisciplinaId(config.nomeDisc);
        await tx.insert(cicloBlocos).values({
          cicloId: novoCiclo.id,
          ordem: i + 1,
          disciplinaId,
          tipo: config.tipo,
          estiloAlvo: config.estiloAlvo,
          duracaoMin: config.duracaoMin,
        });
      }

      // 6. Insert cicloEstado starting at proximaOrdem = 1
      await tx.insert(cicloEstado).values({
        cicloId: novoCiclo.id,
        proximaOrdem: 1,
      });

      return {
        sucesso: true,
        mensagem: 'Novo ciclo de estudos ativo e fila com 28 blocos configurada com sucesso!',
        cicloId: novoCiclo.id,
      };
    });
  } catch (error) {
    console.error('Erro ao iniciar ciclo de estudos:', error);
    return {
      sucesso: false,
      mensagem: 'Erro interno ao iniciar ciclo de estudos.',
    };
  }
}

export async function resetarPlanejamento(): Promise<{ sucesso: boolean; mensagem: string }> {
  const estudante = await requireManagedStudentProfile();

  try {
    return await db.transaction(async (tx) => {
      await applyRlsContext(tx, estudante.id, estudante.papel);

      const ciclosDaEstudante = await tx
        .select({ id: ciclos.id })
        .from(ciclos)
        .where(eq(ciclos.estudantePerfilId, estudante.id));

      // 1. Set all student cycles to active=false
      await tx
        .update(ciclos)
        .set({ ativo: false })
        .where(eq(ciclos.estudantePerfilId, estudante.id));

      // 2. Delete/clear only state entries inherited from this student's cycles
      if (ciclosDaEstudante.length > 0) {
        await tx
          .delete(cicloEstado)
          .where(inArray(cicloEstado.cicloId, ciclosDaEstudante.map((ciclo) => ciclo.id)));
      }

      return {
        sucesso: true,
        mensagem: 'Planejamento resetado com sucesso. Nenhum ciclo está ativo.',
      };
    });
  } catch (error) {
    console.error('Erro ao resetar planejamento:', error);
    return {
      sucesso: false,
      mensagem: 'Erro interno ao resetar planejamento.',
    };
  }
}
