import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeAcervoStorageKey } from './acervoReconciliacao';
import { ACERVO_BUCKET_NAME } from './supabaseStorage';

export const STORAGE_BACKUP_MANIFEST_VERSION = '1.0';
export const DEFAULT_STORAGE_BACKUP_BUCKET = ACERVO_BUCKET_NAME;

export type StorageBackupErrorCode =
  | 'INVALID_MANIFEST'
  | 'SIGNATURE_MISMATCH'
  | 'INVALID_PATH'
  | 'INVALID_PAYLOAD'
  | 'DUPLICATE_OBJECT_PATH'
  | 'IO_ERROR';

export class StorageBackupError extends Error {
  readonly code: StorageBackupErrorCode;
  readonly detalhes?: Record<string, unknown>;

  constructor(code: StorageBackupErrorCode, message: string, detalhes?: Record<string, unknown>) {
    super(message);
    this.name = 'StorageBackupError';
    this.code = code;
    this.detalhes = detalhes;
  }
}

/**
 * Item individual de objeto armazenado listado no manifesto de backup.
 */
export interface StorageBackupObjetoItem {
  storagePath: string;
  arquivoId: string | null;
  tamanhoBytes: number;
  hashSha256: string;
  mimeType: string;
}

/**
 * Manifesto canônico de backup do Supabase Storage.
 */
export interface StorageBackupManifest {
  version: string;
  geradoEm: string;
  bucket: string;
  totalObjetos: number;
  totalBytes: number;
  sha256Manifesto: string;
  objetos: StorageBackupObjetoItem[];
}

/**
 * Entrada flexível para montagem do manifesto de backup.
 */
export interface ObjetoEntradaManifesto {
  storagePath: string;
  arquivoId?: string | null;
  tamanhoBytes?: number;
  hashSha256?: string;
  conteudo?: Buffer | Uint8Array;
  mimeType?: string;
}

export interface GerarManifestoParams {
  bucket?: string;
  version?: string;
  geradoEm?: string | Date;
  objetos: ObjetoEntradaManifesto[];
}

/**
 * Snapshot de objeto físico encontrado no diretório ou storage de backup.
 */
export interface ObjetoFisicoEntrada {
  storagePath: string;
  conteudo?: Buffer | Uint8Array;
  tamanhoBytes?: number;
  hashSha256?: string;
  mimeType?: string;
}

export interface ObjetoAusenteDetalhe {
  storagePath: string;
  arquivoId: string | null;
  tamanhoEsperado: number;
  hashEsperado: string;
}

export interface ObjetoCorrompidoDetalhe {
  storagePath: string;
  arquivoId: string | null;
  esperadoTamanho: number;
  realTamanho: number;
  esperadoSha256: string;
  realSha256: string;
  motivo: 'tamanho_divergente' | 'sha256_divergente' | 'tamanho_e_sha256_divergentes';
}

export interface ObjetoOrfaoDetalhe {
  storagePath: string;
  tamanhoBytes: number;
  hashSha256: string | null;
  mimeType: string | null;
}

export interface ResultadoValidacaoFisicaBackup {
  integro: boolean;
  manifestoValido: boolean;
  motivoInvalidezManifesto?: string;
  bucket: string;
  geradoEm: string;
  totais: {
    manifestados: number;
    encontradosFisicamente: number;
    integros: number;
    ausentes: number;
    corrompidos: number;
    orfaos: number;
  };
  objetosAusentes: ObjetoAusenteDetalhe[];
  objetosCorrompidos: ObjetoCorrompidoDetalhe[];
  objetosOrfaos: ObjetoOrfaoDetalhe[];
  objetosIntegros: string[];
}

export interface ValidarBackupOptions {
  permitirOrfaos?: boolean;
  verificarAssinaturaManifesto?: boolean;
}

export interface ValidarBackupDiretorioOptions extends ValidarBackupOptions {
  ignorarArquivos?: string[];
}

/**
 * Registro mínimo de metadados em `acervo_arquivos` para reconciliação.
 */
export interface RegistroAcervoBancoParaManifesto {
  id: string;
  filePath: string;
  hashConteudo: string;
  tamanhoBytes: number;
  mime: string;
  statusProcessamento?: string | null;
  enviadoPor?: string | null;
  enviadoEm?: Date | string | null;
}

export type TipoInconsistenciaBancoManifesto =
  | 'db_sem_objeto_manifesto'
  | 'manifesto_sem_registro_db'
  | 'tamanho_divergente'
  | 'hash_divergente'
  | 'mime_divergente'
  | 'arquivo_id_divergente'
  | 'duplicidade_db_filepath'
  | 'duplicidade_db_hash';

export interface InconsistenciaBancoManifesto {
  tipo: TipoInconsistenciaBancoManifesto;
  arquivoId: string | null;
  storagePath: string | null;
  hashBanco?: string | null;
  hashManifesto?: string | null;
  tamanhoBanco?: number | null;
  tamanhoManifesto?: number | null;
  mimeBanco?: string | null;
  mimeManifesto?: string | null;
  detalhe: string;
}

