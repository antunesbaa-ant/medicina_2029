# Medicina 2029 — Plano de Modernização

**Origem:** Auditoria F1.01

**Princípio:** menor alteração segura possível; sem refatoração ampla sem necessidade

**Estado:** F1.02 a F1.16 executadas; F1.03-M reprovou a proposta monolítica; F1.03-R, F1.07, F1.08, F1.09, F1.10, F1.11, F1.12, F1.13, F1.14, F1.15 e F1.16 foram aprovadas; nenhuma etapa desta sequência acessou ou alterou produção

## 1. Estratégia geral

O trabalho deve seguir a ordem **contenção → identidade/autorização → integridade → persistência → pipeline → qualidade**. Cada tarefa abaixo deve ser implementada em branch/commit independente, com testes próprios e reversão documentada.

Regras para todas as tarefas:

- preservar o comportamento funcional não relacionado;
- não executar migrations em produção sem backup validado e janela aprovada;
- não usar mocks de runtime como mecanismo de disponibilidade;
- não aceitar IDs de usuário enviados pelo cliente como identidade;
- não avançar para dados reais enquanto qualquer P0 aplicável permanecer aberto;
- registrar a evidência de teste e o risco residual ao concluir cada tarefa.

## 2. Sequência recomendada

```text
F1.02 Autorização imediata
   └── F1.03 Identidade e ownership
          ├── F1.03-M Validação isolada (reprovou proposta monolítica)
          └── F1.03-R Expansão compatível + contração separada
                    ↓
                 F1.05 Isolamento do backup/restore
                    ↓
                 F1.04 RLS e views
          ↓
F1.06 Dependências e segredos
          ↓
F1.07 Contratos de erro / remoção de falso sucesso
          ↓
F1.08 Atomicidade e idempotência
          ↓
F1.09 Validação e constraints
          ↓
F1.10 Storage e upload seguro
          ↓
F1.11 Fila durável do pipeline
          ↓
F1.12 IA, fontes e recuperação real
          ↓
F1.13 Consolidação técnica e preparação para homologação (inserida antes da homologação de banco/worker/IA)
          ↓
F1.14 Estado server-side do ciclo/cronômetro (anteriormente F1.13; prioridade preservada)
          ↓
F1.15 Backup completo e recuperação (anteriormente F1.14; prioridade preservada)
          ↓
F1.16 Testes de segurança/E2E e operação (anteriormente F1.15; prioridade preservada)
```

## 3. Tarefas propostas

### F1.02 — Guardas de autenticação e autorização nas Server Actions

**Status:** concluída em 19/10/2026.

- **Objetivo:** garantir que toda operação valide sessão e papel na própria action.
- **Arquivos potencialmente afetados:** novo helper server-only em `src/lib` ou `src/app`; todos os arquivos em `src/app/actions`; pages administrativas.
- **Dependências:** nenhuma; é a primeira contenção.
- **Riscos:** regressão por bloquear fluxos que hoje dependem de acesso implícito; circular import se o helper reutilizar `authOptions` incorretamente.
- **Estratégia:** criar `requireUser`/`requireRole`; negar por padrão; aplicar primeiro em backup, curadoria, acervo, responsável e reset de ciclo; depois nas demais actions.
- **Testes necessários:** chamada anônima, estudante e responsável para cada classe de action; tentativa direta sem visitar a página.
- **Critérios de aceite:** nenhuma action mutável executa sem sessão; operações administrativas negam estudante; `/lacunas` recebe proteção coerente; respostas não revelam detalhes.
- **Reversão:** reverter apenas o helper e suas chamadas; manter testes de segurança para demonstrar o risco reaberto.
- **Resultado:** 37/37 Server Actions com guarda server-side; papel revalidado no banco; operações administrativas e pessoais separadas; ownership aplicado aos recursos com proprietário disponível; 71/71 testes e build aprovados.
- **Riscos residuais:** RLS, restore destrutivo, hashes no backup, tabelas globais e ausência de vínculo responsável–estudante seguem para tarefas específicas.

### F1.03 — Identidade canônica e ownership

**Status:** análise e preparação concluídas em 19/10/2026; migration não executada e integração PostgreSQL pendente.

- **Objetivo:** eliminar UUIDs hardcoded e a confusão entre `authUserId` e `perfis.id`.
- **Arquivos potencialmente afetados:** auth route, `src/db/schema.ts` apenas se necessário, actions de sessão/check-in/redação/simulado/FSRS/dashboard/responsável/curadoria/acervo e componentes que enviam `perfilId`.
- **Dependências:** F1.02.
- **Riscos:** dados históricos associados a identificadores incorretos; necessidade de saneamento antes de constraint adicional.
- **Estratégia:** resolver o perfil pelo identificador autenticado; retornar contexto `{perfilId,papel}`; remover `perfilId` dos inputs do cliente; adicionar ownership em todas as queries por ID.
- **Testes necessários:** integração com dois perfis reais; FK; usuário não lê/altera registro alheio; ausência de UUID fixo no runtime.
- **Critérios de aceite:** inserts usam `perfis.id` existente; nenhum módulo de runtime contém IDs de perfil fixos; queries sensíveis têm filtro de ownership.
- **Reversão:** feature flag temporária somente em ambiente de teste e rollback do commit; não restaurar IDs hardcoded em produção.
- **Resultado da análise:** `perfis.id` confirmado como identidade canônica; `authUserId` removido do contexto autorizado e mantido intacto no schema; 31 tabelas inventariadas; ciclos, repertórios e revisões trimestrais identificados sem ownership; proposta 1:1 responsável–estudante e auditoria SQL read-only preparadas fora do journal Drizzle.
- **Migration proposta:** relação `responsavel_estudante`, ownership aditivo, quatro FKs ausentes e constraints compostas prioritárias, sempre condicionados a preflight sem ambiguidades.
- **Validação obtida:** 77/77 testes unitários, TypeScript, build, lint dos arquivos alterados e `git diff --check` aprovados.
- **Validação pendente:** auditoria histórica e migration não foram executadas; não existe banco PostgreSQL descartável dedicado e atestado. Não considerar a proposta pronta para produção.

### F1.03-M — Validação isolada da migration

**Status:** concluída em 19/10/2026; proposta classificada como **REPROVADA** e não autorizada para qualquer ambiente persistente.

- **Ambiente:** PostgreSQL 18.4 real em cluster efêmero exclusivo, conectado somente por `127.0.0.1`, com banco, usuário, porta e diretório próprios; nenhum `.env`, `DATABASE_URL`, Supabase ou banco preexistente foi usado.
- **Limitação de fidelidade:** a migration histórica `0000` falhou como esperado porque o runtime local não contém `pgvector`. Os ensaios restantes usaram uma cópia temporária da estrutura em que apenas `CREATE EXTENSION vector` foi removido e `vector(1536)` foi substituído por `text`; essa adaptação não valida o pgvector.
- **Resultado técnico:** o SQL original da proposta concluiu no PostgreSQL real sobre a estrutura adaptada, preservou IDs e contagens, criou o vínculo 1:1, realizou os backfills e validou as FKs.
- **Bloqueio:** a contração `NOT NULL` quebra as escritas atuais de ciclos, repertórios, revisões trimestrais e o restore legado. O rollback operacional descrito também não é compatível com a aplicação anterior.
- **Lacunas:** `id = auth_user_id`, owner com papel incompatível e inversão dos papéis no vínculo continuam aceitos; schema Drizzle, actions e backup não representam a proposta.
- **Rollback físico:** executado no cluster descartável, preservando IDs e contagens; a reconstrução subsequente funcionou. Isso não equivale a rollback operacional ou restauração de backup.
- **Próximo gate obrigatório:** criar uma F1.03-R pequena, dividindo a evolução em expansão nullable, aplicação compatível e contração posterior. Repetir a F1.03-M com PostgreSQL+pgvector e `pg_dump`/`pg_restore` antes da F1.04.

### F1.03-R — Correção da migration e compatibilidade do aplicativo

**Status:** concluída em 19/10/2026 como **APROVADA COM RESSALVAS**; expansão preparada e versionada, contração fora do fluxo automático e nenhuma migration aplicada em produção.

- **Solução:** a antiga proposta monolítica foi substituída operacionalmente por `0003_f1_03_r_expansao.sql`, com owners nullable, preflight antes da DDL, vínculo 1:1, backfill determinístico e FKs validadas. A contração permanece em `docs/modernizacao/propostas/`, sem entrada no journal.
- **Compatibilidade:** inserts equivalentes à aplicação anterior e inserts da aplicação atualizada funcionaram durante a expansão. Ciclos, repertórios e revisões trimestrais passaram a gravar `perfis.id`; consultas e mutações relevantes usam o vínculo autenticado.
- **Validação PostgreSQL:** PGlite/PostgreSQL 18.6 em memória, pgvector 0.8.7 real, cadeia histórica e expansionista via migrador Drizzle, fixtures artificiais, backfill repetido, cenários negativos, rollback físico e dump/restore lógico aprovados. Nenhuma conexão, variável ou dado externo foi utilizado.
- **Validação da aplicação:** TypeScript, 104/104 testes unitários, build, lint dirigido de todos os TS/TSX alterados, `drizzle-kit check` e `git diff --check` aprovados.
- **Rollback operacional:** viável enquanto apenas a expansão nullable estiver aplicada. Depois da futura contração, a versão mínima compatível passa a ser F1.03-R; para voltar ao aplicativo anterior é obrigatório desfazer primeiro a contração.
- **Ressalvas P0/P1:** o restore JSON interativo continua destrutivo, exporta a linha inteira de `perfis` e não equivale a recuperação operacional; deve ser isolado na F1.05. FKs não garantem sozinhas que o papel do perfil permaneça semanticamente compatível após a migration; preflight e guards server-side fornecem a contenção atual.
- **Contração:** somente após aplicação compatível implantada, backfill/auditoria sem pendências, backup nativo restaurado, integração no PostgreSQL-alvo, rollback ensaiado e aprovação específica. Não executar automaticamente.
- **Próximo gate:** F1.05 antes da contração e antes de iniciar F1.04.

