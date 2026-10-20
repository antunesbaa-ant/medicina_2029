import { describe, expect, it, vi } from 'vitest';
import {
  PublicOperationError,
  logOperationalFailure,
  operationFailure,
  operationSuccess,
} from './operation-result';

describe('contrato de resultado operacional', () => {
  it('produz resultados discriminados sem combinações ambíguas', () => {
    expect(operationSuccess({ id: '1' })).toEqual({ ok: true, data: { id: '1' } });
    expect(operationFailure('NOT_FOUND', 'Não encontrado.')).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Não encontrado.',
    });
  });

  it('preserva código público estável em exceções de fronteira', () => {
    const error = new PublicOperationError('PERSISTENCE_ERROR', 'Operação indisponível.');
    expect(error).toMatchObject({ code: 'PERSISTENCE_ERROR', message: 'Operação indisponível.' });
  });

  it('não registra objetos de exceção ou detalhes sensíveis', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logOperationalFailure('redacoes.insert', 'persistence');
    const output = consoleError.mock.calls.flat().join(' ');
    expect(output).toContain('category=persistence');
    expect(output).not.toContain('password');
    expect(output).not.toContain('postgresql://');
    consoleError.mockRestore();
  });
});
