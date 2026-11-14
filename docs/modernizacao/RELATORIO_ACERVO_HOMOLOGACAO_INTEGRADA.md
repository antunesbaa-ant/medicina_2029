# MEDICINA 2029 — RELATÓRIO DE HOMOLOGAÇÃO INTEGRADA DO ACERVO E CORREÇÕES FINAIS FSRS

**Data da Auditoria:** 13 de Novembro de 2026  
**Ambiente Auditado:** Supabase Staging (`ynfocaorhadizlvbnzrt`) / Local Testing Workspace  
**Status Consolidado:** **APTO COM RESSALVAS OPERACIONAIS** para Homologação Controlada  
**Responsável Técnico:** Antigravity AI Coding Assistant & Auditoria de Engenharia

---

## 1. RESULTADO DAS CORREÇÕES FINAIS DE INTERFACE FSRS

As duas pendências residuais observadas durante o teste de repetição espaçada com a usuária sintética Alice foram tratadas e homologadas localmente em [`src/components/RevisaoPage.tsx`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/components/RevisaoPage.tsx):

### 1.1. Duração Inflada por Inatividade de Aba
* **Causa Raiz:** O temporizador de revisão utilizava uma medição estática baseada unicamente no timestamp de renderização inicial (`cardStartTimeRef`). Quando a aba do navegador ficava em segundo plano, minimizada ou esquecida aberta, o tempo decorrido continuava a ser computado linearmente. Ao submeter a revisão após longos intervalos, a duração calculada excedia o limite defensivo do backend de 3.600.000 ms (60 minutos), gerando rejeição por validação de integridade.
* **Solução Implementada:**
  1. **Rastreamento de Tempo Ativo Visível:** Introduzidas referências reativas `activeTimeMsRef`, `lastVisibleTimestampRef` e `isTabVisibleRef`.
  2. **Tratamento de Ciclo de Vida da Página:** Adicionados listeners nativos para `visibilitychange`, `window.blur` e `window.focus`. Ao detectar que a aba ficou oculta ou perdeu o foco, a acumulação de tempo de estudo é suspensa imediatamente, somando apenas o intervalo de interação real comprovada. Ao retornar à aba, o ponto de referência é atualizado sem herdar o hiato de inatividade.
  3. **Limites Defensivos e Sanitização:** Definidos `MAX_ACTIVE_SPAN_MS = 120_000` (limite máximo de 2 minutos por fatia de interação contínua) e `MAX_CARD_STUDY_TIME_MS = 300_000` (teto defensivo de 5 minutos de estudo ativo por cartão). Na submissão, a duração é ajustada com `Math.max(1, Math.min(MAX_CARD_STUDY_TIME_MS, activeTimeMsRef.current || 1))`.
  4. **Resiliência a Falhas:** Caso ocorra qualquer erro de rede ou validação no backend (`!resultado.sucesso`), a função `resetCardTimer()` é executada, permitindo que o estudante tente novamente de imediato sem que o cartão retenha durações acumuladas inválidas.

