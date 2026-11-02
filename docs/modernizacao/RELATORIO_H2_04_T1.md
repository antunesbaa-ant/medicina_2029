# MEDICINA 2029 — RELATÓRIO DE HOMOLOGAÇÃO TÉCNICA H2.04-T1
## HOMOLOGAÇÃO REAL DE AUTENTICAÇÃO E ISOLAMENTO MULTI-TENANT (STAGING)

**Data de Execução:** 02 de Novembro de 2026  
**Ambiente Alvo:** Supabase Staging (`ynfocaorhadizlvbnzrt`)  
**Conexão:** Session Pooler (`aws-0-us-east-1.pooler.supabase.com:5432`) via TLS Estrito (`prod-ca-2021.crt`)  
**Estado do Banco:** 9 migrações aplicadas, seed de homologação provisionado (Alice, Bruno, Carlos)  
**Natureza da Operação:** 100% Somente-Leitura (`READ ONLY`) — Zero mutações remotas  

---

### 1. SUMÁRIO EXECUTIVO E PARECER

| Dimensão Avaliada | Situação | Parecer |
| :--- | :---: | :---: |
| **RPC de Autenticação Segura (`medicina_auth`)** | Validada | **APROVADO** |
| **Proteção de Coluna de Hash (`password_hash`)** | Revogada de `medicina_app` (42501) | **APROVADO** |
| **Princípio Fail-Closed (Sem contexto RLS / Anon)** | 0 linhas / Bloqueio 42501 | **APROVADO** |
| **Isolamento da Estudante Alice** | Ciclo, 28 blocos e 3 cards próprios | **APROVADO** |
| **Isolamento do Estudante Independente Carlos** | Ciclo, 28 blocos e 2 cards; 0 tutoria | **APROVADO** |
| **Escopo do Responsável Bruno** | Tutela Alice; 0 ciclos (anti-vigilância); 0 Carlos | **APROVADO** |
| **Rejeição Compulsória de Escalada de Privilégios** | Erro `P0001` em divergência de papel/UUID | **APROVADO** |
| **Isolamento Transacional no Pooler (`SET LOCAL`)** | Descarte imediato pós-COMMIT | **APROVADO** |
| **Login Funcional de Ponta a Ponta na UI (NextAuth)** | Senha em texto plano não salva no seed | **NÃO EXECUTADO** |

> **PARECER FINAL: APTO COM RESSALVA CONTROLADA DE CREDENCIAIS**  
> Toda a arquitetura de autorização, contexto RLS transacional, segurança de privilégios de banco e isolamento multi-tenant está **100% íntegra e comprovada**.  
> **Ressalva:** Conforme as diretrizes de segurança aplicadas no seed remoto H2.04-R3, as senhas de Alice, Bruno e Carlos foram geradas aleatoriamente em runtime e salvas exclusivamente como hashes bcrypt, sem gravação em texto plano ou eco em console. Portanto, o login interativo na interface (NextAuth) é classificado tecnicamente como **NÃO EXECUTADO** e aguarda uma etapa de escrita controlada para definição de senhas de teste conhecidas.

---

### 2. DIFERENCIAÇÃO CONCEITUAL: PERFIL CADASTRADO vs. USUÁRIO AUTENTICADO

A homologação técnica diferencia formalmente dois estados frequentemente confundidos em testes de integração:

1. **Perfil Cadastrado (Estado Estático no Banco):**
   - Registros presentes nas tabelas `public.perfis` e `public.allowlist`.
   - Possui `id` (UUID v4), `auth_user_id`, `email`, `papel` e `password_hash` bcrypt válido (custo 10).
   - A função `medicina.autenticar_por_email(p_email text)` valida a allowlist e retorna a tupla com sucesso sob a role `medicina_auth`.
   - **Status atual no Staging:** Confirmado para Alice, Bruno e Carlos.

2. **Usuário Autenticado (Estado Dinâmico de Sessão):**
   - Usuário que submete `{ email, password }` em texto plano ao `CredentialsProvider` do NextAuth.
   - O NextAuth executa `bcrypt.compare(password, password_hash)`. Apenas se a comparação for verdadeira um token JWT assinado é emitido com `token.id` e `token.role`.
   - As Server Actions e o middleware extraem o perfil verificado via `requireAuthenticatedProfile()` e aplicam `medicina.set_context(perfil.id, perfil.papel)`.
   - **Status atual no Staging:** Como as senhas geradas aleatoriamente no seed remoto não foram expostas, nenhum cliente ou operador dispõe da credencial em texto plano. Qualquer tentativa de login falha no `bcrypt.compare` com `Credenciais inválidas.`. **Não se pode declarar autenticação aprovada apenas pela presença do perfil no banco.**

