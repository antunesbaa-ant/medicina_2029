import { createHash } from 'node:crypto';
import {
  PublicOperationError,
  operationFailure,
  type OperationFailure,
} from './operation-result';

export type ValidationSuccess<T> = {
  ok: true;
  data: T;
};

export type ValidationErrorResult = {
  ok: false;
  message: string;
  field?: string;
};

export type ValidationResult<T> = ValidationSuccess<T> | ValidationErrorResult;

export interface Schema<T> {
  safeParse(input: unknown, fieldPath?: string): ValidationResult<T>;
  parse(input: unknown, fieldPath?: string): T;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IDEMPOTENCY_KEY_REGEX = /^[a-zA-Z0-9._:-]{8,128}$/;

export const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB

/**
 * Campos de identidade ou papel que jamais podem ser aceitos do cliente como
 * prova de autorização ou substituição do perfil autenticado.
 */
const CLIENT_FORBIDDEN_AUTH_FIELDS = new Set([
  'perfilId',
  'perfil_id',
  'estudantePerfilId',
  'estudante_perfil_id',
  'responsavelPerfilId',
  'responsavel_perfil_id',
  'registradaPorPerfilId',
  'registrada_por_perfil_id',
  'authUserId',
  'auth_user_id',
  'enviadoPor',
  'enviado_por',
  'aprovadoPor',
  'aprovado_por',
  'papel',
  'role',
]);

function makeSchema<T>(
  validator: (input: unknown, fieldPath: string) => ValidationResult<T>
): Schema<T> {
  return {
    safeParse(input: unknown, fieldPath = 'payload'): ValidationResult<T> {
      return validator(input, fieldPath);
    },
    parse(input: unknown, fieldPath = 'payload'): T {
      const result = validator(input, fieldPath);
      if (!result.ok) {
        throw new PublicOperationError('VALIDATION_ERROR', result.message);
      }
      return result.data;
    },
  };
}

export function isValidUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    UUID_REGEX.test(value) &&
    value.toLowerCase() !== NIL_UUID
  );
}

export function toValidationFailure<T>(result: ValidationErrorResult): OperationFailure & { data?: T } {
  return operationFailure('VALIDATION_ERROR', result.message);
}

