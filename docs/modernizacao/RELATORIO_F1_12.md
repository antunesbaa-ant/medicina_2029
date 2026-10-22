# RELATÓRIO DA TAREFA F1.12 — IA REAL, OCR, PROVENIÊNCIA E BUSCA SEMÂNTICA

- **Projeto:** Medicina 2029
- **Tarefa:** F1.12 — IA Real, OCR, Proveniência e Busca Semântica
- **Data:** 20/10/2026
- **Status do Gate:** **APROVADA COM RESSALVAS**
- **Escopo:** Substituição de placeholders de OCR, embeddings e busca semântica por integrações reais, configuráveis e verificáveis; endurecimento da proveniência obrigatória (`fonteChunkIds`, `arquivoOrigemId`, `fonte`, `geracoes.chunkIds`) e da curadoria humana obrigatória (`status = 'rascunho'`, `decisao = 'pendente'`); integração com o worker durável da F1.11 sem manter transações PostgreSQL abertas durante chamadas externas e sem repetir custo de embeddings já persistidos; proposta SQL reversível para índices `HNSW` + `GIN FTS` em português e constraints de proveniência.

---

## 1. AUDITORIA DIRECIONADA DO ESTADO ANTERIOR (PRÉ-F1.12)

A inspeção dos módulos relacionados ao pipeline de ingestão, IA, busca e curadoria identificou os seguintes comportamentos antes da intervenção:

| Módulo / Função | Estado Pré-F1.12 | Diagnóstico de Auditoria | Estado Pós-F1.12 |
| :--- | :--- | :--- | :--- |
| `src/lib/ingestion.ts` (`extrairTextoPDF`) | Parcialmente real / Incompleto para scans | Usava `pdf-parse` nativo, mas filtrava páginas vazias antes de numerar (`numero: index + 1` deslocava páginas subsequentes após páginas em branco) e marcava páginas digitalizadas como `ocr` com `confianca: 0.5` sem chamar nenhum motor real de OCR. | **Real e determinístico:** preserva o índice 1-based original de cada página (`numero`), descarta páginas genuinamente em branco sem inventar texto e aciona OCR multimodal real (`extrairTextoOcrGemini`) apenas quando necessário, falhando explicitamente (`GeminiOcrError`) se o OCR falhar. |
| `src/lib/ingestion.ts` (`segmentarEmChunks` e `classificarTópicoChunk`) | Heurístico determinístico | Segmentação por parágrafos com alvo de ~500 tokens e overlap; classificação por correspondência textual sem normalização de acentos. | **Determinístico endurecido:** segmentação preserva `paginaInicial` e `paginaFinal` reais; classificação normaliza diacríticos (`NFD`), case e pontuação com ponderação por especificidade e termos compostos. |
| `src/lib/ingestion.ts` (`gerarEmbeddingMock`) | Placeholder / Simulado | Gerava vetor de 1536 posições via SHA-256 repetido; bloqueado na F1.11 por `EMBEDDING_PROVIDER_UNAVAILABLE`. | **Provedor real integrado (`gerarEmbeddingReal` / `gerarEmbeddingGemini`):** chama a API Google Gemini (`gemini-embedding-001`) com `outputDimensionality: 1536`, normalização L2 e validação estrita de dimensão e finitude; `gerarEmbeddingMock` mantido apenas com guarda explícito para `NODE_ENV === 'test'`. |
| `src/lib/ingestion.ts` (`buscaHibridaAcervo`) & `src/app/actions/busca.ts` (`buscarNoAcervo`) | Placeholder bloqueado | `buscaHibridaAcervo` lançava erro fixo e `buscarNoAcervo` retornava sempre `EXTERNAL_SERVICE_ERROR` sem consultar o banco. | **Busca híbrida real em PostgreSQL:** gera embedding real da consulta (1536-d) e executa query SQL combinando `pgvector` (`1 - (c.embedding <=> query_vec)`) e FTS em português (`ts_rank_cd(to_tsvector('portuguese', c.texto), plainto_tsquery('portuguese', query))`), aplicando filtros estritos de ownership e retornando proveniência completa. |
| `src/app/actions/curadoria.ts` (`enfileirarGeracaoDeArtefatos` e `curarItem`) | Parcialmente integrado | Gerava artefatos via Gemini como `rascunho`, mas não preenchia `fonteChunkIds` em `materiais`, `perguntas_ativas` ou `questoes`, nem `arquivoOrigemId`/`fonte` em `questoes`, nem propagava `fonteChunkIds` para `cards` FSRS na aprovação humana. | **Proveniência verificável ponta a ponta:** exige chunks reais persistidos, popula `fonteChunkIds` (UUIDs reais de `acervo_chunks`), `arquivoOrigemId`, `fonte` paginada e `geracoes.chunkIds`; bloqueia aprovação humana de artefato gerado sem `fonteChunkIds` e propaga `fonteChunkIds` ao card FSRS aprovado. |
| `src/lib/acervoPipelineWorker.ts` (`executarEtapaIndexacao`) | Sem provedor default | Exigia injeção manual de `gerarEmbeddingReal` e não diferenciava erros permanentes de dimensão (`DIMENSION_MISMATCH`) ou chave ausente de falhas transitórias (`TIMEOUT`, `HTTP_ERROR`, `NETWORK_ERROR`). | **Integrado com provedor real e retomada econômica:** usa `gerarEmbeddingReal` por padrão, mantém chamadas de rede fora de transações PostgreSQL, pula chunks que já possuem `embedding IS NOT NULL` em retries (evitando custo duplicado) e classifica erros fatais vs transitórios para OCR e embeddings. |

