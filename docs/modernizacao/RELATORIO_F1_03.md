# Medicina 2029 — Relatório Técnico F1.03

**Tarefa:** F1.03 — Integridade dos Dados e Ownership
**Fase:** 1 — Confiabilidade e Segurança
**Data da execução:** 19 de outubro de 2026
**Estado:** análise e preparação concluídas; migrations não executadas
**Base de referência:** commits e documentação concluídos até a F1.02

## 1. Resumo executivo

A F1.03 confirmou que `perfis.id` é a identidade canônica efetivamente usada pelo NextAuth e por todas as chaves estrangeiras de usuário. `authUserId` é um UUID alternativo único, atualmente sem participação no login, na resolução da sessão ou nas relações de domínio. Nenhum ID existente foi alterado.

Foram inventariadas as 31 tabelas declaradas no Drizzle, suas 29 chaves primárias e 42 chaves estrangeiras. O schema possui apenas duas constraints `UNIQUE`, nenhuma `CHECK` e nenhum índice explícito além dos índices implícitos de PK/UNIQUE. A migration inicial ainda cria uma tabela `allowlist` e uma função fora do schema Drizzle; não existe trigger que aplique essa função.

O ownership é explícito para oito tabelas pessoais, para livros e para arquivos do acervo. Ele é herdado corretamente por revisões de cards, filhos de simulados e filhos de arquivos. Ciclos, repertórios e revisões trimestrais permanecem sem proprietário. Também não existe vínculo responsável–estudante: a F1.02 depende de existir exatamente uma estudante global e falha fechado quando essa cardinalidade não é atendida.

Foi recomendada uma relação mínima e estritamente 1:1, sem suporte a múltiplas famílias. Foi preparada, fora do journal automático do Drizzle, uma proposta aditiva de migration com preflight, backfill determinístico, validação e rollback operacional. Também foi criado um script histórico exclusivamente `READ ONLY`, com saída agregada e sem dados pessoais.

Nenhum banco foi acessado. O listener local encontrado usa o banco genérico `postgres` e não possui atestado suficiente de conteúdo e isolamento; por segurança, ele não foi utilizado. Assim, os testes PostgreSQL de integração e a execução da auditoria histórica permanecem pendentes. A migration proposta não está pronta para produção até passar por esse gate.

## 2. Escopo executado

- leitura integral de `src/db/schema.ts` e das migrations `0000`–`0002`;
- comparação com `ESPEC.md`, F1.01, plano de modernização e relatório F1.02;
- rastreamento de `perfis.id`, `authUserId`, `perfilId`, `enviadoPor` e `aprovadoPor`;
- classificação de ownership direto, herdado, global legítimo e ausente;
- identificação de FKs, PKs, uniques, checks e índices ausentes;
- avaliação do vínculo responsável–estudante para o modelo de duas contas;
- preparação de auditoria SQL histórica read-only;
- preparação de migration proposta e estratégia de rollback;
- testes unitários de metadados do schema, identidade e segurança do script;
- TypeScript, testes, build, lint dirigido e `git diff --check`.

Não houve consulta de dados, migration, seed, alteração de schema ativo, deploy, commit ou push.

## 3. Diagnóstico da identidade canônica

### 3.1 Fluxo efetivo

1. O Credentials Provider autentica por `perfis.email` e `passwordHash`.
2. O usuário retornado ao NextAuth recebe `id: perfil.id`.
3. O JWT e a sessão preservam esse `id`.
4. `requireAuthenticatedProfile()` reconsulta exclusivamente `perfis.id`.
5. Todas as FKs pessoais existentes apontam para `perfis.id`.

Portanto, **`perfis.id` é a identidade canônica interna**.

### 3.2 Papel atual de `authUserId`

`authUserId` é `NOT NULL` e `UNIQUE`, mas:

- não é usado no login atual;
- não é aceito como identidade de sessão;
- não é destino de nenhuma FK de domínio;
- não é usado pelas Server Actions;
- aparece apenas no schema, seed e testes históricos.

Ele deve ser tratado como identificador externo/legado reservado e imutável até que seja comprovado se algum serviço externo depende dele. Não deve ser igualado a `perfis.id`, usado em novas FKs ou removido sem auditoria específica.