export const v = {
  uuid(label = 'Identificador'): Schema<string> {
    return makeSchema((input, fieldPath) => {
      if (!isValidUuid(input)) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} inválido: esperado UUID válido.`,
        };
      }
      return { ok: true, data: input };
    });
  },

  string(options?: {
    label?: string;
    trim?: boolean;
    min?: number;
    max?: number;
    pattern?: RegExp;
    patternMessage?: string;
  }): Schema<string> {
    const label = options?.label ?? 'Campo de texto';
    const shouldTrim = options?.trim ?? true;
    const min = options?.min ?? 1;
    const max = options?.max ?? 5000;

    return makeSchema((input, fieldPath) => {
      if (typeof input !== 'string') {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} inválido: esperado texto.`,
        };
      }
      if (input.includes('\0')) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} contém caracteres de controle não permitidos.`,
        };
      }

      const normalized = shouldTrim ? input.trim() : input;
      if (normalized.length < min) {
        return {
          ok: false,
          field: fieldPath,
          message:
            min === 1
              ? `${label} é obrigatório e não pode estar vazio.`
              : `${label} deve ter no mínimo ${min} caracteres.`,
        };
      }
      if (normalized.length > max) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} excede o limite máximo de ${max} caracteres.`,
        };
      }
      if (options?.pattern && !options.pattern.test(normalized)) {
        return {
          ok: false,
          field: fieldPath,
          message: options.patternMessage ?? `${label} possui formato inválido.`,
        };
      }

      return { ok: true, data: normalized };
    });
  },

  number(options?: {
    label?: string;
    integer?: boolean;
    min?: number;
    max?: number;
  }): Schema<number> {
    const label = options?.label ?? 'Valor numérico';
    return makeSchema((input, fieldPath) => {
      if (typeof input !== 'number' || !Number.isFinite(input)) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} inválido: esperado número finito.`,
        };
      }
      if (options?.integer && !Number.isInteger(input)) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} inválido: esperado número inteiro.`,
        };
      }
      if (options?.min !== undefined && input < options.min) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} fora dos limites permitidos (mínimo ${options.min}).`,
        };
      }
      if (options?.max !== undefined && input > options.max) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} fora dos limites permitidos (máximo ${options.max}).`,
        };
      }
      return { ok: true, data: input };
    });
  },

  boolean(label = 'Indicador booleano'): Schema<boolean> {
    return makeSchema((input, fieldPath) => {
      if (typeof input !== 'boolean') {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} inválido: esperado booleano.`,
        };
      }
      return { ok: true, data: input };
    });
  },

  enum<const TValues extends readonly [string, ...string[]]>(
    values: TValues,
    label = 'Valor'
  ): Schema<TValues[number]> {
    const allowed = new Set<string>(values);
    return makeSchema((input, fieldPath) => {
      if (typeof input !== 'string' || !allowed.has(input)) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} inválido: valor fora do domínio permitido.`,
        };
      }
      return { ok: true, data: input as TValues[number] };
    });
  },

  date(options?: {
    label?: string;
    minYear?: number;
    maxYear?: number;
  }): Schema<Date> {
    const label = options?.label ?? 'Data';
    const minYear = options?.minYear ?? 2000;
    const maxYear = options?.maxYear ?? 2100;

    return makeSchema((input, fieldPath) => {
      let parsed: Date;
      if (input instanceof Date) {
        parsed = new Date(input.getTime());
      } else if (typeof input === 'string' && input.trim().length > 0 && input.length <= 64) {
        parsed = new Date(input.trim());
      } else {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} inválida.`,
        };
      }

      if (Number.isNaN(parsed.getTime())) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} inválida.`,
        };
      }

      const year = parsed.getUTCFullYear();
      if (year < minYear || year > maxYear) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} fora do intervalo permitido (${minYear}–${maxYear}).`,
        };
      }

      return { ok: true, data: parsed };
    });
  },

  array<T>(
    itemSchema: Schema<T>,
    options?: {
      label?: string;
      min?: number;
      max?: number;
      uniqueBy?: (item: T) => string;
      uniqueMessage?: string;
    }
  ): Schema<T[]> {
    const label = options?.label ?? 'Lista';
    const min = options?.min ?? 0;
    const max = options?.max ?? 100;

    return makeSchema((input, fieldPath) => {
      if (!Array.isArray(input)) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} inválida: esperado array.`,
        };
      }
      if (input.length < min) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} deve conter no mínimo ${min} item(ns).`,
        };
      }
      if (input.length > max) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} excede o máximo de ${max} itens.`,
        };
      }

      const validated: T[] = [];
      const seenKeys = new Set<string>();

      for (let i = 0; i < input.length; i++) {
        const res = itemSchema.safeParse(input[i], `${fieldPath}[${i}]`);
        if (!res.ok) return res;

        if (options?.uniqueBy) {
          const key = options.uniqueBy(res.data);
          if (seenKeys.has(key)) {
            return {
              ok: false,
              field: `${fieldPath}[${i}]`,
              message: options.uniqueMessage ?? `${label} contém itens duplicados.`,
            };
          }
          seenKeys.add(key);
        }

        validated.push(res.data);
      }

      return { ok: true, data: validated };
    });
  },

  object<TShape extends Record<string, Schema<unknown>>>(
    shape: TShape,
    options?: {
      label?: string;
      rejectAuthFields?: boolean;
      refine?: (value: { [K in keyof TShape]: TShape[K] extends Schema<infer U> ? U : never }) => string | null;
    }
  ): Schema<{ [K in keyof TShape]: TShape[K] extends Schema<infer U> ? U : never }> {
    const label = options?.label ?? 'Payload';
    const rejectAuthFields = options?.rejectAuthFields ?? true;

    return makeSchema((input, fieldPath) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input) || input instanceof Date) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} inválido: esperado objeto.`,
        };
      }

      const record = input as Record<string, unknown>;

      if (rejectAuthFields) {
        for (const key of Object.keys(record)) {
          if (CLIENT_FORBIDDEN_AUTH_FIELDS.has(key) && record[key] !== undefined) {
            return {
              ok: false,
              field: `${fieldPath}.${key}`,
              message: `Identificador de autorização não pode ser enviado pelo cliente (${key}).`,
            };
          }
        }
      }

      const output: Record<string, unknown> = {};
      for (const [key, fieldSchema] of Object.entries(shape)) {
        const res = fieldSchema.safeParse(record[key], `${fieldPath}.${key}`);
        if (!res.ok) return res;
        output[key] = res.data;
      }

      const typedOutput = output as {
        [K in keyof TShape]: TShape[K] extends Schema<infer U> ? U : never;
      };

      if (options?.refine) {
        const errorMessage = options.refine(typedOutput);
        if (errorMessage) {
          return {
            ok: false,
            field: fieldPath,
            message: errorMessage,
          };
        }
      }

      return { ok: true, data: typedOutput };
    });
  },

  optional<T>(inner: Schema<T>): Schema<T | undefined> {
    return makeSchema<T | undefined>((input, fieldPath) => {
      if (input === undefined) {
        return { ok: true, data: undefined };
      }
      return inner.safeParse(input, fieldPath);
    });
  },

  nullable<T>(inner: Schema<T>): Schema<T | null> {
    return makeSchema<T | null>((input, fieldPath) => {
      if (input === null) {
        return { ok: true, data: null };
      }
      return inner.safeParse(input, fieldPath);
    });
  },

  jsonObject(options?: { label?: string; maxBytes?: number }): Schema<Record<string, unknown> | unknown[]> {
    const label = options?.label ?? 'Objeto JSON';
    const maxBytes = options?.maxBytes ?? 10_000;

    return makeSchema((input, fieldPath) => {
      if (typeof input !== 'object' || input === null || input instanceof Date) {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} inválido: esperado objeto ou array JSON.`,
        };
      }

      try {
        const serialized = JSON.stringify(input);
        if (!serialized || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
          return {
            ok: false,
            field: fieldPath,
            message: `${label} excede o tamanho máximo permitido (${maxBytes} bytes).`,
          };
        }
      } catch {
        return {
          ok: false,
          field: fieldPath,
          message: `${label} não é serializável em JSON.`,
        };
      }

      return { ok: true, data: input as Record<string, unknown> | unknown[] };
    });
  },

  pdfUpload(options?: { maxBytes?: number }): Schema<{
    nomeArquivo: string;
    fileBuffer: Buffer;
  }> {
    const maxBytes = options?.maxBytes ?? MAX_UPLOAD_FILE_BYTES;
    // Em base64, cada 3 bytes geram 4 caracteres; rejeita antes de alocar buffers gigantes.
    const maxBase64Chars = Math.ceil((maxBytes * 4) / 3) + 64;

    return makeSchema((input, fieldPath) => {
      if (typeof input !== 'object' || input === null) {
        return {
          ok: false,
          field: fieldPath,
          message: 'Dados de arquivo inválidos.',
        };
      }

      const { nomeArquivo, base64Data, fileData } = input as {
        nomeArquivo?: unknown;
        base64Data?: unknown;
        fileData?: unknown;
      };

      if (typeof nomeArquivo !== 'string') {
        return {
          ok: false,
          field: `${fieldPath}.nomeArquivo`,
          message: 'Nome do arquivo é obrigatório.',
        };
      }

      const trimmedName = nomeArquivo.trim();
      if (trimmedName.length < 5 || trimmedName.length > 255) {
        return {
          ok: false,
          field: `${fieldPath}.nomeArquivo`,
          message: 'Nome do arquivo deve ter entre 5 e 255 caracteres.',
        };
      }

      if (
        trimmedName.includes('..') ||
        trimmedName.includes('/') ||
        trimmedName.includes('\\') ||
        /[\x00-\x1f]/.test(trimmedName)
      ) {
        return {
          ok: false,
          field: `${fieldPath}.nomeArquivo`,
          message: 'Nome do arquivo contém caracteres ou caminho inválido.',
        };
      }

      if (!/\.pdf$/i.test(trimmedName)) {
        return {
          ok: false,
          field: `${fieldPath}.nomeArquivo`,
          message: 'Extensão de arquivo inválida. Apenas arquivos .pdf são permitidos.',
        };
      }

      let fileBuffer: Buffer;
      if (fileData !== undefined && fileData !== null) {
        if (Buffer.isBuffer(fileData)) {
          fileBuffer = fileData;
        } else if (fileData instanceof Uint8Array) {
          fileBuffer = Buffer.from(fileData);
        } else if (fileData instanceof ArrayBuffer) {
          fileBuffer = Buffer.from(new Uint8Array(fileData));
        } else {
          return {
            ok: false,
            field: `${fieldPath}.fileData`,
            message: 'Dados binários do arquivo são inválidos.',
          };
        }
      } else {
        if (typeof base64Data !== 'string' || base64Data.trim().length === 0) {
          return {
            ok: false,
            field: `${fieldPath}.base64Data`,
            message: 'O arquivo enviado está vazio ou inválido.',
          };
        }

        const normalizedBase64 = base64Data.trim().replace(/\s+/g, '');
        if (normalizedBase64.length > maxBase64Chars) {
          return {
            ok: false,
            field: `${fieldPath}.base64Data`,
            message: `O arquivo excede o tamanho máximo permitido de ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
          };
        }

        if (normalizedBase64.length % 4 !== 0 || !BASE64_REGEX.test(normalizedBase64)) {
          return {
            ok: false,
            field: `${fieldPath}.base64Data`,
            message: 'Codificação base64 do arquivo é inválida.',
          };
        }

        fileBuffer = Buffer.from(normalizedBase64, 'base64');
      }

      if (fileBuffer.length === 0) {
        return {
          ok: false,
          field: `${fieldPath}.base64Data`,
          message: 'O arquivo enviado está vazio ou inválido.',
        };
      }

      if (fileBuffer.length > maxBytes) {
        return {
          ok: false,
          field: `${fieldPath}.base64Data`,
          message: `O arquivo excede o tamanho máximo permitido de ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
        };
      }

      // 1. Validação de assinatura binária (cabeçalho %PDF-1.x ou %PDF-2.0)
      const headerAscii = fileBuffer.subarray(0, Math.min(fileBuffer.length, 16)).toString('ascii');
      if (!/^%PDF-(1\.[0-7]|2\.0)/.test(headerAscii)) {
        return {
          ok: false,
          field: `${fieldPath}.base64Data`,
          message: 'Tipo de arquivo inválido: o conteúdo não corresponde a um documento PDF válido.',
        };
      }

      // 2. Verificação de marcador de encerramento %%EOF nos últimos 1024 bytes (rejeita upload truncado)
      const tailSlice = fileBuffer.subarray(Math.max(0, fileBuffer.length - 1024)).toString('latin1');
      if (!tailSlice.includes('%%EOF')) {
        return {
          ok: false,
          field: `${fieldPath}.base64Data`,
          message: 'Documento PDF incompleto ou truncado: marcador final %%EOF ausente.',
        };
      }

      // 3. Inspeção defensiva contra tokens de ações ativas/executáveis embutidas em PDF.
      // Limite documentado: streams comprimidos (/ObjStm / FlateDecode) não são descomprimidos
      // nesta camada síncrona; por isso, o arquivo nunca deve ser exposto em URL pública permanente.
      const rawLatin1 = fileBuffer.toString('latin1');
      if (/\/(?:JavaScript|JS|Launch|EmbeddedFiles|RichMedia|XFA)\b/.test(rawLatin1)) {
        return {
          ok: false,
          field: `${fieldPath}.base64Data`,
          message: 'Documento PDF rejeitado por conter recursos ativos ou embutidos não permitidos.',
        };
      }

      return {
        ok: true,
        data: {
          nomeArquivo: trimmedName,
          fileBuffer,
        },
      };
    });
  },
};

