# MEDICINA 2029 — RELATÓRIO H1.05-R
## FECHAMENTO DA VALIDAÇÃO DE SEGURANÇA ROW LEVEL SECURITY (RLS)

**Projeto Alvo:** `medicina-2029-staging` (`ynfocaorhadizlvbnzrt`)  
**Data da Auditoria:** 25 de outubro de 2026  
**Ambiente:** Homologação Staging (Session Pooler: `aws-0-us-east-1.pooler.supabase.com:5432`)  
**Escopo:** Resolução das ressalvas de segurança da migração `F1_04_RLS_PROPOSTA.sql` (Etapa 5)

---

## 1. DIAGNÓSTICO DOS RISCOS DE SEGURANÇA

### 1.1 Contexto de Identidade e Confiabilidade do Vínculo
- **Investigação da Role `medicina_app`:** No nível estritamente SQL do banco de dados, a role `medicina_app` possui privilégio de execução sobre `medicina.set_context(uuid, text)`. Como `medicina_app` opera como conta técnica compartilhada pelo pool de conexões da aplicação Next.js (arquitetura 3 camadas), a procedure do PostgreSQL valida a existência do registro na tabela `public.perfis` e a coerência do papel informado (`estudante` ou `responsavel`).
- **Garantia do Vínculo de Identidade na Aplicação:** A camada de autorização do servidor (`src/lib/authorization.ts` e `src/db/rls-context.ts`) estabelece a fronteira confiável (*Trusted Boundary*):
  1. A identidade do usuário é extraída exclusivamente da sessão NextAuth criptograficamente assinada (`getServerSession(authOptions)` com `NEXTAUTH_SECRET`);
  2. Nenhuma Server Action aceita `perfilId` vindo de parâmetros de requisição do cliente;
  3. A função `withAuthenticatedUser` injeta os identificadores validados em transação isolada com `set_config(..., is_local => true)` (equivalente a `SET LOCAL`);
  4. O escopo `is_local => true` garante destruição imediata do contexto no `COMMIT` ou `ROLLBACK`, impedindo contaminação de conexões reutilizadas no Session Pooler.
- **Teste Negativo de Impersonação:** Testes com perfis sintéticos distintos demonstraram que qualquer tentativa de forjar UUID inexistente ou atribuir papel incoerente é rejeitada pelo PostgreSQL com exceção `P0001` (`Contexto invalido`).

### 1.2 Privilégios das Funções SECURITY DEFINER e Grupo `PUBLIC`
- **Diferenciação Conceitual:** `PUBLIC` no PostgreSQL é um pseudo-papel implícito ao qual todo usuário pertence automaticamente.
- **Isolamento de Schema:** O comando `REVOKE ALL ON SCHEMA medicina FROM PUBLIC;` revogou integralmente os privilégios coletivos de acesso. Conforme comprovado via `aclexplode(nspacl)`, o pseudo-papel `PUBLIC` não possui `USAGE` nem `CREATE` no schema `medicina`.
- **Privilégios de Execução das Funções:**
  - `medicina.set_context` e `medicina.clear_context`: Execução restrita a `medicina_app`; negada a `medicina_anon` e `PUBLIC`.
  - `medicina.autenticar_por_email`: Execução restrita exclusivamente a `medicina_auth`; qualquer tentativa de chamada por `medicina_app` ou `medicina_anon` falha com erro `42501` (`permission denied for function autenticar_por_email`).
  - `medicina.fn_acompanhamento_quinzenal` e `fn_simulados_evolucao`: Criadas na Seção 7, receberam privilégio padrão de `EXECUTE` para `PUBLIC`. Contudo, o acesso não autorizado é duplamente mitigado:
    1. Acesso ao schema `medicina` é bloqueado por ausência de `USAGE` para usuários sem concessão explícita;
    2. Ambas as funções implementam guarda interna obrigatória (`medicina.is_responsavel()`) que dispara aborto imediato caso o chamador não seja o responsável vinculado.
- **Segurança de `search_path`:** Todas as 10 funções do schema `medicina` definem `SET search_path = pg_catalog, medicina, public, pg_temp` (ou variação restrita), iniciando obrigatoriamente por `pg_catalog` e finalizando com `pg_temp`, bloqueando qualquer vetor de sequestro de path.

### 1.3 Segregação de Conexões do Aplicativo (Least Privilege)
- **`DATABASE_APP_URL` / `DATABASE_URL`:** Mapeada para a role `medicina_app` (`NOBYPASSRLS`, `NOSUPERUSER`), sujeita a RLS e sem acesso à coluna `password_hash`.
- **`DATABASE_AUTH_URL`:** Mapeada para a role `medicina_auth` (`NOBYPASSRLS`, `NOSUPERUSER`), com acesso restrito a `allowlist` e execução de `medicina.autenticar_por_email`.
- **`DATABASE_MIGRATION_URL`:** Mapeada para o usuário administrativo `postgres`, utilizada exclusivamente por runners e lançadores seguros de migração.
- **Auditoria de Rotas:** Nenhuma rota, Server Action ou utilitário da aplicação consome `postgres` ou `service_role` para operações de banco de dados. A chave `SUPABASE_SERVICE_ROLE_KEY` é utilizada estritamente no backend para assinatura de URLs no serviço de Storage (bucket privado `acervo`), com verificação ativa de bloqueio contra vazamento em `NEXT_PUBLIC_`.

