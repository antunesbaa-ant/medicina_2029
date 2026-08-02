import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const accessKeyId = process.env.CLOUDFLARE_ACCESS_KEY_ID;
const secretAccessKey = process.env.CLOUDFLARE_SECRET_ACCESS_KEY;
const bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME || 'medicina-2029';

// Inicializa o cliente S3 compatível com o Cloudflare R2
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: accessKeyId || '',
    secretAccessKey: secretAccessKey || '',
  },
});

/**
 * Faz upload de um buffer de arquivo para o Cloudflare R2
 */
export async function uploadToR2(key: string, body: Buffer, contentType: string): Promise<string> {
  try {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
    });
    await s3.send(command);
    return key;
  } catch (error) {
    console.error('Erro ao fazer upload para o Cloudflare R2:', error);
    throw error;
  }
}

/**
 * Gera uma URL assinada temporária (Signed URL) para acesso privado e seguro ao arquivo no R2
 */
export async function obterUrlAssinadaR2(key: string, expiracaoSegundos = 3600): Promise<string> {
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    return await getSignedUrl(s3, command, { expiresIn: expiracaoSegundos });
  } catch (error) {
    console.error('Erro ao gerar URL assinada do Cloudflare R2:', error);
    throw error;
  }
}
