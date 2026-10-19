# Medicina 2029 — Auditoria Técnica Inicial

**Tarefa:** F1.01 — Auditoria Técnica Inicial

**Fase:** 1 — Confiabilidade e Segurança

**Data da auditoria:** 18 de outubro de 2026

**Escopo:** repositório local entregue; análise estática, comparação com `ESPEC.md` e verificações não destrutivas

**Regra observada:** nenhum código-fonte, schema, migration, configuração de produção ou dado de usuário foi alterado

## 1. Resumo executivo

O projeto já possui uma base funcional ampla: Next.js App Router, TypeScript estrito, Drizzle, modelo relacional abrangente, NextAuth, componentes para os principais módulos, FSRS, ingestão, curadoria, dashboards e testes unitários. O build de produção e a checagem TypeScript concluíram com sucesso.

O estado atual, porém, **não é confiável nem seguro para operação com dados reais**. Os principais bloqueadores são:

1. Server Actions não autenticam nem autorizam o chamador na própria fronteira operacional. A separação de papéis depende principalmente de páginas e da navegação.
2. O repositório não versiona políticas RLS; a conexão Drizzle usa acesso PostgreSQL direto sem identidade por usuário. Isso não prova que o serviço externo não tenha políticas manuais, mas deixa a proteção sem garantia reproduzível.
3. Backup e restauração são expostos por Server Actions sem guarda administrativa. O export inclui o registro completo de perfis, e o restore pode apagar a base inteira.
4. O `perfilId` usado em quase todas as operações não corresponde ao `perfis.id` gerado pelo seed. O código confunde `authUserId` com a chave primária, quebrando FKs e isolamento.
5. Sessões, check-ins e outros fluxos transformam falhas de banco em respostas de sucesso com dados simulados. A interface pode afirmar que salvou algo que nunca foi persistido.
6. O ciclo e o cronômetro têm duas fontes de verdade: PostgreSQL e `localStorage`. O progresso pode divergir entre navegador, abas e dispositivos.
7. O pipeline de acervo pode retornar sucesso sem armazenar o arquivo e executa trabalho longo numa Promise solta dentro da requisição.
8. Geração, embeddings, OCR, métricas, notas e análises de simulados contêm simulações de runtime apresentadas como dados reais.
9. A versão instalada do Next.js foi reportada pelo `npm audit` dentro de faixas com vulnerabilidades críticas; há 5 vulnerabilidades de runtime e 18 no total.
10. Os sete testes E2E são placeholders. A suíte unitária executou 48 testes, mas falhou globalmente porque os quatro testes de acervo não chegaram a ser coletados.

**Conclusão:** antes de ampliar funcionalidades, a próxima tarefa deve fechar as fronteiras de autorização, eliminar os falsos sucessos e restaurar uma única identidade/fonte de verdade para persistência.

## 2. Escopo, método e limitações

### 2.1 Verificações realizadas

- Leitura integral da estrutura de `src`, `drizzle`, `e2e`, configurações e `ESPEC.md`.
- Inventário de páginas, componentes, Server Actions, rota de API, schema, migrations e testes.
- Busca por autenticação, autorização, IDs fixos, mocks, fallbacks, `localStorage` e tratamento de erros.
- Execução não destrutiva de TypeScript, lint, testes unitários, build e auditoria de dependências.
- Revisão paralela independente de arquitetura/especificação, segurança e persistência/testes.

### 2.2 Ações deliberadamente não realizadas

- Não foram executados migrations, seeds, restore, limpeza de banco, E2E ou testes que pudessem gravar dados.
- Não foram consultados dados reais nem serviços externos com credenciais.
- Não foram alteradas variáveis de ambiente, configurações de produção ou dependências.
- Não foi realizado deploy, commit ou push.

### 2.3 Limitações

- O diretório entregue não contém metadados `.git`; não foi possível verificar histórico, tracking anterior de segredos ou diff contra uma revisão-base.
- Políticas e configurações existentes apenas no painel do Supabase/Vercel não foram auditadas. A ausência no repositório é tratada como **falta de configuração versionada**, não como prova definitiva de inexistência externa.
- Não houve acesso autorizado a catálogo PostgreSQL/Supabase remoto, buckets, logs, WAF, rate limiting externo ou backups reais.

## 3. Estado atual da arquitetura

### 3.1 Tecnologias e versões

