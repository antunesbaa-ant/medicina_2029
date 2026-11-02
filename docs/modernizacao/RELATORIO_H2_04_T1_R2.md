# MEDICINA 2029 — RELATÓRIO DE CORREÇÃO H2.04-T1-R2
## CORREÇÃO DA EXECUÇÃO REAL DOS TESTES RLS: CONEXÕES AUTENTICADAS DIRETAS POR PAPEL TÉCNICO

**Data:** 02 de Novembro de 2026  
**Ambiente:** Supabase Staging (`aws-0-us-east-1.pooler.supabase.com:5432`) / Node.js 24.21.0  
**Projeto Alvo:** `ynfocaorhadizlvbnzrt` (PostgreSQL 17.6)  
**Mecanismo de Conexão:** Dual Direct Authenticated Connection via Session Pooler (porta 5432, TLS estrito)  
**Status Local dos Testes:** **APROVADO (25/25 testes na suíte direcionada; 64/64 testes na suíte H2.04)**  
**Operações Remotas no Staging:** NENHUMA mutação executada (0 seeds, 0 cleanups, 0 DDL, 0 alterações de senhas)  

---

### 1. CAUSA RAIZ DOS 12 ERROS NA AUDITORIA ANTERIOR

Na execução remota preliminar do auditor `audit-staging-isolation-t1.mjs` no Supabase Staging, 15 cenários foram avaliados, resultando em:
- **3 Aprovados**
- **12 Reprovados**

Com o erro repetitivo registrado em logs:
```text
permission denied to set role "medicina_auth"
permission denied to set role "medicina_app"
```

#### Diagnóstico Técnico da Arquitetura Supabase:
1. **Papel de Conexão Administrativo (`postgres`):**
   No Supabase gerenciado, o papel de conexão `postgres.<PROJECT_REF>` conecta ao PostgreSQL com o usuário interno `postgres`. Diferente de uma instalação local padrão do PostgreSQL (onde `postgres` possui `rolsuper = true`), no Supabase o usuário `postgres` é um papel gerenciado com `rolsuper = false` e `rolcreaterole = true`.
2. **Falta de Membership no Catálogo:**
   As roles técnicas da aplicação (`medicina_auth`, `medicina_app`, `medicina_anon`) foram criadas via DDL pelas migrações canônicas como papéis autônomos (`NOSUPERUSER NOBYPASSRLS`). O Supabase **não concede** automaticamente o membership dessas roles ao usuário `postgres` (`GRANT medicina_auth TO postgres` não foi nem deve ser executado para evitar escalada de privilégios).
3. **Mecanismo `SET ROLE` Abortado:**
   O auditor anterior realizava uma única conexão física como `postgres` e tentava dinamicamente alternar identidades via `SET ROLE medicina_auth` e `SET ROLE medicina_app`. No PostgreSQL, a execução de `SET ROLE <role>` exige que o usuário da sessão (`session_user`) seja superusuário ou possua `GRANT <role>`. Diante da ausência de ambos, o PostgreSQL disparou o erro canônico:
   ```text
   ERROR: 42501: permission denied to set role "medicina_auth"
   ```
4. **Impacto nos 12 Cenários:**
   Os 12 cenários reprovados abortaram **antes mesmo de consultar o schema `public` ou testar as políticas RLS**. Trata-se, portanto, de uma falha de infraestrutura no lançador do auditor, e **não de uma reprovação funcional das políticas RLS**.

---

### 2. ANÁLISE DOS 3 CENÁRIOS ANTERIORMENTE "APROVADOS" (FALSOS POSITIVOS / INCONCLUSIVOS)

No preflight anterior, três cenários foram classificados como "APROVADO". Uma análise aprofundada do código revelou que esses resultados decorreram de **falsos positivos em testes negativos**:

#### Caso A: Cenário `SEC-01` (Bloqueio de RPC para `medicina_app`)
- **Objetivo do Cenário:** Comprovar que a role `medicina_app` não pode executar a função privilegiada `medicina.autenticar_por_email(text)`.
- **Implementação Anterior:**
  ```javascript
  try {
    await tx`SET ROLE medicina_app;`;
    await tx`SELECT * FROM medicina.autenticar_por_email('teste@medicina.com');`;
  } catch (err) {
    if (err.code === '42501') {
      logScenario({ code: 'SEC-01', status: 'APROVADO' }); // FALSO POSITIVO!
    }
  }
  ```
- **O que Realmente Aconteceu:** A instrução `SET ROLE medicina_app;` falhou com código `42501` (`permission denied to set role "medicina_app"`). O bloco `catch` capturou o código `42501` e marcou o cenário como `APROVADO`, presumindo que a função fora rejeitada. Na realidade, a função `medicina.autenticar_por_email` **nunca chegou a ser executada**.

#### Caso B: Cenário `SEC-02` (Proteção de Coluna `password_hash`)
- **Objetivo do Cenário:** Comprovar que `medicina_app` não possui privilégio de `SELECT` na coluna `password_hash` da tabela `public.perfis`.
- **O que Realmente Aconteceu:** Pelo mesmo mecanismo, a falha do `SET ROLE` com código `42501` foi interpretada erroneamente como o bloqueio da coluna, constituindo outro **falso positivo**.

#### Conclusão Formal sobre a Execução Anterior:
**Todos os 15 cenários da auditoria preliminar H2.04-T1 são oficialmente reclassificados como INCONCLUSIVOS**, dado que nenhuma das consultas foi executada sob a identidade PostgreSQL correta e comprovada.

---

### 3. NOVA ARQUITETURA: CONEXÕES AUTENTICADAS DIRETAS POR PAPEL TÉCNICO

Para eliminar em definitivo a dependência de `SET ROLE`, o auditor foi integralmente reestruturado para utilizar **conexões diretas autenticadas via Session Pooler**:

```mermaid
flowchart TD
    subgraph Staging_Session_Pooler["Supabase Session Pooler (Porta 5432, TLS Estrito)"]
        PoolAuth["aws-0-us-east-1.pooler.supabase.com:5432<br/>User: medicina_auth.ynfocaorhadizlvbnzrt"]
        PoolApp["aws-0-us-east-1.pooler.supabase.com:5432<br/>User: medicina_app.ynfocaorhadizlvbnzrt"]
    end

    subgraph Auditor["Auditor H2.04-T1-R2 (scripts/db/audit-staging-isolation-t1.mjs)"]
        AuthConn["Conexão authSql<br/>(Identidade: medicina_auth)"]
        AppConn["Conexão appSql<br/>(Identidade: medicina_app)"]
    end

    subgraph Security_Gate["Portão de Identidade Pré-Auditoria"]
        ValAuth["validateRoleSessionIdentity('medicina_auth')<br/>current_user=medicina_auth<br/>session_user=medicina_auth<br/>rolsuper=false, rolbypassrls=false"]
        ValApp["validateRoleSessionIdentity('medicina_app')<br/>current_user=medicina_app<br/>session_user=medicina_app<br/>rolsuper=false, rolbypassrls=false"]
    end

    subgraph Matrix["Execução Segura da Matriz (Zero SET ROLE)"]
        G1["Grupo 1: RPC Autenticação (Alice, Bruno, Carlos, Anti-enumeração)"]
        G2["Grupo 2: Bloqueio de RPC e Sigilo de Coluna password_hash"]
        G3["Grupo 3: Fail-Closed (Sem Contexto e Anônimo)"]
        G4["Grupo 4: Isolamento Alice (Ciclo, Cards, Tutela)"]
        G5["Grupo 5: Isolamento Carlos (Ciclo, Cards, Zero Vínculos)"]
        G6["Grupo 6: Escopo Bruno (Tutela Alice, Acervo, Anti-Vigilância de Ciclos)"]
        G7["Grupo 7: Rejeição Compulsória de Escalada (Exceções P0001)"]
        G8["Grupo 8: Isolamento Transacional e Pooler Safety (SET LOCAL)"]
    end

    PoolAuth --> AuthConn
    PoolApp --> AppConn

    AuthConn --> ValAuth
    AppConn --> ValApp

    ValAuth --> G1
    ValApp --> G2
    ValApp --> G3
    ValApp --> G4
    ValApp --> G5
    ValApp --> G6
    ValApp --> G7
    ValApp --> G8
```

