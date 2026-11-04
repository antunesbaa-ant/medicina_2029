# MEDICINA 2029 — RELATÓRIO DE CONFIGURAÇÃO E PREFLIGHT H2.04-T3-R2
## CONFIGURAÇÃO SEGURA DO AMBIENTE WEB LOCAL E LANÇADOR DE HOMOLOGAÇÃO STAGING

**Data:** 03 de Novembro de 2026  
**Ambiente de Homologação:** Supabase Staging (`aws-0-us-east-1.pooler.supabase.com:5432`) / Mac OS  
**Projeto Alvo:** `ynfocaorhadizlvbnzrt` (PostgreSQL 17.6)  
**Camada Web:** Next.js 16.4.2 / React 19.2.4 / NextAuth 4.24.15  
**Interface Local:** `127.0.0.1:3000` (Amarração de loopback estrita via `-H 127.0.0.1 -p 3000`)  
**Certificado TLS Raiz:** `~/Downloads/prod-ca-2021.crt` (Supabase Root 2021 CA)  
**Status dos Testes Automatizados:** **100% APROVADOS (17/17 testes H2.04-T3-R2; 80/80 testes da suíte consolidada)**  
**Mutações Remotas Executadas:** **NENHUMA (0 escritas, 0 updates de senhas, 0 migrações, 0 seeds, 0 cleanups, 0 deploys)**  

---

## 1. PARECER CONCLUSIVO

> [!IMPORTANT]
> **PARECER FINAL: APTO PARA CONFIGURAÇÃO HUMANA E INICIALIZAÇÃO DA HOMOLOGAÇÃO**  
> 
> 1. **Bloqueador Solucionado:** O bloqueador de dependência do banco local `medicina_dev` foi sanado mediante o desenvolvimento de um utilitário local interativo que configura o `.env.local` diretamente para o Supabase Staging (`ynfocaorhadizlvbnzrt`), sem exigir digitação de senhas no chat ou para o assistente.
> 2. **Ajuste Pontual de Rede Concluído:** O lançador `scripts/db/launch-staging-web.mjs` foi atualizado para amarrar a inicialização do Next.js dev server estritamente ao loopback local `127.0.0.1:3000` através dos argumentos `-H 127.0.0.1 -p 3000` e variáveis de ambiente `HOSTNAME=127.0.0.1` e `PORT=3000`. Isso impede a exposição indevida do servidor de desenvolvimento na rede local (LAN / Wi-Fi `0.0.0.0`).
> 3. **Utilitário de Configuração (`configure-staging-web-env.mjs`):** Solicita as senhas das roles `medicina_app` e `medicina_auth` com entrada oculta no terminal, codifica caracteres especiais via `encodeURIComponent`, preserva o `NEXTAUTH_SECRET` e demais configurações existentes, grava atomicamente com permissões restritas `0600` e purga as variáveis sensíveis da memória.
> 4. **Lançador de Homologação (`launch-staging-web.mjs`):** Valida de forma estrita (fail-closed) antes de iniciar o Next.js todas as variáveis de conexão, porta 5432, projeto exato, certificado TLS CA raiz e integridade do NextAuth, exportando compulsoriamente `NODE_EXTRA_CA_CERTS`.

---

## 2. ARQUITETURA DE SEGURANÇA E AMARRAÇÃO DE REDE

O `.env.local` anterior utilizava conexões locais herdadas (`localhost:5432/medicina_dev`). A arquitetura foi ajustada para operar estritamente contra o Supabase Staging sem violar o isolamento de privilégios e sem expor portas na rede local:

```mermaid
flowchart TD
    subgraph Local_Terminal["Terminal do Mac (Operador Humano)"]
        CLI["Utilitário Interativo<br/>node scripts/db/configure-staging-web-env.mjs"]
        InputApp["Entrada Oculta: Senha medicina_app"]
        InputAuth["Entrada Oculta: Senha medicina_auth"]
        EnvLocal[".env.local (Permissões 0600 -rw-------)<br/>Preserva NEXTAUTH_SECRET / Elimina medicina_dev"]
    end

    subgraph Launcher_Preflight["Lançador de Homologação (launch-staging-web.mjs)"]
        PreflightCheck{"Auditoria Fail-Closed:<br/>1. Host aws-0-us-east-1 / Porta 5432<br/>2. Projeto ynfocaorhadizlvbnzrt<br/>3. Roles medicina_app / medicina_auth<br/>4. CA TLS Fingerprint SHA-256<br/>5. NEXTAUTH_SECRET >= 32 chars<br/>6. Zero referências a medicina_dev"}
        StartNext["Executa: npx next dev -H 127.0.0.1 -p 3000<br/>Injeta: NODE_EXTRA_CA_CERTS, HOSTNAME, PORT"]
    end

    subgraph Supabase_Staging["Supabase Staging (Porta 5432)"]
        SessionPooler["Session Pooler: aws-0-us-east-1.pooler.supabase.com:5432"]
        DB[(PostgreSQL 17.6<br/>Roles: medicina_app / medicina_auth<br/>Alice, Bruno, Carlos)]
    end

    CLI --> InputApp --> EnvLocal
    CLI --> InputAuth --> EnvLocal
    EnvLocal --> PreflightCheck
    PreflightCheck -->|Aprovado| StartNext
    StartNext <-->|TLS Estrito (prod-ca-2021.crt)| SessionPooler <--> DB
```