| Camada | Implementação encontrada |
|---|---|
| Runtime local auditado | Node.js 24.21.0; npm 11.19.0 |
| Framework | Next.js 16.2.12, App Router |
| UI | React/React DOM 19.2.4; Tailwind CSS 4.3.3 |
| Linguagem | TypeScript 5.9.3, `strict: true`, `noEmit: true` |
| Autenticação | NextAuth 4.24.15, Credentials Provider, JWT |
| ORM/banco | Drizzle ORM 0.45.2; Drizzle Kit 0.31.10; postgres-js 3.4.9; PostgreSQL/pgvector |
| Supabase | `@supabase/supabase-js` 2.111.0, usado no Storage |
| IA | Gemini via `fetch`; fallback determinístico interno |
| Fila | pg-boss 12.26.4 instalado, sem uso encontrado |
| PDF/OCR | pdf-parse 2.4.5; pdfjs-dist 6.2.108 e tesseract.js 7.0.0 instalados, mas não efetivamente usados no pipeline principal |
| Repetição espaçada | ts-fsrs 5.4.1 |
| Testes | Vitest 4.1.10; Playwright 1.62.1 |

Fontes: `package.json:17-46`, `package-lock.json`, `tsconfig.json:2-24`.

### 3.2 Organização

- `src/app`: 15 páginas App Router, 15 módulos de Server Actions e uma rota HTTP explícita de autenticação.
- `src/components`: 16 componentes, em sua maioria clientes, responsáveis pelas telas e interações.
- `src/db`: conexão Drizzle, schema e seed.
- `src/lib`: regras de negócio, ingestão, integração com IA, mocks e Storage.
- `drizzle`: três migrations SQL e snapshots.
- `e2e`: uma suíte Playwright.
- `public`: manifest e assets.

Rotas principais: `/`, `/estudar`, `/ciclo`, `/revisao`, `/caderno-erros`, `/redacoes`, `/simulados`, `/busca`, `/lacunas`, `/acervo`, `/curadoria`, `/responsavel`, `/como-usar`, `/login`; `/dashboard` redireciona para `/`.

### 3.3 Páginas, componentes e operações

As páginas server-side carregam dados por Server Actions e entregam componentes React. Somente `/acervo`, `/curadoria` e `/responsavel` verificam o papel no servidor (`src/app/acervo/page.tsx:9-14`, `src/app/curadoria/page.tsx:9-14`, `src/app/responsavel/page.tsx:9-14`). A navbar oculta essas rotas para estudante (`src/components/NavBar.tsx:325-330`), mas isso não protege as Server Actions.

O único endpoint API explícito é `src/app/api/auth/[...nextauth]/route.ts`. As demais operações são Server Actions em `src/app/actions`, incluindo sessão, ciclo, FSRS, redações, simulados, acervo, curadoria, dashboard, responsável, backup e restore.

### 3.4 Autenticação e autorização

O Credentials Provider consulta `perfis.email`, compara hash bcrypt e emite JWT com `id` e `role`. A sessão tem duração de 30 dias (`src/app/api/auth/[...nextauth]/route.ts:8-71`). O middleware exige uma sessão para quase todas as rotas (`src/middleware.ts:1-13`).

A autorização por papel é incompleta e não é aplicada nas operações. Não há helper central como `requireUser`/`requireRole`, nem ownership nas queries por ID. O papel é usado na UI e em três pages, mas não nas actions administrativas.

### 3.5 Banco e persistência

O schema contém aproximadamente 31 tabelas e cobre a maior parte das entidades da especificação: perfis, currículo, ciclos, sessões, conteúdo, FSRS, questões, erros, redações, simulados, bem-estar, acervo, gerações e curadoria. `pgvector` é declarado com 1536 dimensões (`src/db/schema.ts:3-17`) e a extensão aparece na primeira migration.

As migrations são somente forward. Não foram encontrados rollbacks, índices HNSW/textuais, views agregadas/materializadas nem políticas RLS versionadas. Campos e tabelas de associação importantes carecem de constraints de unicidade, checks ou FKs (`src/db/schema.ts:226-241`, `273-287`, `311-316`).

### 3.6 Supabase e armazenamento

O SDK Supabase é usado apenas no Storage (`src/lib/supabaseStorage.ts:1-49`). Banco e autenticação usam Drizzle/NextAuth diretamente. Existe função para URL assinada, mas nenhum chamador foi encontrado. O bucket e suas políticas externas não foram inspecionados.

