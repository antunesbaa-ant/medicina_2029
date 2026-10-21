# RELATÓRIO TÉCNICO — TAREFA F1.11
## FILA DURÁVEL E PIPELINE RETOMÁVEL

**Projeto:** Medicina 2029  
**Data:** 20/10/2026  
**Status da Tarefa:** CONCLUÍDA — **APROVADA COM RESSALVAS**  
**Escopo Executado:** Substituição do processamento assíncrono efêmero de PDFs por fila PostgreSQL durável (`public.acervo_jobs`) e worker independente (`src/lib/acervoPipelineWorker.ts`), com claim atômico, lease/heartbeat, recuperação de trabalhos interrompidos, retry limitado com backoff exponencial, etapas retomáveis e idempotentes (`extracao`, `segmentacao`, `classificacao`, `indexacao`), proibição de conclusão fictícia na ausência de provedor real de embeddings e proibição de fallback silencioso para execução em memória.

---

## 1. AUDITORIA DIRECIONADA (`acervo.ts`, `ingestion.ts` E ESTADOS DO PIPELINE)

A auditoria de `src/app/actions/acervo.ts` e `src/lib/ingestion.ts` identificou quatro pontos críticos de perda ou corrupção de processamento sob o desenho anterior:

1. **Disparo efêmero acoplado ao processo da requisição HTTP (`void processarArquivoPipeline(...)`):**
   - `enviarArquivo` disparava uma `Promise` desanexada em memória mantendo o `fileBuffer` completo na heap da instância Node/serverless. Qualquer reciclagem de worker, deploy, timeout de função ou reinício do processo após o retorno HTTP descartava silenciosamente o trabalho em andamento.
2. **Estado preso indefinidamente sem lease ou mecanismo de recuperação:**
   - Quando o processo morria durante `extraindo`, `segmentando` ou `classificando`, `acervo_arquivos.status_processamento` permanecia eternamente no estado intermediário, sem timestamp de expiração (`lease_expires_at`), sem identificador de worker (`locked_by`) e sem rotina de recuperação.
3. **Ausência de retomada por etapa e risco de duplicação em reprocessamentos:**
   - `processarArquivoPipeline` executava sequencialmente extração, segmentação, classificação e indexação do zero e realizava `INSERT` em lote em `acervo_paginas` e `acervo_chunks` sem constraints únicas `(arquivo_id, numero)` ou `(arquivo_id, ordem)`. Uma tentativa de reexecução após falha parcial reexecutava etapas já concluídas e podia duplicar páginas e chunks.
4. **Acoplamento ao buffer em memória da requisição de upload:**
   - O pipeline dependia do `Buffer` recebido durante `enviarArquivo`, impedindo que um worker desacoplado ou uma rotina de retomada processasse o documento diretamente a partir do bucket privado `acervo`.

---

## 2. FILA DURÁVEL POSTGRESQL E PROPOSTA DE MIGRATION FORA DO JOURNAL

Foram elaboradas as propostas SQL versionadas fora do journal automático do Drizzle:

- `docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql`
- `docs/modernizacao/propostas/F1_11_ROLLBACK_FILA_INGESTAO.sql`

### 2.1 Estrutura de `public.acervo_jobs` e Constraints de Idempotência

1. **Preflight defensivo (`DO $$ ... $$`):**
   - Verifica a existência de `public.perfis`, `public.acervo_arquivos`, `public.acervo_paginas` e `public.acervo_chunks`.
   - Audita preventivamente se há duplicidades históricas em `acervo_paginas (arquivo_id, numero)` ou `acervo_chunks (arquivo_id, ordem)`, abortando de forma fail-closed (`P0001`) caso existam colisões.
2. **Unicidades estruturais para retomada idempotente:**
   - `acervo_paginas_arquivo_numero_unique UNIQUE (arquivo_id, numero)` em `public.acervo_paginas`.
   - `acervo_chunks_arquivo_ordem_unique UNIQUE (arquivo_id, ordem)` em `public.acervo_chunks`.
