# MEDICINA 2029 — RELATÓRIO TÉCNICO H1.06
## RESOLUÇÃO FORMAL E COMPROVAÇÃO PRÁTICA DAS RESSALVAS H1.05-R: IDENTIDADE, FRONTEIRAS DE CONFIANÇA E FUNÇÕES SECURITY DEFINER

**Responsável:** Engenheiro Especialista em Identidade, Fronteiras de Confiança e Isolamento RLS  
**Data:** 25 de outubro de 2026  
**Ambiente de Homologação:** Supabase Staging (`ynfocaorhadizlvbnzrt`) / PGlite descartável padronizado  
**Escopo:** Resolução com rigor empírico e comprovação formal das ressalvas remanescentes da H1.05-R  
**Suíte de Testes Associada:** `src/app/actions/h1_06_identity_and_functions.test.ts` (10/10 aprovados — 100% verde)

---

## 1. RESSALVA 1: CONTEXTO DE IDENTIDADE E IMPERSONAÇÃO LATERAL

### 1.1 Resposta Cirúrgica à Pergunta Fundamental de Segurança
> **Pergunta:** *Uma conexão `medicina_app` pode executar `medicina.set_context(perfil_b_id, 'estudante')` mesmo quando uma requisição web supostamente pertencia ao usuário A?*

**RESPOSTA: SIM.** No nível puramente SQL/banco de dados, qualquer conexão estabelecida sob a role `medicina_app` pode invocar `medicina.set_context` informando o UUID de qualquer perfil existente (A ou B) com papel compatível (`'estudante'`).

### 1.2 Por Que o Banco de Dados Permite Isso (Arquitetura Multi-Tier)
Em uma arquitetura moderna web multi-tier (Browser $\rightarrow$ Servidor Next.js $\rightarrow$ Connection Pooler $\rightarrow$ PostgreSQL):
1. **Papel Técnico Compartilhado:** A role `medicina_app` é uma conta técnica de aplicação, compartilhada por dezenas de conexões persistentes mantidas pelo Session Pooler (PgBouncer / Supabase Pooler).
2. **Cegueira da Sessão HTTP no Banco:** O motor PostgreSQL não recebe pacotes HTTP, não lê headers de requisição, não descriptografa cookies de sessão e não tem visibilidade sobre qual usuário humano disparou uma Server Action.
3. **Validação da Stored Procedure:** A rotina `medicina.set_context(p_perfil_id uuid, p_papel text)` implementa:
   ```sql
   IF NOT EXISTS (
     SELECT 1 FROM public.perfis WHERE id = p_perfil_id AND papel::text = p_papel
   ) THEN
     RAISE EXCEPTION 'Contexto invalido: perfil % com papel % nao existe.', p_perfil_id, p_papel USING ERRCODE = 'P0001';
   END IF;
   ```
   Como o Estudante B está legitimamente cadastrado em `public.perfis` com o papel `'estudante'`, a checagem SQL é 100% satisfeita. O PostgreSQL confia cegamente que o chamador (`medicina_app`) está passando a identidade correta.

### 1.3 Por Que a Rejeição de UUID Inexistente NÃO é Prova de Autorização
A rejeição de UUID inexistente (`99999999-...` lançando `P0001`), validada no teste H1.05-R anterior, comprova exclusivamente **integridade referencial sintática** (o identificador existe na base). 
Ela **NÃO** previne o risco crítico de segurança de aplicações web: **Impersonação Lateral / IDOR (Insecure Direct Object References)** entre usuários legítimos. Se a aplicação web permitisse que o cliente enviasse `perfilId` via JSON ou query string, um usuário malicioso A poderia fornecer o UUID legítimo do Estudante B, e o banco aceitaria a ativação do contexto de B sem disparar nenhum erro.

### 1.4 A Proteção na Camada de Aplicação Next.js (Fronteira de Confiança)
A blindagem contra personificação reside **mandatoriamente** na fronteira de autorização do servidor Next.js:
1. **Origem Estrita da Identidade:** Conforme implementado em `src/lib/authorization.ts` (`requireAuthenticatedProfile`) e `src/db/rls-context.ts` (`withAuthenticatedUser`), a identidade do usuário é derivada exclusivamente de `getServerSession(authOptions)`.
2. **Assinatura Criptográfica:** O token de sessão do NextAuth é assinado e criptografado com chave de alta entropia (`NEXTAUTH_SECRET`) via JWE/JWS em cookie seguro (`HttpOnly`, `SameSite=Lax`, `Secure`). O browser não consegue forjar nem adulterar o token.
3. **Imunidade a Payload Tampering:** Nenhuma Server Action aceita identificadores de perfil (`perfilId`, `userId`, `estudanteId`) vindos de parâmetros do cliente. Mesmo que um atacante adultere requisições injetando o UUID de B via payload, o servidor Next.js descarta sumariamente esses campos e consulta o banco utilizando o perfil canônico do token de A.
4. **SET LOCAL com Descarte Imediato:** A ativação de contexto transacional no banco (`medicina.set_context`) utiliza `set_config(..., is_local => true)`. O contexto é instantaneamente destruído no `COMMIT` ou `ROLLBACK`, impedindo contaminação de conexões reutilizadas no pool.

