/**
 * MEDICINA 2029 — H1.02
 * Guardião de Isolamento Fail-Closed para Ambiente de Staging (envGuard)
 *
 * Garante que o ambiente de homologação (APP_ENV=staging) opere em isolamento
 * estrito em relação à produção, validando identificadores explícitos de projeto,
 * coerência estrutural de conexões, presença de credenciais obrigatórias e
 * impedindo qualquer vazamento de segredos nos logs.
 */

export class StagingIsolationError extends Error {
  readonly code = 'STAGING_ISOLATION_VIOLATION';
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(details.length > 0 ? `${message}\n- ${details.join('\n- ')}` : message);
    this.name = 'StagingIsolationError';
    this.details = details;
  }
}

export interface StagingConfig {
  stagingProjectRef: string;
  appDatabaseUrl: string;
  authDatabaseUrl: string;
  workerDatabaseUrl: string;
  supabaseUrl: string;
  isStaging: boolean;
}

export interface StagingIsolationResult {
  valid: boolean;
  isStaging: boolean;
  errors: string[];
  sanitizedSummary: {
    stagingProjectRef?: string;
    supabaseHost?: string;
    databaseHosts: string[];
    databaseNames: string[];
  };
}

/**
 * Sanitiza uma URL de conexão ou serviço para exibição segura em logs e mensagens de erro,
 * ocultando senhas, tokens de autenticação e parâmetros de consulta sensíveis.
 */
export function sanitizeUrlForLogging(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '[vazio]';
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = '***';
    }
    // Remove eventuais tokens passados em query string
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/key|token|secret|pass|auth/i.test(key)) {
        parsed.searchParams.set(key, '***');
      }
    }
    return parsed.toString();
  } catch {
    // Se não for uma URL parseável válida, nunca expõe texto bruto que possa conter segredos
    return '[url_invalida_redigida]';
  }
}

/**
 * Extrai o identificador de projeto Supabase (subdomínio da URL ou project_ref).
 * Ex: "https://xyzref.supabase.co" -> "xyzref"
 */