// ============================================================================
// SCHEMAS REUTILIZÁVEIS POR DOMÍNIO
// ============================================================================

export const idempotencyKeySchema = v.optional(
  v.string({
    label: 'Chave de idempotência',
    min: 8,
    max: 128,
    pattern: IDEMPOTENCY_KEY_REGEX,
    patternMessage: 'Chave de idempotência deve conter apenas caracteres alfanuméricos, ponto, hífen, dois-pontos ou sublinhado (8–128 chars).',
  })
);

/**
 * Gera um hash SHA-256 canônico do escopo e payload para detecção determinística
 * de replay idêntico versus conflito de parâmetros na mesma chave de idempotência.
 */
export function computeIdempotencyPayloadHash(scope: string, payload: unknown): string {
  const canonicalize = (val: unknown): unknown => {
    if (val instanceof Date) return val.toISOString();
    if (Array.isArray(val)) return val.map(canonicalize);
    if (val && typeof val === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        const vProp = (val as Record<string, unknown>)[k];
        if (vProp !== undefined) {
          sorted[k] = canonicalize(vProp);
        }
      }
      return sorted;
    }
    return val;
  };
  return createHash('sha256')
    .update(`${scope}:${JSON.stringify(canonicalize(payload))}`)
    .digest('hex');
}

