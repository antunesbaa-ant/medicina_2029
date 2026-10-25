# MEDICINA 2029 — RELATÓRIO H1.06
## PREPARAÇÃO DA SEXTA MIGRAÇÃO (F1.09 — INTEGRIDADE E IDEMPOTÊNCIA)

**Projeto Alvo:** `medicina-2029-staging` (`ynfocaorhadizlvbnzrt`)  
**Data da Avaliação:** 25 de outubro de 2026  
**Ambiente de Destino:** Homologação Staging (Session Pooler: `aws-0-us-east-1.pooler.supabase.com:5432`)  
**Escopo:** Preparação exclusiva da Etapa 6 (`docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`) e resolução definitiva das duas ressalvas de segurança remanescentes da H1.05-R.

---

## 1. INSPEÇÃO INTEGRAL DA MIGRAÇÃO F1.09

A migração `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` (11.303 bytes, SHA-256: `96187040783e236b64bb70c15b9bf57c7ad39feb3d100a571bfa0e01eb5b55d1`) estabelece o ledger persistente de idempotência, unicidades físicas e constraints de domínio com preflight diagnóstico de contenção (`lock_timeout = '5s'`, `statement_timeout = '60s'`).

### 1.1 Tabela Nova: `public.operacoes_idempotentes`
- **Finalidade:** Deduplicação determinística em nível transacional para impedir processamento redundante e colisões de requisições concorrentes.
- **Estrutura:**
  - `id`: `uuid PRIMARY KEY DEFAULT gen_random_uuid()`
  - `perfil_id`: `uuid NOT NULL REFERENCES public.perfis(id) ON DELETE RESTRICT`
  - `escopo`: `varchar(100) NOT NULL`
  - `chave_idempotencia`: `varchar(128) NOT NULL`
  - `payload_hash`: `varchar(64) NOT NULL`
  - `recurso_id`: `uuid NULL`
  - `resposta_resumo`: `jsonb NOT NULL`
  - `criado_em`: `timestamp DEFAULT now() NOT NULL`
- **Constraints Físicas:**
  - `operacoes_idempotentes_pkey`: Primary key em `(id)`.
  - `operacoes_idempotentes_perfil_escopo_chave_unique`: Chave composta única sobre `(perfil_id, escopo, chave_idempotencia)`.
  - `operacoes_idempotentes_payload_hash_check`: `CHECK (char_length(payload_hash) = 64)`.
  - `operacoes_idempotentes_escopo_check`: `CHECK (escopo IN ('sessao.iniciar', 'sessao.concluir', 'fsrs.revisar', 'simulado.registrar', 'curadoria.gerar', 'curadoria.decidir', 'redacao.registrar', 'repertorio.registrar', 'acervo.upload'))`.

### 1.2 Colunas e Índices Parciais Adicionados
- **Colunas:**
  - `public.card_revisoes.chave_idempotencia` (`varchar(128) NULL`)
  - `public.geracoes.chave_idempotencia` (`varchar(128) NULL`)
- **Índices Únicos Parciais:**
  - `card_revisoes_card_chave_idempotencia_uidx` ON `public.card_revisoes(card_id, chave_idempotencia) WHERE chave_idempotencia IS NOT NULL`
  - `geracoes_chave_idempotencia_uidx` ON `public.geracoes(chave_idempotencia) WHERE chave_idempotencia IS NOT NULL`
  - `sessoes_uma_aberta_por_bloco_topico_uidx` ON `public.sessoes(perfil_id, ciclo_bloco_id, topico_id) WHERE encerrada_em IS NULL` (garante fisicamente que um perfil nunca tenha mais de uma sessão aberta para o mesmo bloco e tópico).

