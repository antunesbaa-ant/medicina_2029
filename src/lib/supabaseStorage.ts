import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || 'https://ewruxhmcqznraszvbfes.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

// Inicializa o cliente do Supabase
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

const BUCKET_NAME = 'acervo';

/**
 * Faz upload de um buffer de arquivo para o Supabase Storage
 */
export async function uploadToSupabaseStorage(key: string, body: Buffer, contentType: string): Promise<string> {
  try {
    const { data, error } = await supabase.storage
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
    console.error('Erro ao fazer upload para o Supabase Storage:', error);
    throw error;
  }
}

/**
 * Gera uma URL assinada (Signed URL) temporária para acesso privado ao arquivo no Supabase Storage
 */
export async function obterUrlAssinadaSupabase(key: string, expiracaoSegundos = 3600): Promise<string> {
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(key, expiracaoSegundos);

    if (error) {
      throw error;
    }
    return data.signedUrl;
  } catch (error) {
    console.error('Erro ao gerar URL assinada do Supabase Storage:', error);
    throw error;
  }
}
