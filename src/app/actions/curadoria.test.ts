import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enfileirarGeracaoDeArtefatos, obterFilaCuradoria, curarItem } from './curadoria';
import { obterLacunasEstudo } from './lacunas';
import { obterCadernoErros, resolverErro } from './cadernoErros';
import { injetarTopicoNoCiclo } from './reestudo';
import { listarSimulados } from './simulados';
import { AuthorizationError, requireManagedStudentProfile } from '../../lib/authorization';

const FILA_1_ID = '92000000-0000-4000-8000-000000000001';
const FILA_INEXISTENTE_ID = '92000000-0000-4000-8000-000000000099';
const ARQUIVO_1_ID = '60000000-0000-4000-8000-000000000001';
const TOPICO_1_ID = '31000000-0000-4000-8000-000000000001';
const ERRO_1_ID = '72000000-0000-4000-8000-000000000001';
const RESUMO_1_ID = '90000000-0000-4000-8000-000000000001';
const FC_1_ID = '91000000-0000-4000-8000-000000000001';

const dbState = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  returningResults: [] as unknown[][],
  transaction: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
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

  const estudante = {
    id: '10000000-0000-4000-8000-000000000001',
    authUserId: 'a0000000-0000-4000-8000-000000000001',
    nome: 'Estudante Teste',
    email: null,
    papel: 'estudante',
  };
  const responsavel = {
    id: '20000000-0000-4000-8000-000000000001',
    authUserId: 'b0000000-0000-4000-8000-000000000001',
    nome: 'Responsável Teste',
    email: null,
    papel: 'responsavel',
  };

  return {
    AuthorizationError,
    requireAuthenticatedProfile: vi.fn().mockResolvedValue(estudante),
    requireRole: vi.fn().mockImplementation(async (role: string) => (
      role === 'responsavel' ? responsavel : estudante
    )),
    requireManagedStudentProfile: vi.fn().mockResolvedValue(estudante),
    assertOwnership: vi.fn(),
  };
});

// Mock DB
vi.mock('../../db', () => {
  const queryBuilder = {
    insert: dbState.insert.mockReturnThis(),
    update: dbState.update.mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockImplementation(async () => dbState.returningResults.shift() ?? [{ id: 'mock-id' }]),
    execute: vi.fn().mockResolvedValue([]),
    transaction: dbState.transaction,
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown[]) => unknown) => resolve(dbState.selectResults.shift() ?? [])
  };
  dbState.transaction.mockImplementation(async (callback) => callback(queryBuilder));
  return { db: queryBuilder };
});

