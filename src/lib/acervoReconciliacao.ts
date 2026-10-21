export interface RegistroAcervoSnapshot {
  id: string;
  filePath: string;
  hashConteudo: string;
  tamanhoBytes: number;
  mime: string;
  statusProcessamento:
    | 'aguardando'
    | 'extraindo'
    | 'segmentando'
    | 'classificando'
    | 'indexando'
    | 'concluido'
    | 'falhou'
    | 'erro';
  erroProcessamento?: string | null;
  enviadoPor: string;
  enviadoEm?: Date | string | null;
}

export interface ObjetoStorageSnapshot {
  path: string;
  tamanhoBytes: number | null;
  mime: string | null;
  etag?: string | null;
  hashConteudoMetadata?: string | null;
  criadoEm?: Date | string | null;
}

export type CategoriaDivergenciaAcervo =
  | 'metadados_sem_objeto'
  | 'objeto_sem_metadados'
  | 'upload_incompleto_ou_falho'
  | 'duplicados';

export interface ItemReconciliacaoAcervo {
  categoria: CategoriaDivergenciaAcervo;
  subtipo:
    | 'db_sem_objeto_storage'
    | 'storage_orfao_sem_db'
    | 'storage_orfao_recuperavel_por_hash'
    | 'status_processamento_falho'
    | 'tamanho_ou_mime_divergente'
    | 'hash_divergente'
    | 'hash_duplicado_db'
    | 'filepath_duplicado_db'
    | 'multiplos_objetos_mesmo_hash_storage';
  arquivoIds: string[];
  pathsStorage: string[];
  hashConteudo: string | null;
  recuperavelNoReenvio: boolean;
  acaoRecomendada: string;
}

export interface RelatorioReconciliacaoAcervo {
  geradoEm: string;
  somenteLeitura: true;
  exclusaoAutomaticaExecutada: false;
  totais: {
    registrosDb: number;
    objetosStorage: number;
    integros: number;
    metadadosSemObjeto: number;
    objetoSemMetadados: number;
    uploadIncompletoOuFalho: number;
    duplicados: number;
  };
  classificacoes: {
    metadados_sem_objeto: ItemReconciliacaoAcervo[];
    objeto_sem_metadados: ItemReconciliacaoAcervo[];
    upload_incompleto_ou_falho: ItemReconciliacaoAcervo[];
    duplicados: ItemReconciliacaoAcervo[];
  };
}

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const HASH_FROM_PATH_REGEX = /^acervo\/([0-9a-f]{64})(?:_[A-Za-z0-9._-]+)?\.pdf$/i;

export function normalizeAcervoStorageKey(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^\/+|\/+$/g, '');
  if (
    !trimmed ||
    trimmed.includes('..') ||
    trimmed.includes('\\') ||
    trimmed.includes('//') ||
    /[\x00-\x1f]/.test(trimmed)
  ) {
    throw new Error('Caminho de objeto no Storage é inválido.');
  }
  return trimmed;
}

export function buildDeterministicAcervoStoragePath(hashConteudo: string): string {
  const normalizedHash = hashConteudo.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedHash)) {
    throw new Error('Hash SHA-256 inválido para construção de chave no Storage.');
  }
  return `acervo/${normalizedHash}.pdf`;
}

