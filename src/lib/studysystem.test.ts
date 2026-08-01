import { describe, it, expect } from 'vitest';
import {
  calcularProximaOrdem,
  calcularAderencia,
  calcularDivergenciaTrilhos,
  verificarPendenteSimulado,
  calcularMediaSimulados,
  validarConclusaoSessao,
  validarFonteArtefato,
  type TentativaMapeada,
  type SimuladoComAnalise
} from './studysystem';

describe('Sistema de Estudos - Regras de Negócio', () => {
  
  // 1. Ponteiro do Ciclo
  describe('Ponteiro do Ciclo', () => {
    it('deve avançar a ordem do bloco em 1 se não atingiu o limite', () => {
      expect(calcularProximaOrdem(1, 12)).toBe(2);
      expect(calcularProximaOrdem(5, 16)).toBe(6);
    });

    it('deve retornar a 1 se atingiu o total de blocos do ciclo', () => {
      expect(calcularProximaOrdem(12, 12)).toBe(1);
      expect(calcularProximaOrdem(16, 16)).toBe(1);
    });

    it('deve retornar 1 se o total de blocos for inválido', () => {
      expect(calcularProximaOrdem(1, 0)).toBe(1);
    });
  });

  // 2. Cálculo de Aderência
  describe('Cálculo de Aderência', () => {
    it('deve calcular corretamente a porcentagem de aderência', () => {
      // 24 blocos concluídos de 48 previstos (12 por semana em 4 semanas)
      expect(calcularAderencia(24, 12, 4)).toBe(50);
      
      // 12 concluídos de 12 previstos
      expect(calcularAderencia(12, 12, 1)).toBe(100);
    });

    it('deve retornar 0 se os blocos previstos forem zero ou negativos', () => {
      expect(calcularAderencia(5, 0, 4)).toBe(0);
    });
  });

  // 3. Divergência de Trilhos
  describe('Divergência de Trilhos', () => {
    it('deve disparar alerta de falta de profundidade técnica se ENEM > Conteudista por mais de 15 pontos', () => {
      const tentativas: TentativaMapeada[] = [
        { estilo: 'enem', correta: true },
        { estilo: 'enem', correta: true },
        { estilo: 'enem', correta: true },
        { estilo: 'enem', correta: true }, // 100% ENEM
        { estilo: 'conteudista', correta: true },
        { estilo: 'conteudista', correta: false }, // 50% Conteudista
      ];
      const res = calcularDivergenciaTrilhos(tentativas);
      expect(res.divergencia).toBe(50);
      expect(res.alerta).toBe(true);
      expect(res.diagnostico).toContain('Falta profundidade técnica');
    });

    it('deve disparar alerta de falta de repertório interpretativo se Conteudista > ENEM por mais de 15 pontos', () => {
      const tentativas: TentativaMapeada[] = [
        { estilo: 'enem', correta: false },
        { estilo: 'enem', correta: true }, // 50% ENEM
        { estilo: 'conteudista', correta: true },
        { estilo: 'conteudista', correta: true },
        { estilo: 'conteudista', correta: true }, // 100% Conteudista
      ];
      const res = calcularDivergenciaTrilhos(tentativas);
      expect(res.divergencia).toBe(-50);
      expect(res.alerta).toBe(true);
      expect(res.diagnostico).toContain('Falta repertório interpretativo');
    });

    it('deve sinalizar equilíbrio se a diferença estiver dentro da margem de 15 pontos', () => {
      const tentativas: TentativaMapeada[] = [
        { estilo: 'enem', correta: true },
        { estilo: 'enem', correta: false }, // 50% ENEM
        { estilo: 'conteudista', correta: true },
        { estilo: 'conteudista', correta: false }, // 50% Conteudista
      ];
      const res = calcularDivergenciaTrilhos(tentativas);
      expect(res.divergencia).toBe(0);
      expect(res.alerta).toBe(false);
      expect(res.diagnostico).toContain('Desempenho equilibrado');
    });
  });

  // 5. Travas de Simulado
  describe('Travas de Simulado', () => {
    it('deve detectar se há algum simulado pendente de análise', () => {
      const simulados: SimuladoComAnalise[] = [
        { id: '1', analiseConcluida: true },
        { id: '2', analiseConcluida: false }
      ];
      expect(verificarPendenteSimulado(simulados)).toBe(true);
    });

    it('deve calcular a média das notas ignorando simulados não analisados', () => {
      const simulados: SimuladoComAnalise[] = [
        { id: '1', analiseConcluida: true, notaTotal: 800 },
        { id: '2', analiseConcluida: false, notaTotal: 900 },
        { id: '3', analiseConcluida: true, notaTotal: 700 }
      ];
      expect(calcularMediaSimulados(simulados)).toBe(750); // (800 + 700) / 2
    });
  });

  // 6. Trava de Etapa de Registro
  describe('Trava de Etapa de Registro', () => {
    it('deve validar como concluída apenas se atingir a etapa de registro', () => {
      expect(validarConclusaoSessao('registro')).toBe(true);
      expect(validarConclusaoSessao('questoes')).toBe(false);
      expect(validarConclusaoSessao('conteudo')).toBe(false);
      expect(validarConclusaoSessao('revisao')).toBe(false);
    });
  });

  // 7. Bloqueio de Artefato Sem Fonte
  describe('Bloqueio de Artefato Sem Fonte', () => {
    it('deve rejeitar artefatos que não citam chunks de origem', () => {
      expect(validarFonteArtefato(null)).toBe(false);
      expect(validarFonteArtefato(undefined)).toBe(false);
      expect(validarFonteArtefato([])).toBe(false);
      expect(validarFonteArtefato(['chunk-1'])).toBe(true);
    });
  });

});
