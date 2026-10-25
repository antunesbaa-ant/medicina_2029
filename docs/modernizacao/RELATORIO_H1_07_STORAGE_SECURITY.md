# MEDICINA 2029 — RELATÓRIO DE AUDITORIA DE STORAGE E FRONTEIRAS DE CONFIANÇA (H1.07 / ETAPA 7 — F1.10)

**Data de Emissão:** 25 de Outubro de 2026  
**Status:** APROVADO E VALIDADO COM 100% DE SUCESSO  
**Suíte de Testes:** [`src/app/actions/h1_07_storage_security.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h1_07_storage_security.test.ts)  
**Arquivo de Migração Alvo:** [`docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql)  

---

## 1. AUDITORIA DE CREDENCIAIS E FRONTEIRA DE CONFIANÇA (Trust Boundary)

### 1.1 Mapeamento do Fluxo de Credenciais e Mecanismos de Autenticação

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                CLIENTE / BROWSER                                      │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ Cookie de Sessão HTTP (JWT assinado via NEXTAUTH_SECRET)
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        BACKEND NEXT.JS (App Router / Server Actions)                   │
│                                                                                        │
│  1. NextAuth: requireAuthenticatedProfile() -> valida sessão e carrega perfil canônico │
│  2. Papel Compulsório: requireRole('responsavel') -> bloqueia 'estudante' e anônimo   │
│  3. Isolamento Cross-Tenant: WHERE id = :id AND enviado_por = perfil.id                │
│  4. Chave Determinística: buildDeterministicAcervoStoragePath(sha256)                  │
│  5. Prevenção Path Traversal: normalizeAcervoStorageKey()                              │
│  6. Expiração Estrita: 60s <= expiresIn <= 900s (default 300s)                         │
└───────────────────────┬────────────────────────────────────────┬───────────────────────┘
                        │                                        │
     SQL Connection Pool│(medicina_app)                          │HTTP REST API (service_role)
     SET LOCAL context  │                                        │Authorization: Bearer SUPABASE_SERVICE_ROLE_KEY
                        ▼                                        ▼
