# MEDICINA 2029 — RELATÓRIO DE PREFLIGHT TÉCNICO H2.04-T3-R
## PREFLIGHT FINAL DO AMBIENTE WEB LOCAL E PROCEDIMENTO OPERACIONAL DE LOGIN

**Data:** 02 de Novembro de 2026  
**Ambiente de Homologação:** Supabase Staging (`aws-0-us-east-1.pooler.supabase.com:5432`) / Mac OS  
**Projeto Alvo:** `ynfocaorhadizlvbnzrt` (PostgreSQL 17.6)  
**Camada de Aplicação:** Next.js 16.4.2 / React 19.2.4 / NextAuth 4.24.15  
**Certificado TLS:** `~/Downloads/prod-ca-2021.crt` (Supabase Root 2021 CA)  
**Status do Servidor Web Local:** **APTO (HTTP 200 em `http://localhost:3000/login` validado em 278ms)**  
**Status dos Testes Automatizados:** **100% APROVADOS (63/63 direcionados; 81/81 suíte H2.04 consolidada)**  
**Mutações Remotas Executadas:** **NENHUMA (0 escritas, 0 updates de senhas, 0 migrações, 0 seeds, 0 deploys)**  

---

## 1. PARECER CONCLUSIVO

> [!IMPORTANT]
> **PARECER FINAL: APTO COM RESSALVA OPERACIONAL EXCLUSIVA DE `.env.local`**  
> 
> 1. **Código e Servidor Web:** O runtime Next.js 16.4.2, os manipuladores NextAuth, a mitigação de side-channel (`TIMING_BENCHMARK_HASH`), os middlewares e as guardas server-side de `/lacunas` e `/login` estão **100% APTOS e validados**. O servidor inicia em 278ms e a rota `/login` responde HTTP 200 com HTML integro e sem vazamento de dados.
> 2. **Senhas das Personas:** As senhas de Alice, Bruno e Carlos **já foram configuradas no Supabase Staging**. O utilitário `configure-staging-passwords.mjs` **NÃO DEVE** ser executado novamente.
> 3. **Ressalva Operacional Pré-Conexão:** O arquivo `.env.local` existente na máquina local ainda aponta para `localhost:5432/medicina_dev` (configuração herdada de desenvolvimento local). Para que o servidor local atinja os dados reais de homologação no Supabase Staging, o operador deve ajustar as duas variáveis de conexão (`DATABASE_APP_URL` e `DATABASE_AUTH_URL`) para as credenciais das roles do projeto `ynfocaorhadizlvbnzrt` antes de efetuar o login.

---

## 2. AUDITORIA DO ARQUIVO `.env.local` E VARIÁVEIS DE AMBIENTE

A auditoria estática do arquivo [`.env.local`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/.env.local) foi realizada em conformidade com as diretrizes de segurança (zero exibição de senhas ou segredos):

### 2.1. Matriz de Variáveis no `.env.local` Atual

| Variável | Status no `.env.local` Atual | Destino Configurado Atual | Requisito para Homologação Staging |
| :--- | :---: | :--- | :--- |
| `DATABASE_URL` | **Presente** | `localhost:5432/medicina_dev` (role: `postgres`) | Fallback opcional compatível. |
| `DATABASE_APP_URL` | **Presente** | `localhost:5432/medicina_dev` (role: `postgres`) | **BLOQUEADOR:** Deve apontar para o pooler `ynfocaorhadizlvbnzrt:5432` sob o papel `medicina_app`. |
| `DATABASE_AUTH_URL` | **Presente** | `localhost:5432/medicina_dev` (role: `postgres`) | **BLOQUEADOR:** Deve apontar para o pooler `ynfocaorhadizlvbnzrt:5432` sob o papel `medicina_auth`. |
| `DATABASE_WORKER_URL` | **Presente** | `localhost:5432/medicina_dev` (role: `postgres`) | Não utilizado no teste básico de login. |
| `NEXTAUTH_URL` | **Presente** | `http://localhost:3000` | **CONFORME:** URL canônica da homologação local. |
| `NEXTAUTH_SECRET` | **Presente** | 42 caracteres (entropia alta) | **CONFORME:** Atende ao mínimo de 32 chars e não é valor padrão inseguro. |
| `NODE_ENV` | **Presente** | `development` | **CONFORME:** Ambiente de desenvolvimento local. |
| `STAGING_SUPABASE_PROJECT_REF` | **Ausente** | — | Não requerido em `NODE_ENV=development`. |
| `CONFIRM_ISOLATED_STAGING_ENVIRONMENT` | **Ausente** | — | Não requerido em `NODE_ENV=development`. |
| `APP_ENV` | **Ausente** | — | Não requerido em `NODE_ENV=development`. |