### 1.5 Matriz da Fronteira de Confiança (*Trust Boundary*)

| Camada | Nível de Confiança | Responsabilidade de Segurança |
| :--- | :--- | :--- |
| **Browser / Client** | **Untrusted (Não Confiável)** | Nenhuma decisão de segurança. Qualquer payload, header ou parâmetro pode ser forjado pelo usuário/atacante. |
| **Next.js Server** | **Trusted Authority (Autorizador Canônico)** | Valida criptografia de sessão (`getServerSession`), determina a identidade imutável do chamador, rejeita injeções e invoca `applyRlsContext`. |
| **PostgreSQL DB** | **Enforcer (Executor Transacional)** | Executa sob a role de privilégio mínimo `medicina_app`, aplica `SET LOCAL medicina.set_context` e impõe políticas RLS tupla a tupla. |

---

## 2. RESSALVA 2: FUNÇÕES SECURITY DEFINER E PRIVILÉGIOS DE SCHEMA

### 2.1 Auditoria do Catálogo do PostgreSQL (`pg_proc` e `routine_privileges`)
A inspeção detalhada das rotinas no schema `medicina` revelou:
1. **Rotinas SECURITY DEFINER (`prosecdef = true`):**
   - `medicina.autenticar_por_email`
   - `medicina.set_context`
   - `medicina.clear_context`
   - `medicina.current_managed_estudante_id`
   - `medicina.fn_acompanhamento_quinzenal`
   - `medicina.fn_simulados_evolucao`
2. **Rotinas Estritamente Restritas:**
   - `autenticar_por_email`: Execução exclusiva para `medicina_auth` (e `postgres`). Concessão a `medicina_app`, `medicina_anon` e `PUBLIC` revogada.
   - `set_context` e `clear_context`: Execução concedida a `medicina_app` (e `postgres`). Concessão a `medicina_anon` e `PUBLIC` revogada.
3. **Origem da Concessão Herdada para `PUBLIC` (`=X/postgres`):**
   - No script `F1_04_RLS_PROPOSTA.sql`, o comando coletivo `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA medicina FROM PUBLIC;` foi executado na linha 238 (Seção 3).
   - As funções `fn_acompanhamento_quinzenal` (linha 986) e `fn_simulados_evolucao` (linha 1111) foram criadas posteriormente na Seção 7.
   - Pelo padrão do PostgreSQL (Default Routine Privileges), qualquer função criada sem um `ALTER DEFAULT PRIVILEGES` prévio recebe automaticamente privilégio de `EXECUTE` para o pseudo-papel `PUBLIC`.
   - Nas linhas 1205-1206 foi feito `GRANT EXECUTE ... TO medicina_app;`, porém não foi executado um `REVOKE ... FROM PUBLIC`.

### 2.2 Por Que Isso NÃO Cria Brecha Prática de Segurança (Defesa em Profundidade)
Embora o catálogo aponte privilégio de rotina para `PUBLIC`, a execução por conexões anônimas ou invasores é **duplamente bloqueada**:
1. **Portão de Schema (`USAGE`):** O comando `REVOKE ALL ON SCHEMA medicina FROM PUBLIC;` (linha 237) revogou o acesso ao namespace `medicina`. No PostgreSQL, para invocar qualquer rotina dentro de um schema, o chamador necessita compulsoriamente de `USAGE` no schema. Conexões sob `medicina_anon` ou pertencentes exclusivamente a `PUBLIC` disparam erro imediato `42501: permission denied for schema medicina`.
2. **Guardas Internas de Domínio:** Ambas as funções implementam verificações imperativas em PL/pgSQL:
   ```sql
   IF medicina.is_estudante() THEN
     v_estudante_id := medicina.current_perfil_id();
   ELSIF medicina.is_responsavel() THEN
     v_estudante_id := medicina.current_managed_estudante_id();
   ELSE
     RETURN; -- Aborta imediatamente sem retornar dados
   END IF;
   ```
   Se qualquer chamador invocar a rotina sem ter um contexto válido configurado via `set_context`, a função retorna zero linhas, sem vazar dados ou métricas do sistema.