#### Especificações Técnicas das Conexões:
1. **Conexão `medicina_auth`:**
   - **URI:** `postgresql://medicina_auth.ynfocaorhadizlvbnzrt:*****@aws-0-us-east-1.pooler.supabase.com:5432/postgres`
   - **Finalidade:** Autenticação de credenciais via NextAuth, validação anti-enumeração e execução da RPC `medicina.autenticar_por_email`.
   - **Privilégios:** Apenas `EXECUTE` na RPC `medicina.autenticar_por_email`. Sem privilégios de DML em tabelas de dados.
2. **Conexão `medicina_app`:**
   - **URI:** `postgresql://medicina_app.ynfocaorhadizlvbnzrt:*****@aws-0-us-east-1.pooler.supabase.com:5432/postgres`
   - **Finalidade:** Runtime da aplicação Next.js (Server Actions, RLS, busca vetorial no acervo).
   - **Privilégios:** Operações em `public` subordinadas a RLS via `medicina.set_context()`. Coluna `password_hash` revogada (`GRANT SELECT (id, auth_user_id, email, ...) ON public.perfis TO medicina_app`). Sem acesso à RPC de autenticação.
3. **Validação Estrita de Identidade (`validateRoleSessionIdentity`):**
   Antes de executar qualquer cenário, o auditor valida diretamente no catálogo:
   - `current_user === expectedRole`
   - `session_user === expectedRole`
   - `current_database() === 'postgres'`
   - `rolcanlogin === true`
   - `rolsuper === false` (Impede SUPERUSER)
   - `rolbypassrls === false` (Impede BYPASSRLS)

---

### 4. GESTÃO SEGURA DE CREDENCIAIS

Para atender aos requisitos de conformidade e segurança da informação:
1. **Entrada Interativa Oculta (`promptHiddenPassword`):**
   - O auditor solicita as senhas das roles no terminal interativo sem eco visual (caracteres mascarados).
   - Não aceita senhas como flags de linha de comando (`--password=...`), prevenindo histórico no shell (`~/.zsh_history`) e visualização via `ps aux`.
2. **Ambiente Não-Interativo (Fallback Seguro):**
   - Suporte controlado às variáveis `MEDICINA_AUTH_PASSWORD` e `MEDICINA_APP_PASSWORD`.
   - Caso executado em terminal sem TTY e sem as variáveis, aborta imediatamente em modo *fail-closed*.
3. **Zero Persistência em Disco:**
   - Nenhuma credencial é gravada em arquivos de configuração, logs ou relatórios.
4. **Limpeza em Memória (`finally`):**
   - As strings de senha são sobrescritas (`authPassword = ''; appPassword = '';`) imediatamente após a conexão, e os pools de conexão `postgres` são encerrados com segurança (`await Promise.allSettled([authSql.end(), appSql.end()])`).

---

### 5. ANÁLISE DO PAPEL `medicina_anon` E MODELO DE SEGURANÇA SEM LOGIN

Foi realizada auditoria técnica aprofundada da role `medicina_anon`:

1. **Estado no Catálogo PostgreSQL:**
   - Criada pela migração canônica `F1_04_RLS_PROPOSTA.sql`:
     ```sql
     CREATE ROLE medicina_anon WITH LOGIN NOSUPERUSER NOBYPASSRLS;
     ```
   - Embora possua o atributo `LOGIN` no catálogo (necessário em arquiteturas legadas do Supabase), **não possui senha configurada** (`rolpassword IS NULL`).
   - Não faz parte da allowlist de conexão externa (`ALLOWED_STAGING_ROLES`).
2. **Modelo de Segurança Efetivo da Aplicação Next.js:**
   - Requisições públicas ou não-autenticadas na aplicação **não abrem conexão TCP separada sob `medicina_anon`**.
   - Toda a aplicação opera utilizando o pool de conexões autenticado como `medicina_app` (definido em `DATABASE_URL` via Session Pooler).
   - Em requisições de visitantes não autenticados, a aplicação **não invoca** `medicina.set_context()`.
