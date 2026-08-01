import { obterCicloAtivo } from './actions/ciclo';
import HojePage from '../components/HojePage';
import NavBar from '../components/NavBar';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const cicloAtivoData = await obterCicloAtivo();

  return (
    <main className="flex-1 bg-[#FBF8F3] pl-16 md:pl-64">
      <HojePage dadosIniciais={cicloAtivoData} />
      <NavBar />
    </main>
  );
}
