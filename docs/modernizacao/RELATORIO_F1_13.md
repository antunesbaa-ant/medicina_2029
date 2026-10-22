# RELATÓRIO F1.13 — CONSOLIDAÇÃO TÉCNICA E PREPARAÇÃO PARA HOMOLOGAÇÃO

**Projeto:** Medicina 2029  
**Tarefa:** F1.13 — Consolidação Técnica e Preparação para Homologação  
**Data:** 21/10/2026  
**Classificação Final:** **APROVADA COM RESSALVAS**

---

## 1. Sumário Executivo e Divergência de Escopo no Plano

### 1.1 Divergência de Escopo Identificada e Preservação das Prioridades Originais
Conforme verificado em `docs/modernizacao/PLANO_MODERNIZACAO.md` antes desta execução, o identificador `F1.13` estava originalmente reservado para **"Estado server-side do ciclo e cronômetro"** (seguido por `F1.14 — Backup completo e recuperação testada` e `F1.15 — Testes de segurança, E2E e operação`).

Por determinação explícita desta tarefa, o identificador **F1.13** foi utilizado para executar a **Consolidação Técnica e Preparação para Homologação** das entregas `F1.03-R`, `F1.04`, `F1.09`, `F1.10`, `F1.11` e `F1.12`. Todas as prioridades originais do plano foram integralmente preservadas em `docs/modernizacao/PLANO_MODERNIZACAO.md`, renumeradas sequencialmente sem qualquer supressão de escopo:

- **F1.13:** Consolidação técnica e preparação para homologação *(concluída neste relatório)*;
- **F1.14:** Estado server-side do ciclo e cronômetro *(anteriormente F1.13 — prioridade preservada)*;
- **F1.15:** Backup completo e recuperação testada *(anteriormente F1.14 — prioridade preservada)*;
- **F1.16:** Testes de segurança, E2E e operação *(anteriormente F1.15 — prioridade preservada)*.

### 1.2 Síntese dos Resultados da Consolidação
A auditoria cruzada entre as propostas SQL (`0003_f1_03_r_expansao.sql`, `F1_04`, `F1.09`, `F1.10`, `F1.11` e `F1.12`), o schema Drizzle (`src/db/schema.ts`) e os módulos de runtime (`acervo.ts`, `acervoPipelineWorker.ts`, `ingestion.ts`, `busca.ts`, `curadoria.ts`, `supabaseStorage.ts` e `src/db/index.ts`) identificou **7 incompatibilidades técnicas críticas** que impediriam a homologação conjunta sob RLS ativo (`FORCE ROW LEVEL SECURITY`). Todas as 7 foram corrigidas de forma cirúrgica e comprovadas em banco PostgreSQL 18.6 descartável (`PGlite` + `pgvector`):

1. **Unificação das funções auxiliares RLS (`schema medicina`) e correção de nomes na F1.11:** corrigida a referência a funções inexistentes (`public.rls_current_perfil_id()` e `public.rls_is_responsavel()`) em `F1_11_FILA_INGESTAO_PROPOSTA.sql` para usar `medicina.current_perfil_id()` e `medicina.is_responsavel()`, e unificada a definição de `medicina.current_papel()`, `medicina.is_estudante()` e `medicina.is_responsavel()` entre `F1_04_RLS_PROPOSTA.sql` e `F1_10_STORAGE_POLICIES_PROPOSTA.sql` (exigindo `medicina.current_perfil_id() IS NOT NULL`).
2. **Fechamento da lacuna de RLS e privilégios em `public.operacoes_idempotentes` (F1.09):** adicionados `ENABLE/FORCE ROW LEVEL SECURITY`, policy `operacoes_idempotentes_own_policy` (`perfil_id = medicina.current_perfil_id()`) e `GRANT SELECT, INSERT, UPDATE, DELETE` para `medicina_app` em `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` (e suporte condicional em `F1_04_RLS_PROPOSTA.sql`).
3. **Idempotência de reaplicação DDL na F1.09:** os comandos `ALTER TABLE ... ADD CONSTRAINT ... NOT VALID` em `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` passaram a ser precedidos por `DROP CONSTRAINT IF EXISTS`, garantindo reaplicação idempotente.
4. **Provisionamento de papel de mínimo privilégio `medicina_worker` (`NOSUPERUSER NOBYPASSRLS`):** criado o papel dedicado `medicina_worker` em `F1_11_FILA_INGESTAO_PROPOSTA.sql` (e suporte à conexão `DATABASE_WORKER_URL` em `src/db/index.ts` e `src/lib/env.ts`), com `GRANT` e policies RLS estritamente limitados às tabelas do pipeline (`acervo_jobs`, `acervo_arquivos`, `acervo_paginas`, `acervo_chunks`, `topicos`, `disciplinas`) e leitura de objetos registrados em `storage.objects` (`F1_10_STORAGE_POLICIES_PROPOSTA.sql`), sem qualquer acesso a tabelas sensíveis (`perfis`, `allowlist`, `sessoes`, `checkins`, `simulados`, `redacoes`, `curadoria_fila`).
5. **Viabilização da busca híbrida para `estudante` vinculada sob RLS forçado:** como a F1.04 bloqueia `SELECT` direto de `estudante` em `public.acervo_arquivos` (Cenário C14), o `INNER JOIN public.acervo_arquivos` em `buscaHibridaAcervo` retornava 0 linhas para estudantes sob `medicina_app`. Foi criada a função `medicina.fn_busca_hibrida_acervo` (`SECURITY DEFINER` com `search_path = public, medicina, pg_temp` e validação anti-spoofing de `medicina.current_perfil_id()`) em `F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` e integrada a `buscaHibridaAcervo` (`src/lib/ingestion.ts`), preservando 100% do isolamento de C14.
6. **Constraint de proveniência em `public.cards` (`cards_gerado_proveniencia_check`):** adicionada em `F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` para impedir que cards FSRS com `origem = 'gerado'` sejam persistidos com `fonte_chunk_ids` vazio.
7. **Verificação imediata de integridade SHA-256 e tamanho após `OBJECT_EXISTS` no upload síncrono:** `enviarArquivo` (`src/app/actions/acervo.ts`) agora baixa imediatamente o objeto existente via `downloadFromSupabaseStorage(filePath)` quando o Storage reporta `OBJECT_EXISTS`, recalcula o SHA-256 e compara o tamanho em bytes antes de adotar o objeto no banco, rejeitando divergências com `CONFLICT` e falhas de leitura com `EXTERNAL_SERVICE_ERROR`.

