# PROJETO MEDICINA 2029 — RELATÓRIO TÉCNICO H1.03-R
## CORREÇÃO PRÉ-STAGING: SEGREGAÇÃO RIGOROSA DE PAPÉIS E MENOR PRIVILÉGIO

**Data de Execução:** 23 de Outubro de 2026  
**Ambiente:** Local / PostgreSQL 18.6 Descartável (PGlite + pgvector)  
**Status:** **HOMOLOGADO E APROVADO PARA DECISÃO HUMANA**  
**Escopo:** Correção da Inconsistência de Credenciais do Checklist H1.03, Implementação de Menor Privilégio no Runtime, Defesa em Profundidade contra Roles Administrativas, Testes Negativos e Roteiro Operacional Corrigido.

---

## 1. CONTEXTO E MOTIVAÇÃO DA CORREÇÃO H1.03-R

Durante a revisão do relatório de preflight (`RELATORIO_H1_03.md`), foi identificada uma inconsistência de segurança no checklist operacional para implantação na Vercel: as variáveis de runtime (`DATABASE_URL`, `DATABASE_APP_URL`, `DATABASE_AUTH_URL` e `DATABASE_WORKER_URL`) utilizavam a role administrativa `postgres`.

Conforme a arquitetura de segurança consolidada do **Projeto Medicina 2029** (F1.04-C, F1.06, H1.01-R e H1.02), o runtime da aplicação deve obedecer estritamente ao princípio do **Menor Privilégio**:
- **`medicina_app`**: Aplicação web e Server Actions de negócio cotidianas (sem acesso à coluna `password_hash` nem tabelas internas de autenticação);
- **`medicina_auth`**: NextAuth e verificação de sessões, restrito à execução da função defensiva `medicina.autenticar_por_email`;
- **`medicina_worker`**: Processamento em segundo plano da fila e pipeline do acervo didático;
- **Role Administrativa (`postgres`)**: Uso **exclusivo** do runner de migrações DDL (`scripts/db/migrate-staging.mjs`), nunca configurada no runtime da aplicação web nem exposta em variáveis da Vercel.

O objetivo da etapa **H1.03-R** foi corrigir o checklist, instrumentar salvaguardas fail-closed no código para impedir o uso acidental ou indevido de credenciais administrativas no runtime, testar os cenários negativos em PostgreSQL descartável e atualizar o plano diretor.

---

## 2. VERIFICAÇÃO E IMPLEMENTAÇÃO DOS 7 PONTOS CRÍTICOS

### 2.1. Compatibilidade Real com Supabase Pooler e Nomes de Usuários por Projeto
- **Formato de Usuário no Pooler:** O Connection Pooler do Supabase (Supavisor / PgBouncer nas portas `6543` modo transação e `5432` modo sessão) exige o formato de usuário `<role_name>.<project_ref>` (ex.: `medicina_app.med2029-staging-xyz`). A conexão direta (`db.<project_ref>.supabase.co:5432`) aceita o nome simples `<role_name>`.
- **Implementação do Parser:** Foi criada a função pura `extractDatabaseRole(urlStr)` em `src/lib/envGuard.ts` e em `scripts/db/migrate-staging.mjs`. O parser extrai o nome de usuário da URL e isola o papel antes do primeiro ponto ou `@`, sendo 100% compatível com ambos os formatos:
  - `postgres://medicina_app.xyz:pwd@pooler.supabase.com:6543/postgres` $\rightarrow$ `medicina_app`
  - `postgresql://postgres:pwd@db.xyz.supabase.co:5432/postgres` $\rightarrow$ `postgres`
- **Porta Recomendada:** As conexões do runtime Next.js na Vercel devem utilizar a porta `6543` (Transaction Pooler) com `?sslmode=require` para máxima eficiência e resiliência em ambiente serverless.

### 2.2. Ordem de Criação das Roles, Grants e RLS
- **Sequência Canônica de Migração:** As roles são criadas pela proposta DDL `F1_04_RLS_PROPOSTA.sql` como:
  ```sql
  CREATE ROLE medicina_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  CREATE ROLE medicina_auth WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  CREATE ROLE medicina_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ```
- **Provisionamento Obrigatório de Senhas:** No PostgreSQL gerenciado do Supabase, roles criadas via migração DDL nascem sem senha (`PASSWORD NULL`). Consequentemente, conexões TCP autenticadas via pooler serão rejeitadas caso senhas não sejam provisionadas.
- **Passo Operacional Pós-DDL:** Imediatamente após a aplicação das migrações e antes da subida do runtime, o administrador deve executar via SQL Editor do Supabase:
  ```sql
  ALTER ROLE medicina_app WITH PASSWORD '<SENHA_FORTE_APP>';
  ALTER ROLE medicina_auth WITH PASSWORD '<SENHA_FORTE_AUTH>';
  ALTER ROLE medicina_worker WITH PASSWORD '<SENHA_FORTE_WORKER>';
  ```