// 1. SESSÕES E CRONÔMETRO
export const etapaAtingidaSchema = v.enum(
  ['revisao', 'conteudo', 'questoes', 'registro'] as const,
  'Etapa da sessão'
);

export const tipoErroSchema = v.enum(
  ['conteudo', 'interpretacao', 'distracao', 'calculo', 'tempo'] as const,
  'Tipo de erro'
);

export const iniciarSessaoInputSchema = v.object({
  cicloBlocoId: v.uuid('ID do bloco do ciclo'),
  topicoId: v.uuid('ID do tópico'),
});

export const atualizarSessaoInputSchema = v.object(
  {
    sessaoId: v.uuid('ID da sessão'),
    dados: v.object(
      {
        etapaAtingida: v.optional(etapaAtingidaSchema),
        segundosEfetivos: v.optional(
          v.number({ label: 'Segundos efetivos', integer: true, min: 0, max: 86_400 })
        ),
        segundosPausa: v.optional(
          v.number({ label: 'Segundos de pausa', integer: true, min: 0, max: 86_400 })
        ),
        notaLivre: v.optional(
          v.string({ label: 'Nota livre', trim: false, min: 0, max: 5000 })
        ),
      },
      {
        label: 'Dados de atualização da sessão',
        refine: (dados) => {
          if (
            dados.etapaAtingida === undefined &&
            dados.segundosEfetivos === undefined &&
            dados.segundosPausa === undefined &&
            dados.notaLivre === undefined
          ) {
            return 'Pelo menos um campo deve ser informado para atualizar a sessão.';
          }
          return null;
        },
      }
    ),
  },
  { label: 'Parâmetros de atualização da sessão' }
);

