# Medicina 2029 — Relatório Técnico F1.03-R

**Tarefa:** F1.03-R — Correção da Migração e Compatibilidade do Aplicativo
**Fase:** 1 — Confiabilidade e Segurança
**Data da execução:** 19 de outubro de 2026
**Classificação final:** **APROVADA COM RESSALVAS**
**Escopo:** código e migrations preparados localmente; validação somente com dados artificiais em PostgreSQL descartável em memória
**Produção:** não acessada e não modificada

## 1. Resumo executivo

A F1.03-R corrigiu o desenho monolítico reprovado na F1.03-M. A evolução foi dividida em três gates independentes: expansão aditiva versionada, aplicação compatível com os novos campos e contração futura fora do fluxo automático. A expansão mantém nullable os quatro campos novos de ownership, preservando as escritas da versão anterior enquanto a aplicação atualizada passa a preencher `perfis.id`.

Foi criada a relação 1:1 `responsavel_estudante`, com FKs, unicidades, singleton e proibição de autorrelacionamento. A autorização server-side deixou de descobrir uma estudante global e passou a resolver o vínculo pelo responsável autenticado. Ciclos, repertórios e revisões trimestrais passaram a gravar e consultar ownership explícito. O preflight agora rejeita cardinalidade parcial, colisão cruzada entre identidades de perfis diferentes, owners incompatíveis, órfãos, relações pai–filho incoerentes e duplicidades antes da DDL. A igualdade `perfis.id = auth_user_id` na mesma linha não foi tratada como erro por si só.

A cadeia exata `0000`–`0003` foi aplicada pelo migrador Drizzle em PGlite/PostgreSQL 18.6 em memória com pgvector 0.8.7 real. O tipo `vector(1536)` e o operador de distância foram exercitados sem substituição por texto. Inserts legados e atualizados, backfill repetível, constraints, sete cenários negativos, preservação de dados, rollback e dump/restore lógico passaram. TypeScript, 104 testes unitários, build, lint dirigido, `drizzle-kit check` e `git diff --check` também passaram.

A classificação contém ressalvas porque o banco não torna o papel de um perfil imutável apenas com FKs e porque o backup/restore JSON da interface continua sendo um P0 residual: inclui a linha completa de `perfis`, pode apagar dados em uma restauração parcial e não inclui os objetos do Storage. A contração continua bloqueada até backup nativo restaurável, auditoria/backfill no ambiente autorizado, testes no PostgreSQL-alvo e aprovação específica.

Nenhuma migration foi executada em produção, nenhum dado real foi lido, nenhum Supabase remoto foi acessado e nenhum commit, push ou deploy foi realizado.

## 2. Objetivo e critérios atendidos

| Critério | Resultado | Evidência |
|---|---|---|
| expansão funciona isoladamente | atendido | migrations `0000`–`0003` via migrador Drizzle |
| aplicação anterior escreve durante a expansão | atendido | inserts legados de ciclo, repertório e revisão trimestral |
| aplicação atualizada usa os novos campos | atendido | testes unitários e inserts SQL atualizados |
| vínculo 1:1 coerente | atendido com ressalva | FKs/unique/check + guards; papel não é imutável no banco |
| ownership | atendido | gravação, filtros, FK, backfill e cenários negativos |
| preservação de fixtures | atendido | contagens e IDs idênticos antes/depois da expansão |
| rollback operacional na expansão | atendido | colunas nullable mantêm contrato anterior |
| contração separada | atendido | proposta fora do journal e executada somente em banco de ensaio separado |
| migration versionada | atendido | SQL `0003`, snapshot e journal Drizzle consistentes |
| produção inalterada | atendido | runner em memória, sem URL externa ou dados reais |

## 3. Diagnóstico revisado e classificação dos problemas

