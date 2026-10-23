import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withRlsContext,
  withAuthenticatedUser,
  withStudentContext,
  withResponsibleContext,
  withAuthenticatedRead,
  applyRlsContext,
  isRlsEnforced,
  RlsContextError,
  type DrizzleTransaction
} from './rls-context';
import { db } from './index';
import * as authModule from '../lib/authorization';

describe('RLS Context Integration Helpers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('isRlsEnforced', () => {
    it('detecta flag RLS_ENFORCED ou ENFORCE_RLS', () => {
      delete process.env.RLS_ENFORCED;
      delete process.env.ENFORCE_RLS;
      expect(isRlsEnforced()).toBe(false);

      process.env.RLS_ENFORCED = 'true';
      expect(isRlsEnforced()).toBe(true);

      process.env.RLS_ENFORCED = 'false';
      process.env.ENFORCE_RLS = 'true';
      expect(isRlsEnforced()).toBe(true);
    });
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
        execute: vi.fn().mockImplementation(async (q: any) => {
          const sqlStr = String(q?.queryChunks?.[0]?.value || q || '');
          if (/to_regprocedure/i.test(sqlStr)) {
            return [{ exists: true, curr_role: 'postgres' }];
          }
          return [];
        })
      };

      const spyTransaction = vi.spyOn(db, 'transaction').mockImplementation(async (callback) => {
        return await (callback as (tx: unknown) => unknown)(mockTx);
      });

      const testId = '10000000-0000-4000-8000-000000000001';
      const result = await withRlsContext(testId, 'estudante', async (tx) => {
        expect(tx).toBe(mockTx);
        return 'sucesso_operacao';
      });

      expect(result).toBe('sucesso_operacao');
      expect(spyTransaction).toHaveBeenCalledTimes(1);
      expect(mockTx.execute).toHaveBeenCalled();

      spyTransaction.mockRestore();
    });

    it('assegura chamada a clear_context mesmo quando o callback lança erro', async () => {
      const mockTx = {
        execute: vi.fn().mockImplementation(async (q: any) => {
          const sqlStr = String(q?.queryChunks?.[0]?.value || q || '');
          if (/to_regprocedure/i.test(sqlStr)) {
            return [{ exists: true, curr_role: 'postgres' }];
          }
          return [];
        })
      };

      const spyTransaction = vi.spyOn(db, 'transaction').mockImplementation(async (callback) => {
        return await (callback as (tx: unknown) => unknown)(mockTx);
      });

      const testId = '10000000-0000-4000-8000-000000000001';
      await expect(
        withRlsContext(testId, 'responsavel', async () => {
          throw new Error('Falha simulada na query');
        })
      ).rejects.toThrow('Falha simulada na query');

      expect(mockTx.execute).toHaveBeenCalled();

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
      const spyTx = vi.spyOn(db, 'transaction').mockImplementation(async (cb) => (cb as (tx: unknown) => unknown)(mockTx));

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
      const spyTx = vi.spyOn(db, 'transaction').mockImplementation(async (cb) => (cb as (tx: unknown) => unknown)(mockTx));

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
      const spyTx = vi.spyOn(db, 'transaction').mockImplementation(async (cb) => (cb as (tx: unknown) => unknown)(mockTx));

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

  describe('applyRlsContext', () => {
    it('valida argumentos obrigatórios perfilId e papel', async () => {
      const mockTx = { execute: vi.fn() };
      await expect(applyRlsContext(mockTx as unknown as DrizzleTransaction, '', 'estudante')).rejects.toThrow(
        'RLS Context Error: perfilId é obrigatório'
      );
      await expect(applyRlsContext(mockTx as unknown as DrizzleTransaction, '10000000-0000-4000-8000-000000000001', 'admin')).rejects.toThrow(
        'RLS Context Error: papel inválido'
      );
    });

    it('executa SELECT medicina.set_context se tx.execute estiver disponível e procedure existir', async () => {
      const mockTx = {
        execute: vi.fn().mockImplementation(async (q: any) => {
          const sqlStr = String(q?.queryChunks?.[0]?.value || q || '');
          if (/to_regprocedure/i.test(sqlStr)) {
            return [{ exists: true, curr_role: 'postgres' }];
          }
          return [];
        })
      };
      await applyRlsContext(mockTx as unknown as DrizzleTransaction, '10000000-0000-4000-8000-000000000001', 'estudante');
      expect(mockTx.execute).toHaveBeenCalledTimes(2);
    });

    it('ignora em ambiente de desenvolvimento sem RLS obrigatório quando procedure não existe', async () => {
      delete process.env.RLS_ENFORCED;
      delete process.env.ENFORCE_RLS;
      const mockTx = {
        execute: vi.fn().mockResolvedValue([{ exists: false, curr_role: 'postgres' }])
      };
      await expect(
        applyRlsContext(mockTx as unknown as DrizzleTransaction, '10000000-0000-4000-8000-000000000001', 'responsavel')
      ).resolves.toBeUndefined();
    });

    it('lança erro explícito (fail-closed) quando RLS é obrigatório e procedure não existe', async () => {
      process.env.RLS_ENFORCED = 'true';
      const mockTx = {
        execute: vi.fn().mockResolvedValue([{ exists: false, curr_role: 'postgres' }])
      };
      await expect(
        applyRlsContext(mockTx as unknown as DrizzleTransaction, '10000000-0000-4000-8000-000000000001', 'estudante')
      ).rejects.toThrow(RlsContextError);
    });

    it('lança erro explícito se executado sob role medicina_app e procedure não existe', async () => {
      delete process.env.RLS_ENFORCED;
      const mockTx = {
        execute: vi.fn().mockResolvedValue([{ exists: false, curr_role: 'medicina_app' }])
      };
      await expect(
        applyRlsContext(mockTx as unknown as DrizzleTransaction, '10000000-0000-4000-8000-000000000001', 'estudante')
      ).rejects.toThrow('RLS Fatal Error: medicina.set_context não está disponível');
    });
  });

  describe('withAuthenticatedRead', () => {
    it('executa callback dentro de transação com contexto RLS do usuário', async () => {
      const mockUser = {
        id: '10000000-0000-4000-8000-000000000001',
        nome: 'Estudante Teste',
        email: 'estudante@medicina2029.com.br',
        papel: 'estudante' as const
      };

      vi.spyOn(authModule, 'requireAuthenticatedProfile').mockResolvedValue(mockUser);

      const mockTx = {
        execute: vi.fn().mockImplementation(async (q: any) => {
          const sqlStr = String(q?.queryChunks?.[0]?.value || q || '');
          if (/to_regprocedure/i.test(sqlStr)) {
            return [{ exists: true, curr_role: 'postgres' }];
          }
          return [];
        })
      };

      const spyTx = vi.spyOn(db, 'transaction').mockImplementation(async (callback) => {
        return await (callback as (tx: unknown) => unknown)(mockTx);
      });

      const res = await withAuthenticatedRead(async ({ perfil, tx }) => {
        expect(perfil).toEqual(mockUser);
        expect(tx).toBe(mockTx);
        return 'leitura_sucesso';
      });

      expect(res).toBe('leitura_sucesso');
      expect(mockTx.execute).toHaveBeenCalled();
      spyTx.mockRestore();
    });
  });
});