3. **Tabela `public.acervo_jobs` (1 job persistente por arquivo):**
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `arquivo_id UUID NOT NULL REFERENCES public.acervo_arquivos(id) ON DELETE CASCADE` com constraint `acervo_jobs_arquivo_id_unique UNIQUE (arquivo_id)`
   - `enviado_por UUID NOT NULL REFERENCES public.perfis(id) ON DELETE RESTRICT`
   - `status VARCHAR(30) NOT NULL DEFAULT 'aguardando'` (`CHECK status IN ('aguardando', 'em_execucao', 'concluido', 'falhou')`)
   - `etapa_atual VARCHAR(30) NOT NULL DEFAULT 'extracao'` (`CHECK etapa_atual IN ('extracao', 'segmentacao', 'classificacao', 'indexacao', 'concluido')`)
   - `tentativas INTEGER NOT NULL DEFAULT 0` e `max_tentativas INTEGER NOT NULL DEFAULT 3` (`CHECK tentativas >= 0 AND max_tentativas >= 1 AND tentativas <= max_tentativas`)
   - `proxima_execucao_em TIMESTAMP NOT NULL DEFAULT now()`
   - Controle de lease/heartbeat: `locked_by VARCHAR(128)`, `locked_at TIMESTAMP`, `heartbeat_at TIMESTAMP`, `lease_expires_at TIMESTAMP` (com `CHECK` exigindo `locked_by` e `lease_expires_at` preenchidos quando `status = 'em_execucao'`)
   - Diagnóstico sanitizado e auditoria temporal: `ultimo_erro_codigo VARCHAR(80)`, `ultimo_erro_mensagem TEXT`, `iniciado_em TIMESTAMP`, `concluido_em TIMESTAMP`, `criado_em TIMESTAMP`, `atualizado_em TIMESTAMP`
   - Índices operacionais: `acervo_jobs_claim_idx (status, proxima_execucao_em, criado_em)` e `acervo_jobs_lease_idx (status, lease_expires_at)`.
4. **Backfill determinístico e compatibilidade com dados históricos:**
   - Popula `public.acervo_jobs` para registros existentes em `public.acervo_arquivos` (`ON CONFLICT (arquivo_id) DO NOTHING`), mapeando `status_processamento` legado para `(status, etapa_atual)` correspondente.
5. **Isolamento RLS e privilégios condicionais:**
   - Caso as funções auxiliares da F1.04 (`public.rls_is_responsavel`, `public.rls_current_perfil_id`) e o papel `medicina_app` já estejam presentes no ambiente, ativa RLS e `FORCE ROW LEVEL SECURITY` em `public.acervo_jobs` restringindo `SELECT/INSERT/UPDATE/DELETE` a `enviado_por = public.rls_current_perfil_id()`.

---

## 3. WORKER INDEPENDENTE E PIPELINE RETOMÁVEL (`src/lib/acervoPipelineWorker.ts`)

1. **Download autenticado server-side (`src/lib/supabaseStorage.ts`):**
   - Implementada `downloadFromSupabaseStorage(key)` para baixar os bytes do PDF diretamente do bucket privado `acervo` no momento da execução do worker, eliminando qualquer dependência do buffer da requisição HTTP original.
2. **Enfileiramento durável e idempotente (`enfileirarJobIngestaoAcervo`):**
   - Insere o job em `public.acervo_jobs` com `ON CONFLICT DO NOTHING RETURNING ...` e, caso já exista para o mesmo `(arquivo_id, enviado_por)`, retorna o job persistido sem duplicar registros.
3. **Claim atômico e concorrência segura (`reivindicarProximoJobAcervo`):**
   - Seleciona candidatos elegíveis (`(status = 'aguardando' AND proxima_execucao_em <= now) OR (status = 'em_execucao' AND lease_expires_at <= now)`) ordenados por `(proxima_execucao_em, criado_em)` e executa `UPDATE ... WHERE id = $1 AND tentativas = $2 AND (...) RETURNING *`.
   - Dois workers concorrentes jamais reivindicam a mesma tentativa do job.
