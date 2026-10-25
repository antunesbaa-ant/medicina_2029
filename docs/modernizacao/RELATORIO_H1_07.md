# MEDICINA 2029 — RELATÓRIO H1.07
## PREPARAÇÃO DA SÉTIMA MIGRAÇÃO (F1.10 — SUPABASE STORAGE & POLICIES DO ACERVO)

**Projeto Alvo:** `medicina-2029-staging` (`ynfocaorhadizlvbnzrt`)  
**Data da Avaliação:** 25 de outubro de 2026  
**Ambiente de Destino:** Homologação Staging (Session Pooler: `aws-0-us-east-1.pooler.supabase.com:5432`)  
**Escopo:** Preparação exclusiva da Etapa 7 (`docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql`), mapeamento da fronteira de confiança de credenciais (`service_role` vs RLS), matriz de acesso a arquivos e implementação do lançador seguro.

---

## 1. INSPEÇÃO INTEGRAL DA MIGRAÇÃO F1.10

A migração `F1_10_STORAGE_POLICIES_PROPOSTA.sql` (12.870 bytes, SHA-256: `6b79d1bbfe2e18a664d6b383764a66ae8565738682a8f07b1954cfda4a795a9a`) estabelece as políticas de segurança e integridade física para o bucket privado `acervo` e objetos gerenciados em `storage.objects`, acompanhada de transação protegida com `lock_timeout = '5s'` e `statement_timeout = '60s'`.

