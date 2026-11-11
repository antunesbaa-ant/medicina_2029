# MEDICINA 2029 — RELATÓRIO TÉCNICO H2.04-T5-R
## DIAGNÓSTICO E CORREÇÃO DA INICIALIZAÇÃO DA SESSÃO DE ESTUDO (CRONÔMETRO E RLS)

**Data da Auditoria:** 10 de novembro de 2026  
**Ambiente:** Supabase Staging (`ynfocaorhadizlvbnzrt`) & Código Local Next.js  
**Status Final:** **APTO COM CORREÇÃO TÉCNICA E TESTES LOCAIS CONCLUÍDOS**

---

### 1. SUMÁRIO EXECUTIVO

Após a conclusão bem-sucedida da tarefa `H2.04-T4-R`, a estudante Alice conseguiu visualizar corretamente seu ciclo de estudos (`Ciclo Alice 2029`, 28 blocos) e o bloco 1 de Matemática. Contudo, ao clicar em "Estudar" no primeiro bloco, a interface apresentou:
> *"SESSÃO NÃO INICIADA"*  
> *"Não foi possível identificar o bloco e o tópico ativos no servidor. Volte ao ciclo e selecione um tópico válido."*

Além disso, ao clicar em *"Tentar Sincronizar Novamente"*, o cronômetro era exibido momentaneamente por alguns segundos e depois a tela retornava à caixa de erro.

A auditoria integrada investigou o banco de dados remoto no Supabase Staging e o fluxo completo do código.

---

### 2. CAUSA RAIZ COMPROVADA

A investigação comprovou **duas causas raízes correlacionadas**:

#### 2.1 Causa Raiz do Erro de Inicialização (Backend / RLS)
1. **Chamadas diretas a `db.select()` sem contexto RLS:**
   No arquivo `src/app/actions/sessao.ts`, a Server Action `obterEstadoSessaoCronometro()` executava consultas Drizzle diretamente na instância global `db` nas tabelas `sessoes`, `ciclos`, `ciclo_blocos`, `ciclo_estado` e `topicos`.
2. **Princípio Fail-Closed do PostgreSQL:**
   Todas essas tabelas possuem `FORCE ROW LEVEL SECURITY`. Sob a role de aplicação `medicina_app` no Supabase Staging, consultas executadas sem chamar previamente `medicina.set_context()` retornam compulsoriamente **0 linhas** (já que `medicina.is_estudante()` avalia como falso).
3. **Falha em cascata na resolução de bloco e tópico:**
   Ao não encontrar o ciclo ativo nem os tópicos de Matemática, a Server Action retornava `blocoSugerido: null`. No front-end, a função `reconciliarEstadoCronometroComServidor()` gerava `reconciliado.blocoId = ''` e `reconciliado.topicoId = ''`, acionando a condição de guarda que impedia a criação da sessão e exibia a mensagem de erro.

#### 2.2 Causa Raiz da Aparição Breve do Cronômetro (Frontend / UI)
1. No arquivo `src/components/CronometroPage.tsx`, ao clicar em *"Tentar Sincronizar Novamente"*, a função `sincronizarEInicializarComServidor()` definia `setSincronizando(true)` e limpava a mensagem de erro com `setErroOperacao('')`.
2. No entanto, o estado de carregamento inicial `loading` já havia sido setado como `false` na primeira tentativa.
3. O componente renderizava condicionalmente:
   - `if (loading)` -> `false` (não exibia o spinner);
   - `if (erroOperacao && !sessaoId)` -> `false` (pois `erroOperacao` havia acabado de ser esvaziado);
   - `if (statusSessao === 'concluida')` -> `false`.
4. Sem satisfazer nenhuma das condições de guarda, a função caía no `return` principal do componente, **renderizando o cronômetro completo** antes de qualquer confirmação do servidor.
5. Quando a Server Action remota respondia com falha (pela ausência do RLS context), `setErroOperacao(...)` era chamado novamente, fazendo a tela desmontar o cronômetro e retornar ao erro.

---

### 3. AUDITORIA DOS DADOS SINTÉTICOS NO SUPABASE STAGING

A inspeção remota foi realizada estritamente em modo de leitura via `DATABASE_APP_URL` (`medicina_app`, projeto `ynfocaorhadizlvbnzrt`), sem qualquer mutação de dados.

| Item Consultado | Estado no Banco Staging | Detalhes |
| :--- | :--- | :--- |
| **Ciclo Ativo de Alice** | Presente e Ativo | `id: 40000000-0000-4000-8000-000000000001`, `ativo = true`, 28 blocos semanais |
| **Ponteiro do Ciclo** | Presente | `ciclo_id: 40000000-0000-4000-8000-000000000001`, `proxima_ordem = 1` |
| **Primeiro Bloco** | Presente e Válido | `id: 41000000-0000-4000-8000-000000000001`, `ordem = 1`, `tipo = conteudo`, `disciplina = Matemática` (`d0000000-0000-4000-8000-000000000001`) |
| **Tópicos de Matemática** | **2 tópicos cadastrados** | 1. `Razão e Proporção` (`ordem = 1`, `id: e0000000-0000-4000-8000-000000000001`)<br>2. `Funções de 1º e 2º Grau` (`ordem = 2`, `id: e0000000-0000-4000-8000-000000000002`) |
| **Sessões Criadas de Alice** | **0 sessões** | Nenhuma sessão foi criada pelas tentativas anteriores; o banco permanece limpo e consistente |

