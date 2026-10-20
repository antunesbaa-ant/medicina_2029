# Medicina 2029 — Relatório Técnico F1.07

**Tarefa:** F1.07 — Tratamento de erros, contratos de resultado e eliminação de falsos sucessos
**Fase:** 1 — Confiabilidade e Segurança
**Data:** 20 de outubro de 2026
**Classificação:** **APROVADA COM RESSALVAS**
**Escopo de execução:** repositório local, testes com mocks e PostgreSQL isolado em memória; nenhum serviço externo real

## 1. Resumo executivo

A F1.07 criou um contrato público reutilizável de resultado, corrigiu falsos sucessos críticos e adaptou os consumidores diretamente afetados. Upload não continua depois de falha do Storage; metadados só produzem confirmação quando o `INSERT ... RETURNING` devolve o registro; o processamento do acervo é apresentado como pendente e não como concluído. Gemini não substitui falha por conteúdo fictício. Check-in, sessões, redações, repertórios, simulados e decisões de curadoria passaram a validar sinais concretos de persistência nos pontos modificados.

O cronômetro não avança etapa, ponteiro ou estado local quando a persistência falha. Simulados deixam de registrar análise acadêmica simulada como concluída. Gêneros e repertórios deixam de aparecer a partir de mocks quando não existem registros. Busca, redações, simulados e caderno de erros, nos fluxos alterados, diferenciam ausência legítima de falha operacional.

A revisão independente encontrou e corrigiu uma regressão de classificação: uma negação ao resolver a estudante vinculada durante a curadoria poderia ser capturada como `PERSISTENCE_ERROR`; ela volta a ser propagada como `FORBIDDEN`/`UNAUTHENTICATED`.

A tarefa não afirma eliminar todos os falsos sucessos do sistema. Permanecem fallbacks em ciclo, dashboard, lacunas e acompanhamento do responsável, contratos legados em outros módulos e riscos de atomicidade destinados à F1.08. Por isso, a classificação é **APROVADA COM RESSALVAS**.

## 2. Inventário de falsos sucessos

| Prioridade | Situação encontrada | Tratamento na F1.07 | Estado |
|---|---|---|---|
| P0 | falha/ausência de Storage era ignorada e upload retornava sucesso | falha retorna `EXTERNAL_SERVICE_ERROR` e nenhuma etapa de banco/pipeline é iniciada | corrigido |
| P0 | Gemini usava conteúdo determinístico após chave ausente, HTTP, rede ou resposta inválida | runtime falha explicitamente com categoria estável; mock ficou apenas para chamada explícita de teste/demonstração | corrigido |
| P0 | metadado de acervo e várias mutações podiam confirmar sem registro retornado | pontos alterados exigem `RETURNING` não vazio | corrigido no recorte |
| P0 | cronômetro avançava UI/localStorage após falha do servidor | avanço e finalização aguardam o servidor; falha mantém o estado e exibe erro | corrigido |
| P1 | simulado gravava assuntos fictícios e análise como concluída | análise simulada removida; sucesso informa `analiseStatus: 'pendente'` | corrigido |
| P1 | redação recebia nota fictícia | nova redação é gravada sem nota simulada | corrigido |
| P1 | gêneros e repertórios vazios viravam dados plausíveis | ausência real retorna lista vazia; indisponibilidade lança erro público | corrigido |
| P1 | busca hash-vetorial era apresentada como semântica | sem provedor real, busca falha explicitamente | corrigido |
| P1 | embeddings hash eram persistidos como índice real | pipeline não persiste embedding fictício nem marca conclusão; registra falha visível | corrigido |
| P1 | caderno manual usava UUIDs fictícios incompatíveis com FKs | operação é recusada até existir questão/tentativa persistida | contido |
| P1 | geração/curadoria multi-etapa podia retornar confirmação sem verificar cada escrita | inserts/updates alterados verificam retornos e comunicam persistência parcial | corrigido quanto ao falso sucesso; atomicidade pendente |
| P1 | ciclo, dashboard, lacunas e acompanhamento ainda usam mocks/fallbacks | não alterados para evitar expansão e colisão de escopo | remanescente |
| P1 | FSRS e algumas consultas ainda convertem falha em `[]` ou erro genérico | inventariado para continuação | remanescente |
| P2 | contratos públicos misturavam throw, `[]`, `null` e `{sucesso}` | contrato discriminado aplicado às fronteiras prioritárias | parcialmente corrigido |
| P2 | logs enviavam objetos completos de banco/SDK | novos fluxos usam categoria e contexto controlados | corrigido no recorte |
| P2 | sessão, FSRS, simulado, curadoria e acervo podem persistir parcialmente | falha não é exibida como sucesso; transações/idempotência ficam para F1.08 | remanescente documentado |
| P3 | dívida de lint e `any` dificulta contratos consistentes | novos módulos limpos; dívida histórica preservada | remanescente |

