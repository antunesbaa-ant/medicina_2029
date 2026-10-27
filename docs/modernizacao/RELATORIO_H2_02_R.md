# MEDICINA 2029 — H2.02-R
## Relatório de Verificação Final do Teste Somente-Leitura e Introspeção de Catálogo

**Data:** 26 de Outubro de 2026  
**Ambiente:** Supabase Staging (`medicina-2029-staging`)  
**Project Ref:** `ynfocaorhadizlvbnzrt`  
**Host do Pooler:** `aws-0-us-east-1.pooler.supabase.com`  
**Portas Auditadas:**
- Porta `5432` (Session Pooler): `medicina_app`, `medicina_auth`, `medicina_worker`
- Porta `6543` (Transaction Pooler): `medicina_app`, `medicina_auth` (com `prepare: false` e `SET LOCAL`)
**Certificado Raiz TLS:** `~/Downloads/prod-ca-2021.crt`  
**Fingerprint Canônico SHA-256:** `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`  
**Script Oficial de Validação:** [`scripts/db/verify-staging-roles-connection.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/verify-staging-roles-connection.mjs)  
**Status:** **APROVADO E VERIFICADO LOCALMENTE (38/38 TESTES VÁLIDOS, AGUARDANDO AUTORIZAÇÃO HUMANA)**

---

## 1. Contexto e Motivação da Revisão H2.02-R

Na homologação da etapa **H2.02**, o utilitário interativo [`scripts/db/verify-staging-roles-connection.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/verify-staging-roles-connection.mjs) foi concebido para atestar a autenticação, integridade de atributos de segurança e conectividade das três roles técnicas nos dois modos de pooler do Supabase.

Durante a auditoria de conformidade estrita de **somente-leitura**, foi identificado que a validação de menor privilégio da role `medicina_auth` realizava uma chamada direta à função de negócio:
```sql
SELECT * FROM medicina.autenticar_por_email('probe@medicina2029.staging');
```

A etapa **H2.02-R** teve como missão auditar a implementação real dessa função, avaliar os riscos de sua execução durante diagnósticos de infraestrutura e substituí-la por introspecção direta de catálogos do PostgreSQL, assegurando ausência absoluta de efeitos colaterais e blindagem contra vazamento de credenciais.

---

## 2. Inspeção Técnica e Avaliação de Riscos de `medicina.autenticar_por_email`

### 2.1 Código Real da Função (Migração Canônica `F1_04_RLS_PROPOSTA.sql`, linhas 182-207)

```sql
CREATE OR REPLACE FUNCTION medicina.autenticar_por_email(p_email text)
RETURNS TABLE (
  id uuid,
  email text,
  nome text,
  role text,
  ativo boolean,
  password_hash text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.allowlist
    WHERE email = p_email AND ativo = true
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.email,
    p.nome,
    p.role,
    p.ativo,
    p.password_hash
  FROM public.perfis p
  WHERE p.email = p_email;
END;
$$;
```

### 2.2 Análise de Riscos Identificados

Embora a implementação atual contenha apenas instruções `SELECT` (não gravando dados no momento presente), seu uso em diagnósticos de rede e conectividade apresentava **quatro riscos arquiteturais e operacionais graves**:

1. **Risco de Mutação Futura e Efeitos Colaterais Ocultos (Side Effects):**
   Funções de autenticação em aplicações web frequentemente evoluem para incluir auditoria de logins, rate limiting, registro de tentativas falhas (`auth_audit_log`, `failed_attempts`) ou acionamento de triggers de auditoria. Caso isso ocorresse, um probe rotineiro de conexão deixaria de ser passivo e causaria escritas espúrias no banco de dados.

2. **Vazamento e Exposição de Hashes de Senha (`password_hash`):**
   A assinatura da função declara retorno explícito da coluna confidencial: `password_hash text`. Se o e-mail de teste coincidisse com um usuário existente no banco, a função devolveria o hash de senha criptográfico para a memória do processo cliente Node.js, violando o princípio de menor exposição e criando risco de captura de segredos em dumps de memória ou logs de debug.

