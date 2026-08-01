'use client';

import { useState, useEffect } from 'react';
import { CicloAtivoData } from '../app/actions/ciclo';
import { MOCK_TOPICOS } from '../lib/mocks';
import { registrarCheckin } from '../app/actions/checkin';
import Link from 'next/link';
import { DashboardMetrics } from '../app/actions/dashboard';
import DashboardPage from './DashboardPage';

interface HojePageProps {
  dadosIniciais: CicloAtivoData | null;
  metricasIniciais: DashboardMetrics | null;
}

export default function HojePage({ dadosIniciais, metricasIniciais }: HojePageProps) {
  const [activeTab, setActiveTab] = useState<'hoje' | 'metricas'>('hoje');
  // Próximo bloco do ciclo
  const [ciclo, setCiclo] = useState<CicloAtivoData | null>(dadosIniciais);
  const [proximaOrdem, setProximaOrdem] = useState<number>(dadosIniciais?.proximaOrdem ?? 1);
  const [topicoId, setTopicoId] = useState<string>('');
  
  // Progresso do Ciclo
  const [concluidosSemana, setConcluidosSemana] = useState<number>(0);

  // Check-in de Bem-Estar
  const [checkinFeito, setCheckinFeito] = useState<boolean>(false);
  const [horasSono, setHorasSono] = useState<number>(7);
  const [exercicioMin, setExercicioMin] = useState<number>(30);
  const [humor, setHumor] = useState<number>(4);
  const [energia, setEnergia] = useState<number>(4);
  const [notaLivre, setNotaLivre] = useState<string>('');
  const [salvandoCheckin, setSalvandoCheckin] = useState<boolean>(false);

  // Carregar dados locais (localStorage) para persistência offline/refresh
  useEffect(() => {
    // 1. Ler ordem atualizada localmente se houver (para refletir sessões concluídas)
    const localOrdem = localStorage.getItem('medicina_2029_proxima_ordem');
    if (localOrdem) {
      setProximaOrdem(parseInt(localOrdem, 10));
    }

    // 2. Ler progresso semanal
    const localConcluidos = localStorage.getItem('medicina_2029_concluidos_semana');
    if (localConcluidos) {
      setConcluidosSemana(parseInt(localConcluidos, 10));
    } else {
      // Mock inicial de progresso realista se não houver
      setConcluidosSemana(3);
      localStorage.setItem('medicina_2029_concluidos_semana', '3');
    }

    // 3. Ler check-in do dia
    const hojeStr = new Date().toDateString();
    const localCheckin = localStorage.getItem(`medicina_2029_checkin_${hojeStr}`);
    if (localCheckin) {
      const parsed = JSON.parse(localCheckin);
      setCheckinFeito(true);
      setHorasSono(parsed.horasSono);
      setExercicioMin(parsed.exercicioMin);
      setHumor(parsed.humor);
      setEnergia(parsed.energia);
      setNotaLivre(parsed.notaLivre || '');
    }
  }, []);

  // Determinar o bloco atual a partir da ordem
  const blocos = ciclo?.blocos ?? [];
  const blocoAtual = blocos.find(b => b.ordem === proximaOrdem) || blocos[0] || null;
  const totalBlocos = blocos.length || 12;

  // Obter tópicos disponíveis para a disciplina do bloco atual
  const topicosDisponiveis = blocoAtual 
    ? (MOCK_TOPICOS[blocoAtual.disciplinaId] || []) 
    : [];

  // Definir tópico inicial automaticamente quando o bloco mudar
  useEffect(() => {
    if (topicosDisponiveis.length > 0) {
      setTopicoId(topicosDisponiveis[0].id);
    } else {
      setTopicoId('');
    }
  }, [blocoAtual, topicosDisponiveis]);

  // Handler para salvar o check-in de bem-estar
  const handleSaveCheckin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSalvandoCheckin(true);
    
    const dados = {
      horasSono,
      exercicioMin,
      humor,
      energia,
      notaLivre: notaLivre.trim()
    };

    const res = await registrarCheckin(dados);
    
    if (res.sucesso) {
      const hojeStr = new Date().toDateString();
      localStorage.setItem(`medicina_2029_checkin_${hojeStr}`, JSON.stringify(dados));
      setCheckinFeito(true);
    }
    setSalvandoCheckin(false);
  };

  // Calcular aderência
  const blocosPrevistos = ciclo?.ciclo.blocosPrevistosSemana ?? 12;
  const aderencia = Math.min(Math.round((concluidosSemana / blocosPrevistos) * 100), 100);

  // Tradução do tipo de bloco
  const getTipoLabel = (tipo: string) => {
    switch (tipo) {
      case 'conteudo': return 'Teoria / Conteúdo';
      case 'questoes': return 'Sessão de Questões';
      case 'redacao': return 'Prática de Redação';
      case 'caderno_erros': return 'Revisão de Caderno de Erros';
      case 'revisao_srs': return 'Revisão Espaçada (Anki)';
      case 'lingua_estrangeira': return 'Língua Estrangeira';
      default: return tipo;
    }
  };

  return (
    <div className="w-full max-w-md md:max-w-5xl mx-auto bg-[#FBF8F3] min-h-screen pb-24 px-4 pt-6 select-none font-poppins">
      
      {/* Header Sóbrio */}
      <header className="mb-6 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-[#0E3D4D] tracking-tight">Medicina 2029</h1>
          <p className="text-xs text-[#6A7D87] font-medium">Fortaleza, Ceará</p>
        </div>
        
        {/* Alternador de abas */}
        <div className="flex space-x-1 bg-[#EAE3D5]/50 p-1 rounded-xl border border-[#D5CBB8]/30">
          <button
            onClick={() => setActiveTab('hoje')}
            className={`py-1.5 px-3 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'hoje'
                ? 'bg-[#0E3D4D] text-white shadow-sm'
                : 'text-[#6A7D87] hover:text-[#0E3D4D]'
            }`}
          >
            Hoje
          </button>
          <button
            onClick={() => setActiveTab('metricas')}
            className={`py-1.5 px-3 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'metricas'
                ? 'bg-[#0E3D4D] text-white shadow-sm'
                : 'text-[#6A7D87] hover:text-[#0E3D4D]'
            }`}
          >
            Métricas
          </button>
        </div>
      </header>

      {activeTab === 'hoje' ? (
        /* Grid responsivo para PC */
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        
        {/* Coluna Esquerda: Bloco de Foco e Status (md:col-span-7) */}
        <div className="md:col-span-7 space-y-5">
          {/* Bloco de Foco / Próximo Estudo */}
          <section className="bg-white border border-[#EAE3D5] rounded-2xl p-5 shadow-sm">
            <span className="text-[10px] uppercase font-bold tracking-widest text-[#B5502B]">Próximo Bloco da Fila</span>
            
            {blocoAtual ? (
              <div className="mt-2">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-xl font-bold text-[#0E3D4D] leading-tight font-lora-read">
                      {blocoAtual.disciplina.nome}
                    </h2>
                    <div className="flex gap-2 items-center mt-1">
                      <span className="text-xs font-medium text-[#1B2A33] bg-[#FBF8F3] px-2 py-0.5 rounded border border-[#EAE3D5]">
                        {getTipoLabel(blocoAtual.tipo)}
                      </span>
                      <span className="text-xs font-semibold text-[#C98A2E]">
                        {blocoAtual.estiloAlvo.toUpperCase()}
                      </span>
                    </div>
                  </div>
                  <span className="text-sm font-bold text-[#0E3D4D] bg-[#F1EFEA] px-3 py-1 rounded-lg">
                    {blocoAtual.duracaoMin} min
                  </span>
                </div>

                {/* Dropdown de Seleção de Tópico */}
                <div className="mt-4 pt-4 border-t border-[#F1EFEA]">
                  <label htmlFor="topico-selector" className="block text-xs font-bold text-[#6A7D87] mb-1.5">
                    Escolha o tópico para estudar:
                  </label>
                  {topicosDisponiveis.length > 0 ? (
                    <select
                      id="topico-selector"
                      value={topicoId}
                      onChange={(e) => setTopicoId(e.target.value)}
                      className="w-full h-11 px-3 bg-[#FBF8F3] border border-[#D5CBB8] rounded-xl text-sm font-medium text-[#1B2A33] focus:outline-none focus:ring-1 focus:ring-[#0E3D4D] transition-colors"
                    >
                      {topicosDisponiveis.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.nome} (Incidência: {t.incidenciaEnem}/5)
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-xs text-[#B5502B] font-medium">Nenhum tópico disponível. Mock ativo.</p>
                  )}
                </div>

                {/* Botão de Estudar */}
                <Link
                  href={`/estudar?blocoId=${blocoAtual.id}&topicoId=${topicoId}`}
                  className="mt-4 flex h-12 w-full items-center justify-center rounded-xl bg-[#0E3D4D] text-sm font-bold text-white shadow transition-all hover:bg-[#17607A] active:scale-[0.98] min-h-[44px]"
                >
                  Iniciar Estudo Ativo
                </Link>
              </div>
            ) : (
              <p className="text-sm text-[#6A7D87] mt-2">Nenhum bloco de estudo configurado no ciclo ativo.</p>
            )}
          </section>

          {/* Status de Revisões SRS e Progresso do Ciclo */}
          <div className="grid grid-cols-2 gap-4">
            {/* FSRS Stats */}
            <section className="bg-white border border-[#EAE3D5] rounded-2xl p-4 shadow-sm flex flex-col justify-between">
              <div>
                <span className="text-[10px] uppercase font-bold tracking-wider text-[#6A7D87]">Repetição FSRS</span>
                <div className="mt-2 space-y-1">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-[#6A7D87] font-medium">Revisar hoje:</span>
                    <span className="font-bold text-[#B5502B]">14</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-[#6A7D87] font-medium">Novos:</span>
                    <span className="font-bold text-[#C98A2E]">5</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-[#6A7D87] font-medium">Total due:</span>
                    <span className="font-semibold text-[#1B2A33]">19 cards</span>
                  </div>
                </div>
              </div>
              <button 
                onClick={() => window.location.href = '/revisao'}
                className="mt-3 w-full h-8 bg-[#FBF8F3] hover:bg-[#F1EFEA] border border-[#D5CBB8] text-[#0E3D4D] font-bold text-[11px] rounded-lg transition-colors min-h-[32px]"
              >
                Revisar Anki
              </button>
            </section>

            {/* Ciclo Semanal Stats */}
            <section className="bg-white border border-[#EAE3D5] rounded-2xl p-4 shadow-sm flex flex-col justify-between">
              <div>
                <span className="text-[10px] uppercase font-bold tracking-wider text-[#6A7D87]">Ciclo Semanal</span>
                <div className="mt-2">
                  <div className="flex justify-between items-end">
                    <span className="text-2xl font-bold text-[#0E3D4D]">{concluidosSemana}</span>
                    <span className="text-xs font-semibold text-[#6A7D87]">de {blocosPrevistos} blocos</span>
                  </div>
                  
                  {/* Barra de Progresso */}
                  <div className="w-full bg-[#F1EFEA] h-2 rounded-full mt-2 overflow-hidden border border-[#EAE3D5]/50">
                    <div 
                      className="bg-[#17607A] h-full rounded-full transition-all duration-500" 
                      style={{ width: `${aderencia}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className="mt-3 pt-2 border-t border-[#F1EFEA] flex justify-between items-center text-[10px] font-bold text-[#6A7D87]">
                <span>ADERÊNCIA</span>
                <span className={aderencia >= 75 ? 'text-[#0E3D4D]' : 'text-[#B5502B]'}>{aderencia}%</span>
              </div>
            </section>
          </div>
        </div>

        {/* Coluna Direita: Check-in de Bem-estar (md:col-span-5) */}
        <div className="md:col-span-5">
          {/* Check-in de Bem-Estar */}
          <section className="bg-white border border-[#EAE3D5] rounded-2xl p-5 shadow-sm h-full">
            <div className="flex justify-between items-center mb-4">
              <span className="text-[10px] uppercase font-bold tracking-widest text-[#0E3D4D]">Check-in de Bem-estar</span>
              <span className="text-xs text-[#6A7D87] font-semibold">Diário</span>
            </div>

            {checkinFeito ? (
              <div className="bg-[#FBF8F3] border border-[#EAE3D5] rounded-xl p-4 text-[#1B2A33]">
                <div className="flex items-center gap-2 mb-3">
                  <svg className="w-4 h-4 text-[#0E3D4D]" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span className="text-xs font-bold text-[#0E3D4D]">Check-in concluído hoje!</span>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs font-semibold text-[#6A7D87]">
                  <div>Sono: <span className="text-[#1B2A33]">{horasSono} horas</span></div>
                  <div>Exercício: <span className="text-[#1B2A33]">{exercicioMin} min</span></div>
                  <div>Humor: <span className="text-[#1B2A33]">{humor}/5</span></div>
                  <div>Energia: <span className="text-[#1B2A33]">{energia}/5</span></div>
                </div>

                {notaLivre && (
                  <div className="mt-3 pt-3 border-t border-[#EAE3D5] text-xs">
                    <span className="block font-bold text-[#6A7D87] mb-1">Notas:</span>
                    <p className="font-lora-read text-[#1B2A33] italic leading-relaxed">"{notaLivre}"</p>
                  </div>
                )}
                
                <button 
                  onClick={() => setCheckinFeito(false)}
                  className="mt-4 text-xs font-bold text-[#B5502B] hover:text-[#17607A] transition-colors focus:outline-none min-h-[44px] px-2"
                >
                  Editar Respostas
                </button>
              </div>
            ) : (
              <form onSubmit={handleSaveCheckin} className="space-y-4">
                
                {/* Linha 1: Sono e Exercício */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-[#6A7D87] mb-1">
                      Horas de Sono:
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      max="24"
                      value={horasSono}
                      onChange={(e) => setHorasSono(parseFloat(e.target.value) || 0)}
                      className="w-full h-11 px-3 bg-[#FBF8F3] border border-[#D5CBB8] rounded-xl text-sm font-medium text-[#1B2A33] focus:outline-none focus:ring-1 focus:ring-[#0E3D4D]"
                      required
                    />
                  </div>
                  
                  <div>
                    <label className="block text-xs font-bold text-[#6A7D87] mb-1">
                      Exercício (min):
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="480"
                      value={exercicioMin}
                      onChange={(e) => setExercicioMin(parseInt(e.target.value, 10) || 0)}
                      className="w-full h-11 px-3 bg-[#FBF8F3] border border-[#D5CBB8] rounded-xl text-sm font-medium text-[#1B2A33] focus:outline-none focus:ring-1 focus:ring-[#0E3D4D]"
                      required
                    />
                  </div>
                </div>

                {/* Humor */}
                <div>
                  <span className="block text-xs font-bold text-[#6A7D87] mb-1.5">Humor (1=Péssimo, 5=Excelente):</span>
                  <div className="flex justify-between gap-1">
                    {[1, 2, 3, 4, 5].map((val) => (
                      <button
                        key={`humor-${val}`}
                        type="button"
                        onClick={() => setHumor(val)}
                        className={`flex-1 h-11 rounded-xl font-bold text-xs transition-all border ${
                          humor === val
                            ? 'bg-[#0E3D4D] text-white border-[#0E3D4D]'
                            : 'bg-[#FBF8F3] text-[#6A7D87] border-[#D5CBB8] hover:bg-[#F1EFEA]'
                        } min-h-[44px]`}
                      >
                        {val}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Energia */}
                <div>
                  <span className="block text-xs font-bold text-[#6A7D87] mb-1.5">Energia (1=Esgotado, 5=Disposto):</span>
                  <div className="flex justify-between gap-1">
                    {[1, 2, 3, 4, 5].map((val) => (
                      <button
                        key={`energia-${val}`}
                        type="button"
                        onClick={() => setEnergia(val)}
                        className={`flex-1 h-11 rounded-xl font-bold text-xs transition-all border ${
                          energia === val
                            ? 'bg-[#0E3D4D] text-white border-[#0E3D4D]'
                            : 'bg-[#FBF8F3] text-[#6A7D87] border-[#D5CBB8] hover:bg-[#F1EFEA]'
                        } min-h-[44px]`}
                      >
                        {val}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Nota */}
                <div>
                  <label className="block text-xs font-bold text-[#6A7D87] mb-1">
                    Notas adicionais (opcional):
                  </label>
                  <textarea
                    value={notaLivre}
                    onChange={(e) => setNotaLivre(e.target.value)}
                    placeholder="Ex: Dormi mal por causa do calor..."
                    rows={1}
                    className="w-full p-3 bg-[#FBF8F3] border border-[#D5CBB8] rounded-xl text-sm font-medium text-[#1B2A33] focus:outline-none focus:ring-1 focus:ring-[#0E3D4D] font-lora-read resize-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={salvandoCheckin}
                  className="w-full h-11 bg-[#17607A] text-white font-bold text-sm rounded-xl shadow hover:bg-[#0E3D4D] active:scale-[0.98] transition-all disabled:opacity-50 min-h-[44px]"
                >
                  {salvandoCheckin ? 'Gravando...' : 'Salvar Ficha Diária'}
                </button>
              </form>
            )}
          </section>
        </div>

      </div>
      ) : (
        <div className="mt-4">
          <DashboardPage dadosIniciais={metricasIniciais} embedded={true} />
        </div>
      )}

    </div>
  );
}
