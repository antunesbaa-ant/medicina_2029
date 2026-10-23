import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registrarCheckin } from './checkin';
import { registrarErroManual, resolverErro } from './cadernoErros';

const mocks = vi.hoisted(() => ({
  returningResult: [] as unknown[],
  returningError: null as Error | null,
  insert: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../lib/authorization', () => ({
  requireRole: vi.fn().mockResolvedValue({ id: 'perfil-1', papel: 'estudante' }),
}));

vi.mock('../../db', () => {
  const query = {
    values: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn(async () => {
      if (mocks.returningError) throw mocks.returningError;
      return mocks.returningResult;
    }),
  };
  mocks.insert.mockReturnValue(query);
  mocks.update.mockReturnValue(query);
  const dbObj = {
    insert: mocks.insert,
    update: mocks.update,
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(dbObj)),
  };
  return { db: dbObj };
});

describe('F1.07 - falhas operacionais nas fronteiras públicas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.returningResult = [];
    mocks.returningError = null;
  });

  it('não confirma check-in quando o INSERT afeta zero registros', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await registrarCheckin({ horasSono: 8, exercicioMin: 20, humor: 4, energia: 4 });
    expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_ERROR' });
    consoleError.mockRestore();
  });

  it('retorna erro público sanitizado quando o banco falha', async () => {
    mocks.returningError = new Error('postgresql://user:secret@host/db SQL INSERT');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await registrarCheckin({ horasSono: 8, exercicioMin: 20, humor: 4, energia: 4 });
    expect(result).toEqual({
      ok: false,
      code: 'PERSISTENCE_ERROR',
      message: 'Não foi possível registrar o check-in. Tente novamente.',
    });
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('secret');
    consoleError.mockRestore();
  });

  it('confirma check-in somente com registro retornado', async () => {
    mocks.returningResult = [{ id: 'checkin-1' }];
    await expect(
      registrarCheckin({ horasSono: 8, exercicioMin: 20, humor: 4, energia: 4 })
    ).resolves.toEqual({ ok: true, data: { checkin: { id: 'checkin-1' } } });
  });

  it('não usa IDs fictícios para registro manual de erro', async () => {
    const result = await registrarErroManual({
      descricaoLivre: 'Erro',
      topicoId: 'topico-1',
      disciplinaId: 'disciplina-1',
      estilo: 'enem',
      tipoErro: 'conteudo',
      conceitoCorreto: 'Conceito',
    });
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('diferencia UPDATE sem linha de uma atualização confirmada e valida UUID (F1.09)', async () => {
    const ERRO_INEXISTENTE_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
    const ERRO_1_ID = 'bbbbbbbb-1111-4111-8111-111111111111';
    await expect(resolverErro('inexistente')).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(mocks.update).not.toHaveBeenCalled();

    await expect(resolverErro(ERRO_INEXISTENTE_ID)).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
    mocks.returningResult = [{ id: ERRO_1_ID }];
    await expect(resolverErro(ERRO_1_ID)).resolves.toEqual({ ok: true, data: { erroId: ERRO_1_ID } });
  });

  it('rejeita check-in com limites numéricos inválidos sem escrita (F1.09)', async () => {
    await expect(
      registrarCheckin({ horasSono: 30, exercicioMin: 20, humor: 4, energia: 4 })
    ).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    await expect(
      registrarCheckin({ horasSono: 8, exercicioMin: 20, humor: 6, energia: 4 })
    ).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
