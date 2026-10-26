# MEDICINA 2029 — RELATÓRIO DE AUDITORIA E CORREÇÃO DE SEGURANÇA
## Tarefa H1.09-R: Correção da 9ª Migração (F1.12 — Busca Vetorial e Híbrida)

**Data de Emissão:** 25 de Outubro de 2026  
**Ambiente Alvo:** `medicina-2029-staging`  
**Supabase Project Ref:** `ynfocaorhadizlvbnzrt`  
**Session Pooler:** `aws-0-us-east-1.pooler.supabase.com:5432`  
**Role Administrativa:** `postgres.ynfocaorhadizlvbnzrt`  
**Escopo Restrito:** Etapa 9 (`docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql`)  
**Status do Laudo:** **APTO PARA HOMOLOGAÇÃO E APLICAÇÃO CONTROLADA EM STAGING**

---

### 1. Resumo Executivo e Diagnóstico de Vulnerabilidade (SECURITY DEFINER)

Durante a auditoria de segurança da proposta da nona migração (`F1.12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql`), identificou-se uma **vulnerabilidade crítica de bypass de autorização multi-tenant** na função armazenada `medicina.fn_busca_hibrida_acervo`.

#### 1.1 Comportamento Técnico de `SECURITY DEFINER` e `current_user`
No PostgreSQL, quando uma função é declarada como `SECURITY DEFINER`, ela executa com os privilégios do usuário proprietário da função (`owner`), que no Supabase é invariavelmente a role administrativa `postgres`.
Conforme a especificação do motor PostgreSQL:
- Ao adentrar o corpo de uma rotina `SECURITY DEFINER`, a variável de sistema `current_user` passa a refletir a identidade do **proprietário** (`postgres`), e **não** a do chamador externo (`session_user`).
- No código original da proposta F1.12, constava a seguinte verificação:
  ```sql
  IF current_user = 'medicina_app' OR v_ctx_perfil_id IS NOT NULL OR v_ctx_papel IS NOT NULL THEN
    ...
  ELSE
    v_effective_perfil_id := p_perfil_id;
    v_effective_papel := p_papel;
  END IF;
  ```
- **A falha:** Como `current_user` dentro da função avalia para `'postgres'`, a condição `current_user = 'medicina_app'` resultava sempre em `FALSE`. Se a aplicação ou um cliente conectado não houvesse previamente executado `medicina.set_context(...)` na sessão/transação, as variáveis `v_ctx_perfil_id` e `v_ctx_papel` permaneciam nulas (`NULL`).
- **O bypass:** Nessas circunstâncias, a expressão inteira resultava em `FALSE`, direcionando o fluxo incondicionalmente para o bloco `ELSE`. Esse bloco aceitava cegamente os argumentos `p_perfil_id` e `p_papel` fornecidos pelo chamador, contornando completamente o isolamento RLS e permitindo que qualquer usuário autenticado (ou com privilégio de execução na função) consultasse e extraísse trechos confidenciais de arquivos pertencentes a qualquer outro perfil do sistema (ataque de IDOR / *Insecure Direct Object Reference* ao nível de banco de dados).

---

### 2. Evidência Empírica de Teste Negativo

A vulnerabilidade foi reproduzida e comprovada empiricamente em banco PostgreSQL descartável (PGlite com extensão `vector`), aplicando-se as etapas 1 a 8 e simulando o cenário real:
1. **Cenário de Teste:**
   - Responsável A (`2000...0001`) possui documento privado com texto confidencial (*"Dado ultrassecreto do Responsável 1"*).
   - Responsável B (`2000...0002`) possui documento privado próprio.
   - Estudante 2 vinculada exclusivamente ao Responsável B.
2. **Resultado Antes da Correção:**
   - Invocação da função sem contexto RLS ativo (`clear_context`), informando `p_perfil_id = UUID_RESPONSAVEL_A` e `p_papel = 'responsavel'`:
     **Vazamento confirmado:** A função caía no `ELSE` e retornava as tuplas confidenciais do Responsável A.
