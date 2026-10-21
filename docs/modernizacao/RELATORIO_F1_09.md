# MEDICINA 2029 — RELATÓRIO TÉCNICO F1.09
## Validação Runtime, Integridade Relacional e Proposta de Idempotência Persistente

**Data:** 20/10/2026  
**Tarefa:** F1.09 — Validação Runtime e Integridade Relacional  
**Status:** APROVADA COM RESSALVAS  
**Acesso a produção / Supabase remoto:** Nenhum  
**Migrations aplicadas em banco persistente:** Nenhuma  

---

## 1. Resumo Executivo e Alterações Realizadas

A tarefa F1.09 fortaleceu a validação runtime nas fronteiras das Server Actions e a proteção de integridade relacional, preservando os contratos públicos de erro introduzidos na F1.07, as garantias transacionais da F1.08 e a compatibilidade integral com a expansão F1.03-R (`0003_f1_03_r_expansao.sql`), sem antecipar a contração `NOT NULL` (`F1_03_R_CONTRACAO_PROPOSTA.sql`).

### Principais entregas
1. **Biblioteca de Validação Runtime Reutilizável (`src/lib/validation.ts`):**
   - Implementada sem dependências externas adicionais (o projeto não possui `zod` em `package.json`), compondo primitivos estritos para UUIDs, strings, números inteiros/decimais, booleanos, enums, datas, objetos JSON, arrays com unicidade por chave derivada (`uniqueBy`), objetos com rejeição explícita de identificadores de autorização enviados pelo cliente (`perfilId`, `authUserId`, `papel`, `enviadoPor`, `aprovadoPor`, `estudantePerfilId`, `registradaPorPerfilId`) e validação binária de uploads PDF (`.pdf`, bloqueio de path traversal, limite de 20 MiB e assinatura mágica `%PDF-`).
   - Utilitário determinístico `computeIdempotencyPayloadHash` (SHA-256 sobre JSON canônico) para detecção de conflitos em chaves idempotentes.
2. **Validação Runtime e Integridade Relacional nas Server Actions:**
   - Rejeição imediata (fail-fast) de payloads malformados, UUIDs inválidos, valores fora de faixa e campos de identidade forjados antes de abrir transações ou tocar banco/Storage.
   - Verificação relacional explícita de vínculos entre blocos de ciclo, ciclos da estudante, tópicos, disciplinas, questões, tentativas (incluindo proibição de registrar erro em tentativa acertada), cards FSRS (elegibilidade `status === 'aprovado'` e `!suspenso`), itens de curadoria e gêneros de redação UECE.
3. **Proposta SQL Reversível para Idempotência Persistente e Constraints (`docs/modernizacao/propostas/`):**
   - Criada fora do journal automático do Drizzle (`F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` e `F1_09_ROLLBACK_INTEGRIDADE_E_IDEMPOTENCIA.sql`), com bloco `DO $$ ... $$` de preflight diagnóstico, tabela `operacoes_idempotentes`, colunas nullable `chave_idempotencia` em `card_revisoes` e `geracoes`, índices únicos parciais/compostos e constraints `CHECK` (`NOT VALID` + `VALIDATE CONSTRAINT`).
4. **Suíte de Testes Negativos e Integração em PostgreSQL Descartável:**
   - Ampliação dos testes unitários mockados e criação da suíte de integração real `src/app/actions/f1_09_integracao_pg.test.ts` executada sobre PostgreSQL 18.6 descartável em memória (PGlite + pgvector).

---

## 2. Arquivos Modificados e Criados

### Criados
- `src/lib/validation.ts` — Schemas reutilizáveis de validação runtime, sanitização de upload PDF e hash canônico de idempotência.
- `src/lib/validation.test.ts` — Testes unitários dos primitivos e schemas de domínio.
- `src/app/actions/f1_09_integracao_pg.test.ts` — Suíte de integração em PostgreSQL 18.6 descartável (PGlite) validando a proposta SQL F1.09, constraints, rollback e Server Actions contra banco real.
- `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` — Proposta SQL de idempotência persistente, unicidades e `CHECK` constraints com preflight.
- `docs/modernizacao/propostas/F1_09_ROLLBACK_INTEGRIDADE_E_IDEMPOTENCIA.sql` — Script de rollback atômico da proposta F1.09.
- `docs/modernizacao/RELATORIO_F1_09.md` e `~/Documents/MEDICINA_2029_F1_09_RELATORIO.md` — Relatório técnico desta tarefa.

