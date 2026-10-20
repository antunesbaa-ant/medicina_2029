import { sql } from 'drizzle-orm';
import { db } from './index';

export type Papel = 'estudante' | 'responsavel';

export interface RlsContextOptions {
  perfilId: string;
  papel: Papel;
}

/**
 * Executa uma operação no banco de dados sob o contexto de segurança RLS (PostgreSQL).
 *
 * Propriedades de Segurança:
 * 1. Abre transação dedicada com o cliente Drizzle.
 * 2. Emite `medicina.set_context(perfilId, papel)`, acionando `set_config(..., is_local => true)` (SET LOCAL).
 * 3. O escopo transacional impede que a identidade contamine a pool de conexões (PgBouncer/Node.js pool).
 * 4. Garante que, ao finalizar (seja por retorno de sucesso ou exceção), `medicina.clear_context()` seja chamado
 *    e a transação seja comitada ou abortada (ROLLBACK descarta automaticamente variáveis locais).
 * 5. Se o callback tentar acessar linhas de outro usuário ou tabelas proibidas pelo papel, o PostgreSQL
 *    rejeita a operação no nível de linha (RLS) ou coluna (Column-Level Grant 42501).
 *
 * @param perfilId UUID do perfil canônico validado pela aplicação.
 * @param papel Papel canônico ('estudante' | 'responsavel').
 * @param callback Função que executa queries usando a transação `tx`.
 */
export async function withRlsContext<T>(
  perfilId: string,
  papel: Papel,
  callback: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>
): Promise<T> {
  if (!perfilId || typeof perfilId !== 'string') {
    throw new Error('RLS Context Error: perfilId é obrigatório e deve ser uma string UUID válida.');
  }
  if (papel !== 'estudante' && papel !== 'responsavel') {
    throw new Error(`RLS Context Error: papel inválido "${papel}". Esperado "estudante" ou "responsavel".`);
  }

  return await db.transaction(async (tx) => {
    // 1. Configura o contexto transacional no PostgreSQL
    await tx.execute(sql`SELECT medicina.set_context(${perfilId}::uuid, ${papel}::text);`);

    try {
      // 2. Executa a operação do chamador
      return await callback(tx);
    } finally {
      // 3. Limpeza defensiva explícita de contexto
      try {
        await tx.execute(sql`SELECT medicina.clear_context();`);
      } catch {
        // Se a transação já estiver em estado de erro (aborted), o ROLLBACK automático
        // já limpa todos os parâmetros locais de sessão.
      }
    }
  });
}