---

## 2. Auditoria de Migrations e Dependências (Execução — Item 1)

### 2.1 Ordem Canônica de Aplicação e Grafo de Dependências
A sequência obrigatória de aplicação sobre o schema base (`0000_greedy_loki.sql` → `0001_dry_talos.sql` → `0002_little_swarm.sql` → `0003_f1_03_r_expansao.sql`) foi validada de ponta a ponta:

| Ordem | Script SQL | Dependências Diretas | Objetos Criados / Alterados | Script de Rollback Correspondente |
| :--- | :--- | :--- | :--- | :--- |
| **1** | `drizzle/0003_f1_03_r_expansao.sql` | `0000`..`0002` | Colunas de ownership (`perfil_id`, `enviado_por`, `aprovado_por`), `responsavel_estudante` | `drizzle/propostas/F1_03_R_ROLLBACK_EXPANSAO.sql` |
| **2** | `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql` | `0003_f1_03_r_expansao.sql` | Schema `medicina`, funções de contexto/auth, papéis `medicina_app`, `medicina_auth`, `medicina_anon`, RLS forçado nas 33 tabelas base + views analíticas | `docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql` |
| **3** | `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` | `0003`, `F1_04` (opcional/compatível) | Tabela `public.operacoes_idempotentes` (+ RLS/GRANT), colunas `chave_idempotencia`, índices parciais únicos e 17 constraints `CHECK` (`NOT VALID` + `VALIDATE`) | `docs/modernizacao/propostas/F1_09_ROLLBACK_INTEGRIDADE_E_IDEMPOTENCIA.sql` |
| **4** | `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql` | `0003`, `F1_04`, `F1_09` | Funções `medicina.is_valid_acervo_storage_path`, constraint privada no bucket `acervo` (`20 MiB`, `application/pdf`) e 5 policies RLS em `storage.buckets` e `storage.objects` | `docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql` |
| **5** | `docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql` | `0003`, `F1_04`, `F1_10` | Tabela `public.acervo_jobs`, enums de fila, trigger `trg_acervo_jobs_set_atualizado_em`, uniques `acervo_paginas_arquivo_numero_unique` e `acervo_chunks_arquivo_ordem_unique`, backfill, papel `medicina_worker` e policies RLS do pipeline | `docs/modernizacao/propostas/F1_11_ROLLBACK_FILA_INGESTAO.sql` |
| **6** | `docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` | `0003`, `F1_04`, `F1_11`, `vector` | Índices HNSW (`vector_cosine_ops`), GIN FTS (`portuguese`), B-tree (`arquivo_id, ordem`), constraints de proveniência em `questoes`, `cards`, `geracoes` e função `medicina.fn_busca_hibrida_acervo` | `docs/modernizacao/propostas/F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql` |