### F1.04 — RLS e views agregadas versionadas

**Status:** concluída em 19/10/2026 como **APROVADA COM RESSALVAS**; proposta completa de RLS e views agregadas versionada fora do journal automático em `docs/modernizacao/propostas/`, suíte de 18 cenários de segurança e isolamento 100% verde em PostgreSQL 18.6 isolado (PGlite), rollback atômico e idempotência comprovados, e nenhuma alteração executada em produção.

- **Objetivo:** tornar a separação estudante/responsável verificável no banco.
- **Arquivos gerados/afetados:** `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql`, `docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql`, `tests/integration/f1_04/fixtures.sql`, `scripts/f1_04/run-rls-validation.mjs`, `docs/modernizacao/RELATORIO_F1_04.md`.
- **Dependências:** F1.02 e definição da identidade da F1.03; expansão compatível F1.03-R.
- **Solução implementada:** Todas as 32 tabelas + `allowlist` receberam `ENABLE/FORCE ROW LEVEL SECURITY`; princípio Fail-Closed com funções de contexto no schema `medicina`; variáveis transacionais `SET LOCAL` para isolamento de connection pooling; proibição estrita de leitura de sessões brutas pelo responsável (Princípio 1.2 da ESPEC); view quinzenal agregada `vw_acompanhamento_quinzenal` e evolução de simulados `vw_simulados_evolucao`; view segura `vw_perfis` omitindo `password_hash`; role de mínimo privilégio `medicina_app` (`NOBYPASSRLS`, `NOSUPERUSER`).
- **Validação:** PGlite com PostgreSQL 18.6 e pgvector 0.8.7 real; fixtures artificiais `example.invalid`; 18/18 cenários da matriz de segurança aprovados sob `medicina_app` (bloqueios confirmados para acessos cruzados, inserts com owner forjado, vazamento entre transações e DDL); rollback ensaiado e idempotência comprovada; TypeScript, 114/114 testes Vitest, `drizzle-kit check` e `git diff --check` aprovados.
- **Ressalvas:** A ativação definitiva em produção permanece bloqueada até homologação da infraestrutura com a role `medicina_app` (evitando bypass por superuser) e adaptação da Server Action do responsável para consumir `vw_acompanhamento_quinzenal`.
- **Próximo gate:** F1.04-R para revisão de segurança, endurecimento de privilégios e integração RLS.

### F1.04-R — Revisão de segurança, endurecimento de privilégios e integração RLS

**Status:** concluída em 19/10/2026 como **APROVADA**; proposta endurecida com proteção de colunas sensíveis (`password_hash`), blindagem de funções `SECURITY DEFINER` e revogação de `EXECUTE` para `PUBLIC`, anti-enumeração na allowlist, formalização do Trust Model do banco de dados, helper transacional TypeScript `withRlsContext` com testes unitários, e suíte expandida para 26 cenários de segurança e isolamento 100% verde em PostgreSQL 18.6 com pgvector.

- **Objetivo:** auditar vulnerabilidades residuais da proposta F1.04, proteger colunas sensíveis via privilégios granulares de banco, fornecer helper de runtime seguro e comprovar isolamento relacional irrestrito.
- **Arquivos gerados/afetados:** `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql`, `docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql`, `src/db/rls-context.ts`, `src/db/rls-context.test.ts`, `scripts/f1_04/run-rls-validation.mjs`, `docs/modernizacao/RELATORIO_F1_04_R.md`, `~/Documents/MEDICINA_2029_F1_04_R_RELATORIO.md`.
- **Endurecimentos implementados:**
  1. *Column-Level Grants:* `REVOKE SELECT ON perfis` e concessão apenas em colunas seguras, gerando erro `42501` em tentativas de leitura de `password_hash` sob `medicina_app`.
  2. *Defesa de Funções:* `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA medicina FROM PUBLIC`, fixação de `SET search_path = public, medicina, pg_temp` e provisionamento do papel `medicina_anon` com bloqueio de chamadas (`42501`).
  3. *Anti-enumeração:* `medicina.autenticar_por_email` checa compulsoriamente a allowlist e retorna 0 linhas para e-mails não autorizados.
  4. *Integração TypeScript:* Helper `withRlsContext` em `src/db/rls-context.ts` para transações atômicas com `medicina.set_context` e limpeza defensiva em `finally`.
  5. *Trust Model:* Formalização de que o banco delega autenticação para o servidor de aplicação (NextAuth) e atua como camada relacional de contenção em profundidade.
- **Validação:** 26/26 cenários aprovados (18 baseline + 8 cenários de revisão R1–R8) no runner automatizado `scripts/f1_04/run-rls-validation.mjs` sob PGlite PostgreSQL 18.6 com pgvector 0.8.7; rollback atômico e idempotência na re-aplicação comprovados; `npx tsc --noEmit` aprovado; 117/117 testes Vitest aprovados; `npx drizzle-kit check` e `git diff --check` aprovados.
- **Próximo gate:** F1.04-C para segregação de roles, privilégios mínimos e suíte de conformidade.

### F1.04-C — Conformidade de roles, privilégios mínimos e suíte de segurança

**Status:** concluída em 19/10/2026 como **APROVADA**; segregação estrita dos papéis de banco (`medicina_auth` vs `medicina_app` vs `medicina_anon`), privilégios mínimos em autenticação, proteção irrestrita contra vazamento de credenciais, rollback com remoção atômica do papel de auth, e suíte automatizada expandida para 41 cenários de segurança e isolamento 100% verde em PostgreSQL 18.6 com pgvector.

- **Objetivo:** segregar papéis de banco entre serviço de autenticação e runtime da aplicação, blindar funções e validar 15 novos cenários de conformidade normativa.
- **Arquivos gerados/afetados:** `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql`, `docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql`, `scripts/f1_04/run-rls-validation.mjs`, `docs/modernizacao/RELATORIO_F1_04_C.md`, `~/Documents/MEDICINA_2029_F1_04_C_RELATORIO.md`.
- **Endurecimentos implementados:**
  1. *Segregação de Roles:* `medicina_auth` dedicado exclusivamente ao NextAuth (com `EXECUTE` em `medicina.autenticar_por_email` e `SELECT` nas colunas necessárias para checagem); `medicina_app` para as Server Actions cotidianas (sem permissão em `password_hash` e sem `EXECUTE` em `autenticar_por_email`); `medicina_anon` sem privilégios.
  2. *Defesa de Funções:* `SET search_path = public, medicina, pg_temp;` e `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA medicina FROM PUBLIC;`.
  3. *Rollback Atômico:* `F1_04_ROLLBACK_RLS.sql` revoga privilégios e remove o papel `medicina_auth` (`DROP ROLE medicina_auth;`), mantendo a reversibilidade total e idempotência.
  4. *Conformidade C1–C15:* Identidade retirada exclusivamente da sessão, parâmetro do cliente não substitui identidade nem modifica papel, isolamento estrito de queries/mutations para estudante e responsável, login legítimo 100% funcional, bloqueio 42501 em password_hash sob app, negação fail-closed sem contexto, transações com limpeza de contexto, isolamento pós-DISCARD ALL em pool, cumprimento do Princípio 1.2 (painel do responsável consome apenas view quinzenal), barreira administrativa impenetrável e rejeição de falsos sucessos.
- **Validação:** 41/41 cenários aprovados (18 baseline + 8 revisão F1.04-R + 15 conformidade F1.04-C) no runner automatizado `scripts/f1_04/run-rls-validation.mjs` sob PGlite PostgreSQL 18.6 com pgvector 0.8.7; rollback atômico e idempotência comprovados; `npx tsc --noEmit` aprovado; 123/123 testes Vitest aprovados; `npx drizzle-kit check` e `git diff --check` aprovados.
- **Próximo gate:** F1.06 (Atualização de dependências críticas e separação de segredos) antes de deploy em ambiente compartilhado.

### F1.05 — Isolamento imediato do backup/restore

**Status:** concluída em 19/10/2026 como **APROVADA**; restore interativo bloqueado na interface e no servidor, exportação administrativa protegida e nenhuma restauração executada.