O upload tolera falha do Storage e continua o pipeline (`src/app/actions/acervo.ts:51-85`). Portanto, o banco pode registrar um caminho para um objeto inexistente.

### 3.7 Gemini, ingestão e recuperação

`src/lib/gemini.ts` chama Gemini 2.5 Flash e, em falha ou ausência de chave, gera conteúdo simulado. A classificação de chunks é feita por interseção de palavras; embeddings são vetores pseudoaleatórios derivados de hash; a busca chamada de híbrida usa somente distância pgvector. O pipeline aceita PDF em base64 e a paginação é aproximada por form-feed.

O processamento é iniciado por Promise não aguardada na requisição (`src/app/actions/acervo.ts:77-80`); pg-boss não é usado. Não há job durável, retry persistido ou retomada idempotente.

### 3.8 Deploy e PWA

`next.config.ts` está vazio. O README é o boilerplate do Create Next App. Não foram encontrados `vercel.json`, Dockerfile ou workflow CI versionados. Isso não exclui configuração externa no painel Vercel.

Há `public/manifest.json`, porém não foram encontrados service worker, cache offline ou estratégia de sincronização. A PWA é nominal, não offline.

## 4. Auditoria de segurança

Cada item abaixo registra arquivo/função, risco, evidência, gravidade e correção mínima recomendada.

### SEC-01 — Backup/restore sem autorização e com dados sensíveis — P0

- **Arquivo/função:** `src/app/actions/backup.ts:58-86`, `exportarDadosCompletos`; `:94-158`, `restaurarDadosCompletos`.
- **Risco:** exfiltração de dados privados e hashes de senha; alteração de papéis/contas; apagamento ou corrupção total da base.
- **Evidência:** export seleciona `perfis` integralmente; restore faz deletes globais e reinsere JSON fornecido pelo chamador. Não há sessão, papel, reautenticação, validação de schema, limite ou dry-run.
- **Correção:** mover restore para fluxo operacional controlado; guarda de responsável mais reautenticação; excluir hashes; schema versionado e validado; limite, checksum/assinatura, dry-run, auditoria e teste em base temporária.

### SEC-02 — Ausência de autorização nas Server Actions e de ownership — P0

- **Arquivos/funções:** todas as actions; casos críticos em `backup.ts`, `acervo.ts`, `curadoria.ts`, `ciclo.ts`, `sessao.ts`, `fsrs.ts`, `responsavel.ts`.
- **Risco:** estudante pode acionar operações administrativas; um usuário pode ler ou alterar registros por IDs arbitrários; conteúdo pode ser aprovado/rejeitado sem papel adequado.
- **Evidência:** actions não chamam `getServerSession`; `enviarArquivo` e `iniciarSessao` aceitam `perfilId` do cliente; atualizações usam somente `id`, sem `perfil_id`.
- **Correção:** helper server-only deny-by-default, derivação de perfil pela sessão, role guard na primeira linha e filtro de ownership em toda query/mutação.

### SEC-03 — RLS não versionada e conexão sem identidade por usuário — P0

- **Arquivos:** `drizzle/*.sql`, `drizzle/meta/0002_snapshot.json`, `src/db/index.ts:5-8`.
- **Risco:** qualquer falha na aplicação passa a ter alcance de todas as linhas/tabelas.
- **Evidência:** migrations não contêm `ENABLE ROW LEVEL SECURITY` nem `CREATE POLICY`; snapshots registram RLS desabilitada/policies vazias; conexão PostgreSQL direta não propaga claims.
- **Correção:** verificar catálogo remoto com credencial read-only em tarefa autorizada; versionar RLS/policies, usar role de mínimo privilégio e views agregadas; testar matriz estudante/responsável. A evidência local não prova ausência de configuração externa manual.

### SEC-04 — Next.js em faixa com advisories críticos — P0

- **Arquivo:** `package.json:23`, lockfile.
- **Risco:** RCE, SSRF, cache poisoning ou divulgação conforme superfície e plataforma de deploy.
- **Evidência:** `npm audit --omit=dev` reportou 1 vulnerabilidade crítica e 4 altas de runtime; o audit completo reportou 18 no total.
- **Correção:** upgrade patch isolado para versão corrigida indicada pelo audit, rebuild, testes de regressão e nova auditoria. Confirmar a versão estável aplicável no momento da correção.

### SEC-05 — Possível envio de chave de provedor ao endpoint errado — P0