---

## 2. EXTRAÇÃO DE TEXTO PDF E OCR SOB DEMANDA (`src/lib/ingestion.ts` e `src/lib/gemini.ts`)

1. **Extração Digital com Preservação Exata de Página:**
   - `extrairTextoPDF` divide a saída do parser nativo (`pdf-parse`) por form-feed (`\f`) respeitando `numpages` e atribui o número real 1-based (`numero = i + 1`) antes de qualquer filtragem.
   - Páginas com camada nativa legível (`>= 30` caracteres úteis) recebem `metodo: 'nativo'` e `confianca: 1.0`.
   - Páginas genuinamente em branco não recebem texto inventado e não deslocam a numeração das páginas seguintes (ex.: se a página 2 está em branco, as páginas persistidas são `1` e `3`).

2. **OCR Multimodal sob Demanda (`extrairTextoOcrGemini`):**
   - Quando um PDF possui páginas sem texto nativo suficiente (`< 30` caracteres), `extrairTextoPDF` aciona `extrairTextoOcrGemini(bufferPdf, { paginasAlvo })`.
   - O documento PDF é enviado via `inline_data` (`application/pdf`) ao modelo configurável `GEMINI_OCR_MODEL` (padrão `gemini-2.5-flash`) com `temperature: 0`, `responseMimeType: 'application/json'` e `responseSchema` estrito (`paginas: [{ numero, texto, confianca }]`).
   - A instrução de sistema proíbe explicitamente inventar texto para páginas em branco ou ilegíveis (`texto: ""`, `confianca: 0`).
   - Se todas as páginas alvo tinham ruído residual (`1..29` caracteres) ou se o documento inteiro é digitalizado (`0` páginas nativas legíveis) e o OCR retorna todas as páginas vazias, `extrairTextoPDF` lança `GeminiOcrError('INVALID_RESPONSE')` para impedir que um PDF digitalizado ilegível seja concluído silenciosamente sem texto.

3. **Dependências, Custos e Limitações Documentados:**
   - **Dependências:** `pdf-parse` (extração nativa local sem custo de API) e API Google Gemini (`generativelanguage.googleapis.com`, modelo padrão `gemini-2.5-flash`) somente quando há páginas com menos de 30 caracteres nativos.
   - **Custos:** PDFs digitais nativos têm custo zero de OCR; PDFs digitalizados ou híbridos consomem tokens multimodais de entrada (proporcionais ao número de páginas do PDF) e tokens de saída equivalentes ao texto transcrito nas páginas-alvo.
   - **Limitações:**
     - Documentos enviados inline em base64 para a API Gemini estão sujeitos ao teto de 20 MiB já imposto pela validação de upload da F1.09/F1.10 (`MAX_PDF_BYTES = 20 * 1024 * 1024`).
     - Timeout de 45 segundos por chamada de OCR (`GEMINI_OCR_TIMEOUT_MS = 45_000`), com retry e backoff exponencial gerenciados pelo worker durável F1.11 na etapa `extracao`.

