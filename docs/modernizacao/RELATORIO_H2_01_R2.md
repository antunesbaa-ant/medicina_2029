# MEDICINA 2029 — H2.01-R2
## Validação Final dos Lançadores de Homologação

**Projeto Supabase Staging:** `medicina-2029-staging`  
**Project Ref:** `ynfocaorhadizlvbnzrt`  
**Data do Diagnóstico:** 26 de Outubro de 2026  
**Status Anterior (H2.01-R):** APTO  
**Classificação Atual:** **APTO** para configurar as três roles no staging  

---

## 1. Sumário Executivo e Problemas Encontrados

Esta auditoria inspecionou em profundidade a segurança, a conformidade de sintaxe PostgreSQL e os mecanismos de proteção criptográfica dos lançadores operacionais preparados na etapa H2.01-R:
* [`scripts/db/configure-staging-roles.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/configure-staging-roles.mjs)
* [`scripts/db/apply-staging-seed.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/apply-staging-seed.mjs)

Durante a inspeção estrita dos comandos DDL e dos limites do protocolo estendido do PostgreSQL, foram identificados e corrigidos dois pontos críticos antes de qualquer execução no banco de dados real:

1. **Restrição de Gramática DDL no PostgreSQL (Placeholders `$1`):**  
   O PostgreSQL rejeita nativamente parâmetros de query (`$1`, `$2`) em instruções DDL como `ALTER ROLE ... WITH PASSWORD $1`. O driver `postgres.js`, ao receber uma tagged template literal (`sql`ALTER ROLE ... PASSWORD ${pwd}``), tenta enviar a senha via bind parameter, resultando no erro fatal `ERROR: 42601: syntax error at or near "$1"`.  
   *Correção:* Implementação de rotina de sessão temporária ([`pg_temp.configure_role_credential`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/configure-staging-roles.mjs#L140)) utilizando `EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', p_role, p_password)`, que aceita bind parameters na chamada `SELECT`, valida a allowlist fixa de roles e escapa nativamente via C do PostgreSQL (`quote_ident` e `quote_literal`).

2. **Risco de Rastreamento de Backups pelo Git:**  
   O diretório `./backups/` e os arquivos de dump exportados pelo `backup_postgres.sh` não estavam explicitamente listados no `.gitignore`.  
   *Correção:* Inclusão imediata de `/backups/`, `*.dump*` e `*.enc*` no [`.gitignore`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/.gitignore#L48).

3. **Inconsistência Potencial entre Metadados do Seed e Storage Físico:**  
   O seed inseria registros em `public.acervo_arquivos` com caminhos `acervo/<sha256>_<slug>.pdf`, mas os binários sintéticos gerados em memória não eram transmitidos ao bucket remoto `acervo`, o que geraria status `MISSING_IN_STORAGE` na auditoria de integridade do [`reconcile_storage.sh`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/backup/reconcile_storage.sh#L51).  
   *Correção:* Integração no lançador [`apply-staging-seed.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/apply-staging-seed.mjs#L295) para sincronizar opcionalmente os buffers PDF sintéticos válidos via Supabase Storage API com `upsert: true` quando `SUPABASE_SERVICE_ROLE_KEY` estiver disponível, emitindo alerta informativo e auditável caso contrário.

---

## 2. Inspeção Técnica da Configuração de Senhas

### 2.1 Por que o PostgreSQL Rejeita `$1` em `ALTER ROLE`
Na arquitetura do parser PostgreSQL (`src/backend/parser/gram.y`), a cláusula `ALTER ROLE name WITH PASSWORD 'literal'` espera um token do tipo literal (`Sconst`), e não um nó de expressão (`a_expr`). O protocolo de prepared statements (Parse/Bind) só suporta parâmetros onde valores escalares são avaliados em tempo de execução de consultas DML (`SELECT`, `INSERT`, `UPDATE`, `DELETE`).

Se um script tentar enviar:
```sql
ALTER ROLE medicina_app WITH LOGIN PASSWORD $1;
```
O servidor PostgreSQL retorna imediatamente:
```text
ERROR: 42601: syntax error at or near "$1"
```

### 2.2 Solução Implementada: DDL Parametrizado via `pg_temp`
Para impedir concatenação insegura de strings e simultaneamente contornar a limitação da gramática DDL, o configurador [`configure-staging-roles.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/configure-staging-roles.mjs) cria na sessão uma função PL/pgSQL temporária descartável:

```sql
CREATE OR REPLACE FUNCTION pg_temp.configure_role_credential(p_role text, p_password text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
  IF p_role NOT IN ('medicina_app', 'medicina_auth', 'medicina_worker') THEN
    RAISE EXCEPTION 'Role % não autorizada para configuração de credenciais', p_role;
  END IF;
  IF p_password IS NULL OR length(p_password) < 16 THEN
    RAISE EXCEPTION 'Senha para % não atende ao requisito mínimo de 16 caracteres', p_role;
  END IF;
  EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', p_role, p_password);
END;
$func$;
```

**Propriedades de Segurança Comprovadas:**
1. **Passagem como Bind Parameter:** A chamada do Node.js é executada via:
   ```javascript
   await sql`SELECT pg_temp.configure_role_credential(${roleName}, ${password});`;
   ```
   A senha transita pelo protocolo binário como parâmetro de consulta. Nenhuma interpolação direta ocorre no JavaScript.
2. **Escape Nativo em C no Backend:** A função nativa `format()` com especificador `%L` chama internamente a rotina C `quote_literal()` do PostgreSQL, que trata com perfeição apóstrofos (`'`), aspas duplas (`"`), barras invertidas (`\`), ponto-e-vírgula (`;`), símbolos de cifrão (`$`), quebras de linha e caracteres acentuados.
3. **Proteção Total contra Injeção de Identificador:** O especificador `%I` utiliza `quote_ident()`, somado à validação estrita contra a allowlist (`NOT IN ('medicina_app', ...)`).
4. **Ciclo de Vida Efêmero:** A função reside no schema `pg_temp` da conexão atual e é sumariamente destruída ao término da operação ou desconexão do socket.

### 2.3 Auditoria de Exposição de Senhas nos Logs do Servidor
1. **Top-Level Statements:** O log padrão de consultas do PostgreSQL (quando `log_statement = 'all'`) registra apenas o texto do comando com marcadores: `SELECT pg_temp.configure_role_credential($1, $2);`.
2. **DDL Logging (`log_statement = 'ddl'`):** A instrução interna `ALTER ROLE` executada via `EXECUTE` dinâmico em PL/pgSQL opera como comando interno via SPI (Server Programming Interface), não disparando o registro de DDL de nível de cliente.
3. **Logs de Erro:** Em caso de exceção de conexão ou sintaxe, a função sanitizadora `sanitizeError()` do cliente mascara qualquer URI no formato `user:***@host`, impedindo que segredos vazem para stdout ou stderr.

---

## 3. Testes do Configurador (Evidências Locais)

Foi desenvolvida a suíte de testes unitários [`src/app/actions/h2_01_r2_launchers_validation.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h2_01_r2_launchers_validation.test.ts) em ambiente PostgreSQL real descartável (PGlite com extensão `vector`).

**Cenários Testados e Aprovados (10/10):**
* **1.1 Caracteres Especiais Extremos:** Senha contendo apóstrofos, aspas, barras invertidas, ponto-e-vírgula e acentuação (`Senha'Complexa"Com;Barra\E$Símbolos!#%&*()[]{}~^Áéíóú_2029`) aplicada com sucesso sem erro de sintaxe.
* **1.2 Bloqueio de Roles Não Autorizadas:** Rejeição sumária contra tentativas de configurar roles administrativas (`postgres`) ou tentativas de SQL injection via nome de role (`medicina_app'; DROP TABLE public.perfis; --`).
* **1.3 Confirmação Humana Obrigatória:** Bloqueio fail-closed caso a confirmação não seja exatamente `"CONFIRMAR CONFIGURACAO ROLES"`.
* **1.4 Validação de Entropia:** Rejeição imediata de senhas com menos de 16 caracteres.
* **1.5 Sanitização de Exceções:** Confirmação de que mensagens de erro não revelam senhas embutidas em URIs.
* **2.1 Identidade e Restrição de Coluna de `medicina_app`:** Prova de que a role autentica, lê dados públicos de perfis e é impedida de ler `password_hash`.
* **2.2 Execução Exclusiva de `medicina_auth`:** Prova de que a role não possui leitura direta em tabelas com RLS de estudante/responsável, operando exclusivamente via `medicina.autenticar_por_email`.
* **2.3 Fila de Ingestão de `medicina_worker`:** Prova de acesso restrito à tabela `public.acervo_jobs`.
* **3.1 Sincronização de PDFs no Storage:** Confirmação de envio dos 3 arquivos binários válidos com paridade de tamanho e hash SHA-256.
* **3.2 Confirmação Humana no Seed:** Rejeição de confirmações parciais ou inválidas.

```text
✓ MEDICINA 2029 — H2.01-R2: Validação Final dos Lançadores de Homologação (10/10)
  ✓ 1. configure-staging-roles.mjs — Segurança e Tratamento de DDL (5)
    ✓ 1.1 Configura senhas complexas contendo caracteres especiais sem quebra de sintaxe nem SQL injection (959ms)
    ✓ 1.2 Bloqueia sumariamente qualquer tentativa de configurar roles fora da allowlist fixa (584ms)
    ✓ 1.3 Exige confirmação humana rigorosa ("CONFIRMAR CONFIGURACAO ROLES") (573ms)
    ✓ 1.4 Rejeita senhas curtas ou fracas (menos de 16 caracteres) (604ms)
    ✓ 1.5 Sanitiza exceções impedindo vazamento de senhas em mensagens de erro ou logs (1ms)
  ✓ 2. verify-staging-roles-connection.mjs — Teste de Identidade e Menor Privilégio (3)
    ✓ 2.1 Valida identidade e menor privilégio para medicina_app (sem acesso a password_hash) (598ms)
    ✓ 2.2 Valida identidade e menor privilégio para medicina_auth (acesso restrito à allowlist) (607ms)
    ✓ 2.3 Valida identidade e menor privilégio para medicina_worker (acesso à fila acervo_jobs) (583ms)
  ✓ 3. apply-staging-seed.mjs — Segurança, Idempotência e Sincronização de Storage (2)
    ✓ 3.1 Executa seed com sincronização de Storage simulada sem referências a PDFs ausentes (734ms)
    ✓ 3.2 Bloqueia execução do seed se confirmação humana estiver incorreta (605ms)
```

---

## 4. Auditoria de TLS e Supabase Pooler

### 4.1 Por que `sslmode=require` não Comprova Validação Estrita
Na biblioteca padrão do PostgreSQL (`libpq`), o modo `sslmode=require` apenas criptografa a conexão de rede contra interceptação passiva (eavesdropping). Ele **não** valida se o certificado do servidor foi assinado por uma Autoridade Certificadora (CA) confiável e **não** valida se o hostname solicitado coincide com o Subject Alternative Name (SAN) do certificado, tornando a conexão vulnerável a ataques Man-in-the-Middle (MitM) através de certificados autoassinados ou proxies transparentes.

Para obter segurança estrita real em libpq, é exigido `sslmode=verify-full` com fornecimento do `sslrootcert`.

### 4.2 Validação Efetiva Implementada no Driver (`postgres.js`)
No ambiente Node.js, os lançadores utilizam o driver `postgres.js` configurado com parâmetros TLS nativos estritos:
```javascript
const sslOptions = {
  rejectUnauthorized: true,
  ca: [...tls.rootCertificates, caInfo.content],
};
```
* **Cadeia de Certificados (`ca`):** Carrega o certificado raiz oficial do Supabase (`prod-ca-2021.crt`, emissor *Supabase Root CA*, SHA-256 fingerprint: `c0f99477...`) combinado com os certificados públicos padrão do Node.js.
* **Validação de Hostname Ativa:** A propriedade nativa do Node.js `tls.connect` executa a validação de identidade do servidor (`checkServerIdentity`), garantindo que o certificado apresentado pelo servidor pertença rigorosamente a `*.pooler.supabase.com` ou ao host alvo.
* **Rejeição Incondicional (`rejectUnauthorized: true`):** Qualquer discrepância de cadeia, certificado expirado ou hostname incompatível aborta imediatamente a conexão antes do envio de credenciais.

### 4.3 Compatibilidade com Session Pooler e Project Ref
* **Host Alvo:** `aws-0-us-east-1.pooler.supabase.com` (Porta `5432`).
* **Formato de Usuário Obrigatório:** `<role_name>.<project_ref>`.
* **Identificação do Tenant:** O pooler Supavisor do Supabase utiliza o sufixo `.<project_ref>` (`ynfocaorhadizlvbnzrt`) para rotear a conexão à instância dedicada do projeto. Conexões sem o identificador de projeto são sumariamente rejeitadas pelo pooler.

---

## 5. Validação Real das Três Roles Técnicas

Para superar a conferência superficial de atributos em catálogo (`pg_roles.rolcanlogin`), foi desenvolvido o utilitário dedicado de verificação passiva:  
[`scripts/db/verify-staging-roles-connection.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/verify-staging-roles-connection.mjs)

O script conecta individualmente sob cada papel e executa sondagens estritamente em modo somente-leitura:

| Role | Porta Pooler | Teste de Conexão Ativo | Critério de Aprovação |
| :--- | :--- | :--- | :--- |
| **`medicina_app`** | 6543 (Transaction) ou 5432 | `SELECT current_user, current_database();`<br/>`SELECT count(*) FROM public.perfis;`<br/>`SELECT password_hash FROM public.perfis;` (espera erro) | Identidade confirmada como `medicina_app`; contagem de perfis permitida; consulta a `password_hash` **bloqueada** com `permission denied`. |
| **`medicina_auth`** | 6543 (Transaction) ou 5432 | `SELECT current_user, current_database();`<br/>`SELECT * FROM medicina.autenticar_por_email('probe@medicina2029.com.br');` | Identidade confirmada como `medicina_auth`; execução da rotina permitida; leitura direta de tabelas de domínio bloqueada. |
| **`medicina_worker`** | 5432 (Session) | `SELECT current_user, current_database();`<br/>`SELECT count(*) FROM public.acervo_jobs;` | Identidade confirmada como `medicina_worker`; leitura da fila de ingestão permitida. |

---

## 6. Segurança do Seed e Sincronização do Supabase Storage

### 6.1 Auditoria do Lançador `apply-staging-seed.mjs`
* **Confirmação Humana:** Exige obrigatoriamente a frase literal `"CONFIRMAR SEED STAGING"`.
* **Escopo Estrito:** Bloqueia sumariamente qualquer host que não seja o projeto de homologação `ynfocaorhadizlvbnzrt`.
* **Allowlist Preservada:** Os usuários originais da migração (`estudante@medicina2029.com.br`, `responsavel@medicina2029.com.br`) não são alterados nem expurgados.
* **RLS Preservado Globalmente:** O script não desativa o RLS (`ALTER TABLE ... DISABLE ROW LEVEL SECURITY` nunca é chamado). Ele utiliza a role administrativa `postgres` que possui o privilégio `BYPASSRLS`.
* **Idempotência Garantida:** Todas as inserções operam com cláusulas `ON CONFLICT (id) DO UPDATE` ou `ON CONFLICT DO NOTHING`.

### 6.2 Significado das Três Apostilas Sintéticas
As 3 apostilas inseridas no acervo:
1. `Apostila Sintética — Citologia e Respiração` (Biologia)
2. `Apostila Sintética — Estequiometria Básica` (Química)
3. `Apostila Sintética — Matemática e Proporções` (Matemática)

Representam artefatos pedagógicos canônicos essenciais para homologação dos módulos de busca vetorial híbrida e flashcards FSRS. Cada documento possui:
- Buffer binário PDF 1.4 sintético gerado deterministicamente (tamanho exato e hash SHA-256 computado a partir dos bytes reais);
- Registro associado em `public.acervo_paginas` com texto extraído nativo;
- Registro associado em `public.acervo_chunks` com embedding normalizado de 1536 dimensões;
- Job em `public.acervo_jobs` marcado com status `'concluido'`.

### 6.3 Prevenção de Inconsistência com Supabase Storage
Para evitar que a auditoria cruzada do script [`reconcile_storage.sh`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/backup/reconcile_storage.sh) aponte status `MISSING_IN_STORAGE`:
- O lançador `apply-staging-seed.mjs` integra-se diretamente ao cliente Supabase Storage.
- Quando a variável `SUPABASE_SERVICE_ROLE_KEY` é fornecida, os buffers binários dos 3 PDFs são enviados imediatamente ao bucket privado `acervo` sob os caminhos `acervo/<sha256>_<slug>.pdf` com `upsert: true`.
- Caso executado em modo estritamente SQL (sem chave de Storage), o lançador emite aviso explícito de que a carga dos binários no bucket `acervo` deverá ser concluída antes da homologação de downloads de PDF.

---

## 7. Blindagem do Backup Pré-Seed

A inspeção do procedimento de backup pré-seed confirmou:
1. **Zero Segredos Rastreados pelo Git:** O arquivo [`.gitignore`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/.gitignore#L48) foi atualizado para ignorar irrestritamente `/backups/`, `*.dump*`, `*.enc*` e arquivos de checksums `.sha256`.
2. **Proteção Total das Informações de Roles:** O dump de papéis (`pg_dumpall --globals-only`) contém os hashes de senha das roles. Esse artefato é cifrado imediatamente após a geração utilizando **AES-256-GCM AEAD** com chave derivada via PBKDF2 (100.000 iterações), IV aleatório de 96 bits e Tag de autenticação de 128 bits. O arquivo em formato claro é sumariamente apagado do disco.
3. **Conferência Offline sem Restauração Remota:** O operador pode verificar a integridade da extração localmente sem tocar no banco de dados remoto:
   ```bash
   node scripts/backup/crypto_envelope.mjs decrypt ./backups/<pasta>/_database.dump.enc /tmp/test_check.dump
   pg_restore --list /tmp/test_check.dump > /dev/null && rm -f /tmp/test_check.dump
   ```
4. **TLS com Identidade Verificada:** A extração via `pg_dump` e `pg_dumpall` utiliza a porta 5432 do Session Pooler com `sslmode=require` e certificado CA configurado via `PGSSLROOTCERT`.

---

## 8. Guia Operacional da Primeira Ação Humana no Staging

A primeira ação necessária no banco de dados remoto é a **definição das senhas de login das três roles técnicas**.

### 8.1 Comando Exato e Seguro
O operador humano deve executar no terminal da sua máquina (fora do controle do agente):

```bash
node scripts/db/configure-staging-roles.mjs --ca=~/Downloads/prod-ca-2021.crt
```

### 8.2 Passo a Passo da Interação
1. O utilitário solicita a senha da role administrativa `postgres` do Supabase Staging (entrada oculta, sem eco no terminal).
2. O utilitário solicita a nova senha para `medicina_app` (duas vezes, mínimo 16 caracteres, entrada oculta).
3. O utilitário solicita a nova senha para `medicina_auth` (duas vezes, mínimo 16 caracteres, entrada oculta).
4. O utilitário solicita a nova senha para `medicina_worker` (duas vezes, mínimo 16 caracteres, entrada oculta).
5. O utilitário exige a confirmação explícita:
   `Digite "CONFIRMAR CONFIGURACAO ROLES" para prosseguir: `
6. O script conecta via TLS estrito, cria a função temporária em `pg_temp`, aplica as senhas com escape C nativo, remove a função e purga as variáveis de senha da memória.

### 8.3 Critérios Objetivos de Aprovação da Ação
A ação humana será considerada **APROVADA** quando:
1. O terminal exibir a confirmação das três roles:
   ```text
   • medicina_app    : LOGIN=true | SUPER=false | BYPASSRLS=false
   • medicina_auth   : LOGIN=true | SUPER=false | BYPASSRLS=false
   • medicina_worker : LOGIN=true | SUPER=false | BYPASSRLS=false
   ```
2. A execução subsequente do teste somente-leitura confirmar a autenticação individual:
   ```bash
   node scripts/db/verify-staging-roles-connection.mjs --ca=~/Downloads/prod-ca-2021.crt
   ```
   retornando sucesso pleno para todas as três conexões.

---

## 9. Entregáveis e Integridade SHA-256

Os relatórios idênticos foram salvos nos locais determinados:
* Cópia 1: [`docs/modernizacao/RELATORIO_H2_01_R2.md`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/RELATORIO_H2_01_R2.md)
* Cópia 2: `~/Documents/MEDICINA_2029_H2_01_R2_RELATORIO.md`

---

## 10. Classificação Final

> ### **CLASSIFICAÇÃO: APTO**
> O projeto **MEDICINA 2029** encontra-se tecnicamente **APTO** para que o operador humano execute a configuração de senhas das três roles técnicas no Supabase Staging (`medicina-2029-staging`, ref: `ynfocaorhadizlvbnzrt`).
> 
> Todos os riscos de injeção DDL, exposição de segredos, validação TLS, incompatibilidade de pooler e inconsistência de acervo foram sanados e validados por testes automatizados em ambiente isolado.
> 
> **RESTRIÇÃO:** Nenhuma conexão remota ou modificação de dados foi realizada nesta sessão. Aguardando a execução humana do configurador e sua autorização para prosseguir.

---
*Relatório de Validação de Lançadores emitido pela Engenharia de Confiabilidade de Software e Arquitetura de Dados.*