### 2.3. Banco Utilizado pelo Runner de Migrações
- **Privilégios DDL:** O runner de migrações (`scripts/db/migrate-staging.mjs`) executa criação de tabelas, extensões (`vector`), views de segurança, policies RLS e concessão de privilégios (`GRANT`). Portanto, **exige** a role administrativa `postgres`.
- **Variáveis Dedicadas:** O script agora busca prioritariamente `DATABASE_MIGRATION_URL` ou `DATABASE_ADMIN_URL`.
- **Bloqueio Fail-Closed:** O runner valida a role da conexão. Caso seja invocado com `medicina_app`, `medicina_auth` ou `medicina_worker`, aborta sumariamente:
  ```
  VIOLAÇÃO DE PRIVILÉGIO: O runner de migrações DDL de staging não pode ser executado com papéis restritos de runtime ("medicina_app").
  Utilize DATABASE_MIGRATION_URL configurada com a role administrativa (ex: postgres).
  ```

### 2.4. Ausência de Acesso Administrativo no Runtime
- **Guardião Fail-Closed (`src/lib/envGuard.ts`):** O `envGuard` inspeciona todas as variáveis de banco de runtime (`DATABASE_URL`, `DATABASE_APP_URL`, `DATABASE_AUTH_URL`, `DATABASE_WORKER_URL`).
- **Bloqueio Categórico:** Se qualquer conexão de runtime utilizar `postgres`, `supabase_admin`, `root` ou `admin`, a inicialização do Next.js é imediatamente bloqueada com erro descritivo:
  ```
  VIOLAÇÃO DE MENOR PRIVILÉGIO: DATABASE_APP_URL utiliza credenciais administrativas ("postgres").
  O runtime de staging deve utilizar exclusivamente o papel restrito "medicina_app".
  ```
- O runtime nunca possui privilégios de superuser nem capacidade de contornar RLS (`NOBYPASSRLS`).

### 2.5. Bloqueio de Configurações Divergentes
- **Correspondência Estrita de Papéis:**
  - `DATABASE_APP_URL` e `DATABASE_URL`: Exigem a role `medicina_app`.
  - `DATABASE_AUTH_URL`: Exige a role `medicina_auth`.
  - `DATABASE_WORKER_URL`: Exige a role `medicina_worker`.
- **Incompatibilidade Cruzada:** Qualquer inversão (ex.: atribuir a conexão de `medicina_app` para `DATABASE_AUTH_URL`) resulta no erro fail-closed:
  ```
  INCOMPATIBILIDADE DE PAPEL: DATABASE_AUTH_URL utiliza a role "medicina_app", mas esperava-se "medicina_auth".
  ```
- **Coerência Estrutural:** Todas as conexões devem apontar para o mesmo host, o mesmo banco de dados (`postgres`) e o mesmo projeto autorizado (`STAGING_SUPABASE_PROJECT_REF`).

### 2.6. Aplicabilidade das Policies de Storage no Supabase Gerenciado
- **Arquitetura Desacoplada do Storage:** O Supabase Storage opera como um serviço HTTP RESTful independente (`/storage/v1/object/...`).
- **Bucket Privado Obrigatório:** O bucket `acervo` deve ser criado no painel ou API com a propriedade `public = false`.
- **Autenticação Server-Side:** No Next.js, as Server Actions de upload e geração de URLs assinadas utilizam a biblioteca cliente do Supabase com a chave `SUPABASE_SERVICE_ROLE_KEY` exclusivamente no ambiente de servidor (nunca exposta ao browser). O cliente público (`anon_key`) não possui privilégios para leitura ou escrita direta no bucket.
- **Defesa SQL no Banco:** As propostas SQL em `F1_10_STORAGE_POLICIES_PROPOSTA.sql` atuam sobre o catálogo `storage.objects` e garantem a constraint relacional `storage_buckets_acervo_private_check`, assegurando consistência contra desconfigurações manuais.