---

## 3. EMBEDDINGS REAIS E COMPATIBILIDADE DIMENSIONAL (`vector(1536)`)

1. **Provedor Configurável (`gerarEmbeddingGemini` / `gerarEmbeddingReal`):**
   - Implementado em `src/lib/gemini.ts` e reexportado em `src/lib/ingestion.ts`.
   - Utiliza o modelo configurável `GEMINI_EMBEDDING_MODEL` (padrão `gemini-embedding-001`) no endpoint oficial `https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent` com cabeçalho `x-goog-api-key`.
   - Solicita explicitamente `outputDimensionality: 1536` (`EXPECTED_EMBEDDING_DIMENSION = 1536`), compatível com a coluna existente `acervo_chunks.embedding vector(1536)` (não requer alteração destrutiva de coluna).
   - Valida que o vetor retornado possui exatamente 1536 números finitos e aplica normalização L2 (`normalizarVetorL2`) para máxima precisão com distância de cosseno (`<=>`).

2. **Estados Explícitos de Falha (`GeminiEmbeddingError`):**
   - `MISSING_API_KEY` (não-retentável): ausente `GEMINI_API_KEY`.
   - `EMPTY_INPUT` (não-retentável): texto vazio ou apenas espaços.
   - `DIMENSION_MISMATCH` (não-retentável): modelo retornou dimensão diferente de 1536.
   - `INVALID_RESPONSE` (não-retentável): payload malformado, `NaN`/`Infinity` ou vetor nulo.
   - `HTTP_ERROR`, `TIMEOUT`, `NETWORK_ERROR` (retentáveis com backoff exponencial pelo worker).

---

## 4. BUSCA SEMÂNTICA E HÍBRIDA REAL (`src/lib/ingestion.ts` e `src/app/actions/busca.ts`)

1. **Consulta Híbrida (`buscaHibridaAcervo`):**
   - Recebe `query`, `perfilId`, `papel` (`responsavel` | `estudante`) e opções (`limite` 1..25, `similaridadeMinima`, `disciplinaId`, `topicoId`, `bancaAlvo`).
   - Gera o embedding real da consulta com `taskType: 'RETRIEVAL_QUERY'` (1536 dimensões).
   - Executa consulta SQL parametrizada no PostgreSQL combinando:
     - **Similaridade vetorial (`pgvector`):** `GREATEST(0, LEAST(1, 1 - (c.embedding <=> $queryVector::vector(1536))))`
     - **Ranking lexical (`FTS` em português):** `ts_rank_cd(to_tsvector('portuguese', c.texto), plainto_tsquery('portuguese', $query))`
     - **Pontuação híbrida combinada:** `0.78 * score_vetorial + 0.22 * LEAST(1.0, score_lexical)` (ou `score_vetorial` puro quando a query contém apenas stopwords/símbolos para o FTS).
   - **Filtro estrito de autorização e ownership:**
     - Restringe a `a.status_processamento = 'concluido'` e `c.embedding IS NOT NULL`.
     - Se `papel = 'responsavel'`: exige `a.enviado_por = $perfilId`.
     - Se `papel = 'estudante'`: exige vínculo ativo em `responsavel_estudante` (`re.estudante_id = $perfilId AND re.responsavel_id = a.enviado_por`).
   - **Proveniência completa retornada em cada item (`ResultadoBuscaAcervo`):** `chunkId`, `arquivoId`, `arquivoTitulo`, `autorFonte`, `anoFonte`, `bancaAlvo`, `disciplinaId`, `topicoId`, `paginaInicial`, `paginaFinal`, `texto`, `similaridade`, `scoreVetorial` e `scoreLexical`.