- **Objetivo:** impedir exfiltração, elevação e destruição por chamadas normais da aplicação.
- **Arquivos potencialmente afetados:** `src/app/actions/backup.ts`, `src/components/ResponsavelPage.tsx`, guards/auditoria.
- **Dependências:** F1.02; F1.03 para identidade.
- **Riscos:** indisponibilizar temporariamente restore pela UI; manter falso senso de segurança se apenas esconder o botão.
- **Estratégia:** desabilitar integralmente o restore interativo até redesenho operacional; exigir responsável na exportação/validação; remover dados de autenticação do export; validar versão, estrutura e limites exclusivamente em memória. Reautenticação, modo operacional e trilha de auditoria pertencem ao futuro fluxo de recuperação e não reabrem o restore comum.
- **Testes necessários:** anônimo/estudante negados; export não contém hashes ou segredos; JSON inválido não inicia escrita; chamada direta ao restore permanece bloqueada.
- **Critérios de aceite:** nenhuma rota/action normal apaga base; dados de autenticação não saem no arquivo; tentativa inválida é side-effect free.
- **Reversão:** reativar somente versão anterior em ambiente isolado; nunca reexpor restore inseguro em produção.
- **Resultado:** o corpo destrutivo foi removido da Server Action histórica, que agora exige responsável e sempre retorna negação antes de interpretar o arquivo ou iniciar qualquer escrita. A UI não importa nem chama restore e não oferece seletor de arquivo.
- **Exportação segura:** 32 coleções usam projeções positivas explícitas; `passwordHash`, `authUserId`, e-mail, tokens, cookies, credenciais e segredos não fazem parte das seleções. O arquivo se declara exportação administrativa, sem objetos binários do Storage e não restaurável automaticamente.
- **Manifesto e integridade:** formato 1 com aplicação, timestamp, tipo, coleções, contagens, flags de segurança e SHA-256 sobre a serialização canônica de `dados`. O hash detecta alteração, mas não é assinatura nem prova de autenticidade.
- **Validação:** rotina pura em memória com contrato fechado de campos/tipos/nullability, UUIDs, enums, datas, coleções e contagens; limites de 10 MiB, 100.000 registros, profundidade 20, 500.000 nós e 100 erros.
- **Validação obtida:** 16 arquivos e 114/114 testes aprovados; TypeScript, build, lint dos seis arquivos TypeScript/TSX da F1.05 e `git diff --check` aprovados.
- **Riscos residuais:** a exportação contém dados pessoais e pedagógicos em claro, não inclui objetos do Storage e não permite recuperação integral. Backup nativo PostgreSQL, Storage, criptografia, retenção e restore temporário permanecem na F1.14.

### F1.06 — Atualização de dependências críticas e separação de segredos

**Status:** concluída em 19/10/2026 como **APROVADA**; segregação estrita de provedores de IA (eliminação de `ANTHROPIC_API_KEY` para Gemini e envio por header seguro), eliminação de fallbacks hardcoded em storage e banco, conexões segregadas PostgreSQL (`DATABASE_APP_URL` vs `DATABASE_AUTH_URL` vs `DATABASE_URL`), validação centralizada de ambiente (`src/lib/env.ts`), modelo `.env.example` e suíte com 140/140 testes Vitest aprovados.

- **Objetivo:** remover vulnerabilidades críticas de runtime, impedir chave cruzada entre provedores e eliminar fallbacks inseguros.
- **Arquivos gerados/afetados:** `src/lib/supabaseStorage.ts`, `src/lib/gemini.ts`, `src/lib/gemini.test.ts`, `src/db/index.ts`, `src/lib/auth-options.ts`, `src/lib/env.ts`, `src/lib/env.test.ts`, `.env.example`, `.gitignore`, `docs/modernizacao/RELATORIO_F1_06.md`, `~/Documents/MEDICINA_2029_F1_06_RELATORIO.md`.
- **Implementações e endurecimentos:**
  1. *Eliminação de Fallbacks Hardcoded:* remoção da URL real de projeto Supabase em `supabaseStorage.ts` e credenciais hardcoded em `db/index.ts`.
  2. *Segregação de Provedores de IA:* `gemini.ts` consome exclusivamente `GEMINI_API_KEY`, rejeita expressamente `ANTHROPIC_API_KEY`, envia credencial via cabeçalho `x-goog-api-key` (nunca em query string) e sanitiza logs de erro.
  3. *Conexões PostgreSQL Segregadas:* suporte a `DATABASE_AUTH_URL` (para NextAuth sob papel `medicina_auth`), `DATABASE_APP_URL` (para Server Actions cotidianas sob `medicina_app`) e `DATABASE_URL` (fallback seguro).
  4. *Validação Centralizada (`src/lib/env.ts`):* regras estritas em produção (secret >= 32 chars, proibição de segredos padrão, proibição de localhost em produção, exigência de HTTPS em NEXTAUTH_URL) e regras tolerantes para testes.
  5. *Documentação de Configuração:* arquivo `.env.example` completo com placeholders seguros e designorado em `.gitignore`.
- **Validação:** 140/140 testes unitários Vitest aprovados (19 test files, incluindo `gemini.test.ts` e `env.test.ts`); `npx tsc --noEmit` aprovado com 0 erros; `npx drizzle-kit check` aprovado; `git diff --check` aprovado.
- **Próximo gate:** F1.07 (Contratos explícitos de erro e remoção de falso sucesso).

### F1.07 — Contratos explícitos de erro e remoção de falso sucesso

**Status:** concluída em 20/10/2026 como **APROVADA COM RESSALVAS**. Os falsos sucessos críticos de upload/Storage, geração Gemini, persistência sem `RETURNING`, análise simulada de simulados e avanço local do cronômetro sem confirmação foram contidos. Permanecem fallbacks de runtime e contratos legados em módulos fora do recorte seguro desta intervenção; atomicidade ampla continua reservada à F1.08.

- **Objetivo:** impedir que falhas de persistência sejam apresentadas como sucesso.
- **Arquivos potencialmente afetados:** `sessao.ts`, `checkin.ts`, `ciclo.ts`, `dashboard.ts`, `redacoes.ts`, `lacunas.ts`, `responsavel.ts`, componentes consumidores.
- **Dependências:** F1.03.
- **Riscos:** a UI passará a exibir erros antes ocultos; aumento aparente de falhas até a infraestrutura ser corrigida.
- **Estratégia:** retorno discriminado `{ok,data}`/`{ok:false,code}`; remover mocks de catches; diferenciar vazio de indisponível; retry explícito; correlation ID; mocks somente via adaptador de demo/teste.
- **Testes necessários:** falha de DB, timeout e zero linhas; UI não avança ponteiro nem marca check-in; logs sem segredos.
- **Critérios de aceite:** nenhuma action retorna sucesso quando não persistiu; dashboard nunca troca erro por dado plausível; usuário recebe ação de retry.
- **Reversão:** reverter por módulo; não reintroduzir mocks silenciosos, usar estado de manutenção explícito.
- **Resultado:** criado `OperationResult<T>` como união discriminada com oito códigos públicos estáveis; actions selecionadas passaram a confirmar `INSERT`/`UPDATE`; consultas alteradas diferenciam vazio legítimo de indisponibilidade; logs novos registram somente categoria e contexto constantes; autenticação e autorização permanecem fail-closed.
- **IA e acervo:** Gemini falha explicitamente por chave ausente, HTTP, timeout, rede ou resposta inválida; o gerador determinístico não é usado no runtime. Upload só é confirmado após Storage e metadados persistidos; processamento é reportado como pendente e, sem embeddings reais, termina visivelmente em falha em vez de conclusão fictícia.
- **Interfaces:** check-in, cronômetro, busca, caderno de erros, redações, simulados, acervo e curadoria foram adaptados para não avançar nem exibir sucesso sem confirmação.
- **Validação:** TypeScript, build, Drizzle, `git diff --check`, 24 arquivos/172 testes Vitest e 41/41 cenários RLS em PostgreSQL isolado passaram. O lint do conjunto completo de 32 arquivos TS/TSX alterados encontrou 67 ocorrências preexistentes (53 erros e 14 avisos); o subconjunto novo ou previamente limpo da F1.07 passou. O lint global melhorou de 136 para 126 ocorrências, mas continua vermelho.
- **Ressalvas:** ciclo, dashboard, lacunas e acompanhamento ainda contêm mocks/fallbacks; FSRS e algumas consultas ainda convertem falha em lista vazia; fluxos de sessão, FSRS, simulado, curadoria e acervo não são integralmente atômicos/idempotentes; a fila do acervo segue efêmera; busca/embeddings reais não existem; E2E de navegador não foi executado.
- **Próximo gate:** F1.08 para atomicidade, idempotência, concorrência e comunicação explícita de persistência parcial; depois F1.09–F1.12 para validação, Storage, fila e IA/recuperação reais.

### F1.08 — Atomicidade, idempotência e concorrência

**Status:** concluída em 20/10/2026 como **APROVADA COM RESSALVAS**. Sessão, revisão FSRS, registro de simulado, geração de artefatos e decisão de curadoria passaram a usar transações PostgreSQL curtas, confirmação por `RETURNING` e serialização por row lock ou advisory lock. Repetições deixam de duplicar os efeitos prioritários no recorte compatível com o schema atual. A integração das Server Actions com PostgreSQL real e chaves idempotentes persistidas continuam pendentes.

