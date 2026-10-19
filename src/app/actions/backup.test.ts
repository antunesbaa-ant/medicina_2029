import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { EXPORT_COLLECTION_FIELDS } from '../../lib/exportacao-segura';
import {
  exportarDadosCompletos,
  restaurarDadosCompletos,
  validarArquivoExportacao
} from './backup';

const authorizationMocks = vi.hoisted(() => ({
  requireRole: vi.fn()
}));

const dbMocks = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  selectError: null as Error | null
}));

vi.mock('../../lib/authorization', () => ({
  requireRole: authorizationMocks.requireRole
}));

vi.mock('../../db', () => {
  const queryBuilder: Record<string, unknown> = {
    select: vi.fn(() => {
      if (dbMocks.selectError) throw dbMocks.selectError;
      return queryBuilder;
    }),
    from: vi.fn(() => queryBuilder),
    then: (resolve: (value: unknown[]) => unknown) => resolve(dbMocks.selectResults.shift() ?? []),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn()
  };
  return { db: queryBuilder };
});

function queueSafeExportRows() {
  dbMocks.selectResults.push([
    {
      id: '11111111-1111-4111-8111-111111111111',
      nome: 'Estudante Fictícia',
      papel: 'estudante',
      criadoEm: new Date('2026-10-19T12:00:00.000Z')
    }
  ]);
  for (let index = 1; index < Object.keys(EXPORT_COLLECTION_FIELDS).length; index += 1) {
    dbMocks.selectResults.push([]);
  }
}

describe('F1.05 — exportação segura e bloqueio da restauração', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
    dbMocks.selectError = null;
    authorizationMocks.requireRole.mockResolvedValue({
      id: 'responsavel-ficticio',
      nome: 'Responsável Fictício',
      email: null,
      papel: 'responsavel'
    });
  });

  it('nega exportação antes de consultar dados quando não autenticado', async () => {
    authorizationMocks.requireRole.mockRejectedValueOnce(new Error('UNAUTHENTICATED'));

    await expect(exportarDadosCompletos()).rejects.toThrow('UNAUTHENTICATED');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('nega exportação antes de consultar dados quando o perfil é estudante', async () => {
    authorizationMocks.requireRole.mockRejectedValueOnce(new Error('FORBIDDEN'));

    await expect(exportarDadosCompletos()).rejects.toThrow('FORBIDDEN');
    expect(authorizationMocks.requireRole).toHaveBeenCalledWith('responsavel');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('permite ao responsável somente a exportação allowlist com manifesto', async () => {
    queueSafeExportRows();

    const result = JSON.parse(await exportarDadosCompletos()) as {
      manifesto: Record<string, unknown>;
      dados: Record<string, unknown[]>;
    };

    expect(result.manifesto).toMatchObject({
      aplicativo: 'Medicina 2029',
      versaoFormato: 1,
      tipoExportacao: 'exportacao_administrativa_pessoal',
      segredosExcluidos: true,
      objetosStorageIncluidos: false,
      restauravelAutomaticamente: false
    });
    expect(Object.keys(result.dados)).toEqual(Object.keys(EXPORT_COLLECTION_FIELDS).sort());
    expect(result.dados.perfis).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        nome: 'Estudante Fictícia',
        papel: 'estudante',
        criadoEm: '2026-10-19T12:00:00.000Z'
      }
    ]);

    const profileSelection = vi.mocked(db.select).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(profileSelection)).toEqual(['id', 'nome', 'papel', 'criadoEm']);
    expect(profileSelection).not.toHaveProperty('passwordHash');
    expect(profileSelection).not.toHaveProperty('authUserId');
    expect(JSON.stringify(result)).not.toContain('passwordHash');
    expect(JSON.stringify(result)).not.toContain('authUserId');
  });

  it('retorna erro público estável sem expor detalhe interno', async () => {
    dbMocks.selectError = new Error('postgres://usuario:segredo@host/base');

    await expect(exportarDadosCompletos()).rejects.toThrow('Falha ao exportar base de dados.');
    await expect(exportarDadosCompletos()).rejects.not.toThrow('segredo');
  });

  it('valida arquivo somente em memória e não inicia escrita', async () => {
    queueSafeExportRows();
    const exported = await exportarDadosCompletos();
    vi.clearAllMocks();

    const result = await validarArquivoExportacao(exported);

    expect(result.valido).toBe(true);
    expect(authorizationMocks.requireRole).toHaveBeenCalledWith('responsavel');
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('bloqueia a restauração chamada diretamente antes de qualquer leitura do arquivo ou escrita', async () => {
    const result = await restaurarDadosCompletos('{ JSON deliberadamente inválido');

    expect(result).toEqual({
      sucesso: false,
      mensagem: 'Restauração indisponível por segurança. O arquivo não foi aplicado.'
    });
    expect(authorizationMocks.requireRole).toHaveBeenCalledWith('responsavel');
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('nega restauração não autenticada sem qualquer efeito colateral', async () => {
    authorizationMocks.requireRole.mockRejectedValueOnce(new Error('UNAUTHENTICATED'));

    await expect(restaurarDadosCompletos('{}')).rejects.toThrow('UNAUTHENTICATED');
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
