'use client';

import { useState, useEffect } from 'react';
import { obterFilaCuradoria, curarItem, enfileirarGeracaoDeArtefatos } from '../app/actions/curadoria';
import { listarArquivosAcervo } from '../app/actions/acervo';

export default function CuradoriaPage() {
  const [fila, setFila] = useState<any[]>([]);
  const [arquivos, setArquivos] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Curation Action States
  const [curandoId, setCurandoId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editData, setEditData] = useState<any>({});
  const [rejeitandoId, setRejeitandoId] = useState<string | null>(null);
  const [motivoRejeicao, setMotivoRejeicao] = useState<string>('');

  // Generation Trigger state
  const [gerandoArquivoId, setGerandoArquivoId] = useState<string | null>(null);
  const [geracaoMsg, setGeracaoMsg] = useState<string>('');

  const loadData = async () => {
    setLoading(true);
    try {
      const pending = await obterFilaCuradoria();
      setFila(pending);

      const files = await listarArquivosAcervo();
      setArquivos(files.filter(f => f.statusProcessamento === 'concluido'));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleAprovar = async (curadoriaId: string) => {
    setCurandoId(curadoriaId);
    try {
      const res = await curarItem(curadoriaId, 'aprovado');
      if (res.sucesso) {
        setFila(prev => prev.filter(item => item.curadoriaId !== curadoriaId));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setCurandoId(null);
    }
  };

  const startEdit = (item: any) => {
    setEditId(item.curadoriaId);
    setEditData({ ...item.conteudo });
  };

  const handleSalvarEdicao = async (curadoriaId: string) => {
    setCurandoId(curadoriaId);
    try {
      const res = await curarItem(curadoriaId, 'editado_e_aprovado', editData);
      if (res.sucesso) {
        setFila(prev => prev.filter(item => item.curadoriaId !== curadoriaId));
        setEditId(null);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setCurandoId(null);
    }
  };

  const handleRejeitar = async (curadoriaId: string) => {
    if (!motivoRejeicao.trim()) return;
    setCurandoId(curadoriaId);
    try {
      const res = await curarItem(curadoriaId, 'rejeitado', null, motivoRejeicao.trim());
      if (res.sucesso) {
        setFila(prev => prev.filter(item => item.curadoriaId !== curadoriaId));
        setRejeitandoId(null);
        setMotivoRejeicao('');
      }
    } catch (err) {
      console.error(err);
    } finally {
      setCurandoId(null);
    }
  };

  const triggerGeracao = async (arquivoId: string) => {
    setGerandoArquivoId(arquivoId);
    setGeracaoMsg('Gerando artefatos pedagógicos via Claude...');
    try {
      const res = await enfileirarGeracaoDeArtefatos(arquivoId);
      if (res.sucesso) {
        setGeracaoMsg('Sucesso: Artefatos enfileirados para curadoria.');
        loadData();
      } else {
        setGeracaoMsg(`Erro: ${res.mensagem}`);
      }
    } catch (err: any) {
      setGeracaoMsg(`Erro: ${err.message}`);
    } finally {
      setGerandoArquivoId(null);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 pb-24 font-['Poppins'] text-[#1B2A33]">
      <header className="mb-8 flex flex-col md:flex-row md:justify-between md:items-center border-b pb-6">
        <div>
          <h1 className="text-3xl font-bold font-['Lora'] text-[#0E3D4D]">Fila de Curadoria</h1>
          <p className="text-sm text-gray-500 mt-1">
            Área do Responsável. Revise, edite e aprove materiais de resumos, flashcards e questões geradas por IA.
          </p>
        </div>

        {/* Gerador de Artefatos manual */}
        {arquivos.length > 0 && (
          <div className="mt-4 md:mt-0 flex gap-2 items-center bg-white p-3 rounded-lg border border-gray-200">
            <span className="text-xs font-semibold text-gray-500">Gerar p/ Arquivo:</span>
            <select
              onChange={e => e.target.value && triggerGeracao(e.target.value)}
              className="text-xs px-2 py-1.5 border border-gray-300 rounded bg-white"
              disabled={!!gerandoArquivoId}
            >
              <option value="">Selecione...</option>
              {arquivos.map(f => (
                <option key={f.id} value={f.id}>{f.titulo}</option>
              ))}
            </select>
            {geracaoMsg && <span className="text-xs text-[#0E3D4D] font-medium block mt-1">{geracaoMsg}</span>}
          </div>
        )}
      </header>

      {loading ? (
        <p className="text-sm text-gray-400">Carregando fila de curadoria...</p>
      ) : fila.length === 0 ? (
        <div className="bg-white p-12 text-center rounded-lg border border-gray-200 shadow-sm">
          <p className="text-sm font-semibold text-gray-500">Sem itens pendentes de curadoria.</p>
          <p className="text-xs text-gray-400 mt-1">Todos os resumos, flashcards e questões gerados estão aprovados ou rejeitados.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* Main Queue List (8 cols) */}
          <div className="lg:col-span-8 space-y-6">
            {fila.map((item) => {
              const isEditing = editId === item.curadoriaId;
              const isRejeitando = rejeitandoId === item.curadoriaId;

              return (
                <div 
                  key={item.curadoriaId}
                  className="bg-white p-6 rounded-lg border border-gray-200/80 shadow-sm space-y-4 transition-all hover:border-gray-300"
                >
                  {/* Top Metadados */}
                  <div className="flex justify-between items-start border-b pb-3">
                    <div>
                      <span className="text-[10px] font-extrabold uppercase bg-amber-500/10 text-amber-600 px-2 py-0.5 rounded border border-amber-500/20">
                        {item.artefatoTipo}
                      </span>
                      <h3 className="text-sm font-bold text-[#0E3D4D] mt-2">
                        Tópico: {item.topicoNome} ({item.disciplinaNome})
                      </h3>
                    </div>
                    <span className="text-xs text-gray-400">
                      Gerado em {new Date(item.criadoEm).toLocaleDateString('pt-BR')}
                    </span>
                  </div>

                  {/* Detalhe do Conteúdo */}
                  <div className="font-['Lora'] text-sm leading-relaxed text-[#1B2A33]">
                    
                    {/* Caso RESUMO */}
                    {item.artefatoTipo === 'resumo' && (
                      <div className="space-y-2">
                        {isEditing ? (
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={editData.titulo || ''}
                              onChange={e => setEditData({ ...editData, titulo: e.target.value })}
                              className="w-full px-3 py-1.5 border rounded text-sm font-semibold"
                            />
                            <textarea
                              value={editData.corpo || ''}
                              onChange={e => setEditData({ ...editData, corpo: e.target.value })}
                              rows={5}
                              className="w-full p-3 border rounded text-sm font-['Lora']"
                            />
                          </div>
                        ) : (
                          <div>
                            <h4 className="font-bold text-base text-[#0E3D4D] mb-2">{item.conteudo.titulo}</h4>
                            <p className="whitespace-pre-wrap">{item.conteudo.corpo}</p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Caso FLASHCARD */}
                    {item.artefatoTipo === 'flashcard' && (
                      <div className="space-y-3">
                        {isEditing ? (
                          <div className="space-y-2">
                            <label className="block text-xs font-bold text-gray-400 uppercase">Pergunta</label>
                            <input
                              type="text"
                              value={editData.pergunta || ''}
                              onChange={e => setEditData({ ...editData, pergunta: e.target.value })}
                              className="w-full px-3 py-1.5 border rounded text-sm"
                            />
                            <label className="block text-xs font-bold text-gray-400 uppercase">Resposta</label>
                            <input
                              type="text"
                              value={editData.resposta || ''}
                              onChange={e => setEditData({ ...editData, resposta: e.target.value })}
                              className="w-full px-3 py-1.5 border rounded text-sm"
                            />
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-4">
                            <div className="bg-[#FBF8F3] p-3 rounded border">
                              <span className="text-[10px] font-bold text-gray-400 block uppercase mb-1">Frente</span>
                              <p className="font-semibold text-sm">{item.conteudo.pergunta}</p>
                            </div>
                            <div className="bg-[#FBF8F3] p-3 rounded border">
                              <span className="text-[10px] font-bold text-gray-400 block uppercase mb-1">Verso</span>
                              <p className="text-sm">{item.conteudo.resposta}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Caso QUESTAO */}
                    {item.artefatoTipo === 'questao' && (
                      <div className="space-y-3">
                        {isEditing ? (
                          <div className="space-y-2">
                            <textarea
                              value={editData.enunciado || ''}
                              onChange={e => setEditData({ ...editData, enunciado: e.target.value })}
                              rows={3}
                              className="w-full p-3 border rounded text-sm font-['Lora']"
                            />
                            <input
                              type="text"
                              value={editData.gabarito || ''}
                              onChange={e => setEditData({ ...editData, gabarito: e.target.value })}
                              className="w-24 px-3 py-1.5 border rounded text-sm"
                              placeholder="Gabarito"
                            />
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <p className="font-semibold">{item.conteudo.enunciado}</p>
                            <ul className="space-y-1.5 pl-4 text-xs font-['Poppins']">
                              {item.conteudo.alternativas?.map((alt: any) => (
                                <li key={alt.letra} className={alt.letra === item.conteudo.gabarito ? 'font-bold text-[#17607A]' : ''}>
                                  <strong>{alt.letra})</strong> {alt.texto}
                                </li>
                              ))}
                            </ul>
                            <div className="mt-2 bg-[#FBF8F3] p-3 rounded text-xs border font-['Poppins']">
                              <p className="font-bold text-[#0E3D4D]">Resolução comentada:</p>
                              <p className="mt-1">{item.conteudo.resolucao}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                  </div>

                  {/* Actions Curation controls */}
                  <div className="flex flex-wrap justify-between items-center gap-3 pt-3 border-t">
                    <div className="flex gap-2">
                      {isEditing ? (
                        <>
                          <button
                            onClick={() => handleSalvarEdicao(item.curadoriaId)}
                            disabled={!!curandoId}
                            className="px-4 py-1.5 bg-[#0E3D4D] text-white text-xs font-semibold rounded hover:bg-[#17607A]"
                          >
                            Salvar e Aprovar
                          </button>
                          <button
                            onClick={() => setEditId(null)}
                            className="px-4 py-1.5 bg-gray-100 text-gray-500 text-xs font-semibold rounded hover:bg-gray-200"
                          >
                            Cancelar
                          </button>
                        </>
                      ) : isRejeitando ? (
                        <div className="flex gap-2 items-center">
                          <input
                            type="text"
                            value={motivoRejeicao}
                            onChange={e => setMotivoRejeicao(e.target.value)}
                            placeholder="Motivo da rejeição..."
                            className="px-3 py-1.5 border rounded text-xs w-64"
                          />
                          <button
                            onClick={() => handleRejeitar(item.curadoriaId)}
                            className="px-4 py-1.5 bg-rose-500 text-white text-xs font-semibold rounded"
                          >
                            Confirmar Rejeição
                          </button>
                          <button
                            onClick={() => setRejeitandoId(null)}
                            className="text-xs text-gray-400 underline"
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() => handleAprovar(item.curadoriaId)}
                            disabled={!!curandoId}
                            className="px-4 py-1.5 bg-emerald-500 text-white text-xs font-semibold rounded hover:bg-emerald-600"
                          >
                            Aprovar
                          </button>
                          <button
                            onClick={() => startEdit(item)}
                            className="px-4 py-1.5 bg-[#17607A] text-white text-xs font-semibold rounded hover:bg-[#124b61]"
                          >
                            Editar e Aprovar
                          </button>
                          <button
                            onClick={() => setRejeitandoId(item.curadoriaId)}
                            className="px-4 py-1.5 bg-rose-500 text-white text-xs font-semibold rounded hover:bg-rose-600"
                          >
                            Rejeitar
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                </div>
              );
            })}
          </div>

          {/* Stats Sidebar (4 cols) */}
          <div className="lg:col-span-4 bg-white p-6 rounded-lg border border-gray-200 shadow-sm h-fit space-y-4">
            <h2 className="text-lg font-semibold font-['Lora'] text-[#0E3D4D] border-b pb-2">Status da Fila</h2>
            <div className="divide-y divide-gray-100 text-sm">
              <div className="flex justify-between py-2.5">
                <span className="text-gray-500">Pendentes:</span>
                <span className="font-bold text-[#0E3D4D]">{fila.length} artefatos</span>
              </div>
              <div className="flex justify-between py-2.5">
                <span className="text-gray-500">Resumos:</span>
                <span className="font-semibold">{fila.filter(f => f.artefatoTipo === 'resumo').length}</span>
              </div>
              <div className="flex justify-between py-2.5">
                <span className="text-gray-500">Flashcards:</span>
                <span className="font-semibold">{fila.filter(f => f.artefatoTipo === 'flashcard').length}</span>
              </div>
              <div className="flex justify-between py-2.5">
                <span className="text-gray-500">Questões:</span>
                <span className="font-semibold">{fila.filter(f => f.artefatoTipo === 'questao').length}</span>
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
