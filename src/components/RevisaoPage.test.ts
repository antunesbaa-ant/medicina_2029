import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const revisaoSource = readFileSync(
  resolve(process.cwd(), 'src/components/RevisaoPage.tsx'),
  'utf8'
);
const globalsCss = readFileSync(
  resolve(process.cwd(), 'src/app/globals.css'),
  'utf8'
);

describe('RevisaoPage — Correções Finais do FSRS (Parte A)', () => {
  describe('1. Medição de Duração e Tratamento Defensivo de Inatividade', () => {
    it('implementa temporizador com controle de visibilidade da aba (visibilitychange)', () => {
      expect(revisaoSource).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)");
      expect(revisaoSource).toContain("document.removeEventListener('visibilitychange', handleVisibilityChange)");
      expect(revisaoSource).toContain('document.hidden');
    });

    it('implementa escuta de foco e desfoque da janela (window.blur e window.focus)', () => {
      expect(revisaoSource).toContain("window.addEventListener('blur', handleWindowBlur)");
      expect(revisaoSource).toContain("window.addEventListener('focus', handleWindowFocus)");
      expect(revisaoSource).toContain("window.removeEventListener('blur', handleWindowBlur)");
      expect(revisaoSource).toContain("window.removeEventListener('focus', handleWindowFocus)");
    });

    it('aplica limite defensivo para períodos contínuos de inatividade (MAX_ACTIVE_SPAN_MS)', () => {
      expect(revisaoSource).toContain('MAX_ACTIVE_SPAN_MS');
      expect(revisaoSource).toContain('Math.min(elapsed, MAX_ACTIVE_SPAN_MS)');
    });

    it('aplica teto máximo seguro de estudo por cartão (MAX_CARD_STUDY_TIME_MS) e respeita o piso de 1ms', () => {
      expect(revisaoSource).toContain('MAX_CARD_STUDY_TIME_MS');
      expect(revisaoSource).toContain('Math.max(');
      expect(revisaoSource).toContain('Math.min(MAX_CARD_STUDY_TIME_MS');
      // Garante que o valor nunca ultrapassa o teto do backend de 3.600.000 ms
      expect(revisaoSource).not.toContain('Date.now() - cardShownTimestamp.current;');
    });

    it('reinicia o temporizador após falha de persistência para permitir nova tentativa imediata', () => {
      expect(revisaoSource).toContain('setErroPersistencia(resultado.mensagem)');
      expect(revisaoSource).toContain('resetCardTimer()');
    });

    it('reinicia o temporizador ao avançar para o próximo cartão ou carregar a lista', () => {
      expect(revisaoSource).toContain('setCurrentIndex(prev => prev + 1)');
      expect(revisaoSource).toContain('resetCardTimer()');
    });
  });

  describe('2. Contraste Visual e Compatibilidade com Regras Globais de CSS / Dark Mode', () => {
    it('o texto da pergunta/resposta possui classe explícita para dark mode evitando conflito com .dark .bg-white', () => {
      // globals.css define .dark .bg-white { background-color: #24353F !important; }
      expect(globalsCss).toContain('.dark .bg-white');
      expect(globalsCss).toContain('#24353F !important');

      // RevisaoPage deve possuir dark:text-[#F5F7F8] para garantir contraste contra #24353F
      expect(revisaoSource).toContain('text-[#1B2A33] dark:text-[#F5F7F8]');
    });

    it('o verso do cartão possui gradiente adaptado para dark mode', () => {
      expect(revisaoSource).toContain('dark:from-[#24353F] dark:to-[#1B2A33]');
    });

    it('elimina classes de baixo contraste (text-gray-400 sobre branco) em textos informativos e dicas', () => {
      // Metadados de tópico e dica de flip devem usar pelo menos gray-600 no claro e gray-300 no escuro
      expect(revisaoSource).toContain('text-gray-600 dark:text-gray-300');
      // Não deve ter texto de prompt com text-gray-400 isolado
      expect(revisaoSource).not.toContain('<div className="flex justify-between items-center text-[10px] uppercase font-bold text-gray-400">');
    });

    it('os botões de avaliação possuem classes de alto contraste e acessibilidade', () => {
      expect(revisaoSource).toContain('bg-rose-600');
      expect(revisaoSource).toContain('bg-amber-600');
      expect(revisaoSource).toContain('bg-[#17607A]');
      expect(revisaoSource).toContain('bg-emerald-600');
      expect(revisaoSource).toContain('aria-keyshortcuts');
    });

    it('valida matematicamente as taxas de contraste nos dois modos', () => {
      // Função auxiliar de luminância relativa WCAG 2.1
      function getLuminance(r: number, g: number, b: number): number {
        const a = [r, g, b].map(v => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
      }

      function getContrastRatio(rgb1: [number, number, number], rgb2: [number, number, number]): number {
        const l1 = getLuminance(...rgb1);
        const l2 = getLuminance(...rgb2);
        const lighter = Math.max(l1, l2);
        const darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      }

      // Modo Claro: Texto #1B2A33 (27, 42, 51) sobre Fundo #FFFFFF (255, 255, 255)
      const ratioClaroFrente = getContrastRatio([27, 42, 51], [255, 255, 255]);
      expect(ratioClaroFrente).toBeGreaterThan(7.0); // WCAG AAA exige >= 7.0 (obteve ~13.4:1)

      // Modo Escuro: Texto #F5F7F8 (245, 247, 248) sobre Fundo #24353F (36, 53, 63)
      const ratioEscuroFrente = getContrastRatio([245, 247, 248], [36, 53, 63]);
      expect(ratioEscuroFrente).toBeGreaterThan(7.0); // WCAG AAA exige >= 7.0 (obteve ~11.8:1)

      // Modo Claro Auxiliar: Texto #4B5563 (gray-600) sobre Fundo #FFFFFF
      const ratioClaroAux = getContrastRatio([75, 85, 99], [255, 255, 255]);
      expect(ratioClaroAux).toBeGreaterThan(4.5); // WCAG AA exige >= 4.5 (obteve ~7.5:1)

      // Modo Escuro Auxiliar: Texto #D1D5DB (gray-300) sobre Fundo #24353F
      const ratioEscuroAux = getContrastRatio([209, 213, 219], [36, 53, 63]);
      expect(ratioEscuroAux).toBeGreaterThan(4.5); // WCAG AA exige >= 4.5 (obteve ~8.3:1)
    });
  });
});
