'use server';

import { db } from '../../db';
import { redacoes, generos, repertorios } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';
import { requireRole } from '../../lib/authorization';

export interface RegistrarRedacaoInput {
  formato: 'enem' | 'genero_uece';
  generoId?: string;
  tema: string;
  texto: string;
  minutosGastos: number;
}

export interface RegistrarRepertorioInput {
  referencia: string;
  resumo2Linhas: string;
  temasAplicaveis: string[];
  categoria: string;
}

// 1. Obter todos os Gêneros UECE cadastrados
export async function obterGenerosUECE() {
  await requireRole('estudante');

  try {
    const list = await db.select().from(generos);
    
    // Se a base estiver vazia, retorna mocks com fichas completas exigidas
    if (list.length === 0) {
      return [
        {
          id: 'mock-genero-1',
          nome: 'Carta de Solicitação',
          finalidade: 'Solicitar uma providência ou solução para um problema social.',
          interlocutor: 'Uma autoridade pública competente.',
          estrutura: 'Cabeçalho (local e data), vocativo formal, corpo da carta (solicitação + justificativa), fechamento e assinatura (geralmente pseudônimo).',
          marcasLinguagem: 'Padrão formal, clareza, verbos no imperativo ou subjuntivo, tom respeitoso porém firme.',
          erroQueDescaracteriza: 'Identificação real do candidato, ausência de fórmula de tratamento inicial, ou falta de solicitação explícita.',
          fichaCompleta: true
        },
        {
          id: 'mock-genero-2',
          nome: 'Crônica Narrativa',
          finalidade: 'Refletir liricamente ou com ironia sobre um fato do cotidiano.',
          interlocutor: 'Leitor comum de jornais ou revistas.',
          estrutura: 'Narrativa curta com poucos personagens, tempo cronológico restrito, foco em um único incidente/cena do dia a dia.',
          marcasLinguagem: 'Linguagem coloquial bem estruturada, tom intimista, uso de metáforas, subjetividade.',
          erroQueDescaracteriza: 'Dissertar abstratamente sem contar a crônica ou criar narrativa longa e complexa.',
          fichaCompleta: true
        }
      ];
    }

    return list;
  } catch (error) {
    console.error('Erro ao buscar gêneros:', error);
    return [];
  }
}

// 2. Obter Repertório cadastrado
export async function obterRepertorios() {
  const perfil = await requireRole('estudante');

  try {
    const list = await db
      .select()
      .from(repertorios)
      .where(eq(repertorios.perfilId, perfil.id))
      .orderBy(desc(repertorios.criadoEm));

    if (list.length === 0) {
      return [
        {
          id: 'mock-rep-1',
          referencia: 'Zygmunt Bauman — Modernidade Líquida',
          resumo2Linhas: 'As relações sociais e instituições humanas tornaram-se frágeis e fluidas, imperando o individualismo e o consumo sobre os vínculos comunitários estáveis.',
          temasAplicaveis: ['Tecnologia', 'Consumo', 'Relações Sociais', 'Saúde Mental'],
          categoria: 'Sociologia',
          criadoEm: new Date()
        },
        {
          id: 'mock-rep-2',
          referencia: 'Constituição Federal de 1988 — Artigo 196',
          resumo2Linhas: 'A saúde é direito de todos e dever do Estado, garantido mediante políticas sociais e econômicas que visem à redução do risco de doença e ao acesso universal.',
          temasAplicaveis: ['Saúde Pública', 'Direitos Sociais', 'Acesso à Saúde'],
          categoria: 'Legislação',
          criadoEm: new Date()
        }
      ];
    }

    return list;
  } catch (error) {
    console.error('Erro ao buscar repertórios:', error);
    return [];
  }
}

// 3. Obter redações escritas pela estudante
export async function obterRedacoes() {
  const perfil = await requireRole('estudante');

  try {
    const list = await db
      .select({
        id: redacoes.id,
        formato: redacoes.formato,
        tema: redacoes.tema,
        texto: redacoes.texto,
        minutosGastos: redacoes.minutosGastos,
        notaTotal: redacoes.notaTotal,
        escritaEm: redacoes.escritaEm,
        generoNome: generos.nome
      })
      .from(redacoes)
      .leftJoin(generos, eq(redacoes.generoId, generos.id))
      .where(eq(redacoes.perfilId, perfil.id))
      .orderBy(desc(redacoes.escritaEm));

    return list;
  } catch (error) {
    console.error('Erro ao buscar redações:', error);
    return [];
  }
}

// 4. Registrar nova Redação
export async function registrarRedacao(dados: RegistrarRedacaoInput): Promise<{ sucesso: boolean; mensagem: string; redacaoId?: string }> {
  const perfil = await requireRole('estudante');

  try {
    const [nova] = await db
      .insert(redacoes)
      .values({
        perfilId: perfil.id,
        formato: dados.formato,
        generoId: dados.generoId || null,
        tema: dados.tema,
        texto: dados.texto,
        minutosGastos: dados.minutosGastos,
        escritaEm: new Date(),
        notaTotal: 920 // Simulação de nota preliminar para demonstração
      })
      .returning();

    return {
      sucesso: true,
      mensagem: 'Redação registrada com sucesso no painel de acompanhamento.',
      redacaoId: nova.id
    };
  } catch (error) {
    console.error('Erro ao registrar redação:', error);
    return { sucesso: false, mensagem: 'Erro ao salvar redação.' };
  }
}

// 5. Registrar Repertório Sociocultural
export async function registrarRepertorio(dados: RegistrarRepertorioInput): Promise<{ sucesso: boolean; mensagem: string }> {
  const perfil = await requireRole('estudante');

  try {
    await db.insert(repertorios).values({
      perfilId: perfil.id,
      referencia: dados.referencia,
      resumo2Linhas: dados.resumo2Linhas,
      temasAplicaveis: dados.temasAplicaveis,
      categoria: dados.categoria
    });

    return { sucesso: true, mensagem: 'Repertório sociocultural adicionado à sua base de consulta.' };
  } catch (error) {
    console.error('Erro ao registrar repertório:', error);
    return { sucesso: false, mensagem: 'Erro ao salvar repertório.' };
  }
}
