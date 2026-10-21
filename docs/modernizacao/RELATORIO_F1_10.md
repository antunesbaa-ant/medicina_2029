# MEDICINA 2029 — RELATÓRIO TÉCNICO F1.10
## Upload e Storage Confiáveis (Consistência, Privacidade e Reconciliação)

**Data:** 20/10/2026  
**Tarefa:** F1.10 — Upload e Storage Confiáveis  
**Status:** APROVADA COM RESSALVAS  
**Acesso a produção / Supabase remoto:** Nenhum  
**Uploads / exclusões em buckets reais:** Nenhum  
**Migrations / policies aplicadas em banco persistente:** Nenhuma  

---

## 1. Problemas Identificados na Auditoria Direcionada

1. **Sobrescrita silenciosa no Storage (`upsert: true`):**
   - `uploadToSupabaseStorage` em `src/lib/supabaseStorage.ts` utilizava `upsert: true`, permitindo sobrescrever objetos pré-existentes sem detectar colisão ou estado parcial anterior.
2. **Chave de objeto acoplada ao nome de arquivo do cliente:**
   - `src/app/actions/acervo.ts` compunha `filePath` como `acervo/${hash}_${safeFileName}`. Caso uma tentativa anterior armazenasse o objeto no Storage e falhasse no `INSERT` do banco, o reenvio do mesmo PDF com outro nome criava um segundo objeto órfão no Storage em vez de reconciliar pelo conteúdo.
3. **Falha parcial entre Storage e Banco sem recuperação idempotente:**
   - Quando o upload ao Storage concluía e o `INSERT` em `acervo_arquivos` falhava, o objeto permanecia órfão no Storage; com `upsert: false`, um novo envio do mesmo arquivo falharia permanentemente se o erro `409 Duplicate` (`OBJECT_EXISTS`) não fosse tratado como reconciliação segura.
4. **Transporte ineficiente em Base64 e limite de Server Action ausente:**
   - `AcervoPage.tsx` convertia todo o PDF em string base64 via `FileReader.readAsDataURL` (inflando o tráfego em ~33% e duplicando memória) e anunciava `"Max 200MB"`, enquanto `next.config.ts` não configurava `bodySizeLimit` (mantendo o padrão de 1 MB para Server Actions).
5. **Validação binária de PDF limitada ao cabeçalho `%PDF-`:**
   - `v.pdfUpload` verificava apenas os 5 primeiros bytes (`%PDF-`), aceitando arquivos truncados (sem marcador final `%%EOF`) ou contendo ações ativas embutidas (`/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFiles`, `/RichMedia`, `/XFA`).
6. **Geração de URL assinada sem controle de autorização/expiração nem bloqueio de URL pública:**
   - `obterUrlAssinadaSupabase` aceitava expiração longa (padrão 3600s, sem teto máximo), não validava se a URL retornada era privada (`/object/sign/` vs `/object/public/`) e não possuía Server Action protegida por ownership (`enviadoPor = perfil.id`).
7. **Ausência de rotina de reconciliação Banco ↔ Storage:**
   - Não existia diagnóstico read-only para identificar metadados sem objeto, objetos sem metadados, uploads incompletos/falhos e duplicações sem apagar objetos automaticamente.

---

## 2. Correções Implementadas

### 2.1 Transporte Eficiente e Validação Estrutural (`next.config.ts`, `src/lib/validation.ts`, `src/components/AcervoPage.tsx`)
- **`next.config.ts`:** configurado `experimental.serverActions.bodySizeLimit: '28mb'` para acomodar uploads de até 20 MiB com margem para multipart/metadados.
- **Transporte binário via `FormData` com retrocompatibilidade:**
  - Criada `enviarArquivoFormData(formData: FormData)` em `src/app/actions/acervo.ts` e atualizado `AcervoPage.tsx` para enviar o objeto `File` binário diretamente via `FormData`, eliminando a codificação base64 no navegador e validando o limite de 20 MiB (`MAX_CLIENT_PDF_BYTES`) antes do envio.
  - Preservada integralmente a assinatura posicional `enviarArquivo(...)` aceitando base64 ou buffer binário (`Buffer | Uint8Array | ArrayBuffer`).
- **Validação de PDF fortalecida (`v.pdfUpload` em `src/lib/validation.ts`):**
  1. Cabeçalho de versão válido (`^%PDF-(1\.[0-7]|2\.0)`).
  2. Presença obrigatória do marcador final `%%EOF` nos últimos 1024 bytes (rejeita uploads truncados/incompletos).
  3. Bloqueio de tokens de ações/objetos ativos no fluxo binário (`/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFiles`, `/RichMedia`, `/XFA`).
  4. **Limites documentados da validação:** a inspeção síncrona de bytes não descomprime streams internos (`/FlateDecode` / `/ObjStm`) nem substitui renderização isolada; por isso, os documentos permanecem em bucket estritamente privado, nunca são servidos em URLs públicas permanentes e só são lidos por usuários autorizados via URL assinada de curta duração.