- **Arquivo/função:** `src/lib/gemini.ts:24-49`, `gerarArtefatosGeminiComFallback`.
- **Risco:** divulgação de credencial de outro provedor para Google e logs de URL.
- **Evidência:** a função escolhe `GEMINI_API_KEY` ou, na ausência, `ANTHROPIC_API_KEY`, mas sempre chama endpoint Gemini com o valor na query string.
- **Correção:** separar estritamente provedores/variáveis; nunca reutilizar chave; preferir header suportado; redigir logs e rotacionar a chave se o cenário já ocorreu.

### SEC-06 — Credenciais fixas no seed — P0 condicional

- **Arquivo:** `src/db/seed.ts:31-50`.
- **Risco:** contas previsíveis se o seed ou as mesmas credenciais forem usados fora de ambiente descartável.
- **Evidência:** duas senhas em claro são embutidas e hasheadas pelo seed. Os valores não são reproduzidos neste relatório.
- **Correção:** exigir segredos por ambiente/secret manager, abortar sem configuração, usar senhas únicas e marcar/proteger o seed como local; rotacionar qualquer credencial já reutilizada.

### SEC-07 — Separação estudante/responsável incompleta — P1

- **Arquivos:** rotas de estudo sem role guard; `/lacunas`; actions de leitura/mutação.
- **Risco:** responsável pode acessar granularidade diária ou dados da estudante; estudante pode acessar material/fila administrativa.
- **Evidência:** middleware checa apenas sessão; `/lacunas` não é protegida apesar de ser M15 do responsável; leituras de erros, redações, simulados e acervo não validam papel/propriedade.
- **Correção:** matriz explícita de acesso, guards em pages e actions, views agregadas para responsável e filtro `status='aprovado'` para estudante.

### SEC-08 — Allowlist não é independente — P1

- **Arquivos:** `src/app/api/auth/[...nextauth]/route.ts:16-43`; migration inicial relacionada a allowlist.
- **Risco:** qualquer perfil adicional com e-mail/hash válido autentica; restore pode ampliar acesso.
- **Evidência:** login aceita qualquer linha de `perfis`; a função SQL de allowlist encontrada não está ligada por trigger e os registros não coincidem com o seed.
- **Correção:** definir uma única fonte de verdade, normalizar e-mail, aplicar allowlist no servidor e no banco, restringir privilégios e testar terceiro endereço.

### SEC-09 — Upload ilimitado e não validado no servidor — P1

- **Arquivo/função:** `src/app/actions/acervo.ts:18-30`, `enviarArquivo`; `src/lib/ingestion.ts:14-18`.
- **Risco:** exaustão de memória/CPU, abuso de Storage, parser de PDF exposto a bytes malformados e object keys inadequadas.
- **Evidência:** base64 arbitrário vira Buffer integral; não há limite server-side, magic bytes, extensão/nome sanitizado, quota ou timeout; MIME é forçado para PDF.
- **Correção:** upload streaming/presigned, limite no servidor/proxy, detecção por magic bytes, nome gerado no servidor, limites de página/tempo, sandbox/scan quando aplicável e rate limit.

### SEC-10 — Validação runtime e constraints insuficientes — P2

- **Arquivos:** `checkin.ts`, `simulados.ts`, `redacoes.ts`, `responsavel.ts`, `sessao.ts`, `schema.ts`.
- **Risco:** métricas inválidas, divisão por zero, payloads enormes, datas e faixas inconsistentes.
- **Evidência:** tipos TypeScript são usados como única validação; não há schema runtime central; snapshots mostram ausência de checks relevantes.
- **Correção:** schemas runtime nos boundaries, limites de texto/array/número/data e checks/uniques/FKs no banco por migrations pequenas.

### SEC-11 — Login sem contenção local de brute force — P2

- **Arquivo:** `src/app/api/auth/[...nextauth]/route.ts:16-35`.
- **Risco:** tentativa automatizada e possível enumeração por mensagens distintas.
- **Evidência:** não há rate limit/backoff/lockout no repositório; mensagens internas distinguem conta inexistente de senha inválida.
- **Correção:** resposta uniforme, rate limit por conta e origem, backoff/alerta e testes. Verificar WAF/edge externo antes de concluir ausência total.

### SEC-12 — JWT longo sem revalidação/revogação — P2

- **Arquivo:** `src/app/api/auth/[...nextauth]/route.ts:47-71`.
- **Risco:** sessão permanece válida após revogação ou troca de papel até expirar.
- **Evidência:** id/role são gravados no login e usados por 30 dias sem token version/status.
- **Correção:** versão de token/status do usuário, revalidação periódica e reautenticação em operações críticas.