| Prioridade | Problema reproduzido | Causa e arquivos afetados | Consequência | Correção/dependência | Teste de validação |
|---|---|---|---|---|---|
| P0 | restore JSON continua inseguro como recuperação operacional | `src/app/actions/backup.ts`; exporta `perfis` completo, aceita coleções ausentes como vazias e apaga/reinsere a base | exposição de hashes, perda de tabelas omitidas e restauração incompleta; Storage não é recuperado | F1.05: retirar restore da operação normal, remover hashes, exigir manifesto/versionamento/listas completas e reautenticação; F1.14 para backup integral | round-trip nativo em base temporária, manifesto completo, corrupção/omissão sem efeitos |
| P1 | proposta monolítica quebrava inserts e rollback operacional | antiga `F1_03_MIGRACAO_PROPOSTA.sql` aplicava `NOT NULL` imediatamente | ciclo, repertório, revisão trimestral e restore legado paravam de escrever | expansão nullable `0003`; contração independente | inserts legados passaram na expansão e falharam como esperado somente após contração |
| P1 | ownership inexistente em três raízes | `schema.ts`, `ciclo.ts`, `redacoes.ts`, `responsavel.ts`, `reestudo.ts` | consulta/mutação global e risco de associação ao perfil errado | colunas nullable, escrita com identidade autenticada, filtros pelo owner e backfill | testes unitários, SQL atualizado, owner inexistente rejeitado por FK |
| P1 | responsável era associado à única estudante global | `authorization.ts` não possuía relação persistida | autorização ambígua e incompatível com evolução segura | tabela singleton 1:1 e resolução pelo responsável autenticado | nenhum/mais de um vínculo nega; autorrelacionamento e segundo vínculo rejeitados |
| P1 | papéis podem ficar semanticamente incompatíveis após DDL | FK comprova existência, não o valor de `perfis.papel`; PostgreSQL não permite subquery em `CHECK` | alteração posterior de papel pode invalidar o sentido do vínculo/owner | guards server-side e preflight/contração; decidir garantia adicional versionada sem trigger improvisado | contração rejeitou vínculo com papéis invertidos; banco marcado explicitamente como não garantidor do papel |
| P1 | ausência de RLS versionada | migrations atuais não definem policies | guards da aplicação são a única barreira demonstrada | futura F1.04, somente depois do gate de backup | matriz real de acesso com roles sem bypass |
| P2 | drift entre Drizzle, SQL e aplicação | proposta F1.03 estava fora do journal e schema/actions ignoravam colunas | deploy parcial e catálogo incompatível | schema, snapshot, journal, migration e actions atualizados em conjunto | `drizzle-kit check`, migrador com quatro entradas e segunda execução idempotente |
| P2 | preflight antigo era incompleto/tardio | órfãos e duplicidades falhavam somente durante validação/contração | diagnóstico tardio e lock desnecessário | preflight ampliado antes da DDL | sete cenários negativos `P0001` e rollback atômico |
| P2 | pgvector não havia sido validado na F1.03-M | runtime anterior não possuía a extensão | cadeia histórica permanecia não comprovada | PGlite isolado com extensão pgvector real e versões fixadas | `vector` 0.8.7, coluna `vector(1536)` e operador `<->` aprovados |
| P2 | paridade com o PostgreSQL/Supabase alvo não foi demonstrada | o ensaio usa PostgreSQL WASM 18.6, não o servidor alvo | diferenças de versão/extensão/configuração podem surgir no cutover | repetir em clone descartável da versão alvo, sem dados reais, antes da aplicação | migrations, locks, dump/restore e plano de rollback no runtime-alvo |
| P3 | warnings de ferramentas | Vite avisa sobre carregamento futuro da config; Next.js avisa depreciação de `middleware` | manutenção futura, sem falha atual | tratar em tarefa de dependências/qualidade | build e testes continuam verdes após correção |

## 4. Solução e arquitetura resultante

O fluxo preparado é:

1. executar a expansão versionada somente após autorização e backup validado;
2. manter os novos owners nullable, permitindo rollback operacional para a aplicação anterior;
3. implantar a aplicação F1.03-R, que grava os owners e consulta o vínculo;
4. executar o backfill repetível, que aborta se houver ambiguidade ou owner divergente;
5. auditar cardinalidade, owners, FKs, relações pai–filho e duplicidades;
6. validar backup/restore nativo e rollback no ambiente-alvo;
7. somente com aprovação separada, transformar/aplicar a contração;
8. depois da contração, considerar F1.03-R a versão mínima da aplicação.

### 4.1 Identidade e autorização

