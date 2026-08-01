'use client';

import { useState, useEffect } from 'react';
import { enviarArquivo, listarArquivosAcervo, obterAcervoStatus } from '../app/actions/acervo';
import { obterCicloAtivo } from '../app/actions/ciclo';

export default function AcervoPage() {
  const [perfilId, setPerfilId] = useState<string>('00000000-0000-0000-0000-000000000002'); // Bruno (Responsável)
  const [disciplinas, setDisciplinas] = useState<Array<{ id: string; nome: string }>>([]);
  const [selectedDisciplina, setSelectedDisciplina] = useState<string>('');
  const [titulo, setTitulo] = useState<string>('');
  const [tipoMaterial, setTipoMaterial] = useState<'livro' | 'apostila' | 'slide' | 'lista_exercicios' | 'anotacao_aula' | 'prova_oficial' | 'resumo_proprio' | 'outro'>('livro');
  const [serieAlvo, setSerieAlvo] = useState<number>(1);
  const [arquivos, setArquivos] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // File Upload State
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadMessage, setUploadMessage] = useState<string>('');

  // Selected File Viewer
  const [viewerArquivoId, setViewerArquivoId] = useState<string | null>(null);
  const [viewerData, setViewerData] = useState<any>(null);
  const [viewerLoading, setViewerLoading] = useState<boolean>(false);
  const [viewerPage, setViewerPage] = useState<number>(1);

  // Fetch initial data
  useEffect(() => {
    async function loadData() {
      try {
        const ciclo = await obterCicloAtivo();
        if (ciclo && ciclo.blocos.length > 0) {
          // Extrair disciplinas únicas do ciclo
          const map = new Map<string, string>();
          ciclo.blocos.forEach(b => {
            map.set(b.disciplinaId, b.disciplina.nome);
          });
          const list = Array.from(map.entries()).map(([id, nome]) => ({ id, nome }));
          setDisciplinas(list);
          if (list.length > 0) setSelectedDisciplina(list[0].id);
        }

        const files = await listarArquivosAcervo();
        setArquivos(files);
      } catch (err) {
        console.error('Erro ao carregar dados:', err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // Poll processing files status
  useEffect(() => {
    const processingFiles = arquivos.filter(f => 
      ['aguardando', 'extraindo', 'segmentando', 'classificando', 'indexando'].includes(f.statusProcessamento)
    );

    if (processingFiles.length === 0) return;

    const interval = setInterval(async () => {
      const updatedFiles = await listarArquivosAcervo();
      setArquivos(updatedFiles);

      // Se o arquivo sendo visualizado for atualizado, recarrega seus dados
      if (viewerArquivoId) {
        const updatedViewer = updatedFiles.find(f => f.id === viewerArquivoId);
        const currentViewerState = arquivos.find(f => f.id === viewerArquivoId);
        if (updatedViewer && updatedViewer.statusProcessamento !== currentViewerState?.statusProcessamento) {
          const detail = await obterAcervoStatus(viewerArquivoId);
          setViewerData(detail);
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [arquivos, viewerArquivoId]);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile.type === 'application/pdf') {
        setFile(droppedFile);
        if (!titulo) setTitulo(droppedFile.name.replace(/\.[^/.]+$/, ""));
      } else {
        setUploadMessage('Erro: Apenas arquivos PDF são aceitos no momento.');
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      if (!titulo) setTitulo(selectedFile.name.replace(/\.[^/.]+$/, ""));
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !selectedDisciplina || !titulo) {
      setUploadMessage('Erro: Preencha todos os campos obrigatórios e envie um arquivo.');
      return;
    }

    setUploading(true);
    setUploadMessage('Carregando e preparando arquivo...');

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64Data = (reader.result as string).split(',')[1];
        
        const res = await enviarArquivo(
          selectedDisciplina,
          titulo.trim(),
          tipoMaterial,
          serieAlvo,
          file.name,
          base64Data,
          perfilId
        );

        if (res.sucesso) {
          setUploadMessage('Sucesso: Arquivo enfileirado para processamento.');
          setFile(null);
          setTitulo('');
          const files = await listarArquivosAcervo();
          setArquivos(files);
        } else {
          setUploadMessage(`Erro: ${res.mensagem}`);
        }
        setUploading(false);
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      setUploadMessage(`Erro: ${err.message || 'Falha no processamento.'}`);
      setUploading(false);
    }
  };

  const selectViewerArquivo = async (id: string) => {
    setViewerArquivoId(id);
    setViewerLoading(true);
    setViewerPage(1);
    try {
      const data = await obterAcervoStatus(id);
      setViewerData(data);
    } catch (err) {
      console.error(err);
    } finally {
      setViewerLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'concluido': return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20';
      case 'falhou': return 'bg-rose-500/10 text-rose-600 border-rose-500/20';
      case 'aguardando': return 'bg-amber-500/10 text-amber-600 border-amber-500/20';
      default: return 'bg-[#17607A]/10 text-[#17607A] border-[#17607A]/20';
    }
  };

  const getStepProgress = (status: string) => {
    const steps = ['aguardando', 'extraindo', 'segmentando', 'classificando', 'indexando', 'concluido'];
    const curIdx = steps.indexOf(status);
    if (status === 'falhou') return 0;
    if (curIdx === -1) return 0;
    return Math.round(((curIdx + 1) / steps.length) * 100);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 pb-24 font-['Poppins'] text-[#1B2A33]">
      <header className="mb-8">
        <h1 className="text-3xl font-bold font-['Lora'] text-[#0E3D4D]">Acervo de Materiais</h1>
        <p className="text-sm text-gray-500 mt-1">
          Área do Responsável. Faça upload de livros e apostilas para ingestão e classificação de conteúdo.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Upload Form (4 cols) */}
        <div className="lg:col-span-4 bg-white p-6 rounded-lg border border-gray-200/80 shadow-sm self-start">
          <h2 className="text-lg font-semibold font-['Lora'] text-[#0E3D4D] mb-4">Ingerir Novo Documento</h2>
          
          <form onSubmit={handleUpload} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Título do Material</label>
              <input
                type="text"
                value={titulo}
                onChange={e => setTitulo(e.target.value)}
                placeholder="Ex: Livro de Fisiologia Humana"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-[#17607A] text-sm"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Tipo</label>
                <select
                  value={tipoMaterial}
                  onChange={e => setTipoMaterial(e.target.value as any)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm"
                >
                  <option value="livro">Livro</option>
                  <option value="apostila">Apostila</option>
                  <option value="slide">Slides</option>
                  <option value="lista_exercicios">Lista de Exercícios</option>
                  <option value="resumo_proprio">Resumo Próprio</option>
                  <option value="outro">Outro</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Série Alvo</label>
                <select
                  value={serieAlvo}
                  onChange={e => setSerieAlvo(parseInt(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm"
                >
                  <option value={1}>1º Ano (2027)</option>
                  <option value={2}>2º Ano (2028)</option>
                  <option value={3}>3º Ano (2029)</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Disciplina</label>
              <select
                value={selectedDisciplina}
                onChange={e => setSelectedDisciplina(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm"
                required
              >
                {disciplinas.map(d => (
                  <option key={d.id} value={d.id}>{d.nome}</option>
                ))}
              </select>
            </div>

            {/* Drag & Drop */}
            <div
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-lg p-6 text-center transition-all ${
                dragActive ? 'border-[#17607A] bg-[#17607A]/5' : 'border-gray-300'
              } ${file ? 'bg-emerald-500/5 border-emerald-500/30' : ''}`}
            >
              <input
                type="file"
                id="file-upload"
                accept=".pdf"
                onChange={handleFileChange}
                className="hidden"
              />
              
              {!file ? (
                <label htmlFor="file-upload" className="cursor-pointer">
                  <div className="text-gray-400 text-3xl mb-2">📄</div>
                  <p className="text-sm font-medium text-gray-700">Arraste ou clique para enviar</p>
                  <p className="text-xs text-gray-400 mt-1">Apenas arquivos PDF (Max 200MB)</p>
                </label>
              ) : (
                <div>
                  <div className="text-emerald-500 text-3xl mb-2">✓</div>
                  <p className="text-sm font-semibold text-emerald-800 truncate">{file.name}</p>
                  <p className="text-xs text-gray-400 mt-1">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    className="mt-3 text-xs text-rose-500 underline font-medium"
                  >
                    Remover arquivo
                  </button>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={uploading || !file}
              className="w-full py-2 bg-[#0E3D4D] text-white rounded-md text-sm font-semibold hover:bg-[#17607A] transition-all disabled:bg-gray-300"
            >
              {uploading ? 'Processando...' : 'Iniciar Ingestão'}
            </button>

            {uploadMessage && (
              <p className={`text-xs mt-2 font-medium text-center ${
                uploadMessage.startsWith('Sucesso') ? 'text-emerald-600' : 'text-rose-500'
              }`}>
                {uploadMessage}
              </p>
            )}
          </form>
        </div>

        {/* Acervo List (8 cols or 4/4 layout) */}
        <div className={`lg:col-span-8 space-y-6 ${viewerArquivoId ? 'hidden md:block lg:col-span-4' : 'lg:col-span-8'}`}>
          <div className="bg-white p-6 rounded-lg border border-gray-200/80 shadow-sm">
            <h2 className="text-lg font-semibold font-['Lora'] text-[#0E3D4D] mb-4">Arquivos no Acervo</h2>
            
            {loading ? (
              <p className="text-sm text-gray-400">Carregando lista...</p>
            ) : arquivos.length === 0 ? (
              <p className="text-sm text-gray-400">Nenhum arquivo enviado ainda.</p>
            ) : (
              <div className="divide-y divide-gray-100 max-h-[500px] overflow-y-auto pr-2">
                {arquivos.map((arq) => (
                  <div 
                    key={arq.id} 
                    onClick={() => selectViewerArquivo(arq.id)}
                    className={`py-4 cursor-pointer flex flex-col justify-between transition-all rounded-md px-2 ${
                      viewerArquivoId === arq.id ? 'bg-[#17607A]/5 border-l-4 border-[#17607A]' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex justify-between items-start gap-2 mb-2">
                      <div>
                        <h3 className="text-sm font-semibold text-[#0E3D4D] truncate max-w-[250px]">{arq.titulo}</h3>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {(arq.tamanhoBytes / 1024 / 1024).toFixed(1)}MB · {arq.paginas ? `${arq.paginas} pág.` : 'Contando...'}
                        </p>
                      </div>
                      <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded border ${getStatusColor(arq.statusProcessamento)}`}>
                        {arq.statusProcessamento}
                      </span>
                    </div>

                    {/* Step bar */}
                    {['aguardando', 'extraindo', 'segmentando', 'classificando', 'indexando'].includes(arq.statusProcessamento) && (
                      <div className="mt-1">
                        <div className="w-full bg-gray-100 rounded-full h-1">
                          <div 
                            className="bg-[#17607A] h-1 rounded-full transition-all duration-500" 
                            style={{ width: `${getStepProgress(arq.statusProcessamento)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Side-by-Side Extracted Text Viewer (4 cols) */}
        {viewerArquivoId && (
          <div className="lg:col-span-4 bg-white p-6 rounded-lg border border-gray-200/80 shadow-sm flex flex-col max-h-[600px]">
            <div className="flex justify-between items-center mb-4 border-b pb-2">
              <h2 className="text-base font-semibold font-['Lora'] text-[#0E3D4D] truncate max-w-[180px]">
                {viewerData?.titulo || 'Carregando...'}
              </h2>
              <button 
                onClick={() => { setViewerArquivoId(null); setViewerData(null); }}
                className="text-xs text-rose-500 hover:underline"
              >
                Fechar
              </button>
            </div>

            {viewerLoading ? (
              <p className="text-sm text-gray-400">Carregando visualização...</p>
            ) : viewerData ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex justify-between items-center text-xs mb-3">
                  <span className="font-semibold text-gray-500">Pág. {viewerPage} de {viewerData.paginas || 1}</span>
                  <div className="flex gap-2">
                    <button
                      disabled={viewerPage <= 1}
                      onClick={() => setViewerPage(p => p - 1)}
                      className="px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50 text-xs"
                    >
                      Anterior
                    </button>
                    <button
                      disabled={viewerPage >= (viewerData.paginas || 1)}
                      onClick={() => setViewerPage(p => p + 1)}
                      className="px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50 text-xs"
                    >
                      Próxima
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto bg-[#FBF8F3] p-3 rounded border border-gray-200/60 font-['Lora'] text-sm leading-relaxed whitespace-pre-wrap">
                  {viewerData.paginasLista?.[viewerPage - 1]?.textoExtraido || 'Sem texto extraído nesta página.'}
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-400">Selecione um arquivo para ver.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
