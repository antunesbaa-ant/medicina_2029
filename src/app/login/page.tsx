'use client';

import { useState, Suspense } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const errorType = searchParams.get('error');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErro(null);

    try {
      const res = await signIn('credentials', {
        email,
        password,
        redirect: false,
      });

      if (res?.error) {
        setErro(res.error === 'CredentialsSignin' ? 'E-mail ou senha incorretos.' : res.error);
      } else {
        router.push('/');
        router.refresh();
      }
    } catch (err: any) {
      setErro('Ocorreu um erro ao tentar fazer login. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {erro && (
        <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-600 text-xs font-semibold leading-relaxed">
          ⚠️ {erro}
        </div>
      )}

      {errorType && !erro && (
        <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-600 text-xs font-semibold leading-relaxed">
          ⚠️ Acesso negado. Por favor, faça login com um e-mail cadastrado.
        </div>
      )}

      <div>
        <label className="block text-xs font-bold text-[#0E3D4D] mb-1.5 uppercase tracking-wide">
          E-mail
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="exemplo@medicina2029.com.br"
          className="w-full h-11 px-3 bg-[#FBF8F3] border border-[#D5CBB8] rounded-xl text-sm font-medium text-[#1B2A33] focus:outline-none focus:ring-1 focus:ring-[#0E3D4D]"
        />
      </div>

      <div>
        <label className="block text-xs font-bold text-[#0E3D4D] mb-1.5 uppercase tracking-wide">
          Senha
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          placeholder="••••••••"
          className="w-full h-11 px-3 bg-[#FBF8F3] border border-[#D5CBB8] rounded-xl text-sm font-medium text-[#1B2A33] focus:outline-none focus:ring-1 focus:ring-[#0E3D4D]"
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full h-11 mt-2 bg-[#0E3D4D] hover:bg-[#17607A] text-white font-bold text-sm rounded-xl transition-all shadow-md shadow-[#0E3D4D]/15 active:scale-[0.98] cursor-pointer flex items-center justify-center disabled:opacity-50"
      >
        {loading ? (
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
        ) : (
          'Entrar no Sistema'
        )}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#FBF8F3] px-4 font-poppins">
      <div className="w-full max-w-md rounded-2xl border border-[#EAE3D5] bg-white p-8 shadow-xl shadow-[#0E3D4D]/5 transition-all">
        {/* Brand Header */}
        <div className="text-center mb-8">
          <div className="inline-flex w-12 h-12 rounded-2xl bg-[#0E3D4D] items-center justify-center shadow-md shadow-[#0E3D4D]/25 mb-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2.5}
              stroke="#FFFFFF"
              className="w-6 h-6"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.5 12h15m0 0l-6.75-6.75M19.5 12l-6.75 6.75"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-bold font-lora-read text-[#0E3D4D]">Medicina 2029</h1>
          <p className="text-xs text-[#6A7D87] mt-1 font-semibold uppercase tracking-wider">
            Acesso ao Sistema de Estudos
          </p>
        </div>

        {/* Formulário com Suspense */}
        <Suspense fallback={
          <div className="flex flex-col items-center justify-center py-8">
            <div className="w-8 h-8 border-4 border-[#0E3D4D] border-t-transparent rounded-full animate-spin"></div>
            <p className="text-xs font-semibold text-[#0E3D4D] mt-3">Carregando formulário...</p>
          </div>
        }>
          <LoginForm />
        </Suspense>

        {/* Footer info */}
        <div className="text-center mt-6 pt-6 border-t border-[#EAE3D5] text-[10px] text-[#6A7D87] font-medium leading-relaxed">
          Sistema de Gestão de Estudos Privado.<br />
          Caso não consiga acessar, contate o responsável.
        </div>
      </div>
    </main>
  );
}
