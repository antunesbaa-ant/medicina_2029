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

export class RlsContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RlsContextError';
  }
}

/**
 * Determina se o ambiente exige compulsoriamente a aplicação de políticas RLS.
 * Precedência:
 * 1. Variáveis de ambiente explícitas RLS_ENFORCED ou ENFORCE_RLS ('true'/'1').
 * 2. Ambiente de produção em tempo de execução (NODE_ENV === 'production' fora da fase de build).
 */
export function isRlsEnforced(): boolean {
  if (
    process.env.RLS_ENFORCED === 'true' ||
    process.env.ENFORCE_RLS === 'true' ||
    process.env.RLS_ENFORCED === '1'
  ) {
    return true;
  }
  if (process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
    return true;
  }
  return false;
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
    // c) Executa SET LOCAL transacional via helper defensivo
    await applyRlsContext(tx, perfil.id, perfil.papel);

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
    await applyRlsContext(tx, perfil.id, perfil.papel);

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
    await applyRlsContext(tx, perfil.id, perfil.papel);

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
 *
 * Em conformidade com a diretriz H0.01:
 * - Em ambientes configurados para RLS (isRlsEnforced() === true ou role medicina_app),
 *   a ausência da procedure medicina.set_context lança erro explícito (RlsContextError),
 *   eliminando integralmente o fallback silencioso.
 */
export async function applyRlsContext(
  tx: DrizzleTransaction,
  perfilId: string,
  papel: string
): Promise<void> {
  if (!perfilId || typeof perfilId !== 'string') {
    throw new RlsContextError('RLS Context Error: perfilId é obrigatório e deve ser uma string UUID válida.');
  }
  if (papel !== 'estudante' && papel !== 'responsavel') {
    throw new RlsContextError(`RLS Context Error: papel inválido "${papel}". Esperado "estudante" ou "responsavel".`);
  }

  const rlsMandatorio = isRlsEnforced();

  if (typeof (tx as unknown as { execute?: unknown }).execute === 'function') {
    const executor = tx as unknown as { execute: (q: unknown) => Promise<unknown> };

    try {
      const checkResult = await executor.execute(
        sql`SELECT
              to_regprocedure('medicina.set_context(uuid, text)') IS NOT NULL AS exists,
              current_user AS curr_role;`
      );
      const rows = Array.isArray(checkResult)
        ? checkResult
        : (checkResult as { rows?: unknown[] })?.rows ?? [];
      const firstRow = rows[0] as Record<string, unknown> | undefined;
      const hasSetContext = Boolean(firstRow?.exists === true || firstRow?.exists === 't');
      const isMedicinaAppRole = firstRow?.curr_role === 'medicina_app';

      if (!hasSetContext) {
        if (rlsMandatorio || isMedicinaAppRole) {
          throw new RlsContextError(
            'RLS Fatal Error: medicina.set_context não está disponível no banco de dados. Execução abortada por princípio fail-closed.'
          );
        }
        return;
      }

      await tx.execute(sql`SELECT medicina.set_context(${perfilId}::uuid, ${papel}::text);`);
    } catch (err: unknown) {
      if (err instanceof RlsContextError) {
        throw err;
      }

      const errMsg = err instanceof Error ? err.message : String(err ?? '');
      if (rlsMandatorio) {
        throw new RlsContextError(`RLS Fatal Error ao ativar contexto de segurança: ${errMsg}`);
      }

      if (/to_regprocedure/i.test(errMsg)) {
        return;
      }
      throw err;
    }
  } else if (rlsMandatorio) {
    throw new RlsContextError('RLS Context Error: tx.execute indisponível em transação sob ambiente RLS obrigatório.');
  }
}

/**
 * Envelopa consultas essenciais de leitura sob transação com contexto RLS do usuário autenticado.
 */
export async function withAuthenticatedRead<T>(
  callback: (ctx: AuthenticatedContext) => Promise<T>
): Promise<T> {
  return await withAuthenticatedUser(callback);
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
    throw new RlsContextError('RLS Context Error: perfilId é obrigatório e deve ser uma string UUID válida.');
  }
  if (papel !== 'estudante' && papel !== 'responsavel') {
    throw new RlsContextError(`RLS Context Error: papel inválido "${papel}". Esperado "estudante" ou "responsavel".`);
  }

  return await db.transaction(async (tx) => {
    await applyRlsContext(tx, perfilId, papel);

    try {
      return await callback(tx);
    } finally {
      try {
        await tx.execute(sql`SELECT medicina.clear_context();`);
      } catch {}
    }
  });
}
