import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MODULE_ROOT = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';
const PGLITE_INDEX = path.join(MODULE_ROOT, '@electric-sql/pglite/dist/index.js');
const PGLITE_VECTOR = path.join(MODULE_ROOT, '@electric-sql/pglite-pgvector/dist/index.js');
const HAS_PGLITE = existsSync(PGLITE_INDEX) && existsSync(PGLITE_VECTOR);

const ESTUDANTE_1 = {
  id: '10000000-0000-4000-8000-000000000001',
  authUserId: 'a0000000-0000-4000-8000-000000000001',
  nome: 'Estudante Ficticia 1 F1.04',
  email: 'estudante1.f104@example.invalid',
  papel: 'estudante' as const,
};

const ESTUDANTE_2 = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'a0000000-0000-4000-8000-000000000002',
  nome: 'Estudante Ficticia 2 F1.04',
  email: 'estudante2.f104@example.invalid',
  papel: 'estudante' as const,
};

const RESPONSAVEL_1 = {
  id: '20000000-0000-4000-8000-000000000001',
  authUserId: 'b0000000-0000-4000-8000-000000000001',
  nome: 'Responsavel Ficticio 1 F1.04',
  email: 'responsavel1.f104@example.invalid',
  papel: 'responsavel' as const,
};

const RESPONSAVEL_2 = {
  id: '20000000-0000-4000-8000-000000000002',
  authUserId: 'b0000000-0000-4000-8000-000000000002',
  nome: 'Responsavel Ficticio 2 F1.04',
  email: 'responsavel2.f104@example.invalid',
  papel: 'responsavel' as const,
};

const DUMMY_VECTOR = '[' + Array(1536).fill('0.025').join(',') + ']';