> **Nota sobre flexibilidade de ordem:** `F1_04_RLS_PROPOSTA.sql` foi atualizada na F1.13 com blocos condicionais (`IF to_regclass('public.operacoes_idempotentes') IS NOT NULL` e `IF to_regclass('public.acervo_jobs') IS NOT NULL`) para que tanto a aplicação na ordem canônica (`F1.04` → `F1.09` → `F1.10` → `F1.11` → `F1.12`) quanto uma eventual reaplicação posterior de `F1.04` mantenham 100% das tabelas com RLS habilitado, forçado e com privilégios consistentes.

### 2.2 Compatibilidade com Schema Drizzle (`src/db/schema.ts`)
- Todas as 35 tabelas do schema `public` (33 tabelas base + `operacoes_idempotentes` + `acervo_jobs`), enums (`status_processamento`, `acervo_job_status`, `acervo_job_etapa`, `tipo_material`, `origem`, `status_curadoria`, `papel`, etc.), nomes reais de colunas e tipos (`vector(1536)` em `acervo_chunks.embedding`) estão 100% alinhados com `src/db/schema.ts`.
- O comando `npx drizzle-kit check` confirmou a consistência estrutural sem divergências.

### 2.3 Incompatibilidades SQL Confirmadas e Corrigidas na F1.13

| ID | Arquivo(s) Afetado(s) | Incompatibilidade Detectada | Correção Aplicada na F1.13 |
| :--- | :--- | :--- | :--- |
| **INC-01** | `F1_11_FILA_INGESTAO_PROPOSTA.sql`, `F1_04_RLS_PROPOSTA.sql`, `F1_04_ROLLBACK_RLS.sql` | A F1.11 verificava `to_regprocedure('public.rls_is_responsavel()')` e `public.rls_current_perfil_id()`, mas a F1.04 cria as funções no schema `medicina` (`medicina.is_responsavel()` e `medicina.current_perfil_id()`). Consequentemente, a policy `acervo_jobs_responsavel_all` nunca era criada e `acervo_jobs` ficava sem policy em `FORCE ROW LEVEL SECURITY`. | Corrigida a F1.11 para referenciar `medicina.is_responsavel()` e `medicina.current_perfil_id()`, além de incluir `acervo_jobs` nos blocos condicionais de `F1_04_RLS_PROPOSTA.sql` e `F1_04_ROLLBACK_RLS.sql`. |
| **INC-02** | `F1_04_RLS_PROPOSTA.sql`, `F1_10_STORAGE_POLICIES_PROPOSTA.sql` | `F1_04` definia `medicina.current_papel()` sem checar `medicina.current_perfil_id() IS NOT NULL`, enquanto `F1_10` sobrescrevia a função exigindo `current_perfil_id() IS NOT NULL`. Se aplicadas fora de ordem, o comportamento de `is_estudante()`/`is_responsavel()` divergia. | Unificadas as definições de `medicina.current_perfil_id()`, `medicina.current_papel()`, `medicina.is_estudante()` e `medicina.is_responsavel()` em `F1_04` e `F1_10` (sempre exigindo `medicina.current_perfil_id() IS NOT NULL`). |
| **INC-03** | `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`, `F1_04_RLS_PROPOSTA.sql` | `public.operacoes_idempotentes` era criada na F1.09 sem `ENABLE/FORCE ROW LEVEL SECURITY` e sem `GRANT` para `medicina_app` caso `F1_09` rodasse após `F1_04`. Além disso, `ADD CONSTRAINT ... NOT VALID` falhava na segunda execução (não idempotente). | Adicionados `DROP CONSTRAINT IF EXISTS` antes de cada `ADD CONSTRAINT`, `GRANT SELECT, INSERT, UPDATE, DELETE` para `medicina_app` e `ENABLE/FORCE ROW LEVEL SECURITY` com policy `operacoes_idempotentes_own_policy` (`perfil_id = medicina.current_perfil_id()`). |
| **INC-04** | `F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql`, `F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql` | A F1.12 adicionava constraint de proveniência para `questoes` e `geracoes`, mas não para `public.cards` (`origem = 'gerado'` com `fonte_chunk_ids` vazio). | Adicionada `cards_gerado_proveniencia_check` (`origem <> 'gerado' OR (jsonb_typeof(fonte_chunk_ids) = 'array' AND jsonb_array_length(fonte_chunk_ids) > 0)`) com `NOT VALID` + `VALIDATE CONSTRAINT` e remoção correspondente no rollback. |

---

## 3. Auditoria e Endurecimento de Segurança (Execução — Item 2)

### 3.1 Matriz Consolidada de Papéis PostgreSQL
Todos os quatro papéis de banco são provisionados com `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN`:

