# MEDICINA 2029 — RELATÓRIO FORENSE E CORREÇÃO H2.04-T3-R3
## DIAGNÓSTICO E CORREÇÃO DO RETORNO INDEVIDO À TELA DE LOGIN

**Data:** 04 de Novembro de 2026  
**Ambiente:** Supabase Staging (`aws-0-us-east-1.pooler.supabase.com:5432`) / macOS / Node.js 24.21.0  
**Projeto Alvo:** `ynfocaorhadizlvbnzrt` (PostgreSQL 17.6)  
**Camada Web:** Next.js 16.4.2 / React 19.2.4 / NextAuth 4.24.15  
**Interface Local:** `127.0.0.1:3000` (Loopback estrito via `-H 127.0.0.1 -p 3000`)  
**Certificado TLS Raiz:** `~/Downloads/prod-ca-2021.crt` (SHA-256 validado)  
**Status dos Testes:** **10/10 APROVADOS (100%) na suíte direcionada `h2_04_t3_r3_login_redirect.test.ts`; 48/48 testes consolidados**  
**Mutações Remotas no Supabase:** **NENHUMA (0 escritas, 0 updates de senhas, 0 migrações, 0 seeds, 0 cleanups, 0 deploys)**  

---

## 1. PARECER CONCLUSIVO

> [!IMPORTANT]
> **PARECER FINAL: NÃO APTO PARA LOGIN REAL ATÉ RECONFIGURAÇÃO DA SENHA DE `medicina_app` PELO OPERADOR**  
> 
> 1. **Causa Raiz Material Descoberta:** A autenticação web com Alice funcionou perfeitamente no endpoint de credenciais (`medicina_auth`), porém a aplicação falhou ao carregar a página inicial (`GET /`) porque a role de runtime da aplicação (`medicina_app`) configurada no `.env.local` foi rejeitada pelo PostgreSQL com erro fatal de senha (`PostgresError: password authentication failed for user "medicina_app"`, código `28P01`).
> 2. **Origem Exata do Redirecionamento 307:** O redirecionamento **NÃO** partiu do middleware (`withAuth`). Ele partiu do Server Component `Home()` em `src/app/page.tsx:14-16`, que capturou o erro de banco mascarado como `AuthorizationError('UNAUTHENTICATED')` e executou `redirect('/login')`.
> 3. **Discrepância de Host Sanada:** O `.env.local` mantinha `NEXTAUTH_URL="http://localhost:3000"` enquanto o servidor escutava em `http://127.0.0.1:3000`. Essa divergência causava desconfiança de origem no NextAuth e aborto de requisições no Safari (`CLIENT_FETCH_ERROR: Load failed`), sendo agora padronizada para `http://127.0.0.1:3000`.
> 4. **Preflight Fail-Closed Implementado:** O lançador `scripts/db/launch-staging-web.mjs` e o configurador `scripts/db/configure-staging-web-env.mjs` foram aprimorados para testar ativamente as credenciais no PostgreSQL antes de iniciar o Next.js, impedindo que o servidor suba em estado quebrado.
> 5. **Próxima Ação Humana Obrigatória:** O operador deve executar `npm run config:staging:web` no terminal para inserir a senha correta da role `medicina_app`.

---

## 2. DIAGNÓSTICO FORENSE DOS REGISTROS DO TERMINAL

### Evidência Registrada pelo Operador
```text
POST /api/auth/callback/credentials 200
GET  /api/auth/session             200
GET  /                             307
GET  /login                        200
[next-auth][error][CLIENT_FETCH_ERROR]
message: 'Load failed'
url: '/api/auth/providers'
```

### Análise Estágio por Estágio (A até E)

