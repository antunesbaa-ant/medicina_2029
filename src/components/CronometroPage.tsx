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
        if (!reconciliado.blocoId) {
          setErroOperacao(
            'Não foi possível identificar o bloco do ciclo ativo no servidor. Volte ao ciclo para verificar.'
          );
        } else {
          setErroOperacao(
            'Nenhum tópico cadastrado no banco para esta disciplina. Cadastre ou selecione um tópico antes de iniciar o estudo.'
          );
        }
        setLoading(false);
        return;
      }

      const novaSessaoId = await iniciarSessao(
        reconciliado.blocoId,
        reconciliado.topicoId
      );

      // Alinha a URL do navegador caso tenha sido acessada com parâmetros de bloco obsoleto
      if (blocoIdParam && blocoIdParam !== reconciliado.blocoId) {
        router.replace(
          `/estudar?blocoId=${reconciliado.blocoId}&topicoId=${reconciliado.topicoId}`
        );
      }

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

  if (loading || (sincronizando && !sessaoId)) {
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

  if (!sessaoId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#FBF8F3]">
        <div className="w-8 h-8 border-4 border-[#0E3D4D] border-t-transparent rounded-full animate-spin"></div>
        <p className="text-xs font-semibold text-[#0E3D4D] mt-3">
          Inicializando sessão de estudo...
        </p>
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

  // Configuração das 5 etapas da progressão visual contínua
  const ETAPAS_PROGRESSAO = [
    { id: 'revisao', rotulo: 'Revisão', duracao: '5m', desc: 'Evocação ativa' },
    { id: 'conteudo', rotulo: 'Teoria', duracao: '28m', desc: 'Estudo focado' },
    { id: 'questoes', rotulo: 'Questões', duracao: '15m', desc: 'Treino prático' },
    { id: 'registro', rotulo: 'Registro', duracao: '2m', desc: 'Consolidação' },
    { id: 'pausa', rotulo: 'Pausa', duracao: '10m', desc: 'Descanso visual' },
  ] as const;

  const ordemEtapas = ['revisao', 'conteudo', 'questoes', 'registro', 'pausa'];
  const indiceEtapaAtual = ordemEtapas.indexOf(etapa);

  return (
    <div className="w-full max-w-6xl mx-auto bg-transparent min-h-screen pb-24 px-4 sm:px-6 lg:px-8 pt-6 select-none font-poppins">
      {/* Topo Sóbrio e Responsivo */}
      <header className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-[#EAE3D5]/60">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span
              data-testid="status-sessao-badge"
              className={`text-[10px] sm:text-xs uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full ${
                statusSessao === 'falha_sincronizacao'
                  ? 'bg-red-100 text-red-700'
                  : statusSessao === 'em_andamento'
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-[#EAE3D5]/80 text-[#6A7D87]'
              }`}
            >
              {obterRotuloStatusSessao(statusSessao)}
            </span>
            {isPausa && (
              <span className="text-[10px] sm:text-xs uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800">
                Descanso Ativo
              </span>
            )}
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-[#0E3D4D] leading-tight font-lora-read">
            {disciplinaNome}
          </h1>
          <p className="text-xs sm:text-sm text-[#6A7D87] font-medium italic mt-0.5">
            {topicoNome}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/ciclo"
            className="text-xs font-bold text-[#0E3D4D] hover:text-[#17607A] border border-[#D5CBB8] px-3.5 py-2 rounded-xl bg-white hover:bg-[#FBF8F3] transition-colors shadow-sm flex items-center gap-1.5"
          >
            <span>Ver Fila do Ciclo</span>
          </Link>
          <Link
            href="/"
            className="text-xs font-bold text-[#6A7D87] hover:text-[#0E3D4D] border border-[#D5CBB8] px-3.5 py-2 rounded-xl bg-white hover:bg-[#FBF8F3] transition-colors shadow-sm flex items-center gap-1.5"
          >
            <span>Voltar ao Início</span>
          </Link>
        </div>
      </header>

      {erroOperacao && (
        <div
          role="alert"
          className="mb-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-sm"
        >
          <span className="font-medium">{erroOperacao}</span>
          <button
            type="button"
            onClick={() => void sincronizarEInicializarComServidor()}
            className="px-3.5 py-1.5 rounded-xl bg-white border border-red-200 text-xs font-bold text-[#0E3D4D] hover:bg-red-50/50 whitespace-nowrap self-start sm:self-auto transition-colors"
          >
            Sincronizar Novamente
          </button>
        </div>
      )}

      {/* Indicador de Etapas Horizontal (Linha do Tempo Contínua de 5 Etapas) */}
      <nav aria-label="Progresso da sessão de estudo" className="bg-white border border-[#EAE3D5] rounded-2xl p-4 sm:p-5 mb-6 shadow-sm">
        <div className="grid grid-cols-5 gap-2 items-center">
          {ETAPAS_PROGRESSAO.map((step, idx) => {
            const isActive = etapa === step.id;
            const isPast = indiceEtapaAtual > idx;

            return (
              <div key={step.id} className="flex flex-col items-center text-center relative">
                {/* Linha conectora entre os nós */}
                {idx > 0 && (
                  <div
                    className={`absolute left-0 right-1/2 top-2 sm:top-2.5 h-0.5 -translate-y-1/2 -z-0 ${
                      isPast || isActive ? 'bg-[#0E3D4D]' : 'bg-[#EAE3D5]'
                    }`}
                  />
                )}
                {idx < ETAPAS_PROGRESSAO.length - 1 && (
                  <div
                    className={`absolute left-1/2 right-0 top-2 sm:top-2.5 h-0.5 -translate-y-1/2 -z-0 ${
                      isPast ? 'bg-[#0E3D4D]' : 'bg-[#EAE3D5]'
                    }`}
                  />
                )}

                {/* Nó do indicador */}
                <div
                  className={`relative z-10 w-4 h-4 sm:w-5 sm:h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                    isActive
                      ? isPausa
                        ? 'bg-[#B5502B] border-[#B5502B] scale-110 shadow-sm ring-4 ring-[#B5502B]/15'
                        : 'bg-[#0E3D4D] border-[#0E3D4D] scale-110 shadow-sm ring-4 ring-[#0E3D4D]/15'
                      : isPast
                        ? 'bg-[#17607A] border-[#17607A]'
                        : 'bg-white border-[#D5CBB8]'
                  }`}
                />

                <span
                  className={`text-[10px] sm:text-xs font-bold mt-2 truncate w-full ${
                    isActive
                      ? isPausa
                        ? 'text-[#B5502B]'
                        : 'text-[#0E3D4D]'
                      : isPast
                        ? 'text-[#17607A]'
                        : 'text-[#6A7D87]'
                  }`}
                >
                  {step.rotulo} ({step.duracao})
                </span>
                <span className="hidden md:block text-[9px] text-[#6A7D87] font-medium mt-0.5 truncate w-full">
                  {step.desc}
                </span>
              </div>
            );
          })}
        </div>
      </nav>

      {/* Grid Responsivo Proporcional: Cronômetro (esquerda) + Painel Contextual/Registro (direita) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8 items-start">
        {/* Coluna Esquerda: Mostrador do Cronômetro e Controles */}
        <div className="lg:col-span-5 xl:col-span-5 flex flex-col gap-5">
          <section className="bg-white border border-[#EAE3D5] rounded-3xl p-6 sm:p-8 shadow-sm text-center relative overflow-hidden flex flex-col justify-center items-center">
            {isPausa ? (
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200 text-[#B5502B] text-xs font-bold uppercase tracking-wider mb-2">
                <span className="w-2 h-2 rounded-full bg-[#B5502B] animate-pulse" />
                Pausa para Descanso Visual
              </div>
            ) : (
              <span className="text-xs uppercase font-bold tracking-widest text-[#6A7D87] block mb-2">
                {`Etapa atual: ${etapa.toUpperCase()}`}
              </span>
            )}

            {/* Mostrador Numérico Ampliado */}
            <div
              className={`text-6xl sm:text-7xl font-bold font-poppins tracking-tighter ${themeColor} my-3 sm:my-4`}
            >
              {formatTempo(tempoRestante)}
            </div>

            {/* Barra de Progresso Suave */}
            <div className="w-full bg-[#F1EFEA] h-2 sm:h-2.5 rounded-full overflow-hidden border border-[#EAE3D5]/40 mb-6">
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

            {/* Controles Principais com Dimensões Confortáveis */}
            <div className="flex justify-center items-center gap-5 sm:gap-6">
              {/* Play / Pause Principal */}
              <button
                type="button"
                disabled={sincronizando}
                onClick={() => void handleAlternarPlayPause()}
                aria-label={estaRodando ? 'Pausar Cronômetro' : 'Iniciar Cronômetro'}
                className={`w-16 h-16 sm:w-18 sm:h-18 rounded-2xl sm:rounded-3xl flex items-center justify-center text-white transition-all shadow-md active:scale-95 disabled:opacity-50 min-w-[44px] min-h-[44px] ${
                  isPausa
                    ? 'bg-[#B5502B] hover:bg-[#A04523] shadow-amber-900/10'
                    : 'bg-[#0E3D4D] hover:bg-[#17607A] shadow-[#0E3D4D]/20'
                }`}
              >
                {estaRodando ? (
                  <svg
                    className="w-7 h-7"
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
                    className="w-7 h-7 translate-x-0.5"
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

              {/* Avançar Etapa Manual */}
              <button
                type="button"
                disabled={sincronizando}
                onClick={() => void handlePularEtapa()}
                title="Avançar Etapa"
                aria-label="Avançar Etapa"
                className="w-12 h-12 rounded-2xl bg-[#FBF8F3] hover:bg-[#F1EFEA] border border-[#D5CBB8] text-[#1B2A33] flex items-center justify-center transition-all active:scale-95 disabled:opacity-50 min-h-[44px] min-w-[44px] shadow-sm"
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

              {/* Encerrar Prematuro (Disponível apenas durante o estudo) */}
              {!isPausa && (
                <button
                  type="button"
                  disabled={sincronizando}
                  onClick={() => void handleEncerrarPrematuro()}
                  title="Encerrar Sessão"
                  aria-label="Encerrar Sessão"
                  className="w-12 h-12 rounded-2xl bg-[#FBF8F3] hover:bg-red-50 border border-red-200 text-[#B5502B] flex items-center justify-center transition-all active:scale-95 disabled:opacity-50 min-h-[44px] min-w-[44px] shadow-sm"
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

          {/* Cartão de Resumo e Métricas da Sessão */}
          <div className="bg-white border border-[#EAE3D5] rounded-2xl p-4 sm:p-5 shadow-sm">
            <h2 className="text-xs font-bold text-[#0E3D4D] uppercase tracking-wider mb-3">
              Métricas da Sessão Atual
            </h2>
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="bg-[#FBF8F3] border border-[#EAE3D5]/80 rounded-xl p-3">
                <span className="text-[10px] uppercase font-bold text-[#6A7D87] block mb-1">
                  Tempo Efetivo
                </span>
                <span className="text-base sm:text-lg font-bold text-[#0E3D4D]">
                  {Math.floor(segundosEfetivos / 60)}m {segundosEfetivos % 60}s
                </span>
              </div>
              <div className="bg-[#FBF8F3] border border-[#EAE3D5]/80 rounded-xl p-3">
                <span className="text-[10px] uppercase font-bold text-[#6A7D87] block mb-1">
                  Tempo em Pausa
                </span>
                <span className="text-base sm:text-lg font-bold text-[#B5502B]">
                  {Math.floor(segundosPausa / 60)}m {segundosPausa % 60}s
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Coluna Direita: Painel Contextual / Ficha de Registro / Descanso */}
        <div className="lg:col-span-7 xl:col-span-7 flex flex-col gap-5">
          {/* ETAPA 1: REVISÃO (Evocação Ativa) */}
          {etapa === 'revisao' && (
            <section className="bg-white border border-[#EAE3D5] rounded-3xl p-6 sm:p-8 shadow-sm space-y-5">
              <div className="border-b border-[#F1EFEA] pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-bold text-white bg-[#0E3D4D] px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                    Etapa 1 de 4 • 5 min
                  </span>
                  <span className="text-xs font-bold text-[#6A7D87]">
                    Evocação Ativa Prévia
                  </span>
                </div>
                <h2 className="text-xl sm:text-2xl font-bold text-[#0E3D4D] font-lora-read mt-1">
                  Revisão Sem Consulta
                </h2>
                <p className="text-xs sm:text-sm text-[#6A7D87] mt-1 leading-relaxed">
                  Antes de abrir materiais teóricos novos, force sua memória a recuperar conceitos, fórmulas e esquemas prévios sobre <strong>{topicoNome}</strong>.
                </p>
              </div>

              <div className="bg-[#FBF8F3] border border-[#EAE3D5] p-4 rounded-2xl space-y-2">
                <h3 className="text-xs font-bold text-[#0E3D4D] uppercase tracking-wider">
                  Diretrizes de Fixação:
                </h3>
                <ul className="text-xs sm:text-sm text-[#1B2A33] space-y-1.5 list-disc list-inside font-medium leading-relaxed">
                  <li>Escreva as principais definições e fórmulas fundamentais do tema.</li>
                  <li>Identifique quais partes você não conseguiu lembrar com nitidez.</li>
                  <li>Essas dúvidas direcionarão seu foco durante a fase de teoria.</li>
                </ul>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#0E3D4D] mb-1.5">
                  Rascunho Rápido de Evocação (salvo automaticamente):
                </label>
                <textarea
                  value={notaLivre}
                  onChange={(e) => setNotaLivre(e.target.value)}
                  placeholder="Escreva aqui tudo o que você lembra do tópico antes de abrir o material novo..."
                  rows={4}
                  className="w-full p-4 bg-[#FBF8F3] border border-[#D5CBB8] rounded-2xl text-sm font-medium text-[#1B2A33] focus:outline-none focus:ring-2 focus:ring-[#0E3D4D]/20 focus:border-[#0E3D4D] font-lora-read leading-relaxed"
                />
              </div>
            </section>
          )}

          {/* ETAPA 2: CONTEÚDO (Teoria Estruturada & Deep Work) */}
          {etapa === 'conteudo' && (
            <section className="bg-white border border-[#EAE3D5] rounded-3xl p-6 sm:p-8 shadow-sm space-y-5">
              <div className="border-b border-[#F1EFEA] pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-bold text-white bg-[#0E3D4D] px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                    Etapa 2 de 4 • 28 min
                  </span>
                  <span className="text-xs font-bold text-[#6A7D87]">
                    Estudo Focado & Teoria
                  </span>
                </div>
                <h2 className="text-xl sm:text-2xl font-bold text-[#0E3D4D] font-lora-read mt-1">
                  Teoria & Aprofundamento Conceitual
                </h2>
                <p className="text-xs sm:text-sm text-[#6A7D87] mt-1 leading-relaxed">
                  Foco total no material estruturado de <strong>{topicoNome}</strong>. Busque o entendimento causal dos fenômenos e a lógica por trás de cada modelo ou equação.
                </p>
              </div>

              <div className="bg-[#FBF8F3] border border-[#EAE3D5] p-4 rounded-2xl space-y-2">
                <h3 className="text-xs font-bold text-[#0E3D4D] uppercase tracking-wider">
                  Boas Práticas de Leitura Ativa:
                </h3>
                <ul className="text-xs sm:text-sm text-[#1B2A33] space-y-1.5 list-disc list-inside font-medium leading-relaxed">
                  <li>Evite grifos mecânicos: transforme parágrafos em perguntas e respostas.</li>
                  <li>Dê atenção aos gráficos, diagramas e dados quantitativos.</li>
                  <li>Anote dúvidas conceituais para testar na resolução de questões.</li>
                </ul>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#0E3D4D] mb-1.5">
                  Caderno de Notas da Sessão (sincronizado a cada 15 segundos):
                </label>
                <textarea
                  value={notaLivre}
                  onChange={(e) => setNotaLivre(e.target.value)}
                  placeholder="Capture conceitos centrais, esquemas mentais, fórmulas-chave e dúvidas para sanar no treino prático..."
                  rows={6}
                  className="w-full p-4 bg-[#FBF8F3] border border-[#D5CBB8] rounded-2xl text-sm font-medium text-[#1B2A33] focus:outline-none focus:ring-2 focus:ring-[#0E3D4D]/20 focus:border-[#0E3D4D] font-lora-read leading-relaxed"
                />
              </div>
            </section>
          )}

          {/* ETAPA 3: QUESTÕES (Treino Prático no Ritmo do ENEM/Vestibulares) */}
          {etapa === 'questoes' && (
            <section className="bg-white border border-[#EAE3D5] rounded-3xl p-6 sm:p-8 shadow-sm space-y-5">
              <div className="border-b border-[#F1EFEA] pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-bold text-white bg-[#0E3D4D] px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                    Etapa 3 de 4 • 15 min
                  </span>
                  <span className="text-xs font-bold text-[#6A7D87]">
                    Aplicação Prática • Ritmo de Prova
                  </span>
                </div>
                <h2 className="text-xl sm:text-2xl font-bold text-[#0E3D4D] font-lora-read mt-1">
                  Resolução de Questões
                </h2>
                <p className="text-xs sm:text-sm text-[#6A7D87] mt-1 leading-relaxed">
                  Resolva exercícios de vestibulares concorridos sobre <strong>{topicoNome}</strong>. Meta ideal: ~3 minutos por questão com leitura atenta aos distratores.
                </p>
              </div>

              {/* Registro Rápido Durante a Resolução */}
              <div className="bg-[#FBF8F3] border border-[#EAE3D5] p-5 rounded-2xl space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-[#0E3D4D] uppercase tracking-wider">
                    Placar Rápido de Questões
                  </span>
                  {questoesResolvidas > 0 && (
                    <span className="text-xs font-bold text-[#17607A] bg-white border border-[#D5CBB8] px-2.5 py-1 rounded-full">
                      Aproveitamento: {Math.round((questoesAcertadas / questoesResolvidas) * 100)}%
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-[#6A7D87] mb-1.5">
                      Questões Resolvidas:
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
                      className="w-full h-12 px-4 bg-white border border-[#D5CBB8] rounded-xl text-base font-bold text-[#1B2A33] focus:ring-2 focus:ring-[#0E3D4D]/20 focus:border-[#0E3D4D] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-[#6A7D87] mb-1.5">
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
                      className="w-full h-12 px-4 bg-white border border-[#D5CBB8] rounded-xl text-base font-bold text-[#1B2A33] focus:ring-2 focus:ring-[#0E3D4D]/20 focus:border-[#0E3D4D] focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#0E3D4D] mb-1.5">
                  Notas sobre Pegadinhas e Enunciados Dificultosos:
                </label>
                <textarea
                  value={notaLivre}
                  onChange={(e) => setNotaLivre(e.target.value)}
                  placeholder="Anote se caiu em alguma pegadinha de enunciado ou se houve distrator forte..."
                  rows={4}
                  className="w-full p-4 bg-[#FBF8F3] border border-[#D5CBB8] rounded-2xl text-sm font-medium text-[#1B2A33] focus:outline-none focus:ring-2 focus:ring-[#0E3D4D]/20 focus:border-[#0E3D4D] font-lora-read leading-relaxed"
                />
              </div>
            </section>
          )}

          {/* ETAPA 4: FICHA DE REGISTRO COMPLETA (Fase Obrigatória para Conclusão) */}
          {etapa === 'registro' && (
            <section className="bg-white border border-[#EAE3D5] rounded-3xl p-6 sm:p-8 shadow-sm space-y-6">
              <div className="border-b border-[#F1EFEA] pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-bold text-white bg-[#0E3D4D] px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                    Etapa 4 de 4 • Registro
                  </span>
                  <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
                    Estudo Concluído
                  </span>
                </div>
                <h2 className="text-xl sm:text-2xl font-bold text-[#0E3D4D] font-lora-read uppercase tracking-wide mt-1">
                  Ficha de Registro de Estudo
                </h2>
                <p className="text-xs sm:text-sm text-[#6A7D87] font-medium mt-1">
                  O registro é obrigatório para contabilizar a sessão no ciclo e alimentar a fila de revisões espaçadas.
                </p>
              </div>

              {/* Bloco de Desempenho em Questões */}
              <div className="bg-[#FBF8F3] border border-[#EAE3D5] p-5 sm:p-6 rounded-2xl space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                  <span className="text-xs font-bold text-[#0E3D4D] uppercase tracking-wider block">
                    Desempenho em Questões (Fase Teoria / Prática)
                  </span>
                  {questoesResolvidas > 0 && (
                    <span className="text-xs font-bold text-[#0E3D4D] bg-white border border-[#D5CBB8] px-3 py-1 rounded-full self-start sm:self-auto">
                      Aproveitamento: {Math.round((questoesAcertadas / questoesResolvidas) * 100)}%
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                  <div>
                    <label className="block text-xs font-bold text-[#0E3D4D] mb-1.5">
                      Questões Resolvidas:
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
                      className="w-full h-12 px-4 bg-white border border-[#D5CBB8] rounded-xl text-base font-bold text-[#1B2A33] focus:ring-2 focus:ring-[#0E3D4D]/20 focus:border-[#0E3D4D] focus:outline-none transition-all shadow-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-[#0E3D4D] mb-1.5">
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
                      className="w-full h-12 px-4 bg-white border border-[#D5CBB8] rounded-xl text-base font-bold text-[#1B2A33] focus:ring-2 focus:ring-[#0E3D4D]/20 focus:border-[#0E3D4D] focus:outline-none transition-all shadow-sm"
                    />
                  </div>
                </div>
              </div>

              {/* Bloco de Anotações de Erros */}
              {questoesResolvidas > 0 &&
                questoesAcertadas < questoesResolvidas && (
                  <div className="border border-[#EAE3D5] rounded-2xl p-5 sm:p-6 bg-[#FBF8F3]/60 space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <div>
                        <span className="text-sm font-bold text-[#B5502B] block">
                          Erros detectados ({questoesResolvidas - questoesAcertadas})
                        </span>
                        <p className="text-[11px] text-[#6A7D87] mt-0.5">
                          Identifique a causa raiz de cada erro para evitar reincidência.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setMostrarFormErro(!mostrarFormErro)}
                        className="text-xs font-bold text-[#0E3D4D] bg-white border border-[#D5CBB8] hover:bg-[#F1EFEA] px-3.5 py-2 rounded-xl transition-colors shadow-sm self-start sm:self-auto"
                      >
                        {mostrarFormErro ? 'Cancelar' : '+ Registrar Erro'}
                      </button>
                    </div>

                    {errosRegistrados.length > 0 && (
                      <div className="space-y-2 pt-2">
                        {errosRegistrados.map((err, idx) => (
                          <div
                            key={idx}
                            className="bg-white border border-red-100 p-3.5 rounded-xl text-xs leading-relaxed text-[#1B2A33] shadow-sm"
                          >
                            <div className="flex justify-between items-center mb-1">
                              <span className="font-bold text-[#B5502B] uppercase text-[10px] tracking-wider px-2 py-0.5 bg-red-50 rounded-md border border-red-100">
                                {err.tipoErro}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setErrosRegistrados((prev) =>
                                    prev.filter((_, i) => i !== idx)
                                  )
                                }
                                className="text-[11px] font-bold text-[#B5502B] hover:text-[#0E3D4D] transition-colors"
                              >
                                Remover
                              </button>
                            </div>
                            <p className="italic font-lora-read text-[#1B2A33] my-1">
                              &ldquo;{err.descricaoLivre}&rdquo;
                            </p>
                            <p className="mt-1 font-semibold text-[#0E3D4D]">
                              Conceito Correto: <span className="font-normal text-[#1B2A33]">{err.conceitoCorreto}</span>
                            </p>
                          </div>
                        ))}
                      </div>
                    )}

                    {mostrarFormErro && (
                      <form
                        onSubmit={handleAdicionarErro}
                        className="space-y-3.5 mt-3 pt-3 border-t border-[#EAE3D5]"
                      >
                        <div>
                          <label className="block text-xs font-bold text-[#6A7D87] mb-1">
                            Categoria do Erro:
                          </label>
                          <select
                            value={tipoErro}
                            onChange={(e) =>
                              setTipoErro(
                                e.target.value as AnotacaoErroSessao['tipoErro']
                              )
                            }
                            className="w-full h-11 px-3 bg-white border border-[#D5CBB8] rounded-xl text-xs sm:text-sm font-medium focus:ring-2 focus:ring-[#0E3D4D]/20 focus:border-[#0E3D4D]"
                          >
                            <option value="conteudo">
                              Conteúdo (Lacuna teórica)
                            </option>
                            <option value="interpretacao">
                              Interpretação (Entendimento do texto)
                            </option>
                            <option value="distracao">
                              Distração (Falta de atenção ao comando)
                            </option>
                            <option value="calculo">
                              Cálculo (Equívoco de operação matemática)
                            </option>
                            <option value="tempo">
                              Tempo (Prazo estourado / pressa)
                            </option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-[#6A7D87] mb-1">
                            Descrição do que errou:
                          </label>
                          <input
                            type="text"
                            value={descricaoErro}
                            onChange={(e) => setDescricaoErro(e.target.value)}
                            placeholder="Ex: Confundi os coeficientes na fórmula de Bhaskara..."
                            className="w-full h-11 px-3.5 bg-white border border-[#D5CBB8] rounded-xl text-xs sm:text-sm font-medium focus:ring-2 focus:ring-[#0E3D4D]/20 focus:border-[#0E3D4D]"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-[#6A7D87] mb-1">
                            Conceito Correto (Fato a fixar):
                          </label>
                          <input
                            type="text"
                            value={conceitoCorreto}
                            onChange={(e) => setConceitoCorreto(e.target.value)}
                            placeholder="Ex: O termo 'c' é independente, 'b' multiplica x..."
                            className="w-full h-11 px-3.5 bg-white border border-[#D5CBB8] rounded-xl text-xs sm:text-sm font-medium focus:ring-2 focus:ring-[#0E3D4D]/20 focus:border-[#0E3D4D]"
                          />
                        </div>
                        <button
                          type="submit"
                          className="w-full h-11 bg-[#B5502B] text-white font-bold text-xs sm:text-sm rounded-xl shadow-sm hover:bg-[#A04523] active:scale-[0.99] transition-all min-h-[44px]"
                        >
                          Adicionar Anotação de Erro
                        </button>
                      </form>
                    )}
                  </div>
                )}

              {/* Campo de Anotações e Observações Gerais */}
              <div>
                <label className="block text-xs font-bold text-[#0E3D4D] mb-1.5">
                  Notas e Observações de Estudo:
                </label>
                <textarea
                  value={notaLivre}
                  onChange={(e) => setNotaLivre(e.target.value)}
                  placeholder="Descreva as principais dificuldades ou pontos de fixação aprendidos nesta sessão..."
                  rows={4}
                  className="w-full p-4 bg-[#FBF8F3] border border-[#D5CBB8] rounded-2xl text-sm font-medium text-[#1B2A33] focus:outline-none focus:ring-2 focus:ring-[#0E3D4D]/20 focus:border-[#0E3D4D] font-lora-read leading-relaxed"
                />
              </div>

              {/* Botão Finalizar Estudo com Destaque e Sem Quebras Indesejadas */}
              <button
                type="button"
                disabled={sincronizando}
                onClick={() => void handleFinalizarEstudo()}
                className="w-full h-14 bg-[#0E3D4D] text-white font-bold text-sm sm:text-base rounded-2xl shadow-md hover:bg-[#17607A] active:scale-[0.99] transition-all disabled:opacity-50 min-h-[44px] flex items-center justify-center gap-2"
              >
                {sincronizando ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Confirmando no Servidor...</span>
                  </>
                ) : (
                  <span>Finalizar Estudo e Iniciar Pausa</span>
                )}
              </button>
            </section>
          )}

          {/* ETAPA 5: PAUSA / INTERVALO OBRIGATÓRIO (Apresentação Acolhedora) */}
          {isPausa && (
            <section className="bg-white border border-[#EAE3D5] rounded-3xl p-6 sm:p-8 shadow-sm space-y-6">
              <div className="border-b border-[#F1EFEA] pb-4 text-center">
                <span className="text-xs font-bold text-[#B5502B] uppercase tracking-wider px-3.5 py-1 rounded-full bg-amber-50 border border-amber-200 inline-block mb-2">
                  Intervalo de Recuperação Cognitiva
                </span>
                <h2 className="text-xl sm:text-2xl font-bold text-[#0E3D4D] font-lora-read">
                  Orientações de Descanso
                </h2>
                <p className="text-xs sm:text-sm text-[#6A7D87] mt-1 font-medium">
                  A pausa estruturada consolida sinapses e restaura o foco para os próximos blocos do ciclo.
                </p>
              </div>

              {/* Citação Inspiradora e Acolhedora */}
              <div className="bg-[#FBF8F3] border border-[#EAE3D5] rounded-2xl p-5 sm:p-6 text-center">
                <p className="font-lora-read text-[#1B2A33] text-sm sm:text-base leading-relaxed italic">
                  &ldquo;Aproveite este intervalo de 10 minutos para desviar os
                  olhos das telas, caminhar e alongar-se brevemente. Mantenha-se
                  hidratado.&rdquo;
                </p>
              </div>

              {/* Pilares Ergonômicos do Descanso */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                <div className="border border-[#EAE3D5] rounded-2xl p-4 bg-white text-center">
                  <div className="w-8 h-8 rounded-full bg-[#17607A]/10 text-[#0E3D4D] font-bold text-xs flex items-center justify-center mx-auto mb-2">
                    1
                  </div>
                  <h3 className="text-xs font-bold text-[#0E3D4D] mb-1">
                    Desvio de Foco
                  </h3>
                  <p className="text-[11px] text-[#6A7D87] leading-relaxed">
                    Olhe para um ponto distante pela janela para relaxar a musculatura ocular.
                  </p>
                </div>
                <div className="border border-[#EAE3D5] rounded-2xl p-4 bg-white text-center">
                  <div className="w-8 h-8 rounded-full bg-[#17607A]/10 text-[#0E3D4D] font-bold text-xs flex items-center justify-center mx-auto mb-2">
                    2
                  </div>
                  <h3 className="text-xs font-bold text-[#0E3D4D] mb-1">
                    Hidratação
                  </h3>
                  <p className="text-[11px] text-[#6A7D87] leading-relaxed">
                    Beba água fresca e realize alongamento suave de pescoço e ombros.
                  </p>
                </div>
                <div className="border border-[#EAE3D5] rounded-2xl p-4 bg-white text-center">
                  <div className="w-8 h-8 rounded-full bg-[#17607A]/10 text-[#0E3D4D] font-bold text-xs flex items-center justify-center mx-auto mb-2">
                    3
                  </div>
                  <h3 className="text-xs font-bold text-[#0E3D4D] mb-1">
                    Zero Redes Sociais
                  </h3>
                  <p className="text-[11px] text-[#6A7D87] leading-relaxed">
                    Evite notificações de celular para não sobrecarregar sua memória de trabalho.
                  </p>
                </div>
              </div>

              {/* Botão de Retorno / Pular Pausa */}
              <div className="pt-2 border-t border-[#F1EFEA] flex flex-col sm:flex-row items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={limparCronometroERedirecionar}
                  className="w-full sm:w-auto px-8 h-12 border border-[#D5CBB8] text-[#1B2A33] font-bold text-xs sm:text-sm rounded-xl bg-white hover:bg-[#FBF8F3] active:scale-95 transition-all min-h-[44px] shadow-sm flex items-center justify-center gap-2"
                >
                  <span>Pular Pausa e Voltar</span>
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
