'use client';

import { useState } from 'react';
import Link from 'next/link';

interface SlideData {
  title: string;
  step: string;
  badge: string;
  color: string;
  bgColor: string;
  description: string;
  details: string[];
  tips: string;
  icon: React.ReactNode;
}

export default function ComoUsarPage() {
  const [currentSlide, setCurrentSlide] = useState(0);

  const slides: SlideData[] = [
    {
      step: '01',
      badge: 'BEM-VINDA',
      title: 'Bem-vinda à sua Jornada Medicina 2029!',
      color: 'hsl(194, 69%, 18%)',
      bgColor: 'hsl(194, 70%, 95%)',
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

  const nextSlide = () => {
    if (currentSlide < slides.length - 1) {
      setCurrentSlide(currentSlide + 1);
    }
  };

  const prevSlide = () => {
    if (currentSlide > 0) {
      setCurrentSlide(currentSlide - 1);
    }
  };

  const slide = slides[currentSlide];

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 pb-24 font-['Poppins'] text-[#1B2A33]">
      {/* Header */}
      <header className="border-b pb-6 mb-8 text-center md:text-left">
        <h1 className="text-3xl font-bold font-['Lora'] text-[#0E3D4D]">Como Usar o Sistema</h1>
        <p className="text-sm text-gray-500 mt-1">
          Guia de bordo passo a passo para extrair a máxima performance da sua rotina de estudos.
        </p>
      </header>

      {/* Interactive Carousel */}
      <div className="bg-white border border-[#EAE3D5] rounded-3xl p-6 md:p-10 shadow-lg shadow-[#0E3D4D]/5 transition-all duration-300 relative overflow-hidden flex flex-col justify-between min-h-[500px]">
        {/* Decorative Background Badge */}
        <div 
          className="absolute -right-8 -top-8 w-32 h-32 rounded-full opacity-10 flex items-center justify-center font-bold text-5xl"
          style={{ backgroundColor: slide.color, color: '#FFFFFF' }}
        >
          {slide.step}
        </div>

        {/* Content Section */}
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <span 
              className="text-[10px] font-bold px-3 py-1 rounded-full border"
              style={{ backgroundColor: slide.bgColor, borderColor: slide.color, color: slide.color }}
            >
              {slide.badge}
            </span>
            <span className="text-xs font-bold text-gray-400">Etapa {slide.step} de 06</span>
          </div>

          <div className="flex flex-col md:flex-row gap-6 items-start">
            {/* Slide Icon */}
            <div 
              className="p-4 rounded-2xl shadow-md shrink-0 flex items-center justify-center"
              style={{ backgroundColor: slide.bgColor, color: slide.color }}
            >
              {slide.icon}
            </div>

            <div className="space-y-3 flex-1">
              <h2 
                className="text-xl md:text-2xl font-bold font-['Lora']"
                style={{ color: slide.color }}
              >
                {slide.title}
              </h2>
              <p className="text-sm text-gray-600 leading-relaxed font-medium">
                {slide.description}
              </p>
            </div>
          </div>

          {/* Details list */}
          <div className="bg-[#FBF8F3] rounded-2xl p-5 border border-[#EAE3D5]/60">
            <h3 className="text-xs font-bold text-[#0E3D4D] uppercase tracking-wider mb-3">Pontos Fundamentais:</h3>
            <ul className="space-y-2.5">
              {slide.details.map((d, index) => (
                <li key={index} className="flex gap-3 text-xs text-gray-700 font-medium leading-relaxed">
                  <span className="text-[#B5502B] font-bold text-sm shrink-0">✓</span>
                  <span>{d}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Action controls & Footer */}
        <div className="mt-8 pt-6 border-t border-[#EAE3D5] flex flex-col md:flex-row items-center justify-between gap-4">
          {/* Tip container */}
          <div className="flex-1 flex gap-2 items-start text-[11px] text-gray-500 font-['Lora'] italic leading-relaxed">
            <span className="text-[#B5502B] font-bold not-italic">💡 Dica:</span>
            <span>{slide.tips}</span>
          </div>

          {/* Navigation Buttons */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={prevSlide}
              disabled={currentSlide === 0}
              className="px-4 py-2 border border-gray-300 rounded-xl text-xs font-semibold text-gray-600 bg-white hover:bg-gray-50 transition-all disabled:opacity-30 disabled:hover:bg-white cursor-pointer"
            >
              Anterior
            </button>

            {currentSlide < slides.length - 1 ? (
              <button
                onClick={nextSlide}
                className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-[#0E3D4D] hover:bg-[#17607A] transition-all shadow-md shadow-[#0E3D4D]/15 active:scale-95 cursor-pointer"
              >
                Próximo
              </button>
            ) : (
              <Link
                href="/"
                className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 transition-all shadow-md shadow-emerald-600/15 active:scale-95 text-center"
              >
                Começar a Estudar!
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Progress Dots */}
      <div className="flex justify-center gap-2 mt-6">
        {slides.map((_, index) => (
          <button
            key={index}
            onClick={() => setCurrentSlide(index)}
            className={`w-2.5 h-2.5 rounded-full transition-all cursor-pointer ${
              index === currentSlide ? 'bg-[#0E3D4D] w-6' : 'bg-gray-300'
            }`}
            title={`Ir para etapa ${index + 1}`}
          />
        ))}
      </div>
    </div>
  );
}
