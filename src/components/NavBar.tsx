'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';

export default function NavBar() {
  const pathname = usePathname();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [mounted, setMounted] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [dataHoje, setDataHoje] = useState<string>('');
  const { data: session } = useSession();
  
  const userName = session?.user?.name || 'Estudante';
  const userRole = (session?.user as any)?.role || 'estudante';
  
  const iniciais = userName
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0])
    .join('')
    .substring(0, 2)
    .toUpperCase() || 'U';

  useEffect(() => {
    const date = new Date();
    setDataHoje(date.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }));

    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null;
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const activeTheme = savedTheme || systemTheme;
    
    setTheme(activeTheme);
    if (activeTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    setMounted(true);

    // Initial resize check
    if (window.innerWidth < 768) {
      setIsCollapsed(true);
    }
    
    const handleResize = () => {
      if (window.innerWidth < 768) {
        setIsCollapsed(true);
      } else {
        setIsCollapsed(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (isCollapsed) {
      document.body.classList.add('sidebar-collapsed');
      document.body.classList.remove('sidebar-expanded');
    } else {
      document.body.classList.add('sidebar-expanded');
      document.body.classList.remove('sidebar-collapsed');
    }
  }, [isCollapsed]);

  const toggleTheme = () => {
    const nextTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(nextTheme);
    localStorage.setItem('theme', nextTheme);
    if (nextTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };

  const navItems = [
    {
      label: 'Dashboard',
      path: '/',
      icon: (active: boolean) => (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke={active ? '#FFFFFF' : '#6A7D87'}
          className="w-5 h-5 transition-colors"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v5.25c0 .621-.504 1.125-1.125 1.125h-2.25A1.125 1.125 0 013 18.375v-5.25zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125v-9.75zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v14.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
          />
        </svg>
      ),
    },
    {
      label: 'Estudar',
      path: '/estudar',
      icon: (active: boolean) => (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke={active ? '#FFFFFF' : '#6A7D87'}
          className="w-5 h-5 transition-colors"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      ),
    },
    {
      label: 'Ciclo',
      path: '/ciclo',
      icon: (active: boolean) => (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke={active ? '#FFFFFF' : '#6A7D87'}
          className="w-5 h-5 transition-colors"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5"
          />
        </svg>
      ),
    },
    {
      label: 'Redação',
      path: '/redacoes',
      icon: (active: boolean) => (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke={active ? '#FFFFFF' : '#6A7D87'}
          className="w-5 h-5 transition-colors"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
          />
        </svg>
      ),
    },
    {
      label: 'Acervo',
      path: '/acervo',
      icon: (active: boolean) => (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke={active ? '#FFFFFF' : '#6A7D87'}
          className="w-5 h-5 transition-colors"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-19.5 0A2.25 2.25 0 003 15v3a2.25 2.25 0 002.25 2.25h13.5A2.25 2.25 0 0021 18v-3a2.25 2.25 0 00-2.25-2.25m-16.5 0h16.5"
          />
        </svg>
      ),
    },
    {
      label: 'Busca',
      path: '/busca',
      icon: (active: boolean) => (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke={active ? '#FFFFFF' : '#6A7D87'}
          className="w-5 h-5 transition-colors"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.602 10.602z"
          />
        </svg>
      ),
    },
    {
      label: 'Curadoria',
      path: '/curadoria',
      icon: (active: boolean) => (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke={active ? '#FFFFFF' : '#6A7D87'}
          className="w-5 h-5 transition-colors"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      ),
    },
    {
      label: 'Responsável',
      path: '/responsavel',
      icon: (active: boolean) => (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke={active ? '#FFFFFF' : '#6A7D87'}
          className="w-5 h-5 transition-colors"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m0 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 000 16.251a6 6 0 006 2.47m0-2.47a5.97 5.97 0 001.637-4.07c0-3.314 2.686-6 6-6s6 2.686 6 6a5.97 5.97 0 00-1.636 4.07m-3.274-8.14a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      ),
    },
    {
      label: 'Lacunas',
      path: '/lacunas',
      icon: (active: boolean) => (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke={active ? '#FFFFFF' : '#6A7D87'}
          className="w-5 h-5 transition-colors"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
          />
        </svg>
      ),
    },
    {
      label: 'Erros',
      path: '/caderno-erros',
      icon: (active: boolean) => (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke={active ? '#FFFFFF' : '#6A7D87'}
          className="w-5 h-5 transition-colors"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125"
          />
        </svg>
      ),
    },
    {
      label: 'Provas',
      path: '/simulados',
      icon: (active: boolean) => (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke={active ? '#FFFFFF' : '#6A7D87'}
          className="w-5 h-5 transition-colors"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12h3.75M9 15h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-.621-.504-1.125-1.125-1.125H9.75M8.25 21h8.25c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H8.25c-.621 0-1.125.504-1.125 1.125v14.25c0 .621.504 1.125 1.125 1.125z"
          />
        </svg>
      ),
    },
  ].filter(item => {
    if (['/acervo', '/curadoria', '/responsavel'].includes(item.path)) {
      return userRole === 'responsavel';
    }
    return true;
  });

  return (
    <nav className={`fixed top-0 left-0 bottom-0 z-40 bg-[#FBF8F3] dark:bg-[#0A1114] border-r border-[#EAE3D5] dark:border-[#1E2C33] shadow-lg flex flex-col justify-between transition-all duration-300 py-6 ${isCollapsed ? 'w-16' : 'w-64'}`}>
      
      {/* Brand Header */}
      <div className="px-3 md:px-6">
        <div className="flex items-center gap-3 select-none">
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="w-10 h-10 rounded-xl bg-[#0E3D4D] flex items-center justify-center shadow-md shadow-[#0E3D4D]/25 transition-all duration-300 hover:scale-105 active:scale-95 cursor-pointer shrink-0"
            title={isCollapsed ? "Expandir menu" : "Recolher menu"}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2.5}
              stroke="#FFFFFF"
              className={`w-6 h-6 transition-transform duration-300 ${isCollapsed ? '' : 'rotate-180'}`}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.5 12h15m0 0l-6.75-6.75M19.5 12l-6.75 6.75"
              />
            </svg>
          </button>
          {!isCollapsed && (
            <Link href="/" className="block truncate">
              <h1 className="text-base font-bold font-['Lora'] text-[#0E3D4D] dark:text-white leading-none">Medicina</h1>
              <div className="flex flex-col mt-0.5">
                <span className="text-[10px] font-semibold text-[#B5502B] uppercase tracking-wider leading-none">Ciclo 2029</span>
                <span className="text-[9px] text-[#6A7D87] dark:text-gray-400 mt-1 font-semibold leading-none">{dataHoje}</span>
              </div>
            </Link>
          )}
        </div>
        <div className="h-[1px] bg-[#EAE3D5] dark:bg-[#1E2C33] my-6" />
      </div>

      {/* Nav List */}
      <div className="flex-1 px-2 md:px-4 space-y-1.5 overflow-y-auto pr-1">
        {navItems.map((item) => {
          const isActive = pathname === item.path;
          return (
            <Link
              key={item.path}
              href={item.path}
              className={`flex items-center gap-3 px-3 py-3 md:py-2.5 rounded-xl transition-all duration-200 group relative min-h-[44px] ${
                isActive 
                  ? 'bg-[#0E3D4D] text-white shadow-md shadow-[#0E3D4D]/15' 
                  : 'text-[#6A7D87] dark:text-gray-400 hover:bg-[#F1EFEA] dark:hover:bg-[#15222B] hover:text-[#0E3D4D] dark:hover:text-white'
              }`}
            >
              <div className="flex items-center justify-center w-6 h-6 shrink-0">
                {item.icon(isActive)}
              </div>
              <span
                className={`text-xs font-semibold tracking-wide transition-colors ${
                  isCollapsed ? 'hidden' : 'block'
                } ${
                  isActive ? 'text-white font-bold' : 'text-[#6A7D87] dark:text-gray-400 group-hover:text-[#0E3D4D] dark:group-hover:text-white'
                }`}
              >
                {item.label}
              </span>
              
              {/* Tooltip when collapsed */}
              <div className={`absolute left-full ml-4 px-2.5 py-1.5 bg-[#0E3D4D] text-white text-[10px] font-bold rounded-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 whitespace-nowrap z-50 shadow-md pointer-events-none ${
                isCollapsed ? '' : 'hidden'
              }`}>
                {item.label}
              </div>
            </Link>
          );
        })}
      </div>

      {/* Footer Profile Info */}
      <div className="px-3 md:px-6 mt-auto">
        <div className={`flex ${isCollapsed ? 'flex-col' : 'flex-row'} gap-2 mb-2 relative`}>
          {/* Theme Button */}
          <div className="flex-1 relative group/theme">
            <button
              onClick={toggleTheme}
              className={`flex items-center justify-center rounded-xl border border-[#EAE3D5] bg-[#F1EFEA] dark:border-[#1E2C33] dark:bg-[#15222B] text-[#6A7D87] hover:text-[#0E3D4D] dark:text-gray-400 dark:hover:text-white transition-all cursor-pointer shadow-sm hover:scale-[1.02] active:scale-[0.98] min-h-[40px] w-full px-3 py-2`}
              title="Alternar tema"
            >
              {!mounted ? (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
                  </svg>
                  {!isCollapsed && <span className="text-xs font-semibold ml-2">Escuro</span>}
                </>
              ) : theme === 'dark' ? (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-amber-500">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                  </svg>
                  {!isCollapsed && <span className="text-xs font-semibold ml-2">Claro</span>}
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-[#0E3D4D]">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
                  </svg>
                  {!isCollapsed && <span className="text-xs font-semibold ml-2">Escuro</span>}
                </>
              )}
            </button>
            {isCollapsed && (
              <div className="absolute left-full top-0 ml-4 px-2.5 py-1.5 bg-[#0E3D4D] text-white text-[10px] font-bold rounded-lg opacity-0 invisible group-hover/theme:opacity-100 group-hover/theme:visible transition-all duration-200 whitespace-nowrap z-50 shadow-md pointer-events-none">
                Alternar tema
              </div>
            )}
          </div>

          {/* Sair Button */}
          <div className="relative group/logout">
            <button
              onClick={() => signOut({ callbackUrl: '/login' })}
              className={`flex items-center justify-center rounded-xl border border-[#EAE3D5] bg-[#F1EFEA] dark:border-[#1E2C33] dark:bg-[#15222B] text-[#6A7D87] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 transition-all cursor-pointer shadow-sm hover:scale-[1.02] active:scale-[0.98] min-h-[40px] ${
                isCollapsed ? 'w-10 h-10' : 'px-3 py-2'
              }`}
              title="Sair do sistema"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75"
                />
              </svg>
              {!isCollapsed && <span className="text-xs font-semibold ml-2">Sair</span>}
            </button>
            {isCollapsed && (
              <div className="absolute left-full top-0 ml-4 px-2.5 py-1.5 bg-[#0E3D4D] text-white text-[10px] font-bold rounded-lg opacity-0 invisible group-hover/logout:opacity-100 group-hover/logout:visible transition-all duration-200 whitespace-nowrap z-50 shadow-md pointer-events-none">
                Sair do sistema
              </div>
            )}
          </div>
        </div>

        <div className="h-[1px] bg-[#EAE3D5] dark:bg-[#1E2C33] my-4" />
        
        {/* Profile Avatar and Name */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#B5502B]/10 border border-[#B5502B]/30 flex items-center justify-center font-bold text-xs text-[#B5502B] uppercase shadow-inner shrink-0" title={userName}>
            {iniciais}
          </div>
          {!isCollapsed && (
            <div className="truncate">
              <h4 className="text-xs font-bold text-[#0E3D4D] dark:text-white truncate leading-snug">{userName}</h4>
              <span className="text-[10px] text-gray-400 block truncate uppercase tracking-wider font-semibold">
                {userRole === 'responsavel' ? 'Responsável' : 'Estudante'}
              </span>
            </div>
          )}
        </div>
      </div>

    </nav>
  );
}
