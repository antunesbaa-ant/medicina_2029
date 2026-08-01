'use client';

import { useState, useEffect } from 'react';
import { obterLacunasEstudo, obterResumoAprovado } from '../app/actions/lacunas';

export default function LacunasPage() {
  const [lacunas, setLacunas] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Modal summary preview state
  const [previewTopicoNome, setPreviewTopicoNome] = useState<string | null>(null);
  const [previewResumo, setPreviewResumo] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);

  useEffect(() => {
    async function loadLacunas() {
      try {
        const data = await obterLacunasEstudo();
        setLacunas(data);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadLacunas();
  }, []);

  const openResumoModal = async (topicoId: string, topicoNome: string) => {
    setPreviewTopicoNome(topicoNome);
    setPreviewLoading(true);
    try {
      const res = await obterResumoAprovado(topicoId);
      setPreviewResumo(res);
    } catch (err) {
      console.error(err);
    } finally {
      setPreviewLoading(false);
    }
  };

  const closeResumoModal = () => {
    setPreviewTopicoNome(null);
    setPreviewResumo(null);
  };

  const getTipoErroLabel = (tipo: string) => {
    switch (tipo) {
      case 'conteudo': return 'Lacuna de Conteúdo (Teoria)';
      case 'calculo': return 'Dificuldade de Cálculo';
      case 'interpretacao': return 'Erro de Interpretação';
      case 'distracao': return 'Distração / Falta de Atenção';
      case 'tempo': return 'Estouro de Tempo';
      default: return tipo;
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 pb-24 font-['Poppins'] text-[#1B2A33]">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-bold font-['Lora'] text-[#0E3D4D]">Painel de Lacunas</h1>
        <p className="text-sm text-gray-500 mt-1">
          Identifique tópicos críticos com alta incidência de erros. Acesse resumos curados e questões direcionadas para remediação.
        </p>
      </header>

      {loading ? (
        <p className="text-sm text-gray-400 text-center">Carregando lacunas de estudo...</p>
      ) : lacunas.length === 0 ? (
        <div className="bg-white p-12 text-center rounded-lg border border-gray-200 shadow-sm">
          <p className="text-sm font-semibold text-gray-500">Excelente! Nenhuma lacuna crítica de conhecimento detectada.</p>
          <p className="text-xs text-gray-400 mt-1">Gaps aparecem conforme erros são registrados em simulados ou sessões de estudo.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {lacunas.map((lac) => (
            <div 
              key={lac.topicoId}
              className="bg-white p-6 rounded-lg border border-gray-200/80 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4 transition-all hover:border-gray-300"
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span 
                    className="w-3 h-3 rounded-full border border-white/20" 
                    style={{ backgroundColor: lac.corHex }}
                  />
                  <span className="text-xs font-semibold text-gray-400">{lac.disciplinaNome}</span>
                </div>
                <h3 className="text-base font-bold text-[#0E3D4D] font-['Lora'] leading-tight">
                  {lac.topicoNome}
                </h3>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="bg-rose-500/10 text-rose-600 font-semibold px-2 py-0.5 rounded border border-rose-500/20">
                    {lac.totalErros} erros registrados
                  </span>
                  <span className="bg-amber-500/10 text-amber-600 font-semibold px-2 py-0.5 rounded border border-amber-500/20">
                    Predomínio: {getTipoErroLabel(lac.tipoErroFrequente)}
                  </span>
                </div>
              </div>

              {/* Remediation triggers */}
              <div className="flex gap-2 w-full md:w-auto">
                {lac.temResumoAprovado ? (
                  <button
                    onClick={() => openResumoModal(lac.topicoId, lac.topicoNome)}
                    className="flex-1 md:flex-none px-4 py-2 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg hover:bg-[#17607A] transition-all text-center"
                  >
                    Ler Resumo
                  </button>
                ) : (
                  <span className="text-xs text-gray-400 font-medium italic border border-dashed rounded-lg px-3 py-2 bg-gray-50 flex-1 md:flex-none text-center">
                    Resumo indisponível
                  </span>
                )}

                {lac.totalQuestoesDisponiveis > 0 && (
                  <button
                    onClick={() => window.location.href = `/busca?query=${encodeURIComponent(lac.topicoNome)}`}
                    className="flex-1 md:flex-none px-4 py-2 bg-[#FBF8F3] hover:bg-[#F1EFEA] border border-[#D5CBB8] text-[#0E3D4D] text-xs font-bold rounded-lg transition-all text-center"
                  >
                    Estudar Questões ({lac.totalQuestoesDisponiveis})
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Summary Modal Previewer */}
      {previewTopicoNome && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-gray-200 max-w-2xl w-full p-6 space-y-4 shadow-xl max-h-[85vh] flex flex-col">
            <div className="flex justify-between items-start border-b pb-3">
              <div>
                <span className="text-[10px] uppercase font-bold tracking-widest text-[#B5502B]">Material de Apoio Curado</span>
                <h2 className="text-lg font-bold font-['Lora'] text-[#0E3D4D] mt-1 leading-tight">{previewTopicoNome}</h2>
              </div>
              <button 
                onClick={closeResumoModal}
                className="text-gray-400 hover:text-gray-600 text-lg font-semibold"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto pr-2 text-sm leading-relaxed text-[#1B2A33] font-['Lora'] whitespace-pre-wrap">
              {previewLoading ? (
                <p className="text-sm text-gray-400">Buscando resumo consolidado...</p>
              ) : previewResumo ? (
                <div>
                  <h3 className="font-bold text-base text-[#0E3D4D] mb-3">{previewResumo.titulo}</h3>
                  <p>{previewResumo.corpo}</p>
                </div>
              ) : (
                <p className="text-sm text-gray-400 italic">Nenhum resumo disponível para este tópico no momento.</p>
              )}
            </div>

            <div className="pt-3 border-t flex justify-end">
              <button
                onClick={closeResumoModal}
                className="px-5 py-2 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg hover:bg-[#17607A]"
              >
                Concluir Leitura
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