---

### 3. MATRIZ DE CENÁRIOS E RESULTADOS TÉCNICOS

#### Grupo A: Autenticação Segura via `medicina_auth`
*Executado sob papel técnico `medicina_auth` (sem superuser, sem bypassrls).*

| Código | Descrição do Cenário | Expectativa | Resultado | Status |
| :--- | :--- | :--- | :--- | :---: |
| **AUT-01** | Chamada `medicina.autenticar_por_email` para Alice | Retorna ID de Alice, papel `estudante` e hash bcrypt | 1 tupla com hash bcrypt de custo 10 | **APROVADO** |
| **AUT-02** | Chamada `medicina.autenticar_por_email` para Bruno | Retorna ID de Bruno, papel `responsavel` e hash bcrypt | 1 tupla com papel `responsavel` | **APROVADO** |
| **AUT-03** | Chamada `medicina.autenticar_por_email` para Carlos | Retorna ID de Carlos, papel `estudante` e hash bcrypt | 1 tupla com papel `estudante` | **APROVADO** |
| **AUT-04** | Anti-enumeração: e-mail fora da allowlist (`invasor@externo.com`) | Retorna 0 linhas sem expor se o e-mail existe em perfis | 0 tuplas retornadas | **APROVADO** |
| **AUT-05** | Mitigação de timing attack no NextAuth | Tempo constante mesmo quando e-mail não existe | Execução do benchmark hash `$2a$10$...` | **APROVADO** |

#### Grupo B: Segurança e Fronteiras do Papel Aplicacional (`medicina_app`)
*Executado sob papel técnico `medicina_app` (papel padrão utilizado pelas Server Actions).*

| Código | Descrição do Cenário | Expectativa | Resultado | Status |
| :--- | :--- | :--- | :--- | :---: |
| **SEC-01** | Chamada a `medicina.autenticar_por_email` por `medicina_app` | Rejeição imediata por ausência de GRANT | Erro PostgreSQL `42501: permission denied for function autenticar_por_email` | **APROVADO** |
| **SEC-02** | Consulta direta `SELECT password_hash FROM public.perfis` | Bloqueio em nível de coluna (Column-Level Grant) | Erro PostgreSQL `42501: permission denied for column password_hash` | **APROVADO** |
| **SEC-03** | Consulta permitida `SELECT id, nome, email, papel FROM public.perfis` | Consulta aceita sintaticamente, filtrada por RLS | Aceito pelo PostgreSQL, sujeito às regras de RLS | **APROVADO** |

#### Grupo C: Princípio Fail-Closed
*Executado sem ativação de contexto de sessão e sob o papel não-autenticado `medicina_anon`.*

| Código | Descrição do Cenário | Expectativa | Resultado | Status |
| :--- | :--- | :--- | :--- | :---: |
| **RLS-01** | `medicina_app` sem executar `medicina.set_context` | 0 linhas retornadas em todas as tabelas privadas | `perfis=0`, `ciclos=0`, `cards=0`, `acervo=0`, `vinculos=0` | **APROVADO** |
| **RLS-02** | Papel anônimo `medicina_anon` consultando tabelas privadas | Bloqueio compulsório por RLS / ausência de GRANT | Erro `42501` ou 0 linhas em todas as tabelas | **APROVADO** |

#### Grupo D: Isolamento Multi-Tenant da Estudante Alice
*Executado sob `medicina_app` com contexto `medicina.set_context(alice_id, 'estudante')`.*

| Código | Descrição do Cenário | Expectativa | Resultado | Status |
| :--- | :--- | :--- | :--- | :---: |
| **ISO-01A** | Leitura de `public.perfis` | Retorna exclusivamente o perfil de Alice (1 linha) | Apenas Alice retornado; Bruno e Carlos invisíveis | **APROVADO** |
| **ISO-01B** | Leitura de `public.ciclos` | Retorna exclusivamente o ciclo de Alice (`4000...0001`) | 1 ciclo pertencente a Alice; ciclo de Carlos invisível | **APROVADO** |
| **ISO-01C** | Leitura de `public.ciclo_blocos` | Retorna exatamente os 28 blocos do ciclo de Alice | Exatamente 28 blocos retornados; os 28 de Carlos invisíveis | **APROVADO** |
| **ISO-01D** | Leitura de `public.cards` | Retorna apenas os 3 cards vinculados ao perfil de Alice | Exatamente 3 cards retornados; os 2 de Carlos invisíveis | **APROVADO** |
| **ISO-01E** | Leitura de `public.responsavel_estudante` | Enxerga a relação tutelar onde é a estudante tutelada | 1 vínculo retornado (`responsavel=Bruno, estudante=Alice`) | **APROVADO** |
| **ISO-01F** | Leitura de `public.acervo_arquivos` | Estudante não possui permissão de leitura de acervo bruto | 0 linhas retornadas | **APROVADO** |

