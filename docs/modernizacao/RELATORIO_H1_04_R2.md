# PROJETO MEDICINA 2029 — RELATÓRIO TÉCNICO H1.04-R2
## FECHAMENTO DOS RISCOS DO RUNNER DE MIGRAÇÕES PARA STAGING

**Data de Execução:** 23 de Outubro de 2026  
**Projeto Alvo Homologado:** `medicina-2029-staging`  
**Supabase Project Ref:** `ynfocaorhadizlvbnzrt`  
**Configuração de Banco Remoto:** PostgreSQL 18 gerenciado, extensão `vector 0.8.2` no schema `extensions`, `pgcrypto` e `uuid-ossp` habilitadas.  
**Ambiente de Teste Local:** PostgreSQL descartável em memória (PGlite WASM) com extensão `pgvector` simulando schema `extensions`.  
**Classificação e Parecer Final:** **APTO PARA PRIMEIRA MIGRAÇÃO CONTROLADA** (todos os riscos residuais foram sanados e comprovados com testes automatizados dedicados).

---

## 1. RESUMO EXECUTIVO E DECISÃO TÉCNICA

Em complemento à homologação prévia da [H1.04-R](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/RELATORIO_H1_04_R.md), a etapa **H1.04-R2** eliminou os riscos residuais de execução atômica, endureceu as funções com atributo `SECURITY DEFINER`, alinhou as operações de catálogo no Supabase Storage e aprimorou a infraestrutura do runner [`scripts/db/migrate-staging.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/migrate-staging.mjs).

Todas as modificações foram realizadas com rigor arquitetural e validadas em PostgreSQL descartável, mantendo a regra de **zero acesso ao Supabase remoto** e **zero alterações persistentes não autorizadas**.

A tabela comparativa a seguir sintetiza as correções da etapa H1.04-R2:

| Risco Residual Identificado | Diagnóstico | Tratamento Implementado na H1.04-R2 | Evidência de Teste |
| :--- | :--- | :--- | :---: |
| **1. Descompasso DDL vs Histórico** | Scripts com `BEGIN/COMMIT` próprios podiam efetivar o DDL e falhar antes de registrar na tabela de histórico, permitindo que a próxima execução tentasse recriar objetos já existentes. | Criação da função `stripOuterTransaction`, garantindo transação única atômica para DDL e inserção de histórico em todos os scripts. Implementação do guardião `MIGRATION_PROBES` que detecta assinaturas de estado intermediário antes de executar qualquer DDL, abortando fail-closed sem destruição de dados. | Aprovado em Vitest (cenários de falha transacional e detecção de estado intermediário). |
| **2. Vulnerabilidades de `search_path`** | Funções `SECURITY DEFINER` continham `SET search_path = public, medicina, pg_temp`, permitindo que schemas graváveis por usuários não confiáveis fossem pesquisados antes de schemas do sistema ou da aplicação. | Endurecimento de 100% das funções privilegiadas com `pg_catalog` no início (`SET search_path = pg_catalog, medicina, public, pg_temp` ou `pg_catalog, extensions, medicina, public, pg_temp`), qualificação explícita de tabelas públicas e `pg_temp` estritamente ao final. | Aprovado na suíte RLS (41/41 cenários) e teste 1536-d. |
| **3. Falhas Silenciosas em Storage** | `F1_10` continha `EXCEPTION WHEN insufficient_privilege THEN NULL;`, mascarando pendências estruturais para o operador, além de inserção direta não documentada em `storage.buckets`. | Eliminação de tratamento silencioso: substituído por `RAISE WARNING` explícito identificando pendências de privilégios. Inserção em `storage.buckets` documentada e restrita a ambientes locais/PGlite, orientando criação via Supabase Dashboard/API. Testes de autorização server-side reafirmados. | Aprovado (15/15 testes H1.04-R2). |
| **4. Sintaxe de Roles e Locks de Conexão** | Risco de sintaxe PostgreSQL inválida e perda de locks de sessão caso executados em conexões distintas do pool. Modo dry-run conectava ao banco se `DATABASE_MIGRATION_URL` estivesse configurada. | Confirmação de blocos `DO $$ BEGIN IF NOT EXISTS (...) THEN CREATE ROLE ...; END IF; END $$;`. Conexão reservada dedicada (`sql.reserve()`) mantida durante todo o ciclo de vida do advisory lock (`20290001`). Separação estrita entre `--dry-run` (100% offline, zero conexões) e `--check-db` (inspeção online de leitura). | Aprovado (CLI offline e advisory lock dedicado). |

---

## 2. ATOMICIDADE TRANSACIONAL E DETECÇÃO DE ESTADO INTERMEDIÁRIO

### 2.1. Transação Única para DDL e Histórico (`stripOuterTransaction`)
Para evitar que scripts com declaração literal de `BEGIN;` e `COMMIT;` (como `F1_04` a `F1_12`) finalizassem prematuramente a transação antes da gravação do registro de tracking, foi implementada no runner a função:
```javascript
export function stripOuterTransaction(sqlContent) {
  let content = sqlContent.trim();
  content = content.replace(/^(\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*\bBEGIN\s*;\s*/i, (match) => {
    return match.replace(/\bBEGIN\s*;\s*/i, '');
  });
  content = content.replace(/\bCOMMIT\s*;?(\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*$/i, '');
  return content.trim();
}
```
Com isso, todo o arquivo SQL e a instrução de inserção na tabela de controle executam dentro do mesmo bloco:
```javascript
await client.begin(async (tx) => {
  await tx.unsafe(cleanSqlContent);
  await tx`
    INSERT INTO public._medicina_staging_migrations (ordem, rel_path, sha256, executado_por, tamanho_bytes)
    VALUES (${m.ordem}, ${m.relPath}, ${m.sha256}, current_user, ${m.tamanhoBytes});
  `;
});
```
Se o DDL falhar ou se a gravação do histórico for interrompida, o PostgreSQL desfaz compulsoriamente todas as alterações daquela etapa, impedindo que o banco permaneça em estado inconsistente.

### 2.2. Detecção Segura de Estado Intermediário (`MIGRATION_PROBES`)
Caso ocorra uma falha catastrófica de infraestrutura (por exemplo, queda de rede no momento exato da confirmação de uma transação não-atômica legada) ou caso um operador tenha aplicado manualmente comandos DDL fora do runner, o runner executa uma sonda de verificação de assinatura para a migração pendente:

```javascript
export const MIGRATION_PROBES = {
  1: async (sql) => {
    const [res] = await sql`SELECT to_regclass('public.acervo_arquivos') as tbl, to_regclass('public.perfis') as tbl2;`;
    return Boolean(res?.tbl || res?.tbl2);
  },
  2: async (sql) => {
    const rows = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'perfis' AND column_name IN ('email', 'password_hash');`;
    return rows.length > 0;
  },
  ...
  8: async (sql) => {
    const [res] = await sql`SELECT to_regclass('public.acervo_jobs') as tbl;`;
    return Boolean(res?.tbl);
  },
  9: async (sql) => {
    const rows = await sql`SELECT 1 FROM pg_proc WHERE proname = 'fn_busca_hibrida_acervo';`;
    return rows.length > 0;
  },
};
```
Se a sonda detectar a existência física de objetos pertencentes à migração sem o respectivo registro em `_medicina_staging_migrations`, o runner aborta imediatamente com erro explícito:
```
ESTADO INTERMEDIÁRIO DETECTADO: Os objetos da migração [N] (...) já existem no banco de dados, mas a gravação na tabela _medicina_staging_migrations não foi registrada...
```
Essa abordagem impede qualquer reaplicação destrutiva automática e protege a integridade dos dados existentes.

---

## 3. ENDURECIMENTO DE FUNÇÕES SECURITY DEFINER E SEARCH_PATH

Todas as funções do schema `medicina` e funções utilitárias privilegiadas foram revisadas para fechar vetores de sequestro de resolução no PostgreSQL (`search_path hijacking`):

1. **`pg_catalog` em Primeiro Lugar:**
   Garante que tipos nativos (`uuid`, `text`, `boolean`, `integer`), operadores de igualdade e comparação (`=`, `<>`, `LIKE`) e funções intrínsecas (`current_setting`, `set_config`, `char_length`) sejam resolvidos diretamente do catálogo do sistema, impossibilitando mascaramento por objetos em schemas do usuário.
2. **Priorização de Schemas Confiáveis:**
   - Funções puras de contexto (`current_perfil_id`, `current_papel`, `is_estudante`, `is_responsavel`, `clear_context`, `is_valid_acervo_storage_path`):
     ```sql
     SET search_path = pg_catalog, medicina, pg_temp;
     ```
   - Funções com acesso a tabelas de negócio (`current_managed_estudante_id`, `set_context`, `autenticar_por_email`, `fn_acompanhamento_quinzenal`, `fn_simulados_evolucao`):
     ```sql
     SET search_path = pg_catalog, medicina, public, pg_temp;
     ```
     Todas as tabelas foram qualificadas explicitamente com o prefixo `public.` (`public.perfis`, `public.responsavel_estudante`, `public.allowlist`).
   - Função de busca vetorial híbrida (`medicina.fn_busca_hibrida_acervo`):
     ```sql
     SET search_path = pg_catalog, extensions, medicina, public, pg_temp;
     ```
     Essa configuração resolve com segurança máxima os operadores vetoriais de cosseno (`<=>`), produto escalar (`<#>`) e L2 (`<->`) da extensão `pgvector`, priorizando o schema `extensions` em relação a `public`.

---

## 4. SUPABASE STORAGE E POLÍTICAS DE CATÁLOGO

### 4.1. Transparência em Falhas de Privilégio
Substituídos todos os blocos `EXCEPTION WHEN insufficient_privilege THEN NULL;` por emissão explícita de avisos:
```sql
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING 'AVISO DE PRIVILÉGIO PENDENTE: A role % não possui privilégio de ownership para adicionar constraints em storage.buckets. A restrição de privacidade deve ser assegurada pela configuração do bucket no Supabase Storage.', current_user;
```
Dessa forma, o operador que monitora os logs da migração recebe alerta imediato e rastreável sobre quaisquer restrições que requeiram ação manual no painel do Supabase.

### 4.2. Diretriz de Provisionamento do Bucket `acervo`
O script [`docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql) agora documenta formalmente que a inserção SQL direta em `storage.buckets` destina-se a testes locais descartáveis (PGlite). No Supabase gerenciado, o bucket deve ser mantido através do Dashboard oficial ou Storage API.

### 4.3. Autorização Server-Side para `service_role`
Conforme comprovado na inspeção das Server Actions em [`src/app/actions/acervo.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/acervo.ts):
- O código da aplicação NÃO delega o controle de acesso exclusivamente às policies do Storage API;
- Todas as operações (`enviarArquivo`, `enviarArquivoFormData`, `obterUrlAssinadaArquivo`, `removerArquivoAcervo`) invocam compulsoriamente `requireRole('responsavel')` ou `requireAuthenticatedProfile()` antes de efetuar qualquer chamada ao cliente de Storage;
- Mesmo diante de bypass de RLS no backend via `service_role`, o acesso não autorizado é sumariamente bloqueado na camada de aplicação.

---

## 5. RIGOR SINTÁTICO SQL E ARQUITETURA DO RUNNER

1. **Sintaxe Válida de Criação de Roles:**
   Confirmado que no PostgreSQL não existe a sintaxe literal `CREATE ROLE IF NOT EXISTS`. Todas as criações de roles nos scripts canônicos utilizam blocos PL/pgSQL suportados nativamente:
   ```sql
   IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicina_worker') THEN
     CREATE ROLE medicina_worker WITH NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;
   END IF;
   ```
2. **Escopo Transacional Estrito de `SET LOCAL`:**
   Ao remover os `BEGIN/COMMIT` externos via `stripOuterTransaction`, o runner garante que comandos como `SET LOCAL lock_timeout = '5s'` e `SET LOCAL search_path = ...` executem compulsoriamente dentro da transação atômica gerenciada por `client.begin(...)`.
3. **Lock Consultivo com Conexão Dedicada:**
   O runner utiliza `sql.reserve()` para assegurar uma conexão física dedicada durante toda a execução. O comando `SELECT pg_try_advisory_lock(20290001)` permanece ativo na mesma sessão até a liberação final no bloco `finally`, prevenindo execuções concorrentes acidentais.
4. **Separação Rigorosa dos Modos de Execução:**
   - `node scripts/db/migrate-staging.mjs`: Pré-validação estática 100% offline. Audita manifestos, arquivos e hashes locais sem abrir conexões de rede ou tocar em variáveis de banco de dados.
   - `node scripts/db/migrate-staging.mjs --check-db`: Inspeção online somente-leitura. Conecta ao banco com credenciais administrativas, consulta `_medicina_staging_migrations`, compara hashes e exibe o plano sem efetuar comandos DDL.
   - `node scripts/db/migrate-staging.mjs --apply`: Execução efetiva transacional com confirmação explícita (`CONFIRM_STAGING_MIGRATIONS=true`).

---

## 6. RESULTADOS DOS TESTES EM BANCO DESCAIRTÁVEL

A suíte dedicada [`src/app/actions/h1_04_staging_migrations.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h1_04_staging_migrations.test.ts) foi expandida para 15 testes abrangendo todos os cenários solicitados:

| Grupo de Teste | Cenário Avaliado | Resultado | Evidência Técnica |
| :--- | :--- | :---: | :--- |
| **1. Validação Estática e Parser** | Manifesto canônico com 9 arquivos | **APROVADO** | 9 arquivos auditados com SHA-256 e tamanhos íntegros. |
| | Função `stripOuterTransaction` | **APROVADO** | Remove `BEGIN` e `COMMIT` externos preservando `SET LOCAL` interno. |
| | Parser `extractDatabaseRole` | **APROVADO** | Extrai papéis diretos e via Supabase connection pooler. |
| | Salvaguardas fail-closed CLI | **APROVADO** | Bloqueia roles de runtime (`medicina_app`, `medicina_auth`, `medicina_worker`). |
| **2. Sequência e Idempotência** | Aplicação sequencial dos 9 scripts | **APROVADO** | 9 registros gravados em `_medicina_staging_migrations`. |
| | Reexecução sem duplicações (retry) | **APROVADO** | 9 scripts pulados via `[SKIP]` com 0 mutações adicionais. |
| | Detecção de hash divergente | **APROVADO** | Aborta com `DIVERGÊNCIA DE INTEGRIDADE` ao detectar alteração pós-aplicação. |
| **3. Atomicidade e Falhas** | Aborto transacional por erro de DDL | **APROVADO** | Rollback completo sem gravar tracking nem deixar tabelas orfãs. |
| | Reversão transacional por falha no tracking | **APROVADO** | Rollback do DDL quando o `INSERT` do tracking falha na mesma transação. |
| | Detecção de estado intermediário | **APROVADO** | Aborta com `ESTADO INTERMEDIÁRIO DETECTADO` caso objetos existam sem tracking. |
| | Simulação de concorrência | **APROVADO** | Aborta com `CONCORRÊNCIA BLOQUEADA` se o advisory lock estiver ocupado. |
| **4. Roles e Privilégios** | Roles `medicina_app`, `medicina_auth`, `medicina_worker` | **APROVADO** | Todas com `NOBYPASSRLS`; testes negativos para tabelas sensíveis aprovados. |
| **5. Storage Policies** | Policies em `storage.objects` | **APROVADO** | As 4 policies criadas com sucesso sem erros de ownership. |
| **6. Busca Vetorial PGVector** | Busca híbrida 1536-d sob RLS | **APROVADO** | Operador `<=>` executado com sucesso e score vetorial > 0.5. |
| **7. Rollback Completo** | Rollback canônico dos scripts | **APROVADO** | Schema `medicina` e views revertidos limpos; `DROP OWNED BY` aplicado com sucesso. |

---

## 7. BATERIA FINAL DE INTEGRAÇÃO DO PROJETO

| Verificação | Escopo | Resultado | Detalhes |
| :--- | :--- | :---: | :--- |
| **TypeScript** (`tsc --noEmit`) | Verificação estática total do projeto | **APROVADO** | 0 erros de compilação. |
| **ESLint** | Arquivos alterados e scripts do runner | **APROVADO** | 0 erros, 0 avisos. |
| **Vitest Integral** (`npm run test:run`) | 38 arquivos de teste | **APROVADO** | **38 arquivos passaram, 368 testes aprovados (100% de sucesso)**. |
| **Next.js Turbopack** (`build`) | Compilação de rotas e SSR | **APROVADO** | Build de produção gerado com sucesso em Next.js 16.4.2. |
| **Drizzle Kit Check** | Coerência de esquemas relacionais | **APROVADO** | Catálogo íntegro sem divergências. |
| **Git Diff Check** (`git diff --check`) | Higiene de whitespace e quebras de linha | **APROVADO** | 0 erros de formatação. |
| **Suíte RLS** (`run-rls-validation.mjs`) | Matriz de segurança e contexto RLS | **APROVADO** | **41/41 cenários aprovados (100% de sucesso)**. |

---

## 8. CONCLUSÃO E PARECER TÉCNICO

Com a conclusão da etapa **H1.04-R2**, os riscos de atomicidade transacional, hijacking de `search_path`, concorrência e compatibilidade com o Supabase Storage foram integralmente sanados e comprovados.

### Decisão Técnica:
> ### **APTO PARA PRIMEIRA MIGRAÇÃO CONTROLADA**

Nenhuma ação remota foi executada no Supabase (`ynfocaorhadizlvbnzrt`), nenhum commit ou push foi realizado. O repositório local permanece íntegro e preparado para o avanço controlado conforme autorização humana.

---
*Relatório emitido pela Engenharia de Banco de Dados e Segurança do Projeto Medicina 2029.*
