# RELATÓRIO TÉCNICO — TAREFA F1.14
## ESTADO SERVER-SIDE DO CICLO E CRONÔMETRO
### PROJETO MEDICINA 2029

**Data:** 21 de outubro de 2026  
**Status da Tarefa:** CONCLUÍDA E APROVADA  
**Escopo:** Tornar o PostgreSQL a única fonte de verdade para o estado do ciclo de estudos e do cronômetro, eliminando dependências de mocks, valores heurísticos e autoridade em `localStorage`.

---

## 1. RESUMO EXECUTIVO

A tarefa **F1.14** reestruturou a governança de estado do ciclo de estudos e do cronômetro pedagógico, transferindo a autoridade definitiva para o PostgreSQL e eliminando integralmente os mocks (`MOCK_CICLO_ATIVO`, `MOCK_BLOCOS`, `MOCK_TOPICOS`, `q-mock-*`, `t-mock-*`) e as autoridades locais espúrias (`localStorage.medicina_2029_proxima_ordem`, `medicina_2029_concluidos_semana`).

O cronômetro passa a operar orientado por um modelo server-side estrito com 5 estados operacionais explícitos (`nao_iniciada`, `em_andamento`, `pausada`, `concluida` e `falha_sincronizacao`), hidratando seu estado real a partir de `obterEstadoSessaoCronometro` e sincronizando checkpoints duráveis com concorrência segura (`FOR UPDATE` e locks transacionais `pg_advisory_xact_lock`). A reconciliação temporal baseia-se em teto físico de tempo decorrido (*wall-clock* no servidor), garantindo que tempos ou conclusões fictícias nunca sejam gerados diante de falhas parciais ou interrupções de rede.

Todos os 265 testes automatizados do projeto (distribuídos em 32 arquivos de teste) foram executados e aprovados com 100% de êxito, acompanhados de compilação Next.js Turbopack em modo produção, validação de tipos TypeScript, verificação estrita de lint ESLint, verificação de schema Drizzle e execução íntegra da suíte isolada de segurança PostgreSQL RLS (41 cenários aprovados).

---

## 2. AUDITORIA DO ESTADO ANTERIOR

Antes da F1.14, a auditoria detalhada dos módulos `ciclo.ts`, `sessao.ts`, `HojePage.tsx`, `CicloPage.tsx` e `CronometroPage.tsx` identificou as seguintes fragilidades estruturais:

| Componente / Fluxo | Estado Identificado | Risco / Problema Arquitetural |
| :--- | :--- | :--- |
| `obterCicloAtivo()` em `ciclo.ts` | Retornava `MOCK_CICLO_ATIVO` e `MOCK_BLOCOS` quando o banco estava vazio ou em falha | O sistema simulava a existência de um ciclo com blocos fictícios; o usuário nunca via a ausência de ciclo configurado. |
| `obterTopicosPorDisciplina()` em `ciclo.ts` | Retornava `MOCK_TOPICOS` hardcoded | Criação de sessões com IDs fictícios não referenciados na chave estrangeira de `topicos`. |
| `CicloPage.tsx` e `HojePage.tsx` | Gravavam e liam `medicina_2029_proxima_ordem` e `medicina_2029_concluidos_semana` no `localStorage` | O avanço do ciclo ocorria no navegador mesmo se a Server Action falhasse; abrir em outro navegador retrocedia ou duplicava blocos. |
| `CronometroPage.tsx` | Armazenava o estado da sessão exclusivamente no `localStorage` sob a chave `medicina_2029_cronometro_estado` | Atualizar a página (F5) em outro dispositivo ou limpar os dados do navegador perdia a sessão aberta ou permitia sessões zumbis simultâneas. |
| Avanço de etapa e conclusão | Não usava lock transacional ou verificação de versão | Cliques duplos em "Concluir" ou "Pular Etapa" avançavam o ponteiro do ciclo duas vezes ou criavam checkpoints desordenados. |
| Anotações de erros de sessão | Geravam identificadores arbitrários `q-mock-${Date.now()}` e `t-mock-${Date.now()}` | Tentativas de inserção em `caderno_erros` falhavam por violação de integridade referencial com tabelas inexistentes. |

