import { withAuth } from 'next-auth/middleware';

export default withAuth({
  pages: {
    signIn: '/login',
  },
});

export const config = {
  matcher: [
    // Protege todas as rotas do app, exceto login, chamadas de autenticação de API e arquivos estáticos
    '/((?!api/auth|login|_next/static|_next/image|favicon.ico|manifest.json|window.svg|file.svg|globe.svg|vercel.svg|next.svg|pencil_.*).*)',
  ],
};