describe.skipIf(!HAS_PGLITE)(
  'F1.16 — Prioridade 2: Testes de Segurança RLS em PostgreSQL 18.6 PGlite Descartável',
  () => {
    let pg: {
      exec: (sql: string) => Promise<unknown>;
      query: <T = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ) => Promise<{ rows: T[] }>;
      close: () => Promise<void>;
    };

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

    const f104ProposalSql = readSql('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql');
    const f109ProposalSql = readSql(
      'docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'
    );
    const f110StorageProposalSql = readSql(
      'docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql'
    );
    const f111QueueProposalSql = readSql(
      'docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql'
    );
    const f112SearchProposalSql = readSql(
      'docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'
    );

    beforeAll(async () => {
      const { PGlite } = await import(pathToFileURL(PGLITE_INDEX).href);
      const { vector } = await import(pathToFileURL(PGLITE_VECTOR).href);
      pg = await PGlite.create({ extensions: { vector } });

      // Aplicação da sequência canônica completa sobre PostgreSQL descartável real
      await pg.exec(sql0000);
      await pg.exec(sql0001);
      await pg.exec(sql0002);
      await pg.exec(sql0003);
      await pg.exec(fixturesSql);
      await pg.exec(f104ProposalSql);
      await pg.exec(f109ProposalSql);
      await pg.exec(f110StorageProposalSql);
      await pg.exec(f111QueueProposalSql);
      await pg.exec(f112SearchProposalSql);

      // Popula embedding vetorial de 1536 dimensões para o chunk de Citologia do Responsável 1
      await pg.exec(
        `UPDATE public.acervo_chunks
            SET embedding = '${DUMMY_VECTOR}'::vector(1536)
          WHERE id = '62000000-0000-4000-8000-000000000001';`
      );
    });

    afterAll(async () => {
      if (pg) {
        await pg.close();
      }
    });

    // 1. Responsável acessando seus próprios dados e acervo
    it('1. Responsável acessando seus próprios dados e acervo', async () => {
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
          RESPONSAVEL_1.id,
          RESPONSAVEL_1.papel,
        ]);

        // Acessa seu próprio perfil e da estudante vinculada
        const perfisRes = await pg.query<{ id: string }>(
          'SELECT id FROM public.perfis ORDER BY id;'
        );
        const perfilIds = perfisRes.rows.map((r) => r.id);
        expect(perfilIds).toContain(RESPONSAVEL_1.id);
        expect(perfilIds).toContain(ESTUDANTE_1.id);
        expect(perfilIds).not.toContain(ESTUDANTE_2.id);
        expect(perfilIds).not.toContain(RESPONSAVEL_2.id);

        // Acessa vínculo em responsavel_estudante
        const vinculoRes = await pg.query<{ estudante_perfil_id: string }>(
          'SELECT estudante_perfil_id FROM public.responsavel_estudante;'
        );
        expect(vinculoRes.rows.length).toBe(1);
        expect(vinculoRes.rows[0].estudante_perfil_id).toBe(ESTUDANTE_1.id);

        // Acessa apenas seus arquivos de acervo (enviado_por = RESPONSAVEL_1.id)
        const acervoRes = await pg.query<{ id: string; titulo: string }>(
          'SELECT id, titulo FROM public.acervo_arquivos;'
        );
        expect(acervoRes.rows.length).toBe(1);
        expect(acervoRes.rows[0].id).toBe('60000000-0000-4000-8000-000000000001');
        expect(acervoRes.rows[0].titulo).toBe('Apostila Citologia R1');

        // Pode inserir um novo arquivo para si mesmo
        const novoId = '60000000-0000-4000-8000-000000000099';
        await pg.query(
          `INSERT INTO public.acervo_arquivos (
             id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular,
             file_path, mime, tamanho_bytes, enviado_por, status_processamento, hash_conteudo
           ) VALUES (
             $1::uuid, '30000000-0000-4000-8000-000000000001', 'Novo PDF R1', 'apostila', 1, 'ENEM',
             'f1_16/teste-r1.pdf', 'application/pdf', 1024, $2::uuid, 'aguardando',
             '9999999999999999999999999999999999999999999999999999999999999999'
           );`,
          [novoId, RESPONSAVEL_1.id]
        );

        const checkInsert = await pg.query<{ id: string }>(
          'SELECT id FROM public.acervo_arquivos WHERE id = $1::uuid;',
          [novoId]
        );
        expect(checkInsert.rows.length).toBe(1);
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    // 2. Estudante acessando dados autorizados e acervo vinculado via medicina.fn_busca_hibrida_acervo
    it('2. Estudante acessando dados autorizados e acervo vinculado via medicina.fn_busca_hibrida_acervo', async () => {
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
          ESTUDANTE_1.id,
          ESTUDANTE_1.papel,
        ]);

        // Acessa seus próprios ciclos e sessões
        const ciclosRes = await pg.query<{ id: string }>('SELECT id FROM public.ciclos;');
        expect(ciclosRes.rows.map((r) => r.id)).toEqual(['40000000-0000-4000-8000-000000000001']);

        const sessoesRes = await pg.query<{ id: string }>('SELECT id FROM public.sessoes;');
        expect(sessoesRes.rows.map((r) => r.id)).toEqual(['42000000-0000-4000-8000-000000000001']);

        // Bloqueio C14: SELECT direto em acervo_arquivos retorna 0 linhas para estudante
        const diretoArquivos = await pg.query('SELECT * FROM public.acervo_arquivos;');
        expect(diretoArquivos.rows.length).toBe(0);

        // SELECT direto em acervo_chunks retorna 0 linhas para estudante
        const diretoChunks = await pg.query('SELECT * FROM public.acervo_chunks;');
        expect(diretoChunks.rows.length).toBe(0);

        // Acesso legítimo ao acervo via função de busca híbrida com vínculo verificado
        const buscaRes = await pg.query<{
          chunk_id: string;
          arquivo_id: string;
          arquivo_titulo: string;
        }>(
          `SELECT chunk_id, arquivo_id, arquivo_titulo
             FROM medicina.fn_busca_hibrida_acervo(
               'citologia',
               $1::vector(1536),
               NULL,
               5,
               0.0,
               $2::text,
               $3::uuid
             );`,
          [DUMMY_VECTOR, ESTUDANTE_1.papel, ESTUDANTE_1.id]
        );

        expect(buscaRes.rows.length).toBeGreaterThan(0);
        expect(buscaRes.rows[0].arquivo_id).toBe('60000000-0000-4000-8000-000000000001');
        expect(buscaRes.rows[0].arquivo_titulo).toBe('Apostila Citologia R1');
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    // 3. Usuário tentando acessar ou alterar registro de outro perfil (cross-tenant - 0 linhas ou erro 42501)
    it('3. Usuário tentando acessar ou alterar registro de outro perfil (cross-tenant - 0 linhas ou erro 42501)', async () => {
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
          ESTUDANTE_1.id,
          ESTUDANTE_1.papel,
        ]);

        // Estudante 1 tenta ler sessão da Estudante 2 -> 0 linhas
        const crossSessao = await pg.query(
          'SELECT * FROM public.sessoes WHERE perfil_id = $1::uuid;',
          [ESTUDANTE_2.id]
        );
        expect(crossSessao.rows.length).toBe(0);

        // Estudante 1 tenta atualizar sessão da Estudante 2 -> afeta 0 linhas
        await pg.query(
          "UPDATE public.sessoes SET nota_livre = 'ataque cross-tenant' WHERE perfil_id = $1::uuid;",
          [ESTUDANTE_2.id]
        );
        const checkAuditoria = await pg.query<{ nota_livre: string }>(
          'SELECT nota_livre FROM public.sessoes WHERE id = $1::uuid;',
          ['42000000-0000-4000-8000-000000000002']
        );
        expect(checkAuditoria.rows.length).toBe(0);

        // Estudante 1 tenta spoofar o perfil na busca híbrida -> erro 42501
        await expect(
          pg.query(
            `SELECT * FROM medicina.fn_busca_hibrida_acervo(
               'citologia', $1::vector(1536), NULL, 5, 0.0, 'estudante', $2::uuid
             );`,
            [DUMMY_VECTOR, ESTUDANTE_2.id]
          )
        ).rejects.toThrow(/42501|Conflito de identidade RLS|permission denied/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }

      // Responsável 1 tenta acessar arquivo de Responsável 2
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
          RESPONSAVEL_1.id,
          RESPONSAVEL_1.papel,
        ]);

        const crossAcervo = await pg.query(
          'SELECT * FROM public.acervo_arquivos WHERE enviado_por = $1::uuid;',
          [RESPONSAVEL_2.id]
        );
        expect(crossAcervo.rows.length).toBe(0);

        await pg.query(
          "UPDATE public.acervo_arquivos SET titulo = 'adulterado' WHERE enviado_por = $1::uuid;",
          [RESPONSAVEL_2.id]
        );
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    // 4. Sessão ausente ou inválida (fail-closed, 0 linhas retornadas)
    it('4. Sessão ausente ou inválida (fail-closed, 0 linhas retornadas)', async () => {
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        // Conexão medicina_app sem chamar medicina.set_context (sessão ausente)
        // Usa colunas permitidas no GRANT para verificar comportamento fail-closed do RLS
        const perfisSemContexto = await pg.query(
          'SELECT id, nome, email, papel FROM public.perfis;'
        );
        expect(perfisSemContexto.rows.length).toBe(0);

        const sessoesSemContexto = await pg.query('SELECT * FROM public.sessoes;');
        expect(sessoesSemContexto.rows.length).toBe(0);

        const acervoSemContexto = await pg.query('SELECT * FROM public.acervo_arquivos;');
        expect(acervoSemContexto.rows.length).toBe(0);

        const cardsSemContexto = await pg.query('SELECT * FROM public.cards;');
        expect(cardsSemContexto.rows.length).toBe(0);

        const idempotentesSemContexto = await pg.query('SELECT * FROM public.operacoes_idempotentes;');
        expect(idempotentesSemContexto.rows.length).toBe(0);
      } finally {
        await pg.exec('ROLLBACK;');
      }

      // Tentativa de definir contexto com UUID inexistente
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await expect(
          pg.query("SELECT medicina.set_context('99999999-9999-4999-8999-999999999999'::uuid, 'estudante');")
        ).rejects.toThrow(/P0001|nao existe/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }

      // Tentativa de definir contexto com papel divergente do banco
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await expect(
          pg.query("SELECT medicina.set_context($1::uuid, 'responsavel');", [ESTUDANTE_1.id])
        ).rejects.toThrow(/P0001|nao existe/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }

      // Tentativa de definir papel arbitrário não suportado
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await expect(
          pg.query("SELECT medicina.set_context($1::uuid, 'admin');", [ESTUDANTE_1.id])
        ).rejects.toThrow(/P0001|Papel invalido/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    // 5. Papel incorreto (ex: estudante tentando curadoria/acervo direto ou responsável tentando executar sessão de estudo)
    it('5. Papel incorreto (estudante em curadoria/acervo direto vs responsável em sessão de estudo)', async () => {
      // Subcenário A: Estudante tentando operações de responsável
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
          ESTUDANTE_1.id,
          ESTUDANTE_1.papel,
        ]);

        const curadoria = await pg.query('SELECT * FROM public.curadoria_fila;');
        expect(curadoria.rows.length).toBe(0);

        const allowlist = await pg.query('SELECT * FROM public.allowlist;');
        expect(allowlist.rows.length).toBe(0);

        await expect(
          pg.query(
            `INSERT INTO public.acervo_arquivos (
               id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular,
               file_path, mime, tamanho_bytes, enviado_por, status_processamento, hash_conteudo
             ) VALUES (
               '60000000-0000-4000-8000-000000000077'::uuid, '30000000-0000-4000-8000-000000000001',
               'Tentativa Estudante', 'apostila', 1, 'ENEM', 'caminho.pdf', 'application/pdf', 10,
               $1::uuid, 'aguardando', '7777777777777777777777777777777777777777777777777777777777777777'
             );`,
            [ESTUDANTE_1.id]
          )
        ).rejects.toThrow(/42501|violates row-level security|permission denied/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }

      // Subcenário B: Responsável tentando executar sessão de estudo (Princípio 1.2 ESPEC)
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
          RESPONSAVEL_1.id,
          RESPONSAVEL_1.papel,
        ]);

        // Responsável NUNCA lê sessões individuais brutas
        const sessoesBrutas = await pg.query('SELECT * FROM public.sessoes;');
        expect(sessoesBrutas.rows.length).toBe(0);

        // Responsável bloqueado ao tentar inserir sessão de estudo
        await expect(
          pg.query(
            `INSERT INTO public.sessoes (
               id, perfil_id, ciclo_bloco_id, topico_id, iniciada_em, segundos_efetivos,
               segundos_pausa, etapa_atingida, concluida
             ) VALUES (
               '42000000-0000-4000-8000-000000000088'::uuid, $1::uuid,
               '41000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001',
               now(), 100, 0, 'conteudo', false
             );`,
            [RESPONSAVEL_1.id]
          )
        ).rejects.toThrow(/42501|violates row-level security|permission denied/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    // 6. Operações de escrita não autorizadas bloqueadas por WITH CHECK (erro 42501)
    it('6. Operações de escrita não autorizadas bloqueadas por WITH CHECK (erro 42501)', async () => {
      // Subcenário A: Tentativa de criar sessão forjando perfil_id de outro usuário
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
          ESTUDANTE_1.id,
          ESTUDANTE_1.papel,
        ]);

        await expect(
          pg.query(
            `INSERT INTO public.sessoes (
               id, perfil_id, ciclo_bloco_id, topico_id, iniciada_em, segundos_efetivos,
               segundos_pausa, etapa_atingida, concluida
             ) VALUES (
               '42000000-0000-4000-8000-000000000099'::uuid, $1::uuid,
               '41000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001',
               now(), 100, 0, 'conteudo', false
             );`,
            [ESTUDANTE_2.id]
          )
        ).rejects.toThrow(/42501|violates row-level security|permission denied/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }

      // Subcenário B: Tentativa de escalada de privilégio: estudante alterando seu papel para 'responsavel'
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
          ESTUDANTE_1.id,
          ESTUDANTE_1.papel,
        ]);

        await expect(
          pg.query(
            "UPDATE public.perfis SET papel = 'responsavel' WHERE id = $1::uuid;",
            [ESTUDANTE_1.id]
          )
        ).rejects.toThrow(/42501|violates row-level security|permission denied/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }

      // Subcenário C: Tentativa de gravar em operacoes_idempotentes com perfil_id alheio
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
          ESTUDANTE_1.id,
          ESTUDANTE_1.papel,
        ]);

        await expect(
          pg.query(
            `INSERT INTO public.operacoes_idempotentes (
               perfil_id, escopo, chave_idempotencia, payload_hash, resposta_resumo
             ) VALUES (
               $1::uuid, 'sessao.concluir', 'chave-spoof', 'hash-spoof', '{"ok":true}'::jsonb
             );`,
            [ESTUDANTE_2.id]
          )
        ).rejects.toThrow(/42501|violates row-level security|permission denied/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    // 7. Autenticação via medicina_auth operando isolada sem acesso a tabelas do aplicativo
    it('7. Autenticação via medicina_auth operando isolada sem acesso a tabelas do aplicativo', async () => {
      // Bloqueio a tabelas de domínio
      const tabelasProibidas = [
        'public.perfis',
        'public.sessoes',
        'public.ciclos',
        'public.acervo_arquivos',
        'public.allowlist',
      ];

      for (const tabela of tabelasProibidas) {
        await pg.exec('BEGIN; SET LOCAL ROLE medicina_auth;');
        try {
          await expect(pg.query(`SELECT * FROM ${tabela};`)).rejects.toThrow(
            /42501|permission denied/i
          );
        } finally {
          await pg.exec('ROLLBACK;');
        }
      }

      // Bloqueio a funções do schema medicina reservadas ao app
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_auth;');
      try {
        await expect(
          pg.query("SELECT medicina.set_context($1::uuid, 'estudante');", [ESTUDANTE_1.id])
        ).rejects.toThrow(/42501|permission denied/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }

      // Acesso exclusivo e seguro via SECURITY DEFINER medicina.autenticar_por_email
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_auth;');
      try {
        // Email fora da allowlist -> 0 linhas (proteção contra enumeração de contas)
        const foraDaAllowlist = await pg.query(
          "SELECT * FROM medicina.autenticar_por_email('invasor@example.invalid');"
        );
        expect(foraDaAllowlist.rows.length).toBe(0);

        // Email na allowlist -> retorna credencial autorizada para verificação de senha no NextAuth
        const loginAutorizado = await pg.query<{
          id: string;
          email: string;
          password_hash: string;
          papel: string;
        }>('SELECT * FROM medicina.autenticar_por_email($1::text);', [ESTUDANTE_1.email]);

        expect(loginAutorizado.rows.length).toBe(1);
        expect(loginAutorizado.rows[0].id).toBe(ESTUDANTE_1.id);
        expect(loginAutorizado.rows[0].papel).toBe('estudante');
        expect(loginAutorizado.rows[0].password_hash).toMatch(/^\$2a\$12\$/);
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    // 8. Negação estrita de acesso a password_hash para o papel medicina_app
    it('8. Negação estrita de acesso a password_hash para o papel medicina_app', async () => {
      // Tentativa de ler password_hash explicitamente -> erro 42501 (permission denied)
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
          ESTUDANTE_1.id,
          ESTUDANTE_1.papel,
        ]);

        await expect(
          pg.query('SELECT password_hash FROM public.perfis WHERE id = $1::uuid;', [
            ESTUDANTE_1.id,
          ])
        ).rejects.toThrow(/42501|permission denied/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }

      // Tentativa de ler SELECT * (expande coluna password_hash) -> erro 42501 (permission denied)
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
          ESTUDANTE_1.id,
          ESTUDANTE_1.papel,
        ]);

        await expect(
          pg.query('SELECT * FROM public.perfis WHERE id = $1::uuid;', [ESTUDANTE_1.id])
        ).rejects.toThrow(/42501|permission denied/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }

      // Leitura apenas das colunas com GRANT explícito para medicina_app -> Sucesso
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
          ESTUDANTE_1.id,
          ESTUDANTE_1.papel,
        ]);

        const colunasAutorizadas = await pg.query<{ id: string; nome: string; papel: string }>(
          'SELECT id, nome, papel FROM public.perfis WHERE id = $1::uuid;',
          [ESTUDANTE_1.id]
        );
        expect(colunasAutorizadas.rows.length).toBe(1);
        expect(colunasAutorizadas.rows[0].id).toBe(ESTUDANTE_1.id);
      } finally {
        await pg.exec('ROLLBACK;');
      }

      // medicina_app NÃO tem permissão para chamar medicina.autenticar_por_email
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      try {
        await expect(
          pg.query('SELECT * FROM medicina.autenticar_por_email($1::text);', [ESTUDANTE_1.email])
        ).rejects.toThrow(/42501|permission denied/i);
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    // 9. Papel medicina_worker restrito ao seu domínio (acervo_jobs, acervo_chunks, etc.) sem acesso a dados pessoais
    it('9. Papel medicina_worker restrito ao seu domínio sem acesso a dados pessoais', async () => {
      // Bloqueio total a dados sensíveis de usuários e estudantes
      const tabelasSensiveis = [
        'public.perfis',
        'public.sessoes',
        'public.checkins',
        'public.cards',
        'public.simulados',
        'public.redacoes',
        'public.allowlist',
        'public.curadoria_fila',
      ];

      for (const tabela of tabelasSensiveis) {
        await pg.exec('BEGIN; SET LOCAL ROLE medicina_worker;');
        try {
          await expect(pg.query(`SELECT * FROM ${tabela};`)).rejects.toThrow(
            /42501|permission denied/i
          );
        } finally {
          await pg.exec('ROLLBACK;');
        }
      }

      // Acesso autorizado estritamente às tabelas do pipeline de ingestão
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_worker;');
      try {
        const jobs = await pg.query('SELECT count(*) FROM public.acervo_jobs;');
        expect(jobs.rows.length).toBe(1);

        const arquivos = await pg.query('SELECT count(*) FROM public.acervo_arquivos;');
        expect(arquivos.rows.length).toBe(1);

        const paginas = await pg.query('SELECT count(*) FROM public.acervo_paginas;');
        expect(paginas.rows.length).toBe(1);

        const chunks = await pg.query('SELECT count(*) FROM public.acervo_chunks;');
        expect(chunks.rows.length).toBe(1);

        const disciplinas = await pg.query('SELECT count(*) FROM public.disciplinas;');
        expect(disciplinas.rows.length).toBe(1);

        const topicos = await pg.query('SELECT count(*) FROM public.topicos;');
        expect(topicos.rows.length).toBe(1);
      } finally {
        await pg.exec('ROLLBACK;');
      }
    });

    // 10. Ausência total de vazamento de contexto entre transações e conexões reutilizadas (SET LOCAL e isolamento pós-DISCARD)
    it('10. Ausência total de vazamento de contexto entre transações e conexões reutilizadas (SET LOCAL e isolamento pós-DISCARD)', async () => {
      // Garante sessão limpa
      await pg.exec('RESET ROLE;');

      // Transação 1: Estudante 1 ativa contexto e consulta dados sob medicina_app
      await pg.exec('BEGIN; SET LOCAL ROLE medicina_app;');
      await pg.query('SELECT medicina.set_context($1::uuid, $2::text);', [
        ESTUDANTE_1.id,
        ESTUDANTE_1.papel,
      ]);
      const sessoesTx1 = await pg.query('SELECT * FROM public.sessoes;');
      expect(sessoesTx1.rows.length).toBe(1);
      await pg.exec('COMMIT;');

      // Imediatamente após COMMIT: contexto transacional SET LOCAL expirou
      await pg.exec('SET ROLE medicina_app;');
      const idAposCommit = await pg.query<{ current_perfil_id: string | null }>(
        'SELECT medicina.current_perfil_id();'
      );
      expect(idAposCommit.rows[0].current_perfil_id).toBeNull();

      const papelAposCommit = await pg.query<{ current_papel: string | null }>(
        'SELECT medicina.current_papel();'
      );
      expect(papelAposCommit.rows[0].current_papel).toBeNull();

      // Transação 2 na mesma conexão: sem novo set_context, avalia fail-closed
      await pg.exec('BEGIN;');
      const sessoesTx2 = await pg.query('SELECT * FROM public.sessoes;');
      expect(sessoesTx2.rows.length).toBe(0);
      await pg.exec('COMMIT;');

      // Simulação de retorno da conexão ao pool e ciclo de vida pós-DISCARD ALL / RESET
      await pg.exec('RESET ROLE;');
      await pg.exec('DISCARD ALL;');
      await pg.exec('SET ROLE medicina_app;');

      const idAposDiscard = await pg.query<{ current_perfil_id: string | null }>(
        'SELECT medicina.current_perfil_id();'
      );
      expect(idAposDiscard.rows[0].current_perfil_id).toBeNull();

      const sessoesAposDiscard = await pg.query('SELECT * FROM public.sessoes;');
      expect(sessoesAposDiscard.rows.length).toBe(0);

      await pg.exec('RESET ROLE;');
    });
  }
);