---

## 3. IMPLEMENTAÇÕES E ENDURECIMENTOS TÉCNICOS

### 3.1 Purga Total de Mocks e Fallbacks Silenciosos
- **Remoção de Mocks:** Os objetos `MOCK_CICLO_ATIVO`, `MOCK_BLOCOS` e `MOCK_TOPICOS` foram completamente eliminados de `src/app/actions/ciclo.ts`, `src/components/HojePage.tsx` e `src/components/CicloPage.tsx`.
- **Comportamento Fail-Closed:**
  - `obterCicloAtivo()` consulta estritamente `public.ciclos_estudo` e `public.ciclo_blocos`. Caso nenhum ciclo ativo exista, retorna `null`. Em falhas de banco, dispara erro operacional `PERSISTENCE_ERROR` (sem fallback).
  - `obterTopicosPorDisciplina(disciplinaId)` valida o UUID via Zod e consulta exclusivamente `public.topicos`. Se a disciplina não possuir tópicos, retorna `[]`.
  - As páginas do ciclo (`src/app/page.tsx` e `src/app/ciclo/page.tsx`) agora renderizam um estado visual amigável informando a necessidade de inicialização do ciclo, sem forçar ciclos fictícios.

### 3.2 Novo Contrato e Reconciliação Server-Side do Cronômetro
Foi criado o módulo de domínio puro `src/lib/cicloCronometroReconciliacao.ts` contendo as regras determinísticas de temporalidade e ordem pedagógica:
- **Ordem Monotônica de Etapas:** `revisao` (0) → `conteudo` (1) → `questoes` (2) → `registro` (3) → `pausa` (4). O cronômetro rejeita qualquer tentativa de retrocesso indevido de etapas.
- **Teto Físico de Tempo Decorrido (*Wall-Clock*):** `calcularTetoSegundosDecorridosServidor(iniciadaEm, agoraMs)` calcula a cota física máxima de segundos possíveis desde o início da sessão. O cronômetro impede a injeção de segundos além do tempo real decorrido no relógio.
- **Reconciliação Determinística:** `reconciliarEstadoCronometroComServidor({ servidor, cacheLocal, agoraMs })` valida o cache local contra o registro do PostgreSQL. Se o ID da sessão divergir ou se o servidor apontar sessão já concluída, o cache local é sumariamente descartado (`cacheLocalDescartado = true`).

### 3.3 Cinco Estados Operacionais Explícitos
O cronômetro opera exclusivamente sob uma máquina de estados finita com 5 estados:
1. `nao_iniciada`: Nenhuma sessão aberta no banco para o bloco/tópico selecionado.
2. `em_andamento`: Sessão aberta e cronômetro em contagem ativa.
3. `pausada`: Sessão aberta, mas temporizador pausado pelo estudante ou aguardando ação.
4. `concluida`: Sessão finalizada no banco (etapa de registro salva com sucesso).
5. `falha_sincronizacao`: Falha de comunicação com o servidor. A contagem do cronômetro é congelada, nenhum progresso fictício é computado e o estudante recebe diagnóstico amigável.

### 3.4 Sincronização e Prevenção de Conflitos de Concorrência
- **Prevenção de Múltiplas Sessões Abertas:** Em `iniciarSessao()` (`src/app/actions/sessao.ts`), o sistema verifica se o perfil já possui sessão aberta em `public.sessoes`. Se houver sessão aberta para o mesmo bloco, o ID existente é reaproveitado; se for para outro bloco, a ação rejeita a criação com código `CONFLICT`, exigindo a conclusão ou encerramento da sessão anterior.
- **Lock de Linha em Checkpoints:** `sincronizarCheckpointSessao()` executa dentro de transação com `SELECT ... FOR UPDATE` sobre a linha da sessão. Assegura atualização atômica de `segundosEfetivos`, `segundosPausa`, `etapaAtingida` e `notaLivre`, rejeitando tentativas de sobrescrita defasada (`etapaEsperada`).
- **Deduplicação de Avanço do Ciclo:** `atualizarPonteiroCiclo()` (`src/app/actions/ciclo.ts`) executa lock consultivo de transação (`pg_advisory_xact_lock(hashtext('ciclo_ponteiro_' || cicloId))`) e valida `ordemEsperada`. Cliques concorrentes ou requisições duplicadas são absorvidos de forma idempotente sem avançar blocos indevidamente.
- **Progresso Semanal Real:** `obterProgressoSemanalCiclo()` calcula as sessões concluídas contando exclusivamente registros persistidos com `concluida = true` na semana ISO atual (`date_trunc('week', now())`), eliminando contadores arbitrários em `localStorage`.