---

## 3. ESPECIFICAÇÃO DOS UTILITÁRIOS DESENVOLVIDOS E AJUSTADOS

### 3.1. Utilitário de Configuração: `scripts/db/configure-staging-web-env.mjs`
- **Comando:** `npm run config:staging:web` ou `node scripts/db/configure-staging-web-env.mjs`
- **Entrada Segura:** Utiliza `process.stdin.setRawMode(true)` para capturar as senhas das roles sem eco no terminal.
- **Codificação de Caracteres Especiais:** Aplica `encodeURIComponent` na senha antes de montar a URL. Caracteres como `@`, `#`, `$`, `%`, `&`, `+`, `?`, `/`, `:` são devidamente codificados, impedindo corrupção no parser de URLs PostgreSQL e garantindo que o driver `postgres.js` receba a senha original exata.
- **Estrutura das URLs Geradas:**
  - `DATABASE_APP_URL="postgresql://medicina_app.ynfocaorhadizlvbnzrt:<SENHA_ENCODED>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"`
  - `DATABASE_AUTH_URL="postgresql://medicina_auth.ynfocaorhadizlvbnzrt:<SENHA_ENCODED>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"`
  - `DATABASE_URL="postgresql://medicina_app.ynfocaorhadizlvbnzrt:<SENHA_ENCODED>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"`
  - `STAGING_SUPABASE_PROJECT_REF="ynfocaorhadizlvbnzrt"`
- **Preservação de Configurações Existentes:**
  - Preserva `NEXTAUTH_SECRET` (se já possuir entropia $\ge 32$ chars; caso contrário gera um segredo criptográfico de 32 bytes base64).
  - Preserva `NEXTAUTH_URL` (`http://localhost:3000`).
  - Preserva `NODE_ENV` (`development`).
  - Preserva comentários e variáveis customizadas do desenvolvedor.
  - Remove qualquer referência residual a `DATABASE_WORKER_URL=...medicina_dev`.
- **Gravação Atômica e Permissões:**
  - Grava inicialmente em arquivo temporário `.env.local.tmp.<hex>`.
  - Aplica permissão `0600` (`fs.chmodSync(tmpFile, 0o600)`).
  - Renomeia atomicamente para `.env.local`.
  - Confirma permissão `0600` (`-rw-------`, legível exclusivamente pelo proprietário no Mac OS).
- **Proteção no Git:**
  - Comprovado via `git check-ignore -v .env.local` que `.env.local` é ignorado pela regra `.gitignore:34:.env*`.
- **Purga de Memória e Zero Vazamento:**
  - Variáveis contendo senhas em texto plano são sobrescritas no bloco `finally`.
  - Nenhum valor de senha ou URL com credenciais é impresso no console ou gravado em logs. Apenas URLs com senha mascarada (`:***@`) são exibidas na confirmação.

### 3.2. Lançador Seguro de Homologação: `scripts/db/launch-staging-web.mjs` (Ajustado)
- **Comando:** `npm run dev:staging` ou `node scripts/db/launch-staging-web.mjs`
- **Amarração de Rede Estrita:**
  - A função `buildNextDevArgs(host = '127.0.0.1', port = '3000')` produz os argumentos `['next', 'dev', '-H', '127.0.0.1', '-p', '3000']`.
  - O processo filho `npx` recebe `HOSTNAME: '127.0.0.1'` e `PORT: '3000'`, garantindo que a escuta TCP ocorra exclusivamente no loopback local `127.0.0.1`, sem expor o serviço na rede local.