### Modificados
- `src/app/actions/sessao.ts` — Schemas runtime (`iniciarSessao`, `atualizarSessao`, `concluirSessao`) e integridade relacional (vínculo bloco→ciclo→estudante, compatibilidade disciplina do tópico vs bloco, sessão aberta em `atualizarSessao`, ordem temporal `encerradaEm >= iniciadaEm`, rejeição de conflito de etapa em sessão já concluída, rejeição de erro para tentativa correta e compatibilidade de disciplina da questão).
- `src/app/actions/fsrs.ts` — Schema runtime `registrarRevisaoCardInputSchema` antes da transação e verificação de elegibilidade do card (`status === 'aprovado'` e `!suspenso`).
- `src/app/actions/simulados.ts` — Schema runtime `registrarSimuladoInputSchema` (data válida, `duracaoMin` 1..720, `areas` não vazio, unicidade case-insensitive de área por simulado, `acertos <= total`, bloqueio de `perfilId` do cliente).
- `src/app/actions/curadoria.ts` — Schemas runtime `enfileirarGeracaoInputSchema` e `curarItemInputSchema`, validação de campos de edição por tipo de artefato e consistência relacional de `topicoId` nos `UPDATE`s.
- `src/app/actions/redacoes.ts` — Schemas runtime `registrarRedacaoInputSchema` (obrigatoriedade de `generoId` para `genero_uece`, limites de texto/minutos/nota) e `registrarRepertorioInputSchema`, mais verificação relacional de existência de `generoId` na tabela `generos`.
- `src/app/actions/acervo.ts` — Schema runtime `enviarArquivoInputSchema` (UUID, título, enum, `serieAlvo` 0..3, extensão `.pdf`, bloqueio de path traversal, limite de 20 MiB e assinatura `%PDF-`) e validação de UUID em `obterAcervoStatus` e `listarArquivosAcervo`.
- `src/app/actions/checkin.ts` — Schema runtime `registrarCheckinInputSchema` (`horasSono` 0..24, `exercicioMin` 0..1440, `humor` 1..5, `energia` 1..5).
- `src/app/actions/cadernoErros.ts` — Schema runtime `resolverErroInputSchema` (UUID).
- `src/app/actions/reestudo.ts` — Schema runtime `injetarTopicoNoCicloInputSchema` (`topicoId` UUID, `duracaoMin` 5..240).
- `src/lib/mocks.ts` — Atualização dos identificadores de `MOCK_TOPICOS` e `MOCK_BLOCOS` para UUIDs válidos compatíveis com a validação runtime.
- `src/app/actions/actions.test.ts`, `src/app/actions/fsrs.test.ts`, `src/app/actions/simulados-f1_07.test.ts`, `src/app/actions/curadoria.test.ts`, `src/app/actions/redacoes.test.ts`, `src/app/actions/acervo.test.ts`, `src/app/actions/authorization.test.ts`, `src/app/actions/f1_07_operations.test.ts`, `src/app/actions/reestudo.test.ts` — Adequação de fixtures para UUIDs/PDF válidos e adição dos testes negativos F1.09.
- `docs/modernizacao/PLANO_MODERNIZACAO.md` — Atualização do estado e registro da F1.09.

---

## 3. Validações Runtime e Regras de Integridade Implementadas

