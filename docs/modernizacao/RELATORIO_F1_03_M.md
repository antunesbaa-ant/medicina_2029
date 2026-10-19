# Medicina 2029 — Relatório Técnico F1.03-M

**Tarefa:** F1.03-M — Validação Isolada da Migração
**Fase:** 1 — Confiabilidade e Segurança
**Data da execução:** 19 de outubro de 2026
**Horário de encerramento:** 06:30 (-03)
**Classificação final:** **REPROVADA**
**Escopo:** ambiente local descartável, dados exclusivamente artificiais e nenhuma conexão com produção

## 1. Resumo executivo

A proposta `docs/modernizacao/propostas/F1_03_MIGRACAO_PROPOSTA.sql` foi exercitada em PostgreSQL 18.4 real, dentro de um cluster efêmero criado exclusivamente para a F1.03-M. O servidor escutou somente em `127.0.0.1`, usou banco, usuário, porta, credenciais e diretório de dados exclusivos, não leu `DATABASE_URL` e não acessou `.env`, Supabase, a porta local preexistente 54322 ou qualquer dado real.

A cadeia histórica exata não pôde ser completada: `drizzle/0000_greedy_loki.sql` falhou no primeiro comando com `extension "vector" is not available`. O runtime isolado não contém `pgvector`, Docker/Podman não estão disponíveis e não foram instaladas dependências no sistema. A falha foi registrada; `0001` e `0002` não foram declaradas como validadas na cadeia fiel.

Para não interromper a investigação das partes independentes de vetores, foi criada apenas em memória uma estrutura de ensaio na qual `CREATE EXTENSION vector` foi removido e a única coluna `vector(1536)` foi substituída por `text`. Todas as demais instruções das migrations `0000`–`0002` foram executadas sem modificação. Esse ensaio usou PostgreSQL real, mas **não equivale à validação fiel das migrations históricas nem valida pgvector**.

Sobre essa estrutura, o SQL original da proposta concluiu. Preservou todos os IDs e contagens das fixtures, criou uma relação 1:1, realizou os backfills de ownership e terminou sem FK não validada. FKs inválidas e unicidades foram realmente rejeitadas pelo PostgreSQL. O rollback físico de teste preservou as linhas anteriores e permitiu reaplicar a proposta.

Apesar disso, a proposta está **REPROVADA** porque a contração `NOT NULL` é incompatível com o aplicativo atual: inserts no formato usado pelas actions e pelo restore falharam para ciclos, repertórios e revisões trimestrais. O banco também aceitou `perfis.id = auth_user_id`, owner com papel incompatível e inversão estudante/responsável no vínculo. O rollback operacional descrito na proposta não funciona depois da contração.

Nenhuma migration foi aplicada fora do cluster descartável. O cluster foi encerrado e seu diretório temporário exclusivo foi removido ao final.

## 2. Ambiente de testes utilizado

| Item | Valor verificado |
|---|---|
| Mecanismo | `embedded-postgres` 18.4.0-beta.17 já disponível localmente |
| Servidor | PostgreSQL 18.4 arm64 |
| Endereço | `127.0.0.1` |
| Porta | 55439, confirmada livre antes do início |
| Banco | `medicina_2029_f103m_validation` |
| Usuário | usuário exclusivo de teste F1.03-M |
| Credencial | temporária e exclusiva de teste; valor não registrado neste relatório |
| Diretório de dados | diretório `mktemp` exclusivo sob `/tmp` |
| Persistência | `persistent: false` |
| Cliente | `pg` do próprio runtime isolado |
| Docker/Podman | indisponíveis |
| `psql`, `pg_dump`, `pg_restore` | indisponíveis no runtime |
| pgvector | indisponível |

### 2.1 Recursos identificados antes da execução

- runtime PostgreSQL local reutilizado somente como conjunto de executáveis;
- nenhum diretório de dados preexistente foi reutilizado;
- portas 55439–55441 estavam livres na inspeção;
- o PostgreSQL local preexistente na porta 54322 não foi consultado nem alterado;
- Docker, Podman, Postgres.app, `psql`, `pg_config` e Homebrew não estavam disponíveis;
- não havia `vector.control`, SQL da extensão ou biblioteca pgvector no runtime.

## 3. Garantias de isolamento

O runner `scripts/f1_03_m/run-isolated-validation.mjs` impôs as seguintes garantias:

1. escolheu porta livre em um intervalo reservado para a tarefa;
2. criou diretório de dados e socket próprios em um caminho aleatório de `/tmp`;
3. iniciou o servidor vinculado a `127.0.0.1`;
4. criou banco e usuário nomeados exclusivamente para a F1.03-M;
5. usou credencial artificial declarada no próprio runner, sem consultar variáveis reais;
6. não utilizou `DATABASE_URL`, `.env`, Supabase ou qualquer endpoint remoto;
7. executou resets destrutivos apenas no schema `public` do banco recém-criado pela tarefa;
8. encerrou o cluster com `persistent: false`;
9. removeu somente o diretório temporário exato criado pela execução.

A consulta de identificação retornou o banco esperado, o usuário de teste, servidor `127.0.0.1/32` e PostgreSQL 18.4. Não houve dado real no ambiente.

## 4. Migrations executadas

### 4.1 Cadeia histórica exata

| Migration | Resultado |
|---|---|
| `0000_greedy_loki.sql` | **reprovada no ambiente**: código PostgreSQL `0A000`, extensão `vector` indisponível |
| `0001_dry_talos.sql` | não executada na cadeia fiel, pois `0000` falhou primeiro |
| `0002_little_swarm.sql` | não executada na cadeia fiel, pois `0000` falhou primeiro |

Conclusão: as migrations históricas **não foram integralmente validadas** neste ambiente. A dependência de pgvector é explícita e deve estar presente no próximo ambiente descartável.

### 4.2 Estrutura adaptada exclusivamente para investigação

A cópia temporária da `0000` recebeu exatamente duas adaptações em memória:

- remoção de `CREATE EXTENSION IF NOT EXISTS vector`;
- substituição da única ocorrência `vector(1536)` por `text`.

As migrations `0001` e `0002` foram executadas sem alteração. O catálogo resultante continha:

- 32 tabelas públicas: 31 tabelas do aplicativo e `allowlist`;
- duas linhas fictícias/legadas na `allowlist`, conforme a migration;
- uma função `check_allowlist()`;
- zero triggers de usuário em `perfis`, confirmando que a função de allowlist não é aplicada por trigger.

Essa adaptação não foi salva como migration e não alterou o repositório histórico.

## 5. Fixtures utilizadas

O arquivo `tests/integration/f1_03_m/fixtures.sql` contém somente dados artificiais sob o domínio reservado `example.invalid`. Ele cria:

- uma estudante fictícia;
- um responsável fictício;
- dois tópicos e uma disciplina;
- ciclo, bloco e estado do ciclo;
- sessão de estudo;
- flashcard e revisão;
- arquivo, página e chunk do acervo;
- questão e associação com tópico;
- simulado, questão, área e análise;
- tentativa e registro de erro;
- gênero, redação original e reescrita;
- repertório;
- revisão trimestral;
- check-in e livro.

Os dois perfis usam UUIDs internos deliberadamente diferentes de seus `auth_user_id`. Uma asserção real confirmou zero linhas com `perfis.id = perfis.auth_user_id` na fixture limpa. Nenhum seed de produção foi executado.

## 6. Resultados da auditoria read-only

`docs/modernizacao/sql/F1_03_AUDITORIA_READONLY.sql` foi executado no PostgreSQL descartável.

### 6.1 Fixture íntegra

- execução concluída em transação `READ ONLY`;
- contagens de todas as tabelas verificadas permaneceram idênticas antes e depois;
- identidades internas iguais às externas: 0;
- `questoes.arquivo_origem_id` órfão: 0;
- card com papel de owner incorreto: 0.

### 6.2 Inconsistências controladas

Em uma reconstrução independente do schema descartável, foram adicionados:

- um card pertencente ao perfil responsável;
- uma questão com `arquivo_origem_id` inexistente, coluna ainda sem FK no schema atual.

O script foi executado novamente e as consultas correspondentes identificaram exatamente:

- um owner com papel incorreto;
- uma referência órfã.

O teste comprova que as verificações relevantes detectam esses problemas artificiais. Não comprova nada sobre dados históricos reais, que não foram acessados.

### 6.3 Limitações do script