### 1.2. Falha de Contraste dos Textos dos Flashcards (Claro e Escuro)
* **Causa Raiz:** Em [`src/app/globals.css`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/globals.css#L53), a diretiva global `.dark .bg-white { background-color: #24353F !important; color: #F5F7F8 !important; }` forçava o fundo escuro do cartão para `#24353F`. No entanto, quando elementos filhos declaravam estilos explícitos de texto escuro (`text-[#1B2A33]`), a precedência do seletor anulava a herança do texto claro, resultando em texto escuro sobre fundo escuro. Adicionalmente, classes auxiliares utilizavam `text-gray-400` com contraste abaixo das diretrizes de acessibilidade WCAG.
* **Solução Implementada:**
  1. **Declaração Direta de Contraste:** O parágrafo principal do cartão recebeu a classe explícita `text-[#1B2A33] dark:text-[#F5F7F8]`, garantindo contraste mínimo de **10.8:1** no modo escuro e **13.5:1** no modo claro (superando com folga o padrão WCAG AAA de 7:1).
  2. **Contêiner e Gradientes:** Contêiner do card padronizado com `bg-white dark:bg-[#24353F]` no anverso e gradiente escuro refinado `dark:from-[#24353F] dark:to-[#1B2A33]` no verso revelado.
  3. **Tipografia Auxiliar e Botões:** Todos os textos secundários foram promovidos de `text-gray-400` para `text-gray-600 dark:text-gray-300` (contraste > 7.5:1 no claro e > 8.3:1 no escuro). Os botões de avaliação FSRS foram reforçados com paleta semântica nítida (`bg-rose-600`, `bg-amber-600`, `bg-[#17607A]`, `bg-emerald-600` e equivalentes dark).
  4. **Homologação Visual Automatizada:** O conjunto de 12 testes E2E do Playwright (`e2e/revisao-fsrs.spec.ts`) foi executado em Chromium Desktop e Pixel 5 (Mobile Chrome), validando que `getComputedStyle(el).color` renderiza exatamente `rgb(27, 42, 51)` em modo claro e `rgb(245, 247, 248)` sobre `rgb(36, 53, 63)` em modo escuro.

---

## 2. DIAGNÓSTICO REAL DO MÓDULO DE ACERVO

O módulo de Acervo e Materiais Pedagógicos foi submetido a auditoria estática e dinâmica de código, banco de dados e fluxos de armazenamento.

### 2.1. Arquitetura de Persistência e Tabelas
* `public.acervo_arquivos`: Armazena metadados do documento pedagógico (`disciplina_id`, `titulo`, `tipo_material`, `serie_alvo`, `vestibular`, `nome_arquivo_original`, `tamanho_bytes`, `hash_conteudo`, `storage_path`, `status_processamento`, `enviado_por`).
* `public.acervo_paginas`: Armazena o desdobramento página a página (`numero_pagina`, `texto_extraido`, `tem_imagens`, `metodo_extracao`, `confianca`).
* `public.acervo_chunks`: Armazena os blocos de texto semânticos (`ordem`, `pagina_inicial`, `pagina_final`, `texto`, `tipo_conteudo`, `embedding vector(1536)`, `tsv_conteudo tsvector`).
* `public.acervo_jobs`: Fila durável de ingestão com controle transacional de lease (`locked_by`, `lease_expires_at`, `tentativas`, `max_tentativas`, `etapa_atual`).

### 2.2. Estado Observado no Supabase Staging
A inspeção somente-leitura realizada na base remota confirmou:
1. `acervo_arquivos`: Contém 1 registro legítimo cadastrado pelo Responsável Bruno (`f0000000-0000-4000-8000-000000000001`, *"Apostila Citologia e Membrana Plasmática"*, tamanho de 1.847.291 bytes, status: `concluido`).
2. `acervo_paginas` e `acervo_chunks`: Chunks presentes com vetor de 1536 dimensões indexado via `pgvector` e texto limpo.
3. `acervo_jobs`: 1 job histórico registrado com status `concluido`.
4. **Isolamento de Segurança (RLS):** Uma consulta direta executada sob a identidade da estudante Alice retornou exatamente **0 registros**, comprovando que a política RLS restringe a visibilidade de arquivos do acervo exclusivamente aos estudantes formalmente associados ao responsável através da tabela `responsavel_estudante`.

---

## 3. FUNCIONALIDADES IMPLEMENTADAS E TESTADAS (12 DIMENSÕES)

| # | Dimensão Auditada | Status | Evidência Técnica / Comportamento Observado |
|---|---|---|---|
| **1** | **Cadastro e organização de materiais pedagógicos** | **Implementado e Testado** | `enviarArquivoInputSchema` valida rigorosamente `disciplinaId` (UUID válido), `titulo` (1–255 caracteres sem nulos), `tipoMaterial` (livro, apostila, slide, etc.), `serieAlvo` (0 a 3) e `vestibular`. Rejeita dados vazios ou corrompidos antes de acessar qualquer recurso de storage ou banco. |
| **2** | **Upload de PDFs e formatos suportados** | **Implementado e Testado** | Exclusividade técnica estrita para arquivos PDF. Validação em três camadas: extensão `.pdf`, assinatura de cabeçalho binário `%PDF-1.x` ou `%PDF-2.0`, e marcador final `%%EOF`. Formatos alternativos (EPUB, DOCX, Imagens, Plaintext) são rejeitados com erro amigável na borda. |
| **3** | **Armazenamento e recuperação no Supabase Storage** | **Implementado e Testado** | Bucket privado `acervo`. Chaves de armazenamento estruturadas de forma determinística por hash SHA-256 (`acervo/${sha256}.pdf`), eliminando vulnerabilidades de sobrescrita e injeção de nomes de arquivos maliciosos. Geração de URLs assinadas via `obterUrlLeituraArquivoAcervo` com tempo de vida limitado defensivamente entre 60 e 900 segundos. |
| **4** | **Extração e processamento de conteúdo** | **Implementado e Testado** | `extrairTextoPDF` executa parsing nativo página a página utilizando o delimitador `\f` com paginação 1-based. Caso encontre páginas escaneadas (sem camada de texto nativo), aciona fallback para OCR via Gemini Vision (`extrairTextoOcrGemini`), registrando a pontuação de confiança sem fabricar texto sintético em caso de falha. |
| **5** | **Divisão em chunks e mecanismos de indexação** | **Implementado e Testado** | `segmentarTexto` divide o conteúdo em janelas semânticas de 500 a 1000 tokens (~2000 a 4000 caracteres) com 15% de sobreposição estruturada em quebras de parágrafo. Classifica o tipo de conteúdo (`exposicao_teorica`, `exemplo_resolvido`, `exercicio`, `formula`). Índices `pgvector` de 1536 dimensões compatíveis com `text-embedding-004`. |
| **6** | **Associação a disciplinas e tópicos** | **Implementado e Testado** | Cada chunk herda obrigatoriamente `disciplina_id` e executa classificação probabilística de tópicos via `classificarTópicoChunk`, analisando correspondência de termos normalizados com os tópicos cadastrados na disciplina no banco. |
| **7** | **Consulta, busca e recuperação de materiais** | **Implementado e Testado** | `buscaHibridaAcervo` combina busca vetorial (`<=>` em 1536 dimensões, peso 0.85) e busca textual em português (`ts_rank_cd` via `to_tsvector`, peso 0.15). Inclusão de `SET LOCAL search_path = public, extensions, medicina, pg_temp;` na transação para assegurar visibilidade ao tipo `vector` no PostgreSQL. |
| **8** | **Estados de processamento, erros e recuperação** | **Implementado e Testado** | Máquina de estados determinística (`aguardando` -> `extraindo` -> `segmentando` -> `classificando` -> `indexando` -> `concluido`). Fila durável `acervo_jobs` com lease lock de 60s, máximo de 3 tentativas, heartbeat periódico e backoff exponencial (`calcularBackoffMs`: 5s, 10s, 20s, até teto de 300s). Erros não-retentáveis encerram sem queimar tentativas indevidamente. |
| **9** | **Controle de acesso por perfil e políticas RLS** | **Implementado e Testado** | Upload, reprocessamento e exclusão restritos formalmente ao papel `responsavel` (`requireRole('responsavel')`). Tentativas de escrita pelo perfil `estudante` resultam em `UNAUTHORIZED_ROLE`. Estudantes possuem permissão estrita de leitura aos materiais pertencentes ao responsável vinculado. |
| **10** | **Segurança de arquivos, tamanho e malformação** | **Implementado e Testado** | Teto máximo de upload de 20 MiB (`MAX_UPLOAD_FILE_BYTES`). Verificação de truncamento via `%%EOF` nos últimos 1024 bytes. Varredura defensiva contra vetores de execução maliciosa em PDF (`/JavaScript`, `/Launch`, `/EmbeddedFiles`, `/XFA`). Sanitização completa contra Path Traversal (`..`, `/`, `\`). |
| **11** | **Prevenção de duplicações e reconciliação** | **Implementado e Testado** | Deduplicação por hash SHA-256 no banco (`acervo_arquivos.hash_conteudo`). Caso o objeto binário já exista no Storage (`OBJECT_EXISTS`), o sistema valida o SHA-256 remoto antes de adotar. Rotina `reconciliarSnapshotsAcervo` opera estritamente em modo diagnóstico de leitura (`somenteLeitura: true`, `exclusaoAutomaticaExecutada: false`). |
| **12** | **Integrações de IA (Embeddings e OCR)** | **Implementado e Testado** | Proteção de custos implementada: nenhuma chamada externa é disparada sem autorização. Tratamento honesto de indisponibilidade de credencial (`MISSING_API_KEY`), suspendendo a etapa de indexação com `EMBEDDING_PROVIDER_UNAVAILABLE` sem registrar vetores simulados ou enganosos no banco de produção. |

---

## 4. PROBLEMAS IDENTIFICADOS E CORREÇÕES REALIZADAS

### Problema 1: Incompatibilidade de `search_path` com a Extensão `vector` no Supabase Staging
* **Classificação:** CRÍTICO (Bloqueador de Busca Híbrida)
* **Manifestação:** Ao executar a busca híbrida remota no Supabase Staging, o PostgreSQL disparava o erro `PostgresError: type "vector" does not exist (code 42704)`.
* **Causa:** No Supabase Staging gerenciado, a extensão `pgvector` (versão 0.8.2) está instalada no schema dedicado `extensions`. A role de aplicação `medicina_app` conecta-se com o `search_path` padrão `"$user", public`, tornando o tipo `vector` invisível durante o casting de parâmetros `::vector(1536)`.
* **Correção Realizada:** Em [`src/lib/ingestion.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/ingestion.ts#L449), foi adicionado o comando de sessão `await tx.execute(sql\`SET LOCAL search_path = public, extensions, medicina, pg_temp;\`);` no início do bloco transacional de `buscaHibridaAcervo`.
* **Resultado:** Busca híbrida executada com êxito no Staging, retornando o chunk correto da apostila de Citologia com score de similaridade `0.865`.

### Problema 2: Inconsistência de Temporização e Duração Máxima FSRS
* **Classificação:** CRÍTICO (Bloqueador de Conclusão de Sessão)
* **Manifestação:** Erro `Duração da revisão inválida: deve ter entre 1 e 3.600.000 ms` exibido na interface após inatividade da aba.
* **Causa:** Falta de rastreamento do estado de visibilidade da aba do navegador no componente `RevisaoPage.tsx`.
* **Correção Realizada:** Implementação de listeners de ciclo de vida (`visibilitychange`, `blur`, `focus`), cálculo exclusivo de tempo ativo, teto defensivo de 5 minutos por cartão (`MAX_CARD_STUDY_TIME_MS`) e reset de timer após erro.
* **Resultado:** 11 testes unitários dedicados aprovados e 12 testes E2E Playwright aprovados.

### Problema 3: Falha de Contraste Visual no Flashcard FSRS em Modo Escuro
* **Classificação:** IMPORTANTE (Acessibilidade e Usabilidade)
* **Manifestação:** Texto de perguntas e respostas com baixo contraste visual contra o fundo `#24353F`.
* **Causa:** Conflito de especificidade da regra `.dark .bg-white` em `globals.css` com classes de cor inline Tailwind.
* **Correção Realizada:** Inclusão explícita de `text-[#1B2A33] dark:text-[#F5F7F8]` no parágrafo do flashcard e padronização dos botões de resposta.
* **Resultado:** Relação de contraste superior a 10.8:1 validada via inspeção computada de estilos no Playwright.

---

## 5. TESTES EXECUTADOS E SEUS RESULTADOS

### 5.1. Testes Automatizados Unitários e de Integração (Vitest)
Executados em lote único cobrindo todas as suítes relacionadas:

```bash
npx vitest run src/app/actions/acervo_homologacao_integrada.test.ts \
               src/app/actions/acervo.test.ts \
               src/components/AcervoPage.test.ts \
               src/components/RevisaoPage.test.ts \
               src/app/actions/fsrs.test.ts \
               src/app/actions/fsrs_homologacao_integrada.test.ts
```

* **Resultado:** **6 arquivos de teste, 87 testes executados, 87 APROVADOS (100% de sucesso)**.
  1. `acervo_homologacao_integrada.test.ts`: **26/26 aprovados** (Cobre as 12 dimensões do Acervo: validação de metadados, rejeição de não-PDFs, hashing determinístico, normalização de storage keys, extração 1-based, OCR sob demanda, segmentação e overlap, mapeamento de tópicos, teto de backoff de 300s, LeaseLostError, controle de perfil por role, anti-truncamento `%%EOF`, anti-scripts `/JavaScript`, modo reconciliação read-only, e ausência honesta de chave IA).
  2. `acervo.test.ts`: **16/16 aprovados** (Server actions de envio, download, status, listagem e reconciliação).
  3. `AcervoPage.test.ts`: **2/2 aprovados** (Confirmação honesta de upload discriminando processamento).
  4. `RevisaoPage.test.ts`: **11/11 aprovados** (Acúmulo de tempo ativo, listeners de visibilidade, teto de 5 min, reset em erro, contraste WCAG).
  5. `fsrs_homologacao_integrada.test.ts`: **21/21 aprovados** (Mapeamento de notas, transições de estado FSRS, limites de tempo, idempotência).
  6. `fsrs.test.ts`: **11/11 aprovados** (Server actions de revisão, isolamento de estudante, validação de payload).

### 5.2. Testes Visuais e Funcionais E2E (Playwright)
Executados contra o servidor web local com Chromium Desktop e Mobile Chrome:

```bash
npx playwright test e2e/revisao-fsrs.spec.ts
```

* **Resultado:** **12/12 testes APROVADOS (100% de sucesso)**.
  * Validação de redirecionamento anônimo para login.
  * Autenticação e carga dos cartões da estudante Alice.
  * Flip do flashcard e atalhos de teclado (Espaço/Enter e 1-4).
  * Tratamento gracioso de erro sem exposição de sessão.
  * Isolamento estrito de estudantes (Carlos não herda nem visualiza os cartões de Alice).
  * **Verificação visual de contraste renderizado nos modos claro e escuro:**
    * Modo Claro: `color = rgb(27, 42, 51)` (`#1B2A33`) sobre fundo claro.
    * Modo Escuro: `backgroundColor = rgb(36, 53, 63)` (`#24353F`) e `color = rgb(245, 247, 248)` (`#F5F7F8`).

---

## 6. PENDÊNCIAS CLASSIFICADAS POR CRITICIDADE

### 6.1. Bloqueadores Críticos (CRÍTICOS)
* **Nenhum (0).** Não há bloqueadores críticos, vazamentos de isolamento ou falhas de persistência no código local ou no banco de dados Staging.

### 6.2. Pendências Importantes (IMPORTANTES)
1. **Configuração Global de `search_path` no Supabase Staging:**  
   * Embora o código local contorne o problema injetando `SET LOCAL search_path` na transação, recomenda-se configurar formalmente a role de conexão:
     ```sql
     ALTER ROLE medicina_app SET search_path = public, extensions, medicina, pg_temp;
     ```
   * Isso previne que futuras consultas ad-hoc ou chamadas fora de transação falhem ao instanciar vetores.
2. **Provisionamento de Chave Gemini em Staging para Ingestão Completa:**  
   * A ingestão automática de novos PDFs digitalizados e a geração de embeddings exigem a variável de ambiente `GEMINI_API_KEY`. No momento, o sistema comporta-se defensivamente, pausando na etapa de indexação sem inventar dados sintéticos.

### 6.3. Melhorias Recomendadas (MELHORIAS)
1. **Visualizador de PDF com Zoom e Busca Integrada:**  
   * Evoluir a interface do leitor de acervo em `AcervoPage.tsx` para incorporar renderização visual das páginas em canvas (via `pdfjs-dist`), complementando a visualização de texto limpo existente.
2. **Feedback em Tempo Real do Worker via SSE/WebSocket:**  
   * Substituir o polling atual de 3 segundos no front-end por canais em tempo real (Supabase Realtime ou Server-Sent Events) para atualização imediata do status de processamento dos arquivos.

---

## 7. MATRIZ DE OPERAÇÕES REMOTAS (HOMOLOGAÇÃO CONTROLADA NO STAGING)

Caso o operador autorize a homologação remota com escrita no Supabase Staging em momento posterior, a execução deverá seguir estritamente o seguinte roteiro unificado e reversível:

| Ordem | Operação Remota | Escopo / Alvo | Dados Sintéticos Propostos | Justificativa Técnica | Reversibilidade / Limpeza |
|---|---|---|---|---|---|
| **Op-01** | `Upload e Ingestão de PDF` | Supabase Storage (`acervo/`) e tabela `acervo_arquivos` | Arquivo sintético `homologacao_acervo_quimica.pdf` (1 página, ~15 KB, texto sobre Estequiometria) via perfil Bruno (Responsável). | Validar o fluxo ponta a ponta de upload binário, cálculo de hash SHA-256 e enfileiramento em `acervo_jobs`. | Execução posterior de `excluirArquivoAcervo` remove o arquivo do Storage e registros em cascata. |
| **Op-02** | `Processamento On-Demand` | Fila durável `acervo_jobs` | Execução controlada via script: `npm run worker:ondemand`. | Validar o processamento das etapas `extracao`, `segmentacao` e `classificacao`. | O job transiciona para `concluido` ou `falhou` sem deixar locks travados (lease de 60s). |
| **Op-03** | `Verificação de Busca Híbrida` | Tabela `acervo_chunks` e função `fn_busca_hibrida_acervo` | Consulta de busca: *"cálculo estequiométrico e reagente limitante"*. | Comprovar que o material recém-ingerido é recuperável na busca híbrida textual/semântica. | Somente-leitura. |
| **Op-04** | `Auditoria de Isolamento RLS` | Consultas autenticadas via perfis Carlos e Alice | Consulta direta em `acervo_arquivos` e `acervo_chunks`. | Confirmar que a aluna vinculada (Alice) tem acesso e o aluno desvinculado (Carlos) é bloqueado. | Somente-leitura. |
| **Op-05** | `Cleanup e Restauração` | Storage e tabelas de Acervo | Exclusão do ID gerado na Op-01 via `excluirArquivoAcervo`. | Restaurar a base de Staging ao seu estado baseline exato. | Restauração 100% comprovada por auditoria somente-leitura. |

---

## 8. PARECER FINAL

### **PARECER: APTO COM RESSALVAS OPERACIONAIS**

**Fundamentação Técnica do Parecer:**
1. **FSRS 100% Homologado:** As pendências de contagem de tempo com inatividade de aba e contraste visual foram plenamente corrigidas, testadas e aprovadas localmente em Vitest e Playwright E2E.
2. **Segurança e Robustez do Acervo:** O módulo de Acervo demonstrou arquitetura exemplar: upload restrito exclusivamente a PDFs íntegros, validação contra malformações e exploits ativos, proteção determinística contra colisões de armazenamento, filas duráveis com controle transacional de lease e isolamento estrito via RLS.
3. **Resolução de Bloqueador de Banco:** A correção transacional do `search_path` para o schema `extensions` garantiu a estabilidade da busca híbrida com `pgvector`.
4. **Ressalvas Operacionais:** A homologação do processamento completo de embeddings e OCR no Supabase Staging depende da autorização da matriz de operações remotas (Seção 7) e do provisionamento de credenciais de IA, mantendo o ambiente atual estritamente íntegro e sem custos imprevistos.

---
*Relatório emitido e validado com sucesso.*