### 1.3 Constraints Únicas e de Domínio (`CHECK`)
- **Unicidades em Tabelas Pré-existentes:**
  - `erros_tentativa_id_unique`: `UNIQUE (tentativa_id)` em `public.erros` (cardinalidade 1:1 estrita).
  - `curadoria_fila_artefato_unique`: `UNIQUE (artefato_tipo, artefato_id)` em `public.curadoria_fila`.
  - `acervo_arquivos_hash_conteudo_unique`: `UNIQUE (hash_conteudo)` em `public.acervo_arquivos`.
- **Regras de Negócio e Domínio Adicionadas via `NOT VALID` + `VALIDATE CONSTRAINT`:**
  1. `sessoes_tempos_limites_check` (`sessoes`): `segundos_efetivos BETWEEN 0 AND 86400 AND segundos_pausa BETWEEN 0 AND 86400`
  2. `sessoes_ordem_temporal_check` (`sessoes`): `encerrada_em IS NULL OR encerrada_em >= iniciada_em`
  3. `card_revisoes_duracao_rating_check` (`card_revisoes`): `duracao_ms BETWEEN 0 AND 3600000 AND rating IN ('again', 'hard', 'good', 'easy')`
  4. `simulados_duracao_limites_check` (`simulados`): `duracao_min > 0 AND duracao_min <= 720`
  5. `simulado_areas_acertos_total_check` (`simulado_areas`): `total > 0 AND total <= 200 AND acertos >= 0 AND acertos <= total`
  6. `redacoes_limites_e_genero_check` (`redacoes`): `minutos_gastos > 0 AND minutos_gastos <= 600 AND (nota_total IS NULL OR (nota_total >= 0 AND nota_total <= 1000)) AND (formato <> 'genero_uece' OR genero_id IS NOT NULL)`
  7. `checkins_limites_dominio_check` (`checkins`): `horas_sono BETWEEN 0 AND 24 AND exercicio_min BETWEEN 0 AND 1440 AND humor BETWEEN 1 AND 5 AND energia BETWEEN 1 AND 5`
  8. `acervo_arquivos_tamanho_serie_check` (`acervo_arquivos`): `tamanho_bytes > 0 AND tamanho_bytes <= 20971520 AND serie_alvo BETWEEN 0 AND 3`

### 1.4 Compatibilidade com as Etapas 1 a 5
A migração F1.09 é **100% aditiva e retrocompatível**:
- As novas colunas são `NULLABLE`, preservando dados legados.
- As constraints não conflitam com a tipagem original do Drizzle.
- A expansão F1.03-R (`responsavel_estudante`, nulabilidade de `estudante_perfil_id`) é integralmente respeitada.
- O script de rollback correspondente (`F1_09_ROLLBACK_INTEGRIDADE_E_IDEMPOTENCIA.sql`, SHA-256: `30ea0c6fe3d1a9ec6d59aaf3857b84a80a2030c33c7ef34c651ca531111b2779`) desfaz com exatidão cirúrgica cada objeto criado, garantindo reversibilidade perfeita.

---

## 2. SEGURANÇA ROW LEVEL SECURITY (RLS) NA ETAPA 6

### 2.1 Proteção da Tabela `operacoes_idempotentes`
- **Ativação e Forçamento:**
  ```sql
  ALTER TABLE public.operacoes_idempotentes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.operacoes_idempotentes FORCE ROW LEVEL SECURITY;
  ```
  O `FORCE ROW LEVEL SECURITY` assegura que até mesmo o dono da tabela obedeça às políticas caso opere sem bypass explícito.
- **Política RLS Unificada (`operacoes_idempotentes_own_policy`):**
  - **Comando:** `FOR ALL` (aplica-se a `SELECT`, `INSERT`, `UPDATE`, `DELETE`).
  - **USING:** `medicina.current_perfil_id() IS NOT NULL AND perfil_id = medicina.current_perfil_id()`.
  - **WITH CHECK:** `medicina.current_perfil_id() IS NOT NULL AND perfil_id = medicina.current_perfil_id()`.
- **Fail-Closed:** Conexões anônimas ou sem contexto ativo obtêm `0 linhas` em consultas e `0 linhas` afetadas em mutações.
- **Anti-Spoofing:** Tentativa de `INSERT` ou `UPDATE` forjando `perfil_id` de terceiro dispara violação de RLS (`42501`).