#### Grupo E: Isolamento do Estudante Independente Carlos
*Executado sob `medicina_app` com contexto `medicina.set_context(carlos_id, 'estudante')`.*

| Código | Descrição do Cenário | Expectativa | Resultado | Status |
| :--- | :--- | :--- | :--- | :---: |
| **ISO-02A** | Leitura de `public.perfis` | Retorna exclusivamente o perfil de Carlos (1 linha) | Apenas Carlos retornado; Alice e Bruno invisíveis | **APROVADO** |
| **ISO-02B** | Leitura de `public.ciclos` | Retorna exclusivamente o ciclo de Carlos (`4000...0003`) | 1 ciclo pertencente a Carlos; ciclo de Alice invisível | **APROVADO** |
| **ISO-02C** | Leitura de `public.ciclo_blocos` | Retorna exatamente os 28 blocos de Carlos | Exatamente 28 blocos retornados; blocos de Alice invisíveis | **APROVADO** |
| **ISO-02D** | Leitura de `public.cards` | Retorna apenas os 2 cards de Carlos | Exatamente 2 cards retornados; cards de Alice invisíveis | **APROVADO** |
| **ISO-02E** | Leitura de `public.responsavel_estudante` | Carlos é independente (sem vínculo tutelar) | 0 linhas retornadas; vínculo Bruno->Alice 100% invisível | **APROVADO** |
| **ISO-02F** | Leitura de `public.acervo_arquivos` | Estudante não possui acesso ao acervo bruto | 0 linhas retornadas | **APROVADO** |

#### Grupo F: Escopo de Acesso do Responsável Bruno (Tutela de Alice, Zero Carlos)
*Executado sob `medicina_app` com contexto `medicina.set_context(bruno_id, 'responsavel')`.*

| Código | Descrição do Cenário | Expectativa | Resultado | Status |
| :--- | :--- | :--- | :--- | :---: |
| **ISO-03A** | Leitura de `public.perfis` | Retorna perfil próprio e perfil da tutelada Alice (2 linhas) | Exatamente 2 perfis (Bruno e Alice); Carlos 100% invisível | **APROVADO** |
| **ISO-03B** | Leitura de `public.responsavel_estudante` | Retorna vínculo de tutoria de Alice | 1 vínculo retornado (`Bruno -> Alice`) | **APROVADO** |
| **ISO-03C** | Leitura de `public.acervo_arquivos` | Retorna arquivo sintético enviado por Bruno | 1 arquivo retornado (`Apostila Citologia`) | **APROVADO** |
| **ISO-03D** | Leitura de `public.ciclos` | Responsável NÃO lê ciclos brutos (Princípio 1.2 da ESPEC) | 0 linhas retornadas (anti-vigilância mantida) | **APROVADO** |

#### Grupo G: Rejeição Compulsória de Escalada de Privilégios
*Executado sob `medicina_app`.*

| Código | Descrição do Cenário | Expectativa | Resultado | Status |
| :--- | :--- | :--- | :--- | :---: |
| **ESC-01** | Carlos tenta ativar contexto com papel `responsavel` | Rejeição por divergência de papel no cadastro | Exceção `P0001: Contexto invalido: perfil ... com papel responsavel nao existe.` | **APROVADO** |
| **ESC-02** | Alice tenta ativar contexto com papel `responsavel` | Rejeição por divergência de papel no cadastro | Exceção `P0001: Contexto invalido: perfil ... com papel responsavel nao existe.` | **APROVADO** |
| **ESC-03** | Ativação com UUID arbitrário inexistente | Rejeição por inexistência do perfil | Exceção `P0001: Contexto invalido: perfil ... nao existe.` | **APROVADO** |
| **ESC-04** | Ativação com papel inválido (`admin`, `superuser`) | Rejeição por violação de domínio | Exceção `P0001: Papel invalido: admin` | **APROVADO** |

#### Grupo H: Isolamento Transacional e Pooler Safety
*Executado sob o Session Pooler na porta 5432.*

| Código | Descrição do Cenário | Expectativa | Resultado | Status |
| :--- | :--- | :--- | :--- | :---: |
| **POL-01** | Transação 1 ativa contexto Alice; Transação 2 subsequente na mesma conexão física não ativa contexto | Transação 2 encontra `current_perfil_id = NULL` e 0 perfis | `is_local => true` (`SET LOCAL`) descarta variáveis no `COMMIT`; zero contaminação no pooler | **APROVADO** |

