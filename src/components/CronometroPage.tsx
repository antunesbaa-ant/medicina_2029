'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { obterCicloAtivo } from '../app/actions/ciclo';
import { MOCK_DISCIPLINAS, MOCK_TOPICOS } from '../lib/mocks';
import { iniciarSessao, atualizarSessao, concluirSessao } from '../app/actions/sessao';
import NavBar from './NavBar';
import Link from 'next/link';

type EtapaSessao = 'revisao' | 'conteudo' | 'questoes' | 'registro' | 'pausa';

interface CronometroState {
  sessaoId: string;
  blocoId: string;
  topicoId: string;
  disciplinaNome: string;
  topicoNome: string;
  etapaAtual: EtapaSessao;
  tempoRestante: number;
  estaRodando: boolean;
  segundosEfetivos: number;
  segundosPausa: number;
  timestampUltimoTick: number;
}

const TEMPO_ETAPAS: Record<Exclude<EtapaSessao, 'pausa'>, number> = {
  revisao: 5 * 60, // 5 minutos (300s)
  conteudo: 28 * 60, // 28 minutos (1680s)
  questoes: 15 * 60, // 15 minutos (900s)
  registro: 2 * 60, // 2 minutos (120s)
};

const TEMPO_PAUSA = 10 * 60; // 10 minutos (600s)

