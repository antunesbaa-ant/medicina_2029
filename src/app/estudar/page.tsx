import { Suspense } from 'react';
import CronometroPage from '../../components/CronometroPage';

export const dynamic = 'force-dynamic';

export default function EstudarPage() {
  return (
    <main className="flex-1 bg-transparent pl-16 md:pl-64">
      <Suspense fallback={
        <div className="flex flex-col items-center justify-center min-h-screen bg-transparent">
          <div className="w-8 h-8 border-4 border-[#0E3D4D] border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs font-semibold text-[#0E3D4D] mt-3">Carregando cronômetro...</p>
        </div>
      }>
        <CronometroPage />
      </Suspense>
    </main>
  );
}
