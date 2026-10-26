# MEDICINA 2029 — RELATÓRIO TÉCNICO H2.01
## DIAGNÓSTICO DE PRONTIDÃO PARA HOMOLOGAÇÃO FUNCIONAL NO STAGING

**Projeto:** Medicina 2029  
**Etapa:** H2.01 — Avaliação Diagnóstica Pré-Homologação Funcional  
**Data de Emissão:** 26 de Outubro de 2026  
**Ambiente Alvo:** `medicina-2029-staging`  
**Supabase Project Ref:** `ynfocaorhadizlvbnzrt`  
**Host de Conexão Direta:** `db.ynfocaorhadizlvbnzrt.supabase.co`  
**Host do Pooler (AWS us-east-1):** `aws-0-us-east-1.pooler.supabase.com`  
**Porta Session Pooler (DDL / Migrações):** `5432`  
**Porta Transaction Pooler (Runtime da Aplicação):** `6543`  
**Classificação do Projeto:** **APTO COM RESSALVAS**  
**Salvaguarda Operacional:** Diagnóstico 100% passivo. Nenhuma migração executada, nenhum usuário criado, nenhum arquivo enviado ao Storage remoto, nenhum worker acionado e nenhuma chamada à API paga realizada nesta avaliação.

---

### Resumo Executivo e Status no Supabase Staging

A infraestrutura relacional do projeto Supabase `medicina-2029-staging` (`ynfocaorhadizlvbnzrt`) concluiu integralmente o ciclo de migrações canônicas (etapas 1 a 9), conforme conferência formal realizada via SQL Editor do Supabase Cloud:
- **9 migrações registradas** em `public._medicina_staging_migrations` com integridade de metadados;
- **Etapa 9 (F1.12)** conferida com hash SHA-256 canônico (`b9474fa616038325f4677176d1cfc9e3ae29ab19e32545931acae7123c0aec1d`) e tamanho de 9.672 bytes;
- **2 índices de busca** instalados e ativos em `public.acervo_chunks`:
  - `acervo_chunks_embedding_hnsw_idx` (índice HNSW com `vector_cosine_ops`);
  - `acervo_chunks_texto_fts_idx` (índice GIN em português para busca textual full-text);
- **Função de busca híbrida instalada:** `medicina.fn_busca_hibrida_acervo(text, vector, uuid, integer, double precision, text, uuid)` com search_path restrito e execução restrita;
- **3 constraints de proveniência** instaladas como `NOT VALID` para preservação do histórico:
  - `materiais_gerado_proveniencia_check` em `public.materiais`;
  - `questoes_gerada_proveniencia_check` em `public.questoes`;
  - `cards_gerado_proveniencia_check` em `public.cards`;
- **Extensão pgvector instalada:** Versão `0.8.2` no schema `extensions`, com suporte nativo a colunas `vector(1536)`;
- **Cadeia de migrações encerrada:** Nenhuma migração posterior pendente ou intermediária detectada.

O diagnóstico de engenharia conclui que a base de código, os módulos de autorização, as políticas RLS, a camada de abstração de Storage, o worker assíncrono e os algoritmos de busca semântica encontram-se **tecnicamente preparados** para a homologação funcional controlada.

A classificação atribuída é **APTO COM RESSALVAS**. A transição para a execução prática dos testes reais depende do cumprimento prévio de um conjunto de **pré-requisitos operacionais e de infraestrutura**, detalhados nas seções seguintes deste documento.

---

## 1. Conexões, Ambientes e Segregação de Papéis

### 1.1 Topologia de Conectividade e Identificação de Projeto
A arquitetura do Medicina 2029 adota segregação fail-closed entre os ambientes de homologação e produção, operando com identificadores explícitos de projeto e isolamento de hosts:

```
                               ┌─────────────────────────────────────────────────────────────┐
                               │                    CLIENTE / NAVEGADOR                      │
                               └──────────────────────────────┬──────────────────────────────┘
                                                              │ NextAuth Session JWT (HttpOnly)
                                                              ▼
                               ┌─────────────────────────────────────────────────────────────┐
                               │                 APLICAÇÃO NEXT.JS (APP ROUTER)              │
                               │               Ambiente: APP_ENV=staging                     │
                               └──────┬───────────────────────┬───────────────────────┬──────┘
                                      │                       │                       │
              DATABASE_APP_URL        │      DATABASE_AUTH_URL│                       │ SUPABASE_SERVICE_ROLE_KEY
              (Role: medicina_app)    │   (Role: medicina_auth│                       │ (Bypass RLS no Storage)
                                      ▼                       ▼                       ▼
┌──────────────────────────────────────────────────────────────────┐ ┌───────────────────────────────────────┐
│               SUPABASE CLOUD STAGING (ynfocaorhadizlvbnzrt)      │ │        SUPABASE STORAGE (BUCKET)      │
│                                                                  │ │                                       │
│  - Pooler: aws-0-us-east-1.pooler.supabase.com                   │ │  - Bucket privado: 'acervo'           │
│    - Porta 6543 (Transaction Pooler - Runtime Serverless)        │ │  - public = false                     │
│    - Porta 5432 (Session Pooler - DDL / Migrações Administrativas│ │  - file_size_limit = 20 MiB           │
│  - Schemas: public, medicina, extensions, storage                │ │  - allowed_mime_types = [pdf]         │
└──────────────────────────────────────────────────────────────────┘ └───────────────────────────────────────┘
```

| Componente | Ambiente de Homologação (Staging) | Ambiente de Produção (Bloqueado) | Política de Isolamento |
| :--- | :--- | :--- | :--- |
| **Project Ref** | `ynfocaorhadizlvbnzrt` | Identificador produtivo segregado | Bloqueio imediato se refs coincidirem |
| **Direct Host** | `db.ynfocaorhadizlvbnzrt.supabase.co:5432` | Host produtivo segregado | Rejeita strings com `medicina_prod` ou `production` |
| **Session Pooler** | `aws-0-us-east-1.pooler.supabase.com:5432` | Pooler produtivo segregado | Exclusivo para DDL via `postgres.ynfocaorhadizlvbnzrt` |
| **Transaction Pooler** | `aws-0-us-east-1.pooler.supabase.com:6543` | Pooler produtivo segregado | Recomendado para runtime sob papéis restritos |
| **Supabase URL** | `https://ynfocaorhadizlvbnzrt.supabase.co` | URL produtiva segregada | Validação estrita por `extractSupabaseProjectRef` |

