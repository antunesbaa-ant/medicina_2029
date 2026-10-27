#!/usr/bin/env node
/**
 * ==============================================================================
 * PROJETO MEDICINA 2029 — ENVELOPE CRIPTOGRÁFICO DE BACKUP (AEAD AES-256-GCM)
 * ==============================================================================
 * Utilitário nativo Node.js de alta performance para cifragem/decifragem autenticada
 * de dumps de banco de dados e arquivos de manifesto.
 *
 * Especificação do Envelope Binário M29G (Versão 0x01):
 * [0..3]   Magic Bytes : 'M29G' (0x4D, 0x32, 0x39, 0x47)
 * [4]      Versão      : 0x01
 * [5..20]  Salt PBKDF2 : 16 bytes (128 bits gerados via randomBytes)
 * [21..32] IV / Nonce  : 12 bytes (96 bits padrão NIST SP 800-38D)
 * [33..48] Auth Tag    : 16 bytes (128 bits de tag GHASH)
 * [49..N]  Ciphertext  : N bytes de carga cifrada via AES-256-GCM
 *
 * Compatibilidade Retroativa (Legacy Fallback):
 * Se o arquivo de entrada iniciar com 'Salted__' (formato OpenSSL enc), executa
 * decifragem retroativa AES-256-CBC (PBKDF2) com aviso explícito no stderr.
 * ==============================================================================
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  unlinkSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAGIC_BYTES = Buffer.from('M29G', 'ascii'); // 4 bytes
const ENVELOPE_VERSION = 0x01; // 1 byte
const SALT_LENGTH = 16; // 16 bytes
const IV_LENGTH = 12; // 12 bytes (96 bits para AES-GCM)
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits

function printUsage() {
  console.error(`Uso:
  node crypto_envelope.mjs encrypt <in_file> <out_file>
  node crypto_envelope.mjs decrypt <in_file> <out_file>

Variáveis de Ambiente:
  BACKUP_ENCRYPTION_KEY  Chave / senha mestra para cifragem e decifragem (obrigatória).
`);
}

function deriveKey(passphrase, salt) {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Cifragem Autenticada AEAD (AES-256-GCM) com Envelope M29G
 */
export async function encryptFile(inFile, outFile, passphrase) {
  if (!existsSync(inFile)) {
    throw new Error(`Arquivo de entrada não encontrado: ${inFile}`);
  }

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);

  // Criamos o arquivo temporário para streaming do ciphertext
  const tempOut = `${outFile}.tmp_${Date.now()}`;
  const outWriteStream = createWriteStream(tempOut);

  // Gravamos o cabeçalho preliminar (Magic, Versão, Salt, IV)
  const headerPrefix = Buffer.concat([
    MAGIC_BYTES,
    Buffer.from([ENVELOPE_VERSION]),
    salt,
    iv,
  ]);
  outWriteStream.write(headerPrefix);

  // Stream do arquivo de entrada através do cipher
  const inReadStream = createReadStream(inFile);
  for await (const chunk of inReadStream) {
    const encChunk = cipher.update(chunk);
    if (encChunk.length > 0) {
      outWriteStream.write(encChunk);
    }
  }

  // Finalização do cipher e obtenção da tag de autenticação de 128 bits
  cipher.final();
  const authTag = cipher.getAuthTag();

  await new Promise((resolve, reject) => {
    outWriteStream.end((err) => (err ? reject(err) : resolve()));
  });

  // Montamos o envelope canônico com a Tag inserida no offset exato (33..48)
  // Estrutura final:
  // [0..3: MAGIC] [4: VERSION] [5..20: SALT] [21..32: IV] [33..48: TAG] [49..N: CIPHERTEXT]
  const finalWriteStream = createWriteStream(outFile);
  finalWriteStream.write(headerPrefix);
  finalWriteStream.write(authTag);

  // Stream do ciphertext gerado (pulando o headerPrefix que já havia sido escrito no tempOut)
  const tempReadStream = createReadStream(tempOut, { start: headerPrefix.length });
  await pipeline(tempReadStream, finalWriteStream);

  // Limpa arquivo temporário
  try {
    unlinkSync(tempOut);
  } catch {
    // ignorar falha de limpeza
  }

  console.error(`[AEAD] Arquivo cifrado com sucesso com AES-256-GCM (Tag 128-bit): ${outFile}`);
}

/**
 * Decifragem Autenticada com detecção de adulteração e suporte retroativo a CBC
 */