## 3. Contratos definidos

`src/lib/operation-result.ts` define a união discriminada:

```ts
type OperationResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: OperationErrorCode; message: string };
```

Os códigos documentados e estáveis são:

- `UNAUTHENTICATED`;
- `FORBIDDEN`;
- `VALIDATION_ERROR`;
- `NOT_FOUND`;
- `CONFLICT`;
- `PERSISTENCE_ERROR`;
- `EXTERNAL_SERVICE_ERROR`;
- `INTERNAL_ERROR`.

Os helpers `operationSuccess` e `operationFailure` impedem combinações ambíguas. `PublicOperationError` permite que consultas públicas lancem erro categorizado quando retornar lista vazia seria incorreto. O contrato não foi imposto mecanicamente a helpers internos nem a todas as actions legadas.

## 4. Autenticação e autorização

Os guards criados na F1.02 foram preservados. Em geral, `requireRole`/`requireAuthenticatedProfile` permanecem antes dos `try/catch` operacionais, impedindo que sessão ausente ou papel negado virem lista vazia ou falha de persistência.

Na revisão integrada foi identificado um caso específico em `curarItem`: `requireManagedStudentProfile()` era necessário somente após conhecer o tipo do item e, portanto, era chamado dentro do bloco operacional. O catch agora reconhece `AuthorizationError` e o propaga sem alterar o código. Um teste comprova a preservação de `FORBIDDEN`.

Ownership existente foi mantido em sessão, erro, card, acervo e vínculo responsável–estudante. Nenhuma política RLS proposta foi modificada ou ativada.

## 5. Falhas de persistência

Foram adicionadas confirmações por `RETURNING` para os pontos modificados de:

- check-in;
- início, atualização e conclusão de sessão;
- redação e repertório;
- simulado e suas áreas;
- arquivo e transições de estado do acervo;
- artefatos e fila de curadoria;
- updates de decisão de curadoria e criação de card FSRS derivado.

`UPDATE` com zero linhas é tratado como `NOT_FOUND` ou `PERSISTENCE_ERROR`, conforme a semântica. Falhas posteriores a uma escrita anterior retornam erro e, quando conhecido, mensagem explícita de persistência parcial. Isso evita confirmação falsa, mas não desfaz efeitos já gravados.

Não foram introduzidas transações extensas. Conclusão de sessão, revisão FSRS, simulado, geração/curadoria e pipeline do acervo ainda precisam de atomicidade, idempotency keys e testes de concorrência na F1.08.

## 6. Inteligência artificial

`gerarArtefatosGemini` agora:

- exige exclusivamente `GEMINI_API_KEY`;
- nunca usa `ANTHROPIC_API_KEY`;
- envia a chave somente no cabeçalho;
- aplica timeout de 30 segundos com `AbortController`;
- diferencia chave ausente, HTTP, timeout, rede e resposta inválida;
- valida a estrutura mínima do JSON antes de retorná-lo;
- não usa fallback determinístico no runtime;
- não inclui detalhes do provedor, payload ou credencial no erro público.

Artefatos gerados são persistidos como rascunho e enviados à fila de curadoria. Nenhum conteúdo é aprovado automaticamente. A fixture determinística permanece exportada apenas para uso explícito em teste/demonstração controlada e não possui chamador no runtime auditado.

## 7. Upload, processamento e busca

O fluxo distingue:

- upload concluído: objeto do Storage confirmado e metadado retornado pelo banco;
- processamento pendente: resposta imediatamente após upload confirmado;
- processamento em andamento: estados `extraindo`, `segmentando`, `classificando` e `indexando`;
- processamento concluído: estado suportado pelo modelo, mas não produzido nesta fase sem embeddings reais;
- processamento com falha: status `falhou` com mensagem pública.

Se Storage falhar, nada é cadastrado e o pipeline não começa. Se Storage concluir e o banco falhar, o resultado declara a situação parcial e orienta a não reenviar antes de verificar o acervo. Não foi realizada compensação externa, exclusão no Storage ou upload real.

O pipeline continua efêmero em uma Promise da requisição até a F1.11. Como não existe provedor real de embeddings, ele não grava vetores hash como se fossem reais e não marca a ingestão como concluída. A busca semântica falha explicitamente enquanto o provedor não existe.

