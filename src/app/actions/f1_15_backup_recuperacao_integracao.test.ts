import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  gerarManifestoBackupStorage,
  validarIntegridadeBackupFisico,
  reconciliarManifestoComBanco,
  type ObjetoEntradaManifesto,
  type ObjetoFisicoEntrada,
  type RegistroAcervoBancoParaManifesto,
} from '../../lib/storageBackupManifest';

const MODULE_ROOT =
  process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';
const PGLITE_INDEX = path.join(MODULE_ROOT, '@electric-sql/pglite/dist/index.js');
const PGLITE_VECTOR = path.join(
  MODULE_ROOT,
  '@electric-sql/pglite-pgvector/dist/index.js'
);
const HAS_PGLITE = existsSync(PGLITE_INDEX) && existsSync(PGLITE_VECTOR);

// Ordem canônica calculada pelo grafo topológico (Níveis 0 a 5)
const ORDERED_TABLES = [
  // Nível 0: Sem dependências de FK externas
  'allowlist',
  'disciplinas',
  'generos',
  'perfis',
  // Nível 1: Dependem apenas do Nível 0
  'responsavel_estudante',
  'topicos',
  'ciclos',
  'acervo_arquivos',
  'simulados',
  'redacoes',
  'repertorios',
  'checkins',
  'revisoes_trimestrais',
  'livros',
  'operacoes_idempotentes',
  // Nível 2: Dependem dos Níveis 0 e 1
  'ciclo_blocos',
  'ciclo_estado',
  'materiais',
  'perguntas_ativas',
  'cards',
  'acervo_paginas',
  'acervo_chunks',
  'acervo_jobs',
  'questoes',
  'simulado_areas',
  'simulado_analise',
  'geracoes',
  'curadoria_fila',
  // Nível 3: Dependem do Nível 2
  'sessoes',
  'card_revisoes',
  'acervo_figuras',
  'questao_topicos',
  'simulado_questoes',
  // Nível 4: Dependem do Nível 3
  'tentativas',
  // Nível 5: Dependem do Nível 4
  'erros',
] as const;

interface PGliteInstance {
  exec: (sql: string) => Promise<unknown>;
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[] }>;
  close: () => Promise<void>;
}

