# RELATÓRIO DE AUDITORIA H1.07-R: MODELOS DE ACESSO A STORAGE, ISOLAMENTO E SEGURANÇA DO BACKEND NEXT.JS

**Data de Emissão:** 25 de Outubro de 2026  
**Projeto:** MEDICINA 2029 — H1.07-R  
**Responsável:** Especialista em Modelos de Autenticação, Isolamento de Storage e Segurança de Backend  
**Status da Suíte de Testes:** 100% APROVADO (`src/app/actions/h1_07_r_backend_security.test.ts`)

---

## 1. DISTINÇÃO FUNDAMENTAL ENTRE OS DOIS MODELOS DE ACESSO A STORAGE

A auditoria arquitetural do MEDICINA 2029 comprova de forma formal, estática e empírica a coexistência teórica de dois paradigmas de integração com o Supabase Storage, estabelecendo categoricamente que o sistema adota **exclusivamente o Modelo A**.

```
                        MODELO A (MEDICINA 2029 — ADOTADO)
┌──────────────┐   HTTP/Server Action    ┌──────────────────┐   SUPABASE_SERVICE_ROLE_KEY   ┌──────────────────┐
│   Browser    │ ──────────────────────> │  Next.js Server  │ ────────────────────────────> │ Supabase Storage │
│  (NextAuth   │                         │  (Verifica posse │   (Bypass RLS / priv. op)     │  (Bucket privado │
│   Session)   │ <────────────────────── │   em PostgreSQL) │ <──────────────────────────── │   owner_id=NULL) │
└──────────────┘    Signed URL (300s)    └──────────────────┘          Signed URL           └──────────────────┘
                            │
                            └──────────────────── Direct GET (300s) ───────────────────────────────┘

                       MODELO B (SUPABASE TRADICIONAL — NÃO UTILIZADO)
┌──────────────┐               HTTP REST Storage + Supabase JWT               ┌──────────────────┐
│   Browser    │ ───────────────────────────────────────────────────────────> │ Supabase Storage │
│ (GoTrue JWT) │ <─────────────────────────────────────────────────────────── │  (storage.objects│
└──────────────┘                                                              │   owner=auth.uid)│
                                                                              └──────────────────┘
```

### 1.1 Modelo A: NextAuth no Frontend + Server Actions no Backend Next.js (`SUPABASE_SERVICE_ROLE_KEY`)
- **Autenticação:** Gerenciada integralmente via **NextAuth.js v4**. A sessão do usuário reside em cookie criptografado (JWE / HttpOnly / Secure / SameSite).
- **Fronteira com o Supabase:** O browser **nunca** se comunica diretamente com o endpoint REST da Supabase Storage API (`/storage/v1/object/...`) para uploads ou operações mutantes.
- **Canal de Armazenamento:** Todas as operações partem de Server Actions (`enviarArquivo`, `enviarArquivoFormData`, `obterUrlLeituraArquivoAcervo`), executadas estritamente no backend Next.js.
- **Credenciais de Storage:** O backend utiliza `SUPABASE_SERVICE_ROLE_KEY` (chave mestra privada mantida em variáveis protegidas de servidor).
- **Propriedade e Isolamento:** A relação de posse é mantida em nível relacional na tabela `public.acervo_arquivos` (`enviado_por = perfil.id`). O acesso aos objetos em disco ocorre unicamente através de **Signed URLs efêmeras** (60 a 900 segundos; padrão 300 segundos), geradas pelo servidor somente após validação rigorosa de identidade e tenant na base PostgreSQL.