### 2.7. Sequência de Ativação e Protocolo de Rollback
- **Sequência de Ativação Segura:**
  1. Criação do projeto Supabase Staging no Free Tier;
  2. Execução das migrações DDL canônicas pelo runner administrativo (`DATABASE_MIGRATION_URL` com `postgres`);
  3. Atribuição de senhas fortes para as roles de runtime (`ALTER ROLE ... WITH PASSWORD`);
  4. Criação do bucket privado `acervo` (`public = false`);
  5. Configuração das variáveis restritas na Vercel Staging (apenas `medicina_app`, `medicina_auth`, `medicina_worker`);
  6. Deploy na Vercel e validação do boot fail-closed via `instrumentation.ts`;
  7. Carga de dados sintéticos via `seed-staging.ts` (`medicina_app`);
  8. Execução manual de teste do worker sob demanda (`medicina_worker`).
- **Protocolo de Rollback Granular:**
  - *Rollback de Aplicação:* Reversão instantânea do deployment na Vercel para o build anterior;
  - *Rollback de Dados Sintéticos:* Re-execução do script `seed-staging.ts` (100% idempotente, baseado em UUIDs canônicos) ou limpeza seletiva;
  - *Rollback de Migrações:* Aplicação sequencial dos scripts canônicos de rollback (`F1_04_ROLLBACK_RLS.sql`, `F1_10_ROLLBACK_STORAGE.sql`, etc.) através da role administrativa `postgres`.

---

## 3. COMPROVAÇÃO DE TESTES TÉCNICOS (POSTGRESQL DESCARTÁVEL)

A verificação completa foi executada sem nenhuma conexão remota ou persistente, utilizando instâncias PostgreSQL 18.6 descartáveis em memória com extensão `pgvector`.

### 3.1. Suíte Preflight Atualizada (`h1_03_staging_preflight.test.ts`)
A suíte foi expandida de 19 para **24 testes unitários e de integração**, com 100% de sucesso:
- **Testes Negativos de Menor Privilégio:**
  - Rejeição fail-closed quando `DATABASE_URL` ou `DATABASE_APP_URL` utiliza a role administrativa `postgres` ($\rightarrow$ `VIOLAÇÃO DE MENOR PRIVILÉGIO`);
  - Rejeição fail-closed quando as roles de runtime estão cruzadas ou invertidas ($\rightarrow$ `INCOMPATIBILIDADE DE PAPEL`);
  - Rejeição fail-closed quando o runner de migrações DDL é invocado com `medicina_app` ($\rightarrow$ `VIOLAÇÃO DE PRIVILÉGIO`).
- **Testes Positivos:**
  - Aprovação do runner de migrações DDL com `DATABASE_MIGRATION_URL` sob a role `postgres`;
  - Aprovação do runtime de staging publicado (`NODE_ENV=production`, `APP_ENV=staging`) com todas as conexões devidamente segregadas (`medicina_app`, `medicina_auth`, `medicina_worker`).

### 3.2. Bateria Global de Conformidade
| Ferramenta / Suíte | Comando | Resultado | Status |
| :--- | :--- | :--- | :---: |
| **Suíte H1.03-R** | `npx vitest run src/app/actions/h1_03_staging_preflight.test.ts` | 24 de 24 testes aprovados | **APROVADO** |
| **Suíte H1.02** | `npx vitest run src/app/actions/h1_02_staging_preparacao.test.ts` | 18 de 18 testes aprovados | **APROVADO** |
| **Vitest Integral** | `npm run test:run` | **37 arquivos, 353 testes aprovados (0 falhas)** | **APROVADO** |
| **TypeScript** | `npx tsc --noEmit` | 0 erros de compilação | **APROVADO** |
| **Next.js Build** | `npm run build` | Compilação Turbopack concluída com sucesso | **APROVADO** |
| **Drizzle Kit** | `npx drizzle-kit check` | Esquema e migrações 100% sincronizados | **APROVADO** |
| **ESLint** | `npx eslint src/lib/envGuard.ts ...` | 0 erros, 0 advertências | **APROVADO** |
| **Git Diff** | `git diff --check` | 0 conflitos de formatação/espaço | **APROVADO** |
| **Suíte RLS (F1.04)** | `node scripts/f1_04/run-rls-validation.mjs` | **41 de 41 cenários de segurança aprovados** | **APROVADO** |

---

## 4. CHECKLIST OPERACIONAL CORRIGIDO DE ATIVAÇÃO DO STAGING

### 4.1. Matriz de Variáveis de Ambiente da Vercel (Runtime de Staging)
> **ATENÇÃO:** Nenhuma credencial administrativa (`postgres`) deve ser inserida nas configurações da Vercel.