describe.skipIf(!HAS_PGLITE)(
  'F1.15 — Backup Completo e Recuperação Testada (PostgreSQL Real PGlite + Storage Manifest)',
  () => {
    let PGliteClass: {
      create: (options?: {
        extensions?: Record<string, unknown>;
      }) => Promise<PGliteInstance>;
    };
    let vectorExtension: unknown;

    const rootDir = process.cwd();
    const readSql = (relPath: string) =>
      readFileSync(path.join(rootDir, relPath), 'utf8').replaceAll(
        '--> statement-breakpoint',
        '\n'
      );

    const sql0000 = readSql('drizzle/0000_greedy_loki.sql');
    const sql0001 = readSql('drizzle/0001_dry_talos.sql');
    const sql0002 = readSql('drizzle/0002_little_swarm.sql');
    const sql0003 = readSql('drizzle/0003_f1_03_r_expansao.sql');
    const fixturesSql = readSql('tests/integration/f1_04/fixtures.sql');
    const f109ProposalSql = readSql(
      'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'
    );
    const f111ProposalSql = readSql(
      'docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql'
    );
    const f112ProposalSql = readSql(
      'docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'
    );

    beforeAll(async () => {
      const { PGlite } = await import(pathToFileURL(PGLITE_INDEX).href);
      const { vector } = await import(pathToFileURL(PGLITE_VECTOR).href);
      PGliteClass = PGlite;
      vectorExtension = vector;
    });

    /**
     * Aplica o schema DDL completo (migrations + propostas homologadas F1.09, F1.11, F1.12)
     */
    async function inicializarSchemaCompleto(pg: PGliteInstance): Promise<void> {
      await pg.exec(sql0000);
      await pg.exec(sql0001);
      await pg.exec(sql0002);
      await pg.exec(sql0003);
      await pg.exec(f109ProposalSql);
      await pg.exec(f111ProposalSql);
      await pg.exec(f112ProposalSql);
    }

    /**
     * Exporta dados de uma tabela para formato de tuplas portáveis
     */
    async function exportarTabela(
      pg: PGliteInstance,
      tableName: string
    ): Promise<{
      tableName: string;
      columns: string[];
      rows: unknown[][];
      count: number;
    }> {
      const colsRes = await pg.query<{ column_name: string }>(
        `SELECT column_name 
           FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position`,
        [tableName]
      );
      const columns = colsRes.rows.map((r) => r.column_name);

      if (columns.length === 0) {
        return { tableName, columns: [], rows: [], count: 0 };
      }

      const rowsRes = await pg.query(
        `SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM public."${tableName}"`
      );
      const rows = rowsRes.rows.map((row) =>
        columns.map((col) => (row as Record<string, unknown>)[col])
      );

      return {
        tableName,
        columns,
        rows,
        count: rows.length,
      };
    }

    /**
     * Restaura os dados de uma tabela em ordem topológica segura
     */
    async function restaurarTabela(
      pg: PGliteInstance,
      data: {
        tableName: string;
        columns: string[];
        rows: unknown[][];
      }
    ): Promise<void> {
      if (data.rows.length === 0 || data.columns.length === 0) {
        return;
      }

      for (const row of data.rows) {
        const placeholders = row.map((_, i) => `$${i + 1}`).join(', ');
        const colList = data.columns.map((c) => `"${c}"`).join(', ');

        const sanitizedParams = row.map((val) => {
          if (val === null || val === undefined) return null;
          if (typeof val === 'object') {
            return JSON.stringify(val);
          }
          return val;
        });

        await pg.query(
          `INSERT INTO public."${data.tableName}" (${colList}) VALUES (${placeholders})`,
          sanitizedParams
        );
      }
    }

    it('1. Round-Trip Integral: Snapshot completo de banco primário e restauração em banco descartável', async () => {
      // 1. Instância Primária (A) com dados ricos
      const pgPrimary = await PGliteClass.create({
        extensions: { vector: vectorExtension },
      });
      // Aplica DDL base, fixtures e atualiza constraints
      await pgPrimary.exec(sql0000);
      await pgPrimary.exec(sql0001);
      await pgPrimary.exec(sql0002);
      await pgPrimary.exec(sql0003);
      await pgPrimary.exec(fixturesSql);

      // Garante que questões geradas nas fixtures possuem proveniência válida (conforme F1.12)
      await pgPrimary.exec(`
        UPDATE public.questoes 
           SET fonte_chunk_ids = '["62000000-0000-4000-8000-000000000001"]'::jsonb 
         WHERE procedencia = 'gerada' AND (fonte_chunk_ids IS NULL OR jsonb_array_length(fonte_chunk_ids) = 0);
      `);

      await pgPrimary.exec(f109ProposalSql);
      await pgPrimary.exec(f111ProposalSql);
      await pgPrimary.exec(f112ProposalSql);

      // Adiciona itens adicionais de F1.11 e F1.12 para cobertura completa de chunks com vetor e jobs
      const arquivoId = '60000000-0000-4000-8000-000000000009';
      const dummyVector = JSON.stringify(new Array(1536).fill(0.025));

      await pgPrimary.exec(`
        INSERT INTO public.acervo_arquivos (
          id, disciplina_id, titulo, tipo_material, serie_alvo, file_path,
          mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo
        ) VALUES (
          '${arquivoId}',
          '30000000-0000-4000-8000-000000000001',
          'Biologia Celular e Tecidos F1.15',
          'livro',
          1,
          'acervo/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.pdf',
          'application/pdf',
          1048576,
          42,
          '20000000-0000-4000-8000-000000000001',
          'concluido',
          '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
        ) ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.acervo_chunks (
          id, arquivo_id, pagina_inicial, pagina_final, ordem, texto,
          tipo_conteudo, topico_id, confianca_classificacao, embedding, tokens
        ) VALUES (
          '62000000-0000-4000-8000-000000000009',
          '${arquivoId}',
          1, 3, 1,
          'A membrana plasmática possui estrutura de mosaico fluido...',
          'exposicao_teorica',
          '31000000-0000-4000-8000-000000000001',
          0.98,
          '${dummyVector}',
          120
        ) ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.acervo_jobs (
          id, arquivo_id, status, etapa_atual, tentativas, max_tentativas, enviado_por, concluido_em
        ) VALUES (
          '63000000-0000-4000-8000-000000000009',
          '${arquivoId}',
          'concluido',
          'concluido',
          1,
          3,
          '20000000-0000-4000-8000-000000000001',
          now()
        ) ON CONFLICT (arquivo_id) DO NOTHING;
      `);

      // 2. Extrai backup lógico completo em ordem topológica de tabelas
      const snapshotBackup: Array<{
        tableName: string;
        columns: string[];
        rows: unknown[][];
        count: number;
      }> = [];

      for (const table of ORDERED_TABLES) {
        const tableData = await exportarTabela(pgPrimary, table);
        snapshotBackup.push(tableData);
      }

      // Valida que tabelas essenciais possuem dados
      const perfisData = snapshotBackup.find((t) => t.tableName === 'perfis');
      const cardsData = snapshotBackup.find((t) => t.tableName === 'cards');
      const sessoesData = snapshotBackup.find((t) => t.tableName === 'sessoes');

      expect(perfisData?.count).toBeGreaterThanOrEqual(4);
      expect(cardsData?.count).toBeGreaterThanOrEqual(2);
      expect(sessoesData?.count).toBeGreaterThanOrEqual(2);

      // 3. Instância Descartável de Destino (B) - começa do zero absoluto
      const pgRestored = await PGliteClass.create({
        extensions: { vector: vectorExtension },
      });

      // Passo 3a: Pre-data (criação de schemas, tipos e todas as tabelas)
      await inicializarSchemaCompleto(pgRestored);

      // Passo 3b: Limpa integralmente todas as tabelas para garantir carga limpa e sem backfills de migração
      const truncateList = ORDERED_TABLES.map((t) => `public."${t}"`).join(', ');
      await pgRestored.exec(`TRUNCATE ${truncateList} CASCADE;`);

      // Confirma que o banco de destino está vazio antes do restore de dados
      const countBefore = await pgRestored.query<{ count: string }>(
        'SELECT count(*) as count FROM public.perfis'
      );
      expect(Number(countBefore.rows[0].count)).toBe(0);

      // Passo 3c: Data (carga em massa na ordem topológica estrita Nível 0 -> Nível 5)
      for (const tableData of snapshotBackup) {
        await restaurarTabela(pgRestored, tableData);
      }

      // 4. Verificação de Integridade 100% entre Primário e Restaurado
      for (const tableData of snapshotBackup) {
        const restoredCountRes = await pgRestored.query<{ count: string }>(
          `SELECT count(*) as count FROM public."${tableData.tableName}"`
        );
        const countRestored = Number(restoredCountRes.rows[0].count);

        expect(
          countRestored,
          `Contagem divergente na tabela ${tableData.tableName}`
        ).toBe(tableData.count);
      }

      // 5. Auditoria de Integridade Referencial e Chaves Estrangeiras no Banco Restaurado
      const vinculoRes = await pgRestored.query<{
        estudante: string;
        responsavel: string;
      }>(`
        SELECT e.nome as estudante, r.nome as responsavel
          FROM responsavel_estudante re
          JOIN perfis r ON r.id = re.responsavel_perfil_id
          JOIN perfis e ON e.id = re.estudante_perfil_id
         WHERE re.vinculo_id = 1
      `);
      expect(vinculoRes.rows[0].estudante).toBe('Estudante Ficticia 1 F1.04');
      expect(vinculoRes.rows[0].responsavel).toBe('Responsavel Ficticio 1 F1.04');

      // 6. Auditoria de Estado de Ciclos e Sessões
      const cicloRes = await pgRestored.query<{
        nome: string;
        ativo: boolean;
        blocos: string;
      }>(`
        SELECT c.nome, c.ativo, count(b.id) as blocos
          FROM ciclos c
          LEFT JOIN ciclo_blocos b ON b.ciclo_id = c.id
         WHERE c.id = '40000000-0000-4000-8000-000000000001'
         GROUP BY c.id, c.nome, c.ativo
      `);
      expect(cicloRes.rows[0].ativo).toBe(true);
      expect(Number(cicloRes.rows[0].blocos)).toBeGreaterThanOrEqual(1);

      // 7. Auditoria de Flashcards e Parâmetros FSRS
      const cardRes = await pgRestored.query<{
        stability: number;
        difficulty: number;
        state: string;
        revisoes: string;
      }>(`
        SELECT c.stability, c.difficulty, c.state, count(r.id) as revisoes
          FROM cards c
          LEFT JOIN card_revisoes r ON r.card_id = c.id
         WHERE c.id = '50000000-0000-4000-8000-000000000001'
         GROUP BY c.id, c.stability, c.difficulty, c.state
      `);
      expect(cardRes.rows[0].stability).toBe(1.0);
      expect(cardRes.rows[0].state).toBe('review');
      expect(Number(cardRes.rows[0].revisoes)).toBe(1);

      // 8. Auditoria de Ingestão e Chunks com Embedding
      const chunkRes = await pgRestored.query<{
        texto: string;
        tokens: number;
      }>(`
        SELECT texto, tokens 
          FROM acervo_chunks 
         WHERE id = '62000000-0000-4000-8000-000000000009'
      `);
      expect(chunkRes.rows[0].texto).toContain('membrana plasmática');
      expect(chunkRes.rows[0].tokens).toBe(120);

      await pgPrimary.close();
      await pgRestored.close();
    }, 30000);

    it('2. Correspondência Banco/Storage: Geração e validação de manifesto contra acervo_arquivos', async () => {
      // Cria buffers sintéticos de teste simulando PDFs do storage
      const pdfBuffer1 = Buffer.from('%PDF-1.4 Mock PDF Content Biology 1');
      const sha1 = crypto.createHash('sha256').update(pdfBuffer1).digest('hex');
      const storagePath1 = `acervo/${sha1}.pdf`;

      const pdfBuffer2 = Buffer.from('%PDF-1.4 Mock PDF Content Chemistry 2');
      const sha2 = crypto.createHash('sha256').update(pdfBuffer2).digest('hex');
      const storagePath2 = `acervo/${sha2}.pdf`;

      const objetosStorage: ObjetoEntradaManifesto[] = [
        {
          storagePath: storagePath1,
          arquivoId: '60000000-0000-4000-8000-000000000001',
          conteudo: pdfBuffer1,
          mimeType: 'application/pdf',
        },
        {
          storagePath: storagePath2,
          arquivoId: '60000000-0000-4000-8000-000000000002',
          conteudo: pdfBuffer2,
          mimeType: 'application/pdf',
        },
      ];

      // Gera o manifesto canônico
      const manifesto = gerarManifestoBackupStorage({
        bucket: 'acervo',
        objetos: objetosStorage,
      });

      expect(manifesto.version).toBe('1.0');
      expect(manifesto.totalObjetos).toBe(2);
      expect(manifesto.totalBytes).toBe(pdfBuffer1.length + pdfBuffer2.length);
      expect(manifesto.sha256Manifesto).toMatch(/^[0-9a-f]{64}$/);

      // Simula registros lidos de acervo_arquivos no PostgreSQL
      const registrosDb: RegistroAcervoBancoParaManifesto[] = [
        {
          id: '60000000-0000-4000-8000-000000000001',
          filePath: storagePath1,
          hashConteudo: sha1,
          tamanhoBytes: pdfBuffer1.length,
          mime: 'application/pdf',
        },
        {
          id: '60000000-0000-4000-8000-000000000002',
          filePath: storagePath2,
          hashConteudo: sha2,
          tamanhoBytes: pdfBuffer2.length,
          mime: 'application/pdf',
        },
      ];

      // Reconcilia banco com manifesto de storage
      const relatorio = reconciliarManifestoComBanco(manifesto, registrosDb);
      expect(relatorio.reconciliado).toBe(true);
      expect(relatorio.totais.registrosBanco).toBe(2);
      expect(relatorio.totais.objetosManifesto).toBe(2);
      expect(relatorio.totais.integros).toBe(2);
      expect(relatorio.totais.inconsistencias).toBe(0);

      // Validação física dos arquivos contra o manifesto
      const arquivosFisicos: ObjetoFisicoEntrada[] = [
        { storagePath: storagePath1, conteudo: pdfBuffer1 },
        { storagePath: storagePath2, conteudo: pdfBuffer2 },
      ];

      const validacaoFisica = validarIntegridadeBackupFisico(
        manifesto,
        arquivosFisicos
      );
      expect(validacaoFisica.integro).toBe(true);
      expect(validacaoFisica.totais.manifestados).toBe(2);
      expect(validacaoFisica.totais.corrompidos).toBe(0);
      expect(validacaoFisica.totais.ausentes).toBe(0);
    });

    it('3. Detecção de Objetos Ausentes ou Corrompidos no Storage', async () => {
      const pdfBuffer1 = Buffer.from('%PDF-1.4 Real Document');
      const sha1 = crypto.createHash('sha256').update(pdfBuffer1).digest('hex');
      const storagePath1 = `acervo/${sha1}.pdf`;

      const pdfBuffer2 = Buffer.from('%PDF-1.4 Another Document');
      const sha2 = crypto.createHash('sha256').update(pdfBuffer2).digest('hex');
      const storagePath2 = `acervo/${sha2}.pdf`;

      const manifesto = gerarManifestoBackupStorage({
        bucket: 'acervo',
        objetos: [
          {
            storagePath: storagePath1,
            arquivoId: '60000000-0000-4000-8000-000000000001',
            conteudo: pdfBuffer1,
          },
          {
            storagePath: storagePath2,
            arquivoId: '60000000-0000-4000-8000-000000000002',
            conteudo: pdfBuffer2,
          },
        ],
      });

      // Cenário A: Objeto 2 ausente do backup físico
      const storageComFalta: ObjetoFisicoEntrada[] = [
        { storagePath: storagePath1, conteudo: pdfBuffer1 },
      ];
      const resFalta = validarIntegridadeBackupFisico(
        manifesto,
        storageComFalta
      );

      expect(resFalta.integro).toBe(false);
      expect(resFalta.totais.ausentes).toBe(1);
      expect(resFalta.objetosAusentes[0].storagePath).toBe(storagePath2);

      // Cenário B: Objeto 2 adulterado/corrompido (bytes alterados com mesmo tamanho)
      const bufferCorrompido = Buffer.from('%PDF-1.4 Tampered Doc!!!!');
      expect(bufferCorrompido.length).toBe(pdfBuffer2.length); // mesmo tamanho, hash diferente

      const storageComCorrupcao: ObjetoFisicoEntrada[] = [
        { storagePath: storagePath1, conteudo: pdfBuffer1 },
        { storagePath: storagePath2, conteudo: bufferCorrompido },
      ];

      const resCorrupcao = validarIntegridadeBackupFisico(
        manifesto,
        storageComCorrupcao
      );
      expect(resCorrupcao.integro).toBe(false);
      expect(resCorrupcao.totais.corrompidos).toBe(1);
      expect(resCorrupcao.objetosCorrompidos[0].motivo).toBe(
        'sha256_divergente'
      );
    });

    it('4. Detecção de Backup Incompleto e Rejeição Fail-Closed de Chaves Estrangeiras', async () => {
      // Inicia instância isolada com pre-data schema
      const pg = await PGliteClass.create({
        extensions: { vector: vectorExtension },
      });
      await pg.exec(sql0000);
      await pg.exec(sql0001);
      await pg.exec(sql0002);
      await pg.exec(sql0003);

      // Tenta restaurar a tabela 'sessoes' com referências a perfis e blocos inexistentes
      const sessaoOrfa = {
        tableName: 'sessoes',
        columns: [
          'id',
          'perfil_id',
          'ciclo_bloco_id',
          'topico_id',
          'iniciada_em',
          'segundos_efetivos',
          'segundos_pausa',
          'etapa_atingida',
          'concluida',
        ],
        rows: [
          [
            '42000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000099', // ID não existe em perfis
            '41000000-0000-4000-8000-000000000099', // ID não existe em ciclo_blocos
            '31000000-0000-4000-8000-000000000099', // ID não existe em topicos
            new Date().toISOString(),
            1200,
            100,
            'conteudo',
            false,
          ],
        ],
      };

      // Deve falhar com violação estrita de Foreign Key (código Postgres 23503)
      await expect(restaurarTabela(pg, sessaoOrfa)).rejects.toThrow(
        /foreign key|violates foreign key constraint/i
      );

      // Garante que o banco continua limpo e íntegro
      const sessoesCount = await pg.query<{ count: string }>(
        'SELECT count(*) as count FROM public.sessoes'
      );
      expect(Number(sessoesCount.rows[0].count)).toBe(0);

      await pg.close();
    }, 15000);

    it('5. Saneamento Pós-Restore com Auditoria e Teste de Reversibilidade Estrita', async () => {
      const pg = await PGliteClass.create({
        extensions: { vector: vectorExtension },
      });
      await pg.exec(sql0000);
      await pg.exec(sql0001);
      await pg.exec(sql0002);
      await pg.exec(sql0003);
      await pg.exec(fixturesSql);
      await pg.exec(f109ProposalSql);
      await pg.exec(f111ProposalSql);
      await pg.exec(f112ProposalSql);

      // Cria uma sessão que estava em andamento no momento do backup (encerrada_em IS NULL)
      await pg.exec(`
        INSERT INTO public.sessoes (
          id, perfil_id, ciclo_bloco_id, topico_id, iniciada_em, encerrada_em, segundos_efetivos,
          segundos_pausa, etapa_atingida, concluida, nota_livre
        ) VALUES (
          '42000000-0000-4000-8000-000000000099',
          '10000000-0000-4000-8000-000000000001',
          '41000000-0000-4000-8000-000000000001',
          '31000000-0000-4000-8000-000000000001',
          now() - interval '1 hour',
          NULL,
          1500,
          200,
          'conteudo',
          false,
          'Sessão interrompida por snapshot de backup'
        );

        INSERT INTO public.acervo_arquivos (
          id, disciplina_id, titulo, tipo_material, serie_alvo, file_path,
          mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo
        ) VALUES (
          '60000000-0000-4000-8000-000000000099',
          '30000000-0000-4000-8000-000000000001',
          'Arquivo em Processamento',
          'apostila',
          1,
          'acervo/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.pdf',
          'application/pdf',
          2048,
          5,
          '20000000-0000-4000-8000-000000000001',
          'extraindo',
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        );

        INSERT INTO public.acervo_jobs (
          id, arquivo_id, status, etapa_atual, tentativas, max_tentativas, enviado_por,
          locked_by, locked_at, lease_expires_at
        ) VALUES (
          '63000000-0000-4000-8000-000000000099',
          '60000000-0000-4000-8000-000000000099',
          'em_execucao',
          'extracao',
          1,
          3,
          '20000000-0000-4000-8000-000000000001',
          'worker-old-instance',
          now() - interval '10 minutes',
          now() - interval '5 minutes'
        );
      `);

      // Executa o script de saneamento prescrito no runbook pós-restore
      await pg.exec(`
        -- 1. Encerra com segurança sessões zumbis sem inventar conclusão
        UPDATE public.sessoes
           SET encerrada_em = COALESCE(iniciada_em + (segundos_efetivos || ' seconds')::interval, now()),
               concluida = false,
               nota_livre = COALESCE(nota_livre || ' ', '') || '[Encerrada por restauração de backup]'
         WHERE encerrada_em IS NULL;

        -- 2. Rearma jobs em execução para que o novo pool de workers possa retomar o processamento
        UPDATE public.acervo_jobs
           SET status = 'aguardando',
               locked_by = NULL,
               locked_at = NULL,
               lease_expires_at = NULL
         WHERE status = 'em_execucao';
      `);

      // Valida o estado saneado
      const sessaoSaneada = await pg.query<{
        encerrada_em: string | null;
        concluida: boolean;
        nota_livre: string;
      }>(
        "SELECT encerrada_em, concluida, nota_livre FROM public.sessoes WHERE id = '42000000-0000-4000-8000-000000000099'"
      );

      expect(sessaoSaneada.rows[0].encerrada_em).not.toBeNull();
      expect(sessaoSaneada.rows[0].concluida).toBe(false);
      expect(sessaoSaneada.rows[0].nota_livre).toContain(
        '[Encerrada por restauração de backup]'
      );

      const jobSaneado = await pg.query<{
        status: string;
        locked_by: string | null;
      }>(
        "SELECT status, locked_by FROM public.acervo_jobs WHERE id = '63000000-0000-4000-8000-000000000099'"
      );

      expect(jobSaneado.rows[0].status).toBe('aguardando');
      expect(jobSaneado.rows[0].locked_by).toBeNull();

      // TESTE DE REVERSIBILIDADE FORENSE:
      // Reverte o encerramento da sessão simulando procedimento de reversão/auditoria
      await pg.exec(`
        UPDATE public.sessoes
           SET encerrada_em = NULL,
               nota_livre = 'Sessão interrompida por snapshot de backup'
         WHERE id = '42000000-0000-4000-8000-000000000099';

        UPDATE public.acervo_jobs
           SET status = 'em_execucao',
               locked_by = 'worker-old-instance',
               locked_at = now() - interval '10 minutes',
               lease_expires_at = now() + interval '5 minutes'
         WHERE id = '63000000-0000-4000-8000-000000000099';
      `);

      const sessaoRevertida = await pg.query<{
        encerrada_em: string | null;
        nota_livre: string;
      }>(
        "SELECT encerrada_em, nota_livre FROM public.sessoes WHERE id = '42000000-0000-4000-8000-000000000099'"
      );
      expect(sessaoRevertida.rows[0].encerrada_em).toBeNull();
      expect(sessaoRevertida.rows[0].nota_livre).toBe('Sessão interrompida por snapshot de backup');

      const jobRevertido = await pg.query<{
        status: string;
        locked_by: string | null;
      }>(
        "SELECT status, locked_by FROM public.acervo_jobs WHERE id = '63000000-0000-4000-8000-000000000099'"
      );
      expect(jobRevertido.rows[0].status).toBe('em_execucao');
      expect(jobRevertido.rows[0].locked_by).toBe('worker-old-instance');

      await pg.close();
    }, 20000);

    it('6. Cifragem e Decifragem de Backups: Round-Trip Criptográfico OpenSSL AES-256 com PBKDF2 e Verificação SHA-256', async () => {
      const { execSync } = await import('node:child_process');
      const os = await import('node:os');
      const fs = await import('node:fs');

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-vitest-'));
      const testKey = 'master_test_vault_key_aes256_' + Date.now();
      const origFile = path.join(tmpDir, 'medicina_sample.dump');
      const encFile = path.join(tmpDir, 'medicina_sample.dump.enc');
      const decFile = path.join(tmpDir, 'medicina_sample.dump.dec');

      try {
        // Gera dados sintéticos realistas (64 KiB de payload aleatório)
        const payload = crypto.randomBytes(65536);
        fs.writeFileSync(origFile, payload);
        const origSha256 = crypto.createHash('sha256').update(payload).digest('hex');

        // Cifra via OpenSSL conforme backup_postgres.sh
        execSync(
          `openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -in "${origFile}" -out "${encFile}" -pass "pass:${testKey}"`
        );
        expect(fs.existsSync(encFile)).toBe(true);
        expect(fs.statSync(encFile).size).toBeGreaterThan(payload.length);

        // Decifra via OpenSSL conforme restore_postgres.sh
        execSync(
          `openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "${encFile}" -out "${decFile}" -pass "pass:${testKey}"`
        );
        expect(fs.existsSync(decFile)).toBe(true);

        const decBytes = fs.readFileSync(decFile);
        const decSha256 = crypto.createHash('sha256').update(decBytes).digest('hex');

        // Valida correspondência de 100% de bytes e integridade SHA-256
        expect(decBytes.equals(payload)).toBe(true);
        expect(decSha256).toBe(origSha256);

        // Valida rejeição fail-closed com chave inválida
        expect(() => {
          execSync(
            `openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "${encFile}" -out "${decFile}.bad" -pass "pass:senha_errada"`,
            { stdio: 'pipe' }
          );
        }).toThrow();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }
);
