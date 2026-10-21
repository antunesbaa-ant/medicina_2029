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
      'onConflictDoNothing',
      'for',
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
    execute: vi.fn().mockResolvedValue([]),
    transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(db)),
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

const DISCIPLINA_1_ID = '00000000-0000-0000-0000-000000000001';
const BLOCO_1_ID = 'b1b1b1b1-1111-4111-8111-111111111101';
const TOPICO_1_ID = '11111111-1111-4111-8111-111111111101';
const SESSAO_ALHEIA_ID = '22222222-2222-4222-8222-222222222222';
const QUESTAO_ALHEIA_ID = '33333333-3333-4333-8333-333333333333';
const TENTATIVA_ALHEIA_ID = '44444444-4444-4444-8444-444444444444';
const ERRO_ALHEIO_ID = '55555555-5555-4555-8555-555555555555';
const CARD_ALHEIO_ID = '66666666-6666-4666-8666-666666666666';

const uploadArgs = [
  DISCIPLINA_1_ID,
  'Livro Teste',
  'livro',
  1,
  'enem',
  'livro.pdf',
  Buffer.from('%PDF-1.4\npdf de teste\n%%EOF').toString('base64'),
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
    await expect(iniciarSessao(BLOCO_1_ID, TOPICO_1_ID)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

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

    await expect(iniciarSessao(BLOCO_1_ID, TOPICO_1_ID)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(dbDouble.db.insert).not.toHaveBeenCalled();
  });

  it('usa a identidade da sessão no upload autorizado e enfileira job durável com o mesmo owner', async () => {
    authState.profile = responsavel;
    vi.stubEnv('SUPABASE_ANON_KEY', 'chave-de-teste');
    dbDouble.queues.select.push([]);
    dbDouble.queues.insert.push(
      [{ id: 'arquivo-1' }],
      [{ id: 'job-1', status: 'aguardando', etapaAtual: 'extracao' }]
    );

    const resultado = await enviarArquivo(...uploadArgs);

    expect(resultado).toMatchObject({ ok: true, data: { arquivoId: 'arquivo-1' } });
    expect(dbDouble.valuesCalls).toContainEqual(expect.objectContaining({
      enviadoPor: responsavel.id,
    }));
    expect(dbDouble.valuesCalls).toContainEqual(expect.objectContaining({
      arquivoId: 'arquivo-1',
      enviadoPor: responsavel.id,
    }));
    expect(storageMocks.uploadToSupabaseStorage).toHaveBeenCalledOnce();
    expect(dbDouble.db.update).not.toHaveBeenCalled();
  });

  it('não conclui nem gera registros derivados para uma sessão alheia', async () => {
    authState.profile = estudante;
    dbDouble.queues.select.push([]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(concluirSessao(SESSAO_ALHEIA_ID, {
      etapaAtingida: 'registro',
      errosParaRegistrar: [{
        questaoId: QUESTAO_ALHEIA_ID,
        tentativaId: TENTATIVA_ALHEIA_ID,
        tipoErro: 'conteudo',
      }],
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(dbDouble.db.update).not.toHaveBeenCalled();
    expect(dbDouble.db.insert).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('não trata como sucesso a atualização de uma sessão alheia', async () => {
    authState.profile = estudante;
    dbDouble.queues.update.push([]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(atualizarSessao(SESSAO_ALHEIA_ID, {
      segundosEfetivos: 120,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(dbDouble.db.insert).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('não altera erro ou card indicado por ID arbitrário', async () => {
    authState.profile = estudante;
    dbDouble.queues.update.push([]);

    const erro = await resolverErro(ERRO_ALHEIO_ID);
    expect(erro).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Registro não encontrado ou acesso não permitido.',
    });
    expect(dbDouble.db.insert).not.toHaveBeenCalled();

    dbDouble.db.update.mockClear();
    dbDouble.queues.select.push([]);
    const card = await registrarRevisaoCard(CARD_ALHEIO_ID, 'good', 1_000);

    expect(card).toEqual({
      sucesso: false,
      code: 'NOT_FOUND',
      mensagem: 'Registro não encontrado ou acesso não permitido.',
    });
    expect(dbDouble.db.update).not.toHaveBeenCalled();
    expect(dbDouble.db.insert).not.toHaveBeenCalled();
  });

  it('mantém o acesso legítimo do estudante e grava seu perfil efetivo', async () => {
    authState.profile = estudante;
    dbDouble.queues.select.push(
      [],
      [{
        blocoId: BLOCO_1_ID,
        estudantePerfilId: estudante.id,
        blocoDisciplinaId: DISCIPLINA_1_ID,
        topicoDisciplinaId: DISCIPLINA_1_ID,
      }],
    );
    dbDouble.queues.insert.push([{ id: 'sessao-autorizada' }]);

    await expect(iniciarSessao(BLOCO_1_ID, TOPICO_1_ID)).resolves.toBe('sessao-autorizada');
    expect(dbDouble.valuesCalls).toContainEqual(expect.objectContaining({
      perfilId: estudante.id,
      cicloBlocoId: BLOCO_1_ID,
      topicoId: TOPICO_1_ID,
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
