import NextAuth, { AuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { db } from '../../../../db';
import { perfis } from '../../../../db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

export const authOptions: AuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'text' },
        password: { label: 'Password', type: 'password' }
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error('E-mail e senha são obrigatórios.');
        }

        // Buscar usuário pelo e-mail
        const [perfil] = await db
          .select()
          .from(perfis)
          .where(eq(perfis.email, credentials.email))
          .limit(1);

        if (!perfil || !perfil.passwordHash) {
          throw new Error('E-mail não cadastrado ou fora da allowlist.');
        }

        // Validar senha
        const senhaValida = await bcrypt.compare(credentials.password, perfil.passwordHash);
        if (!senhaValida) {
          throw new Error('Senha incorreta.');
        }

        return {
          id: perfil.id,
          name: perfil.nome,
          email: perfil.email,
          role: perfil.papel
        };
      }
    })
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as any).role;
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).role = token.role;
        (session.user as any).id = token.id;
      }
      return session;
    }
  },
  pages: {
    signIn: '/login',
    error: '/login'
  },
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60 // 30 dias de duração da sessão
  },
  secret: process.env.NEXTAUTH_SECRET
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
