import DashboardPage from '../../components/DashboardPage';
import NavBar from '../../components/NavBar';

export const dynamic = 'force-dynamic';

export default async function Page() {
  return (
    <main className="flex-1 bg-[#FBF8F3] pl-16 md:pl-64">
      <DashboardPage />
      <NavBar />
    </main>
  );
}