Nesta tarefa, `authUserId` foi removido do objeto `AuthorizedProfile` e do `select` do helper, reduzindo a chance de uso acidental. A coluna e seus valores permaneceram intactos.

### 3.3 Risco histórico

Antes da F1.02, UUIDs fixados no seed como `authUserId` eram usados em runtime como `perfilId`. Se as FKs estavam presentes e validadas, inserts incorretos tenderiam a falhar e leituras retornariam vazio. Isso não prova que não existam dados históricos inconsistentes em outro ambiente, especialmente se constraints externas tiverem sido alteradas ou carregamentos administrativos tiverem contornado o modelo.

A conclusão depende da futura auditoria read-only em uma cópia autorizada. Nenhuma afirmação sobre dados reais foi feita.

## 4. Inventário integral do schema

| # | Tabela | PK | Relações principais | Ownership e diagnóstico |
|---:|---|---|---|---|
| 1 | `perfis` | `id` | `auth_user_id` e `email` únicos | identidade; não garante exatamente um perfil por papel |
| 2 | `disciplinas` | `id` | nenhuma FK | catálogo global legítimo |
| 3 | `topicos` | `id` | FK `disciplina_id` | catálogo global; `pre_requisito_topico_id` sem FK |
| 4 | `ciclos` | `id` | nenhuma FK | dado da estudante sem owner explícito |
| 5 | `ciclo_blocos` | `id` | FKs ciclo e disciplina | herda owner ausente; falta unique ciclo+ordem |
| 6 | `ciclo_estado` | `ciclo_id` | FK ciclo | owner herdado do ciclo |
| 7 | `sessoes` | `id` | FKs perfil, bloco e tópico | owner explícito; banco não garante coerência tópico/bloco |
| 8 | `materiais` | `id` | FKs tópico e aprovador | conteúdo global curado; aprovador é ator, não owner; fontes em JSON |
| 9 | `perguntas_ativas` | `id` | FK tópico | conteúdo global; fontes em JSON |
| 10 | `cards` | `id` | FKs perfil e tópico | owner explícito; origem/state sem checks |
| 11 | `card_revisoes` | `id` | FK card | owner herdado; rating/state sem checks |
| 12 | `questoes` | `id` | FK disciplina | global; `arquivo_origem_id` sem FK; fontes em JSON |
| 13 | `questao_topicos` | nenhuma | FKs questão e tópico | associação sem PK/unique; aceita duplicatas |
| 14 | `tentativas` | `id` | FKs perfil, questão e sessão | owner explícito; `simulado_id` sem FK; owner pode divergir do pai |
| 15 | `erros` | `id` | FKs perfil, questão, tentativa, disciplina e tópico | owner explícito; campos redundantes podem divergir |
| 16 | `generos` | `id` | nenhuma FK | catálogo global legítimo |
| 17 | `redacoes` | `id` | FKs perfil e gênero | owner explícito; `reescrita_de_id` sem FK |
| 18 | `repertorios` | `id` | nenhuma FK | dado pessoal sem owner explícito |
| 19 | `simulados` | `id` | FK perfil | owner explícito |
| 20 | `simulado_questoes` | nenhuma | FKs simulado e questão | owner herdado; sem PK/unique |
| 21 | `simulado_areas` | `id` | FK simulado | owner herdado; falta unique simulado+área |
| 22 | `simulado_analise` | `id` | FK simulado | owner herdado; não limita uma análise por simulado |
| 23 | `checkins` | `id` | FK perfil | owner explícito; faltam checks e regra por dia |
| 24 | `revisoes_trimestrais` | `id` | nenhuma FK | dado sensível da estudante, escrito pelo responsável, sem sujeito/ator |
| 25 | `livros` | `id` | FK perfil | owner explícito |
| 26 | `acervo_arquivos` | `id` | FKs disciplina e `enviado_por` | responsável funciona como owner operacional no modelo atual |
| 27 | `acervo_paginas` | `id` | FK arquivo | owner herdado; falta unique arquivo+página |
| 28 | `acervo_chunks` | `id` | FKs arquivo e tópico opcional | owner herdado; falta unique arquivo+ordem/check de páginas |
| 29 | `acervo_figuras` | `id` | FKs arquivo e chunk opcional | owner herdado; não garante mesmo arquivo do chunk |
| 30 | `geracoes` | `id` | FK tópico; arquivos/chunks em JSON | pipeline global; proveniência sem integridade relacional |
| 31 | `curadoria_fila` | `id` | FK tópico | fila global; artefato polimórfico sem FK; sem revisor explícito |