| Domínio / Action | Validação Runtime (`src/lib/validation.ts`) | Integridade Relacional e Idempotência/Conflito |
| :--- | :--- | :--- |
| **Sessões e Cronômetro** (`sessao.ts`) | `cicloBlocoId`, `topicoId` e `sessaoId` (UUID); `segundosEfetivos` e `segundosPausa` inteiros `0..86400`; `etapaAtingida` enum (`revisao`, `conteudo`, `questoes`, `registro`); `notaLivre <= 10000` chars; `errosParaRegistrar` até 100 itens com `tentativaId` único no lote e bloqueio de campos de auth do cliente. | `iniciarSessao` confirma que `cicloBloco` pertence a ciclo da estudante (ou legado `NULL` na expansão F1.03-R) e que `topico.disciplinaId === cicloBloco.disciplinaId`. `atualizarSessao` exige sessão aberta (`encerradaEm IS NULL`). `concluirSessao` verifica vínculo do ciclo, garante `encerradaEm >= iniciadaEm`, rejeita replay com `etapaAtingida` divergente (`CONFLICT`), exige que a questão pertença à mesma disciplina do tópico da sessão e rejeita erro apontando para `tentativa.correta === true`. |
| **FSRS** (`fsrs.ts`) | `cardId` (UUID), `rating` enum (`again`, `hard`, `good`, `easy`), `duracaoMs` inteiro `0..3600000`. | Falha antes de abrir transação se o payload for inválido; dentro da transação com `FOR UPDATE`, exige ownership (`cards.perfilId = perfil.id`), `status === 'aprovado'` e `suspenso === false`; preserva deduplicação de replay em janela de 60s. |
| **Simulados** (`simulados.ts`) | `formato` enum, `data` válida, `condicoesReais` boolean, `duracaoMin` inteiro `1..720`, `local` `1..255` chars, `composicaoProcedencia` JSON válido, `areas` `1..20` itens com unicidade case-insensitive de `area`, `total` `1..200`, `acertos` `0..total`, rejeição de `perfilId` no payload. | Valida todo o lote antes de abrir transação; preserva advisory lock por estudante e bloqueio de novo simulado enquanto houver análise pendente. |
| **Curadoria** (`curadoria.ts`) | `arquivoId` e `filaId` (UUID); `acao` enum (`aprovar`, `rejeitar`, `editar_aprovar`); `motivoRejeicao` obrigatório ao rejeitar; `dadosEdicao` obrigatório ao `editar_aprovar` com validação específica para `resumo`, `flashcard` e `questao` (2..6 alternativas, letras únicas e gabarito existente entre as alternativas). | Verifica ownership do arquivo (`enviadoPor = responsavel.id`), vínculo da estudante gerenciada ao criar card FSRS, e escopa os `UPDATE`s de `materiais`, `perguntasAtivas` e `questoes` também pelo `itemFila.topicoId`. |
| **Redações e Repertórios** (`redacoes.ts`) | `formato` enum (`enem`, `genero_uece`), `generoId` UUID obrigatório quando `formato === 'genero_uece'`, `tema` `3..500` chars, `texto` `50..30000` chars ou `arquivoUrl` válida, `minutosGastos` `1..600`, `notaTotal` `0..1000`, `reescritaDeId` UUID opcional; repertório com `temasAplicaveis` `1..20` itens. | Confirma existência real de `generoId` na tabela `generos` antes do `INSERT` e preserva verificação de ownership da redação original em `reescritaDeId`. |
| **Acervo e Uploads** (`acervo.ts`) | `disciplinaId` e `arquivoId` (UUID), `titulo` `2..255` chars, `tipoMaterial` enum, `serieAlvo` inteiro `0..3`, `vestibular` `1..50` chars, `fileName` `.pdf` sem caracteres de controle nem `..`/`/`/`\`, base64 válido, tamanho `1..20 MiB` (`20.971.520` bytes) e assinatura mágica `%PDF-`. | Impede upload para Storage e `INSERT` no banco quando o arquivo ou qualquer metadado falha na validação; preserva deduplicação por `hashConteudo`. |
| **Check-in, Erros e Reestudo** (`checkin.ts`, `cadernoErros.ts`, `reestudo.ts`) | Check-in: `horasSono` `0..24`, `exercicioMin` `0..1440`, `humor` e `energia` inteiros `1..5`; `resolverErro`: `erroId` UUID; `injetarTopicoNoCiclo`: `topicoId` UUID e `duracaoMin` inteiro `5..240`. | Preserva ownership por `perfil.id` e reordenação atômica do ciclo ativo da estudante. |

---

## 4. Avaliação da Idempotência (F1.08) e Proposta SQL Persistente

### Limitações dos mecanismos provisórios da F1.08
- Na F1.08, a deduplicação operou sem alterar o schema: FSRS apoiou-se em janela heurística de 60s sobre `lastReview` e último log; `iniciarSessao` apoiou-se em `SELECT` + `pg_advisory_xact_lock` sem índice único parcial no banco; `curadoria` deduplicou `geracoes` por comparação JSON de `arquivoIds`; `erros` verificou `tentativaId` por `SELECT` sem constraint `UNIQUE` física.

### Proposta mínima reversível (`F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`)
1. **Preflight diagnóstico (`DO $$ ... $$`):** aborta sem efeitos colaterais se a expansão F1.03-R não estiver presente, se existirem duplicidades históricas (`sessoes` abertas por perfil/bloco/tópico, `erros.tentativa_id`, `curadoria_fila(artefato_tipo, artefato_id)`, `acervo_arquivos.hash_conteudo`) ou registros fora dos limites de domínio.
2. **Idempotência persistente:**
   - Tabela `operacoes_idempotentes` com `UNIQUE (perfil_id, escopo, chave_idempotencia)` e `payload_hash` (SHA-256 de 64 caracteres) para distinguir repetição idêntica de conflito de payload sob a mesma chave.
   - Colunas nullable `chave_idempotencia varchar(128)` em `card_revisoes` e `geracoes`, com índices únicos parciais (`WHERE chave_idempotencia IS NOT NULL`), mantendo 100% de compatibilidade com linhas históricas.
3. **Unicidades estruturais:**
   - `sessoes_uma_aberta_por_bloco_topico_uidx` (`UNIQUE (perfil_id, ciclo_bloco_id, topico_id) WHERE encerrada_em IS NULL`);
   - `erros_tentativa_id_unique` (`UNIQUE (tentativa_id)`);
   - `curadoria_fila_artefato_unique` (`UNIQUE (artefato_tipo, artefato_id)`);
   - `acervo_arquivos_hash_conteudo_unique` (`UNIQUE (hash_conteudo)`).
4. **Constraints `CHECK` de domínio (`NOT VALID` + `VALIDATE CONSTRAINT`):**
   - `sessoes_tempos_limites_check` e `sessoes_ordem_temporal_check`;
   - `card_revisoes_duracao_rating_check`;
   - `simulados_duracao_limites_check` e `simulado_areas_acertos_total_check`;
   - `redacoes_limites_e_genero_check` (exigindo `genero_id IS NOT NULL` quando `formato = 'genero_uece'` e preservando registros históricos `enem`);
   - `checkins_limites_dominio_check`;
   - `acervo_arquivos_tamanho_serie_check`.
5. **Compatibilidade F1.03-R e Rollback:**
   - Não altera a nulabilidade de `ciclos.estudante_perfil_id`, `repertorios.perfil_id` ou `revisoes_trimestrais.*`.
   - `F1_09_ROLLBACK_INTEGRIDADE_E_IDEMPOTENCIA.sql` reverte todas as constraints, índices, colunas e tabela em transação única.

---

## 5. Testes e Resultados da Validação Final

### Diferenciação entre testes mockados, integração real e não executados
- **Testes unitários e de fronteira mockados (Vitest):** 25 arquivos de teste (214 testes) exercitando schemas em `src/lib/validation.test.ts` e Server Actions com dublês de banco/Storage/IA, cobrindo UUID inválido, limites numéricos/strings, payload incompleto, referências inexistentes, ownership incorreto, arquivo excessivo/não-PDF, repetição de requisição, conflito de dados e ausência de escrita em validação rejeitada.
- **Testes de integração em PostgreSQL real descartável:**
  1. `src/app/actions/f1_09_integracao_pg.test.ts` (4 testes integrados no Vitest sobre PGlite PostgreSQL 18.6 + pgvector 0.8.7): aplica migrations `0000`–`0003`, fixtures sintéticas `F1.04` e `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`; valida rejeição física por constraints no banco, rollback e reaplicação idempotente, e executa as Server Actions reais (`iniciarSessao`, `atualizarSessao`, `concluirSessao`, `registrarRevisaoCard`, `registrarSimulado`, `registrarRedacao`, `enfileirarGeracaoDeArtefatos`) contra o PostgreSQL descartável.
  2. `scripts/f1_04/run-rls-validation.mjs` (41 cenários em PostgreSQL 18.6 descartável com pgvector): valida RLS, views seguras, privilégios mínimos (`medicina_app`, `medicina_auth`, `medicina_anon`) e rollback/reaplicação.
- **Testes não executados:**
  - Testes E2E de navegador (Playwright/Cypress) não foram executados (escopo da F1.15).
  - Nenhum teste ou preflight foi executado contra banco de produção ou Supabase remoto (proibido pelas restrições da tarefa).

### Resultados da rodada única de validação final

| Verificação | Comando | Resultado |
| :--- | :--- | :--- |
| TypeScript | `npx tsc --noEmit` | **APROVADO** (0 erros) |
| Testes Automatizados (Mockados + PGlite) | `npm run test:run` | **APROVADO** (26 suítes / 218 testes aprovados) |
| Build de Produção Next.js | `npm run build` | **APROVADO** (compilação e geração de páginas sem erros) |
| Lint dos Arquivos Modificados | `npx eslint <22 arquivos TS modificados>` | **APROVADO** (0 erros, 0 warnings) |
| Integridade do Journal Drizzle | `npx drizzle-kit check` | **APROVADO** (`Everything's fine`) |
| Higiene de Diff Git | `git diff --check` | **APROVADO** (0 problemas de whitespace/conflito) |
| Suíte RLS Isolada Existente | `node scripts/f1_04/run-rls-validation.mjs` | **APROVADO** (41/41 cenários aprovados, 100%) |

