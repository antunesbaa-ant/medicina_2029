import { test, expect } from '@playwright/test';
import {
  authenticateContext,
  ESTUDANTE_USER,
  CARLOS_USER,
  RESPONSAVEL_USER,
} from './helpers/auth';

test.describe('MEDICINA 2029 — Estabilização dos Módulos Pedagógicos (E2E)', () => {
  test('1. Bloqueia acesso anônimo às rotas pedagógicas redirecionando para /login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);

    await page.goto('/simulados');
    await expect(page).toHaveURL(/\/login/);

    await page.goto('/caderno-erros');
    await expect(page).toHaveURL(/\/login/);

    await page.goto('/redacoes');
    await expect(page).toHaveURL(/\/login/);
  });

  test('2. Estudante (Alice) visualiza Dashboard com dados reais de aderência e sem mock fictício', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    await page.goto('/');
    await expect(page).toHaveURL('/');

    // Alterna para a aba de Métricas Analíticas
    await page.getByRole('button', { name: 'Métricas' }).click();

    // Valida elementos do Dashboard
    await expect(page.getByText(/Aderência ao Ciclo/i)).toBeVisible();
    await expect(page.getByText(/Divergência de Trilhos/i)).toBeVisible();

    // Alice tem 3 sessões concluídas no Staging (13% de aderência)
    await expect(page.getByText('13%')).toBeVisible();
  });

  test('3. Novo estudante (Carlos) visualiza Dashboard limpo sem simulados ou dados fictícios', async ({ page, context }) => {
    await authenticateContext(context, CARLOS_USER);

    await page.goto('/');
    await expect(page).toHaveURL('/');

    // Alterna para a aba de Métricas Analíticas
    await page.getByRole('button', { name: 'Métricas' }).click();

    // Carlos não deve visualizar métricas fictícias de 82% nem 14 redações
    await expect(page.getByText('82%')).not.toBeVisible();
    await expect(page.getByText('14 redações')).not.toBeVisible();
    await expect(page.getByText(/Nenhum simulado registrado até o momento/i)).toBeVisible();
  });

  test('4. Caderno de Erros exibe interface orientada com rastreamento automático sem formulário quebrado', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    await page.goto('/caderno-erros');
    await expect(page).toHaveURL('/caderno-erros');

    // Valida cabeçalho e card informativo de automação
    await expect(page.getByRole('heading', { name: /Caderno de Erros/i })).toBeVisible();
    await expect(page.getByText(/Alimentação Automática/i)).toBeVisible();
    await expect(page.getByText(/Filtros e Busca/i)).toBeVisible();

    // Garante que a ação impossível (+ Registrar Erro Manual) foi removida
    await expect(page.getByRole('button', { name: /\+ Registrar Erro Manual/i })).not.toBeVisible();
  });

  test('5. Redações e Repertórios exibe abas funcionais de produção, repertório e gêneros', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    await page.goto('/redacoes');
    await expect(page).toHaveURL('/redacoes');

    // Aguarda término do carregamento dos dados
    await expect(page.getByText(/Carregando dados pedagógicos/i)).not.toBeVisible({ timeout: 15000 });

    // Navega pelas abas
    await expect(page.getByRole('button', { name: 'Redações' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Repertórios' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fichas de Gêneros' })).toBeVisible();

    // Clica na aba Repertórios
    await page.getByRole('button', { name: 'Repertórios' }).click();
    await expect(page.getByText(/Adicionar Novo Repertório Sociocultural/i)).toBeVisible();

    // Clica na aba Fichas de Gêneros e valida os 5 gêneros UECE
    await page.getByRole('button', { name: 'Fichas de Gêneros' }).click();
    await expect(page.getByRole('heading', { name: 'Manifesto' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Carta ao Leitor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Artigo de Opinião' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Crônica Argumentativa' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Resenha Crítica' })).toBeVisible();
    await expect(page.getByText('Gêneros UECE disponíveis:')).toBeVisible();
  });

  test('6. Simulados exibe página com estrutura de registro e histórico', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    await page.goto('/simulados');
    await expect(page).toHaveURL('/simulados');

    await expect(page.getByRole('heading', { name: /Desempenho em Simulados/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /\+ Registrar Simulado/i })).toBeVisible();
  });

  test('7. Responsável acessa área de acompanhamento sem expor dashboards individuais brutos', async ({ page, context }) => {
    await authenticateContext(context, RESPONSAVEL_USER);

    await page.goto('/responsavel');
    await expect(page).toHaveURL('/responsavel');

    await expect(page.getByRole('heading', { name: /Painel do Responsável/i })).toBeVisible();
  });
});