describe('Fase 3 & 4 - Server Actions Tests', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectResults.length = 0;
    dbState.returningResults.length = 0;
  });

  describe('obterFilaCuradoria', () => {
    it('deve retornar lista de itens pendentes', async () => {
      const list = await obterFilaCuradoria();
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe('curarItem', () => {
    it('deve retornar erro para item inexistente', async () => {
      const res = await curarItem(FILA_INEXISTENTE_ID, 'aprovado');
      expect(res).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });

    it('rejeita UUID inválido, decisão inválida ou editado_e_aprovado sem dados sem tocar no banco', async () => {
      await expect(curarItem('id-invalido', 'aprovado')).resolves.toMatchObject({
        ok: false,
        code: 'VALIDATION_ERROR',
      });
      await expect(curarItem(FILA_1_ID, 'editado_e_aprovado', {})).resolves.toMatchObject({
        ok: false,
        code: 'VALIDATION_ERROR',
      });
      await expect(
        curarItem(FILA_1_ID, 'aprovado', null, 'motivo em aprovacao')
      ).resolves.toMatchObject({
        ok: false,
        code: 'VALIDATION_ERROR',
      });
      expect(dbState.transaction).not.toHaveBeenCalled();
      expect(dbState.update).not.toHaveBeenCalled();
      expect(dbState.insert).not.toHaveBeenCalled();
    });

    it('rejeita edição incompatível com o tipo do artefato sem alterar banco', async () => {
      dbState.selectResults.push([{
        id: FILA_1_ID,
        artefatoTipo: 'resumo',
        artefatoId: RESUMO_1_ID,
        topicoId: TOPICO_1_ID,
        decisao: 'pendente',
      }]);

      const res = await curarItem(FILA_1_ID, 'editado_e_aprovado', {
        pergunta: 'Pergunta de flashcard em um resumo',
      });
      expect(res).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
      expect(dbState.update).not.toHaveBeenCalled();
    });

    it('preserva a negação de autorização ao resolver a estudante vinculada', async () => {
      dbState.selectResults.push([{
        id: FILA_1_ID,
        artefatoTipo: 'flashcard',
        artefatoId: FC_1_ID,
        topicoId: TOPICO_1_ID,
        decisao: 'pendente',
      }]);
      vi.mocked(requireManagedStudentProfile).mockRejectedValueOnce(new AuthorizationError('FORBIDDEN'));

      await expect(curarItem(FILA_1_ID, 'aprovado')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('trata repetição da mesma decisão como sucesso idempotente sem nova escrita', async () => {
      dbState.selectResults.push([{
        id: FILA_1_ID,
        artefatoTipo: 'resumo',
        artefatoId: RESUMO_1_ID,
        topicoId: TOPICO_1_ID,
        decisao: 'aprovado',
      }]);

      const result = await curarItem(FILA_1_ID, 'aprovado');

      expect(result).toMatchObject({ ok: true, data: { decisao: 'aprovado' } });
      expect(dbState.update).not.toHaveBeenCalled();
      expect(dbState.insert).not.toHaveBeenCalled();
    });

    it('recusa decisão concorrente diferente sem alterar o artefato', async () => {
      dbState.selectResults.push([{
        id: FILA_1_ID,
        artefatoTipo: 'resumo',
        artefatoId: RESUMO_1_ID,
        topicoId: TOPICO_1_ID,
        decisao: 'rejeitado',
      }]);

      const result = await curarItem(FILA_1_ID, 'aprovado');

      expect(result).toMatchObject({ ok: false, code: 'CONFLICT' });
      expect(dbState.update).not.toHaveBeenCalled();
    });

    it('retorna falha transacional quando a fila não confirma a decisão', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      dbState.selectResults.push([{
        id: FILA_1_ID,
        artefatoTipo: 'resumo',
        artefatoId: RESUMO_1_ID,
        topicoId: TOPICO_1_ID,
        decisao: 'pendente',
      }]);
      dbState.returningResults.push([{ id: RESUMO_1_ID }], []);

      const result = await curarItem(FILA_1_ID, 'aprovado');

      expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_ERROR' });
      expect(dbState.transaction).toHaveBeenCalledOnce();
      consoleError.mockRestore();
    });
  });

  describe('geração por IA', () => {
    it('rejeita arquivoId inválido antes de consultar o banco', async () => {
      const result = await enfileirarGeracaoDeArtefatos('arquivo-invalido');
      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
      expect(dbState.transaction).not.toHaveBeenCalled();
    });

    it('retorna o lote existente em repetição sem chamar o provedor', async () => {
      const originalKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      dbState.selectResults.push(
        [{ id: ARQUIVO_1_ID, statusProcessamento: 'concluido' }],
        [{ itensGerados: 7 }]
      );

      const result = await enfileirarGeracaoDeArtefatos(ARQUIVO_1_ID);

      expect(result).toMatchObject({ ok: true, data: { itensGerados: 7 } });
      expect(dbState.transaction).not.toHaveBeenCalled();
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalKey;
    });

    it('não cria falso sucesso quando a chave Gemini está ausente', async () => {
      const originalKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      dbState.selectResults.push(
        [{ id: ARQUIVO_1_ID, statusProcessamento: 'concluido' }],
        [],
        [{ texto: 'Conteúdo médico', topicoId: TOPICO_1_ID, topicoNome: 'Fisiologia' }]
      );

      const result = await enfileirarGeracaoDeArtefatos(ARQUIVO_1_ID);

      expect(result).toMatchObject({ ok: false, code: 'EXTERNAL_SERVICE_ERROR' });
      expect(result).not.toHaveProperty('data');
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalKey;
    });
  });

  describe('obterLacunasEstudo', () => {
    it('deve retornar lista de lacunas', async () => {
      const lacunas = await obterLacunasEstudo();
      expect(Array.isArray(lacunas)).toBe(true);
      expect(lacunas.length).toBeGreaterThan(0);
    });
  });

  describe('Caderno de Erros', () => {
    it('deve obter erros do caderno', async () => {
      const erros = await obterCadernoErros();
      expect(Array.isArray(erros)).toBe(true);
    });

    it('deve marcar erro como resolvido', async () => {
      const res = await resolverErro(ERRO_1_ID);
      expect(res.ok).toBe(true);
    });
  });

  describe('Re-estudo', () => {
    it('deve retornar erro ao tentar injetar topico inexistente', async () => {
      const res = await injetarTopicoNoCiclo(TOPICO_1_ID);
      expect(res.sucesso).toBe(false);
    });
  });

  describe('Simulados', () => {
    it('deve listar simulados cadastrados', async () => {
      const simulados = await listarSimulados();
      expect(Array.isArray(simulados)).toBe(true);
    });
  });

});