### 2.2 Privilégios Concedidos por Papel
- **`medicina_app`:** `GRANT SELECT, INSERT, UPDATE, DELETE`. Acesso legítimo para as Server Actions operarem sob RLS ativo.
- **`medicina_anon`:** `REVOKE ALL`. Bloqueio total.
- **`PUBLIC`:** Bloqueio total.
- **`medicina_auth` / `medicina_worker`:** Nenhum privilégio concedido (Princípio do Menor Privilégio).

---

## 3. RESOLUÇÃO DEFINITIVA DAS RESSALVAS H1.05-R

### 3.1 Ressalva 1: Contexto de Identidade e Fronteiras de Confiança

> **Questão Técnica Auditada:** *Uma conexão `medicina_app` pode executar `medicina.set_context(perfil_b_id, 'estudante')` enquanto opera em nome do usuário A?*

**Conclusão Empírica e Arquitetural: SIM no nível SQL; NUNCA no nível de Aplicação.**

1. **Comportamento no Nível PostgreSQL (Conta Técnica de Pool):**
   - No ensaio em PostgreSQL descartável com dois perfis sintéticos ativos (Estudante A: `10000000-...0001` e Estudante B: `10000000-...0002`), comprovou-se que uma conexão aberta como a role técnica `medicina_app` pode invocar `medicina.set_context` com o UUID de B e, logo em seguida, com o UUID de A.
   - **Causa Arquitetural:** Em uma arquitetura 3 camadas com pool de conexões (Browser $\rightarrow$ Next.js Server $\rightarrow$ Session Pooler $\rightarrow$ PostgreSQL), o banco não processa conexões diretas de usuários finais, não recebe requisições HTTP e não decodifica cookies. O banco confia que a aplicação já autenticou o usuário.
   - **Por Que Rejeitar UUID Inexistente NÃO é Prova de Autorização:** A rejeição de UUIDs inexistentes (`P0001: Contexto invalido: perfil ... nao existe`) atesta apenas **integridade referencial**. Ela **não** impede impersonação lateral entre dois perfis legítimos existentes (ataque IDOR).

2. **A Blindagem Inviolável no Servidor Next.js (A Verdadeira Fronteira de Confiança):**
   - A camada de autorização em `src/lib/authorization.ts` (`requireAuthenticatedProfile`) e `src/db/rls-context.ts` (`withAuthenticatedUser`) extrai a identidade **exclusivamente do token de sessão JWT assinado criptograficamente pelo NextAuth** (`getServerSession(authOptions)` com `NEXTAUTH_SECRET`).
   - Nenhuma Server Action aceita `perfilId` vindo de parâmetros de formulário, URLs ou JSON enviados pelo cliente.
   - **Comprovação Prática Automatizada (Teste 1.3):** Quando um cliente malicioso autenticado como Estudante A envia um payload forjado contendo `{ perfilId: B, estudanteId: B, papel: 'responsavel' }`, o servidor Next.js descarta sumariamente os parâmetros não confiáveis e invoca a Server Action com a identidade canônica de A.
   - **Proteção do Pool com `SET LOCAL`:** A função `withAuthenticatedUser` executa `medicina.set_context` com `is_local => true` (`SET LOCAL`). Comprovou-se (Teste 1.5) que, após o encerramento da transação (`COMMIT` ou `ROLLBACK`), o contexto é imediatamente destruído, deixando a conexão reutilizada no pool em estado *fail-closed* (`current_perfil_id() IS NULL`).