### 3.5 Sanidade e Integridade no Registro de Erros
- Foram eliminados os prefixos mockados `q-mock-*` e `t-mock-*`.
- O cronômetro diferencia anotações livres de estudos da inserção de erros formais: apenas erros que acompanham UUIDs legítimos de questão e tentativa são despachados em `errosParaRegistrar` para persistência em `public.caderno_erros`. Anotações gerais de revisão são consolidadas estruturadamente no campo `nota_livre` da sessão.

---

## 4. AUDITORIA E REGISTRO DE SEGURANÇA RLS

Conforme as diretrizes estritas da tarefa:
1. **RLS não foi ativado nesta tarefa:** Nenhuma política remota foi alterada e não se presumiu que o contexto RLS já esteja resolvido.
2. **Rejeição de Identidade Fornecida pelo Cliente:** As schemas de validação Zod (`acaoPonteiroCicloSchema`, `atualizarPonteiroCicloInputSchema`, `obterEstadoSessaoCronometroInputSchema`, `sincronizarCheckpointSessaoInputSchema`) não aceitam propriedades como `perfilId` ou `papel`. A identidade do usuário é derivada exclusivamente dos dados validados do token de sessão server-side (`obterContextoAutenticado`).
3. **Bloqueador Obrigatório de Homologação Mantido:**
   > **BLOQUEADOR OBRIGATÓRIO:** A integração sistemática da execução do contexto transacional `medicina.set_context(perfil_id, papel)` em todas as conexões da role `medicina_app` (`DATABASE_URL`), abrangendo todas as Server Actions de ciclo, cronômetro e sessões, é requisito bloqueante e indispensável antes da futura ativação de `FORCE ROW LEVEL SECURITY` em ambiente de produção.

---

## 5. MATRIZ DE TESTES E VALIDAÇÃO EXECUTADA

### 5.1 Testes Unitários de Domínio (`cicloCronometroReconciliacao.test.ts`)
- **6 testes aprovados (100%):**
  - Ordem monotônica das etapas (`revisao` < `conteudo` < `questoes` < `registro` < `pausa`).
  - Comparação e seleção da etapa mais avançada.
  - Cálculo do tempo restante baseado na cota nominal da etapa.
  - Cálculo do teto físico de tempo decorrido (*wall-clock*).
  - Reconciliação priorizando o banco de dados contra cache local divergente.
  - Descarte seguro do cache local quando a sessão no servidor já se encontra concluída.

### 5.2 Testes de Integração em PostgreSQL 18.6 Isolado (`f1_14_ciclo_cronometro_integracao.test.ts`)
Executados utilizando PGlite in-memory com schema completo:
1. **Recuperação Real após Refresh/F5:** Criação de sessão no banco, recuperação fidedigna através de `obterEstadoSessaoCronometro` e conferência dos tempos e etapa atingida.
2. **Atualização Atômica de Checkpoint:** Chamada a `sincronizarCheckpointSessao` com avanço monotônico de `revisao` para `conteudo`, validação de `emPausa` e bloqueio de retrocesso.
3. **Idempotência de Cliques Concorrentes:** Duas chamadas simultâneas a `atualizarPonteiroCiclo` com o mesmo `ordemEsperada`; a primeira avança para o bloco seguinte, a segunda é rejeitada com `CONFLICT` de forma idempotente, preservando a ordem correta.
4. **Resiliência contra Falha de Persistência:** Tentativa de avanço com ciclo inexistente; o banco não altera ponteiros e a action retorna erro estruturado `PERSISTENCE_ERROR`.
5. **Proteção de Ownership e Isolamento:** Tentativa de estudante consultar ou sincronizar sessão pertencente a outro perfil é sumariamente bloqueada com `NOT_FOUND` ou `FORBIDDEN`.

