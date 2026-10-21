# Medicina 2029 — Plano de Modernização

**Origem:** Auditoria F1.01

**Princípio:** menor alteração segura possível; sem refatoração ampla sem necessidade

**Estado:** F1.02 a F1.10 executadas; F1.03-M reprovou a proposta monolítica; F1.03-R, F1.07, F1.08, F1.09 e F1.10 foram aprovadas com ressalvas; nenhuma etapa desta sequência acessou ou alterou produção

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
F1.13 Estado server-side do ciclo/cronômetro
          ↓
F1.14 Backup completo e recuperação
          ↓
F1.15 Testes de segurança/E2E e operação
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

- **Objetivo:** eliminar conteúdo/embeddings/OCR simulados no runtime e cumprir o portão de fonte.
- **Arquivos potencialmente afetados:** `gemini.ts`, `ingestion.ts`, `curadoria.ts`, schema de gerações/chunks, migrations de índices.
- **Dependências:** F1.11 e F1.09.
- **Riscos:** custo de API, mudança de ranking, reindexação, conteúdo legado sem fonte.
- **Estratégia:** falhar fechado sem provedor; resposta validada por schema; `fonteChunkIds` obrigatório; embeddings reais versionados; HNSW + `tsvector` pt; OCR real e visão abaixo do limiar; bloquear publicação sem fonte.
- **Testes necessários:** provider ausente, JSON inválido, prompt injection no documento, item sem fonte, relevância conhecida, página correta e OCR de amostra.
- **Critérios de aceite:** nenhum mock entra em produção; todo item publicado aponta para chunks/páginas; busca híbrida supera baseline definido.
- **Reversão:** manter índice anterior até validação; feature flag para desligar geração, não para publicar conteúdo simulado.

### F1.13 — Estado server-side do ciclo e cronômetro

- **Objetivo:** estabelecer uma única fonte de verdade e sincronização entre dispositivos.
- **Arquivos potencialmente afetados:** `CronometroPage.tsx`, `CicloPage.tsx`, `HojePage.tsx`, `sessao.ts`, `ciclo.ts`, possivelmente schema/migration de versão/checkpoint.
- **Dependências:** F1.03, F1.07 e F1.08.
- **Riscos:** sessões locais antigas; conflitos multiaba; carga de heartbeat.
- **Estratégia:** versão de sessão/checkpoint no servidor; persistência periódica e em eventos; localStorage como cache com user/session/version/TTL; reconciliação; BroadcastChannel opcional para abas.
- **Testes necessários:** refresh, offline curto, troca de dispositivo, duas abas, clock drift, limpeza do storage e retomada.
- **Critérios de aceite:** ponteiro e tempo convergem ao servidor; limpar navegador não perde progresso persistido; avanço ocorre uma vez.
- **Reversão:** manter leitura temporária do formato local antigo para migração; não voltar a torná-lo autoridade.

### F1.14 — Backup completo e recuperação testada

- **Objetivo:** oferecer recuperação real, incluindo acervo, sem expor segredos.
- **Arquivos potencialmente afetados:** novo módulo operacional de backup, Storage, schema de manifesto, documentação/runbook; substituição de `backup.ts`.
- **Dependências:** F1.05, F1.10 e F1.11.
- **Riscos:** custo/tempo, retenção de dados sensíveis, backup incompleto, restore destrutivo.
- **Estratégia:** manifesto versionado de todas as tabelas e objetos; hashes; criptografia autenticada; snapshot consistente; restore em base temporária; validação e promoção; agendamento semanal e retenção.
- **Testes necessários:** round-trip integral, arquivos, relações, corrupção de arquivo, versão incompatível, restore interrompido e recuperação.
- **Critérios de aceite:** amostra completa restaura com contagens/constraints/hashes iguais; credenciais não são exportadas; RTO/RPO documentados.
- **Reversão:** backups são append-only; nova versão não invalida a anterior; promoção só após validação.

### F1.15 — Testes de segurança, E2E e operação

- **Objetivo:** transformar as garantias anteriores em gates automatizados.
- **Arquivos potencialmente afetados:** testes Vitest/Playwright, configs, CI, README/runbooks; sem mudança funcional por si só.
- **Dependências:** todas as tarefas anteriores conforme o fluxo testado.
- **Riscos:** testes frágeis; E2E alterar dados compartilhados; tempo de pipeline.
- **Estratégia:** banco descartável por execução; fixtures sem credenciais fixas; E2E real desktop/mobile; threshold de cobertura para regras críticas; CI com TypeScript, lint, unitário, integração, E2E, build e audit.
- **Testes necessários:** os próprios gates, incluindo matriz de papéis, RLS, login, sessão+erro+ponteiro, FSRS conhecido, upload/job, curadoria, simulado pendente e backup round-trip.
- **Critérios de aceite:** nenhum placeholder; pipeline reproduzível; falha bloqueia merge; documentação contém setup/env/deploy/backup/pipeline sem segredos.
- **Reversão:** desabilitar temporariamente apenas teste comprovadamente flakey com issue e prazo; nunca remover gate de segurança sem substituto.

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
- upload privado validado e recuperável;
- **bloqueador de publicação (F1.10/F1.11):** verificação do conteúdo do objeto adotado após resposta `OBJECT_EXISTS` no fluxo síncrono de upload (complementando a checagem SHA-256 `STORAGE_HASH_MISMATCH` executada pelo worker na etapa `extracao`);
- **bloqueador de publicação (F1.10/F1.11):** homologação das policies Supabase Storage (`F1_10_STORAGE_POLICIES_PROPOSTA.sql`) e do papel de serviço efetivamente usado no ambiente remoto;
- backup/restore round-trip aprovado;
- E2E reais de login, sessão e papéis passando;
- segredos rotacionados caso haja indício de uso cruzado ou credencial demo reutilizada.

## 6. Próxima tarefa

**Próxima autorização recomendada: F1.12 — IA, proveniência, OCR e busca reais.**

Escopo: eliminar conteúdo, embeddings e OCR simulados no runtime, exigir `fonteChunkIds` e páginas válidas para publicação, integrar provedor real de embeddings na etapa `indexacao` do worker durável (`gerarEmbeddingReal`) e implementar busca híbrida (`HNSW` + `tsvector` em português).

A F1.11 concluiu a fila durável PostgreSQL (`public.acervo_jobs` em `F1_11_FILA_INGESTAO_PROPOSTA.sql` e rollback em `F1_11_ROLLBACK_FILA_INGESTAO.sql`) e o worker independente (`src/lib/acervoPipelineWorker.ts`) com claim atômico, lease/heartbeat, recuperação de leases expirados, retry com backoff exponencial e retomada idempotente por etapa (`extracao`, `segmentacao`, `classificacao`, `indexacao`), proibindo fallback silencioso para execução efêmera em memória e mantendo `indexacao` sem conclusão fictícia enquanto não houver provedor real de embeddings. A aplicação das propostas SQL (`F1_04`, `F1_09`, `F1_10` e `F1_11`) no ambiente remoto permanece bloqueada até janela operacional autorizada.

Não iniciar automaticamente. Aguardar aprovação explícita.
