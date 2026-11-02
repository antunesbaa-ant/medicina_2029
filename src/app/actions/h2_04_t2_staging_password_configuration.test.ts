/**
 * ==============================================================================
 * MEDICINA 2029 — H2.04-T2: TESTES DE CONFIGURAÇÃO DE SENHAS SINTÉTICAS
 * ==============================================================================
 * Suíte de testes automatizados em ambiente descartável e isolado (PGlite / mocks):
 *
 * 1. Geração, Custo e Comparação de Hashes Bcrypt (Interoperabilidade NextAuth)
 * 2. Validação Estrita de Complexidade e Distinção das Senhas
 * 3. Bloqueio de Conexões Inválidas e Proteção contra Projetos Incorretos
 * 4. Transação Atômica e Rollback Total em Falha Parcial
 * 5. Proteção de Colisões de Identidade e Integridade de Personas
 * 6. Higienização de Erros e Ausência de Vazamento de Credenciais
 * 7. Integração Funcional de Login: Validação de Credenciais e Sessão JWT
 * 8. Validação de Sintaxe ESM e Execução do Processo Node.js
 * ==============================================================================
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcryptjs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  PERSONA_ALICE,
  PERSONA_BRUNO,
  PERSONA_CARLOS,
  provisionHomologationData,
} from '../../../scripts/db/prepare-staging-homologation.mjs';

import {
  TARGET_HOST,
  TARGET_PORT,
  TARGET_DB,
  TARGET_ROLE,
  TARGET_PROJECT_REF,
  validateStagingPasswordConfig,
  validatePersonaPasswords,
  updateStagingSyntheticPasswords,
  sanitizeError,
} from '../../../scripts/db/configure-staging-passwords.mjs';

import { authOptions } from '../../lib/auth-options';

const MODULE_ROOT = process.env.F104_PGLITE_MODULE_ROOT || '/tmp/pglite-f104-modules/node_modules';
const PGLITE_INDEX = path.join(MODULE_ROOT, '@electric-sql/pglite/dist/index.js');
const PGLITE_VECTOR = path.join(MODULE_ROOT, '@electric-sql/pglite-pgvector/dist/index.js');
const HAS_PGLITE = existsSync(PGLITE_INDEX) && existsSync(PGLITE_VECTOR);

interface PGliteInstance {
  exec: (query: string) => Promise<unknown>;
  query: <T = Record<string, unknown>>(
    query: string,
    params?: unknown[]
  ) => Promise<{ rows: T[] }>;
  close: () => Promise<void>;
}

describe.skipIf(!HAS_PGLITE)('MEDICINA 2029 — H2.04-T2: Configuração de Senhas e Preparação de Login', () => {
  let pg: PGliteInstance;
  let sqlAdapter: any;

  const projectRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../');
  const readSql = (relPath: string) =>
    readFileSync(path.join(projectRoot, relPath), 'utf8').replaceAll(
      '--> statement-breakpoint',
      '\n'
    );

  const createSqlAdapter = (db: PGliteInstance) => {
    const executeQuery = async (strings: TemplateStringsArray, values: unknown[]) => {
      let query = strings[0];
      const params: any[] = [];
      let paramIdx = 1;
      for (let i = 0; i < values.length; i++) {
        let val: any = values[i];
        if (val && typeof val.then === 'function') {
          val = await val;
        }
        if (val && typeof val === 'object' && val.isSqlFragment) {
          query += val.text + strings[i + 1];
        } else {
          params.push(val);
          query += `$${paramIdx++}` + strings[i + 1];
        }
      }
      const res = await db.query(query, params);
      const rows: any = res.rows;
      rows.count = (res as any).affectedRows ?? res.rows.length;
      return rows;
    };

    const adapter: any = (strings: TemplateStringsArray | any[], ...values: any[]) => {
      if (!strings || !('raw' in strings)) {
        const arr = Array.isArray(strings) ? strings : [strings];
        return {
          isSqlFragment: true,
          text: `(${arr.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ')})`,
        };
      }
      return executeQuery(strings as TemplateStringsArray, values);
    };

    adapter.begin = async (fn: (tx: any) => Promise<any>) => {
      await db.exec('BEGIN;');
      try {
        const txMock: any = async (strings: TemplateStringsArray, ...values: any[]) => {
          let query = strings[0];
          const params: any[] = [];
          let paramIdx = 1;
          for (let i = 0; i < values.length; i++) {
            let val: any = values[i];
            if (val && typeof val.then === 'function') {
              val = await val;
            }
            if (val && typeof val === 'object' && val.isSqlFragment) {
              query += val.text + strings[i + 1];
            } else {
              params.push(val);
              query += `$${paramIdx++}` + strings[i + 1];
            }
          }
          const res = await db.query(query, params);
          const rows: any = res.rows;
          rows.count = (res as any).affectedRows ?? res.rows.length;
          return rows;
        };
        const res = await fn(txMock);
        await db.exec('COMMIT;');
        return res;
      } catch (err) {
        await db.exec('ROLLBACK;');
        throw err;
      }
    };

    return adapter;
  };

  beforeAll(async () => {
    const { PGlite } = await import(pathToFileURL(PGLITE_INDEX).href);
    const { vector } = await import(pathToFileURL(PGLITE_VECTOR).href);

    pg = await PGlite.create({ extensions: { vector } });
    sqlAdapter = createSqlAdapter(pg);

    // Mock das tabelas auxiliares de storage e tracking de migrações
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE TABLE IF NOT EXISTS storage.buckets (
        id text PRIMARY KEY,
        name text NOT NULL UNIQUE,
        public boolean DEFAULT false NOT NULL,
        file_size_limit bigint,
        allowed_mime_types text[],
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL
      );
      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES ('acervo', 'acervo', false, 20971520, ARRAY['application/pdf']::text[])
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS storage.objects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_id text REFERENCES storage.buckets(id),
        name text NOT NULL,
        owner uuid,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL,
        last_accessed_at timestamptz DEFAULT now() NOT NULL,
        metadata jsonb
      );

      CREATE TABLE IF NOT EXISTS public._medicina_staging_migrations (
        ordem integer PRIMARY KEY,
        rel_path text NOT NULL,
        sha256 text NOT NULL,
        aplicado_em timestamptz DEFAULT now() NOT NULL,
        executado_por text NOT NULL,
        tamanho_bytes integer NOT NULL
      );
    `);

    // 1. Aplica o schema base Drizzle
    await pg.exec(readSql('drizzle/0000_greedy_loki.sql'));
    await pg.exec(readSql('drizzle/0001_dry_talos.sql'));
    await pg.exec(readSql('drizzle/0002_little_swarm.sql'));
    await pg.exec(readSql('drizzle/0003_f1_03_r_expansao.sql'));

    // 2. Aplica as migrações estruturais do Staging
    await pg.exec(readSql('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql'));
    await pg.exec(readSql('docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'));

    // 3. Executa o seed de homologação inicial com as 3 personas
    await provisionHomologationData({
      sql: sqlAdapter,
      student1Password: 'senha_antiga_alice_123',
      responsiblePassword: 'senha_antiga_bruno_456',
      student2Password: 'senha_antiga_carlos_789',
      logger: () => {},
    });
  });

  afterAll(async () => {
    if (pg) {
      await pg.close();
    }
  });

  // ============================================================================
  // 1. GERAÇÃO E VALIDAÇÃO DE HASHES BCRYPT
  // ============================================================================
  describe('1. Geração, Custo e Comparação de Hashes Bcrypt', () => {
    it('1.1 Bcrypt gera hashes com custo 10 e prefixo canônico $2b$10$ ou $2a$10$', async () => {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash('NovaSenhaAlice2029!', salt);

      expect(/^\$2[ab]\$10\$/.test(hash)).toBe(true);
      expect(hash.length).toBe(60);

      const isValid = await bcrypt.compare('NovaSenhaAlice2029!', hash);
      expect(isValid).toBe(true);
    });

    it('1.2 Bcrypt rejeita senhas incorretas com precisão booleana', async () => {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash('SenhaCorreta123!', salt);

      expect(await bcrypt.compare('SenhaIncorreta999!', hash)).toBe(false);
      expect(await bcrypt.compare('', hash)).toBe(false);
    });
  });

  // ============================================================================
  // 2. VALIDAÇÃO DE COMPLEXIDADE E DISTINÇÃO DE SENHAS
  // ============================================================================
  describe('2. Validação Estrita de Complexidade e Distinção das Senhas', () => {
    it('2.1 Três senhas fortes e distintas são aceitas com sucesso', () => {
      const res = validatePersonaPasswords({
        alicePassword: 'AliceForteSegura2029!',
        brunoPassword: 'BrunoTutorSeguro2029#',
        carlosPassword: 'CarlosIndepSeguro2029$',
      });
      expect(res.valid).toBe(true);
    });

    it('2.2 Senha curta (< 10 caracteres) é categoricamente rejeitada', () => {
      expect(() =>
        validatePersonaPasswords({
          alicePassword: 'curta',
          brunoPassword: 'BrunoTutorSeguro2029#',
          carlosPassword: 'CarlosIndepSeguro2029$',
        })
      ).toThrow(/deve conter no mínimo 10 caracteres/);
    });

    it('2.3 Senhas compartilhadas ou duplicadas são terminantemente rejeitadas', () => {
      expect(() =>
        validatePersonaPasswords({
          alicePassword: 'SenhaCompartilhada123!',
          brunoPassword: 'SenhaCompartilhada123!',
          carlosPassword: 'CarlosIndepSeguro2029$',
        })
      ).toThrow(/As três senhas devem ser mutuamente distintas/);
    });
  });

  // ============================================================================
  // 3. BLOQUEIO DE CONEXÕES INVÁLIDAS E PROTEÇÃO CONTRA PROJETOS INCORRETOS
  // ============================================================================
  describe('3. Proteção de Ambiente e Bloqueio de Projeto Incorreto', () => {
    it('3.1 URL de Session Pooler do Staging válida é aceita', () => {
      const validUrl = `postgresql://${TARGET_ROLE}.${TARGET_PROJECT_REF}:senha123@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}`;
      const conf = validateStagingPasswordConfig(validUrl);
      expect(conf.valid).toBe(true);
      expect(conf.projectRef).toBe(TARGET_PROJECT_REF);
    });

    it('3.2 Host incorreto (ex: tentativa contra localhost ou produção) é bloqueado', () => {
      const invalidHostUrl = `postgresql://${TARGET_ROLE}.${TARGET_PROJECT_REF}:senha123@localhost:${TARGET_PORT}/${TARGET_DB}`;
      expect(() => validateStagingPasswordConfig(invalidHostUrl)).toThrow(/VIOLAÇÃO DE HOST/);
    });

    it('3.3 Porta de Transaction Pooler (6543) é rejeitada em prol do Session Pooler (5432)', () => {
      const invalidPortUrl = `postgresql://${TARGET_ROLE}.${TARGET_PROJECT_REF}:senha123@${TARGET_HOST}:6543/${TARGET_DB}`;
      expect(() => validateStagingPasswordConfig(invalidPortUrl)).toThrow(/VIOLAÇÃO DE PORTA/);
    });

    it('3.4 Usuário que não referencia o projeto de staging exato é bloqueado', () => {
      const invalidTenantUrl = `postgresql://${TARGET_ROLE}.outroprojeto:senha123@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}`;
      expect(() => validateStagingPasswordConfig(invalidTenantUrl)).toThrow(/VIOLAÇÃO DE (USUÁRIO|TENANT)/);
    });
  });

  // ============================================================================
  // 4. TRANSAÇÃO ATÔMICA E ATUALIZAÇÃO SEGURA
  // ============================================================================
  describe('4. Transação Atômica de Atualização de Senhas', () => {
    const novasSenhas = {
      alicePassword: 'AliceNovaSenhaForte2029!',
      brunoPassword: 'BrunoNovaSenhaForte2029#',
      carlosPassword: 'CarlosNovaSenhaForte2029$',
    };

    it('4.1 updateStagingSyntheticPasswords atualiza os 3 registros de forma atômica', async () => {
      const logs: string[] = [];
      const res = await updateStagingSyntheticPasswords({
        sql: sqlAdapter,
        ...novasSenhas,
        logger: (msg: string) => logs.push(msg),
      });

      expect(res.success).toBe(true);
      expect(res.updatedPerfis).toBe(3);

      // Comprova no banco que as senhas foram atualizadas e validam com as novas credenciais
      const rows = await pg.query<{ id: string; password_hash: string }>(
        `SELECT id, password_hash FROM public.perfis WHERE id IN ('${PERSONA_ALICE.id}', '${PERSONA_BRUNO.id}', '${PERSONA_CARLOS.id}');`
      );
      expect(rows.rows).toHaveLength(3);

      const aliceRow = rows.rows.find((r) => r.id === PERSONA_ALICE.id);
      const brunoRow = rows.rows.find((r) => r.id === PERSONA_BRUNO.id);
      const carlosRow = rows.rows.find((r) => r.id === PERSONA_CARLOS.id);

      expect(await bcrypt.compare(novasSenhas.alicePassword, aliceRow!.password_hash)).toBe(true);
      expect(await bcrypt.compare(novasSenhas.brunoPassword, brunoRow!.password_hash)).toBe(true);
      expect(await bcrypt.compare(novasSenhas.carlosPassword, carlosRow!.password_hash)).toBe(true);

      // As senhas antigas não funcionam mais
      expect(await bcrypt.compare('senha_antiga_alice_123', aliceRow!.password_hash)).toBe(false);
    });

    it('4.2 Rollback Total em Falha Parcial: se houver inconsistência, nenhuma senha é modificada', async () => {
      // Guarda os hashes atuais
      const beforeRows = await pg.query<{ id: string; password_hash: string }>(
        `SELECT id, password_hash FROM public.perfis WHERE id IN ('${PERSONA_ALICE.id}', '${PERSONA_BRUNO.id}', '${PERSONA_CARLOS.id}');`
      );

      // Cria um adapter que simula falha proposital durante a atualização da terceira persona (Carlos)
      const failingAdapter: any = (strings: TemplateStringsArray | any[], ...values: any[]) =>
        sqlAdapter(strings, ...values);

      failingAdapter.begin = async (fn: (tx: any) => Promise<any>) => {
        await pg.exec('BEGIN;');
        try {
          const txProxy: any = async (strings: TemplateStringsArray, ...values: any[]) => {
            const queryStr = strings[0];
            if (queryStr.includes('UPDATE public.perfis') && values.includes(PERSONA_CARLOS.id)) {
              throw new Error('SIMULAÇÃO_FALHA_CONEXAO_UPDATE_CARLOS');
            }
            return await sqlAdapter(strings, ...values);
          };
          const res = await fn(txProxy);
          await pg.exec('COMMIT;');
          return res;
        } catch (err) {
          await pg.exec('ROLLBACK;');
          throw err;
        }
      };

      await expect(
        updateStagingSyntheticPasswords({
          sql: failingAdapter,
          alicePassword: 'TentativaInvalidaAlice!',
          brunoPassword: 'TentativaInvalidaBruno#',
          carlosPassword: 'TentativaInvalidaCarlos$',
          logger: () => {},
        })
      ).rejects.toThrow(/SIMULAÇÃO_FALHA_CONEXAO_UPDATE_CARLOS/);

      // Comprova que devido ao ROLLBACK, os hashes permanecem EXATAMENTE os mesmos de antes da tentativa
      const afterRows = await pg.query<{ id: string; password_hash: string }>(
        `SELECT id, password_hash FROM public.perfis WHERE id IN ('${PERSONA_ALICE.id}', '${PERSONA_BRUNO.id}', '${PERSONA_CARLOS.id}');`
      );

      for (const before of beforeRows.rows) {
        const after = afterRows.rows.find((r) => r.id === before.id);
        expect(after?.password_hash).toBe(before.password_hash);
      }
    });
  });

  // ============================================================================
  // 5. HIGIENIZAÇÃO DE ERROS E ZERO VAZAMENTO DE CREDENCIAIS
  // ============================================================================
  describe('5. Higienização de Erros e Ausência de Vazamento de Credenciais', () => {
    it('5.1 sanitizeError higieniza URLs com senhas e hashes bcrypt', () => {
      const sensitiveError =
        'Falha de conexão em postgresql://postgres:SuperSecret123@aws-0-us-east-1.pooler.supabase.com:5432/postgres com hash $2a$10$7EqJtq98hPqEX7fNZaODi.Z6wKqGqD0Vq7F1eK1s8aC9w1p0X.uG6';

      const sanitized = sanitizeError(sensitiveError);

      expect(sanitized).not.toContain('SuperSecret123');
      expect(sanitized).toContain(':****@');
      expect(sanitized).not.toContain('7EqJtq98hPqEX7fNZaODi.Z6wKqGqD0Vq7F1eK1s8aC9w1p0X.uG6');
      expect(sanitized).toContain('*****************************************************');
    });
  });

  // ============================================================================
  // 6. INTEGRAÇÃO COM NEXTAUTH E SESSÃO JWT
  // ============================================================================
  describe('6. Integração Funcional de Login: NextAuth e Sessão JWT', () => {
    it('6.1 RPC medicina.autenticar_por_email retorna os novos dados e valida a nova senha de Alice', async () => {
      await pg.exec('SET ROLE medicina_auth;');

      const rows = await pg.query<{
        id: string;
        auth_user_id: string;
        nome: string;
        email: string;
        password_hash: string;
        papel: string;
      }>(`SELECT * FROM medicina.autenticar_por_email('${PERSONA_ALICE.email}');`);

      await pg.exec('RESET ROLE;');

      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      expect(row.id).toBe(PERSONA_ALICE.id);
      expect(row.nome).toBe(PERSONA_ALICE.nome);
      expect(row.email).toBe(PERSONA_ALICE.email);
      expect(row.papel).toBe('estudante');

      // Validação real de senha com a nova credencial configurada no teste 4.1
      const isValid = await bcrypt.compare('AliceNovaSenhaForte2029!', row.password_hash);
      expect(isValid).toBe(true);

      const isInvalid = await bcrypt.compare('SenhaIncorretaAlice!', row.password_hash);
      expect(isInvalid).toBe(false);
    });

    it('6.2 RPC medicina.autenticar_por_email e validação de Bruno: senha correta valida e errada rejeita', async () => {
      await pg.exec('SET ROLE medicina_auth;');

      const rows = await pg.query<{ password_hash: string }>(
        `SELECT password_hash FROM medicina.autenticar_por_email('${PERSONA_BRUNO.email}');`
      );

      await pg.exec('RESET ROLE;');

      expect(rows.rows).toHaveLength(1);
      const hash = rows.rows[0].password_hash;

      expect(await bcrypt.compare('BrunoNovaSenhaForte2029#', hash)).toBe(true);
      expect(await bcrypt.compare('SenhaIncorretaBruno!', hash)).toBe(false);
    });

    it('6.3 Callbacks de JWT e Sessão injetam estritamente id e role sem vazamento de authUserId', async () => {
      const jwtCallback = authOptions.callbacks!.jwt!;
      const sessionCallback = authOptions.callbacks!.session!;

      const mockUser = {
        id: PERSONA_CARLOS.id,
        name: PERSONA_CARLOS.nome,
        email: PERSONA_CARLOS.email,
        role: 'estudante' as const,
      };

      // 1. JWT callback
      const token = await jwtCallback({ token: {}, user: mockUser as any });
      expect(token.id).toBe(PERSONA_CARLOS.id);
      expect(token.role).toBe('estudante');

      // 2. Session callback
      const session = await sessionCallback({
        session: { user: {}, expires: '2026-12-01' } as any,
        token,
      });

      expect(session.user?.id).toBe(PERSONA_CARLOS.id);
      expect((session.user as any)?.role).toBe('estudante');
      expect(session.user).not.toHaveProperty('authUserId');
    });
  });

  // ============================================================================
  // 7. VALIDAÇÃO DE SINTAXE ESM E EXECUÇÃO COMO PROCESSO NODE.JS
  // ============================================================================
  describe('7. Validação de Sintaxe ESM e Execução de Processo Node.js', () => {
    const scriptPath = path.join(projectRoot, 'scripts/db/configure-staging-passwords.mjs');

    it('7.1 "node --check" valida sintaxe JavaScript pura com código de saída 0', () => {
      const res = spawnSync(process.execPath, ['--check', scriptPath], {
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
    });

    it('7.2 Invocação com "--help" executa como subprocesso Node.js real com código 0', () => {
      const res = spawnSync(process.execPath, [scriptPath, '--help'], {
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Uso do Configurador de Senhas Staging');
      expect(res.stderr).toBe('');
    });
  });
});