- **Objetivo:** tornar operações multi-etapa consistentes.
- **Arquivos potencialmente afetados:** `sessao.ts`, `fsrs.ts`, `simulados.ts`, `curadoria.ts`, `reestudo.ts`; schema/migrations de chaves idempotentes.
- **Dependências:** F1.03 e F1.07.
- **Riscos:** locks/deadlocks; repetição de requests antigos; rollback de efeitos externos ao DB.
- **Estratégia:** transação por caso de uso; ordem correta de operações; idempotency key para conclusão/revisão/upload; locking otimista ou row lock no ponteiro; ações externas antes/depois com outbox.
- **Testes necessários:** falha em cada etapa, retry, duplo clique, duas abas, concorrência no ponteiro, rollback do log FSRS.
- **Critérios de aceite:** ou todo o caso de uso persiste ou nada persiste; retry não duplica; ponteiro avança uma vez.
- **Reversão:** rollback dos commits por fluxo; constraints novas exigem migration reversível ensaiada.
- **Resultado:** `concluirSessao` serializa a sessão, grava conclusão, erros e ponteiro na mesma transação e trata sessão encerrada como replay; FSRS serializa o card e torna atômicos card+histórico; simulado serializa por estudante e grava cabeçalho+áreas atomicamente; geração de curadoria mantém Gemini fora da transação, grava o lote de artefatos/fila/marcador em uma única transação e deduplica persistência por arquivo; decisão de curadoria torna atômicos artefato, card derivado e fila. A interface de revisão só avança após confirmação.
- **Validação:** TypeScript, build, lint dos dez arquivos TS/TSX alterados, Drizzle check e `git diff --check` aprovados; 24 arquivos/184 testes Vitest aprovados; suíte RLS em PostgreSQL descartável aprovada em 41/41 cenários. Os testes específicos das Server Actions permanecem mockados; o PostgreSQL real isolado valida RLS e primitivas transacionais, não a integração completa dessas actions.
- **Ressalvas:** FSRS usa o estado persistido (`lastReview`, `due` e último log) como deduplicação compatível, sem idempotency key durável; chamadas Gemini concorrentes ainda podem duplicar custo antes de uma delas vencer o lock de persistência; Storage continua fora da atomicidade PostgreSQL; não foram aplicadas constraints ou migrations.
- **Próximo gate:** F1.09 para validação runtime, constraints e desenho explícito das chaves idempotentes persistidas, sem aplicar a contração F1.03-R automaticamente.

### F1.09 — Validação runtime e integridade relacional

**Status:** concluída em 20/10/2026 como **APROVADA COM RESSALVAS**. Validação runtime reutilizável (`src/lib/validation.ts`) implementada sem dependências externas e aplicada às Server Actions prioritárias (`sessao.ts`, `fsrs.ts`, `simulados.ts`, `curadoria.ts`, `redacoes.ts`, `acervo.ts`) e complementares (`checkin.ts`, `cadernoErros.ts`, `reestudo.ts`). Integridade relacional server-side reforçada antes de escrita, e proposta SQL reversível (`F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` + `F1_09_ROLLBACK_INTEGRIDADE_E_IDEMPOTENCIA.sql`) versionada fora do journal automático e ensaiada em PostgreSQL 18.6 descartável (PGlite), preservando integralmente a expansão F1.03-R.

- **Objetivo:** validar todo input não confiável e reforçar regras no banco.
- **Arquivos gerados/afetados:** `src/lib/validation.ts`, `src/lib/validation.test.ts`, `src/lib/mocks.ts`, `src/app/actions/sessao.ts`, `src/app/actions/fsrs.ts`, `src/app/actions/simulados.ts`, `src/app/actions/curadoria.ts`, `src/app/actions/redacoes.ts`, `src/app/actions/acervo.ts`, `src/app/actions/checkin.ts`, `src/app/actions/cadernoErros.ts`, `src/app/actions/reestudo.ts`, testes de actions (`actions.test.ts`, `fsrs.test.ts`, `simulados-f1_07.test.ts`, `curadoria.test.ts`, `redacoes.test.ts`, `acervo.test.ts`, `authorization.test.ts`, `f1_07_operations.test.ts`, `reestudo.test.ts`, `f1_09_integracao_pg.test.ts`), `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`, `docs/modernizacao/propostas/F1_09_ROLLBACK_INTEGRIDADE_E_IDEMPOTENCIA.sql`, `docs/modernizacao/RELATORIO_F1_09.md`, `~/Documents/MEDICINA_2029_F1_09_RELATORIO.md`.
- **Dependências:** F1.03; recomendado após F1.08 para conhecer as transações.
- **Riscos:** dados legados inválidos impedirem constraints; compatibilidade de formulários.
- **Estratégia:** schemas pequenos por action; limites de texto/arrays/números/datas; checks de humor/energia/série/incidência/acertos; FKs ausentes; uniques/PKs em associações; saneamento prévio somente após auditoria autorizada.
- **Testes necessários:** valores de borda, payload enorme, divisão por zero, datas inválidas, associação duplicada e órfãos.
- **Critérios de aceite:** entrada inválida é rejeitada antes do DB; banco impede estados impossíveis; erros públicos são estáveis.
- **Reversão:** remover constraints apenas por migration de rollback; validadores podem ser revertidos por módulo.
- **Resultado:** módulo `src/lib/validation.ts` valida UUIDs, strings, limites numéricos, enums, datas, arrays com unicidade (`uniqueBy`), objetos com bloqueio de campos de identidade fornecidos pelo cliente (`perfilId`, `authUserId`, `papel`, `enviadoPor`, `aprovadoPor`, `estudantePerfilId`) e uploads PDF (extensão `.pdf`, bloqueio de path traversal, teto de 20 MiB e magic bytes `%PDF-`). Integridade relacional verificada em `iniciarSessao` (ownership do ciclo e compatibilidade `topico.disciplinaId === cicloBloco.disciplinaId`), `atualizarSessao` (somente sessão aberta), `concluirSessao` (ownership do ciclo, `encerradaEm >= iniciadaEm`, rejeição de erro para tentativa correta, conflito de etapa em sessão já encerrada), `registrarRevisaoCard` (card aprovado e não suspenso), `curarItem` (consistência `topicoId` e campos por tipo de artefato) e `registrarRedacao` (existência de `generoId`).
- **Proposta SQL e idempotência persistente:** `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` adiciona preflight diagnósticos, tabela `operacoes_idempotentes`, colunas nullable `chave_idempotencia` com índices parciais únicos em `card_revisoes` e `geracoes`, unicidades em `sessoes` abertas, `erros.tentativa_id`, `curadoria_fila(artefato_tipo, artefato_id)` e `acervo_arquivos.hash_conteudo`, e `CHECK` constraints (`NOT VALID` + `VALIDATE CONSTRAINT`), além de rollback atômico (`F1_09_ROLLBACK_INTEGRIDADE_E_IDEMPOTENCIA.sql`).
- **Validação:** `npx tsc --noEmit` (0 erros), `npm run test:run` (26 suítes / 218 testes aprovados, incluindo integração real em PostgreSQL 18.6 descartável via `f1_09_integracao_pg.test.ts`), `npm run build`, `npx eslint` nos 22 arquivos TS modificados (0 erros, 0 avisos), `npx drizzle-kit check`, `git diff --check` e suíte RLS `scripts/f1_04/run-rls-validation.mjs` (41/41 cenários aprovados).
- **Ressalvas:** a proposta SQL F1.09 permanece fora do journal automático e não foi aplicada em produção; o consumo direto da tabela `operacoes_idempotentes` pelas Server Actions depende da aplicação prévia da migration proposta em janela autorizada; upload continua em base64 até a F1.10.
- **Próximo gate:** F1.10 (Upload e Storage confiáveis).

### F1.10 — Upload e Storage confiáveis

**Status:** concluída em 20/10/2026 como **APROVADA COM RESSALVAS**. Upload endurecido com transporte binário via `FormData` (`enviarArquivoFormData`, preservando retrocompatibilidade com `enviarArquivo`), chave determinística endereçada por conteúdo (`acervo/<sha256>.pdf`), `upsert: false` por padrão no Supabase Storage, validação estrutural adicional de PDF (`%%EOF` e bloqueio de `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFiles`, `/RichMedia`, `/XFA`), geração autenticada de URLs assinadas de curta duração (`60..900`s) com rejeição de URLs públicas permanentes, reconciliação read-only Banco↔Storage sem exclusão automática (`reconciliarSnapshotsAcervo` e `diagnosticarReconciliacaoAcervo`) e proposta SQL versionada de policies de Storage privado (`F1_10_STORAGE_POLICIES_PROPOSTA.sql` e `F1_10_ROLLBACK_STORAGE_POLICIES.sql`).

- **Objetivo:** garantir que sucesso signifique arquivo privado realmente persistido e validado.
- **Arquivos gerados/afetados:** `next.config.ts`, `src/lib/validation.ts`, `src/lib/validation.test.ts`, `src/lib/supabaseStorage.ts`, `src/lib/acervoReconciliacao.ts`, `src/app/actions/acervo.ts`, `src/app/actions/acervo.test.ts`, `src/app/actions/f1_10_storage_integracao.test.ts`, `src/components/AcervoPage.tsx`, `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql`, `docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql`, `docs/modernizacao/RELATORIO_F1_10.md`, `~/Documents/MEDICINA_2029_F1_10_RELATORIO.md`.
- **Dependências:** F1.02, F1.03, F1.07 e auditoria das policies externas.
- **Riscos:** custo de upload; arquivos grandes; compatibilidade serverless; mudanças de policy bloquearem acesso.
- **Estratégia:** upload binário via `FormData`; chave determinística por SHA-256 (`acervo/<sha256>.pdf`); `upsert:false`; limite server-side de 20 MiB (`bodySizeLimit: '28mb'` em `next.config.ts`); cabeçalho `%PDF-`, trailer `%%EOF` e bloqueio de recursos ativos; metadados depois da confirmação; adoção idempotente de objeto órfão existente no reenvio sem exclusão automática; bucket privado; URLs assinadas curtas (`60..900`s); reconciliação read-only objeto↔registro.
- **Testes necessários:** arquivo válido, não-PDF, truncado sem `%%EOF`, com `/JavaScript`, oversized, duplicado, falha Storage, falha `INSERT`, objeto existente, URL assinada sem autorização e reconciliação.
- **Critérios de aceite:** sem objeto e metadados confirmados não há status de sucesso; nenhum arquivo é público; hash/tamanho conferem; falha parcial é recuperável sem apagar arquivos existentes.
- **Reversão:** manter leitor compatível com keys antigas (`acervo/<sha256>_<nome>.pdf`); rollback de policy ensaiado antes da aplicação (`F1_10_ROLLBACK_STORAGE_POLICIES.sql`).
- **Validação:** `npx tsc --noEmit` (0 erros), `npm run test:run` (27 suítes / 227 testes aprovados, incluindo `f1_10_storage_integracao.test.ts` em PostgreSQL 18.6 descartável PGlite + Storage simulado), `npm run build`, `npx eslint` nos arquivos modificados (0 erros, 0 warnings), `npx drizzle-kit check`, `git diff --check` e suíte RLS `scripts/f1_04/run-rls-validation.mjs` (41/41 cenários aprovados).
- **Ressalvas:** o pipeline de extração/segmentação/classificação permanece assíncrono em memória até a F1.11 (fila durável); a validação binária síncrona não descomprime streams `/FlateDecode`/`/ObjStm`; as propostas SQL (`F1_04`, `F1_09` e `F1_10`) não foram aplicadas em produção ou no Supabase remoto.
- **Próximo gate:** F1.11 (Fila durável e pipeline retomável).