export const erroParaRegistrarSchema = v.object({
  questaoId: v.uuid('ID da questão'),
  tentativaId: v.uuid('ID da tentativa'),
  tipoErro: tipoErroSchema,
  descricaoLivre: v.optional(
    v.string({ label: 'Descrição do erro', min: 1, max: 2000 })
  ),
  conceitoCorreto: v.optional(
    v.string({ label: 'Conceito correto', min: 1, max: 2000 })
  ),
});

export const concluirSessaoInputSchema = v.object({
  sessaoId: v.uuid('ID da sessão'),
  dadosFinalizacao: v.object({
    encerradaEm: v.optional(v.date({ label: 'Data de encerramento', minYear: 2020, maxYear: 2100 })),
    segundosEfetivos: v.optional(
      v.number({ label: 'Segundos efetivos', integer: true, min: 0, max: 86_400 })
    ),
    segundosPausa: v.optional(
      v.number({ label: 'Segundos de pausa', integer: true, min: 0, max: 86_400 })
    ),
    etapaAtingida: etapaAtingidaSchema,
    notaLivre: v.optional(
      v.string({ label: 'Nota livre', trim: false, min: 0, max: 5000 })
    ),
    errosParaRegistrar: v.optional(
      v.array(erroParaRegistrarSchema, {
        label: 'Erros para registrar',
        min: 0,
        max: 100,
        uniqueBy: (item) => item.tentativaId.toLowerCase(),
        uniqueMessage: 'Não é permitido registrar múltiplos erros para a mesma tentativa.',
      })
    ),
  }),
});