export function extractSupabaseProjectRef(urlStr: string): string | null {
  try {
    const parsed = new URL(urlStr);
    const parts = parsed.hostname.split('.');
    if (parts.length >= 3 && parts.slice(1).join('.') === 'supabase.co') {
      return parts[0].toLowerCase();
    }
    // Para ambientes locais ou proxies (ex: localhost, 127.0.0.1)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return 'local-supabase';
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extrai o identificador de projeto Supabase a partir de uma URL de conexão PostgreSQL.
 * Reconhece:
 * 1. Conexão direta Supabase: db.<project-ref>.supabase.co
 * 2. Conexão pooler Supabase: *.pooler.supabase.com com username no formato <role>.<project-ref>
 * 3. Conexões locais ou efêmeras: localhost / 127.0.0.1 -> 'local-supabase'
 */
export function extractSupabaseDbProjectRef(urlStr: string): string | null {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();

    // 1. Conexão direta Supabase: db.<project-ref>.supabase.co
    if (hostname.startsWith('db.') && hostname.endsWith('.supabase.co')) {
      const parts = hostname.split('.');
      if (parts.length >= 4) {
        return parts[1].toLowerCase();
      }
    }

    // 2. Conexão via pooler Supabase: *.pooler.supabase.com com username <role>.<project-ref>
    if (hostname.endsWith('.pooler.supabase.com') || hostname === 'pooler.supabase.com') {
      const username = decodeURIComponent(parsed.username);
      const dotIndex = username.lastIndexOf('.');
      if (dotIndex > 0) {
        return username.slice(dotIndex + 1).toLowerCase();
      }
    }

    // 3. Ambientes locais / efêmeros de teste
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'local-supabase';
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Tipo flexível para leitura de variáveis de ambiente.
 */
export type EnvDictionary = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Verifica se a execução atual está configurada para ambiente de staging.
 * Produção real (APP_ENV=production) NUNCA é tratada como staging.
 */
export function isStagingEnvironment(env: EnvDictionary = process.env): boolean {
  const appEnv = env.APP_ENV?.trim().toLowerCase();
  if (appEnv === 'production') {
    return false;
  }
  const stagingGuard = env.STAGING_GUARD_ENABLED?.trim().toLowerCase();
  return appEnv === 'staging' || stagingGuard === 'true';
}

/**
 * Valida de forma pura (sem efeitos colaterais de encerramento) o estado do ambiente de staging.
 */
export function validateStagingIsolation(env: EnvDictionary = process.env): StagingIsolationResult {
  const isStaging = isStagingEnvironment(env);
  const errors: string[] = [];

  const rawProjectRef = (env.STAGING_SUPABASE_PROJECT_REF || env.SUPABASE_PROJECT_REF)?.trim();
  const prodProjectRef = env.PRODUCTION_SUPABASE_PROJECT_REF?.trim();

  const dbUrl = env.DATABASE_URL?.trim();
  const dbAppUrl = env.DATABASE_APP_URL?.trim() || dbUrl;
  const dbAuthUrl = env.DATABASE_AUTH_URL?.trim() || dbUrl;
  const dbWorkerUrl = env.DATABASE_WORKER_URL?.trim() || dbAppUrl || dbUrl;

  const supabaseUrl = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL)?.trim();
  const supabaseAnonKey = (env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  const nextAuthSecret = env.NEXTAUTH_SECRET?.trim();
  const nextAuthUrl = env.NEXTAUTH_URL?.trim();
  const geminiApiKey = env.GEMINI_API_KEY?.trim();

  const dbHosts = new Set<string>();
  const dbNames = new Set<string>();

  // Se não estiver em modo staging, não impõe os bloqueios de homologação
  if (!isStaging) {
    return {
      valid: true,
      isStaging: false,
      errors: [],
      sanitizedSummary: {
        databaseHosts: [],
        databaseNames: [],
      },
    };
  }

  // 1. Identificador Explícito Obrigatório de Projeto de Staging
  if (!rawProjectRef) {
    errors.push(
      'Configuração ausente: STAGING_SUPABASE_PROJECT_REF (ou SUPABASE_PROJECT_REF) é obrigatório em staging.'
    );
  } else {
    // 2. Bloqueio Imediato se o Ref for idêntico ao de Produção
    if (prodProjectRef && rawProjectRef.toLowerCase() === prodProjectRef.toLowerCase()) {
      errors.push(
        'VIOLAÇÃO CRÍTICA DE ISOLAMENTO: O identificador de projeto de staging é idêntico ao de produção.'
      );
    }
  }

  // 3. Validação de URLs de Banco de Dados
  const checkDbUrl = (url: string | undefined, name: string) => {
    if (!url) {
      errors.push(`${name} não configurada para o ambiente de staging.`);
      return;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        errors.push(`${name} deve utilizar protocolo postgres:// ou postgresql:// (recebido: ${parsed.protocol})`);
      }
      if (parsed.hostname) {
        dbHosts.add(parsed.hostname.toLowerCase());
      }
      const dbPath = parsed.pathname.replace(/^\//, '');
      if (dbPath) {
        dbNames.add(dbPath.toLowerCase());
      } else {
        errors.push(`${name} não especifica o nome da base de dados.`);
      }

      // Rejeita identificador de produção na URL de banco
      if (prodProjectRef && url.toLowerCase().includes(prodProjectRef.toLowerCase())) {
        errors.push(
          `VIOLAÇÃO DE ISOLAMENTO: ${name} contém referências ao identificador de projeto produtivo.`
        );
      }

      // Valida correspondência estrita com o projeto Supabase autorizado (H1.03)
      const detectedDbRef = extractSupabaseDbProjectRef(url);
      if (detectedDbRef && detectedDbRef !== 'local-supabase') {
        if (prodProjectRef && detectedDbRef.toLowerCase() === prodProjectRef.toLowerCase()) {
          errors.push(
            `VIOLAÇÃO CRÍTICA DE ISOLAMENTO: ${name} aponta para o projeto de produção ("${prodProjectRef}").`
          );
        }
        if (rawProjectRef && rawProjectRef.toLowerCase() !== 'local-supabase') {
          if (detectedDbRef.toLowerCase() !== rawProjectRef.toLowerCase()) {
            errors.push(
              `Incompatibilidade de projeto Supabase: ${name} aponta para o projeto "${detectedDbRef}", mas o projeto de staging autorizado é "${rawProjectRef}".`
            );
          }
        }
      }
    } catch {
      errors.push(`${name} possui formato de URL inválido.`);
    }
  };

  checkDbUrl(dbAppUrl, 'DATABASE_APP_URL');
  checkDbUrl(dbAuthUrl, 'DATABASE_AUTH_URL');
  checkDbUrl(dbWorkerUrl, 'DATABASE_WORKER_URL');

  // Coerência estrutural das conexões: em staging, todas devem apontar para a mesma base/cluster
  if (dbNames.size > 1) {
    errors.push(
      `Divergência de conexões de banco: URLs apontam para bases distintas (${Array.from(dbNames).join(', ')}).`
    );
  }

  // 4. Validação da URL do Supabase Storage
  let detectedSupabaseRef: string | null = null;
  if (!supabaseUrl) {
    errors.push('SUPABASE_URL (ou NEXT_PUBLIC_SUPABASE_URL) é obrigatória em staging.');
  } else {
    try {
      const parsed = new URL(supabaseUrl);
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        errors.push(`SUPABASE_URL em staging deve utilizar HTTPS seguro (recebido: ${parsed.protocol}).`);
      }
      detectedSupabaseRef = extractSupabaseProjectRef(supabaseUrl);

      if (prodProjectRef && supabaseUrl.toLowerCase().includes(prodProjectRef.toLowerCase())) {
        errors.push('VIOLAÇÃO DE ISOLAMENTO: SUPABASE_URL aponta para o projeto de produção.');
      }

      // Confere se o ref da URL bate com o ref configurado
      if (rawProjectRef && detectedSupabaseRef && detectedSupabaseRef !== 'local-supabase') {
        if (detectedSupabaseRef.toLowerCase() !== rawProjectRef.toLowerCase()) {
          errors.push(
            `Incompatibilidade de projeto Supabase: URL aponta para "${detectedSupabaseRef}", mas STAGING_SUPABASE_PROJECT_REF é "${rawProjectRef}".`
          );
        }
      }
    } catch {
      errors.push('SUPABASE_URL possui formato inválido.');
    }
  }

  // 5. Presença de Credenciais Obrigatórias
  if (!supabaseAnonKey) {
    errors.push('SUPABASE_ANON_KEY é obrigatória para o ambiente de staging.');
  }

  if (!nextAuthSecret) {
    errors.push('NEXTAUTH_SECRET é obrigatório em staging.');
  } else if (nextAuthSecret.length < 32) {
    errors.push(
      `NEXTAUTH_SECRET possui entropia insuficiente (${nextAuthSecret.length} caracteres; mínimo exigido: 32).`
    );
  }

  if (nextAuthUrl) {
    try {
      new URL(nextAuthUrl);
    } catch {
      errors.push('NEXTAUTH_URL possui formato de URL inválido.');
    }
  }

  if (!geminiApiKey) {
    errors.push('GEMINI_API_KEY é obrigatória para o funcionamento dos recursos de IA em staging.');
  }

  // 6. Confirmação Declarativa Obrigatória de Staging
  const confirmFlag = env.CONFIRM_ISOLATED_STAGING_ENVIRONMENT?.trim().toLowerCase();
  if (confirmFlag !== 'true') {
    errors.push(
      'Autorização ausente: a variável CONFIRM_ISOLATED_STAGING_ENVIRONMENT=true é obrigatória para confirmar isolamento de staging.'
    );
  }

  return {
    valid: errors.length === 0,
    isStaging: true,
    errors,
    sanitizedSummary: {
      stagingProjectRef: rawProjectRef,
      supabaseHost: supabaseUrl ? sanitizeUrlForLogging(supabaseUrl) : undefined,
      databaseHosts: Array.from(dbHosts),
      databaseNames: Array.from(dbNames),
    },
  };
}

/**
 * Aplica o guardião de staging de forma estrita (fail-closed).
 * Se APP_ENV=staging e houver qualquer violação, aborta imediatamente com erro explícito.
 */
export function assertStagingIsolation(env: EnvDictionary = process.env): StagingConfig {
  const result = validateStagingIsolation(env);

  if (!result.valid) {
    const errorMsg = 'FALHA DE ISOLAMENTO DE STAGING (FAIL-CLOSED): A inicialização foi bloqueada por motivos de segurança.';
    throw new StagingIsolationError(errorMsg, result.errors);
  }

  const rawProjectRef = (env.STAGING_SUPABASE_PROJECT_REF || env.SUPABASE_PROJECT_REF) ?? 'unspecified-staging';
  const dbUrl = env.DATABASE_URL ?? '';
  const dbAppUrl = env.DATABASE_APP_URL || dbUrl;
  const dbAuthUrl = env.DATABASE_AUTH_URL || dbUrl;
  const dbWorkerUrl = env.DATABASE_WORKER_URL || dbAppUrl || dbUrl;
  const supabaseUrl = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL) ?? '';

  return {
    stagingProjectRef: rawProjectRef,
    appDatabaseUrl: dbAppUrl,
    authDatabaseUrl: dbAuthUrl,
    workerDatabaseUrl: dbWorkerUrl,
    supabaseUrl,
    isStaging: result.isStaging,
  };
}

/**
 * Garante que migrações DDL em staging só sejam executadas sob ambiente estritamente
 * isolado, com autorização explícita e bloqueando qualquer contato com produção.
 */
export function assertCanRunStagingMigrations(env: EnvDictionary = process.env): void {
  // 1. Proibição absoluta em produção
  if (env.NODE_ENV === 'production' && env.APP_ENV !== 'staging') {
    throw new StagingIsolationError('PRODUÇÃO BLOQUEADA: É expressamente proibido executar migrações de staging em ambiente de produção!');
  }
  if (env.APP_ENV === 'production') {
    throw new StagingIsolationError('PRODUÇÃO BLOQUEADA: APP_ENV=production detectado. Migrações sumariamente abortadas!');
  }

  // 2. Exigência de autorização explícita
  const isAuthorized =
    env.CONFIRM_STAGING_MIGRATIONS === 'true' ||
    env.ALLOW_STAGING_MIGRATIONS === 'true' ||
    env.NODE_ENV === 'test';

  if (!isAuthorized) {
    throw new StagingIsolationError(
      'Migrações de staging bloqueadas: requer autorização explícita via variável CONFIRM_STAGING_MIGRATIONS=true.'
    );
  }

  // 3. Validação fail-closed completa em staging
  if (isStagingEnvironment(env)) {
    assertStagingIsolation(env);
  }

  // 4. Bloqueio contra bancos produtivos ou não identificados
  const dbUrl = env.DATABASE_URL || env.DATABASE_APP_URL || '';
  const prodRef = env.PRODUCTION_SUPABASE_PROJECT_REF?.trim();
  if (prodRef && dbUrl.includes(prodRef)) {
    throw new StagingIsolationError('PRODUÇÃO BLOQUEADA: DATABASE_URL aponta para o projeto de produção!');
  }
  if (dbUrl.includes('medicina_prod') || dbUrl.includes('production')) {
    throw new StagingIsolationError('PRODUÇÃO BLOQUEADA: Nome de banco produtivo detectado em DATABASE_URL!');
  }
}
