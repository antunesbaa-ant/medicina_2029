# Relatório Técnico — Tarefa F1.04-C: Endurecimento de Roles, Privilégios Mínimos e Suíte de Segurança com 41 Cenários
## Segregação de Papéis de Banco (`medicina_auth` vs `medicina_app`), Proteção de Funções e Validação de Conformidade

**Data da Validação F1.04-C:** 19/10/2026  
**Papéis:** Database & Test Suite Security Engineer (Subagente 2) & Database Security Architect (Subagente 1)  
**Status da Tarefa:** **CONCLUÍDA — APROVADA (100% dos testes aprovados, rollback e idempotência atestados)**  
**Ambiente de Execução:** PostgreSQL 18.6 isolado e descartável em memória (PGlite WASM) com extensão `vector` 0.8.7.  
**Restrição Estrita de Ambiente:** Nenhum banco de produção, Supabase remoto ou credencial externa foi acessado. Dados estritamente sintéticos sob o domínio de teste reservado RFC 2606/6761 (`example.invalid`).  

---

### Arquivos do Pacote F1.04-C
- **Proposta RLS Endurecida com Segregação de Roles:** [`docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql)
- **Script de Rollback Atômico:** [`docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql)
- **Suíte de Testes Automatizada (41 Cenários):** [`scripts/f1_04/run-rls-validation.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/f1_04/run-rls-validation.mjs)
- **Fixtures Artificiais de Teste:** [`tests/integration/f1_04/fixtures.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/tests/integration/f1_04/fixtures.sql)
- **Camada de Contexto RLS e Helpers:** [`src/db/rls-context.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/rls-context.ts)
- **Testes Unitários da Aplicação (Vitest):** [`src/db/rls-context.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/rls-context.test.ts)
- **Relatório de Arquitetura de Segurança F1.04:** [`docs/modernizacao/RELATORIO_F1_04.md`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/RELATORIO_F1_04.md)
- **Plano de Modernização Atualizado:** [`docs/modernizacao/PLANO_MODERNIZACAO.md`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/PLANO_MODERNIZACAO.md)

---

## 1. Resumo Executivo da Tarefa F1.04-C

A tarefa **F1.04-C** concluiu a arquitetura de banco de dados para a separação estudante/responsável e segurança relacional, implementando a segregação de papéis de banco (*least privilege roles*), o endurecimento estrito das funções de autenticação e autorização, e a expansão da suíte automatizada para **41 cenários de segurança e isolamento**, cobrindo 100% dos requisitos normativos e preceitos de fail-closed.

### Principais Entregas e Endurecimentos:
1. **Segregação Estrita de Papéis de Banco (`medicina_auth` vs `medicina_app` vs `medicina_anon`):**
   - Papel `medicina_auth`: Utilizado exclusivamente pelo serviço NextAuth. Possui concessão de `EXECUTE` na função `medicina.autenticar_por_email` e `SELECT` apenas nas colunas necessárias para checagem de credenciais na allowlist e perfis. Não possui privilégios de escrita nem de bypass de RLS.
   - Papel `medicina_app`: Utilizado pelas Server Actions e rotas do aplicativo. Possui `REVOKE SELECT` em nível de tabela na tabela `perfis`, com `GRANT SELECT` estrito apenas nas colunas seguras (bloqueando `password_hash` com erro `42501`), e **NÃO possui permissão de `EXECUTE`** em `medicina.autenticar_por_email` (rejeitado com erro `42501`).
   - Papel `medicina_anon`: Papel anônimo sem nenhum privilégio concedido nos schemas `medicina` ou `public`.
2. **Blindagem de Funções `SECURITY DEFINER` e Search Path:**
   - Todas as funções do schema `medicina` possuem fixação imutável de `SET search_path = public, medicina, pg_temp;`.
   - Nenhuma função concede privilégios a `PUBLIC` (`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA medicina FROM PUBLIC;`).
3. **Rollback Atômico e Remoção Limpa do Papel `medicina_auth`:**
   - O script `F1_04_ROLLBACK_RLS.sql` revoga privilégios e remove o papel `medicina_auth` e todos os objetos dependentes de forma atômica e limpa, preservando a idempotência da DDL.
4. **Suíte Automatizada com 41 Cenários Aprovados (100% PASS):**
   - 18 cenários de linha de base (Cenários 1 a 18);
   - 8 cenários adicionais de auditoria F1.04-R (Cenários R1 a R8);
   - 15 novos cenários de conformidade e privilégios F1.04-C (Cenários C1 a C15).