- ele foi desenhado para o schema anterior à proposta; sua seção de ownership não deve ser usada como auditoria pós-migração;
- a consulta de localidade informa o resultado, mas não aborta por si só em host inadequado;
- não valida a allowlist, sua função ou a ausência do trigger;
- não cobre todos os arrays JSON de proveniência e a relação polimórfica da curadoria;
- cenários com zero inconsistências podem não produzir uma linha em algumas seções, exigindo normalização no harness.

## 7. Resultados da migração proposta

O arquivo original `docs/modernizacao/propostas/F1_03_MIGRACAO_PROPOSTA.sql`, sem alteração, foi executado no PostgreSQL 18.4 sobre a estrutura adaptada.

### 7.1 Itens aprovados tecnicamente no ensaio

- o SQL original concluiu no PostgreSQL 18.4;
- `responsavel_estudante` foi criado com uma linha 1:1;
- ciclos, repertórios e revisões trimestrais receberam owner por backfill;
- nenhuma nova coluna de owner permaneceu nula;
- nenhuma FK pública terminou como `NOT VALID`;
- as contagens de todas as 26 tabelas que receberam fixtures foram preservadas;
- `perfis.id` e `auth_user_id` permaneceram inalterados;
- FK inválida em `tentativas.simulado_id` foi rejeitada com código `23503`;
- duplicidade trimestral foi rejeitada com código `23505`;
- as transações com falhas de preflight/constraint reverteram a criação da tabela de vínculo.

A hipótese estática de que `NOT VALID` inline impediria a criação da tabela **não se confirmou** no PostgreSQL 18.4: o SQL original foi aceito. Ainda é necessário confirmar a versão PostgreSQL do futuro ambiente-alvo.

### 7.2 Bloqueios encontrados

#### P1 — Contração incompatível com as escritas atuais

Após a proposta, inserts no formato atual falharam com `23502`:

- ciclo sem `estudante_perfil_id`;
- repertório sem `perfil_id`;
- revisão trimestral sem `estudante_perfil_id` e `registrada_por_perfil_id`.

Esse é exatamente o formato ainda usado em:

- `src/app/actions/ciclo.ts`;
- `src/app/actions/redacoes.ts`;
- `src/app/actions/responsavel.ts`;
- `src/app/actions/backup.ts` durante restore.

A migration monolítica quebraria funcionalidades essenciais imediatamente.

#### P1 — Rollback operacional inválido

Voltar a aplicação para a versão anterior mantendo as colunas novas como `NOT NULL` não recupera a operação: os inserts antigos continuam falhando. O comentário de rollback operacional da proposta é insuficiente depois da contração.

#### P1 — Papéis e ownership sem garantia semântica no banco

O PostgreSQL aceitou:

- atualização do vínculo com estudante e responsável invertidos;
- dado de estudante cujo owner é um perfil de papel responsável;
- perfil com `id = auth_user_id` na mesma linha.

As FKs garantem existência do perfil, não o papel correto. A proposta também não impede mudança posterior de `perfis.papel` que invalide semanticamente o vínculo.

#### P2 — Preflight incompleto ou tardio

- órfão em relação nova foi rejeitado apenas durante a validação da FK;
- dois ciclos ativos foram rejeitados apenas na criação do índice parcial;
- owner com papel errado não foi rejeitado;
- `id = auth_user_id` não foi rejeitado;
- inconsistências transitivas entre owners de pai/filho não fazem parte do preflight.

As falhas tardias ainda foram atômicas no ensaio, mas produzem diagnóstico menos controlado.

#### P2 — Drift com Drizzle e aplicação

`src/db/schema.ts`, o journal Drizzle, as actions e o contrato de backup ainda não representam a tabela, as colunas e as constraints propostas. Executar o SQL isoladamente deixaria código e catálogo divergentes.

## 8. Testes negativos

