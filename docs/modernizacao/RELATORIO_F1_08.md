# Medicina 2029 — Relatório Técnico F1.08

**Tarefa:** F1.08 — Atomicidade, idempotência e concorrência
**Data:** 20 de outubro de 2026
**Classificação:** **APROVADA COM RESSALVAS**
**Escopo:** repositório local, testes com mocks e PostgreSQL descartável; nenhum serviço ou dado real

## 1. Resumo executivo

A F1.08 tornou atômicos os fluxos PostgreSQL prioritários de conclusão de sessão, revisão FSRS, registro de simulado, persistência de lote gerado e decisão de curadoria. As transações são curtas; falhas intermediárias lançam exceção para provocar rollback e só há sucesso após `RETURNING` confirmado. Row locks e advisory locks serializam duplo clique e concorrência nos recursos relevantes.

A geração Gemini ocorre antes da transação, pois um serviço externo não participa da atomicidade PostgreSQL. Storage não foi acessado nem alterado. A solução preserva guards, ownership, contratos públicos da F1.07 e compatibilidade com o banco ainda não contraído.

Não foi criada nem executada migration. Como não há idempotency keys persistidas no schema atual, parte da deduplicação usa marcadores de domínio existentes. Por isso, e pela ausência de integração direta das Server Actions contra PostgreSQL real, a classificação é aprovada com ressalvas.

## 2. Correções implementadas

### Sessões

- `concluirSessao` executa leitura bloqueada, validações, atualização, registro de erros e avanço do ponteiro na mesma transação.
- `SELECT ... FOR UPDATE` serializa duas conclusões da mesma sessão.
- Sessão já encerrada retorna o estado persistido sem duplicar erros ou avançar novamente o ponteiro.
- O ponteiro do ciclo usa advisory lock transacional de 64 bits e só avança quando a sessão atingiu a etapa pedagogicamente concluída.
- Falha de `UPDATE`, inserção de erro ou upsert do ponteiro lança erro e aborta toda a transação.

### FSRS

- A revisão bloqueia a linha do card com `FOR UPDATE`.
- Atualização do card e inserção em `card_revisoes` são uma única unidade atômica, ambas confirmadas por `RETURNING`.
- Card de outro perfil ou inexistente continua resultando em `NOT_FOUND` sem escrita.
- Um card já reagendado, com último log coerente, é tratado como replay idempotente; payload divergente resulta em `CONFLICT`.
- Falha de consulta de cards não é mais convertida em lista vazia.
- A interface de revisão aguarda a persistência, bloqueia cliques concorrentes e não avança diante de falha.

### Simulados

- A verificação de análise pendente foi movida para dentro da transação.
- Advisory lock de 64 bits por estudante serializa duas requisições mesmo quando ainda não existe simulado a bloquear.
- Cabeçalho e áreas são persistidos atomicamente; qualquer área sem confirmação aborta o conjunto.
- Validação inválida ocorre antes de qualquer escrita e conflitos mantêm o código público `CONFLICT`.

### Curadoria e IA

- Chamadas Gemini permanecem fora da transação para evitar conexão e locks durante I/O externo.
- Se uma chamada externa falha, nenhum artefato do lote é persistido.
- Artefatos, itens da fila e marcador em `geracoes` são gravados numa única transação curta.
- Advisory lock por arquivo impede persistência duplicada; uma repetição encontra o lote concluído e retorna o resultado existente.
- Decisão de curadoria usa lock por item e transação única para artefato, eventual card FSRS derivado e atualização da fila.
- Repetição da mesma decisão é idempotente; decisão diferente retorna `CONFLICT`.
- Falhas de autorização de `requireManagedStudentProfile` continuam propagadas e provocam rollback.

### Acervo e Storage

Nenhuma tentativa foi feita de tratar banco e Storage como uma única transação. Upload e compensação externa permanecem separados e documentados para F1.10/F1.11. Nenhum upload real foi executado.

## 3. Concorrência, rollback e contratos

Os locks pertencem à transação PostgreSQL e são liberados no commit ou rollback. Foram usadas chaves derivadas do recurso com `hashtextextended(..., 0)`, reduzindo colisões em comparação a chaves de 32 bits. Guards de papel continuam antes das escritas e filtros de ownership permanecem nas consultas e updates.

Falhas intermediárias que ocorrem após alguma escrita usam `throw`, e não retorno comum do callback, para garantir rollback pelo driver. Resultados esperados sem escrita (`NOT_FOUND`, `CONFLICT`, payload inválido e replay) podem retornar normalmente.