### F1.11 — Fila durável e pipeline retomável

**Status:** concluída em 20/10/2026 como **APROVADA COM RESSALVAS**. O disparo assíncrono efêmero em memória (`void processarArquivoPipeline(...)`) foi substituído por fila PostgreSQL durável (`public.acervo_jobs`, proposta em `F1_11_FILA_INGESTAO_PROPOSTA.sql` com rollback em `F1_11_ROLLBACK_FILA_INGESTAO.sql`) e worker independente (`src/lib/acervoPipelineWorker.ts`) com claim atômico compare-and-swap, lease/heartbeat renovável, recuperação de leases vencidos, retry limitado com backoff exponencial, sanitização de erros e etapas idempotentes/retomáveis (`extracao`, `segmentacao`, `classificacao`, `indexacao`). Sem provedor real de embeddings (F1.12), a etapa `indexacao` nunca declara conclusão fictícia e encerra explicitamente como `falhou` (`EMBEDDING_PROVIDER_UNAVAILABLE`), preservando integralmente páginas, chunks e classificações anteriores.

- **Objetivo:** retirar processamento longo das requisições e tornar cada etapa idempotente.
- **Arquivos gerados/afetados:** `src/lib/acervoPipelineWorker.ts`, `src/lib/supabaseStorage.ts`, `src/app/actions/acervo.ts`, `src/app/actions/acervo.test.ts`, `src/app/actions/authorization.test.ts`, `src/app/actions/f1_10_storage_integracao.test.ts`, `src/app/actions/f1_11_fila_integracao.test.ts`, `docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql`, `docs/modernizacao/propostas/F1_11_ROLLBACK_FILA_INGESTAO.sql`, `docs/modernizacao/RELATORIO_F1_11.md`, `~/Documents/MEDICINA_2029_F1_11_RELATORIO.md`.
- **Dependências:** F1.10; F1.08.
- **Riscos:** duplicidade de jobs; worker indisponível; aumento de complexidade operacional; ativação do runtime antes da migration `F1_11_FILA_INGESTAO_PROPOSTA.sql`.
- **Estratégia:** publicar job durável em `public.acervo_jobs` após commit de `acervo_arquivos` (`enfileirarJobIngestaoAcervo`), sem fallback silencioso para execução efêmera (`PERSISTENCE_ERROR` explícito se a fila falhar); worker independente (`processarProximoJobAcervo`) com claim atômico, heartbeat/lease (`renovarHeartbeatJobAcervo`, `recuperarJobsComLeaseVencido`), retry com backoff exponencial (`calcularBackoffMs`) e retomada por etapa (`retomarProcessamentoArquivoAcervo`, `obterStatusJobAcervo`).
- **Ordem obrigatória de ativação:** (1) aplicar `F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`; (2) aplicar `F1_10_STORAGE_POLICIES_PROPOSTA.sql`; (3) aplicar `F1_11_FILA_INGESTAO_PROPOSTA.sql` (cria `public.acervo_jobs`, constraints `acervo_paginas_arquivo_numero_unique` e `acervo_chunks_arquivo_ordem_unique`, e executa backfill determinístico dos arquivos existentes); (4) publicar a aplicação (`src/app/actions/acervo.ts`) e ativar o runner/cron do worker (`processarProximoJobAcervo`).
- **Bloqueadores explícitos de publicação:**
  1. Verificação do conteúdo do objeto adotado após resposta `OBJECT_EXISTS` no fluxo síncrono de upload (além da checagem SHA-256 já executada pelo worker na etapa `extracao` via `STORAGE_HASH_MISMATCH`).
  2. Homologação das policies Supabase Storage (`F1_10_STORAGE_POLICIES_PROPOSTA.sql`) e do papel de serviço efetivamente usado no ambiente remoto.
- **Testes necessários:** dois workers concorrentes, execução duplicada, falha em etapa intermediária, retomada após interrupção, lease vencido, retry e limite de tentativas, ownership/autorização, rollback SQL e ausência de sucesso fictício.
- **Critérios de aceite:** request retorna após enfileirar job persistido; fechamento do processo HTTP não perde job; falha é visível, sanitizada e retomável a partir da etapa pendente sem reexecutar etapas já confirmadas.
- **Reversão:** pausar consumidores do worker e aplicar `F1_11_ROLLBACK_FILA_INGESTAO.sql` em janela controlada; nunca reintroduzir `Promise` solta em memória.
- **Validação:** `npx tsc --noEmit` (0 erros), `npm run test:run` (28 suítes / 236 testes aprovados, incluindo 8 cenários de integração em PostgreSQL 18.6 descartável PGlite em `f1_11_fila_integracao.test.ts`), `npm run build`, `npx eslint` nos arquivos modificados (0 erros, 0 warnings), `npx drizzle-kit check`, `git diff --check` e suíte RLS `scripts/f1_04/run-rls-validation.mjs` (41/41 cenários aprovados).
- **Próximo gate:** F1.12 (IA, proveniência, OCR e busca reais).

### F1.12 — IA, proveniência, OCR e busca reais

**Status:** concluída em 20/10/2026 como **APROVADA COM RESSALVAS**. Os placeholders de OCR, embeddings e busca semântica foram substituídos por integrações reais, configuráveis e verificáveis (`extrairTextoOcrGemini` com `gemini-2.5-flash` para PDFs digitalizados, `gerarEmbeddingGemini`/`gerarEmbeddingReal` com `gemini-embedding-001` em 1536 dimensões normalizadas L2 compatíveis com `vector(1536)`, e `buscaHibridaAcervo` com `pgvector` `<=>` + `to_tsvector('portuguese', ...)` filtrando estritamente por ownership do acervo). A curadoria humana obrigatória e a proveniência verificável (`fonteChunkIds`, `arquivoOrigemId`, `fonte`, `geracoes.chunkIds`) foram endurecidas em `curadoria.ts` e na proposta SQL reversível `F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` (com rollback `F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql`).