- `perfis.id` permanece a identidade canônica de todas as FKs.
- `auth_user_id` não foi alterado nem usado como owner.
- `id = auth_user_id` na mesma linha é aceito; somente colisão cruzada entre perfis diferentes aborta.
- `requireManagedStudentProfile()` resolve `responsavel_estudante.responsavel_perfil_id = perfil autenticado` e exige exatamente um resultado de papel estudante.
- `requireStudentScope()` devolve a própria estudante autenticada ou, para o responsável, a estudante vinculada.
- nenhuma action nova aceita ID do cliente como prova de autorização.

### 4.2 Ownership no aplicativo

- ciclos ativos, criação e reset são escopados pela estudante vinculada;
- reestudo busca somente o ciclo ativo da estudante autenticada e atualiza a fila em transação;
- repertórios são inseridos e listados por `perfil_id` autenticado;
- revisões trimestrais gravam estudante-sujeito e responsável-autor e são filtradas por ambos;
- o seed local passou a criar o vínculo e preencher owners, mas não foi executado nesta tarefa.

## 5. Migrations e scripts preparados

### 5.1 Expansão automática versionada

- `drizzle/0003_f1_03_r_expansao.sql`;
- `drizzle/meta/0003_snapshot.json`;
- entrada `idx: 3` em `drizzle/meta/_journal.json`.

A expansão cria `responsavel_estudante`, adiciona quatro colunas nullable, executa backfill somente quando existe um par inequívoco, adiciona e valida dez FKs e não aplica `NOT NULL` nem as unicidades da contração.

### 5.2 Backfill controlado

`docs/modernizacao/sql/F1_03_R_BACKFILL_REPETIVEL.sql` não sobrescreve owner preenchido, aborta em cardinalidade/vínculo/identidade divergente e pode ser repetido sem mudar o resultado.

### 5.3 Contração deliberadamente fora do journal

`docs/modernizacao/propostas/F1_03_R_CONTRACAO_PROPOSTA.sql` permanece fora de `drizzle/` e não é aplicada pelo migrador. Ela propõe:

- quatro `NOT NULL`;
- PKs/uniques de associações e ordens;
- unique por período trimestral;
- unique parcial de um ciclo ativo por estudante.

Pré-condições obrigatórias: aplicação F1.03-R implantada, backfill/auditoria limpos, teste PostgreSQL-alvo aprovado, backup nativo restaurado, rollback ensaiado e autorização específica.

### 5.4 Rollback

- `F1_03_R_ROLLBACK_CONTRACAO.sql` desfaz somente `NOT NULL`, uniques e índice, retornando ao estado nullable da expansão;
- `F1_03_R_ROLLBACK_EXPANSAO.sql` remove FKs, colunas e vínculo, mas perde metadados novos e não remove a entrada do journal;
- depois de rollback físico da expansão, o migrador não reaplica `0003` automaticamente; a recuperação deve ser forward-only ou por backup consistente, nunca por remoção improvisada do journal;
- rollback operacional durante a expansão consiste em voltar o aplicativo e manter as colunas nullable;
- depois da contração, é obrigatório reverter primeiro a contração antes de usar a aplicação anterior.

Rollback operacional, rollback físico e restauração de backup não são equivalentes.

## 6. Backup e restore

A compatibilidade estrutural foi ampliada: o JSON agora inclui a tabela de vínculo, owners, associações que antes eram omitidas, metadados do acervo e gerações. O restore valida cardinalidade, vínculo autorizado, colisão cruzada, ownership e algumas relações transitivas antes da transação. A ordem de delete/insert foi atualizada para as FKs novas.

Isso **não torna o backup JSON um mecanismo seguro de recuperação**:

- a exportação de `perfis` ainda inclui `passwordHash`;
- coleções ausentes podem ser interpretadas como vazias e apagadas na restauração;
- objetos binários do Storage não são incluídos;
- não há manifesto de versão, hash, tamanho e completude;
- a operação continua disponível como Server Action destrutiva ao responsável autenticado;
- não existe promoção a partir de uma restauração validada em base temporária.

O `pgDump` exercitado no harness, por `pglite-tools`, produziu um dump SQL lógico e permitiu restore em outra instância em memória, preservando perfis, vínculo, tentativas, ciclos e pgvector. Isso não substitui `pg_dump`/`pg_restore` nativos, o backup do Storage nem um ensaio na versão PostgreSQL do ambiente-alvo.

## 7. Ambiente isolado e pgvector