| Cenário | Resultado observado | Avaliação |
|---|---|---|
| nenhuma estudante | preflight rejeitou; transação revertida | aprovado |
| mais de uma estudante | preflight rejeitou; transação revertida | aprovado |
| nenhum responsável | preflight rejeitou; transação revertida | aprovado |
| mais de um responsável | preflight rejeitou; transação revertida | aprovado |
| colisão cruzada entre `id` e `auth_user_id` | preflight rejeitou | aprovado |
| relação órfã em FK proposta | FK rejeitou; transação revertida | aprovado, mas tardio |
| duplicidade incompatível com unique | preflight rejeitou | aprovado |
| mais de um ciclo ativo | índice rejeitou; transação revertida | aprovado, mas tardio |
| `id = auth_user_id` na mesma linha | migration concluiu | **reprovado** |
| owner com papel incompatível | migration concluiu | **reprovado** |
| vínculo com papéis invertidos | banco aceitou atualização | **reprovado** |
| FK de simulado inexistente após migration | banco rejeitou | aprovado |
| período trimestral duplicado após migration | banco rejeitou | aprovado |
| inserts da aplicação anterior | banco rejeitou | **reprovado por incompatibilidade** |

Oito cenários de rejeição esperada foram aprovados com rollback atômico. Três regras semânticas foram aceitas indevidamente, e a compatibilidade de escrita da aplicação anterior falhou.

## 9. Resultados do rollback

### A. Rollback operacional da aplicação

Foi testado por sondas equivalentes aos inserts da versão atual. Resultado: **incompatível** após `SET NOT NULL`. Um simples rollback do código não restaura a capacidade de escrita.

Estratégia necessária:

1. migration de expansão com colunas nullable e FKs;
2. aplicação compatível escrevendo os novos owners;
3. backfill e validação;
4. migration de contração posterior com `NOT NULL`.

Durante a expansão nullable, a versão anterior pode continuar escrevendo; depois da contração, não.

### B. Rollback físico do schema

O arquivo `tests/integration/f1_03_m/rollback_fisico.sql` foi executado somente no cluster descartável. Ele removeu, em ordem inversa:

- índice parcial e uniques/PKs novos;
- quatro FKs relacionais;
- FKs de ownership;
- quatro colunas de ownership;
- tabela `responsavel_estudante`.

Resultados:

- contagens das 26 tabelas com fixture preservadas;
- IDs dos perfis preservados;
- tabela e colunas novas removidas;
- proposta reaplicada com sucesso após o rollback, comprovando reconstrução.

Esse rollback perde os metadados de ownership criados após uma futura implantação e, portanto, exige export/backup antes de qualquer uso fora do teste. Ele não foi incorporado ao journal Drizzle.

### C. Restauração a partir de backup

**Não executada.** O runtime contém `postgres`, `initdb` e `pg_ctl`, mas não fornece `pg_dump` ou `pg_restore`. Uma cópia lógica implementada pela aplicação não seria equivalente e não foi usada como substituta.

Além da limitação do ambiente, o restore atual do aplicativo está incompatível com as novas colunas obrigatórias e não inclui a nova tabela na sua ordem operacional.

## 10. Testes de integração

Os testes reais, sem mocks, cobriram:

- criação e identificação do cluster PostgreSQL dedicado;
- execução da migration histórica exata até a falha real de pgvector;
- reconstrução das 32 tabelas na estrutura adaptada;
- execução de fixtures com identidades canônicas distintas;
- auditoria read-only e ausência de efeitos colaterais;
- detecção de inconsistências artificiais;
- execução do SQL original da proposta;
- preservação de contagens e IDs;
- backfill e vínculo 1:1;
- validação das novas FKs;
- rejeição de FK inválida e unique duplicada;
- atomicidade de oito cenários negativos;
- incompatibilidade dos inserts legados;
- rollback físico e reconstrução.

Regras de papel e ownership que a migration aceitou não foram declaradas como garantidas pelo banco.

## 11. Validação geral

| Verificação | Resultado |
|---|---|
| TypeScript — `npx tsc --noEmit` | aprovado |
| Testes unitários — `npm run test:run` | 13 arquivos e 77/77 testes aprovados |
| Harness PostgreSQL real | processo aprovado; resultado funcional da proposta reprovado |
| Build — `npm run build` | aprovado |
| Lint dirigido | aprovado após remoção de um import não usado no runner |
| `git diff --check` | aprovado na validação final |

Avisos preexistentes observados:

- Vitest informa futura mudança de carregamento da configuração;
- Next.js informa que a convenção `middleware` está deprecated.

Não foram atribuídos à F1.03-M.

### 11.1 Testes não executados

- cadeia histórica fiel `0000`–`0002` com pgvector;
- `pg_dump`/`pg_restore` e comparação pós-restauração;
- integração do aplicativo já adaptado ao novo schema, pois essa adaptação ainda não existe;
- execução pelo journal/migrador Drizzle, pois a proposta continua fora do journal;
- qualquer teste contra produção, Supabase ou dados reais.

