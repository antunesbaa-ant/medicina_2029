# MEDICINA 2029 — RELATÓRIO DE PREPARAÇÃO H2.04-T2
## PREPARAÇÃO DO LOGIN FUNCIONAL NO SUPABASE STAGING

**Data:** 02 de Novembro de 2026  
**Ambiente:** Supabase Staging (`aws-0-us-east-1.pooler.supabase.com:5432`) / Node.js 24.21.0  
**Projeto Alvo:** `ynfocaorhadizlvbnzrt` (PostgreSQL 17.6)  
**Parecer de Engenharia:** **APTO PARA CONFIGURAÇÃO DE SENHAS (AGUARDANDO AUTORIZAÇÃO HUMANA)**  
**Status de Testes Locais:** **APROVADO (17/17 testes em H2.04-T2; 81/81 testes na suíte consolidada H2.04)**  
**Operações Remotas Executadas:** **NENHUMA (0 escritas, 0 updates remotos, 0 seeds, 0 cleanups, 0 deploys)**  

---

### 1. PARECER FORMAL DE ENGENHARIA

O ambiente e os artefatos de preparação para o primeiro login funcional de ponta a ponta no Supabase Staging foram minuciosamente auditados e testados localmente.

> [!IMPORTANT]
> **PARECER: APTO**  
> O lançador `scripts/db/configure-staging-passwords.mjs` e a infraestrutura de autenticação NextAuth estão rigorosamente preparados e validados em ambiente descartável isolado.
> Nenhuma mutação remota foi executada nesta etapa. A aplicação das senhas aguarda autorização humana explícita.

---

### 2. AUDITORIA ARQUITETURAL DO FLUXO REAL DE AUTENTICAÇÃO

A auditoria inspecionou integralmente o ciclo de vida da autenticação, desde a submissão de credenciais na interface até a imposição de Row Level Security (RLS) no PostgreSQL.

```mermaid
sequenceDiagram
    autonumber
    actor User as Usuário (Alice / Bruno / Carlos)
    participant LoginUI as Formulário (/login)
    participant NextAuth as NextAuth Handler (route.ts / auth-options.ts)
    participant AuthDb as Conexão Dedicada medicina_auth
    participant AppDb as Conexão de Runtime medicina_app
    participant Postgres as Supabase Staging (PostgreSQL 17.6)

    User->>LoginUI: Digita e-mail e senha
    LoginUI->>NextAuth: POST /api/auth/callback/credentials
    Note over NextAuth,AuthDb: Separação de Papéis (DATABASE_AUTH_URL)
    NextAuth->>AuthDb: SELECT * FROM medicina.autenticar_por_email(email)
    AuthDb->>Postgres: Executa RPC (SECURITY DEFINER)
    Postgres-->>AuthDb: Retorna (id, nome, email, password_hash, papel)
    Note over NextAuth: bcrypt.compare(senha, hash) + Timing Benchmark
    NextAuth-->>LoginUI: Emite Cookie next-auth.session-token (JWT)
    LoginUI->>User: Redireciona para / (ou /responsavel)

    Note over User,AppDb: Requisição subsequente a Server Action
    User->>AppDb: Invoca Server Action (ex: obterCiclo)
    AppDb->>NextAuth: getServerSession(authOptions)
    Note over AppDb: requireAuthenticatedProfile() recarrega perfis
    AppDb->>Postgres: BEGIN; SELECT medicina.set_context(perfilId, papel);
    Note over Postgres: SET LOCAL medicina.current_perfil_id = ...
    AppDb->>Postgres: Executa Queries sob RLS (ex: SELECT FROM ciclos)
    Postgres-->>AppDb: Retorna exclusivamente dados do tenant
    AppDb->>Postgres: COMMIT; (Contexto descartado pelo pooler)
```

