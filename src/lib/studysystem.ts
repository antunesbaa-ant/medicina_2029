import { type Card, type ReviewLog, State, Rating } from 'ts-fsrs';

// 1. Ponteiro do Ciclo
// Concluir uma sessão avança proxima_ordem em 1; ao passar do último, volta a 1.
export function calcularProximaOrdem(ordemAtual: number, totalBlocos: number): number {
  if (totalBlocos <= 0) return 1;
  const proxima = ordemAtual + 1;
  return proxima > totalBlocos ? 1 : proxima;
}

// 2. Cálculo de Aderência
// sessões concluídas ÷ blocos previstos, janela móvel de 4 semanas
export function calcularAderencia(
  sessoesConcluidas: number,
  blocosPrevistosSemana: number,
  semanas: number = 4
): number {
  const totalPrevisto = blocosPrevistosSemana * semanas;
  if (totalPrevisto <= 0) return 0;
  return (sessoesConcluidas / totalPrevisto) * 100;
}

// 3. Divergência de Trilhos
// % acerto enem − % acerto conteudista, últimas 300 tentativas
export interface TentativaMapeada {
  correta: boolean;
  estilo: 'enem' | 'conteudista' | 'misto';
}

export function calcularDivergenciaTrilhos(tentativas: TentativaMapeada[]): {
  acertoEnem: number;
  acertoConteudista: number;
  divergencia: number;
  alerta: boolean;
  diagnostico: string;
} {
  const enemTentativas = tentativas.filter(t => t.estilo === 'enem');
  const conteudistaTentativas = tentativas.filter(t => t.estilo === 'conteudista');

  const acertoEnem = enemTentativas.length > 0 
    ? (enemTentativas.filter(t => t.correta).length / enemTentativas.length) * 100 
    : 0;

  const acertoConteudista = conteudistaTentativas.length > 0
    ? (conteudistaTentativas.filter(t => t.correta).length / conteudistaTentativas.length) * 100
    : 0;

  const divergencia = acertoEnem - acertoConteudista;
  const alerta = Math.abs(divergencia) > 15;

  let diagnostico = 'Desempenho equilibrado entre os trilhos.';
  if (divergencia > 15) {
    diagnostico = 'Falta profundidade técnica. Sugere-se aumentar questões conteudistas e revisão de fórmulas/definições.';
  } else if (divergencia < -15) {
    diagnostico = 'Falta repertório interpretativo. Sugere-se aumentar leitura e prática de questões contextualizadas.';
  }

  return {
    acertoEnem: Math.round(acertoEnem * 10) / 10,
    acertoConteudista: Math.round(acertoConteudista * 10) / 10,
    divergencia: Math.round(divergencia * 10) / 10,
    alerta,
    diagnostico
  };
}

// 4. Agendamento FSRS
// ts-fsrs helper
export function obterEstadoFSRS(estado: string): State {
  switch (estado.toLowerCase()) {
    case 'new': return State.New;
    case 'learning': return State.Learning;
    case 'review': return State.Review;
    case 'relearning': return State.Relearning;
    default: return State.New;
  }
}

export function obterRatingFSRS(rating: string): Rating {
  switch (rating.toLowerCase()) {
    case 'again': return Rating.Again;
    case 'hard': return Rating.Hard;
    case 'good': return Rating.Good;
    case 'easy': return Rating.Easy;
    default: return Rating.Good;
  }
}

// 5. Travas de Simulado
// - Simulado sem analise concluída não entra na média e é marcado como pendente.
// - Não permite registrar novo simulado se houver análise pendente.
export interface SimuladoComAnalise {
  id: string;
  analiseConcluida: boolean;
  notaTotal?: number;
}

export function verificarPendenteSimulado(simulados: SimuladoComAnalise[]): boolean {
  return simulados.some(s => !s.analiseConcluida);
}

export function calcularMediaSimulados(simulados: SimuladoComAnalise[]): number {
  const simuladosValidos = simulados.filter(s => s.analiseConcluida && s.notaTotal !== undefined);
  if (simuladosValidos.length === 0) return 0;
  const soma = simuladosValidos.reduce((acc, curr) => acc + (curr.notaTotal || 0), 0);
  return soma / simuladosValidos.length;
}

// 6. Trava de Etapa de Registro
// O registro não pode ser pulado. Se a sessão for encerrada antes da etapa de 'registro', 
// concluída = false e a etapa_atingida final é salva para fins estatísticos.
export function validarConclusaoSessao(etapaAtingida: 'revisao' | 'conteudo' | 'questoes' | 'registro'): boolean {
  return etapaAtingida === 'registro';
}

// 7. Regra de Bloqueio de Artefato Sem Citação
// Todo artefato gerado deve citar os chunk_ids que o fundamentam. Sem citação, é rejeitado antes da curadoria.
export function validarFonteArtefato(fonteChunkIds: string[] | null | undefined): boolean {
  if (!fonteChunkIds || !Array.isArray(fonteChunkIds)) return false;
  return fonteChunkIds.length > 0;
}