2. **Server Action `buscarNoAcervo` (`src/app/actions/busca.ts`):**
   - Autentica o perfil via `requireAuthenticatedProfile()`.
   - Valida a string de busca (`2..500` caracteres) com `validationError`.
   - Diferencia explicitamente:
     - **Ausência legítima de resultados:** retorna `{ ok: true, data: [] }`.
     - **Indisponibilidade ou falha do provedor de embeddings (`GeminiEmbeddingError`):** retorna `{ ok: false, code: 'EXTERNAL_SERVICE_ERROR', ... }`.
     - **Falha de banco de dados:** retorna `{ ok: false, code: 'PERSISTENCE_ERROR', ... }`.

---

## 5. PROVENIÊNCIA VERIFICÁVEL E CURADORIA HUMANA OBRIGATÓRIA (`src/app/actions/curadoria.ts`)

1. **Proveniência na Geração (`enfileirarGeracaoDeArtefatos`):**
   - Exige que o arquivo exista, pertença ao responsável autenticado e possua chunks reais em `acervo_chunks` (`CONFLICT` se o arquivo ainda não tiver chunks extraídos).
   - Ordena os chunks por `ordem`, constrói o contexto com marcação explícita de página (`[Chunk #N | p. X-Y]`) e coleta os UUIDs reais em `fonteChunkIds`.
   - Persiste na transação:
     - `materiais`: `status = 'rascunho'`, `origem = 'gerado'`, `fonteChunkIds = chunkIdsUtilizados`.
     - `perguntas_ativas`: `status = 'rascunho'`, `fonteChunkIds = chunkIdsUtilizados`.
     - `questoes`: `status = 'rascunho'`, `procedencia = 'gerada'`, `arquivoOrigemId = arquivo.id`, `fonte = "Acervo: <titulo> (p. X-Y)"`, `fonteChunkIds = chunkIdsUtilizados`.
     - `geracoes`: `chunkIds = chunkIdsUtilizados`, `modelo = DEFAULT_GEMINI_GENERATION_MODEL`, `status = 'pendente_curadoria'`.
     - `curadoria_fila`: todos os itens entram com `decisao = 'pendente'`. Nenhum conteúdo gerado por IA recebe `status = 'aprovado'` automaticamente.

2. **Verificação de Proveniência na Aprovação Humana (`curarItem`):**
   - Exclusivo para o papel `responsavel` (`requireRole('responsavel')`), verificando vínculo com a estudante quando o artefato é um flashcard que originará um `card` FSRS.
   - Antes de aprovar qualquer `resumo` (`origem = 'gerado'`), `flashcard` ou `questao` (`procedencia = 'gerada'`), `curarItem` valida via `extrairFonteChunkIdsValidos` que `fonteChunkIds` é um array não vazio de UUIDs válidos. Caso contrário, aborta a transação com `CONFLICT` (`"Não é permitido aprovar ... gerado por IA sem referência verificável aos trechos de origem (fonteChunkIds)."`).
   - Ao aprovar um flashcard, o registro criado em `public.cards` herda `fonteChunkIds: fonteChunkIdsFlashcard`, mantendo a rastreabilidade até os trechos do PDF original durante o estudo FSRS.

3. **Proposta SQL de Índices e Constraints (`docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql`):**
   - Elaborada fora do journal automático, com preflight e script de rollback dedicado (`F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql`):
     - Índice vetorial HNSW em `acervo_chunks.embedding` (`acervo_chunks_embedding_hnsw_idx` com `vector_cosine_ops`, `m = 16`, `ef_construction = 64`).
     - Índice GIN de busca textual em português (`acervo_chunks_texto_fts_idx` sobre `to_tsvector('portuguese', texto)`).
     - Constraints `CHECK ... NOT VALID` (preservando dados históricos da expansão F1.03-R sem quebrar registros legados):
       - `materiais_gerado_proveniencia_check`: exige `jsonb_typeof(fonte_chunk_ids) = 'array' AND jsonb_array_length(fonte_chunk_ids) > 0` quando `origem = 'gerado'`.
       - `questoes_gerada_proveniencia_check`: exige `arquivo_origem_id IS NOT NULL` e `fonte_chunk_ids` não vazio quando `procedencia = 'gerada'`.
       - `cards_gerado_proveniencia_check`: exige `fonte_chunk_ids` não vazio quando `origem = 'gerado'`.