#### 2.1. CredentialsProvider e Invocação da RPC
- **Arquivo Central:** [`src/lib/auth-options.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/auth-options.ts#L25-L105)
- **Conexão Dedicada (`authDb`):** A autenticação não utiliza a conexão de runtime geral (`medicina_app`). Ela conecta via `DATABASE_AUTH_URL` assumindo o papel PostgreSQL `medicina_auth`.
- **RPC `medicina.autenticar_por_email(text)`:**
  - Definida em `F1_04_RLS_PROPOSTA.sql` como `SECURITY DEFINER` com `search_path = pg_catalog, medicina, public, pg_temp`.
  - **Guarda Anti-Enumeração:** Se o e-mail não constar na tabela `public.allowlist`, retorna vazio imediatamente sem consultar a tabela de perfis.
  - Concessão de execução (`GRANT EXECUTE`) restrita unicamente ao papel `medicina_auth`. O papel aplicacional `medicina_app` é bloqueado com erro relacional `42501`.

#### 2.2. Mitigação de Ataques de Temporização (Timing Side-Channel)
- Se o usuário não existir na allowlist ou não possuir `password_hash`, o NextAuth executa compulsoriamente:
  ```typescript
  const TIMING_BENCHMARK_HASH = '$2a$10$7EqJtq98hPqEX7fNZaODi.Z6wKqGqD0Vq7F1eK1s8aC9w1p0X.uG6';
  await bcrypt.compare(credentials.password, TIMING_BENCHMARK_HASH);
  throw new Error('Credenciais inválidas.');
  ```
- Isso equaliza o tempo computacional de resposta da CPU entre e-mails válidos e inexistentes, eliminando vazamento de informação por análise de latência.

#### 2.3. Sessão JWT e Cookies
- **Estratégia:** JWT assinado com `NEXTAUTH_SECRET` (entropia $\ge 32$ caracteres).
- **Callbacks `jwt` e `session`:**
  - Injetam estritamente `token.id = user.id` (UUID interno da tabela `perfis`) e `token.role = user.role` (`'estudante' | 'responsavel'`).
  - O identificador externo `auth_user_id` é deliberadamente ocultado do cliente.
- **Cookies:**
  - Em desenvolvimento/HTTP: `next-auth.session-token` (`httpOnly: true`, `sameSite: 'lax'`, `path: '/'`).
  - Em staging/produção/HTTPS: `__Secure-next-auth.session-token` (`secure: true`, `httpOnly: true`, `sameSite: 'lax'`).

#### 2.4. Proteção de Rotas e Middleware
- **Arquivo:** [`src/middleware.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/middleware.ts#L1-L14)
- Intercepta todas as rotas do aplicativo (com exceção de `/login`, `/api/auth/*` e assets estáticos).
- Redireciona compulsoriamente requisições anônimas para `/login`.

#### 2.5. Integração com Contexto RLS (`medicina.set_context`)
- **Arquivo:** [`src/lib/authorization.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/authorization.ts#L50-L114) e [`src/db/rls-context.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/rls-context.ts#L137-L195)
- As Server Actions invocam `requireAuthenticatedProfile()` e `requireRole()`.
- O papel do usuário é recarregado do banco de dados (não aceita role manipulado no payload do cliente).
- A ativação RLS executa:
  ```sql
  SELECT medicina.set_context(perfil_id::uuid, papel::text);
  ```
- Internamente, `set_config('medicina.current_perfil_id', ..., true)` opera com `is_local => true` (**`SET LOCAL`**), garantindo que o contexto seja limpo ao final da transação, sem contaminação do pool de conexões (Session Pooler).

---

### 3. CONFIGURAÇÃO DE SENHAS: O LANÇADOR EXCLUSIVO DE STAGING

Para solucionar a pendência dos hashes gerados aleatoriamente durante o seed da H2.04 sem comprometer o isolamento do banco, foi construído o script:
[`scripts/db/configure-staging-passwords.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/configure-staging-passwords.mjs)

#### 3.1. Papel PostgreSQL e Conexão
- A auditoria de DDL comprovou que:
  - `medicina_app` teve o `UPDATE` revogado em `perfis` (`GRANT UPDATE (nome, email)`) $\rightarrow$ não tem permissão para alterar `password_hash`.
  - `medicina_auth` possui apenas `SELECT` em colunas públicas $\rightarrow$ não possui permissão de `UPDATE`.
- Portanto, o script conecta exclusivamente como **`postgres.ynfocaorhadizlvbnzrt`** via **Session Pooler** (`aws-0-us-east-1.pooler.supabase.com:5432`) com validação TLS estrita (`prod-ca-2021.crt`).

#### 3.2. Salvaguardas de Segurança Operacional
1. **Entrada Oculta:** As três senhas são digitadas pelo operador em modo raw no terminal (`promptHiddenPassword`), sem eco de caracteres, sem histórico de shell e sem argumentos de linha de comando.
2. **Complexidade e Distinção Obrigatória:**
   - Mínimo de 10 caracteres por senha;
   - Não vazias;
   - As 3 senhas devem ser **mutuamente distintas entre si** (Alice, Bruno e Carlos não podem compartilhar senha).
3. **Confirmação Humana Explícita:** Exige a digitação exata do token:
   `CONFIRMAR ATUALIZACAO SENHAS STAGING`
4. **Transação 100% Atômica com Pessimistic Locking:**
   ```sql
   BEGIN;
   SET LOCAL lock_timeout = '5s';
   SET LOCAL statement_timeout = '15s';
   SELECT id, email, papel, nome FROM public.perfis WHERE id IN (...) FOR UPDATE;
   -- Validação estrita: se não encontrar exatamente as 3 personas sintéticas, aborta.
   UPDATE public.perfis SET password_hash = ... WHERE id = ... AND email = ... AND papel = ...;
   COMMIT;
   ```
5. **Rollback Total em Falha Parcial:** Se qualquer persona falhar, nenhuma alteração é persistida.
6. **Purga de Memória:** Limpeza explícita das variáveis de senha no bloco `finally`.

---

### 4. MATRIZ E RESULTADOS DOS TESTES AUTOMATIZADOS LOCAIS

Os testes foram executados contra instância PostgreSQL descartável em memória (PGlite com extensão `pgvector`), validando todos os cenários sem qualquer dependência externa:

```bash
npx vitest run src/app/actions/h2_04_t2_staging_password_configuration.test.ts
```

| Grupo | Cenários Avaliados | Status | Detalhes Técnicos |
| :--- | :---: | :---: | :--- |
| **1. Hashing Bcrypt** | 2 | **APROVADO** | Hashes com fator de custo 10 (`$2b$10$`), 60 caracteres, validação booleana estrita no `compare`. |
| **2. Complexidade e Distinção** | 3 | **APROVADO** | Rejeição de senhas curtas (< 10 caracteres) e bloqueio categórico de senhas compartilhadas. |
| **3. Proteção de Projeto** | 4 | **APROVADO** | Validação canônica do Session Pooler 5432; rejeição de porta 6543, localhost e tenants incorretos. |
| **4. Transação Atômica** | 2 | **APROVADO** | Atualização dos 3 perfis e comprovação de Rollback Total sem alteração residual em falha parcial. |
| **5. Higienização de Logs** | 1 | **APROVADO** | Mascaramento de senhas, credenciais em URLs e hashes bcrypt em mensagens de erro. |
| **6. Integração NextAuth** | 3 | **APROVADO** | Validação da RPC `medicina.autenticar_por_email` com nova senha e injeção correta de claims JWT. |
| **7. Processo Node.js Puro** | 2 | **APROVADO** | Código 0 em `node --check` e `--help` como subprocesso real, sem dependência de transpilação. |

**Total da Suíte H2.04-T2:** **17/17 Aprovados (100%)**  
**Suíte Consolidada H2.04 (6 arquivos):** **81/81 Aprovados (100%)**

---

### 5. PLANO FUNCIONAL DE HOMOLOGAÇÃO DE LOGIN (ETAPA SUBSEQUENTE)

Após a aplicação das senhas no Staging mediante autorização humana, a homologação do login funcional seguirá a seguinte matriz de testes:

| Teste | Usuário / Perfil | Cenário Funcional | Critério de Sucesso | Tipo de Teste |
| :--- | :--- | :--- | :--- | :--- |
| **T2.1** | Alice (`estudante`) | Login com credenciais válidas na UI | Emissão do cookie `__Secure-next-auth.session-token`, redirecionamento para `/` | E2E Browser |
| **T2.2** | Alice (`estudante`) | Tentativa de acesso à rota `/responsavel` | Redirecionamento automático para `/` ou bloqueio `FORBIDDEN` | E2E Browser |
| **T2.3** | Bruno (`responsavel`) | Login com credenciais válidas na UI | Redirecionamento para `/responsavel`, exibição dos dados da tutelada Alice | E2E Browser |
| **T2.4** | Bruno (`responsavel`) | Acompanhamento quinzenal de Alice | Consulta à view agregada quinzenal sem acesso a sessões individuais | E2E / API |
| **T2.5** | Carlos (`estudante`) | Login como estudante independente | Visualização exclusiva de seu ciclo (28 blocos) e 2 cards; zero dados de Alice | E2E Browser |
| **T2.6** | Anônimo | Acesso direto a rota privada (ex: `/ciclo`) | Redirecionamento automático pelo middleware para `/login` | E2E Browser |
| **T2.7** | Qualquer | Submissão de senha incorreta em `/login` | Mensagem de erro "E-mail ou senha incorretos", sem vazamento de stack | E2E Browser |
| **T2.8** | Qualquer | Logout através do botão da NavBar | Expiração imediata do cookie de sessão e retorno para `/login` | E2E Browser |

#### Diferenciação Metodológica:
- **Testes Locais de Integração (Concluídos):** Validam a integridade matemática do bcrypt, a autorização no PostgreSQL, os column-level grants e a camada de Server Actions sem overhead de rede.
- **Testes E2E Reais no Navegador (Próxima Etapa):** Executam via Playwright/navegador contra a URL de staging (`https://...`), testando envio de formulário, armazenamento de cookies no browser, renderização dos componentes client-side e navegação com NextAuth.

---

### 6. MATRIZ DE RISCOS OPERACIONAIS E SALVAGUARDAS

| Risco Identificado | Severidade | Salvaguarda Implementada |
| :--- | :---: | :--- |
| **Vazamento de credenciais no histórico do shell** | Alta | Senhas solicitadas via entrada oculta interativa; proibido passar senha por flag de CLI. |
| **Conexão acidental a projeto incorreto ou produção** | Crítica | Validação estrita do host `aws-0-us-east-1.pooler.supabase.com` e tenant `ynfocaorhadizlvbnzrt`. |
| **Atualização parcial (ex: Alice atualiza e Bruno falha)** | Média | Transação atômica única com `ROLLBACK` total se qualquer um dos 3 updates falhar. |
| **Colisão ou sobreescrita de outros usuários** | Alta | `WHERE id = ... AND email = ... AND papel = ...` com matching exato dos 3 UUIDs canônicos. |
| **Retenção de senhas em memória após execução** | Baixa | Variáveis de senha explicitamente zeradas (`''`) no bloco `finally`. |

---

### 7. COMANDO EXATO PARA A FUTURA CONFIGURAÇÃO DE SENHAS

Quando for concedida a autorização humana, o operador executará no Terminal:

```bash
node scripts/db/configure-staging-passwords.mjs --ca="$HOME/Downloads/prod-ca-2021.crt"
```

#### Roteiro Interativo Esperado:
1. Validação do certificado TLS `prod-ca-2021.crt`.
2. Solicitação da senha do PostgreSQL `postgres`:
   `🔑 Digite a senha do usuário administrativo postgres: `
3. Solicitação das três novas senhas distintas:
   - `🔑 [1/3] Digite a nova senha de Alice (estudante): `
   - `🔑 [2/3] Digite a nova senha de Bruno (responsável): `
   - `🔑 [3/3] Digite a nova senha de Carlos (estudante independente): `
4. Confirmação explícita de segurança:
   `CONFIRMAR ATUALIZACAO SENHAS STAGING`
5. Execução atômica e relatório de conclusão.

---

### 8. CONFERÊNCIA DE INTEGRIDADE DOS RELATÓRIOS (SHA-256)

Os relatórios idênticos foram gerados em:
- **Repositório:** `docs/modernizacao/RELATORIO_H2_04_T2.md`
- **Diretório do Usuário:** `/Users/brunoantunes/Documents/MEDICINA_2029_H2_04_T2_RELATORIO.md`
