import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const BUCKET_NAME = 'acervo';

let cachedClient: SupabaseClient | null = null;

/**
 * Retorna o cliente do Supabase inicializado de forma estrita.
 * Exige que SUPABASE_URL e SUPABASE_ANON_KEY estejam devidamente configurados no ambiente,
 * eliminando fallbacks hardcoded com URLs ou chaves de projetos reais.
 */
export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) {
    return cachedClient;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Supabase Storage não está configurado. Configure as variáveis SUPABASE_URL e SUPABASE_ANON_KEY no ambiente para utilizar o armazenamento de arquivos.'
    );
  }

  cachedClient = createClient(supabaseUrl, supabaseAnonKey);
  return cachedClient;
}

/**
 * Proxy transparente para o cliente Supabase garantindo inicialização sob demanda (lazy initialization)
 * sem risco de quebrar a importação do módulo quando as variáveis de storage não estiverem definidas.
 */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getSupabaseClient();
    const value = (client as any)[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  }
});

/**
 * Faz upload de um buffer de arquivo para o Supabase Storage
 */
export async function uploadToSupabaseStorage(key: string, body: Buffer, contentType: string): Promise<string> {
  try {
    const client = getSupabaseClient();
    const { data, error } = await client.storage
      .from(BUCKET_NAME)
      .upload(key, body, {
        contentType,
        upsert: true,
      });

    if (error) {
      throw error;
    }
    return data.path;
  } catch (error) {
    console.error('Erro ao fazer upload para o Supabase Storage:', error instanceof Error ? error.message : 'Erro desconhecido');
    throw error;
  }
}

/**
 * Gera uma URL assinada (Signed URL) temporária para acesso privado ao arquivo no Supabase Storage
 */
export async function obterUrlAssinadaSupabase(key: string, expiracaoSegundos = 3600): Promise<string> {
  try {
    const client = getSupabaseClient();
    const { data, error } = await client.storage
      .from(BUCKET_NAME)
      .createSignedUrl(key, expiracaoSegundos);

    if (error) {
      throw error;
    }
    return data.signedUrl;
  } catch (error) {
    console.error('Erro ao gerar URL assinada do Supabase Storage:', error instanceof Error ? error.message : 'Erro desconhecido');
    throw error;
  }
}
