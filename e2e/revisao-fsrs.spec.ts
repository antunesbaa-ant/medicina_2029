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

    // Garante que Carlos nunca visualiza os cards ou sessão de Alice
    await expect(page.getByText(/Mitocôndria produz ATP via/i)).not.toBeVisible();
    await expect(page.getByText(/Fórmula da velocidade média no MRU/i)).not.toBeVisible();
    await expect(page.getByText(/Elementos da intervenção no ENEM/i)).not.toBeVisible();

    // Carlos visualiza exclusivamente seus próprios cartões ou tela de conclusão
    const hasCarlosCard = await page.getByText(/Volume molar|Grandezas inversamente/i).isVisible();
    const hasEmptyState = await page.getByRole('heading', { name: /Tudo em Dia!|Revisões Concluídas!/i }).isVisible();
    expect(hasCarlosCard || hasEmptyState).toBe(true);
  });

  test('6. Verificação visual de alto contraste efetivamente renderizado nos modos claro e escuro', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    await page.goto('/revisao');
    await expect(page.getByText('Carregando seus cartões de revisão...')).not.toBeVisible({ timeout: 10000 });

    const hasActiveSession = await page.getByText(/Sessão de Repetição Espaçada/i).isVisible();

    if (hasActiveSession) {
      const flashcard = page.getByRole('button', { name: /Flashcard interativo/i });
      const cardParagraph = flashcard.locator('p');

      // Modo Claro: validação de contraste do texto da pergunta
      const colorClaro = await cardParagraph.evaluate((el) => window.getComputedStyle(el).color);
      // Deve ser a cor escura #1B2A33 = rgb(27, 42, 51)
      expect(colorClaro).toBe('rgb(27, 42, 51)');

      // Ativação do Modo Escuro
      await page.evaluate(() => {
        document.documentElement.classList.add('dark');
        document.body.classList.add('dark');
      });
      // Aguarda término da transição CSS (transition-all duration-300)
      await page.waitForTimeout(400);

      // Modo Escuro: Fundo do card deve ser #24353F = rgb(36, 53, 63) via .dark .bg-white
      const bgEscuro = await flashcard.evaluate((el) => window.getComputedStyle(el).backgroundColor);
      expect(bgEscuro).toBe('rgb(36, 53, 63)');

      // Modo Escuro: Texto da pergunta DEVE ser renderizado claro (#F5F7F8 = rgb(245, 247, 248)), e NÃO escuro
      const colorEscuro = await cardParagraph.evaluate((el) => window.getComputedStyle(el).color);
      expect(colorEscuro).toBe('rgb(245, 247, 248)');

      // Revela o verso e valida contraste da resposta no modo escuro
      await page.keyboard.press('Space');
      const colorVersoEscuro = await cardParagraph.evaluate((el) => window.getComputedStyle(el).color);
      expect(colorVersoEscuro).toBe('rgb(245, 247, 248)');
    } else {
      // Estado vazio no modo escuro
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      const heading = page.getByRole('heading', { name: 'Tudo em Dia!' });
      const headingColor = await heading.evaluate((el) => window.getComputedStyle(el).color);
      // Deve renderizar texto claro (#E0EBF0 = rgb(224, 235, 240)), não o petróleo escuro de dia
      expect(headingColor).toBe('rgb(224, 235, 240)');
    }
  });
});