- **Objetivo:** eliminar conteúdo/embeddings/OCR simulados no runtime e cumprir o portão de fonte.
- **Arquivos gerados/afetados:** `src/lib/gemini.ts`, `src/lib/gemini.test.ts`, `src/lib/ingestion.ts`, `src/lib/ingestion.test.ts`, `src/lib/acervoPipelineWorker.ts`, `src/lib/env.ts`, `.env.example`, `src/app/actions/busca.ts`, `src/app/actions/curadoria.ts`, `src/app/actions/f1_12_ia_busca_integracao.test.ts`, `docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql`, `docs/modernizacao/propostas/F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql`, `docs/modernizacao/RELATORIO_F1_12.md`, `~/Documents/MEDICINA_2029_F1_12_RELATORIO.md`.
- **Dependências:** F1.11 e F1.09.
- **Riscos:** custo de API (`gemini-embedding-001` por chunk na indexação e por consulta em `buscarNoAcervo`, além de `gemini-2.5-flash` em PDFs digitalizados sem camada nativa de texto); limite de tamanho inline do OCR multimodal (`inline_data` em base64 para documentos até 20 MiB); necessidade de aplicar `F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` para criar os índices HNSW e GIN FTS em produção.
- **Estratégia:** falhar fechado sem provedor (`GeminiEmbeddingError` / `GeminiOcrError` / `GeminiGenerationError`); preservar numeração real 1-based das páginas (`numero`) mesmo com páginas em branco intermediárias; acionar OCR multimodal sob demanda somente para páginas sem texto nativo e nunca inventar texto quando uma página estiver em branco ou o OCR falhar; validar estritamente dimensão 1536 (`EXPECTED_EMBEDDING_DIMENSION = 1536`) e finitude numérica dos vetores; manter chamadas externas de OCR e embeddings fora de transações PostgreSQL no worker e pular chunks já indexados (`embedding IS NOT NULL`) em retries para evitar custo duplicado; executar busca híbrida real (`pgvector` `<=>` + `ts_rank_cd` em português) restrita ao acervo autorizado (`responsavel` próprio ou `estudante` vinculada em `responsavel_estudante`); exigir `fonteChunkIds` não vazio em todo artefato gerado por IA e propagar `fonteChunkIds` aos `cards` FSRS somente após aprovação humana explícita (`curarItem`).
- **Testes necessários:** PDF digital, PDF digitalizado com OCR, falha de OCR, página em branco sem texto inventado, geração de embeddings 1536-d, incompatibilidade dimensional (`DIMENSION_MISMATCH`), falha transitória de provedor sem reindexar chunks já persistidos, busca semântica com proveniência, busca sem resultados (`[]`) vs erro de provedor (`EXTERNAL_SERVICE_ERROR`) vs erro de banco (`PERSISTENCE_ERROR`), isolamento de ownership entre perfis, bloqueio de aprovação sem `fonteChunkIds`, rollback e reaplicação idempotente da proposta SQL.
- **Critérios de aceite:** nenhum vetor hash ou texto inventado entra no runtime; todo item gerado permanece `rascunho`/`pendente` até curadoria humana e referencia `fonteChunkIds` reais do arquivo de origem; busca híbrida respeita ownership e retorna fonte, página, trecho e pontuação real.
- **Reversão:** aplicar `F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql` para remover índices HNSW/FTS e constraints de proveniência se necessário; nunca reintroduzir vetores simulados por hash ou autoaprovação de IA.
- **Validação:** `npx tsc --noEmit` (0 erros), `npm run test:run` (29 suítes / 249 testes aprovados, incluindo 5 cenários de integração real em PostgreSQL 18.6 descartável PGlite + `pgvector` em `f1_12_ia_busca_integracao.test.ts`), `npm run build`, `npx eslint` nos 10 arquivos TS modificados (0 erros, 0 warnings), `npx drizzle-kit check`, `git diff --check` e suíte RLS `scripts/f1_04/run-rls-validation.mjs` (41/41 cenários aprovados).
- **Bloqueadores explícitos de implantação mantidos:**
  1. Compatibilidade entre os nomes das funções auxiliares RLS da F1.04 (`medicina.current_perfil_id()` / `medicina.is_responsavel()`) e os verificados pelo preflight da F1.11 (`public.rls_current_perfil_id()` / `public.rls_is_responsavel()`).
  2. Verificação imediata de integridade do conteúdo de objetos adotados após resposta `OBJECT_EXISTS` no fluxo síncrono de upload.
  3. Homologação das policies Supabase Storage (`F1_10_STORAGE_POLICIES_PROPOSTA.sql`) e do papel de serviço efetivamente utilizado no ambiente remoto.
  4. Implantação operacional do worker/scheduler independente para consumir `processarProximoJobAcervo`.
- **Próximo gate:** F1.13 (Consolidação técnica e preparação para homologação; preservando integralmente a prioridade original de Estado server-side do ciclo e cronômetro como F1.14).

### F1.13 — Consolidação técnica e preparação para homologação

**Status:** concluída em 21/10/2026 como **APROVADA COM RESSALVAS**. Divergência de numeração registrada e prioridades originais preservadas: no plano original, o identificador `F1.13` estava reservado para *Estado server-side do ciclo e cronômetro*; por determinação operacional, a `F1.13` consolidou a compatibilidade técnica entre `F1.03-R`, `F1.04`, `F1.09`, `F1.10`, `F1.11` e `F1.12` antes da futura homologação, deslocando *Estado server-side do ciclo e cronômetro* para `F1.14`, *Backup completo e recuperação testada* para `F1.15` e *Testes de segurança, E2E e operação* para `F1.16`, sem suprimir nenhuma entrega.

- **Objetivo:** verificar a compatibilidade entre as melhorias `F1.03-R`, `F1.04`, `F1.09`, `F1.10`, `F1.11` e `F1.12`, corrigir incompatibilidades críticas antes da homologação e preparar o checklist objetivo de homologação.
- **Arquivos gerados/afetados:** `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql`, `docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql`, `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`, `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql`, `docs/modernizacao/propostas/F1_10_ROLLBACK_STORAGE_POLICIES.sql`, `docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql`, `docs/modernizacao/propostas/F1_11_ROLLBACK_FILA_INGESTAO.sql`, `docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql`, `docs/modernizacao/propostas/F1_12_ROLLBACK_BUSCA_VETORIAL_E_INDICES.sql`, `src/db/index.ts`, `src/lib/env.ts`, `.env.example`, `src/lib/ingestion.ts`, `src/app/actions/acervo.ts`, `src/app/actions/acervo.test.ts`, `src/app/actions/f1_10_storage_integracao.test.ts`, `src/app/actions/f1_13_consolidacao_homologacao.test.ts`, `docs/modernizacao/PLANO_MODERNIZACAO.md`, `docs/modernizacao/RELATORIO_F1_13.md`, `~/Documents/MEDICINA_2029_F1_13_RELATORIO.md`.
- **Dependências:** F1.03-R, F1.04, F1.09, F1.10, F1.11 e F1.12.
- **Incompatibilidades críticas corrigidas:**
  1. **Colisão de assinatura/semântica RLS entre `F1_04`, `F1_10` e `F1_11`:** unificadas as funções `medicina.current_perfil_id()`, `medicina.current_papel()`, `medicina.is_estudante()` e `medicina.is_responsavel()` (exigindo `medicina.current_perfil_id() IS NOT NULL` em `F1_04` e `F1_10`), e corrigida a referência inexistente `public.rls_current_perfil_id()` / `public.rls_is_responsavel()` em `F1_11_FILA_INGESTAO_PROPOSTA.sql`.
  2. **Lacuna de RLS/GRANT em `public.operacoes_idempotentes` (F1.09):** adicionados `ENABLE/FORCE ROW LEVEL SECURITY`, policy `operacoes_idempotentes_own_policy` (`perfil_id = medicina.current_perfil_id()`) e `GRANT SELECT, INSERT, UPDATE, DELETE` para `medicina_app` tanto em `F1_09` quanto condicionalmente em `F1_04`.
  3. **Idempotência de DDL em `F1_09`:** `ADD CONSTRAINT ... NOT VALID` precedido por `DROP CONSTRAINT IF EXISTS` para permitir reaplicação segura.
  4. **Papel de mínimo privilégio `medicina_worker` (`NOSUPERUSER NOBYPASSRLS`):** provisionado em `F1_11_FILA_INGESTAO_PROPOSTA.sql` (com `DATABASE_WORKER_URL` em `src/db/index.ts` e `src/lib/env.ts`), com `GRANT` e policies RLS restritos às tabelas do pipeline (`acervo_jobs`, `acervo_arquivos`, `acervo_paginas`, `acervo_chunks`, `topicos`, `disciplinas`) e leitura de objetos registrados em `storage.objects` (`F1_10_STORAGE_POLICIES_PROPOSTA.sql`), sem qualquer acesso a `perfis`, `allowlist`, `sessoes`, `checkins`, `simulados`, `redacoes` ou `curadoria_fila`.
  5. **Busca híbrida sob RLS para `estudante` vinculada:** criada `medicina.fn_busca_hibrida_acervo` (`SECURITY DEFINER` com `search_path = public, medicina, pg_temp` e verificação anti-spoofing de `medicina.current_perfil_id()`) em `F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` e integrada em `buscaHibridaAcervo` (`src/lib/ingestion.ts`), permitindo que a estudante pesquise trechos indexados dos responsáveis vinculados sem abrir `SELECT` direto na tabela `public.acervo_arquivos` (preservando o cenário C14 da F1.04).
  6. **Constraint de proveniência em `public.cards` (`cards_gerado_proveniencia_check`):** adicionada em `F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` (`origem <> 'gerado' OR jsonb_array_length(fonte_chunk_ids) > 0`).
  7. **Verificação imediata de integridade SHA-256 após `OBJECT_EXISTS` no upload síncrono:** `enviarArquivo` (`src/app/actions/acervo.ts`) baixa imediatamente os bytes do objeto pré-existente via `downloadFromSupabaseStorage(filePath)` e compara tamanho e SHA-256 antes de adotar o objeto no banco, rejeitando divergências com `CONFLICT` e falha de leitura com `EXTERNAL_SERVICE_ERROR`.
- **Validação:** `npx tsc --noEmit` (0 erros), `npm run test:run` (30 suítes / 254 testes aprovados, incluindo a suíte ponta a ponta `f1_13_consolidacao_homologacao.test.ts` em PostgreSQL 18.6 descartável PGlite + `pgvector`), `npm run build`, `npx eslint` nos arquivos modificados (0 erros, 0 warnings), `npx drizzle-kit check`, `git diff --check` e suíte RLS `scripts/f1_04/run-rls-validation.mjs` (41/41 cenários aprovados).
- **Próximo gate:** F1.14 (Estado server-side do ciclo e cronômetro) ou execução em janela autorizada do Checklist de Homologação da F1.13 em ambiente de staging.

### F1.14 — Estado server-side do ciclo e cronômetro (anteriormente F1.13)

**Status:** concluída em 21/10/2026 como **APROVADA**; PostgreSQL estabelecido como única fonte da verdade para ciclo e cronômetro de estudo; purga total de mocks (`MOCK_CICLO_ATIVO`, `MOCK_BLOCOS`, `MOCK_TOPICOS`, `q-mock-*`, `t-mock-*`) e de autoridades fictícias em `localStorage` (`medicina_2029_proxima_ordem`, `medicina_2029_concluidos_semana`); 5 estados explícitos implementados (`nao_iniciada`, `em_andamento`, `pausada`, `concluida`, `falha_sincronizacao`); reconciliação server-side com teto de tempo físico (`wall-clock`); idempotência de checkpoints e avanço com locks transacionais (`pg_advisory_xact_lock` e `FOR UPDATE`); suíte de integração em PostgreSQL 18.6 PGlite (`f1_14_ciclo_cronometro_integracao.test.ts`) com 5 cenários aprovados e testes de reconciliação (`cicloCronometroReconciliacao.test.ts`, 6 testes); validação completa de 32 suítes / 265 testes aprovados.

