import { describe, it, expect } from 'vitest';
import { validateEnv, getValidatedEnv, isProduction, isTest, isDevelopment } from './env';

describe('Validação Centralizada de Variáveis de Ambiente (F1.06)', () => {
  const validProductionEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    NEXTAUTH_SECRET: 'super-secure-production-secret-minimum-32-chars-long!',
    NEXTAUTH_URL: 'https://medicina2029.exemplo.com.br',
    DATABASE_URL: 'postgresql://medicina_user:complexpassword@db.prod.internal:5432/medicina_prod',
    GEMINI_API_KEY: 'valid-gemini-api-key'
  };

  it('deve aprovar uma configuração completa e segura em produção', () => {
    const result = validateEnv(validProductionEnv);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.env.NODE_ENV).toBe('production');
    expect(result.env.NEXTAUTH_SECRET).toBe(validProductionEnv.NEXTAUTH_SECRET);
  });

  it('deve REJEITAR em produção quando NEXTAUTH_SECRET possuir menos de 32 caracteres', () => {
    const result = validateEnv({
      ...validProductionEnv,
      NEXTAUTH_SECRET: 'curto_demais_123'
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('no mínimo 32 caracteres'))).toBe(true);
  });

  it('deve REJEITAR em produção quando NEXTAUTH_SECRET estiver ausente', () => {
    const envSemSecret = { ...validProductionEnv };
    delete envSemSecret.NEXTAUTH_SECRET;

    const result = validateEnv(envSemSecret);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('NEXTAUTH_SECRET é obrigatório'))).toBe(true);
  });

  it('deve REJEITAR em produção quando NEXTAUTH_SECRET for um valor padrão fraco conhecido', () => {
    const result = validateEnv({
      ...validProductionEnv,
      NEXTAUTH_SECRET: 'secret'
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('valor padrão inseguro'))).toBe(true);
  });

  it('deve REJEITAR em produção quando DATABASE_URL apontar para localhost ou 127.0.0.1', () => {
    const result = validateEnv({
      ...validProductionEnv,
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/medicina'
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('aponta para endereço local (localhost/127.0.0.1)'))).toBe(true);
  });

  it('deve permitir localhost em produção se ALLOW_LOCALHOST_IN_PRODUCTION for true', () => {
    const result = validateEnv({
      ...validProductionEnv,
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/medicina',
      ALLOW_LOCALHOST_IN_PRODUCTION: 'true'
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('deve REJEITAR em produção quando NEXTAUTH_URL não utilizar HTTPS', () => {
    const result = validateEnv({
      ...validProductionEnv,
      NEXTAUTH_URL: 'http://inseguro.exemplo.com.br'
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('deve utilizar protocolo seguro HTTPS'))).toBe(true);
  });

  it('deve REJEITAR quando ANTHROPIC_API_KEY for fornecida sem GEMINI_API_KEY (segregação de IA)', () => {
    const envCruzado: NodeJS.ProcessEnv = {
      ...validProductionEnv,
      ANTHROPIC_API_KEY: 'sk-ant-test-key'
    };
    delete envCruzado.GEMINI_API_KEY;

    const result = validateEnv(envCruzado);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Segregação de IA'))).toBe(true);
  });

  it('deve emitir avisos (warnings) em desenvolvimento sem bloquear a execução', () => {
    const result = validateEnv({
      NODE_ENV: 'development'
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('deve ser tolerante e permissivo em ambiente de testes (NODE_ENV = test)', () => {
    const result = validateEnv({
      NODE_ENV: 'test'
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.env.NODE_ENV).toBe('test');
  });

  it('getValidatedEnv deve lançar exceção ao falhar em produção e retornar dados quando válida', () => {
    expect(() => {
      getValidatedEnv({
        NODE_ENV: 'production',
        NEXTAUTH_SECRET: 'curto'
      });
    }).toThrow('Falha de validação de variáveis de ambiente em produção');

    const env = getValidatedEnv(validProductionEnv);
    expect(env.NODE_ENV).toBe('production');
    expect(env.NEXTAUTH_SECRET).toBe(validProductionEnv.NEXTAUTH_SECRET);
  });

  it('helpers de ambiente isProduction, isTest e isDevelopment devem refletir o estado correto', () => {
    expect(isProduction({ NODE_ENV: 'production' })).toBe(true);
    expect(isProduction({ NODE_ENV: 'development' })).toBe(false);

    expect(isTest({ NODE_ENV: 'test' })).toBe(true);
    expect(isTest({ NODE_ENV: 'production' })).toBe(false);

    expect(isDevelopment({ NODE_ENV: 'development' })).toBe(true);
    expect(isDevelopment({ NODE_ENV: undefined } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isDevelopment({ NODE_ENV: 'production' })).toBe(false);
  });
});