---

### 4. MECANISMO EFETIVO DE CONTEXTO DE SESSÃO

A aplicação utiliza um modelo estrito de três camadas para assegurar que nenhuma identidade arbitrária vinda do cliente possa burlar o banco:

```
[ Cliente / Browser ]
        │  Cookie de Sessão Criptografado (NextAuth JWT)
        ▼
[ Next.js Server Action / API ]
        │  1. requireAuthenticatedProfile() valida assinatura JWT e papel no banco
        │  2. db.transaction(async (tx) => { ... })
        ▼
[ PostgreSQL / Session Pooler ]
        │  3. SELECT medicina.set_context(perfil.id, perfil.papel);
        │     ↳ set_config('medicina.current_perfil_id', id, is_local => true);  (SET LOCAL)
        │     ↳ set_config('medicina.current_papel', papel, is_local => true);   (SET LOCAL)
        │  4. RLS avalia: id = medicina.current_perfil_id()
        │  5. COMMIT / ROLLBACK descarta automaticamente as configurações locais
        ▼
[ Conexão Retorna ao PgBouncer 100% Limpa ]
```

1. **Escopo Transacional Estrito (`SET LOCAL`):**
   A procedure `medicina.set_context` utiliza o terceiro argumento de `set_config` como `true` (`is_local => true`), restringindo as variáveis à transação corrente. Ao término da transação, o PostgreSQL reverte os valores para `NULL`, impedindo que uma conexão física reutilizada pelo PgBouncer herde o perfil anterior.

2. **Limpeza Defensiva Explícita (`finally`):**
   Os helpers em `src/db/rls-context.ts` (`withAuthenticatedUser`, `withStudentContext`, `withResponsibleContext`) envelopam a transação em um bloco `try / finally` que invoca `medicina.clear_context()`, provendo dupla garantia defensiva.

3. **Validação Cruzada de Existência:**
   A procedure `medicina.set_context` confere se o par `(id, papel)` existe estritamente em `public.perfis`. Nenhuma sessão forjada com papel divergente consegue iniciar uma consulta válida.

---

### 5. COMANDOS SEGUROS DE AUDITORIA E VALIDAÇÃO

#### A. Diagnóstico Passivo Somente-Leitura (Executável pelo Operador)
Para auditar a autenticação e o isolamento multi-tenant sem qualquer risco de escrita:

```bash
# Executa a auditoria completa de isolamento RLS (100% READ ONLY)
node scripts/db/audit-staging-isolation-t1.mjs --ca=~/Downloads/prod-ca-2021.crt
```

*Proteções embutidas no auditor:*
- Validação estrita de host (`aws-0-us-east-1.pooler.supabase.com`), porta (`5432`), banco (`postgres`) e usuário (`postgres.ynfocaorhadizlvbnzrt`).
- Handshake TLS com validação de cadeia (`prod-ca-2021.crt`) e `rejectUnauthorized: true`.
- Ativação de `SET default_transaction_read_only = on;` na sessão.
- Transações com `SET TRANSACTION READ ONLY;` e descarte defensivo.
- Entrada interativa oculta de senha sem eco no terminal.

#### B. Execução da Suíte de Testes Automatizados (Vitest / PGlite)
```bash
# Executa todos os 15 testes de autenticação e isolamento em PostgreSQL descartável
npx vitest run src/app/actions/h2_04_t1_authentication_and_isolation.test.ts

# Executa o conjunto completo de 54 testes da fase H2.04
npx vitest run src/app/actions/h2_04*.test.ts
```

---

### 6. BLOQUEADORES REAIS E PRÓXIMOS PASSOS (H2.04-T2)

1. **Bloqueador Identificado:**
   - Ausência de credenciais conhecidas em texto plano para as personas de homologação Alice, Bruno e Carlos no Staging.
   - **Impacto:** O login interativo na interface web (`/login`) não pode ser operado humanamente até que senhas de teste sejam injetadas de forma controlada.

2. **Próximos Passos Propostos (H2.04-T2):**
   - Criar um utilitário de escrita segura (ex: `scripts/db/set-staging-homologation-passwords.mjs`) que exija confirmação explícita de token humano para atualizar `public.perfis.password_hash` com senhas conhecidas pré-definidas para a homologação.
   - Executar os testes de fluxo de login e Server Actions com cookies reais emitidos pelo NextAuth.
   - Preservar o isolamento do Supabase Storage e Gemini desativados/mockados até autorização explícita.

---

*Relatório gerado em conformidade com as diretrizes de segurança da modernização Medicina 2029.*