export function extractHashFromStoragePath(rawPath: string): string | null {
  try {
    const normalized = normalizeAcervoStorageKey(rawPath);
    const match = HASH_FROM_PATH_REGEX.exec(normalized);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Reconcilia de forma 100% read-only os snapshots de metadados em `acervo_arquivos`
 * e de objetos no bucket privado `acervo`.
 *
 * Garantias:
 * - Nunca executa exclusão automática de objetos nem de registros;
 * - Nunca varre buckets remotos reais diretamente;
 * - Identifica metadados sem objeto, objetos sem metadados, uploads incompletos/falhos e duplicações.
 */
export function reconciliarSnapshotsAcervo(
  registrosDb: readonly RegistroAcervoSnapshot[],
  objetosStorage: readonly ObjetoStorageSnapshot[],
): RelatorioReconciliacaoAcervo {
  const metadadosSemObjeto: ItemReconciliacaoAcervo[] = [];
  const objetoSemMetadados: ItemReconciliacaoAcervo[] = [];
  const uploadIncompletoOuFalho: ItemReconciliacaoAcervo[] = [];
  const duplicados: ItemReconciliacaoAcervo[] = [];

  const objetosPorPath = new Map<string, ObjetoStorageSnapshot>();
  const objetosPorHash = new Map<string, ObjetoStorageSnapshot[]>();

  for (const obj of objetosStorage) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeAcervoStorageKey(obj.path);
    } catch {
      continue;
    }
    objetosPorPath.set(normalizedPath, { ...obj, path: normalizedPath });

    const inferredHash = (obj.hashConteudoMetadata ?? extractHashFromStoragePath(normalizedPath))?.toLowerCase() ?? null;
    if (inferredHash) {
      const list = objetosPorHash.get(inferredHash) ?? [];
      list.push({ ...obj, path: normalizedPath });
      objetosPorHash.set(inferredHash, list);
    }
  }

  const registrosPorPath = new Map<string, RegistroAcervoSnapshot[]>();
  const registrosPorHash = new Map<string, RegistroAcervoSnapshot[]>();

  for (const reg of registrosDb) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeAcervoStorageKey(reg.filePath);
    } catch {
      normalizedPath = reg.filePath.trim();
    }

    const byPath = registrosPorPath.get(normalizedPath) ?? [];
    byPath.push(reg);
    registrosPorPath.set(normalizedPath, byPath);

    const normalizedHash = reg.hashConteudo.trim().toLowerCase();
    const byHash = registrosPorHash.get(normalizedHash) ?? [];
    byHash.push(reg);
    registrosPorHash.set(normalizedHash, byHash);
  }

  // 1. Duplicidades no banco (mesmo hashConteudo ou mesmo filePath)
  for (const [hash, regs] of registrosPorHash.entries()) {
    if (regs.length > 1) {
      duplicados.push({
        categoria: 'duplicados',
        subtipo: 'hash_duplicado_db',
        arquivoIds: regs.map((r) => r.id),
        pathsStorage: Array.from(new Set(regs.map((r) => r.filePath))),
        hashConteudo: hash,
        recuperavelNoReenvio: false,
        acaoRecomendada:
          'Auditar registros com mesmo hash_conteudo em acervo_arquivos antes de consolidar referências.',
      });
    }
  }

  for (const [pathKey, regs] of registrosPorPath.entries()) {
    if (regs.length > 1) {
      duplicados.push({
        categoria: 'duplicados',
        subtipo: 'filepath_duplicado_db',
        arquivoIds: regs.map((r) => r.id),
        pathsStorage: [pathKey],
        hashConteudo: regs[0]?.hashConteudo ?? null,
        recuperavelNoReenvio: false,
        acaoRecomendada:
          'Auditar múltiplos registros apontando para o mesmo file_path no banco de dados.',
      });
    }
  }

  // 2. Múltiplos objetos no Storage para o mesmo hash
  for (const [hash, objs] of objetosPorHash.entries()) {
    if (objs.length > 1) {
      duplicados.push({
        categoria: 'duplicados',
        subtipo: 'multiplos_objetos_mesmo_hash_storage',
        arquivoIds: (registrosPorHash.get(hash) ?? []).map((r) => r.id),
        pathsStorage: objs.map((o) => o.path),
        hashConteudo: hash,
        recuperavelNoReenvio: false,
        acaoRecomendada:
          'Preservar objetos existentes e verificar qual caminho está vinculado em acervo_arquivos antes de qualquer limpeza manual.',
      });
    }
  }

  let integros = 0;

  // 3. Avaliação de cada registro em acervo_arquivos
  for (const reg of registrosDb) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeAcervoStorageKey(reg.filePath);
    } catch {
      normalizedPath = reg.filePath.trim();
    }
    const normalizedHash = reg.hashConteudo.trim().toLowerCase();
    const objeto = objetosPorPath.get(normalizedPath);

    if (!objeto) {
      metadadosSemObjeto.push({
        categoria: 'metadados_sem_objeto',
        subtipo: 'db_sem_objeto_storage',
        arquivoIds: [reg.id],
        pathsStorage: [normalizedPath],
        hashConteudo: normalizedHash,
        recuperavelNoReenvio: true,
        acaoRecomendada:
          'Objeto ausente no Storage para registro existente. Reenviar o PDF correspondente ou restaurar objeto a partir de backup.',
      });
      continue;
    }

    const hashExtraido = (
      objeto.hashConteudoMetadata ?? extractHashFromStoragePath(objeto.path)
    )?.toLowerCase();

    const tamanhoInvalido =
      objeto.tamanhoBytes === null ||
      objeto.tamanhoBytes <= 0 ||
      objeto.tamanhoBytes > MAX_PDF_BYTES ||
      objeto.tamanhoBytes !== reg.tamanhoBytes;
    const mimeInvalido =
      (objeto.mime !== null && objeto.mime !== 'application/pdf') ||
      reg.mime !== 'application/pdf';
    const hashDivergente = Boolean(hashExtraido && hashExtraido !== normalizedHash);
    const statusFalho =
      reg.statusProcessamento === 'falhou' ||
      reg.statusProcessamento === 'erro' ||
      Boolean(reg.erroProcessamento);

    if (hashDivergente) {
      uploadIncompletoOuFalho.push({
        categoria: 'upload_incompleto_ou_falho',
        subtipo: 'hash_divergente',
        arquivoIds: [reg.id],
        pathsStorage: [objeto.path],
        hashConteudo: normalizedHash,
        recuperavelNoReenvio: false,
        acaoRecomendada:
          'Divergência entre hash do registro e hash identificado no Storage. Inspecionar manualmente sem sobrescrever.',
      });
      continue;
    }

    if (tamanhoInvalido || mimeInvalido) {
      uploadIncompletoOuFalho.push({
        categoria: 'upload_incompleto_ou_falho',
        subtipo: 'tamanho_ou_mime_divergente',
        arquivoIds: [reg.id],
        pathsStorage: [objeto.path],
        hashConteudo: normalizedHash,
        recuperavelNoReenvio: true,
        acaoRecomendada:
          'Objeto com tamanho ou MIME divergente do registrado em acervo_arquivos. Verificar integridade do PDF.',
      });
      continue;
    }

    if (statusFalho) {
      uploadIncompletoOuFalho.push({
        categoria: 'upload_incompleto_ou_falho',
        subtipo: 'status_processamento_falho',
        arquivoIds: [reg.id],
        pathsStorage: [objeto.path],
        hashConteudo: normalizedHash,
        recuperavelNoReenvio: true,
        acaoRecomendada:
          'Upload e metadados íntegros, mas pipeline de ingestão falhou. Elegível para reprocessamento futuro (F1.11).',
      });
      continue;
    }

    integros++;
  }

  // 4. Avaliação de objetos presentes no Storage sem registro correspondente em acervo_arquivos
  for (const [pathKey, objeto] of objetosPorPath.entries()) {
    if (registrosPorPath.has(pathKey)) {
      continue;
    }

    const hashExtraido = (
      objeto.hashConteudoMetadata ?? extractHashFromStoragePath(pathKey)
    )?.toLowerCase() ?? null;
    const objetoIntegro =
      objeto.tamanhoBytes !== null &&
      objeto.tamanhoBytes > 0 &&
      objeto.tamanhoBytes <= MAX_PDF_BYTES &&
      (objeto.mime === null || objeto.mime === 'application/pdf') &&
      Boolean(hashExtraido);

    objetoSemMetadados.push({
      categoria: 'objeto_sem_metadados',
      subtipo: objetoIntegro ? 'storage_orfao_recuperavel_por_hash' : 'storage_orfao_sem_db',
      arquivoIds: [],
      pathsStorage: [pathKey],
      hashConteudo: hashExtraido,
      recuperavelNoReenvio: objetoIntegro,
      acaoRecomendada: objetoIntegro
        ? 'Objeto órfão íntegro no Storage (possível falha de INSERT anterior). O reenvio do mesmo PDF adotará o objeto de forma idempotente.'
        : 'Objeto sem registro em acervo_arquivos. Preservar até auditoria manual pelo responsável.',
    });

    if (!objetoIntegro) {
      uploadIncompletoOuFalho.push({
        categoria: 'upload_incompleto_ou_falho',
        subtipo: 'tamanho_ou_mime_divergente',
        arquivoIds: [],
        pathsStorage: [pathKey],
        hashConteudo: hashExtraido,
        recuperavelNoReenvio: false,
        acaoRecomendada:
          'Objeto órfão no Storage com metadados incompletos ou inválidos. Não excluir automaticamente; auditar manualmente.',
      });
    }
  }

  return {
    geradoEm: new Date().toISOString(),
    somenteLeitura: true,
    exclusaoAutomaticaExecutada: false,
    totais: {
      registrosDb: registrosDb.length,
      objetosStorage: objetosPorPath.size,
      integros,
      metadadosSemObjeto: metadadosSemObjeto.length,
      objetoSemMetadados: objetoSemMetadados.length,
      uploadIncompletoOuFalho: uploadIncompletoOuFalho.length,
      duplicados: duplicados.length,
    },
    classificacoes: {
      metadados_sem_objeto: metadadosSemObjeto,
      objeto_sem_metadados: objetoSemMetadados,
      upload_incompleto_ou_falho: uploadIncompletoOuFalho,
      duplicados,
    },
  };
}
