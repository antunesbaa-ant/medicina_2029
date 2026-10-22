/**
 * MEDICINA 2029 — F1.06
 * Camada Centralizada de Validação e Sanitização de Variáveis de Ambiente
 *
 * Implementa validação estrita em produção, avisos em desenvolvimento e
 * permissividade controlada em ambiente de testes automatizados (Vitest).
 */

export interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  env: {
    NODE_ENV: 'development' | 'production' | 'test';
    DATABASE_URL?: string;
    DATABASE_APP_URL?: string;
    DATABASE_AUTH_URL?: string;
    DATABASE_WORKER_URL?: string;
    NEXTAUTH_SECRET?: string;
    NEXTAUTH_URL?: string;
    GEMINI_API_KEY?: string;
    GEMINI_EMBEDDING_MODEL?: string;
    GEMINI_OCR_MODEL?: string;
    SUPABASE_URL?: string;
    SUPABASE_ANON_KEY?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
  };
}

const INSECURE_DEFAULT_SECRETS = new Set([
  'secret',
  'password',
  'change-me',
  '12345678',
  'nextauth_secret',
  'sua_chave_secreta_aqui'
]);

/**
 * Valida o conjunto de variáveis de ambiente segundo as políticas de segurança da F1.06.
 */
export function validateEnv(rawEnv: NodeJS.ProcessEnv = process.env): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const rawNodeEnv = rawEnv.NODE_ENV || 'development';
  const nodeEnv: 'development' | 'production' | 'test' =
    rawNodeEnv === 'production' || rawNodeEnv === 'test' ? rawNodeEnv : 'development';

  const isProd = nodeEnv === 'production';
  const isDev = nodeEnv === 'development';

  const nextAuthSecret = rawEnv.NEXTAUTH_SECRET?.trim();
  const nextAuthUrl = rawEnv.NEXTAUTH_URL?.trim();
  const dbUrl = rawEnv.DATABASE_URL?.trim();
  const dbAppUrl = rawEnv.DATABASE_APP_URL?.trim();
  const dbAuthUrl = rawEnv.DATABASE_AUTH_URL?.trim();
  const dbWorkerUrl = rawEnv.DATABASE_WORKER_URL?.trim();
  const geminiApiKey = rawEnv.GEMINI_API_KEY?.trim();
  const geminiEmbeddingModel = rawEnv.GEMINI_EMBEDDING_MODEL?.trim();
  const geminiOcrModel = rawEnv.GEMINI_OCR_MODEL?.trim();
  const anthropicApiKey = rawEnv.ANTHROPIC_API_KEY?.trim();
  const openaiApiKey = rawEnv.OPENAI_API_KEY?.trim();
  const supabaseUrl = rawEnv.SUPABASE_URL?.trim();
  const supabaseAnonKey = rawEnv.SUPABASE_ANON_KEY?.trim();
  const supabaseServiceRoleKey = rawEnv.SUPABASE_SERVICE_ROLE_KEY?.trim();

  // 1. Verificação de Chave Cruzada de IA e Exposição Indevida no Cliente (NEXT_PUBLIC_*)
  if (anthropicApiKey && !geminiApiKey) {
    const msg = 'Segregação de IA: ANTHROPIC_API_KEY não pode ser utilizada como substituta de GEMINI_API_KEY.';
    if (isProd) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
  }
  if (openaiApiKey && !geminiApiKey) {
    const msg = 'Segregação de IA: OPENAI_API_KEY não pode ser utilizada como substituta de GEMINI_API_KEY.';
    if (isProd) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
  }
  if (rawEnv.NEXT_PUBLIC_GEMINI_API_KEY?.trim()) {
    errors.push('Segurança: GEMINI_API_KEY nunca deve ser exposta com prefixo NEXT_PUBLIC_.');
  }
  if (rawEnv.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    errors.push('Segurança: SUPABASE_SERVICE_ROLE_KEY nunca deve ser exposta com prefixo NEXT_PUBLIC_.');
  }

  // 2. Validação de NEXTAUTH_SECRET
  if (isProd) {
    if (!nextAuthSecret) {
      errors.push('NEXTAUTH_SECRET é obrigatório em ambiente de produção.');
    } else {
      if (nextAuthSecret.length < 32) {
        errors.push(
          `NEXTAUTH_SECRET possui apenas ${nextAuthSecret.length} caracteres. Em produção, são exigidos no mínimo 32 caracteres de entropia.`
        );
      }
      if (INSECURE_DEFAULT_SECRETS.has(nextAuthSecret.toLowerCase())) {
        errors.push('NEXTAUTH_SECRET utiliza um valor padrão inseguro conhecido.');
      }
    }

    if (nextAuthUrl && !nextAuthUrl.startsWith('https://')) {
      errors.push(`NEXTAUTH_URL em produção deve utilizar protocolo seguro HTTPS. Valor configurado: "${nextAuthUrl}".`);
    }
  } else if (isDev) {
    if (!nextAuthSecret) {
      warnings.push('NEXTAUTH_SECRET não está definido no ambiente de desenvolvimento.');
    } else if (nextAuthSecret.length < 16) {
      warnings.push('NEXTAUTH_SECRET recomendado com maior entropia (mínimo 32 caracteres).');
    }
  }

  // 3. Validação de Conexão com Banco de Dados
  const hasDbUrl = Boolean(dbUrl || (dbAppUrl && dbAuthUrl));

  if (isProd) {
    if (!hasDbUrl) {
      errors.push('DATABASE_URL (ou o par DATABASE_APP_URL e DATABASE_AUTH_URL) é obrigatório em produção.');
    }

    const checkLocalhost = (url: string | undefined, name: string) => {
      if (url && (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('[::1]'))) {
        if (rawEnv.ALLOW_LOCALHOST_IN_PRODUCTION !== 'true') {
          errors.push(
            `${name} aponta para endereço local (localhost/127.0.0.1) em ambiente de produção. Configure a URL remota segura.`
          );
        }
      }
    };

    checkLocalhost(dbUrl, 'DATABASE_URL');
    checkLocalhost(dbAppUrl, 'DATABASE_APP_URL');
    checkLocalhost(dbAuthUrl, 'DATABASE_AUTH_URL');
    checkLocalhost(dbWorkerUrl, 'DATABASE_WORKER_URL');
  } else if (isDev && !hasDbUrl) {
    warnings.push('Nenhuma URL de banco de dados configurada (DATABASE_URL).');
  }

  // 4. Validação do Supabase Storage
  if (supabaseUrl && !supabaseAnonKey) {
    warnings.push('SUPABASE_URL está configurada, mas SUPABASE_ANON_KEY está ausente.');
  }
  if (!supabaseUrl && supabaseAnonKey) {
    warnings.push('SUPABASE_ANON_KEY está configurada, mas SUPABASE_URL está ausente.');
  }

  const valid = errors.length === 0;

  return {
    valid,
    errors,
    warnings,
    env: {
      NODE_ENV: nodeEnv,
      DATABASE_URL: dbUrl,
      DATABASE_APP_URL: dbAppUrl,
      DATABASE_AUTH_URL: dbAuthUrl,
      DATABASE_WORKER_URL: dbWorkerUrl,
      NEXTAUTH_SECRET: nextAuthSecret,
      NEXTAUTH_URL: nextAuthUrl,
      GEMINI_API_KEY: geminiApiKey,
      GEMINI_EMBEDDING_MODEL: geminiEmbeddingModel,
      GEMINI_OCR_MODEL: geminiOcrModel,
      SUPABASE_URL: supabaseUrl,
      SUPABASE_ANON_KEY: supabaseAnonKey,
      SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKey,
    }
  };
}

/**
 * Obtém as variáveis de ambiente validadas. Lança exceção imediata caso haja erros em produção.
 */
export function getValidatedEnv(rawEnv: NodeJS.ProcessEnv = process.env): EnvValidationResult['env'] {
  const result = validateEnv(rawEnv);

  if (!result.valid && result.env.NODE_ENV === 'production') {
    throw new Error(`Falha de validação de variáveis de ambiente em produção:\n- ${result.errors.join('\n- ')}`);
  }

  return result.env;
}

export function isProduction(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return (rawEnv.NODE_ENV || 'development') === 'production';
}

export function isTest(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return rawEnv.NODE_ENV === 'test';
}

export function isDevelopment(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  const env = rawEnv.NODE_ENV || 'development';
  return env !== 'production' && env !== 'test';
}
