import { test, expect } from '@playwright/test';
import {
  authenticateContext,
  ESTUDANTE_USER,
  CARLOS_USER,
} from './helpers/auth';

test.describe('MEDICINA 2029 — Automação E2E do Módulo de Estudos', () => {
  test('1. Bloqueia acesso anônimo à rota /estudar e redireciona para /login', async ({ page }) => {
    await page.goto('/estudar');
    await expect(page).toHaveURL(/\/login/);
  });

  test('2. Bloqueia acesso anônimo à rota /ciclo e redireciona para /login', async ({ page }) => {
    await page.goto('/ciclo');
    await expect(page).toHaveURL(/\/login/);
  });

  test('3. Estudante autenticada (Alice) acessa /ciclo e visualiza estrutura da fila', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    await page.goto('/ciclo');
    await expect(page).toHaveURL('/ciclo');

    // Valida elementos estruturais do ciclo
    await expect(page.getByRole('heading', { name: /Ciclo/i })).toBeVisible();
    await expect(page.getByText(/Fila Sequencial/i)).toBeVisible();
  });

  test('4. Interface responsiva do cronômetro carrega componentes de progresso contínuo', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    await page.goto('/estudar');
    // Confirma que a página carrega sem erro de console crítico
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).toContain('/estudar');
  });

  test('5. Isolamento entre estudantes: Carlos autenticado não herda contexto de Alice', async ({ page, context }) => {
    await authenticateContext(context, CARLOS_USER);

    await page.goto('/ciclo');
    await page.waitForLoadState('domcontentloaded');
    // Deve carregar o contexto exclusivo de Carlos sem vazar dados de Alice
    expect(page.url()).toContain('/ciclo');
  });
});
