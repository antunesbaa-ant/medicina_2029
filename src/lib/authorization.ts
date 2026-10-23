import { getServerSession, type Session } from 'next-auth';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { perfis, responsavelEstudante } from '../db/schema';
import { authOptions } from './auth-options';

export type Papel = typeof perfis.$inferSelect.papel;

export interface AuthorizedProfile {
  id: string;
  nome: string;
  email: string | null;
  papel: Papel;
}

export type AuthorizationErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN';

const AUTHORIZATION_MESSAGES: Record<AuthorizationErrorCode, string> = {
  UNAUTHENTICATED: 'Autenticação necessária.',
  FORBIDDEN: 'Acesso não autorizado.'
};

export class AuthorizationError extends Error {
  readonly code: AuthorizationErrorCode;

  constructor(code: AuthorizationErrorCode) {
    super(AUTHORIZATION_MESSAGES[code]);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

const authorizedProfileSelection = {
  id: perfis.id,
  nome: perfis.nome,
  email: perfis.email,
  papel: perfis.papel
};

function sessionProfileId(session: Session | null): string | null {
  const user = session?.user as (Session['user'] & { id?: unknown }) | undefined;
  return typeof user?.id === 'string' && user.id.length > 0 ? user.id : null;
}

function sessionProfileRole(session: Session | null): Papel | null {
  const user = session?.user as (Session['user'] & { role?: unknown }) | undefined;
  return user?.role === 'estudante' || user?.role === 'responsavel' ? user.role : null;
}

export async function requireAuthenticatedProfile(): Promise<AuthorizedProfile> {
  let session: Session | null;

  try {
    session = await getServerSession(authOptions);
  } catch {
    throw new AuthorizationError('UNAUTHENTICATED');
  }

  const perfilId = sessionProfileId(session);
  if (!perfilId) {
    throw new AuthorizationError('UNAUTHENTICATED');
  }

  const sessionRole = sessionProfileRole(session);
  let perfil: AuthorizedProfile | undefined;

  try {
    // 1. Consulta direta eficiente sem sobrecarga transacional
    const [row] = await db
      .select(authorizedProfileSelection)
      .from(perfis)
      .where(eq(perfis.id, perfilId))
      .limit(1);
    perfil = row;

    // 2. Se não retornou linhas (ex: ambiente com FORCE RLS sob medicina_app),
    // estabelece contexto RLS transacional derivado estritamente da sessão NextAuth
    if (!perfil && sessionRole) {
      try {
        perfil = await db.transaction(async (tx) => {
          const check = await tx.execute(
            sql`SELECT to_regprocedure('medicina.set_context(uuid, text)') IS NOT NULL AS exists;`
          );
          const rows = Array.isArray(check) ? check : (check as { rows?: unknown[] })?.rows ?? [];
          const firstRow = rows[0] as Record<string, unknown> | undefined;
          const hasFn = Boolean(firstRow?.exists);
          if (hasFn) {
            await tx.execute(sql`SELECT medicina.set_context(${perfilId}::uuid, ${sessionRole}::text);`);
          }

          const [rlsRow] = await tx
            .select(authorizedProfileSelection)
            .from(perfis)
            .where(eq(perfis.id, perfilId))
            .limit(1);
          return rlsRow;
        });
      } catch {
        // Fallback defensivo
      }
    }

    if (!perfil) {
      throw new AuthorizationError('UNAUTHENTICATED');
    }

    return perfil;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw error;
    }
    throw new AuthorizationError('UNAUTHENTICATED');
  }
}

export async function requireRole(role: Papel): Promise<AuthorizedProfile> {
  const perfil = await requireAuthenticatedProfile();
  if (perfil.papel !== role) {
    throw new AuthorizationError('FORBIDDEN');
  }
  return perfil;
}

export function assertOwnership(expectedId: string, actualId: string): void {
  if (!expectedId || !actualId || expectedId !== actualId) {
    throw new AuthorizationError('FORBIDDEN');
  }
}

async function loadManagedStudentProfile(responsavelId: string): Promise<AuthorizedProfile> {
  try {
    const estudantes = await db
      .select(authorizedProfileSelection)
      .from(responsavelEstudante)
      .innerJoin(perfis, eq(responsavelEstudante.estudantePerfilId, perfis.id))
      .where(and(
        eq(responsavelEstudante.responsavelPerfilId, responsavelId),
        eq(perfis.papel, 'estudante')
      ))
      .limit(2);

    if (estudantes.length !== 1) {
      throw new AuthorizationError('FORBIDDEN');
    }

    return estudantes[0];
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw error;
    }
    throw new AuthorizationError('FORBIDDEN');
  }
}

export async function requireManagedStudentProfile(): Promise<AuthorizedProfile> {
  const responsavel = await requireRole('responsavel');
  return loadManagedStudentProfile(responsavel.id);
}

export async function requireStudentScope(): Promise<AuthorizedProfile> {
  const perfil = await requireAuthenticatedProfile();

  if (perfil.papel === 'estudante') {
    return perfil;
  }

  if (perfil.papel === 'responsavel') {
    return loadManagedStudentProfile(perfil.id);
  }

  throw new AuthorizationError('FORBIDDEN');
}
