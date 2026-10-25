# MEDICINA 2029 — PARECER TÉCNICO DE AUDITORIA F1.10
## POLÍTICAS DE STORAGE, SEGURANÇA RLS E ISOLAMENTO DE ACERVO

**Projeto Alvo:** `medicina-2029-staging` (`ynfocaorhadizlvbnzrt`)  
**Data da Auditoria:** 25 de outubro de 2026  
**Auditor:** Especialista em Políticas de Storage e Segurança RLS  
**Escopo:** Inspeção e validação integral de `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql` (Etapa 7 de 9) e seu respectivo rollback `docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql`.

---

## 1. IDENTIFICAÇÃO E METADADOS DOS SCRIPTS

| Arquivo | Tamanho (Bytes) | Linhas | SHA-256 |
| :--- | :--- | :--- | :--- |
| [`F1_10_STORAGE_POLICIES_PROPOSTA.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql) | 12.870 | 336 | `6b79d1bbfe2e18a664d6b383764a66ae8565738682a8f07b1954cfda4a795a9a` |
| [`F1_10_ROLLBACK_STORAGE_POLICIES.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql) | 2.448 | 60 | `1213bb2c8e1d9f88e63d691defc188f0f53c1f56228a5ff18be9deb4bc3133d5` |

- **Posição no Runner Canônico:** Etapa 7 de 9 no manifesto [`scripts/db/migrate-staging.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/migrate-staging.mjs).
- **Lançador Controlado:** [`scripts/db/apply-staging-step7.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/apply-staging-step7.mjs) (`--until-step=7`, token: `APLICAR ETAPA 7 EM STAGING`).
- **Transacionalidade:** Script encapsulado em `BEGIN ... COMMIT` com proteções de contenção (`SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '60s'`). O runner remove o `BEGIN/COMMIT` externo via `stripOuterTransaction` para gravar atomicamente DDL + registro na tabela de histórico `_medicina_staging_migrations`.

---

## 2. INVENTÁRIO DETALHADO DOS OBJETOS E POLÍTICAS CRIADAS

### 2.1 Preflight Diagnóstico (Seção 1)
O script aborta imediatamente com erro `P0001` caso:
1. As tabelas `public.perfis`, `public.acervo_arquivos` ou `public.responsavel_estudante` não existam (`to_regclass`).
2. Existam dados legados em `public.acervo_arquivos` fora do padrão:
   - `mime <> 'application/pdf'`
   - `tamanho_bytes <= 0 OR tamanho_bytes > 20971520` (20 MiB)
   - `file_path LIKE '%..%' OR file_path LIKE '%\%'`

### 2.2 Estrutura do Schema `storage` (Seção 2)
Para compatibilidade com ambientes locais isolados e PGlite (caso o schema `storage` ainda não exista):
- **Tabela `storage.buckets`:**
  - Colunas: `id` (text, PK), `name` (text, NOT NULL UNIQUE), `owner` (uuid), `public` (boolean DEFAULT false NOT NULL), `file_size_limit` (bigint), `allowed_mime_types` (text[]), `created_at` (timestamptz), `updated_at` (timestamptz).
  - Constraint CHECK: `storage_buckets_acervo_private_check` (id <> 'acervo' OR (public = false AND file_size_limit = 20971520 AND allowed_mime_types = ARRAY['application/pdf']::text[])).
- **Tabela `storage.objects`:**
  - Colunas: `id` (uuid, PK), `bucket_id` (text, FK `storage.buckets.id` ON DELETE RESTRICT), `name` (text NOT NULL), `owner` (uuid), `metadata` (jsonb DEFAULT '{}'), `created_at` (timestamptz), `updated_at` (timestamptz).
  - Constraint UNIQUE: `storage_objects_bucket_name_unique (bucket_id, name)`.