4. **Lease, heartbeat e recuperação de trabalhos interrompidos (`renovarHeartbeatJobAcervo` e `recuperarJobsComLeaseVencido`):**
   - O worker renova `heartbeat_at` e `lease_expires_at` antes e durante cada etapa e valida ownership do lease (`locked_by = workerId`) ao avançar etapas (`avancarEtapaJobComLease`).
   - Se o lease vencer e outro worker assumir ou recuperar o job, o worker atrasado recebe `LeaseLostError` e aborta sem sobrescrever o estado do novo titular.
   - `recuperarJobsComLeaseVencido` devolve jobs com lease expirado para `status = 'aguardando'` (preservando `etapa_atual` e agendando backoff) ou encerra-os como `status = 'falhou'` (`LEASE_EXPIRED_MAX_RETRIES`) quando `tentativas >= max_tentativas`.
5. **Etapas idempotentes e retomáveis (`processarProximoJobAcervo`):**
   - **`extracao`:** verifica se todas as páginas já foram persistidas em `acervo_paginas`; caso contrário, baixa o PDF do Storage, **confere o hash SHA-256 do conteúdo baixado contra `acervo_arquivos.hash_conteudo`** (rejeitando divergências com falha terminal `STORAGE_HASH_MISMATCH`), extrai páginas e insere cada página com `onConflictDoNothing()`. Avança `etapa_atual` para `'segmentacao'`.
   - **`segmentacao`:** lê as páginas já persistidas em `acervo_paginas` (sem baixar nem extrair o PDF novamente), segmenta em chunks e insere apenas as ordens ainda ausentes em `acervo_chunks` (`onConflictDoNothing()`). Avança `etapa_atual` para `'classificacao'`.
   - **`classificacao`:** consulta `acervo_chunks` do arquivo e classifica apenas os chunks com `confianca_classificacao IS NULL`, preservando classificações já gravadas em tentativas anteriores. Avança `etapa_atual` para `'indexacao'`.
   - **`indexacao`:** exige provedor real de embeddings (`gerarEmbeddingReal`). Na ausência de provedor real (escopo da F1.12), lança `NonRetryablePipelineError('EMBEDDING_PROVIDER_UNAVAILABLE', ...)` e grava `status = 'falhou'`, `etapa_atual = 'indexacao'` e `acervo_arquivos.status_processamento = 'falhou'`, **nunca declarando conclusão fictícia**. Quando um provedor válido (vetor de 1536 dimensões) está configurado, indexa apenas os chunks com `embedding IS NULL` e conclui o job (`status = 'concluido'`, `etapa_atual = 'concluido'`).
6. **Retry limitado com backoff exponencial e erros sanitizados (`calcularBackoffMs`, `sanitizarErroJobAcervo`):**
   - Falhas transitórias incrementam `tentativas` no claim e, enquanto `tentativas < max_tentativas`, reagendam o job para `status = 'aguardando'` mantendo `etapa_atual` na etapa em que parou e aplicando backoff exponencial (`min(baseBackoffMs * 2^(tentativa-1), 300_000)`).
   - Ao atingir `max_tentativas` ou ocorrer erro não retentável, o job passa para `status = 'falhou'` com mensagem pública sanitizada (redigindo URLs `postgresql://...` e padrões `key/token/secret/password/credential`).

---

## 4. INTEGRAÇÃO COM UPLOAD CONFIRMADO E ORDEM DE ATIVAÇÃO

### 4.1 Modificações em `src/app/actions/acervo.ts`

- Removida a função efêmera `processarArquivoPipeline` e o disparo `void processarArquivoPipeline(...)`.
- Após confirmar o upload no Storage e o `INSERT ... RETURNING` em `acervo_arquivos`, `enviarArquivo` invoca `await enfileirarJobIngestaoAcervo(novoArquivo.id, perfil.id)`.
- Se a persistência do job em `acervo_jobs` falhar, `enviarArquivo` retorna explicitamente `{ ok: false, code: 'PERSISTENCE_ERROR' }`, **sem qualquer fallback silencioso para processamento em memória**.
- Adicionadas as Server Actions autenticadas e restritas ao responsável proprietário (`requireRole('responsavel')` + filtro `enviado_por = perfil.id`):
  - `obterStatusJobAcervo(arquivoId)`: consulta o estado detalhado do job (`status`, `etapaAtual`, `tentativas`, `maxTentativas`, `ultimoErroCodigo`, `ultimoErroMensagem`).
  - `retomarProcessamentoArquivoAcervo(arquivoId)`: reenfileira jobs falhos ou órfãos preservando `etapa_atual` para retomada a partir da etapa pendente.

