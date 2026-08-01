'use client';

import { useState, useEffect, useRef } from 'react';
import { obterCardsParaRevisao, registrarRevisaoCard } from '../app/actions/fsrs';

export default function RevisaoPage() {
  const [cardsList, setCardsList] = useState<any[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [showVerso, setShowVerso] = useState<boolean>(false);
  const [concluido, setConcluido] = useState<boolean>(false);
  
  // Timer for active card review duration
  const cardShownTimestamp = useRef<number>(Date.now());

  useEffect(() => {
    async function loadCards() {
      try {
        const res = await obterCardsParaRevisao();
        setCardsList(res);
        cardShownTimestamp.current = Date.now();
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadCards();
  }, []);

  const handleFlip = () => {
    setShowVerso(prev => !prev);
  };

  const handleAnswer = async (rating: 'again' | 'hard' | 'good' | 'easy') => {
    const activeCard = cardsList[currentIndex];
    if (!activeCard) return;

    const duracaoMs = Date.now() - cardShownTimestamp.current;

    // Move to next card immediately on frontend for snappiness
    const isLast = currentIndex === cardsList.length - 1;
    
    if (isLast) {
      setConcluido(true);
    } else {
      setCurrentIndex(prev => prev + 1);
      setShowVerso(false);
      cardShownTimestamp.current = Date.now();
    }

    // Call backend mutation in background
    try {
      await registrarRevisaoCard(activeCard.id, rating, duracaoMs);
    } catch (err) {
      console.error('Erro ao registrar revisão de card:', err);
    }
  };

  if (loading) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 flex flex-col items-center justify-center min-h-[60vh] font-['Poppins']">
        <div className="w-8 h-8 border-4 border-[#0E3D4D] border-t-transparent rounded-full animate-spin"></div>
        <p className="text-xs font-semibold text-[#0E3D4D] mt-3">Carregando seus cartões de revisão...</p>
      </div>
    );
  }

  if (concluido || cardsList.length === 0) {
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
          onClick={() => window.location.href = '/'}
          className="px-6 py-2.5 bg-[#0E3D4D] hover:bg-[#17607A] text-white text-xs font-bold rounded-lg transition-all"
        >
          Voltar ao Início
        </button>
      </div>
    );
  }

  const activeCard = cardsList[currentIndex];

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
        onClick={handleFlip}
        className={`w-full min-h-[280px] md:min-h-[320px] bg-white rounded-2xl border border-gray-200/80 shadow-md p-8 flex flex-col justify-between cursor-pointer transition-all duration-300 hover:shadow-lg ${
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
            {showVerso ? 'Clique para ver a Pergunta' : 'Clique para Revelar a Resposta'}
          </span>
        </div>
      </div>

      {/* FSRS Rating Options panel */}
      <div className="w-full space-y-4">
        {showVerso ? (
          <div className="space-y-2">
            <span className="block text-[10px] font-bold text-center text-gray-400 uppercase tracking-widest">Qual foi sua facilidade?</span>
            <div className="grid grid-cols-4 gap-2.5">
              <button
                onClick={() => handleAnswer('again')}
                className="py-3 bg-rose-500 hover:bg-rose-600 text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 text-center flex flex-col items-center justify-center gap-1"
              >
                <span>Errei</span>
                <span className="text-[8px] font-medium opacity-80">(Novamente)</span>
              </button>
              
              <button
                onClick={() => handleAnswer('hard')}
                className="py-3 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 text-center flex flex-col items-center justify-center gap-1"
              >
                <span>Difícil</span>
                <span className="text-[8px] font-medium opacity-80">(Revisar mais)</span>
              </button>

              <button
                onClick={() => handleAnswer('good')}
                className="py-3 bg-[#17607A] hover:bg-[#124b61] text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 text-center flex flex-col items-center justify-center gap-1"
              >
                <span>Bom</span>
                <span className="text-[8px] font-medium opacity-80">(Normal)</span>
              </button>

              <button
                onClick={() => handleAnswer('easy')}
                className="py-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 text-center flex flex-col items-center justify-center gap-1"
              >
                <span>Fácil</span>
                <span className="text-[8px] font-medium opacity-80">(Espaçar)</span>
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={handleFlip}
            className="w-full py-3.5 bg-[#0E3D4D] hover:bg-[#17607A] text-white text-xs font-bold rounded-xl shadow-md transition-all active:scale-98 text-center"
          >
            Mostrar Resposta
          </button>
        )}
      </div>

    </div>
  );
}