### 4.1 Resumo quantitativo

- 31 tabelas no schema Drizzle;
- 29 chaves primárias;
- 42 chaves estrangeiras;
- 2 constraints `UNIQUE` declaradas (`perfis.auth_user_id` e `perfis.email`);
- 0 constraints `CHECK`;
- 0 índices explícitos;
- todas as FKs existentes usam `NO ACTION` para update/delete;
- `allowlist` adicional existe somente na migration SQL.

## 5. Ownership

### 5.1 Ownership direto e válido

Usam `perfil_id -> perfis.id` obrigatório:

- `sessoes`;
- `cards`;
- `tentativas`;
- `erros`;
- `redacoes`;
- `simulados`;
- `checkins`;
- `livros`.

`acervo_arquivos.enviado_por -> perfis.id` identifica o responsável que enviou o arquivo e é usado como owner operacional pela F1.02. `materiais.aprovado_por` registra o ator da aprovação, não um proprietário.

### 5.2 Ownership herdado

- `card_revisoes` herda de `cards`;
- `simulado_questoes`, `simulado_areas` e `simulado_analise` herdam de `simulados`;
- `acervo_paginas`, `acervo_chunks` e `acervo_figuras` herdam de `acervo_arquivos`;
- `ciclo_blocos` e `ciclo_estado` deveriam herdar de `ciclos`, mas a raiz não possui owner.

Não se recomenda duplicar `perfil_id` nos filhos quando a FK ao pai oferece uma cadeia inequívoca. A exceção são relações que precisam garantir o mesmo owner por FK composta, como tentativa–sessão.

### 5.3 Globais legítimas

- taxonomia curricular: `disciplinas`, `topicos` e `generos`;
- conteúdo curricular curado: `materiais`, `perguntas_ativas`, `questoes` e `questao_topicos`;
- pipeline/curadoria no modelo atual: `geracoes` e `curadoria_fila`.

Essas tabelas ainda precisam de RLS, estados de publicação, autoria/proveniência e constraints, mas não necessariamente de um owner estudante.

### 5.4 Lacunas de ownership

#### Ciclos

O ciclo pertence à estudante segundo a ESPEC, porém é global. `ciclo_blocos`, `ciclo_estado` e `reestudo` não podem ser isolados por perfil. Recomenda-se `ciclos.estudante_perfil_id NOT NULL` e ownership herdado pelos filhos.

#### Repertórios

A interface chama o conjunto de “sua base”, mas a tabela é global. Recomenda-se `repertorios.perfil_id NOT NULL` e filtro/insert pela estudante autenticada.

#### Revisões trimestrais

Contêm métricas e conversa da estudante, mas não identificam sujeito nem autor. Recomenda-se:

- `estudante_perfil_id NOT NULL` como sujeito;
- `registrada_por_perfil_id NOT NULL` como responsável autor;
- unique `(estudante_perfil_id, ano, trimestre)`.

## 6. Relação responsável–estudante

### 6.1 Estado atual

`requireManagedStudentProfile()` exige responsável e busca a única estudante global. A operação falha fechado se encontrar zero ou mais de uma. Isso é seguro para a cardinalidade atual, mas não prova um vínculo de autorização entre as duas pessoas.

### 6.2 Recomendação

Criar uma tabela estreita `responsavel_estudante` com:

- `vinculo_id` fixo em 1 como PK/check singleton;
- `responsavel_perfil_id` como FK única e obrigatória;
- `estudante_perfil_id` como FK única e obrigatória;
- check impedindo o mesmo ID nos dois lados;
- `criado_em`;
- uma única linha criada somente após o preflight confirmar exatamente um perfil de cada papel.

As constraints únicas dos dois lados preservam estritamente o modelo 1:1. Isso não implementa múltiplas famílias nem muda a autenticação.

O papel das pontas não pode ser garantido por um `CHECK` simples, porque PostgreSQL não permite subquery nessa constraint. A migration deve validar os papéis no preflight e a aplicação deve continuar revalidando-os. Um trigger de enforcement pode ser proposto separadamente se a garantia no banco for exigida.