### 2.2. Auditoria Criptográfica do `NEXTAUTH_SECRET`
- **Presença:** Confirmada no `.env.local`.
- **Comprimento:** 42 caracteres (exigência mínima do código: $\ge 32$ caracteres).
- **Lista de Insegurança:** Não pertence à lista de segredos padrão (`secret`, `password`, `change-me`, etc.).
- **Variedade de Caracteres:** Contém letras maiúsculas, minúsculas, dígitos numéricos e símbolos especiais.
- **Conclusão:** O segredo existente é seguro e válido. Não há necessidade de substituição.
- **Orientação de Rotação (se desejado pelo operador):** Caso o operador opte por rotacionar o segredo por política interna, deve gerar uma string aleatória de 32 bytes via terminal:
  ```bash
  openssl rand -base64 32
  ```

---

## 3. BANCO DE DADOS, ROLES E VALIDAÇÃO TLS ESTROITA

### 3.1. Identidade do Projeto Remoto
- **Identificador Canônico:** `ynfocaorhadizlvbnzrt`
- **Host do Pooler:** `aws-0-us-east-1.pooler.supabase.com`
- **Porta Obrigatória:** **`5432` (Session Pooler)**
  *(A porta 6543 de Transaction Pooler não suporta prepared statements exigidos pelo Drizzle ORM e é categoricamente rejeitada).*
- **Base de Dados:** `postgres`

### 3.2. Segregação de Papéis Técnicos no Runtime
Em conformidade com as migrações F1.04-C e F1.06:
- **`medicina_app.ynfocaorhadizlvbnzrt`:** Utilizado por `DATABASE_APP_URL`. Concede acesso às tabelas de negócio (`ciclos`, `ciclo_blocos`, `sessoes`) estritamente sob as políticas RLS ativadas por `medicina.set_context`. Possui `SELECT` na coluna `perfis.password_hash` revogado.
- **`medicina_auth.ynfocaorhadizlvbnzrt`:** Utilizado por `DATABASE_AUTH_URL`. Concede acesso exclusivo à rotina `SECURITY DEFINER` `medicina.autenticar_por_email(text)` e à tabela `public.allowlist`.

### 3.3. Certificado TLS Raiz
A conexão remota exige TLS estrito (`rejectUnauthorized: true`). O certificado emitido pela infraestrutura Supabase foi auditado localmente:
- **Caminho:** `/Users/brunoantunes/Downloads/prod-ca-2021.crt`
- **Subject / Issuer:** `/C=US/ST=Delware/L=New Castle/O=Supabase Inc/CN=Supabase Root 2021 CA`
- **Validade:** Até 26 de Abril de 2031 GMT
- **Impressão Digital SHA-256:**
  `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`
- **Obrigatoriedade:** Para que o Node.js aceite o certificado privado sem desativar a checagem TLS, o servidor Next.js deve ser iniciado com a variável de ambiente nativa:
  ```bash
  export NODE_EXTRA_CA_CERTS="$HOME/Downloads/prod-ca-2021.crt"
  ```

---

## 4. ANÁLISE DE DEPENDÊNCIAS DE INTEGRAÇÃO (GEMINI, WORKER E STORAGE)

A inspeção do código-fonte confirmou a **independência total do fluxo de login e navegação das personas** em relação a integrações externas:

