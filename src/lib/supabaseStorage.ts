import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeAcervoStorageKey } from './acervoReconciliacao';
import { MAX_UPLOAD_FILE_BYTES } from './validation';

export const ACERVO_BUCKET_NAME = 'acervo';
export const MIN_SIGNED_URL_SECONDS = 60;
export const MAX_SIGNED_URL_SECONDS = 900;
export const DEFAULT_SIGNED_URL_SECONDS = 300;

export type StorageErrorCode =
  | 'NOT_CONFIGURED'
  | 'INSECURE_CONFIGURATION'
  | 'INVALID_KEY'
  | 'INVALID_PAYLOAD'
  | 'OBJECT_EXISTS'
  | 'INVALID_RESPONSE'
  | 'UNAVAILABLE';

export class StorageOperationError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'StorageOperationError';
    this.code = code;
  }
}

let cachedClient: SupabaseClient | null = null;

export function resetSupabaseClientCache(): void {
  cachedClient = null;
}

function isDuplicateStorageError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as {
    statusCode?: string | number;
    status?: number;
    error?: string;
    message?: string;
  };
  if (
    candidate.statusCode === '409' ||
    candidate.statusCode === 409 ||
    candidate.status === 409 ||
    candidate.error === 'Duplicate'
  ) {
    return true;
  }
  if (typeof candidate.message === 'string') {
    return /already exists|duplicate|resource already exists|409/i.test(candidate.message);
  }
  return false;
}

/**
 * Retorna o cliente do Supabase inicializado de forma estrita no servidor.
 * - Bloqueia exposição acidental de chave privilegiada em variável NEXT_PUBLIC_*;
 * - Prioriza SUPABASE_SERVICE_ROLE_KEY no servidor com fallback compatível para SUPABASE_ANON_KEY;
 * - Desativa persistência de sessão para uso estritamente server-side.
 */