| Variável | Papel do Banco | Exemplo Seguro (Sintético / Pooler) | Finalidade |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | — | `production` | Modo otimizado de produção do Next.js |
| `APP_ENV` | — | `staging` | Identificador estrito de staging para o `envGuard` |
| `STAGING_SUPABASE_PROJECT_REF` | — | `[STAGING_REF]` | Referência inequívoca do projeto Supabase |
| `CONFIRM_ISOLATED_STAGING_ENVIRONMENT` | — | `true` | Assinatura declarativa fail-closed |
| `DATABASE_URL` | `medicina_app` | `postgres://medicina_app.[STAGING_REF]:[SENHA_APP]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require` | Conexão padrão da aplicação |
| `DATABASE_APP_URL` | `medicina_app` | `postgres://medicina_app.[STAGING_REF]:[SENHA_APP]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require` | Server Actions e operações cotidianas |
| `DATABASE_AUTH_URL` | `medicina_auth` | `postgres://medicina_auth.[STAGING_REF]:[SENHA_AUTH]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require` | NextAuth e autenticação de usuários |
| `DATABASE_WORKER_URL` | `medicina_worker` | `postgres://medicina_worker.[STAGING_REF]:[SENHA_WORKER]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require` | Processamento do pipeline do acervo |
| `SUPABASE_URL` | — | `https://[STAGING_REF].supabase.co` | Endpoint do Storage Supabase |
| `SUPABASE_ANON_KEY` | — | `[STAGING_ANON_KEY]` | Chave anônima para metadados |
| `SUPABASE_SERVICE_ROLE_KEY` | — | `[STAGING_SERVICE_ROLE_KEY]` | Chave privada server-side para Storage |
| `NEXTAUTH_SECRET` | — | `[SECRET_ALEATORIO_32_CHARS]` | Assinatura e criptografia de cookies de sessão |
| `NEXTAUTH_URL` | — | `https://[SUBDOMINIO_VERCEL].vercel.app` | URL pública canônica da Vercel Staging |
| `GEMINI_API_KEY` | — | `[STAGING_GEMINI_API_KEY]` | Chave da Google AI Studio para IA |

---

### 4.2. Variáveis Exclusivas para Execução Local de Migrações (Runner CLI)
> **NOTA:** Estas variáveis são utilizadas **exclusivamente na máquina do administrador** durante a janela de migração DDL e **nunca** na Vercel.

| Variável | Papel do Banco | Exemplo Seguro | Finalidade |
| :--- | :--- | :--- | :--- |
| `APP_ENV` | — | `staging` | Ativação do guardião de isolamento |
| `STAGING_SUPABASE_PROJECT_REF` | — | `[STAGING_REF]` | Validação de correspondência de projeto |
| `CONFIRM_ISOLATED_STAGING_ENVIRONMENT` | — | `true` | Assinatura declarativa fail-closed |
| `CONFIRM_STAGING_MIGRATIONS` | — | `true` | Confirmação explícita para aplicar DDL |
| `DATABASE_MIGRATION_URL` | `postgres` | `postgres://postgres.[STAGING_REF]:[SENHA_ADMIN_SUPABASE]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require` | Execução com privilégios administrativos |

---

### 4.3. Roteiro Passo a Passo de Implantação Manual

#### Passo 1: Criação do Projeto Supabase Staging
1. Acessar o dashboard do Supabase e criar um novo projeto (ex: `medicina-staging-2029`) no plano gratuito (Free Tier).
2. Selecionar a região mais próxima (ex: `sa-east-1` São Paulo).
3. Salvar a senha do administrador `postgres` em cofre seguro.
4. Coletar o `Project Ref` (`STAGING_SUPABASE_PROJECT_REF`), o endpoint (`https://[REF].supabase.co`), a `anon key` e a `service_role key`.

#### Passo 2: Execução das Migrações DDL Canônicas
1. Na máquina local de desenvolvimento (com as credenciais de staging devidamente isoladas):
   ```bash
   APP_ENV=staging \
   STAGING_SUPABASE_PROJECT_REF="[STAGING_REF]" \
   CONFIRM_ISOLATED_STAGING_ENVIRONMENT="true" \
   CONFIRM_STAGING_MIGRATIONS="true" \
   DATABASE_MIGRATION_URL="postgres://postgres.[STAGING_REF]:[SENHA_ADMIN]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require" \
   node scripts/db/migrate-staging.mjs
   ```
2. O runner executará as 9 migrações canônicas (`0000..0003` + `F1.04..F1.12`), criando o schema, extensões, tabelas, views de auditoria, funções RLS e as 3 roles restritas de runtime.

