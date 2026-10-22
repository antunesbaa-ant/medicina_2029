'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  iniciarSessao,
  concluirSessao,
  obterEstadoSessaoCronometro,
  sincronizarCheckpointSessao,
  type ErroParaRegistrar,
} from '../app/actions/sessao';
import {
  TEMPO_ETAPAS,
  TEMPO_PAUSA,
  calcularTempoRestanteEtapaServidor,
  obterProximaEtapaPedagogica,
  reconciliarEstadoCronometroComServidor,
  type CacheLocalCronometro,
  type EtapaCronometroUI,
  type EtapaPedagogicaSessao,
  type StatusSessaoCronometro,
} from '../lib/cicloCronometroReconciliacao';
import Link from 'next/link';

const STORAGE_KEY_CRONOMETRO = 'medicina_2029_cronometro_estado';
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AnotacaoErroSessao {
  questaoId?: string;
  tentativaId?: string;
  tipoErro: 'conteudo' | 'interpretacao' | 'distracao' | 'calculo' | 'tempo';
  descricaoLivre: string;
  conceitoCorreto: string;
}

export default function CronometroPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const blocoIdParam = searchParams.get('blocoId');
  const topicoIdParam = searchParams.get('topicoId');

  const [loading, setLoading] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);
  const [statusSessao, setStatusSessao] =
    useState<StatusSessaoCronometro>('nao_iniciada');
  const [erroOperacao, setErroOperacao] = useState<string>('');
  const [sessaoId, setSessaoId] = useState<string>('');
  const [blocoId, setBlocoId] = useState<string>('');
  const [topicoId, setTopicoId] = useState<string>('');
  const [disciplinaNome, setDisciplinaNome] = useState<string>('Estudo');
  const [topicoNome, setTopicoNome] = useState<string>('Tópico Geral');

  const [etapa, setEtapa] = useState<EtapaCronometroUI>('revisao');
  const [tempoRestante, setTempoRestante] = useState<number>(
    TEMPO_ETAPAS.revisao
  );
  const [estaRodando, setEstaRodando] = useState<boolean>(false);
  const [segundosEfetivos, setSegundosEfetivos] = useState<number>(0);
  const [segundosPausa, setSegundosPausa] = useState<number>(0);

  // Estados do formulário de Registro
  const [notaLivre, setNotaLivre] = useState<string>('');

  // Registro de desempenho e anotações de erros da sessão
  const [questoesResolvidas, setQuestoesResolvidas] = useState<number>(0);
  const [questoesAcertadas, setQuestoesAcertadas] = useState<number>(0);
  const [mostrarFormErro, setMostrarFormErro] = useState<boolean>(false);
  const [tipoErro, setTipoErro] = useState<
    'conteudo' | 'interpretacao' | 'distracao' | 'calculo' | 'tempo'
  >('conteudo');
  const [descricaoErro, setDescricaoErro] = useState<string>('');
  const [conceitoCorreto, setConceitoCorreto] = useState<string>('');
  const [errosRegistrados, setErrosRegistrados] = useState<
    AnotacaoErroSessao[]
  >([]);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const operacaoEmVooRef = useRef<boolean>(false);
  const avancarEtapaRef = useRef<() => Promise<void>>(async () => {});

  const lerCacheLocalAuxiliar = (): CacheLocalCronometro | null => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_CRONOMETRO);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CacheLocalCronometro;
      if (!parsed || typeof parsed.sessaoId !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  };

  // Inicializar ou recuperar a sessão real a partir do PostgreSQL
  const sincronizarEInicializarComServidor = useCallback(async () => {
    if (operacaoEmVooRef.current) return;
    operacaoEmVooRef.current = true;
    setSincronizando(true);
    setErroOperacao('');

    try {
      const cacheLocal = lerCacheLocalAuxiliar();
      const estadoServidor = await obterEstadoSessaoCronometro({
        sessaoId: cacheLocal?.sessaoId || undefined,
        cicloBlocoId: blocoIdParam || undefined,
        topicoId: topicoIdParam || undefined,
      });

      const reconciliado = reconciliarEstadoCronometroComServidor({
        servidor: estadoServidor,
        cacheLocal,
        agoraMs: Date.now(),
      });

      if (reconciliado.cacheLocalDescartado) {
        localStorage.removeItem(STORAGE_KEY_CRONOMETRO);
      }

      // Caso 1: Sessão já encerrada no servidor (ex.: concluída em outra aba/dispositivo)
      if (reconciliado.statusSessao === 'concluida') {
        setSessaoId(reconciliado.sessaoId);
        setBlocoId(reconciliado.blocoId);
        setTopicoId(reconciliado.topicoId);
        setDisciplinaNome(reconciliado.disciplinaNome);
        setTopicoNome(reconciliado.topicoNome);
        setEtapa(reconciliado.etapa);
        setTempoRestante(0);
        setEstaRodando(false);
        setSegundosEfetivos(reconciliado.segundosEfetivos);
        setSegundosPausa(reconciliado.segundosPausa);
        setNotaLivre(reconciliado.notaLivre);
        setStatusSessao('concluida');
        setLoading(false);
        return;
      }

      // Caso 2: Existe uma sessão aberta no PostgreSQL -> recupera seu estado real
      if (reconciliado.sessaoId) {
        setSessaoId(reconciliado.sessaoId);
        setBlocoId(reconciliado.blocoId);
        setTopicoId(reconciliado.topicoId);
        setDisciplinaNome(reconciliado.disciplinaNome);
        setTopicoNome(reconciliado.topicoNome);
        setEtapa(reconciliado.etapa);
        setTempoRestante(reconciliado.tempoRestante);
        setEstaRodando(reconciliado.estaRodando);
        setSegundosEfetivos(reconciliado.segundosEfetivos);
        setSegundosPausa(reconciliado.segundosPausa);
        setNotaLivre(reconciliado.notaLivre);
        setStatusSessao(reconciliado.statusSessao);

        if (
          reconciliado.requerCheckpointServidor &&
          reconciliado.etapa !== 'pausa'
        ) {
          await sincronizarCheckpointSessao(reconciliado.sessaoId, {
            etapaAtual: reconciliado.etapa,
            segundosEfetivos: reconciliado.segundosEfetivos,
            segundosPausa: reconciliado.segundosPausa,
            emPausa: !reconciliado.estaRodando,
            notaLivre: reconciliado.notaLivre,
          });
        }

        setLoading(false);
        return;
      }

      // Caso 3: Sessão ainda não iniciada -> valida bloco e tópico reais do servidor e cria sessão no banco
      if (!reconciliado.blocoId || !reconciliado.topicoId) {
        setStatusSessao('nao_iniciada');
        setErroOperacao(
          'Não foi possível identificar o bloco e o tópico ativos no servidor. Volte ao ciclo e selecione um tópico válido.'
        );
        setLoading(false);
        return;
      }

      const novaSessaoId = await iniciarSessao(
        reconciliado.blocoId,
        reconciliado.topicoId
      );

      setSessaoId(novaSessaoId);
      setBlocoId(reconciliado.blocoId);
      setTopicoId(reconciliado.topicoId);
      setDisciplinaNome(reconciliado.disciplinaNome);
      setTopicoNome(reconciliado.topicoNome);
      setEtapa('revisao');
      setTempoRestante(TEMPO_ETAPAS.revisao);
      setEstaRodando(false);
      setSegundosEfetivos(0);
      setSegundosPausa(0);
      setStatusSessao('pausada');
      setLoading(false);
    } catch (error) {
      setEstaRodando(false);
      setStatusSessao('falha_sincronizacao');
      setErroOperacao(
        error instanceof Error
          ? error.message
          : 'Falha de sincronização com o servidor. Nenhum progresso fictício foi aplicado.'
      );
      setLoading(false);
    } finally {
      operacaoEmVooRef.current = false;
      setSincronizando(false);
    }
  }, [blocoIdParam, topicoIdParam]);

  useEffect(() => {
    let ativo = true;
    void Promise.resolve().then(() => {
      if (ativo) {
        void sincronizarEInicializarComServidor();
      }
    });
    return () => {
      ativo = false;
    };
  }, [sincronizarEInicializarComServidor]);

  // Recuperar estado do servidor após reconexão de rede ou retorno à aba/aplicativo
  useEffect(() => {
    const onOnline = () => {
      void sincronizarEInicializarComServidor();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void sincronizarEInicializarComServidor();
      }
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [sincronizarEInicializarComServidor]);

  // Salvar dica auxiliar no localStorage apenas quando houver sessão aberta válida
  useEffect(() => {
    if (
      loading ||
      !sessaoId ||
      statusSessao === 'concluida' ||
      statusSessao === 'nao_iniciada'
    ) {
      return;
    }

    const state: CacheLocalCronometro = {
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

    localStorage.setItem(STORAGE_KEY_CRONOMETRO, JSON.stringify(state));
  }, [
    tempoRestante,
    estaRodando,
    etapa,
    segundosEfetivos,
    segundosPausa,
    loading,
    sessaoId,
    blocoId,
    topicoId,
    disciplinaNome,
    topicoNome,
    statusSessao,
  ]);

  // Checkpoint periódico de tempo no PostgreSQL a cada 15s enquanto rodando
  useEffect(() => {
    if (!estaRodando || !sessaoId || etapa === 'pausa') return;

    const interval = setInterval(() => {
      if (operacaoEmVooRef.current) return;
      void sincronizarCheckpointSessao(sessaoId, {
        etapaAtual: etapa,
        segundosEfetivos,
        segundosPausa,
        emPausa: false,
        notaLivre: notaLivre || undefined,
      })
        .then((res) => {
          if (res.statusSessao === 'concluida') {
            setEstaRodando(false);
            setStatusSessao('concluida');
            localStorage.removeItem(STORAGE_KEY_CRONOMETRO);
          } else if (
            res.reconciliado &&
            res.sessao.etapaAtingida &&
            res.sessao.etapaAtingida !== etapa
          ) {
            const etapaServidor = res.sessao
              .etapaAtingida as EtapaPedagogicaSessao;
            setEtapa(etapaServidor);
            setTempoRestante(
              calcularTempoRestanteEtapaServidor(
                etapaServidor,
                res.sessao.segundosEfetivos ?? segundosEfetivos
              )
            );
          }
        })
        .catch(() => {
          setEstaRodando(false);
          setStatusSessao('falha_sincronizacao');
          setErroOperacao(
            'Perda de conexão ao salvar checkpoint no servidor. O cronômetro foi pausado para não inventar tempo estudado.'
          );
        });
    }, 15_000);

    return () => clearInterval(interval);
  }, [estaRodando, sessaoId, etapa, segundosEfetivos, segundosPausa, notaLivre]);

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
          if (timerRef.current) clearInterval(timerRef.current);
          void avancarEtapaRef.current();
          return 0;
        }

        if (etapa !== 'pausa') {
          setSegundosEfetivos((s) => s + 1);
        } else {
          setSegundosPausa((s) => s + 1);
        }

        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [estaRodando, etapa]);

  const handleAlternarPlayPause = async () => {
    if (!sessaoId || operacaoEmVooRef.current) return;
    const novoRodando = !estaRodando;
    setEstaRodando(novoRodando);
    setStatusSessao(novoRodando ? 'em_andamento' : 'pausada');
    setErroOperacao('');

    if (etapa !== 'pausa') {
      try {
        const res = await sincronizarCheckpointSessao(sessaoId, {
          etapaAtual: etapa,
          segundosEfetivos,
          segundosPausa,
          emPausa: !novoRodando,
          notaLivre: notaLivre || undefined,
        });
        if (res.statusSessao === 'concluida') {
          setEstaRodando(false);
          setStatusSessao('concluida');
          localStorage.removeItem(STORAGE_KEY_CRONOMETRO);
        }
      } catch (error) {
        setEstaRodando(false);
        setStatusSessao('falha_sincronizacao');
        setErroOperacao(
          error instanceof Error
            ? error.message
            : 'Não foi possível sincronizar o estado do cronômetro com o servidor.'
        );
      }
    }
  };

  const limparCronometroERedirecionar = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    localStorage.removeItem(STORAGE_KEY_CRONOMETRO);
    router.push('/');
  };

  // Adicionar uma anotação de erro (sem criar IDs fictícios q-mock / t-mock)
  const handleAdicionarErro = (e: React.FormEvent) => {
    e.preventDefault();
    if (!descricaoErro.trim() || !conceitoCorreto.trim()) return;

    const novoErro: AnotacaoErroSessao = {
      tipoErro,
      descricaoLivre: descricaoErro.trim(),
      conceitoCorreto: conceitoCorreto.trim(),
    };

    setErrosRegistrados((prev) => [...prev, novoErro]);
    setDescricaoErro('');
    setConceitoCorreto('');
    setMostrarFormErro(false);
  };

  // Finalizar a sessão (etapa de registro)
  const handleFinalizarEstudo = async () => {
    if (!sessaoId || operacaoEmVooRef.current) return;
    operacaoEmVooRef.current = true;
    setSincronizando(true);
    setEstaRodando(false);
    setErroOperacao('');

    // Apenas erros com UUIDs reais de questão e tentativa são enviados em errosParaRegistrar;
    // anotações livres de erro do cronômetro são consolidadas em notaLivre sem IDs falsos.
    const errosReaisParaBanco: ErroParaRegistrar[] = errosRegistrados
      .filter(
        (item): item is Required<AnotacaoErroSessao> =>
          Boolean(
            item.questaoId &&
              item.tentativaId &&
              UUID_REGEX.test(item.questaoId) &&
              UUID_REGEX.test(item.tentativaId)
          )
      )
      .map((item) => ({
        questaoId: item.questaoId,
        tentativaId: item.tentativaId,
        tipoErro: item.tipoErro,
        descricaoLivre: item.descricaoLivre,
        conceitoCorreto: item.conceitoCorreto,
      }));

    const resumoAnotacoesErros = errosRegistrados
      .filter(
        (item) =>
          !item.questaoId ||
          !item.tentativaId ||
          !UUID_REGEX.test(item.questaoId) ||
          !UUID_REGEX.test(item.tentativaId)
      )
      .map(
        (item) =>
          `[${item.tipoErro.toUpperCase()}] ${item.descricaoLivre} -> Conceito: ${item.conceitoCorreto}`
      )
      .join(' ; ');

    const partesNota = [
      notaLivre.trim(),
      `Questões: ${questoesAcertadas}/${questoesResolvidas} acertos.`,
      resumoAnotacoesErros ? `Erros anotados: ${resumoAnotacoesErros}` : '',
    ].filter(Boolean);

    try {
      await concluirSessao(sessaoId, {
        encerradaEm: new Date(),
        segundosEfetivos,
        segundosPausa,
        etapaAtingida: 'registro',
        notaLivre: partesNota.join(' | ').slice(0, 5000),
        ...(errosReaisParaBanco.length > 0 && {
          errosParaRegistrar: errosReaisParaBanco,
        }),
      });
    } catch {
      setStatusSessao('falha_sincronizacao');
      setErroOperacao(
        'Não foi possível confirmar a conclusão no servidor. O ponteiro do ciclo não foi avançado.'
      );
      operacaoEmVooRef.current = false;
      setSincronizando(false);
      return;
    }

    // Remove o cache da sessão aberta; o ponteiro do ciclo já foi avançado atomicamente no PostgreSQL
    localStorage.removeItem(STORAGE_KEY_CRONOMETRO);

    setStatusSessao('concluida');
    setEtapa('pausa');
    setTempoRestante(TEMPO_PAUSA);
    setEstaRodando(true);
    operacaoEmVooRef.current = false;
    setSincronizando(false);
  };

  const transicionarEtapa = async (automatico: boolean) => {
    if (operacaoEmVooRef.current) return;

    if (etapa === 'pausa') {
      limparCronometroERedirecionar();
      return;
    }

    const proxima = obterProximaEtapaPedagogica(etapa);
    if (proxima === 'concluir') {
      await handleFinalizarEstudo();
      return;
    }

    operacaoEmVooRef.current = true;
    setSincronizando(true);
    setEstaRodando(false);
    setErroOperacao('');

    try {
      const resultado = await sincronizarCheckpointSessao(sessaoId, {
        etapaAtual: proxima,
        etapaEsperada: etapa,
        segundosEfetivos,
        segundosPausa,
        emPausa: !automatico,
        notaLivre: notaLivre || undefined,
      });

      if (resultado.statusSessao === 'concluida') {
        setStatusSessao('concluida');
        localStorage.removeItem(STORAGE_KEY_CRONOMETRO);
        return;
      }

      const etapaConfirmada = (resultado.sessao.etapaAtingida ??
        proxima) as EtapaPedagogicaSessao;
      setEtapa(etapaConfirmada);
      setSegundosEfetivos(resultado.sessao.segundosEfetivos ?? segundosEfetivos);
      setSegundosPausa(resultado.sessao.segundosPausa ?? segundosPausa);
      setTempoRestante(TEMPO_ETAPAS[etapaConfirmada]);
      setEstaRodando(automatico);
      setStatusSessao(automatico ? 'em_andamento' : 'pausada');
    } catch {
      setEstaRodando(false);
      setStatusSessao('falha_sincronizacao');
      setErroOperacao(
        automatico
          ? 'Não foi possível salvar o avanço automático. Tente novamente.'
          : 'Não foi possível salvar o avanço da sessão. Tente novamente.'
      );
    } finally {
      operacaoEmVooRef.current = false;
      setSincronizando(false);
    }
  };

  // Avançar etapa automaticamente quando o tempo acaba
  const avancarEtapaAutomatico = async () => {
    await transicionarEtapa(true);
  };

  useEffect(() => {
    avancarEtapaRef.current = avancarEtapaAutomatico;
  });

  // Pular Etapa Manualmente
  const handlePularEtapa = async () => {
    await transicionarEtapa(false);
  };

  // Encerrar sessão prematuramente (antes do registro)
  const handleEncerrarPrematuro = async () => {
    if (!sessaoId || operacaoEmVooRef.current) return;
    const confirmar = confirm(
      'Deseja encerrar a sessão de estudo antes do tempo? Ela será salva como incompleta (concluída = false) e o progresso do ciclo não avançará.'
    );
    if (!confirmar) return;

    operacaoEmVooRef.current = true;
    setSincronizando(true);
    setEstaRodando(false);
    setErroOperacao('');

    try {
      await concluirSessao(sessaoId, {
        encerradaEm: new Date(),
        segundosEfetivos,
        segundosPausa,
        etapaAtingida: etapa as Exclude<EtapaCronometroUI, 'pausa'>,
        notaLivre: `Encerrado prematuramente na etapa de ${etapa}. Nota: ${notaLivre.trim()}`.slice(
          0,
          5000
        ),
      });
    } catch {
      setStatusSessao('falha_sincronizacao');
      setErroOperacao(
        'Não foi possível salvar o encerramento da sessão no servidor. Tente novamente.'
      );
      operacaoEmVooRef.current = false;
      setSincronizando(false);
      return;
    }

    operacaoEmVooRef.current = false;
    setSincronizando(false);
    limparCronometroERedirecionar();
  };

  // Formatação do Tempo (MM:SS)
  const formatTempo = (segundos: number) => {
    const mins = Math.floor(segundos / 60);
    const secs = segundos % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const obterRotuloStatusSessao = (status: StatusSessaoCronometro): string => {
    switch (status) {
      case 'nao_iniciada':
        return 'Sessão não iniciada';
      case 'em_andamento':
        return 'Sessão em andamento';
      case 'pausada':
        return 'Sessão pausada';
      case 'concluida':
        return 'Sessão concluída';
      case 'falha_sincronizacao':
        return 'Falha de sincronização';
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#FBF8F3]">
        <div className="w-8 h-8 border-4 border-[#0E3D4D] border-t-transparent rounded-full animate-spin"></div>
        <p className="text-xs font-semibold text-[#0E3D4D] mt-3">
          Sincronizando Cronômetro com o Servidor...
        </p>
      </div>
    );
  }

  if (erroOperacao && !sessaoId) {
    return (
      <div className="mx-auto max-w-xl p-6 space-y-4">
        <div className="text-xs font-bold uppercase tracking-widest text-[#B5502B]">
          {obterRotuloStatusSessao(statusSessao)}
        </div>
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {erroOperacao}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void sincronizarEInicializarComServidor()}
            className="px-4 py-2 rounded-lg bg-[#0E3D4D] text-white text-xs font-bold hover:bg-[#17607A]"
          >
            Tentar Sincronizar Novamente
          </button>
          <Link
            href="/ciclo"
            className="px-4 py-2 rounded-lg border border-[#D5CBB8] bg-white text-xs font-bold text-[#0E3D4D]"
          >
            Voltar ao Ciclo
          </Link>
        </div>
      </div>
    );
  }

  if (statusSessao === 'concluida' && etapa !== 'pausa') {
    return (
      <div className="mx-auto max-w-xl p-6 space-y-4 font-poppins">
        <div className="rounded-2xl border border-[#EAE3D5] bg-white p-6 shadow-sm space-y-3">
          <span className="text-[10px] uppercase font-bold tracking-widest text-[#17607A]">
            {obterRotuloStatusSessao(statusSessao)}
          </span>
          <h1 className="text-xl font-bold text-[#0E3D4D] font-lora-read">
            {disciplinaNome} — {topicoNome}
          </h1>
          <p className="text-xs text-[#6A7D87]">
            Esta sessão já foi encerrada e confirmada no servidor ({Math.floor(segundosEfetivos / 60)} min estudados).
          </p>
          <div className="pt-2 flex gap-3">
            <Link
              href="/"
              className="px-4 py-2 rounded-xl bg-[#0E3D4D] text-white text-xs font-bold hover:bg-[#17607A]"
            >
              Voltar ao Início
            </Link>
            <Link
              href="/ciclo"
              className="px-4 py-2 rounded-xl border border-[#D5CBB8] bg-[#FBF8F3] text-xs font-bold text-[#0E3D4D]"
            >
              Ver Fila do Ciclo
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Cores de fundo e textos baseadas no estado de estudo ou pausa
  const isPausa = etapa === 'pausa';
  const themeColor = isPausa ? 'text-[#B5502B]' : 'text-[#0E3D4D]';
  const progressBgColor = isPausa ? 'bg-[#B5502B]' : 'bg-[#0E3D4D]';

  return (
    <div
      className={`w-full max-w-md mx-auto bg-transparent min-h-screen pb-24 px-4 pt-6 select-none font-poppins`}
    >
      {/* Topo Sóbrio */}
      <header className="mb-6 flex justify-between items-center">
        <div>
          <span
            data-testid="status-sessao-badge"
            className={`text-[10px] uppercase font-bold tracking-widest ${
              statusSessao === 'falha_sincronizacao'
                ? 'text-red-700'
                : 'text-[#6A7D87]'
            }`}
          >
            {obterRotuloStatusSessao(statusSessao)}
          </span>
          <h1 className="text-xl font-bold text-[#0E3D4D] leading-tight font-lora-read">
            {disciplinaNome}
          </h1>
          <p className="text-xs text-[#6A7D87] font-medium italic mt-0.5">
            {topicoNome}
          </p>
        </div>
        <Link
          href="/"
          className="text-xs font-bold text-[#6A7D87] hover:text-[#0E3D4D] border border-[#D5CBB8] px-3 py-1.5 rounded-lg bg-white"
        >
          Voltar
        </Link>
      </header>

      {erroOperacao && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 flex items-center justify-between gap-3"
        >
          <span>{erroOperacao}</span>
          <button
            type="button"
            onClick={() => void sincronizarEInicializarComServidor()}
            className="px-2.5 py-1 rounded bg-white border border-red-200 text-xs font-bold text-[#0E3D4D] whitespace-nowrap"
          >
            Sincronizar
          </button>
        </div>
      )}

      {/* Indicador de Etapas Horizontal (Linha do Tempo) */}
      {!isPausa && (
        <div className="bg-white border border-[#EAE3D5] rounded-2xl p-4 mb-5 shadow-sm">
          <div className="flex justify-between items-center">
            {(['revisao', 'conteudo', 'questoes', 'registro'] as const).map(
              (step, idx) => {
                const isActive = etapa === step;
                const isPast =
                  ['revisao', 'conteudo', 'questoes', 'registro'].indexOf(
                    etapa
                  ) > idx;

                const stepLabels = {
                  revisao: 'Revisão (5m)',
                  conteudo: 'Teoria (28m)',
                  questoes: 'Questões (15m)',
                  registro: 'Registro (2m)',
                };

                return (
                  <div key={step} className="flex flex-col items-center flex-1">
                    <div className="relative flex items-center justify-center w-full">
                      {idx > 0 && (
                        <div
                          className={`absolute left-0 right-1/2 top-2 h-0.5 -translate-y-1/2 -z-10 ${
                            isPast || isActive
                              ? 'bg-[#0E3D4D]'
                              : 'bg-[#EAE3D5]'
                          }`}
                        />
                      )}
                      {idx < 3 && (
                        <div
                          className={`absolute left-1/2 right-0 top-2 h-0.5 -translate-y-1/2 -z-10 ${
                            isPast ? 'bg-[#0E3D4D]' : 'bg-[#EAE3D5]'
                          }`}
                        />
                      )}

                      <div
                        className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                          isActive
                            ? 'bg-[#0E3D4D] border-[#0E3D4D] scale-110 shadow-sm'
                            : isPast
                              ? 'bg-[#17607A] border-[#17607A]'
                              : 'bg-white border-[#D5CBB8]'
                        }`}
                      />
                    </div>
                    <span
                      className={`text-[9px] font-bold mt-2 text-center ${
                        isActive ? 'text-[#0E3D4D]' : 'text-[#6A7D87]'
                      }`}
                    >
                      {stepLabels[step]}
                    </span>
                  </div>
                );
              }
            )}
          </div>
        </div>
      )}

      {/* Grid responsivo para PC */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 mt-5">
        {/* Coluna Esquerda: Mostrador do Cronômetro (md:col-span-7) */}
        <div className="md:col-span-7">
          <section className="bg-white border border-[#EAE3D5] rounded-3xl p-8 shadow-sm text-center relative overflow-hidden h-full flex flex-col justify-center items-center">
            {isPausa && (
              <div className="absolute top-0 left-0 right-0 bg-[#B5502B] text-white py-1 text-[10px] uppercase font-bold tracking-widest">
                Intervalo Obrigatório
              </div>
            )}

            <span className="text-[10px] uppercase font-bold tracking-widest text-[#6A7D87] block mb-2">
              {isPausa
                ? 'Pausa para Descanso Visual'
                : `Etapa atual: ${etapa.toUpperCase()}`}
            </span>

            <div
              className={`text-6xl font-bold font-poppins tracking-tighter ${themeColor} my-3`}
            >
              {formatTempo(tempoRestante)}
            </div>

            <div className="w-full bg-[#F1EFEA] h-1.5 rounded-full overflow-hidden border border-[#EAE3D5]/30 mb-6">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${progressBgColor}`}
                style={{
                  width: `${
                    (tempoRestante /
                      (isPausa
                        ? TEMPO_PAUSA
                        : TEMPO_ETAPAS[
                            etapa as Exclude<EtapaCronometroUI, 'pausa'>
                          ])) *
                    100
                  }%`,
                }}
              />
            </div>

            {/* Controles principais */}
            <div className="flex justify-center items-center gap-6">
              {/* Play/Pause */}
              <button
                type="button"
                disabled={sincronizando}
                onClick={() => void handleAlternarPlayPause()}
                className={`w-16 h-16 rounded-full flex items-center justify-center text-white transition-all shadow-md active:scale-95 disabled:opacity-50 ${
                  isPausa
                    ? 'bg-[#B5502B] hover:bg-[#A04523]'
                    : 'bg-[#0E3D4D] hover:bg-[#17607A]'
                } min-w-[44px] min-h-[44px]`}
              >
                {estaRodando ? (
                  <svg
                    className="w-6 h-6"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      fillRule="evenodd"
                      d="M6.75 5.25a.75.75 0 01.75-.75H9a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H7.5a.75.75 0 01-.75-.75V5.25zm7.5 0A.75.75 0 0115 4.5h1.5a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H15a.75.75 0 01-.75-.75V5.25z"
                      clipRule="evenodd"
                    />
                  </svg>
                ) : (
                  <svg
                    className="w-6 h-6 translate-x-0.5"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      fillRule="evenodd"
                      d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </button>

              {/* Pular Etapa */}
              <button
                type="button"
                disabled={sincronizando}
                onClick={() => void handlePularEtapa()}
                title="Avançar Etapa"
                className="w-11 h-11 rounded-full bg-[#FBF8F3] hover:bg-[#F1EFEA] border border-[#D5CBB8] text-[#1B2A33] flex items-center justify-center transition-colors active:scale-95 disabled:opacity-50 min-h-[44px] min-w-[44px]"
              >
                <svg
                  className="w-5 h-5 text-[#6A7D87]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13 5l7 7-7 7M5 5l7 7-7 7"
                  />
                </svg>
              </button>

              {/* Encerrar Prematuro */}
              {!isPausa && (
                <button
                  type="button"
                  disabled={sincronizando}
                  onClick={() => void handleEncerrarPrematuro()}
                  title="Encerrar Sessão"
                  className="w-11 h-11 rounded-full bg-[#FBF8F3] hover:bg-red-50 border border-red-200 text-[#B5502B] flex items-center justify-center transition-colors active:scale-95 disabled:opacity-50 min-h-[44px] min-w-[44px]"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>
          </section>
        </div>

        {/* Coluna Direita: Registro ou Pausa (md:col-span-5) */}
        <div className="md:col-span-5 space-y-4">
          {etapa === 'registro' && (
            <section className="bg-white border border-[#EAE3D5] rounded-2xl p-5 shadow-sm space-y-4">
              <div className="border-b border-[#F1EFEA] pb-2">
                <span className="text-xs font-bold text-[#0E3D4D] uppercase tracking-wider block">
                  Ficha de Registro de Estudo
                </span>
                <p className="text-[10px] text-[#6A7D87] font-medium mt-0.5">
                  O registro é obrigatório para contabilizar a sessão no ciclo.
                </p>
              </div>

              {/* Contador de Questões */}
              <div className="bg-[#FBF8F3] border border-[#EAE3D5] p-3.5 rounded-xl">
                <span className="block text-xs font-bold text-[#6A7D87] mb-2">
                  Desempenho em Questões (Fase Teoria/Prática):
                </span>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-bold text-[#6A7D87] mb-1">
                      Resolvidas:
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={questoesResolvidas}
                      onChange={(e) =>
                        setQuestoesResolvidas(
                          Math.max(0, parseInt(e.target.value, 10) || 0)
                        )
                      }
                      className="w-full h-10 px-2 bg-white border border-[#D5CBB8] rounded-lg text-xs font-semibold focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-[#6A7D87] mb-1">
                      Acertos:
                    </label>
                    <input
                      type="number"
                      min="0"
                      max={questoesResolvidas}
                      value={questoesAcertadas}
                      onChange={(e) =>
                        setQuestoesAcertadas(
                          Math.min(
                            questoesResolvidas,
                            Math.max(0, parseInt(e.target.value, 10) || 0)
                          )
                        )
                      }
                      className="w-full h-10 px-2 bg-white border border-[#D5CBB8] rounded-lg text-xs font-semibold focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Anotações de Erros da Sessão */}
              {questoesResolvidas > 0 &&
                questoesAcertadas < questoesResolvidas && (
                  <div className="border border-[#EAE3D5] rounded-xl p-3">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs font-bold text-[#B5502B]">
                        Erros detectados ({questoesResolvidas - questoesAcertadas})
                      </span>
                      <button
                        type="button"
                        onClick={() => setMostrarFormErro(!mostrarFormErro)}
                        className="text-[10px] font-bold text-[#0E3D4D] bg-[#F1EFEA] hover:bg-[#EAE3D5] px-2 py-1 rounded transition-colors"
                      >
                        {mostrarFormErro ? 'Cancelar' : '+ Registrar Erro'}
                      </button>
                    </div>

                    {errosRegistrados.length > 0 && (
                      <div className="space-y-1.5 mb-2">
                        {errosRegistrados.map((err, idx) => (
                          <div
                            key={idx}
                            className="bg-red-50/50 border border-red-100 p-2 rounded-lg text-[10px] leading-relaxed text-[#1B2A33]"
                          >
                            <div className="flex justify-between items-center mb-0.5">
                              <span className="font-bold text-[#B5502B] uppercase text-[9px]">
                                {err.tipoErro}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setErrosRegistrados((prev) =>
                                    prev.filter((_, i) => i !== idx)
                                  )
                                }
                                className="text-[9px] font-bold text-[#B5502B] hover:text-[#0E3D4D]"
                              >
                                Remover
                              </button>
                            </div>
                            <p className="italic font-lora-read">
                              &ldquo;{err.descricaoLivre}&rdquo;
                            </p>
                            <p className="mt-0.5 font-semibold text-[#0E3D4D]">
                              Conceito: {err.conceitoCorreto}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}

                    {mostrarFormErro && (
                      <form
                        onSubmit={handleAdicionarErro}
                        className="space-y-2 mt-2 pt-2 border-t border-[#F1EFEA]"
                      >
                        <div>
                          <label className="block text-[10px] font-bold text-[#6A7D87] mb-1">
                            Categoria do Erro:
                          </label>
                          <select
                            value={tipoErro}
                            onChange={(e) =>
                              setTipoErro(
                                e.target.value as AnotacaoErroSessao['tipoErro']
                              )
                            }
                            className="w-full h-8 px-2 bg-white border border-[#D5CBB8] rounded-lg text-xs"
                          >
                            <option value="conteudo">
                              Conteúdo (Lacuna teórica)
                            </option>
                            <option value="interpretacao">
                              Interpretação (Entendimento)
                            </option>
                            <option value="distracao">
                              Distração (Atenção)
                            </option>
                            <option value="calculo">
                              Cálculo (Matemática)
                            </option>
                            <option value="tempo">
                              Tempo (Prazo estourado)
                            </option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-[#6A7D87] mb-1">
                            Descrição do que errou:
                          </label>
                          <input
                            type="text"
                            value={descricaoErro}
                            onChange={(e) => setDescricaoErro(e.target.value)}
                            placeholder="Ex: Confundi os coeficientes na fórmula de Bhaskara..."
                            className="w-full h-8 px-2 bg-white border border-[#D5CBB8] rounded-lg text-xs"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-[#6A7D87] mb-1">
                            Conceito Correto (Fato a fixar):
                          </label>
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
                          Adicionar Anotação de Erro
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
                type="button"
                disabled={sincronizando}
                onClick={() => void handleFinalizarEstudo()}
                className="w-full h-12 bg-[#0E3D4D] text-white font-bold text-sm rounded-xl shadow hover:bg-[#17607A] active:scale-[0.98] transition-all disabled:opacity-50 min-h-[44px]"
              >
                {sincronizando
                  ? 'Confirmando no Servidor...'
                  : 'Finalizar Estudo e Iniciar Pausa'}
              </button>
            </section>
          )}

          {isPausa && (
            <section className="bg-white border border-[#EAE3D5] rounded-2xl p-5 shadow-sm text-center space-y-3">
              <span className="text-xs font-bold text-[#B5502B] uppercase tracking-wider block">
                Orientações de Descanso
              </span>
              <p className="font-lora-read text-[#1B2A33] text-sm leading-relaxed italic">
                &ldquo;Aproveite este intervalo de 10 minutos para desviar os
                olhos das telas, caminhar e alongar-se brevemente. Mantenha-se
                hidratado.&rdquo;
              </p>
              <div className="pt-2 border-t border-[#F1EFEA] flex justify-center">
                <button
                  type="button"
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
