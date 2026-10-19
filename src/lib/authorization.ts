import { getServerSession, type Session } from 'next-auth';
import { and, eq } from 'drizzle-orm';
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

  try {
    const [perfil] = await db
      .select(authorizedProfileSelection)
      .from(perfis)
      .where(eq(perfis.id, perfilId))
      .limit(1);

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
