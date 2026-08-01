import { obterCicloAtivo } from './actions/ciclo';
import { obterMetricasDashboard } from './actions/dashboard';
import HojePage from '../components/HojePage';
import NavBar from '../components/NavBar';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const cicloAtivoData = await obterCicloAtivo();
  const metricasData = await obterMetricasDashboard();

  return (
    <main className="flex-1 bg-[#FBF8F3] pl-16 md:pl-64">
      <HojePage dadosIniciais={cicloAtivoData} metricasIniciais={metricasData} />
      <NavBar />
    </main>
  );
}
