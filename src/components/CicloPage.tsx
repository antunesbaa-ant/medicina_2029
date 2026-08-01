'use client';

import { useState, useEffect } from 'react';
import { CicloAtivoData, obterCicloAtivo } from '../app/actions/ciclo';
import Link from 'next/link';

interface CicloPageProps {
  dadosIniciais: CicloAtivoData | null;
}

export default function CicloPage({ dadosIniciais }: CicloPageProps) {
  const [ciclo, setCiclo] = useState<CicloAtivoData | null>(dadosIniciais);
  const [proximaOrdem, setProximaOrdem] = useState<number>(dadosIniciais?.proximaOrdem ?? 1);
  const [loading, setLoading] = useState<boolean>(false);

  // Carregar dados de progresso e ponteiro local
  useEffect(() => {
    const localOrdem = localStorage.getItem('medicina_2029_proxima_ordem');
    if (localOrdem) {
      setProximaOrdem(parseInt(localOrdem, 10));
    }
  }, []);

  const handleResetCiclo = () => {
    const confirmar = confirm('Deseja reiniciar a fila do ciclo de estudos de volta ao bloco 1?');
    if (!confirmar) return;
    
    localStorage.setItem('medicina_2029_proxima_ordem', '1');
    setProximaOrdem(1);
  };

  const handleAvancarCiclo = () => {
    const total = ciclo?.blocos.length || 12;
    const proxima = proximaOrdem >= total ? 1 : proximaOrdem + 1;
    localStorage.setItem('medicina_2029_proxima_ordem', proxima.toString());
    setProximaOrdem(proxima);
  };

  const handleRetrocederCiclo = () => {
    const total = ciclo?.blocos.length || 12;
    const anterior = proximaOrdem <= 1 ? total : proximaOrdem - 1;
    localStorage.setItem('medicina_2029_proxima_ordem', anterior.toString());
    setProximaOrdem(anterior);
  };

  const blocos = ciclo?.blocos ?? [];
  const proximoBloco = blocos.find((b) => b.ordem === proximaOrdem) || blocos[0] || null;

  // Tradução do tipo de bloco
  const getTipoLabel = (tipo: string) => {
    switch (tipo) {
      case 'conteudo': return 'Teoria';
      case 'questoes': return 'Questões';
      case 'redacao': return 'Redação';
      case 'caderno_erros': return 'Erros';
      case 'revisao_srs': return 'FSRS/Anki';
      case 'lingua_estrangeira': return 'Estrang.';
      default: return tipo;
    }
  };

  return (
    <div className="w-full max-w-md md:max-w-4xl mx-auto bg-transparent min-h-screen pb-24 px-4 pt-6 select-none font-poppins">
      
      {/* Header Sóbrio */}
      <header className="mb-6 flex justify-between items-center">
        <div>
          <span className="text-[10px] uppercase font-bold tracking-widest text-[#6A7D87]">Estrutura de Fila</span>
          <h1 className="text-2xl font-bold text-[#0E3D4D] tracking-tight">Ciclo Ativo</h1>
          <p className="text-xs text-[#6A7D87] font-semibold mt-0.5">{ciclo?.ciclo.nome ?? 'Carregando Ciclo...'}</p>
        </div>
      </header>

      {/* Grid responsivo para PC */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        
        {/* Coluna Esquerda: Ponteiro e Controles (5 cols no md) */}
        <div className="md:col-span-5 space-y-5">
          <section className="bg-white border border-[#EAE3D5] rounded-2xl p-5 shadow-sm">
            <div className="flex justify-between items-center border-b border-[#F1EFEA] pb-3 mb-3">
              <div>
                <span className="text-[10px] uppercase font-bold tracking-wider text-[#6A7D87]">Ponteiro de Execução</span>
                <span className="block text-xs font-bold text-[#0E3D4D] mt-0.5">
                  Bloco {proximaOrdem} de {blocos.length}
                </span>
              </div>
              
              {/* Controles de Ponteiro manual */}
              <div className="flex gap-1.5">
                <button
                  onClick={handleRetrocederCiclo}
                  title="Voltar bloco anterior"
                  className="w-9 h-9 border border-[#D5CBB8] rounded-lg flex items-center justify-center text-[#6A7D87] hover:text-[#0E3D4D] bg-[#FBF8F3] active:scale-90 transition-transform"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  onClick={handleAvancarCiclo}
                  title="Avançar próximo bloco"
                  className="w-9 h-9 border border-[#D5CBB8] rounded-lg flex items-center justify-center text-[#6A7D87] hover:text-[#0E3D4D] bg-[#FBF8F3] active:scale-90 transition-transform"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                <button
                  onClick={handleResetCiclo}
                  title="Reiniciar Ciclo"
                  className="w-9 h-9 border border-red-200 text-[#B5502B] rounded-lg flex items-center justify-center hover:bg-red-50 bg-[#FBF8F3] active:scale-90 transition-transform"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 7.89M9 9H4" />
                  </svg>
                </button>
              </div>
            </div>

            {proximoBloco && (
              <div className="bg-[#FBF8F3] border border-[#EAE3D5] rounded-xl p-4 flex justify-between items-center">
                <div>
                  <span className="text-[10px] uppercase font-bold tracking-widest text-[#B5502B]">Foco de Estudo</span>
                  <h3 className="text-base font-bold text-[#0E3D4D] leading-tight font-lora-read mt-0.5">
                    {proximoBloco.disciplina.nome}
                  </h3>
                  <div className="flex gap-2 items-center mt-1 text-[10px] font-semibold text-[#6A7D87]">
                    <span>{getTipoLabel(proximoBloco.tipo).toUpperCase()}</span>
                    <span>•</span>
                    <span className="text-[#C98A2E]">{proximoBloco.estiloAlvo.toUpperCase()}</span>
                  </div>
                </div>
                <Link
                  href={`/estudar?blocoId=${proximoBloco.id}`}
                  className="h-10 px-4 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg flex items-center justify-center shadow hover:bg-[#17607A] active:scale-[0.96] transition-transform min-h-[40px]"
                >
                  Estudar
                </Link>
              </div>
            )}
          </section>
        </div>

        {/* Coluna Direita: Fila Sequencial (7 cols no md) */}
        <div className="md:col-span-7">
          <section className="space-y-2.5">
            <span className="text-[10px] uppercase font-bold tracking-widest text-[#6A7D87] block mb-2 px-1">Fila Sequencial de Estudos</span>
            
            {blocos.map((bloco) => {
              const isNext = bloco.ordem === proximaOrdem;
              const isCompleted = bloco.ordem < proximaOrdem;
              
              return (
                <div
                  key={bloco.id}
                  className={`border rounded-xl p-3.5 flex items-center justify-between transition-all ${
                    isNext
                      ? 'bg-white border-[#17607A] shadow-sm ring-1 ring-[#17607A]/30'
                      : isCompleted
                        ? 'bg-white/60 border-[#EAE3D5] opacity-75'
                        : 'bg-white border-[#EAE3D5]'
                  }`}
                >
                  <div className="flex items-center gap-3.5">
                    {/* Indicador de Ordem / Conclusão */}
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
                      isNext
                        ? 'bg-[#17607A] text-white'
                        : isCompleted
                          ? 'bg-[#EAE3D5] text-[#6A7D87]'
                          : 'bg-[#FBF8F3] text-[#1B2A33] border border-[#EAE3D5]'
                    }`}>
                      {isCompleted ? (
                        <svg className="w-4 h-4 text-[#0E3D4D]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        bloco.ordem.toString().padStart(2, '0')
                      )}
                    </div>

                    <div>
                      <div className="flex items-center gap-1.5">
                        <h4 className="text-sm font-bold text-[#1B2A33] font-lora-read">
                          {bloco.disciplina.nome}
                        </h4>
                        
                        {/* Tag de Próximo bloco */}
                        {isNext && (
                          <span className="bg-[#B5502B] text-white text-[8px] font-extrabold px-1.5 py-0.5 rounded uppercase tracking-wider">
                            A Seguir
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2 items-center text-[10px] font-semibold text-[#6A7D87] mt-0.5">
                        <span>{getTipoLabel(bloco.tipo)}</span>
                        <span>•</span>
                        <span className="text-[#C98A2E]">{bloco.estiloAlvo.toUpperCase()}</span>
                      </div>
                    </div>
                  </div>

                  {/* Informações Auxiliares do Bloco */}
                  <div className="text-right">
                    <span className="text-xs font-bold text-[#0E3D4D] block">
                      {bloco.duracaoMin}m
                    </span>
                    <span 
                      className="inline-block w-2.5 h-2.5 rounded-full border border-white/20 mt-1" 
                      style={{ backgroundColor: bloco.disciplina.corHex }}
                      title={bloco.disciplina.nome}
                    />
                  </div>
                </div>
              );
            })}
          </section>
        </div>

      </div>

    </div>
  );
}
