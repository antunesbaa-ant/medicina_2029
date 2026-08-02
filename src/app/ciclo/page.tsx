import { obterCicloAtivo } from '../actions/ciclo';
import CicloPage from '../../components/CicloPage';
import NavBar from '../../components/NavBar';

export const dynamic = 'force-dynamic';

export default async function CicloRoute() {
  const cicloAtivoData = await obterCicloAtivo();

  return (
    <main className="flex-1 pl-16 md:pl-64">
      <CicloPage dadosIniciais={cicloAtivoData} />
      <NavBar />
    </main>
  );
}
