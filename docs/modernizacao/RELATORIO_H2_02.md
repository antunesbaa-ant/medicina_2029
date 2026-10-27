# MEDICINA 2029 — H2.02
## Relatório de Validação das Conexões Técnicas e Integridade das Roles

**Data:** 26 de Outubro de 2026  
**Ambiente:** Supabase Staging (`medicina-2029-staging`)  
**Project Ref:** `ynfocaorhadizlvbnzrt`  
**Host do Pooler:** `aws-0-us-east-1.pooler.supabase.com`  
**Portas de Conexão:** 
- Porta `5432` (Session Pooler): `medicina_app`, `medicina_auth`, `medicina_worker`
- Porta `6543` (Transaction Pooler): `medicina_app`, `medicina_auth` (com `prepare: false` e `SET LOCAL`)
**Certificado Raiz TLS:** `~/Downloads/prod-ca-2021.crt`  
**Fingerprint Canônico SHA-256:** `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`  
**Script Oficial de Validação:** [`scripts/db/verify-staging-roles-connection.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/verify-staging-roles-connection.mjs)  
**Status da Preparação:** **APROVADO LOCALMENTE (38/38 TESTES VÁLIDOS, AGUARDANDO AUTORIZAÇÃO HUMANA)**

---

## 1. Contexto e Objetivo da Etapa H2.02

As 9 migrações estruturais canônicas foram instaladas e auditadas no Supabase Staging. As senhas de autenticação das três roles técnicas (`medicina_app`, `medicina_auth` e `medicina_worker`) foram provisionadas via utilitário administrativo parametrizado.

O objetivo da etapa **H2.02** é preparar e comprovar a segurança de um teste interativo, estritamente passivo e **somente-leitura**, para validar a autenticação real de cada role individualmente, atestando:
1. **Identidade Conectada:** Confirmação de que `current_user` e `session_user` correspondem à role autenticada.
2. **Integridade de Catálogo (`pg_roles`):** Confirmação rigorosa de `rolcanlogin = true`, `rolsuper = false` e `rolbypassrls = false`.
3. **Session Pooler (Porta 5432):** Teste de conectividade e menor privilégio para as três roles.
4. **Transaction Pooler (Porta 6543):** Teste de compatibilidade para `medicina_app` e `medicina_auth` com prepared statements desativados (`prepare: false`) e injeção de contexto transacional via `SET LOCAL`.
5. **Segurança de Segredos:** Entrada de senhas oculta sem eco, nenhuma persistência em logs ou disco, e purga de memória.
6. **TLS Estrito:** Rejeição de certificados não confiáveis ou com divergência de fingerprint.

---

## 2. Arquitetura dos Poolers e Segregação de Roles

O Supabase gerencia o acesso ao PostgreSQL através do PgBouncer em dois modos distintos de pooling:

```
                                  ┌────────────────────────────────────────┐
                                  │   Supabase Cloud Staging (AWS us-east-1)│
                                  │   Project Ref: ynfocaorhadizlvbnzrt    │
                                  └──────────────────┬─────────────────────┘
                                                     │
                         ┌───────────────────────────┴───────────────────────────┐
                         │                                                       │
                         ▼                                                       ▼
       ┌───────────────────────────────────┐                   ┌───────────────────────────────────┐
       │     Session Pooler (Porta 5432)   │                   │  Transaction Pooler (Porta 6543)  │
       │     Modo: Conexão Dedicada / Sessão│                   │     Modo: Transação / PgBouncer   │
       ├───────────────────────────────────┤                   ├───────────────────────────────────┤
       │ Roles Suportadas:                 │                   │ Roles Suportadas:                 │
       │ • medicina_worker (exclusivo)     │                   │ • medicina_app                    │
       │ • medicina_app                    │                   │ • medicina_auth                   │
       │ • medicina_auth                   │                   │                                   │
       │ Características:                  │                   │ Características:                  │
       │ - Suporte a LISTEN / NOTIFY       │                   │ - Alto throughput / concorrência  │
       │ - Locks de sessão e SKIP LOCKED   │                   │ - prepare: false compulsório      │
       │ - Estado persiste na sessão       │                   │ - Contexto isolado via SET LOCAL  │
       └───────────────────────────────────┘                   └───────────────────────────────────┘
```

### 2.1 Por que `medicina_worker` opera exclusivamente na porta 5432?
O worker assíncrono executa o processamento em lote da fila `public.acervo_jobs`, demandando recursos que são incompatíveis com o Transaction Pooler do PgBouncer:
- Operações com `FOR UPDATE SKIP LOCKED` mantidas abertas durante etapas de processamento;
- Conexões de longa permanência para polling e escuta de eventos;
- Transações com isolamento de sessão estável.
No Transaction Pooler (porta 6543), o PgBouncer devolve a conexão ao pool imediatamente ao término de cada comando ou transação, corrompendo qualquer estado ou lock mantido a nível de sessão. Portanto, a role `medicina_worker` foi **arquitetada exclusivamente para a porta 5432**.

### 2.2 Por que `medicina_app` e `medicina_auth` utilizam a porta 6543 com `prepare: false`?
As Server Actions do Next.js e o runtime da aplicação abrem requisições curtas de alta concorrência:
- No Transaction Pooler, prepared statements nomeados (`PREPARE stmt`) falham porque uma transação subsequente pode ser roteada para outro backend do PostgreSQL onde o prepared statement não foi preparado (`prepared statement does not exist`). O driver `postgres.js` deve operar com `prepare: false`.
- O contexto de autorização e usuário autenticado (como `request.jwt.claim.sub` e `statement_timeout`) deve ser obrigatoriamente injetado através de comandos `SET LOCAL` dentro de blocos transacionais explícitos (`BEGIN ... COMMIT`). Ao executar o `COMMIT`, o PostgreSQL descarta compulsoriamente os valores de `SET LOCAL`, garantindo que a conexão reutilizada pelo pooler volte perfeitamente limpa para o próximo cliente.

---

## 3. Implementação do Script de Validação (`verify-staging-roles-connection.mjs`)

O script [`scripts/db/verify-staging-roles-connection.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/verify-staging-roles-connection.mjs) foi atualizado para cumprir rigorosamente todos os 8 requisitos estabelecidos:

### 3.1 Fase 1: Validação no Session Pooler (Porta 5432)
Para cada uma das 3 roles técnicas (`medicina_app`, `medicina_auth`, `medicina_worker`):
1. **Conexão TLS Estrita:** Valida o certificado CA raiz (`prod-ca-2021.crt`), confere o fingerprint canônico e aplica `rejectUnauthorized: true`.
2. **Identidade Conectada:** Executa:
   ```sql
   SELECT current_user AS connected_user, session_user AS session_user, current_database() AS database_name;
   ```
   Valida que `connected_user === roleName`, `session_user === roleName` e `database_name === 'postgres'`.
3. **Catálogo de Segurança (`pg_roles`):** Executa:
   ```sql
   SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
   FROM pg_roles
   WHERE rolname = current_user;
   ```
   Valida rigorosamente:
   - `rolcanlogin === true` (Permissão de login ativa);
   - `rolsuper === false` (Superusuário bloqueado fail-closed);
   - `rolbypassrls === false` (Bypass de RLS estritamente proibido).
4. **Sondagem Passiva de Menor Privilégio:**
   - `medicina_app`: Lê contagem em `public.perfis`; tenta selecionar a coluna confidencial `password_hash` e comprova o bloqueio com erro de permissão.
   - `medicina_auth`: Executa a função RPC exclusiva `medicina.autenticar_por_email(...)`.
   - `medicina_worker`: Lê contagem de tarefas pendentes na fila `public.acervo_jobs`.
5. **Encerramento Imediato:** Executa `await sql.end()`.

### 3.2 Fase 2: Validação no Transaction Pooler (Porta 6543)
Para as roles de aplicação (`medicina_app` e `medicina_auth`):
1. Conecta na porta 6543 configurando `prepare: false` no driver `postgres.js`.
2. Abre bloco transacional explícito (`BEGIN`).
3. Injeta contexto transacional via `SET LOCAL`:
   - `medicina_app`: `SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000000'` e `SET LOCAL statement_timeout = '15000'`.
   - `medicina_auth`: `SET LOCAL statement_timeout = '10000'`.
4. Executa consulta passiva sob a transação, conferindo que `current_setting('request.jwt.claim.sub', true)` reflete os valores transacionais.
5. Conclui com `COMMIT` e encerra a conexão (`await sql.end()`).

### 3.3 Salvaguardas de Tratamento de Terminal e Credenciais
- **Entrada Oculta:** Utiliza o mecanismo aperfeiçoado de modo raw TTY (`process.stdin.setRawMode(true)`), garantindo que as perguntas fiquem 100% visíveis antes da digitação e que as senhas permaneçam completamente ocultas na tela (sem eco).
- **Tratamento de Sinais:** `Ctrl+C` (SIGINT) restaura o terminal e encerra o processo com exit code `130`. Entrada vazia aborta com exit code `1`.
- **Sanitização Universal:** Mensagens de erro e URLs com senhas são filtradas pela função `sanitizeError`, substituindo strings confidenciais por `:***@`.
- **Purga de Memória:** O bloco `finally` esvazia compulsoriamente todas as variáveis de senha no processo Node.js.

---

## 4. Evidências dos Testes Locais Direcionados

Antes de qualquer autorização para execução remota, toda a lógica foi submetida a baterias rigorosas de testes automatizados locais.

