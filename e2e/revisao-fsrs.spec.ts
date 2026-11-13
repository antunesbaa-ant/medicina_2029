import { test, expect } from '@playwright/test';
import {
  authenticateContext,
  ESTUDANTE_USER,
  RESPONSAVEL_USER,
  CARLOS_USER,
} from './helpers/auth';

test.describe('MEDICINA 2029 — Automação E2E da Revisão de Flashcards FSRS', () => {
  test('1. Bloqueia acesso anônimo à rota /revisao e redireciona para /login', async ({ page }) => {
    await page.goto('/revisao');
    await expect(page).toHaveURL(/\/login/);
  });

  test('2. Estudante autenticada (Alice) acessa /revisao e carrega interface com sucesso', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    const response = await page.goto('/revisao');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL('/revisao');

    // Aguarda conclusão do loading inicial
    await expect(page.getByText('Carregando seus cartões de revisão...')).not.toBeVisible({ timeout: 10000 });

    // Garante que não houve erro não tratado ou tela de falha
    await expect(page.getByRole('heading', { name: 'Falha no Carregamento' })).not.toBeVisible();

    // Deve renderizar ou o fluxo ativo de repetição espaçada ou o estado vazio "Tudo em Dia!"
    const hasActiveSession = await page.getByText(/Sessão de Repetição Espaçada/i).isVisible();
    const hasEmptyState = await page.getByRole('heading', { name: /Tudo em Dia!/i }).isVisible();

    expect(hasActiveSession || hasEmptyState).toBe(true);
  });

  test('3. Interação com flashcard (flip frente/verso e atalhos de teclado) ou confirmação de estado vazio', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    await page.goto('/revisao');
    await expect(page.getByText('Carregando seus cartões de revisão...')).not.toBeVisible({ timeout: 10000 });

    const hasActiveSession = await page.getByText(/Sessão de Repetição Espaçada/i).isVisible();

    if (hasActiveSession) {
      // Valida estrutura de progresso
      await expect(page.getByRole('heading', { name: /Card \d+ de \d+/i })).toBeVisible();

      // Botão "Mostrar Resposta" inicial visível
      const mostrarRespostaBtn = page.getByRole('button', { name: /Mostrar Resposta/i });
      await expect(mostrarRespostaBtn).toBeVisible();

      // Testa a revelação via atalho de teclado Space
      await page.keyboard.press('Space');

      // Após virar o cartão, as opções de avaliação FSRS devem ser exibidas
      await expect(page.getByText(/Qual foi sua facilidade\?/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /Errei/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Difícil/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Bom/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Fácil/i })).toBeVisible();

      // Testa o retorno à pergunta (frente) ao clicar no card
      const flashcard = page.getByRole('button', { name: /Flashcard interativo/i });
      await flashcard.click();
      await expect(page.getByRole('button', { name: /Mostrar Resposta/i })).toBeVisible();

      // Testa a revelação via atalho Enter
      await page.keyboard.press('Enter');
      await expect(page.getByText(/Qual foi sua facilidade\?/i)).toBeVisible();
    } else {
      // Validação do estado vazio elegante quando não há cartões pendentes
      await expect(page.getByRole('heading', { name: 'Tudo em Dia!' })).toBeVisible();
      await expect(page.getByText(/Não há cartões pendentes de revisão para hoje/i)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Voltar ao Início' })).toBeVisible();
    }
  });

  test('4. Perfil Responsável (Bruno) ao acessar /revisao exibe tratamento elegante de erro sem expor sessão', async ({ page, context }) => {
    await authenticateContext(context, RESPONSAVEL_USER);

    const response = await page.goto('/revisao');
    expect(response?.status()).toBe(200);

    // Aguarda o término do carregamento inicial
    await expect(page.getByText('Carregando seus cartões de revisão...')).not.toBeVisible({ timeout: 10000 });

    // Como Bruno é responsável, a action rejeita com erro de permissão e exibe o estado elegante de erro
    await expect(page.getByRole('heading', { name: 'Falha no Carregamento' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tentar Novamente' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Voltar ao Início' })).toBeVisible();

    // Garante que NÃO exibe falsamente tela de comemoração ou cards
    await expect(page.getByRole('heading', { name: 'Revisões Concluídas!' })).not.toBeVisible();
    await expect(page.getByText(/Sessão de Repetição Espaçada/i)).not.toBeVisible();
  });

  test('5. Isolamento entre estudantes: Carlos autenticado não herda nem visualiza os cartões de Alice', async ({ page, context }) => {
    await authenticateContext(context, CARLOS_USER);

    const response = await page.goto('/revisao');
    expect(response?.status()).toBe(200);

    // Aguarda o término do carregamento inicial
    await expect(page.getByText('Carregando seus cartões de revisão...')).not.toBeVisible({ timeout: 10000 });

    // Garante que Carlos nunca visualiza os cards ou sessão ativa de Alice
    await expect(page.getByText(/Sessão de Repetição Espaçada/i)).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Revisões Concluídas!' })).not.toBeVisible();

    // Carlos recebe resposta segura (estado vazio isolado ou tratamento elegante de autorização sem crash)
    const hasGracefulError = await page.getByRole('heading', { name: 'Falha no Carregamento' }).isVisible();
    const hasEmptyState = await page.getByRole('heading', { name: /Tudo em Dia!/i }).isVisible();
    expect(hasGracefulError || hasEmptyState).toBe(true);
  });
});