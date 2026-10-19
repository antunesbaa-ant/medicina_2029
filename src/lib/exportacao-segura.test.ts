import { describe, expect, it } from 'vitest';
import {
  calcularHashIntegridade,
  criarExportacaoSegura,
  EXPORT_COLLECTION_CONTRACTS,
  EXPORT_COLLECTION_FIELDS,
  MAX_EXPORT_JSON_BYTES,
  MAX_EXPORT_NESTING_DEPTH,
  MAX_EXPORT_RECORDS,
  type ExportCollections,
  serializarDeterministicamente,
  validarExportacaoSegura
} from './exportacao-segura';

function emptyCollections(): ExportCollections {
  return Object.fromEntries(
    Object.keys(EXPORT_COLLECTION_FIELDS).map((collection) => [collection, []])
  ) as unknown as ExportCollections;
}

function validExport() {
  const data = emptyCollections();
  data.perfis.push({
    id: '11111111-1111-4111-8111-111111111111',
    nome: 'Perfil Fictício',
    papel: 'estudante',
    criadoEm: '2026-10-19T12:00:00.000Z'
  });
  return criarExportacaoSegura(data, new Date('2026-10-19T15:00:00.000Z'));
}

function refreshManifest(file: ReturnType<typeof validExport>): void {
  for (const collection of Object.keys(EXPORT_COLLECTION_FIELDS) as Array<keyof ExportCollections>) {
    file.manifesto.quantidades[collection] = file.dados[collection].length;
  }
  file.manifesto.hashIntegridade = calcularHashIntegridade(file.dados);
}