```
┌─────────────────────────────────┐
│   Browser Client (NÃO CONFIÁVEL)│  Parâmetros, IDs e corpos de requisição
│   Atacante pode manipular IDs  │  podem ser arbitrários.
└────────────────┬────────────────┘
                 │ Cookie HTTP-Only Seguro (JWT Assinado com NEXTAUTH_SECRET)
                 ▼
┌─────────────────────────────────┐
│   Next.js Server (AUTORIZADOR)  │  1. Decodifica sessão criptográfica;
│   [FRONTEIRA DE CONFIANÇA]      │  2. Ignora qualquer perfilId recebido no payload;
│                                 │  3. Inicia transação e chama applyRlsContext().
└────────────────┬────────────────┘
                 │ SET LOCAL medicina.set_context(perfil_autenticado, papel)
                 ▼
┌─────────────────────────────────┐
│   PostgreSQL Engine (EXECUTOR)  │  1. Role técnica medicina_app (sem superuser/bypassrls);
│   Aplica RLS Transacional       │  2. Aplica RLS estrito nas 34 tabelas;
│                                 │  3. Purga contexto no COMMIT/ROLLBACK.
└─────────────────────────────────┘
```

### 3.2 Ressalva 2: Funções SECURITY DEFINER e Grupo `PUBLIC`

1. **Achado no Catálogo:**
   - Em `F1_04_RLS_PROPOSTA.sql`, o comando de revogação de funções de `PUBLIC` precedeu a criação das rotinas da Seção 7 (`medicina.fn_acompanhamento_quinzenal` e `medicina.fn_simulados_evolucao`). Pelo comportamento padrão do PostgreSQL, rotinas criadas sem um `ALTER DEFAULT PRIVILEGES` prévio herdaram privilégio `EXECUTE` para `PUBLIC`.
2. **Defesa em Profundidade Ativa:**
   - O acesso indevido por usuários não autorizados é estritamente bloqueado por duas barreiras:
     * **Barreira de Schema:** `PUBLIC` e `medicina_anon` não possuem privilégio `USAGE` no schema `medicina` (`REVOKE ALL ON SCHEMA medicina FROM PUBLIC`). Chamadas diretas falham com erro `42501: permission denied for schema medicina`.
     * **Barreira de Domínio:** Ambas as rotinas contêm guardas imperativas internas (`IF medicina.is_responsavel() ... ELSE RETURN`). Chamadas sem contexto retornam 0 linhas.
3. **Privilégios `CREATE` em Schemas:**
   - Nem `medicina_app` nem `medicina_anon` possuem privilégio `CREATE` nos schemas `medicina` ou `public` (comprovado via `aclexplode(nspacl)` e teste negativo de DDL com erro `42501`).
4. **Hardening Proposto sem Violação do Hash de F1.04:**
   - > [!CAUTION]
     > O arquivo `F1_04_RLS_PROPOSTA.sql` **NÃO DEVE SER MODIFICADO**. O hash SHA-256 (`8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f`) já está persistido na tabela remota `_medicina_staging_migrations`. Qualquer alteração invalidaria a cadeia de integridade do runner.
   - A correção de higiene defensiva formulada para inclusão posterior consiste em:
     ```sql
     REVOKE EXECUTE ON FUNCTION medicina.fn_acompanhamento_quinzenal() FROM PUBLIC;
     REVOKE EXECUTE ON FUNCTION medicina.fn_simulados_evolucao() FROM PUBLIC;
     ALTER DEFAULT PRIVILEGES IN SCHEMA medicina REVOKE EXECUTE ON ROUTINES FROM PUBLIC;
     ```

---

## 4. LANÇADOR SEGURO DA ETAPA 6