### 4.2 Ordem Obrigatória de Ativação em Ambiente Persistente

Para evitar indisponibilidade de enfileiramento durante o deploy, a ativação em ambiente persistente deve seguir estritamente a ordem:

1. Executar preflight e aplicar `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`.
2. Executar preflight e aplicar `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql`.
3. Executar preflight e aplicar `docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql` (cria `public.acervo_jobs`, constraints `acervo_paginas_arquivo_numero_unique` e `acervo_chunks_arquivo_ordem_unique`, e realiza backfill determinístico dos registros de `acervo_arquivos`).
4. Publicar a versão da aplicação contendo `src/app/actions/acervo.ts` e `src/lib/acervoPipelineWorker.ts`.
5. Ativar o consumidor/scheduler independente que invoca `recuperarJobsComLeaseVencido()` e `processarProximoJobAcervo(workerId)`.

---

## 5. BLOQUEADORES EXPLÍCITOS DE PUBLICAÇÃO (ITEM 7)

Conforme determinado na especificação da F1.11, ficam registrados como **bloqueadores obrigatórios antes de publicação / operação com dados reais**:

1. **Verificação do conteúdo do objeto adotado após resposta `OBJECT_EXISTS`:**
   - Quando `uploadToSupabaseStorage` recebe `OBJECT_EXISTS` (HTTP 409) para uma chave determinística `acervo/<sha256>.pdf` e `enviarArquivo` adota o objeto preexistente no Storage para concluir o `INSERT` de metadados, o fluxo síncrono de upload ainda não baixa/inspeciona os bytes remotos no ato da adoção (embora o worker da F1.11 agora verifique o SHA-256 completo do objeto baixado na etapa `extracao` e aborte com `STORAGE_HASH_MISMATCH` se houver divergência). A verificação imediata de integridade do objeto adotado no momento do `OBJECT_EXISTS` permanece bloqueador de publicação.
2. **Homologação das policies Supabase Storage e do papel de serviço efetivamente usado:**
   - As policies RLS em `storage.objects` propostas em `F1_10_STORAGE_POLICIES_PROPOSTA.sql` e o papel de serviço efetivamente utilizado pelo backend (`SUPABASE_SERVICE_ROLE_KEY` estritamente server-side vs papéis autenticados) devem ser homologados em ambiente Supabase de staging antes de qualquer publicação em produção.

---

## 6. TESTES E VALIDAÇÃO FINAL

### 6.1 Cobertura dos Novos Testes (`src/app/actions/f1_11_fila_integracao.test.ts` e `src/app/actions/acervo.test.ts`)

| Cenário Exigido | Arquivo de Teste | Tipo de Execução | Resultado |
| :--- | :--- | :--- | :--- |
| Dois workers concorrentes disputando o mesmo job (`Promise.all`) | `src/app/actions/f1_11_fila_integracao.test.ts` (Teste 1) | PostgreSQL 18.6 real descartável (PGlite) + Storage simulado | **APROVADO** (1 vencedor, 0 páginas/chunks duplicados) |
| Enfileiramento repetido e execução duplicada sobre job concluído | `src/app/actions/f1_11_fila_integracao.test.ts` (Teste 2) | PostgreSQL 18.6 real descartável (PGlite) + Storage simulado | **APROVADO** (mesmo `job.id`, 2ª execução `processado: false`) |
| Falha em etapa intermediária (`classificacao` chunk 2) e retomada após backoff | `src/app/actions/f1_11_fila_integracao.test.ts` (Teste 3) | PostgreSQL 18.6 real descartável (PGlite) + Storage simulado | **APROVADO** (páginas, chunks e chunk 1 preservados; retomada pula `extracao` e `segmentacao`) |
| Ausência de sucesso fictício sem provedor de embeddings e conclusão real após retomada | `src/app/actions/f1_11_fila_integracao.test.ts` (Teste 4) | PostgreSQL 18.6 real descartável (PGlite) + Storage simulado | **APROVADO** (`EMBEDDING_PROVIDER_UNAVAILABLE` -> retomada em `indexacao` -> `concluido`) |
| Recuperação de lease vencido e bloqueio de worker atrasado (`LeaseLostError`) | `src/app/actions/f1_11_fila_integracao.test.ts` (Teste 5) | PostgreSQL 18.6 real descartável (PGlite) + Storage simulado | **APROVADO** |
| Retry com backoff exponencial, limite `maxTentativas` e sanitização de segredos no erro | `src/app/actions/f1_11_fila_integracao.test.ts` (Teste 6) | PostgreSQL 18.6 real descartável (PGlite) + Storage simulado | **APROVADO** |
| Ownership e autorização (`obterStatusJobAcervo`, `retomarProcessamentoArquivoAcervo`) + `STORAGE_HASH_MISMATCH` | `src/app/actions/f1_11_fila_integracao.test.ts` (Teste 7) | PostgreSQL 18.6 real descartável (PGlite) + Storage simulado | **APROVADO** |
| Rollback SQL (`F1_11_ROLLBACK_FILA_INGESTAO.sql`) e reaplicação idempotente com backfill | `src/app/actions/f1_11_fila_integracao.test.ts` (Teste 8) | PostgreSQL 18.6 real descartável (PGlite) | **APROVADO** |
| Falha de persistência na fila durável sem fallback silencioso para execução efêmera | `src/app/actions/acervo.test.ts` | Unitário com mocks (Vitest) | **APROVADO** (`PERSISTENCE_ERROR`, `extrairTextoPDF` não invocado) |