export async function decryptFile(inFile, outFile, passphrase) {
  if (!existsSync(inFile)) {
    throw new Error(`Arquivo de entrada não encontrado: ${inFile}`);
  }

  const fd = openSync(inFile, 'r');
  const stat = fstatSync(fd);
  const fileSize = stat.size;

  // Lemos os primeiros 49 bytes para analisar o cabeçalho
  const headerBuf = Buffer.alloc(Math.min(fileSize, 49));
  readSync(fd, headerBuf, 0, headerBuf.length, 0);
  closeSync(fd);

  // 1. Verificação se é Envelope Canônico M29G (AES-256-GCM)
  if (
    headerBuf.length >= 49 &&
    headerBuf.subarray(0, 4).equals(MAGIC_BYTES) &&
    headerBuf[4] === ENVELOPE_VERSION
  ) {
    const salt = headerBuf.subarray(5, 21);
    const iv = headerBuf.subarray(21, 33);
    const authTag = headerBuf.subarray(33, 49);

    const key = deriveKey(passphrase, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const tempDecOut = `${outFile}.tmp_${Date.now()}`;
    const outWriteStream = createWriteStream(tempDecOut);
    const cipherReadStream = createReadStream(inFile, { start: 49 });

    try {
      for await (const chunk of cipherReadStream) {
        const decChunk = decipher.update(chunk);
        if (decChunk.length > 0) {
          outWriteStream.write(decChunk);
        }
      }
      const finalChunk = decipher.final();
      if (finalChunk.length > 0) {
        outWriteStream.write(finalChunk);
      }

      await new Promise((resolve, reject) => {
        outWriteStream.end((err) => (err ? reject(err) : resolve()));
      });

      // Se a autenticação foi concluída com sucesso, move para o arquivo final
      const finalWriteStream = createWriteStream(outFile);
      const decReadStream = createReadStream(tempDecOut);
      await pipeline(decReadStream, finalWriteStream);
      unlinkSync(tempDecOut);

      console.error(`[AEAD] Decifragem AES-256-GCM concluída com sucesso (Autenticidade e Integridade 100% verificadas): ${outFile}`);
      return;
    } catch (err) {
      try {
        unlinkSync(tempDecOut);
      } catch {}
      throw new Error(
        `FALHA CRÍTICA DE AUTENTICAÇÃO AEAD: O arquivo cifrado foi corrompido, adulterado ou a chave está incorreta! (${err.message})`
      );
    }
  }

  // 2. Verificação de cabeçalho OpenSSL legado ('Salted__') -> AES-256-CBC
  if (
    headerBuf.length >= 16 &&
    headerBuf.subarray(0, 8).toString('ascii') === 'Salted__'
  ) {
    console.error(
      `[LEGACY WARNING] Detectado formato legado OpenSSL AES-256-CBC (sem integridade autenticada AEAD). Executando decifragem retroativa...`
    );
    const salt = headerBuf.subarray(8, 16);
    // OpenSSL deriva 48 bytes (32 para key + 16 para IV) via PBKDF2-HMAC-SHA256
    const keyAndIv = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH + 16, 'sha256');
    const key = keyAndIv.subarray(0, 32);
    const iv = keyAndIv.subarray(32, 48);

    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const outWriteStream = createWriteStream(outFile);
    const cipherReadStream = createReadStream(inFile, { start: 16 });

    await pipeline(cipherReadStream, decipher, outWriteStream);
    console.error(`[LEGACY] Decifragem retroativa AES-256-CBC concluída: ${outFile}`);
    return;
  }

  throw new Error(
    `Formato de arquivo cifrado desconhecido ou não suportado (não é envelope M29G nem OpenSSL Salted__).`
  );
}

// -----------------------------------------------------------------------------
// Ponto de Entrada CLI
// -----------------------------------------------------------------------------
async function main() {
  const [mode, inFile, outFile] = process.argv.slice(2);

  if (!mode || !inFile || !outFile || (mode !== 'encrypt' && mode !== 'decrypt')) {
    printUsage();
    process.exit(1);
  }

  const passphrase = process.env.BACKUP_ENCRYPTION_KEY;
  if (!passphrase || passphrase.trim().length === 0) {
    console.error('ERRO: Variável de ambiente BACKUP_ENCRYPTION_KEY não definida!');
    process.exit(1);
  }

  try {
    if (mode === 'encrypt') {
      await encryptFile(inFile, outFile, passphrase.trim());
    } else {
      await decryptFile(inFile, outFile, passphrase.trim());
    }
  } catch (err) {
    console.error(`ERRO CRÍTICO NA OPERAÇÃO CRIPTOGRÁFICA: ${err.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