describe('formato seguro de exportação F1.05', () => {
  it('serializa objetos deterministicamente e preserva a ordem das listas', () => {
    expect(serializarDeterministicamente({ z: 1, a: { y: 2, b: 3 } }))
      .toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(serializarDeterministicamente({ lista: [2, 1] }))
      .toBe('{"lista":[2,1]}');
  });

  it('gera manifesto versionado, contagens e hash verificável somente sobre dados', () => {
    const file = validExport();

    expect(file.manifesto).toMatchObject({
      aplicativo: 'Medicina 2029',
      versaoFormato: 1,
      tipoExportacao: 'exportacao_administrativa_pessoal',
      segredosExcluidos: true,
      objetosStorageIncluidos: false,
      restauravelAutomaticamente: false,
      algoritmoIntegridade: 'SHA-256'
    });
    expect(file.manifesto.quantidades.perfis).toBe(1);
    expect(file.manifesto.hashIntegridade).toBe(calcularHashIntegridade(file.dados));
    expect(validarExportacaoSegura(file)).toEqual({ valido: true, arquivo: file });
  });

  it('normaliza Date válida do driver e rejeita Date inválida antes da serialização', () => {
    const data = emptyCollections();
    data.perfis.push({
      id: '88888888-8888-4888-8888-888888888888',
      nome: 'Perfil com Date',
      papel: 'estudante',
      criadoEm: new Date('2026-10-19T15:00:00.000Z')
    });
    const generated = criarExportacaoSegura(data);
    expect(generated.dados.perfis[0].criadoEm).toBe('2026-10-19T15:00:00.000Z');
    expect(validarExportacaoSegura(generated).valido).toBe(true);

    data.perfis[0].criadoEm = new Date(Number.NaN);
    expect(() => criarExportacaoSegura(data)).toThrow(
      'Os dados excedem os limites seguros de exportação.'
    );
  });

  it('mantém contrato explícito alinhado à allowlist para todas as 32 coleções', () => {
    expect(Object.keys(EXPORT_COLLECTION_CONTRACTS)).toEqual(Object.keys(EXPORT_COLLECTION_FIELDS));
    for (const collection of Object.keys(EXPORT_COLLECTION_FIELDS) as Array<keyof ExportCollections>) {
      expect(Object.keys(EXPORT_COLLECTION_CONTRACTS[collection])).toEqual(
        EXPORT_COLLECTION_FIELDS[collection]
      );
    }
  });

  it('rejeita tipo textual e papel inválidos sem incluir o conteúdo recebido no erro', () => {
    const numericName = validExport();
    numericName.dados.perfis[0].nome = 42;
    refreshManifest(numericName);
    const nameResult = validarExportacaoSegura(numericName);
    expect(nameResult.valido).toBe(false);
    if (!nameResult.valido) {
      expect(nameResult.erros).toContain('Tipo ou string inválido em perfis[0].nome.');
      expect(nameResult.erros.join(' ')).not.toContain('42');
    }

    const invalidRole = validExport();
    invalidRole.dados.perfis[0].papel = 'administrador_secreto';
    refreshManifest(invalidRole);
    const roleResult = validarExportacaoSegura(invalidRole);
    expect(roleResult.valido).toBe(false);
    if (!roleResult.valido) {
      expect(roleResult.erros).toContain('Tipo ou valor enumerado inválido em perfis[0].papel.');
      expect(roleResult.erros.join(' ')).not.toContain('administrador_secreto');
    }
  });

  it('rejeita datas, números, booleanos e JSON obrigatórios com tipos inválidos', () => {
    const file = validExport();
    file.dados.perfis[0].criadoEm = 'data-inválida';
    file.dados.generos.push({
      id: '22222222-2222-4222-8222-222222222222',
      nome: 'Gênero',
      finalidade: 'Finalidade',
      interlocutor: 'Interlocutor',
      estrutura: 'Estrutura',
      marcasLinguagem: 'Marcas',
      erroQueDescaracteriza: 'Erro',
      fichaCompleta: 'não'
    });
    file.dados.disciplinas.push({
      id: '33333333-3333-4333-8333-333333333333',
      nome: 'Biologia',
      area: 'natureza',
      corHex: '#ffffff',
      ordem: 1.5
    });
    file.dados.simuladoAnalise.push({
      id: '44444444-4444-4444-8444-444444444444',
      simuladoId: '55555555-5555-4555-8555-555555555555',
      concluida: false,
      tresAssuntosFracos: null,
      errosEstrategia: null,
      minutosAnalise: 10,
      realizadaEm: '2026-10-19T15:00:00.000Z'
    });
    refreshManifest(file);

    const result = validarExportacaoSegura(file);
    expect(result.valido).toBe(false);
    if (!result.valido) {
      expect(result.erros).toContain('Tipo ou date inválido em perfis[0].criadoEm.');
      expect(result.erros).toContain('Tipo ou boolean inválido em generos[0].fichaCompleta.');
      expect(result.erros).toContain('Tipo ou integer inválido em disciplinas[0].ordem.');
      expect(result.erros).toContain('Tipo ou json inválido em simuladoAnalise[0].tresAssuntosFracos.');
    }
  });

  it('exige a presença até de campos nullable no formato fechado', () => {
    const file = validExport();
    file.dados.ciclos.push({
      id: '66666666-6666-4666-8666-666666666666',
      nome: 'Ciclo',
      anoLetivo: 2027,
      ativo: true,
      blocosPrevistosSemana: 5,
      criadoEm: '2026-10-19T15:00:00.000Z'
    });
    refreshManifest(file);

    const result = validarExportacaoSegura(file);
    expect(result.valido).toBe(false);
    if (!result.valido) {
      expect(result.erros).toContain('Campo obrigatório ausente em ciclos[0].estudantePerfilId.');
    }
  });

  it('falha de modo fechado antes do parse para arquivo maior que o limite', () => {
    const oversized = ' '.repeat(MAX_EXPORT_JSON_BYTES + 1);
    expect(validarExportacaoSegura(oversized)).toEqual({
      valido: false,
      erros: ['Arquivo excede o tamanho máximo permitido.']
    });
  });

  it('impede que a própria geração produza arquivo acima dos limites defensivos', () => {
    const tooLarge = emptyCollections();
    tooLarge.perfis.push({
      id: '77777777-7777-4777-8777-777777777777',
      nome: 'x'.repeat(MAX_EXPORT_JSON_BYTES),
      papel: 'estudante',
      criadoEm: '2026-10-19T15:00:00.000Z'
    });
    expect(() => criarExportacaoSegura(tooLarge)).toThrow(
      'Os dados excedem os limites seguros de exportação.'
    );

    const tooMany = emptyCollections();
    tooMany.cards = Array.from({ length: MAX_EXPORT_RECORDS + 1 }, () => ({}));
    expect(() => criarExportacaoSegura(tooMany)).toThrow(
      'Os dados excedem os limites seguros de exportação.'
    );

    const tooDeep = emptyCollections();
    const nested: Record<string, unknown> = {};
    let cursor = nested;
    for (let index = 0; index <= MAX_EXPORT_NESTING_DEPTH; index += 1) {
      const child: Record<string, unknown> = {};
      cursor.proximo = child;
      cursor = child;
    }
    tooDeep.materiais.push({ fonteChunkIds: nested });
    expect(() => criarExportacaoSegura(tooDeep)).toThrow(
      'Os dados excedem os limites seguros de exportação.'
    );
  });

  it('limita quantidade total de registros antes da validação individual', () => {
    const file = validExport();
    file.dados.cards = Array.from({ length: MAX_EXPORT_RECORDS }, () => ({}));
    refreshManifest(file);

    expect(validarExportacaoSegura(file)).toEqual({
      valido: false,
      erros: ['Arquivo excede o número máximo de registros permitido.']
    });
  });

  it('rejeita estrutura recursiva profunda e referência cíclica sem lançar exceção', () => {
    const deep = validExport() as unknown as Record<string, unknown>;
    let cursor = deep;
    for (let index = 0; index <= MAX_EXPORT_NESTING_DEPTH; index += 1) {
      const child: Record<string, unknown> = {};
      cursor.extra = child;
      cursor = child;
    }
    expect(validarExportacaoSegura(deep)).toEqual({
      valido: false,
      erros: ['Estrutura excede os limites permitidos ou contém valor inválido.']
    });

    const cyclic = validExport() as unknown as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(validarExportacaoSegura(cyclic)).toEqual({
      valido: false,
      erros: ['Estrutura excede os limites permitidos ou contém valor inválido.']
    });
  });

  it('detecta alteração do conteúdo pelo hash', () => {
    const file = validExport();
    file.dados.perfis[0].nome = 'Conteúdo adulterado';

    const result = validarExportacaoSegura(file);
    expect(result.valido).toBe(false);
    if (!result.valido) expect(result.erros).toContain('Hash de integridade divergente.');
  });

  it('detecta coleção ausente', () => {
    const file = validExport();
    delete (file.dados as Partial<ExportCollections>).cards;

    const result = validarExportacaoSegura(file);
    expect(result.valido).toBe(false);
    if (!result.valido) {
      expect(result.erros).toContain('Coleções obrigatórias ausentes ou desconhecidas.');
    }
  });

  it('detecta contagem inconsistente', () => {
    const file = validExport();
    file.manifesto.quantidades.perfis = 2;

    const result = validarExportacaoSegura(file);
    expect(result.valido).toBe(false);
    if (!result.valido) {
      expect(result.erros).toContain('Quantidade inconsistente na coleção perfis.');
    }
  });

  it('rejeita formato desconhecido e JSON malformado', () => {
    const file = validExport();
    (file.manifesto as { versaoFormato: number }).versaoFormato = 99;

    const unknownVersion = validarExportacaoSegura(file);
    expect(unknownVersion.valido).toBe(false);
    if (!unknownVersion.valido) {
      expect(unknownVersion.erros).toContain('Versão de formato desconhecida.');
    }

    expect(validarExportacaoSegura('{')).toEqual({
      valido: false,
      erros: ['Arquivo JSON malformado.']
    });
  });

  it('rejeita registros sem campos obrigatórios e campos desconhecidos', () => {
    const file = validExport();
    file.dados.perfis = [{ nome: 'Sem ID', campoNovo: true }];
    file.manifesto.quantidades.perfis = 1;
    file.manifesto.hashIntegridade = calcularHashIntegridade(file.dados);

    const result = validarExportacaoSegura(file);
    expect(result.valido).toBe(false);
    if (!result.valido) {
      expect(result.erros).toContain('Campo não permitido em perfis[0].campoNovo.');
      expect(result.erros).toContain('Campo obrigatório ausente em perfis[0].id.');
    }
  });

  it('rejeita identificador com tipo ou formato incompatível com UUID', () => {
    const file = validExport();
    file.dados.perfis[0].id = 123;
    file.manifesto.hashIntegridade = calcularHashIntegridade(file.dados);

    const result = validarExportacaoSegura(file);
    expect(result.valido).toBe(false);
    if (!result.valido) {
      expect(result.erros).toContain('UUID inválido em perfis[0].id.');
    }
  });

  it.each(['passwordHash', 'authUserId', 'token', 'apiKey', 'cookie'])(
    'rejeita recursivamente o campo proibido %s',
    (forbiddenField) => {
      const file = validExport();
      file.dados.perfis[0] = {
        ...file.dados.perfis[0],
        [forbiddenField]: 'não deve sair'
      };
      file.manifesto.hashIntegridade = calcularHashIntegridade(file.dados);

      const result = validarExportacaoSegura(file);
      expect(result.valido).toBe(false);
      if (!result.valido) {
        expect(result.erros.some((error) => error.includes('Campo proibido'))).toBe(true);
      }
    }
  );

  it('interrompe a própria geração quando um JSON aninhado contém segredo', () => {
    const data = emptyCollections();
    data.materiais.push({
      id: '33333333-3333-4333-8333-333333333333',
      fonteChunkIds: [{ geminiApiKey: 'não deve sair' }]
    });

    expect(() => criarExportacaoSegura(data)).toThrow(
      'Os dados contêm campos proibidos para exportação.'
    );
  });

  it('não executa banco nem possui dependência de persistência durante a validação', () => {
    const file = validExport();
    expect(validarExportacaoSegura(JSON.stringify(file)).valido).toBe(true);
  });
});
