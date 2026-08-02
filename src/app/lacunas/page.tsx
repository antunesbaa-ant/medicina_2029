import LacunasPage from '../../components/LacunasPage';
import NavBar from '../../components/NavBar';

export const dynamic = 'force-dynamic';

export default async function Page() {
  return (
    <main className="flex-1 pl-16 md:pl-64">
      <LacunasPage />
      <NavBar />
    </main>
  );
}