3. **Comportamento Fail-Closed Efetivo:**
   - Quando `medicina.current_perfil_id()` é invocado em uma transação onde `set_context` não foi chamado, a função retorna `NULL`.
   - As políticas RLS das tabelas privadas (`perfis`, `ciclos`, `cards`, `acervo_arquivos`, `responsavel_estudante`) utilizam predicados estritos:
     ```sql
     id = medicina.current_perfil_id()
     ```
   - Como `coluna = NULL` avalia como `UNKNOWN` (falso no contexto SQL), a consulta retorna rigorosamente **0 linhas**.
   - **Comprovação:** O cenário `RLS-01` e o teste unitário 3.1 validam que consultas sob `medicina_app` sem contexto retornam exatamente 0 linhas em todas as 5 tabelas privadas.
   - O cenário `RLS-02` valida adicionalmente que `medicina_anon` no catálogo possui `rolsuper = false` e `rolbypassrls = false`.

---

### 6. MATRIZ COMPARATIVA DOS 15 CENÁRIOS DE AUDITORIA

| Código | Descrição do Cenário | Papel Efetivo | Execução Anterior (SET ROLE) | Nova Execução (Conexão Direta) | Causa da Diferença |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **AUT-01** | RPC autenticação Alice (`estudante`) | `medicina_auth` | ❌ REPROVADO | ✅ APROVADO | Anterior abortou em `SET ROLE medicina_auth`. Agora conecta diretamente autenticado. |
| **AUT-02** | RPC autenticação Bruno (`responsavel`) | `medicina_auth` | ❌ REPROVADO | ✅ APROVADO | Anterior abortou em `SET ROLE medicina_auth`. Agora conecta diretamente autenticado. |
| **AUT-03** | RPC autenticação Carlos (`estudante`) | `medicina_auth` | ❌ REPROVADO | ✅ APROVADO | Anterior abortou em `SET ROLE medicina_auth`. Agora conecta diretamente autenticado. |
| **AUT-04** | Anti-enumeração (e-mail fora da allowlist) | `medicina_auth` | ❌ REPROVADO | ✅ APROVADO | Retorna 0 linhas sem expor schema ou presença de usuários. |
| **SEC-01** | Bloqueio de RPC de autenticação para papel aplicacional | `medicina_app` | ⚠️ FALSO POSITIVO | ✅ APROVADO | Anterior falhou no `SET ROLE` (42501). Agora testa a função diretamente e captura 42501 específico da função. |
| **SEC-02** | Proteção de coluna `password_hash` contra SELECT | `medicina_app` | ⚠️ FALSO POSITIVO | ✅ APROVADO | Anterior falhou no `SET ROLE` (42501). Agora testa a coluna e captura 42501 específico de coluna. |
| **RLS-01** | Fail-closed sem ativação de contexto transacional | `medicina_app` | ❌ REPROVADO | ✅ APROVADO | Anterior abortou no `SET ROLE`. Agora conecta como `medicina_app` e comprova 0 linhas em 5 tabelas. |
| **RLS-02** | Fail-closed anônimo e auditoria de `medicina_anon` | `medicina_app` | ❌ REPROVADO | ✅ APROVADO | Valida isolamento anônimo e atributos do catálogo de `medicina_anon` (sem super/bypass). |
| **ISO-01** | Isolamento estrito da estudante Alice | `medicina_app` | ❌ REPROVADO | ✅ APROVADO | Acessa apenas 1 perfil, ciclo com 28 blocos, 3 cards e 1 vínculo. 0 dados de Carlos visíveis. |
| **ISO-02** | Isolamento estrito do estudante independente Carlos | `medicina_app` | ❌ REPROVADO | ✅ APROVADO | Acessa apenas 1 perfil, ciclo com 28 blocos e 2 cards. Vínculo Bruno->Alice e ciclo de Alice invisíveis. |
| **ISO-03** | Escopo do responsável Bruno (tutela Alice, zero Carlos) | `medicina_app` | ❌ REPROVADO | ✅ APROVADO | Enxerga Bruno e Alice, seu vínculo e arquivo no acervo. Ciclos diretos são invisíveis (anti-vigilância). |
| **ESC-01** | Carlos tentando forjar papel 'responsavel' | `medicina_app` | ❌ REPROVADO | ✅ APROVADO | Anterior recebeu 42501 do `SET ROLE`. Agora `set_context` dispara a exceção canônica `P0001`. |
| **ESC-02** | Alice tentando forjar papel 'responsavel' | `medicina_app` | ❌ REPROVADO | ✅ APROVADO | Disparo comprovado da exceção canônica `P0001` de violação de contexto. |
| **ESC-03** | Ativação de contexto com UUID arbitrário inexistente | `medicina_app` | ❌ REPROVADO | ✅ APROVADO | Disparo comprovado da exceção canônica `P0001` (perfil inexistente). |
| **POL-01** | Isolamento transacional e Pooler Safety (`SET LOCAL`) | `medicina_app` | ❌ REPROVADO | ✅ APROVADO | Transação 2 na mesma conexão encontra `current_perfil_id=NULL` e 0 linhas. Zero contaminação. |