| Item | Evidência |
|---|---|
| motor | PGlite, PostgreSQL 18.6 compilado para WASM |
| persistência | nenhuma; bancos exclusivamente em memória |
| pgvector | extensão real 0.8.7 |
| tipo | `vector(1536)` confirmado no catálogo |
| operação | distância vetorial retornou resultado esperado |
| dependências do ensaio | PGlite 0.5.10, pglite-pgvector 0.0.11, pglite-tools 0.4.10 e drizzle-orm 0.45.2 |
| instalação | somente em diretório `mktemp` fora do repositório; nada global |
| dados | fixtures artificiais `example.invalid`; `perfis.id != auth_user_id` |
| conexões | nenhuma leitura de `DATABASE_URL`, `.env`, Supabase ou banco local existente |
| limpeza | todas as instâncias fechadas e o diretório temporário exato removido |

PGlite executa o motor PostgreSQL e constraints reais, mas não é o servidor nativo do ambiente-alvo. A paridade final de versão, extensões, locks, privilégios e desempenho continua pendente.

## 8. Testes executados

### 8.1 Aplicação e estrutura

| Verificação | Resultado |
|---|---|
| `npx tsc --noEmit` | **PASSOU** |
| `npm run test:run` | **PASSOU** — 14 arquivos, 104/104 testes |
| `npm run build` | **PASSOU** — 17 rotas e middleware/proxy listados |
| lint de todos os TS/TSX alterados | **PASSOU** |
| `npx drizzle-kit check` | **PASSOU** |
| `git diff --check` | **PASSOU** |

Os testes Vitest são unitários com mocks de banco/sessão. Eles verificam guards, construção das queries, owners inseridos, escopo do ciclo, atomicidade lógica do reestudo e validação prévia do backup. Eles não são testes de integração PostgreSQL.

### 8.2 Integração PostgreSQL em memória

O runner `scripts/f1_03_r/run-pgvector-validation.mjs` passou com:

- cadeia histórica exata `0000`, `0001` e `0002`;
- cadeia versionada `0000`–`0003` aplicada pelo migrador Drizzle;
- quatro registros no journal e segunda execução idempotente;
- 32 tabelas públicas após as migrations históricas;
- expansão em base vazia e em base com fixtures;
- contagens e IDs preservados;
- vínculo correto criado e quatro colunas nullable;
- inserts legados e atualizados aceitos durante a expansão;
- backfill aprovado em duas execuções;
- FK de owner inexistente rejeitada (`23503`);
- autorrelacionamento rejeitado (`23514`);
- segundo vínculo rejeitado (`23514`);
- sete cenários negativos rejeitados com `P0001` e atomicidade;
- contração ensaiada separadamente;
- insert legado rejeitado depois da contração (`23502`);
- escrita F1.03-R aceita depois da contração;
- segundo ciclo ativo rejeitado (`23505`);
- rollback da contração retornando ao estado nullable;
- rollback físico da expansão preservando linhas anteriores;
- dump SQL e restore em nova instância com pgvector e ownership.

### 8.3 Testes não executados

- migration em produção ou Supabase remoto;
- consulta de dados históricos reais;
- migration em clone nativo da versão exata do PostgreSQL-alvo;
- `pg_dump`/`pg_restore` binários do ambiente-alvo e backup dos objetos do Storage;
- E2E do aplicativo contra PostgreSQL real sem mocks;
- contração fora do ensaio descartável;
- lint global do repositório, que possui dívida preexistente documentada; o lint dirigido exigido passou.

Avisos não bloqueantes: Vitest/Vite avisou sobre futura mudança do carregador de configuração; Next.js avisou que a convenção `middleware` está deprecated.

## 9. Arquivos criados e modificados na F1.03-R

### Migrations e schema

- `drizzle/0003_f1_03_r_expansao.sql`;
- `drizzle/meta/0003_snapshot.json`;
- `drizzle/meta/_journal.json`;
- `src/db/schema.ts`;
- `src/db/seed.ts`.

### Aplicação

- `src/lib/authorization.ts`;
- `src/app/actions/backup.ts`;
- `src/app/actions/ciclo.ts`;
- `src/app/actions/redacoes.ts`;
- `src/app/actions/reestudo.ts`;
- `src/app/actions/responsavel.ts`.