export function getSupabaseClient(): SupabaseClient {
  if (process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY) {
    throw new StorageOperationError(
      'INSECURE_CONFIGURATION',
      'Configuração insegura detectada: chave de serviço não pode ser exposta em variável NEXT_PUBLIC_.'
    );
  }

  if (cachedClient) {
    return cachedClient;
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseServerKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY
  )?.trim();

  if (!supabaseUrl || !supabaseServerKey) {
    throw new StorageOperationError(
      'NOT_CONFIGURED',
      'Supabase Storage não está configurado. Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_ANON_KEY) no ambiente.'
    );
  }

  cachedClient = createClient(supabaseUrl, supabaseServerKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return cachedClient;
}

/**
 * Proxy transparente para o cliente Supabase garantindo inicialização sob demanda (lazy initialization)
 * sem risco de quebrar a importação do módulo quando as variáveis de storage não estiverem definidas.
 */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getSupabaseClient();
    const value = (client as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

/**
 * Faz upload de um buffer de PDF para o bucket privado `acervo` no Supabase Storage.
 * - Utiliza `upsert: false` por padrão para impedir sobrescrita silenciosa de objetos existentes;
 * - Valida chave, tamanho, MIME e a resposta retornada pelo serviço externo.
 */
export async function uploadToSupabaseStorage(
  key: string,
  body: Buffer,
  contentType: string,
  options?: { upsert?: boolean }
): Promise<string> {
  let normalizedKey: string;
  try {
    normalizedKey = normalizeAcervoStorageKey(key);
  } catch {
    throw new StorageOperationError('INVALID_KEY', 'Chave de armazenamento inválida.');
  }

  if (!normalizedKey.startsWith('acervo/') || !normalizedKey.toLowerCase().endsWith('.pdf')) {
    throw new StorageOperationError(
      'INVALID_KEY',
      'O objeto deve ser armazenado sob o prefixo privado acervo/ com extensão .pdf.'
    );
  }

  if (
    !Buffer.isBuffer(body) ||
    body.length <= 0 ||
    body.length > MAX_UPLOAD_FILE_BYTES ||
    contentType !== 'application/pdf'
  ) {
    throw new StorageOperationError(
      'INVALID_PAYLOAD',
      'Payload de arquivo inválido para armazenamento no bucket privado.'
    );
  }

  try {
    const client = getSupabaseClient();
    const { data, error } = await client.storage
      .from(ACERVO_BUCKET_NAME)
      .upload(normalizedKey, body, {
        contentType: 'application/pdf',
        upsert: options?.upsert ?? false,
      });

    if (error) {
      if (isDuplicateStorageError(error)) {
        throw new StorageOperationError('OBJECT_EXISTS', 'O objeto já existe no Storage.');
      }
      throw new StorageOperationError('UNAVAILABLE', 'Falha ao armazenar o arquivo.');
    }

    if (!data || typeof data.path !== 'string' || data.path.trim().length === 0) {
      throw new StorageOperationError(
        'INVALID_RESPONSE',
        'Resposta inválida do serviço de armazenamento.'
      );
    }

    return data.path.trim();
  } catch (error) {
    if (error instanceof StorageOperationError) {
      if (error.code !== 'OBJECT_EXISTS') {
        console.error(`[storage] upload_failed code=${error.code}`);
      }
      throw error;
    }
    if (isDuplicateStorageError(error)) {
      throw new StorageOperationError('OBJECT_EXISTS', 'O objeto já existe no Storage.');
    }
    console.error('[storage] upload_failed');
    throw new StorageOperationError('UNAVAILABLE', 'Falha ao armazenar o arquivo.');
  }
}

/**
 * Gera uma URL assinada (Signed URL) temporária e de curta duração para acesso privado
 * a um objeto no bucket `acervo` do Supabase Storage.
 * - Exige expiração curta (60..900 segundos, padrão 300s);
 * - Rejeita URLs públicas permanentes (`/object/public/`) ou respostas malformadas.
 */
export async function obterUrlAssinadaSupabase(
  key: string,
  expiracaoSegundos = DEFAULT_SIGNED_URL_SECONDS
): Promise<string> {
  let normalizedKey: string;
  try {
    normalizedKey = normalizeAcervoStorageKey(key);
  } catch {
    throw new StorageOperationError('INVALID_KEY', 'Chave de armazenamento inválida.');
  }

  if (!normalizedKey.startsWith('acervo/') || !normalizedKey.toLowerCase().endsWith('.pdf')) {
    throw new StorageOperationError('INVALID_KEY', 'Chave de objeto fora do escopo do acervo.');
  }

  if (
    !Number.isInteger(expiracaoSegundos) ||
    expiracaoSegundos < MIN_SIGNED_URL_SECONDS ||
    expiracaoSegundos > MAX_SIGNED_URL_SECONDS
  ) {
    throw new StorageOperationError(
      'INVALID_PAYLOAD',
      `Tempo de expiração da URL assinada deve estar entre ${MIN_SIGNED_URL_SECONDS} e ${MAX_SIGNED_URL_SECONDS} segundos.`
    );
  }

  try {
    const client = getSupabaseClient();
    const { data, error } = await client.storage
      .from(ACERVO_BUCKET_NAME)
      .createSignedUrl(normalizedKey, expiracaoSegundos);

    if (error) {
      throw new StorageOperationError('UNAVAILABLE', 'Falha ao gerar acesso temporário ao arquivo.');
    }

    const signedUrl = data?.signedUrl?.trim();
    if (
      !signedUrl ||
      signedUrl.includes('/object/public/') ||
      !(/^https?:\/\//i.test(signedUrl) || signedUrl.startsWith('/'))
    ) {
      throw new StorageOperationError(
        'INVALID_RESPONSE',
        'URL temporária retornada pelo Storage é inválida ou insegura.'
      );
    }

    return signedUrl;
  } catch (error) {
    if (error instanceof StorageOperationError) {
      console.error(`[storage] signed_url_failed code=${error.code}`);
      throw error;
    }
    console.error('[storage] signed_url_failed');
    throw new StorageOperationError('UNAVAILABLE', 'Falha ao gerar acesso temporário ao arquivo.');
  }
}

/**
 * Baixa os bytes de um PDF armazenado no bucket privado `acervo` para processamento pelo worker.
 */
export async function downloadFromSupabaseStorage(key: string): Promise<Buffer> {
  let normalizedKey: string;
  try {
    normalizedKey = normalizeAcervoStorageKey(key);
  } catch {
    throw new StorageOperationError('INVALID_KEY', 'Chave de armazenamento inválida.');
  }

  if (!normalizedKey.startsWith('acervo/') || !normalizedKey.toLowerCase().endsWith('.pdf')) {
    throw new StorageOperationError('INVALID_KEY', 'Chave de objeto fora do escopo do acervo.');
  }

  try {
    const client = getSupabaseClient();
    const { data, error } = await client.storage.from(ACERVO_BUCKET_NAME).download(normalizedKey);

    if (error || !data) {
      throw new StorageOperationError('UNAVAILABLE', 'Falha ao baixar o arquivo do Storage.');
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(new Uint8Array(arrayBuffer));

    if (buffer.length <= 0 || buffer.length > MAX_UPLOAD_FILE_BYTES) {
      throw new StorageOperationError(
        'INVALID_RESPONSE',
        'Arquivo retornado pelo Storage possui tamanho inválido.'
      );
    }

    return buffer;
  } catch (error) {
    if (error instanceof StorageOperationError) {
      console.error(`[storage] download_failed code=${error.code}`);
      throw error;
    }
    console.error('[storage] download_failed');
    throw new StorageOperationError('UNAVAILABLE', 'Falha ao baixar o arquivo do Storage.');
  }
}