- **Verificações de Preflight (Fail-Closed):**
  1. *Arquivo `.env.local`:* Confirma existência e restringe permissões para `0600` se divergentes.
  2. *DATABASE_APP_URL:* Host `aws-0-us-east-1.pooler.supabase.com`, porta `5432`, base `postgres`, usuário `medicina_app.ynfocaorhadizlvbnzrt`, parâmetro `sslmode=require` e ausência de `medicina_dev`.
  3. *DATABASE_AUTH_URL:* Host `aws-0-us-east-1.pooler.supabase.com`, porta `5432`, base `postgres`, usuário `medicina_auth.ynfocaorhadizlvbnzrt`, parâmetro `sslmode=require` e ausência de `medicina_dev`.
  4. *DATABASE_URL:* Valida ausência de referências a `localhost`, `127.0.0.1` ou `medicina_dev`.
  5. *Certificado TLS CA:* Localiza `prod-ca-2021.crt` (em `~/Downloads` ou via argumento `--ca`), validando que a impressão digital SHA-256 seja exatamente:
     `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.
  6. *NEXTAUTH_SECRET:* Exige comprimento mínimo de 32 caracteres e rejeita segredos padrão inseguros.
  7. *NEXTAUTH_URL:* Confirma URL válida para atendimento local (`http://localhost:3000`).
- **Modo `--check-only`:** Permite validar todas as condições estáticas sem inicializar o servidor de desenvolvimento.
- **Injeção Automática de CA:** Exporta compulsoriamente `NODE_EXTRA_CA_CERTS: preflight.caPath` no processo filho.

---

## 4. RESULTADOS DA SUÍTE DE TESTES AUTOMATIZADOS

A suíte de testes em `src/app/actions/h2_04_t3_r2_staging_web_env.test.ts` foi executada via Vitest, cobrindo todos os cenários com credenciais sintéticas e diretórios temporários:

| Grupo de Teste | Cenário Avaliado | Resultado |
| :--- | :--- | :---: |
| **1. Construção de URLs** | 1.1 Constrói URL com projeto `ynfocaorhadizlvbnzrt`, porta 5432 e `sslmode=require` | **APROVADO** |
| | 1.2 Codifica senhas com caracteres especiais (`@`, `#`, `$`, `%`, `&`, `+`, `?`, `/`, `:`) | **APROVADO** |
| | 1.3 Rejeita senhas curtas (< 8 chars) ou com caracteres de controle (`\n`, `\r`) | **APROVADO** |
| **2. Atualização Atômica** | 2.1 Preserva `NEXTAUTH_SECRET` existente de alta entropia e desativa `medicina_dev` | **APROVADO** |
| | 2.2 Gera `NEXTAUTH_SECRET` criptográfico forte caso ausente no arquivo | **APROVADO** |
| **3. Permissões e Sigilo** | 3.1 Garante permissão `0600` (`-rw-------`) no arquivo gerado | **APROVADO** |
| | 3.2 Comprova zero vazamento de senhas em logs do configurador | **APROVADO** |
| **4. Validação de URLs** | 4.1 Rejeita `localhost`, `127.0.0.1` e `medicina_dev` | **APROVADO** |
| | 4.2 Rejeita porta 6543 do Transaction Pooler (exige 5432) | **APROVADO** |
| | 4.3 Rejeita papéis administrativos (`postgres`) ou incorretos | **APROVADO** |
| | 4.4 Rejeita `sslmode` ausente ou desativado | **APROVADO** |
| | 4.5 Aceita conexão canônica de staging perfeitamente configurada | **APROVADO** |
| **5. Preflight do Lançador**| 5.1 Falha fechado se `.env.local` estiver ausente | **APROVADO** |
| | 5.2 Falha fechado se `NEXTAUTH_SECRET` tiver menos de 32 caracteres | **APROVADO** |
| | 5.3 Aprova preflight completo com CA certificado e credenciais válidas | **APROVADO** |
| **6. Amarração de Rede** | 6.1 Amarra o servidor Next.js exclusivamente em 127.0.0.1:3000 por padrão | **APROVADO** |
| | 6.2 Permite porta ou host customizados mantendo seletores `-H` e `-p` | **APROVADO** |

**Consolidado da Suíte H2.04-T3-R2:** **17/17 testes aprovados** em 9ms.  
**Suíte Geral Consolidada:** **80/80 testes aprovados** em 5.44s.

---

## 5. GUIA OPERACIONAL PARA O OPERADOR HUMANO

Para concluir a preparação e iniciar a homologação de login:

### Passo 1: Executar o Configurador Interativo no Terminal
No terminal do seu Mac (na raiz do projeto):
```bash
npm run config:staging:web
```
*(Alternativa direta: `node scripts/db/configure-staging-web-env.mjs`)*