## 8. Consumidores modificados

- `HojePage`: só grava check-in local após `ok: true`; finaliza loading em `finally`.
- `CronometroPage`: remove IDs fallback de bloco/tópico, aguarda persistência e não avança estado local em falha.
- `BuscaPage`: mostra indisponibilidade em vez de “nenhum resultado”.
- `CadernoErrosPage`: entende o contrato discriminado e mantém falhas visíveis.
- `RedacoesPage`: distingue carregamento vazio de erro e só fecha formulários após confirmação.
- `SimuladosPage`: só fecha o formulário após persistência confirmada.
- `AcervoPage`: diferencia upload confirmado de processamento e trata erro do `FileReader`.
- `CuradoriaPage`: só remove item da fila após confirmação, informa falhas de geração/decisão e nomeia Gemini corretamente.

Não houve redesenho visual nem mudança deliberada dos fluxos pedagógicos além da retirada de confirmações fictícias.

## 9. Logs seguros

`logOperationalFailure(context, category)` registra somente dois valores controlados pelo código. Categorias: autenticação, autorização, negócio, persistência, serviço externo e erro interno. Objetos de exceção, SQL, URLs, conteúdo estudantil e respostas completas de SDK não são enviados por esse helper.

Storage e Gemini também passaram a emitir mensagens estáticas ou código HTTP, sem reproduzir chaves, connection strings ou payloads. Logs legados fora do recorte continuam inventariados como dívida. Não foi criado serviço externo de observabilidade nem correlation ID persistente.

## 10. Arquivos alterados

### Código e testes

- `src/lib/operation-result.ts` e `src/lib/operation-result.test.ts`;
- `src/lib/gemini.ts` e `src/lib/gemini.test.ts`;
- `src/lib/ingestion.ts` e `src/lib/ingestion.test.ts`;
- `src/lib/supabaseStorage.ts`;
- `src/app/actions/acervo.ts`, `acervo.test.ts`;
- `src/app/actions/busca.ts`;
- `src/app/actions/cadernoErros.ts`;
- `src/app/actions/checkin.ts`;
- `src/app/actions/curadoria.ts`, `curadoria.test.ts`;
- `src/app/actions/redacoes.ts`, `redacoes.test.ts`;
- `src/app/actions/sessao.ts`, `actions.test.ts`, `authorization.test.ts`;
- `src/app/actions/simulados.ts`, `simulados-f1_07.test.ts`;
- `src/app/actions/f1_07_operations.test.ts`;
- `src/components/AcervoPage.tsx`, `AcervoPage.test.ts`;
- `src/components/BuscaPage.tsx`;
- `src/components/CadernoErrosPage.tsx`;
- `src/components/CronometroPage.tsx`;
- `src/components/CuradoriaPage.tsx`, `CuradoriaPage.test.ts`;
- `src/components/HojePage.tsx`;
- `src/components/RedacoesPage.tsx`;
- `src/components/SimuladosPage.tsx`.

### Documentação

- `docs/modernizacao/PLANO_MODERNIZACAO.md`;
- `docs/modernizacao/RELATORIO_F1_07.md`;
- `/Users/brunoantunes/Documents/MEDICINA_2029_F1_07_RELATORIO.md` (cópia idêntica verificada ao final).

## 11. Testes executados e resultados

### Linha de base antes da implementação

| Verificação | Resultado |
|---|---|
| TypeScript | passou |
| Vitest | 19 arquivos, 140/140 testes aprovados |
| build | passou, 17 rotas |
| Drizzle check | passou |
| `git diff --check` | passou |
| RLS isolada | 41/41 cenários aprovados |
| lint global | falhou: 136 ocorrências, 89 erros e 47 avisos |

### Validação final

| Verificação | Resultado |
|---|---|
| `npx tsc --noEmit` | **PASSOU**, 0 erros |
| `npm run test:run` | **PASSOU**, 24 arquivos e **172/172 testes** |
| `npm run build` | **PASSOU**, 17 rotas; aviso preexistente de depreciação de `middleware` |
| lint dos 32 arquivos TS/TSX alterados | **FALHOU**, 67 ocorrências: 53 erros e 14 avisos, concentrados em dívida preexistente de `any`, hooks e JSX |
| lint do subconjunto novo ou previamente limpo da F1.07 | **PASSOU**, 18 arquivos |
| lint global | **FALHOU**, 126 ocorrências: 83 erros e 43 avisos; melhora sobre a linha de base, mas ainda vermelho |
| `npx drizzle-kit check` | **PASSOU**, `Everything's fine` |
| `git diff --check` | **PASSOU** |
| `node scripts/f1_04/run-rls-validation.mjs` | **PASSOU**, 41/41 cenários, PostgreSQL 18.6/PGlite isolado |