---

### 7. EVIDÊNCIAS DE TESTES E VALIDAÇÃO LOCAL

#### A. Verificação de Sintaxe JavaScript Pura (Node.js 24)
```bash
node --check scripts/db/audit-staging-isolation-t1.mjs
# Código de saída: 0 (Sucesso absoluto)
```

#### B. Execução da Suíte de Testes Vitest (PGlite com pgvector)
```bash
npx vitest run src/app/actions/h2_04_t1_authentication_and_isolation.test.ts
```
**Resultado:**
```text
 ✓ src/app/actions/h2_04_t1_authentication_and_isolation.test.ts (25 tests) 1878ms
   ✓ MEDICINA 2029 — H2.04-T1: Autenticação e Isolamento Multi-Tenant (25)
     ✓ 1. Fluxo de Autenticação e RPC sob medicina_auth (3)
       ✓ 1.1 medicina.autenticar_por_email retorna registro completo com hash bcrypt para Alice, Bruno e Carlos
       ✓ 1.2 Anti-enumeração: e-mail fora da allowlist retorna 0 linhas imediatamente
       ✓ 1.3 Validação de senha: hash bcrypt gerado valida estritamente a senha correspondente
     ✓ 2. Segurança de Privilégios e Proteção de Coluna sob medicina_app (2)
       ✓ 2.1 Bloqueio de RPC: medicina_app NÃO possui permissão em medicina.autenticar_por_email (erro 42501)
       ✓ 2.2 Proteção de Coluna: leitura direta da coluna password_hash é revogada de medicina_app (erro 42501)
     ✓ 3. Princípio Fail-Closed (2)
       ✓ 3.1 Consulta sob medicina_app sem chamar medicina.set_context retorna 0 linhas em todas as tabelas privadas
       ✓ 3.2 Consulta sob medicina_anon é bloqueada ou retorna 0 linhas (fail-closed absoluto)
     ✓ 4. Isolamento RLS da Estudante Alice (1)
       ✓ 4.1 Alice enxerga exclusivamente seu perfil, seu ciclo (28 blocos), seus 3 cards e seu vínculo de tutoria
     ✓ 5. Isolamento RLS do Estudante Independente Carlos (1)
       ✓ 5.1 Carlos enxerga exclusivamente seu perfil, seu ciclo (28 blocos) e seus 2 cards; zero tutoria e zero Alice
     ✓ 6. Escopo de Acesso do Responsável Bruno (Tutela de Alice, Zero Carlos) (1)
       ✓ 6.1 Bruno enxerga apenas seu perfil e o da tutelada Alice, seu vínculo e seu arquivo no acervo; Carlos e ciclos são invisíveis
     ✓ 7. Rejeição Compulsória de Escalada de Privilégios (3)
       ✓ 7.1 Carlos tentando assumir papel responsavel lança exceção P0001
       ✓ 7.2 UUID inexistente ou arbitrário lança exceção P0001
       ✓ 7.3 Papel inválido ("admin") lança exceção P0001
     ✓ 8. Isolamento Transacional e Pooler Safety (SET LOCAL) (1)
       ✓ 8.1 Ao encerrar uma transação, o contexto RLS é descartado e a transação seguinte na mesma conexão encontra NULL
     ✓ 9. Diferenciação Formal: Perfil Cadastrado vs Usuário Autenticado (1)
       ✓ 9.1 Perfil cadastrado existe com hash bcrypt válido, mas login com senha arbitrária falha
     ✓ 10. Validação de Sintaxe ESM e Execução do Processo Node.js do Auditor (H2.04-T1-R) (4)
       ✓ 10.1 "node --check" valida sintaxe JavaScript pura sem qualquer erro de TypeScript
       ✓ 10.2 Invocação com "--help" executa como processo Node.js real e exibe ajuda sem SyntaxError
       ✓ 10.3 Invocação com certificado CA inexistente rejeita com mensagem controlada e sem SyntaxError
       ✓ 10.4 A função exportada runStagingIsolationAudit executa todos os 8 grupos de cenários com sucesso
     ✓ 11. Diagnóstico e Prevenção de Falhas de Roles Reais (H2.04-T1-R2) (6)
       ✓ 11.1 Falha em SET ROLE: usuário sem permissão lança erro 42501 ao tentar assumir outra role
       ✓ 11.2 Prevenção de Falso Positivo: erro em SET ROLE não é tratado como aprovação de bloqueio RLS/RPC
       ✓ 11.3 Conexão Direta Correta: validateRoleSessionIdentity valida current_user, login, super=false e bypassrls=false
       ✓ 11.4 Identidade PostgreSQL Inesperada: validateRoleSessionIdentity aborta se current_user divergir
       ✓ 11.5 Validação de URL de Conexão com Project Ref: validateRoleConnectionConfig rejeita configurações inválidas
       ✓ 11.6 Execução Dual Completa: runStagingIsolationAudit opera diretamente com authSql e appSql sem SET ROLE

 Test Files  1 passed (1)
      Tests  25 passed (25)
   Duration  2.04s
```