### SEC-13 — Respostas expõem mensagens internas — P2

- **Arquivos:** várias actions, incluindo `backup.ts:155-157`, `acervo.ts:87-92`, `curadoria.ts:298-301`, `simulados.ts:146-148`.
- **Risco:** divulgação de detalhes de constraints, infraestrutura e fornecedores.
- **Evidência:** `error.message` é retornado ao cliente.
- **Correção:** mensagem pública genérica e correlation ID; detalhe apenas em log estruturado com redaction.

### SEC-14 — Headers defensivos não versionados — P3

- **Arquivo:** `next.config.ts:1-7`.
- **Risco:** proteção menor contra framing, sniffing, referrer leakage e injeções.
- **Evidência:** não há CSP, `frame-ancestors`/X-Frame-Options, nosniff, Referrer/Permissions Policy ou HSTS no repo.
- **Correção:** verificar edge/proxy externo e depois definir/testar headers no ponto correto.

## 5. Auditoria dos dados e simulações

### 5.1 A — Dados legítimos de demonstração

- `src/db/seed.ts:31-391`: perfis, disciplinas, tópicos, gêneros e ciclos deliberadamente iniciais.
- São aceitáveis apenas em ambiente explicitamente local/demo. O seed é destrutivo e contém credenciais fixas, portanto não pode ser usado em produção como está.
- `src/lib/mocks.ts` poderia apoiar showcase isolado, mas hoje é importado pelo runtime e, por isso, passa à categoria C.

### 5.2 B — Dados de testes

- Fixtures e mocks nos dez arquivos `*.test.ts`.
- São isolados no runner e, em princípio, legítimos.
- Limitação: muitos mocks são permissivos e verificam apenas forma/retorno, permitindo falsos positivos. Exemplo: teste de resolver erro inexistente espera sucesso.

### 5.3 C — Simulação indevida no funcionamento real

| Local | Simulação | Impacto |
|---|---|---|
| `actions/ciclo.ts:25-31,65-88` | ciclo/tópicos mock em base vazia ou erro | indisponibilidade parece funcionamento normal |
| `actions/sessao.ts:33-37,68-82,197-212` | IDs e entidades de sessão fabricados | perda silenciosa de histórico e progresso |
| `actions/checkin.ts:30-45` | `sucesso:true` após falha | bem-estar fica só no navegador |
| `actions/dashboard.ts:102-107,202-205,225-362` | métricas e séries plausíveis inventadas | decisões pedagógicas baseadas em dados falsos |
| `actions/lacunas.ts:88-121` | lacunas mockadas | prioridades de estudo/acervo enganosas |
| `actions/redacoes.ts:27-90,121-137` | gêneros/repertórios e nota fixa | indicador acadêmico contaminado |
| `actions/simulados.ts:102-139` | nota estimada simples, tópicos fracos mock e análise concluída | trava pedagógica é anulada; métricas falsas |
| `actions/responsavel.ts:103-171` | quinzenas e revisão trimestral aproximadas | painel do responsável não reflete a realidade |
| `lib/ingestion.ts:23-39,186-250` | OCR apenas rotulado e embedding hash | recuperação e confiança sem significado semântico |
| `lib/gemini.ts:83-138` | material genérico inventado | conteúdo pode ser aprovado sem base real |
| `HojePage.tsx:56-59` | contador semanal inicia em valor fictício | aderência local artificial |
| `CronometroPage.tsx:282-313` | IDs de questão/tentativa mock | conclusão falha depois de alteração parcial |

## 6. Auditoria da persistência

### 6.1 Defeito estrutural de identidade — P0

`perfis.id` é aleatório e `authUserId` é outro campo (`src/db/schema.ts:74-81`). O seed fixa apenas `authUserId` (`src/db/seed.ts:37-50`), enquanto as actions usam esses valores fixos como `perfilId` FK. Isso afeta sessão, check-in, redação, simulados, FSRS, dashboard, responsável, curadoria e acervo.

**Impacto:** inserts falham por FK; leituras consultam um perfil inexistente; fallbacks mascaram a falha. A correção deve derivar o `perfis.id` real da sessão no servidor.

### 6.2 Matriz de persistência

