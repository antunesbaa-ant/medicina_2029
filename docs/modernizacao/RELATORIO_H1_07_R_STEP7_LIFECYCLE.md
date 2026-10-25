# MEDICINA 2029 — RELATÓRIO H1.07-R
## TESTES DE CICLO DE VIDA E VALIDAÇÃO DO LANÇADOR SEGURO DA ETAPA 7 (F1.10)

**Projeto Alvo:** `medicina-2029-staging` (`ynfocaorhadizlvbnzrt`)  
**Data:** 25 de outubro de 2026  
**Status:** 100% APROVADO E VALIDADO (17/17 TESTES VERDES)  
**Papel:** Engenheiro de Lançadores e Testes de Ciclo de Vida do Supabase Cloud (Etapa 7 / H1.07-R)  

---

## 1. RESUMO EXECUTIVO

Em conformidade com as diretrizes da Etapa 7 (H1.07-R), o lançador seguro [`scripts/db/apply-staging-step7.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/apply-staging-step7.mjs), o probe de detecção fail-closed em [`scripts/db/migrate-staging.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/migrate-staging.mjs), e a nova suíte de ciclo de vida em PostgreSQL descartável (PGlite) [`src/app/actions/h1_07_r_step7_lifecycle.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h1_07_r_step7_lifecycle.test.ts) foram integralmente validados e sincronizados com a migração F1.10 reformulada ([`docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql)).

Todas as 17 asserções automatizadas foram executadas com sucesso via Vitest:
`npx vitest run src/app/actions/h1_04_staging_step7_launcher.test.ts src/app/actions/h1_07_r_step7_lifecycle.test.ts`
Resultado: **2 test files passed (2/2), 17 tests passed (17/17), 0 falhas**.

---

## 2. PARÂMETROS OPERACIONAIS E SALVAGUARDAS DO LANÇADOR DA ETAPA 7

O script [`scripts/db/apply-staging-step7.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/apply-staging-step7.mjs) opera como o canal oficial e seguro para execução in-process da Etapa 7 em Staging:

| Parâmetro / Salvaguarda | Configuração Efetiva | Finalidade de Segurança |
| :--- | :--- | :--- |
| **Projeto Alvo Fixo** | `ynfocaorhadizlvbnzrt` | Impede execução acidental em projetos remotos divergentes ou produção |
| **Session Pooler Fixo** | `aws-0-us-east-1.pooler.supabase.com:5432` | Garante uso do pooler seguro no cluster Supabase AWS East 1 |
| **Usuário Administrativo** | `postgres.ynfocaorhadizlvbnzrt` | Autenticação autorizada sob role de provisionamento de Staging |
| **Banco de Dados** | `postgres` | Banco canônico da infraestrutura Supabase |
| **Certificado TLS CA** | `~/Downloads/prod-ca-2021.crt` | TLS estrito (`rejectUnauthorized: true`) validando cadeia oficial |
| **Confirmação Humana** | `APLICAR ETAPA 7 EM STAGING` | Exige digitação manual exata no terminal antes de qualquer escrita |
| **Portão Operacional** | `--until-step=7` | Bloqueia categoricamente a execução das etapas 8 (`F1.11`) e 9 (`F1.12`) |
| **Comando Equivalente** | `CONFIRM_STAGING_MIGRATIONS=true node scripts/db/migrate-staging.mjs --apply --until-step=7` | Padronização com o runner canônico |
| **Probe 7 (Detecção)** | `to_regprocedure('medicina.is_valid_acervo_storage_path(text)') OR pg_constraint ('acervo_arquivos_file_path_format_check')` | Detecta estado intermediário fail-closed caso objetos existam sem gravação no ledger |

---

## 3. COMPATIBILIDADE NATIVA COM SUPABASE CLOUD (H1.07-R)

1. **Catálogo Gerenciado do Supabase Storage:**
   - No Supabase Cloud, o schema `storage` pertence à role interna `supabase_storage_admin`. A role administrativa de conexão `postgres.ynfocaorhadizlvbnzrt` não é owner desse schema.
   - A migração `F1_10_STORAGE_POLICIES_PROPOSTA.sql` eliminou qualquer comando DDL ou DML sobre o schema gerenciado `storage` (`CREATE SCHEMA storage`, `CREATE TABLE storage.buckets/objects`, `INSERT INTO storage.buckets`, `ENABLE RLS` em storage).
2. **Preflight Fail-Closed:**
   - A migração verifica no catálogo `storage.buckets` se o bucket `acervo` já existe previamente e se está configurado como estritamente privado (`public = false`).
   - Caso o bucket `acervo` esteja ausente ou configurado como público (`public = true`), a migração **aborta imediatamente com erro `P0001` (`RAISE EXCEPTION`)**, sem mascaramento por warnings.
3. **Integridade de Domínio no Schema `public`:**
   - A validação de caminhos é garantida matematicamente através da função `medicina.is_valid_acervo_storage_path(text)` (IMMUTABLE, search_path seguro) e aplicada diretamente como constraint física `acervo_arquivos_file_path_format_check` em `public.acervo_arquivos` (`NOT VALID` seguido de `VALIDATE CONSTRAINT`).

---

## 4. RESULTADOS DA SUÍTE DE TESTES AUTOMATIZADOS

### 4.1 Lançador Seguro da Etapa 7 ([`h1_04_staging_step7_launcher.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h1_04_staging_step7_launcher.test.ts))