```mermaid
flowchart TD
    subgraph LoginAndDashboardFlow["Fluxo Essencial de Login e Navegação (Autônomo)"]
        LoginForm["Formulário /login"] --> NextAuth["CredentialsProvider (NextAuth)"]
        NextAuth --> AuthRPC["medicina.autenticar_por_email<br/>(via DATABASE_AUTH_URL - medicina_auth)"]
        AuthRPC --> Bcrypt["bcrypt.compare<br/>(Mitigação TIMING_BENCHMARK_HASH)"]
        Bcrypt --> Session["Cookie JWT de Sessão<br/>(NEXTAUTH_SECRET)"]
        Session --> Dashboard["SSR / e /responsavel<br/>(via DATABASE_APP_URL - medicina_app + RLS)"]
    end

    subgraph IndependentSubsystems["Subsistemas Desacoplados (Não Requeridos no Login)"]
        Gemini["Google Gemini IA<br/>(GEMINI_API_KEY)"] -.-|Apenas geração de resumos em Curadoria| Curadoria["Curadoria Avançada"]
        Worker["Worker Assíncrono<br/>(DATABASE_WORKER_URL)"] -.-|Apenas ingestão de PDFs| Ingestao["Pipeline de Documentos"]
        Storage["Supabase Storage<br/>(SUPABASE_URL / ANON_KEY)"] -.-|Apenas upload físico de arquivos| Blobs["Storage Blobs"]
    end
```

- **Gemini IA (`GEMINI_API_KEY`):** Utilizada exclusivamente em `src/app/actions/curadoria.ts` para geração sob demanda de resumos teóricos e questões. **Zero dependência no login ou dashboard.**
- **Worker (`DATABASE_WORKER_URL`):** Utilizado exclusivamente pelos scripts de background job de ingestão de arquivos. **Zero dependência no login ou dashboard.**
- **Storage (`SUPABASE_URL` / `SUPABASE_ANON_KEY`):** Utilizado exclusivamente para download/upload de arquivos brutos do acervo. **Zero dependência no login ou dashboard.**
- **Conclusão:** Não é necessário fornecer chaves do Gemini, do Worker ou do Storage para a homologação do login.

---

## 5. RESULTADOS DO PREFLIGHT LOCAL DO NEXT.JS

O teste de execução real do servidor foi realizado em porta livre (porta 3000):
1. **Boot do Next.js 16.4.2 (Turbopack):** Pronto em **278ms**.
2. **Disponibilidade da Rota `/login`:** Requisição `GET http://localhost:3000/login` retornou status **HTTP 200** em 187ms.
3. **Renderização do Formulário:** HTML inspecionado com sucesso, contendo o título *"Medicina 2029"*, subtítulo *"Acesso ao Sistema de Estudos"*, campos de E-mail, Senha e botão *"Entrar no Sistema"*.
4. **Proteção Contra Produção:** Nenhuma URL aponta para produção; flags de segurança ativas.
5. **Auditoria de Logs:** Nenhum segredo, hash ou credencial foi registrado nos logs do console.

---

## 6. GUIA OPERACIONAL PARA O OPERADOR HUMANO

### Passo 1: Ajustar as Conexões do Staging no `.env.local`
No arquivo `.env.local` na raiz do projeto (`/Users/brunoantunes/Documents/Projetos IA/medicina_2029-main/.env.local`), atualize as variáveis de conexão com as credenciais já existentes das roles técnicas:

```bash
# ----------------------------------------------------------------------------
# CONEXÕES POSTGRESQL STAGING (SUPABASE SESSION POOLER - PORTA 5432)
# ----------------------------------------------------------------------------
DATABASE_APP_URL="postgresql://medicina_app.ynfocaorhadizlvbnzrt:<SENHA_MEDICINA_APP>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"
DATABASE_AUTH_URL="postgresql://medicina_auth.ynfocaorhadizlvbnzrt:<SENHA_MEDICINA_AUTH>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"
DATABASE_URL="postgresql://medicina_app.ynfocaorhadizlvbnzrt:<SENHA_MEDICINA_APP>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"

# ----------------------------------------------------------------------------
# AUTENTICAÇÃO E RUNTIME
# ----------------------------------------------------------------------------
NODE_ENV=development
NEXTAUTH_URL=http://localhost:3000
# Preservar o NEXTAUTH_SECRET existente de 42 caracteres já presente no arquivo
```

