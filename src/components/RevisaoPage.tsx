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

  // Temporizador defensivo de tempo ativo de revisão (sem inflação por abas inativas)
  const activeTimeMsRef = useRef<number>(0);
  const lastVisibleTimestampRef = useRef<number>(0);
  const isTabVisibleRef = useRef<boolean>(true);

  // Limite máximo de contagem contínua sem interação por cartão (120s / 2 minutos)
  // e teto defensivo absoluto de estudo efetivo por cartão (300s / 5 minutos)
  const MAX_ACTIVE_SPAN_MS = 120_000;
  const MAX_CARD_STUDY_TIME_MS = 300_000;

  const resetCardTimer = useCallback(() => {
    activeTimeMsRef.current = 0;
    lastVisibleTimestampRef.current = Date.now();
    isTabVisibleRef.current = typeof document !== 'undefined' ? !document.hidden : true;
  }, []);

  const accumulateVisibleTime = useCallback(() => {
    if (isTabVisibleRef.current && lastVisibleTimestampRef.current > 0) {
      const now = Date.now();
      const elapsed = now - lastVisibleTimestampRef.current;
      activeTimeMsRef.current += Math.max(0, Math.min(elapsed, MAX_ACTIVE_SPAN_MS));
      lastVisibleTimestampRef.current = now;
    }
  }, [MAX_ACTIVE_SPAN_MS]);

  // Escuta visibilidade da aba (visibilitychange) e foco da janela para pausar/retomar tempo
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        accumulateVisibleTime();
        isTabVisibleRef.current = false;
      } else {
        isTabVisibleRef.current = true;
        lastVisibleTimestampRef.current = Date.now();
      }
    };

    const handleWindowBlur = () => {
      accumulateVisibleTime();
      isTabVisibleRef.current = false;
    };

    const handleWindowFocus = () => {
      isTabVisibleRef.current = true;
      lastVisibleTimestampRef.current = Date.now();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [accumulateVisibleTime]);

  const carregarCards = useCallback(async () => {
    setLoading(true);
    setErroCarregamento(null);
    try {
      const res = await obterCardsParaRevisao();
      setCardsList(res);
      resetCardTimer();
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
  }, [resetCardTimer]);

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

      // Consolida o tempo visível até este exato momento
      accumulateVisibleTime();

      // Aplica proteção defensiva:
      // 1. Garante mínimo de 1ms exigido pelo schema
      // 2. Teto de estudo ativo (5 minutos) para não computar inatividade espúria
      // 3. Respeita com folga o limite máximo do backend (3.600.000 ms)
      const duracaoMs = Math.max(
        1,
        Math.min(MAX_CARD_STUDY_TIME_MS, activeTimeMsRef.current || 1)
      );

      setSalvando(true);
      setErroPersistencia(null);
      try {
        const resultado = await registrarRevisaoCard(activeCard.id, rating, duracaoMs);
        if (!resultado.sucesso) {
          setErroPersistencia(resultado.mensagem);
          resetCardTimer();
          return;
        }

        const isLast = currentIndex === cardsList.length - 1;
        if (isLast) {
          setConcluido(true);
        } else {
          setCurrentIndex(prev => prev + 1);
          setShowVerso(false);
          resetCardTimer();
        }
      } catch {
        setErroPersistencia('Não foi possível registrar a revisão. Tente novamente.');
        resetCardTimer();
      } finally {
        setSalvando(false);
      }
    },
    [cardsList, currentIndex, salvando, accumulateVisibleTime, resetCardTimer, MAX_CARD_STUDY_TIME_MS]
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
        <div className="w-8 h-8 border-4 border-[#0E3D4D] dark:border-[#38A3C5] border-t-transparent rounded-full animate-spin"></div>
        <p className="text-xs font-semibold text-[#0E3D4D] dark:text-[#E0EBF0] mt-3">Carregando seus cartões de revisão...</p>
      </div>
    );
  }

  if (erroCarregamento) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 flex flex-col items-center justify-center min-h-[60vh] font-['Poppins'] text-center space-y-4">
        <div className="w-16 h-16 bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 rounded-full flex items-center justify-center mx-auto shadow-inner">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-8 h-8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold font-['Lora'] text-[#0E3D4D] dark:text-[#E0EBF0]">Falha no Carregamento</h2>
        <p className="text-sm text-gray-600 dark:text-gray-300 max-w-sm">
          {erroCarregamento}
        </p>
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={() => carregarCards()}
            className="px-6 py-2.5 bg-[#0E3D4D] hover:bg-[#17607A] dark:bg-[#17607A] dark:hover:bg-[#1f7391] text-white text-xs font-bold rounded-lg transition-all shadow-sm"
          >
            Tentar Novamente
          </button>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-bold rounded-lg transition-all"
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
        <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 rounded-full flex items-center justify-center mx-auto shadow-inner">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-8 h-8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold font-['Lora'] text-[#0E3D4D] dark:text-[#E0EBF0]">Revisões Concluídas!</h2>
        <p className="text-sm text-gray-600 dark:text-gray-300 max-w-sm">
          Excelente trabalho! Você concluiu todos os cartões programados para hoje. Seus intervalos de repetição FSRS foram recalculados.
        </p>
        <button
          onClick={() => router.push('/')}
          className="px-6 py-2.5 bg-[#0E3D4D] hover:bg-[#17607A] dark:bg-[#17607A] dark:hover:bg-[#1f7391] text-white text-xs font-bold rounded-lg transition-all shadow-sm"
        >
          Voltar ao Início
        </button>
      </div>
    );
  }

  if (cardsList.length === 0) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 flex flex-col items-center justify-center min-h-[60vh] font-['Poppins'] text-center space-y-4">
        <div className="w-16 h-16 bg-[#17607A]/10 border border-[#17607A]/20 text-[#17607A] dark:text-[#38A3C5] rounded-full flex items-center justify-center mx-auto shadow-inner">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-8 h-8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold font-['Lora'] text-[#0E3D4D] dark:text-[#E0EBF0]">Tudo em Dia!</h2>
        <p className="text-sm text-gray-600 dark:text-gray-300 max-w-sm">
          Você está em dia com seus flashcards! Não há cartões pendentes de revisão para hoje.
        </p>
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={() => router.push('/')}
            className="px-6 py-2.5 bg-[#0E3D4D] hover:bg-[#17607A] dark:bg-[#17607A] dark:hover:bg-[#1f7391] text-white text-xs font-bold rounded-lg transition-all shadow-sm"
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
    <div className="max-w-2xl mx-auto px-4 py-12 pb-24 font-['Poppins'] text-[#1B2A33] dark:text-[#F5F7F8] flex flex-col items-center min-h-[80vh] justify-between">
      
      {/* Progress header */}
      <header className="w-full text-center space-y-1.5">
        <span className="text-[10px] uppercase font-extrabold tracking-widest text-[#B5502B] dark:text-[#E07A5F]">Sessão de Repetição Espaçada</span>
        <h1 className="text-2xl font-bold font-['Lora'] text-[#0E3D4D] dark:text-[#E0EBF0]">
          Card {currentIndex + 1} de {cardsList.length}
        </h1>
        
        {/* Progress bar */}
        <div className="w-full bg-[#EAE3D5] dark:bg-gray-700/80 h-1.5 rounded-full overflow-hidden border border-gray-300/40 dark:border-gray-600">
          <div 
            className="bg-[#17607A] dark:bg-[#38A3C5] h-full rounded-full transition-all duration-300"
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
        className={`w-full min-h-[280px] md:min-h-[320px] bg-white dark:bg-[#24353F] rounded-2xl border border-gray-200/80 dark:border-gray-700 shadow-md p-8 flex flex-col justify-between cursor-pointer transition-all duration-300 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[#17607A] dark:focus:ring-[#38A3C5] ${
          showVerso
            ? 'bg-gradient-to-b from-white to-[#FBF8F3] dark:from-[#24353F] dark:to-[#1B2A33] border-[#0E3D4D]/25 dark:border-[#38A3C5]/40 ring-2 ring-[#0E3D4D]/5 dark:ring-[#38A3C5]/10'
            : ''
        }`}
      >
        {/* Meta info of card */}
        <div className="flex justify-between items-center text-[10px] uppercase font-bold text-gray-600 dark:text-gray-300">
          <span className="font-semibold text-gray-700 dark:text-gray-200">Tópico: {activeCard.topicoNome}</span>
          <span 
            className="px-2.5 py-0.5 rounded text-white font-bold border shadow-xs"
            style={{ backgroundColor: activeCard.corHex, borderColor: 'rgba(255,255,255,0.3)' }}
          >
            {activeCard.disciplinaNome}
          </span>
        </div>

        {/* Content Body */}
        <div className="flex-1 flex items-center justify-center py-6">
          <p className="font-['Lora'] text-base md:text-lg text-center leading-relaxed font-lora-read text-[#1B2A33] dark:text-[#F5F7F8] font-medium selection:bg-[#17607A]/20">
            {showVerso ? activeCard.verso : activeCard.frente}
          </p>
        </div>

        {/* Card flip prompt */}
        <div className="text-center">
          <span className="text-[10px] font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wide">
            {showVerso ? 'Clique para ver a Pergunta' : 'Clique ou pressione Espaço para Revelar a Resposta'}
          </span>
        </div>
      </div>

      {/* FSRS Rating Options panel */}
      <div className="w-full space-y-4">
        {showVerso ? (
          <div className="space-y-2">
            <span className="block text-[10px] font-bold text-center text-gray-700 dark:text-gray-300 uppercase tracking-widest">Qual foi sua facilidade?</span>
            <fieldset disabled={salvando} className="grid grid-cols-4 gap-2.5 disabled:opacity-60">
              <button
                type="button"
                onClick={() => handleAnswer('again')}
                aria-keyshortcuts="1"
                className="py-3 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 text-center flex flex-col items-center justify-center gap-1 focus:outline-none focus:ring-2 focus:ring-rose-400"
              >
                <div className="flex items-center gap-1">
                  <span>Errei</span>
                  <span className="hidden sm:inline-block px-1 py-0.2 text-[9px] bg-black/30 text-white rounded font-mono">1</span>
                </div>
                <span className="text-[8px] font-medium text-white/90">(Novamente)</span>
              </button>
              
              <button
                type="button"
                onClick={() => handleAnswer('hard')}
                aria-keyshortcuts="2"
                className="py-3 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 text-center flex flex-col items-center justify-center gap-1 focus:outline-none focus:ring-2 focus:ring-amber-400"
              >
                <div className="flex items-center gap-1">
                  <span>Difícil</span>
                  <span className="hidden sm:inline-block px-1 py-0.2 text-[9px] bg-black/30 text-white rounded font-mono">2</span>
                </div>
                <span className="text-[8px] font-medium text-white/90">(Revisar mais)</span>
              </button>

              <button
                type="button"
                onClick={() => handleAnswer('good')}
                aria-keyshortcuts="3"
                className="py-3 bg-[#17607A] hover:bg-[#124b61] dark:bg-[#1f7391] dark:hover:bg-[#17607A] text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 text-center flex flex-col items-center justify-center gap-1 focus:outline-none focus:ring-2 focus:ring-[#38A3C5]"
              >
                <div className="flex items-center gap-1">
                  <span>Bom</span>
                  <span className="hidden sm:inline-block px-1 py-0.2 text-[9px] bg-black/30 text-white rounded font-mono">3</span>
                </div>
                <span className="text-[8px] font-medium text-white/90">(Normal)</span>
              </button>

              <button
                type="button"
                onClick={() => handleAnswer('easy')}
                aria-keyshortcuts="4"
                className="py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 text-center flex flex-col items-center justify-center gap-1 focus:outline-none focus:ring-2 focus:ring-emerald-400"
              >
                <div className="flex items-center gap-1">
                  <span>Fácil</span>
                  <span className="hidden sm:inline-block px-1 py-0.2 text-[9px] bg-black/30 text-white rounded font-mono">4</span>
                </div>
                <span className="text-[8px] font-medium text-white/90">(Espaçar)</span>
              </button>
            </fieldset>
            {salvando && <p className="text-xs text-center text-gray-500 dark:text-gray-400">Salvando revisão...</p>}
            {erroPersistencia && (
              <p role="alert" className="text-xs text-center text-rose-600 dark:text-rose-400 font-medium">{erroPersistencia}</p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={handleFlip}
            className="w-full py-3.5 bg-[#0E3D4D] hover:bg-[#17607A] dark:bg-[#17607A] dark:hover:bg-[#1f7391] text-white text-xs font-bold rounded-xl shadow-md transition-all active:scale-98 text-center flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-[#38A3C5]"
          >
            <span>Mostrar Resposta</span>
            <span className="hidden sm:inline-block px-1.5 py-0.5 text-[9px] bg-white/20 rounded font-mono text-white/90">Espaço / Enter</span>
          </button>
        )}
      </div>

    </div>
  );
}