export const acaoPonteiroCicloSchema = v.enum(
  ['avancar', 'retroceder', 'reiniciar', 'definir'] as const,
  'Ação do ponteiro do ciclo'
);

export const atualizarPonteiroCicloInputSchema = v.object(
  {
    cicloId: v.uuid('ID do ciclo'),
    acao: acaoPonteiroCicloSchema,
    ordemEsperada: v.optional(
      v.number({ label: 'Ordem esperada', integer: true, min: 1, max: 1000 })
    ),
    ordemAlvo: v.optional(
      v.number({ label: 'Ordem alvo', integer: true, min: 1, max: 1000 })
    ),
  },
  {
    label: 'Parâmetros de atualização do ponteiro do ciclo',
    refine: (dados) => {
      if (dados.acao === 'definir' && dados.ordemAlvo === undefined) {
        return 'Ordem alvo é obrigatória quando a ação do ponteiro é definir.';
      }
      return null;
    },
  }
);

export const obterEstadoSessaoCronometroInputSchema = v.object({
  sessaoId: v.optional(v.uuid('ID da sessão')),
  cicloBlocoId: v.optional(v.uuid('ID do bloco do ciclo')),
  topicoId: v.optional(v.uuid('ID do tópico')),
});

export const sincronizarCheckpointSessaoInputSchema = v.object(
  {
    sessaoId: v.uuid('ID da sessão'),
    dados: v.object({
      etapaAtual: etapaAtingidaSchema,
      etapaEsperada: v.optional(etapaAtingidaSchema),
      segundosEfetivos: v.number({
        label: 'Segundos efetivos',
        integer: true,
        min: 0,
        max: 86_400,
      }),
      segundosPausa: v.number({
        label: 'Segundos de pausa',
        integer: true,
        min: 0,
        max: 86_400,
      }),
      emPausa: v.optional(v.boolean('Estado de pausa')),
      notaLivre: v.optional(
        v.string({ label: 'Nota livre', trim: false, min: 0, max: 5000 })
      ),
    }),
  },
  { label: 'Parâmetros de sincronização de checkpoint da sessão' }
);

// 2. FSRS
export const ratingFsrsSchema = v.enum(
  ['again', 'hard', 'good', 'easy'] as const,
  'Classificação FSRS (rating)'
);

export const registrarRevisaoCardInputSchema = v.object({
  cardId: v.uuid('ID do card'),
  ratingStr: ratingFsrsSchema,
  duracaoMs: v.number({
    label: 'Duração da revisão (ms)',
    integer: true,
    min: 1,
    max: 3_600_000,
  }),
});

