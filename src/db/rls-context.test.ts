import { describe, it, expect, vi } from 'vitest';
import { withRlsContext } from './rls-context';
import { db } from './index';

describe('withRlsContext helper', () => {
  it('valida argumentos obrigatórios (perfilId e papel)', async () => {
    // perfilId vazio é validado em runtime
    await expect(withRlsContext('', 'estudante', async () => {})).rejects.toThrow(
      'RLS Context Error: perfilId é obrigatório'
    );

    // @ts-expect-error teste com papel inválido
    await expect(withRlsContext('10000000-0000-4000-8000-000000000001', 'admin', async () => {})).rejects.toThrow(
      'RLS Context Error: papel inválido'
    );
  });

  it('invoca db.transaction e configura o contexto transacional', async () => {
    const mockTx = {
      execute: vi.fn().mockResolvedValue([])
    };

    const spyTransaction = vi.spyOn(db, 'transaction').mockImplementation(async (callback: any) => {
      return await callback(mockTx);
    });

    const testId = '10000000-0000-4000-8000-000000000001';
    const result = await withRlsContext(testId, 'estudante', async (tx) => {
      expect(tx).toBe(mockTx);
      return 'sucesso_operacao';
    });

    expect(result).toBe('sucesso_operacao');
    expect(spyTransaction).toHaveBeenCalledTimes(1);
    expect(mockTx.execute).toHaveBeenCalledTimes(2); // set_context e clear_context

    spyTransaction.mockRestore();
  });

  it('assegura chamada a clear_context mesmo quando o callback lança erro', async () => {
    const mockTx = {
      execute: vi.fn().mockResolvedValue([])
    };

    const spyTransaction = vi.spyOn(db, 'transaction').mockImplementation(async (callback: any) => {
      return await callback(mockTx);
    });

    const testId = '10000000-0000-4000-8000-000000000001';
    await expect(
      withRlsContext(testId, 'responsavel', async () => {
        throw new Error('Falha simulada na query');
      })
    ).rejects.toThrow('Falha simulada na query');

    expect(mockTx.execute).toHaveBeenCalledTimes(2); // set_context e clear_context no finally

    spyTransaction.mockRestore();
  });
});
