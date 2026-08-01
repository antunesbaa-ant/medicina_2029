'use client';

import { useState, useEffect } from 'react';
import { obterGenerosUECE, obterRepertorios, obterRedacoes, registrarRedacao, registrarRepertorio } from '../app/actions/redacoes';

export default function RedacoesPage() {
  const [redacoesList, setRedacoesList] = useState<any[]>([]);
  const [repertoriosList, setRepertoriosList] = useState<any[]>([]);
  const [generosList, setGenerosList] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<'redacoes' | 'repertorios' | 'generos'>('redacoes');

  // Redação Form State
  const [showRedacaoForm, setShowRedacaoForm] = useState<boolean>(false);
  const [formato, setFormato] = useState<'enem' | 'genero_uece'>('enem');
  const [generoId, setGeneroId] = useState<string>('');
  const [tema, setTema] = useState<string>('');
  const [texto, setTexto] = useState<string>('');
  const [minutos, setMinutos] = useState<number>(55);
  const [salvandoRedacao, setSalvandoRedacao] = useState<boolean>(false);

  // Repertório Form State
  const [showRepertorioForm, setShowRepertorioForm] = useState<boolean>(false);
  const [referencia, setReferencia] = useState<string>('');
  const [resumo, setResumo] = useState<string>('');
  const [tagsInput, setTagsInput] = useState<string>('');
  const [categoria, setCategoria] = useState<string>('Sociologia');
  const [salvandoRepertorio, setSalvandoRepertorio] = useState<boolean>(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const red = await obterRedacoes();
      setRedacoesList(red);

      const rep = await obterRepertorios();
      setRepertoriosList(rep);

      const gen = await obterGenerosUECE();
      setGenerosList(gen);
      if (gen.length > 0) {
        setGeneroId(gen[0].id);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSalvarRedacao = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tema || !texto) return;

    setSalvandoRedacao(true);
    try {
      const res = await registrarRedacao({
        formato,
        generoId: formato === 'genero_uece' ? generoId : undefined,
        tema,
        texto,
        minutosGastos: minutos
      });

      if (res.sucesso) {
        setTema('');
        setTexto('');
        setShowRedacaoForm(false);
        loadData();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSalvandoRedacao(false);
    }
  };

  const handleSalvarRepertorio = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!referencia || !resumo) return;

    setSalvandoRepertorio(true);
    try {
      const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
      const res = await registrarRepertorio({
        referencia,
        resumo2Linhas: resumo,
        temasAplicaveis: tags,
        categoria
      });

      if (res.sucesso) {
        setReferencia('');
        setResumo('');
        setTagsInput('');
        setShowRepertorioForm(false);
        loadData();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSalvandoRepertorio(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 pb-24 font-['Poppins'] text-[#1B2A33] space-y-8">
      
      {/* Header */}
      <header className="border-b pb-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold font-['Lora'] text-[#0E3D4D]">Redação e Repertório</h1>
          <p className="text-sm text-gray-500 mt-1">
            Escreva redações do ENEM e da UECE, consulte fichas de gêneros textuais e gerencie seu banco de repertório sociocultural.
          </p>
        </div>

        {/* Tab Controls */}
        <div className="flex bg-[#F1EFEA] p-1.5 rounded-xl border border-gray-200 text-xs font-semibold gap-1">
          <button
            onClick={() => setActiveTab('redacoes')}
            className={`px-4 py-2 rounded-lg transition-all ${
              activeTab === 'redacoes' ? 'bg-[#0E3D4D] text-white shadow-sm' : 'text-gray-500 hover:text-[#0E3D4D]'
            }`}
          >
            Redações
          </button>
          <button
            onClick={() => setActiveTab('repertorios')}
            className={`px-4 py-2 rounded-lg transition-all ${
              activeTab === 'repertorios' ? 'bg-[#0E3D4D] text-white shadow-sm' : 'text-gray-500 hover:text-[#0E3D4D]'
            }`}
          >
            Repertórios
          </button>
          <button
            onClick={() => setActiveTab('generos')}
            className={`px-4 py-2 rounded-lg transition-all ${
              activeTab === 'generos' ? 'bg-[#0E3D4D] text-white shadow-sm' : 'text-gray-500 hover:text-[#0E3D4D]'
            }`}
          >
            Fichas de Gêneros
          </button>
        </div>
      </header>

      {loading ? (
        <p className="text-sm text-gray-400 text-center py-12">Carregando dados pedagógicos...</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* Main Workspace Column (8 cols) */}
          <div className="lg:col-span-8 space-y-6">
            
            {/* TAB REDACOES */}
            {activeTab === 'redacoes' && (
              <div className="space-y-6">
                {showRedacaoForm ? (
                  <div className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm space-y-4">
                    <h2 className="text-lg font-bold font-['Lora'] text-[#0E3D4D]">Registrar Redação Escrita</h2>
                    <form onSubmit={handleSalvarRedacao} className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Formato</label>
                          <select
                            value={formato}
                            onChange={e => setFormato(e.target.value as any)}
                            className="w-full px-2 py-2 border rounded bg-white text-xs"
                          >
                            <option value="enem">ENEM</option>
                            <option value="genero_uece">Gênero UECE</option>
                          </select>
                        </div>
                        {formato === 'genero_uece' && (
                          <div>
                            <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Gênero Alvo</label>
                            <select
                              value={generoId}
                              onChange={e => setGeneroId(e.target.value)}
                              className="w-full px-2 py-2 border rounded bg-white text-xs"
                            >
                              {generosList.map(g => (
                                <option key={g.id} value={g.id}>{g.nome}</option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div>
                          <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Tempo de Escrita (min)</label>
                          <input
                            type="number"
                            value={minutos}
                            onChange={e => setMinutos(parseInt(e.target.value) || 0)}
                            className="w-full px-3 py-1.5 border rounded text-xs"
                            required
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Tema da Redação</label>
                        <input
                          type="text"
                          value={tema}
                          onChange={e => setTema(e.target.value)}
                          placeholder="Ex: O estigma associado às doenças mentais na sociedade brasileira..."
                          className="w-full px-3 py-2 border rounded-lg text-sm"
                          required
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Corpo da Redação (Texto escrito)</label>
                        <textarea
                          value={texto}
                          onChange={e => setTexto(e.target.value)}
                          placeholder="Cole ou digite aqui a sua redação escrita..."
                          rows={10}
                          className="w-full p-4 border rounded-xl text-sm font-['Lora'] leading-relaxed focus:outline-none"
                          required
                        />
                      </div>

                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={salvandoRedacao}
                          className="px-5 py-2.5 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg hover:bg-[#17607A]"
                        >
                          {salvandoRedacao ? 'Salvando...' : 'Gravar Redação'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowRedacaoForm(false)}
                          className="px-5 py-2.5 bg-gray-100 text-gray-500 text-xs font-bold rounded-lg hover:bg-gray-200"
                        >
                          Cancelar
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {redacoesList.length === 0 ? (
                      <div className="bg-white p-12 text-center rounded-lg border border-gray-200 shadow-sm">
                        <p className="text-sm font-semibold text-gray-500">Nenhuma redação registrada ainda.</p>
                        <p className="text-xs text-gray-400 mt-1">Grave suas produções de redação clicando no botão do topo direito.</p>
                      </div>
                    ) : (
                      redacoesList.map((red) => (
                        <div key={red.id} className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm space-y-3 transition-all hover:border-gray-300">
                          <div className="flex justify-between items-start border-b pb-2">
                            <div>
                              <span className="text-[10px] font-extrabold uppercase bg-emerald-500/10 text-emerald-600 px-2 py-0.5 rounded border border-emerald-500/20">
                                {red.formato === 'enem' ? 'ENEM' : `UECE: ${red.generoNome || ''}`}
                              </span>
                              <h3 className="text-sm font-bold text-[#0E3D4D] mt-2">{red.tema}</h3>
                            </div>
                            <div className="text-right text-xs">
                              <span className="text-gray-400 block">{new Date(red.escritaEm).toLocaleDateString('pt-BR')}</span>
                              <span className="font-bold text-[#0E3D4D] block mt-0.5">Nota: {red.notaTotal} pts</span>
                            </div>
                          </div>
                          <p className="text-xs text-gray-500 leading-relaxed max-h-32 overflow-y-auto font-['Lora'] italic bg-gray-50 p-3 rounded-lg border border-dashed">
                            "{red.texto}"
                          </p>
                          <div className="text-[10px] text-gray-400 font-semibold">
                            Tempo de produção: {red.minutosGastos} minutos
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            {/* TAB REPERTORIOS */}
            {activeTab === 'repertorios' && (
              <div className="space-y-6">
                {showRepertorioForm ? (
                  <div className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm space-y-4">
                    <h2 className="text-lg font-bold font-['Lora'] text-[#0E3D4D]">Adicionar Repertório Sociocultural</h2>
                    <form onSubmit={handleSalvarRepertorio} className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Autor / Referência</label>
                          <input
                            type="text"
                            value={referencia}
                            onChange={e => setReferencia(e.target.value)}
                            placeholder="Ex: Zygmunt Bauman"
                            className="w-full px-3 py-2 border rounded-lg text-sm"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Categoria</label>
                          <select
                            value={categoria}
                            onChange={e => setCategoria(e.target.value)}
                            className="w-full px-2 py-2 border rounded bg-white text-xs"
                          >
                            <option value="Sociologia">Sociologia</option>
                            <option value="Filosofia">Filosofia</option>
                            <option value="Legislação">Legislação / Leis</option>
                            <option value="História">História</option>
                            <option value="Literatura">Literatura / Artes</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Resumo das Ideias (2 Linhas)</label>
                        <textarea
                          value={resumo}
                          onChange={e => setResumo(e.target.value)}
                          placeholder="Escreva uma síntese curta da tese do autor..."
                          rows={2}
                          className="w-full p-2.5 border rounded-lg text-sm focus:outline-none"
                          required
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Temas Aplicáveis (separados por vírgula)</label>
                        <input
                          type="text"
                          value={tagsInput}
                          onChange={e => setTagsInput(e.target.value)}
                          placeholder="Ex: Tecnologia, Individualismo, Saúde Mental"
                          className="w-full px-3 py-2 border rounded-lg text-sm"
                        />
                      </div>

                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={salvandoRepertorio}
                          className="px-5 py-2.5 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg hover:bg-[#17607A]"
                        >
                          {salvandoRepertorio ? 'Adicionando...' : 'Gravar Repertório'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowRepertorioForm(false)}
                          className="px-5 py-2.5 bg-gray-100 text-gray-500 text-xs font-bold rounded-lg hover:bg-gray-200"
                        >
                          Cancelar
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <button
                      onClick={() => setShowRepertorioForm(true)}
                      className="w-full py-3 bg-[#FBF8F3] hover:bg-[#F1EFEA] border-2 border-dashed border-[#D5CBB8] text-[#0E3D4D] font-bold text-xs rounded-xl transition-all text-center"
                    >
                      + Adicionar Novo Repertório Sociocultural
                    </button>
                    {repertoriosList.map((rep) => (
                      <div key={rep.id} className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm space-y-3 transition-all hover:border-gray-300">
                        <div className="flex justify-between items-center border-b pb-2">
                          <h4 className="text-sm font-bold text-[#0E3D4D]">{rep.referencia}</h4>
                          <span className="bg-[#B5502B]/10 text-[#B5502B] text-[10px] font-bold px-2 py-0.5 rounded border border-[#B5502B]/20">
                            {rep.categoria}
                          </span>
                        </div>
                        <p className="text-xs text-gray-600 leading-relaxed font-['Lora'] italic">
                          "{rep.resumo2Linhas}"
                        </p>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {rep.temasAplicaveis?.map((tag: string, tIdx: number) => (
                            <span key={tIdx} className="bg-gray-100 text-gray-500 text-[9px] font-semibold px-2 py-0.5 rounded border">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB FICHAS DE GENEROS */}
            {activeTab === 'generos' && (
              <div className="space-y-6">
                {generosList.map((gen) => (
                  <div key={gen.id} className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm space-y-4 transition-all hover:border-gray-300">
                    <div className="flex justify-between items-center border-b pb-2">
                      <h3 className="text-base font-bold text-[#0E3D4D] font-['Lora']">{gen.nome}</h3>
                      <span className="bg-emerald-500/10 text-emerald-600 text-[10px] font-bold px-2 py-0.5 rounded border border-emerald-500/20">Ficha Completa</span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                      <div className="space-y-1 bg-[#FBF8F3] p-3 rounded-lg border">
                        <strong className="text-[#0E3D4D] block uppercase tracking-wider text-[9px] font-bold text-gray-400">Finalidade Pedagógica</strong>
                        <p className="text-gray-700 leading-relaxed">{gen.finalidade}</p>
                      </div>
                      <div className="space-y-1 bg-[#FBF8F3] p-3 rounded-lg border">
                        <strong className="text-[#0E3D4D] block uppercase tracking-wider text-[9px] font-bold text-gray-400">Interlocutor e Canal</strong>
                        <p className="text-gray-700 leading-relaxed">{gen.interlocutor}</p>
                      </div>
                    </div>

                    <div className="text-xs space-y-2">
                      <div className="bg-[#FBF8F3] p-3 rounded-lg border space-y-1">
                        <strong className="text-[#0E3D4D] block uppercase tracking-wider text-[9px] font-bold text-gray-400 font-['Poppins']">Estrutura Textual Exigida</strong>
                        <p className="text-gray-700 leading-relaxed font-['Lora'] italic">{gen.estrutura}</p>
                      </div>
                      <div className="bg-[#FBF8F3] p-3 rounded-lg border space-y-1">
                        <strong className="text-[#0E3D4D] block uppercase tracking-wider text-[9px] font-bold text-gray-400 font-['Poppins']">Marcas de Linguagem</strong>
                        <p className="text-gray-700 leading-relaxed font-['Lora'] italic">{gen.marcasLinguagem}</p>
                      </div>
                      <div className="bg-rose-500/[0.02] border border-rose-500/20 p-3 rounded-lg text-rose-700 space-y-1">
                        <strong className="block uppercase tracking-wider text-[9px] font-bold text-rose-500 font-['Poppins']">Fator de Descaracterização (Zerar)</strong>
                        <p className="leading-relaxed font-semibold italic">{gen.erroQueDescaracteriza}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

          </div>

          {/* Target Stats Sidebar (4 cols) */}
          <div className="lg:col-span-4 space-y-6">
            <section className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm h-fit space-y-4">
              <h3 className="text-lg font-bold font-['Lora'] text-[#0E3D4D] border-b pb-2">Status da Temporada</h3>
              <div className="divide-y divide-gray-100 text-xs">
                <div className="flex justify-between py-2.5">
                  <span className="text-gray-500">Redações escritas:</span>
                  <span className="font-bold text-[#0E3D4D]">{redacoesList.length}</span>
                </div>
                <div className="flex justify-between py-2.5">
                  <span className="text-gray-500">Reescritas realizadas:</span>
                  <span className="font-bold">{redacoesList.filter(r => r.reescritadeId !== null).length}</span>
                </div>
                <div className="flex justify-between py-2.5">
                  <span className="text-gray-500">Repertórios na base:</span>
                  <span className="font-bold">{repertoriosList.length}</span>
                </div>
                <div className="flex justify-between py-2.5">
                  <span className="text-gray-500">Gêneros UECE disponíveis:</span>
                  <span className="font-bold">{generosList.length}</span>
                </div>
              </div>
              {activeTab === 'redacoes' && !showRedacaoForm && (
                <button
                  onClick={() => setShowRedacaoForm(true)}
                  className="w-full py-2 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg hover:bg-[#17607A] transition-all text-center"
                >
                  Nova Redação
                </button>
              )}
            </section>
          </div>

        </div>
      )}
    </div>
  );
}