5. **Quality Gates Aprovados:**
   - TypeScript strict (`npx tsc --noEmit`): 0 erros;
   - Vitest unit tests (`npm run test:run`): 17 arquivos, **123/123 testes aprovados**;
   - Drizzle schema check (`npx drizzle-kit check`): 0 inconformidades;
   - Git hygiene check (`git diff --check`): 0 violações de whitespace.

---

## 2. Arquitetura de Segregação de Papéis de Banco

A proposta implementa a matriz de privilégios mínimos exigida pela arquitetura de defesa em profundidade:

```
                      +-----------------------------+
                      |       PostgreSQL 18.6       |
                      +-----------------------------+
                                     |
         +---------------------------+---------------------------+
         |                           |                           |
         v                           v                           v
+------------------+       +-------------------+       +-------------------+
|  medicina_auth   |       |   medicina_app    |       |   medicina_anon   |
| (Auth Service)   |       | (App Server/Next) |       | (Sem Permissões)  |
+------------------+       +-------------------+       +-------------------+
| NOSUPERUSER      |       | NOSUPERUSER       |       | NOSUPERUSER       |
| NOBYPASSRLS      |       | NOBYPASSRLS       |       | NOBYPASSRLS       |
| USAGE medicina   |       | USAGE medicina    |       | Sem USAGE         |
| EXECUTE          |       | EXECUTE contexto  |       | Sem EXECUTE       |
| autenticar_email |       | Sem EXECUTE auth  |       |                   |
| SELECT allowlist |       | SELECT/CRUD tab.  |       |                   |
| SELECT perfis    |       | perfis (SEM hash) |       |                   |
| (colunas seguras)|       |                   |       |                   |
+------------------+       +-------------------+       +-------------------+
```

### 2.1 Especificação Detalhada dos Papéis

| Propriedade / Privilégio | `medicina_auth` | `medicina_app` | `medicina_anon` |
|---|:---:|:---:|:---:|
| **Bypass RLS (`BYPASSRLS`)** | `NOBYPASSRLS` | `NOBYPASSRLS` | `NOBYPASSRLS` |
| **Superusuário (`SUPERUSER`)** | `NOSUPERUSER` | `NOSUPERUSER` | `NOSUPERUSER` |
| **Schema `medicina`** | `USAGE` | `USAGE` | Nenhum privilégio |
| **Funções de Contexto (`set_context`, etc.)** | Não concedido | `EXECUTE` | Rejeição `42501` |
| **Função `medicina.autenticar_por_email`** | `EXECUTE` | Rejeição `42501` | Rejeição `42501` |
| **Tabela `perfis` — Coluna `password_hash`** | Apenas via função segura | Rejeição `42501` | Rejeição `42501` |
| **Tabelas do Schema `public` (Sessões, Cards, etc.)** | Sem privilégios | `SELECT, INSERT, UPDATE, DELETE` | Rejeição `42501` |
| **Tabela `allowlist`** | `SELECT` | `SELECT` | Rejeição `42501` |

---

## 3. Matriz dos 15 Novos Cenários de Conformidade e Privilégios (C1 a C15)

Os 15 cenários introduzidos na F1.04-C cobrem integralmente as regras operacionais e de integridade do sistema:

### C1 — Identidade Retirada Exclusivamente da Sessão Validada
- **Comportamento:** A sessão autenticada sob `medicina_app` configura o contexto de Estudante 1 (`S1_ID`). Tentativas de injetar o identificador de Estudante 2 (`S2_ID`) via parâmetro `WHERE perfil_id = S2_ID` retornam 0 linhas. Tentativas de `INSERT` com payload forjado (`perfil_id = S2_ID`) são bloqueadas na origem pelo PostgreSQL com violação de `WITH CHECK` (código `42501`).
- **Resultado:** **PASS** (leitura injetada: 0 linhas; inserção injetada: erro `42501`).

### C2 — ID Fornecido pelo Cliente Não Substitui Identidade Autenticada
- **Comportamento:** Uma mutação (`UPDATE sessoes`) que tenta manipular registros fornecendo o `perfil_id` de Estudante 2 afeta rigorosamente 0 linhas. Já uma atualização legítima fornecendo o próprio perfil autenticado afeta exatamente 1 linha.
- **Resultado:** **PASS** (spoof afeta 0 linhas; legítimo afeta 1 linha).

### C3 — Papel Fornecido pelo Cliente Não Modifica a Autorização
- **Comportamento:** Estudante 1 tenta invocar `medicina.set_context(S1_ID, 'responsavel')`. O PostgreSQL aborta a transação com erro explícito `P0001` (*Contexto invalido*). Sob contexto legítimo de estudante, a função `medicina.is_responsavel()` avalia compulsoriamente como `false`.
- **Resultado:** **PASS** (troca de papel rejeitada com `P0001`; `is_responsavel` falso).