| Papel PostgreSQL | Variável de Conexão | Escopo de Uso | Acesso a `perfis.password_hash` | Acesso a Tabelas de Estudo (`sessoes`, `checkins`, `cards`, `simulados`) | Acesso a `acervo_*` e `storage.objects` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`medicina_app`** | `DATABASE_URL` | Requisições autenticadas da aplicação web (Server Actions / SSR) | **NEGADO** (Column-Level Grant revoga `password_hash`) | Permitido **somente sob contexto RLS** (`medicina.set_context`) e conforme papel (`estudante` vs `responsavel`) | `responsavel`: CRUD nos próprios arquivos/jobs/storage; `estudante`: **sem `SELECT` direto**, busca apenas via `medicina.fn_busca_hibrida_acervo` |
| **`medicina_auth`** | `DATABASE_AUTH_URL` | Fluxo exclusivo de login `NextAuth` (`authorize`) | **Somente via `medicina.autenticar_por_email(text)`** (`SECURITY DEFINER` com filtro obrigatório na `allowlist`) | **NEGADO** (`0` permissões em tabelas de domínio) | **NEGADO** |
| **`medicina_worker`** | `DATABASE_WORKER_URL` | Worker independente de ingestão de PDFs (`acervoPipelineWorker.ts`) | **NEGADO** (`0` permissões em `perfis` e `allowlist`) | **NEGADO** (`0` permissões em `sessoes`, `checkins`, `cards`, `questoes`, `simulados`, `redacoes`, `curadoria_fila`) | `SELECT/INSERT/UPDATE/DELETE` em `acervo_jobs`; `SELECT/UPDATE` em `acervo_arquivos`; `SELECT/INSERT/UPDATE` em `acervo_paginas` e `acervo_chunks`; `SELECT` em `topicos`, `disciplinas`, `storage.buckets` e `storage.objects` |
| **`medicina_anon`** | N/A (fallback sem sessão) | Conexões não autenticadas | **NEGADO** | **NEGADO** (`fail-closed`: 0 linhas / `42501`) | **NEGADO** |

### 3.2 Dependências do Contexto RLS (`medicina.set_context`)
- Todas as policies de `medicina_app` dependem de `medicina.current_perfil_id()` e `medicina.current_papel()`, alimentadas por `medicina.set_context(p_perfil_id uuid, p_papel text)`.
- `medicina.set_context` executa `set_config(..., true)` (`is_local => true`), garantindo que o contexto expire automaticamente ao final da transação (`COMMIT`/`ROLLBACK`) e nunca vaze em pools de conexão reutilizados.
- Sem transação ativa ou sem chamada prévia a `medicina.set_context`, todas as políticas avaliam para `false` (**fail-closed**).

### 3.3 Permissões do Worker (`medicina_worker`)
- Antes da F1.13, o worker dependia de privilégios amplos de banco ou não possuía policies dedicadas nas tabelas `acervo_*` quando `FORCE ROW LEVEL SECURITY` estava ativo.
- Na F1.13:
  - `F1_11_FILA_INGESTAO_PROPOSTA.sql` cria o papel `medicina_worker` (`NOSUPERUSER NOBYPASSRLS`) com `GRANT` restrito às 6 tabelas envolvidas no pipeline (`acervo_jobs`, `acervo_arquivos`, `acervo_paginas`, `acervo_chunks`, `topicos`, `disciplinas`), `GRANT EXECUTE` nas funções de leitura de contexto `medicina.current_perfil_id()`, `medicina.current_papel()`, `medicina.is_estudante()`, `medicina.is_responsavel()` (necessárias para que o PostgreSQL avalie as expressões booleanas das demais policies permissivas nas mesmas tabelas sem erro `42501`), e policies `USING (current_user = 'medicina_worker')` / `WITH CHECK (current_user = 'medicina_worker')` somente nessas 6 tabelas.
  - `F1_10_STORAGE_POLICIES_PROPOSTA.sql` adiciona a policy `acervo_objects_worker_select` permitindo ao `medicina_worker` ler (`FOR SELECT`) objetos do bucket privado `acervo` que possuam caminho válido (`medicina.is_valid_acervo_storage_path(name)`) e estejam registrados em `public.acervo_arquivos`.
  - `src/db/index.ts` e `src/lib/env.ts` expõem `resolveDatabaseWorkerUrl()` e `DATABASE_WORKER_URL`.

### 3.4 Auditoria das Funções `SECURITY DEFINER`
Existem exatamente **5 funções `SECURITY DEFINER`** em toda a arquitetura proposta, todas com `SET search_path` explícito e privilégios `EXECUTE` revogados de `PUBLIC` e `medicina_anon`:

