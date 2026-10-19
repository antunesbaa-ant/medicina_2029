import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  acervoArquivos,
  acervoChunks,
  acervoFiguras,
  acervoPaginas,
  cardRevisoes,
  cards,
  checkins,
  cicloBlocos,
  cicloEstado,
  ciclos,
  curadoriaFila,
  disciplinas,
  erros,
  generos,
  geracoes,
  livros,
  materiais,
  perfis,
  perguntasAtivas,
  questaoTopicos,
  questoes,
  redacoes,
  repertorios,
  responsavelEstudante,
  revisoesTrimestrais,
  sessoes,
  simuladoAnalise,
  simuladoAreas,
  simuladoQuestoes,
  simulados,
  tentativas,
  topicos
} from './schema';

type Table = Parameters<typeof getTableConfig>[0];
type Column = ReturnType<typeof getTableConfig>['columns'][number];

const allTables: Table[] = [
  perfis,
  disciplinas,
  topicos,
  ciclos,
  cicloBlocos,
  cicloEstado,
  sessoes,
  materiais,
  perguntasAtivas,
  cards,
  cardRevisoes,
  questoes,
  questaoTopicos,
  tentativas,
  erros,
  generos,
  redacoes,
  repertorios,
  responsavelEstudante,
  simulados,
  simuladoQuestoes,
  simuladoAreas,
  simuladoAnalise,
  checkins,
  revisoesTrimestrais,
  livros,
  acervoArquivos,
  acervoPaginas,
  acervoChunks,
  acervoFiguras,
  geracoes,
  curadoriaFila
];

function hasForeignKey(table: Table, localColumn: Column, foreignColumn: Column): boolean {
  return getTableConfig(table).foreignKeys.some((foreignKey) => {
    const reference = foreignKey.reference();
    return reference.columns.some((column) => column === localColumn)
      && reference.foreignColumns.some((column) => column === foreignColumn);
  });
}

function hasColumn(table: Table, columnName: string): boolean {
  return getTableConfig(table).columns.some((column) => column.name === columnName);
}

