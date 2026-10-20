import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * Resolução de URLs de conexão com separação de papéis (F1.04-C / F1.06):
 * - DATABASE_APP_URL: Conexão sob papel medicina_app (Server Actions cotidianas, sem acesso a password_hash)
 * - DATABASE_AUTH_URL: Conexão sob papel medicina_auth (NextAuth, com permissão restrita para autenticar_por_email)
 * - DATABASE_URL: Fallback geral seguro para desenvolvimento ou transição de infraestrutura
 *
 * Fallbacks hardcoded com senhas embutidas em código foram integralmente eliminados.
 */

export function resolveDatabaseAppUrl(): string {
  const url = process.env.DATABASE_APP_URL || process.env.DATABASE_URL;
  if (!url) {
    if (process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
      throw new Error('Configuração ausente: DATABASE_APP_URL ou DATABASE_URL é obrigatória em ambiente de produção.');
    }
    // String neutra para ambiente de desenvolvimento/teste/build sem senhas embutidas em código
    return 'postgres://postgres@localhost:5432/medicina_dev';
  }
  return url;
}

export function resolveDatabaseAuthUrl(): string {
  const url = process.env.DATABASE_AUTH_URL || process.env.DATABASE_URL;
  if (!url) {
    if (process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
      throw new Error('Configuração ausente: DATABASE_AUTH_URL ou DATABASE_URL é obrigatória em ambiente de produção.');
    }
    // String neutra para ambiente de desenvolvimento/teste/build sem senhas embutidas em código
    return 'postgres://postgres@localhost:5432/medicina_dev';
  }
  return url;
}

const appConnectionString = resolveDatabaseAppUrl();
export const client = postgres(appConnectionString);
export const db = drizzle(appConnectionString, { schema });

// Conexão dedicada para autenticação NextAuth (papel medicina_auth)
const authConnectionString = resolveDatabaseAuthUrl();
export const authClient = postgres(authConnectionString);
export const authDb = drizzle(authConnectionString, { schema });

export * as schema from './schema';