export default function CronometroPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  
  const blocoIdParam = searchParams.get('blocoId');
  const topicoIdParam = searchParams.get('topicoId');

  const [loading, setLoading] = useState(true);
  const [sessaoId, setSessaoId] = useState<string>('');
  const [blocoId, setBlocoId] = useState<string>('');
  const [topicoId, setTopicoId] = useState<string>('');
  const [disciplinaNome, setDisciplinaNome] = useState<string>('Estudo');
  const [topicoNome, setTopicoNome] = useState<string>('Tópico Geral');

  const [etapa, setEtapa] = useState<EtapaSessao>('revisao');
  const [tempoRestante, setTempoRestante] = useState<number>(TEMPO_ETAPAS.revisao);
  const [estaRodando, setEstaRodando] = useState<boolean>(false);
  const [segundosEfetivos, setSegundosEfetivos] = useState<number>(0);
  const [segundosPausa, setSegundosPausa] = useState<number>(0);

  // Estados do formulário de Registro
  const [notaLivre, setNotaLivre] = useState<string>('');
  
  // Registro de Erros
  const [questoesResolvidas, setQuestoesResolvidas] = useState<number>(0);
  const [questoesAcertadas, setQuestoesAcertadas] = useState<number>(0);
  const [mostrarFormErro, setMostrarFormErro] = useState<boolean>(false);
  const [tipoErro, setTipoErro] = useState<'conteudo' | 'interpretacao' | 'distracao' | 'calculo' | 'tempo'>('conteudo');
  const [descricaoErro, setDescricaoErro] = useState<string>('');
  const [conceitoCorreto, setConceitoCorreto] = useState<string>('');
  const [errosRegistrados, setErrosRegistrados] = useState<Array<{
    questaoId: string;
    tentativaId: string;
    tipoErro: 'conteudo' | 'interpretacao' | 'distracao' | 'calculo' | 'tempo';
    descricaoLivre: string;
    conceitoCorreto: string;
  }>>([]);

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Inicializar o cronômetro
  useEffect(() => {
    async function inicializar() {
      // 1. Verificar se há estado salvo no localStorage
      const localStateStr = localStorage.getItem('medicina_2029_cronometro_estado');
      
      if (localStateStr) {
        try {
          const state: CronometroState = JSON.parse(localStateStr);
          
          setSessaoId(state.sessaoId);
          setBlocoId(state.blocoId);
          setTopicoId(state.topicoId);
          setDisciplinaNome(state.disciplinaNome);
          setTopicoNome(state.topicoNome);
          setEtapa(state.etapaAtual);
          setSegundosEfetivos(state.segundosEfetivos);
          setSegundosPausa(state.segundosPausa);

          // Calcular tempo decorrido com a página fechada se estava rodando
          if (state.estaRodando) {
            const segundosPassados = Math.floor((Date.now() - state.timestampUltimoTick) / 1000);
            const novoTempoRestante = Math.max(0, state.tempoRestante - segundosPassados);
            setTempoRestante(novoTempoRestante);
            setEstaRodando(true);
            
            // Adicionar tempo decorrido aos segundos efetivos
            if (state.etapaAtual !== 'pausa') {
              setSegundosEfetivos(prev => prev + Math.min(state.tempoRestante, segundosPassados));
            } else {
              setSegundosPausa(prev => prev + Math.min(state.tempoRestante, segundosPassados));
            }
          } else {
            setTempoRestante(state.tempoRestante);
            setEstaRodando(false);
          }
          
          setLoading(false);
          return;
        } catch (e) {
          console.error('Erro ao ler estado do cronômetro local:', e);
        }
      }

      // 2. Se não há estado local, criar nova sessão usando parâmetros ou ciclo ativo
      let bId = blocoIdParam;
      let tId = topicoIdParam;
      let discName = 'Estudo';
      let topName = 'Tópico de Estudo';

      const cicloData = await obterCicloAtivo();

      if (cicloData) {
        const blocos = cicloData.blocos;
        const ordemAtual = parseInt(localStorage.getItem('medicina_2029_proxima_ordem') || '1', 10);
        const bloco = blocos.find(b => b.id === bId) || blocos.find(b => b.ordem === ordemAtual) || blocos[0];
        
        if (bloco) {
          bId = bloco.id;
          discName = bloco.disciplina.nome;
          
          const topicos = MOCK_TOPICOS[bloco.disciplinaId] || [];
          const topico = topicos.find(t => t.id === tId) || topicos[0];
          if (topico) {
            tId = topico.id;
            topName = topico.nome;
          }
        }
      }

      // Se falhou em achar dados, define mocks
      bId = bId || 'b-1';
      tId = tId || 't-mat-1';

      // Inicia sessão no backend/mock
      const sId = await iniciarSessao('00000000-0000-0000-0000-000000000001', bId, tId);
      
      setSessaoId(sId);
      setBlocoId(bId);
      setTopicoId(tId);
      setDisciplinaNome(discName);
      setTopicoNome(topName);
      setEtapa('revisao');
      setTempoRestante(TEMPO_ETAPAS.revisao);
      setEstaRodando(false);
      setSegundosEfetivos(0);
      setSegundosPausa(0);

      setLoading(false);
    }

    inicializar();
  }, [blocoIdParam, topicoIdParam]);

  // Persistir o estado no localStorage a cada alteração do tempo, estado ou etapa
  useEffect(() => {
    if (loading || !sessaoId) return;

    const state: CronometroState = {
      sessaoId,
      blocoId,
      topicoId,
      disciplinaNome,
      topicoNome,
      etapaAtual: etapa,
      tempoRestante,
      estaRodando,
      segundosEfetivos,
      segundosPausa,
      timestampUltimoTick: Date.now(),
    };

    localStorage.setItem('medicina_2029_cronometro_estado', JSON.stringify(state));
  }, [tempoRestante, estaRodando, etapa, segundosEfetivos, segundosPausa, loading, sessaoId]);

  // Efeito principal do Cronômetro (Tick a cada 1s)
  useEffect(() => {
    if (!estaRodando) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    timerRef.current = setInterval(() => {
      setTempoRestante((prev) => {
        if (prev <= 1) {
          // Etapa concluída! Ir para a próxima etapa.
          if (timerRef.current) clearInterval(timerRef.current);
          avancarEtapaAutomatico();
          return 0;
        }
        
        // Incrementar segundos efetivos ou pausa
        if (etapa !== 'pausa') {
          setSegundosEfetivos(s => s + 1);
        } else {
          setSegundosPausa(s => s + 1);
        }

        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [estaRodando, etapa]);

  // Avançar etapa automaticamente quando o tempo acaba
  const avancarEtapaAutomatico = () => {
    setEstaRodando(false);
    if (etapa === 'revisao') {
      atualizarSessaoBackend('conteudo');
      setEtapa('conteudo');
      setTempoRestante(TEMPO_ETAPAS.conteudo);
      setEstaRodando(true);
    } else if (etapa === 'conteudo') {
      atualizarSessaoBackend('questoes');
      setEtapa('questoes');
      setTempoRestante(TEMPO_ETAPAS.questoes);
      setEstaRodando(true);
    } else if (etapa === 'questoes') {
      atualizarSessaoBackend('registro');
      setEtapa('registro');
      setTempoRestante(TEMPO_ETAPAS.registro);
      setEstaRodando(true);
    } else if (etapa === 'registro') {
      // O registro acabou, finalizar estudo e ir para a pausa
      handleFinalizarEstudo();
    } else if (etapa === 'pausa') {
      // Pausa concluída, limpar cronômetro e voltar para Hoje
      limparCronometroERedirecionar();
    }
  };

  // Atualizar etapa no backend
  const atualizarSessaoBackend = async (novaEtapa: 'conteudo' | 'questoes' | 'registro') => {
    if (sessaoId && !sessaoId.startsWith('sessao-mock')) {
      await atualizarSessao(sessaoId, { etapaAtingida: novaEtapa });
    }
  };

  // Pular Etapa Manualmente
  const handlePularEtapa = () => {
    setEstaRodando(false);
    if (etapa === 'revisao') {
      atualizarSessaoBackend('conteudo');
      setEtapa('conteudo');
      setTempoRestante(TEMPO_ETAPAS.conteudo);
    } else if (etapa === 'conteudo') {
      atualizarSessaoBackend('questoes');
      setEtapa('questoes');
      setTempoRestante(TEMPO_ETAPAS.questoes);
    } else if (etapa === 'questoes') {
      atualizarSessaoBackend('registro');
      setEtapa('registro');
      setTempoRestante(TEMPO_ETAPAS.registro);
    } else if (etapa === 'registro') {
      handleFinalizarEstudo();
    } else if (etapa === 'pausa') {
      limparCronometroERedirecionar();
    }
  };

  // Adicionar um erro ao Caderno de Erros (localmente para salvar ao concluir)
  const handleAdicionarErro = (e: React.FormEvent) => {
    e.preventDefault();
    if (!descricaoErro.trim() || !conceitoCorreto.trim()) return;

    const novoErro = {
      questaoId: `q-mock-${Date.now()}`,
      tentativaId: `t-mock-${Date.now()}`,
      tipoErro,
      descricaoLivre: descricaoErro.trim(),
      conceitoCorreto: conceitoCorreto.trim()
    };

    setErrosRegistrados(prev => [...prev, novoErro]);
    setDescricaoErro('');
    setConceitoCorreto('');
    setMostrarFormErro(false);
  };

  // Finalizar a sessão (etapa de registro)
  const handleFinalizarEstudo = async () => {
    setEstaRodando(false);
    
    // Concluir no backend
    await concluirSessao(sessaoId, {
      encerradaEm: new Date(),
      segundosEfetivos,
      segundosPausa,
      etapaAtingida: 'registro',
      notaLivre: `${notaLivre.trim()} | Questões: ${questoesAcertadas}/${questoesResolvidas} acertos.`,
      errosParaRegistrar: errosRegistrados
    });

    // Atualizar o ponteiro local do ciclo
    const localOrdem = parseInt(localStorage.getItem('medicina_2029_proxima_ordem') || '1', 10);
    const novoPonteiro = localOrdem >= 12 ? 1 : localOrdem + 1;
    localStorage.setItem('medicina_2029_proxima_ordem', novoPonteiro.toString());

    // Incrementar blocos concluídos na semana
    const concluidosSemana = parseInt(localStorage.getItem('medicina_2029_concluidos_semana') || '3', 10);
    localStorage.setItem('medicina_2029_concluidos_semana', (concluidosSemana + 1).toString());

    // Passar para a etapa de Pausa
    setEtapa('pausa');
    setTempoRestante(TEMPO_PAUSA);
    setEstaRodando(true);
  };

  // Encerrar sessão prematuramente (antes do registro)
  const handleEncerrarPrematuro = async () => {
    const confirmar = confirm(
      'Deseja encerrar a sessão de estudo antes do tempo? Ela será salva como incompleta (concluída = false) e o progresso do ciclo não avançará.'
    );
    if (!confirmar) return;

    setEstaRodando(false);
    
    // Salvar como não concluída
    await concluirSessao(sessaoId, {
      encerradaEm: new Date(),
      segundosEfetivos,
      segundosPausa,
      etapaAtingida: etapa as Exclude<EtapaSessao, 'pausa'>,
      notaLivre: `Encerrado prematuramente na etapa de ${etapa}. Nota: ${notaLivre.trim()}`
    });

    // Limpar local e ir para a Home
    limparCronometroERedirecionar();
  };

  const limparCronometroERedirecionar = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    localStorage.removeItem('medicina_2029_cronometro_estado');
    router.push('/');
  };

  // Formatação do Tempo (MM:SS)
  const formatTempo = (segundos: number) => {
    const mins = Math.floor(segundos / 60);
    const secs = segundos % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#FBF8F3]">
        <div className="w-8 h-8 border-4 border-[#0E3D4D] border-t-transparent rounded-full animate-spin"></div>
        <p className="text-xs font-semibold text-[#0E3D4D] mt-3">Iniciando Cronômetro de Estudo...</p>
      </div>
    );
  }

  // Cores de fundo e textos baseadas no estado de estudo ou pausa
  const isPausa = etapa === 'pausa';
  const themeColor = isPausa ? 'text-[#B5502B]' : 'text-[#0E3D4D]';
  const progressBgColor = isPausa ? 'bg-[#B5502B]' : 'bg-[#0E3D4D]';

  return (
    <div className={`w-full max-w-md mx-auto bg-transparent min-h-screen pb-24 px-4 pt-6 select-none font-poppins`}>
      
      {/* Topo Sóbrio */}
      <header className="mb-6 flex justify-between items-center">
        <div>
          <span className="text-[10px] uppercase font-bold tracking-widest text-[#6A7D87]">Sessão Ativa</span>
          <h1 className="text-xl font-bold text-[#0E3D4D] leading-tight font-lora-read">{disciplinaNome}</h1>
          <p className="text-xs text-[#6A7D87] font-medium italic mt-0.5">{topicoNome}</p>
        </div>
        <Link 
          href="/"
          className="text-xs font-bold text-[#6A7D87] hover:text-[#0E3D4D] border border-[#D5CBB8] px-3 py-1.5 rounded-lg bg-white"
        >
          Voltar
        </Link>
      </header>

      {/* Indicador de Etapas Horizontal (Linha do Tempo) */}
      {!isPausa && (
        <div className="bg-white border border-[#EAE3D5] rounded-2xl p-4 mb-5 shadow-sm">
          <div className="flex justify-between items-center">
            {(['revisao', 'conteudo', 'questoes', 'registro'] as const).map((step, idx) => {
              const isActive = etapa === step;
              const isPast = ['revisao', 'conteudo', 'questoes', 'registro'].indexOf(etapa) > idx;
              
              const stepLabels = {
                revisao: 'Revisão (5m)',
                conteudo: 'Teoria (28m)',
                questoes: 'Questões (15m)',
                registro: 'Registro (2m)'
              };

              return (
                <div key={step} className="flex flex-col items-center flex-1">
                  <div className="relative flex items-center justify-center w-full">
                    {/* Barra conectora */}
                    {idx > 0 && (
                      <div className={`absolute left-0 right-1/2 top-2 h-0.5 -translate-y-1/2 -z-10 ${
                        isPast || isActive ? 'bg-[#0E3D4D]' : 'bg-[#EAE3D5]'
                      }`} />
                    )}
                    {idx < 3 && (
                      <div className={`absolute left-1/2 right-0 top-2 h-0.5 -translate-y-1/2 -z-10 ${
                        isPast ? 'bg-[#0E3D4D]' : 'bg-[#EAE3D5]'
                      }`} />
                    )}

                    {/* Círculo indicador */}
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                      isActive 
                        ? 'bg-[#0E3D4D] border-[#0E3D4D] scale-110 shadow-sm' 
                        : isPast 
                          ? 'bg-[#17607A] border-[#17607A]' 
                          : 'bg-white border-[#D5CBB8]'
                    }`} />
                  </div>
                  <span className={`text-[9px] font-bold mt-2 text-center ${
                    isActive ? 'text-[#0E3D4D]' : 'text-[#6A7D87]'
                  }`}>
                    {stepLabels[step]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Grid responsivo para PC */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 mt-5">
        
        {/* Coluna Esquerda: Mostrador do Cronômetro (md:col-span-7) */}
        <div className="md:col-span-7">
          <section className="bg-white border border-[#EAE3D5] rounded-3xl p-8 shadow-sm text-center relative overflow-hidden h-full flex flex-col justify-center items-center">
            
            {/* Banner de Pausa */}
            {isPausa && (
              <div className="absolute top-0 left-0 right-0 bg-[#B5502B] text-white py-1 text-[10px] uppercase font-bold tracking-widest">
                Intervalo Obrigatório
              </div>
            )}

            <span className="text-[10px] uppercase font-bold tracking-widest text-[#6A7D87] block mb-2">
              {isPausa ? 'Pausa para Descanso Visual' : `Etapa atual: ${etapa.toUpperCase()}`}
            </span>

            <div className={`text-6xl font-bold font-poppins tracking-tighter ${themeColor} my-3`}>
              {formatTempo(tempoRestante)}
            </div>

            {/* Barra de progresso circular/horizontal minimalista de progresso do tempo */}
            <div className="w-full bg-[#F1EFEA] h-1.5 rounded-full overflow-hidden border border-[#EAE3D5]/30 mb-6">
              <div 
                className={`h-full rounded-full transition-all duration-1000 ${progressBgColor}`}
                style={{ 
                  width: `${(tempoRestante / (isPausa ? TEMPO_PAUSA : TEMPO_ETAPAS[etapa as Exclude<EtapaSessao, 'pausa'>])) * 100}%` 
                }}
              />
            </div>

            {/* Controles principais */}
            <div className="flex justify-center items-center gap-6">
              
              {/* Play/Pause (Área de toque ampla >= 44px) */}
              <button
                onClick={() => setEstaRodando(!estaRodando)}
                className={`w-16 h-16 rounded-full flex items-center justify-center text-white transition-all shadow-md active:scale-95 ${
                  isPausa 
                    ? 'bg-[#B5502B] hover:bg-[#A04523]' 
                    : 'bg-[#0E3D4D] hover:bg-[#17607A]'
                } min-w-[44px] min-h-[44px]`}
              >
                {estaRodando ? (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path fillRule="evenodd" d="M6.75 5.25a.75.75 0 01.75-.75H9a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H7.5a.75.75 0 01-.75-.75V5.25zm7.5 0A.75.75 0 0115 4.5h1.5a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H15a.75.75 0 01-.75-.75V5.25z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 translate-x-0.5" fill="currentColor" viewBox="0 0 24 24">
                    <path fillRule="evenodd" d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653z" clipRule="evenodd" />
                  </svg>
                )}
              </button>

              {/* Pular Etapa (Área de toque ampla >= 44px) */}
              <button
                onClick={handlePularEtapa}
                title="Avançar Etapa"
                className="w-11 h-11 rounded-full bg-[#FBF8F3] hover:bg-[#F1EFEA] border border-[#D5CBB8] text-[#1B2A33] flex items-center justify-center transition-colors active:scale-95 min-h-[44px] min-w-[44px]"
              >
                <svg className="w-5 h-5 text-[#6A7D87]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                </svg>
              </button>

              {/* Encerrar Prematuro (Apenas durante o estudo) */}
              {!isPausa && (
                <button
                  onClick={handleEncerrarPrematuro}
                  title="Encerrar Sessão"
                  className="w-11 h-11 rounded-full bg-[#FBF8F3] hover:bg-red-50 border border-red-200 text-[#B5502B] flex items-center justify-center transition-colors active:scale-95 min-h-[44px] min-w-[44px]"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </section>
        </div>

        {/* Coluna Direita: Registro ou Pausa (md:col-span-5) */}
        <div className="md:col-span-5 space-y-4">
          
          {/* Painel de Registro (Ativado apenas na etapa de 'registro') */}
          {etapa === 'registro' && (
            <section className="bg-white border border-[#EAE3D5] rounded-2xl p-5 shadow-sm space-y-4">
              <div className="border-b border-[#F1EFEA] pb-2">
                <span className="text-xs font-bold text-[#0E3D4D] uppercase tracking-wider block">Ficha de Registro de Estudo</span>
                <p className="text-[10px] text-[#6A7D87] font-medium mt-0.5">O registro é obrigatório para contabilizar a sessão no ciclo.</p>
              </div>

              {/* Contador de Questões */}
              <div className="bg-[#FBF8F3] border border-[#EAE3D5] p-3.5 rounded-xl">
                <span className="block text-xs font-bold text-[#6A7D87] mb-2">Desempenho em Questões (Fase Teoria/Prática):</span>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-bold text-[#6A7D87] mb-1">Resolvidas:</label>
                    <input
                      type="number"
                      min="0"
                      value={questoesResolvidas}
                      onChange={(e) => setQuestoesResolvidas(Math.max(0, parseInt(e.target.value, 10) || 0))}
                      className="w-full h-10 px-2 bg-white border border-[#D5CBB8] rounded-lg text-xs font-semibold focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-[#6A7D87] mb-1">Acertos:</label>
                    <input
                      type="number"
                      min="0"
                      max={questoesResolvidas}
                      value={questoesAcertadas}
                      onChange={(e) => setQuestoesAcertadas(Math.min(questoesResolvidas, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                      className="w-full h-10 px-2 bg-white border border-[#D5CBB8] rounded-lg text-xs font-semibold focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Caderno de Erros */}
              {questoesResolvidas > 0 && questoesAcertadas < questoesResolvidas && (
                <div className="border border-[#EAE3D5] rounded-xl p-3">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-[#B5502B]">Erros detectados ({questoesResolvidas - questoesAcertadas})</span>
                    <button
                      type="button"
                      onClick={() => setMostrarFormErro(!mostrarFormErro)}
                      className="text-[10px] font-bold text-[#0E3D4D] bg-[#F1EFEA] hover:bg-[#EAE3D5] px-2 py-1 rounded transition-colors"
                    >
                      {mostrarFormErro ? 'Cancelar' : '+ Registrar Erro'}
                    </button>
                  </div>

                  {/* Listagem de erros adicionados */}
                  {errosRegistrados.length > 0 && (
                    <div className="space-y-1.5 mb-2">
                      {errosRegistrados.map((err, idx) => (
                        <div key={idx} className="bg-red-50/50 border border-red-100 p-2 rounded-lg text-[10px] leading-relaxed text-[#1B2A33]">
                          <div className="flex justify-between items-center mb-0.5">
                            <span className="font-bold text-[#B5502B] uppercase text-[9px]">{err.tipoErro}</span>
                            <button 
                              onClick={() => setErrosRegistrados(prev => prev.filter((_, i) => i !== idx))}
                              className="text-[9px] font-bold text-[#B5502B] hover:text-[#0E3D4D]"
                            >
                              Remover
                            </button>
                          </div>
                          <p className="italic font-lora-read">"{err.descricaoLivre}"</p>
                          <p className="mt-0.5 font-semibold text-[#0E3D4D]">Conceito: {err.conceitoCorreto}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Form de erro */}
                  {mostrarFormErro && (
                    <form onSubmit={handleAdicionarErro} className="space-y-2 mt-2 pt-2 border-t border-[#F1EFEA]">
                      <div>
                        <label className="block text-[10px] font-bold text-[#6A7D87] mb-1">Categoria do Erro:</label>
                        <select
                          value={tipoErro}
                          onChange={(e) => setTipoErro(e.target.value as any)}
                          className="w-full h-8 px-2 bg-white border border-[#D5CBB8] rounded-lg text-xs"
                        >
                          <option value="conteudo">Conteúdo (Lacuna teórica)</option>
                          <option value="interpretacao">Interpretação (Entendimento)</option>
                          <option value="distracao">Distração (Atenção)</option>
                          <option value="calculo">Cálculo (Matemática)</option>
                          <option value="tempo">Tempo (Prazo estourado)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-[#6A7D87] mb-1">Descrição do que errou:</label>
                        <input
                          type="text"
                          value={descricaoErro}
                          onChange={(e) => setDescricaoErro(e.target.value)}
                          placeholder="Ex: Confundi os coeficientes na fórmula de Bhaskara..."
                          className="w-full h-8 px-2 bg-white border border-[#D5CBB8] rounded-lg text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-[#6A7D87] mb-1">Conceito Correto (Fato a fixar):</label>
                        <input
                          type="text"
                          value={conceitoCorreto}
                          onChange={(e) => setConceitoCorreto(e.target.value)}
                          placeholder="Ex: O termo 'c' é independente, 'b' multiplica x..."
                          className="w-full h-8 px-2 bg-white border border-[#D5CBB8] rounded-lg text-xs"
                        />
                      </div>
                      <button
                        type="submit"
                        className="w-full h-8 bg-[#B5502B] text-white font-bold text-[10px] rounded-lg shadow-sm hover:bg-[#A04523]"
                      >
                        Adicionar no Caderno de Erros
                      </button>
                    </form>
                  )}
                </div>
              )}

              {/* Anotações gerais */}
              <div>
                <label className="block text-xs font-bold text-[#6A7D87] mb-1">
                  Notas e Observações de Estudo:
                </label>
                <textarea
                  value={notaLivre}
                  onChange={(e) => setNotaLivre(e.target.value)}
                  placeholder="Descreva as principais dificuldades ou pontos de fixação aprendidos..."
                  rows={3}
                  className="w-full p-3 bg-[#FBF8F3] border border-[#D5CBB8] rounded-xl text-sm font-medium text-[#1B2A33] focus:outline-none focus:ring-1 focus:ring-[#0E3D4D] font-lora-read"
                />
              </div>

              <button
                onClick={handleFinalizarEstudo}
                className="w-full h-12 bg-[#0E3D4D] text-white font-bold text-sm rounded-xl shadow hover:bg-[#17607A] active:scale-[0.98] transition-all min-h-[44px]"
              >
                Finalizar Estudo e Iniciar Pausa
              </button>
            </section>
          )}

          {/* Recomendações de Pausa */}
          {isPausa && (
            <section className="bg-white border border-[#EAE3D5] rounded-2xl p-5 shadow-sm text-center space-y-3">
              <span className="text-xs font-bold text-[#B5502B] uppercase tracking-wider block">Orientações de Descanso</span>
              <p className="font-lora-read text-[#1B2A33] text-sm leading-relaxed italic">
                "Aproveite este intervalo de 10 minutos para desviar os olhos das telas, caminhar e alongar-se brevemente. Mantenha-se hidratado."
              </p>
              <div className="pt-2 border-t border-[#F1EFEA] flex justify-center">
                <button
                  onClick={limparCronometroERedirecionar}
                  className="px-6 h-10 border border-[#D5CBB8] text-[#1B2A33] font-bold text-xs rounded-xl bg-white hover:bg-[#FBF8F3] active:scale-95 transition-all min-h-[44px]"
                >
                  Pular Pausa e Voltar
                </button>
              </div>
            </section>
          )}

        </div>
      </div>

    </div>
  );
}