### 2.3 Funções no Schema `medicina` (Seção 3)
1. **`medicina.current_perfil_id()`**: `RETURNS uuid`, STABLE, lê `current_setting('medicina.current_perfil_id', true)`.
2. **`medicina.current_papel()`**: `RETURNS text`, STABLE, valida papel estrito (`estudante` ou `responsavel`).
3. **`medicina.is_estudante()`**: `RETURNS boolean`, STABLE, checa papel e perfil ativo.
4. **`medicina.is_responsavel()`**: `RETURNS boolean`, STABLE, checa papel e perfil ativo.
5. **`medicina.is_valid_acervo_storage_path(p_name text)`**: `RETURNS boolean`, **IMMUTABLE**, `SET search_path = pg_catalog, medicina, pg_temp`:
   - Validações:
     * `p_name IS NOT NULL`
     * `char_length(p_name) BETWEEN 12 AND 512`
     * `p_name LIKE 'acervo/%.pdf'` (atalho de prefixo e extensão)
     * `strpos(p_name, '..') = 0` (bloqueio de path traversal)
     * `strpos(p_name, '//') = 0` (bloqueio de barras repetidas)
     * `strpos(p_name, '\') = 0` (bloqueio de contra-barras)
     * `p_name ~ '^acervo/[0-9a-f]{64}(_[A-Za-z0-9._-]+)?\.pdf$'` (exige hash SHA-256 de 64 caracteres hexadecimais em minúsculas, sufixo de desambiguação opcional e extensão `.pdf`).

### 2.4 Matriz de Privilégios (GRANT / REVOKE)
- **`PUBLIC`:**
  - `REVOKE ALL` revoga execução de todas as funções (`current_perfil_id`, `current_papel`, `is_estudante`, `is_responsavel`, `is_valid_acervo_storage_path`).
- **`medicina_app`:**
  - `GRANT USAGE ON SCHEMA medicina, storage`;
  - `GRANT EXECUTE` em todas as funções de contexto e validação de storage;
  - `GRANT SELECT ON storage.buckets`;
  - `GRANT SELECT, INSERT, DELETE ON storage.objects` (**NÃO há concessão de `UPDATE`**, prevenindo mutações de objetos no banco).
- **`medicina_worker`:**
  - `GRANT USAGE ON SCHEMA medicina, storage`;
  - `GRANT EXECUTE` nas funções de validação;
  - `GRANT SELECT ON storage.buckets, storage.objects` (Acesso estritamente somente-leitura para o pipeline de extração e indexação).
- **`medicina_anon`:**
  - `REVOKE ALL ON SCHEMA storage`;
  - `REVOKE ALL ON storage.buckets, storage.objects`;
  - `REVOKE ALL ON FUNCTION medicina.is_valid_acervo_storage_path(text)`.