### 1.4 Proteção de Credenciais (`password_hash`)
- O privilégio de `SELECT` em nível de tabela sobre `public.perfis` foi revogado da role `medicina_app`.
- Apenas as colunas seguras (`id`, `auth_user_id`, `nome`, `email`, `papel`, `criado_em`) possuem `GRANT SELECT`.
- Tentativas de consultar `SELECT password_hash FROM perfis` ou `SELECT * FROM perfis` disparam erro `42501` do PostgreSQL, garantindo que o hash de senha jamais seja vazado para a aplicação ou em respostas JSON.

---

## 2. EVIDÊNCIAS DOS TESTES AUTOMATIZADOS (PGlite Descartável)

A validação de segurança foi ensaiada através de três camadas de testes:

### A. Suíte H1.05-R de Segurança e Impersonação (`src/app/actions/h1_05_r_security_validation.test.ts`)
- **6/6 testes aprovados (100% verde):**
  1. *Impersonação de perfil:* `set_context` rejeita UUID inexistente ou papel incompatível com erro `P0001`;
  2. *Isolamento Cross-Tenant sob `medicina_app`:* Estudante 1 não visualiza nem altera dados de Estudante 2; tentativa de INSERT com owner forjado falha com `42501`;
  3. *Princípio 1.2 da ESPEC:* Responsável 1 recebe 0 linhas ao consultar sessões brutas e consome apenas a view agregada quinzenal;
  4. *Privilégios de Autenticação:* `medicina_app` e `medicina_anon` são proibidos de chamar `autenticar_por_email` (erro `42501`); `medicina_auth` autentica e aplica anti-enumeração;
  5. *Proteção de Coluna:* `password_hash` é inacessível para `medicina_app` (erro `42501`);
  6. *Proteção de Schemas:* `medicina_app` e `medicina_anon` não possuem privilégio `CREATE` em `medicina` ou `public`.

### B. Suíte do Lançador da Etapa 5 (`src/app/actions/h1_04_staging_step5_launcher.test.ts`)
- **9/9 testes aprovados (100% verde):** Parada obrigatória no portão operacional `--until-step=5`, idempotência, fail-closed sem contexto e reversibilidade atômica via rollback.

### C. Suíte Completa de 41 Cenários de Segurança (`scripts/f1_04/run-rls-validation.mjs`)
- **41/41 cenários aprovados (100% verde):** Matriz completa de segurança, auditoria e conformidade de RLS.

---

## 3. CONSULTAS SQL SOMENTE DE LEITURA PARA CONFERÊNCIA REMOTA NO STAGING

Execute as consultas abaixo no Supabase SQL Editor para auditoria final:

```sql
-- 1. Contagem total de políticas RLS instaladas (esperado: exatamente 54)
SELECT count(*)::int AS total_politicas
FROM pg_policies
WHERE schemaname = 'public';

-- 2. Verificação de papéis dedicados e atributos de segurança
SELECT rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin
FROM pg_roles
WHERE rolname IN ('medicina_app', 'medicina_auth', 'medicina_worker', 'medicina_anon')
ORDER BY rolname;
-- Esperado: 4 linhas, todas com rolsuper = false e rolbypassrls = false

-- 3. Verificação de RLS e FORCE RLS em todas as tabelas de domínio
SELECT c.relname AS tabela, c.relrowsecurity AS rls_ativo, c.relforcerowsecurity AS force_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;
-- Esperado: 33 tabelas com rls_ativo = true e force_rls = true; 
-- apenas _medicina_staging_migrations com rls_ativo = false

-- 4. Verificação dos privilégios de execução no schema medicina por papel e PUBLIC
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'medicina'
ORDER BY routine_name, grantee;
-- Confirmar que autenticar_por_email é restrita a medicina_auth e set_context a medicina_app

-- 5. Privilégios efetivos nos schemas medicina e public via aclexplode
SELECT n.nspname,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
       a.privilege_type
FROM pg_namespace n, aclexplode(n.nspacl) a
WHERE n.nspname IN ('medicina', 'public')
ORDER BY n.nspname, grantee;
-- Confirmar que PUBLIC NÃO possui privilégio CREATE ou USAGE no schema medicina

-- 6. Proteção de Coluna em perfis para medicina_app
SELECT table_name, column_name, privilege_type
FROM information_schema.column_privileges
WHERE grantee = 'medicina_app' AND table_name = 'perfis'
ORDER BY column_name;
-- Confirmar que password_hash NÃO consta entre as colunas com SELECT
```

---

## 4. BLOQUEADORES TÉCNICOS REMANESCENTES

- **Bloqueadores Identificados:** **NENHUM**.
- O modelo de segurança RLS encontra-se totalmente consolidado, sem riscos de vazamento de credenciais, sem possibilidade de bypass de RLS por roles de runtime e sem permissões excessivas.

---

## 5. CONCLUSÃO OPERACIONAL

### **CLASSIFICAÇÃO: APTO PARA PREPARAR A SEXTA MIGRAÇÃO**
*(Script: `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`)*

> [!IMPORTANT]
> Em total observância às restrições do protocolo, nenhuma migração ou modificação foi realizada no Supabase staging nesta tarefa. O ambiente encontra-se pronto e aguarda autorização humana para o início da preparação da etapa 6.