## 12. Arquivos criados ou alterados

### Criados nesta tarefa

- `docs/modernizacao/RELATORIO_F1_03_M.md`;
- `scripts/f1_03_m/run-isolated-validation.mjs`;
- `tests/integration/f1_03_m/fixtures.sql`;
- `tests/integration/f1_03_m/rollback_fisico.sql`.

### Alterado nesta tarefa

- `docs/modernizacao/PLANO_MODERNIZACAO.md`.

### Deliberadamente não alterados

- `docs/modernizacao/propostas/F1_03_MIGRACAO_PROPOSTA.sql`;
- migrations históricas `drizzle/0000`–`0002`;
- `src/db/schema.ts`;
- Server Actions, autenticação e interface;
- credenciais, configuração de produção e deploy.

O worktree já continha alterações não commitadas da F1.03 antes desta tarefa. Elas foram preservadas e não foram atribuídas à F1.03-M.

## 13. Riscos remanescentes e pendências

1. **P1 — Incompatibilidade do aplicativo:** a proposta não pode ser aplicada antes de schema Drizzle, actions e backup suportarem os owners.
2. **P1 — Rollback operacional:** a contração precisa ser separada da expansão.
3. **P1 — Integridade semântica:** papéis corretos e owner correto ainda dependem da aplicação.
4. **P1 — Restore:** contrato e ordem de restore não suportam as novas relações.
5. **P2 — pgvector:** a cadeia histórica ainda precisa de validação fiel em imagem/runtime compatível.
6. **P2 — Drift Drizzle:** a proposta não está no journal e diverge de `schema.ts`.
7. **P2 — Preflight:** validações importantes são ausentes ou tardias.
8. **P2 — Auditoria pós-migração:** deve ser criada separadamente, sem reutilizar a seção pré-migração de ownership.
9. **P3 — Portabilidade:** confirmar a sintaxe e comportamento na versão PostgreSQL do ambiente-alvo.

## 14. Classificação final

# REPROVADA

A proposta não pode ser aplicada com segurança porque quebra operações essenciais da aplicação atual e não oferece rollback operacional compatível. Além disso, aceita estados semanticamente inválidos de identidade e papel.

Essa classificação não decorre apenas da falta de pgvector. Mesmo no ensaio estrutural em PostgreSQL real, foram reproduzidos bloqueios suficientes para impedir a aplicação segura.

Nenhuma classificação ou resultado deste relatório autoriza migration, deploy ou alteração em produção.

## 15. Recomendação para F1.04

Não iniciar a F1.04 ainda. A próxima tarefa recomendada é uma etapa corretiva curta:

**F1.03-R — Revisão da migration em expansão/contração**

Escopo mínimo:

1. dividir a proposta em migration de expansão nullable e migration posterior de contração;
2. atualizar `src/db/schema.ts`, relações Drizzle, Server Actions e backup/restore para os novos owners;
3. tornar o vínculo responsável–estudante a origem da autorização sem ampliar para múltiplas famílias;
4. adicionar preflight para identidade igual, papéis, owner incompatível, órfãos, incoerências transitivas e ciclos ativos;
5. definir como o banco garantirá papéis sem introduzir trigger improvisado;
6. versionar migrations e rollback no journal apropriado;
7. repetir a F1.03-M em PostgreSQL com pgvector e ferramentas de dump/restore.

A F1.04 — RLS e views — deve começar somente após a F1.03-R ser aprovada em ambiente isolado, pois suas policies dependerão da identidade, ownership e vínculo definitivos.

## 16. Confirmações de encerramento

- nenhum banco de produção foi acessado;
- nenhum Supabase remoto foi acessado;
- nenhum dado real foi lido, copiado ou alterado;
- nenhuma migration foi executada em ambiente preexistente;
- nenhum seed foi executado;
- nenhuma credencial real foi lida ou modificada;
- nenhum deploy, commit ou push foi realizado;
- nenhum código de interface ou funcionalidade pedagógica foi alterado;
- o único banco criado era descartável e exclusivo da tarefa;
- o cluster foi encerrado;
- o diretório temporário e os dados artificiais foram removidos de forma definitiva;
- os scripts de teste foram preservados no repositório.