### 6.2 Resultado da Rodada Única de Validação Final

1. **TypeScript (`npx tsc --noEmit`):** **APROVADO** (0 erros).
2. **Vitest completo (`npm run test:run`):** **APROVADO** — **28 arquivos de teste / 236 testes aprovados (0 falhas)**.
   - *Integração real com PostgreSQL 18.6 descartável (PGlite + pgvector):* `src/app/actions/f1_11_fila_integracao.test.ts` (8 testes), `src/app/actions/f1_10_storage_integracao.test.ts` (4 testes), `src/app/actions/f1_09_integracao_pg.test.ts` (4 testes).
   - *Unitários e de contrato com mocks:* demais 25 arquivos de teste (220 testes).
3. **Build de Produção (`npm run build`):** **APROVADO** (Next.js 16.4.2 Turbopack compilado com sucesso).
4. **Lint dos arquivos modificados (`npx eslint src/lib/supabaseStorage.ts src/lib/acervoPipelineWorker.ts src/app/actions/acervo.ts src/app/actions/acervo.test.ts src/app/actions/authorization.test.ts src/app/actions/f1_10_storage_integracao.test.ts src/app/actions/f1_11_fila_integracao.test.ts`):** **APROVADO** (0 erros, 0 warnings).
5. **Drizzle Kit Check (`npx drizzle-kit check`):** **APROVADO** (`Everything's fine`).
6. **Higiene de Diff (`git diff --check`):** **APROVADO** (0 erros de whitespace/formatação).
7. **Suíte RLS Isolada (`node scripts/f1_04/run-rls-validation.mjs`):** **APROVADO** (41/41 cenários aprovados — 100,0%, incluindo rollback e reaplicação).

### 6.3 Testes Não Executados (Por Restrição de Escopo e Ambiente)

- Não foram executados testes contra banco PostgreSQL de produção ou instância remota do Supabase Storage.
- Não foram executados testes com provedores externos reais de embeddings/OCR/visão (escopo da F1.12).
- Não foram executados testes E2E de navegador (Playwright), previstos para a F1.15.

---

## 7. RISCOS RESIDUAIS, PRÉ-REQUISITOS E PRÓXIMA ETAPA

- **Riscos residuais:**
  1. `src/lib/ingestion.ts` ainda contém implementações heurísticas/placeholder para extração OCR/visão e classificação de tópicos por palavras-chave, e não há provedor real de embeddings configurado; por isso, em produção sem `gerarEmbeddingReal`, os jobs pararão honestamente na etapa `indexacao` com código `EMBEDDING_PROVIDER_UNAVAILABLE` até a entrega da F1.12.
  2. As propostas SQL (`F1_04`, `F1_09`, `F1_10` e `F1_11`) permanecem não aplicadas no banco persistente.
- **Próxima etapa recomendada:** **F1.12 — IA, proveniência, OCR e busca reais** (somente após avaliação e autorização explícita do usuário).
