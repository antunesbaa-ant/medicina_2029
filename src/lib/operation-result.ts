export const OPERATION_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'PERSISTENCE_ERROR',
  'EXTERNAL_SERVICE_ERROR',
  'INTERNAL_ERROR',
] as const;

export type OperationErrorCode = (typeof OPERATION_ERROR_CODES)[number];

export type OperationSuccess<T> = {
  ok: true;
  data: T;
};

export type OperationFailure = {
  ok: false;
  code: OperationErrorCode;
  message: string;
};

export type OperationResult<T> = OperationSuccess<T> | OperationFailure;

export function operationSuccess<T>(data: T): OperationSuccess<T> {
  return { ok: true, data };
}

export function operationFailure(
  code: OperationErrorCode,
  message: string
): OperationFailure {
  return { ok: false, code, message };
}

export class PublicOperationError extends Error {
  readonly code: OperationErrorCode;

  constructor(code: OperationErrorCode, message: string) {
    super(message);
    this.name = 'PublicOperationError';
    this.code = code;
  }
}

export type OperationalFailureCategory =
  | 'authentication'
  | 'authorization'
  | 'business'
  | 'persistence'
  | 'external_service'
  | 'internal';

/**
 * Registra somente metadados controlados. Exceções de SDK/banco não devem ser
 * enviadas diretamente ao logger porque podem conter SQL, URLs ou credenciais.
 */
export function logOperationalFailure(
  context: string,
  category: OperationalFailureCategory
): void {
  console.error(`[operational_failure] category=${category} context=${context}`);
}