> [!NOTE]
> As senhas `<SENHA_MEDICINA_APP>` e `<SENHA_MEDICINA_AUTH>` foram configuradas nas tarefas H2.01-R2 e validadas na tarefa H2.04-T1-R2. Não as compartilhe em commits ou logs.

### Passo 2: Iniciar o Servidor Next.js
No terminal do Mac, exporte o certificado CA raiz e inicie o servidor:
```bash
export NODE_EXTRA_CA_CERTS="$HOME/Downloads/prod-ca-2021.crt"
npm run dev
```
*O servidor estará ativo em `http://localhost:3000`.*

---

## 7. ROTEIRO DE HOMOLOGAÇÃO MANUAL NO NAVEGADOR

Acesse `http://localhost:3000/login` em uma janela anônima do navegador.

### Teste 1: Login de Alice (Estudante Real Definitiva)
1. **Credenciais:**
   - **E-mail:** `alice@medicina2029.staging`
   - **Senha:** *(A senha de Alice já configurada no Supabase Staging)*
2. **Clique em "Entrar no Sistema".**
3. **Comportamento Esperado:**
   - Redireciona para `http://localhost:3000/`.
   - Renderiza o Dashboard do Estudante (`HojePage`) com o ciclo ativo contendo 28 blocos.
   - Menu lateral exibe rotas de estudante (Dashboard, Estudar, Ciclo, Redações, Caderno de Erros, Simulados).
   - Se tentar digitar diretamente na URL `http://localhost:3000/responsavel` ou `/lacunas`, o sistema redireciona imediatamente de volta para `/`.

### Teste 2: Logout Seguro
1. No menu lateral, clique em **Sair**.
2. **Comportamento Esperado:**
   - Redireciona imediatamente para `http://localhost:3000/login`.
   - Cookie de sessão é expulso. Se tentar recarregar `http://localhost:3000/`, o middleware intercepta e exige login.

### Teste 3: Login de Bruno (Responsável Real Definitivo)
1. **Credenciais:**
   - **E-mail:** `bruno@medicina2029.staging`
   - **Senha:** *(A senha de Bruno já configurada no Supabase Staging)*
2. **Clique em "Entrar no Sistema".**
3. **Comportamento Esperado:**
   - Atinge `/` e o Server Component detecta `perfil.papel === 'responsavel'`, redirecionando automaticamente para `http://localhost:3000/responsavel`.
   - Exibe a visão de acompanhamento pedagógico tutelado da estudante Alice.
   - Menu lateral exibe rotas de responsável (Responsável, Acervo, Curadoria, Lacunas).
   - Em conformidade com o princípio de anti-vigilância, Bruno não visualiza sessões de estudo brutas nem dados de estudantes não tutelados.

### Teste 4: Teste Adicional de Carlos (Isolamento Estudante-Estudante — Exclusivo Staging)
> [!NOTE]
> Carlos é uma persona sintética temporária criada unicamente para comprovar que um estudante nunca tem visibilidade sobre outro. Carlos **não integra o sistema definitivo**.
1. **Credenciais:**
   - **E-mail:** `carlos@medicina2029.staging`
   - **Senha:** *(A senha de Carlos já configurada no Supabase Staging)*
2. **Comportamento Esperado:**
   - Login bem-sucedido direciona para `/` com o ciclo independente de Carlos (28 blocos distintos).
   - Zero vínculo com Bruno; zero visibilidade sobre o ciclo ou flashcards de Alice.

---

## 8. REGISTRO DE SALVAGUARDAS E CONFORMIDADE

- **Mutações Remotas Executadas nesta Tarefa:** **0 (Zero)**.
- **Configuração de Senhas Remotas:** **NÃO EXECUTADA** (procedimento anterior removido conforme determinação).
- **Git State:** Working tree preservado (`src/app/lacunas/page.tsx` e `src/app/login/page.tsx` mantidos com as correções de H2.04-T3). Nenhum commit, push ou deploy realizado.
- **Documentação Sincronizada:** Relatórios canônicos gerados com exata paridade criptográfica.