### 2.2 Storage Privado e URLs Assinadas (`src/lib/supabaseStorage.ts`, `src/app/actions/acervo.ts`, `docs/modernizacao/propostas/`)
- **`upsert: false` por padrão:** `uploadToSupabaseStorage` proíbe sobrescrita silenciosa de objetos existentes, valida o prefixo `acervo/` e extensão `.pdf`, exige tamanho `1..20 MiB` e MIME `application/pdf`, e valida a resposta externa (`data.path` não vazio).
- **Proteção de credenciais privilegiadas:** `getSupabaseClient` bloqueia imediatamente a execução (`INSECURE_CONFIGURATION`) caso `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` esteja definida no ambiente, prioriza `SUPABASE_SERVICE_ROLE_KEY` apenas no servidor (com fallback compatível para `SUPABASE_ANON_KEY`) e desativa persistência de sessão (`persistSession: false`).
- **URLs assinadas curtas e autorizadas (`obterUrlAssinadaSupabase` e `obterUrlLeituraArquivoAcervo`):**
  - Expiração restrita a `60..900` segundos (padrão `300`s / 5 minutos).
  - Rejeição explícita de qualquer resposta contendo `/object/public/`.
  - Server Action `obterUrlLeituraArquivoAcervo` exige `requireRole('responsavel')`, valida UUID e verifica ownership (`acervoArquivos.enviadoPor === perfil.id`) antes de solicitar a URL assinada.
- **Proposta SQL versionada fora do journal automático:**
  - `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql` e `docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql`: configuram o bucket `acervo` com `public = false`, `file_size_limit = 20971520` e `allowed_mime_types = ARRAY['application/pdf']`, constraint `storage_buckets_acervo_private_check`, RLS `ENABLE/FORCE` em `storage.buckets` e `storage.objects`, função `medicina.is_valid_acervo_storage_path` e policies fail-closed restritas ao responsável proprietário (sem policy de `UPDATE`).

### 2.3 Consistência Banco ↔ Storage e Reconciliação (`src/lib/acervoReconciliacao.ts`, `src/app/actions/acervo.ts`)
- **Chave determinística por conteúdo:** `buildDeterministicAcervoStoragePath(hash)` gera `acervo/<sha256>.pdf` a partir do SHA-256 dos bytes validados do PDF.
- **Tratamento explícito de falhas e repetições em `enviarArquivo`:**
  - *Arquivo já registrado no banco (`hashConteudo` existente ou violação `23505`):* retorna `CONFLICT` antes de tocar o Storage, preservando objetos existentes.
  - *Falha no upload ao Storage ou resposta externa inválida:* retorna `EXTERNAL_SERVICE_ERROR` sem iniciar `INSERT` nem pipeline.
  - *Upload conclui, mas `INSERT` falha (ou retorno vazio):* retorna `PERSISTENCE_ERROR` sem falso sucesso e **sem excluir objetos existentes**.
  - *Objeto já existente no Storage (`OBJECT_EXISTS` com `upsert: false`) sem linha no banco:* reconhece o objeto determinístico órfão da tentativa anterior, adota-o sem sobrescrever nem excluir e conclui o `INSERT` em `acervo_arquivos` (`reconciliacao: 'objeto_existente_adotado'`).
- **Mecanismo de Reconciliação Read-Only (`reconciliarSnapshotsAcervo` e `diagnosticarReconciliacaoAcervo`):**
  - Classifica `metadados_sem_objeto`, `objeto_sem_metadados`, `upload_incompleto_ou_falho` e `duplicados` com `somenteLeitura: true` e `exclusaoAutomaticaExecutada: false`, sem varrer buckets reais nem apagar arquivos automaticamente.

---

## 3. Arquivos Modificados e Criados

### Criados
- `src/lib/acervoReconciliacao.ts` — Chave determinística de Storage e motor puro read-only de reconciliação Banco ↔ Storage.
- `src/app/actions/f1_10_storage_integracao.test.ts` — Suíte de integração com PostgreSQL 18.6 descartável (PGlite) e simulador de Storage cobrindo policies SQL, falhas parciais, adoção de objeto existente, URLs assinadas e reconciliação.
- `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql` — Proposta SQL de bucket privado `acervo` e policies RLS do Supabase Storage.
- `docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql` — Rollback atômico das policies de Storage (preservando `public = false`).
- `docs/modernizacao/RELATORIO_F1_10.md` e `~/Documents/MEDICINA_2029_F1_10_RELATORIO.md` — Relatório técnico desta tarefa.