export interface ResultadoReconciliacaoBancoManifesto {
  reconciliado: boolean;
  geradoEm: string;
  totais: {
    registrosBanco: number;
    objetosManifesto: number;
    integros: number;
    inconsistencias: number;
    dbSemObjetoManifesto: number;
    manifestoSemRegistroDb: number;
    divergenciasMetadados: number;
    duplicadosBanco: number;
  };
  integros: Array<{ arquivoId: string; storagePath: string; hashSha256: string }>;
  inconsistencias: InconsistenciaBancoManifesto[];
}

export interface DiferencasManifestos {
  iguais: boolean;
  adicionados: StorageBackupObjetoItem[];
  removidos: StorageBackupObjetoItem[];
  modificados: Array<{
    storagePath: string;
    anterior: StorageBackupObjetoItem;
    atual: StorageBackupObjetoItem;
    alteracoes: Array<'tamanhoBytes' | 'hashSha256' | 'mimeType' | 'arquivoId'>;
  }>;
  inalterados: StorageBackupObjetoItem[];
}

// ---------------------------------------------------------------------------
// Helpers puros determinísticos de hash e serialização canônica
// ---------------------------------------------------------------------------

/**
 * Normaliza caminho de storage removendo barras redundantes e bloqueando traversal.
 */
export function normalizarStoragePath(rawPath: string): string {
  try {
    return normalizeAcervoStorageKey(rawPath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Caminho inválido';
    throw new StorageBackupError('INVALID_PATH', `Caminho de objeto inválido "${rawPath}": ${msg}`);
  }
}

/**
 * Calcula hash SHA-256 em formato hexadecimal minúsculo para buffer.
 */
export function calcularSha256Buffer(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex').toLowerCase();
}

/**
 * Serializa de forma determinística (RFC 8785) com ordenação alfabética recursiva de chaves,
 * sem espaços extras e independente da ordem de inserção das propriedades.
 */
function serializarJsonCanonico(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(serializarJsonCanonico).join(',')}]`;
  }
  const keys = Object.keys(val as Record<string, unknown>).sort();
  const entries = keys
    .filter((k) => (val as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${serializarJsonCanonico((val as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Infere o MIME type a partir da extensão do arquivo caso não seja informado.
 */
function inferirMimeType(storagePath: string, fornecido?: string): string {
  if (fornecido && fornecido.trim().length > 0) {
    return fornecido.trim().toLowerCase();
  }
  const lower = storagePath.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

/**
 * Produz a representação canônica ordenada do payload do manifesto (sem o campo sha256Manifesto).
 */
export function serializarManifestoCanonico(
  manifesto: Omit<StorageBackupManifest, 'sha256Manifesto'> | StorageBackupManifest
): string {
  const objetosOrdenados: StorageBackupObjetoItem[] = [...manifesto.objetos]
    .map((o) => ({
      arquivoId: o.arquivoId ?? null,
      hashSha256: o.hashSha256.trim().toLowerCase(),
      mimeType: o.mimeType.trim().toLowerCase(),
      storagePath: normalizarStoragePath(o.storagePath),
      tamanhoBytes: Number(o.tamanhoBytes),
    }))
    .sort((a, b) => (a.storagePath < b.storagePath ? -1 : a.storagePath > b.storagePath ? 1 : 0));

  const payloadCanonico = {
    bucket: manifesto.bucket.trim(),
    geradoEm: typeof manifesto.geradoEm === 'string'
      ? manifesto.geradoEm
      : new Date(manifesto.geradoEm).toISOString(),
    objetos: objetosOrdenados,
    totalBytes: Number(manifesto.totalBytes),
    totalObjetos: Number(manifesto.totalObjetos),
    version: manifesto.version.trim(),
  };

  return serializarJsonCanonico(payloadCanonico);
}

/**
 * Calcula o hash SHA-256 canônico do manifesto a partir da sua representação normalizada.
 */
export function calcularSha256Manifesto(
  manifesto: Omit<StorageBackupManifest, 'sha256Manifesto'> | StorageBackupManifest
): string {
  const jsonCanonico = serializarManifestoCanonico(manifesto);
  return createHash('sha256').update(jsonCanonico, 'utf8').digest('hex').toLowerCase();
}

/**
 * Valida se um manifesto possui estrutura canônica íntegra e se o seu `sha256Manifesto` coincide
 * estritamente com o conteúdo dos objetos e metadados.
 */
export function validarAssinaturaManifesto(manifesto: StorageBackupManifest): {
  valido: boolean;
  motivo?: string;
  hashEsperado?: string;
  hashCalculado?: string;
} {
  if (!manifesto || typeof manifesto !== 'object') {
    return { valido: false, motivo: 'Manifesto nulo ou não é um objeto.' };
  }
  if (!manifesto.version || typeof manifesto.version !== 'string') {
    return { valido: false, motivo: 'Versão do manifesto ausente ou inválida.' };
  }
  if (!manifesto.geradoEm || typeof manifesto.geradoEm !== 'string' || Number.isNaN(Date.parse(manifesto.geradoEm))) {
    return { valido: false, motivo: 'Timestamp geradoEm ausente ou formato ISO inválido.' };
  }
  if (!manifesto.bucket || typeof manifesto.bucket !== 'string' || manifesto.bucket.trim().length === 0) {
    return { valido: false, motivo: 'Nome do bucket ausente ou inválido.' };
  }
  if (!Array.isArray(manifesto.objetos)) {
    return { valido: false, motivo: 'Lista de objetos ausente ou não é um array.' };
  }
  if (manifesto.totalObjetos !== manifesto.objetos.length) {
    return {
      valido: false,
      motivo: `Contagem totalObjetos (${manifesto.totalObjetos}) diverge do tamanho do array (${manifesto.objetos.length}).`,
    };
  }

  const somaBytes = manifesto.objetos.reduce((acc, o) => acc + (o?.tamanhoBytes ?? 0), 0);
  if (manifesto.totalBytes !== somaBytes) {
    return {
      valido: false,
      motivo: `Contagem totalBytes (${manifesto.totalBytes}) diverge da soma real dos objetos (${somaBytes}).`,
    };
  }

  // Verifica ordenação canônica estrita dos objetos e formato dos hashes
  for (let i = 0; i < manifesto.objetos.length; i++) {
    const item = manifesto.objetos[i];
    if (!item || typeof item !== 'object') {
      return { valido: false, motivo: `Objeto no índice ${i} é inválido.` };
    }
    if (!item.storagePath || typeof item.storagePath !== 'string') {
      return { valido: false, motivo: `storagePath ausente no índice ${i}.` };
    }
    if (!/^[0-9a-f]{64}$/i.test(item.hashSha256 || '')) {
      return { valido: false, motivo: `Hash SHA-256 inválido para ${item.storagePath}.` };
    }
    if (typeof item.tamanhoBytes !== 'number' || item.tamanhoBytes < 0 || !Number.isInteger(item.tamanhoBytes)) {
      return { valido: false, motivo: `Tamanho em bytes inválido para ${item.storagePath}.` };
    }
    if (i > 0) {
      const prev = manifesto.objetos[i - 1].storagePath;
      const curr = item.storagePath;
      if (prev >= curr) {
        return {
          valido: false,
          motivo: `Lista de objetos não está estritamente ordenada por storagePath ("${prev}" >= "${curr}").`,
        };
      }
    }
  }

  if (!manifesto.sha256Manifesto || !/^[0-9a-f]{64}$/i.test(manifesto.sha256Manifesto)) {
    return { valido: false, motivo: 'sha256Manifesto ausente ou formato diferente de 64 caracteres hexadecimais.' };
  }

  const hashCalculado = calcularSha256Manifesto(manifesto);
  const hashEsperado = manifesto.sha256Manifesto.trim().toLowerCase();

  if (hashCalculado !== hashEsperado) {
    return {
      valido: false,
      motivo: 'Assinatura SHA-256 do manifesto diverge do conteúdo canônico.',
      hashEsperado,
      hashCalculado,
    };
  }

  return { valido: true, hashEsperado, hashCalculado };
}

// ---------------------------------------------------------------------------
// Geração de Manifesto de Backup de Storage
// ---------------------------------------------------------------------------

/**
 * Gera um manifesto canônico de backup de storage determinístico e assinado com SHA-256.
 */
export function gerarManifestoBackupStorage(params: GerarManifestoParams): StorageBackupManifest {
  const bucket = (params.bucket ?? DEFAULT_STORAGE_BACKUP_BUCKET).trim();
  const version = (params.version ?? STORAGE_BACKUP_MANIFEST_VERSION).trim();
  const geradoEm = params.geradoEm
    ? (typeof params.geradoEm === 'string' ? params.geradoEm : params.geradoEm.toISOString())
    : new Date().toISOString();

  if (!bucket) {
    throw new StorageBackupError('INVALID_PAYLOAD', 'Bucket de backup não pode ser vazio.');
  }

  const caminhosVistos = new Map<string, StorageBackupObjetoItem>();

  for (const entrada of params.objetos) {
    const normalizedPath = normalizarStoragePath(entrada.storagePath);

    let tamanhoBytes: number;
    let hashSha256: string;

    if (entrada.conteudo) {
      const calculadoTamanho = entrada.conteudo.length;
      const calculadoHash = calcularSha256Buffer(entrada.conteudo);

      if (entrada.tamanhoBytes !== undefined && entrada.tamanhoBytes !== calculadoTamanho) {
        throw new StorageBackupError(
          'INVALID_PAYLOAD',
          `tamanhoBytes fornecido (${entrada.tamanhoBytes}) diverge do buffer real (${calculadoTamanho}) para ${normalizedPath}.`
        );
      }
      if (entrada.hashSha256 !== undefined && entrada.hashSha256.toLowerCase().trim() !== calculadoHash) {
        throw new StorageBackupError(
          'INVALID_PAYLOAD',
          `hashSha256 fornecido (${entrada.hashSha256}) diverge do buffer real (${calculadoHash}) para ${normalizedPath}.`
        );
      }

      tamanhoBytes = calculadoTamanho;
      hashSha256 = calculadoHash;
    } else {
      if (typeof entrada.tamanhoBytes !== 'number' || entrada.tamanhoBytes < 0 || !Number.isInteger(entrada.tamanhoBytes)) {
        throw new StorageBackupError(
          'INVALID_PAYLOAD',
          `tamanhoBytes inválido para objeto sem buffer: ${normalizedPath}.`
        );
      }
      if (!entrada.hashSha256 || !/^[0-9a-f]{64}$/i.test(entrada.hashSha256.trim())) {
        throw new StorageBackupError(
          'INVALID_PAYLOAD',
          `hashSha256 inválido (deve ser SHA-256 hex de 64 caracteres) para: ${normalizedPath}.`
        );
      }
      tamanhoBytes = entrada.tamanhoBytes;
      hashSha256 = entrada.hashSha256.trim().toLowerCase();
    }

    const mimeType = inferirMimeType(normalizedPath, entrada.mimeType);
    const arquivoId = entrada.arquivoId ? entrada.arquivoId.trim() : null;

    if (caminhosVistos.has(normalizedPath)) {
      throw new StorageBackupError(
        'DUPLICATE_OBJECT_PATH',
        `Objeto duplicado detectado para o mesmo caminho no backup: "${normalizedPath}".`
      );
    }

    caminhosVistos.set(normalizedPath, {
      storagePath: normalizedPath,
      arquivoId,
      tamanhoBytes,
      hashSha256,
      mimeType,
    });
  }

  // Ordenação canônica estrita por storagePath ascendente
  const objetosOrdenados = Array.from(caminhosVistos.values()).sort((a, b) =>
    a.storagePath < b.storagePath ? -1 : a.storagePath > b.storagePath ? 1 : 0
  );

  const totalObjetos = objetosOrdenados.length;
  const totalBytes = objetosOrdenados.reduce((acc, item) => acc + item.tamanhoBytes, 0);

  const manifestoIncompleto: Omit<StorageBackupManifest, 'sha256Manifesto'> = {
    version,
    geradoEm,
    bucket,
    totalObjetos,
    totalBytes,
    objetos: objetosOrdenados,
  };

  const sha256Manifesto = calcularSha256Manifesto(manifestoIncompleto);

  return {
    ...manifestoIncompleto,
    sha256Manifesto,
  };
}

/**
 * Gera um manifesto canônico diretamente a partir dos metadados de `acervo_arquivos` do banco.
 */
export function gerarManifestoDeRegistrosDb(
  registrosDb: readonly RegistroAcervoBancoParaManifesto[],
  options?: { bucket?: string; version?: string; geradoEm?: string | Date }
): StorageBackupManifest {
  const objetosParaManifesto: ObjetoEntradaManifesto[] = registrosDb.map((reg) => ({
    storagePath: reg.filePath,
    arquivoId: reg.id,
    tamanhoBytes: reg.tamanhoBytes,
    hashSha256: reg.hashConteudo,
    mimeType: reg.mime,
  }));

  return gerarManifestoBackupStorage({
    bucket: options?.bucket ?? DEFAULT_STORAGE_BACKUP_BUCKET,
    version: options?.version ?? STORAGE_BACKUP_MANIFEST_VERSION,
    geradoEm: options?.geradoEm,
    objetos: objetosParaManifesto,
  });
}

/**
 * Gera um manifesto canônico varrendo um diretório local com arquivos físicos de backup.
 * Opcionalmente cruza com registros do banco para correlacionar arquivoId.
 */
export function gerarManifestoDeDiretorio(
  dirPath: string,
  options?: {
    bucket?: string;
    version?: string;
    geradoEm?: string | Date;
    ignorarArquivos?: string[];
    registrosDb?: readonly RegistroAcervoBancoParaManifesto[];
  }
): StorageBackupManifest {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new StorageBackupError('IO_ERROR', `Diretório de backup não encontrado ou inválido: "${dirPath}".`);
  }

  const ignorarSet = new Set(['manifest.json', 'manifesto.json', '.DS_Store', ...(options?.ignorarArquivos ?? [])]);
  const dbPorPath = new Map<string, RegistroAcervoBancoParaManifesto>();

  if (options?.registrosDb) {
    for (const reg of options.registrosDb) {
      try {
        dbPorPath.set(normalizarStoragePath(reg.filePath), reg);
      } catch {
        // Ignora caminhos malformados do banco na correlação
      }
    }
  }

  const objetos: ObjetoEntradaManifesto[] = [];

  function varrerDiretorio(diretorioAtual: string) {
    const entradas = fs.readdirSync(diretorioAtual, { withFileTypes: true });
    for (const entrada of entradas) {
      const fullPath = path.join(diretorioAtual, entrada.name);
      if (entrada.isDirectory()) {
        varrerDiretorio(fullPath);
      } else if (entrada.isFile()) {
        if (ignorarSet.has(entrada.name)) continue;

        const relPath = path.relative(dirPath, fullPath).replace(/\\/g, '/');
        const normalizedPath = normalizarStoragePath(relPath);
        const buffer = fs.readFileSync(fullPath);
        const matchDb = dbPorPath.get(normalizedPath);

        objetos.push({
          storagePath: normalizedPath,
          arquivoId: matchDb?.id ?? null,
          conteudo: buffer,
          mimeType: matchDb?.mime ?? inferirMimeType(normalizedPath),
        });
      }
    }
  }

  varrerDiretorio(dirPath);

  return gerarManifestoBackupStorage({
    bucket: options?.bucket ?? DEFAULT_STORAGE_BACKUP_BUCKET,
    version: options?.version ?? STORAGE_BACKUP_MANIFEST_VERSION,
    geradoEm: options?.geradoEm,
    objetos,
  });
}

// ---------------------------------------------------------------------------
// Validador de Integridade Física do Backup contra o Manifesto
// ---------------------------------------------------------------------------

/**
 * Valida a integridade física de uma coleção de objetos do storage contra o manifesto de backup.
 *
 * Detecta:
 * - Objetos ausentes (no manifesto mas não encontrados no storage)
 * - Objetos corrompidos (tamanho ou SHA-256 divergente)
 * - Objetos órfãos (no storage mas fora do manifesto)
 */
export function validarIntegridadeBackupFisico(
  manifesto: StorageBackupManifest,
  backupFisico: readonly ObjetoFisicoEntrada[] | Map<string, ObjetoFisicoEntrada>,
  options?: ValidarBackupOptions
): ResultadoValidacaoFisicaBackup {
  const verificarAssinatura = options?.verificarAssinaturaManifesto ?? true;
  const permitirOrfaos = options?.permitirOrfaos ?? false;

  let manifestoValido = true;
  let motivoInvalidezManifesto: string | undefined;

  if (verificarAssinatura) {
    const validacaoAssinatura = validarAssinaturaManifesto(manifesto);
    if (!validacaoAssinatura.valido) {
      manifestoValido = false;
      motivoInvalidezManifesto = validacaoAssinatura.motivo;
    }
  }

  // Se o próprio manifesto estiver corrompido, aborta com diagnóstico fail-closed
  if (!manifestoValido) {
    return {
      integro: false,
      manifestoValido: false,
      motivoInvalidezManifesto,
      bucket: manifesto?.bucket ?? '',
      geradoEm: manifesto?.geradoEm ?? '',
      totais: {
        manifestados: manifesto?.totalObjetos ?? 0,
        encontradosFisicamente: 0,
        integros: 0,
        ausentes: 0,
        corrompidos: 0,
        orfaos: 0,
      },
      objetosAusentes: [],
      objetosCorrompidos: [],
      objetosOrfaos: [],
      objetosIntegros: [],
    };
  }

  // Normaliza o catálogo físico em memória
  const fisicosPorPath = new Map<string, { tamanhoBytes: number; hashSha256: string; mimeType: string | null }>();

  const entradasFisicas = backupFisico instanceof Map
    ? Array.from(backupFisico.values())
    : backupFisico;

  for (const item of entradasFisicas) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizarStoragePath(item.storagePath);
    } catch {
      continue;
    }

    let realTamanho: number;
    let realSha256: string;

    if (item.conteudo) {
      realTamanho = item.conteudo.length;
      realSha256 = calcularSha256Buffer(item.conteudo);
    } else {
      realTamanho = typeof item.tamanhoBytes === 'number' ? item.tamanhoBytes : -1;
      realSha256 = (item.hashSha256 ?? '').trim().toLowerCase();
    }

    fisicosPorPath.set(normalizedPath, {
      tamanhoBytes: realTamanho,
      hashSha256: realSha256,
      mimeType: item.mimeType ?? null,
    });
  }

  const objetosAusentes: ObjetoAusenteDetalhe[] = [];
  const objetosCorrompidos: ObjetoCorrompidoDetalhe[] = [];
  const objetosIntegros: string[] = [];
  const caminhosManifestados = new Set<string>();

  // 1. Verifica cada objeto esperado pelo manifesto
  for (const esperado of manifesto.objetos) {
    const storagePath = normalizarStoragePath(esperado.storagePath);
    caminhosManifestados.add(storagePath);

    const fisico = fisicosPorPath.get(storagePath);
    if (!fisico) {
      objetosAusentes.push({
        storagePath,
        arquivoId: esperado.arquivoId,
        tamanhoEsperado: esperado.tamanhoBytes,
        hashEsperado: esperado.hashSha256,
      });
      continue;
    }

    const tamanhoDivergente = fisico.tamanhoBytes !== esperado.tamanhoBytes;
    const hashDivergente = fisico.hashSha256 !== esperado.hashSha256.toLowerCase();

    if (tamanhoDivergente && hashDivergente) {
      objetosCorrompidos.push({
        storagePath,
        arquivoId: esperado.arquivoId,
        esperadoTamanho: esperado.tamanhoBytes,
        realTamanho: fisico.tamanhoBytes,
        esperadoSha256: esperado.hashSha256,
        realSha256: fisico.hashSha256,
        motivo: 'tamanho_e_sha256_divergentes',
      });
    } else if (tamanhoDivergente) {
      objetosCorrompidos.push({
        storagePath,
        arquivoId: esperado.arquivoId,
        esperadoTamanho: esperado.tamanhoBytes,
        realTamanho: fisico.tamanhoBytes,
        esperadoSha256: esperado.hashSha256,
        realSha256: fisico.hashSha256,
        motivo: 'tamanho_divergente',
      });
    } else if (hashDivergente) {
      objetosCorrompidos.push({
        storagePath,
        arquivoId: esperado.arquivoId,
        esperadoTamanho: esperado.tamanhoBytes,
        realTamanho: fisico.tamanhoBytes,
        esperadoSha256: esperado.hashSha256,
        realSha256: fisico.hashSha256,
        motivo: 'sha256_divergente',
      });
    } else {
      objetosIntegros.push(storagePath);
    }
  }

  // 2. Detecta objetos órfãos (presentes no storage mas fora do manifesto)
  const objetosOrfaos: ObjetoOrfaoDetalhe[] = [];
  for (const [pathFisico, objFisico] of fisicosPorPath.entries()) {
    if (!caminhosManifestados.has(pathFisico)) {
      objetosOrfaos.push({
        storagePath: pathFisico,
        tamanhoBytes: objFisico.tamanhoBytes,
        hashSha256: objFisico.hashSha256 || null,
        mimeType: objFisico.mimeType,
      });
    }
  }

  const integro =
    manifestoValido &&
    objetosAusentes.length === 0 &&
    objetosCorrompidos.length === 0 &&
    (permitirOrfaos ? true : objetosOrfaos.length === 0);

  return {
    integro,
    manifestoValido,
    motivoInvalidezManifesto,
    bucket: manifesto.bucket,
    geradoEm: manifesto.geradoEm,
    totais: {
      manifestados: manifesto.totalObjetos,
      encontradosFisicamente: fisicosPorPath.size,
      integros: objetosIntegros.length,
      ausentes: objetosAusentes.length,
      corrompidos: objetosCorrompidos.length,
      orfaos: objetosOrfaos.length,
    },
    objetosAusentes,
    objetosCorrompidos,
    objetosOrfaos,
    objetosIntegros,
  };
}

/**
 * Valida a integridade física de um backup gravado em diretório no disco contra o manifesto.
 */
export function validarIntegridadeBackupDiretorio(
  dirPath: string,
  manifesto: StorageBackupManifest,
  options?: ValidarBackupDiretorioOptions
): ResultadoValidacaoFisicaBackup {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new StorageBackupError('IO_ERROR', `Diretório de backup não encontrado: "${dirPath}".`);
  }

  const ignorarSet = new Set(['manifest.json', 'manifesto.json', '.DS_Store', ...(options?.ignorarArquivos ?? [])]);
  const objetosFisicos: ObjetoFisicoEntrada[] = [];

  function varrerDiretorio(diretorioAtual: string) {
    const entradas = fs.readdirSync(diretorioAtual, { withFileTypes: true });
    for (const entrada of entradas) {
      const fullPath = path.join(diretorioAtual, entrada.name);
      if (entrada.isDirectory()) {
        varrerDiretorio(fullPath);
      } else if (entrada.isFile()) {
        if (ignorarSet.has(entrada.name)) continue;
        const relPath = path.relative(dirPath, fullPath).replace(/\\/g, '/');
        const normalizedPath = normalizarStoragePath(relPath);
        const buffer = fs.readFileSync(fullPath);
        objetosFisicos.push({
          storagePath: normalizedPath,
          conteudo: buffer,
        });
      }
    }
  }

  varrerDiretorio(dirPath);

  return validarIntegridadeBackupFisico(manifesto, objetosFisicos, options);
}

// ---------------------------------------------------------------------------
// Reconciliação entre Manifesto e Metadados do Banco (`acervo_arquivos`)
// ---------------------------------------------------------------------------

/**
 * Reconcilia o manifesto de backup com os registros persistidos em `acervo_arquivos` no PostgreSQL.
 *
 * Detecta:
 * - Registros do banco sem objeto no manifesto de backup (`db_sem_objeto_manifesto`)
 * - Objetos do manifesto sem registro correspondente no banco (`manifesto_sem_registro_db`)
 * - Divergências de tamanho, hash SHA-256 ou MIME
 * - Conflitos de identificador de arquivo (`arquivo_id_divergente`)
 * - Duplicidades pré-existentes de filePath ou hash no banco
 */
export function reconciliarManifestoComBanco(
  manifesto: StorageBackupManifest,
  registrosDb: readonly RegistroAcervoBancoParaManifesto[]
): ResultadoReconciliacaoBancoManifesto {
  const inconsistencias: InconsistenciaBancoManifesto[] = [];
  const integros: Array<{ arquivoId: string; storagePath: string; hashSha256: string }> = [];

  const manifestoPorPath = new Map<string, StorageBackupObjetoItem>();
  for (const obj of manifesto.objetos) {
    manifestoPorPath.set(normalizarStoragePath(obj.storagePath), obj);
  }

  // 1. Auditoria de duplicidades no banco de dados
  const dbPorPath = new Map<string, RegistroAcervoBancoParaManifesto[]>();
  const dbPorHash = new Map<string, RegistroAcervoBancoParaManifesto[]>();

  for (const reg of registrosDb) {
    let normPath: string;
    try {
      normPath = normalizarStoragePath(reg.filePath);
    } catch {
      normPath = reg.filePath.trim();
    }

    const byPath = dbPorPath.get(normPath) ?? [];
    byPath.push(reg);
    dbPorPath.set(normPath, byPath);

    const normHash = reg.hashConteudo.trim().toLowerCase();
    const byHash = dbPorHash.get(normHash) ?? [];
    byHash.push(reg);
    dbPorHash.set(normHash, byHash);
  }

  let duplicadosBanco = 0;

  for (const [p, regs] of dbPorPath.entries()) {
    if (regs.length > 1) {
      duplicadosBanco++;
      inconsistencias.push({
        tipo: 'duplicidade_db_filepath',
        arquivoId: regs.map((r) => r.id).join(','),
        storagePath: p,
        detalhe: `Múltiplos registros (${regs.length}) em acervo_arquivos apontam para o mesmo file_path "${p}".`,
      });
    }
  }

  for (const [h, regs] of dbPorHash.entries()) {
    if (regs.length > 1) {
      duplicadosBanco++;
      inconsistencias.push({
        tipo: 'duplicidade_db_hash',
        arquivoId: regs.map((r) => r.id).join(','),
        storagePath: regs.map((r) => r.filePath).join(','),
        hashBanco: h,
        detalhe: `Múltiplos registros (${regs.length}) em acervo_arquivos compartilham o mesmo hash_conteudo "${h}".`,
      });
    }
  }

  let dbSemObjetoManifesto = 0;
  let divergenciasMetadados = 0;

  // 2. Avaliação de cada registro do banco contra o manifesto
  for (const reg of registrosDb) {
    let normPath: string;
    try {
      normPath = normalizarStoragePath(reg.filePath);
    } catch {
      normPath = reg.filePath.trim();
    }

    const objManifesto = manifestoPorPath.get(normPath);

    if (!objManifesto) {
      dbSemObjetoManifesto++;
      inconsistencias.push({
        tipo: 'db_sem_objeto_manifesto',
        arquivoId: reg.id,
        storagePath: normPath,
        hashBanco: reg.hashConteudo,
        tamanhoBanco: reg.tamanhoBytes,
        mimeBanco: reg.mime,
        detalhe: `Registro ${reg.id} em acervo_arquivos referencia "${normPath}", mas objeto não consta no manifesto de backup.`,
      });
      continue;
    }

    const normDbHash = reg.hashConteudo.trim().toLowerCase();
    const normManHash = objManifesto.hashSha256.trim().toLowerCase();
    const tamanhoDivergente = reg.tamanhoBytes !== objManifesto.tamanhoBytes;
    const hashDivergente = normDbHash !== normManHash;
    const mimeDivergente = reg.mime.trim().toLowerCase() !== objManifesto.mimeType.trim().toLowerCase();
    const arquivoIdDivergente = Boolean(objManifesto.arquivoId && objManifesto.arquivoId !== reg.id);

    let houveDivergencia = false;

    if (tamanhoDivergente) {
      houveDivergencia = true;
      divergenciasMetadados++;
      inconsistencias.push({
        tipo: 'tamanho_divergente',
        arquivoId: reg.id,
        storagePath: normPath,
        tamanhoBanco: reg.tamanhoBytes,
        tamanhoManifesto: objManifesto.tamanhoBytes,
        detalhe: `Tamanho divergente para ${normPath}: banco registra ${reg.tamanhoBytes} bytes, manifesto registra ${objManifesto.tamanhoBytes} bytes.`,
      });
    }

    if (hashDivergente) {
      houveDivergencia = true;
      divergenciasMetadados++;
      inconsistencias.push({
        tipo: 'hash_divergente',
        arquivoId: reg.id,
        storagePath: normPath,
        hashBanco: normDbHash,
        hashManifesto: normManHash,
        detalhe: `Hash divergente para ${normPath}: banco registra ${normDbHash}, manifesto registra ${normManHash}.`,
      });
    }

    if (mimeDivergente) {
      houveDivergencia = true;
      divergenciasMetadados++;
      inconsistencias.push({
        tipo: 'mime_divergente',
        arquivoId: reg.id,
        storagePath: normPath,
        mimeBanco: reg.mime,
        mimeManifesto: objManifesto.mimeType,
        detalhe: `Tipo MIME divergente para ${normPath}: banco registra ${reg.mime}, manifesto registra ${objManifesto.mimeType}.`,
      });
    }

    if (arquivoIdDivergente) {
      houveDivergencia = true;
      divergenciasMetadados++;
      inconsistencias.push({
        tipo: 'arquivo_id_divergente',
        arquivoId: reg.id,
        storagePath: normPath,
        detalhe: `arquivoId divergente para ${normPath}: banco possui ${reg.id}, manifesto possui ${objManifesto.arquivoId}.`,
      });
    }

    if (!houveDivergencia) {
      integros.push({
        arquivoId: reg.id,
        storagePath: normPath,
        hashSha256: normManHash,
      });
    }
  }

  // 3. Avaliação de objetos do manifesto que não possuem registro no banco
  let manifestoSemRegistroDb = 0;
  for (const objManifesto of manifesto.objetos) {
    const normPath = normalizarStoragePath(objManifesto.storagePath);
    if (!dbPorPath.has(normPath)) {
      manifestoSemRegistroDb++;
      inconsistencias.push({
        tipo: 'manifesto_sem_registro_db',
        arquivoId: objManifesto.arquivoId,
        storagePath: normPath,
        hashManifesto: objManifesto.hashSha256,
        tamanhoManifesto: objManifesto.tamanhoBytes,
        mimeManifesto: objManifesto.mimeType,
        detalhe: `Objeto "${normPath}" existe no manifesto de backup do Storage, mas não possui linha correspondente em acervo_arquivos.`,
      });
    }
  }

  return {
    reconciliado: inconsistencias.length === 0,
    geradoEm: new Date().toISOString(),
    totais: {
      registrosBanco: registrosDb.length,
      objetosManifesto: manifesto.totalObjetos,
      integros: integros.length,
      inconsistencias: inconsistencias.length,
      dbSemObjetoManifesto,
      manifestoSemRegistroDb,
      divergenciasMetadados,
      duplicadosBanco,
    },
    integros,
    inconsistencias,
  };
}

// ---------------------------------------------------------------------------
// Comparação Diferencial entre Manifestos de Backup
// ---------------------------------------------------------------------------

/**
 * Compara dois manifestos canônicos de backup (ex.: backup anterior vs backup atual)
 * para identificar arquivos adicionados, removidos, modificados ou inalterados.
 */
export function compararManifestos(
  manifestoAnterior: StorageBackupManifest,
  manifestoAtual: StorageBackupManifest
): DiferencasManifestos {
  const mapaAnterior = new Map<string, StorageBackupObjetoItem>();
  for (const o of manifestoAnterior.objetos) {
    mapaAnterior.set(normalizarStoragePath(o.storagePath), o);
  }

  const mapaAtual = new Map<string, StorageBackupObjetoItem>();
  for (const o of manifestoAtual.objetos) {
    mapaAtual.set(normalizarStoragePath(o.storagePath), o);
  }

  const adicionados: StorageBackupObjetoItem[] = [];
  const removidos: StorageBackupObjetoItem[] = [];
  const modificados: DiferencasManifestos['modificados'] = [];
  const inalterados: StorageBackupObjetoItem[] = [];

  for (const [pathAtual, objAtual] of mapaAtual.entries()) {
    const objAnterior = mapaAnterior.get(pathAtual);
    if (!objAnterior) {
      adicionados.push(objAtual);
    } else {
      const alteracoes: Array<'tamanhoBytes' | 'hashSha256' | 'mimeType' | 'arquivoId'> = [];
      if (objAtual.tamanhoBytes !== objAnterior.tamanhoBytes) alteracoes.push('tamanhoBytes');
      if (objAtual.hashSha256.toLowerCase() !== objAnterior.hashSha256.toLowerCase()) alteracoes.push('hashSha256');
      if (objAtual.mimeType.toLowerCase() !== objAnterior.mimeType.toLowerCase()) alteracoes.push('mimeType');
      if (objAtual.arquivoId !== objAnterior.arquivoId) alteracoes.push('arquivoId');

      if (alteracoes.length > 0) {
        modificados.push({
          storagePath: pathAtual,
          anterior: objAnterior,
          atual: objAtual,
          alteracoes,
        });
      } else {
        inalterados.push(objAtual);
      }
    }
  }

  for (const [pathAnt, objAnt] of mapaAnterior.entries()) {
    if (!mapaAtual.has(pathAnt)) {
      removidos.push(objAnt);
    }
  }

  return {
    iguais: adicionados.length === 0 && removidos.length === 0 && modificados.length === 0,
    adicionados,
    removidos,
    modificados,
    inalterados,
  };
}

// ---------------------------------------------------------------------------
// Utilitários de Serialização, Arquivo e Leitura
// ---------------------------------------------------------------------------

/**
 * Serializa o manifesto completo para JSON legível ou compacto.
 */
export function serializarManifestoJson(manifesto: StorageBackupManifest, pretty = true): string {
  return JSON.stringify(manifesto, null, pretty ? 2 : 0);
}

/**
 * Carrega e valida um manifesto a partir de string JSON, conferindo opcionalmente sua assinatura.
 */
export function deserializarManifestoJson(jsonStr: string, validarAssinatura = true): StorageBackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'JSON malformado';
    throw new StorageBackupError('INVALID_MANIFEST', `Falha ao interpretar JSON do manifesto: ${msg}`);
  }

  const manifesto = parsed as StorageBackupManifest;
  if (validarAssinatura) {
    const validacao = validarAssinaturaManifesto(manifesto);
    if (!validacao.valido) {
      throw new StorageBackupError('SIGNATURE_MISMATCH', `Assinatura de integridade do manifesto inválida: ${validacao.motivo}`);
    }
  }

  return manifesto;
}

/**
 * Salva o manifesto em arquivo local de forma segura e síncrona.
 */
export function salvarManifestoEmArquivo(manifesto: StorageBackupManifest, filePath: string): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = serializarManifestoJson(manifesto, true);
    fs.writeFileSync(filePath, json, 'utf8');
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Erro de I/O';
    throw new StorageBackupError('IO_ERROR', `Falha ao salvar arquivo de manifesto em "${filePath}": ${msg}`);
  }
}

/**
 * Carrega o manifesto a partir de um arquivo local.
 */
export function carregarManifestoDeArquivo(filePath: string, validarAssinatura = true): StorageBackupManifest {
  try {
    if (!fs.existsSync(filePath)) {
      throw new StorageBackupError('IO_ERROR', `Arquivo de manifesto não encontrado: "${filePath}".`);
    }
    const json = fs.readFileSync(filePath, 'utf8');
    return deserializarManifestoJson(json, validarAssinatura);
  } catch (error) {
    if (error instanceof StorageBackupError) throw error;
    const msg = error instanceof Error ? error.message : 'Erro de I/O';
    throw new StorageBackupError('IO_ERROR', `Falha ao ler arquivo de manifesto de "${filePath}": ${msg}`);
  }
}