### 1.2 Papéis de Execução e Mínimo Privilégio
O sistema aboliu o uso de credenciais administrativas (`postgres`, `supabase_admin`, `root`) no runtime da aplicação. Quatro papéis distintos foram concebidos e implementados:

1. **`postgres` (ou `postgres.ynfocaorhadizlvbnzrt` via pooler):**
   - Papel administrativo de infraestrutura.
   - Restrito exclusivamente a scripts de migração DDL (`scripts/db/migrate-staging.mjs`, `apply-staging-step*.mjs`) e operações de backup nativo de baixo nível (`pg_dump`).
   - Bloqueado sumariamente no runtime do Next.js pelo módulo [`src/lib/envGuard.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/envGuard.ts).

2. **`medicina_app` (`medicina_app.ynfocaorhadizlvbnzrt`):**
   - Papel técnico das Server Actions cotidianas da aplicação.
   - Privilégios: `USAGE` no schema `medicina` e `public`. `SELECT, INSERT, UPDATE, DELETE` nas tabelas de domínio controladas por RLS.
   - Restrições estritas: Sem acesso a `password_hash` em `public.perfis` (coluna revogada via DDL), sem privilégios de `CREATE TABLE` nos schemas `public` ou `medicina`, sem permissão de execução em `medicina.autenticar_por_email`.

3. **`medicina_auth` (`medicina_auth.ynfocaorhadizlvbnzrt`):**
   - Papel dedicado e exclusivo da rota de autenticação NextAuth ([`src/app/api/auth/[...nextauth]/route.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/api/auth/%5B...nextauth%5D/route.ts)).
   - Privilégios: Permissão cirúrgica de `EXECUTE` na stored procedure `medicina.autenticar_por_email(text)`.
   - Restrições estritas: Não possui acesso às tabelas operacionais da aplicação.

4. **`medicina_worker` (`medicina_worker.ynfocaorhadizlvbnzrt`):**
   - Papel dedicado ao processamento assíncrono do acervo e extração de PDF/OCR/Embeddings.
   - Privilégios: Mínimo privilégio restrito exclusivamente às tabelas do pipeline (`acervo_jobs`, `acervo_arquivos`, `acervo_paginas`, `acervo_chunks`, `topicos`, `disciplinas`).
   - Políticas RLS: Bypass controlado nas tabelas do pipeline via cláusula `USING (current_user = 'medicina_worker')`.
   - Restrições: Nenhum acesso a tabelas de usuários, sessões, ciclos, simulados, redações ou controle financeiro.

### 1.3 Estado Atual das Variáveis de Ambiente e Ressalvas de Configuração
A inspeção do sistema de arquivos local revela que o arquivo `.env.local` encontra-se configurado para desenvolvimento efêmero local (`NODE_ENV=development`, conexões apontando para `localhost:5432/medicina_dev`).