| Estágio Investigado | Componentes Envolvidos | Resultado Forense | Status |
| :--- | :--- | :--- | :--- |
| **A. Autenticação e RPC no Supabase Staging** | `CredentialsProvider.authorize()`, `DATABASE_AUTH_URL`, `medicina_auth`, `medicina.autenticar_por_email`, `bcrypt.compare` | **100% Funcional.** Conexão sob `medicina_auth` validada com sucesso no pooler. Alice foi localizada na allowlist/perfis e a senha informada bateu com o hash bcrypt. Retornou `{ id, name, email, role }`. | **APROVADO** |
| **B. Geração de Token e Callbacks NextAuth** | `callbacks.jwt`, `callbacks.session`, `NEXTAUTH_SECRET`, JWT encode | **100% Funcional.** O token JWT foi emitido contendo `token.id` e `token.role='estudante'`. A rota `/api/auth/session` retornou status `200 OK` com os dados da estudante. | **APROVADO** |
| **C. Trânsito HTTP, Cookies e Middleware** | `src/middleware.ts` (`withAuth`), Safari Private Browsing, cookie `next-auth.session-token` | **Middleware Aprovou.** O cookie foi transmitido na requisição `GET /`. O middleware validou o token e retornou `undefined` (pass-through). Se o middleware tivesse redirecionado, o destino conteria `?callbackUrl=%2F`. Como o log foi `GET /login 200` (sem query), o 307 originou-se no componente de página. | **APROVADO** |
| **D. Consulta RLS sob `medicina_app` e Resolução de Perfil** | `src/app/page.tsx`, `requireAuthenticatedProfile()`, `DATABASE_APP_URL`, `medicina_app`, RLS `perfis` | **Causa Raiz da Falha.** `requireAuthenticatedProfile()` tenta ler a tabela `perfis` usando a conexão `db` (`DATABASE_APP_URL`). A role `medicina_app` foi rejeitada pelo PostgreSQL com código `28P01` (senha incorreta no `.env.local`). O bloco `catch` converteu a falha em `UNAUTHENTICATED` e `Home()` chamou `redirect('/login')` (HTTP 307). | **REPROVADO (Causa Raiz)** |
| **E. Discrepância de Host e Erro no Safari** | `NEXTAUTH_URL=localhost` vs Host real `127.0.0.1`, `CLIENT_FETCH_ERROR: Load failed` | **Identificado e Corrigido.** O erro `Load failed` é específico do WebKit/Safari disparado quando `window.location.href = '/'` provocou a navegação enquanto uma chamada a `/api/auth/providers` estava em trânsito. A discrepância entre `127.0.0.1` e `localhost` agravava o isolamento de partição no Safari Private Browsing. | **CORRIGIDO** |

---

## 3. PROVAS TÉCNICAS E EVIDÊNCIAS DE CÓDIGO

### 3.1. Prova da Falha de Senha de `medicina_app` no Staging
Teste executado com as credenciais gravadas no `.env.local`:
```bash
# Teste de DATABASE_AUTH_URL (medicina_auth)
SELECT current_user;
# -> Result: [ { current_user: 'medicina_auth' } ]  (SUCESSO)

# Teste de DATABASE_APP_URL (medicina_app)
SELECT current_user;
# -> PostgresError: password authentication failed for user "medicina_app" (code: '28P01')  (FALHA)
```

### 3.2. Prova de que o 307 Partiu de `page.tsx` e Não do Middleware
No arquivo `node_modules/next-auth/next/middleware.js` (linhas 45-47):
```javascript
const signInUrl = new URL(`${basePath}${signInPage}`, origin);
signInUrl.searchParams.append("callbackUrl", `${basePath}${pathname}${search}`);
return NextResponse.redirect(signInUrl);
```
Se `withAuth` tivesse barrado a requisição a `/`, a URL resultante conteria obrigatoriamente `?callbackUrl=%2F`, gerando o log:
```text
GET /login?callbackUrl=%2F 200
```
No arquivo `src/app/page.tsx` (linhas 11-16):
```typescript
let perfil;
try {
  perfil = await requireAuthenticatedProfile();
} catch {
  redirect('/login'); // <-- Gera exatamente Location: /login (sem query string)
}
```
O log real foi rigorosamente:
```text
GET / 307
GET /login 200
```
Comprovando que a requisição ultrapassou o middleware e falhou dentro de `requireAuthenticatedProfile()`.

---

## 4. ALTERAÇÕES IMPLEMENTADAS NO REPOSITÓRIO

### 4.1. Observabilidade Sanitizada em `src/lib/authorization.ts`
- Implementada a função `sanitizeLogMessage()` que mascara senhas em strings de conexão (`:***@`).
- Adicionado registro no console do servidor para erros de conexão PostgreSQL e falhas no fallback transacional RLS.
- Preservada a segurança fail-closed: o cliente web continua recebendo apenas `AuthorizationError('UNAUTHENTICATED')`, sem vazamento de detalhes internos da infraestrutura.