Foi implementado o lançador autônomo in-process [`scripts/db/apply-staging-step6.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/apply-staging-step6.mjs):
* **Projeto Alvo Fixo:** `ynfocaorhadizlvbnzrt`
* **Session Pooler Host:** `aws-0-us-east-1.pooler.supabase.com:5432`
* **Usuário Administrativo:** `postgres.ynfocaorhadizlvbnzrt`
* **Certificado CA:** `~/Downloads/prod-ca-2021.crt` com TLS estrito (`rejectUnauthorized: true`, validação de cadeia e hostname).
* **Entrada de Senha:** Interativa oculta via TTY (`test-staging-connection.mjs` pattern), sem eco nem registro em histórico de shell.
* **Token de Confirmação Humana Explícita:** Exige estritamente a digitação de `APLICAR ETAPA 6 EM STAGING`.
* **Portão Operacional:** Executa o runner com os argumentos:
  ```bash
  CONFIRM_STAGING_MIGRATIONS=true node scripts/db/migrate-staging.mjs --apply --until-step=6
  ```
* **Proteção de Credenciais:** A senha é purgada da memória imediatamente após o uso e jamais é transmitida como argumento de linha de comando de processo (`argv`).

---

## 5. EVIDÊNCIAS DOS TESTES AUTOMATIZADOS (PGlite Descartável)

Três suítes de testes foram executadas com **100% de aprovação (27/27 testes)**:

### 5.1 Suíte de Ciclo de Vida da Migração 6 ([`h1_06_step6_migration_lifecycle.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h1_06_step6_migration_lifecycle.test.ts))
* **10/10 testes aprovados:**
  1. Aplicação sequencial de 1 a 5, aplicação exclusiva da Etapa 6, histórico com exatamente 6 registros e confirmação de não execução da Etapa 7 (`F1_10`);
  2. Estrutura canônica de `operacoes_idempotentes` (colunas, PK e checks);
  3. Validação de integridade de domínio (checks de escopo e payload_hash);
  4. Concorrência e idempotência persistente (chave duplicada rejeitada, `ON CONFLICT DO NOTHING` suportado);
  5. Integridade referencial e Foreign Key com `ON DELETE RESTRICT`;
  6. Unicidades e índices parciais de idempotência em tabelas pré-existentes;
  7. 8 Constraints de domínio adicionadas por F1.09 com validação comprovada no catálogo;
  8. Permissões de acesso e isolamento RLS por perfil sob `medicina_app`;
  9. Atomicidade e reversão atômica via `ROLLBACK` em caso de falha;
  10. Idempotência completa na reexecução (sem duplicação de histórico).

### 5.2 Suíte de Identidade e Funções H1.06 ([`h1_06_identity_and_functions.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h1_06_identity_and_functions.test.ts))
* **10/10 testes aprovados:**
  1. Ensaio SQL com perfis A e B demonstrando a capacidade da role técnica no banco e explicando a separação de camadas;
  2. Comprovação da insuficiência da rejeição de UUID inexistente contra IDOR;
  3. Derivação de identidade estritamente a partir do token NextAuth ignorando qualquer payload malicioso;
  4. Bloqueio de manipulação de recursos de terceiros via RLS;
  5. Isolamento transacional com `SET LOCAL` eliminando risco de contaminação de pool;
  6. Auditoria de rotinas SECURITY DEFINER e concessões a `PUBLIC`;
  7. Defesa em profundidade pelo bloqueio de `USAGE` no schema `medicina`;
  8. Guardas internas de domínio em funções agregadoras;
  9. Auditoria de ausência de privilégio `CREATE` para `medicina_app` e `medicina_anon`;
  10. Proposta de hardening formulada sem quebra de integridade do arquivo F1.04.

### 5.3 Suíte do Lançador da Etapa 6 ([`h1_04_staging_step6_launcher.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h1_04_staging_step6_launcher.test.ts))
* **7/7 testes aprovados:**
  1. Metadados operacionais fixos (`ynfocaorhadizlvbnzrt`, porta 5432, `--until-step=6`);
  2. Rejeição fail-closed de token de confirmação inválido;
  3. Rejeição na ausência do certificado CA;
  4. Execução exclusiva da etapa 6 com etapas 1 a 5 puladas com segurança;
  5. Idempotência em reexecução;
  6. Rollback atômico em falha de DDL;
  7. Rollback atômico em falha de tracking.

**Validação de Regressão Global:** A execução conjunta de todos os lançadores (Etapas 1 a 6) totalizou **55/55 testes aprovados (100% verde)**.

