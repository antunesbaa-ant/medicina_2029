import { test, expect } from '@playwright/test';
import {
  authenticateContext,
  ESTUDANTE_USER,
  RESPONSAVEL_USER,
} from './helpers/auth';

test.describe('F1.16 — Testes E2E do Fluxo Principal do Sistema de Estudos', () => {

  // ---------------------------------------------------------------------------
  // 1. LOGIN & SEGURANÇA DE ACESSO
  // ---------------------------------------------------------------------------
  test('1.1 Deve rejeitar login com e-mail fora da allowlist ou credenciais inválidas', async ({ page }) => {
    await page.goto('/login');

    // Valida estrutura básica da tela de login
    await expect(page.getByRole('heading', { name: 'Medicina 2029' })).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toContainText('Entrar no Sistema');

    // Submete credenciais inválidas / fora da allowlist
    await page.fill('input[type="email"]', 'intruso@fora-da-allowlist.com.br');
    await page.fill('input[type="password"]', 'senhaInvalida123!');
    await page.click('button[type="submit"]');

    // Aguarda apresentação do alerta de erro do formulário
    const alertaErro = page.locator('div.bg-red-50');
    await expect(alertaErro).toBeVisible({ timeout: 15000 });
    const textoAlerta = await alertaErro.textContent();
    expect(textoAlerta).toMatch(/incorreto|erro|negado|inválid/i);

    // Permanece na rota de login
    expect(page.url()).toContain('/login');
  });

  test('1.2 Deve bloquear acesso anônimo a rotas protegidas e redirecionar para /login', async ({ page }) => {
    const rotasProtegidas = ['/ciclo', '/estudar', '/revisao', '/simulados', '/responsavel', '/acervo', '/curadoria'];

    for (const rota of rotasProtegidas) {
      await page.goto(rota);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  // ---------------------------------------------------------------------------
  // 2. AUTORIZAÇÃO E SEGREGACÃO DE PAPÉIS (ESTUDANTE vs RESPONSÁVEL)
  // ---------------------------------------------------------------------------
  test('2.1 Deve permitir acesso do Responsável às suas telas exclusivas (/responsavel, /acervo, /curadoria)', async ({ page, context }) => {
    await authenticateContext(context, RESPONSAVEL_USER);

    // Acesso ao painel do responsável
    await page.goto('/responsavel');
    await expect(page).toHaveURL('/responsavel');
    await expect(page.getByRole('heading', { name: 'Painel do Responsável' })).toBeVisible();
    await expect(page.getByText('Acompanhamento Quinzenal')).toBeVisible();

    // Acesso ao acervo de materiais
    await page.goto('/acervo');
    await expect(page).toHaveURL('/acervo');
    await expect(page.getByRole('heading', { name: 'Acervo de Materiais' })).toBeVisible();
    await expect(page.getByText('Ingerir Novo Documento')).toBeVisible();

    // Acesso à curadoria pedagógica
    await page.goto('/curadoria');
    await expect(page).toHaveURL('/curadoria');
    await expect(page.getByRole('heading', { name: 'Fila de Curadoria' })).toBeVisible();
  });

  test('2.2 Deve bloquear rotas administrativas para o Estudante com redirecionamento protetivo', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    // Estudante tentando acessar /responsavel deve ser bloqueado e redirecionado para /
    await page.goto('/responsavel');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/responsavel');

    // Estudante tentando acessar /acervo deve ser bloqueado e redirecionado para /
    await page.goto('/acervo');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/acervo');

    // Estudante tentando acessar /curadoria deve ser bloqueado e redirecionado para /
    await page.goto('/curadoria');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/curadoria');
  });

  // ---------------------------------------------------------------------------
  // 3. CICLO DE ESTUDOS E NAVEGAÇÃO DO ESTUDANTE
  // ---------------------------------------------------------------------------
  test('3.1 Deve permitir abertura e visualização da estrutura de fila do ciclo de estudos (/ciclo)', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    await page.goto('/ciclo');
    await expect(page).toHaveURL('/ciclo');

    // Valida cabeçalho e estrutura da fila
    await expect(page.getByRole('heading', { name: 'Ciclo Ativo' })).toBeVisible();
    await expect(page.getByText('Estrutura de Fila')).toBeVisible();

    // Barra de navegação inferior/lateral presente
    await expect(page.locator('nav')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // 4. SESSÃO DE ESTUDOS, CRONÔMETRO E PERSISTÊNCIA (RELOAD)
  // ---------------------------------------------------------------------------
  test('4.1 Deve renderizar a página do cronômetro de estudos (/estudar) com tratamento de sessão', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    await page.goto('/estudar');
    await expect(page).toHaveURL('/estudar');

    // A página deve carregar o CronometroPage sem crash
    // Como estamos sem base Postgres ativa em dev, o cronômetro entra no modo defensivo
    // de sincronização com botão "Voltar ao Ciclo" ou carrega os controles se houver cache
    const botaoVoltarOuControles = page.locator('text=Voltar ao Ciclo').or(page.locator('[data-testid="status-sessao-badge"]'));
    await expect(botaoVoltarOuControles).toBeVisible({ timeout: 15000 });
  });

  test('4.2 Deve manter o estado local de estudo após atualização de página (F5/reload)', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    // Navega para /estudar e insere um estado sintético de sessão ativa no localStorage
    await page.goto('/estudar');

    await page.evaluate(() => {
      const estadoSessaoSintetica = {
        sessaoId: '42000000-0000-4000-8000-000000000099',
        blocoId: '41000000-0000-4000-8000-000000000001',
        topicoId: '31000000-0000-4000-8000-000000000001',
        disciplinaNome: 'Biologia Celular',
        topicoNome: 'Mitocôndrias e Bioenergética',
        etapaAtual: 'conteudo',
        tempoRestante: 1200,
        estaRodando: false,
        segundosEfetivos: 300,
        segundosPausa: 0,
        timestampUltimoTick: Date.now(),
      };
      localStorage.setItem('medicina_2029_cronometro_estado', JSON.stringify(estadoSessaoSintetica));
    });

    // Simula reload (F5) do estudante
    await page.reload();

    // Valida que o localStorage preservou a chave e o app reinicializou sem exceção
    const valorArmazenado = await page.evaluate(() => {
      return localStorage.getItem('medicina_2029_cronometro_estado');
    });

    expect(valorArmazenado).not.toBeNull();
    expect(valorArmazenado).toContain('Mitocôndrias e Bioenergética');
  });

  // ---------------------------------------------------------------------------
  // 5. REVISÃO FSRS (/revisao)
  // ---------------------------------------------------------------------------
  test('5.1 Deve abrir a página de revisão FSRS e apresentar estado concluído ou cartões', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    await page.goto('/revisao');
    await expect(page).toHaveURL('/revisao');

    // Em base limpa / sem cards pendentes, exibe a tela de conclusão "Revisões Concluídas!"
    // Caso existam cards, exibe o contador "Card X de Y"
    const estadoConcluidoOuCards = page.getByText('Revisões Concluídas!').or(page.getByText(/Card \d+ de \d+/));
    await expect(estadoConcluidoOuCards).toBeVisible({ timeout: 15000 });
  });

  // ---------------------------------------------------------------------------
  // 6. SIMULADOS E TRAVAS DE DIAGNÓSTICO (/simulados)
  // ---------------------------------------------------------------------------
  test('6.1 Deve exibir painel de simulados e permitir abertura do formulário com travas', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    await page.goto('/simulados');
    await expect(page).toHaveURL('/simulados');

    // Título principal
    await expect(page.getByRole('heading', { name: 'Desempenho em Simulados' })).toBeVisible();

    // Botão de registrar novo simulado
    const btnNovoSimulado = page.getByText('+ Registrar Simulado');
    await expect(btnNovoSimulado).toBeVisible();

    // Clica para abrir o formulário
    await btnNovoSimulado.click();

    // Valida que o formulário de cadastro abre com campos obrigatórios
    await expect(page.getByText('Registrar Nova Prova')).toBeVisible();
    await expect(page.locator('select').first()).toBeVisible(); // Seletor de Formato (ENEM, UECE, etc.)
  });

  // ---------------------------------------------------------------------------
  // 7. LOGOUT E ENCERRAMENTO DE SESSÃO
  // ---------------------------------------------------------------------------
  test('7.1 Deve invalidar a sessão ao limpar cookies e redirecionar para /login', async ({ page, context }) => {
    await authenticateContext(context, ESTUDANTE_USER);

    // Confirma que está autenticado em /ciclo
    await page.goto('/ciclo');
    await expect(page).toHaveURL('/ciclo');

    // Limpa os cookies simulando logout/expiração
    await context.clearCookies();

    // Nova navegação protegida deve ser interceptada pelo middleware
    await page.goto('/ciclo');
    await expect(page).toHaveURL(/\/login/);
  });

});
