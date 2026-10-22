import { sql } from 'drizzle-orm';
import { db } from './index';
import {
  requireAuthenticatedProfile,
  requireRole,
  type AuthorizedProfile,
  type Papel
} from '../lib/authorization';

export type { AuthorizedProfile, Papel };

export type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface AuthenticatedContext {
  perfil: AuthorizedProfile;
  tx: DrizzleTransaction;
}

/**
 * Executa uma operação no banco de dados sob o contexto RLS do usuário autenticado.
 *
 * Fluxo de Segurança:
 * 1. Obtém a identidade canônica e autenticada a partir da sessão NextAuth e do banco via `requireAuthenticatedProfile()`.
 *    NENHUM ID ou papel vindo do cliente é aceito.
 * 2. Abre transação Drizzle (`db.transaction`).
 * 3. Ativa o contexto RLS no PostgreSQL via `medicina.set_context(perfil.id, perfil.papel)`.
 *    A função interna no PostgreSQL utiliza `set_config(..., is_local => true)` (SET LOCAL),
 *    garantindo que o contexto seja restrito à transação e não contamine o pool de conexões (PgBouncer).
 * 4. Invoca o callback fornecendo o perfil autorizado e o manipulador transacional `tx`.
 * 5. Em bloco `finally`, executa limpeza defensiva `medicina.clear_context()`.
 */
export async function withAuthenticatedUser<T>(
  callback: (ctx: AuthenticatedContext) => Promise<T>
): Promise<T> {
  // a) Valida a sessão NextAuth e obtém o perfil canônico
  const perfil = await requireAuthenticatedProfile();

  // b) Abre a transação Drizzle
  return await db.transaction(async (tx) => {
    // c) Executa SET LOCAL transacional
    await tx.execute(sql`SELECT medicina.set_context(${perfil.id}::uuid, ${perfil.papel}::text);`);

    try {
      // d) Invoca o callback seguro
      return await callback({ perfil, tx });
    } finally {
      // e) Limpeza defensiva explícita
      try {
        await tx.execute(sql`SELECT medicina.clear_context();`);
      } catch {
        // Se a transação já estiver abortada, o ROLLBACK automático do PostgreSQL já descarta o SET LOCAL.
      }
    }
  });
}

/**
 * Executa uma operação garantindo que o usuário possua compulsoriamente o papel 'estudante'.
 * Se o usuário não for estudante, lança AuthorizationError('FORBIDDEN') antes de abrir a transação.
 */
export async function withStudentContext<T>(
  callback: (ctx: AuthenticatedContext) => Promise<T>
): Promise<T> {
  const perfil = await requireRole('estudante');

  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT medicina.set_context(${perfil.id}::uuid, ${perfil.papel}::text);`);

    try {
      return await callback({ perfil, tx });
    } finally {
      try {
        await tx.execute(sql`SELECT medicina.clear_context();`);
      } catch {}
    }
  });
}

/**
 * Executa uma operação garantindo que o usuário possua compulsoriamente o papel 'responsavel'.
 * Se o usuário não for responsável, lança AuthorizationError('FORBIDDEN') antes de abrir a transação.
 */
export async function withResponsibleContext<T>(
  callback: (ctx: AuthenticatedContext) => Promise<T>
): Promise<T> {
  const perfil = await requireRole('responsavel');

  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT medicina.set_context(${perfil.id}::uuid, ${perfil.papel}::text);`);

    try {
      return await callback({ perfil, tx });
    } finally {
      try {
        await tx.execute(sql`SELECT medicina.clear_context();`);
      } catch {}
    }
  });
}

/**
 * Aplica o contexto RLS (SET LOCAL via medicina.set_context) a uma transação Drizzle já existente.
 * Utilizado por Server Actions que gerenciam seu próprio ciclo transacional (ex: advisory locks).
 */
export async function applyRlsContext(
  tx: DrizzleTransaction,
  perfilId: string,
  papel: string
): Promise<void> {
  if (!perfilId || typeof perfilId !== 'string') {
    throw new Error('RLS Context Error: perfilId é obrigatório e deve ser uma string UUID válida.');
  }
  if (papel !== 'estudante' && papel !== 'responsavel') {
    throw new Error(`RLS Context Error: papel inválido "${papel}". Esperado "estudante" ou "responsavel".`);
  }

  if (typeof (tx as unknown as { execute?: unknown }).execute === 'function') {
    try {
      const checkResult = await (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
        sql`SELECT to_regprocedure('medicina.set_context(uuid, text)') IS NOT NULL AS exists;`
      );
      const rows = Array.isArray(checkResult)
        ? checkResult
        : (checkResult as { rows?: unknown[] })?.rows ?? [];
      const firstRow = rows[0] as Record<string, unknown> | undefined;
      const hasSetContext = Boolean(firstRow?.exists === true || firstRow?.exists === 't');

      if (hasSetContext) {
        await tx.execute(sql`SELECT medicina.set_context(${perfilId}::uuid, ${papel}::text);`);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err ?? '');
      if (/to_regprocedure/i.test(errMsg)) {
        return;
      }
      throw err;
    }
  }
}

/**
 * Helper de baixo nível que aceita perfilId e papel explicitamente.
 * Destinado EXCLUSIVAMENTE para rotinas internas de manutenção, scripts administrativos
 * e testes de integração de RLS.
 */
export async function withRlsContext<T>(
  perfilId: string,
  papel: Papel,
  callback: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  if (!perfilId || typeof perfilId !== 'string') {
    throw new Error('RLS Context Error: perfilId é obrigatório e deve ser uma string UUID válida.');
  }
  if (papel !== 'estudante' && papel !== 'responsavel') {
    throw new Error(`RLS Context Error: papel inválido "${papel}". Esperado "estudante" ou "responsavel".`);
  }

  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT medicina.set_context(${perfilId}::uuid, ${papel}::text);`);

    try {
      return await callback(tx);
    } finally {
      try {
        await tx.execute(sql`SELECT medicina.clear_context();`);
      } catch {}
    }
  });
}