┌──────────────────────────────────────────────┐ ┌───────────────────────────────────────┐
│           POSTGRESQL (Tabelas e RLS)         │ │        SUPABASE STORAGE ENGINE        │
│                                              │ │                                       │
│  - Role: medicina_app / medicina_worker      │ │  - SUPABASE_SERVICE_ROLE_KEY:         │
│  - RLS Ativo em storage.buckets              │ │    EFETUA BYPASS NAS POLICIES RLS     │
│  - RLS Ativo em storage.objects              │ │    DE storage.objects!                │
│  - Trava CHECK: public = false               │ │  - O backend Next.js é a verdadeira   │
│  - Role medicina_anon: REVOKE ALL            │ │    fronteira de autorização!          │
└──────────────────────────────────────────────┘ └───────────────────────────────────────┘
```

#### 1. NextAuth (Sessão HTTP do Usuário)
- **Onde entra:** No handshake web e em todas as Server Actions (`src/lib/authorization.ts`, `src/app/actions/acervo.ts`).
- **Mecanismo:** Sessão assinada e criptografada com `NEXTAUTH_SECRET`. A identidade e o papel (`session.user.id`, `session.user.role`) são extraídos no servidor sem confiar em nenhum parâmetro vindo do cliente.
- **Funções-chave:**
  - `requireAuthenticatedProfile()`: valida a sessão e carrega o perfil oficial da tabela `perfis`.
  - `requireRole('responsavel')`: exige compulsoriamente que o perfil logado possua o papel `responsavel`, lançando `AuthorizationError('FORBIDDEN')` caso contrário.
  - `withAuthenticatedUser()`: propaga a identidade para transações Drizzle aplicando `medicina.set_context(perfil.id, perfil.papel)`.

#### 2. Roles PostgreSQL (`medicina_app`, `medicina_worker`, `medicina_anon`, `postgres`)
- **`medicina_app`**: Role utilizada pela aplicação Next.js para consultas e mutações SQL. Opera sob RLS com contexto transacional volátil (`SET LOCAL via medicina.set_context()`), impedindo contaminação do pooler de conexões.
- **`medicina_worker`**: Role restrita para workers em lote (ingestão e OCR do acervo F1.11). Possui acesso SELECT limitado a objetos previamente registrados em `acervo_arquivos`.
- **`medicina_anon`**: Role sem privilégios. Tem todos os privilégios revogados em `storage.buckets` e `storage.objects` (`REVOKE ALL`).
- **`postgres` / `service_role`**: Superusuário / papel administrativo com bypass de RLS (`BYPASSRLS`).

#### 3. Supabase Auth
- **Situação no MEDICINA 2029:** **NÃO é utilizado pelo frontend da aplicação**. Estudantes e responsáveis não possuem tokens JWT do Supabase (`sb-...-auth-token`).
- **Consequência arquitetural:** O browser nunca se conecta diretamente ao Supabase Storage. Todo e qualquer acesso a arquivos é mediado pelas Server Actions do Next.js.

#### 4. `SUPABASE_SERVICE_ROLE_KEY`
- **Onde é usada:** Exclusivamente no servidor Next.js em `src/lib/supabaseStorage.ts` via `getSupabaseClient()`.
- **Como é usada:** Inicializa o cliente `@supabase/supabase-js` em modo server-side (`persistSession: false`) para executar chamadas de upload, download e geração de URLs assinadas.
- **Proteção contra vazamento:** Possui salvaguarda estrita que detecta e aborta imediatamente caso a chave seja exposta acidentalmente em variáveis de ambiente com prefixo público (`process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`), lançando `StorageOperationError('INSECURE_CONFIGURATION')`.

---

### 1.2 Resposta à Diretriz Fundamental de Segurança

> *"Não considere uma operação segura apenas por existir uma política RLS se ela utiliza credenciais capazes de contorná-la."*

#### 1. A Falácia da Falsa Segurança por RLS no Storage
As chamadas à API REST do Supabase Storage (`client.storage.from('acervo').upload(...)`, `.createSignedUrl(...)`, `.download(...)`) são executadas com a `SUPABASE_SERVICE_ROLE_KEY`. No ecossistema Supabase:
- O JWT de serviço possui a claim `"role": "service_role"`.
- A role `service_role` possui o atributo `BYPASSRLS` ativo por padrão no PostgreSQL do Supabase.
- **Portanto, as policies definidas em `storage.objects` são IGNORADAS (BYPASS) em todas as requisições feitas pela API REST usando a chave de serviço.**
- Considerar o Storage seguro apenas porque foram criadas policies em `storage.objects` seria um erro crasso de engenharia de segurança.

#### 2. Onde reside a Verdadeira Fronteira de Confiança (Trust Boundary)
A verdadeira fronteira de autorização reside **no servidor Next.js**, antes de qualquer invocação à API do Supabase Storage:

1. **Validação Estrita de Papel (`requireRole('responsavel')`)**:
   Estudantes e usuários anônimos são barrados na borda do servidor Next.js antes de qualquer chamada ao Storage ou consulta ao banco.
2. **Isolamento de Tenant e Propriedade Obrigatória (`WHERE enviado_por = perfil.id`)**:
   Na geração de link temporário (`obterUrlLeituraArquivoAcervo`), o servidor executa uma busca restrita:
   ```ts
   const [arquivo] = await db
     .select({ id: acervoArquivos.id, filePath: acervoArquivos.filePath, enviadoPor: acervoArquivos.enviadoPor })
     .from(acervoArquivos)
     .where(and(eq(acervoArquivos.id, idCheck.data), eq(acervoArquivos.enviadoPor, perfil.id)))
     .limit(1);
   ```
   Se outro responsável tentar acessar o arquivo (ataque Cross-Tenant), a consulta retorna vazio e a ação retorna `NOT_FOUND` imediatamente, **sem jamais invocar o Supabase Storage**.
3. **Caminhos Determinísticos Baseados em Hash SHA-256**:
   A chave do arquivo no Storage não aceita entradas arbitrárias do usuário (ex: nomes de arquivo originais). O caminho é construído exclusivamente pelo digest criptográfico do buffer validado:
   `filePath = acervo/${sha256(fileBuffer)}.pdf`
4. **URLs Assinadas de Curta Duração (60s a 900s, padrão 300s)**:
   O bucket `acervo` é estritamente privado (`public = false`). O servidor rejeita URLs permanentes (`/object/public/`) e impõe janela temporal estrita.
5. **Proteção Contra Sobrescrita (`upsert: false`) e Idempotência**:
   O upload envia compulsoriamente `upsert: false`. Se o objeto já existir (409 Conflict), o servidor valida o hash SHA-256 e o tamanho do objeto pré-existente antes de vincular o metadado, sem jamais sobrescrever bytes.

#### 3. O que as Policies de `storage.objects` em F1.10 Protegem
Embora as chamadas REST com service role contornem o RLS do Storage, as políticas em F1.10 exercem um papel essencial de **Defesa em Profundidade (Defense-in-Depth)**:
1. **Acessos diretos via SQL pela role `medicina_app`**:
   Se qualquer query SQL gerada pela aplicação ou administradores acessar diretamente `storage.objects` ou `storage.buckets`, ela estará sob o RLS da role `medicina_app`, que impõe `acervo_objects_responsavel_select` (apenas objetos onde `owner = medicina.current_perfil_id()` ou `acervo_arquivos.enviado_por = medicina.current_perfil_id()`).
2. **Processos em lote da role `medicina_worker`**:
   O worker em lote roda sob a role PostgreSQL `medicina_worker`, ficando rigidamente restrito pela policy `acervo_objects_worker_select` a apenas ler arquivos que possuam correspondente em `acervo_arquivos`.
3. **Tentativas de acesso direto com a `anon_key` pública**:
   Se um invasor obtiver a `anon_key` do Supabase e tentar chamar a API REST diretamente contra o bucket `acervo`, o Supabase executará a requisição sob a role `anon`. Como o bucket tem `public = false` e não há políticas permitindo acesso a `anon`, a requisição é negada no gateway do Supabase.

---

## 2. MATRIZ DE ACESSO DO STORAGE

| Operação | Estudante | Responsável (Proprietário) | Responsável (Terceiro / Cross-Tenant) | Medicina Worker | Anon / Público |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Upload de PDF** | ❌ **BLOQUEADO**<br>Next.js: `requireRole` -> `FORBIDDEN`.<br>SQL: `is_responsavel()` é false. | ✅ **PERMITIDO**<br>Via `enviarArquivo`.<br>Chave canônica `acervo/<sha256>.pdf`, MIME `application/pdf`, tamanho <= 20MB. | ✅ **ISOLADO**<br>Permitido apenas para materiais próprios. Se enviar mesmo PDF já existente, o banco deduplica sem sobrescrita. | ❌ **NÃO APLICÁVEL**<br>Worker é read-only para objetos de acervo. Sem GRANT de INSERT. | ❌ **BLOQUEADO**<br>Bucket privado, sem rota anônima e sem GRANT em `storage.objects`. |
| **Leitura de Metadados do Bucket** | ❌ **BLOQUEADO**<br>Sem Server Action exposta.<br>SQL: RLS filtra apenas se autenticado, mas bucket é `public=false`. | ✅ **PERMITIDO**<br>Via `diagnosticarReconciliacaoAcervo` (somente-leitura). | ⚠️ **ISOLADO**<br>Visualiza apenas metadados dos seus próprios arquivos (`WHERE enviado_por = perfil.id`). | ✅ **PERMITIDO**<br>SQL: `current_user = 'medicina_worker'` possui GRANT SELECT. | ❌ **BLOQUEADO**<br>`REVOKE ALL ON storage.buckets FROM medicina_anon`. |
| **Download / Obtenção de Signed URL** | ❌ **BLOQUEADO**<br>Next.js: `requireRole` -> `FORBIDDEN`.<br>SQL: `acervo_objects_responsavel_select` rejeita. | ✅ **PERMITIDO**<br>Via `obterUrlLeituraArquivoAcervo`. Gera Signed URL temporária (60-900s, padrão 300s). | ❌ **BLOQUEADO (Cross-Tenant)**<br>Next.js: `WHERE enviado_por = perfil.id` retorna `NOT_FOUND`. Storage NUNCA é chamado. | ✅ **PERMITIDO (Backend Worker)**<br>Via `downloadFromSupabaseStorage` apenas para OCR/ingestão de arquivos registrados. | ❌ **BLOQUEADO**<br>URLs públicas `/object/public/` rejeitadas. Sem acesso a chaves privadas. |
| **Exclusão de Arquivo Vinculado** | ❌ **BLOQUEADO**<br>Sem rota exposta. | ❌ **PROIBIDO**<br>SQL: `acervo_objects_responsavel_delete_unlinked` exige `NOT EXISTS em acervo_arquivos`. | ❌ **BLOQUEADO**<br>Não possui ownership. | ❌ **PROIBIDO**<br>Worker não possui GRANT de DELETE. | ❌ **BLOQUEADO**<br>Sem permissão. |
| **Exclusão de Arquivo Desvinculado (Órfão)** | ❌ **BLOQUEADO** | ⚠️ **MANUAL / AUDITADO**<br>Reconciliação apenas reporta; não apaga automaticamente. SQL permite se `owner = current_perfil_id()`. | ❌ **BLOQUEADO**<br>Rejeitado por ownership. | ❌ **PROIBIDO** | ❌ **BLOQUEADO** |
| **Tentativa de Sobrescrita (`upsert: false`)** | ❌ **BLOQUEADO** | ❌ **IMPEDIDO**<br>`upsert: false` dispara 409. O reenvio valida SHA-256 e adota sem sobrescrever. | ❌ **IMPEDIDO**<br>Não pode sobrescrever arquivos de outros tenants. | ❌ **NÃO APLICÁVEL** | ❌ **BLOQUEADO** |
| **Path Traversal (`..`, `//`, `\`)** | ❌ **BLOQUEADO** | ❌ **REJEITADO**<br>Barrado por `normalizeAcervoStorageKey` e `medicina.is_valid_acervo_storage_path`. | ❌ **REJEITADO** | ❌ **REJEITADO** | ❌ **REJEITADO** |

