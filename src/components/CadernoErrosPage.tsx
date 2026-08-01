'use client';

import { useState, useEffect } from 'react';
import { obterCadernoErros, resolverErro, registrarErroManual } from '../app/actions/cadernoErros';
import { obterCicloAtivo } from '../app/actions/ciclo';

export default function CadernoErrosPage() {
  const [errosList, setErrosList] = useState<any[]>([]);
  const [disciplinas, setDisciplinas] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Filters State
  const [selectedDisciplina, setSelectedDisciplina] = useState<string>('');
  const [selectedTipoErro, setSelectedTipoErro] = useState<string>('');
  const [selectedStatus, setSelectedStatus] = useState<string>('pendente'); // default pendente

  // Manual error form state
  const [exibirForm, setExibirForm] = useState<boolean>(false);
  const [descricao, setDescricao] = useState<string>('');
  const [tipoErroForm, setTipoErroForm] = useState<'conteudo' | 'interpretacao' | 'distracao' | 'calculo' | 'tempo'>('conteudo');
  const [conceito, setConceito] = useState<string>('');
  const [formDisciplina, setFormDisciplina] = useState<string>('');
  const [formTopico, setFormTopico] = useState<string>('');
  const [topicosList, setTopicosList] = useState<any[]>([]);
  const [salvando, setSalvando] = useState<boolean>(false);

  const fetchErros = async () => {
    setLoading(true);
    try {
      const res = await obterCadernoErros({
        disciplinaId: selectedDisciplina || undefined,
        tipoErro: selectedTipoErro as any || undefined,
        resolvido: selectedStatus === 'resolvido' ? true : selectedStatus === 'pendente' ? false : undefined
      });
      setErrosList(res);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchErros();
  }, [selectedDisciplina, selectedTipoErro, selectedStatus]);

  // Load initial data
  useEffect(() => {
    async function loadData() {
      try {
        const ciclo = await obterCicloAtivo();
        if (ciclo) {
          const map = new Map<string, string>();
          ciclo.blocos.forEach(b => {
            map.set(b.disciplinaId, b.disciplina.nome);
          });
          const list = Array.from(map.entries()).map(([id, nome]) => ({ id, nome }));
          setDisciplinas(list);
          if (list.length > 0) {
            setFormDisciplina(list[0].id);
          }
        }
      } catch (err) {
        console.error(err);
      }
    }
    loadData();
  }, []);

  const handleResolver = async (id: string) => {
    try {
      const res = await resolverErro(id);
      if (res.sucesso) {
        setErrosList(prev => prev.map(e => e.id === id ? { ...e, resolvidoEm: new Date() } : e));
        fetchErros();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSalvarErro = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!descricao || !formDisciplina || !conceito) return;

    setSalvando(true);
    try {
      // Mock topic link or fallback
      const topicoMockId = formTopico || '00000000-0000-0000-0000-000000000001';
      const res = await registrarErroManual({
        descricaoLivre: descricao,
        topicoId: topicoMockId,
        disciplinaId: formDisciplina,
        estilo: 'enem',
        tipoErro: tipoErroForm,
        conceitoCorreto: conceito
      });

      if (res.sucesso) {
        setDescricao('');
        setConceito('');
        setExibirForm(false);
        fetchErros();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSalvando(false);
    }
  };

  const getTipoErroLabel = (tipo: string) => {
    switch (tipo) {
      case 'conteudo': return 'Teoria / Conteúdo';
      case 'calculo': return 'Cálculo / Matemática';
      case 'interpretacao': return 'Interpretação';
      case 'distracao': return 'Distração / Atenção';
      case 'tempo': return 'Estouro de Tempo';
      default: return tipo;
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 pb-24 font-['Poppins'] text-[#1B2A33]">
      <header className="mb-8 flex flex-col md:flex-row justify-between items-start md:items-center border-b pb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold font-['Lora'] text-[#0E3D4D]">Caderno de Erros</h1>
          <p className="text-sm text-gray-500 mt-1">
            Analise e revise seus erros para consolidar conceitos fracos e evitar reincidência.
          </p>
        </div>

        <button
          onClick={() => setExibirForm(!exibirForm)}
          className="px-4 py-2 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg hover:bg-[#17607A] transition-all"
        >
          {exibirForm ? 'Fechar Form' : '+ Registrar Erro Manual'}
        </button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Column: Form or filters (4 cols) */}
        <div className="lg:col-span-4 space-y-6">
          {exibirForm ? (
            <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm space-y-4">
              <h2 className="text-lg font-semibold font-['Lora'] text-[#0E3D4D]">Registrar Novo Erro</h2>
              
              <form onSubmit={handleSalvarErro} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Dificuldade / O que errou?</label>
                  <textarea
                    value={descricao}
                    onChange={e => setDescricao(e.target.value)}
                    placeholder="Ex: Confundi mitocôndria com cloroplasto na fotossíntese..."
                    rows={3}
                    className="w-full p-2.5 border rounded-lg text-sm text-gray-700 focus:outline-none"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Conceito Correto (Fato a Fixar)</label>
                  <input
                    type="text"
                    value={conceito}
                    onChange={e => setConceito(e.target.value)}
                    placeholder="Ex: A fotossíntese ocorre nos cloroplastos..."
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Disciplina</label>
                    <select
                      value={formDisciplina}
                      onChange={e => setFormDisciplina(e.target.value)}
                      className="w-full px-2 py-2 border rounded bg-white text-xs"
                      required
                    >
                      {disciplinas.map(d => (
                        <option key={d.id} value={d.id}>{d.nome}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Tipo de Erro</label>
                    <select
                      value={tipoErroForm}
                      onChange={e => setTipoErroForm(e.target.value as any)}
                      className="w-full px-2 py-2 border rounded bg-white text-xs"
                    >
                      <option value="conteudo">Teoria</option>
                      <option value="interpretacao">Interpretação</option>
                      <option value="distracao">Atenção</option>
                      <option value="calculo">Cálculo</option>
                      <option value="tempo">Tempo</option>
                    </select>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={salvando}
                  className="w-full py-2 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg hover:bg-[#17607A]"
                >
                  {salvando ? 'Gravando...' : 'Gravar no Caderno'}
                </button>
              </form>
            </div>
          ) : (
            <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm space-y-4">
              <h2 className="text-lg font-semibold font-['Lora'] text-[#0E3D4D]">Filtros e Busca</h2>
              
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Disciplina</label>
                  <select
                    value={selectedDisciplina}
                    onChange={e => setSelectedDisciplina(e.target.value)}
                    className="w-full px-3 py-2 border rounded-md bg-white text-xs"
                  >
                    <option value="">Todas</option>
                    {disciplinas.map(d => (
                      <option key={d.id} value={d.id}>{d.nome}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Tipo de Erro</label>
                  <select
                    value={selectedTipoErro}
                    onChange={e => setSelectedTipoErro(e.target.value)}
                    className="w-full px-3 py-2 border rounded-md bg-white text-xs"
                  >
                    <option value="">Todos</option>
                    <option value="conteudo">Teoria / Conceito</option>
                    <option value="interpretacao">Interpretação</option>
                    <option value="distracao">Atenção / Distração</option>
                    <option value="calculo">Cálculo</option>
                    <option value="tempo">Tempo</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Status</label>
                  <select
                    value={selectedStatus}
                    onChange={e => setSelectedStatus(e.target.value)}
                    className="w-full px-3 py-2 border rounded-md bg-white text-xs"
                  >
                    <option value="pendente">Pendentes (Não Resolvidos)</option>
                    <option value="resolvido">Resolvidos</option>
                    <option value="todos">Todos</option>
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Error Cards (8 cols) */}
        <div className="lg:col-span-8 space-y-4">
          {loading ? (
            <p className="text-sm text-gray-400 text-center py-12">Carregando caderno de erros...</p>
          ) : errosList.length === 0 ? (
            <div className="bg-white p-12 text-center rounded-lg border border-gray-200 shadow-sm">
              <p className="text-sm font-semibold text-gray-500">Nenhum erro encontrado.</p>
              <p className="text-xs text-gray-400 mt-1">Ótimo sinal! Continue praticando questões e monitorando lacunas.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {errosList.map((err) => (
                <div 
                  key={err.id}
                  className={`bg-white p-5 rounded-lg border shadow-sm transition-all hover:border-gray-300 flex flex-col md:flex-row justify-between items-start gap-4 ${
                    err.resolvidoEm ? 'border-emerald-500/20 bg-emerald-500/[0.01]' : 'border-gray-200/80'
                  }`}
                >
                  <div className="space-y-2 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: err.corHex }} />
                      <span className="text-xs font-semibold text-gray-500">{err.disciplinaNome}</span>
                      <span className="text-xs text-gray-400 font-medium">· Tópico: {err.topicoNome}</span>
                    </div>

                    <p className="font-['Lora'] text-sm leading-relaxed text-[#1B2A33]">
                      {err.descricaoLivre}
                    </p>

                    <div className="bg-[#FBF8F3] p-3 rounded-lg border text-xs">
                      <strong className="text-[#0E3D4D]">Conceito Correto:</strong>
                      <p className="italic font-lora-read text-gray-600 mt-0.5">"{err.conceitoCorreto}"</p>
                    </div>

                    <div className="flex gap-2">
                      <span className="bg-rose-500/10 text-rose-600 text-[10px] font-semibold px-2 py-0.5 rounded border border-rose-500/20">
                        {getTipoErroLabel(err.tipoErro)}
                      </span>
                      {err.resolvidoEm && (
                        <span className="bg-emerald-500/10 text-emerald-600 text-[10px] font-semibold px-2 py-0.5 rounded border border-emerald-500/20">
                          Resolvido em {new Date(err.resolvidoEm).toLocaleDateString('pt-BR')}
                        </span>
                      )}
                    </div>
                  </div>

                  {!err.resolvidoEm && (
                    <button
                      onClick={() => handleResolver(err.id)}
                      className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold rounded-lg transition-all w-full md:w-auto text-center self-end md:self-center"
                    >
                      Resolver
                    </button>
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