| Área | Estado observado | Risco |
|---|---|---|
| Sessões | tabelas e CRUD existem; perfil incorreto; falso sucesso; conclusão sem transação | P0 |
| Ciclos | estrutura persiste; ponteiro também existe em `localStorage`; controles locais não sincronizam | P1 |
| Cronômetro | tempo restante/execução ficam só em `localStorage`; servidor recebe etapas/final | P1 |
| Caderno de erros | listagem/resolução existem; cadastro usa referências fictícias que violam FKs | P1/P0 no fluxo de sessão |
| Flashcards | FSRS persistido; criação por curadoria usa perfil incorreto e sem fonte | P1 |
| Revisões | card é atualizado antes do log, sem transação; UI ignora falha | P0 |
| Simulados | múltiplos inserts sem transação; análise já nasce fictícia e concluída | P0/P1 |
| Redações | insert existe; perfil incorreto e nota simulada gravada como real | P1 |
| Acervo | metadados/chunks persistem; Storage opcional; job efêmero; OCR/embedding simulados | P0/P1 |
| Indicadores | queries existem, mas erros/base vazia viram números plausíveis | P1 |

### 6.3 Transações e consistência

- `concluirSessao` atualiza sessão, grava erros e avança ponteiro sem transação (`src/app/actions/sessao.ts:108-196`). Um erro intermediário deixa sessão concluída, sem erros e sem avanço.
- FSRS atualiza o card e depois grava o histórico sem transação (`src/app/actions/fsrs.ts:94-127`).
- Simulado, áreas e análise são inseridos separadamente (`src/app/actions/simulados.ts:72-139`).
- Curadoria publica artefato, pode criar card e só depois atualiza a fila (`src/app/actions/curadoria.ts:206-296`).

Esses fluxos precisam de transação, idempotência e testes de rollback/concor­rência.

### 6.4 `localStorage`

Chaves de negócio: `medicina_2029_proxima_ordem`, `medicina_2029_concluidos_semana`, `medicina_2029_cronometro_estado` e `medicina_2029_checkin_<data>`. O tema é a única preferência local legítima.

Problemas:

- não há namespace por usuário, versão de schema, TTL ou validação robusta;
- duas abas podem divergir;
- troca/limpeza de dispositivo perde o estado;
- valores são adulteráveis;
- o ponteiro do banco pode divergir do ponteiro local;
- o cronômetro reaberto pode ignorar novos parâmetros e retomar estado obsoleto.

O servidor deve ser a autoridade; `localStorage` deve ser apenas cache otimista versionado, com reconciliação.

### 6.5 Backup e restauração — P0

O export omite `cicloEstado`, `questaoTopicos`, `simuladoQuestoes`, todas as tabelas `acervo_*`, `geracoes` e os objetos do Storage. A ordem de delete/insert do restore conflita com FKs: erros e tentativas, ciclos/estado e sessões/blocos. O teste usa um backup mínimo e não verifica round-trip real.

O backup atual não satisfaz recuperação de desastre e cria falsa segurança. Deve ser redesenhado com manifesto versionado, arquivos, hashes, validação prévia, ordem topológica e teste integral em base descartável.

## 7. Divergências relevantes em relação ao `ESPEC.md`

| Requisito | Implementação atual | Gravidade |
|---|---|---|
| Supabase Auth + allowlist de duas contas | NextAuth Credentials; qualquer perfil válido autentica | P1 |
| RLS em todas as tabelas e views agregadas | não há policies/RLS versionadas; conexão direta | P0 |
| Responsável sem acesso a dados brutos | enforcement por UI/pages; queries brutas no servidor | P1 |
| Jobs longos em pg-boss | Promise em request; pg-boss sem uso | P1 |
| Anthropic API | Gemini, com nomes “Claude” em UI/dados | P1/P3 |
| Sem conteúdo sem fonte | `fonteChunkIds` omitido; fallback inventa conteúdo | P1 |
| Embeddings reais + HNSW + busca textual | embedding hash, sem HNSW/tsvector | P1 |
| OCR real e visão em baixa confiança | texto curto apenas rotulado como OCR | P2 |
| Upload multi-formato, limites 200 MB/800 páginas | PDF base64 sem validação server-side | P1 |
| Cronômetro persistido no servidor | estado operacional em `localStorage` | P1 |
| Etapa registro não pulável | ação manual permite finalizar na etapa de registro sem exigir registro | P1 |
| Simulado pendente até análise de 2h | análise mock já nasce concluída em 30 min | P1 |
| Backup semanal completo, incluindo acervo | manual, incompleto e sem objetos | P0/P1 |
| PWA offline | apenas manifest | P2 |
| M1–M19 | várias telas ausentes ou parciais | P2 |
| Métricas em views/funções SQL | cálculos TS e fallbacks mock | P2 |
| Shadcn, Recharts, TipTap, KaTeX | não encontrados nas dependências | P2 |
| Sem `any` | uso amplo em produção e testes | P3 |
| Migrations reversíveis | somente migrations forward | P2 |
| Timezone Fortaleza/UTC | timestamps sem timezone explícita e borda sem `timeZone` fixa | P2 |
| README operacional | README boilerplate | P2 |