### 6.3 Impacto futuro nas actions

Depois da migration aprovada:

- `requireManagedStudentProfile()` deve resolver por `responsavel_perfil_id = perfil autenticado`;
- painel do responsável, lacunas e criação de cards devem usar o vínculo;
- ciclos e repertórios devem ser filtrados pelo owner;
- revisões trimestrais devem gravar sujeito e autor;
- a interface pública das actions pode permanecer igual.

## 7. Relacionamentos e constraints ausentes

### 7.1 FKs diretas prioritárias

| Coluna atual | FK recomendada | Política proposta |
|---|---|---|
| `topicos.pre_requisito_topico_id` | `topicos.id` | `ON DELETE SET NULL` |
| `questoes.arquivo_origem_id` | `acervo_arquivos.id` | `ON DELETE SET NULL` |
| `tentativas.simulado_id` | `simulados.id` | `ON DELETE RESTRICT` |
| `redacoes.reescrita_de_id` | `redacoes.id` | `ON DELETE SET NULL` |

### 7.2 Unicidades prioritárias

- PK `(questao_id, topico_id)` em `questao_topicos`;
- PK `(simulado_id, questao_id)` e unique `(simulado_id, ordem)` em `simulado_questoes`;
- unique `(ciclo_id, ordem)` em `ciclo_blocos`;
- unique `(simulado_id, area)` em `simulado_areas`;
- unique `simulado_id` em `simulado_analise`;
- unique `(arquivo_id, numero)` em `acervo_paginas`;
- unique `(arquivo_id, ordem)` em `acervo_chunks`;
- unique parcial para um ciclo ativo por estudante;
- unique `(estudante_perfil_id, ano, trimestre)` em revisões trimestrais.

### 7.3 Consistência de owner

O banco atualmente permite:

- `tentativas.perfil_id` diferente do owner da sessão ou simulado;
- `erros.perfil_id` diferente do owner da tentativa;
- erro apontando questão diferente da tentativa;
- reescrita pertencente a perfil diferente;
- figura apontando chunk de outro arquivo.

Após auditoria, uma etapa posterior pode adicionar chaves compostas `(id, perfil_id)` nos pais e FKs compostas nos filhos. Essa parte não foi incluída automaticamente porque exige avaliar redundância, índices e dados existentes.

### 7.4 Checks recomendados

- série prevista e incidências dentro das faixas da ESPEC;
- humor e energia entre 1 e 5;
- tempos, contagens, notas e percentuais não negativos e dentro de limites;
- `pagina_inicial <= pagina_final`;
- ratings e states FSRS dentro do domínio;
- `acertos <= total` e `total > 0`;
- datas finais não anteriores às datas iniciais;
- redação não reescrever a si própria.

## 8. Divergências schema, migrations e ESPEC

1. `allowlist` e `check_allowlist()` existem somente na migration inicial, fora do schema/snapshots; nenhum trigger chama a função.
2. A autenticação NextAuth atual consulta diretamente `perfis.email`, sem usar a tabela `allowlist`.
3. A ESPEC exige RLS em todas as tabelas, mas não há policies versionadas nas migrations.
4. Timestamps usam `timestamp without time zone`, enquanto a ESPEC exige UTC no banco.
5. A rastreabilidade de fontes usa arrays JSON de UUIDs sem FKs.
6. A ESPEC dá autonomia do ciclo à estudante, mas o ciclo é global e suas mutações administrativas continuam com o responsável por compatibilidade da UI atual.
7. `simulado_areas.nota_estimated` diverge do nome `nota_estimada` da ESPEC.
8. `perfis.email` e `password_hash` são nullable apesar de o login Credentials depender dos dois; unique de e-mail é case-sensitive e permite múltiplos `NULL`.
9. O banco não garante que owners pessoais tenham papel estudante ou que remetente/aprovador tenha papel responsável; hoje essa garantia está na F1.02.

Ausência de configuração no repositório não foi tratada como prova de ausência em serviços externos.

## 9. Auditoria histórica preparada

Arquivo: `docs/modernizacao/sql/F1_03_AUDITORIA_READONLY.sql`.

Características:

- inicia transação `REPEATABLE READ READ ONLY`;
- aplica timeouts locais;
- confirma o estado `transaction_read_only`;
- retorna somente contagens agregadas;
- não mostra UUIDs, nomes, e-mails ou conteúdo;
- termina em `ROLLBACK`;
- não contém `INSERT`, `UPDATE`, `DELETE`, DDL ou chamadas procedurais.

Verificações incluídas:

- cardinalidade por papel e colisões `id`/`auth_user_id`;
- e-mails duplicados sem diferenciar maiúsculas/minúsculas;
- constraints não validadas;
- owners órfãos ou que casam somente `auth_user_id`;
- owners com papel incoerente;
- órfãos nas quatro FKs ausentes;
- divergências owner entre tentativa, sessão, simulado e erro;
- coerência de reescritas, tópicos/blocos e figura/chunk;
- duplicidades relevantes;
- volume a receber backfill;
- forma e referências de arrays JSON de chunks.

O script **não foi executado**. Ele deve ser usado primeiro em PostgreSQL descartável dedicado e depois, mediante autorização própria, em uma cópia read-only de dados reais.

## 10. Migration proposta

Arquivo: `docs/modernizacao/propostas/F1_03_MIGRACAO_PROPOSTA.sql`.

O arquivo está deliberadamente fora de `drizzle/` e de `_journal.json`, portanto `drizzle-kit migrate` não o aplica.

### 10.1 Fases

1. **Preflight:** exige exatamente uma estudante e um responsável, ausência de colisão cruzada de identidade e ausência das duplicidades que bloqueariam constraints.
2. **Expansão:** cria o vínculo 1:1 e adiciona colunas nullable de ownership.
3. **Backfill:** usa os dois perfis únicos; aborta em qualquer cardinalidade diferente.
4. **FKs:** adiciona as quatro relações ausentes como `NOT VALID`.
5. **Validação:** valida todas as FKs antes de contrair.
6. **Contração:** aplica `NOT NULL`, PKs/uniques e índice parcial do ciclo ativo.

### 10.2 Pré-condições obrigatórias

- backup validado e janela aprovada;
- PostgreSQL descartável dedicado para primeiro ensaio;
- migrations atuais aplicadas em base vazia;
- fixtures inteiramente fictícias com `perfis.id != authUserId`;
- auditoria read-only sem órfãos, ambiguidades ou duplicidades;
- versão da aplicação compatível com colunas novas;
- plano de rollback ensaiado.

### 10.3 Preservação e rollback

Nenhum ID existente é alterado. A expansão adiciona metadados e relações. O rollback preferencial é operacional: reverter primeiro a aplicação e manter tabela/colunas aditivas sem uso, evitando perda de informação nova.

Rollback físico somente pode ocorrer após exportar os vínculos/owners, comprovar que nenhuma escrita depende deles e obter autorização explícita. A remoção ocorre na ordem inversa: índices/uniques, FKs, colunas e tabela de vínculo. `perfis.id` e `auth_user_id` nunca são alterados.

### 10.4 Estado de prontidão

A proposta passou por revisão estática, mas **não foi executada nem validada em PostgreSQL**. Ela não deve ser transformada em migration ativa ou aplicada em qualquer ambiente compartilhado antes do teste de integração isolado.

## 11. Testes e validações

| Verificação | Resultado |
|---|---|
| `npx eslint src/db/integrity.test.ts src/lib/authorization.ts src/lib/authorization.test.ts` | **PASSOU** |
| `npm run test:run` | **PASSOU** — 13 arquivos, 77/77 testes |
| `npx tsc --noEmit` | **PASSOU** |
| `npm run build` | **PASSOU** — aviso preexistente de depreciação de `middleware` |
| `git diff --check` | **PASSOU** |
| `npm run lint` | **FALHOU** — 172 ocorrências: 126 erros e 46 avisos preexistentes |
| Auditoria SQL histórica | **NÃO EXECUTADA** — sem banco descartável dedicado atestado |
| Migration proposta | **NÃO EXECUTADA** — proposta fora do journal |
| Integração PostgreSQL | **NÃO EXECUTADA** — ambiente seguro indisponível |
| Playwright | **NÃO EXECUTADO** — casos existentes são placeholders |

### 11.1 Cobertura nova

Seis testes estruturais verificam:

- owners obrigatórios e FKs para `perfis.id`;
- inexistência de FK para `authUserId`;
- cadeias de ownership herdado;
- lacunas de ownership que dependem da migration;
- ausência de comandos mutáveis no script histórico;
- proposta F1.03 fora do journal automático.

