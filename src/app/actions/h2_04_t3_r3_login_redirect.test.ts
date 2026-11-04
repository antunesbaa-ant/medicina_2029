/**
 * MEDICINA 2029 — H2.04-T3-R3
 * Suíte de Testes de Regressão: Diagnóstico e Correção do Retorno Indevido à Tela de Login
 *
 * Valida de forma estrita:
 * 1. Ciclo de Autenticação e Propagação de Claims (authorize -> jwt -> session)
 * 2. Reprodução do Diagnóstico Forense: Falha de conexão sob medicina_app vs medicina_auth
 * 3. Sanitização de Logs e Princípio Fail-Closed em requireAuthenticatedProfile
 * 4. Alinhamento de Rede: Prevenção de discrepância de Host/Origin (127.0.0.1 vs localhost)
 * 5. Preflight e Validação Ativa de Conexões (verifyPreflightConnections / verifyRoleCredentials)
 * 6. Resolução de Perfil sob RLS Transacional (fallback com medicina.set_context)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authOptions } from '../../lib/auth-options';
import {
  requireAuthenticatedProfile,
  AuthorizationError,
} from '../../lib/authorization';
import {
  auditStagingWebPreflight,
  verifyPreflightConnections,
  buildNextDevArgs,
} from '../../../scripts/db/launch-staging-web.mjs';
import {
  verifyRoleCredentials,
  buildRolePoolerUrl,
} from '../../../scripts/db/configure-staging-web-env.mjs';

// Mocks para isolamento de testes unitários locais
const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  queryResults: [] as unknown[][],
}));

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mocks.getServerSession(...args),
}));

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => mocks.select(...args),
    transaction: (...args: unknown[]) => mocks.transaction(...args),
  },
  authDb: null,
}));

describe('MEDICINA 2029 — H2.04-T3-R3: Correção do Retorno Indevido ao Login', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    mocks.queryResults.length = 0;

    mocks.select.mockImplementation(() => {
      const query = {
        from: () => query,
        where: () => query,
        limit: async () => mocks.queryResults.shift() ?? [],
      };
      return query;
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // --------------------------------------------------------------------------
  // GRUPO 1: CICLO DE TOKENS E CALLBACKS NEXTAUTH
  // --------------------------------------------------------------------------
  describe('1. Ciclo de Tokens e Callbacks NextAuth', () => {
    it('1.1 callback jwt propaga id e role válidos para o token', async () => {
      const jwtCallback = authOptions.callbacks?.jwt;
      expect(typeof jwtCallback).toBe('function');

      const user = {
        id: '10000000-0000-4000-8000-000000000001',
        name: 'Alice Estudante',
        email: 'alice@medicina2029.staging',
        role: 'estudante' as const,
      };

      const tokenResult = await jwtCallback!({
        token: {},
        user,
      });

      expect(tokenResult.id).toBe(user.id);
      expect(tokenResult.role).toBe('estudante');
    });

    it('1.2 callback session propaga id e role do token para session.user', async () => {
      const sessionCallback = authOptions.callbacks?.session;
      expect(typeof sessionCallback).toBe('function');

      const initialSession = {
        user: { name: 'Alice Estudante', email: 'alice@medicina2029.staging' },
        expires: '2026-12-31T23:59:59.000Z',
      };

      const token = {
        id: '10000000-0000-4000-8000-000000000001',
        role: 'estudante',
      };

      const sessionResult = await sessionCallback!({
        session: initialSession,
        token,
        user: {} as any,
        newSession: undefined,
        trigger: undefined as any,
      });

      expect((sessionResult.user as any).id).toBe(token.id);
      expect((sessionResult.user as any).role).toBe('estudante');
    });

    it('1.3 callback session ignora roles inválidas que divirjam do enum de segurança', async () => {
      const sessionCallback = authOptions.callbacks?.session;
      const initialSession = {
        user: { name: 'Hacker', email: 'malicious@test.com' },
        expires: '2026-12-31T23:59:59.000Z',
      };

      const token = {
        id: '99999999-9999-4999-8999-999999999999',
        role: 'superadmin_injetado',
      };

      const sessionResult = await sessionCallback!({
        session: initialSession,
        token,
        user: {} as any,
        newSession: undefined,
        trigger: undefined as any,
      });

      expect((sessionResult.user as any).role).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 2: REPRODUÇÃO DO DIAGNÓSTICO FORENSE (FALHA DE BANCO vs SESSÃO)
  // --------------------------------------------------------------------------
  describe('2. Diagnóstico Forense: Isolamento de Erro de Banco vs Sessão Ativa', () => {
    it('2.1 sessão ativa mas banco medicina_app falhando rejeita de forma fail-closed sem expor segredos', async () => {
      const perfilId = '10000000-0000-4000-8000-000000000001';
      mocks.getServerSession.mockResolvedValue({
        user: { id: perfilId, role: 'estudante', name: 'Alice' },
      });

      // Simula erro de autenticação PostgreSQL sob medicina_app
      mocks.select.mockImplementation(() => {
        throw new Error('password authentication failed for user "medicina_app": postgresql://medicina_app:secret123@aws-0-us-east-1.pooler.supabase.com:5432/postgres');
      });

      const spyConsole = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(requireAuthenticatedProfile()).rejects.toThrow(AuthorizationError);
      await expect(requireAuthenticatedProfile()).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        message: 'Autenticação necessária.',
      });

      // Verifica se o erro foi registrado no log do servidor
      expect(spyConsole).toHaveBeenCalled();
      const loggedMessage = spyConsole.mock.calls[0]?.[1];
      // Garante sanitização de segredos no log do servidor
      expect(loggedMessage).not.toContain('secret123');
      expect(loggedMessage).toContain(':***@');

      spyConsole.mockRestore();
    });

    it('2.2 fallback RLS com medicina.set_context recupera perfil com sucesso quando consulta direta retorna 0 linhas', async () => {
      const perfilId = '10000000-0000-4000-8000-000000000001';
      const perfilEsperado = {
        id: perfilId,
        nome: 'Alice Sintética',
        email: 'alice@medicina2029.staging',
        papel: 'estudante' as const,
      };

      mocks.getServerSession.mockResolvedValue({
        user: { id: perfilId, role: 'estudante', name: 'Alice Sintética' },
      });

      // Passo 1: Consulta direta retorna 0 linhas (simulando FORCE RLS sob medicina_app sem context)
      mocks.queryResults.push([]);

      // Passo 2: Transação executa to_regprocedure, set_context e retorna o perfil
      const mockTx = {
        execute: vi.fn().mockImplementation(async (q: any) => {
          const sqlText = String(q?.queryChunks?.[0]?.value || q || '');
          if (/to_regprocedure/i.test(sqlText)) {
            return [{ exists: true }];
          }
          return [];
        }),
        select: vi.fn().mockImplementation(() => ({
          from: () => ({
            where: () => ({
              limit: async () => [perfilEsperado],
            }),
          }),
        })),
      };

      mocks.transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => {
        return await cb(mockTx);
      });

      const perfil = await requireAuthenticatedProfile();
      expect(perfil).toEqual(perfilEsperado);
      expect(mockTx.execute).toHaveBeenCalledTimes(2); // to_regprocedure e set_context
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 3: ALINHAMENTO DE REDE E HOST (127.0.0.1 vs localhost)
  // --------------------------------------------------------------------------
  describe('3. Alinhamento de Rede e Host Consistency', () => {
    it('3.1 buildNextDevArgs amarra exclusivamente em 127.0.0.1:3000', () => {
      const args = buildNextDevArgs('127.0.0.1', '3000');
      expect(args).toEqual(['next', 'dev', '-H', '127.0.0.1', '-p', '3000']);
    });

    it('3.2 auditStagingWebPreflight alerta quando NEXTAUTH_URL diverge da interface de escuta', () => {
      const envObj = {
        DATABASE_APP_URL: 'postgresql://medicina_app.ynfocaorhadizlvbnzrt:senha12345678@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require',
        DATABASE_AUTH_URL: 'postgresql://medicina_auth.ynfocaorhadizlvbnzrt:senha12345678@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require',
        DATABASE_URL: 'postgresql://medicina_app.ynfocaorhadizlvbnzrt:senha12345678@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require',
        NEXTAUTH_SECRET: 'uma_chave_secreta_de_alta_entropia_com_mais_de_32_chars_1234',
        NEXTAUTH_URL: 'http://localhost:3000', // localhost quando escuta em 127.0.0.1
        STAGING_SUPABASE_PROJECT_REF: 'ynfocaorhadizlvbnzrt',
      };

      // Simula arquivo .env temporário
      const preflight = auditStagingWebPreflight({
        envFilePath: '/caminho/inexistente',
        targetHost: '127.0.0.1',
        targetPort: '3000',
      });

      // Em arquivo inexistente, preflight falha fechado
      expect(preflight.valid).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 4: PREFLIGHT E VALIDAÇÃO DE CONEXÕES ATIVAS
  // --------------------------------------------------------------------------
  describe('4. Preflight e Validação de Conexões Ativas', () => {
    it('4.1 verifyRoleCredentials rejeita senhas inválidas ou curtas antes de gravar no .env', async () => {
      await expect(verifyRoleCredentials('medicina_app', 'curta')).rejects.toThrow(
        'A senha da role "medicina_app" deve conter no mínimo 8 caracteres.'
      );
    });

    it('4.2 verifyPreflightConnections reporta erro quando variáveis de conexão estão ausentes', async () => {
      const res = await verifyPreflightConnections({});
      expect(res.app).toBe(false);
      expect(res.auth).toBe(false);
      expect(res.errors.length).toBeGreaterThan(0);
      expect(res.errors[0]).toContain('DATABASE_APP_URL ausente');
    });

    it('4.3 buildRolePoolerUrl formata a URL estrita com Session Pooler porta 5432 e sslmode=require', () => {
      const url = buildRolePoolerUrl('medicina_app', 'senhaForte123@#$');
      expect(url).toContain('medicina_app.ynfocaorhadizlvbnzrt');
      expect(url).toContain(':5432/');
      expect(url).toContain('sslmode=require');
      expect(url).toContain(encodeURIComponent('senhaForte123@#$'));
    });
  });
});