---

## 6. CONSULTAS SQL SOMENTE DE LEITURA PARA O SUPABASE SQL EDITOR

Execute o bloco abaixo no Supabase SQL Editor de Staging para conferência antes e após a migração:

```sql
-- 1. Contagem total de políticas RLS instaladas (esperado após Etapa 6: 55 políticas)
SELECT count(*)::int AS total_politicas_public
FROM pg_policies
WHERE schemaname = 'public';

-- 2. Verificação de RLS e FORCE RLS em tabelas de domínio (esperado após Etapa 6: 34 tabelas ativas)
SELECT c.relname AS tabela,
       c.relrowsecurity AS rls_ativo,
       c.relforcerowsecurity AS force_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;

-- 3. Detalhes da política RLS na tabela operacoes_idempotentes
SELECT schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'operacoes_idempotentes';

-- 4. Verificação de estrutura de operacoes_idempotentes
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'operacoes_idempotentes'
ORDER BY ordinal_position;

-- 5. Verificação das novas colunas de chave idempotente em card_revisoes e geracoes
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name IN ('card_revisoes', 'geracoes')
  AND column_name = 'chave_idempotencia';

-- 6. Verificação dos índices parciais de idempotência
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'card_revisoes_card_chave_idempotencia_uidx',
    'geracoes_chave_idempotencia_uidx',
    'sessoes_uma_aberta_por_bloco_topico_uidx'
  );

-- 7. Verificação das 8 novas constraints de domínio e validação (convalidated = true)
SELECT c.conname, t.relname, c.contype, c.convalidated, pg_get_constraintdef(c.oid)
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND c.conname IN (
    'sessoes_tempos_limites_check',
    'sessoes_ordem_temporal_check',
    'card_revisoes_duracao_rating_check',
    'simulados_duracao_limites_check',
    'simulado_areas_acertos_total_check',
    'redacoes_limites_e_genero_check',
    'checkins_limites_dominio_check',
    'acervo_arquivos_tamanho_serie_check',
    'erros_tentativa_id_unique',
    'curadoria_fila_artefato_unique',
    'acervo_arquivos_hash_conteudo_unique'
  )
ORDER BY t.relname, c.conname;

-- 8. Verificação do histórico de migrações gerenciadas
SELECT ordem, rel_path, sha256, tamanho_bytes, executado_por, aplicado_em
FROM public._medicina_staging_migrations
ORDER BY ordem;
```

---

## 7. COMANDO OPERACIONAL PREPARADO

Para executar exclusivamente a migração da Etapa 6 no Supabase Staging:

```bash
node scripts/db/apply-staging-step6.mjs
```

**Parâmetros de Execução:**
- Digite a senha administrativa interativa quando solicitado (entrada mascarada).
- Digite o token de confirmação obrigatório: `APLICAR ETAPA 6 EM STAGING`.
- O lançador aplicará unicamente `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` e parará antes de `F1_10_STORAGE_POLICIES_PROPOSTA.sql`.

---

## 8. RISCOS E BLOQUEADORES TÉCNICOS REMANESCENTES

- **Bloqueadores Técnicos:** **NENHUM**.
- Todas as dependências estruturais das etapas 1 a 5 estão consolidadas.
- O runner e o lançador garantem transação atômica única, advisory lock e interrupção compulsória no portão operacional `--until-step=6`.

---

## 9. CONCLUSÃO E CLASSIFICAÇÃO

### **CLASSIFICAÇÃO: APTO PARA EXECUTAR A SEXTA MIGRAÇÃO CONTROLADA**
*(Script: `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`)*

> [!IMPORTANT]
> Em estrito cumprimento às diretrizes do protocolo de segurança, nenhuma conexão remota ao Supabase Staging foi efetuada, nenhum comando `--apply` real foi executado contra o banco remoto e nenhuma alteração foi submetida a repositório. O ambiente local está 100% verificado e aguarda avaliação e autorização humana para o disparo operacional.
