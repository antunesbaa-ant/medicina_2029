'use client';

import { useState, useEffect } from 'react';
import { buscarNoAcervo } from '../app/actions/busca';
import { obterCicloAtivo } from '../app/actions/ciclo';

export default function BuscaPage() {
  const [query, setQuery] = useState<string>('');
  const [disciplinas, setDisciplinas] = useState<Array<{ id: string; nome: string }>>([]);
  const [selectedDisciplina, setSelectedDisciplina] = useState<string>('');
  const [resultados, setResultados] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [hasSearched, setHasSearched] = useState<boolean>(false);

  // Load disciplines
  useEffect(() => {
    async function loadDisciplines() {
      try {
        const ciclo = await obterCicloAtivo();
        if (ciclo) {
          const map = new Map<string, string>();
          ciclo.blocos.forEach(b => {
            map.set(b.disciplinaId, b.disciplina.nome);
          });
          const list = Array.from(map.entries()).map(([id, nome]) => ({ id, nome }));
          setDisciplinas(list);
        }
      } catch (err) {
        console.error(err);
      }
    }
    loadDisciplines();
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setHasSearched(true);
    try {
      const res = await buscarNoAcervo(query, selectedDisciplina || undefined);
      setResultados(res);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 pb-24 font-['Poppins'] text-[#1B2A33]">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-bold font-['Lora'] text-[#0E3D4D]">Busca no Acervo</h1>
        <p className="text-sm text-gray-500 mt-1">
          Pesquise trechos, fórmulas e conceitos nos materiais de estudo integrados ao sistema.
        </p>
      </header>

      {/* Search Input Bar */}
      <form onSubmit={handleSearch} className="bg-white p-4 rounded-lg border border-gray-200/80 shadow-sm flex flex-col md:flex-row gap-3 mb-8">
        <div className="flex-1 relative">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="O que você quer pesquisar? (Ex: Ciclo de Krebs, Citologia, etc.)"
            className="w-full pl-4 pr-10 py-2.5 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-[#17607A] text-sm"
            required
          />
        </div>

        <div className="w-full md:w-48">
          <select
            value={selectedDisciplina}
            onChange={e => setSelectedDisciplina(e.target.value)}
            className="w-full px-3 py-2.5 border border-gray-300 rounded-md bg-white text-sm"
          >
            <option value="">Todas as Disciplinas</option>
            {disciplinas.map(d => (
              <option key={d.id} value={d.id}>{d.nome}</option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="px-6 py-2.5 bg-[#0E3D4D] text-white rounded-md text-sm font-semibold hover:bg-[#17607A] transition-all disabled:opacity-50"
        >
          {loading ? 'Pesquisando...' : 'Pesquisar'}
        </button>
      </form>

      {/* Results Section */}
      <div className="space-y-4">
        {loading ? (
          <div className="text-center py-12">
            <p className="text-sm text-gray-400">Realizando busca híbrida e processando resultados...</p>
          </div>
        ) : resultados.length > 0 ? (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
              {resultados.length} resultados encontrados
            </h2>
            {resultados.map((res) => (
              <div 
                key={res.chunkId} 
                className="bg-white p-6 rounded-lg border border-gray-200/80 shadow-sm space-y-3 hover:border-gray-300 transition-all"
              >
                <div className="flex justify-between items-start text-xs font-semibold text-gray-500">
                  <span className="text-[#17607A] hover:underline cursor-pointer">
                    {res.arquivoTitulo} (Pág. {res.paginaInicial === res.paginaFinal ? res.paginaInicial : `${res.paginaInicial}-${res.paginaFinal}`})
                  </span>
                  <span className="bg-[#17607A]/10 text-[#17607A] px-2 py-0.5 rounded">
                    {Math.round(res.similaridade * 100)}% de relevância
                  </span>
                </div>
                
                <p className="font-['Lora'] text-sm leading-relaxed text-[#1B2A33] whitespace-pre-wrap">
                  {res.texto}
                </p>
              </div>
            ))}
          </div>
        ) : hasSearched ? (
          <div className="text-center py-12 bg-white rounded-lg border border-gray-200/80 shadow-sm p-6">
            <p className="text-sm font-medium text-gray-500">Nenhum trecho correspondente encontrado.</p>
            <p className="text-xs text-gray-400 mt-1">Experimente buscar por outros termos ou verifique se os materiais correspondentes foram ingeridos.</p>
          </div>
        ) : (
          <div className="text-center py-12 bg-white rounded-lg border border-gray-200/60 p-6">
            <p className="text-xs text-gray-400">Insira um termo de pesquisa acima para iniciar a busca semântica no acervo.</p>
          </div>
        )}
      </div>
    </div>
  );
}