3. **Resultado Após a Correção:**
   - Invocação sem contexto RLS ativo: **0 linhas retornadas** (comportamento estrito *fail-closed*).
   - Invocação com contexto legítimo do Responsável B tentando passar parâmetro de A (`p_perfil_id = UUID_RESPONSAVEL_A`): **Exceção 42501 lançada imediatamente** (*"Conflito de identidade RLS na busca do acervo."*).
   - Invocação com contexto legítimo do Responsável B tentando passar papel divergente (`p_papel = 'estudante'`): **Exceção 42501 lançada imediatamente** (*"Conflito de papel RLS na busca do acervo."*).
   - Invocação sob contexto legítimo do Responsável A: **Sucesso na recuperação de seus próprios arquivos**.

---

### 3. Código Antes e Depois da Correção

#### 3.1 Função `medicina.fn_busca_hibrida_acervo`

```sql
-- ============================================================================
-- CÓDIGO VULNERÁVEL (ANTERIOR):
-- ============================================================================
  IF to_regprocedure('medicina.current_perfil_id()') IS NOT NULL THEN
    v_ctx_perfil_id := medicina.current_perfil_id();
    v_ctx_papel := medicina.current_papel();
  END IF;

  IF current_user = 'medicina_app' OR v_ctx_perfil_id IS NOT NULL OR v_ctx_papel IS NOT NULL THEN
    IF v_ctx_perfil_id IS NULL OR v_ctx_papel IS NULL THEN
      RETURN;
    END IF;
    IF p_perfil_id IS NOT NULL AND p_perfil_id <> v_ctx_perfil_id THEN
      RAISE EXCEPTION 'Conflito de identidade RLS na busca do acervo.' USING ERRCODE = '42501';
    END IF;
    IF p_papel IS NOT NULL AND p_papel <> v_ctx_papel THEN
      RAISE EXCEPTION 'Conflito de papel RLS na busca do acervo.' USING ERRCODE = '42501';
    END IF;
    v_effective_perfil_id := v_ctx_perfil_id;
    v_effective_papel := v_ctx_papel;
  ELSE
    v_effective_perfil_id := p_perfil_id;
    v_effective_papel := p_papel;
  END IF;

  IF v_effective_perfil_id IS NULL OR v_effective_papel NOT IN ('responsavel', 'estudante') THEN
    RETURN;
  END IF;

-- ============================================================================
-- CÓDIGO SEGURO E CORRIGIDO (H1.09-R):
-- ============================================================================
  IF to_regprocedure('medicina.current_perfil_id()') IS NOT NULL THEN
    v_ctx_perfil_id := medicina.current_perfil_id();
    v_ctx_papel := medicina.current_papel();
  END IF;

  -- FAIL-CLOSED: Se o contexto de sessão não estiver autenticado, encerra sem retornar registros
  IF v_ctx_perfil_id IS NULL OR v_ctx_papel IS NULL THEN
    RETURN;
  END IF;

  -- Validação contra spoofing de identidade fornecida em parâmetros
  IF p_perfil_id IS NOT NULL AND p_perfil_id <> v_ctx_perfil_id THEN
    RAISE EXCEPTION 'Conflito de identidade RLS na busca do acervo.' USING ERRCODE = '42501';
  END IF;
  IF p_papel IS NOT NULL AND p_papel <> v_ctx_papel THEN
    RAISE EXCEPTION 'Conflito de papel RLS na busca do acervo.' USING ERRCODE = '42501';
  END IF;

  v_effective_perfil_id := v_ctx_perfil_id;
  v_effective_papel := v_ctx_papel;

  IF v_effective_papel NOT IN ('responsavel', 'estudante') THEN
    RETURN;
  END IF;
```