1. `medicina.set_context(uuid, text)`: `SET search_path = public, medicina, pg_temp`. Valida existência estrita do par `(id, papel)` em `public.perfis`. `EXECUTE` exclusivo para `medicina_app`.
2. `medicina.clear_context()`: `SET search_path = public, medicina, pg_temp`. Limpa `medicina.current_perfil_id` e `medicina.current_papel`. `EXECUTE` exclusivo para `medicina_app`.
3. `medicina.autenticar_por_email(text)`: `SET search_path = public, medicina, pg_temp`. Verifica presença prévia em `public.allowlist` (anti-enumeração). `EXECUTE` exclusivo para `medicina_auth` (`medicina_app` não possui permissão).
4. `medicina.fn_busca_hibrida_acervo(text, vector, uuid, integer, double precision, text, uuid)` *(adicionada na F1.13 em `F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql`)*: `SET search_path = public, medicina, pg_temp`. Quando invocada por `medicina_app` (ou com contexto RLS ativo), exige `medicina.current_perfil_id() IS NOT NULL`, rejeita com `42501` qualquer tentativa de passar `p_perfil_id` ou `p_papel` divergente do contexto RLS, e retorna apenas trechos (`acervo_chunks`) de arquivos com `status_processamento = 'concluido'` pertencentes ao próprio responsável ou a responsável vinculado à estudante em `public.responsavel_estudante`. `EXECUTE` exclusivo para `medicina_app`.
5. `public.fn_acervo_jobs_set_atualizado_em()`: `SET search_path = public, pg_temp`. Trigger interna de atualização de `atualizado_em` em `public.acervo_jobs`.

---

## 4. Auditoria de Acervo, IA e Integridade após `OBJECT_EXISTS` (Execução — Item 3)

### 4.1 Verificação Imediata de Integridade do Objeto Reaproveitado após `OBJECT_EXISTS`
Na F1.10/F1.11/F1.12, quando o upload para `acervo/<sha256>.pdf` recebia `OBJECT_EXISTS` do Supabase Storage (por exemplo, após falha anterior de `INSERT` no banco), `enviarArquivo` adotava o caminho no banco e delegava a conferência do hash para a execução assíncrona do worker (`STORAGE_HASH_MISMATCH`). Isso estava registrado como bloqueador de publicação.

**Correção implementada na F1.13 (`src/app/actions/acervo.ts`, linhas 146–173):**
- Ao capturar `StorageOperationError` com `code === 'OBJECT_EXISTS'`, `enviarArquivo` executa imediatamente `downloadFromSupabaseStorage(filePath)` antes de abrir qualquer transação ou inserir metadados em `public.acervo_arquivos`.
- Se o download de verificação falhar, retorna `EXTERNAL_SERVICE_ERROR` (`"O arquivo já consta no armazenamento, mas não foi possível verificar sua integridade. Nenhum processamento foi iniciado."`).
- Calcula `crypto.createHash('sha256').update(bytesArmazenados).digest('hex')` e compara tanto `bytesArmazenados.length === fileBuffer.length` quanto `hashArmazenado.toLowerCase() === hash.toLowerCase()`.
- Se houver qualquer divergência de tamanho ou SHA-256, registra `logOperationalFailure('acervo.upload.storage_hash_mismatch', 'external_service')` e retorna `CONFLICT` (`"O objeto existente no armazenamento diverge do conteúdo enviado (falha de integridade SHA-256). Nenhum cadastro foi realizado."`), sem gravar registro no banco e sem enfileirar job.
- A verificação adicional no worker (`acervoPipelineWorker.ts`) foi preservada como segunda camada de defesa em profundidade (Zero Trust).

### 4.2 Fluxo Integrado: Upload → Fila → Worker (`medicina_worker`) → OCR/Embeddings → Busca Híbrida → Proveniência
1. **Upload e Enfileiramento (`acervo.ts`):** valida PDF (20 MiB, `%PDF-`, `%%EOF`, ausência de `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFiles`, `/RichMedia`, `/XFA`), persiste ou reconcilia o objeto privado com verificação imediata de SHA-256, insere metadados em `acervo_arquivos` e registra o job durável em `acervo_jobs` via `enfileirarJobIngestaoAcervo`.
2. **Worker Retomável (`acervoPipelineWorker.ts`):** opera sob `medicina_worker` (`NOBYPASSRLS`), faz claim atômico compare-and-swap, mantém lease/heartbeat, executa chamadas externas de OCR (`gemini-2.5-flash`) e embeddings (`gemini-embedding-001` em 1536 dimensões normalizadas L2) **fora de transações PostgreSQL**, e em caso de falha parcial preserva páginas, chunks, classificações e embeddings já gravados (`WHERE embedding IS NULL`).
3. **Busca Semântica Híbrida (`busca.ts` / `ingestion.ts`):** gera embedding 1536-d da consulta e executa `medicina.fn_busca_hibrida_acervo` combinando similaridade cosseno (`1 - (embedding <=> query_vector)`) e ranking lexical (`ts_rank_cd` em português), respeitando ownership tanto para `responsavel` quanto para `estudante` vinculada sob `medicina_app` + RLS forçado.
4. **Proveniência e Curadoria Humana (`curadoria.ts`):** todo conteúdo gerado por IA exige `fonteChunkIds` não vazio pertencente ao `arquivoOrigemId`, nasce obrigatoriamente como `rascunho`/`pendente`, e só é promovido a `aprovado` (ou inserido em `public.cards` com `fonte_chunk_ids` validado pela constraint `cards_gerado_proveniencia_check`) mediante ação humana explícita de um `responsavel` autorizado.