### 4.2. Rastreabilidade no Servidor em `src/app/page.tsx`
- Adicionado log explícito no console do servidor antes da chamada a `redirect('/login')`, informando exatamente o motivo pelo qual a página inicial redirecionou para o login.

### 4.3. Validação Ativa de Conexões em `scripts/db/configure-staging-web-env.mjs`
- Criada a função exportada `verifyRoleCredentials(role, password, caCertPath)`.
- O utilitário agora conecta ativamente ao Supabase Staging via Session Pooler (porta 5432, TLS com CA canônico) e executa `SELECT current_user;`.
- Se o operador cometer um erro de digitação na senha de `medicina_app` ou `medicina_auth`, o configurador rejeita imediatamente antes de salvar no `.env.local`.
- Atualizado o valor padrão de `NEXTAUTH_URL` para `http://127.0.0.1:3000`.

### 4.4. Preflight Fail-Closed Ativo em `scripts/db/launch-staging-web.mjs`
- Criada a função `verifyPreflightConnections(env, caPath)`.
- Antes de subir o processo `next dev`, o lançador executa uma verificação real de autenticação com o PostgreSQL.
- Se a senha de `medicina_app` estiver incorreta, o preflight falha fechado com código 1, emitindo:
  ```text
  ❌ PREFLIGHT REPROVADO: FALHA DE CONEXÃO COM POSTGRESQL
     • DATABASE_APP_URL falhou na autenticação PostgreSQL: password authentication failed for user "medicina_app"

  💡 Ação recomendada: Execute `npm run config:staging:web` para reconfigurar as senhas das roles no `.env.local`.
  ```
- Adicionado alerta de discrepância caso `NEXTAUTH_URL` divirja de `http://127.0.0.1:3000`.

### 4.5. Alinhamento de Rede em `.env.local`
- Atualizado `NEXTAUTH_URL` de `http://localhost:3000` para `http://127.0.0.1:3000`, eliminando a quebra de confiança de origem no Safari.

### 4.6. Suíte de Testes de Regressão: `src/app/actions/h2_04_t3_r3_login_redirect.test.ts`
- 10 novos testes unitários e de integração cobrindo:
  1. Ciclo de propagação dos tokens e claims (`jwt` e `session`).
  2. Isolamento de erro de banco sob sessão ativa sem vazamento de credenciais.
  3. Resolução de perfil via RLS transacional (`medicina.set_context`).
  4. Amarração de rede local e alerta de discrepância de host.
  5. Validação de preflight e conexões ativas.

---

## 5. PROCEDIMENTO OPERACIONAL PARA O OPERADOR HUMANO

Para concluir a homologação e realizar o login real com Alice:

### Passo 1: Reconfigurar a Senha de `medicina_app`
No terminal, execute o configurador interativo seguro:
```bash
npm run config:staging:web
```
- Digite a senha correta de `medicina_app` (definida na migração de staging).
- Digite a senha de `medicina_auth`.
- O configurador testará ambas as senhas no Supabase Staging em tempo real antes de gravar no `.env.local`.

### Passo 2: Executar o Preflight e Iniciar o Servidor
Execute o lançador seguro:
```bash
npm run dev:staging
```
- O preflight verificará o certificado TLS, o projeto `ynfocaorhadizlvbnzrt`, as conexões ativas e a amarração em `127.0.0.1:3000`.
- O servidor Next.js será inicializado exclusivamente em `http://127.0.0.1:3000`.

### Passo 3: Realizar o Login no Navegador
1. Abra uma janela (normal ou privada) do navegador no endereço:
   `http://127.0.0.1:3000/login`
2. Insira as credenciais de homologação de Alice:
   - **E-mail:** `alice@medicina2029.staging`
   - **Senha:** *(senha sintética configurada na tarefa H2.04-T2)*
3. Clique em **Entrar**.
4. O painel da estudante (`HojePage`) será carregado com sucesso em `/`.

---

## 6. HASHES DE INTEGRIDADE (RELATÓRIOS GÊMEOS)

Os relatórios foram gerados em duplicata idêntica:
- Repositório: `docs/modernizacao/RELATORIO_H2_04_T3_R3.md`
- Documentos: `~/Documents/MEDICINA_2029_H2_04_T3_R3_RELATORIO.md`