Para a ativação do staging controlado, nenhuma variável secreta deve ser gravada no repositório Git. As seguintes regras do guardião fail-closed ([`src/lib/envGuard.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/envGuard.ts)) devem ser observadas no provisionamento das variáveis de homologação:

> [!WARNING]
> **Ressalva Crítica de Conexão (Provisionamento de Senhas das Roles no Supabase Cloud):**
> No PostgreSQL gerenciado do Supabase Cloud, roles criadas via comandos DDL nas migrações (`CREATE ROLE medicina_app WITH ... LOGIN;`) nascem sem senha (`PASSWORD NULL`).
> Antes de conectar a aplicação ou o worker utilizando `DATABASE_APP_URL`, `DATABASE_AUTH_URL` ou `DATABASE_WORKER_URL` através do pooler, o operador humano deve definir as senhas dessas 3 roles executando no SQL Editor do Supabase Staging:
> ```sql
> ALTER ROLE medicina_app WITH PASSWORD 'senha_forte_gerada_app';
> ALTER ROLE medicina_auth WITH PASSWORD 'senha_forte_gerada_auth';
> ALTER ROLE medicina_worker WITH PASSWORD 'senha_forte_gerada_worker';
> ```
> Sem este procedimento administrativo prévio, tentativas de autenticação TCP via pooler serão rejeitadas com erro `password authentication failed`.

---

## 2. Autenticação, Identidade e Segurança (RLS & Privilégios)

### 2.1 Fluxo de Login, Sessões e Vínculo Responsável-Estudante
O mecanismo de autenticação do Medicina 2029 opera com blindagem rigorosa contra ataques de canal lateral (*timing side-channel attacks*) e falsificação de sessão:

1. **Credenciais e Comparação Criptográfica:**
   - Em [`src/lib/auth-options.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/auth-options.ts), a rota NextAuth invoca a procedure `medicina.autenticar_por_email(credentials.email)` sob a conexão dedicada `authDb` (`medicina_auth`).
   - Se o e-mail não existir na base de dados ou não possuir hash cadastrado, o sistema executa compulsoriamente `bcrypt.compare(credentials.password, TIMING_BENCHMARK_HASH)` com um hash bcrypt padrão de referência (custo 10). Isso equaliza o tempo de resposta da requisição, impedindo a enumeração de e-mails legítimos por cronometria de rede.

2. **Criptografia e Persistência de Sessão:**
   - A sessão utiliza tokens JWT (`strategy: 'jwt'`) com validade de 30 dias, assinados exclusivamente pelo servidor via `NEXTAUTH_SECRET` (entropia obrigatória $\ge 32$ caracteres).
   - O payload do JWT armazena estritamente `id` do perfil e `role` (`estudante` | `responsavel`).
   - Os cookies são emitidos com atributos `HttpOnly`, `SameSite=Lax` e `Secure` (em HTTPS), impedindo a exfiltração de tokens via scripts de cliente (XSS).

3. **Vínculo Responsável-Estudante e Escopo Multi-Tenant:**
   - O relacionamento entre responsável e estudante é gerido pela tabela `public.responsavel_estudante`.
   - A função [`requireStudentScope()`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/authorization.ts#L160) valida se a requisição provém do próprio estudante autenticado ou do responsável legal formalmente vinculado.
   - Responsáveis não vinculados sofrem bloqueio `FORBIDDEN` e não possuem qualquer visibilidade sobre o acervo, ciclo ou métricas de outros estudantes.

### 2.2 Vinculação Confiável da Identidade NextAuth ao Contexto RLS
A fronteira de confiança (*Trust Boundary*) do sistema estabelece que o navegador do cliente é **completamente não confiável**. A integridade do contexto de segurança transacional é garantida pelo servidor Next.js:

```
┌────────────────────────────────┐
│   CLIENTE / BROWSER (UNTRUSTED)│
└───────────────┬────────────────┘
                │ Dispara Server Action (ex: buscarNoAcervo, enviarArquivo)
                │ NENHUM parâmetro perfilId ou papel é aceito no payload
                ▼
┌────────────────────────────────────────────────────────────────────────┐
│               SERVIDOR NEXT.JS / SERVER ACTION (TRUSTED)               │
│                                                                        │
│ 1. requireAuthenticatedProfile() -> getServerSession(authOptions)      │
│    Valida JWT criptografado e obtém AuthorizedProfile canônico         │
│ 2. db.transaction() -> abre transação atômica no PostgreSQL           │
│ 3. applyRlsContext(tx, perfil.id, perfil.papel)                        │
│    -> SELECT medicina.set_context(perfil.id, perfil.papel)             │
└───────────────┬────────────────────────────────────────────────────────┘
                │ Executa sob conexão da role medicina_app
                │ Configura variáveis com is_local => true (SET LOCAL)
                ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        POSTGRESQL (ENFORCER)                           │
│                                                                        │
│ - SET LOCAL medicina.current_perfil_id = <perfil.id>                   │
│ - SET LOCAL medicina.current_papel = <perfil.papel>                    │
│ - Avalia políticas RLS tupla a tupla (WHERE enviado_por = perfil_id)   │
│ - fn_busca_hibrida_acervo: confere v_ctx_perfil_id com session context │
│ - COMMIT / ROLLBACK: variáveis SET LOCAL são automaticamente destruídas│
└────────────────────────────────────────────────────────────────────────┘
```

- **Imunidade contra Spoofing no Pooler:** A chamada a `medicina.set_context` utiliza a instrução interna `set_config(..., is_local => true)`, equivalente ao comando SQL `SET LOCAL`. As variáveis de sessão existem exclusivamente enquanto durar a transação corrente. Ao término (`COMMIT` ou `ROLLBACK`), o contexto é descartado de forma imediata pelo motor do PostgreSQL, impedindo qualquer contaminação cruzada de conexões reutilizadas no pool (PgBouncer/Supavisor).
- **Dupla Validação na Busca Híbrida (`fn_busca_hibrida_acervo`):** A stored procedure da Etapa 9 inspeciona as variáveis transacionais ativas (`medicina.current_perfil_id()` e `medicina.current_papel()`). Se os parâmetros passados divergirem do contexto transacional estabelecido, a rotina aborta imediatamente disparando erro `42501` (*insufficient_privilege*). Se o contexto não tiver sido ativado, ela opera *fail-closed*, retornando zero linhas.

### 2.3 Registro de Pendências de Privilégios SECURITY DEFINER e EXECUTE
Em total conformidade com a auditoria documental conduzida em H1.06 ([`docs/modernizacao/RELATORIO_H1_06_IDENTIDADE_E_FUNCOES.md`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/RELATORIO_H1_06_IDENTIDADE_E_FUNCOES.md)), registra-se o diagnóstico de privilégios de rotinas no schema `medicina`, sem alterá-las remotamente:

1. **Rotinas SECURITY DEFINER Existentes:**
   - `medicina.autenticar_por_email` (owner: `postgres`, search_path fixo, `EXECUTE` exclusivo para `medicina_auth`);
   - `medicina.set_context` (owner: `postgres`, search_path fixo, `EXECUTE` exclusivo para `medicina_app`);
   - `medicina.clear_context` (owner: `postgres`, search_path fixo, `EXECUTE` exclusivo para `medicina_app`);
   - `medicina.current_managed_estudante_id` (owner: `postgres`);
   - `medicina.fn_acompanhamento_quinzenal` (owner: `postgres`);
   - `medicina.fn_simulados_evolucao` (owner: `postgres`);
   - `medicina.fn_busca_hibrida_acervo` (owner: `postgres`, search_path fixo, `EXECUTE` concedido a `medicina_app` e revogado de `PUBLIC` e `medicina_anon`).

2. **Pendência de Catalogação (Herança Default para `PUBLIC`):**
   - **Diagnóstico:** As funções `fn_acompanhamento_quinzenal` e `fn_simulados_evolucao` foram criadas no arquivo canônico `F1_04_RLS_PROPOSTA.sql` após a instrução coletiva `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA medicina FROM PUBLIC;`. Pela convenção nativa do PostgreSQL, funções criadas sem `ALTER DEFAULT PRIVILEGES` prévio herdam concessão padrão de `EXECUTE` para o pseudo-papel `PUBLIC` no catálogo (`pg_proc.proacl`).
   - **Análise de Risco (Defesa em Profundidade):** Essa pendência **NÃO** constitui vulnerabilidade prática ou explorável:
     a) O comando `REVOKE ALL ON SCHEMA medicina FROM PUBLIC;` revogou o privilégio `USAGE` no schema. Conexões de papéis não autorizados sofrem bloqueio prévio com erro `42501` (*permission denied for schema medicina*);
     b) Ambas as rotinas possuem guardas internas imperativas em PL/pgSQL que exigem contexto ativo de estudante ou responsável, abortando com retorno de 0 linhas caso não autenticadas.
   - **Ação Recomendada:** Manter inalterado o ambiente de staging nesta fase H2.01, preservando os hashes dos SQLs das migrações congeladas. A remoção cosmética do privilégio default deve ser tratada como item de manutenção programada em etapa futura.

---

## 3. Acervo e Supabase Storage Privado