---

## 5. Plano e Checklist Objetivo de Homologação (Execução — Item 5)

### 5.1 Pré-requisitos de Infraestrutura
- [ ] Instância PostgreSQL 15+ (compatível com PostgreSQL 18.6 validado em testes) com extensões `pgcrypto` e `vector` (`pgvector >= 0.7.0` com suporte a índice `hnsw`).
- [ ] Bucket `acervo` criado no Supabase Storage com `public = false`, `file_size_limit = 20971520` (20 MiB) e `allowed_mime_types = ['application/pdf']`.
- [ ] Chave `GEMINI_API_KEY` dedicada por ambiente (homologação separada de produção) com acesso aos modelos `gemini-embedding-001` e `gemini-2.5-flash`.
- [ ] Quatro papéis PostgreSQL criados com senhas fortes e distintas no cofre de segredos: `medicina_app`, `medicina_auth`, `medicina_worker` e usuário administrativo de migração.

### 5.2 Backups Obrigatórios Antes da Mudança
- [ ] **Backup lógico/físico completo do PostgreSQL:** `pg_dump --format=custom --blobs --verbose --file=backup_pre_f113.dump` + snapshot point-in-time (PITR) confirmado.
- [ ] **Manifesto de objetos do Storage:** executar `diagnosticarReconciliacaoAcervo` (somente leitura) e salvar o snapshot JSON com lista de objetos em `acervo/` e hashes SHA-256 de `public.acervo_arquivos`.
- [ ] **Teste de restauração prévio:** validar restauração do dump em banco efêmero de homologação antes de iniciar a janela.

### 5.3 Configuração das Conexões e Variáveis de Ambiente
Configurar no ambiente de homologação (conforme `.env.example` e `src/lib/env.ts`):
- `DATABASE_URL`: string de conexão utilizando o papel `medicina_app` (`NOSUPERUSER NOBYPASSRLS`).
- `DATABASE_AUTH_URL`: string de conexão utilizando o papel `medicina_auth` (`NOSUPERUSER NOBYPASSRLS`).
- `DATABASE_WORKER_URL`: string de conexão utilizando o papel `medicina_worker` (`NOSUPERUSER NOBYPASSRLS`).
- `NEXTAUTH_SECRET` e `NEXTAUTH_URL`: exclusivos do ambiente de homologação.
- `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`: exclusivos do projeto Supabase de homologação (nunca expor `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`).
- `GEMINI_API_KEY`, `GEMINI_EMBEDDING_MODEL=gemini-embedding-001`, `GEMINI_OCR_MODEL=gemini-2.5-flash`, `GEMINI_GENERATION_MODEL=gemini-2.5-flash`.

### 5.4 Ordem Exata de Implantação (Passo a Passo)
1. **Ativar janela de manutenção** e pausar consumidores de jobs/workers existentes.
2. **Executar auditorias preflight (somente leitura)** contidas no cabeçalho de:
   - `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql`
   - `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`
   - `docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql`
   - `docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql`
   *(Confirmar 0 linhas órfãs ou violadoras antes de aplicar DDL).*
3. **Aplicar `drizzle/0003_f1_03_r_expansao.sql`** (caso ainda não aplicado no ambiente alvo) e validar preenchimento das colunas de ownership.
4. **Aplicar `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql`** (cria schema `medicina`, funções de contexto/auth, papéis `medicina_app`, `medicina_auth`, `medicina_anon` e RLS nas tabelas base).
   > **Atenção:** a ativação de `FORCE ROW LEVEL SECURITY` para conexões `medicina_app` exige que o wrapper transacional `withRlsContext` (`SELECT medicina.set_context(perfil_id, papel)`) esteja ativo nas chamadas do runtime.
