'use client';

import { useState } from 'react';
import Link from 'next/link';

interface SlideData {
  title: string;
  step: string;
  badge: string;
  color: string;
  bgColor: string;
  textClass: string;
  bgClass: string;
  borderClass: string;
  description: string;
  details: string[];
  tips: string;
  icon: React.ReactNode;
}

export default function ComoUsarPage() {
  const [activeTab, setActiveTab] = useState<'estudante' | 'responsavel'>('estudante');
  const [currentSlide, setCurrentSlide] = useState(0);

  const slidesEstudante: SlideData[] = [
    {
      step: '01',
      badge: 'BEM-VINDA',
      title: 'Bem-vinda à sua Jornada Medicina 2029!',
      color: 'hsl(194, 69%, 18%)',
      bgColor: 'hsl(194, 70%, 95%)',
      textClass: 'text-[#0E3D4D] dark:text-[#7DD3FC]',
      bgClass: 'bg-[#E0EBF0] dark:bg-[#0E3D4D]/30',
      borderClass: 'border-[#0E3D4D]/20 dark:border-[#7DD3FC]/30',
      description: 'Este sistema foi projetado sob medida para o seu sucesso no ENEM e UECE, utilizando os métodos de estudo cientificamente mais eficazes do mundo: Recuperação Ativa e Repetição Espaçada.',
      details: [
        'Aprenda ativamente em vez de apenas ler passivamente.',
        'Elimine pontos cegos através de estatísticas do seu Caderno de Erros.',
        'Siga um ciclo dinâmico que se adapta ao seu ritmo diário.'
      ],
      tips: 'A consistência diária vence a intensidade temporária. Estude um pouco todos os dias!',
      icon: (
        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.436 60.436 0 00-.491 6.347A48.62 48.62 0 0112 20.904a48.62 48.62 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.57 50.57 0 00-2.658-.813A59.905 59.905 0 0112 3.493a59.902 59.902 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15a.75.75 0 100-1.5.75.75 0 000 1.5zm0 0v-3.675A57.778 57.778 0 0012 7.5" />
        </svg>
      )
    },
    {
      step: '02',
      badge: 'PASSO 1',
      title: 'O Começo do Dia: Check-in de Saúde',
      color: 'hsl(145, 63%, 20%)',
      bgColor: 'hsl(145, 65%, 95%)',
      textClass: 'text-[#1B4D3E] dark:text-[#86EFAC]',
      bgClass: 'bg-[#E8F5E9] dark:bg-[#1B4D3E]/30',
      borderClass: 'border-[#1B4D3E]/20 dark:border-[#86EFAC]/30',
      description: 'Seu cérebro depende do seu corpo. Todos os dias, antes de iniciar os blocos, você preencherá um rápido questionário sobre a qualidade da sua rotina.',
      details: [
        'Horas de Sono: Dormir bem consolida as memórias do dia anterior.',
        'Atividade Física: Melhora a oxigenação cerebral e reduz a ansiedade.',
        'Níveis de Energia e Humor: Ajudam a rastrear quando você rende mais.'
      ],
      tips: 'Não negligencie o sono! Menos de 7h de sono reduz drasticamente a retenção de conteúdos difíceis.',
      icon: (
        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    },
    {
      step: '03',
      badge: 'PASSO 2',
      title: 'O Bloco de Estudo de 50 Minutos',
      color: 'hsl(28, 70%, 25%)',
      bgColor: 'hsl(28, 70%, 95%)',
      textClass: 'text-[#A0522D] dark:text-[#FDBA74]',
      bgClass: 'bg-[#FFF3E0] dark:bg-[#A0522D]/30',
      borderClass: 'border-[#A0522D]/20 dark:border-[#FDBA74]/30',
      description: 'Seus estudos são divididos em sessões de alta performance de 50 minutos cronometrados no sistema. A sessão segue uma divisão estrita de foco:',
      details: [
        'Minuto 00 ao 30 (Foco Total): Leitura ativa do material no acervo, marcação ou aula teórica.',
        'Minuto 30 ao 40 (Autoexplicação): Feche o livro e escreva ou fale em voz alta os pontos chave do que aprendeu. Isso força a memória ativa!',
        'Minuto 40 ao 50 (Revisão Espaçada): Abra o seu Anki (FSRS) no app e responda os flashcards programados para o dia.'
      ],
      tips: 'Ao iniciar o cronômetro, ative o modo Não Perturbe do celular. 50 minutos de estudo limpo rendem mais do que 3 horas interrompidas.',
      icon: (
        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    },
    {
      step: '04',
      badge: 'PASSO 3',
      title: 'Caderno de Erros: O Caminho da Aprovação',
      color: 'hsl(7, 65%, 25%)',
      bgColor: 'hsl(7, 70%, 96%)',
      textClass: 'text-[#8B2500] dark:text-[#FCA5A5]',
      bgClass: 'bg-[#FFEBEE] dark:bg-[#8B2500]/30',
      borderClass: 'border-[#8B2500]/20 dark:border-[#FCA5A5]/30',
      description: 'O segredo para passar em medicina é errar no treino para acertar no jogo. Sempre que resolver listas de questões ou simulados, registre seus erros no sistema.',
      details: [
        'Cadastre a questão exata, a alternativa correta e a que você marcou.',
        'Classifique a causa do erro: Falta de Atenção, Esquecimento de Fórmula, Conteúdo não aprendido ou Erro de Cálculo.',
        'O sistema agendará automaticamente reestudos direcionados sobre essas falhas para tapar seus buracos teóricos.'
      ],
      tips: 'Sua meta não é apenas acertar questões, é entender perfeitamente o motivo de cada erro cometido e corrigi-lo.',
      icon: (
        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
        </svg>
      )
    },
    {
      step: '05',
      badge: 'PASSO 4',
      title: 'Revisão Espaçada Ativa (Anki/FSRS)',
      color: 'hsl(280, 50%, 25%)',
      bgColor: 'hsl(280, 55%, 96%)',
      textClass: 'text-[#5E3A8C] dark:text-[#D8B4FE]',
      bgClass: 'bg-[#F3E5F5] dark:bg-[#5E3A8C]/30',
      borderClass: 'border-[#5E3A8C]/20 dark:border-[#D8B4FE]/30',
      description: 'Para não esquecer em Novembro o que aprendeu em Março, revisamos usando Flashcards. Ao responder a pergunta do card, escolha honestamente o grau de dificuldade:',
      details: [
        'ERREI: O assunto sumiu da cabeça. O card volta a aparecer em poucos minutos.',
        'DIFÍCIL: Você lembrou com esforço extremo. O card será revisto em breve.',
        'BOM: Resposta correta com esforço moderado. Intervalo ideal recomendado pelo FSRS.',
        'FÁCIL: Lembrou instantaneamente. O card ficará agendado para muito tempo depois.'
      ],
      tips: 'Nunca minta para o algoritmo de repetição espaçada! Se errou, marque sem medo. Isso otimiza o seu tempo.',
      icon: (
        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 14.25v2.25m3-4.5v4.5m3-6.75v6.75m3-9v9M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" />
        </svg>
      )
    },
    {
      step: '06',
      badge: 'PASSO 5',
      title: 'Redação: Nota 1000 no ENEM e UECE',
      color: 'hsl(340, 60%, 25%)',
      bgColor: 'hsl(340, 65%, 96%)',
      textClass: 'text-[#9F2B68] dark:text-[#FBCFE8]',
      bgClass: 'bg-[#FCE4EC] dark:bg-[#9F2B68]/30',
      borderClass: 'border-[#9F2B68]/20 dark:border-[#FBCFE8]/30',
      description: 'A redação garante 20% da sua nota final. Escreva à mão na folha de redação, digite o seu rascunho no sistema e utilize a inteligência artificial para:',
      details: [
        'Corrigir desvios gramaticais e de coesão textual.',
        'Atribuir uma nota simulada nas 5 competências do ENEM.',
        'Fornecer sugestões de reescrita parágrafo por parágrafo.',
        'Reescrever o texto completo buscando atingir a nota máxima.'
      ],
      tips: 'A cada redação enviada, reescreva-a incorporando as correções da IA. A reescrita é o que de fato melhora a sua escrita!',
      icon: (
        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
        </svg>
      )
    }
  ];

  const slidesResponsavel: SlideData[] = [
    {
      step: '01',
      badge: 'PASSO 1',
      title: 'Alimentar o Acervo de Estudos',
      color: 'hsl(194, 69%, 18%)',
      bgColor: 'hsl(194, 70%, 95%)',
      textClass: 'text-[#0E3D4D] dark:text-[#7DD3FC]',
      bgClass: 'bg-[#E0EBF0] dark:bg-[#0E3D4D]/30',
      borderClass: 'border-[#0E3D4D]/20 dark:border-[#7DD3FC]/30',
      description: 'O primeiro passo antes de tudo é alimentar o sistema. Você deve cadastrar livros, apostilas e listas de questões em PDF para criar a base didática da estudante.',
      details: [
        'Acesse a tela do "Acervo" e preencha os dados (Título, Tipo de Material).',
        'Selecione a série alvo (ou "Todos os Anos" se for material geral).',
        'Selecione o Vestibular alvo ("ENEM" ou "UECE") e a disciplina vinculada.',
        'Faça o upload do PDF. A IA fará o processamento e a extração do texto em segundo plano.'
      ],
      tips: 'Suba os materiais estruturais logo no início dos testes para que a IA processe e divida os capítulos adequadamente.',
      icon: (
        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
        </svg>
      )
    },
    {
      step: '02',
      badge: 'PASSO 2',
      title: 'Curadoria de Flashcards e Resumos',
      color: 'hsl(145, 63%, 20%)',
      bgColor: 'hsl(145, 65%, 95%)',
      textClass: 'text-[#1B4D3E] dark:text-[#86EFAC]',
      bgClass: 'bg-[#E8F5E9] dark:bg-[#1B4D3E]/30',
      borderClass: 'border-[#1B4D3E]/20 dark:border-[#86EFAC]/30',
      description: 'Após extrair as páginas, a IA sugere automaticamente resumos conceituais e perguntas/respostas para o Anki da Alice. Você faz a curadoria final.',
      details: [
        'Acesse a tela de "Curadoria" (exclusiva do seu perfil).',
        'Analise os flashcards gerados dinamicamente para cada página.',
        'Edite perguntas ou respostas livremente para refinar o conteúdo.',
        'Aprove o material. Apenas cards aprovados entrarão na rotina de revisões da estudante.'
      ],
      tips: 'Sua curadoria evita alucinações de IA e garante que sua filha estude apenas informações 100% corretas e alinhadas ao edital.',
      icon: (
        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.745 3.745 0 011.043 3.296A3.75 3.75 0 0121 12z" />
        </svg>
      )
    },
    {
      step: '03',
      badge: 'PASSO 3',
      title: 'Iniciar o Ciclo de Estudos',
      color: 'hsl(28, 70%, 25%)',
      bgColor: 'hsl(28, 70%, 95%)',
      textClass: 'text-[#A0522D] dark:text-[#FDBA74]',
      bgClass: 'bg-[#FFF3E0] dark:bg-[#A0522D]/30',
      borderClass: 'border-[#A0522D]/20 dark:border-[#FDBA74]/30',
      description: 'Com a biblioteca alimentada, o terceiro passo é iniciar oficialmente o ciclo de estudos da Alice, configurando as metas.',
      details: [
        'Acesse a tela "Responsável".',
        'No painel direito "Controle do Ciclo", clique no botão "Iniciar Ciclo de Estudos".',
        'O sistema estruturará automaticamente um cronograma de 28 blocos focado fortemente em resolução de questões (mais de 50% dos blocos).',
        'O ciclo será ativado com data inicial de hoje, liberando a tela da Alice.'
      ],
      tips: 'A qualquer momento nos testes, se desejar replanejar a data de início ou zerar o progresso, use o botão "Resetar Planejamento" e inicie de novo.',
      icon: (
        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
        </svg>
      )
    },
    {
      step: '04',
      badge: 'PASSO 4',
      title: 'Acompanhar o Desempenho Qualitativo',
      color: 'hsl(280, 50%, 25%)',
      bgColor: 'hsl(280, 55%, 96%)',
      textClass: 'text-[#5E3A8C] dark:text-[#D8B4FE]',
      bgClass: 'bg-[#F3E5F5] dark:bg-[#5E3A8C]/30',
      borderClass: 'border-[#5E3A8C]/20 dark:border-[#D8B4FE]/30',
      description: 'O quarto passo é acompanhar o progresso a cada duas semanas no dashboard, respeitando a autonomia e privacidade de estudos da aluna.',
      details: [
        'Verifique os indicadores quinzenais acumulados de sono, atividades e cumprimento de blocos.',
        'Analise os relatórios do Caderno de Erros para entender as fraquezas cognitivas (atenção vs conteúdo).',
        'Utilize o formulário de Revisão Trimestral para registrar os acordos pedagógicos e conversas de alinhamento.'
      ],
      tips: 'Dar autonomia para a aluna gerenciar seu dia a dia e focar em revisões quinzenais conjuntas reduz o estresse e gera melhores resultados a longo prazo.',
      icon: (
        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v5.25c0 .621-.504 1.125-1.125 1.125h-2.25A1.125 1.125 0 013 18.375v-5.25zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125v-9.75zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v14.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
        </svg>
      )
    }
  ];

  const handleTabChange = (tab: 'estudante' | 'responsavel') => {
    setActiveTab(tab);
    setCurrentSlide(0);
  };

  const currentSlides = activeTab === 'estudante' ? slidesEstudante : slidesResponsavel;

  const nextSlide = () => {
    if (currentSlide < currentSlides.length - 1) {
      setCurrentSlide(currentSlide + 1);
    }
  };

  const prevSlide = () => {
    if (currentSlide > 0) {
      setCurrentSlide(currentSlide - 1);
    }
  };

  const slide = currentSlides[currentSlide];

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 pb-24 font-['Poppins'] text-[#1B2A33] dark:text-gray-100">
      {/* Header */}
      <header className="border-b dark:border-gray-800 pb-6 mb-8 text-center md:text-left flex flex-col md:flex-row justify-between items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold font-['Lora'] text-[#0E3D4D] dark:text-[#E2E8F0]">Como Usar o Sistema</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Guia de bordo passo a passo para extrair a máxima performance da rotina de estudos.
          </p>
        </div>

        {/* Tab Selection */}
        <div className="flex bg-[#EAE3D5]/40 dark:bg-gray-800/40 p-1 rounded-2xl border border-[#D5CBB8]/30 dark:border-gray-700/30">
          <button
            onClick={() => handleTabChange('estudante')}
            className={`py-2 px-4 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'estudante'
                ? 'bg-[#0E3D4D] text-white shadow-sm'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
            }`}
          >
            Guia da Aluna (Alice)
          </button>
          <button
            onClick={() => handleTabChange('responsavel')}
            className={`py-2 px-4 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'responsavel'
                ? 'bg-[#0E3D4D] text-white shadow-sm'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
            }`}
          >
            Guia do Responsável (Bruno)
          </button>
        </div>
      </header>

      {/* Interactive Carousel */}
      <div className="bg-white dark:bg-[#111C24] border border-[#EAE3D5] dark:border-gray-800 rounded-3xl p-6 md:p-10 shadow-lg shadow-[#0E3D4D]/5 transition-all duration-300 relative overflow-hidden flex flex-col justify-between min-h-[500px]">
        {/* Decorative Background Badge */}
        <div 
          className="absolute -right-8 -top-8 w-32 h-32 rounded-full opacity-10 flex items-center justify-center font-bold text-5xl text-white"
          style={{ backgroundColor: slide.color }}
        >
          {slide.step}
        </div>

        {/* Content Section */}
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <span 
              className={`text-[10px] font-bold px-3 py-1 rounded-full border ${slide.bgClass} ${slide.borderClass} ${slide.textClass}`}
            >
              {slide.badge}
            </span>
            <span className="text-xs font-bold text-gray-400 dark:text-gray-500">
              Etapa {slide.step} de {currentSlides.length.toString().padStart(2, '0')}
            </span>
          </div>

          <div className="flex flex-col md:flex-row gap-6 items-start">
            {/* Slide Icon */}
            <div 
              className={`p-4 rounded-2xl shadow-md shrink-0 flex items-center justify-center ${slide.bgClass} ${slide.textClass}`}
            >
              {slide.icon}
            </div>

            <div className="space-y-3 flex-1">
              <h2 
                className={`text-2xl md:text-3xl font-bold font-['Lora'] leading-snug ${slide.textClass}`}
              >
                {slide.title}
              </h2>
              <p className="text-sm md:text-base text-gray-600 dark:text-gray-300 leading-relaxed font-medium">
                {slide.description}
              </p>
            </div>
          </div>

          {/* Details list */}
          <div className="bg-[#FBF8F3] dark:bg-[#1B2A33] rounded-2xl p-6 border border-[#EAE3D5]/60 dark:border-gray-800">
            <h3 className="text-xs md:text-sm font-bold text-[#0E3D4D] dark:text-[#E0EBF0] uppercase tracking-wider mb-3">Pontos Fundamentais:</h3>
            <ul className="space-y-3">
              {slide.details.map((d, index) => (
                <li key={index} className="flex gap-3 text-xs md:text-sm text-gray-700 dark:text-gray-300 font-medium leading-relaxed">
                  <span className="text-[#B5502B] dark:text-[#E07A5F] font-bold text-base shrink-0">✓</span>
                  <span>{d}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Action controls & Footer */}
        <div className="mt-8 pt-6 border-t border-[#EAE3D5] dark:border-gray-800 flex flex-col md:flex-row items-center justify-between gap-4">
          {/* Tip container */}
          <div className="flex-1 flex gap-2 items-start text-xs md:text-sm text-gray-500 dark:text-gray-400 font-['Lora'] italic leading-relaxed">
            <span className="text-[#B5502B] dark:text-[#E07A5F] font-bold not-italic shrink-0">💡 Dica:</span>
            <span>{slide.tips}</span>
          </div>

          {/* Navigation Buttons */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={prevSlide}
              disabled={currentSlide === 0}
              className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-xl text-xs font-semibold text-gray-600 dark:text-gray-400 bg-white dark:bg-[#1B2A33] hover:bg-gray-50 dark:hover:bg-[#253540] transition-all disabled:opacity-30 disabled:hover:bg-white dark:disabled:hover:bg-[#1B2A33] cursor-pointer"
            >
              Anterior
            </button>

            {currentSlide < currentSlides.length - 1 ? (
              <button
                onClick={nextSlide}
                className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-[#0E3D4D] dark:bg-[#17607A] hover:bg-[#17607A] dark:hover:bg-[#0E3D4D] transition-all shadow-md shadow-[#0E3D4D]/15 active:scale-95 cursor-pointer"
              >
                Próximo
              </button>
            ) : (
              <Link
                href={activeTab === 'estudante' ? '/' : '/responsavel'}
                className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 transition-all shadow-md shadow-emerald-600/15 active:scale-95 text-center"
              >
                {activeTab === 'estudante' ? 'Começar a Estudar!' : 'Ir para o Painel!'}
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Progress Dots */}
      <div className="flex justify-center gap-2 mt-6">
        {currentSlides.map((_, index) => (
          <button
            key={index}
            onClick={() => setCurrentSlide(index)}
            className={`w-2.5 h-2.5 rounded-full transition-all cursor-pointer ${
              index === currentSlide ? 'bg-[#0E3D4D] dark:bg-[#38BDF8] w-6' : 'bg-gray-300 dark:bg-gray-700'
            }`}
            title={`Ir para etapa ${index + 1}`}
          />
        ))}
      </div>
    </div>
  );
}
