/**
 * MEDICINA 2029 — H1.02
 * Hook de Inicialização do Servidor Next.js (Server Startup Instrumentation)
 *
 * Executado uma única vez no boot do servidor Next.js antes do atendimento a qualquer requisição.
 * Em ambiente de staging (APP_ENV=staging), valida o isolamento estrutural fail-closed.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' || !process.env.NEXT_RUNTIME) {
    const { isStagingEnvironment, assertStagingIsolation } = await import('./lib/envGuard');
    if (isStagingEnvironment()) {
      assertStagingIsolation();
    }
  }
}