describe('integridade estrutural e identidade canônica', () => {
  it('mantém as colunas de owner pessoal obrigatórias ligadas a perfis.id', () => {
    const owners: Array<[string, Table, Column]> = [
      ['sessoes', sessoes, sessoes.perfilId],
      ['cards', cards, cards.perfilId],
      ['tentativas', tentativas, tentativas.perfilId],
      ['erros', erros, erros.perfilId],
      ['redacoes', redacoes, redacoes.perfilId],
      ['simulados', simulados, simulados.perfilId],
      ['checkins', checkins, checkins.perfilId],
      ['livros', livros, livros.perfilId],
      ['acervo_arquivos', acervoArquivos, acervoArquivos.enviadoPor]
    ];

    for (const [name, table, column] of owners) {
      expect(column.notNull, `${name}.${column.name} deve ser NOT NULL`).toBe(true);
      expect(
        hasForeignKey(table, column, perfis.id),
        `${name}.${column.name} deve referenciar perfis.id`
      ).toBe(true);
    }
  });

  it('não usa authUserId como destino de nenhuma FK de domínio', () => {
    const referencesToAuthUserId = allTables.flatMap((table) =>
      getTableConfig(table).foreignKeys.filter((foreignKey) =>
        foreignKey.reference().foreignColumns.some((column) => column === perfis.authUserId)
      )
    );

    expect(referencesToAuthUserId).toHaveLength(0);
  });

  it('mantém ownership herdado ligado ao registro pai correto', () => {
    const inherited: Array<[string, Table, Column, Column]> = [
      ['card_revisoes.card_id', cardRevisoes, cardRevisoes.cardId, cards.id],
      ['simulado_areas.simulado_id', simuladoAreas, simuladoAreas.simuladoId, simulados.id],
      ['simulado_analise.simulado_id', simuladoAnalise, simuladoAnalise.simuladoId, simulados.id],
      ['simulado_questoes.simulado_id', simuladoQuestoes, simuladoQuestoes.simuladoId, simulados.id],
      ['acervo_paginas.arquivo_id', acervoPaginas, acervoPaginas.arquivoId, acervoArquivos.id],
      ['acervo_chunks.arquivo_id', acervoChunks, acervoChunks.arquivoId, acervoArquivos.id],
      ['acervo_figuras.arquivo_id', acervoFiguras, acervoFiguras.arquivoId, acervoArquivos.id]
    ];

    for (const [name, table, localColumn, foreignColumn] of inherited) {
      expect(hasForeignKey(table, localColumn, foreignColumn), `${name} deve manter a cadeia de owner`).toBe(true);
    }
  });

  it('modela a expansão de ownership como nullable e ligada a perfis.id', () => {
    const expansionOwners: Array<[string, Table, Column]> = [
      ['ciclos.estudante_perfil_id', ciclos, ciclos.estudantePerfilId],
      ['repertorios.perfil_id', repertorios, repertorios.perfilId],
      [
        'revisoes_trimestrais.estudante_perfil_id',
        revisoesTrimestrais,
        revisoesTrimestrais.estudantePerfilId
      ],
      [
        'revisoes_trimestrais.registrada_por_perfil_id',
        revisoesTrimestrais,
        revisoesTrimestrais.registradaPorPerfilId
      ]
    ];

    for (const [name, table, column] of expansionOwners) {
      expect(hasColumn(table, column.name), `${name} deve existir`).toBe(true);
      expect(column.notNull, `${name} deve permanecer nullable na expansão`).toBe(false);
      expect(hasForeignKey(table, column, perfis.id), `${name} deve referenciar perfis.id`).toBe(true);
    }
  });

  it('formaliza o vínculo singleton responsável-estudante sem usar authUserId', () => {
    const config = getTableConfig(responsavelEstudante);

    expect(responsavelEstudante.vinculoId.primary).toBe(true);
    expect(responsavelEstudante.responsavelPerfilId.notNull).toBe(true);
    expect(responsavelEstudante.estudantePerfilId.notNull).toBe(true);
    expect(hasForeignKey(
      responsavelEstudante,
      responsavelEstudante.responsavelPerfilId,
      perfis.id
    )).toBe(true);
    expect(hasForeignKey(
      responsavelEstudante,
      responsavelEstudante.estudantePerfilId,
      perfis.id
    )).toBe(true);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'responsavel_estudante_singleton_check',
        'responsavel_estudante_ids_distintos_check'
      ])
    );
  });

  it('mantém o script histórico estritamente read-only', () => {
    const sql = readFileSync(
      new URL('../../docs/modernizacao/sql/F1_03_AUDITORIA_READONLY.sql', import.meta.url),
      'utf8'
    );
    const executableSql = sql
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    expect(executableSql).toMatch(/BEGIN TRANSACTION[\s\S]*READ ONLY/i);
    expect(executableSql).toMatch(/current_setting\('transaction_read_only'\)/i);
    expect(executableSql.trim()).toMatch(/ROLLBACK;$/i);
    expect(executableSql).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE|CALL|DO)\b/i
    );
  });

  it('versiona apenas a expansão e mantém a contração fora do journal automático', () => {
    const journal = readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8');
    const expansion = readFileSync(
      new URL('../../drizzle/0003_f1_03_r_expansao.sql', import.meta.url),
      'utf8'
    );
    const contraction = readFileSync(
      new URL('../../docs/modernizacao/propostas/F1_03_R_CONTRACAO_PROPOSTA.sql', import.meta.url),
      'utf8'
    );
    const proposal = readFileSync(
      new URL('../../docs/modernizacao/propostas/F1_03_MIGRACAO_PROPOSTA.sql', import.meta.url),
      'utf8'
    );

    expect(journal).toContain('0003_f1_03_r_expansao');
    expect(JSON.parse(journal).entries).toHaveLength(4);
    expect(journal).not.toContain('F1_03_MIGRACAO_PROPOSTA');
    expect(journal).not.toContain('F1_03_R_CONTRACAO_PROPOSTA');
    expect(expansion).toContain('ADD COLUMN "estudante_perfil_id" uuid;');
    expect(expansion).toContain(
      "SET LOCAL lock_timeout = '5s';\n--> statement-breakpoint\nSET LOCAL statement_timeout = '60s';"
    );
    expect(expansion).not.toMatch(/ALTER COLUMN\s+\S+\s+SET NOT NULL/i);
    expect(contraction).toContain('ALTER COLUMN estudante_perfil_id SET NOT NULL');
    expect(proposal).toContain('responsavel_estudante_singleton_check');
    expect(proposal).toContain('CHECK (vinculo_id = 1)');
    expect(proposal).toContain('F1.03 abortada: esperado exatamente um perfil estudante.');
    expect(proposal).toContain('F1.03 abortada: esperado exatamente um perfil responsavel.');
  });

  it('mantém backfill repetível e rollbacks separados para expansão e contração', () => {
    const backfill = readFileSync(
      new URL('../../docs/modernizacao/sql/F1_03_R_BACKFILL_REPETIVEL.sql', import.meta.url),
      'utf8'
    );
    const expansionRollback = readFileSync(
      new URL('../../docs/modernizacao/propostas/F1_03_R_ROLLBACK_EXPANSAO.sql', import.meta.url),
      'utf8'
    );
    const contractionRollback = readFileSync(
      new URL('../../docs/modernizacao/propostas/F1_03_R_ROLLBACK_CONTRACAO.sql', import.meta.url),
      'utf8'
    );

    expect(backfill).toContain('WHERE estudante_perfil_id IS NULL');
    expect(backfill).toContain('WHERE perfil_id IS NULL');
    expect(backfill).toContain('COALESCE(estudante_perfil_id, estudante_id)');
    expect(backfill).not.toMatch(/\b(DELETE|TRUNCATE|DROP)\b/i);
    expect(expansionRollback).toContain('DROP TABLE IF EXISTS responsavel_estudante');
    expect(expansionRollback).toContain('nao remove e nao deve remover automaticamente');
    expect(expansionRollback).toContain('drizzle.__drizzle_migrations');
    expect(expansionRollback).toContain(
      'DROP CONSTRAINT IF EXISTS ciclos_estudante_perfil_id_perfis_id_fk'
    );
    expect(contractionRollback).not.toContain('DROP TABLE');
    expect(contractionRollback).toContain('ALTER COLUMN estudante_perfil_id DROP NOT NULL');
  });
});