| # | Teste | Status | Duração |
| :--- | :--- | :--- | :--- |
| 1 | Valida metadados e parâmetros operacionais fixos do lançador | **PASSED** | 1ms |
| 2 | Rejeita execução se confirmação humana explícita não for exatamente "APLICAR ETAPA 7 EM STAGING" | **PASSED** | 1ms |
| 3 | Rejeita se o arquivo de certificado CA TLS não for localizado | **PASSED** | 0ms |
| 4 | Executa exclusivamente a migração 7 (F1.10) com etapas 1 a 6 previamente aplicadas | **PASSED** | 795ms |
| 5 | Demonstra idempotência completa em re-execução (todas as 7 etapas puladas com segurança) | **PASSED** | 557ms |
| 6 | Falha durante DDL de 0007 reverte transação atomicamente via ROLLBACK | **PASSED** | 564ms |
| 7 | Falha durante tracking de 0007 reverte transação atomicamente desfazendo os objetos de F1.10 | **PASSED** | 561ms |
| 8 | Preflight Fail-Closed: Rejeita aplicação se o bucket "acervo" for ausente ou público | **PASSED** | 1149ms |
| 9 | Probe 7: Detecta estado intermediário e aborta fail-closed se objetos existirem sem tracking | **PASSED** | 558ms |

### 4.2 Ciclo de Vida H1.07-R em PGlite ([`h1_07_r_step7_lifecycle.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h1_07_r_step7_lifecycle.test.ts))

| # | Teste | Status | Duração |
| :--- | :--- | :--- | :--- |
| 1 | Aplica sequencialmente as etapas 1 a 6 e executa F1.10 com sucesso mantendo isolamento da etapa 8 | **PASSED** | 1421ms |
| 2 | Preflight Fail-Closed: Aborta com código P0001 se o bucket "acervo" for ausente ou público | **PASSED** | 2244ms |
| 3 | Preflight Fail-Closed: Aborta com erro P0001 se existirem dados anômalos em acervo_arquivos | **PASSED** | 590ms |
| 4 | Validação da Constraint de Integridade `acervo_arquivos_file_path_format_check` | **PASSED** | 620ms |
| 5 | Validação da Função Canônica `medicina.is_valid_acervo_storage_path` (Propriedades e Privilégios) | **PASSED** | 587ms |
| 6 | Rollback Atômico e Simétrico (`F1_10_ROLLBACK_STORAGE_POLICIES.sql`) | **PASSED** | 607ms |
| 7 | Re-execução Idempotente e Reversibilidade da Migração F1.10 | **PASSED** | 607ms |
| 8 | Probe 7: Detecta estado intermediário fail-closed (constraint presente sem histórico) | **PASSED** | 577ms |

---

## 5. DETALHES DE SEGURANÇA E INTEGRIDADE

### 5.1 Testes da Constraint `acervo_arquivos_file_path_format_check`
No teste de inserção em `public.acervo_arquivos`:
- `acervo/../arquivo.pdf`: **Rejeitado** com violação de CHECK constraint (`acervo_arquivos_file_path_format_check`);
- `acervo/invalido.doc`: **Rejeitado** com violação de CHECK constraint;
- `acervo\contra_barra.pdf`: **Rejeitado** com violação de CHECK constraint;
- `acervo//dupla_barra.pdf`: **Rejeitado** com violação de CHECK constraint;
- `acervo/<sha256>.pdf`: **Aceito** com persistência canônica;
- `acervo/<sha256>_versao-1.0.pdf`: **Aceito** para desambiguação controlada.

### 5.2 Rollback Atômico e Idempotência
- O script [`docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql) remove limpa e simetricamente a constraint de formato e a função `medicina.is_valid_acervo_storage_path(text)`.
- A tabela `public.acervo_arquivos` permanece íntegra.
- Execuções repetidas do script de rollback são 100% idempotentes e seguras.
- A migração F1.10 pode ser reaplicada com sucesso pós-rollback.

---

## 6. CONCLUSÃO

A migração F1.10 corrigida está pronta e homologada em ambiente isolado PGlite para aplicação no Supabase Cloud Staging através do lançador seguro:
`node scripts/db/apply-staging-step7.mjs`
com portão operacional `--until-step=7`, TLS estrito, confirmação humana compulsória e total conformidade com o catálogo nativo do Supabase.
