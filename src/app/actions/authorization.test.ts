import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enviarArquivo } from './acervo';
import { exportarDadosCompletos } from './backup';
import { resolverErro } from './cadernoErros';
import { registrarRevisaoCard } from './fsrs';
import { atualizarSessao, concluirSessao, iniciarSessao } from './sessao';

type TestRole = 'estudante' | 'responsavel';

interface TestProfile {
  id: string;
  authUserId: string;
  nome: string;
  email: string | null;
  papel: TestRole;
}

const authState = vi.hoisted(() => ({
  profile: null as TestProfile | null,
}));

const authMocks = vi.hoisted(() => ({
  requireAuthenticatedProfile: vi.fn(),
  requireRole: vi.fn(),
  requireManagedStudentProfile: vi.fn(),
  assertOwnership: vi.fn(),
}));

const dbDouble = vi.hoisted(() => {
  type QueryResult = unknown[] | Error;

  const queues = {
    select: [] as QueryResult[],
    insert: [] as QueryResult[],
    update: [] as QueryResult[],
  };
  const valuesCalls: unknown[] = [];

  const nextResult = (operation: keyof typeof queues): QueryResult => (
    queues[operation].shift() ?? []
  );

  const makeQuery = (result: QueryResult) => {
    const query: Record<string, unknown> = {};
    const chainMethods = [
      'from',
      'where',
      'limit',
      'innerJoin',
      'leftJoin',
      'orderBy',
      'groupBy',
      'set',
      'returning',
      'onConflictDoUpdate',
    ];

    for (const method of chainMethods) {
      query[method] = vi.fn(() => query);
    }

    query.values = vi.fn((value: unknown) => {
      valuesCalls.push(value);
      return query;
    });
    query.then = (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => {
      const promise = result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result);
      return promise.then(resolve, reject);
    };

    return query;
  };

  const db = {
    select: vi.fn(() => makeQuery(nextResult('select'))),
    insert: vi.fn(() => makeQuery(nextResult('insert'))),
    update: vi.fn(() => makeQuery(nextResult('update'))),
    transaction: vi.fn(),
  };

  return { db, queues, valuesCalls };
});

const storageMocks = vi.hoisted(() => ({
  uploadToSupabaseStorage: vi.fn().mockResolvedValue('acervo/teste.pdf'),
}));

vi.mock('../../lib/authorization', () => {
  class AuthorizationError extends Error {
    readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN';

    constructor(code: 'UNAUTHENTICATED' | 'FORBIDDEN') {
      super(code === 'UNAUTHENTICATED' ? 'Autenticação necessária.' : 'Acesso não autorizado.');
      this.name = 'AuthorizationError';
      this.code = code;
    }
  }

  authMocks.requireAuthenticatedProfile.mockImplementation(async () => {
    if (!authState.profile) throw new AuthorizationError('UNAUTHENTICATED');
    return authState.profile;
  });
  authMocks.requireRole.mockImplementation(async (role: TestRole) => {
    if (!authState.profile) throw new AuthorizationError('UNAUTHENTICATED');
    if (authState.profile.papel !== role) throw new AuthorizationError('FORBIDDEN');
    return authState.profile;
  });
  authMocks.requireManagedStudentProfile.mockImplementation(async () => {
    if (!authState.profile) throw new AuthorizationError('UNAUTHENTICATED');
    if (authState.profile.papel !== 'responsavel') throw new AuthorizationError('FORBIDDEN');
    return {
      id: 'estudante-gerenciada',
      authUserId: 'auth-estudante-gerenciada',
      nome: 'Estudante Gerenciada',
      email: null,
      papel: 'estudante' as const,
    };
  });

  return { AuthorizationError, ...authMocks };
});

vi.mock('../../db', () => ({ db: dbDouble.db }));
vi.mock('../../lib/supabaseStorage', () => storageMocks);
vi.mock('../../lib/ingestion', () => ({
  extrairTextoPDF: vi.fn().mockResolvedValue([]),
  segmentarTexto: vi.fn().mockReturnValue([]),
  classificarTópicoChunk: vi.fn(),
  gerarMockEmbedding: vi.fn(),
}));

const estudante: TestProfile = {
  id: 'estudante-1',
  authUserId: 'auth-estudante-1',
  nome: 'Estudante Teste',
  email: null,
  papel: 'estudante',
};

const responsavel: TestProfile = {
  id: 'responsavel-1',
  authUserId: 'auth-responsavel-1',
  nome: 'Responsável Teste',
  email: null,
  papel: 'responsavel',
};

const uploadArgs = [
  'disciplina-1',
  'Livro Teste',
  'livro',
  1,
  'enem',
  'livro.pdf',
  Buffer.from('pdf de teste').toString('base64'),
] as const;