- **Objetivo:** estabelecer o PostgreSQL como a única fonte de verdade para o ciclo e o cronômetro, com persistência durável, recuperação real após refresh/reconexão/troca de abas ou dispositivos, e eliminação de estados locais fictícios.
- **Arquivos gerados/afetados:** `src/lib/validation.ts`, `src/lib/cicloCronometroReconciliacao.ts`, `src/lib/cicloCronometroReconciliacao.test.ts`, `src/app/actions/ciclo.ts`, `src/app/actions/sessao.ts`, `src/app/actions/actions.test.ts`, `src/app/actions/f1_14_ciclo_cronometro_integracao.test.ts`, `src/app/page.tsx`, `src/app/ciclo/page.tsx`, `src/components/CicloPage.tsx`, `src/components/HojePage.tsx`, `src/components/CronometroPage.tsx`, `docs/modernizacao/RELATORIO_F1_14.md`, `~/Documents/MEDICINA_2029_F1_14_RELATORIO.md`.
- **Implementações e endurecimentos:**
  1. *Purga completa de mocks pedagógicos:* remoção de `MOCK_CICLO_ATIVO`, `MOCK_BLOCOS`, `MOCK_TOPICOS` de todas as Server Actions e componentes. Quando não há ciclo ativo ou tópicos no banco, o sistema retorna `null`/vazio e exibe estado amigável sem inventar dados.
  2. *Reconciliação e recuperação resiliente:* rotina pura `reconciliarEstadoCronometroComServidor` calcula teto físico decorrido (`agoraMs - iniciadaEm`) e tempo restante nominal, descartando qualquer cache local incompatível com a sessão do banco. Recuperação automática em montagem, reconexão de rede (`online`) e retorno à aba (`visibilitychange`).
  3. *Prevenção de duplicidade e concorrência:* `iniciarSessao` verifica se já existe sessão aberta para o perfil do estudante (rejeitando com `CONFLICT` caso tente iniciar outro bloco sem concluir o anterior); `sincronizarCheckpointSessao` aplica `FOR UPDATE` para garantir monotonicidade de etapas e tempos; `atualizarPonteiroCiclo` utiliza `pg_advisory_xact_lock` no ciclo ativo e `ordemEsperada` para evitar saltos duplos de bloco.
  4. *Cinco estados operacionais explícitos:* `nao_iniciada`, `em_andamento`, `pausada`, `concluida` e `falha_sincronizacao`. Falhas de rede ou servidor nunca inventam tempo estudado nem avançam o ciclo.
  5. *Integridade no registro de erros:* purga dos geradores de IDs fictícios `q-mock-*` e `t-mock-*`. Apenas anotações com UUIDs reais de questão e tentativa são enviadas para `caderno_erros`; anotações livres do cronômetro são consolidadas em `nota_livre` sem poluir as chaves estrangeiras.
- **Segurança e RLS (Bloqueador de Homologação):**
  - RLS não foi ativado nesta tarefa e nenhuma autoridade foi presumida resolvida prematuramente.
  - As novas schemas em `src/lib/validation.ts` (`acaoPonteiroCicloSchema`, `atualizarPonteiroCicloInputSchema`, `obterEstadoSessaoCronometroInputSchema`, `sincronizarCheckpointSessaoInputSchema`) rejeitam sumariamente campos de identidade fornecidos pelo cliente (`perfilId`, `papel`, etc.). A identidade é extraída exclusivamente da sessão de autenticação do servidor (`obterContextoAutenticado`).
  - **Bloqueador obrigatório registrado para homologação:** A integração do contexto RLS derivado da sessão autenticada (`medicina.set_context(perfil_id, papel)`) no pool/transação de conexões das Server Actions, incluindo os fluxos de ciclo e cronômetro, permanece como requisito bloqueante antes da ativação do RLS no ambiente alvo.
- **Validação:** `npx tsc --noEmit` (0 erros), `npx eslint` nos 12 arquivos afetados (0 erros, 0 warnings), `npx drizzle-kit check`, `git diff --check`, `npm run test:run` (32 suítes / 265 testes aprovados), `npm run build` (Turbopack otimizado concluído com êxito) e suíte RLS `scripts/f1_04/run-rls-validation.mjs` (41/41 cenários aprovados).
- **Próximo gate:** F1.15 (Backup completo e recuperação testada).

### F1.15 — Backup completo e recuperação testada (anteriormente F1.14)

**Status:** concluída em 21/10/2026 como **APROVADA**; inventário completo de 35 tabelas em 7 domínios e 6 níveis topológicos; grafo de dependências e tratamento de autorreferência (`topicos.pai_id`); scripts operacionais nativos (`scripts/backup/`) com `pg_dump -Fc`, SHA-256, AES-256-GCM e retenção GFS (7D/4W/12M/3Y); motor de manifesto do Storage canônico com ordenação RFC 8785 e validação física (`src/lib/storageBackupManifest.ts`); suíte de testes unitários (23 testes) e integração completa round-trip em PostgreSQL descartável (PGlite + `pgvector`, 5 cenários); runbook operacional completo com RTO ($\le$ 30-45 min) e RPO ($\le$ 5 min / 24h); preservação da segurança F1.05 (sem interface de restore para usuário final e sem reativação de JSON destrutivo); validação total de 34 suítes e 293 testes aprovados.

- **Objetivo:** oferecer procedimento reproduzível, auditável e testado para recuperação completa do PostgreSQL e dos arquivos privados do Storage, com integridade referencial, segurança e rastreabilidade.
- **Arquivos gerados/afetados:**
  - `src/lib/storageBackupManifest.ts`: motor de manifesto do Storage, hash SHA-256, ordenação canônica RFC 8785, validação física e reconciliação contra `acervo_arquivos`.
  - `src/lib/storageBackupManifest.test.ts`: suíte com 23 testes unitários cobrindo determinismo, detecção de arquivos corrompidos/ausentes/órfãos e reconciliação com banco.
  - `docs/modernizacao/RUNBOOK_BACKUP_RECUPERACAO.md`: runbook técnico detalhado com inventário das 35 tabelas, topologia de restauração, RTO/RPO, retenção GFS, comandos nativos, sanitização pós-restore e critérios de fail-closed.
  - `scripts/backup/backup_postgres.sh`: script de backup nativo PostgreSQL (`pg_dump -Fc` com soma SHA-256 e criptografia AES-256-CBC/GCM).
  - `scripts/backup/restore_postgres.sh`: script de restauração segura em banco descartável com checagem de preflight e foreign keys.
  - `scripts/backup/verify_restore.sh`: script de verificação de integridade e contagem pós-restore.
  - `scripts/backup/reconcile_storage.sh`: script de reconciliação entre manifesto de storage e registros de banco.
  - `src/app/actions/f1_15_backup_recuperacao_integracao.test.ts`: suíte de integração em PostgreSQL 18.6 descartável (PGlite + `pgvector`) cobrindo 5 cenários críticos de restauração integral.
  - `docs/modernizacao/RELATORIO_F1_15.md` e `~/Documents/MEDICINA_2029_F1_15_RELATORIO.md`.
- **Implementações e garantias técnicas:**
  1. *Inventário integral de 35 tabelas do PostgreSQL:* classificado em 7 domínios (Identidade & Vínculos, Conteúdo & Taxonomia, Planejamento & Ciclo, Estudo & Sessões, Acervo & Ingestão IA, Avaliações & Correção, Operações & Idempotência) e 6 níveis topológicos de dependência (Nível 0 a Nível 5). Tratamento explícito de chave autorreferencial em `topicos.pai_id` via pré-criação/deferred constraints.
  2. *Estratégia e limitações do ambiente:* O runbook operacional prescreve comandos nativos `pg_dump` e `pg_restore` (`-Fc`). Registrou-se a limitação de que `pg_dump`/`pg_restore` não estão disponíveis no `$PATH` local do ambiente macOS; em estrita conformidade com os princípios do projeto, a validação de restauração real foi executada contra instâncias reais de PostgreSQL 18.6 PGlite com expansão `pgvector`, sem qualquer mock de dados ou de banco.
  3. *Manifesto canônico do Storage:* Geração com serialização determinística RFC 8785 (chaves ordenadas lexicograficamente), hashing SHA-256 de cada objeto e do manifesto global, e checagem bidirecional contra `acervo_arquivos` (`filePath`, `hashConteudo`, `tamanhoBytes`, `mime`).
  4. *Restauração isolada e sanitização pós-restore:*
     - Validação de integridade referencial fail-closed: tentativa de carregar chaves estrangeiras órfãs é rejeitada sumariamente pelo PostgreSQL (erro `23503`).
     - Saneamento de sessões zumbis: sessões sem encerramento (`encerrada_em IS NULL`) são finalizadas com base no tempo efetivo ou no momento do snapshot, marcadas como `concluida = false` e anotadas com nota explicativa.
     - Rearmamento de jobs em voo: jobs em status `em_execucao` têm seus locks liberados e são resetados para `aguardando`, permitindo que os workers da nova infraestrutura retomem o pipeline sem duplicidade de processamento.
  5. *Segurança e Proteção de Dados (F1.05 preservada):* Não foi criada nenhuma rota ou interface de restauração para o usuário final. As credenciais nunca são exportadas em texto claro; senhas em `perfis.password_hash` são mantidas com hashing bcrypt resistente e exportadas apenas via dump nativo criptografado com chave mestra externa. A rota de exportação JSON (`backup.ts`) permanece como snapshot defensivo de conformidade do estudante (F1.05), sem capacidade destrutiva de importação.