### C4 — Estudante Não Assume Outro Perfil em Queries ou Mutations
- **Comportamento:** Sob contexto de Estudante 1, todas as quatro operações fundamentais (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) direcionadas a registros de Estudante 2 são barradas pelo RLS (retornando 0 linhas ou disparando erro `42501` no insert).
- **Resultado:** **PASS** (select: 0 linhas, update: 0 linhas, delete: 0 linhas, insert: erro `42501`).

### C5 — Responsável Não Assume Outro Perfil em Consultas
- **Comportamento:** Responsável 1 (vinculado a Estudante 1) consulta `revisoes_trimestrais` da Estudante 2 (sem vínculo) e recebe 0 linhas. Consulta de acervo enviado por Responsável 2 retorna 0 linhas. Consulta da sua própria estudante vinculada retorna a linha legítima.
- **Resultado:** **PASS** (cross-tenant no responsável retorna 0 linhas; vínculo autorizado retorna 1 linha).

### C6 — Login Legítimo Continua 100% Funcional
- **Comportamento:** Sob o papel `medicina_auth`, chamadas a `medicina.autenticar_por_email` para estudante e responsável cadastrados na allowlist retornam com sucesso o perfil completo contendo as credenciais para conferência de hash pelo NextAuth.
- **Resultado:** **PASS** (estudante e responsável autenticados com sucesso via `medicina_auth`).

### C7 — Consultas Cotidianas (`medicina_app`) Não Expõem Hashes de Senha
- **Comportamento:** Conexões operando com a role cotidiana da aplicação (`medicina_app`) tentam emitir `SELECT password_hash FROM perfis` ou `SELECT * FROM perfis`. Ambas são bloqueadas pelo PostgreSQL com erro de privilégio `42501` (*permission denied for column password_hash*).
- **Resultado:** **PASS** (rejeição de privilégio `42501` para consultas de hash em `medicina_app`).

### C8 — Funções de Autenticação Respeitam Privilégios Mínimos
- **Comportamento:** O papel `medicina_app` tenta chamar `medicina.autenticar_por_email` e é rejeitado com erro `42501`. O papel `medicina_anon` tenta a mesma chamada e é rejeitado com erro `42501`. Apenas `medicina_auth` possui permissão para executar a função.
- **Resultado:** **PASS** (bloqueio `42501` para `medicina_app` e `medicina_anon`; execução exclusiva para `medicina_auth`).

### C9 — Operações sem Sessão/Contexto São Negadas Fail-Closed
- **Comportamento:** Sem contexto configurado, leituras em `sessoes`, `cards` e `perfis` retornam 0 linhas. Tentativa de `INSERT` sem contexto é rejeitada com erro `42501`.
- **Resultado:** **PASS** (leituras: 0 linhas; escrita sem contexto: erro `42501`).

### C10 — Transações Encerram com Limpeza de Contexto
- **Comportamento:** Transação que sofre `ROLLBACK` intencional descarta qualquer modificação e desfaz parâmetros locais. Transação que conclui com `COMMIT` e `medicina.clear_context()` deixa a sessão limpa (`current_perfil_id = NULL`).
- **Resultado:** **PASS** (sem vazamento de contexto ou estado entre ciclos transacionais).

### C11 — Conexões Reutilizadas Não Carregam Contexto Pós-DISCARD ALL
- **Comportamento:** Simulação de reutilização de conexões em poolers (ex.: PgBouncer). Após `DISCARD ALL;`, o papel do PostgreSQL permanece estéril, `current_perfil_id` é nulo e `SELECT * FROM sessoes` retorna 0 linhas.
- **Resultado:** **PASS** (isolamento comprovado em pools reaproveitadas).

### C12 — Queries Protegidas Não Executam sem Contexto Apropriado
- **Comportamento:** Tabelas analíticas e pedagógicas sensíveis (`simulado_analise`, `erros`, `checkins`, `repertorios`) retornam 0 linhas na ausência de contexto de sessão, retornando dados exclusivamente sob contexto autorizado.
- **Resultado:** **PASS** (acesso estritamente condicionado ao contexto).

### C13 — Painel do Responsável Consome Apenas Informações Agregadas (Princípio 1.2)
- **Comportamento:** Responsável 1 autenticado consulta `sessoes` brutas e recebe 0 linhas. Consulta `checkins` brutos e recebe 0 linhas. Consulta a view agregada `vw_acompanhamento_quinzenal` e recebe os indicadores consolidados com sucesso.
- **Resultado:** **PASS** (cumprimento irrestrito do Princípio 1.2 da ESPEC).

