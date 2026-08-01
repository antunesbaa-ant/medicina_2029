'use client';

import { useState, useEffect } from 'react';
import { listarSimulados, registrarSimulado } from '../app/actions/simulados';
import { injetarTopicoNoCiclo } from '../app/actions/reestudo';

export default function SimuladosPage() {
  const [simuladosList, setSimuladosList] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // New Simulation Form State
  const [exibirForm, setExibirForm] = useState<boolean>(false);
  const [formato, setFormato] = useState<'enem' | 'uece_1fase' | 'uece_2fase' | 'privada'>('enem');
  const [data, setData] = useState<string>(new Date().toISOString().split('T')[0]);
  const [duracao, setDuracao] = useState<number>(270); // 4h30m default
  const [local, setLocal] = useState<string>('Em Casa (Condições reais)');
  const [condicoesReais, setCondicoesReais] = useState<boolean>(true);
  
  // Areas scores state
  const [naturezaAcertos, setNaturezaAcertos] = useState<number>(30);
  const [matematicaAcertos, setMatematicaAcertos] = useState<number>(28);
  const [humanasAcertos, setHumanasAcertos] = useState<number>(35);
  const [linguagensAcertos, setLinguagensAcertos] = useState<number>(34);

  const [salvando, setSalvando] = useState<boolean>(false);
  const [injetandoId, setInjetandoId] = useState<string | null>(null);
  const [reestudoMsg, setReestudoMsg] = useState<string>('');

  const fetchSimulados = async () => {
    setLoading(true);
    try {
      const res = await listarSimulados();
      setSimuladosList(res);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSimulados();
  }, []);

  const handleSalvarSimulado = async (e: React.FormEvent) => {
    e.preventDefault();
    setSalvando(true);
    try {
      const areasInput = [
        { area: 'Ciências da Natureza e suas Tecnologias', acertos: naturezaAcertos, total: 45 },
        { area: 'Matemática e suas Tecnologias', acertos: matematicaAcertos, total: 45 },
        { area: 'Ciências Humanas e suas Tecnologias', acertos: humanasAcertos, total: 45 },
        { area: 'Linguagens, Códigos e suas Tecnologias', acertos: linguagensAcertos, total: 45 }
      ];

      const res = await registrarSimulado({
        formato,
        data,
        condicoesReais,
        duracaoMin: duracao,
        local,
        composicaoProcedencia: { simuladoOrigem: 'Caderno ENEM Oficial' },
        areas: areasInput
      });

      if (res.sucesso) {
        setExibirForm(false);
        fetchSimulados();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSalvando(false);
    }
  };

  const handleInjetarReestudo = async (topicoId: string) => {
    setInjetandoId(topicoId);
    setReestudoMsg('Injetando re-estudo no ciclo...');
    try {
      const res = await injetarTopicoNoCiclo(topicoId);
      if (res.sucesso) {
        setReestudoMsg('Sucesso: Próximo bloco do ciclo configurado!');
        setTimeout(() => setReestudoMsg(''), 4000);
      } else {
        setReestudoMsg(`Erro: ${res.mensagem}`);
      }
    } catch (err: any) {
      setReestudoMsg(`Erro: ${err.message}`);
    } finally {
      setInjetandoId(null);
    }
  };

  const getSomaAcertos = (areas: any[]) => {
    return areas.reduce((sum, a) => sum + a.acertos, 0);
  };

  const getSomaTotal = (areas: any[]) => {
    return areas.reduce((sum, a) => sum + a.total, 0);
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 pb-24 font-['Poppins'] text-[#1B2A33]">
      <header className="mb-8 flex flex-col md:flex-row justify-between items-start md:items-center border-b pb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold font-['Lora'] text-[#0E3D4D]">Desempenho em Simulados</h1>
          <p className="text-sm text-gray-500 mt-1">
            Lance seus gabaritos de provas inteiras, identifique fraquezas e configure ciclos de re-estudo imediatos.
          </p>
        </div>

        <button
          onClick={() => setExibirForm(!exibirForm)}
          className="px-4 py-2 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg hover:bg-[#17607A] transition-all"
        >
          {exibirForm ? 'Fechar Form' : '+ Registrar Simulado'}
        </button>
      </header>

      {reestudoMsg && (
        <div className={`p-4 mb-6 rounded-lg text-sm font-semibold text-center ${
          reestudoMsg.startsWith('Sucesso') ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-600 border border-rose-500/20'
        }`}>
          {reestudoMsg}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Column: Form (4 cols) */}
        <div className="lg:col-span-4 space-y-6">
          {exibirForm ? (
            <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm space-y-4">
              <h2 className="text-lg font-semibold font-['Lora'] text-[#0E3D4D]">Registrar Nova Prova</h2>
              
              <form onSubmit={handleSalvarSimulado} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Formato</label>
                    <select
                      value={formato}
                      onChange={e => setFormato(e.target.value as any)}
                      className="w-full px-2 py-2 border rounded bg-white text-xs"
                    >
                      <option value="enem">ENEM</option>
                      <option value="uece_1fase">UECE 1ª Fase</option>
                      <option value="uece_2fase">UECE 2ª Fase</option>
                      <option value="privada">Privada / Outros</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Duração (min)</label>
                    <input
                      type="number"
                      value={duracao}
                      onChange={e => setDuracao(parseInt(e.target.value) || 0)}
                      className="w-full px-3 py-1.5 border rounded text-xs"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Data</label>
                    <input
                      type="date"
                      value={data}
                      onChange={e => setData(e.target.value)}
                      className="w-full px-3 py-1.5 border rounded text-xs"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Simulado Real?</label>
                    <select
                      value={condicoesReais ? 'sim' : 'nao'}
                      onChange={e => setCondicoesReais(e.target.value === 'sim')}
                      className="w-full px-2 py-2 border rounded bg-white text-xs"
                    >
                      <option value="sim">Sim (Condições do dia)</option>
                      <option value="nao">Não (Fração livre)</option>
                    </select>
                  </div>
                </div>

                <div className="border-t pt-3 space-y-3">
                  <span className="block text-xs font-bold text-gray-500 uppercase mb-2">Acertos p/ Área (ENEM)</span>
                  
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <label className="block text-gray-400 mb-0.5">Nat. (x/45):</label>
                      <input
                        type="number"
                        max={45}
                        min={0}
                        value={naturezaAcertos}
                        onChange={e => setNaturezaAcertos(parseInt(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-400 mb-0.5">Mat. (x/45):</label>
                      <input
                        type="number"
                        max={45}
                        min={0}
                        value={matematicaAcertos}
                        onChange={e => setMatematicaAcertos(parseInt(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-400 mb-0.5">Hum. (x/45):</label>
                      <input
                        type="number"
                        max={45}
                        min={0}
                        value={humanasAcertos}
                        onChange={e => setHumanasAcertos(parseInt(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-400 mb-0.5">Ling. (x/45):</label>
                      <input
                        type="number"
                        max={45}
                        min={0}
                        value={linguagensAcertos}
                        onChange={e => setLinguagensAcertos(parseInt(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                      />
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={salvando}
                  className="w-full py-2 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg hover:bg-[#17607A]"
                >
                  {salvando ? 'Processando e Analisando...' : 'Gravar Simulado'}
                </button>
              </form>
            </div>
          ) : (
            <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm space-y-4">
              <h2 className="text-lg font-semibold font-['Lora'] text-[#0E3D4D]">Análise Consolidada</h2>
              <p className="text-xs text-gray-500 leading-relaxed">
                Cada simulado adicionado roda uma varredura instantânea sobre as áreas de menor pontuação e lista os assuntos mais frágeis para re-estudo na fila semanal.
              </p>
            </div>
          )}
        </div>

        {/* Right Column: Simulation Cards (8 cols) */}
        <div className="lg:col-span-8 space-y-6">
          {loading ? (
            <p className="text-sm text-gray-400 text-center py-12">Carregando lista de simulados...</p>
          ) : simuladosList.length === 0 ? (
            <div className="bg-white p-12 text-center rounded-lg border border-gray-200 shadow-sm">
              <p className="text-sm font-semibold text-gray-500">Nenhum simulado cadastrado ainda.</p>
              <p className="text-xs text-gray-400 mt-1">Insira seus simulados clicando no botão no topo direito.</p>
            </div>
          ) : (
            <div className="space-y-6">
              {simuladosList.map((sim) => (
                <div 
                  key={sim.id}
                  className="bg-white p-6 rounded-lg border border-gray-200/80 shadow-sm space-y-5 transition-all hover:border-gray-300"
                >
                  {/* Top Metadados */}
                  <div className="flex justify-between items-start border-b pb-3">
                    <div>
                      <span className="text-[10px] font-extrabold uppercase bg-[#17607A]/10 text-[#17607A] px-2 py-0.5 rounded border border-[#17607A]/20">
                        {sim.formato.toUpperCase()}
                      </span>
                      <h3 className="text-sm font-bold text-[#0E3D4D] mt-2">
                        Local: {sim.local} · Duração: {sim.duracaoMin} min
                      </h3>
                    </div>
                    <div className="text-right">
                      <span className="text-xs text-gray-400 block">
                        Realizado em {new Date(sim.data).toLocaleDateString('pt-BR')}
                      </span>
                      <span className="text-xs font-bold text-emerald-600 block mt-0.5">
                        {getSomaAcertos(sim.areas)} / {getSomaTotal(sim.areas)} Acertos
                      </span>
                    </div>
                  </div>

                  {/* Areas score list */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                    {sim.areas?.map((a: any) => (
                      <div key={a.id} className="bg-[#FBF8F3] p-3 rounded-lg border text-center">
                        <span className="text-[9px] font-semibold text-gray-400 block truncate" title={a.area}>{a.area}</span>
                        <span className="text-base font-bold text-[#0E3D4D] block mt-1">{a.acertos}/{a.total}</span>
                        <span className="text-[10px] text-gray-400 mt-0.5 block">Nota Est: {a.notaEstimada}</span>
                      </div>
                    ))}
                  </div>

                  {/* Weak Subjects Analysis */}
                  {sim.analise && (
                    <div className="border border-amber-500/20 bg-amber-500/[0.01] p-4 rounded-xl space-y-3">
                      <div>
                        <span className="text-[10px] uppercase font-bold text-[#B5502B]">Três Assuntos Mais Fracos (Foco de Re-estudo)</span>
                        <p className="text-[10px] text-gray-500">Injete o re-estudo imediato desses tópicos de volta no seu ciclo ativo.</p>
                      </div>

                      <div className="space-y-2">
                        {sim.analise.tresAssuntosFracos?.map((ass: any, idx: number) => (
                          <div key={idx} className="flex justify-between items-center bg-white p-2.5 rounded border border-gray-200 text-xs">
                            <div>
                              <span className="font-semibold text-gray-700">{ass.nome}</span>
                              <span className="block text-[10px] text-rose-500 mt-0.5">Acerto estimado: {ass.acertosPct}%</span>
                            </div>
                            <button
                              onClick={() => handleInjetarReestudo(ass.topicoId)}
                              disabled={injetandoId === ass.topicoId}
                              className="px-3 py-1.5 bg-[#0E3D4D] text-white font-semibold text-[10px] rounded hover:bg-[#17607A] transition-all disabled:opacity-50"
                            >
                              Injetar Re-estudo
                            </button>
                          </div>
                        ))}
                      </div>

                      {sim.analise.errosEstrategia && (
                        <div className="text-[10px] text-gray-500 leading-relaxed border-t pt-2 mt-1">
                          <strong>Dica Estratégica:</strong> {sim.analise.errosEstrategia}
                        </div>
                      )}
                    </div>
                  )}

                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
