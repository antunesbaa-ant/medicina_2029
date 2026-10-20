import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  withRlsContext,
  withAuthenticatedUser,
  withStudentContext,
  withResponsibleContext
} from './rls-context';
import { db } from './index';
import * as authModule from '../lib/authorization';

describe('RLS Context Integration Helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('withRlsContext (baixo nível)', () => {
    it('valida argumentos obrigatórios (perfilId e papel)', async () => {
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

      expect(mockTx.execute).toHaveBeenCalledTimes(2);

      spyTransaction.mockRestore();
    });
  });

  describe('withAuthenticatedUser (alto nível seguro)', () => {
    it('obtém identidade do guard e injeta contexto transacional protegido', async () => {
      const estudanteMock: authModule.AuthorizedProfile = {
        id: '10000000-0000-4000-8000-000000000001',
        nome: 'Estudante Teste',
        email: 'estudante@medicina2029.com.br',
        papel: 'estudante'
      };

      vi.spyOn(authModule, 'requireAuthenticatedProfile').mockResolvedValue(estudanteMock);

      const mockTx = {
        execute: vi.fn().mockResolvedValue([])
      };
      const spyTx = vi.spyOn(db, 'transaction').mockImplementation(async (cb: any) => cb(mockTx));

      const res = await withAuthenticatedUser(async ({ perfil, tx }) => {
        expect(perfil).toEqual(estudanteMock);
        expect(tx).toBe(mockTx);
        return { ok: true, id: perfil.id };
      });

      expect(res).toEqual({ ok: true, id: estudanteMock.id });
      expect(authModule.requireAuthenticatedProfile).toHaveBeenCalledTimes(1);
      expect(mockTx.execute).toHaveBeenCalledTimes(2);

      spyTx.mockRestore();
    });

    it('bloqueia execução e não abre transação se o usuário não estiver autenticado', async () => {
      vi.spyOn(authModule, 'requireAuthenticatedProfile').mockRejectedValue(
        new authModule.AuthorizationError('UNAUTHENTICATED')
      );

      const spyTx = vi.spyOn(db, 'transaction');

      await expect(withAuthenticatedUser(async () => {})).rejects.toThrow(
        'Autenticação necessária.'
      );

      expect(spyTx).not.toHaveBeenCalled();
    });
  });

  describe('withStudentContext (guard estudante)', () => {
    it('permite acesso se o papel for estudante', async () => {
      const estudanteMock: authModule.AuthorizedProfile = {
        id: '10000000-0000-4000-8000-000000000001',
        nome: 'Estudante Teste',
        email: 'estudante@medicina2029.com.br',
        papel: 'estudante'
      };

      vi.spyOn(authModule, 'requireRole').mockResolvedValue(estudanteMock);

      const mockTx = {
        execute: vi.fn().mockResolvedValue([])
      };
      const spyTx = vi.spyOn(db, 'transaction').mockImplementation(async (cb: any) => cb(mockTx));

      const res = await withStudentContext(async ({ perfil }) => {
        return perfil.papel;
      });

      expect(res).toBe('estudante');
      expect(authModule.requireRole).toHaveBeenCalledWith('estudante');

      spyTx.mockRestore();
    });

    it('rejeita com FORBIDDEN se o usuário não for estudante', async () => {
      vi.spyOn(authModule, 'requireRole').mockRejectedValue(
        new authModule.AuthorizationError('FORBIDDEN')
      );

      const spyTx = vi.spyOn(db, 'transaction');

      await expect(withStudentContext(async () => {})).rejects.toThrow(
        'Acesso não autorizado.'
      );

      expect(spyTx).not.toHaveBeenCalled();
    });
  });

  describe('withResponsibleContext (guard responsável)', () => {
    it('permite acesso se o papel for responsável', async () => {
      const responsavelMock: authModule.AuthorizedProfile = {
        id: '20000000-0000-4000-8000-000000000001',
        nome: 'Responsável Teste',
        email: 'responsavel@medicina2029.com.br',
        papel: 'responsavel'
      };

      vi.spyOn(authModule, 'requireRole').mockResolvedValue(responsavelMock);

      const mockTx = {
        execute: vi.fn().mockResolvedValue([])
      };
      const spyTx = vi.spyOn(db, 'transaction').mockImplementation(async (cb: any) => cb(mockTx));

      const res = await withResponsibleContext(async ({ perfil }) => {
        return perfil.papel;
      });

      expect(res).toBe('responsavel');
      expect(authModule.requireRole).toHaveBeenCalledWith('responsavel');

      spyTx.mockRestore();
    });

    it('rejeita com FORBIDDEN se o usuário não for responsável', async () => {
      vi.spyOn(authModule, 'requireRole').mockRejectedValue(
        new authModule.AuthorizationError('FORBIDDEN')
      );

      const spyTx = vi.spyOn(db, 'transaction');

      await expect(withResponsibleContext(async () => {})).rejects.toThrow(
        'Acesso não autorizado.'
      );

      expect(spyTx).not.toHaveBeenCalled();
    });
  });
});