### 1.1 Preflight Diagnóstico Fail-Closed
- Aborta com erro `P0001` caso as tabelas base `public.perfis`, `public.acervo_arquivos` ou `public.responsavel_estudante` estejam ausentes.
- Aborta com erro `P0001` se houver registros legados em `public.acervo_arquivos` que violem o MIME `application/pdf`, o teto de 20 MiB (`20971520` bytes) ou apresentem sequências maliciosas de path traversal (`..` ou `\`).

### 1.2 Estrutura de Tabelas e Constraints no Schema `storage`
- **Tabela `storage.buckets`:** Define o bucket `acervo` com `public = false`, `file_size_limit = 20971520` e `allowed_mime_types = ARRAY['application/pdf']::text[]`.
  - Constraint física `storage_buckets_acervo_private_check`: Impede que o bucket `acervo` seja alterado para público ou tenha seus limites de tamanho/MIME violados.
- **Tabela `storage.objects`:** Colunas `id` (uuid PK), `bucket_id` (FK RESTRICT para buckets), `name` (text), `owner` (uuid), `metadata` (jsonb), `created_at`, `updated_at`.
  - Constraint única `storage_objects_bucket_name_unique`: `UNIQUE (bucket_id, name)`.

### 1.3 Funções no Schema `medicina`
- `medicina.current_perfil_id()`: STABLE, retorna UUID da sessão autenticada.
- `medicina.current_papel()`: STABLE, retorna `'estudante'` ou `'responsavel'`.
- `medicina.is_estudante()` / `medicina.is_responsavel()`: STABLE, boolean.
- `medicina.is_valid_acervo_storage_path(p_name text)`: **IMMUTABLE**, `SET search_path = pg_catalog, medicina, pg_temp`:
  - Valida tamanho entre 12 e 512 caracteres;
  - Exige prefixo e extensão rápidos: `p_name LIKE 'acervo/%.pdf'`;
  - Neutraliza Directory Traversal: `strpos(p_name, '..') = 0`, `strpos(p_name, '//') = 0` e `strpos(p_name, '\') = 0`;
  - Valida expressão regular estrita: `^acervo/[0-9a-f]{64}(_[A-Za-z0-9._-]+)?\.pdf$`.

### 1.4 Matriz de Privilégios (GRANT / REVOKE)
- **`PUBLIC`:** `REVOKE ALL` explícito em todas as rotinas e tabelas de storage.
- **`medicina_app`:** `GRANT USAGE` nos schemas `medicina` e `storage`; `GRANT SELECT` em `storage.buckets`; `GRANT SELECT, INSERT, DELETE` em `storage.objects` (**bloqueio estrito de `UPDATE`**; `upsert: false`).
- **`medicina_worker`:** `GRANT USAGE` nos schemas; `GRANT SELECT` em `storage.buckets` e `storage.objects` (leitura restrita para o worker de ingestão).
- **`medicina_anon`:** `REVOKE ALL` em schemas, tabelas e funções.

### 1.5 Políticas RLS Criadas (5 Políticas)
1. **`acervo_buckets_select_authenticated`** (`storage.buckets`, `SELECT`): Permite consulta de metadados do bucket `acervo` a perfis autenticados ou ao worker.
2. **`acervo_objects_responsavel_select`** (`storage.objects`, `SELECT`): Restringe a leitura de objetos ao responsável proprietário (`owner = perfil.id` ou cadastrado em `acervo_arquivos.enviado_por`).
3. **`acervo_objects_worker_select`** (`storage.objects`, `SELECT`): Concede leitura ao `medicina_worker` exclusivamente sobre objetos registrados em `acervo_arquivos`.
4. **`acervo_objects_responsavel_insert`** (`storage.objects`, `INSERT`): Permite upload unicamente a responsáveis autenticados, com caminho validado por `is_valid_acervo_storage_path`, MIME `application/pdf`, tamanho <= 20MB e owner compatível.
5. **`acervo_objects_responsavel_delete_unlinked`** (`storage.objects`, `DELETE`): Permite exclusão pelo proprietário apenas para arquivos que **NÃO** estejam vinculados a nenhum registro em `public.acervo_arquivos`.

---

## 2. COMPATIBILIDADE COM O SUPABASE GERENCIADO

1. **Tratamento Defensivo de Permissões em Catálogos Gerenciados:**
   - O schema `storage` no Supabase Cloud pertence ao superusuário interno `supabase_storage_admin`. A role administrativa de staging (`postgres.ynfocaorhadizlvbnzrt`) pode enfrentar restrições em DDLs diretos no catálogo `storage`.
   - O script `F1_10` encapsula a inserção defensiva do bucket, a constraint de integridade e o comando `ENABLE RLS` em blocos `BEGIN ... EXCEPTION WHEN insufficient_privilege THEN RAISE WARNING ... END;`, garantindo que a migração não falhe em ambientes com ownership restrito.
2. **Ausência Intencional de `FORCE ROW LEVEL SECURITY` em `storage.objects`:**
   - Ao contrário das tabelas do schema `public` (onde `FORCE RLS` é obrigatório), em `storage.objects` o script utiliza **apenas `ENABLE ROW LEVEL SECURITY`**.
   - **Justificativa Crítica:** O serviço de Storage da plataforma Supabase (`storage-api`) conecta-se via role interna com privilégio `BYPASSRLS` para emitir URLs assinadas e persistir objetos. A aplicação de `FORCE RLS` forçaria o PostgreSQL a avaliar o contexto de sessão (`medicina.is_responsavel()`) até mesmo para a infraestrutura do Supabase, quebrando o serviço gerenciado de Storage. A manutenção de `storage.objects` sem `FORCE RLS` é a arquitetura canônica e correta recomendada pelo Supabase.

---

## 3. BUCKET E CAMINHOS DE ARMAZENAMENTO

1. **Configuração do Bucket `acervo`:**
   - **Privacidade:** `public = false` (bloqueio total de links estáticos públicos `/object/public/acervo/...`).
   - **Teto Físico:** 20 MiB (`20971520` bytes).
   - **MIME Type:** Estritamente `application/pdf`.
2. **Compatibilidade dos Caminhos:**
   - O gerador determinístico da aplicação ([`buildDeterministicAcervoStoragePath`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/acervoReconciliacao.ts)) produz chaves no formato `acervo/${hashSha256}.pdf` (75 caracteres).
   - Esse formato casa 100% com a regex de validação `^acervo/[0-9a-f]{64}(_[A-Za-z0-9._-]+)?\.pdf$` da função `medicina.is_valid_acervo_storage_path`.
   - Tentativas de Directory Traversal (`acervo/../outra_pasta.pdf`, `acervo//dupla_barra.pdf`, `acervo\barra_invertida.pdf`) são categoricamente rejeitadas tanto no validador TypeScript quanto na checagem SQL.

---

## 4. FRONTEIRA DE CONFIANÇA E RISCO DO `service_role`

> **Diretriz de Segurança:** *"Não considere uma operação segura apenas por existir uma política RLS se ela utiliza credenciais capazes de contorná-la."*

### 4.1 O Bypass do Storage REST API pela `SUPABASE_SERVICE_ROLE_KEY`
- Quando a aplicação Next.js efetua upload (`uploadToSupabaseStorage`), download (`downloadFromSupabaseStorage`) ou geração de URL assinada (`obterUrlAssinadaSupabase`), o cliente Supabase no backend (`src/lib/supabaseStorage.ts`) envia a credencial `SUPABASE_SERVICE_ROLE_KEY`.
- No gateway da Storage API do Supabase, requisições autenticadas com essa chave executam sob a role `service_role` (`BYPASSRLS = true`), **ignorando completamente as políticas RLS de `storage.objects`**.
- Portanto, **a segurança contra vazamento ou adulteração de arquivos não decorre das políticas de `storage.objects` durante requisições de backend**.

### 4.2 A Verdadeira Fronteira de Confiança no Servidor Next.js
A segurança dos dados é garantida de forma imperativa e incontornável pela camada de autorização do servidor Next.js:
1. **Origem da Identidade e Papel:** O servidor consulta exclusivamente a sessão criptograficamente assinada do NextAuth (`getServerSession(authOptions)`). Parâmetros vindos do cliente são sumariamente ignorados.
2. **Guarda de Papel:** A Server Action `enviarArquivo` exige compulsoriamente `requireRole('responsavel')`. Perfis de estudante recebem `FORBIDDEN` imediato.
3. **Isolamento de Propriedade e Cross-Tenant:** Na ação `obterUrlLeituraArquivoAcervo`, o backend consulta o banco de dados filtrando estritamente por `WHERE id = :id AND enviado_por = perfil.id`. Se outro responsável tentar obter link para o arquivo, a consulta retorna `NOT_FOUND` e o Supabase Storage **jamais é invocado**.
4. **URLs Assinadas de Curta Duração:** O backend emite apenas URLs assinadas temporárias (60s a 900s, padrão 300s). URLs públicas permanentes são rejeitadas.
5. **Proteção Contra Sobrescrita (`upsert: false`):** Uploads utilizam `upsert: false`. Tentativas de colisão (409) disparam verificação de integridade de hash antes da adoção de metadados, sem jamais substituir bytes em disco.

### 4.3 O Papel das Políticas RLS de F1.10 (Defesa em Profundidade)
As políticas RLS de `storage.objects` constituem uma barreira secundária (*Defense-in-Depth*):
- Bloqueiam consultas SQL diretas via Drizzle sob a role `medicina_app` fora do contexto do usuário;
- Restringem o `medicina_worker` a ler apenas arquivos já indexados em `acervo_arquivos`;
- Bloqueiam chamadas diretas feitas ao endpoint REST do Supabase utilizando `anon_key`.

---

## 5. MATRIZ DE ACESSO DO STORAGE

| Operação | Estudante | Responsável (Proprietário) | Responsável (Terceiro / Cross-Tenant) | Medicina Worker | Anon / Público |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Upload de PDF** | ❌ **BLOQUEADO** (`FORBIDDEN`) | ✅ **PERMITIDO** (Via `enviarArquivo`, <= 20MB) | ✅ **ISOLADO** (Deduplica sem sobrescrever) | ❌ **PROIBIDO** (Read-only) | ❌ **BLOQUEADO** (Sem GRANT) |
| **Leitura Metadados Bucket** | ❌ **BLOQUEADO** | ✅ **PERMITIDO** (Bucket `acervo`) | ⚠️ **ISOLADO** (Apenas arquivos próprios) | ✅ **PERMITIDO** (GRANT SELECT) | ❌ **BLOQUEADO** (`REVOKE ALL`) |
| **Obtenção de Signed URL** | ❌ **BLOQUEADO** (`FORBIDDEN`) | ✅ **PERMITIDO** (URL temporária 60..900s) | ❌ **BLOQUEADO** (`NOT_FOUND` no servidor; Storage intocado) | ✅ **PERMITIDO** (Apenas p/ ingestão) | ❌ **BLOQUEADO** (URLs públicas proibidas) |
| **Exclusão Arquivo Vinculado** | ❌ **BLOQUEADO** | ❌ **PROIBIDO** (Policy exige `NOT EXISTS em acervo_arquivos`) | ❌ **BLOQUEADO** | ❌ **PROIBIDO** | ❌ **BLOQUEADO** |
| **Exclusão Arquivo Órfão** | ❌ **BLOQUEADO** | ⚠️ **PERMITIDO** (Manual, se desvinculado) | ❌ **BLOQUEADO** | ❌ **PROIBIDO** | ❌ **BLOQUEADO** |
| **Sobrescrita (`upsert: false`)** | ❌ **BLOQUEADO** | ❌ **IMPEDIDO** (Dispara 409; adota sem sobrescrever) | ❌ **IMPEDIDO** | ❌ **NÃO APLICÁVEL** | ❌ **BLOQUEADO** |
| **Path Traversal (`..`, `//`, `\`)** | ❌ **BLOQUEADO** | ❌ **REJEITADO** (Validador TS e regex SQL) | ❌ **REJEITADO** | ❌ **REJEITADO** | ❌ **REJEITADO** |

---

## 6. PRESERVAÇÃO DE COMPATIBILIDADE E PENDÊNCIAS CONHECIDAS

1. **Preservação das Migrações Anteriores (Etapas 1 a 6):**
   - As 6 migrações já consolidadas em Staging permanecem intocadas em seus arquivos físicos e hashes SHA-256.
2. **Pendência Conhecida da H1.06 (Privilégios `EXECUTE` em F1.04):**
   - A concessão implícita de `EXECUTE` para `PUBLIC` em `fn_acompanhamento_quinzenal` e `fn_simulados_evolucao` permanece documentada.
   - O arquivo canônico `F1_04_RLS_PROPOSTA.sql` **NÃO FOI MODIFICADO**, mantendo seu hash idêntico ao registrado em Staging (`8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f`).
   - A correção de higiene defensiva será efetuada em migração corretiva posterior.
3. **Rollback Simétrico (`F1_10_ROLLBACK_STORAGE_POLICIES.sql`):**
   - SHA-256: `1213bb2c8e1d9f88e63d691defc188f0f53c1f56228a5ff18be9deb4bc3133d5`.
   - Reverte políticas e permissões, mantendo `UPDATE storage.buckets SET public = false WHERE id = 'acervo'` para assegurar que os arquivos permaneçam privados mesmo em caso de falha.

---

## 7. EVIDÊNCIAS DOS TESTES AUTOMATIZADOS (PGlite Descartável)

Três suítes cobrindo a Etapa 7 foram executadas com **100% de sucesso (26/26 testes)**:

### 7.1 Suíte de Segurança e Fronteiras de Confiança (`h1_07_storage_security.test.ts`)
- **8/8 testes aprovados:**
  1. Rejeição compulsória de estudante tentando upload no acervo (`FORBIDDEN`);
  2. Rejeição compulsória de estudante tentando obter Signed URL (`FORBIDDEN`);
  3. Isolamento Cross-Tenant (Responsável B recebe `NOT_FOUND` ao solicitar arquivo de A; Storage não invocado);
  4. Rejeição de Path Traversal no validador TypeScript e na função SQL `is_valid_acervo_storage_path`;
  5. Validação de tempo de expiração da Signed URL (rejeita < 60s, > 900s e não-inteiros);
  6. Bloqueio sumário contra vazamento de `SUPABASE_SERVICE_ROLE_KEY` em `NEXT_PUBLIC_`;
  7. Proteção contra sobrescrita com `upsert: false` e validação estrita de integridade SHA-256;
  8. Comprovação do bypass da API com `service_role` e demonstração de que a fronteira real está no Next.js.

### 7.2 Suíte de Ciclo de Vida da Migração 7 (`h1_07_step7_migration_lifecycle.test.ts`)
- **11/11 testes aprovados:**
  1. Aplicação sequencial de 1 a 6, execução de 7, histórico com 7 registros e bloqueio estrito da Etapa 8 (`acervo_jobs`);
  2. Estrutura canônica de `storage.buckets` e `storage.objects`;
  3. Configuração do bucket `acervo` (privado, 20MB, application/pdf);
  4. Validação exaustiva da função `medicina.is_valid_acervo_storage_path`;
  5. Permissões concedidas a `medicina_app` e `medicina_worker`;
  6. Políticas RLS em `storage.buckets` (fail-closed sem contexto);
  7. Políticas RLS em `storage.objects` (leitura e isolamento cross-tenant);
  8. Políticas RLS em `storage.objects` (upload restrito a responsável);
  9. Políticas RLS em `storage.objects` (exclusão restrita a objetos desvinculados);
  10. Reversibilidade atômica via `F1_10_ROLLBACK_STORAGE_POLICIES.sql`;
  11. Idempotência completa na reexecução.

### 7.3 Suíte do Lançador da Etapa 7 (`h1_04_staging_step7_launcher.test.ts`)
- **7/7 testes aprovados:**
  1. Metadados e constantes operacionais fixas (`ynfocaorhadizlvbnzrt`, porta 5432, `--until-step=7`);
  2. Rejeição fail-closed de token de confirmação inválido;
  3. Rejeição na ausência do certificado CA TLS;
  4. Execução exclusiva da etapa 7 com etapas 1 a 6 puladas;
  5. Idempotência em reexecução;
  6. Rollback atômico em falha de DDL;
  7. Rollback atômico em falha de tracking.

**Validação de Regressão Global:** A execução conjunta de todos os lançadores e testes de segurança (Etapas 1 a 7) totalizou **60/60 testes aprovados (100% verde)**.  
**Qualidade de Código:** `npx tsc --noEmit` e `eslint` executados com **0 erros e 0 avisos**.

---

## 8. CONSULTAS SQL SOMENTE DE LEITURA PARA O SUPABASE SQL EDITOR

Execute as consultas abaixo no Supabase SQL Editor de Staging para conferência antes e após a Etapa 7:

```sql
-- 1. Diagnóstico do Histórico de Migrações em Staging (esperado: 7 registros ordenados)
SELECT ordem, rel_path, sha256, tamanho_bytes, executado_por, aplicado_em
FROM public._medicina_staging_migrations
ORDER BY ordem ASC;

-- 2. Configuração de Privacidade e Limites do Bucket 'acervo' (esperado: public = false, 20MB, application/pdf)
SELECT id, name, owner, public, file_size_limit, allowed_mime_types
FROM storage.buckets
WHERE id = 'acervo';

-- 3. Verificação de RLS em storage.buckets e storage.objects (esperado: rls_enabled = true; force_rls = false em objects)
SELECT n.nspname AS schemaname, c.relname AS tablename, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS force_rls
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'storage' AND c.relname IN ('buckets', 'objects');

-- 4. Inspeção das Políticas RLS no Schema storage (esperado: 5 políticas ativas)
SELECT schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage' AND tablename IN ('buckets', 'objects')
ORDER BY tablename, policyname;

-- 5. Verificação da Função medicina.is_valid_acervo_storage_path (esperado: IMMUTABLE, search_path fixado)
SELECT proname, prosecdef, provolatile, proconfig
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'medicina' AND proname = 'is_valid_acervo_storage_path';

-- 6. Auditoria de Privilégios das Roles sobre storage.buckets e storage.objects
SELECT table_name, grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'storage' AND table_name IN ('buckets', 'objects')
  AND grantee IN ('medicina_app', 'medicina_worker', 'medicina_anon', 'public')
ORDER BY table_name, grantee, privilege_type;

-- 7. Confirmação de Ausência da Etapa 8 (Fila de Ingestão F1.11 ainda não aplicada)
SELECT to_regclass('public.acervo_jobs') AS tabela_acervo_jobs_etapa8,
       to_regprocedure('medicina.enfileirar_job_acervo(uuid,text)') AS funcao_job_etapa8;
```

---

## 9. COMANDO OPERACIONAL PREPARADO

Para executar exclusivamente a migração da Etapa 7 no Supabase Staging:

```bash
node scripts/db/apply-staging-step7.mjs
```

**Instruções Operacionais:**
1. Digite a senha administrativa interativa quando solicitado pelo terminal TTY (entrada mascarada, sem echo).
2. Digite o token de confirmação obrigatório: `APLICAR ETAPA 7 EM STAGING`.
3. O lançador aplicará unicamente `F1_10_STORAGE_POLICIES_PROPOSTA.sql` e parará antes de `F1_11_FILA_INGESTAO_PROPOSTA.sql`.

---

## 10. CONCLUSÃO E CLASSIFICAÇÃO

### **CLASSIFICAÇÃO: APTO PARA EXECUTAR A SÉTIMA MIGRAÇÃO CONTROLADA**
*(Script: `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql`)*

> [!IMPORTANT]
> Em estrito cumprimento ao protocolo de segurança, nenhuma conexão remota ao Supabase Staging foi efetuada, nenhum `--apply` real foi executado e nenhuma alteração foi commitada ou enviada ao repositório remoto. O ambiente local está 100% validado e aguarda avaliação e autorização humana para o disparo operacional.