---

## 3. SUÍTE DE TESTES AUTOMATIZADOS (`h1_07_storage_security.test.ts`)

Foi implementada a suíte completa de testes automatizados em [`src/app/actions/h1_07_storage_security.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h1_07_storage_security.test.ts), executada sobre instância isolada do PostgreSQL 18.6 (PGlite com extensão `vector`) e Storage simulado.

### 3.1 Relação dos Casos de Teste e Resultados

| # | Cenário Testado | Mecanismo de Validação | Resultado |
| :-: | :--- | :--- | :-: |
| **1** | **Rejeição de estudante tentando upload no acervo** | Invoca `enviarArquivo` e `enviarArquivoFormData` autenticado como `estudante`. Valida que lança `AuthorizationError('FORBIDDEN')` e que o Storage não recebe chamadas. | **PASSED** (12ms) |
| **2** | **Rejeição de estudante tentando obter Signed URL** | Estudante tenta gerar Signed URL de arquivo cadastrado. Valida lançamento de `FORBIDDEN` e que `createSignedUrl` nunca é chamado. | **PASSED** (8ms) |
| **3** | **Isolamento Cross-Tenant (Responsável B vs Responsável A)** | Responsável B tenta gerar Signed URL para arquivo de Responsável A. Valida que a consulta retorna `NOT_FOUND` no servidor e o Storage não é acionado; Responsável A obtém a URL normalmente. | **PASSED** (2ms) |
| **4** | **Rejeição de Path Traversal no validador TS e no SQL** | Testa sequências maliciosas (`..`, `//`, `\`, caracteres nulos `\x00`, caminhos fora de escopo). Valida rejeição por `normalizeAcervoStorageKey`, por `medicina.is_valid_acervo_storage_path()` no SQL e por `uploadToSupabaseStorage`. | **PASSED** (3ms) |
| **5** | **Validação de expiração de Signed URL (60s a 900s)** | Testa tempos de expiração: `< 60s` (59, 0, -300) e `> 900s` (901, 3600), além de não-inteiros (300.5). Valida erro `INVALID_PAYLOAD` no storage e `VALIDATION_ERROR` na Server Action. | **PASSED** (2ms) |
| **6** | **Bloqueio contra vazamento de chave em `NEXT_PUBLIC_`** | Define `process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`. Comprova que `getSupabaseClient`, `upload`, `obterUrlAssinada` e `download` abortam com `INSECURE_CONFIGURATION`. | **PASSED** (1ms) |
| **7** | **Proteção contra sobrescrita (`upsert: false`) e integridade SHA-256** | Comprova envio de `upsert: false`. Comprova que se o objeto no storage possuir hash/tamanho divergente, o envio é rejeitado com `CONFLICT` ('falha de integridade SHA-256'), preservando os bytes originais. | **PASSED** (1ms) |
| **8** | **Comprovação de Bypass da Service Role Key e Barreira no Next.js** | Comprova que o cliente backend usa `SUPABASE_SERVICE_ROLE_KEY`. Comprova que o bucket tem `public = false`, que a constraint CHECK impede torná-lo público e que URLs `/object/public/` são rejeitadas. | **PASSED** (1ms) |

### 3.2 Evidência de Execução do Vitest

```bash
$ npx vitest run src/app/actions/h1_07_storage_security.test.ts

 ✓ src/app/actions/h1_07_storage_security.test.ts (8 tests) 1143ms
   ✓ H1.07 — Auditoria de Credenciais, Fronteira de Confiança e Isolamento de Storage (8)
     ✓ 1. Rejeita compulsoriamente estudante tentando upload no acervo (JSON e FormData) 12ms
     ✓ 2. Rejeita compulsoriamente estudante tentando obter URL assinada de arquivo do acervo 8ms
     ✓ 3. Assegura isolamento Cross-Tenant: Responsável B não consegue gerar URL assinada de arquivo do Responsável A 2ms
     ✓ 4. Rejeita caminhos maliciosos e Path Traversal tanto no validador TS quanto na função SQL 3ms
     ✓ 5. Valida tempo de expiração da Signed URL (rejeita < 60s ou > 900s e não-inteiros) 2ms
     ✓ 6. Bloqueia sumariamente qualquer execução se SUPABASE_SERVICE_ROLE_KEY for exposta em NEXT_PUBLIC_ 1ms
     ✓ 7. Garante proteção contra sobrescrita com upsert: false e integridade SHA-256 no reenvio 1ms
     ✓ 8. Demonstra que a API de Storage usa SUPABASE_SERVICE_ROLE_KEY (bypass RLS) e que a barreira real está no Next.js 1ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  1.67s
```

---

## 4. CONCLUSÃO E PRÓXIMOS PASSOS

A Etapa 7 (F1.10 - Storage Policies e Bucket Privado) está plenamente auditada e aprovada sob rigorosa fundamentação arquitetural e comprovação empírica automatizada.

A fronteira de confiança está inequivocamente delineada:
1. **O backend Next.js é a autoridade máxima e primária de autorização**, aplicando validação de papéis, isolamento cross-tenant e caminhos determinísticos antes de qualquer chamada ao Storage.
2. **A `SUPABASE_SERVICE_ROLE_KEY` é segregada estritamente no servidor**, com bloqueio absoluto de vazamento para o cliente.
3. **As policies RLS em `storage.objects` e `storage.buckets` funcionam como uma sólida camada de Defesa em Profundidade**, blindando o catálogo contra acessos diretos via SQL da role `medicina_app`, processos em lote do `medicina_worker` e chamadas externas com chave anônima.

O sistema está apto para a execução controlada da migração de Staging através do script [`scripts/db/apply-staging-step7.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/apply-staging-step7.mjs).