// 3. SIMULADOS
export const simuladoAreaInputSchema = v.object(
  {
    area: v.string({ label: 'Nome da área', min: 1, max: 100 }),
    acertos: v.number({ label: 'Acertos da área', integer: true, min: 0, max: 200 }),
    total: v.number({ label: 'Total de questões da área', integer: true, min: 1, max: 200 }),
  },
  {
    label: 'Área do simulado',
    refine: (area) => {
      if (area.acertos > area.total) {
        return 'Os totais e acertos das áreas são inválidos.';
      }
      return null;
    },
  }
);

export const registrarSimuladoInputSchema = v.object({
  formato: v.enum(['enem', 'uece_1fase', 'uece_2fase', 'privada'] as const, 'Formato do simulado'),
  data: v.date({ label: 'Data do simulado', minYear: 2020, maxYear: 2100 }),
  condicoesReais: v.boolean('Condições reais'),
  duracaoMin: v.number({ label: 'Duração do simulado (min)', integer: true, min: 1, max: 720 }),
  local: v.string({ label: 'Local do simulado', min: 1, max: 255 }),
  composicaoProcedencia: v.jsonObject({ label: 'Composição de procedência', maxBytes: 10_000 }),
  areas: v.array(simuladoAreaInputSchema, {
    label: 'Áreas do simulado',
    min: 1,
    max: 10,
    uniqueBy: (item) => item.area.trim().toLowerCase(),
    uniqueMessage: 'Não é permitido informar áreas duplicadas no mesmo simulado.',
  }),
});

// 4. CURADORIA
export const enfileirarGeracaoInputSchema = v.object({
  arquivoId: v.uuid('ID do arquivo'),
});

export const alternativaQuestaoSchema = v.object(
  {
    letra: v.string({ label: 'Letra da alternativa', min: 1, max: 5 }),
    texto: v.string({ label: 'Texto da alternativa', min: 1, max: 2000 }),
  },
  { rejectAuthFields: false }
);

export const dadosEdicaoCuradoriaSchema = v.object(
  {
    titulo: v.optional(v.string({ label: 'Título', min: 1, max: 255 })),
    corpo: v.optional(v.string({ label: 'Corpo', min: 1, max: 50_000 })),
    pergunta: v.optional(v.string({ label: 'Pergunta', min: 1, max: 5000 })),
    resposta: v.optional(v.string({ label: 'Resposta', min: 1, max: 10_000 })),
    enunciado: v.optional(v.string({ label: 'Enunciado', min: 1, max: 20_000 })),
    alternativas: v.optional(
      v.array(alternativaQuestaoSchema, {
        label: 'Alternativas',
        min: 2,
        max: 6,
        uniqueBy: (alt) => alt.letra.trim().toUpperCase(),
        uniqueMessage: 'As alternativas da questão não podem repetir a mesma letra.',
      })
    ),
    gabarito: v.optional(v.string({ label: 'Gabarito', min: 1, max: 10 })),
  },
  {
    label: 'Dados de edição de curadoria',
    rejectAuthFields: false,
  }
);

export const curarItemInputSchema = v.object(
  {
    curadoriaId: v.uuid('ID do item de curadoria'),
    decisao: v.enum(['aprovado', 'rejeitado', 'editado_e_aprovado'] as const, 'Decisão de curadoria'),
    novosDados: v.optional(v.nullable(dadosEdicaoCuradoriaSchema)),
    motivoRejeicao: v.optional(
      v.string({ label: 'Motivo da rejeição', min: 1, max: 2000 })
    ),
  },
  {
    label: 'Parâmetros de curadoria',
    refine: (val) => {
      if (val.decisao === 'editado_e_aprovado') {
        const d = val.novosDados;
        if (
          !d ||
          (d.titulo === undefined &&
            d.corpo === undefined &&
            d.pergunta === undefined &&
            d.resposta === undefined &&
            d.enunciado === undefined &&
            d.alternativas === undefined &&
            d.gabarito === undefined)
        ) {
          return 'Dados de edição são obrigatórios para a decisão editado_e_aprovado.';
        }
      }
      if (val.decisao !== 'rejeitado' && val.motivoRejeicao !== undefined) {
        return 'Motivo de rejeição só pode ser informado quando a decisão for rejeitado.';
      }
      return null;
    },
  }
);