---

## 6. Riscos Remanescentes

1. **Proposta SQL F1.09 ainda não aplicada no banco persistente:** as constraints físicas (`UNIQUE` e `CHECK`) e a tabela `operacoes_idempotentes` estão validadas em PostgreSQL 18.6 descartável, mas permanecem em `docs/modernizacao/propostas/` até janela operacional autorizada. Enquanto não aplicadas, a proteção contra estados inválidos no ambiente persistente depende da camada de validação runtime e das transações das Server Actions.
2. **Chaves idempotentes persistidas não acopladas ao schema Drizzle ativo:** para não quebrar `drizzle-kit check` nem exigir migration aplicada antes do código, `src/db/schema.ts` foi mantido alinhado às migrations `0000`–`0003`. O uso direto de `operacoes_idempotentes` e `chave_idempotencia` pelo ORM deverá ocorrer somente após a aplicação da migration proposta.
3. **Upload ainda trafega em base64 na Server Action (`acervo.ts`):** embora agora validado estritamente (tamanho <= 20 MiB, extensão `.pdf`, path traversal e assinatura `%PDF-`), o modelo de transporte e reconciliação com o Storage pertence à F1.10.

---

## 7. Dependências de Implantação

1. Manter a expansão compatível `0003_f1_03_r_expansao.sql` aplicada antes de qualquer execução da proposta `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`.
2. Executar backup nativo validado antes de aplicar `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` em ambiente persistente.
3. Caso o preflight de `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` acuse duplicidades históricas ou valores fora dos limites, realizar saneamento auditado antes de repetir a aplicação.
4. Não aplicar a contração `F1_03_R_CONTRACAO_PROPOSTA.sql` sem aprovação explícita e cumprimento de todos os seus pré-requisitos.

---

## 8. Próxima Tarefa Recomendada

**F1.10 — Upload e Storage confiáveis:** substituir/endurecer o fluxo de upload para garantir objeto privado efetivamente persistido e reconciliado com o registro em `acervo_arquivos`, mantendo os contratos explícitos da F1.07 e as validações de arquivo introduzidas na F1.09.
