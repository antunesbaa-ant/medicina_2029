'use client';

import { useState, useEffect } from 'react';
import { obterAcompanhamentoQuinzenal, registrarRevisaoTrimestral, obterRevisoesTrimestrais, QuinzenaResumo } from '../app/actions/responsavel';
import { exportarDadosCompletos, restaurarDadosCompletos } from '../app/actions/backup';
import { iniciarCicloEstudos, resetarPlanejamento } from '../app/actions/ciclo';

export default function ResponsavelPage() {
  const [quinzenas, setQuinzenas] = useState<QuinzenaResumo[]>([]);
  const [trimestrais, setTrimestrais] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [processandoCiclo, setProcessandoCiclo] = useState<boolean>(false);

  const handleIniciarCiclo = async () => {
    setProcessandoCiclo(true);
    setStatusMsg('Iniciando ciclo de estudos...');
    try {
      const res = await iniciarCicloEstudos();
      if (res.sucesso) {
        setStatusMsg('Ciclo de estudos iniciado com sucesso!');
        await loadData();
      } else {
        setStatusMsg(res.mensagem || 'Falha ao iniciar ciclo de estudos.');
      }
    } catch (err) {
      console.error(err);
      setStatusMsg('Erro ao iniciar ciclo de estudos.');
    } finally {
      setProcessandoCiclo(false);
    }
  };

  const handleResetarPlanejamento = async () => {
    if (!confirm('Tem certeza que deseja resetar todo o planejamento? Alice ficará aguardando o início de um novo ciclo.')) {
      return;
    }
    setProcessandoCiclo(true);
    setStatusMsg('Resetando planejamento...');
    try {
      const res = await resetarPlanejamento();
      if (res.sucesso) {
        setStatusMsg('Planejamento resetado com sucesso!');
        await loadData();
      } else {
        setStatusMsg(res.mensagem || 'Falha ao resetar planejamento.');
      }
    } catch (err) {
      console.error(err);
      setStatusMsg('Erro ao resetar planejamento.');
    } finally {
      setProcessandoCiclo(false);
    }
  };

  // Trimestral Form State
  const [showForm, setShowForm] = useState<boolean>(false);
  const [trimestre, setTrimestre] = useState<number>(3);
  const [ano, setAno] = useState<number>(new Date().getFullYear());
  const [conversa, setConversa] = useState<string>('');
  const [decisoes, setDecisoes] = useState<string>('');
  const [salvando, setSalvando] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>('');

  const handleExportar = async () => {
    try {
      const dataStr = await exportarDadosCompletos();
      const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
      
      const exportFileDefaultName = `medicina_2029_backup_${new Date().toISOString().split('T')[0]}.json`;
      
      const linkElement = document.createElement('a');
      linkElement.setAttribute('href', dataUri);
      linkElement.setAttribute('download', exportFileDefaultName);
      linkElement.click();
      setStatusMsg('Backup exportado com sucesso.');
    } catch (err) {
      console.error(err);
      setStatusMsg('Falha ao exportar backup.');
    }
  };

  const handleRestaurar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileReader = new FileReader();
    if (e.target.files && e.target.files[0]) {
      fileReader.readAsText(e.target.files[0], "UTF-8");
      fileReader.onload = async (event) => {
        const text = event.target?.result as string;
        if (text) {
          setStatusMsg('Restaurando banco...');
          const res = await restaurarDadosCompletos(text);
          if (res.sucesso) {
            setStatusMsg('Base de dados restaurada com sucesso!');
            loadData();
          } else {
            setStatusMsg(res.mensagem);
          }
        }
      };
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const qData = await obterAcompanhamentoQuinzenal();
      setQuinzenas(qData);

      const tData = await obterRevisoesTrimestrais();
      setTrimestrais(tData);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSalvarTrimestral = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!conversa || !decisoes) return;

    setSalvando(true);
    try {
      const res = await registrarRevisaoTrimestral({
        trimestre,
        ano,
        conversa,
        decisoes
      });

      if (res.sucesso) {
        setConversa('');
        setDecisoes('');
        setShowForm(false);
        loadData();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 pb-24 font-['Poppins'] text-[#1B2A33] space-y-8">
      
      {/* Header */}
      <header className="border-b pb-6">
        <h1 className="text-3xl font-bold font-['Lora'] text-[#0E3D4D]">Painel do Responsável</h1>
        <p className="text-sm text-gray-500 mt-1">
          Acompanhamento pedagógico de Alice Antunes focado em autonomia, consistência e privacidade.
        </p>
      </header>

      {/* Strict Privacy Banner */}
      <div className="bg-[#0E3D4D]/[0.02] border-2 border-dashed border-[#0E3D4D]/25 p-5 rounded-2xl space-y-2">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-[#0E3D4D]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <strong className="text-[#0E3D4D] text-sm font-bold">Termo de Respeito à Autonomia (Regra 1.2)</strong>
        </div>
        <p className="text-xs text-gray-600 leading-relaxed font-['Lora']">
          Para preservar a saúde emocional da estudante e evitar vigilância culpabilizante ou micromanagement, este painel <strong>não expõe</strong> dados em tempo real ou com granularidade diária. A atividade é agrupada em blocos quinzenais, permitindo uma análise saudável de consistência, sono e progresso qualitativo.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 text-center py-12">Carregando painel do responsável...</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* Left Column: Quinzenas & Acompanhamento (8 cols) */}
          <div className="lg:col-span-8 space-y-6">
            <h2 className="text-lg font-bold font-['Lora'] text-[#0E3D4D] border-b pb-2">Acompanhamento Quinzenal</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {quinzenas.map((q, idx) => (
                <section key={idx} className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm space-y-4">
                  <div className="flex justify-between items-center border-b pb-2">
                    <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Período</span>
                    <span className="bg-[#0E3D4D]/10 text-[#0E3D4D] text-[10px] font-bold px-2 py-0.5 rounded border border-[#0E3D4D]/20">
                      {q.periodoRotulo}
                    </span>
                  </div>

                  <div className="space-y-3 text-xs font-semibold">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Blocos de estudo concluídos:</span>
                      <span className="text-[#0E3D4D]">{q.blocosConcluidos} blocos</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Média de sono:</span>
                      <span className={`${q.mediaHorasSono < 7.5 ? 'text-rose-600' : 'text-emerald-600'}`}>
                        {q.mediaHorasSono}h / noite
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Redações escritas:</span>
                      <span className="text-gray-800">{q.redacoesEscritas} redações</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Redações reescritas:</span>
                      <span className="text-gray-800">{q.redacoesReescritas} reescritas</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Cards ativos no FSRS (SRS):</span>
                      <span className="text-gray-800">{q.cardsFSRSAtivos} cards</span>
                    </div>
                  </div>
                </section>
              ))}
            </div>

            {/* List of past Trimester Reviews */}
            <div className="space-y-4 pt-6">
              <h2 className="text-lg font-bold font-['Lora'] text-[#0E3D4D] border-b pb-2">Revisões Trimestrais Concluídas</h2>
              {trimestrais.length === 0 ? (
                <p className="text-xs text-gray-400 italic">Nenhuma revisão trimestral registrada.</p>
              ) : (
                trimestrais.map((t) => (
                  <div key={t.id} className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm space-y-3">
                    <div className="flex justify-between border-b pb-2 text-xs font-semibold">
                      <span className="text-[#0E3D4D]">Trimestre {t.trimestre} / {t.ano}</span>
                      <span className="text-gray-400">Registrado em {new Date(t.fechadaEm).toLocaleDateString('pt-BR')}</span>
                    </div>
                    <div className="text-xs space-y-2 font-['Lora']">
                      <div>
                        <strong className="text-[#0E3D4D] block uppercase font-['Poppins'] text-[9px] text-gray-400 tracking-wider">Percepções e Alinhamento</strong>
                        <p className="text-gray-700 italic">"{t.conversa}"</p>
                      </div>
                      <div>
                        <strong className="text-[#0E3D4D] block uppercase font-['Poppins'] text-[9px] text-gray-400 tracking-wider">Decisões e Acordos</strong>
                        <p className="text-gray-700 italic">"{t.decisoes}"</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right Column: Trimestral Form Trigger (4 cols) */}
          <div className="lg:col-span-4 space-y-6">
            <section className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm h-fit space-y-4">
              <h3 className="text-base font-bold font-['Lora'] text-[#0E3D4D] border-b pb-2">Nova Revisão Trimestral</h3>
              
              {!showForm ? (
                <div className="space-y-3 text-xs">
                  <p className="text-gray-500 leading-relaxed">
                    A cada trimestre (março, junho, setembro, dezembro), realize uma conversa qualitativa para alinhar a carga de estudos com base nos resultados consolidados.
                  </p>
                  <button
                    onClick={() => setShowForm(true)}
                    className="w-full py-2 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg hover:bg-[#17607A] transition-all text-center"
                  >
                    Iniciar Revisão
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSalvarTrimestral} className="space-y-4">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <label className="block text-gray-400 font-bold uppercase mb-1">Trimestre</label>
                      <select
                        value={trimestre}
                        onChange={e => setTrimestre(parseInt(e.target.value))}
                        className="w-full p-2 border rounded bg-white"
                      >
                        <option value={1}>1º Trimestre (Março)</option>
                        <option value={2}>2º Trimestre (Junho)</option>
                        <option value={3}>3º Trimestre (Setembro)</option>
                        <option value={4}>4º Trimestre (Dezembro)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-gray-400 font-bold uppercase mb-1">Ano</label>
                      <input
                        type="number"
                        value={ano}
                        onChange={e => setAno(parseInt(e.target.value) || new Date().getFullYear())}
                        className="w-full p-2 border rounded"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-400 font-bold uppercase mb-1">Notas da Conversa Qualitativa</label>
                    <textarea
                      value={conversa}
                      onChange={e => setConversa(e.target.value)}
                      placeholder="Como foi a conversa? Ajustaram a rotina? A estudante se sente sobrecarregada?..."
                      rows={4}
                      className="w-full p-2.5 border rounded-lg text-xs focus:outline-none"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-gray-400 font-bold uppercase mb-1">Decisões e Acordos Firmados</label>
                    <textarea
                      value={decisoes}
                      onChange={e => setDecisoes(e.target.value)}
                      placeholder="Ex: Reduzir de 6 para 5 blocos por semana em Matemática para respirar..."
                      rows={3}
                      className="w-full p-2.5 border rounded-lg text-xs focus:outline-none"
                      required
                    />
                  </div>

                  <div className="flex gap-2 text-xs">
                    <button
                      type="submit"
                      disabled={salvando}
                      className="px-4 py-2 bg-[#0E3D4D] text-white font-bold rounded hover:bg-[#17607A]"
                    >
                      {salvando ? 'Salvando...' : 'Fechar Trimestre'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowForm(false)}
                      className="px-4 py-2 bg-gray-100 text-gray-500 font-bold rounded hover:bg-gray-200"
                    >
                      Cancelar
                    </button>
                  </div>
                </form>
              )}
            </section>

            {/* Controle do Ciclo de Estudos */}
            <section className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm space-y-4">
              <h3 className="text-base font-bold font-['Lora'] text-[#0E3D4D] border-b pb-2">Controle do Ciclo</h3>
              <p className="text-xs text-gray-500 leading-relaxed font-medium">
                Inicie o ciclo de estudos de Alice para 2027 ou resete o planejamento ativo para pausar as atividades diárias.
              </p>
              
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleIniciarCiclo}
                  disabled={processandoCiclo}
                  className="w-full py-2.5 bg-emerald-600 text-white text-xs font-bold rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-all text-center font-semibold"
                >
                  {processandoCiclo ? 'Processando...' : 'Iniciar Ciclo de Estudos'}
                </button>
                
                <button
                  onClick={handleResetarPlanejamento}
                  disabled={processandoCiclo}
                  className="w-full py-2.5 bg-rose-600 text-white text-xs font-bold rounded-lg hover:bg-rose-700 disabled:opacity-50 transition-all text-center font-semibold"
                >
                  {processandoCiclo ? 'Processando...' : 'Resetar Planejamento'}
                </button>
              </div>
            </section>

            {/* Backup & Export Section */}
            <section className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm space-y-4">
              <h3 className="text-base font-bold font-['Lora'] text-[#0E3D4D] border-b pb-2">Backup do Sistema</h3>
              <p className="text-xs text-gray-500 leading-relaxed font-medium">
                Exporte todo o seu progresso, acervo e histórico de simulados em formato JSON ou restaure um backup anterior em uma base limpa.
              </p>
              
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleExportar}
                  className="w-full py-2.5 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg hover:bg-[#17607A] transition-all text-center"
                >
                  Exportar Backup Completo (JSON)
                </button>
                
                <div className="border-t pt-3">
                  <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Restaurar de Backup</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleRestaurar}
                    className="w-full text-xs text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200 cursor-pointer"
                  />
                  {statusMsg && (
                    <p className={`text-[10px] font-bold mt-2 ${statusMsg.includes('sucesso') ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {statusMsg}
                    </p>
                  )}
                </div>
              </div>
            </section>
          </div>

        </div>
      )}
    </div>
  );
}
