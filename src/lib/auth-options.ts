import type { AuthOptions, User } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { perfis } from '../db/schema';

type Papel = typeof perfis.$inferSelect.papel;
type UserWithRole = User & { role: Papel };
type SessionUserWithAuthorization = {
  id?: string;
  role?: Papel;
};

const INVALID_CREDENTIALS_MESSAGE = 'Credenciais inválidas.';

function isPapel(value: unknown): value is Papel {
  return value === 'estudante' || value === 'responsavel';
}

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
          throw new Error(INVALID_CREDENTIALS_MESSAGE);
        }

        const [perfil] = await db
          .select()
          .from(perfis)
          .where(eq(perfis.email, credentials.email))
          .limit(1);

        if (!perfil?.passwordHash) {
          throw new Error(INVALID_CREDENTIALS_MESSAGE);
        }

        const senhaValida = await bcrypt.compare(credentials.password, perfil.passwordHash);
        if (!senhaValida) {
          throw new Error(INVALID_CREDENTIALS_MESSAGE);
        }

        return {
          id: perfil.id,
          name: perfil.nome,
          email: perfil.email,
          role: perfil.papel
        } satisfies UserWithRole;
      }
    })
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const role = (user as UserWithRole).role;
        if (isPapel(role)) {
          token.role = role;
        }
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const sessionUser = session.user as typeof session.user & SessionUserWithAuthorization;
        if (typeof token.id === 'string') {
          sessionUser.id = token.id;
        }
        if (isPapel(token.role)) {
          sessionUser.role = token.role;
        }
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
    maxAge: 30 * 24 * 60 * 60
  },
  secret: process.env.NEXTAUTH_SECRET
};