Conformidades relevantes: App Router; TypeScript strict; Drizzle e migrations versionadas; pgvector com dimensão fixa; schema amplo; JWT de 30 dias; estados rascunho/aprovado; curadoria explícita; função de URL assinada; regras unitárias de ciclo/aderência/divergência.

## 8. Auditoria dos testes e verificações executadas

### 8.1 Resultados

| Verificação | Resultado |
|---|---|
| `npx tsc --noEmit --pretty false` | **PASSOU**, sem saída de erro |
| `npm run build` | **PASSOU**; 15 rotas geradas; aviso deprecando a convenção `middleware` |
| `npm run lint` | **FALHOU**: 199 problemas, sendo 144 erros e 55 avisos |
| `npm run test:run` | **FALHOU globalmente**: 9 suítes passaram, 1 falhou antes da coleta; 48 testes passaram |
| `npm audit --omit=dev --json` | 5 vulnerabilidades de runtime: 1 crítica e 4 altas |
| `npm audit --json` | 18 vulnerabilidades: 1 crítica, 11 altas e 6 moderadas |
| Playwright E2E | não executado; os 7 casos são placeholders e poderiam depender de ambiente/dados |

### 8.2 Cobertura existente

Há 10 arquivos Vitest e 52 casos declarados:

- regras de ciclo, aderência, divergência, trava de simulado, conclusão e fonte;
- segmentação, extração básica e embedding mock;
- actions de ciclo/sessão, backup, curadoria, dashboard, FSRS, redações, responsável e acervo.

Quatro testes de acervo não rodaram porque `src/lib/supabaseStorage.ts` instancia o cliente sem uma chave configurada durante a importação.

### 8.3 Limitações da cobertura

- Os sete E2E usam somente `expect(true).toBe(true)`.
- Não há provider nem threshold de cobertura.
- Mocks de banco são permissivos e não verificam FKs, transações, ownership ou RLS.
- O teste de privacidade verifica nomes de exports, não o conteúdo retornado.
- FSRS não é comparado a casos conhecidos.
- Não há testes negativos por papel, payload inválido, upload excessivo, restore malicioso ou falha intermediária.

### 8.4 Testes prioritários

1. Matriz anônimo/estudante/responsável para toda Server Action.
2. RLS real em PostgreSQL para sessões brutas, conteúdo rascunho e views agregadas.
3. Integração com `perfis.id` real e FKs.
4. Rollback/idempotência de sessão, FSRS, simulado, curadoria e backup.
5. Falha de banco/Storage/IA nunca retorna sucesso mock.
6. Sincronização do cronômetro e ciclo entre abas/dispositivos.
7. E2E real de login, sessão+erro+ponteiro, revisão, upload/job, curadoria e simulado pendente.
8. Upload não-PDF, oversized e arquivo malformado.
9. Backup/restore round-trip completo em ambiente descartável.
10. Dashboard em base vazia, com dados reais e com indisponibilidade.

## 9. Classificação consolidada

### P0 — Crítico

- Backup/restore sem autorização, incompleto e capaz de apagar toda a base.
- Server Actions sem guarda/ownership e RLS não versionada.
- Confusão `authUserId` × `perfis.id` quebrando FKs e isolamento.
- Falsos sucessos em sessão/check-in com perda silenciosa.
- Conclusão de sessão, FSRS e simulados sem atomicidade.
- Storage pode falhar e a aplicação ainda registrar sucesso.
- Next.js em faixa com advisories críticos.
- Possível envio de chave de provedor ao endpoint errado.
- Credenciais fixas no seed, caso reutilizadas fora de ambiente descartável.

### P1 — Alto