describe('Autorização das Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.profile = null;
    dbDouble.queues.select.length = 0;
    dbDouble.queues.insert.length = 0;
    dbDouble.queues.update.length = 0;
    dbDouble.valuesCalls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('bloqueia usuário não autenticado antes de acessar banco ou Storage', async () => {
    await expect(exportarDadosCompletos()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(enviarArquivo(...uploadArgs)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(iniciarSessao('bloco-1', 'topico-1')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    expect(dbDouble.db.select).not.toHaveBeenCalled();
    expect(dbDouble.db.insert).not.toHaveBeenCalled();
    expect(dbDouble.db.update).not.toHaveBeenCalled();
    expect(dbDouble.db.transaction).not.toHaveBeenCalled();
    expect(storageMocks.uploadToSupabaseStorage).not.toHaveBeenCalled();
  });

  it('impede estudante de executar backup ou upload sem efeitos colaterais', async () => {
    authState.profile = estudante;

    await expect(exportarDadosCompletos()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(enviarArquivo(...uploadArgs)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(dbDouble.db.select).not.toHaveBeenCalled();
    expect(dbDouble.db.insert).not.toHaveBeenCalled();
    expect(dbDouble.db.transaction).not.toHaveBeenCalled();
    expect(storageMocks.uploadToSupabaseStorage).not.toHaveBeenCalled();
  });

  it('impede responsável de iniciar sessão de estudo', async () => {
    authState.profile = responsavel;

    await expect(iniciarSessao('bloco-1', 'topico-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(dbDouble.db.insert).not.toHaveBeenCalled();
  });

  it('usa a identidade da sessão no upload autorizado', async () => {
    authState.profile = responsavel;
    vi.stubEnv('SUPABASE_ANON_KEY', 'chave-de-teste');
    dbDouble.queues.select.push([]);
    dbDouble.queues.insert.push([{ id: 'arquivo-1' }]);

    const resultado = await enviarArquivo(...uploadArgs);

    expect(resultado).toMatchObject({ sucesso: true, arquivoId: 'arquivo-1' });
    expect(dbDouble.valuesCalls).toContainEqual(expect.objectContaining({
      enviadoPor: responsavel.id,
    }));
    expect(storageMocks.uploadToSupabaseStorage).toHaveBeenCalledOnce();

    await vi.waitFor(() => {
      expect(dbDouble.db.update).toHaveBeenCalledTimes(4);
    });
  });

  it('não conclui nem gera registros derivados para uma sessão alheia', async () => {
    authState.profile = estudante;
    dbDouble.queues.select.push([]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(concluirSessao('sessao-alheia', {
      etapaAtingida: 'registro',
      errosParaRegistrar: [{
        questaoId: 'questao-alheia',
        tentativaId: 'tentativa-alheia',
        tipoErro: 'conteudo',
      }],
    })).rejects.toThrow('Não foi possível concluir a sessão.');

    expect(dbDouble.db.update).not.toHaveBeenCalled();
    expect(dbDouble.db.insert).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('não trata como sucesso a atualização de uma sessão alheia', async () => {
    authState.profile = estudante;
    dbDouble.queues.update.push([]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(atualizarSessao('sessao-alheia', {
      segundosEfetivos: 120,
    })).rejects.toThrow('Não foi possível atualizar a sessão.');

    expect(dbDouble.db.insert).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('não altera erro ou card indicado por ID arbitrário', async () => {
    authState.profile = estudante;
    dbDouble.queues.update.push([]);

    const erro = await resolverErro('erro-alheio');
    expect(erro).toEqual({
      sucesso: false,
      mensagem: 'Registro não encontrado ou acesso não permitido.',
    });
    expect(dbDouble.db.insert).not.toHaveBeenCalled();

    dbDouble.db.update.mockClear();
    dbDouble.queues.select.push([]);
    const card = await registrarRevisaoCard('card-alheio', 'good', 1_000);

    expect(card).toEqual({
      sucesso: false,
      mensagem: 'Registro não encontrado ou acesso não permitido.',
    });
    expect(dbDouble.db.update).not.toHaveBeenCalled();
    expect(dbDouble.db.insert).not.toHaveBeenCalled();
  });

  it('mantém o acesso legítimo do estudante e grava seu perfil efetivo', async () => {
    authState.profile = estudante;
    dbDouble.queues.insert.push([{ id: 'sessao-autorizada' }]);

    await expect(iniciarSessao('bloco-1', 'topico-1')).resolves.toBe('sessao-autorizada');
    expect(dbDouble.valuesCalls).toContainEqual(expect.objectContaining({
      perfilId: estudante.id,
      cicloBlocoId: 'bloco-1',
      topicoId: 'topico-1',
    }));
  });

  it('não expõe detalhes sensíveis em erro interno', async () => {
    const segredo = 'token-super-secreto';
    authState.profile = responsavel;
    dbDouble.queues.select.push(new Error(segredo));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let erroRecebido: Error | null = null;
    try {
      await exportarDadosCompletos();
    } catch (error) {
      erroRecebido = error instanceof Error ? error : new Error(String(error));
    }

    expect(erroRecebido?.message).toBe('Falha ao exportar base de dados.');
    expect(erroRecebido?.message).not.toContain(segredo);
    consoleError.mockRestore();
  });
});