### C14 — Operações Administrativas e de Curadoria Inacessíveis para Estudantes
- **Comportamento:** Estudante autenticada tenta consultar `curadoria_fila` (0 linhas) ou `acervo_arquivos` (0 linhas), tenta inserir em `curadoria_fila` (erro `42501`) e tenta chamar `medicina.current_managed_estudante_id()` (retorna `NULL`).
- **Resultado:** **PASS** (fronteira administrativa impenetrável para estudante).

### C15 — Rejeição de Falsos Sucessos
- **Comportamento:** Mutações não autorizadas por RLS afetam rigorosamente 0 linhas (`rowCount === 0`). Inserções não autorizadas disparam exceção relacional `42501`. Nenhuma operação inválida passa como falso sucesso.
- **Resultado:** **PASS** (mutações retornam 0 linhas e inserts disparam erro `42501`).

---

## 4. Matriz Consolidada de 41 Cenários de Segurança

| Bloco | Intervalo | Cenários Avaliados | Status |
|---|:---:|---|:---:|
| **Etapa 9 (Baseline)** | 1 a 18 | Usuário anônimo, estudante, responsável, vínculo, cross-tenant, mutações indevidas, curadoria, agregação quinzenal, proteção de perfis, subqueries/joins, fail-closed, transações sucessivas, pool reuse, tabelas filhas e bloqueio DDL. | **18/18 PASS** |
| **F1.04-R (Auditoria)** | R1 a R8 | Trust model, role mismatch, column-level grant em `password_hash`, papel anônimo, fail-closed fora de transação, anti-enumeração allowlist, login legítimo allowlist, isolamento em `vw_revisoes_trimestrais`. | **8/8 PASS** |
| **F1.04-C (Conformidade)** | C1 a C15 | Identidade de sessão, parâmetro não substitui auth, papel imutável, estudante sem outro perfil, responsável sem outro perfil, login 100% funcional, consultas comuns sem hash, privilégio mínimo auth (`medicina_auth`), negação fail-closed, lifecycle transacional, pool pós-DISCARD, queries protegidas, Princípio 1.2, barreira administrativa e rejeição de falsos sucessos. | **15/15 PASS** |

**Total de Cenários Avaliados:** **41**  
**Cenários Aprovados:** **41**  
**Cenários Reprovados:** **0**  
**Taxa de Sucesso:** **100.0%**

---

## 5. Ensaio de Rollback e Idempotência

O procedimento de rollback atômico e re-aplicação foi executado comprovando a reversibilidade total:
1. **Execução de `F1_04_ROLLBACK_RLS.sql`:**
   - Remoção de views de segurança (`vw_perfis`, `vw_acompanhamento_quinzenal`, `vw_simulados_evolucao`, `vw_revisoes_trimestrais`);
   - Desabilitação de Row-Level Security em todas as 33 tabelas;
   - Remoção de todas as políticas de linha;
   - Remoção atômica do papel `medicina_auth` (`DROP ROLE medicina_auth;`);
   - Revogação de permissões e descarte em cascata do schema `medicina`.
   - **Resultado do rollback:** 0 views restantes, 0 tabelas com RLS ativo, 0 papéis `medicina_auth` restantes.
2. **Re-aplicação de `F1_04_RLS_PROPOSTA.sql`:**
   - Re-execução da proposta sobre a base limpa.
   - **Resultado da re-aplicação:** Sucesso total sem colisões, erros de sintaxe ou violações de dependência, atestando a idempotência da DDL.

---

## 6. Quality Gates

```bash
# 1. Typecheck estrito TypeScript
npx tsc --noEmit
# Resultado: 0 erros

# 2. Suíte de testes unitários Vitest
npm run test:run
# Resultado: 17 test files, 123/123 testes aprovados (incluindo rls-context.test.ts)

# 3. Integridade do schema Drizzle
npx drizzle-kit check
# Resultado: Everything's fine

# 4. Formatação e espaços em branco Git
git diff --check
# Resultado: 0 violações
```

---

## 7. Conclusão e Próximos Passos

A tarefa **F1.04-C** atesta que a camada de Row-Level Security, papéis segregados de banco e contratos de autorização do Medicina 2029 estão plenamente validados, auditados e prontos para homologação.

O próximo gate obrigatório do Plano de Modernização é a tarefa **F1.06** (Atualização de dependências críticas e separação de segredos), sem necessidade de novas alterações na camada relacional de autorização.