**Conclusão sobre os dados:** Não há ausência de tópicos de Matemática. Os tópicos existem no staging e atendem perfeitamente aos critérios de elegibilidade. O erro decorreu unicamente da barreira de RLS na consulta.

---

### 4. CORREÇÕES TÉCNICAS REALIZADAS

1. **Backend — [`src/app/actions/sessao.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/sessao.ts):**
   - Refatoração de `obterEstadoSessaoCronometro()` para executar compulsoriamente dentro de `db.transaction(async (tx) => { ... })`.
   - Aplicação preliminar de `await applyRlsContext(tx, perfil.id, perfil.papel)`.
   - Conversão de todas as consultas internas (`sessoes`, `ciclos`, `cicloBlocos`, `disciplinas`, `topicos`, `cicloEstado`) para operar sobre o handle transacional `tx`.

2. **Frontend — [`src/components/CronometroPage.tsx`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/components/CronometroPage.tsx):**
   - Correção do portão de renderização: `if (loading || (sincronizando && !sessaoId))` agora garante que o spinner de sincronização seja exibido durante tentativas de reconexão ou retry, impedindo que o cronômetro pisque prematuramente.
   - Adição de portão de segurança estrito: `if (!sessaoId)` garante que nenhuma casca do cronômetro seja renderizada enquanto a sessão não possuir UUID confirmado no servidor.
   - Refinamento das mensagens de erro em caso de ausência real de bloco ou de tópicos cadastrados.

---

### 5. TESTES DE REGRESSÃO EXECUTADOS

Foi criada a suíte de testes unitários [`src/app/actions/h2_04_t5_r_estudo_sessao_rls.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h2_04_t5_r_estudo_sessao_rls.test.ts) cobrindo todos os cenários exigidos:

1. **Bloco e tópico válidos:** `obterEstadoSessaoCronometro()` aplica o contexto RLS com o ID e papel de Alice e sugere o primeiro bloco e o tópico correspondente (`Razão e Proporção`).
2. **Bloco existente sem tópico elegível:** retorna `blocoSugerido: null` de forma segura quando a disciplina não possui tópicos cadastrados.
3. **Consulta sem contexto RLS:** falha na aplicação de `applyRlsContext` aborta a operação *fail-closed* via `PublicOperationError`.
4. **Tentativa de acesso ao bloco de outro estudante:** `iniciarSessao()` rejeita blocos de outros perfis com erro `NOT_FOUND`.
5. **Falha de persistência / comunicação:** mapeamento defensivo para `PERSISTENCE_ERROR` sem vazamento de detalhes internos.
6. **Cronômetro não iniciado prematuramente:** reconciliação com `blocoSugerido: null` mantém `statusSessao: 'nao_iniciada'` e não inventa `sessaoId`.
7. **Nova tentativa de sincronização sem duplicação:** `iniciarSessao()` reutiliza sessão aberta existente de forma idempotente sem novo INSERT.
8. **Preservação do funcionamento da tela Ciclo:** `obterCicloAtivo()` permanece íntegro e retorna os dados do ciclo de Alice.

**Resultado da execução Vitest:**
- `h2_04_t5_r_estudo_sessao_rls.test.ts`: **8/8 aprovados**
- Suíte completa de autenticação, autorização, ciclo e cronômetro: **100 testes aprovados, 0 falhas** (8 testes de integração externa mantidos como skipped).

---

### 6. PROCEDIMENTO PARA REPETIÇÃO DO TESTE MANUAL

1. No terminal, inicie o servidor web apontando para o Supabase Staging:
   ```bash
   npm run staging:web
   ```
2. Abra o navegador em `http://127.0.0.1:3000/login` e autentique como Alice (`alice@medicina2029.staging`).
3. Navegue até `http://127.0.0.1:3000/ciclo`.
4. No card do primeiro bloco (*Matemática*, 50 min), clique no botão **"Estudar"**.
5. Observe que a tela `/estudar` apresenta o spinner de sincronização e transiciona diretamente para o cronômetro ativo da sessão:
   - Título: **Matemática**
   - Subtítulo: **Razão e Proporção**
   - Etapa: **Revisão (5m)**
   - Status: **Pausada** (pronta para o operador clicar em Iniciar).

---

### 7. PARECER CONCLUSIVO

**Status:** **APTO PARA HOMOLOGAÇÃO MANUAL EM STAGING**  
Nenhuma escrita remota foi realizada durante o diagnóstico e os dados sintéticos permanecem 100% íntegros.
