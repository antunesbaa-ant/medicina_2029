import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  select: vi.fn(),
  queryResults: [] as unknown[][]
}));

vi.mock('next-auth', () => ({
  getServerSession: mocks.getServerSession
}));

vi.mock('./auth-options', () => ({
  authOptions: {}
}));

vi.mock('../db', () => ({
  db: {
    select: mocks.select
  }
}));

import {
  assertOwnership,
  AuthorizationError,
  requireAuthenticatedProfile,
  requireManagedStudentProfile,
  requireRole,
  requireStudentScope
} from './authorization';

const estudanteAuthUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const estudante = {
  id: '11111111-1111-4111-8111-111111111111',
  nome: 'Estudante',
  email: 'estudante@example.test',
  papel: 'estudante' as const
};

const responsavel = {
  id: '22222222-2222-4222-8222-222222222222',
  nome: 'Responsável',
  email: 'responsavel@example.test',
  papel: 'responsavel' as const
};

function setSession(id: string, role?: 'estudante' | 'responsavel') {
  mocks.getServerSession.mockResolvedValue({
    user: { id, role }
  });
}

describe('authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryResults.length = 0;
    mocks.select.mockImplementation(() => {
      const query = {
        innerJoin: () => query,
        where: () => query,
        limit: async () => mocks.queryResults.shift() ?? []
      };
      return { from: () => query };
    });
  });

  it('nega quando não existe sessão sem consultar o banco', async () => {
    mocks.getServerSession.mockResolvedValue(null);

    await expect(requireAuthenticatedProfile()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'Autenticação necessária.'
    });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('resolve a identidade exclusivamente por perfis.id', async () => {
    setSession(estudante.id);
    mocks.queryResults.push([estudante]);

    await expect(requireAuthenticatedProfile()).resolves.toEqual(estudante);
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.select.mock.calls[0][0]).not.toHaveProperty('authUserId');
  });

  it('nega sessão cujo id não corresponde a um perfil', async () => {
    setSession(estudanteAuthUserId);
    mocks.queryResults.push([]);

    await expect(requireAuthenticatedProfile()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED'
    });
  });

  it('usa o papel recarregado do banco e ignora a claim divergente', async () => {
    setSession(estudante.id, 'responsavel');
    mocks.queryResults.push([estudante]);

    await expect(requireRole('responsavel')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Acesso não autorizado.'
    });
  });

  it('mantém o acesso do papel autorizado', async () => {
    setSession(responsavel.id, 'responsavel');
    mocks.queryResults.push([responsavel]);

    await expect(requireRole('responsavel')).resolves.toEqual(responsavel);
  });

  it('nega falha de banco sem expor detalhes internos', async () => {
    setSession(estudante.id);
    mocks.select.mockImplementationOnce(() => {
      throw new Error('database connection string with sensitive details');
    });

    await expect(requireAuthenticatedProfile()).rejects.toEqual(
      expect.objectContaining({
        name: 'AuthorizationError',
        code: 'UNAUTHENTICATED',
        message: 'Autenticação necessária.'
      })
    );
  });

  it('valida propriedade sem revelar identificadores', () => {
    expect(() => assertOwnership(estudante.id, estudante.id)).not.toThrow();
    expect(() => assertOwnership(estudante.id, responsavel.id)).toThrowError(
      new AuthorizationError('FORBIDDEN')
    );
  });

  it('retorna o único perfil estudante para um responsável', async () => {
    setSession(responsavel.id, 'responsavel');
    mocks.queryResults.push([responsavel], [estudante]);

    await expect(requireManagedStudentProfile()).resolves.toEqual(estudante);
  });

  it('mantém a própria identidade da estudante como escopo estudantil', async () => {
    setSession(estudante.id, 'estudante');
    mocks.queryResults.push([estudante]);

    await expect(requireStudentScope()).resolves.toEqual(estudante);
    expect(mocks.select).toHaveBeenCalledOnce();
  });

  it('resolve o escopo estudantil do responsável exclusivamente pelo vínculo', async () => {
    setSession(responsavel.id, 'responsavel');
    mocks.queryResults.push([responsavel], [estudante]);

    await expect(requireStudentScope()).resolves.toEqual(estudante);
    expect(mocks.select).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['nenhum', []],
    ['mais de um', [estudante, { ...estudante, id: '33333333-3333-4333-8333-333333333333' }]]
  ])('nega sem fallback global quando existe %s vínculo de estudante gerenciado', async (_cenario, estudantes) => {
    setSession(responsavel.id, 'responsavel');
    mocks.queryResults.push([responsavel], estudantes);

    await expect(requireManagedStudentProfile()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Acesso não autorizado.'
    });
  });
});
