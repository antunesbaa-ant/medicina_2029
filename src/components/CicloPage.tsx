'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  CicloAtivoData,
  atualizarPonteiroCiclo,
  obterCicloAtivo,
} from '../app/actions/ciclo';
import Link from 'next/link';

interface CicloPageProps {
  dadosIniciais: CicloAtivoData | null;
  erroSincronizacaoInicial?: string;
}

export default function CicloPage({
  dadosIniciais,
  erroSincronizacaoInicial = '',
}: CicloPageProps) {
  const [ciclo, setCiclo] = useState<CicloAtivoData | null>(dadosIniciais);
  const [proximaOrdem, setProximaOrdem] = useState<number>(
    dadosIniciais?.proximaOrdem ?? 1
  );
  const [loading, setLoading] = useState<boolean>(false);
  const [erroSincronizacao, setErroSincronizacao] = useState<string>(
    erroSincronizacaoInicial
  );
  const operacaoEmAndamentoRef = useRef<boolean>(false);

  const sincronizarComServidor = useCallback(async () => {
    if (operacaoEmAndamentoRef.current) return;
    try {
      const atualizado = await obterCicloAtivo();
      setCiclo(atualizado);
      if (atualizado) {
        setProximaOrdem(atualizado.proximaOrdem);
      }
      setErroSincronizacao('');
    } catch (error) {
      setErroSincronizacao(
        error instanceof Error
          ? error.message
          : 'Falha de sincronização ao atualizar o estado do ciclo no servidor.'
      );
    }
  }, []);

  // Reconciliar com o PostgreSQL ao reconectar ou retornar à aba/aplicativo
  useEffect(() => {
    const onOnline = () => {
      void sincronizarComServidor();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void sincronizarComServidor();
      }
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [sincronizarComServidor]);

  const executarAjustePonteiro = async (
    acao: 'avancar' | 'retroceder' | 'reiniciar'
  ) => {
    if (!ciclo?.ciclo.id || operacaoEmAndamentoRef.current) return;

    operacaoEmAndamentoRef.current = true;
    setLoading(true);
    setErroSincronizacao('');

    try {
      const resultado = await atualizarPonteiroCiclo(ciclo.ciclo.id, acao, {
        ordemEsperada: proximaOrdem,
      });
      setProximaOrdem(resultado.proximaOrdem);
    } catch (error) {
      setErroSincronizacao(
        error instanceof Error
          ? error.message
          : 'Não foi possível sincronizar o ponteiro com o servidor. Nenhum avanço foi aplicado.'
      );
    } finally {
      operacaoEmAndamentoRef.current = false;
      setLoading(false);
    }
  };

  const handleResetCiclo = async () => {
    const confirmar = confirm(
      'Deseja reiniciar a fila do ciclo de estudos de volta ao bloco 1?'
    );
    if (!confirmar) return;
    await executarAjustePonteiro('reiniciar');
  };

  const handleAvancarCiclo = async () => {
    await executarAjustePonteiro('avancar');
  };

  const handleRetrocederCiclo = async () => {
    await executarAjustePonteiro('retroceder');
  };

  const blocos = ciclo?.blocos ?? [];
  const proximoBloco =
    blocos.find((b) => b.ordem === proximaOrdem) || blocos[0] || null;

  // Tradução do tipo de bloco
  const getTipoLabel = (tipo: string) => {
    switch (tipo) {
      case 'conteudo':
        return 'Teoria';
      case 'questoes':
        return 'Questões';
      case 'redacao':
        return 'Redação';
      case 'caderno_erros':
        return 'Erros';
      case 'revisao_srs':
        return 'FSRS/Anki';
      case 'lingua_estrangeira':
        return 'Estrang.';
      default:
        return tipo;
    }
  };

  return (
    <div className="w-full max-w-md md:max-w-4xl mx-auto bg-transparent min-h-screen pb-24 px-4 pt-6 select-none font-poppins">
      {/* Header Sóbrio */}
      <header className="mb-6 flex justify-between items-center">
        <div>
          <span className="text-[10px] uppercase font-bold tracking-widest text-[#6A7D87]">
            Estrutura de Fila
          </span>
          <h1 className="text-2xl font-bold text-[#0E3D4D] tracking-tight">
            Ciclo Ativo
          </h1>
          <p className="text-xs text-[#6A7D87] font-semibold mt-0.5">
            {ciclo?.ciclo.nome ?? 'Nenhum ciclo ativo no servidor'}
          </p>
        </div>
      </header>

      {erroSincronizacao && (
        <div
          role="alert"
          className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-semibold text-red-700 flex items-center justify-between gap-3"
        >
          <span>Falha de sincronização: {erroSincronizacao}</span>
          <button
            type="button"
            onClick={() => void sincronizarComServidor()}
            className="px-3 py-1.5 rounded-lg bg-white border border-red-200 text-[#0E3D4D] font-bold hover:bg-[#FBF8F3]"
          >
            Reconectar
          </button>
        </div>
      )}

      {/* Grid responsivo para PC */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        {/* Coluna Esquerda: Ponteiro e Controles (5 cols no md) */}
        <div className="md:col-span-5 space-y-5">
          <section className="bg-white border border-[#EAE3D5] rounded-2xl p-5 shadow-sm">
            <div className="flex justify-between items-center border-b border-[#F1EFEA] pb-3 mb-3">
              <div>
                <span className="text-[10px] uppercase font-bold tracking-wider text-[#6A7D87]">
                  Ponteiro de Execução (Servidor)
                </span>
                <span className="block text-xs font-bold text-[#0E3D4D] mt-0.5">
                  Bloco {blocos.length > 0 ? proximaOrdem : 0} de {blocos.length}
                </span>
              </div>

              {/* Controles de Ponteiro sincronizados no PostgreSQL */}
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={loading || !ciclo}
                  onClick={() => void handleRetrocederCiclo()}
                  title="Voltar bloco anterior"
                  className="w-9 h-9 border border-[#D5CBB8] rounded-lg flex items-center justify-center text-[#6A7D87] hover:text-[#0E3D4D] bg-[#FBF8F3] active:scale-90 transition-transform disabled:opacity-50"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  disabled={loading || !ciclo}
                  onClick={() => void handleAvancarCiclo()}
                  title="Avançar próximo bloco"
                  className="w-9 h-9 border border-[#D5CBB8] rounded-lg flex items-center justify-center text-[#6A7D87] hover:text-[#0E3D4D] bg-[#FBF8F3] active:scale-90 transition-transform disabled:opacity-50"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  disabled={loading || !ciclo}
                  onClick={() => void handleResetCiclo()}
                  title="Reiniciar Ciclo"
                  className="w-9 h-9 border border-red-200 text-[#B5502B] rounded-lg flex items-center justify-center hover:bg-red-50 bg-[#FBF8F3] active:scale-90 transition-transform disabled:opacity-50"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 7.89M9 9H4"
                    />
                  </svg>
                </button>
              </div>
            </div>

            {proximoBloco && (
              <div className="bg-[#FBF8F3] border border-[#EAE3D5] rounded-xl p-4 flex justify-between items-center">
                <div>
                  <span className="text-[10px] uppercase font-bold tracking-widest text-[#B5502B]">
                    Foco de Estudo
                  </span>
                  <h3 className="text-base font-bold text-[#0E3D4D] leading-tight font-lora-read mt-0.5">
                    {proximoBloco.disciplina.nome}
                  </h3>
                  <div className="flex gap-2 items-center mt-1 text-[10px] font-semibold text-[#6A7D87]">
                    <span>{getTipoLabel(proximoBloco.tipo).toUpperCase()}</span>
                    <span>•</span>
                    <span className="text-[#C98A2E]">
                      {proximoBloco.estiloAlvo.toUpperCase()}
                    </span>
                  </div>
                </div>
                <Link
                  href={`/estudar?blocoId=${proximoBloco.id}`}
                  className="h-10 px-4 bg-[#0E3D4D] text-white text-xs font-bold rounded-lg flex items-center justify-center shadow hover:bg-[#17607A] active:scale-[0.96] transition-transform min-h-[40px]"
                >
                  Estudar
                </Link>
              </div>
            )}
          </section>
        </div>

        {/* Coluna Direita: Fila Sequencial (7 cols no md) */}
        <div className="md:col-span-7">
          <section className="space-y-2.5">
            <span className="text-[10px] uppercase font-bold tracking-widest text-[#6A7D87] block mb-2 px-1">
              Fila Sequencial de Estudos
            </span>

            {blocos.map((bloco) => {
              const isNext = bloco.ordem === proximaOrdem;
              const isCompleted = bloco.ordem < proximaOrdem;

              return (
                <div
                  key={bloco.id}
                  className={`border rounded-xl p-3.5 flex items-center justify-between transition-all ${
                    isNext
                      ? 'bg-white border-[#17607A] shadow-sm ring-1 ring-[#17607A]/30'
                      : isCompleted
                        ? 'bg-white/60 border-[#EAE3D5] opacity-75'
                        : 'bg-white border-[#EAE3D5]'
                  }`}
                >
                  <div className="flex items-center gap-3.5">
                    {/* Indicador de Ordem / Conclusão */}
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
                        isNext
                          ? 'bg-[#17607A] text-white'
                          : isCompleted
                            ? 'bg-[#EAE3D5] text-[#6A7D87]'
                            : 'bg-[#FBF8F3] text-[#1B2A33] border border-[#EAE3D5]'
                      }`}
                    >
                      {isCompleted ? (
                        <svg
                          className="w-4 h-4 text-[#0E3D4D]"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={3}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      ) : (
                        bloco.ordem.toString().padStart(2, '0')
                      )}
                    </div>

                    <div>
                      <div className="flex items-center gap-1.5">
                        <h4 className="text-sm font-bold text-[#1B2A33] font-lora-read">
                          {bloco.disciplina.nome}
                        </h4>

                        {/* Tag de Próximo bloco */}
                        {isNext && (
                          <span className="bg-[#B5502B] text-white text-[8px] font-extrabold px-1.5 py-0.5 rounded uppercase tracking-wider">
                            A Seguir
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2 items-center text-[10px] font-semibold text-[#6A7D87] mt-0.5">
                        <span>{getTipoLabel(bloco.tipo)}</span>
                        <span>•</span>
                        <span className="text-[#C98A2E]">
                          {bloco.estiloAlvo.toUpperCase()}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Informações Auxiliares do Bloco */}
                  <div className="text-right">
                    <span className="text-xs font-bold text-[#0E3D4D] block">
                      {bloco.duracaoMin}m
                    </span>
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full border border-white/20 mt-1"
                      style={{ backgroundColor: bloco.disciplina.corHex }}
                      title={bloco.disciplina.nome}
                    />
                  </div>
                </div>
              );
            })}
          </section>
        </div>
      </div>
    </div>
  );
}
