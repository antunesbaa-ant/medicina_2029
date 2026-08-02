import AcervoPage from '../../components/AcervoPage';
import NavBar from '../../components/NavBar';
import { getServerSession } from 'next-auth';
import { authOptions } from '../api/auth/[...nextauth]/route';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const session = await getServerSession(authOptions);
  
  if ((session?.user as any)?.role !== 'responsavel') {
    redirect('/');
  }

  return (
    <main className="flex-1 pl-16 md:pl-64">
      <AcervoPage />
      <NavBar />
    </main>
  );
}
