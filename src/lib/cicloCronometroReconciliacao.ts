/**
 * F1.14 — Reconciliação determinística e máquina de estados server-side
 * do Ciclo e do Cronômetro de Estudo.
 *
 * Princípios:
 * 1. O PostgreSQL é a única fonte definitiva de verdade para sessões e ponteiro do ciclo.
 * 2. O cache local (localStorage) funciona exclusivamente como dica auxiliar da aba
 *    atual (ex.: se o cronômetro estava rodando ou pausado e o tempo restante na etapa),
 *    nunca podendo ressuscitar sessões encerradas, regredir etapas avançadas em outro
 *    dispositivo/aba ou inventar tempo estudado acima do limite físico da sessão.
 */

export type EtapaPedagogicaSessao = 'revisao' | 'conteudo' | 'questoes' | 'registro';
export type EtapaCronometroUI = EtapaPedagogicaSessao | 'pausa';

export type StatusSessaoCronometro =
  | 'nao_iniciada'
  | 'em_andamento'
  | 'pausada'
  | 'concluida'
  | 'falha_sincronizacao';

export const TEMPO_ETAPAS: Record<EtapaPedagogicaSessao, number> = {
  revisao: 5 * 60, // 300s (5 min)
  conteudo: 28 * 60, // 1680s (28 min)
  questoes: 15 * 60, // 900s (15 min)
  registro: 2 * 60, // 120s (2 min)
};

export const TEMPO_PAUSA = 10 * 60; // 600s (10 min)

export const ORDEM_ETAPAS: Record<EtapaPedagogicaSessao, number> = {
  revisao: 0,
  conteudo: 1,
  questoes: 2,
  registro: 3,
};

export const LISTA_ETAPAS_PEDAGOGICAS: readonly EtapaPedagogicaSessao[] = [
  'revisao',
  'conteudo',
  'questoes',
  'registro',
] as const;

export interface CacheLocalCronometro {
  sessaoId: string;
  blocoId: string;
  topicoId: string;
  disciplinaNome: string;
  topicoNome: string;
  etapaAtual: EtapaCronometroUI;
  tempoRestante: number;
  estaRodando: boolean;
  segundosEfetivos: number;
  segundosPausa: number;
  timestampUltimoTick: number;
}

export interface SessaoHidratadaServidor {
  id: string;
  cicloBlocoId: string;
  topicoId: string;
  disciplinaId: string;
  disciplinaNome: string;
  topicoNome: string;
  iniciadaEm: Date | string;
  encerradaEm: Date | string | null;
  etapaAtingida: EtapaPedagogicaSessao;
  segundosEfetivos: number;
  segundosPausa: number;
  concluida: boolean;
  notaLivre: string | null;
}

export interface BlocoSugeridoServidor {
  blocoId: string;
  cicloId: string;
  ordem: number;
  disciplinaId: string;
  disciplinaNome: string;
  topicoId: string;
  topicoNome: string;
}

export interface EstadoServidorCronometro {
  statusSessao: Exclude<StatusSessaoCronometro, 'falha_sincronizacao'>;
  sessao: SessaoHidratadaServidor | null;
  blocoSugerido: BlocoSugeridoServidor | null;
  proximaOrdemCiclo: number;
  serverTimestampMs: number;
}

export interface ResultadoReconciliacaoCronometro {
  statusSessao: StatusSessaoCronometro;
  sessaoId: string;
  blocoId: string;
  topicoId: string;
  disciplinaNome: string;
  topicoNome: string;
  etapa: EtapaCronometroUI;
  tempoRestante: number;
  estaRodando: boolean;
  segundosEfetivos: number;
  segundosPausa: number;
  notaLivre: string;
  cacheLocalDescartado: boolean;
  motivoDescarteCache?:
    | 'SESSAO_ENCERRADA_NO_SERVIDOR'
    | 'SESSAO_DIVERGENTE'
    | 'ETAPA_SERVIDOR_MAIS_AVANCADA'
    | 'SEM_SESSAO_ATIVA';
  requerCheckpointServidor: boolean;
}

export function compararEtapasSessao(
  a: EtapaPedagogicaSessao,
  b: EtapaPedagogicaSessao
): number {
  return ORDEM_ETAPAS[a] - ORDEM_ETAPAS[b];
}

export function etapaMaisAvancada(
  a: EtapaPedagogicaSessao,
  b: EtapaPedagogicaSessao
): EtapaPedagogicaSessao {
  return compararEtapasSessao(a, b) >= 0 ? a : b;
}

export function obterProximaEtapaPedagogica(
  atual: EtapaPedagogicaSessao
): EtapaPedagogicaSessao | 'concluir' {
  switch (atual) {
    case 'revisao':
      return 'conteudo';
    case 'conteudo':
      return 'questoes';
    case 'questoes':
      return 'registro';
    case 'registro':
      return 'concluir';
  }
}

/**
 * Calcula a soma nominal de segundos das etapas anteriores à etapa informada.
 */