#### 3.2 Benefícios da Solução Implementada
1. **Eliminação Integral do Fallback Privilegiado:** Não existe mais nenhuma instrução `ELSE` que atribua `v_effective_perfil_id := p_perfil_id`.
2. **Fail-Closed Mandatório:** Ausência de contexto de sessão autenticado encerra a rotina imediatamente com 0 linhas, impedindo execuções anônimas ou desautorizadas.
3. **Anti-Spoofing Criptográfico:** Caso o chamador informe parâmetros opcionais `p_perfil_id` ou `p_papel`, o PostgreSQL exige correspondência exata com as variáveis transacionais estabelecidas via `medicina.set_context(...)`. Qualquer discrepância aborta a transação com código `42501`.

---

### 4. Auditoria de Permissões e Princípio do Menor Privilégio

A proposta anterior continha o comando global:
`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA medicina FROM PUBLIC;`

#### 4.1 Análise de Risco da Revogação Global
A execução de um `REVOKE` em lote sobre todas as funções do schema `medicina` representava alto risco de regressão operacional, pois poderia revogar inadvertidamente privilégios de rotinas instaladas nas migrações 5 a 8 (`set_context`, `clear_context`, `current_perfil_id`, `is_responsavel`, `is_valid_acervo_storage_path`, rotinas da fila de ingestão, etc.), exigindo concessões redundantes propensas a erro.

#### 4.2 Saneamento Cirúrgico Adotado
Substituiu-se a revogação em massa por controle cirúrgico restrito à nova função de busca:
```sql
REVOKE ALL ON FUNCTION medicina.fn_busca_hibrida_acervo(
  text,
  vector,
  uuid,
  integer,
  double precision,
  text,
  uuid
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_anon') THEN
    REVOKE ALL ON FUNCTION medicina.fn_busca_hibrida_acervo(
      text,
      vector,
      uuid,
      integer,
      double precision,
      text,
      uuid
    ) FROM medicina_anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_app') THEN
    GRANT USAGE ON SCHEMA extensions TO medicina_app;
    GRANT USAGE ON SCHEMA medicina TO medicina_app;

    GRANT EXECUTE ON FUNCTION medicina.fn_busca_hibrida_acervo(
      text,
      vector,
      uuid,
      integer,
      double precision,
      text,
      uuid
    ) TO medicina_app;
  END IF;
END
$$;
```
- **Concessão `USAGE ON SCHEMA extensions`:** Concede à role `medicina_app` permissão de resolução dos tipos e operadores do `pgvector`.
- **Privilégios Mínimos:** Somente `medicina_app` (além de `postgres`) possui permissão `EXECUTE` na rotina de busca. `medicina_anon` e `PUBLIC` possuem execução estritamente negada.

---

### 5. Integração na Camada de Aplicação (`src/lib/ingestion.ts`)