Total automatizado contado: **213 verificações de caso** (172 Vitest mockados/unitários + 41 cenários de integração RLS), **213 aprovadas**, **0 reprovadas**. O comando de lint não é contado como caso de teste e permanece falho pela dívida descrita.

Os testes novos cobrem banco indisponível simulado, `INSERT`/`UPDATE` sem linha, não encontrado, autorização preservada, Storage falho, Gemini sem chave, HTTP/rede/timeout/resposta inválida, persistência parcial, ausência real, sucesso por `RETURNING`, mensagens sem segredo e consumidores que não exibem sucesso falso.

### Não executados

- E2E Playwright/browser: não executado; a suíte existente continua composta por placeholders e exigiria servidor/fixtures adequados.
- integração real das Server Actions com PostgreSQL: não executada; testes das actions usam mocks.
- Storage, Gemini, embeddings e upload reais: proibidos e não executados.
- produção/Supabase remoto: não acessados.
- migrations, contração F1.03-R, seeds e restore: não executados.

## 12. Limitações

1. O contrato discriminado foi aplicado às fronteiras prioritárias, não a todas as funções públicas.
2. Consultas e actions legadas ainda apresentam contratos heterogêneos.
3. A suíte das actions é majoritariamente mockada e não prova constraints, latência, driver ou rollback reais.
4. Os testes de componente de acervo/curadoria são estruturais, não testes de navegador.
5. O pipeline de ingestão não possui worker durável, retry, heartbeat ou dead-letter.
6. Não há provedor real de embedding nem busca híbrida operacional.
7. O arquivo já armazenado pode ficar órfão quando a persistência do metadado falha; a situação é comunicada, mas não compensada.
8. A atualização do status `falhou` após erro do pipeline não confirma `RETURNING`; se essa própria escrita falhar, somente o log sanitizado permanece.
9. Validação runtime completa de payloads e limites de upload permanece para F1.09/F1.10.
10. O lint dirigido completo não ficou verde por dívida anterior nos arquivos consumidores alterados.

## 13. Riscos remanescentes

### P0

Nenhum novo P0 foi identificado na revisão do diff. Os P0 de falso sucesso diretamente tratados — Storage, Gemini, confirmação de persistência e avanço local do cronômetro — ficaram cobertos por testes. Isso não equivale a afirmar ausência de P0 fora do recorte ou em ambiente real não testado.

### P1

- mocks/fallbacks em ciclo, dashboard, lacunas e painel do responsável;
- consultas FSRS e outras leituras ainda confundem erro com ausência;
- sessão, FSRS, simulado, curadoria e acervo não são atomicamente completos;
- pipeline efêmero pode ser perdido no encerramento do processo;
- busca indisponível até embeddings reais;
- cronômetro ainda coleta referências fictícias de questão/tentativa em parte do fluxo; o servidor agora recusa a conclusão, mas a origem precisa ser modelada;
- `HojePage` ainda contém estado/progresso pedagógico local simulado.

### P2/P3

- ausência de correlation ID e observabilidade estruturada persistente;
- validação runtime parcial;
- dívida de lint, `any` e hooks;
- E2E placeholders e ausência de cobertura de navegador.

## 14. Recomendações e conclusão

Próxima tarefa recomendada: **F1.08 — Atomicidade, idempotência e concorrência**, sem iniciá-la automaticamente. Prioridades: transações pequenas por caso de uso, idempotency keys, comunicação uniforme de persistência parcial e testes de falha em cada etapa. Depois, F1.09/F1.10/F1.11/F1.12 devem tratar validação, upload/Storage, fila durável e IA/recuperação reais.

Confirmações:

- nenhum ambiente de produção foi acessado ou modificado;
- nenhum dado real foi usado;
- nenhum upload, chamada Gemini ou serviço externo real foi executado;
- nenhuma migration, contração, seed, restauração ou exclusão de registros foi executada;
- nenhuma credencial foi lida ou modificada;
- nenhum commit, push ou deploy foi realizado;
- alterações anteriores do worktree foram preservadas.

**Conclusão:** a F1.07 atende os principais critérios de confiabilidade no recorte implementado, compila e mantém as suítes unitária e RLS verdes, mas não conclui a remoção global de fallbacks nem a atomicidade. Classificação final: **APROVADA COM RESSALVAS**.