3. **Mascaramento de Privilégios por `SECURITY DEFINER`:**
   Como a função possui o modificador `SECURITY DEFINER`, ela é executada sob os privilégios do seu proprietário (`postgres`). Portanto, executá-la com sucesso **não comprova** quais privilégios diretos a role `medicina_auth` possui ou deixa de possuir no banco de dados; apenas comprova que ela pode chamar a função.

4. **Acoplamento Indevido entre Infraestrutura e Domínio de Negócio:**
   Um script de verificação de conectividade e pooling (camada de transporte/sessão) passava a depender do conteúdo de tabelas de negócio (`public.allowlist` e `public.perfis`), tornando o teste frágil a estados vazios de banco ou falhas de dados de domínio.

**Conclusão da Auditoria:** Havia risco arquitetural e de segurança real. A chamada de negócio foi formalmente reprovada para uso no script de diagnóstico.

---

## 3. Correção Arquitetural: Introspecção Pura de Catálogos PostgreSQL

A chamada a `medicina.autenticar_por_email(...)` foi inteiramente removida do script [`scripts/db/verify-staging-roles-connection.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/verify-staging-roles-connection.mjs).

Em seu lugar, foi adotada a **introspecção direta de catálogos do PostgreSQL** utilizando as funções nativas compiladas em C do motor relacional:
- `has_function_privilege(user, function, privilege)`
- `has_schema_privilege(user, schema, privilege)`
- `has_table_privilege(user, table, privilege)`
- `has_column_privilege(user, table, column, privilege)`

### 3.1 Consulta de Catálogo na Fase 1 (Session Pooler - Porta 5432)

No Session Pooler, o diagnóstico de `medicina_auth` executa a seguinte consulta de catálogo segura:

```sql
SELECT 
  has_function_privilege(current_user, 'medicina.autenticar_por_email(text)', 'EXECUTE') AS can_execute_auth,
  has_schema_privilege(current_user, 'medicina', 'USAGE') AS can_use_medicina,
  has_table_privilege(current_user, 'public.allowlist', 'SELECT') AS can_select_allowlist,
  has_column_privilege(current_user, 'public.perfis', 'password_hash', 'SELECT') AS can_select_pwd_hash,
  has_table_privilege(current_user, 'public.acervo_jobs', 'SELECT') AS can_select_jobs;
```

O script valida compulsoriamente os seguintes predicados:
- `can_execute_auth === true`: Comprova que a role tem grant de `EXECUTE` na RPC `medicina.autenticar_por_email`;
- `can_use_medicina === true`: Comprova que a role tem privilégio de `USAGE` no schema `medicina`;
- `can_select_allowlist === true`: Comprova que a role tem privilégio de `SELECT` na tabela de controle de acesso `public.allowlist`;
- `can_select_pwd_hash === false`: Comprova que a role **NÃO** tem acesso direto de leitura à coluna confidencial `password_hash` da tabela `public.perfis` (privilégio estritamente revogado pela migração 4);
- `can_select_jobs === false`: Comprova que a role **NÃO** tem acesso à fila de workers `public.acervo_jobs` (isolamento estrito entre roles).

### 3.2 Consulta de Catálogo na Fase 2 (Transaction Pooler - Porta 6543)

No Transaction Pooler, a validação de `medicina_auth` opera em bloco transacional com `prepare: false` e `SET LOCAL statement_timeout = '10000'`, executando:

```sql
SELECT 
  current_setting('statement_timeout', true) AS timeout_val,
  current_user AS tx_user,
  session_user AS tx_session_user,
  current_database() AS tx_database,
  has_function_privilege(current_user, 'medicina.autenticar_por_email(text)', 'EXECUTE') AS can_exec_auth;
```

Validando que:
- `timeout_val === '10s' || timeout_val === '10000ms'`: O parâmetro `SET LOCAL` foi injetado de forma transacional e limpa no PgBouncer;
- `tx_user === 'medicina_auth'` e `tx_session_user === 'medicina_auth'`;
- `can_exec_auth === true`: A capacidade de execução permanece íntegra sob o pooler transacional sem executar a função de negócio.

### 3.3 Vantagens Matemáticas e de Segurança da Nova Solução

| Dimensão | Chamada de Negócio (`medicina.autenticar_por_email`) | Introspecção de Catálogo (`has_*_privilege`) |
|---|:---:|:---:|
| **Garantia Somente-Leitura** | Dependente do corpo PL/pgSQL | **Garantida matematicamente pelo motor C do PostgreSQL** |
| **Risco de Escrita Espúria** | Presente caso haja logs/triggers | **Zero (impossível alterar estado)** |
| **Exposição de Hashes** | Retorna hash real de usuários | **Zero (opera apenas booleanos de privilégio)** |
| **Verificação de Privilégios** | Mascarada por `SECURITY DEFINER` | **Inspeciona diretamente os grants da role autenticada** |
| **Dependência de Dados** | Falha se banco não tiver seed | **Independente de dados (consulta metadados do PostgreSQL)** |
| **Segurança em Pooler** | Pode colidir se chamada concorrente | **Idempotente, segura e atômica** |

---

## 4. Preservação Integral dos Requisitos de Segurança e Pooling

Todas as especificações estabelecidas para a etapa H2.02 permanecem 100% ativas e preservadas:

1. **Session Pooler (Porta 5432):**
   - Validação sequencial e isolada para `medicina_app`, `medicina_auth` e `medicina_worker`.
   - Verificação de identidade: `current_user === session_user === roleName`.
   - Consulta restrita a `pg_roles`: `rolcanlogin = true`, `rolsuper = false`, `rolbypassrls = false`.
   - Desconexão imediata (`sql.end()`) após cada role.

2. **Transaction Pooler (Porta 6543):**
   - Validação para `medicina_app` e `medicina_auth`.
   - Bloqueio fail-closed de `medicina_worker` na porta 6543 (worker reservado compulsoriamente para porta 5432 devido a locks e jobs).
   - Driver `postgres.js` configurado compulsoriamente com `prepare: false`.
   - Injeção de contexto via `SET LOCAL` transacional (`BEGIN ... COMMIT`), garantindo descarte imediato ao devolver o socket ao PgBouncer.

3. **Criptografia TLS Estrita:**
   - Validação física do certificado raiz `~/Downloads/prod-ca-2021.crt`.
   - Checagem estrita de integridade do fingerprint SHA-256 (`80:70:25:AD:50...`).
   - Opção `rejectUnauthorized: true` ativa.

4. **Tratamento de Terminal e Senhas:**
   - Entrada oculta sem eco via `process.stdin.setRawMode(true)` em terminal TTY.
   - Mensagens de instrução e prompts perfeitamente visíveis antes da digitação.
   - Rejeição de senhas vazias com saída código `1`.
   - Captura graciosa de `Ctrl+C` com saída código `130`.
   - Sanitização de strings em mensagens de erro (`:***@`).
   - Purga imediata das variáveis de senha da memória via bloco `finally`.

---

## 5. Evidências dos Testes Locais Direcionados

Todos os testes foram executados localmente sem qualquer conexão com o Supabase remoto.

### 5.1 Suíte de Testes Automatizados (Vitest)

Execução da suíte completa de homologação H2:
```bash
npx vitest run src/app/actions/h2_*.test.ts
```

**Resultado Consolidado:**
```text
 ✓ src/app/actions/h2_01_r2_launchers_validation.test.ts (10 tests) 6214ms
 ✓ src/app/actions/h2_01_r_seed_allowlist_validation.test.ts (6 tests) 4821ms
 ✓ src/app/actions/h2_02_roles_connection_validation.test.ts (12 tests) 4754ms
 ✓ src/app/actions/h2_01_r3_operational_security.test.ts (10 tests) 1746ms

 Test Files  4 passed (4)
      Tests  38 passed (38)
   Start at  22:25:31
   Duration  19.04s
```

#### Detalhamento da Suíte [`src/app/actions/h2_02_roles_connection_validation.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h2_02_roles_connection_validation.test.ts) (12/12):
1. `1.1 medicina_app`: Conecta na 5432, valida identidade, `rolcanlogin=true`, `rolsuper=false`, `rolbypassrls=false`, leitura em perfis e bloqueio de `password_hash`. (Aprovado)
2. `1.2 medicina_auth`: Conecta na 5432, valida identidade, atributos de catálogo e menor privilégio via `has_function_privilege` e `has_table_privilege`. (Aprovado)
3. `1.3 medicina_worker`: Conecta na 5432, valida identidade, atributos de catálogo e leitura exclusiva na fila `acervo_jobs`. (Aprovado)
4. `2.1 Role não autorizada`: Bloqueia tentativas fora da allowlist fixa. (Aprovado)
5. `2.2 Superuser Fail-Closed`: Aborta e falha se `rolsuper = true`. (Aprovado)
6. `2.3 BypassRLS Fail-Closed`: Aborta e falha se `rolbypassrls = true`. (Aprovado)
7. `2.4 Login Fail-Closed`: Aborta e falha se `rolcanlogin = false`. (Aprovado)
8. `3.1 medicina_app`: Executa na 6543 com `prepare: false`, transação `SET LOCAL "request.jwt.claim.sub"` e `SET LOCAL statement_timeout`. (Aprovado)
9. `3.2 medicina_auth`: Executa na 6543 com `prepare: false`, transação `SET LOCAL statement_timeout` e introspecção de privilégio. (Aprovado)
10. `3.3 medicina_worker bloqueado na 6543`: Rejeita compulsoriamente execução do worker no Transaction Pooler. (Aprovado)
11. `4.1 Formatador de URLs`: Codifica corretamente caracteres especiais em senhas. (Aprovado)
12. `4.2 Orquestrador Geral`: Executa fluxo sequencial completo sem vazamento de erros. (Aprovado)