5. **Aplicar `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`** (cria `operacoes_idempotentes` com RLS/GRANT, índices parciais de idempotência e constraints `CHECK`).
6. **Aplicar `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql`** (configura bucket privado `acervo` e policies RLS em `storage.buckets` e `storage.objects`).
7. **Aplicar `docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql`** (cria `public.acervo_jobs`, uniques de páginas/chunks, executa backfill dos arquivos existentes, provisiona `medicina_worker` e policies RLS do pipeline).
8. **Aplicar `docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql`** (cria índices HNSW/GIN FTS, constraints de proveniência em `questoes`, `cards` e `geracoes`, e função `medicina.fn_busca_hibrida_acervo`).
9. **Publicar a build da aplicação Next.js** com as variáveis `DATABASE_URL`, `DATABASE_AUTH_URL`, `SUPABASE_*` e `GEMINI_*`.
10. **Iniciar o processo/agendador do worker independente** (`processarProximoJobAcervo` / `recuperarJobsComLeaseVencido`) conectado exclusivamente via `DATABASE_WORKER_URL` (`medicina_worker`).

### 5.5 Worker e Agendador
- O worker deve rodar fora do ciclo de vida das requisições HTTP (processo Node.js dedicado, container worker ou cron job com lock de banco via `acervo_jobs`).
- Ciclo recomendado do agendador:
  1. A cada `60s`, executar `recuperarJobsComLeaseVencido(new Date())` para reenfileirar jobs cujo worker anterior tenha sofrido queda abrupta (`lease_expira_em < now()`).
  2. Em loop controlado (ou disparo a cada `5s..15s`), invocar `processarProximoJobAcervo(workerId)` até retornar `{ processado: false, motivo: 'FILA_VAZIA' }`.
- O lease padrão é de `180s` (`DEFAULT_LEASE_SECONDS = 180`), renovado a cada etapa e lote de indexação via `renovarHeartbeatJobAcervo`.

### 5.6 Testes Funcionais Essenciais de Homologação (Smoke Suite)
- [ ] **Autenticação (`medicina_auth`):** login com e-mail presente na `allowlist` (sucesso) e e-mail ausente na `allowlist` (rejeição genérica sem enumeração).
- [ ] **Upload e Integridade (`medicina_app` — `responsavel`):**
  - Enviar PDF digital válido (< 20 MiB) → `uploadStatus: 'concluido'`, `processamentoStatus: 'aguardando'`, job criado em `acervo_jobs`.
  - Reenviar o mesmo PDF → rejeição `CONFLICT` (`"Este arquivo já foi enviado anteriormente ao acervo."`).
  - Simular objeto órfão no Storage e reenviar PDF íntegro → adoção com verificação imediata de SHA-256 (`reconciliacao: 'objeto_existente_adotado'`).
- [ ] **Processamento pelo Worker (`medicina_worker`):**
  - Consumir o job com `processarProximoJobAcervo` → status transita `aguardando` → `processando` (`extracao` → `segmentacao` → `classificacao` → `indexacao` → `concluido`) com embeddings 1536-d gravados em `acervo_chunks`.
- [ ] **Busca Híbrida e Isolamento RLS (`medicina_app`):**
  - Executar `buscarNoAcervo` autenticado como o `responsavel` proprietário → retorna trecho com `arquivoId`, `paginaInicial`, `paginaFinal` e `similaridade`.
  - Executar `buscarNoAcervo` autenticado como `estudante` vinculada ao responsável → retorna o mesmo trecho via `medicina.fn_busca_hibrida_acervo`, enquanto `SELECT` direto em `acervo_arquivos` permanece bloqueado (0 linhas).
  - Executar `buscarNoAcervo` autenticado como `estudante` não vinculada → retorna `[]` (0 resultados).
- [ ] **Proveniência e Curadoria Humana (`curadoria.ts`):**
  - Gerar questão/flashcard a partir de tópico com chunks indexados → nasce como `rascunho` / `pendente` na `curadoria_fila` com `fonteChunkIds` preenchido.
  - Aprovar item como `responsavel` → status muda para `aprovado` e card FSRS é criado em `public.cards` com `fonte_chunk_ids` preservado.

### 5.7 Critérios Objetivos de Rollback e Sequência Reversa
Acionar rollback imediato se ocorrer qualquer um dos critérios abaixo durante a janela de homologação:
1. Qualquer erro `42501` (permissão negada) em operações legítimas de estudante ou responsável autenticado;
2. Qualquer vazamento cross-tenant nos testes de isolamento entre perfis;
3. Falha na criação dos índices HNSW/GIN ou lock de tabela superior a `30s`;
4. Falha do worker sob `medicina_worker` ao ler/atualizar `acervo_jobs`, `acervo_arquivos`, `acervo_paginas` ou `acervo_chunks`.

**Sequência exata de rollback SQL (ordem estritamente inversa à aplicação):**
1. Pausar o worker independente;
2. Executar `docs/modernizacao/propostas/F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql`;
3. Executar `docs/modernizacao/propostas/F1_11_ROLLBACK_FILA_INGESTAO.sql`;
4. Executar `docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql`;
5. Executar `docs/modernizacao/propostas/F1_09_ROLLBACK_INTEGRIDADE_E_IDEMPOTENCIA.sql`;
6. Executar `docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql`.
*(Sequência integralmente testada e comprovada no Teste 4 de `src/app/actions/f1_13_consolidacao_homologacao.test.ts`).*