### 4.1 Suíte de Testes Automatizados (Vitest)
Arquivo criado: [`src/app/actions/h2_02_roles_connection_validation.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h2_02_roles_connection_validation.test.ts)

```text
 ✓ src/app/actions/h2_02_roles_connection_validation.test.ts (12 tests) 4298ms
   ✓ MEDICINA 2029 — H2.02: Validação Real das Conexões Técnicas (12)
     ✓ 1. Validação no Session Pooler (porta 5432) (3)
       ✓ 1.1 medicina_app: Conecta, valida identidade, rolcanlogin=true, rolsuper=false, rolbypassrls=false e menor privilégio (841ms)
       ✓ 1.2 medicina_auth: Conecta, valida identidade, rolcanlogin=true, rolsuper=false, rolbypassrls=false e menor privilégio (620ms)
       ✓ 1.3 medicina_worker: Conecta, valida identidade, rolcanlogin=true, rolsuper=false, rolbypassrls=false e menor privilégio (568ms)
     ✓ 2. Salvaguardas Fail-Closed de Atributos e Privilégios de Role (4)
       ✓ 2.1 Rejeita sumariamente tentativa de validação para role não autorizada (1ms)
       ✓ 2.2 Bloqueia e falha se a role for superusuário (rolsuper=true) (554ms)
       ✓ 2.3 Bloqueia e falha se a role possuir bypass de RLS (rolbypassrls=true) (1ms)
       ✓ 2.4 Bloqueia e falha se a role não tiver permissão de login (rolcanlogin=false) (0ms)
     ✓ 3. Validação no Transaction Pooler (porta 6543) (3)
       ✓ 3.1 medicina_app: Executa na porta 6543 com prepare=false e contexto SET LOCAL transacional (564ms)
       ✓ 3.2 medicina_auth: Executa na porta 6543 com prepare=false e contexto SET LOCAL transacional (568ms)
       ✓ 3.3 medicina_worker: É bloqueada de execução no Transaction Pooler (dedicada exclusivamente à porta 5432) (1ms)
     ✓ 4. Orquestrador Geral verifyAllStagingRoles e Configuração de URLs (2)
       ✓ 4.1 Constrói URLs de pooler devidamente formatadas com codificação percentual de senha (0ms)
       ✓ 4.2 Orquestrador verifyAllStagingRoles executa as duas fases com sucesso sob mocks (578ms)
```

**Resultado Consolidado da Suíte H2:**
- `h2_01_r2_launchers_validation.test.ts`: **10/10 aprovados**
- `h2_01_r_seed_allowlist_validation.test.ts`: **6/6 aprovados**
- `h2_01_r3_operational_security.test.ts`: **10/10 aprovados**
- `h2_02_roles_connection_validation.test.ts`: **12/12 aprovados**
- **Total: 38/38 testes aprovados com 100% de sucesso.**

### 4.2 Testes Interativos em Terminal TTY Real (Python PTY Simulation)
Arquivo executado: `test_tty_verify_roles.py`

| # | Cenário Testado | Ação Simulada | Resultado Observado | Status |
|---|----------------|---------------|---------------------|:------:|
| 1 | **Visibilidade de Prompts e Entrada Oculta** | Solicitação sequencial das 3 senhas em terminal TTY virtual. | Perguntas perfeitamente visíveis antes da digitação; zero caracteres das senhas vazaram na tela. | **APROVADO** |
| 2 | **Interrupção Graciosa (Ctrl+C)** | Envio de sinal `\x03` no prompt de senha. | Terminal restaurado limpo, mensagem de cancelamento emitida e código de saída `130`. | **APROVADO** |
| 3 | **Entrada Vazia** | Envio de `Enter` imediato no prompt de credencial. | Rejeição imediata com mensagem orientativa e código de saída `1`. | **APROVADO** |

---

## 5. Comando Definitivo para Execução no Mac

O operador deve executar o seguinte comando no **Terminal do Mac**:

```bash
node scripts/db/verify-staging-roles-connection.mjs --ca=~/Downloads/prod-ca-2021.crt
```

---

## 6. Resultados Esperados no Terminal

Durante a execução humana, o operador verá a seguinte sequência de mensagens e prompts interativos:

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
      • Menor privilégio:  Execução exclusiva autenticar_por_email OK (0 registros)
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
      • Transação:      SET LOCAL Timeout: 10000ms | RPC autenticar_por_email OK (0 registros)

================================================================
🎉 TODAS AS ROLES TÉCNICAS FORAM VALIDADAS COM SUCESSO!
   • Porta 5432 (Session Pooler): 3/3 roles autenticadas e com atributos corretos
   • Porta 6543 (Transaction Pooler): 2/2 roles validadas com prepare=false e SET LOCAL
   • Identidade: current_user e session_user conferidos
   • Menor Privilégio: rolcanlogin=true, rolsuper=false, rolbypassrls=false
================================================================
```

---

## 7. Critérios para Autorização da Execução Remota

1. **Certificado Raiz Presente:** O arquivo `~/Downloads/prod-ca-2021.crt` deve estar no diretório informado.
2. **Senhas Provisionadas em Mãos:** O operador deve possuir as senhas recém-configuradas para as três roles.
3. **Restrições Asseguradas:**
   - O teste não executa nenhum comando DDL (`CREATE`, `ALTER`, `DROP`);
   - O teste não executa nenhum comando DML de escrita (`INSERT`, `UPDATE`, `DELETE`);
   - O teste não executa backup, seed ou inicialização de workers remotos;
   - Nenhum commit, push ou deploy foi realizado.

O utilitário está completamente pronto e aguarda autorização para a execução manual pelo operador no Terminal do Mac.