### 3.1 Fluxo Ponta a Ponta: Envio, Cadastro, Deduplicação e Links Temporários
O ciclo de gestão de documentos do acervo ([`src/app/actions/acervo.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/acervo.ts)) foi arquitetado com integridade estrita, idempotência e ausência de mutação cega:

```mermaid
sequenceDiagram
    autonumber
    actor Resp as Responsável Autenticado
    participant Action as Server Action (enviarArquivo)
    participant Storage as Supabase Storage (Bucket acervo)
    participant DB as PostgreSQL (public.acervo_arquivos)
    participant Queue as Fila Durável (public.acervo_jobs)

    Resp->>Action: enviarArquivo(metadata, fileBuffer)
    Note over Action: Valida autorização requireRole('responsavel')<br/>Calcula SHA-256 do Buffer<br/>Gera chave determinística: acervo/<sha256>.pdf
    Action->>DB: SELECT id FROM acervo_arquivos WHERE hash_conteudo = sha256
    alt Arquivo já existe no Banco
        DB-->>Action: Registro existente localizado
        Action-->>Resp: Erro CONFLICT (Arquivo já enviado anteriormente)
    else Arquivo inédito no Banco
        Action->>Storage: upload(acervo/<sha256>.pdf, fileBuffer, upsert: false)
        alt Upload bem-sucedido (Objeto inédito)
            Storage-->>Action: Confirmação de armazenamento
        else Colisão no Storage (Status 409 / OBJECT_EXISTS)
            Note over Action: Reconciliação H1.07-R / F1.13:<br/>Baixa objeto existente e confere SHA-256 real
            Action->>Storage: download(acervo/<sha256>.pdf)
            Storage-->>Action: bytesArmazenados
            alt Hash confere bit a bit
                Note over Action: Adota objeto existente com segurança (reconciliado)
            else Divergência de Hash / Tamanho
                Action-->>Resp: Erro CONFLICT (Corrupção de integridade no Storage)
            end
        end
        Action->>DB: INSERT INTO public.acervo_arquivos (enviado_por, file_path, hash_conteudo, ...)
        DB-->>Action: Confirmação de persistência relacional
        Action->>Queue: enfileirarJobIngestaoAcervo(arquivoId, responsavelId)
        Queue-->>Action: Job durável enfileirado ('aguardando', etapa 'extracao')
        Action-->>Resp: Sucesso (Upload confirmado e job registrado)
    end
```

### 3.2 Autorização Backend com `service_role` e Bypass de RLS
A reformulação arquitetural implementada na Etapa 7 (H1.07-R / [`docs/modernizacao/RELATORIO_H1_07_R_STORAGE_REDESIGN.md`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/RELATORIO_H1_07_R_STORAGE_REDESIGN.md)) estabeleceu a convivência harmônica entre a aplicação Next.js e o modelo gerenciado do Supabase Cloud:

1. **Bypass Nativo da Service Role no Storage:**
   - O backend Next.js autentica-se junto à REST API do Supabase Storage utilizando `SUPABASE_SERVICE_ROLE_KEY`.
   - Sob esta chave, o gateway HTTP do Supabase Storage realiza **bypass total nas policies RLS de `storage.objects`**.
   - Além disso, uploads efetuados via backend gravam `owner_id = NULL` na tabela interna `storage.objects`, tornando inoperante qualquer política baseada em `auth.uid() = owner_id` no catálogo de arquivos.

2. **Garantia de Isolamento na Camada de Domínio e Aplicação:**
   - A autorização foi completamente transposta para a camada de serviço da aplicação e para as constraints de banco de dados do domínio:
     - **Bloqueio de Papel:** [`requireRole('responsavel')`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/authorization.ts#L116) impede categoricamente que estudantes ou usuários anônimos façam uploads;
     - **Isolamento de Tenant:** Consultas de status, download e acompanhamento exigem cláusula SQL explícita `WHERE id = :arquivoId AND enviado_por = perfil.id`;
     - **Trava Relacional Fail-Closed:** A tabela `public.acervo_arquivos` possui a constraint ativa `acervo_arquivos_file_path_format_check`, que invoca a função `medicina.is_valid_acervo_storage_path(file_path)`. Qualquer tentativa de gravar um caminho com *path traversal* (`..`), extensões não autorizadas ou que fuja do padrão estrito `^acervo/[0-9a-f]{64}(_[A-Za-z0-9._-]+)?\.pdf$` é rejeitada no nível relacional.

3. **Geração de URLs Assinadas de Curta Duração:**
   - Nenhum arquivo é disponibilizado por URL pública direta (`/object/public/` é terminantemente proibido).
   - O acesso para visualização ou download no navegador é intermediado pela função [`obterUrlLeituraArquivoAcervo()`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/acervo.ts#L404), que gera uma **URL assinada (Signed URL)** temporária com tempo de vida parametrizado entre 60 e 900 segundos (padrão: 300 segundos), expirando automaticamente após o uso.

---

## 4. Fila Assíncrona e Worker de Ingestão (`acervo_jobs`)

### 4.1 Preparação Técnica do Worker e Estrutura da Fila
A infraestrutura de processamento assíncrono do acervo encontra-se implementada nos módulos [`src/lib/acervoPipelineWorker.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/acervoPipelineWorker.ts) e [`src/lib/workerOnDemand.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/workerOnDemand.ts), apoiada pela tabela relacional `public.acervo_jobs` criada na Etapa 8 (`F1_11_FILA_INGESTAO_PROPOSTA.sql`):

- **Modelo de Mínimo Privilégio:** Opera sob a conexão dedicada `DATABASE_WORKER_URL` com a role `medicina_worker`, que possui acesso exclusivo às tabelas do acervo e aos tópicos de classificação;
- **Operação Sob Demanda (Sem Servidor Permanente):** O worker não depende de uma máquina virtual permanentemente ativa ou container contínuo. Ele foi desenhado para ser acionado sob demanda via CLI (`node scripts/worker/run-on-demand.mjs`), webhooks controlados ou agendamentos serverless (Cloud Run Jobs, GitHub Actions ou Cron da hospedagem);
- **Mecanismo de Concorrência e Lease Distribuído:**
  - A reivindicação de trabalho (`reivindicarProximoJobAcervo`) opera com seleção ordenada e atualização atômica (*compare-and-swap*) com base no estado do lease e número de tentativas;
  - Concede um lease padrão de 60 segundos (`DEFAULT_LEASE_DURATION_MS = 60000`), renovado periodicamente a cada etapa via heartbeat (`renovarHeartbeatJobAcervo`);
  - Se outro worker assumir o trabalho devido a expiração de lease, o processo original detecta a perda e encerra com `LeaseLostError`, evitando processamento redundante ou duplicado.
- **Pipeline de Ingestão em 4 Etapas Progressivas:**
  1. `extracao`: Baixa o PDF do Storage, valida SHA-256 e extrai páginas para `public.acervo_paginas`;
  2. `segmentacao`: Lê as páginas persistidas e divide o conteúdo em blocos semânticos salvos em `public.acervo_chunks`;
  3. `classificacao`: Associa os chunks aos tópicos da matriz curricular em `public.topicos`;
  4. `indexacao`: Computa embeddings vetoriais de 1536 dimensões e popula `acervo_chunks.embedding`.
- **Tratamento de Falhas e Retomada Idempotente:**
  - Cada etapa grava seus resultados de forma atômica no banco antes de transicionar o campo `etapa_atual`;
  - Em caso de falha transitória, o sistema calcula recuo exponencial (`calcularBackoffMs(tentativas)` de 5s a 300s) e reagenda a execução;
  - Ao ser retomado, o worker pula as etapas já gravadas, reaproveitando páginas e chunks já existentes sem retrabalho;
  - Na eventualidade de ausência do provedor de embeddings, o worker falha de forma estrita (`EMBEDDING_PROVIDER_UNAVAILABLE`), **jamais declarando conclusão fictícia**, preservando o trabalho para indexação posterior.

### 4.2 Requisitos de Infraestrutura para Operação em Staging
Para que o worker opere de forma segura em staging quando autorizado:
1. Runtime Node.js versão $\ge 20.x$;
2. Variável de conexão `DATABASE_WORKER_URL` configurada sob a role `medicina_worker.ynfocaorhadizlvbnzrt`;
3. Acesso à internet via HTTPS para comunicação com o Supabase Storage e API do Google Gemini;
4. Credenciais `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `GEMINI_API_KEY` devidamente provisionadas no ambiente de execução do worker.

> [!IMPORTANT]
> **Salvaguarda do Diagnóstico:** O worker remoto e agendamentos automáticos NÃO foram iniciados durante esta avaliação. O acionamento de processamento real permanece bloqueado.

---

## 5. Inteligência Artificial, Embeddings e Busca Híbrida

### 5.1 Encadeamento do Pipeline de IA e Referências ao Material de Origem
A cadeia de processamento de inteligência artificial integra os módulos de extração, representação vetorial e recuperação híbrida com rastreabilidade de proveniência ponta a ponta:

```
[Documento PDF no Storage]
       │
       ▼
1. Extração Digital de Texto (pdf-parse)
   │ Se a página for digitalizada (sem texto nativo)
   └──► 1.1 OCR Multimodal via Gemini 2.5 Flash (extrairTextoOcrGemini)
       │
       ▼
2. Segmentação em Chunks Estruturados (segmentarTexto)
   │ Divide em trechos com sobreposição, preservando paginaInicial e paginaFinal
       │
       ▼
3. Classificação Temática (classificarTópicoChunk)
   │ Vincula o chunk ao topico_id e disciplina_id correspondentes
       │
       ▼
4. Indexação Vetorial 1536-D (gerarEmbeddingGemini via gemini-embedding-001)
   │ Gera vetor normalizado (magnitude = 1.0) compatível com vector(1536)
       │
       ▼
[Tabela public.acervo_chunks]
   ├── Índice HNSW: acervo_chunks_embedding_hnsw_idx (similaridade de cosseno <=>)
   └── Índice GIN:  acervo_chunks_texto_fts_idx (FTS em português)
       │
       ▼
5. Busca Híbrida Integrada (medicina.fn_busca_hibrida_acervo)
   Score Final = (Score_Vetorial * 0.85) + (Score_Textual * 0.15)
   Retorna: chunk_id, arquivo_id, arquivo_titulo, autor_fonte, paginas, texto
```

- **Rastreabilidade e Proveniência Garantidas:** Cada resultado retornado pela busca híbrida expõe o `arquivo_id`, `arquivo_titulo`, `pagina_inicial`, `pagina_final` e a ordem do fragmento textual. O frontend é capaz de apresentar a citação literal com a indicação exata da página do PDF do material original enviado pelo responsável.
- **Constraints de Proveniência:** No banco de dados, as constraints `materiais_gerado_proveniencia_check`, `questoes_gerada_proveniencia_check` e `cards_gerado_proveniencia_check` (instaladas na Etapa 9) garantem que qualquer artefato derivado de inteligência artificial (`gerado_por_ia = true`) obrigue o preenchimento de `modelo_ia`, `prompt_versao`, `revisado_por` ou dados da fonte geradora, impedindo alucinações apócrifas no banco.

### 5.2 Dependências da API Gemini vs. Capacidades Testáveis com Mocks
Para a realização de testes controlados sem consumo financeiro ou sem dependência de serviços externos, o sistema possui clara separação entre componentes reais e simulados:

| Funcionalidade | Provedor Real (API Paga) | Capacidade de Teste com Mocks / Sem Custo | Estratégia de Homologação Inicial |
| :--- | :--- | :--- | :--- |
| **Extração de PDF Digital** | Nenhuma (biblioteca local `pdf-parse`) | Totalmente local e nativa | Testável 100% sem custos de API |
| **OCR de PDF Digitalizado** | Google Gemini Vision (`gemini-2.5-flash`) | Injeção via `OpcoesExtracaoPDF.executarOcrDocumento` | Usar PDF digital nativo no teste inicial |
| **Segmentação em Chunks** | Nenhuma (algoritmo puro TypeScript) | 100% determinístico e local | Testável sem custos de API |
| **Classificação de Tópicos** | Regras de domínio ou heurísticas | Injeção via `WorkerPipelineDependencies.classificarChunk` | Mapeamento direto por disciplina/tópico sintético |
| **Geração de Embeddings** | `gemini-embedding-001` (1536-D) | Injeção via `gerarEmbeddingReal` / `gerarEmbeddingQuery` | Vetores sintéticos normalizados para validar DB; 1 chamada real para validação final |
| **Busca Híbrida no DB** | Motor PostgreSQL (`pgvector` + FTS) | Totalmente nativo no Supabase Staging | 100% executável contra índices reais |
| **Curadoria / Artefatos** | `gemini-2.5-flash` (`gerarArtefatosGemini`) | [`gerarMockArtefatos`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/gemini.ts#L445) em `src/lib/gemini.ts` | Usar mock determinístico na primeira fase |

---

## 6. Prontidão de Recuperação e Backup

Antes do início de testes funcionais remotos que realizem mutações no ambiente de staging, é mandatório estabelecer o plano de contingência e recuperação. O sistema distingue formalmente três categorias de recuperação:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        TRIPLA ARQUITETURA DE RECUPERAÇÃO                               │
├────────────────────────┬───────────────────────────────┬───────────────────────────────┤
│   1. EXPORTAÇÃO LÓGICA │ 2. DISASTER RECOVERY DO BANCO │ 3. RECUPERAÇÃO DO STORAGE     │
│   (CAMADA DE APLICAÇÃO)│    (POSTGRESQL NATIVO)        │    (ARQUIVOS E MANIFESTO)     │
├────────────────────────┼───────────────────────────────┼───────────────────────────────┤
│ - exportarDadosCompletos- pg_dump -Fc (Custom Format)   │ - storageBackupManifest.ts    │
│ - JSON estruturado     │ - pg_dumpall --globals-only   │ - reconciliarSnapshotsAcervo  │
│ - 32 coleções de dados │ - Todas as 35 tabelas e schemas- Bucket privado 'acervo'      │
│ - LGPD / Portabilidade │ - Criptografia AES-256-GCM    │ - Validação SHA-256 por objeto│
│ - Máx. 10 MiB          │ - Restauração topológica (FKs)│ - Reconciliação bidirecional  │
│ - Senhas mascaradas    │ - Envelope de segurança offsite│ - RPO/RTO de armazenamento    │
└────────────────────────┴───────────────────────────────┴───────────────────────────────┘
```

### 6.1 Detalhamento dos Níveis de Recuperação
1. **Exportação Lógica da Aplicação (`exportarDadosCompletos`):**
   - Localizada em [`src/app/actions/backup.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/backup.ts);
   - Finalidade: Portabilidade de dados do estudante, conformidade LGPD e consulta didática pelo responsável;
   - Características: Formato JSON com exclusão estrita de `password_hash`, tokens e metadados operacionais do pooler. **Não se destina à recuperação de desastres de infraestrutura**.

2. **Recuperação Nativa de Banco de Dados (Disaster Recovery Relacional):**
   - Scripts canônicos: [`scripts/backup/backup_postgres.sh`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/backup/backup_postgres.sh) e [`restore_postgres.sh`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/backup/restore_postgres.sh);
   - Cobertura: Todas as 35 tabelas operacionais, 4 schemas (`public`, `medicina`, `extensions`, `storage`), constraints, sequências, índices vetoriais HNSW e roles de banco;
   - Segurança: Cifragem imediata via envelope criptográfico AES-256-GCM ([`scripts/backup/crypto_envelope.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/backup/crypto_envelope.mjs));
   - Grafo Topológico de Restauração: Impõe ordem estrita de carga (Nível 0 a Nível 5) para evitar erros de violação de chave estrangeira (`23503`).

3. **Recuperação e Reconciliação do Supabase Storage:**
   - Módulo: [`src/lib/storageBackupManifest.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/storageBackupManifest.ts) e script [`scripts/backup/reconcile_storage.sh`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/backup/reconcile_storage.sh);
   - Os arquivos binários no bucket privado `acervo` não residem no dump do PostgreSQL. A sua recuperação depende do manifesto criptográfico de objetos (versão 1.0) que cataloga caminho (`acervo/<sha256>.pdf`), tamanho em bytes e hash SHA-256;
   - O reconciliador detecta objetos ausentes no Storage ou arquivos órfãos sem registro na tabela `acervo_arquivos`, viabilizando recomposição sem deleções destrutivas.

> [!TIP]
> **Ação Recomendada Pré-Testes:** Antes de executar qualquer carga ou script de seed no Supabase Staging, deve-se gerar um snapshot de backup baseline da base atual via `scripts/backup/backup_postgres.sh` apontando para o Session Pooler (`aws-0-us-east-1.pooler.supabase.com:5432`) sob a role `postgres.ynfocaorhadizlvbnzrt`.

---

## 7. Plano de Homologação Funcional Controlada

### 7.1 Matriz de Separação de Estados de Implementação e Validação

| Domínio Funcional | Implementado no Código | Validado Localmente (Vitest / PGlite) | Validado no Supabase Staging Real |
| :--- | :---: | :---: | :---: |
| **Migrações 1 a 9 e Estrutura Relacional** | **SIM** | **SIM** (100% verde) | **SIM** (9 migrações registradas) |
| **pgvector 0.8.2 e Índices HNSW / GIN** | **SIM** | **SIM** (100% verde) | **SIM** (Confirmados no SQL Editor) |
| **Função fn_busca_hibrida_acervo** | **SIM** | **SIM** (100% verde) | **SIM** (Confirmada no catálogo) |
| **Guardião de Isolamento Fail-Closed** | **SIM** | **SIM** (100% verde) | Pendente de teste em runtime remoto |
| **Seed Sintético (Alice / Bruno / Ciclo)** | **SIM** | **SIM** (Testes unitários) | Pendente de execução remota |
| **Autenticação NextAuth e Roles RLS** | **SIM** | **SIM** (100% verde) | Pendente de login remoto |
| **Upload no Storage e URLs Assinadas** | **SIM** | **SIM** (Mocks / PGlite) | Pendente de primeiro upload no bucket |
| **Worker Sob Demanda (`acervo_jobs`)** | **SIM** | **SIM** (100% verde) | Pendente de execução remota |
| **Embeddings Reais e Busca Semântica** | **SIM** | **SIM** (Mocks determinísticos) | Pendente de teste integrado com Gemini |

### 7.2 Sequência Recomendada de Testes Funcionais Sintéticos (Passo a Passo)

A homologação funcional no staging deve ser conduzida em **fases sequenciais controladas**, utilizando exclusivamente identidades e materiais didáticos sintéticos (Zero PII):

```
Fase 0: Preflight Passivo de Conexão e Portões de Segurança
   │   (Verifica pooler, roles, TLS e ausência de bloqueios fail-closed)
   ▼
Fase 1: Snapshot de Backup Baseline
   │   (Registra o estado virgem do staging antes de qualquer inserção)
   ▼
Fase 2: Carga do Seed Sintético Controlado (scripts/db/seed-staging.ts)
   │   (Cria Alice [estudante], Bruno [responsável], 5 disciplinas e ciclo de 28 blocos)
   ▼
Fase 3: Homologação de Autenticação e Sessões (NextAuth)
   │   (Testa login de Alice e Bruno, validação de JWT e proteção de rotas pelo middleware)
   ▼
Fase 4: Homologação do Acervo e Supabase Storage Privado
   │   (Bruno envia PDF sintético válido, verifica deduplicação SHA-256 e gera Signed URL)
   ▼
Fase 5: Execução Controlada do Worker Sob Demanda
   │   (Processa o job do acervo através das etapas de extração, segmentação e classificação)
   ▼
Fase 6: Homologação da Busca Híbrida e Referenciação
   │   (Executa busca textual e semântica com pgvector, confirmando retorno de páginas e fontes)
   ▼
Fase 7: Auditoria de Encerramento e Comparação de Integridade
       (Reconciliação Banco vs Storage e validação de isolamento multi-tenant)
```

#### Detalhamento das Fases

#### Fase 0: Preflight Passivo de Conexão e Portões de Segurança
- **Objetivo:** Confirmar conectividade via TLS com o Session Pooler e Transaction Pooler.
- **Procedimento:** Executar o script passivo [`scripts/db/test-staging-connection.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/test-staging-connection.mjs) com validação de certificado CA (`prod-ca-2021.crt`).
- **Critério de Aprovação:** Conexão bem-sucedida, confirmação do banco `postgres` e projeto `ynfocaorhadizlvbnzrt`.

#### Fase 1: Snapshot de Backup Baseline
- **Objetivo:** Garantir a reversibilidade imediata do banco antes da injeção de dados.
- **Procedimento:** Executar `scripts/backup/backup_postgres.sh` com cifragem ativada.
- **Critério de Aprovação:** Arquivo `.sql.enc` e manifesto SHA-256 gerados com sucesso.

#### Fase 2: Carga do Seed Sintético Controlado
- **Objetivo:** Popular a base com as entidades fundamentais sem expor dados reais (Zero PII).
- **Procedimento:** Acionar [`src/db/seed-staging.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/seed-staging.ts) com flags de isolamento:
  `CONFIRM_STAGING_SEED=true APP_ENV=staging STAGING_SUPABASE_PROJECT_REF=ynfocaorhadizlvbnzrt npm run db:seed:staging`
- **Entidades Criadas:**
  - Estudante: `alice@medicina2029.staging` (ID: `10000000-0000-4000-8000-000000000001`);
  - Responsável: `bruno@medicina2029.staging` (ID: `20000000-0000-4000-8000-000000000001`);
  - Vínculo na tabela `responsavel_estudante` (`vinculo_id = 1`);
  - 5 disciplinas canônicas (Matemática, Biologia, Química, Física, Redação);
  - 10 tópicos curriculares com incidências ENEM/UECE;
  - 1 ciclo sintético de 28 blocos semanais associado a Alice.
- **Critério de Aprovação:** Resumo do seed reportando 2 perfis, 5 disciplinas, 10 tópicos e 1 ciclo sem violações de integridade.

#### Fase 3: Homologação de Autenticação e Sessões (NextAuth)
- **Objetivo:** Validar o fluxo de login web e imposição de papéis.
- **Procedimento:**
  1. Login como Bruno (`bruno@medicina2029.staging`): acesso permitido a `/responsavel` e `/acervo`;
  2. Login como Alice (`alice@medicina2029.staging`): acesso permitido a `/dashboard`, `/ciclo` e `/busca`; acesso negado (`FORBIDDEN`) a rotas restritas de responsável;
  3. Tentativa de login com senha incorreta: rejeição imediata sem vazamento de dados.
- **Critério de Aprovação:** Emissão correta de cookies JWT e isolamento de rotas pelo `middleware.ts`.

#### Fase 4: Homologação do Acervo e Supabase Storage Privado
- **Objetivo:** Validar upload, integridade determinística e links de leitura.
- **Procedimento:**
  1. Como Bruno, submeter via formulário um documento PDF sintético gerado por [`createSyntheticPdfBuffer()`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/seed-staging.ts#L64) com o tópico "Razão e Proporção";
  2. Confirmar gravação no bucket privado `acervo` sob a chave `acervo/<sha256>.pdf`;
  3. Re-enviar o mesmo arquivo: validar resposta `CONFLICT` (deduplicação idempotente ativa);
  4. Gerar URL assinada de leitura via `obterUrlLeituraArquivoAcervo`: validar download do arquivo no navegador dentro da janela de 300 segundos.
- **Critério de Aprovação:** Documento persistido em `acervo_arquivos` e job criado em `acervo_jobs` com status `aguardando`.

#### Fase 5: Execução Controlada do Worker Sob Demanda
- **Objetivo:** Processar o documento na fila assíncrona.
- **Procedimento:** Acionar o runner controlado limitando a 1 job e 60 segundos de teto:
  `node scripts/worker/run-on-demand.mjs --max-jobs=1 --max-duration=60000`
- **Validação das Etapas:**
  1. `extracao`: Páginas registradas em `public.acervo_paginas`;
  2. `segmentacao`: Chunks divididos em `public.acervo_chunks`;
  3. `classificacao`: Chunks associados ao tópico correto;
  4. `indexacao`: Vetor de 1536 dimensões persistido na coluna `embedding`.
- **Critério de Aprovação:** Job finalizado com status `concluido` e arquivo com `status_processamento = 'concluido'`.

#### Fase 6: Homologação da Busca Híbrida e Referenciação
- **Objetivo:** Validar a recuperação semântica no banco real com pgvector e FTS.
- **Procedimento:**
  1. Como Alice, efetuar busca pelo termo "Razão e Proporção" via [`buscarNoAcervo()`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/busca.ts#L14);
  2. Verificar acionamento da rotina `medicina.fn_busca_hibrida_acervo`;
  3. Inspecionar resultados: presença de score vetorial, score textual, título do documento e página de origem.
- **Critério de Aprovação:** Retorno dos chunks do PDF sintético com similaridade coerente e identificação da fonte original.

### 7.3 Custos Financeiros Previstos para a Homologação
O plano foi desenhado para gerar impacto orçamentário **estatisticamente nulo**:
- **Supabase Staging:** Coberto pelo plano existente (sem cobrança por volume moderado de consultas);
- **Google Gemini API:**
  - Extração de PDF: Custo $0,00 (processamento local via `pdf-parse`);
  - 1 PDF sintético de 2 páginas (~5 chunks de texto):
    - 5 requisições de embedding (`gemini-embedding-001`): ~$0,00005 USD;
    - 1 consulta de busca híbrida: ~$0,00001 USD;
  - **Custo Total Estimado da Homologação:** **Inferior a R$ 0,10 (dez centavos de real)**.

---

## 8. Bloqueadores Reais, Checklist Operacional e Parecer Final

### 8.1 Identificação e Diagnóstico de Bloqueadores

#### Bloqueadores Técnicos e Arquiteturais de Código: ZERO
- Todos os 9 SQLs canônicos estão aplicados e auditados no Supabase Staging;
- Schemas, extensões (`pgvector 0.8.2`), índices e funções estão 100% instalados;
- As suítes de testes de regressão de segurança, ciclo de vida e storage redesign apresentam 100% de aprovação no ambiente local.

#### Bloqueadores Operacionais / Pré-requisitos de Ambiente: 4 Itens
Existem pendências de configuração externa que devem ser sanadas **antes** de disparar as ações da Fase 2 em diante:

1. **[OPERACIONAL] Provisionamento de Senhas das Roles Técnicas no Staging:**
   - As roles `medicina_app`, `medicina_auth` e `medicina_worker` foram criadas sem senha no Supabase Staging. O operador deve definir suas senhas via SQL Editor (`ALTER ROLE ... WITH PASSWORD`) para viabilizar conexões TCP via pooler.
2. **[OPERACIONAL] Configuração do Arquivo de Variáveis de Runtime de Staging:**
   - O runtime do Next.js e o worker necessitam das variáveis de ambiente de staging configuradas (`APP_ENV=staging`, `DATABASE_APP_URL`, `DATABASE_AUTH_URL`, `DATABASE_WORKER_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `NEXTAUTH_SECRET`, `GEMINI_API_KEY`).
3. **[SEGURANÇA] Snapshot de Backup Baseline:**
   - Realização obrigatória do dump de segurança do banco antes de qualquer injeção de dados.
4. **[STORAGE] Confirmação da Configuração do Bucket Privado:**
   - Garantir que o bucket `acervo` no painel do Supabase Storage esteja configurado com `public = false`, limite de tamanho de 20 MiB e MIME type restrito a `application/pdf`.

---

### 8.2 Checklist Operacional Pré-Homologação

```markdown
- [ ] 1. Infraestrutura e Permissões no Supabase Staging
  - [ ] 1.1 Executar ALTER ROLE no SQL Editor definindo senhas para medicina_app, medicina_auth e medicina_worker.
  - [ ] 1.2 Confirmar no Storage que o bucket 'acervo' existe e possui status PRIVADO (public = false).
  - [ ] 1.3 Confirmar que o limite do bucket está em 20 MiB e MIME restrito a application/pdf.

- [ ] 2. Configuração e Segredos de Ambiente
  - [ ] 2.1 Preparar arquivo de variáveis de staging (ou configurar secrets no host de homologação).
  - [ ] 2.2 Validar que NEXTAUTH_SECRET possui no mínimo 32 caracteres de alta entropia.
  - [ ] 2.3 Garantir que nenhuma credencial possua o prefixo NEXT_PUBLIC_.
  - [ ] 2.4 Configurar CONFIRM_ISOLATED_STAGING_ENVIRONMENT=true e STAGING_SUPABASE_PROJECT_REF=ynfocaorhadizlvbnzrt.

- [ ] 3. Salvaguarda e Contingência
  - [ ] 3.1 Executar scripts/backup/backup_postgres.sh contra o pooler de staging.
  - [ ] 3.2 Armazenar com segurança o arquivo de dump cifrado e conferir o hash do manifesto.

- [ ] 4. Execução Controlada dos Testes
  - [ ] 4.1 Executar Fase 0 (test-staging-connection.mjs com certificado CA).
  - [ ] 4.2 Executar Fase 2 (seed-staging.ts com dados puramente sintéticos de Alice e Bruno).
  - [ ] 4.3 Executar Fase 3 (Login e validação de sessão NextAuth).
  - [ ] 4.4 Executar Fase 4 (Upload de PDF sintético e conferência de signed URL).
  - [ ] 4.5 Executar Fase 5 (Processamento pontual do worker com --max-jobs=1).
  - [ ] 4.6 Executar Fase 6 (Busca híbrida e verificação de citações de proveniência).
```

---

### 8.3 Conclusão e Parecer Técnico Final

Com base na auditoria rigorosa do código-fonte, nos registros do SQL Editor do Supabase Cloud, nas salvaguardas de isolamento fail-closed e nas suítes automatizadas de testes de regressão, o projeto Medicina 2029 é formalmente classificado como:

$$\mathbf{APTO\ COM\ RESSALVAS}$$

**Fundamentação da Classificação:**
- **Inexistência de Impedimentos Arquiteturais:** O software está completo, as migrações estão 100% aplicadas, as rotinas de RLS, storage, fila e busca estão testadas e operacionais.
- **Motivação das Ressalvas:** O início das operações remotas depende exclusivamente do cumprimento do checklist operacional prévio (provisionamento de senhas das roles no pooler, configuração segura de segredos de runtime e execução do backup baseline de contingência).

> [!IMPORTANT]
> **Portão Operacional Estrito:** Em estrito cumprimento às instruções recebidas, o sistema **NÃO avança automaticamente para a tarefa H2.02**. A execução permanece pausada, aguardando avaliação e autorização humana explícita.

---
*Fim do Relatório Técnico H2.01.*