### 5.8 Pendências que Bloqueiam Produção
1. **Integração automática do wrapper transacional `withRlsContext` (`medicina.set_context`) em todas as Server Actions:** o módulo `src/db/rls-context.ts` já existe e é validado em testes, mas as Server Actions ainda consultam `db` diretamente; antes de ativar `FORCE ROW LEVEL SECURITY` em produção com conexões `medicina_app`, todas as queries de `medicina_app` precisam executar dentro do wrapper `withRlsContext` (ou o pool de conexões deve injetar o contexto da sessão autenticada).
2. **Homologação no Supabase Storage remoto:** validar a aplicação de `F1_10_STORAGE_POLICIES_PROPOSTA.sql` contra o serviço gerenciado do Supabase Storage e confirmar o papel de conexão utilizado pela API de Storage (`service_role` vs JWT assinado).
3. **Execução das tarefas restantes do plano original:**
   - **F1.14:** Estado server-side do ciclo e cronômetro;
   - **F1.15:** Backup completo e recuperação testada;
   - **F1.16:** Testes de segurança, E2E e operação.

---

## 6. Testes e Validações Executadas

Todos os testes e validações foram executados localmente com PostgreSQL 18.6 descartável (`PGlite` + `pgvector`), dados sintéticos e mocks controlados de rede/Storage, sem qualquer acesso a serviços externos reais ou bancos persistentes:

| Verificação | Comando Executado | Resultado |
| :--- | :--- | :--- |
| **TypeScript (`tsc`)** | `npx tsc --noEmit` | **APROVADO** (0 erros) |
| **ESLint (arquivos alterados)** | `npx eslint src/db/index.ts src/lib/env.ts src/lib/ingestion.ts src/app/actions/acervo.ts src/app/actions/acervo.test.ts src/app/actions/f1_10_storage_integracao.test.ts src/app/actions/f1_13_consolidacao_homologacao.test.ts` | **APROVADO** (0 erros, 0 warnings) |
| **Consistência Drizzle** | `npx drizzle-kit check` | **APROVADO** (`Everything's fine`) |
| **Higiene de Diff Git** | `git diff --check` | **APROVADO** (0 problemas de whitespace/formatação) |
| **Suíte Completa Vitest** | `npm run test:run` | **APROVADO** (**30/30 suítes**, **254/254 testes** passando) |
| **Suíte de Consolidação F1.13 (PostgreSQL 18.6 + `pgvector`)** | `npx vitest run src/app/actions/f1_13_consolidacao_homologacao.test.ts` | **APROVADO** (4/4 cenários ponta a ponta: sequência completa `0000`..`0003` + `F1.04`..`F1.12`, verificação imediata de SHA-256 após `OBJECT_EXISTS`, pipeline sob `medicina_worker` + busca híbrida sob `medicina_app` para responsável e estudante vinculada, bloqueio de falsificação de perfil `42501`, constraint `cards_gerado_proveniencia_check` e rollback reverso completo `F1.12` → `F1.04` + reaplicação idempotente) |
| **Suíte RLS Completa (F1.04)** | `node scripts/f1_04/run-rls-validation.mjs` | **APROVADO** (**41/41 cenários** — 100% de sucesso, incluindo rollback e reaplicação) |
| **Build de Produção Next.js** | `npm run build` | **APROVADO** (Next.js 16.4.2 Turbopack compilado sem erros) |

---

## 7. Classificação Final

**Classificação:** **APROVADA COM RESSALVAS**

- **Justificativa:** Todas as incompatibilidades técnicas entre `F1.03-R`, `F1.04`, `F1.09`, `F1.10`, `F1.11` e `F1.12` foram identificadas, corrigidas e comprovadas em PostgreSQL 18.6 descartável com `pgvector`, incluindo a verificação síncrona imediata de integridade SHA-256 após `OBJECT_EXISTS`, o papel de mínimo privilégio `medicina_worker` (`NOBYPASSRLS`), a busca híbrida para estudantes vinculadas via `medicina.fn_busca_hibrida_acervo` sem abrir acesso direto a `acervo_arquivos`, e o ensaio completo de aplicação e rollback reverso. As ressalvas referem-se exclusivamente às etapas operacionais de infraestrutura (aplicação das migrations em janela autorizada, ativação do wrapper transacional `withRlsContext` nas Server Actions antes de `FORCE ROW LEVEL SECURITY` em produção, homologação das policies no Supabase Storage remoto e ativação do agendador do worker) e às tarefas subsequentes preservadas no plano (`F1.14`, `F1.15` e `F1.16`).