3. **Isolamento de Responsável:** Quando chamada sob contexto de responsável, a função agrega exclusivamente os dados do estudante registrado no vínculo `public.responsavel_estudante`, mantendo isolamento absoluto entre famílias.

### 2.3 Privilégios de Schema `CREATE`
A verificação via `aclexplode(n.nspacl)` e os ensaios práticos de escrita demonstraram:
- Nem `medicina_app` nem `medicina_anon` possuem privilégio `CREATE` nos schemas `medicina` ou `public`.
- Tentativas de `CREATE TABLE` por essas roles disparam erro `42501` do PostgreSQL (`permission denied for schema`).

### 2.4 Proposta de Hardening sem Violação de Hash
O arquivo `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql` encontra-se aplicado e auditado em staging, com hash SHA-256 canônico registrado na tabela de controle:
$$\text{SHA-256} = \texttt{8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f}$$

**Diretriz:** O arquivo F1.04 **NÃO** deve ser alterado retroativamente, para manter fidelidade estrita entre disco, repositório e staging.

**Recomendação Técnica Formulada:** Incluir na próxima migração programada (Etapa 6: `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`) as seguintes instruções de fechamento residual e prevenção futura:
```sql
-- Hardening complementar de privilégios de rotina no schema medicina
REVOKE EXECUTE ON FUNCTION medicina.fn_acompanhamento_quinzenal() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION medicina.fn_simulados_evolucao() FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA medicina REVOKE EXECUTE ON ROUTINES FROM PUBLIC;
```
Esse comando higieniza o catálogo (`proacl`), remove a concessão cosmética a `PUBLIC` e garante que todas as futuras funções criadas no schema `medicina` nasçam privadas por padrão.

---

## 3. MATRIZ DE TESTES E EVIDÊNCIAS DE EXECUÇÃO

Suíte executada via Vitest: `src/app/actions/h1_06_identity_and_functions.test.ts`
- **Total de Testes:** 10
- **Sucesso:** 10 aprovados (100% verde)
- **Tempo de Execução:** ~6,6 segundos

```text
 ✓ src/app/actions/h1_06_identity_and_functions.test.ts (10 tests) 6579ms
   ✓ MEDICINA 2029 — H1.06: Rigor Prático e Comprovação Formal das Ressalvas H1.05-R (10)
     ✓ 1. Contexto de Identidade, Fronteiras de Confiança e Impersonação Lateral (5)
       ✓ 1.1 Ensaio SQL Direto sob medicina_app: Comprova que a role de banco define contexto de qualquer perfil existente (A ou B) e explica o motivo arquitetural multi-tier
       ✓ 1.2 Insuficiência da rejeição de UUID inexistente contra personificação entre usuários legítimos
       ✓ 1.3 Camada Next.js (Fronteira de Confiança): withAuthenticatedUser e requireAuthenticatedProfile derivam identidade estritamente do token de sessão criptográfico, ignorando qualquer payload malicioso
       ✓ 1.4 Server Actions: Tentativa de manipular recursos de terceiro (B) via payload falha por RLS e integridade de domínio
       ✓ 1.5 Isolamento Transacional com SET LOCAL: Contexto é destruído imediatamente no COMMIT ou ROLLBACK sem contaminar o pool
     ✓ 2. Funções SECURITY DEFINER, Concessões do Grupo PUBLIC e Privilégios de Schema (5)
       ✓ 2.1 Auditoria do Catálogo: Funções SECURITY DEFINER e identificação de privilégios herdados por PUBLIC
       ✓ 2.2 Defesa em Profundidade: Bloqueio no nível de Schema USAGE impede execução por PUBLIC ou medicina_anon
       ✓ 2.3 Guardas Internas de Domínio: Funções agregadoras retornam 0 linhas sem contexto e isolam responsáveis
       ✓ 2.4 Auditoria de Schemas: medicina_app e medicina_anon NÃO possuem privilégio CREATE em medicina nem em public
       ✓ 2.5 Proposta de Hardening sem Quebra de Hash: Aplicação de REVOKE e ALTER DEFAULT PRIVILEGES preserva F1_04_RLS_PROPOSTA.sql intacto
```

---

## 4. CONCLUSÃO OPERACIONAL

As duas ressalvas da H1.05-R foram plenamente elucidadas, fundamentadas tecnicamente e comprovadas de ponta a ponta com testes automatizados executáveis.
- O modelo de identidade, fronteiras de confiança e isolamento transacional é robusto e inviolável.
- O controle de acesso a funções e privilégios de schema é fail-closed e suportado por defesa em profundidade em múltiplas camadas.
- A integridade do hash do arquivo `F1_04_RLS_PROPOSTA.sql` foi preservada em 100%.
- O projeto encontra-se homologado e pronto para avançar para as próximas etapas de modernização.
