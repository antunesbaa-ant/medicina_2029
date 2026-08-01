'use client';

import { useState, useEffect } from 'react';
import { obterMetricasDashboard, DashboardMetrics } from '../app/actions/dashboard';

export default function DashboardPage() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    async function loadMetrics() {
      try {
        const data = await obterMetricasDashboard();
        setMetrics(data);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadMetrics();
  }, []);

  if (loading || !metrics) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 flex flex-col items-center justify-center min-h-[60vh] font-['Poppins']">
        <div className="w-8 h-8 border-4 border-[#0E3D4D] border-t-transparent rounded-full animate-spin"></div>
        <p className="text-xs font-semibold text-[#0E3D4D] mt-3">Calculando métricas derivadas de desempenho...</p>
      </div>
    );
  }

  const getTipoErroLabel = (tipo: string) => {
    switch (tipo) {
      case 'conteudo': return 'Conceitual / Teoria';
      case 'calculo': return 'Falta de Atenção em Cálculo';
      case 'interpretacao': return 'Erro de Interpretação';
      case 'distracao': return 'Distração / Pegadinha';
      case 'tempo': return 'Falta de tempo';
      default: return tipo;
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 pb-24 font-['Poppins'] text-[#1B2A33] space-y-8">
      
      {/* Header */}
      <header className="border-b pb-6 text-center md:text-left">
        <h1 className="text-3xl font-bold font-['Lora'] text-[#0E3D4D]">Painel Analítico de Desempenho</h1>
        <p className="text-sm text-gray-500 mt-1">
          Métricas derivadas e diagnósticos automáticos baseados nas sessões e tentativas de estudos da estudante.
        </p>
      </header>

      {/* Grid de Métricas Principais (3 cols no PC) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

        {/* 1. Aderência */}
        <section className={`bg-white p-6 rounded-2xl border shadow-sm flex flex-col justify-between transition-all hover:shadow-md ${
          metrics.aderencia.alerta ? 'border-rose-500/20 bg-rose-500/[0.01]' : 'border-gray-200'
        }`}>
          <div>
            <div className="flex justify-between items-start">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Aderência ao Ciclo</span>
              {metrics.aderencia.alerta && (
                <span className="bg-rose-500/10 text-rose-600 text-[9px] font-bold px-2 py-0.5 rounded border border-rose-500/20 uppercase">Alerta</span>
              )}
            </div>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="text-4xl font-extrabold text-[#0E3D4D]">{metrics.aderencia.valor}%</span>
              <span className="text-xs text-gray-400 font-medium">concluído</span>
            </div>
            <div className="w-full bg-gray-100 h-2 rounded-full mt-3 overflow-hidden">
              <div 
                className={`h-full rounded-full transition-all duration-500 ${
                  metrics.aderencia.alerta ? 'bg-rose-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${metrics.aderencia.valor}%` }}
              />
            </div>
          </div>
          <p className="text-[11px] text-gray-500 leading-relaxed mt-4 border-t pt-2.5">
            {metrics.aderencia.mensagem}
          </p>
        </section>

        {/* 2. Divergência de Trilhos (ENEM vs Conteudista) */}
        <section className={`bg-white p-6 rounded-2xl border shadow-sm flex flex-col justify-between transition-all hover:shadow-md lg:col-span-2 ${
          metrics.divergencia.alerta ? 'border-amber-500/20 bg-amber-500/[0.01]' : 'border-gray-200'
        }`}>
          <div>
            <div className="flex justify-between items-start border-b pb-2">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Divergência de Trilhos (Últimas 300 Questões)</span>
              {metrics.divergencia.alerta && (
                <span className="bg-amber-500/10 text-amber-600 text-[9px] font-bold px-2 py-0.5 rounded border border-amber-500/20 uppercase">Desvio Detectado</span>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
              <div className="text-center md:text-left">
                <span className="text-[10px] text-gray-400 block">Acerto ENEM</span>
                <span className="text-2xl font-bold text-[#17607A]">{metrics.divergencia.enemPct}%</span>
              </div>
              <div className="text-center md:text-left">
                <span className="text-[10px] text-gray-400 block">Acerto Conteudista</span>
                <span className="text-2xl font-bold text-[#B5502B]">{metrics.divergencia.conteudistaPct}%</span>
              </div>
              <div className="col-span-2 md:col-span-1 text-center md:text-right border-t md:border-t-0 pt-2.5 md:pt-0">
                <span className="text-[10px] text-gray-400 block">Divergência</span>
                <span className="text-2xl font-bold text-[#0E3D4D]">{metrics.divergencia.valor} pts</span>
              </div>
            </div>
          </div>

          <div className="mt-4 bg-[#FBF8F3] p-3 rounded-lg border text-xs">
            <strong className="text-[#0E3D4D] font-bold block mb-0.5">Diagnóstico Pedagógico:</strong>
            <p className="text-gray-600 leading-relaxed font-['Lora'] italic">"{metrics.divergencia.diagnostico}"</p>
          </div>
        </section>

      </div>

      {/* Grid Secundário */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* 3. Perfil de Erro (8 cols) */}
        <section className={`lg:col-span-8 bg-white p-6 rounded-2xl border shadow-sm space-y-4 ${
          metrics.perfilErro.alerta ? 'border-rose-500/20' : 'border-gray-200'
        }`}>
          <div className="flex justify-between items-center border-b pb-3">
            <div>
              <h3 className="text-base font-bold font-['Lora'] text-[#0E3D4D]">Distribuição dos Tipos de Erro</h3>
              <p className="text-[10px] text-gray-400 mt-0.5">Janela móvel de 90 dias</p>
            </div>
            {metrics.perfilErro.alerta && (
              <span className="bg-rose-500/10 text-rose-600 text-[9px] font-bold px-2.5 py-0.5 rounded border border-rose-500/20 uppercase">
                Concentração Alta (&gt;40%)
              </span>
            )}
          </div>

          <div className="space-y-4">
            {metrics.perfilErro.distribuicao.map((err, idx) => (
              <div key={idx} className="space-y-1.5">
                <div className="flex justify-between text-xs font-semibold">
                  <span className="text-gray-700">{getTipoErroLabel(err.tipo)}</span>
                  <span className="text-[#0E3D4D]">{err.porcentagem}% ({err.contagem} erros)</span>
                </div>
                <div className="w-full bg-gray-100 h-3 rounded-full overflow-hidden">
                  <div 
                    className={`h-full rounded-full transition-all duration-500 ${
                      err.porcentagem > 40 ? 'bg-rose-500' : 'bg-[#17607A]'
                    }`}
                    style={{ width: `${err.porcentagem}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          {metrics.perfilErro.alerta && (
            <div className="bg-rose-500/[0.02] border border-rose-500/25 p-3 rounded-xl text-xs text-rose-700 leading-relaxed font-medium">
              Atenção: A estudante está cometendo mais de 40% de erros associados a <strong>{getTipoErroLabel(metrics.perfilErro.tipoAlerta)}</strong>. Recomenda-se realizar revisões dedicadas e desacelerar a leitura de enunciados para conter reincidências de interpretação ou distração.
            </div>
          )}
        </section>

        {/* Outras Métricas Rápidas (4 cols) */}
        <div className="lg:col-span-4 space-y-6">

          {/* SRS Card Queue */}
          <section className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm flex items-center justify-between">
            <div>
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Fila de Revisão (Due)</span>
              <h4 className="text-2xl font-bold text-[#0E3D4D] mt-1">{metrics.filaRevisao.totalCardsDue} cards</h4>
              <span className="text-[10px] text-gray-400 mt-1 block">Aguardando no motor FSRS</span>
            </div>
            {metrics.filaRevisao.alerta && (
              <div className="w-12 h-12 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-600 flex items-center justify-center font-bold text-xs">
                !
              </div>
            )}
          </section>

          {/* Sono */}
          <section className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm flex items-center justify-between">
            <div>
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Média de Sono (14 dias)</span>
              <h4 className="text-2xl font-bold text-[#0E3D4D] mt-1">{metrics.sono.mediaHoras}h</h4>
              <span className="text-[10px] text-gray-400 mt-1 block">Recomendado &gt; 7.5h</span>
            </div>
            {metrics.sono.alerta ? (
              <span className="bg-rose-500/10 text-rose-600 text-[10px] font-bold px-2 py-1 rounded">Sono Insuficiente</span>
            ) : (
              <span className="bg-emerald-500/10 text-emerald-600 text-[10px] font-bold px-2 py-1 rounded">Saudável</span>
            )}
          </section>

          {/* Redações */}
          <section className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm">
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Redações Concluídas</span>
            <div className="mt-2 flex justify-between items-baseline">
              <span className="text-2xl font-bold text-[#0E3D4D]">{metrics.redacoes.escritas} / {metrics.redacoes.meta}</span>
              <span className="text-xs text-gray-400 font-semibold">{metrics.redacoes.reescritas} reescritas</span>
            </div>
            <div className="w-full bg-gray-100 h-1.5 rounded-full mt-2 overflow-hidden">
              <div 
                className="bg-[#17607A] h-full rounded-full"
                style={{ width: `${(metrics.redacoes.escritas / metrics.redacoes.meta) * 100}%` }}
              />
            </div>
          </section>

        </div>

      </div>

      {/* Evolução de Simulados */}
      <section className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm space-y-4">
        <h3 className="text-base font-bold font-['Lora'] text-[#0E3D4D] border-b pb-2">Evolução Histórica de Simulados</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {metrics.simuladosEvolucao.map((sim, idx) => (
            <div key={idx} className="bg-[#FBF8F3] p-4 rounded-xl border space-y-3">
              <div className="flex justify-between border-b pb-1.5 text-xs font-semibold">
                <span className="text-gray-500">Prova em {sim.data}</span>
                <span className="text-[#0E3D4D]">Média: {sim.mediaGlobal}</span>
              </div>
              <div className="space-y-1.5 text-[10px]">
                {sim.areas?.map((a: any, aIdx: number) => (
                  <div key={aIdx} className="flex justify-between items-center">
                    <span className="text-gray-600 truncate max-w-[120px]">{a.area}</span>
                    <span className="font-bold text-gray-800">{a.acertosPct}%</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
}
