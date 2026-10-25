# MEDICINA 2029 — RELATÓRIO TÉCNICO H1.07-R
## REDESENHO DO SQL DE STORAGE E COMPATIBILIDADE NATIVA COM SUPABASE CLOUD
### Reformulação Estrita das Propostas F1.10 (Aplicação e Rollback)

**Data de Emissão:** 25 de Outubro de 2026  
**Arquiteto Especialista:** Redesenho de Storage & Supabase Cloud (H1.07-R)  
**Projeto Alvo:** `medicina-2029-staging` (`ynfocaorhadizlvbnzrt`)  
**Arquivos de Migração Objeto:**
- Proposta de Aplicação: [`docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql)
- Proposta de Rollback: [`docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql)

---

## 1. SUMÁRIO EXECUTIVO E METADADOS DOS ARQUIVOS

Em cumprimento rigoroso à diretiva arquitetural H1.07-R, as propostas SQL da Etapa 7 (`F1.10`) foram inteiramente reformuladas para respeitar a infraestrutura nativa e segregada do Supabase Cloud.

Todas as operações indevidas que tentavam modificar, criar, alterar constraints ou gerenciar RLS diretamente sobre o schema gerenciado `storage` (`storage.buckets` e `storage.objects`) foram sumariamente eliminadas. O mascaramento de exceções com `RAISE WARNING` foi banido, restaurando integralmente o princípio **Fail-Closed**. A integridade matemática e segurança contra path traversal e arquivos inválidos foram transpostas diretamente para o schema de domínio (`public.acervo_arquivos`) e schema da aplicação (`medicina`).

### Metadados Criptográficos e Físicos Consolidados

| Arquivo | Tamanho Exato | Hash SHA-256 |
| :--- | :---: | :--- |
| `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql` | **5.759 bytes** | `41dde50128b89ce9407dd03c97f53540451c5d6ae27d19edd3a5f789240d5fc0` |
| `docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql` | **1.057 bytes** | `1a7e9c2c93184182033fb4e58cbed885ec39a25a2b909684728d9566c8774952` |

---

## 2. DIAGNÓSTICO DAS CAUSAS RAIZ NO SUPABASE CLOUD STAGING

A inspeção direta no SQL Editor do Supabase Cloud em Staging (`ynfocaorhadizlvbnzrt`) revelou incompatibilidades estruturais intransponíveis na versão legada da F1.10:

1. **Ownership Exclusivo do Superuser Interno (`supabase_storage_admin`):**
   - No Supabase Cloud gerenciado, o schema `storage` e as tabelas `storage.buckets` e `storage.objects` pertencem ao papel interno de sistema `supabase_storage_admin`.
   - A role administrativa da sessão (`postgres.ynfocaorhadizlvbnzrt`) **não é proprietária** de nenhuma tabela no schema `storage`.
   - Qualquer instrução de `ALTER TABLE storage.buckets ADD CONSTRAINT` ou `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` falha com erro de permissão fatal (`must be owner of table buckets/objects`).

2. **Inoperância das Policies RLS no Gateway HTTP do Supabase Storage:**
   - O MEDICINA 2029 utiliza **NextAuth** no frontend (App Router) e se comunica com o Supabase Storage via backend utilizando a `SUPABASE_SERVICE_ROLE_KEY`.
   - Não há usuários conectando-se diretamente ao Storage REST API via Supabase Auth JWT (`sb-...-auth-token`).
   - Requisições feitas via `service_role` efetuam **bypass total nas policies de RLS** de `storage.objects`.
   - Em uploads via `service_role`, o campo `storage.objects.owner_id` permanece `NULL` ou assume o ID interno da service role, tornando comparações como `owner = medicina.current_perfil_id()` ou `medicina.is_responsavel()` completamente inoperantes e falaciosas no catálogo do Storage.

3. **Violação do Princípio Fail-Closed por Mascaramento (`RAISE WARNING`):**
   - Tentativas anteriores de encapsular comandos em `BEGIN ... EXCEPTION WHEN insufficient_privilege THEN RAISE WARNING ... END;` mascaravam a ausência de privilégios.
   - Isso violava o princípio Fail-Closed: a migração era registrada na tabela de auditoria `_medicina_staging_migrations` como `APPLIED`, embora salvaguardas essenciais de integridade tivessem sido ignoradas.

4. **Desnecessidade de Concessões SQL em `storage.*` para Roles da Aplicação:**
   - As roles de aplicação (`medicina_app`, `medicina_worker`, `medicina_anon`) nunca consultam o schema `storage` via SQL no PostgreSQL.
   - As interações com arquivos são feitas exclusivamente pelo backend via SDK REST do Supabase Storage.
   - Conceder `GRANT SELECT, INSERT, DELETE ON storage.objects` para `medicina_app` era desnecessário e poluidor de privilégios.

---

## 3. SOLUÇÃO ARQUITETURAL IMPLEMENTADA (H1.07-R)

