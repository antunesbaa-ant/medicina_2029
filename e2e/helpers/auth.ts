import { encode } from 'next-auth/jwt';
import type { BrowserContext } from '@playwright/test';
import { E2E_NEXTAUTH_SECRET } from '../../playwright.config';

export interface MockSessionUser {
  id: string;
  name: string;
  email: string;
  role: 'estudante' | 'responsavel';
}

export const ESTUDANTE_USER: MockSessionUser = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Estudante Teste E2E',
  email: 'estudante@medicina2029.com.br',
  role: 'estudante',
};

export const RESPONSAVEL_USER: MockSessionUser = {
  id: '20000000-0000-4000-8000-000000000001',
  name: 'Responsavel Teste E2E',
  email: 'responsavel@medicina2029.com.br',
  role: 'responsavel',
};

export async function createSessionCookie(user: MockSessionUser): Promise<string> {
  return await encode({
    token: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      sub: user.id,
    },
    secret: E2E_NEXTAUTH_SECRET,
  });
}

export async function authenticateContext(
  context: BrowserContext,
  user: MockSessionUser = ESTUDANTE_USER
): Promise<void> {
  const token = await createSessionCookie(user);
  await context.addCookies([
    {
      name: 'next-auth.session-token',
      value: token,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