---

## 6. INTEGRAÇÃO AO WORKER DURÁVEL F1.11 (`src/lib/acervoPipelineWorker.ts`)

1. **Chamadas Externas Fora de Transações PostgreSQL:**
   - Na etapa `extracao`, o download do Storage e o parsing/OCR (`extrairTextoPDF`) ocorrem integralmente fora da transação; a transação PostgreSQL é aberta apenas para o `INSERT ... ON CONFLICT DO UPDATE` das páginas em `acervo_paginas` e atualização de `totalPaginas`.
   - Na etapa `indexacao`, os embeddings são solicitados sequencialmente fora de transação e cada vetor confirmado é gravado por `UPDATE public.acervo_chunks SET embedding = ... WHERE id = ...`.

2. **Evitação de Custo Duplicado em Retries:**
   - `executarEtapaIndexacao` filtra `chunks.filter((chunk) => !Array.isArray(chunk.embedding) || chunk.embedding.length === 0)`.
   - Se um job com 20 chunks falhar por timeout de rede no 15º chunk, a retomada pelo worker consulta `acervo_chunks`, detecta que os chunks 1..14 já possuem `embedding` persistido e solicita à API Gemini apenas os chunks 15..20.

3. **Classificação Determinística de Erros de OCR e Embeddings:**
   - Erros de OCR (`GeminiOcrError`): `OCR_PROVIDER_UNAVAILABLE` (`MISSING_API_KEY`, fatal), `OCR_INVALID_RESPONSE` (`INVALID_RESPONSE`, fatal), `OCR_TIMEOUT` (`TIMEOUT`, retentável), `OCR_EXTERNAL_ERROR` (`HTTP_ERROR` / `NETWORK_ERROR`, retentável).
   - Erros de Embeddings (`GeminiEmbeddingError`): `EMBEDDING_PROVIDER_UNAVAILABLE` (`MISSING_API_KEY`, fatal), `EMBEDDING_DIMENSION_MISMATCH` (`DIMENSION_MISMATCH`, fatal), `EMBEDDING_INVALID_RESPONSE` (`INVALID_RESPONSE` / `EMPTY_INPUT`, fatal), `EMBEDDING_TIMEOUT` (`TIMEOUT`, retentável), `EMBEDDING_EXTERNAL_ERROR` (`HTTP_ERROR` / `NETWORK_ERROR`, retentável).

---

## 7. CONFIGURAÇÕES E SEGREDOS (`.env.example` e `src/lib/env.ts`)

1. **Variáveis Documentadas em `.env.example`:**
   - `GEMINI_API_KEY`: chave exclusiva da API Google Gemini (server-only).
   - `GEMINI_EMBEDDING_MODEL`: opcional, padrão `gemini-embedding-001` (saída configurada em 1536 dimensões).
   - `GEMINI_OCR_MODEL`: opcional, padrão `gemini-2.5-flash`.
   - `SUPABASE_SERVICE_ROLE_KEY`: chave server-only para operações administrativas de Storage privado.

2. **Validação em `src/lib/env.ts`:**
   - Rejeita o uso de variáveis cruzadas de outros provedores (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) quando `GEMINI_API_KEY` não está definida.
   - Bloqueia exposição acidental de segredos no bundle do navegador (`NEXT_PUBLIC_GEMINI_API_KEY`, `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_DATABASE_URL`, `NEXT_PUBLIC_NEXTAUTH_SECRET`).
   - Nenhuma chave ou payload sensível é registrado em logs de console.

---

## 8. BLOQUEADORES EXPLÍCITOS DE IMPLANTAÇÃO MANTIDOS

Conforme diretriz da tarefa, permanecem formalmente registrados como bloqueadores para implantação em produção (sem ampliação de escopo nesta tarefa):