A reformulação redefiniu a arquitetura de armazenamento do MEDICINA 2029 alinhando-se à realidade do Supabase Cloud:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                CLIENTE / BROWSER                                      │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ NextAuth Session JWT (Cookies HTTPOnly)
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        BACKEND NEXT.JS (App Router / Server Actions)                   │
│                                                                                        │
│  - requireAuthenticatedProfile() -> valida sessão NextAuth                             │
│  - requireRole('responsavel') -> bloqueia estudante / anônimo                          │
│  - Cross-Tenant: WHERE id = :id AND enviado_por = perfil.id                            │
│  - Chave Determinística: acervo/<sha256>.pdf                                           │
│  - URLs assinadas de curta duração (60s..900s, default 300s)                           │
│  - upsert: false por padrão (sem sobrescrita silenciosa)                               │
└───────────────────────┬────────────────────────────────────────┬───────────────────────┘
                        │ Conexão SQL Pooler                     │ Chamadas REST via SDK
                        │ (postgres / medicina_app)              │ (SUPABASE_SERVICE_ROLE_KEY)
                        ▼                                        ▼
┌──────────────────────────────────────────────┐ ┌───────────────────────────────────────┐
│           POSTGRESQL (SCHEMA DOMÍNIO)        │ │         SUPABASE STORAGE CLOUD        │
│                                              │ │                                       │
│ 1. Preflight Fail-Closed estrito:            │ │ - Bucket acervo: pré-provisionado     │
│    - storage.buckets existe                  │ │ - public = false                      │
│    - acervo existe e public = false          │ │ - file_size_limit = 20 MiB            │
│ 2. Função Canônica:                          │ │ - allowed_mime_types = [pdf]          │
│    medicina.is_valid_acervo_storage_path()   │ │                                       │
│ 3. Trava Relacional no Domínio:              │ │ - Gerenciado nativamente por          │
│    public.acervo_arquivos ADD CONSTRAINT     │ │   supabase_storage_admin              │
│    acervo_arquivos_file_path_format_check    │ │ - Intocado por DDLs de migração       │
│    CHECK (is_valid_acervo_storage_path)      │ │                                       │
└──────────────────────────────────────────────┘ └───────────────────────────────────────┘
```

---

## 4. MATRIZ DETALHADA DE ITENS REMOVIDOS E MANTIDOS/APERFEIÇOADOS

### 4.1 Itens Removidos

| Componente Removido | Motivo Arquitetural / Fundamentação |
| :--- | :--- |
| `CREATE SCHEMA IF NOT EXISTS storage;` | O schema `storage` é nativo e gerenciado pelo Supabase Cloud. |
| `CREATE TABLE IF NOT EXISTS storage.buckets;` | Tabela nativa gerenciada de propriedade de `supabase_storage_admin`. |
| `CREATE TABLE IF NOT EXISTS storage.objects;` | Tabela nativa gerenciada de propriedade de `supabase_storage_admin`. |
| `INSERT INTO storage.buckets ... ON CONFLICT DO UPDATE ...` | Bucket `acervo` já provisionado e gerido via Dashboard/Storage API. |
| `ALTER TABLE storage.buckets ADD CONSTRAINT storage_buckets_acervo_private_check ...` | Role administrativa `postgres` não é owner de `storage.buckets` (`must be owner`). |
| `ALTER TABLE storage.buckets/objects ENABLE ROW LEVEL SECURITY;` | Violação de ownership; RLS em `storage` já é nativo da plataforma Supabase. |
| `GRANT/REVOKE` em `storage.buckets` e `storage.objects` | `medicina_app` e `medicina_worker` não acessam o schema `storage` via SQL. |
| Tratamento de exceção com `RAISE WARNING` | Mascaramento de erros proibido; princípio Fail-Closed restabelecido com `RAISE EXCEPTION`. |
| Policies RLS em `storage.objects` (`responsavel_select`, `worker_select`, etc.) | Inoperantes no gateway HTTP para requisições backend com `service_role` (bypass nativo). |
| Redefinição de funções `medicina.current_perfil_id`, `current_papel`, etc. | Desnecessárias na Etapa 7 (já consolidadas e ativas na Etapa 5 — `F1_04_RLS_PROPOSTA.sql`). |

### 4.2 Itens Mantidos e Aperfeiçoados

| Componente | Schema / Tabela | Detalhamento da Implementação |
| :--- | :--- | :--- |
| **Preflight Diagnóstico Fail-Closed** | `DO $$` transacional | 1. Valida existência de `public.perfis`, `public.acervo_arquivos` e `public.responsavel_estudante` (senão erro `P0001`).<br>2. Valida integridade em `public.acervo_arquivos` (MIME `application/pdf`, tamanho 1..20971520, sem `..` ou `\`).<br>3. Inspeciona o catálogo `storage.buckets` de forma dinâmica (`EXECUTE`): aborta com `RAISE EXCEPTION 'Bucket acervo inexistente ou não configurado como privado' USING ERRCODE = 'P0001'` caso o catálogo não exista, o bucket `acervo` inexista ou possua `public = true`. |
| **Função Canônica de Validação de Caminho** | `medicina.is_valid_acervo_storage_path(p_name text)` | Função `IMMUTABLE` com `search_path` restrito a `pg_catalog, medicina, pg_temp`. Impõe comprimento 12..512, prefixo `acervo/`, extensão `.pdf`, bloqueio de `..`, `//`, `\` e regex `^acervo/[0-9a-f]{64}(_[A-Za-z0-9._-]+)?\.pdf$`. |
| **Privilégios Estritos de Execução** | Schema `medicina` | `REVOKE ALL ON FUNCTION ... FROM PUBLIC;`. Concessão controlada de `EXECUTE` para `medicina_app` e `medicina_worker`, e `REVOKE ALL` explícito de `medicina_anon`. |
| **Constraint de Integridade de Domínio** | `public.acervo_arquivos` | `acervo_arquivos_file_path_format_check`: Adicionada como `CHECK (medicina.is_valid_acervo_storage_path(file_path)) NOT VALID;` seguida imediatamente de `VALIDATE CONSTRAINT acervo_arquivos_file_path_format_check;`. Garante que nenhum registro inválido seja inserido na tabela do acervo. |
| **Rollback Atômico e Simétrico** | `F1_10_ROLLBACK_STORAGE_POLICIES.sql` | Remove a constraint `acervo_arquivos_file_path_format_check` de `public.acervo_arquivos` e remove a função `medicina.is_valid_acervo_storage_path(text)`. Execução 100% limpa no domínio sem tocar em tabelas do Supabase. |

