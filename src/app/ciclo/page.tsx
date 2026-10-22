import { obterCicloAtivo } from '../actions/ciclo';
import CicloPage from '../../components/CicloPage';
import NavBar from '../../components/NavBar';

export const dynamic = 'force-dynamic';

export default async function CicloRoute() {
  let cicloAtivoData = null;
  let erroSincronizacao = '';

  try {
    cicloAtivoData = await obterCicloAtivo();
  } catch (error) {
    erroSincronizacao =
      error instanceof Error
        ? error.message
        : 'Não foi possível sincronizar o ciclo ativo com o servidor.';
  }

  return (
    <main className="flex-1 pl-16 md:pl-64">
      <CicloPage
        dadosIniciais={cicloAtivoData}
        erroSincronizacaoInicial={erroSincronizacao}
      />
      <NavBar />
    </main>
  );
}