- Separação de papéis incompleta; IDOR em ações por ID.
- Pipeline sem fila durável e geração síncrona.
- Conteúdo gerado/embedding/análise acadêmica simulados em runtime.
- `localStorage` como fonte concorrente para ciclo e cronômetro.
- Caderno manual estruturalmente incompatível com FKs.
- Simulado automaticamente “analisado”; redação recebe nota fictícia.
- Upload sem validação/limite e backup sem arquivos do acervo.
- Busca semântica e OCR não reais.

### P2 — Médio

- Validação runtime/constraints insuficientes.
- Leitores confundem erro com lista vazia.
- Rate limiting e revogação não demonstrados.
- PWA, módulos, métricas SQL, timezone e documentação operacional incompletos.
- Migrations sem rollback demonstrado.

### P3 — Baixo

- 144 erros de lint e 55 avisos.
- Uso amplo de `any`.
- Dependências sem uso e nomenclatura inconsistente Gemini/Claude.
- Headers defensivos não versionados.

## 10. Recomendações imediatas

1. Suspender uso com dados reais e qualquer deploy público até fechar P0.
2. Corrigir primeiro autorização/ownership/RLS e isolar restore.
3. Unificar identidade em torno do `perfis.id` resolvido da sessão.
4. Remover falsos sucessos e mocks de runtime antes de evoluir funcionalidades.
5. Tornar sessão/FSRS/simulado/curadoria atômicos.
6. Atualizar Next.js em tarefa isolada, com regressão.
7. Depois, tornar Storage e pipeline duráveis e rastreáveis.

O plano detalhado e reversível está em `docs/modernizacao/PLANO_MODERNIZACAO.md`.

## 11. Confirmação de integridade da tarefa

- Nenhum arquivo de código do aplicativo foi alterado.
- Nenhuma migration, seed, restauração, limpeza ou operação destrutiva foi executada.
- Nenhuma dependência foi instalada ou atualizada durante esta auditoria.
- Nenhuma variável de ambiente ou configuração de produção foi alterada.
- Nenhum segredo é reproduzido neste relatório.
- Os únicos arquivos criados são os documentos autorizados desta tarefa e a cópia solicitada na pasta Documentos.

## 12. Próxima tarefa recomendada

**F1.02 — Fechamento das fronteiras de autorização e identidade.**

Escopo proposto: criar guards server-side reutilizáveis, derivar o perfil da sessão, aplicar autorização/ownership em todas as Server Actions, bloquear backup/restore para estudante e preparar a matriz de RLS sem ainda ampliar funcionalidades.

Não executar F1.02 sem aprovação explícita.

## 13. Atualização controlada após a F1.02 — 19/10/2026

A tarefa F1.02 implementou a contenção de autenticação, papel e ownership no nível da aplicação. Esta seção preserva o diagnóstico histórico da F1.01 e registra somente a mudança de estado dos riscos.

### Riscos mitigados ou contidos

- As 37 Server Actions agora exigem autenticação ou papel explicitamente no servidor.
- O papel é reconsultado em `perfis`; a claim JWT não é a autoridade final.
- `perfis.id` passou a ser a identidade canônica de runtime para as FKs.
- IDs de perfil foram removidos dos inputs de upload e início de sessão.
- Sessão, card, erro e acervo receberam filtros de ownership.
- Estudante não executa backup, restore, acervo, curadoria, lacunas ou acompanhamento.
- Responsável não executa ações pessoais de estudo.
- Login e erros alterados usam mensagens públicas genéricas.
- Falsos sucessos de sessão e check-in foram removidos.

### Riscos que permanecem abertos

- RLS/policies externas não foram verificadas ou versionadas.
- Backup ainda contém dados de autenticação e restore continua destrutivo quando autorizado.
- Não existe relação responsável–estudante no schema; a compatibilidade atual exige exatamente uma estudante.
- Dados históricos não foram inspecionados; não há conclusão sobre eventual associação anterior por UUID incorreto.
- Ciclo, repertórios e revisões trimestrais não possuem ownership completo no schema.
- Busca, validação de payloads, atomicidade, Storage e pipeline mantêm os riscos descritos na F1.01.
- O lint global continua falhando; E2E continuam placeholders.

### Evidência de validação da F1.02

- TypeScript: passou.
- Vitest: 12 arquivos e 71/71 testes passaram.
- Build: passou.
- Lint dirigido dos módulos novos: passou.
- Lint global: falhou com 172 ocorrências (126 erros e 46 avisos), dívida preexistente.
- Nenhuma migration, seed, operação em dados reais, deploy, commit ou push foi executado.

O relatório completo está em `docs/modernizacao/RELATORIO_F1_02.md`.