1. **Compatibilidade entre funções auxiliares RLS F1.04 e F1.11:**
   - `F1_04_RLS_PROPOSTA.sql` define `medicina.current_perfil_id()` e `medicina.is_responsavel()`, enquanto o preflight/policies de `F1_11_FILA_INGESTAO_PROPOSTA.sql` referenciam `public.rls_current_perfil_id()` e `public.rls_is_responsavel()`. É necessário alinhar os nomes ou criar funções adaptadoras antes de aplicar as migrations em ambiente persistente.
2. **Verificação imediata de integridade de objetos adotados após `OBJECT_EXISTS`:**
   - No fluxo síncrono de upload (`enviarArquivo` / `enviarArquivoFormData`), quando o Supabase Storage retorna `OBJECT_EXISTS` para a chave determinística `acervo/<sha256>.pdf`, a verificação criptográfica do conteúdo armazenado ocorre hoje de forma assíncrona na etapa `extracao` do worker (`STORAGE_HASH_MISMATCH`), devendo ser homologada a verificação imediata antes de abertura para produção.
3. **Homologação das policies Supabase Storage (`F1_10_STORAGE_POLICIES_PROPOSTA.sql`):**
   - As policies RLS em `storage.objects` e o papel de serviço efetivamente utilizado no ambiente Supabase remoto precisam ser homologados em staging antes de publicação.
4. **Implantação do worker/scheduler independente:**
   - O consumidor de `processarProximoJobAcervo` e `recuperarJobsComLeaseVencido` precisa ser provisionado como processo/cron independente das requisições HTTP na infraestrutura de produção.

---

## 9. TESTES E VALIDAÇÃO FINAL

### 9.1 Diferenciação entre Testes Reais (PostgreSQL Descartável), Mocks e Não Executados

| Categoria | Escopo Executado | Resultado |
| :--- | :--- | :--- |
| **PostgreSQL 18.6 Real Descartável (`PGlite` + extensão `pgvector`)** | `src/app/actions/f1_12_ia_busca_integracao.test.ts` (5 cenários E2E): (1) PDF digitalizado, falha de OCR (`OCR_TIMEOUT`), retomada e página intermediária em branco sem inventar texto e preservando numeração `1, 3`; (2) `DIMENSION_MISMATCH` fatal sem retry e falha transitória no 2º chunk preservando o 1º chunk já indexado sem chamada duplicada de API; (3) busca híbrida real (`pgvector` `<=>` + `to_tsvector('portuguese', ...)`), ranking por relevância, proveniência completa, busca sem resultados (`[]`), falha do provedor (`EXTERNAL_SERVICE_ERROR`), falha de banco (`PERSISTENCE_ERROR`) e isolamento de ownership (`responsavel_1`, `estudante_1` vinculada, `responsavel_2` e `estudante_2` bloqueados); (4) geração de artefatos com `fonteChunkIds` reais, curadoria humana obrigatória (`status = 'rascunho'`, `decisao = 'pendente'`) e propagação de `fonteChunkIds` para `cards` FSRS após aprovação humana; (5) constraint SQL `materiais_gerado_proveniencia_check` bloqueando `fonte_chunk_ids = '[]'::jsonb`, seguida de rollback (`F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql`) e reaplicação idempotente (`F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql`). | **5/5 aprovados** |
| **PostgreSQL 18.6 Real Descartável (Suítes F1.04, F1.09, F1.10, F1.11)** | `scripts/f1_04/run-rls-validation.mjs` (41 cenários RLS), `f1_09_integracao_pg.test.ts` (4 cenários), `f1_10_storage_integracao.test.ts` (4 cenários), `f1_11_fila_integracao.test.ts` (8 cenários). | **41/41 cenários RLS + 16/16 testes PG aprovados** |
| **Testes Unitários com Serviços Simulados (`vi.spyOn(globalThis, 'fetch')`)** | `src/lib/gemini.test.ts` (24 testes cobrindo geração estruturada, `gerarEmbeddingGemini` 1536-d normalizado L2, `DIMENSION_MISMATCH`, `EMPTY_INPUT`, `TIMEOUT`, `extrairTextoOcrGemini`, sanitização de erros e rejeição de chaves cruzadas) e `src/lib/ingestion.test.ts` (9 testes cobrindo PDF digital, PDF digitalizado com OCR, página sem texto, falha de OCR sem inventar texto, segmentação e classificação com acentuação). | **33/33 aprovados** |
| **Não Executado (Por Restrição Operacional)** | Chamadas de rede contra a API paga do Google Gemini com chave real; aplicação das propostas SQL em banco Supabase remoto/produção; testes E2E de navegador (Playwright). | **Não executado (proibido pelas restrições de segurança)** |