export function calcularSegundosAcumuladosEtapasAnteriores(
  etapa: EtapaPedagogicaSessao
): number {
  let soma = 0;
  for (const item of LISTA_ETAPAS_PEDAGOGICAS) {
    if (item === etapa) break;
    soma += TEMPO_ETAPAS[item];
  }
  return soma;
}

/**
 * Estima o tempo restante na etapa atual com base nos segundos efetivos já
 * persistidos no servidor quando não há cache local válido (ex.: novo dispositivo
 * ou navegador limpo).
 */
export function calcularTempoRestanteEtapaServidor(
  etapa: EtapaPedagogicaSessao,
  segundosEfetivosServidor: number
): number {
  const duracaoEtapa = TEMPO_ETAPAS[etapa];
  const acumuladosAnteriores = calcularSegundosAcumuladosEtapasAnteriores(etapa);
  const segundosNaEtapaAtual = Math.max(0, segundosEfetivosServidor - acumuladosAnteriores);
  if (segundosNaEtapaAtual >= duracaoEtapa) {
    return duracaoEtapa;
  }
  return Math.max(1, duracaoEtapa - segundosNaEtapaAtual);
}

/**
 * Calcula o limite físico máximo de segundos que poderiam ter decorrido desde
 * `iniciada_em` no servidor, impedindo que clock drift ou adulteração de
 * localStorage inventem mais tempo estudado do que a duração real da sessão.
 */
export function calcularTetoSegundosDecorridosServidor(
  iniciadaEm: Date | string,
  agoraMs: number
): number {
  const inicioMs = new Date(iniciadaEm).getTime();
  if (Number.isNaN(inicioMs)) return 86_400;
  // Tolerância de 5s para pequenas diferenças de relógio
  const decorridoSegundos = Math.floor(Math.max(0, agoraMs - inicioMs) / 1000) + 5;
  return Math.min(86_400, Math.max(0, decorridoSegundos));
}

/**
 * Reconcilia o estado retornado pelo PostgreSQL com o cache local do navegador.
 * O servidor tem autoridade absoluta sobre existência, encerramento, ownership,
 * bloco/tópico e etapa mínima atingida.
 */
