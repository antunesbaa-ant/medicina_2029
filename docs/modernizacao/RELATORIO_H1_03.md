# RELATÓRIO H1.03 — PREFLIGHT DE ATIVAÇÃO DO STAGING
**PROJETO MEDICINA 2029**  
**Data:** 22 de Outubro de 2026  
**Responsável Técnico:** Antigravity (Advanced Agentic Architecture)  
**Status da Tarefa:** **CONCLUÍDO COM SUCESSO E HOMOLOGADO**  
**Decisão Formal:** **APTO PARA PROVISIONAMENTO MANUAL DE STAGING**  
**Classificação:** Verificação Pré-Operacional, Compatibilidade com Parsers Reais e Salvaguardas de Ativação

---

## 1. SUMÁRIO EXECUTIVO

Em atendimento rigoroso às diretrizes da tarefa **H1.03**, foi executado o ensaio completo de pré-ativação (*preflight*) do ambiente de homologação (*staging*), cobrindo todos os caminhos reais de execução do sistema, validando a correspondência estrita de identidades de projeto Supabase, integrando o parser real de PDF e garantindo que nenhuma operação de migração ou carga de dados possa ser disparada contra produção.

**Conclusão Técnica:** O sistema Medicina 2029 encontra-se **APTO PARA PROVISIONAMENTO MANUAL DE STAGING**. Todas as salvaguardas *fail-closed* foram comprovadas por testes automatizados em PostgreSQL 16.3/18.6 descartável.

> [!IMPORTANT]
> Em cumprimento às regras operacionais estritas, **nenhuma ação remota foi realizada**: nenhum serviço foi contratado, nenhum projeto remoto foi criado, nenhuma migração persistente foi executada e nenhum commit, push ou deploy foi efetuado.

---

## 2. CAMINHOS REAIS DE INICIALIZAÇÃO E ENVGUARD

O guardião de isolamento [`src/lib/envGuard.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/envGuard.ts) foi inspecionado e validado em todos os caminhos reais de inicialização do sistema:

1. **Boot do Servidor Next.js ([`src/instrumentation.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/instrumentation.ts)):** Acionado via hook `register()` no arranque do servidor. Se `APP_ENV=staging`, executa `assertStagingIsolation()` antes de aceitar qualquer requisição HTTP.
2. **Conexões de Banco de Dados ([`src/db/index.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/index.ts)):** Verifica o isolamento antes de resolver as instâncias Drizzle e instanciar os pools do `postgres.js`.
3. **Pipeline Worker ([`src/lib/acervoPipelineWorker.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/acervoPipelineWorker.ts)):** Valida o isolamento no início de `processarProximoJobAcervo`.
4. **Worker sob Demanda ([`src/lib/workerOnDemand.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/workerOnDemand.ts) e [`scripts/worker/run-on-demand.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/worker/run-on-demand.mjs)):** Executa `assertStagingIsolation()` antes de iniciar o loop de jobs.
5. **Drizzle Kit Config ([`drizzle.config.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/drizzle.config.ts)):** Integrado diretamente no carregamento da configuração. Comandos CLI como `drizzle-kit check` ou `drizzle-kit migrate` sofrem aborto imediato se invocados com `APP_ENV=staging` sem as credenciais e autorizações devidas.
6. **Runner Controlado de Migrações ([`scripts/db/migrate-staging.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/migrate-staging.mjs)):** Aplica `assertCanRunStagingMigrationsCli` e `assertCanRunStagingMigrations`, exigindo `CONFIRM_STAGING_MIGRATIONS=true`.

---

## 3. DISTINÇÃO ENTRE STAGING PUBLICADO E PRODUÇÃO REAL

Foi validado o comportamento do sistema diante das duas combinações críticas de variáveis de ambiente:

| Configuração | Interpretação do Sistema | Comportamento Implementado |
| :--- | :--- | :--- |
| `APP_ENV=staging`<br/>`NODE_ENV=production` | **Staging Publicado** (ex: build otimizado na Vercel Preview/Staging) | **Permitido sob guarda:** Executa validação integral de `envGuard`, exige `STAGING_SUPABASE_PROJECT_REF`, valida segredos com alta entropia e permite carga sintética e migrações **somente** se houver flags explícitas (`CONFIRM_STAGING_SEED=true`, `CONFIRM_STAGING_MIGRATIONS=true`). |
| `APP_ENV=production`<br/>`NODE_ENV=production` | **Produção Real** | **Bloqueio Incondicional (Fail-Closed):** `isStagingEnvironment()` retorna `false` categoricamente. Qualquer tentativa de executar `seed-staging.ts` ou `migrate-staging.mjs` é abortada imediatamente com erro `PRODUÇÃO BLOQUEADA`. Flags como `CONFIRM_STAGING_SEED=true` ou `STAGING_GUARD_ENABLED=true` são **completamente ignoradas**. |

---

## 4. CORRESPONDÊNCIA DE PROJETOS E CONEXÕES SUPABASE

Para eliminar riscos de apontamento cruzado acidental entre instâncias de banco e buckets de storage, foi criada a função `extractSupabaseDbProjectRef` em [`src/lib/envGuard.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/envGuard.ts), capaz de inspecionar URLs diretas e de pooler:

- **URLs Diretas Supabase:** `postgresql://postgres:pass@db.<project-ref>.supabase.co:5432/postgres` $\rightarrow$ extrai `<project-ref>`.
- **URLs de Connection Pooler:** `postgresql://medicina_worker.<project-ref>:pass@aws-0-sa-east-1.pooler.supabase.com:6543/postgres` $\rightarrow$ extrai `<project-ref>`.
- **Conexões Locais:** `localhost` e `127.0.0.1` $\rightarrow$ mapeadas como `local-supabase`.

### Regras de Correspondência Validadas:
1. Todas as URLs (`DATABASE_URL`, `DATABASE_APP_URL`, `DATABASE_AUTH_URL`, `DATABASE_WORKER_URL`, `SUPABASE_URL`) devem corresponder ao **mesmo** projeto de staging autorizado (`STAGING_SUPABASE_PROJECT_REF`).
2. Se qualquer URL contiver o identificador `PRODUCTION_SUPABASE_PROJECT_REF`, a inicialização é abortada com erro de violação crítica de isolamento.
3. Se qualquer URL apontar para um projeto Supabase diferente do autorizado, o preflight falha explicitamente informando o subdomínio divergente detectado.

---

## 5. PARSER REAL DE PDF E INTEGRIDADE DE DADOS

Durante os ensaios da tarefa H1.03, foi identificada e corrigida a interoperabilidade entre o motor de ingestão [`src/lib/ingestion.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/ingestion.ts) e a versão `2.4.5` da biblioteca `pdf-parse`:

- **Ajuste Técnico em `resolverPdfParserPadrao`:** Suporte dual à classe `PDFParse` do `pdf-parse` v2 (que opera sobre buffers binários `Uint8Array`) e a funções com exportação default (utilizadas em mocks legados).
- **Validação com Arquivos Didáticos Reais:** Os 3 PDFs didáticos sintéticos gerados por `createSyntheticPdfBuffer` foram submetidos à extração de texto real via `extrairTextoPDF`:
  - Extração 100% nativa (`metodo: 'nativo'`).
  - Confiança máxima (`confianca: 1.0`).
  - Zero acionamento espúrio de OCR.
  - Correspondência matemática absoluta entre os bytes do arquivo em disco/buffer, tamanho registrado e hash SHA-256 de 64 caracteres hexadecimais no banco.

---

## 6. WORKER SOB DEMANDA: DURAÇÃO, LEASE E IDEMPOTÊNCIA

A bateria de testes em PostgreSQL descartável ([`src/app/actions/h1_03_staging_preflight.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h1_03_staging_preflight.test.ts)) comprovou a robustez operacional do worker sob demanda:

1. **Interrupção por Tempo Limite:** Ao atingir o limite configurado em `maxDurationMs`, o worker encerra seu ciclo graciosamente com `motivoParada: 'tempo_limite_atingido'`.
2. **Recuperação de Lease Vencido:** Jobs que permaneceram em `em_execucao` após a expiração do lease têm seus locks limpos (`locked_by = null`, `locked_at = null`) e retornam para o status `aguardando` com backoff exponencial, preservando a `etapa_atual`.
3. **Esgotamento de Tentativas:** Jobs que atingem `tentativas >= max_tentativas` durante lease expirado são encerrados como `falhou` com código `LEASE_EXPIRED_MAX_RETRIES`.
4. **Retomada sem Duplicações:** Quando um job interrompido na etapa `segmentacao` é retomado por outro worker, as páginas já extraídas não são reprocessadas e não ocorrem inserções duplicadas em `acervo_paginas` ou `acervo_chunks`.

---

## 7. RUNNER CONTROLADO DE MIGRAÇÕES (`migrate-staging.mjs`)

Foi criado o script [`scripts/db/migrate-staging.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/migrate-staging.mjs) e registrado o comando `npm run db:migrate:staging` no [`package.json`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/package.json).

### Sequência Canônica de Migrações (9 arquivos auditados):
1. `drizzle/0000_greedy_loki.sql` (24.043 bytes — SHA-256: `b1cf8d6741894a52...`)
2. `drizzle/0001_dry_talos.sql` (238 bytes — SHA-256: `8e82452e0071ee1c...`)
3. `drizzle/0002_little_swarm.sql` (66 bytes — SHA-256: `c3ce3d3b1335bedb...`)
4. `drizzle/0003_f1_03_r_expansao.sql` (11.541 bytes — SHA-256: `32be49be0da8ed6c...`)
5. `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql` (45.414 bytes — SHA-256: `2daef35a88a7732d...`)
6. `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` (11.303 bytes — SHA-256: `96187040783e236b...`)
7. `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql` (10.113 bytes — SHA-256: `9193076ecdc51495...`)
8. `docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql` (11.579 bytes — SHA-256: `54186e37d1b1c186...`)
9. `docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` (11.421 bytes — SHA-256: `16653eb78ee00f6b...`)

Modo `--dry-run` exibe o manifesto e calcula os hashes sem tocar em nenhum banco. Modo `--apply` exige `CONFIRM_STAGING_MIGRATIONS=true`.

---

## 8. CHECKLIST MANUAL DE CONFIGURAÇÃO (PASSO A PASSO SIMPLES)

> [!NOTE]
> Este roteiro orienta o operador humano na criação e parametrização dos serviços de homologação quando a autorização formal for concedida.

### Etapa A — Supabase (Projeto de Homologação)
1. **Criar Novo Projeto:** Acesse o painel do Supabase e clique em "New Project".
   - *Nome do Projeto:* `medicina-2029-staging`
   - *Região:* `sa-east-1` (São Paulo) para menor latência.
   - *Senha do Banco:* Gere uma senha forte de pelo menos 24 caracteres e guarde-a com segurança.
   - *Anote o Project Ref:* Identificador de ~20 letras no subdomínio (ex: `abcdefghijklmnopqrst`).
2. **Criar o Bucket Privado:** No menu *Storage*, crie um bucket chamado `acervo`. Marque como **Private** (acesso público desligado).
3. **Coletar as Conexões:**
   - *DATABASE_URL:* Conexão direta ou via Session Pooler (porta 5432/6543).
   - *SUPABASE_URL:* `https://<project-ref>.supabase.co`
   - *SUPABASE_ANON_KEY:* Chave pública em *Project Settings > API*.
4. **Gate de Verificação do Banco:**
   - Teste o manifesto: `npm run db:migrate:staging -- --dry-run`
   - Aplique as migrações: `CONFIRM_STAGING_MIGRATIONS=true npm run db:migrate:staging -- --apply`
   - Aplique o seed sintético: `CONFIRM_STAGING_SEED=true npm run db:seed:staging`

### Etapa B — Google AI Studio (IA e Embeddings)
1. **Obter Chave:** Acesse [aistudio.google.com](https://aistudio.google.com) e crie uma `API Key` no plano gratuito.
2. **Modelos Utilizados:** `gemini-2.5-flash` (geração e curadoria) e `gemini-embedding-001` (embeddings 1536-d).

### Etapa C — Vercel (Hospedagem Web de Staging)
1. **Criar Ambiente Staging:** No painel da Vercel, vincule o repositório em um branch/preview dedicado ou projeto `medicina-2029-staging`.
2. **Configurar as Variáveis de Ambiente:**
   ```env
   APP_ENV=staging
   CONFIRM_ISOLATED_STAGING_ENVIRONMENT=true
   STAGING_SUPABASE_PROJECT_REF=<project-ref-do-supabase>
   DATABASE_URL=postgresql://postgres:<senha>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require
   DATABASE_APP_URL=postgresql://postgres:<senha>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require
   DATABASE_AUTH_URL=postgresql://postgres:<senha>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require
   DATABASE_WORKER_URL=postgresql://postgres:<senha>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require
   SUPABASE_URL=https://<project-ref-do-supabase>.supabase.co
   SUPABASE_ANON_KEY=<anon-key-do-supabase>
   NEXTAUTH_SECRET=<token-aleatorio-com-pelo-menos-32-caracteres>
   NEXTAUTH_URL=https://<url-gerada-pela-vercel>.vercel.app
   GEMINI_API_KEY=<chave-do-google-ai-studio>
   ```
3. **Gate de Verificação:** No deploy, os logs de boot do servidor deverão registrar a confirmação de isolamento higienizada do `envGuard`.

### Resumo de Custos a Confirmar:
- **Supabase Free Tier:** R$ 0,00 / mês (500MB banco, 1GB storage, pgvector ativo).
- **Vercel Hobby Tier:** R$ 0,00 / mês (100GB tráfego mensal para homologação).
- **Google AI Studio Free Tier:** R$ 0,00 / mês (15 requisições por minuto).
- **Custo Inicial Total de Homologação:** **R$ 0,00 (Zero Reais)**.

---

## 9. PAINEL DE VALIDAÇÃO E CONFORMIDADE

| Auditoria / Ferramenta | Escopo | Resultado |
| :--- | :--- | :--- |
| **TypeScript (`npx tsc --noEmit`)** | Tipagens estritas de todo o repositório | **0 erros** |
| **Suíte Dedicada H1.03 ([`h1_03_staging_preflight.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h1_03_staging_preflight.test.ts))** | 19 cenários de pré-ativação de staging | **19 aprovados (100%)** |
| **Vitest Global (`npm run test:run`)** | 37 arquivos de teste automatizados | **348 testes aprovados (100%)** |
| **Next.js Production Build (`npm run build`)** | Compilação Turbopack de todas as rotas | **Sucesso em 725ms** |
| **Drizzle Kit Check (`npx drizzle-kit check`)** | Integridade dos esquemas DDL e migrations | **100% íntegro (Everything's fine)** |
| **Linter ESLint (`npx eslint ...`)** | Arquivos modificados e novos | **0 erros, 0 avisos** |
| **Git Diff Check (`git diff --check`)** | Integridade de whitespace e caracteres especiais | **0 erros** |
| **Suíte RLS PostgreSQL (`run-rls-validation.mjs`)** | 41 cenários de segurança e isolamento RLS | **41 aprovados (100%)** |

---

## 10. DECISÃO FINAL E PRÓXIMOS PASSOS

- **Decisão:** **SISTEMA APTO PARA PROVISIONAMENTO MANUAL DE STAGING**.
- **Ação Imediata:** Nenhuma ação remota realizada. O sistema aguarda deliberação e autorização humana expressa para o provisionamento do projeto remoto Supabase e implantação na Vercel.