### 9.2 Resumo da Rodada Única de Validação Final

- **TypeScript (`npx tsc --noEmit`):** aprovado (0 erros).
- **Vitest completo (`npm run test:run`):** aprovado — **29 suítes / 249 testes aprovados**.
- **Build de produção (`npm run build`):** aprovado (Next.js 16.4.2 Turbopack compilado sem erros).
- **ESLint dos arquivos alterados (`npx eslint src/lib/gemini.ts src/lib/gemini.test.ts src/lib/ingestion.ts src/lib/ingestion.test.ts src/lib/acervoPipelineWorker.ts src/lib/env.ts src/app/actions/busca.ts src/app/actions/curadoria.ts src/app/actions/f1_12_ia_busca_integracao.test.ts`):** aprovado (0 erros, 0 warnings).
- **Drizzle Kit Check (`npx drizzle-kit check`):** aprovado (`Everything's fine`).
- **Verificação de formatação Git (`git diff --check`):** aprovado (0 problemas).
- **Suíte RLS isolada (`node scripts/f1_04/run-rls-validation.mjs`):** aprovado (**41/41 cenários**, 100,0%).

---

## 10. ARQUIVOS CRIADOS E MODIFICADOS NA F1.12

- `src/lib/gemini.ts` — `gerarEmbeddingGemini`, `GeminiEmbeddingError`, `extrairTextoOcrGemini`, `GeminiOcrError`, validação de dimensão 1536 e normalização L2.
- `src/lib/gemini.test.ts` — testes unitários para embeddings 1536-d, incompatibilidade dimensional, OCR multimodal e estados de falha.
- `src/lib/ingestion.ts` — `extrairTextoPDF` com preservação de página 1-based e OCR sob demanda, `classificarTópicoChunk` normalizado, `gerarEmbeddingReal` e `buscaHibridaAcervo` (`pgvector` + FTS em português com filtro de ownership).
- `src/lib/ingestion.test.ts` — testes unitários para PDF digital, PDF digitalizado, página em branco, falha de OCR e classificação.
- `src/lib/acervoPipelineWorker.ts` — integração de `gerarEmbeddingReal` na etapa `indexacao`, preservação de chunks já indexados em retries e classificação de erros `GeminiOcrError` / `GeminiEmbeddingError`.
- `src/app/actions/busca.ts` — integração de `buscarNoAcervo` com `buscaHibridaAcervo`, validação de entrada e diferenciação entre `[]`, `EXTERNAL_SERVICE_ERROR` e `PERSISTENCE_ERROR`.
- `src/app/actions/curadoria.ts` — proveniência verificável (`fonteChunkIds`, `arquivoOrigemId`, `fonte`, `geracoes.chunkIds`), verificação obrigatória antes da aprovação humana e propagação de `fonteChunkIds` para `cards`.
- `src/lib/env.ts` e `.env.example` — documentação e validação de `GEMINI_EMBEDDING_MODEL`, `GEMINI_OCR_MODEL`, `SUPABASE_SERVICE_ROLE_KEY`, rejeição de chaves de outros provedores e bloqueio de exposição `NEXT_PUBLIC_`.
- `docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` — proposta SQL idempotente para índices `HNSW` + `GIN FTS` e constraints `CHECK ... NOT VALID` de proveniência.
- `docs/modernizacao/propostas/F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql` — script de rollback reversível da proposta F1.12.
- `src/app/actions/f1_12_ia_busca_integracao.test.ts` — suíte de integração em PostgreSQL descartável (`PGlite` + `pgvector`).
- `docs/modernizacao/PLANO_MODERNIZACAO.md` — atualização do status da F1.12, gates e próxima tarefa recomendada (F1.13).