### 5.3 Resultados Consolidados de Validação

| Verificação | Comando | Resultado |
| :--- | :--- | :--- |
| **TypeScript** | `npx tsc --noEmit` | **0 erros** |
| **ESLint** | `npx eslint <arquivos_modificados>` | **0 erros, 0 warnings** |
| **Drizzle Kit** | `npx drizzle-kit check` | **Schema íntegro e sincronizado** |
| **Git Diff** | `git diff --check` | **0 conflitos ou espaços em branco incorretos** |
| **Vitest (Total)** | `npm run test:run` | **32 suítes aprovadas, 265 testes aprovados (100%)** |
| **Next.js Build** | `npm run build` | **Compilação otimizada com Turbopack concluída com sucesso** |
| **Suíte RLS (F1.04)** | `node scripts/f1_04/run-rls-validation.mjs` | **41 cenários de segurança aprovados (100%)** |

---

## 6. ARQUIVOS MODIFICADOS E CRIADOS

### Criados
- `src/lib/cicloCronometroReconciliacao.ts`: Rotinas de domínio para estados, tempos, teto físico e reconciliação.
- `src/lib/cicloCronometroReconciliacao.test.ts`: Testes unitários da reconciliação do cronômetro.
- `src/app/actions/f1_14_ciclo_cronometro_integracao.test.ts`: Suíte de integração com PostgreSQL in-memory.
- `docs/modernizacao/RELATORIO_F1_14.md`: Este relatório técnico.

### Modificados
- `src/lib/validation.ts`: Adição de schemas Zod defensivas sem campos de identidade do cliente.
- `src/app/actions/ciclo.ts`: Purga total de mocks; `obterProgressoSemanalCiclo()`; `atualizarPonteiroCiclo()` com lock transacional.
- `src/app/actions/sessao.ts`: `obterEstadoSessaoCronometro()`; `sincronizarCheckpointSessao()` com lock `FOR UPDATE`.
- `src/app/actions/actions.test.ts`: Atualização de expectativas unitárias para ausência de mocks.
- `src/app/page.tsx`: Injeção de ciclo real e tratamento de ausência de ciclo ativo.
- `src/app/ciclo/page.tsx`: Tratamento de ciclo real sem fallbacks artificiais.
- `src/components/CicloPage.tsx`: Removida autoridade de `localStorage` para navegação do ciclo.
- `src/components/HojePage.tsx`: Sincronização server-side exclusiva do bloco atual, tópicos e progresso semanal.
- `src/components/CronometroPage.tsx`: Estados server-side explícitos, reconexão de rede, teto físico e purga de IDs mockados.
- `docs/modernizacao/PLANO_MODERNIZACAO.md`: Atualização do status de F1.14 e direcionamento para F1.15.

---

## 7. CRITÉRIOS DE ROLLBACK

Caso seja identificada qualquer inconsistência operacional:
1. Reverter os commits associados à F1.14 no controle de versão git (`git revert`).
2. Nenhuma alteração foi realizada em banco de dados remoto ou persistente, eliminando necessidade de rollback DDL.
3. As propostas anteriores (`F1.04` a `F1.13`) permanecem integralmente preservadas e compatíveis.

---

## 8. CONCLUSÃO E PRÓXIMA ETAPA

A tarefa **F1.14** foi executada integralmente em conformidade com o plano diretor. O ciclo de estudos e o cronômetro operam sob a autoridade incontestável do PostgreSQL, com reconciliação determinística e resiliência a desconexões e refresh.

A próxima etapa autorizada pelo plano diretor é a **F1.15 — Backup completo e recuperação testada**.