### Testes automatizados

- `src/lib/authorization.test.ts`;
- `src/app/actions/actions.test.ts`;
- `src/app/actions/backup.test.ts`;
- `src/app/actions/redacoes.test.ts`;
- `src/app/actions/reestudo.test.ts`;
- `src/app/actions/responsavel.test.ts`;
- `tests/integration/f1_03_r/legacy-writes.sql`;
- `tests/integration/f1_03_r/updated-writes.sql`;
- `scripts/f1_03_r/run-pgvector-validation.mjs`.

### Documentação e propostas

- `docs/modernizacao/sql/F1_03_R_BACKFILL_REPETIVEL.sql`;
- `docs/modernizacao/propostas/F1_03_R_CONTRACAO_PROPOSTA.sql`;
- `docs/modernizacao/propostas/F1_03_R_ROLLBACK_CONTRACAO.sql`;
- `docs/modernizacao/propostas/F1_03_R_ROLLBACK_EXPANSAO.sql`;
- `docs/modernizacao/PLANO_MODERNIZACAO.md`;
- `docs/modernizacao/RELATORIO_F1_03_R.md`.

O worktree já continha artefatos não commitados das F1.03 e F1.03-M, incluindo seus relatórios, proposta original, auditoria, fixtures e testes. Eles foram preservados e não são atribuídos à F1.03-R. A proposta monolítica original permanece apenas como registro histórico e não deve ser aplicada.

## 10. Riscos e pendências

1. **P0 — backup/restore JSON:** isolar a Server Action destrutiva, remover credenciais do export e exigir manifesto completo antes de qualquer uso real.
2. **P1 — RLS:** nenhuma policy foi implementada ou verificada nesta tarefa.
3. **P1 — integridade de papel:** uma alteração posterior em `perfis.papel` pode invalidar semanticamente vínculo e owners; hoje guards e preflights falham fechado nas operações cobertas.
4. **P1 — dados históricos:** o preflight deve ser executado em cópia autorizada antes de qualquer migration fora do ensaio.
5. **P2 — paridade do alvo:** repetir cadeia, backup e rollback na versão nativa do PostgreSQL/Supabase alvo.
6. **P2 — contração:** ainda é proposta, não migration automática; depende de gate explícito.
7. **P2 — cobertura:** actions foram verificadas com mocks e os contratos SQL no PostgreSQL; falta E2E de actions reais contra banco descartável.
8. **P2 — múltiplas famílias:** deliberadamente não suportadas; o singleton preserva apenas o modelo atual de duas contas.

## 11. Classificação final

**APROVADA COM RESSALVAS.**

A expansão está tecnicamente preparada e versionada, preserva a aplicação anterior, suporta a aplicação atualizada e passou no ambiente isolado com pgvector. Esta classificação **não autoriza** aplicação em produção, execução da contração ou uso de dados reais.

As ressalvas impeditivas para um cutover são: backup/restore operacional seguro, auditoria de dados históricos em cópia autorizada, ensaio no PostgreSQL-alvo e aprovação expressa da expansão. A contração exige uma segunda aprovação posterior.

## 12. Confirmações de encerramento

- nenhum ambiente de produção ou Supabase remoto foi acessado;
- nenhum banco local preexistente foi consultado ou modificado;
- nenhum dado real foi usado;
- nenhuma migration foi aplicada fora das instâncias descartáveis em memória;
- nenhuma dependência foi instalada globalmente ou adicionada ao projeto;
- o diretório temporário de dependências foi removido definitivamente;
- nenhum seed foi executado;
- nenhuma credencial real foi lida ou alterada;
- nenhum commit, push ou deploy foi realizado;
- a contração não foi adicionada ao journal nem executada automaticamente.

## 13. Próxima tarefa recomendada

**F1.05 — Isolamento imediato do backup/restore**, antes da contração e antes de iniciar a F1.04.

Escopo recomendado: desabilitar o restore destrutivo na operação normal, remover `passwordHash` do export, introduzir manifesto/versionamento/completude, exigir reautenticação e modo operacional, e testar restauração nativa em base temporária com os objetos do Storage. Depois desse gate, a expansão ainda dependerá de auditoria autorizada e aprovação própria.

Não iniciar automaticamente F1.04, F1.05 ou a contração.