Os contratos discriminados da F1.07 foram preservados em simulados e curadoria. Sessão continua lançando `PublicOperationError`, como antes. FSRS preservou o contrato legado discriminado por `sucesso`, agora com `code` nas falhas, evitando ruptura desnecessária no consumidor.

## 4. Arquivos alterados

- `src/app/actions/sessao.ts`
- `src/app/actions/fsrs.ts`
- `src/app/actions/simulados.ts`
- `src/app/actions/curadoria.ts`
- `src/components/RevisaoPage.tsx`
- `src/app/actions/actions.test.ts`
- `src/app/actions/fsrs.test.ts`
- `src/app/actions/simulados-f1_07.test.ts`
- `src/app/actions/curadoria.test.ts`
- `src/app/actions/authorization.test.ts`
- `docs/modernizacao/PLANO_MODERNIZACAO.md`
- `docs/modernizacao/RELATORIO_F1_08.md`
- `/Users/brunoantunes/Documents/MEDICINA_2029_F1_08_RELATORIO.md` (cópia idêntica)

## 5. Testes e validações

### Testes direcionados durante a implementação

- 5 arquivos e 50/50 testes aprovados.
- Cobertura com mocks: rollback sinalizado por falha intermediária, `RETURNING` vazio, repetição, conflito, sessão encerrada, análise pendente, ownership e autorização.
- Diagnóstico isolado confirmou que `pg_advisory_xact_lock(hashtextextended(...))` é aceito pelo PostgreSQL descartável disponível.

### Gates finais — executados uma vez

| Verificação | Resultado |
|---|---|
| `npx tsc --noEmit` | passou, 0 erros |
| `npm run test:run` | passou, 24 arquivos e **184/184 testes** |
| `npm run build` | passou, 17 rotas; aviso preexistente sobre `middleware` |
| lint dos 10 arquivos TS/TSX modificados | passou, 0 ocorrências |
| `npx drizzle-kit check` | passou, `Everything's fine` |
| `git diff --check` | passou |
| `node scripts/f1_04/run-rls-validation.mjs` | passou, **41/41 cenários** em PostgreSQL 18.6/PGlite isolado |

Total único de casos automatizados contabilizados: **225**, sendo 184 testes Vitest mockados/unitários e 41 cenários PostgreSQL/RLS reais; 225 aprovados, 0 reprovados. Os 50 testes direcionados são subconjunto dos 184 e não foram somados novamente.

### Não executados

- integração das Server Actions modificadas contra PostgreSQL real;
- concorrência distribuída em múltiplas conexões/processos reais;
- E2E de navegador;
- Gemini, Storage, upload e serviços externos reais;
- produção, Supabase remoto, migrations, seeds e restore.

## 6. Limitações e riscos remanescentes

1. A idempotência FSRS é inferida de `lastReview`, `due` e do último log. Uma chave idempotente persistida continua recomendada para retries tardios e inequívocos.
2. Duas gerações concorrentes podem chamar Gemini em paralelo e duplicar custo; o lock impede duplicação no banco, não no provedor externo.
3. O marcador de lote em `geracoes` reutiliza o schema existente e igualdade do array JSON de arquivo; uma chave dedicada e constraint unique exigem migration futura.
4. Advisory locks dependem de PostgreSQL e não foram exercitados pelas actions em integração real nesta tarefa.
5. As actions ainda usam a conexão direta atual. Quando o RLS proposto for ativado, a adoção coordenada dos helpers de contexto transacional deverá ser validada em homologação.
6. Banco, Storage e Gemini não possuem transação distribuída. Compensação, outbox, fila durável e reconciliação continuam para F1.10/F1.11.
7. Constraints de unicidade propostas na F1.03-R não foram aplicadas; a contração permanece explicitamente fora desta tarefa.

## 7. Conclusão e próxima tarefa

Os falsos sucessos parciais dos fluxos prioritários foram substituídos por rollback PostgreSQL e confirmação explícita. Replays e conflitos relevantes são tratados sem enfraquecer autenticação ou ownership. As suítes disponíveis permaneceram verdes.

Próxima tarefa recomendada: **F1.09 — Validação runtime e integridade relacional**, incluindo o desenho de chaves idempotentes persistidas e constraints reversíveis, sem aplicação automática em ambiente real.

Confirmações: nenhum ambiente real ou remoto foi acessado; nenhum dado real foi usado; nenhuma migration, seed, restore, upload, chamada Gemini, exclusão de registros, commit, push ou deploy foi executado.
