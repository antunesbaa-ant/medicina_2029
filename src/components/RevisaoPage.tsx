'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { obterCardsParaRevisao, registrarRevisaoCard } from '../app/actions/fsrs';

type CardRevisao = Awaited<ReturnType<typeof obterCardsParaRevisao>>[number];

export default function RevisaoPage() {
  const router = useRouter();
  const [cardsList, setCardsList] = useState<CardRevisao[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [showVerso, setShowVerso] = useState<boolean>(false);
  const [concluido, setConcluido] = useState<boolean>(false);
  const [salvando, setSalvando] = useState<boolean>(false);
  const [erroPersistencia, setErroPersistencia] = useState<string | null>(null);
  const [erroCarregamento, setErroCarregamento] = useState<string | null>(null);

  // Timer for active card review duration
  const cardShownTimestamp = useRef<number>(0);

  const carregarCards = useCallback(async () => {
    setLoading(true);
    setErroCarregamento(null);
    try {
      const res = await obterCardsParaRevisao();
      setCardsList(res);
      cardShownTimestamp.current = Date.now();
    } catch (err: unknown) {
      console.error(err);
      const mensagem =
        err instanceof Error && err.message
          ? err.message
          : 'Não foi possível carregar os cartões para revisão.';
      setErroCarregamento(mensagem);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregarCards();
  }, [carregarCards]);

  const handleFlip = () => {
    setShowVerso(prev => !prev);
  };

  const handleAnswer = useCallback(
    async (rating: 'again' | 'hard' | 'good' | 'easy') => {
      const activeCard = cardsList[currentIndex];
      if (!activeCard || salvando) return;

      const duracaoMs = Math.max(1, Date.now() - cardShownTimestamp.current);
      setSalvando(true);
      setErroPersistencia(null);
      try {
        const resultado = await registrarRevisaoCard(activeCard.id, rating, duracaoMs);
        if (!resultado.sucesso) {
          setErroPersistencia(resultado.mensagem);
          return;
        }

        const isLast = currentIndex === cardsList.length - 1;
        if (isLast) {
          setConcluido(true);
        } else {
          setCurrentIndex(prev => prev + 1);
          setShowVerso(false);
          cardShownTimestamp.current = Date.now();
        }
      } catch {
        setErroPersistencia('Não foi possível registrar a revisão. Tente novamente.');
      } finally {
        setSalvando(false);
      }
    },
    [cardsList, currentIndex, salvando]
  );

  // Atalhos de teclado para navegação e classificação FSRS
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (loading || concluido || erroCarregamento || salvando || cardsList.length === 0) {
        return;
      }

      if (!showVerso) {
        if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          setShowVerso(true);
        }
      } else {
        if (e.key === '1') {
          e.preventDefault();
          handleAnswer('again');
        } else if (e.key === '2') {
          e.preventDefault();
          handleAnswer('hard');
        } else if (e.key === '3') {
          e.preventDefault();
          handleAnswer('good');
        } else if (e.key === '4') {
          e.preventDefault();
          handleAnswer('easy');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [loading, concluido, erroCarregamento, salvando, cardsList.length, showVerso, handleAnswer]);

  if (loading) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 flex flex-col items-center justify-center min-h-[60vh] font-['Poppins']">
        <div className="w-8 h-8 border-4 border-[#0E3D4D] border-t-transparent rounded-full animate-spin"></div>
        <p className="text-xs font-semibold text-[#0E3D4D] mt-3">Carregando seus cartões de revisão...</p>
      </div>
    );
  }

  if (erroCarregamento) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 flex flex-col items-center justify-center min-h-[60vh] font-['Poppins'] text-center space-y-4">
        <div className="w-16 h-16 bg-rose-500/10 border border-rose-500/20 text-rose-600 rounded-full flex items-center justify-center mx-auto shadow-inner">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-8 h-8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold font-['Lora'] text-[#0E3D4D]">Falha no Carregamento</h2>
        <p className="text-sm text-gray-500 max-w-sm">
          {erroCarregamento}
        </p>
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={() => carregarCards()}
            className="px-6 py-2.5 bg-[#0E3D4D] hover:bg-[#17607A] text-white text-xs font-bold rounded-lg transition-all shadow-sm"
          >
            Tentar Novamente
          </button>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-bold rounded-lg transition-all"
          >
            Voltar ao Início
          </button>
        </div>
      </div>
    );
  }

  if (concluido) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 flex flex-col items-center justify-center min-h-[60vh] font-['Poppins'] text-center space-y-4">
        <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 rounded-full flex items-center justify-center mx-auto shadow-inner">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-8 h-8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold font-['Lora'] text-[#0E3D4D]">Revisões Concluídas!</h2>
        <p className="text-sm text-gray-500 max-w-sm">
          Excelente trabalho! Você concluiu todos os cartões programados para hoje. Seus intervalos de repetição FSRS foram recalculados.
        </p>
        <button
          onClick={() => router.push('/')}
          className="px-6 py-2.5 bg-[#0E3D4D] hover:bg-[#17607A] text-white text-xs font-bold rounded-lg transition-all shadow-sm"
        >
          Voltar ao Início
        </button>
      </div>
    );
  }

  if (cardsList.length === 0) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 flex flex-col items-center justify-center min-h-[60vh] font-['Poppins'] text-center space-y-4">
        <div className="w-16 h-16 bg-[#17607A]/10 border border-[#17607A]/20 text-[#17607A] rounded-full flex items-center justify-center mx-auto shadow-inner">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-8 h-8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold font-['Lora'] text-[#0E3D4D]">Tudo em Dia!</h2>
        <p className="text-sm text-gray-500 max-w-sm">
          Você está em dia com seus flashcards! Não há cartões pendentes de revisão para hoje.
        </p>
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={() => router.push('/')}
            className="px-6 py-2.5 bg-[#0E3D4D] hover:bg-[#17607A] text-white text-xs font-bold rounded-lg transition-all shadow-sm"
          >
            Voltar ao Início
          </button>
        </div>
      </div>
    );
  }

  const activeCard = cardsList[currentIndex];
  if (!activeCard) return null;

  return (
    <div className="max-w-2xl mx-auto px-4 py-12 pb-24 font-['Poppins'] text-[#1B2A33] flex flex-col items-center min-h-[80vh] justify-between">
      
      {/* Progress header */}
      <header className="w-full text-center space-y-1.5">
        <span className="text-[10px] uppercase font-extrabold tracking-widest text-[#B5502B]">Sessão de Repetição Espaçada</span>
        <h1 className="text-2xl font-bold font-['Lora'] text-[#0E3D4D]">
          Card {currentIndex + 1} de {cardsList.length}
        </h1>
        
        {/* Progress bar */}
        <div className="w-full bg-[#EAE3D5] h-1.5 rounded-full overflow-hidden border">
          <div 
            className="bg-[#17607A] h-full rounded-full transition-all duration-300"
            style={{ width: `${((currentIndex + 1) / cardsList.length) * 100}%` }}
          />
        </div>
      </header>

      {/* Interactive flashcard deck card */}
      <div 
        role="button"
        tabIndex={0}
        aria-label="Flashcard interativo"
        onClick={handleFlip}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleFlip();
          }
        }}
        className={`w-full min-h-[280px] md:min-h-[320px] bg-white rounded-2xl border border-gray-200/80 shadow-md p-8 flex flex-col justify-between cursor-pointer transition-all duration-300 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[#17607A] ${
          showVerso ? 'bg-gradient-to-b from-white to-[#FBF8F3] border-[#0E3D4D]/25 ring-2 ring-[#0E3D4D]/5' : ''
        }`}
      >
        {/* Meta info of card */}
        <div className="flex justify-between items-center text-[10px] uppercase font-bold text-gray-400">
          <span>Tópico: {activeCard.topicoNome}</span>
          <span 
            className="px-2 py-0.5 rounded text-white border"
            style={{ backgroundColor: activeCard.corHex, borderColor: 'rgba(255,255,255,0.2)' }}
          >
            {activeCard.disciplinaNome}
          </span>
        </div>

        {/* Content Body */}
        <div className="flex-1 flex items-center justify-center py-6">
          <p className="font-['Lora'] text-base md:text-lg text-center leading-relaxed font-lora-read text-[#1B2A33]">
            {showVerso ? activeCard.verso : activeCard.frente}
          </p>
        </div>

        {/* Card flip prompt */}
        <div className="text-center">
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">
            {showVerso ? 'Clique para ver a Pergunta' : 'Clique ou pressione Espaço para Revelar a Resposta'}
          </span>
        </div>
      </div>

      {/* FSRS Rating Options panel */}
      <div className="w-full space-y-4">
        {showVerso ? (
          <div className="space-y-2">
            <span className="block text-[10px] font-bold text-center text-gray-400 uppercase tracking-widest">Qual foi sua facilidade?</span>
            <fieldset disabled={salvando} className="grid grid-cols-4 gap-2.5 disabled:opacity-60">
              <button
                type="button"
                onClick={() => handleAnswer('again')}
                aria-keyshortcuts="1"
                className="py-3 bg-rose-500 hover:bg-rose-600 text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 text-center flex flex-col items-center justify-center gap-1"
              >
                <div className="flex items-center gap-1">
                  <span>Errei</span>
                  <span className="hidden sm:inline-block px-1 py-0.2 text-[9px] bg-black/20 rounded font-mono">1</span>
                </div>
                <span className="text-[8px] font-medium opacity-80">(Novamente)</span>
              </button>
              
              <button
                type="button"
                onClick={() => handleAnswer('hard')}
                aria-keyshortcuts="2"
                className="py-3 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 text-center flex flex-col items-center justify-center gap-1"
              >
                <div className="flex items-center gap-1">
                  <span>Difícil</span>
                  <span className="hidden sm:inline-block px-1 py-0.2 text-[9px] bg-black/20 rounded font-mono">2</span>
                </div>
                <span className="text-[8px] font-medium opacity-80">(Revisar mais)</span>
              </button>

              <button
                type="button"
                onClick={() => handleAnswer('good')}
                aria-keyshortcuts="3"
                className="py-3 bg-[#17607A] hover:bg-[#124b61] text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 text-center flex flex-col items-center justify-center gap-1"
              >
                <div className="flex items-center gap-1">
                  <span>Bom</span>
                  <span className="hidden sm:inline-block px-1 py-0.2 text-[9px] bg-black/20 rounded font-mono">3</span>
                </div>
                <span className="text-[8px] font-medium opacity-80">(Normal)</span>
              </button>

              <button
                type="button"
                onClick={() => handleAnswer('easy')}
                aria-keyshortcuts="4"
                className="py-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 text-center flex flex-col items-center justify-center gap-1"
              >
                <div className="flex items-center gap-1">
                  <span>Fácil</span>
                  <span className="hidden sm:inline-block px-1 py-0.2 text-[9px] bg-black/20 rounded font-mono">4</span>
                </div>
                <span className="text-[8px] font-medium opacity-80">(Espaçar)</span>
              </button>
            </fieldset>
            {salvando && <p className="text-xs text-center text-gray-500">Salvando revisão...</p>}
            {erroPersistencia && (
              <p role="alert" className="text-xs text-center text-rose-600">{erroPersistencia}</p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={handleFlip}
            className="w-full py-3.5 bg-[#0E3D4D] hover:bg-[#17607A] text-white text-xs font-bold rounded-xl shadow-md transition-all active:scale-98 text-center flex items-center justify-center gap-2"
          >
            <span>Mostrar Resposta</span>
            <span className="hidden sm:inline-block px-1.5 py-0.5 text-[9px] bg-white/20 rounded font-mono text-white/90">Espaço / Enter</span>
          </button>
        )}
      </div>

    </div>
  );
}