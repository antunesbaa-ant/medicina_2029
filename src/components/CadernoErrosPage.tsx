'use client';

import { useState, useEffect } from 'react';
import { obterCadernoErros, resolverErro } from '../app/actions/cadernoErros';
import { obterCicloAtivo } from '../app/actions/ciclo';

export default function CadernoErrosPage() {
  const [errosList, setErrosList] = useState<any[]>([]);
  const [disciplinas, setDisciplinas] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [mensagemErro, setMensagemErro] = useState<string>('');

  // Filters State
  const [selectedDisciplina, setSelectedDisciplina] = useState<string>('');
  const [selectedTipoErro, setSelectedTipoErro] = useState<string>('');
  const [selectedStatus, setSelectedStatus] = useState<string>('pendente'); // default pendente

  const fetchErros = async () => {
    setLoading(true);
    setMensagemErro('');
    try {
      const res = await obterCadernoErros({
        disciplinaId: selectedDisciplina || undefined,
        tipoErro: (selectedTipoErro as any) || undefined,
        resolvido: selectedStatus === 'resolvido' ? true : selectedStatus === 'pendente' ? false : undefined,
      });
      setErrosList(res);
    } catch {
      setMensagemErro('Não foi possível carregar o caderno de erros. Tente novamente.');
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
          ciclo.blocos.forEach((b) => {
            map.set(b.disciplinaId, b.disciplina.nome);
          });
          const list = Array.from(map.entries()).map(([id, nome]) => ({ id, nome }));
          setDisciplinas(list);
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
      if (res.ok) {
        setErrosList((prev) => prev.map((e) => (e.id === id ? { ...e, resolvidoEm: new Date() } : e)));
        fetchErros();
      } else {
        setMensagemErro(res.message);
      }
    } catch {
      setMensagemErro('Não foi possível atualizar o registro. Tente novamente.');
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
      {mensagemErro && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {mensagemErro}
        </p>
      )}
      <header className="mb-8 flex flex-col md:flex-row justify-between items-start md:items-center border-b pb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold font-['Lora'] text-[#0E3D4D]">Caderno de Erros</h1>
          <p className="text-sm text-gray-500 mt-1">
            Analise e revise seus erros para consolidar conceitos fracos e evitar reincidência.
          </p>
        </div>

        <div className="inline-flex items-center gap-2 bg-[#FBF8F3] px-3.5 py-2 rounded-xl border border-[#D5CBB8] text-xs font-semibold text-[#0E3D4D]">
          <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
          <span>Rastreamento Automático Ativo</span>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Informational notice and filters (4 cols) */}
        <div className="lg:col-span-4 space-y-6">
          <div className="bg-[#FBF8F3] border border-[#D5CBB8] p-5 rounded-2xl space-y-2 text-xs text-[#0E3D4D]">
            <div className="flex items-center gap-1.5 font-bold text-xs uppercase tracking-wider text-[#17607A]">
              <span>💡</span>
              <span>Alimentação Automática</span>
            </div>
            <p className="text-gray-600 leading-relaxed text-[11px]">
              Os erros são catalogados automaticamente durante as sessões de estudo ao encerrar questões incorretas.
              Isso garante a vinculação fidedigna da questão, tópico curricular e estilo de prova para revisão focada.
            </p>
          </div>

          <div className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm space-y-4">
            <h2 className="text-base font-semibold font-['Lora'] text-[#0E3D4D] border-b pb-2">Filtros e Busca</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Disciplina</label>
                <select
                  value={selectedDisciplina}
                  onChange={(e) => setSelectedDisciplina(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg bg-white text-xs"
                >
                  <option value="">Todas</option>
                  {disciplinas.map((d) => (
                    <option key={d.id} value={d.id}>{d.nome}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Tipo de Erro</label>
                <select
                  value={selectedTipoErro}
                  onChange={(e) => setSelectedTipoErro(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg bg-white text-xs"
                >
                  <option value="">Todos</option>
                  <option value="conteudo">Teoria / Conteúdo</option>
                  <option value="interpretacao">Interpretação</option>
                  <option value="distracao">Distração / Atenção</option>
                  <option value="calculo">Cálculo / Matemática</option>
                  <option value="tempo">Estouro de Tempo</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Status</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedStatus('pendente')}
                    className={`flex-1 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
                      selectedStatus === 'pendente'
                        ? 'bg-[#0E3D4D] text-white border-[#0E3D4D]'
                        : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
                    }`}
                  >
                    Pendentes
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedStatus('resolvido')}
                    className={`flex-1 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
                      selectedStatus === 'resolvido'
                        ? 'bg-[#0E3D4D] text-white border-[#0E3D4D]'
                        : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
                    }`}
                  >
                    Resolvidos
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedStatus('todos')}
                    className={`flex-1 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
                      selectedStatus === 'todos'
                        ? 'bg-[#0E3D4D] text-white border-[#0E3D4D]'
                        : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
                    }`}
                  >
                    Todos
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Error list (8 cols) */}
        <div className="lg:col-span-8 space-y-4">
          <div className="flex justify-between items-center text-xs text-gray-400 font-semibold mb-2">
            <span>{errosList.length} registros encontrados</span>
            <span>Ordenados por relevância e pendência</span>
          </div>

          {loading ? (
            <p className="text-sm text-gray-400 text-center py-12">Carregando caderno de erros...</p>
          ) : errosList.length === 0 ? (
            <div className="bg-white p-12 text-center rounded-2xl border border-gray-200 shadow-sm">
              <span className="text-4xl block mb-2">🎉</span>
              <p className="text-sm font-semibold text-gray-600">Nenhum erro encontrado com os filtros atuais.</p>
              <p className="text-xs text-gray-400 mt-1">
                Continue praticando suas sessões de estudo. Se errar alguma questão, ela será listada aqui.
              </p>
            </div>
          ) : (
            errosList.map((erro) => {
              const isResolvido = !!erro.resolvidoEm;
              return (
                <div
                  key={erro.id}
                  className={`bg-white p-6 rounded-2xl border shadow-sm transition-all hover:border-gray-300 space-y-3 ${
                    isResolvido ? 'border-emerald-200/60 bg-emerald-500/[0.01]' : 'border-gray-200'
                  }`}
                >
                  <div className="flex justify-between items-start gap-4 border-b pb-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded border"
                        style={{
                          backgroundColor: `${erro.corHex || '#0E3D4D'}15`,
                          color: erro.corHex || '#0E3D4D',
                          borderColor: `${erro.corHex || '#0E3D4D'}30`,
                        }}
                      >
                        {erro.disciplinaNome}
                      </span>
                      <span className="text-xs text-gray-400">•</span>
                      <span className="text-xs font-bold text-gray-700">{erro.topicoNome}</span>
                      <span className="text-xs text-gray-400">•</span>
                      <span className="text-[10px] font-semibold bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                        {getTipoErroLabel(erro.tipoErro)}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {isResolvido ? (
                        <span className="bg-emerald-500/10 text-emerald-600 text-[10px] font-bold px-2.5 py-1 rounded-full border border-emerald-500/20">
                          Resolvido
                        </span>
                      ) : (
                        <button
                          onClick={() => handleResolver(erro.id)}
                          className="px-3 py-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 text-[10px] font-bold rounded-lg transition-all"
                        >
                          Marcar como Resolvido
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div>
                      <strong className="text-gray-400 uppercase tracking-widest text-[9px] block mb-0.5">
                        O que foi registrado:
                      </strong>
                      <p className="text-gray-800 leading-relaxed font-medium">
                        {erro.descricaoLivre || 'Sem descrição livre informada.'}
                      </p>
                    </div>

                    {erro.conceitoCorreto && (
                      <div className="bg-[#FBF8F3] p-3 rounded-xl border border-[#D5CBB8] text-xs">
                        <strong className="text-[#0E3D4D] font-bold uppercase tracking-wider text-[9px] block mb-0.5">
                          Conceito Correto a Fixar:
                        </strong>
                        <p className="text-gray-700 leading-relaxed font-['Lora'] italic">"{erro.conceitoCorreto}"</p>
                      </div>
                    )}
                  </div>

                  <div className="flex justify-between items-center text-[10px] text-gray-400 border-t pt-2 mt-2">
                    <span>Criado em: {new Date(erro.criadoEm).toLocaleDateString('pt-BR')}</span>
                    {isResolvido && erro.resolvidoEm && (
                      <span>Superado em: {new Date(erro.resolvidoEm).toLocaleDateString('pt-BR')}</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