O teste de autorização foi ampliado para confirmar que o contexto autorizado não seleciona `authUserId`. Todos são testes unitários ou estáticos; eles não substituem integração PostgreSQL.

## 12. Problemas encontrados e classificação

### P1 — Alto

- ausência de vínculo explícito responsável–estudante;
- ciclos, repertórios e revisões trimestrais sem ownership;
- cadastro manual de erro ainda usa IDs fictícios e tende a falhar sob FKs normais;
- restore administrativo pode importar combinações de owner/papel inválidas;
- RLS não versionada mantém a aplicação como única barreira demonstrada.

### P2 — Médio

- quatro relações UUID sem FK;
- inconsistência transitiva de owner permitida pelo banco;
- associações e entidades 1:1 sem PK/unique adequadas;
- ausência de checks de domínio;
- rastreabilidade em JSON sem integridade referencial;
- risco histórico de UUID externo usado como interno, ainda não medido;
- falta de índices explícitos para FKs e predicados de owner.

### P3 — Baixo

- drift entre schema e migration da allowlist;
- nome físico `nota_estimated` divergente;
- timestamps sem timezone explícito;
- `authUserId` permanece como coluna legada/reservada sem contrato documentado fora deste relatório.

## 13. Riscos remanescentes

- O histórico real não foi auditado.
- A proposta pode encontrar dados ambíguos e deve abortar, não escolher owners automaticamente.
- Relações polimórficas e arrays JSON continuam sem FK.
- O papel correto de cada owner ainda não é garantido por constraint no banco.
- A proposta 1:1 precisa de decisão posterior se o sistema deixar de ter exatamente duas contas.
- RLS e views agregadas continuam pendentes para a F1.04.
- Backup/restore, atomicidade, validação runtime e Storage mantêm os riscos das tarefas futuras.

## 14. Arquivos criados e modificados

### Criados

- `docs/modernizacao/RELATORIO_F1_03.md`
- `docs/modernizacao/sql/F1_03_AUDITORIA_READONLY.sql`
- `docs/modernizacao/propostas/F1_03_MIGRACAO_PROPOSTA.sql`
- `src/db/integrity.test.ts`

### Modificados

- `docs/modernizacao/PLANO_MODERNIZACAO.md`
- `src/lib/authorization.ts`
- `src/lib/authorization.test.ts`

Não foram modificados `src/db/schema.ts`, migrations ativas, Server Actions, interfaces ou configurações de produção.

## 15. Pendências

1. Provisionar PostgreSQL descartável dedicado com nome e credencial próprios de teste.
2. Aplicar migrations atuais e fixtures fictícias, sem usar o seed destrutivo.
3. Executar a auditoria read-only e exigir zero achados impeditivos.
4. Ensaiar forward e rollback da proposta em transações controladas.
5. Atualizar schema Drizzle e actions somente após aprovação da modelagem.
6. Auditar uma cópia autorizada do histórico antes de qualquer backfill real.
7. Corrigir o registro manual de erros sem IDs fictícios.
8. Decidir a política versionada da allowlist e eliminar o drift.

## 16. Confirmações de integridade da tarefa

- Nenhum banco foi acessado.
- Nenhum dado real foi lido, modificado ou apagado.
- Nenhuma migration foi executada.
- Nenhum seed foi executado.
- Nenhuma credencial ou variável de ambiente foi alterada.
- Nenhuma dependência foi instalada.
- Nenhuma interface foi modificada.
- Nenhum deploy foi realizado.
- Nenhum commit ou push foi realizado.
- Nenhum segredo ou dado pessoal é reproduzido neste relatório.

## 17. Próxima tarefa recomendada

Antes da F1.04, recomenda-se uma autorização intermediária **F1.03-M — Validação Isolada da Migration**:

1. criar PostgreSQL descartável dedicado;
2. validar migrations atuais, auditoria, proposta e rollback com fixtures fictícias;
3. revisar o resultado e decidir a migration Drizzle definitiva;
4. somente então considerar aplicação em ambiente autorizado.

Após esse gate, a próxima tarefa numerada é **F1.04 — RLS e views agregadas versionadas**. Esta tarefa não foi iniciada.