---

## 5. COMPROVAÇÃO EMPÍRICA AUTOMATIZADA

As alterações foram exaustivamente validadas em ambiente PostgreSQL descartável (PGlite com extensão `vector`) através de 3 suítes dedicadas:

1. **`src/app/actions/h1_07_r_step7_lifecycle.test.ts` (8/8 testes aprovados — 100% verde):**
   - Aplicação sequencial de 1 a 6 e execução da F1.10 com isolamento estrito da Etapa 8.
   - Preflight Fail-Closed rejeitando bucket ausente ou bucket público com erro `P0001`.
   - Preflight Fail-Closed rejeitando dados anômalos em `acervo_arquivos`.
   - Validação da constraint `acervo_arquivos_file_path_format_check` (aceita válidos, rejeita path traversal e extensões incorretas).
   - Validação de imutabilidade e privilégios da função `medicina.is_valid_acervo_storage_path`.
   - Reversibilidade atômica e simétrica via `F1_10_ROLLBACK_STORAGE_POLICIES.sql`.
   - Re-execução com idempotência completa.
   - Detecção de estado intermediário no Probe 7 (`migrate-staging.mjs`).

2. **`src/app/actions/h1_07_r_backend_security.test.ts` (8/8 testes aprovados — 100% verde):**
   - Bloqueio imediato de estudantes tentando upload (`FORBIDDEN`).
   - Isolamento cross-tenant entre responsáveis (`NOT_FOUND`).
   - Rejeição de Path Traversal no validador TypeScript e na função SQL.
   - Neutralização de spoofing de perfil (NextAuth assinado no servidor).
   - Proteção contra sobrescrita com `upsert: false` e reconciliação determinística SHA-256.
   - Validação de expiração temporal de links assinados (60s a 900s).
   - Salvaguarda contra vazamento de `SUPABASE_SERVICE_ROLE_KEY` em `NEXT_PUBLIC_`.
   - Isolamento de uploads com `owner_id` nulo garantido pelo domínio `public.acervo_arquivos`.

3. **`src/app/actions/h1_04_staging_step7_launcher.test.ts` (9/9 testes aprovados — 100% verde):**
   - Parâmetros fixos do pooler (`ynfocaorhadizlvbnzrt`, porta 5432, `--until-step=7`).
   - Confirmação humana explícita obrigatória (`APLICAR ETAPA 7 EM STAGING`).
   - Validação de cadeia TLS com certificado CA.
   - Idempotência e rollback transacional comprovados.

---

## 6. CONCLUSÃO E PARECER TÉCNICO FINAL

A migração `F1_10_STORAGE_POLICIES_PROPOSTA.sql` e seu rollback `F1_10_ROLLBACK_STORAGE_POLICIES.sql` estão plenamente homologados, em perfeita consonância com a arquitetura nativa do Supabase Cloud.

- **Conformidade de Catálogo:** Zero operações DDL/DML sobre o schema `storage`.
- **Integridade Relacional:** Garantida matematicamente em `public.acervo_arquivos`.
- **Princípio Fail-Closed:** 100% restaurado sem supressão de exceções.
- **Prontidão Operacional:** Aprovado para execução controlada em Staging via [`scripts/db/apply-staging-step7.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/apply-staging-step7.mjs).