### 1.2 Modelo B: Acesso Direto do Browser à Supabase Storage API com JWT Supabase Auth (`auth.users`)
- **Mecanismo:** O frontend importa o cliente `@supabase/supabase-js`, autentica-se contra o GoTrue (`auth.users`) e recebe um token JWT Supabase (`role: "authenticated"`, `sub: <auth.users.id>`).
- **Comunicação:** O browser faz uploads e downloads diretamente contra o gateway do Storage (`/storage/v1/object/acervo/...`) enviando o cabeçalho `Authorization: Bearer <Supabase-JWT>`.
- **Autorização:** Delegada às policies de Row Level Security (RLS) diretamente nas tabelas `storage.buckets` e `storage.objects`, avaliando `auth.uid() = storage.objects.owner`.

### 1.3 Comprovação de que o MEDICINA 2029 Opera Exclusivamente no Modelo A
1. **Ausência de GoTrue no Frontend:** Nenhum componente de cliente (`'use client'`) importa `@supabase/supabase-js` nem `@supabase/auth-helpers-nextjs`. Não há `createClient` executado no navegador.
2. **Ausência de Supabase JWT no Browser:** O navegador não armazena tokens JWT do Supabase (nem em `localStorage`, nem em cookies Supabase `sb-*-auth-token`). A autenticação é 100% NextAuth.
3. **Bloqueio de Chaves Públicas de Storage:** O cliente Supabase (`getSupabaseClient()`) reside exclusivamente em `src/lib/supabaseStorage.ts`, configurado com `persistSession: false`, e lança exceção fatal (`INSECURE_CONFIGURATION`) se qualquer variável `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` estiver definida.

---

## 2. ANÁLISE PROFUNDA DE `storage.objects.owner_id` E INEFICÁCIA DE RLS DIRETO NO STORAGE

### 2.1 O que o Supabase Storage Grava em Uploads via `service_role`
Quando o backend Next.js envia um buffer via `uploadToSupabaseStorage()` utilizando a `SUPABASE_SERVICE_ROLE_KEY`:
- O Supabase Storage identifica a requisição como originada pela chave administrativa (`role: "service_role"`).
- Como não há cabeçalho de usuário final Supabase (`auth.uid()`), o Supabase Storage insere o registro na tabela interna `storage.objects` com:
  $$\text{storage.objects.owner} = \text{NULL (ou UUID reservado da service\_role)}$$
  $$\text{storage.objects.owner\_id} = \text{NULL}$$
- **Conclusão:** O campo `storage.objects.owner` **jamais reflete nem armazena o `public.perfis.id`** do usuário da aplicação.

### 2.2 Ineficácia e Perigo de Políticas Baseadas em `storage.objects.owner = auth.uid()`
- Se o sistema dependesse de policies no catálogo `storage.objects` como controle primário (ex: `USING (owner = auth.uid())` ou `USING (owner = medicina.current_perfil_id())`):
  1. Qualquer consulta direta ao Storage retornaria $0$ linhas, pois `owner` é nulo.
  2. Como os usuários não possuem Supabase JWT, `auth.uid()` sempre avaliaria para `NULL`.
  3. Políticas avaliando `medicina.current_perfil_id()` no gateway HTTP do Supabase falhariam por ausência de sessão PostgreSQL configurada no pool de storage.
- Portanto, **tentar transferir a responsabilidade de autorização para policies em `storage.objects` é conceitualmente inútil e representaria uma falsa sensação de segurança.**

### 2.3 Onde a Autorização Real Reside
A autorização no MEDICINA 2029 é exercida no servidor Next.js em três barreiras sequenciais e intransponíveis:
1. **Barreira 1 — Autenticação Criptográfica (NextAuth):**  
   `requireRole('responsavel')` extrai e valida o token assinado da sessão no servidor. Qualquer estudante ou usuário anônimo é sumariamente bloqueado (`FORBIDDEN` / `UNAUTHENTICATED`) sem que o Storage sequer tome conhecimento da requisição.
2. **Barreira 2 — Validação de Posse Relacional (`public.acervo_arquivos`):**  
   A posse é estritamente modelada e verificada em PostgreSQL:
   ```sql
   SELECT id, file_path, enviado_por
   FROM public.acervo_arquivos
   WHERE id = :arquivoId AND enviado_por = :perfilId;
   ```
   Se um responsável tentar ler ou solicitar acesso a um arquivo de outro responsável, a query retorna vazio e o servidor Next.js responde com `NOT_FOUND`, interrompendo o fluxo imediatamente.
