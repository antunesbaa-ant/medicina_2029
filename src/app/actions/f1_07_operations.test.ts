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
  return { db: { insert: mocks.insert, update: mocks.update } };
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

  it('diferencia UPDATE sem linha de uma atualização confirmada', async () => {
    await expect(resolverErro('inexistente')).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
    mocks.returningResult = [{ id: 'erro-1' }];
    await expect(resolverErro('erro-1')).resolves.toEqual({ ok: true, data: { erroId: 'erro-1' } });
  });
});
