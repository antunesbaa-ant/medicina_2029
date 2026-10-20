import type { AuthOptions, User } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { db, authDb } from '../db';
import { perfis } from '../db/schema';

type Papel = typeof perfis.$inferSelect.papel;
type UserWithRole = User & { role: Papel };
type SessionUserWithAuthorization = {
  id?: string;
  role?: Papel;
};

const INVALID_CREDENTIALS_MESSAGE = 'Credenciais inválidas.';

// Hash bcrypt de referência (custo 10) para mitigar timing side-channel attacks
// Garante tempo de resposta constante independentemente de o e-mail existir ou não na base
const TIMING_BENCHMARK_HASH = '$2a$10$7EqJtq98hPqEX7fNZaODi.Z6wKqGqD0Vq7F1eK1s8aC9w1p0X.uG6';

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

        let perfil: { id: string; nome: string; email: string | null; papel: Papel; passwordHash: string | null } | undefined;

        // Conexão de autenticação dedicada sob papel medicina_auth (quando configurada) ou db
        const targetDb = authDb || db;

        // Tentativa primária: chamada à rotina segura de autenticação (quando RLS estiver ativo no banco)
        if (typeof (targetDb as any).execute === 'function') {
          try {
            const rows = await targetDb.execute(sql`SELECT * FROM medicina.autenticar_por_email(${credentials.email}::text)`);
            if (rows && rows.length > 0) {
              const row = rows[0] as any;
              perfil = {
                id: row.id,
                nome: row.nome,
                email: row.email,
                papel: row.papel,
                passwordHash: row.password_hash
              };
            }
          } catch {
            // Se a função medicina.autenticar_por_email não existir (ambiente pré-migração),
            // segue para o fallback direto
          }
        }

        // Fallback de compatibilidade (ambiente pré-RLS onde a tabela perfis ainda permite SELECT)
        if (!perfil) {
          try {
            const [row] = await targetDb
              .select()
              .from(perfis)
              .where(eq(perfis.email, credentials.email))
              .limit(1);
            if (row) {
              perfil = {
                id: row.id,
                nome: row.nome,
                email: row.email,
                papel: row.papel,
                passwordHash: row.passwordHash
              };
            }
          } catch {
            // Em caso de erro de consulta, perfil permanece undefined
          }
        }

        // Mitigação de timing side-channel: se o usuário não for encontrado ou não tiver hash,
        // ainda assim executa o bcrypt.compare com um hash padrão de referência para uniformizar o tempo de resposta
        if (!perfil?.passwordHash) {
          await bcrypt.compare(credentials.password, TIMING_BENCHMARK_HASH);
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