### 5.2 Teste de Terminal TTY Interativo (Simulação de Terminal Real via Python PTY)

```text
--- TESTE 1: Visibilidade de Prompts em verify-staging-roles-connection ---
  ✓ Etapa 1 e prompt de medicina_app visíveis.
  ✓ Senha app oculta. Etapa 2 (medicina_auth) exibida.
  ✓ Senha auth oculta. Etapa 3 (medicina_worker) exibida.
  ✓ Cancelamento limpo com Ctrl+C.
  ✓ Processo encerrou com código 130 conforme esperado.

--- TESTE 2: Tratamento de Entrada Vazia ---
  ✓ Entrada vazia detectada e bloqueada com código 1.

========================================================
✅ TESTES INTERATIVOS TTY DE VERIFY-STAGING-ROLES APROVADOS!
========================================================
```

---

## 6. Comando Definitivo para Execução no Terminal do Mac

Para executar a validação real de forma segura no ambiente Staging, o operador deve rodar o seguinte comando no **Terminal do Mac**:

```bash
node scripts/db/verify-staging-roles-connection.mjs --ca=~/Downloads/prod-ca-2021.crt
```

---

## 7. Saída Esperada no Terminal

Durante a execução pelo operador, o terminal apresentará o seguinte comportamento interativo:

```text
================================================================
MEDICINA 2029 — H2.02: VALIDAÇÃO REAL DE CONEXÕES (STAGING)
================================================================
Projeto Alvo:          ynfocaorhadizlvbnzrt
Session Pooler:        aws-0-us-east-1.pooler.supabase.com:5432
Transaction Pooler:    aws-0-us-east-1.pooler.supabase.com:6543
Roles a Validar:       medicina_app, medicina_auth, medicina_worker
================================================================

Orientações de Segurança:
  • As senhas digitadas NÃO serão exibidas na tela (sem eco).
  • Nenhuma senha será registrada em logs ou persistida em disco.
  • Operação 100% somente-leitura (nenhum dado será modificado no banco).
  • Pressione Ctrl+C a qualquer momento para cancelar com segurança.

[Etapa 1/3] Credencial para medicina_app (Server Actions / Runtime):
🔑 Digite a senha de medicina_app: [ENTRADA OCULTA]

[Etapa 2/3] Credencial para medicina_auth (Autenticação NextAuth):
🔑 Digite a senha de medicina_auth: [ENTRADA OCULTA]

[Etapa 3/3] Credencial para medicina_worker (Worker Assíncrono / Ingestão):
🔑 Digite a senha de medicina_worker: [ENTRADA OCULTA]

================================================================
MEDICINA 2029 — H2.02: VALIDAÇÃO REAL DAS CONEXÕES TÉCNICAS
================================================================
Host Alvo:             aws-0-us-east-1.pooler.supabase.com
Projeto Alvo:          ynfocaorhadizlvbnzrt
Session Pooler:        Porta 5432 (medicina_app, medicina_auth, medicina_worker)
Transaction Pooler:    Porta 6543 (medicina_app, medicina_auth - prepare=false)
Escopo:                Somente-Leitura (SELECT passivo, TLS estrito)
================================================================

--- FASE 1: Validação no Session Pooler (porta 5432) ---
   ✅ Role [medicina_app    ]: Conectado como "medicina_app" no banco "postgres"
      • Atributos pg_roles: LOGIN=true | SUPER=false | BYPASSRLS=false
      • Menor privilégio:  Leitura OK (X perfis) | password_hash blindado
   ✅ Role [medicina_auth   ]: Conectado como "medicina_auth" no banco "postgres"
      • Atributos pg_roles: LOGIN=true | SUPER=false | BYPASSRLS=false
      • Menor privilégio:  Execução exclusiva autenticar_por_email OK (privilégios de catálogo confirmados)
   ✅ Role [medicina_worker ]: Conectado como "medicina_worker" no banco "postgres"
      • Atributos pg_roles: LOGIN=true | SUPER=false | BYPASSRLS=false
      • Menor privilégio:  Leitura fila acervo_jobs OK (0 jobs)

--- FASE 2: Validação no Transaction Pooler (porta 6543) ---
Nota: medicina_worker opera exclusivamente na porta 5432 (Session Pooler).

   ✅ Role [medicina_app    ]: Porta 6543 (Transaction Pooler) validada com sucesso!
      • Modo do Driver: prepare=false (sem prepared statements)
      • Transação:      SET LOCAL RLS claim.sub OK | Timeout: 15000ms | Leitura: X perfis
   ✅ Role [medicina_auth   ]: Porta 6543 (Transaction Pooler) validada com sucesso!
      • Modo do Driver: prepare=false (sem prepared statements)
      • Transação:      SET LOCAL Timeout: 10000ms | RPC autenticar_por_email OK (privilégios de catálogo confirmados)

================================================================
🎉 TODAS AS ROLES TÉCNICAS FORAM VALIDADAS COM SUCESSO!
   • Porta 5432 (Session Pooler): 3/3 roles autenticadas e com atributos corretos
   • Porta 6543 (Transaction Pooler): 2/2 roles validadas com prepare=false e SET LOCAL
   • Identidade: current_user e session_user conferidos
   • Menor Privilégio: rolcanlogin=true, rolsuper=false, rolbypassrls=false
================================================================
```

---

## 8. Salvaguardas de Não Execução Remota

Em cumprimento estrito às instruções da ordem H2.02-R:
- **Nenhuma conexão ao Supabase remoto foi realizada pelo assistente.**
- **Nenhuma migração ou credencial foi alterada.**
- **Nenhum seed, backup ou worker foi executado.**
- **Nenhum commit, push ou deploy foi realizado no repositório git.**
- O assistente permanece aguardando a autorização humana para a execução pelo operador no Terminal.
