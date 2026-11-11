import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('MEDICINA 2029 — H2.04-T5-UI: Reformulação Responsiva das Telas de Estudo, Registro e Pausa', () => {
  const cronometroPath = path.resolve(
    process.cwd(),
    'src/components/CronometroPage.tsx'
  );
  const estudarRoutePath = path.resolve(
    process.cwd(),
    'src/app/estudar/page.tsx'
  );

  const cronometroContent = fs.readFileSync(cronometroPath, 'utf-8');
  const estudarRouteContent = fs.readFileSync(estudarRoutePath, 'utf-8');

  describe('1. Rota /estudar e Integração Estrutural', () => {
    it('inclui o componente NavBar na árvore de renderização da rota /estudar', () => {
      expect(estudarRouteContent).toContain('<NavBar />');
      expect(estudarRouteContent).toContain("import NavBar from '../../components/NavBar';");
    });

    it('utiliza espaçamento compensatório responsivo para a barra lateral (pl-16 md:pl-64)', () => {
      expect(estudarRouteContent).toContain('pl-16 md:pl-64');
    });

    it('envolve o CronometroPage em um Suspense boundary com feedback visual', () => {
      expect(estudarRouteContent).toContain('<Suspense');
      expect(estudarRouteContent).toContain('<CronometroPage />');
    });
  });

  describe('2. Contêiner Principal e Breakpoints Responsivos', () => {
    it('substitui o limite estreito de max-w-md por max-w-6xl com margens respiráveis', () => {
      expect(cronometroContent).toContain('max-w-6xl');
      expect(cronometroContent).toContain('px-4 sm:px-6 lg:px-8');
    });

    it('adota grid responsivo de 12 colunas em desktop (grid-cols-1 lg:grid-cols-12)', () => {
      expect(cronometroContent).toContain('grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8');
    });

    it('distribui 5 colunas no cronômetro e 7 colunas no painel contextual/registro em lg', () => {
      expect(cronometroContent).toContain('lg:col-span-5');
      expect(cronometroContent).toContain('lg:col-span-7');
    });
  });

  describe('3. Linha do Tempo / Stepper Contínuo de 5 Etapas', () => {
    it('mantém o stepper visível em todas as etapas incluindo a pausa', () => {
      expect(cronometroContent).toContain('ETAPAS_PROGRESSAO');
      expect(cronometroContent).toContain("id: 'revisao'");
      expect(cronometroContent).toContain("id: 'conteudo'");
      expect(cronometroContent).toContain("id: 'questoes'");
      expect(cronometroContent).toContain("id: 'registro'");
      expect(cronometroContent).toContain("id: 'pausa'");
    });

    it('apresenta rótulos claros com durações em minutos (5m, 28m, 15m, 2m, 10m)', () => {
      expect(cronometroContent).toContain("duracao: '5m'");
      expect(cronometroContent).toContain("duracao: '28m'");
      expect(cronometroContent).toContain("duracao: '15m'");
      expect(cronometroContent).toContain("duracao: '2m'");
      expect(cronometroContent).toContain("duracao: '10m'");
    });
  });

  describe('4. Mostrador do Cronômetro, Controles e Acessibilidade', () => {
    it('preserva o atributo de teste data-testid="status-sessao-badge"', () => {
      expect(cronometroContent).toContain('data-testid="status-sessao-badge"');
    });

    it('mantém os dígitos do cronômetro amplos com suporte a telas grandes (text-6xl sm:text-7xl)', () => {
      expect(cronometroContent).toContain('text-6xl sm:text-7xl');
    });

    it('garante que o botão Avançar Etapa tenha title e aria-label com toque mínimo de 44px', () => {
      expect(cronometroContent).toContain('title="Avançar Etapa"');
      expect(cronometroContent).toContain('aria-label="Avançar Etapa"');
      expect(cronometroContent).toContain('min-h-[44px] min-w-[44px]');
    });

    it('garante que o botão Play/Pause tenha dimensão generosa e target acessível', () => {
      expect(cronometroContent).toContain('w-16 h-16 sm:w-18 sm:h-18');
      expect(cronometroContent).toContain('min-w-[44px] min-h-[44px]');
    });

    it('renderiza o indicador de etapa textual no DOM para compatibilidade funcional', () => {
      expect(cronometroContent).toContain('{`Etapa atual: ${etapa.toUpperCase()}`}');
    });
  });

  describe('5. Ficha de Registro de Estudo Ampliada e Ergonômica', () => {
    it('oferece campos numéricos de questões e acertos com altura mínima de 44px (h-12)', () => {
      expect(cronometroContent).toContain('h-12 px-4 bg-white border border-[#D5CBB8] rounded-xl text-base font-bold');
    });

    it('inclui textarea para observações com fonte de leitura elegante (font-lora-read) e linhas ampliadas', () => {
      expect(cronometroContent).toContain('rows={4}');
      expect(cronometroContent).toContain('font-lora-read');
      expect(cronometroContent).toContain('value={notaLivre}');
    });

    it('apresenta botão de finalização com texto completo e sem truncamento', () => {
      expect(cronometroContent).toContain('Finalizar Estudo e Iniciar Pausa');
      expect(cronometroContent).toContain('h-14 bg-[#0E3D4D]');
    });

    it('permite anotações qualificadas de erros com formulário estruturado', () => {
      expect(cronometroContent).toContain('+ Registrar Erro');
      expect(cronometroContent).toContain('Adicionar Anotação de Erro');
    });
  });

  describe('6. Tela de Pausa / Intervalo Obrigatório Acolhedora', () => {
    it('apresenta a orientação clássica de descanso em destaque', () => {
      expect(cronometroContent).toContain(
        'Aproveite este intervalo de 10 minutos para desviar os'
      );
    });

    it('inclui os 3 pilares ergonômicos de recuperação (Desvio de Foco, Hidratação, Zero Redes)', () => {
      expect(cronometroContent).toContain('Desvio de Foco');
      expect(cronometroContent).toContain('Hidratação');
      expect(cronometroContent).toContain('Zero Redes Sociais');
    });

    it('preserva o botão Pular Pausa e Voltar com target acessível de 44px', () => {
      expect(cronometroContent).toContain('Pular Pausa e Voltar');
      expect(cronometroContent).toContain('min-h-[44px]');
    });
  });
});