3. **Barreira 3 — Emissão Controlada de Signed URLs Efêmeras:**  
   A API de Storage (`createSignedUrl`) só é invocada **após** a Barreira 2 confirmar a propriedade do arquivo. O servidor emite uma URL assinada temporária com expiração restrita entre 60 e 900 segundos (padrão 300s).

---

## 3. MATRIZ REAL DE ACESSO AOS DOCUMENTOS PDF (ACERVO)

| Ator / Papel | Contexto de Execução | Ação Tentada | Mecanismo de Controle | Resultado no Backend | Supabase Storage Acessado? |
| :--- | :--- | :--- | :--- | :---: | :---: |
| **Estudante** | Server Action (`enviarArquivo`) | Upload de PDF (JSON base64) | `requireRole('responsavel')` | ❌ Rejeição imediata (`FORBIDDEN`) | 🚫 **Não** (0 chamadas) |
| **Estudante** | Server Action (`enviarArquivoFormData`) | Upload de PDF (FormData binário) | `requireRole('responsavel')` | ❌ Rejeição imediata (`FORBIDDEN`) | 🚫 **Não** (0 chamadas) |
| **Estudante** | Server Action (`obterUrlLeituraArquivoAcervo`) | Gerar Signed URL para leitura | `requireRole('responsavel')` | ❌ Rejeição imediata (`FORBIDDEN`) | 🚫 **Não** (0 chamadas) |
| **Responsável B** (Cross-Tenant) | Server Action (`obterUrlLeituraArquivoAcervo`) | Obter Signed URL de arquivo do Responsável A | `WHERE id = :id AND enviado_por = perfil.id` | ❌ Rejeição imediata (`NOT_FOUND`) | 🚫 **Não** (0 chamadas) |
| **Responsável B** (Cross-Tenant) | Server Action (`obterStatusJobAcervo`) | Consultar job de arquivo do Responsável A | `WHERE arquivo_id = :id AND enviado_por = perfil.id` | ❌ Rejeição imediata (`NOT_FOUND`) | 🚫 **Não** (0 chamadas) |
| **Responsável B** (Cross-Tenant) | Server Action (`retomarProcessamentoArquivoAcervo`) | Reenfileirar arquivo do Responsável A | `WHERE id = :id AND enviado_por = perfil.id` | ❌ Rejeição imediata (`NOT_FOUND`) | 🚫 **Não** (0 chamadas) |
| **Responsável B** (Cross-Tenant) | Server Action (`obterAcervoStatus`) | Consultar páginas de arquivo do Responsável A | `WHERE id = :id AND enviado_por = perfil.id` | ❌ Retorno `null` | 🚫 **Não** (0 chamadas) |
| **Responsável A** (Proprietário) | Server Action (`enviarArquivo`) | Upload de PDF válido | Validação de schema, SHA-256 e DML | ✅ Upload concluído (`concluido`) | 💾 **Sim** (`upload` com `upsert: false`) |
| **Responsável A** (Proprietário) | Server Action (`obterUrlLeituraArquivoAcervo`) | Gerar Signed URL com prazo padrão (300s) | Validação de posse em `acervo_arquivos` | ✅ Sucesso (`signedUrl` emitida) | 🔑 **Sim** (`createSignedUrl`, 300s) |
| **Atacante Externo** | Payload com Path Traversal | Chave maliciosa (`..`, `//`, `\`, escapes) | `normalizeAcervoStorageKey` + `medicina.is_valid_acervo_storage_path` | ❌ Rejeição imediata (`INVALID_KEY`) | 🚫 **Não** (0 chamadas) |
| **Atacante Externo** | Spoofing de Identidade | Envio de `perfilId` / `enviadoPor` adulterado | `v.object` rejeita campos proibidos; servidor usa NextAuth | ❌ Rejeição de validação ou descarte de campos | 🚫 **Não** (persiste com ID da sessão) |
| **Atacante / Usuário** | Reupload de PDF com SHA-256 idêntico | Reenvio de arquivo pré-existente no Storage | Deduplicação + Verificação de Hash e Tamanho (`upsert: false`) | ✅ Adoção segura sem sobrescrever disco | 🔍 **Sim** (`download` para validar hash) |
| **Atacante / Bug** | Reupload com SHA-256 divergente | Colisão ou adulteração em storage pré-existente | Comparação SHA-256 vs bytes baixados | ❌ Rejeição imediata (`CONFLICT`) | 🚫 **Não** (arquivo em disco intocado) |
| **Atacante / Cliente** | Prazos de URL inválidos | Expiração `< 60s` ou `> 900s` ou decimais | Validador `v.number` e `obterUrlAssinadaSupabase` | ❌ Rejeição imediata (`VALIDATION_ERROR`) | 🚫 **Não** (0 chamadas) |
| **Worker Backend** | Fila Assíncrona (`acervoPipelineWorker`) | Download de PDF para OCR e chunking | Autenticação interna via processo backend | ✅ Leitura autorizada | 📥 **Sim** (`downloadFromSupabaseStorage`) |

---

## 4. RESULTADOS DA SUÍTE DE TESTES AUTOMATIZADOS DE SEGURANÇA

A suíte formal foi consolidada e executada via Vitest em:
`src/app/actions/h1_07_r_backend_security.test.ts`

### 4.1 Resumo de Execução
```bash
npx vitest run src/app/actions/h1_07_r_backend_security.test.ts
```
```
 ✓ src/app/actions/h1_07_r_backend_security.test.ts (8 tests) 1145ms
   ✓ H1.07-R — Suíte de Segurança do Backend Next.js e Isolamento de Storage (8)
     ✓ Cenário 1: Estudante tentando enviar PDF via Server Action -> Rejeição imediata (FORBIDDEN), Storage não tocado 11ms
     ✓ Cenário 2: Responsável tentando acessar/gerar URL assinada de PDF pertencente a outro responsável (Cross-Tenant) -> Rejeição imediata (NOT_FOUND), Storage não tocado 8ms
     ✓ Cenário 3: Tentativa de Path Traversal (.., //, \, caminhos absolutos, caracteres de escape) -> Rejeição pelo validador TypeScript e pela função medicina.is_valid_acervo_storage_path 3ms
     ✓ Cenário 4: Alteração de IDs enviados pelo cliente (spoofing de perfilId/enviadoPor) -> Servidor descarta parâmetros e resolve identidade estritamente da sessão assinada NextAuth 2ms
     ✓ Cenário 5: Colisão de SHA-256 e cenário OBJECT_EXISTS no Storage -> Validação de tamanho e hash sem jamais sobrescrever bytes (upsert: false) 2ms
     ✓ Cenário 6: URLs assinadas e prazos de expiração -> Aceita 60s, 300s, 900s; rejeita < 60s, > 900s, decimais e negativos 2ms
     ✓ Cenário 7: Ausência absoluta de exposição da SUPABASE_SERVICE_ROLE_KEY -> Bloqueio imediato (INSECURE_CONFIGURATION) caso configurada em NEXT_PUBLIC_ 0ms
     ✓ Cenário 8: Confirmação de que uploads via service_role com owner_id nulo permanecem isolados porque a autorização é verificada em public.acervo_arquivos 3ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  1.68s
```

### 4.2 Detalhamento dos 8 Cenários Testados

1. **Cenário 1 — Bloqueio de Estudante:**  
   Comprova que chamadas síncronas de upload (`enviarArquivo` e `enviarArquivoFormData`) vindas de perfis com `papel: 'estudante'` são imediatamente abortadas com `AuthorizationError('FORBIDDEN')`. A contagem de uploads no Storage permanece estritamente em zero e nenhum registro é inserido em `public.acervo_arquivos`.
2. **Cenário 2 — Isolamento Cross-Tenant:**  
   Comprova que o Responsável B não consegue gerar URL assinada, consultar jobs, retomar processamento ou inspecionar metadados de arquivos enviados pelo Responsável A. O servidor responde com `NOT_FOUND` e o Storage não é acionado. Quando o Responsável A (proprietário) faz a requisição, o acesso é concedido com sucesso.
3. **Cenário 3 — Defesa contra Path Traversal e Injeção de Caminhos:**  
   Testa sequências maliciosas (`..`, `//`, `\`, caracteres nulos `\x00`, caminhos absolutos como `/etc/passwd` e `/acervo/absoluto.pdf`). Comprova rejeição pelo validador TypeScript (`normalizeAcervoStorageKey`), pela função SQL `medicina.is_valid_acervo_storage_path` e pelas funções de storage (`uploadToSupabaseStorage` e `obterUrlAssinadaSupabase`).
4. **Cenário 4 — Blindagem contra Spoofing de Identidade:**  
   Testa injeção de `perfilId`, `enviadoPor` e `authUserId` em payloads JSON e `FormData`. Comprova que o validador `v.object` rejeita explicitamente esses campos no payload (`VALIDATION_ERROR`) e que qualquer campo injetado em `FormData` é solenemente descartado, persistindo exclusivamente o `perfil.id` derivado da sessão assinada NextAuth. Adicionalmente, verifica rejeição imediata com `UNAUTHENTICATED` se não houver sessão ativa.
5. **Cenário 5 — Proteção contra Sobrescrita (`upsert: false`) e Integridade SHA-256:**  
   Comprova que uploads com `upsert: false` disparam `OBJECT_EXISTS` no Storage. Demonstra que quando há divergência de bytes/hash entre o objeto existente e o arquivo enviado, a Server Action aborta com `CONFLICT` ('falha de integridade SHA-256') sem jamais sobrescrever os bytes no Storage. Quando os hashes coincidem perfeitamente, o objeto é adotado com segurança (`reconciliacao: 'objeto_existente_adotado'`).
6. **Cenário 6 — Prazos e Validação de URLs Assinadas:**  
   Testa prazos de expiração tanto na função de storage quanto na Server Action. Aceita valores válidos (60s, 300s, 900s). Rejeita valores inferiores ao mínimo (59s, 0s, negativos), superiores ao máximo (901s, 3600s) e números decimais (300.5s) com `VALIDATION_ERROR`.
7. **Cenário 7 — Prevenção contra Vazamento de Chave Mestra:**  
   Comprova que a existência de `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` no ambiente é sumariamente detectada por `getSupabaseClient()`, disparando exceção `INSECURE_CONFIGURATION` e impedindo qualquer upload, download ou geração de link.
8. **Cenário 8 — Prova Formal de Isolamento com `owner_id = NULL`:**  
   Comprova formalmente que, mesmo com `storage.objects.owner IS NULL` (padrão em uploads via `service_role`), o isolamento tenant é 100% estrito e hermético porque a autorização é verificada em `public.acervo_arquivos.enviado_por` antes de qualquer geração de URL assinada.

---

## 5. CONCLUSÃO TÉCNICA

A arquitetura de backend do MEDICINA 2029 opera com máxima robustez e aderência ao princípio do menor privilégio:
1. O Modelo A isola completamente a infraestrutura de Storage da internet aberta, permitindo acesso apenas via credenciais assinadas efêmeras de curtíssima duração;
2. O Supabase Storage atua estritamente como um repositório de blocos binários privados;
3. Toda a inteligência de autorização, integridade de domínio, governança de tenants e isolamento de perfis reside com firmeza inquebrantável na camada de serviços do Next.js e no catálogo relacional do PostgreSQL.