### Modificados
- `next.config.ts` — Configuração de `experimental.serverActions.bodySizeLimit: '28mb'`.
- `src/lib/validation.ts` — Suporte a payload binário (`fileData`) além de `base64Data`, validação de versão PDF, marcador final `%%EOF` e bloqueio de recursos ativos (`/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFiles`, `/RichMedia`, `/XFA`).
- `src/lib/validation.test.ts` — Adequação da fixture de PDF válido com `%%EOF`.
- `src/lib/supabaseStorage.ts` — `StorageOperationError`, `upsert: false` por padrão, validação de chave/payload/resposta externa, bloqueio de `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` e endurecimento de `obterUrlAssinadaSupabase` (`60..900`s, bloqueio de `/object/public/`).
- `src/app/actions/acervo.ts` — Chave determinística `acervo/<sha256>.pdf`, reconciliação idempotente de `OBJECT_EXISTS`, `enviarArquivoFormData`, `obterUrlLeituraArquivoAcervo` e `diagnosticarReconciliacaoAcervo`.
- `src/app/actions/acervo.test.ts` — Testes unitários de PDF truncado/malicioso, `FormData`, resposta externa inválida, adoção de objeto existente, URL assinada e reconciliação read-only.
- `src/components/AcervoPage.tsx` — Envio binário via `FormData` (`enviarArquivoFormData`), validação cliente de 20 MiB, correção do rótulo para `"Max 20MB"` e tipagem explícita sem `any`.
- `docs/modernizacao/PLANO_MODERNIZACAO.md` — Atualização do estado da F1.10 e recomendação da F1.11.

---

## 4. Testes e Resultados da Validação Final

### Diferenciação entre testes mockados, integração real em banco descartável e não executados
- **Testes unitários e de fronteira mockados (Vitest):** 25 suítes exercitando validações de PDF, autorização, falhas de Storage/DB, `FormData`, URLs assinadas e reconciliação em memória.
- **Testes de integração em PostgreSQL 18.6 descartável (PGlite) + Storage simulado:**
  1. `src/app/actions/f1_10_storage_integracao.test.ts` (4 cenários integrados): aplica migrations `0000`–`0003`, fixtures sintéticas, `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` e `F1_10_STORAGE_POLICIES_PROPOSTA.sql` (com ensaio de rollback e reaplicação), além de testar falha de upload, falha de `INSERT`, reconciliação no reenvio (`OBJECT_EXISTS`), bloqueio de duplicata, autorização de URL assinada e relatório de reconciliação.
  2. `src/app/actions/f1_09_integracao_pg.test.ts` (4 cenários integrados em PGlite).
  3. `scripts/f1_04/run-rls-validation.mjs` (41 cenários de segurança RLS em PGlite PostgreSQL 18.6 + pgvector).
- **Testes não executados:**
  - Nenhum teste foi executado contra o Supabase Storage remoto ou banco de produção (expressamente vedado pelas restrições da tarefa).
  - Testes E2E de navegador pertencem à F1.15.

### Resultados da rodada final de validação

| Verificação | Comando | Resultado |
| :--- | :--- | :--- |
| TypeScript | `npx tsc --noEmit` | **APROVADO** (0 erros) |
| Testes Automatizados (27 suítes) | `npm run test:run` | **APROVADO** (27 suítes / 227 testes aprovados) |
| Build de Produção Next.js | `npm run build` | **APROVADO** |
| Lint dos Arquivos Modificados | `npx eslint <9 arquivos TS/TSX modificados>` | **APROVADO** (0 erros, 0 warnings) |
| Integridade do Journal Drizzle | `npx drizzle-kit check` | **APROVADO** (`Everything's fine`) |
| Higiene de Diff Git | `git diff --check` | **APROVADO** (0 problemas) |
| Suíte RLS Isolada Existente | `node scripts/f1_04/run-rls-validation.mjs` | **APROVADO** (41/41 cenários aprovados, 100%) |

---

## 5. Riscos Remanescentes

1. **Inspeção estática de PDF não descomprime streams internos:** embora a validação rejeite arquivos truncados (sem `%%EOF`) e tokens ativos visíveis (`/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFiles`, `/RichMedia`, `/XFA`), objetos comprimidos em `/ObjStm` ou `/FlateDecode` não são expandidos no validador síncrono. A mitigação estrutural adotada é manter o bucket estritamente privado e nunca servir os PDFs em URLs públicas permanentes.
2. **Pipeline de ingestão pós-upload permanece em memória:** o retorno de `enviarArquivo` confirma exclusivamente o armazenamento do objeto e o `INSERT` de metadados (`processamentoStatus: 'aguardando'`), mas o disparo de `processarArquivoPipeline` continua assíncrono em memória até a implementação da fila durável na **F1.11**.
3. **Policies SQL de Storage ainda não aplicadas no ambiente remoto:** `F1_10_STORAGE_POLICIES_PROPOSTA.sql` está versionada e validada localmente em PostgreSQL 18.6 descartável, aguardando janela operacional aprovada.

---

## 6. Dependências para Implantação

1. Configurar `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` (exclusivamente no ambiente server-side, nunca com prefixo `NEXT_PUBLIC_`) antes de habilitar uploads reais em produção.
2. Aplicar `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql` (em conjunto com as propostas `F1_04` e `F1_09`) durante janela operacional aprovada e após backup validado.
3. Executar `diagnosticarReconciliacaoAcervo` caso existam registros legados em `acervo_arquivos` para verificar correspondência com objetos no bucket antes de liberar reprocessamento.

---

## 7. Próxima Tarefa Recomendada

**F1.11 — Fila durável e pipeline retomável:** retirar o processamento longo de extração, segmentação, classificação e indexação do ciclo da requisição HTTP, publicando jobs persistidos após a confirmação do upload e tornando cada etapa idempotente e reprocessável.