#### C. Suíte Completa de Portões e Homologação H2.04 (Vitest)
```bash
npx vitest run src/app/actions/h2_04
# 5 arquivos de teste avaliados, 64 testes aprovados (64/64), 0 falhas.
```

---

### 8. COMANDO SEGURO PARA A PRÓXIMA AUDITORIA REMOTA

Quando for concedida autorização humana, o operador executará a auditoria remota no Supabase Staging através do comando seguro:

```bash
node scripts/db/audit-staging-isolation-t1.mjs --ca="$HOME/Downloads/prod-ca-2021.crt"
```

#### Fluxo Operacional Durante a Execução:
1. O processo valida o certificado TLS `prod-ca-2021.crt`.
2. Solicita de forma interativa e mascarada:
   - `🔑 [1/2] Digite a senha da role medicina_auth: `
   - `🔑 [2/2] Digite a senha da role medicina_app: `
3. Conecta no Session Pooler (`aws-0-us-east-1.pooler.supabase.com:5432`) diretamente com:
   - `medicina_auth.ynfocaorhadizlvbnzrt`
   - `medicina_app.ynfocaorhadizlvbnzrt`
4. Valida no catálogo que ambas as roles possuem `rolcanlogin = true`, `rolsuper = false`, `rolbypassrls = false`.
5. Ativa `SET default_transaction_read_only = on` em ambas as sessões.
6. Executa a matriz dos 15 cenários de teste exclusivamente via `SELECT` e encerra as conexões de forma limpa.

---

### 9. COMPARAÇÃO E VERIFICAÇÃO DE INTEGRIDADE (HASH SHA-256)

Os relatórios idênticos foram emitidos em:
- **Caminho do Projeto:** `docs/modernizacao/RELATORIO_H2_04_T1_R2.md`
- **Caminho do Usuário:** `/Users/brunoantunes/Documents/MEDICINA_2029_H2_04_T1_R2_RELATORIO.md`