// 5. REDAÇÕES E REPERTÓRIOS
export const registrarRedacaoInputSchema = v.object(
  {
    formato: v.enum(['enem', 'genero_uece'] as const, 'Formato da redação'),
    generoId: v.optional(v.uuid('ID do gênero textual')),
    tema: v.string({ label: 'Tema da redação', min: 1, max: 500 }),
    texto: v.string({ label: 'Texto da redação', min: 1, max: 50_000 }),
    minutosGastos: v.number({ label: 'Minutos gastos', integer: true, min: 1, max: 600 }),
  },
  {
    label: 'Dados da redação',
    refine: (val) => {
      if (val.formato === 'genero_uece' && !val.generoId) {
        return 'O gênero textual é obrigatório para redações no formato genero_uece.';
      }
      if (val.formato === 'enem' && val.generoId) {
        return 'Redações no formato enem não devem especificar gênero da UECE.';
      }
      return null;
    },
  }
);

export const registrarRepertorioInputSchema = v.object({
  referencia: v.string({ label: 'Referência do repertório', min: 1, max: 1000 }),
  resumo2Linhas: v.string({ label: 'Resumo do repertório', min: 1, max: 1000 }),
  temasAplicaveis: v.array(
    v.string({ label: 'Tema aplicável', min: 1, max: 100 }),
    {
      label: 'Temas aplicáveis',
      min: 0,
      max: 20,
      uniqueBy: (t) => t.toLowerCase(),
      uniqueMessage: 'Os temas aplicáveis não devem conter valores duplicados.',
    }
  ),
  categoria: v.string({ label: 'Categoria do repertório', min: 1, max: 100 }),
});

// 6. ACERVO E UPLOADS
export const tipoAcervoMaterialSchema = v.enum(
  [
    'livro',
    'apostila',
    'slide',
    'lista_exercicios',
    'anotacao_aula',
    'prova_oficial',
    'resumo_proprio',
    'outro',
  ] as const,
  'Tipo de material do acervo'
);

export const enviarArquivoInputSchema = v.object({
  disciplinaId: v.uuid('ID da disciplina'),
  titulo: v.string({ label: 'Título do material', min: 1, max: 255 }),
  tipoMaterial: tipoAcervoMaterialSchema,
  serieAlvo: v.number({ label: 'Série alvo', integer: true, min: 0, max: 3 }),
  vestibular: v.string({ label: 'Vestibular', min: 1, max: 50 }),
  upload: v.pdfUpload({ maxBytes: MAX_UPLOAD_FILE_BYTES }),
});

// 7. CHECK-IN, CADERNO DE ERROS E RE-ESTUDO
export const registrarCheckinInputSchema = v.object({
  horasSono: v.number({ label: 'Horas de sono', min: 0, max: 24 }),
  exercicioMin: v.number({ label: 'Minutos de exercício', integer: true, min: 0, max: 1440 }),
  humor: v.number({ label: 'Humor', integer: true, min: 1, max: 5 }),
  energia: v.number({ label: 'Energia', integer: true, min: 1, max: 5 }),
  notaLivre: v.optional(v.string({ label: 'Nota livre', min: 0, max: 2000 })),
});

export const injetarTopicoInputSchema = v.object({
  topicoId: v.uuid('ID do tópico'),
  duracaoMin: v.number({ label: 'Duração do bloco (min)', integer: true, min: 5, max: 240 }),
});