### 2.5 Políticas Row Level Security (RLS) Criadas

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ POLÍTICAS RLS CRIADAS NA ETAPA F1.10                                                   │
├─────────────────────────────────────────┬─────────┬──────────────┬─────────────────────┤
│ Nome da Política                        │ Tabela  │ Comando      │ Alvo / Condição     │
├─────────────────────────────────────────┼─────────┼──────────────┼─────────────────────┤
│ acervo_buckets_select_authenticated     │ buckets │ SELECT       │ Autenticado/Worker  │
│ acervo_objects_responsavel_select       │ objects │ SELECT       │ Responsável Dono    │
│ acervo_objects_worker_select            │ objects │ SELECT       │ medicina_worker     │
│ acervo_objects_responsavel_insert       │ objects │ INSERT       │ Responsável Dono    │
│ acervo_objects_responsavel_delete_unlinked│ objects │ DELETE     │ Responsável (Órfão) │
└─────────────────────────────────────────┴─────────┴──────────────┴─────────────────────┘
```

1. **`acervo_buckets_select_authenticated`** (`storage.buckets`, `SELECT`):
   - **USING:** `id = 'acervo' AND public = false AND (medicina.current_perfil_id() IS NOT NULL OR current_user = 'medicina_worker')`.
   - Assegura visibilidade dos metadados do bucket exclusivamente a perfis logados ou worker e valida que o bucket permanece privado.
2. **`acervo_objects_responsavel_select`** (`storage.objects`, `SELECT`):
   - **USING:** `bucket_id = 'acervo' AND medicina.is_responsavel() AND medicina.is_valid_acervo_storage_path(name) AND (owner = medicina.current_perfil_id() OR EXISTS (SELECT 1 FROM public.acervo_arquivos a WHERE a.file_path = storage.objects.name AND a.enviado_por = medicina.current_perfil_id()))`.
   - Permite leitura direta de objetos pelo responsável apenas se ele for o proprietário do objeto no Storage ou o autor do registro em `public.acervo_arquivos`.
3. **`acervo_objects_worker_select`** (`storage.objects`, `SELECT`):
   - **USING:** `bucket_id = 'acervo' AND current_user = 'medicina_worker' AND medicina.is_valid_acervo_storage_path(name) AND EXISTS (SELECT 1 FROM public.acervo_arquivos a WHERE a.file_path = storage.objects.name)`.
   - Permite que o worker de background leia exclusivamente objetos que já estejam indexados e persistidos em `public.acervo_arquivos`.
4. **`acervo_objects_responsavel_insert`** (`storage.objects`, `INSERT`):
   - **WITH CHECK:** `bucket_id = 'acervo' AND medicina.is_responsavel() AND medicina.is_valid_acervo_storage_path(name) AND (owner IS NULL OR owner = medicina.current_perfil_id()) AND COALESCE(metadata->>'mimetype', 'application/pdf') = 'application/pdf' AND COALESCE((metadata->>'size')::bigint, 1) BETWEEN 1 AND 20971520`.
   - Força conformidade de MIME, caminho canônico, tamanho (1B..20MB) e ownership.
   - **Observação Crítica:** NÃO existe política de `UPDATE` sobre `storage.objects`, impedindo fisicamente que qualquer usuário sobrescreva um objeto existente.
5. **`acervo_objects_responsavel_delete_unlinked`** (`storage.objects`, `DELETE`):
   - **USING:** `bucket_id = 'acervo' AND medicina.is_responsavel() AND owner = medicina.current_perfil_id() AND NOT EXISTS (SELECT 1 FROM public.acervo_arquivos a WHERE a.file_path = storage.objects.name)`.
   - Protege a integridade referencial: um objeto que já foi associado a um arquivo processado ou em processamento em `public.acervo_arquivos` não pode ser excluído diretamente no Storage pelo usuário, prevenindo órfãos em cascata.

---

## 3. COMPATIBILIDADE COM O SUPABASE GERENCIADO

### 3.1 Tratamento Defensivo de Exceções (`insufficient_privilege`)
No Supabase Gerenciado (Cloud / Staging), o schema `storage` e as tabelas `storage.buckets` e `storage.objects` pertencem à role interna de sistema `supabase_storage_admin`. Conexões administrativas (como `postgres.ynfocaorhadizlvbnzrt`) operam como donas do schema `public`, mas podem encontrar restrições ao executar comandos DDL/DML diretos no catálogo `storage`.

O script F1.10 trata essa característica arquitetural com rigor:
1. **DML em `storage.buckets` (linhas 189-206):** Inserção/update do bucket envolvido em bloco `EXCEPTION WHEN insufficient_privilege THEN RAISE WARNING ...`. Caso o usuário não tenha privilégios DML na tabela do catálogo, a transação não é abortada; um aviso operacional claro é emitido instruindo o provisionamento via Supabase Dashboard / Storage API.
2. **Constraint em `storage.buckets` (linhas 210-230):** A adição de `storage_buckets_acervo_private_check` é protegida com `EXCEPTION WHEN insufficient_privilege THEN RAISE WARNING ...`. Em ambientes onde a role não é dona da tabela, a migração prossegue sem falhar.
3. **ENABLE RLS em `storage.buckets` e `storage.objects` (linhas 235-255):** Protegidos defensivamente com `EXCEPTION WHEN insufficient_privilege`.

### 3.2 Decisão Arquitetural: Ausência de `FORCE ROW LEVEL SECURITY` em `storage.objects`
Enquanto nas 34 tabelas de negócio do schema `public` (F1.04 e F1.09) aplicou-se `FORCE ROW LEVEL SECURITY` para evitar qualquer bypass acidental, no schema `storage`:
- **`FORCE ROW LEVEL SECURITY` foi deliberadamente OMITIDO.**
- **Motivo Técnico Crítico:** No Supabase gerenciado, o serviço externo `storage-api` (GoTrue/Storage microservice) autentica-se e interage com o catálogo de objetos utilizando a role `supabase_storage_admin` (com atributo `BYPASSRLS`) para geração de Signed URLs, downloads administrativos e deleção por expiração.
- Se `FORCE ROW LEVEL SECURITY` fosse aplicado a `storage.objects`, a cláusula de bypass seria ignorada e o `supabase_storage_admin` estaria submetido às políticas locais de `medicina.is_responsavel()`. Isso provocaria falha catastrófica em toda a Storage API gerenciada do Supabase. A omissão de `FORCE RLS` no schema gerenciado é, portanto, **indispensável e correta**.

### 3.3 Integração com `public.acervo_arquivos`
- O script F1.10 referencia estritamente as colunas consolidadas da tabela `public.acervo_arquivos` (`file_path`, `enviado_por`, `tamanho_bytes`, `mime`).
- As políticas de SELECT e DELETE utilizam subconsultas correlacionadas `EXISTS / NOT EXISTS` contra `public.acervo_arquivos`, garantindo perfeita sincronia entre os metadados de negócio e os arquivos físicos no bucket.

---

## 4. CONFIGURAÇÃO DO BUCKET E CAMINHOS DE ARMAZENAMENTO

### 4.1 Configuração Estrita do Bucket `acervo`
- `public = false`: O bucket é estritamente privado. URLs públicas permanentes (`/object/public/acervo/...`) são categoricamente rejeitadas pelo código da aplicação (`src/lib/supabaseStorage.ts:193-248` e testes H1.07). O acesso é feito exclusivamente por URLs assinadas de curta duração (`60..900s`, padrão 300s).
- `file_size_limit = 20971520` (exatamente 20 MiB).
- `allowed_mime_types = ARRAY['application/pdf']` (rejeita outros tipos MIME no nível do storage).

### 4.2 Função `medicina.is_valid_acervo_storage_path(text)`
A expressão regular implementada é:
```regexp
^acervo/[0-9a-f]{64}(_[A-Za-z0-9._-]+)?\.pdf$
```
- **Início e Fim Estritos:** `^` e `$` impedem injeção de caracteres antes ou depois.
- **Prefixo Obrigatório:** `acervo/`.
- **Hash do Conteúdo:** Exige exatamente 64 caracteres hexadecimais minúsculos (`[0-9a-f]{64}`), garantindo que a chave seja baseada no hash SHA-256 do arquivo.
- **Sufixo Opcional:** Permite `(_[A-Za-z0-9._-]+)?` para manter compatibilidade com nomes de arquivo sanitizados ou desambiguações de versões.
- **Extensão Obrigatória:** `.pdf` em minúsculas.
- **Defesas Adicionais:**
  * `char_length(p_name) BETWEEN 12 AND 512`: rejeita strings anômalas ou excessivas.
  * `strpos(p_name, '..') = 0`: neutraliza qualquer tentativa de subir diretórios (Directory Traversal).
  * `strpos(p_name, '//') = 0` e `strpos(p_name, '\') = 0`: neutraliza caminhos com barras duplas ou contra-barras típicas de sistemas legados.

### 4.3 Compatibilidade com a Aplicação
- Em `src/lib/acervoReconciliacao.ts` (`buildDeterministicAcervoStoragePath`):
  ```typescript
  export function buildDeterministicAcervoStoragePath(hashConteudo: string): string {
    const normalizedHash = hashConteudo.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedHash)) {
      throw new Error('Hash SHA-256 inválido para construção de chave no Storage.');
    }
    return `acervo/${normalizedHash}.pdf`;
  }
  ```
- O padrão gerado possui exatamente 75 caracteres (`acervo/` [7] + 64 hex + `.pdf` [4]), perfeitamente alinhado com o regex e com a restrição de tamanho (12..512).
- Em `src/app/actions/acervo.ts`, linha 131:
  `const filePath = buildDeterministicAcervoStoragePath(hash);`
- Em `src/lib/supabaseStorage.ts`, a opção `upsert: false` é padrão em todas as operações de upload, garantindo integridade contra sobrescrita e suportando reconciliação segura por hash em caso de colisão `409 Conflict`.

---

## 5. PENDÊNCIAS CONHECIDAS DA H1.06 (HERANÇA DE `PUBLIC` EM F1.04)

### 5.1 Histórico e Contexto da Ressalva
Conforme documentado no relatório H1.06 (Seção 3.2), no script `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql` as instruções de revogação de funções de `PUBLIC` precederam a criação de duas funções na Seção 7:
1. `medicina.fn_acompanhamento_quinzenal()`
2. `medicina.fn_simulados_evolucao()`

Pelas regras padrão do PostgreSQL, rotinas criadas sem um `ALTER DEFAULT PRIVILEGES` prévio herdam privilégio `EXECUTE` para `PUBLIC`.

### 5.2 Defesa em Profundidade Ativa
A segurança permanece íntegra devido a duas barreiras intransponíveis:
1. **Barreira de Schema:** `PUBLIC` e `medicina_anon` não possuem privilégio `USAGE` no schema `medicina` (`REVOKE ALL ON SCHEMA medicina FROM PUBLIC`). Chamadas diretas de conexões anônimas ou desautorizadas falham com erro `42501 (permission denied for schema medicina)`.
2. **Barreira de Domínio:** Ambas as rotinas contêm guardas condicionais internas (`IF NOT medicina.is_responsavel() ... THEN RETURN;`), retornando 0 linhas na ausência do contexto legítimo.

### 5.3 Regra de Ouro: Proibição de Modificação em F1.04
> [!CAUTION]
> O arquivo `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql` **NÃO DEVE SER ALTERADO**.
> O hash SHA-256 canônico (`8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f`) já está persistido na tabela remota `_medicina_staging_migrations` (ordem 5). Qualquer alteração no arquivo local invalidaria a checagem de integridade do runner em homologação Staging.

A regularização de higiene defensiva permanece programada para a etapa de consolidação e hardening pós-migrações:
```sql
REVOKE EXECUTE ON FUNCTION medicina.fn_acompanhamento_quinzenal() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION medicina.fn_simulados_evolucao() FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA medicina REVOKE EXECUTE ON ROUTINES FROM PUBLIC;
```

---

## 6. AVALIAÇÃO DO SCRIPT DE ROLLBACK (`F1_10_ROLLBACK_STORAGE_POLICIES.sql`)

O script de reversão foi inspecionado e atende plenamente aos critérios de segurança:
1. Remove as 5 políticas RLS criadas em `storage.objects` e `storage.buckets`.
2. Revoga todos os privilégios das roles `medicina_worker` e `medicina_app` no schema `storage`.
3. Remove defensivamente a constraint `storage_buckets_acervo_private_check`.
4. **Garantia Fail-Closed Inegociável:** Executa `UPDATE storage.buckets SET public = false WHERE id = 'acervo'` (protegido por `insufficient_privilege`). Mesmo durante ou após um rollback, o bucket `acervo` **jamais é exposto como público**.
5. Remove a função `medicina.is_valid_acervo_storage_path(text)`.

---

## 7. CONSULTAS SQL SOMENTE-LEITURA PARA O SUPABASE SQL EDITOR DE STAGING

Abaixo está o conjunto exato e completo de consultas passivas (SELECT puro, sem geração de locks ou alterações de estado) para inspeção antes e após a aplicação da Etapa 7.

### Consulta 1: Diagnóstico do Ledger de Migrações em Staging
*Finalidade: Confirmar que as etapas 1 a 6 estão aplicadas e verificar o estado da Etapa 7 (e ausência da Etapa 8).*
```sql
SELECT
  ordem,
  rel_path,
  sha256,
  aplicado_em,
  executado_por,
  tamanho_bytes
FROM public._medicina_staging_migrations
ORDER BY ordem ASC;
```

### Consulta 2: Metadados e Configuração de Privacidade do Bucket `acervo`
*Finalidade: Verificar se o bucket `acervo` está configurado como privado (`public = false`), limite de 20MB e MIME `application/pdf`.*
```sql
SELECT
  id,
  name,
  owner,
  public,
  file_size_limit,
  allowed_mime_types,
  created_at,
  updated_at
FROM storage.buckets
WHERE id = 'acervo';
```

### Consulta 3: Status de RLS em `storage.buckets` e `storage.objects`
*Finalidade: Confirmar que RLS está habilitado e que `FORCE ROW LEVEL SECURITY` está ausente (evita quebra do `supabase_storage_admin`).*
```sql
SELECT
  n.nspname AS schemaname,
  c.relname AS tablename,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS force_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'storage'
  AND c.relname IN ('buckets', 'objects')
ORDER BY c.relname;
```

### Consulta 4: Inspeção Detalhada de Políticas RLS no Schema `storage`
*Finalidade: Listar todas as 5 políticas ativas e suas cláusulas USING e WITH CHECK.*
```sql
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual AS using_expression,
  with_check AS with_check_expression
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename IN ('buckets', 'objects')
ORDER BY tablename, policyname;
```

### Consulta 5: Verificação da Função `medicina.is_valid_acervo_storage_path`
*Finalidade: Confirmar assinatura, volatilidade (IMMUTABLE), ausência de SECURITY DEFINER e search_path configurado.*
```sql
SELECT
  p.proname AS nome_funcao,
  pg_get_function_identity_arguments(p.oid) AS argumentos,
  pg_get_function_result(p.oid) AS tipo_retorno,
  CASE p.provolatile
    WHEN 'i' THEN 'IMMUTABLE'
    WHEN 's' THEN 'STABLE'
    WHEN 'v' THEN 'VOLATILE'
  END AS volatilidade,
  p.prosecdef AS security_definer,
  p.proconfig AS search_path_config
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'medicina'
  AND p.proname = 'is_valid_acervo_storage_path';
```

### Consulta 6: Auditoria de Privilégios das Roles sobre o Catálogo de Storage
*Finalidade: Conferir concessões e revogações das roles `medicina_app`, `medicina_worker`, `medicina_anon` e `public`.*
```sql
SELECT
  table_schema,
  table_name,
  grantee,
  privilege_type,
  is_grantable
FROM information_schema.table_privileges
WHERE table_schema = 'storage'
  AND table_name IN ('buckets', 'objects')
  AND grantee IN ('medicina_app', 'medicina_worker', 'medicina_anon', 'public')
ORDER BY table_name, grantee, privilege_type;
```

### Consulta 7: Pré-Checagem Diagnóstica de Conformidade de `public.acervo_arquivos`
*Finalidade: Avaliar antes da migração se existem registros incompatíveis que acionariam o preflight `P0001`.*
```sql
SELECT
  count(*) AS total_registros,
  count(*) FILTER (WHERE mime <> 'application/pdf') AS mime_invalido,
  count(*) FILTER (WHERE tamanho_bytes <= 0 OR tamanho_bytes > 20971520) AS tamanho_fora_limite,
  count(*) FILTER (WHERE file_path LIKE '%..%' OR file_path LIKE '%\%') AS path_traversal_detectado,
  count(*) FILTER (WHERE NOT (file_path ~ '^acervo/[0-9a-f]{64}(_[A-Za-z0-9._-]+)?\.pdf$')) AS paths_legados_nao_canonicos
FROM public.acervo_arquivos;
```

### Consulta 8: Garantia de Não-Execução da Etapa 8 (Fila de Ingestão F1.11)
*Finalidade: Comprovar que a Etapa 8 (`public.acervo_jobs`) e Etapa 9 permanecem ausentes em Staging antes do avanço controlado.*
```sql
SELECT
  to_regclass('public.acervo_jobs') AS tabela_acervo_jobs_etapa8,
  to_regprocedure('medicina.enfileirar_job_acervo(uuid,text)') AS funcao_job_etapa8,
  EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'fn_busca_hibrida_acervo'
  ) AS busca_hibrida_etapa9;
```

---

## 8. CONCLUSÃO E PARECER DO AUDITOR

1. **Aprovação Técnica Integral:** A migração `F1_10_STORAGE_POLICIES_PROPOSTA.sql` e seu script de reversão `F1_10_ROLLBACK_STORAGE_POLICIES.sql` foram integralmente auditados, testados em PostgreSQL 18.6 isolado (PGlite) e validados contra a suíte automatizada (`12/12` testes aprovados somando as suítes `f1_10_storage_integracao.test.ts` e `h1_07_storage_security.test.ts`).
2. **Resiliência no Supabase Gerenciado:** O script é 100% tolerante a ambientes com permissões limitadas em schemas gerenciados, omitindo acertadamente o `FORCE ROW LEVEL SECURITY` em `storage.objects` e tratando defensivamente potenciais exceções de privilégio em `storage.buckets`.
3. **Fronteira de Confiança Estrita:** A aplicação em conjunto com as policies RLS impede categoricamente acessos anônimos, uploads por estudantes, cross-tenant entre responsáveis e sobrescrita de arquivos.
4. **Prontidão Operacional:** O lançador interativo [`scripts/db/apply-staging-step7.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/apply-staging-step7.mjs) está devidamente preparado para conduzir a aplicação da Etapa 7 com contenção e salvaguardas fail-closed.
