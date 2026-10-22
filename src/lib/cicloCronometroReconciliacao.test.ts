import { describe, expect, it } from 'vitest';
import {
  TEMPO_ETAPAS,
  calcularSegundosAcumuladosEtapasAnteriores,
  calcularTempoRestanteEtapaServidor,
  calcularTetoSegundosDecorridosServidor,
  compararEtapasSessao,
  etapaMaisAvancada,
  obterProximaEtapaPedagogica,
  reconciliarEstadoCronometroComServidor,
  type CacheLocalCronometro,
  type EstadoServidorCronometro,
} from './cicloCronometroReconciliacao';

describe('F1.14 — Reconciliação e Máquina de Estados do Cronômetro', () => {
  it('respeita a ordem monotônica das etapas pedagógicas', () => {
    expect(compararEtapasSessao('revisao', 'conteudo')).toBeLessThan(0);
    expect(compararEtapasSessao('conteudo', 'conteudo')).toBe(0);
    expect(compararEtapasSessao('registro', 'questoes')).toBeGreaterThan(0);

    expect(etapaMaisAvancada('revisao', 'conteudo')).toBe('conteudo');
    expect(etapaMaisAvancada('registro', 'conteudo')).toBe('registro');

    expect(obterProximaEtapaPedagogica('revisao')).toBe('conteudo');
    expect(obterProximaEtapaPedagogica('conteudo')).toBe('questoes');
    expect(obterProximaEtapaPedagogica('questoes')).toBe('registro');
    expect(obterProximaEtapaPedagogica('registro')).toBe('concluir');
  });

  it('calcula segundos acumulados e tempo restante nominal na etapa', () => {
    expect(calcularSegundosAcumuladosEtapasAnteriores('revisao')).toBe(0);
    expect(calcularSegundosAcumuladosEtapasAnteriores('conteudo')).toBe(TEMPO_ETAPAS.revisao);
    expect(calcularSegundosAcumuladosEtapasAnteriores('questoes')).toBe(
      TEMPO_ETAPAS.revisao + TEMPO_ETAPAS.conteudo
    );

    // Se acabou de entrar em conteudo com 300s no banco, restam todos os 1680s da etapa
    expect(calcularTempoRestanteEtapaServidor('conteudo', 300)).toBe(TEMPO_ETAPAS.conteudo);
    // Se está em conteudo e já tem 600s no banco (300s da revisao + 300s do conteudo)
    expect(calcularTempoRestanteEtapaServidor('conteudo', 600)).toBe(
      TEMPO_ETAPAS.conteudo - 300
    );
  });

  it('calcula teto físico de segundos decorridos para mitigar drift ou adulteração de localStorage', () => {
    const agora = Date.now();
    const cincoMinAtras = new Date(agora - 5 * 60 * 1000);
    const teto = calcularTetoSegundosDecorridosServidor(cincoMinAtras, agora);
    // 300s + tolerância de 5s
    expect(teto).toBeGreaterThanOrEqual(300);
    expect(teto).toBeLessThanOrEqual(310);
  });

  it('descarta cache local quando a sessão já consta como encerrada no PostgreSQL', () => {
    const servidor: EstadoServidorCronometro = {
      statusSessao: 'concluida',
      sessao: {
        id: '42000000-0000-4000-8000-000000000001',
        cicloBlocoId: '41000000-0000-4000-8000-000000000001',
        topicoId: '31000000-0000-4000-8000-000000000001',
        disciplinaId: '30000000-0000-4000-8000-000000000001',
        disciplinaNome: 'Biologia',
        topicoNome: 'Citologia',
        iniciadaEm: new Date(Date.now() - 3600_000),
        encerradaEm: new Date(Date.now() - 600_000),
        etapaAtingida: 'registro',
        segundosEfetivos: 1800,
        segundosPausa: 100,
        concluida: true,
        notaLivre: 'Concluído na outra aba',
      },
      blocoSugerido: null,
      proximaOrdemCiclo: 2,
      serverTimestampMs: Date.now(),
    };

    const cacheLocalAntigo: CacheLocalCronometro = {
      sessaoId: '42000000-0000-4000-8000-000000000001',
      blocoId: '41000000-0000-4000-8000-000000000001',
      topicoId: '31000000-0000-4000-8000-000000000001',
      disciplinaNome: 'Biologia',
      topicoNome: 'Citologia',
      etapaAtual: 'conteudo',
      tempoRestante: 500,
      estaRodando: true,
      segundosEfetivos: 400,
      segundosPausa: 0,
      timestampUltimoTick: Date.now() - 10_000,
    };

    const res = reconciliarEstadoCronometroComServidor({
      servidor,
      cacheLocal: cacheLocalAntigo,
    });

    expect(res.statusSessao).toBe('concluida');
    expect(res.cacheLocalDescartado).toBe(true);
    expect(res.motivoDescarteCache).toBe('SESSAO_ENCERRADA_NO_SERVIDOR');
    expect(res.estaRodando).toBe(false);
    expect(res.etapa).toBe('pausa');
  });

  it('converge para o servidor quando a etapa do PostgreSQL já foi avançada em outra aba', () => {
    const servidor: EstadoServidorCronometro = {
      statusSessao: 'em_andamento',
      sessao: {
        id: '42000000-0000-4000-8000-000000000001',
        cicloBlocoId: '41000000-0000-4000-8000-000000000001',
        topicoId: '31000000-0000-4000-8000-000000000001',
        disciplinaId: '30000000-0000-4000-8000-000000000001',
        disciplinaNome: 'Biologia',
        topicoNome: 'Citologia',
        iniciadaEm: new Date(Date.now() - 1000_000),
        encerradaEm: null,
        etapaAtingida: 'questoes', // Servidor já em questoes
        segundosEfetivos: 1980,
        segundosPausa: 50,
        concluida: false,
        notaLivre: null,
      },
      blocoSugerido: null,
      proximaOrdemCiclo: 1,
      serverTimestampMs: Date.now(),
    };

    const cacheLocalAtrasado: CacheLocalCronometro = {
      sessaoId: '42000000-0000-4000-8000-000000000001',
      blocoId: '41000000-0000-4000-8000-000000000001',
      topicoId: '31000000-0000-4000-8000-000000000001',
      disciplinaNome: 'Biologia',
      topicoNome: 'Citologia',
      etapaAtual: 'conteudo', // Cache local atrasado em conteudo
      tempoRestante: 600,
      estaRodando: true,
      segundosEfetivos: 800,
      segundosPausa: 0,
      timestampUltimoTick: Date.now() - 5000,
    };

    const res = reconciliarEstadoCronometroComServidor({
      servidor,
      cacheLocal: cacheLocalAtrasado,
    });

    expect(res.etapa).toBe('questoes');
    expect(res.statusSessao).toBe('pausada');
    expect(res.cacheLocalDescartado).toBe(true);
    expect(res.motivoDescarteCache).toBe('ETAPA_SERVIDOR_MAIS_AVANCADA');
  });

  it('hidrata a partir do servidor em modo pausado seguro quando não há cache local', () => {
    const servidor: EstadoServidorCronometro = {
      statusSessao: 'em_andamento',
      sessao: {
        id: '42000000-0000-4000-8000-000000000001',
        cicloBlocoId: '41000000-0000-4000-8000-000000000001',
        topicoId: '31000000-0000-4000-8000-000000000001',
        disciplinaId: '30000000-0000-4000-8000-000000000001',
        disciplinaNome: 'Biologia',
        topicoNome: 'Citologia',
        iniciadaEm: new Date(Date.now() - 400_000),
        encerradaEm: null,
        etapaAtingida: 'conteudo',
        segundosEfetivos: 400,
        segundosPausa: 10,
        concluida: false,
        notaLivre: null,
      },
      blocoSugerido: null,
      proximaOrdemCiclo: 1,
      serverTimestampMs: Date.now(),
    };

    const res = reconciliarEstadoCronometroComServidor({
      servidor,
      cacheLocal: null,
    });

    expect(res.statusSessao).toBe('pausada');
    expect(res.sessaoId).toBe('42000000-0000-4000-8000-000000000001');
    expect(res.etapa).toBe('conteudo');
    expect(res.segundosEfetivos).toBe(400);
    expect(res.estaRodando).toBe(false);
  });
});