export function reconciliarEstadoCronometroComServidor(params: {
  servidor: EstadoServidorCronometro;
  cacheLocal: CacheLocalCronometro | null;
  agoraMs?: number;
}): ResultadoReconciliacaoCronometro {
  const { servidor, cacheLocal } = params;
  const agoraMs = params.agoraMs ?? servidor.serverTimestampMs ?? Date.now();

  // 1. Se a sessão consultada já consta encerrada no servidor:
  //    descarta o cache local desatualizado imediatamente.
  if (servidor.statusSessao === 'concluida' && servidor.sessao) {
    const s = servidor.sessao;
    return {
      statusSessao: 'concluida',
      sessaoId: s.id,
      blocoId: s.cicloBlocoId,
      topicoId: s.topicoId,
      disciplinaNome: s.disciplinaNome,
      topicoNome: s.topicoNome,
      etapa: s.concluida ? 'pausa' : s.etapaAtingida,
      tempoRestante: 0,
      estaRodando: false,
      segundosEfetivos: s.segundosEfetivos,
      segundosPausa: s.segundosPausa,
      notaLivre: s.notaLivre ?? '',
      cacheLocalDescartado: cacheLocal !== null,
      motivoDescarteCache: cacheLocal ? 'SESSAO_ENCERRADA_NO_SERVIDOR' : undefined,
      requerCheckpointServidor: false,
    };
  }

  // 2. Se não há sessão aberta no servidor (`nao_iniciada`):
  //    qualquer sessão ativa no cache local é fantasma/desatualizada e deve ser descartada.
  if (servidor.statusSessao === 'nao_iniciada' || !servidor.sessao) {
    const sugerido = servidor.blocoSugerido;
    return {
      statusSessao: 'nao_iniciada',
      sessaoId: '',
      blocoId: sugerido?.blocoId ?? '',
      topicoId: sugerido?.topicoId ?? '',
      disciplinaNome: sugerido?.disciplinaNome ?? 'Estudo',
      topicoNome: sugerido?.topicoNome ?? 'Tópico Geral',
      etapa: 'revisao',
      tempoRestante: TEMPO_ETAPAS.revisao,
      estaRodando: false,
      segundosEfetivos: 0,
      segundosPausa: 0,
      notaLivre: '',
      cacheLocalDescartado: cacheLocal !== null,
      motivoDescarteCache: cacheLocal ? 'SEM_SESSAO_ATIVA' : undefined,
      requerCheckpointServidor: false,
    };
  }

  // 3. Há uma sessão aberta confirmada no PostgreSQL (`encerrada_em IS NULL`).
  const s = servidor.sessao;
  const tetoSegundosSessao = calcularTetoSegundosDecorridosServidor(s.iniciadaEm, agoraMs);

  // 3a. Não há cache local ou o cache local pertence a outra sessão:
  //     hidrata 100% a partir do estado persistido no PostgreSQL em modo pausado seguro.
  if (!cacheLocal || cacheLocal.sessaoId !== s.id) {
    const tempoRestanteServidor = calcularTempoRestanteEtapaServidor(
      s.etapaAtingida,
      s.segundosEfetivos
    );
    return {
      statusSessao: 'pausada',
      sessaoId: s.id,
      blocoId: s.cicloBlocoId,
      topicoId: s.topicoId,
      disciplinaNome: s.disciplinaNome,
      topicoNome: s.topicoNome,
      etapa: s.etapaAtingida,
      tempoRestante: tempoRestanteServidor,
      estaRodando: false,
      segundosEfetivos: s.segundosEfetivos,
      segundosPausa: s.segundosPausa,
      notaLivre: s.notaLivre ?? '',
      cacheLocalDescartado: cacheLocal !== null,
      motivoDescarteCache: cacheLocal ? 'SESSAO_DIVERGENTE' : undefined,
      requerCheckpointServidor: false,
    };
  }

  // 3b. O cache local é da mesma sessão, mas está em 'pausa' (intervalo pós-conclusão)
  //     enquanto no servidor a sessão ainda está aberta, OU o servidor está em uma
  //     etapa pedagógica mais avançada que o cache local (avanço ocorrido em outro dispositivo/aba).
  if (
    cacheLocal.etapaAtual === 'pausa' ||
    compararEtapasSessao(s.etapaAtingida, cacheLocal.etapaAtual) > 0
  ) {
    const tempoRestanteServidor = calcularTempoRestanteEtapaServidor(
      s.etapaAtingida,
      s.segundosEfetivos
    );
    return {
      statusSessao: 'pausada',
      sessaoId: s.id,
      blocoId: s.cicloBlocoId,
      topicoId: s.topicoId,
      disciplinaNome: s.disciplinaNome,
      topicoNome: s.topicoNome,
      etapa: s.etapaAtingida,
      tempoRestante: tempoRestanteServidor,
      estaRodando: false,
      segundosEfetivos: s.segundosEfetivos,
      segundosPausa: s.segundosPausa,
      notaLivre: s.notaLivre ?? '',
      cacheLocalDescartado: true,
      motivoDescarteCache: 'ETAPA_SERVIDOR_MAIS_AVANCADA',
      requerCheckpointServidor: false,
    };
  }

  // 3c. Cache local da mesma sessão e na mesma etapa (ou etapa compatível):
  //     calcula o tempo decorrido na aba se estava rodando, respeitando o teto físico
  //     da sessão no servidor e a duração máxima da etapa.
  const etapaReconciliada = etapaMaisAvancada(s.etapaAtingida, cacheLocal.etapaAtual);
  const duracaoEtapa = TEMPO_ETAPAS[etapaReconciliada];
  const tempoRestanteBase = Math.max(0, Math.min(duracaoEtapa, cacheLocal.tempoRestante));

  let novoTempoRestante = tempoRestanteBase;
  let novosSegundosEfetivos = Math.max(s.segundosEfetivos, cacheLocal.segundosEfetivos);
  let novosSegundosPausa = Math.max(s.segundosPausa, cacheLocal.segundosPausa);

  if (cacheLocal.estaRodando && cacheLocal.timestampUltimoTick > 0) {
    const segundosPassados = Math.max(
      0,
      Math.floor((agoraMs - cacheLocal.timestampUltimoTick) / 1000)
    );
    const incrementoEtapa = Math.min(tempoRestanteBase, segundosPassados);
    novoTempoRestante = Math.max(0, tempoRestanteBase - incrementoEtapa);
    novosSegundosEfetivos = novosSegundosEfetivos + incrementoEtapa;
  }

  // Nunca permite que os segundos efetivos ultrapassem o tempo físico real desde iniciada_em no banco
  novosSegundosEfetivos = Math.max(
    s.segundosEfetivos,
    Math.min(tetoSegundosSessao, novosSegundosEfetivos)
  );
  novosSegundosPausa = Math.max(
    s.segundosPausa,
    Math.min(tetoSegundosSessao, novosSegundosPausa)
  );

  const estaRodando = Boolean(cacheLocal.estaRodando && novoTempoRestante > 0);
  const requerCheckpointServidor =
    novosSegundosEfetivos > s.segundosEfetivos ||
    novosSegundosPausa > s.segundosPausa ||
    compararEtapasSessao(etapaReconciliada, s.etapaAtingida) > 0;

  return {
    statusSessao: estaRodando ? 'em_andamento' : 'pausada',
    sessaoId: s.id,
    blocoId: s.cicloBlocoId,
    topicoId: s.topicoId,
    disciplinaNome: s.disciplinaNome,
    topicoNome: s.topicoNome,
    etapa: etapaReconciliada,
    tempoRestante: novoTempoRestante,
    estaRodando,
    segundosEfetivos: novosSegundosEfetivos,
    segundosPausa: novosSegundosPausa,
    notaLivre: s.notaLivre ?? '',
    cacheLocalDescartado: false,
    requerCheckpointServidor,
  };
}
