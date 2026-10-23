import { test, expect, Page, BrowserContext } from '@playwright/test';
// @ts-expect-error módulo pg utilizado diretamente no teste e2e sem @types/pg no devDependencies
import { Client } from 'pg';

const DB_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/medicina_dev';

const ALICE_PERFIL_ID = '10000000-0000-4000-8000-000000000001';
const BRUNO_PERFIL_ID = '20000000-0000-4000-8000-000000000001';

test.describe.serial('H0.01 — Testes E2E Reais com Banco PostgreSQL Descartável', () => {
  let dbClient: Client;
  let context: BrowserContext;
  let page: Page;
  let sessaoCriadaId: string = '';

  test.beforeAll(async ({ browser }) => {
    dbClient = new Client({ connectionString: DB_URL });
    await dbClient.connect();

    // Limpeza de sessões e erros de testes prévios para garantir idempotência e determinismo
    await dbClient.query(
      `DELETE FROM public.erros WHERE perfil_id = '${ALICE_PERFIL_ID}'`
    );
    await dbClient.query(
      `DELETE FROM public.sessoes WHERE perfil_id = '${ALICE_PERFIL_ID}'`
    );
    // Remove ciclos secundários criados em execuções anteriores para garantir que apenas o ciclo inicial exista
    await dbClient.query(
      `DELETE FROM public.ciclo_estado WHERE ciclo_id != '40000000-0000-4000-8000-000000000001'`
    );
    await dbClient.query(
      `DELETE FROM public.ciclo_blocos WHERE ciclo_id != '40000000-0000-4000-8000-000000000001'`
    );
    await dbClient.query(
      `DELETE FROM public.ciclos WHERE id != '40000000-0000-4000-8000-000000000001'`
    );
    // Garante que o ciclo inicial está ativo e com ponteiro no bloco 1
    await dbClient.query(
      `UPDATE public.ciclos SET ativo = true WHERE id = '40000000-0000-4000-8000-000000000001'`
    );
    await dbClient.query(
      `INSERT INTO public.ciclo_estado (ciclo_id, proxima_ordem)
       VALUES ('40000000-0000-4000-8000-000000000001', 1)
       ON CONFLICT (ciclo_id) DO UPDATE SET proxima_ordem = 1`
    );

    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    if (context) {
      await context.close();
    }
    if (dbClient) {
      await dbClient.end();
    }
  });

  // ---------------------------------------------------------------------------
  // 1. LOGIN LEGÍTIMO VIA FORMULÁRIO COM CREDENCIAIS REAIS DO POSTGRESQL
  // ---------------------------------------------------------------------------
  test('1. Deve rejeitar credenciais inválidas e efetuar login legítimo via formulário', async () => {
    await page.goto('/login');

    // 1.1 Tenta login com senha incorreta
    await page.fill('input[type="email"]', 'alice@medicina2029.com.br');
    await page.fill('input[type="password"]', 'senha_incorreta_errada');
    await page.click('button[type="submit"]');

    // Alerta de erro deve ser exibido pelo formulário
    const alertaErro = page.locator('div.bg-red-50');
    await expect(alertaErro).toBeVisible({ timeout: 10000 });
    await expect(alertaErro).toContainText(/incorreto|erro|negado|inválid/i);
    expect(page.url()).toContain('/login');

    // 1.2 Submete credenciais legítimas de Alice (Estudante) salvas com bcrypt no PostgreSQL
    await page.fill('input[type="email"]', 'alice@medicina2029.com.br');
    await page.fill('input[type="password"]', 'senha_estudante_2029');
    await page.click('button[type="submit"]');

    // Redirecionamento bem-sucedido para a página inicial protegida
    await expect(page).toHaveURL('http://localhost:3000/', { timeout: 15000 });

    // Confirma que a página inicial da estudante carregou sem erro
    await expect(page.locator('main')).toBeVisible();

    // Valida diretamente no PostgreSQL que o perfil logado existe e está ativo
    const perfilRes = await dbClient.query(
      `SELECT id, nome, email, papel FROM public.perfis WHERE email = 'alice@medicina2029.com.br'`
    );
    expect(perfilRes.rows.length).toBe(1);
    expect(perfilRes.rows[0].id).toBe(ALICE_PERFIL_ID);
    expect(perfilRes.rows[0].papel).toBe('estudante');
  });

  // ---------------------------------------------------------------------------
  // 2. CRIAÇÃO E NAVEGAÇÃO DE CICLO DE ESTUDOS REAL NO BANCO DE DADOS
  // ---------------------------------------------------------------------------
  test('2. Deve navegar pelo ciclo de estudos real ativo no banco de dados', async () => {
    // Alice já está autenticada na sessão do navegador
    await page.goto('/ciclo');
    await page.waitForSelector('text=Ciclo Ativo', { timeout: 15000 });

    // Valida cabeçalho e fila do ciclo persistido no PostgreSQL
    await expect(page.getByRole('heading', { name: 'Ciclo Ativo' })).toBeVisible();
    await expect(page.getByText('Estrutura de Fila')).toBeVisible();

    // Confirma que o botão de ação do bloco ativo está presente
    const btnEstudarBloco = page.locator('a[href*="/estudar?blocoId="]');
    await expect(btnEstudarBloco).toBeVisible();

    // Valida diretamente contra PostgreSQL a existência dos blocos do ciclo
    const blocosRes = await dbClient.query(
      `SELECT count(*) FROM public.ciclo_blocos WHERE ciclo_id = '40000000-0000-4000-8000-000000000001'`
    );
    expect(parseInt(blocosRes.rows[0].count, 10)).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 3. INÍCIO DE SESSÃO DE ESTUDO REAL EM /estudar E GRAVAÇÃO EM public.sessoes
  // ---------------------------------------------------------------------------
  test('3. Deve iniciar sessão de estudo real em /estudar e confirmar gravação em public.sessoes', async () => {
    // Clica no botão Estudar do próximo bloco a partir da fila do ciclo
    await page.click('a[href*="/estudar?blocoId="]');

    // Aguarda carregamento de /estudar e montagem do cronômetro sincronizado
    await page.waitForURL(/.*\/estudar.*/, { timeout: 15000 });
    await page.waitForSelector('[data-testid="status-sessao-badge"]', {
      timeout: 15000,
    });

    // Valida status badge na interface
    const statusBadge = page.locator('[data-testid="status-sessao-badge"]');
    await expect(statusBadge).toContainText(/Sessão pausada|Sessão em andamento/i);

    // Validação estrita no PostgreSQL: sessão real gravada na tabela public.sessoes
    const sessoesAbertas = await dbClient.query(
      `SELECT id, perfil_id, ciclo_bloco_id, etapa_atingida, concluida, encerrada_em
       FROM public.sessoes
       WHERE perfil_id = '${ALICE_PERFIL_ID}' AND encerrada_em IS NULL`
    );

    expect(sessoesAbertas.rows.length).toBe(1);
    const sessao = sessoesAbertas.rows[0];
    sessaoCriadaId = sessao.id;

    expect(sessao.perfil_id).toBe(ALICE_PERFIL_ID);
    expect(sessao.concluida).toBe(false);
    expect(sessao.encerrada_em).toBeNull();
    expect(sessao.etapa_atingida).toBe('revisao');
    expect(sessao.ciclo_bloco_id).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // 4. CHECKPOINT PERSISTIDO NO BANCO AO AVANÇAR ETAPAS
  // ---------------------------------------------------------------------------
  test('4. Deve persistir checkpoint de etapa e tempo diretamente no PostgreSQL', async () => {
    // Clica no botão de avançar etapa (de revisao para conteudo)
    const btnAvancar = page.locator('button[title="Avançar Etapa"]');
    await expect(btnAvancar).toBeVisible();
    await btnAvancar.click();

    // Aguarda atualização da interface para a etapa de teoria/conteúdo
    await expect(page.locator('body')).toContainText(/CONTEUDO/i, {
      timeout: 10000,
    });

    // Validação estrita no PostgreSQL: etapa_atingida foi atualizada para 'conteudo'
    const sessaoAtualizada = await dbClient.query(
      `SELECT id, etapa_atingida, concluida
       FROM public.sessoes
       WHERE id = '${sessaoCriadaId}'`
    );

    expect(sessaoAtualizada.rows.length).toBe(1);
    expect(sessaoAtualizada.rows[0].etapa_atingida).toBe('conteudo');
    expect(sessaoAtualizada.rows[0].concluida).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 5. ATUALIZAÇÃO DE PÁGINA (F5) E RECUPERAÇÃO DO ESTADO PELO BANCO SEM LOCALSTORAGE
  // ---------------------------------------------------------------------------
  test('5. Deve recuperar o estado da sessão exclusivamente do banco após F5 sem auxílio de localStorage', async () => {
    // Limpa completamente o localStorage e sessionStorage para provar que a
    // recuperação decorre estritamente do PostgreSQL e não de cache local sintético
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    const chavesRestantes = await page.evaluate(() => localStorage.length);
    expect(chavesRestantes).toBe(0);

    // Simula reload completo da página (F5)
    await page.reload();

    // Aguarda carregamento do cronômetro sincronizado com o banco
    await page.waitForSelector('[data-testid="status-sessao-badge"]', {
      timeout: 15000,
    });

    // Valida que o cronômetro recuperou a etapa persistida no banco ('conteudo') e não resetou para 'revisao'
    await expect(page.locator('body')).toContainText(/CONTEUDO/i);

    // Valida que os seletores de status da sessão continuam consistentes
    const statusBadge = page.locator('[data-testid="status-sessao-badge"]');
    await expect(statusBadge).toContainText(/Sessão pausada|Sessão em andamento/i);
  });

  // ---------------------------------------------------------------------------
  // 6. CONCLUSÃO DA SESSÃO, AVANÇO DO CICLO E GARANTIA CONTRA DUPLICAÇÕES
  // ---------------------------------------------------------------------------
  test('6. Deve concluir sessão, avançar ponteiro do ciclo e não duplicar registros', async () => {
    // Avança de 'conteudo' para 'questoes'
    const btnAvancar = page.locator('button[title="Avançar Etapa"]');
    await btnAvancar.click();
    await page.waitForTimeout(500);

    // Avança de 'questoes' para 'registro'
    await btnAvancar.click();
    await page.waitForSelector('textarea', { timeout: 10000 });

    // Preenche observações e finaliza o estudo
    await page.fill(
      'textarea',
      'Sessão E2E concluída com sucesso contra banco PostgreSQL descartável.'
    );

    const btnFinalizar = page.locator(
      'button:has-text("Finalizar Estudo e Iniciar Pausa")'
    );
    await expect(btnFinalizar).toBeVisible();
    await btnFinalizar.click();

    // Aguarda transição para status de sessão concluída
    const statusBadge = page.locator('[data-testid="status-sessao-badge"]');
    await expect(statusBadge).toContainText('Sessão concluída', { timeout: 15000 });

    // 6.1 Validação direta contra PostgreSQL: status concluída = true, encerrada_em preenchido
    const sessoesConcluidas = await dbClient.query(
      `SELECT id, perfil_id, etapa_atingida, concluida, encerrada_em, nota_livre
       FROM public.sessoes
       WHERE id = '${sessaoCriadaId}'`
    );

    expect(sessoesConcluidas.rows.length).toBe(1);
    const sessaoFinal = sessoesConcluidas.rows[0];
    expect(sessaoFinal.concluida).toBe(true);
    expect(sessaoFinal.encerrada_em).not.toBeNull();
    expect(sessaoFinal.etapa_atingida).toBe('registro');
    expect(sessaoFinal.nota_livre).toContain('Sessão E2E concluída');

    // 6.2 Garantia de idempotência e não-duplicação: exatamente 1 sessão existe para Alice
    const totalSessoesAlice = await dbClient.query(
      `SELECT count(*) FROM public.sessoes WHERE perfil_id = '${ALICE_PERFIL_ID}'`
    );
    expect(parseInt(totalSessoesAlice.rows[0].count, 10)).toBe(1);

    // 6.3 Validação de avanço atômico do ponteiro de ciclo no banco
    const cicloEstado = await dbClient.query(
      `SELECT ciclo_id, proxima_ordem FROM public.ciclo_estado
       WHERE ciclo_id = '40000000-0000-4000-8000-000000000001'`
    );
    expect(cicloEstado.rows.length).toBe(1);
    expect(cicloEstado.rows[0].proxima_ordem).toBe(2); // Avançou atomicamente de 1 para 2
  });

  // ---------------------------------------------------------------------------
  // 7. NEGAÇÃO DE ACESSO ENTRE PERFIS (ESTUDANTE vs RESPONSÁVEL) E CRIAÇÃO DE CICLO
  // ---------------------------------------------------------------------------
  test('7. Deve bloquear acesso cruzado entre perfis no servidor e validar controle do responsável', async ({
    browser,
  }) => {
    // 7.1 Alice (estudante) tentando acessar rotas administrativas do responsável
    await page.goto('/responsavel');
    await page.waitForLoadState('domcontentloaded');
    // Deve ser bloqueada e redirecionada para a raiz /
    expect(page.url()).not.toContain('/responsavel');

    await page.goto('/acervo');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/acervo');

    await page.goto('/curadoria');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/curadoria');

    // 7.2 Bruno (responsável) em contexto isolado com credenciais legítimas
    const respContext = await browser.newContext();
    const respPage = await respContext.newPage();

    await respPage.goto('/login');
    await respPage.fill('input[type="email"]', 'bruno@medicina2029.com.br');
    await respPage.fill('input[type="password"]', 'senha_responsavel_2029');
    await respPage.click('button[type="submit"]');
    await expect(respPage).toHaveURL('http://localhost:3000/responsavel', {
      timeout: 15000,
    });

    // Responsável acessa suas páginas exclusivas com sucesso
    await expect(
      respPage.getByRole('heading', { name: 'Painel do Responsável' })
    ).toBeVisible();

    await respPage.goto('/acervo');
    await expect(
      respPage.getByRole('heading', { name: 'Acervo de Materiais' })
    ).toBeVisible();

    await respPage.goto('/curadoria');
    await expect(
      respPage.getByRole('heading', { name: 'Fila de Curadoria' })
    ).toBeVisible();

    // 7.3 Bruno cria um novo ciclo completo com 28 blocos pelo painel do responsável
    await respPage.goto('/responsavel');
    const btnIniciarCiclo = respPage.locator(
      'button:has-text("Iniciar Ciclo de Estudos")'
    );
    await expect(btnIniciarCiclo).toBeVisible();
    await btnIniciarCiclo.click();

    // Confirmação na interface do responsável
    await expect(
      respPage.getByText('Ciclo de estudos iniciado com sucesso!')
    ).toBeVisible({ timeout: 15000 });

    // Validação direta contra PostgreSQL: novo ciclo criado com 28 blocos
    const ciclosAtivos = await dbClient.query(
      `SELECT id, nome, ativo, blocos_previstos_semana FROM public.ciclos
       WHERE ativo = true AND estudante_perfil_id = '${ALICE_PERFIL_ID}'`
    );
    expect(ciclosAtivos.rows.length).toBe(1);
    expect(ciclosAtivos.rows[0].blocos_previstos_semana).toBe(28);

    const blocosRes = await dbClient.query(
      `SELECT count(*) FROM public.ciclo_blocos WHERE ciclo_id = '${ciclosAtivos.rows[0].id}'`
    );
    expect(parseInt(blocosRes.rows[0].count, 10)).toBe(28);

    await respContext.close();

    // 7.4 Tentativa de acesso anônimo sem credenciais
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    await anonPage.goto('/ciclo');
    await expect(anonPage).toHaveURL(/\/login/);
    await anonContext.close();
  });
});