1. O prompt solicitará a senha da role **`medicina_app`** (a digitação é oculta, sem eco no terminal);
2. Em seguida, solicitará a senha da role **`medicina_auth`** (também oculta);
3. O utilitário atualizará o `.env.local` atomicamente com permissões `0600`.

> [!NOTE]
> As senhas de `medicina_app` e `medicina_auth` foram definidas pelo operador na tarefa H2.01-R2 e validadas com sucesso na tarefa H2.04-T1-R2.

### Passo 2: Iniciar o Servidor Next.js via Lançador de Homologação
No terminal do seu Mac:
```bash
npm run dev:staging
```
*(Alternativa direta: `node scripts/db/launch-staging-web.mjs`)*

O lançador executará todas as verificações de preflight (projeto, porta 5432, roles, certificado CA em `~/Downloads/prod-ca-2021.crt`, `NEXTAUTH_SECRET`) e iniciará o servidor Next.js exclusivamente em:
```text
http://127.0.0.1:3000
```
*(Também acessível via `http://localhost:3000`)*

---

## 6. ROTEIRO DE HOMOLOGAÇÃO MANUAL NO NAVEGADOR

Abra uma janela anônima no navegador e acesse: **`http://127.0.0.1:3000/login`** (ou `http://localhost:3000/login`).

### Teste 1: Login de Alice (Estudante Real Definitiva)
1. **Credenciais:**
   - **E-mail:** `alice@medicina2029.staging`
   - **Senha:** *(Senha de Alice já configurada no Supabase Staging)*
2. **Comportamento Esperado:**
   - Autentica via `medicina_auth` (`medicina.autenticar_por_email`);
   - Redireciona para `http://127.0.0.1:3000/`;
   - Renderiza o Dashboard do Estudante (`HojePage`) com o ciclo ativo contendo 28 blocos;
   - Menu lateral exibe rotas de estudante;
   - Se tentar acessar `/responsavel` ou `/lacunas`, o sistema redireciona imediatamente de volta para `/`.

### Teste 2: Logout Seguro
1. No menu lateral, clique em **Sair**.
2. **Comportamento Esperado:**
   - Redireciona imediatamente para `http://127.0.0.1:3000/login`;
   - Sessão é invalidada e o cookie JWT é expulso.

### Teste 3: Login de Bruno (Responsável Real Definitivo)
1. **Credenciais:**
   - **E-mail:** `bruno@medicina2029.staging`
   - **Senha:** *(Senha de Bruno já configurada no Supabase Staging)*
2. **Comportamento Esperado:**
   - Atinge `/` e o Server Component detecta `perfil.papel === 'responsavel'`, redirecionando automaticamente para `http://127.0.0.1:3000/responsavel`;
   - Exibe a visão de acompanhamento pedagógico tutelado da estudante Alice;
   - Menu lateral exibe rotas de responsável (`/responsavel`, `/acervo`, `/curadoria`, `/lacunas`);
   - Princípio de anti-vigilância: Bruno não visualiza sessões de estudo brutas nem dados de Carlos.

### Teste 4: Teste Adicional de Carlos (Isolamento Estudante-Estudante — Exclusivo Staging)
> [!NOTE]
> Carlos é uma identidade sintética temporária de homologação para comprovar o isolamento RLS entre estudantes. Carlos **não integra o sistema definitivo**.
1. **Credenciais:**
   - **E-mail:** `carlos@medicina2029.staging`
   - **Senha:** *(Senha de Carlos já configurada no Supabase Staging)*
2. **Comportamento Esperado:**
   - Login bem-sucedido direciona para `/` com o ciclo independente de Carlos (28 blocos distintos);
   - Zero vínculo com Bruno; zero visibilidade sobre Alice.

---

## 7. GARANTIAS DE SEGURANÇA E REGISTRO DE SALVAGUARDAS

- **Mutações Remotas Realizadas nesta Tarefa:** **0 (Zero)**.
- **Exposição de Credenciais:** **Zero senhas em texto plano** registradas em arquivos de log, código ou relatórios.
- **Isolamento de Rede Local:** O servidor Next.js amarrado exclusivamente em `127.0.0.1:3000` via `-H 127.0.0.1 -p 3000`.
- **Git State:** `.env.local` estritamente ignorado pelo Git (`.gitignore:34:.env*`) com permissões `0600` (`-rw-------`). Nenhum commit, push ou deploy executado nesta etapa.
- **Documentação Sincronizada:** Relatórios canônicos gerados com paridade criptográfica comprovada via SHA-256.
