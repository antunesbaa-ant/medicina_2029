import { obterCicloAtivo, obterProgressoSemanalCiclo } from './actions/ciclo';
import { obterMetricasDashboard } from './actions/dashboard';
import HojePage from '../components/HojePage';
import NavBar from '../components/NavBar';
import { redirect } from 'next/navigation';
import { requireAuthenticatedProfile } from '../lib/authorization';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const perfil = await requireAuthenticatedProfile();
  if (perfil.papel === 'responsavel') {
    redirect('/responsavel');
  }

  let cicloAtivoData = null;
  let progressoSemanalData = null;
  let erroSincronizacao = '';

  try {
    [cicloAtivoData, progressoSemanalData] = await Promise.all([
      obterCicloAtivo(),
      obterProgressoSemanalCiclo(),
    ]);
  } catch (error) {
    erroSincronizacao =
      error instanceof Error
        ? error.message
        : 'Não foi possível sincronizar o estado do ciclo com o servidor.';
  }

  let metricasData = null;
  try {
    metricasData = await obterMetricasDashboard();
  } catch {
    metricasData = null;
  }

  return (
    <main className="flex-1 pl-16 md:pl-64">
      <HojePage
        dadosIniciais={cicloAtivoData}
        metricasIniciais={metricasData}
        progressoSemanalInicial={progressoSemanalData}
        erroSincronizacaoInicial={erroSincronizacao}
      />
      <NavBar />
    </main>
  );
}