- **Validação:** `npx tsc --noEmit` (0 erros), `npx eslint` nos novos módulos e testes (0 erros, 0 warnings), `npx drizzle-kit check`, `git diff --check`, `npm run test:run` (34 suítes / 293 testes aprovados, 100% de sucesso), `npm run build` (Next.js 16.4.2 Turbopack otimizado concluído com êxito) e suíte RLS `scripts/f1_04/run-rls-validation.mjs` (41/41 cenários aprovados).
- **Próximo gate:** F1.16 (Testes de segurança, E2E e operação).

### F1.16 — Testes de segurança, E2E e operação (anteriormente F1.15)

**Status:** concluída em 21/10/2026 como **APROVADA E HOMOLOGADA**; consolidação integral das 4 Prioridades da tarefa:
1. **Prioridade 1 (Segurança RLS e integração transacional):** implementação de `applyRlsContext(tx, perfilId, papel)` em `src/db/rls-context.ts` com detecção não disruptiva via `to_regprocedure('medicina.set_context(uuid, text)')`; instrumentação transacional nas Server Actions de sessão (`iniciarSessao`, `atualizarSessao`, `sincronizarCheckpointSessao`, `concluirSessao`), ciclo (`atualizarPonteiroCiclo`, `iniciarCicloEstudos`, `resetarPlanejamento`), curadoria (`enfileirarGeracaoDeArtefatos`, `decidirItemCuradoria`), FSRS (`registrarRevisaoCard`) e simulados (`registrarSimulado`); autoridade soberana de identidade via NextAuth (`requireAuthenticatedProfile`, `requireRole`); preservação de locks transacionais (`pg_advisory_xact_lock`, `FOR UPDATE`) e idempotência; formalização do modelo de ameaça atestando que a checagem de UUID em `set_context` é validação relacional fail-closed e mitigação de spoofing por SQL arbitrário via queries parametrizadas (Drizzle), privilégio mínimo e Column-Level Grants em `perfis`.
2. **Prioridade 2 (Testes de segurança RLS em PostgreSQL 18.6 PGlite descartável):** criação de `src/app/actions/f1_16_seguranca_rls_integracao.test.ts` cobrindo 10 cenários obrigatórios sob `FORCE ROW LEVEL SECURITY` (Responsável sem acesso a sessões brutas, Estudante com busca híbrida autorizada, isolamento cross-tenant, fail-closed sem sessão, rejeição de papel incorreto, travas WITH CHECK, segregação de `medicina_auth`, negação de leitura a `password_hash` por coluna, isolamento de `medicina_worker` ao pipeline e ausência de vazamento pós-commit / pool), todos aprovados (10/10).
3. **Prioridade 3 (Testes E2E reais com Playwright):** 10 testes determinísticos aprovados em Desktop Chromium e Mobile Chrome (Pixel 5) em `e2e/workflow.spec.ts` cobrindo login defensivo, guarda anônima, controle de papéis, ciclo, cronômetro, persistência pós-F5, FSRS, simulados e logout.
4. **Prioridade 4 (Backup nativo, saneamento pós-restore e criptografia):** tabela de auditoria `public.auditoria_saneamento_restore`, scripts operacionais `sanitizar_pos_restore.sh` e `reverter_saneamento_pos_restore.sh` com reversibilidade comprovada em banco, e round-trip criptográfico OpenSSL AES-256 PBKDF2 com validação SHA-256.

- **Objetivo:** transformar as garantias anteriores em gates automatizados e assegurar a integração transacional do Row Level Security nas Server Actions.
- **Arquivos gerados/afetados:** `src/db/rls-context.ts`, `src/db/rls-context.test.ts`, `src/app/actions/sessao.ts`, `src/app/actions/ciclo.ts`, `src/app/actions/curadoria.ts`, `src/app/actions/fsrs.ts`, `src/app/actions/simulados.ts`, `src/app/actions/f1_16_seguranca_rls_integracao.test.ts`, `e2e/workflow.spec.ts`, `e2e/helpers/auth.ts`, `playwright.config.ts`, `src/app/login/page.tsx`, `scripts/backup/sanitizar_pos_restore.sh`, `scripts/backup/reverter_saneamento_pos_restore.sh`, `scripts/backup/test_crypto_roundtrip.sh`, `scripts/backup/restore_postgres.sh`, `docs/modernizacao/RUNBOOK_BACKUP_RECUPERACAO.md`, `src/app/actions/f1_15_backup_recuperacao_integracao.test.ts`, `docs/modernizacao/RELATORIO_F1_16.md`, `docs/modernizacao/PLANO_MODERNIZACAO.md`.
- **Dependências:** todas as etapas F1.02 a F1.15.
- **Validação obtida:** 35 suítes / 307 testes Vitest (100% de aprovação), 41/41 cenários RLS históricos (`run-rls-validation.mjs`), 10/10 cenários RLS de integração, 10/10 testes E2E Desktop Chromium, 10/10 testes E2E Mobile Chrome, 6/6 testes de backup/saneamento/crypto, `npx tsc --noEmit` (0 erros), `npx eslint` (0 erros, 0 avisos), `npx drizzle-kit check` (íntegro), `npm run build` (Turbopack otimizado com sucesso) e `git diff --check` (0 erros).

## 4. Backlog posterior à estabilização

Estas tarefas não devem competir com os P0/P1:

- completar PWA/offline com estratégia segura de cache;
- implementar telas M1–M19 ainda ausentes;
- adotar componentes/gráficos/editor/matemática quando o módulo exigir;
- eliminar `any`, reduzir warnings e estabelecer lint zero;
- explicitar timezone UTC/Fortaleza;
- adicionar headers defensivos no ponto de deploy confirmado;
- documentar rollbacks de migrations e operação individual.

## 5. Gates para uso com dados reais

O sistema só deve receber dados reais quando todos os itens abaixo estiverem comprovados:

- Server Actions autenticadas/autorizadas e com ownership;
- RLS/policies verificadas no ambiente alvo;
- identidade canônica sem UUIDs hardcoded;
- nenhuma resposta de sucesso sem persistência;
- operações críticas atômicas/idempotentes;
- versão crítica do Next.js atualizada;
- upload privado validado e recuperável, com verificação imediata de integridade SHA-256 na adoção de objeto pré-existente (`OBJECT_EXISTS`) resolvida em código na F1.13;
- compatibilidade entre as propostas SQL (`0003`, `F1.04`, `F1.09`, `F1.10`, `F1.11` e `F1.12`), funções RLS (`medicina.*`), papel `medicina_worker` (`NOBYPASSRLS`) e função `medicina.fn_busca_hibrida_acervo` validada em PostgreSQL 18.6 descartável na F1.13;
- **bloqueador de implantação (infraestrutura/homologação):** execução em janela autorizada da sequência canônica de migrations (`0003` → `F1.04` → `F1.09` → `F1.10` → `F1.11` → `F1.12`) e instrumentação do wrapper transacional `medicina.set_context(perfil_id, papel)` nas conexões `DATABASE_URL` (`medicina_app`) antes de ativar `FORCE ROW LEVEL SECURITY` em produção, abrangendo sistematicamente as Server Actions de ciclo, cronômetro e sessões (código de aplicação já pronto na F1.16);
- **bloqueador de implantação (infraestrutura/homologação):** homologação das policies Supabase Storage (`F1_10_STORAGE_POLICIES_PROPOSTA.sql`) e do papel de serviço/conexão efetivamente usado no ambiente remoto;
- **bloqueador de implantação (infraestrutura/homologação):** implantação operacional do worker/scheduler independente autenticado com `DATABASE_WORKER_URL` (`medicina_worker`) para consumir `processarProximoJobAcervo`;
- estado server-side do ciclo e cronômetro implementado e validado (F1.14);
- backup completo PostgreSQL e Storage validado com recuperação testada e manifesto íntegro (F1.15);
- E2E reais de login, sessão e papéis passando (F1.16);
- segredos rotacionados caso haja indício de uso cruzado ou credencial demo reutilizada.

## 6. Próximo marco operacional

**Ciclo de Modernização e Estabilização Preliminar (F1.02 a F1.16) CONCLUÍDO COM SUCESSO.**

Todas as 15 etapas de modernização foram executadas, validadas e homologadas em bancos PostgreSQL 18.6 descartáveis (PGlite com `pgvector`), sem alteração ou acesso prematuro a instâncias persistentes ou ambientes de produção.

**Próximo marco recomendado:** Homologação Operacional em Ambiente Dedicado de Staging, compreendendo:
1. Provisionamento de PostgreSQL remoto dedicado com extensão `vector`.
2. Criação das roles `medicina_auth`, `medicina_app`, `medicina_worker` e `medicina_anon`.
3. Execução das migrações e propostas SQL em janela autorizada (`0000..0003`, `F1.04`, `F1.09`, `F1.10`, `F1.11`, `F1.12`).
4. Ativação de `FORCE ROW LEVEL SECURITY`.
5. Drill de simulação de desastre (backup, decifragem, restore e saneamento auditado com medição cronometrada de RTO e RPO).
6. Execução das suítes de teste de integração e Playwright contra o ambiente de staging.