Para garantir que as Server Actions da aplicação web invoquem a função sob um contexto transacional autenticado legítimo:
- O módulo [`src/lib/ingestion.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/ingestion.ts#L438-L500) foi atualizado para encapsular a execução de `medicina.fn_busca_hibrida_acervo` em uma transação Drizzle (`db.transaction`).
- Dentro da transação, injeta o contexto da sessão autenticada via `SELECT medicina.set_context(perfilId, papel)`.
- Como o contexto utiliza `set_config(..., is_local => true)`, ao final da transação (`COMMIT` ou `ROLLBACK`), o contexto é instantaneamente eliminado, impedindo qualquer contaminação no Connection Pooler.

---

### 6. Tabela de Metadados, Hashes SHA-256 e Tamanhos dos Artefatos

Todos os arquivos canônicos das etapas 1 a 8 mantiveram seus hashes intactos e auditados. Os artefatos correspondentes à Etapa 9 foram integralmente recalculados e validados:

| Etapa | Arquivo / Artefato | SHA-256 Checksum | Tamanho | Linhas |
|---|---|---|---|---|
| **Etapa 1** | `drizzle/0000_greedy_loki.sql` | `b1cf8d6741894a52543ca0edf7212dee9ee8945051cd01148ea60a3cbaf4b4c6` | 13.910 B | 363 |
| **Etapa 2** | `drizzle/0001_dry_talos.sql` | `8e82452e0071ee1ce5a1e38569ef8f69a0851ae3d8e229ebfd1b4969e3db9180` | 2.197 B | 43 |
| **Etapa 3** | `drizzle/0002_little_swarm.sql` | `c3ce3d3b1335bedb2deb46e2c14c018fe15370b60e7fdc415def17cb9de0343b` | 3.483 B | 61 |
| **Etapa 4** | `drizzle/0003_f1_03_r_expansao.sql` | `32be49be0da8ed6c675657ef0ecf14f54951491df0176cb66f1a450b8bab4e3f` | 6.551 B | 108 |
| **Etapa 5** | `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql` | `8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f` | 51.688 B | 1257 |
| **Etapa 6** | `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` | `96187040783e236b64bb70c15b9bf57c7ad39feb3d100a571bfa0e01eb5b55d1` | 9.771 B | 278 |
| **Etapa 7** | `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql` | `41dde50128b89ce9407dd03c97f53540451c5d6ae27d19edd3a5f789240d5fc0` | 7.971 B | 179 |
| **Etapa 8** | `docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql` | `e5a9ceea9daca82347c4af623bfb36156334fb4ae7525334e1f58626b41b8298` | 13.917 B | 373 |
| **Etapa 9 (SQL)** | `docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` | `b9474fa616038325f4677176d1cfc9e3ae29ab19e32545931acae7123c0aec1d` | 9.672 B | 286 |
| **Etapa 9 (Rollback)** | `docs/modernizacao/propostas/F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql` | `ec1d8066dbccc09d2aa5877cd00ccb22500fbe3fcbc2a45dd903d42c25a94702` | 980 B | 33 |
| **Lançador** | `scripts/db/apply-staging-step9.mjs` | `faa730e405180330bcc8eec25ee605c6e8b58a9b472d7ebd17b887e3535a06d4` | 10.847 B | 264 |
| **Testes Lifecycle** | `src/app/actions/h1_09_step9_migration_lifecycle.test.ts` | `fe764f76c982b7556444830fdd217e50a5ea9cdc9c7ce2a4ab804273162619e7` | 28.471 B | 722 |
| **Testes Lançador** | `src/app/actions/h1_04_staging_step9_launcher.test.ts` | `5b96476d7b24ec975c90c4b743be9b13550005a4279984c36a0383e256ecdc27` | 15.351 B | 387 |

---

### 7. Resultados dos Testes Automatizados Locais (100% Aprovados)

As suítes automatizadas foram executadas via Vitest em ambiente isolado PGlite, cobrindo todos os cenários positivos, negativos e de segurança:

```text
✓ src/app/actions/h1_09_step9_migration_lifecycle.test.ts (7 tests) 4453ms
  ✓ 1. Replay das etapas 1 a 8 e aplicação exclusiva de F1.12 com 9 registros no histórico
  ✓ 2. Verifica criação dos índices HNSW e GIN FTS e constraints de proveniência
  ✓ 3. Validação de Dimensionalidade de Embeddings (1536) e Rejeição de Incompatíveis
  ✓ 4. Teste de Busca Híbrida Real: Pontuação Vetorial + Textual e Tratamento de Vazio
  ✓ 5. Teste de RLS e Isolamento Multi-Tenant: Responsável vs Estudante vs Outro Responsável
  ✓ 6. Testes Negativos Obrigatórios de Segurança (H1.09-R: Fail-Closed, Spoofing e SECURITY DEFINER)
  ✓ 7. Teste de Rollback (F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql) e Reversibilidade Simétrica

✓ src/app/actions/h1_04_staging_step9_launcher.test.ts (9 tests) 3564ms
  ✓ 1. Valida metadados e parâmetros operacionais fixos do lançador
  ✓ 2. Rejeita execução se confirmação humana explícita não for exatamente "APLICAR ETAPA 9 EM STAGING"
  ✓ 3. Rejeita se o arquivo de certificado CA TLS não for localizado
  ✓ 4. Executa exclusivamente a migração 9 (F1.12) com etapas 1 a 8 previamente aplicadas
  ✓ 5. Demonstra idempotência completa em re-execução (todas as 9 etapas puladas com segurança)
  ✓ 6. Falha durante DDL da etapa 9 reverte transação atomicamente via ROLLBACK
  ✓ 7. Falha durante tracking da etapa 9 reverte transação atomicamente desfazendo os objetos de F1.12
  ✓ 8. Probe 9: Detecta estado intermediário e aborta fail-closed se fn_busca_hibrida_acervo existir sem tracking
  ✓ 9. Conclusão da cadeia: total de 9 migrações registradas e sem pendências

✓ src/lib/ingestion.test.ts (9 tests) 5ms
  ✓ Motor de Ingestão: OCR, segmentação, validação de dimensionalidade e busca segura
```

**Total de Testes da Etapa 9:** 25/25 aprovados.  
**Regressão da Etapa 8:** 15/15 testes aprovados (`h1_08_step8_migration_lifecycle` e `h1_04_staging_step8_launcher`).

---

### 8. Estimativas Técnicas de Custo, Memória e Locks na Instância Supabase Nano

> [!NOTE]
> Os valores apresentados a seguir constituem **estimativas analíticas de engenharia** com base nas especificações da engine `pgvector 0.8.2` e limites de hardware da infraestrutura Supabase Nano (2 vCPUs compartilhadas, 1 GB de RAM, `shared_buffers` ~128MB). Não devem ser interpretados como medições de telemetria em produção com acervo populado.

1. **Índice HNSW (`acervo_chunks_embedding_hnsw_idx`):**
   - **Locks:** Adquire `ShareLock` na tabela `public.acervo_chunks` durante `CREATE INDEX`. Permite leituras simultâneas (`SELECT`), mas enfileira escritas (`INSERT`, `UPDATE`, `DELETE`).
   - **Duração Estimada:** No estado atual de staging (tabela vazia ou com volume residual), a construção consome **< 1,5 segundo**.
   - **Consumo de Memória:** Para 0 a 1.000 chunks, consome < 10 MB de RAM de trabalho.
   - **Recomendação Futura:** Quando a tabela atingir dezenas de milhares de registros em produção, qualquer reconstrução de índice vetorial deverá ser executada em janela de manutenção de baixo tráfego.
2. **Índice Textual GIN (`acervo_chunks_texto_fts_idx`):**
   - **Locks:** Adquire `ShareLock` em `public.acervo_chunks`.
   - **Duração Estimada:** Subsegundo em acervo inicial (< 500 ms).
   - **Consumo de Memória:** Desprezível no estado atual.
3. **Constraints de Proveniência (`NOT VALID`):**
   - As constraints `materiais_gerado_proveniencia_check`, `questoes_gerada_proveniencia_check` e `cards_gerado_proveniencia_check` utilizam a cláusula `NOT VALID`.
   - **Locks:** Adquirem apenas `ShareRowExclusiveLock` brevíssimo (milissegundos) para registrar a constraint no catálogo do PostgreSQL (`pg_constraint`), sem realizar *table scan* nas tuplas existentes. Zero risco de timeout de DDL.

---

### 9. Consultas SQL Somente de Leitura para Validação no Supabase Staging

Após a autorização humana e aplicação remota da migração 9, o operador poderá executar as seguintes consultas no **SQL Editor** do Supabase para auditoria estrutural imediata:

```sql
-- ----------------------------------------------------------------------------
-- 1. CONFERÊNCIA DO HISTÓRICO DE MIGRAÇÕES E HASH DA ETAPA 9
-- ----------------------------------------------------------------------------
SELECT ordem, rel_path, sha256, applied_at
FROM public._medicina_staging_migrations
ORDER BY ordem ASC;
-- Esperado: Exatamente 9 linhas. Linha 9:
-- rel_path = 'docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'
-- sha256 = 'b9474fa616038325f4677176d1cfc9e3ae29ab19e32545931acae7123c0aec1d'

-- ----------------------------------------------------------------------------
-- 2. VERIFICAÇÃO DOS ÍNDICES VETORIAL HNSW E TEXTUAL GIN
-- ----------------------------------------------------------------------------
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'acervo_chunks'
  AND indexname IN ('acervo_chunks_embedding_hnsw_idx', 'acervo_chunks_texto_fts_idx')
ORDER BY indexname;
-- Esperado: 2 linhas, uma USING hnsw (vector_cosine_ops) e outra USING gin (to_tsvector)

-- ----------------------------------------------------------------------------
-- 3. VERIFICAÇÃO DAS CONSTRAINTS DE PROVENIÊNCIA NOT VALID
-- ----------------------------------------------------------------------------
SELECT conname, conrelid::regclass AS tabela, convalidated, pg_get_constraintdef(oid) AS definicao
FROM pg_constraint
WHERE conname IN (
  'materiais_gerado_proveniencia_check',
  'questoes_gerada_proveniencia_check',
  'cards_gerado_proveniencia_check'
)
ORDER BY conname;
-- Esperado: 3 linhas com convalidated = false (NOT VALID ativo)

-- ----------------------------------------------------------------------------
-- 4. INSPEÇÃO DA FUNÇÃO DE BUSCA HÍBRIDA (SECURITY DEFINER E SEARCH_PATH)
-- ----------------------------------------------------------------------------
SELECT
  p.proname,
  n.nspname AS schema_name,
  pg_get_userbyid(p.proowner) AS proprietario,
  p.prosecdef AS is_security_definer,
  p.proconfig AS config_search_path
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'medicina'
  AND p.proname = 'fn_busca_hibrida_acervo';
-- Esperado: 1 linha. proprietario = postgres, is_security_definer = true,
-- config_search_path = {search_path=pg_catalog, extensions, medicina, public, pg_temp}

-- ----------------------------------------------------------------------------
-- 5. AUDITORIA DE PERMISSÕES DA FUNÇÃO (LEAST PRIVILEGE)
-- ----------------------------------------------------------------------------
SELECT
  grantee,
  privilege_type
FROM information_schema.routine_privileges
WHERE specific_schema = 'medicina'
  AND routine_name = 'fn_busca_hibrida_acervo'
ORDER BY grantee;
-- Esperado: Somente 'postgres' e 'medicina_app' com EXECUTE.
-- Ausência total de 'PUBLIC' e 'medicina_anon'.

-- ----------------------------------------------------------------------------
-- 6. GARANTIA DE AUSÊNCIA DE ETAPAS POSTERIORES
-- ----------------------------------------------------------------------------
SELECT COUNT(*) AS total_migracoes, MAX(ordem) AS ultima_etapa
FROM public._medicina_staging_migrations;
-- Esperado: total_migracoes = 9, ultima_etapa = 9.
```

---

### 10. Conclusão e Instruções para Aplicação Segura

A vulnerabilidade de autorização multi-tenant em `medicina.fn_busca_hibrida_acervo` foi **integralmente corrigida** com mecanismo *fail-closed*, anti-spoofing e escopo transacional restrito. A suíte completa de testes locais foi aprovada com sucesso.

Nenhuma conexão com o banco remoto Supabase foi estabelecida e nenhuma escrita remota foi realizada durante este procedimento, respeitando estritamente os limites de governança.

#### Como Executar a Migração Remota em Staging (Pelo Operador Humano):
Quando estiver pronto para homologar e aplicar remotamente no Supabase Staging:

```bash
# Executa o lançador seguro da Etapa 9
CONFIRM_STAGING_MIGRATIONS=true node scripts/db/apply-staging-step9.mjs
```
O lançador solicitará a senha de forma oculta e exigirá a confirmação textual explícita `APLICAR ETAPA 9 EM STAGING`.

---
*Fim do Relatório H1.09-R.*