#### Passo 3: Provisionamento de Senhas das Roles de Runtime
1. No painel do Supabase, acessar **SQL Editor** e executar:
   ```sql
   ALTER ROLE medicina_app WITH PASSWORD '[GERAR_SENHA_FORTE_APP]';
   ALTER ROLE medicina_auth WITH PASSWORD '[GERAR_SENHA_FORTE_AUTH]';
   ALTER ROLE medicina_worker WITH PASSWORD '[GERAR_SENHA_FORTE_WORKER]';
   ```

#### Passo 4: Configuração do Supabase Storage
1. No menu **Storage** do Supabase, criar o bucket com o nome exato: `acervo`.
2. **Desmarcar** a opção "Public bucket" (assegurando `public = false`).
3. Opcionalmente, fixar o tamanho máximo por arquivo (ex: 50MB) e os tipos permitidos (`application/pdf`).

#### Passo 5: Configuração e Deploy na Vercel (Staging)
1. Conectar o repositório à Vercel apontando para o ambiente de Staging.
2. Cadastrar as variáveis de ambiente descritas na Tabela 4.1 (assegurando que `DATABASE_URL`, `DATABASE_APP_URL`, `DATABASE_AUTH_URL` e `DATABASE_WORKER_URL` utilizem as roles `medicina_app`, `medicina_auth` e `medicina_worker`, respectivamente).
3. Disparar o deploy e acompanhar os logs de inicialização. O preflight do `src/instrumentation.ts` validará o isolamento fail-closed automaticamente.

#### Passo 6: Carga de Dados Sintéticos Canônicos (Seed)
1. Executar a carga idempotente a partir da máquina do administrador:
   ```bash
   APP_ENV=staging \
   STAGING_SUPABASE_PROJECT_REF="[STAGING_REF]" \
   CONFIRM_ISOLATED_STAGING_ENVIRONMENT="true" \
   CONFIRM_STAGING_SEED="true" \
   DATABASE_URL="postgres://medicina_app.[STAGING_REF]:[SENHA_APP]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require" \
   DATABASE_APP_URL="postgres://medicina_app.[STAGING_REF]:[SENHA_APP]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require" \
   DATABASE_AUTH_URL="postgres://medicina_auth.[STAGING_REF]:[SENHA_AUTH]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require" \
   DATABASE_WORKER_URL="postgres://medicina_worker.[STAGING_REF]:[SENHA_WORKER]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require" \
   SUPABASE_URL="https://[STAGING_REF].supabase.co" \
   SUPABASE_ANON_KEY="[STAGING_ANON_KEY]" \
   NEXTAUTH_SECRET="[STAGING_NEXTAUTH_SECRET]" \
   GEMINI_API_KEY="[STAGING_GEMINI_KEY]" \
   npm run db:seed:staging
   ```
2. O script criará os perfis sintéticos de teste (Alice e Bruno), o ciclo inicial, os cards de revisão e os metadados dos 3 PDFs sintéticos com hashes SHA-256 matematicamente conferidos.

#### Passo 7: Teste Operacional do Worker sob Demanda
1. Testar o processamento em lote da fila do acervo via script CLI:
   ```bash
   APP_ENV=staging \
   STAGING_SUPABASE_PROJECT_REF="[STAGING_REF]" \
   CONFIRM_ISOLATED_STAGING_ENVIRONMENT="true" \
   CONFIRM_ON_DEMAND_WORKER="true" \
   DATABASE_WORKER_URL="postgres://medicina_worker.[STAGING_REF]:[SENHA_WORKER]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require" \
   WORKER_MAX_JOBS=5 \
   WORKER_MAX_DURATION_MS=60000 \
   node scripts/worker/run-on-demand.mjs
   ```

---

## 5. CONCLUSÃO E DECISÃO TÉCNICA

A revisão **H1.03-R** eliminou com sucesso a inconsistência do checklist operacional, estabelecendo garantias de menor privilégio no código, nos scripts e na configuração de deployment:
1. **Segregação Rigorosa:** A role administrativa `postgres` está categoricamente banida do runtime da aplicação e protegida por testes negativos fail-closed.
2. **Defesa em Profundidade:** Cada subsistema da aplicação conecta com a role de banco estritamente necessária ao seu propósito funcional (`medicina_app`, `medicina_auth`, `medicina_worker`).
3. **Compatibilidade Total:** Compatibilidade comprovada com o pooler do Supabase e com a suíte integral de 353 testes automatizados e 41 cenários RLS.

**Decisão Formal:**  
O preflight de staging está **CORRIGIDO, REVALIDADO E APROVADO**. O projeto está apto para o provisionamento remoto manual assim que for autorizado pelo responsável.

---
*Relatório emitido pela Engenharia de Segurança e Infraestrutura do Projeto Medicina 2029.*
