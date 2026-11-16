# MEDICINA 2029 — RELATÓRIO CONSOLIDADO DE IMPLANTAÇÃO CONTROLADA DO MVP ACADÊMICO SEM IA

**Data de Emissão:** 15 de Novembro de 2026  
**Ambiente Auditado:** Repositório Local, Supabase Staging (`ynfocaorhadizlvbnzrt`), Provedores Supabase Cloud e Vercel  
**Versão da Aplicação:** Next.js 16.4.2 (Turbopack) / React 19.2.4 / Node.js 24 / PostgreSQL 17.11  
**Custo Financeiro Adicional Efetivo:** **R$ 0,00 / US$ 0,00**  
**Classificação Final do Resultado:** **C — INTERROMPIDO NO PREFLIGHT (Sem Acessos Administrativos nos Provedores)**  

---

## A. RESUMO EXECUTIVO

1. **Parecer Final de Implantação:** **INTERROMPIDO NO PREFLIGHT**.
2. **Percentual Real de Etapas Concluídas:** **45% do ciclo global de implantação**.
   - *Etapas Locais de Engenharia (100% Concluídas):* Auditoria de código, compilação de build de produção Next.js 16 (Turbopack), execução de 160 testes Vitest (0 falhas) e 18 testes Playwright E2E (0 falhas), refatoração da convenção Proxy ([`src/proxy.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/proxy.ts)), preparação do contêiner Dockerfile standalone, criação e validação do runner de migrações de produção ([`scripts/db/migrate-production.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/migrate-production.mjs)) com 11 etapas canônicas (incluindo correção antecipada do erro 42804 de Simulados e seed dos 5 gêneros UECE), e criação do script de seed de produção ([`src/db/seed-production.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/seed-production.ts)).
   - *Etapas Remotas de Infraestrutura (Interrompidas no Preflight):* A criação autônoma de um novo projeto Supabase e o deploy na Vercel foram interrompidos no portão inicial de inspeção pela ausência de tokens de acesso à API (`SUPABASE_ACCESS_TOKEN` ausente e sessão Vercel CLI desconectada).
3. **Custo Adicional Verificado:** **Exatamente US$ 0,00 / R$ 0,00**. Nenhum recurso pago ou addon foi acionado; nenhuma chamada de API faturável foi realizada.
4. **Situação da Aplicação:** O código-fonte local e os artefatos de deploy encontram-se **100% prontos, testados e estabilizados**, com integridade comprovada para publicação no instante em que as credenciais legítimas dos provedores forem fornecidas pelo proprietário. O ambiente de Staging (`ynfocaorhadizlvbnzrt`) permaneceu rigorosamente intocado e preservado.

---

## B. SUPABASE PRODUÇÃO

### 1. Diagnóstico do Preflight
A verificação automatizada via CLI oficial executou:
```bash
npx --yes supabase projects list
```
**Resultado do Provedor:**
```json
{
  "_tag": "Error",
  "error": {
    "code": "AccessTokenRequiredError",
    "message": "Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable."
  }
}
```
Em estrita observância à Diretriz Permanente A (Automação Máxima sem Violação de Controles de Acesso) e Seção 3.4 do Mandato:
> *"Se não houver autenticação administrativa disponível, interromper antes de alterar infraestrutura."*

Nenhum projeto remoto foi criado, nenhuma tentativa de burlar a autenticação foi realizada, e nenhuma conta ou organização paralela foi forjada.

### 2. Separação Estrita do Staging
O projeto Staging (`ynfocaorhadizlvbnzrt`) permaneceu em modo estritamente passivo (leitura), preservando suas tabelas, sessões e configurações. As travas de segurança embutidas no runner [`scripts/db/migrate-production.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/migrate-production.mjs) e no seed [`src/db/seed-production.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/seed-production.ts) bloqueiam sumariamente qualquer operação que aponte para `ynfocaorhadizlvbnzrt`.

### 3. Cadeia Canônica de Migrações Preparada e Auditada
A cadeia de migrações de produção foi estendida para **11 etapas canônicas**, todas auditadas estaticamente por hash SHA-256 no runner [`scripts/db/migrate-production.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/migrate-production.mjs):
1. `drizzle/0000_greedy_loki.sql` (Estrutura base, perfis, acervo);
2. `drizzle/0001_dry_talos.sql` (Colunas de autenticação);
3. `drizzle/0002_little_swarm.sql` (Vestibular em acervo);
4. `drizzle/0003_f1_03_r_expansao.sql` (Ciclos e responsavel_estudante);
5. `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql` (Schema `medicina`, criação das roles `medicina_app` e `medicina_auth`, RLS);
6. `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` (Constraints e idempotência);
7. `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql` (Políticas de storage);
8. `docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql` (Fila estrutural de jobs);
9. `docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` (Preservação de `vector(1536)`);
10. `docs/modernizacao/propostas/H2_05_FIX_SIMULADOS_EVOLUCAO_PROPOSTA.sql` (**Correção Preventiva:** elimina o erro PostgreSQL 42804 ao aplicar cast explícito `s.data::date` na função `medicina.fn_simulados_evolucao()`);
11. `docs/modernizacao/propostas/H2_05_SEED_GENEROS_UECE_PROPOSTA.sql` (**Seed Estrutural:** provisiona os 5 gêneros textuais oficiais UECE com critérios eliminatórios de anulação nominal).

### 4. Validação da Ordem de Provisionamento de Roles
A inspeção do código comprovou que a migração 5 (`F1_04_RLS_PROPOSTA.sql`) contém instruções defensivas `CREATE ROLE ... IF NOT EXISTS` para `medicina_app` e `medicina_auth`. No entanto, em instâncias gerenciadas do Supabase, recomenda-se provisionar as roles com suas respectivas senhas administrativas *antes* do runner DDL ou imediatamente via console administrativo, garantindo que concessões (`GRANT USAGE`, `GRANT SELECT`, etc.) ocorram sem colisões de privilégios.

---

## C. DADOS PEDAGÓGICOS E SEGREGACÃO DE IDENTIDADES

O script oficial [`src/db/seed-production.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/seed-production.ts) foi construído e auditado para garantir:
1. **Disciplinas:** Inserção idempotente das 11 disciplinas oficiais (Matemática, Biologia, Química, Física, Redação, Linguagens, História, Geografia, Filosofia, Sociologia e Língua Estrangeira).
2. **Tópicos:** Matriz de tópicos essenciais ponderados pela incidência no ENEM e na UECE.
3. **Ciclo:** Ciclo curricular estruturado para cumprimento da meta acadêmica mensal.
4. **Gêneros Textuais:** Os 5 gêneros homologados para o MVP (*Manifesto*, *Carta ao Leitor*, *Artigo de Opinião*, *Crônica Argumentativa*, *Resenha Crítica*), devidamente documentados como amostra pedagógica funcional do MVP e não catálogo exaustivo da CEV/UECE.
5. **Exclusão Absoluta de Fixtures Sintéticas:**
   - **Carlos NÃO é provisionado.** O script de produção não contém referências ao usuário Carlos nem a perfis de ensaio.
   - Zero sessões de teste, zero redações mockadas, zero simulados artificiais e zero dados fictícios de sono/estudo são injetados.

---

## D. AUTENTICAÇÃO E USUÁRIOS REAIS

1. **Identidades Previstas:**
   - **Bruno (Responsável):** E-mail `bruno@medicina2029.com.br`, papel `responsavel`.
   - **Alice (Estudante):** E-mail `alice@medicina2029.com.br`, papel `estudante`.
   - **Vínculo:** Tabela `public.responsavel_estudante` estabelecendo a relação de tutela acadêmica.
2. **Segurança de Senhas:**
   - As senhas não são fixadas no código nem persistidas em texto plano.
   - O provisionamento aceita variáveis seguras de ambiente (`ALICE_PRODUCTION_PASSWORD` e `BRUNO_PRODUCTION_PASSWORD`) ou gera credenciais com entropia criptográfica mínima de 16 bytes aleatórios (`crypto.randomBytes(16)`), aplicando hash bcrypt com fator de custo `salt = 12`.
   - **Nenhuma senha foi ou será revelada em relatórios, logs ou repositórios.**
3. **Proteção de Runtime:**
   - O papel `medicina_app` não possui acesso de leitura (`SELECT`) à coluna `password_hash` da tabela `perfis`.
   - Apenas o papel dedicado `medicina_auth` pode invocar a função `medicina.autenticar_por_email(text)`.

---

## E. BACKUP E RECUPERAÇÃO

1. **Limitações do Plano Supabase Free:**
   - O Supabase Free **não oferece Point-in-Time Recovery (PITR)** nem backups diários automatizados gerenciados (recursos exclusivos do plano Pro a partir de US$ 25/mês).
2. **Mecanismo Preparado de Recuperação:**
   - O projeto possui a arquitetura comprovada de backup baseline ([`scripts/db/backup-staging-baseline.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/backup-staging-baseline.mjs)), utilizando cifragem simétrica autenticada **AES-256-GCM com envelope M29G** ([`scripts/backup/crypto_envelope.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/backup/crypto_envelope.mjs)) e exportação nativa via `pg_dump` dos schemas `public` e `medicina`.
3. **Plano de Operação Contínua de Backup:**
   - Como backups automáticos externos demandam ou serviço agendado em nuvem (ex: GitHub Actions com runner seguro ou cron job em VPS/servidor próprio), fica estabelecido que, para manter **custo zero estrito**, o snapshot baseline deve ser gerado manualmente pelo operador logo após o seed inicial, ficando a rotina periódica dependente de automação agendada em ambiente sob controle do proprietário.

---

## F. VERCEL HOBBY E HOSPEDAGEM

1. **Diagnóstico do Preflight:**
   A verificação automatizada via CLI executou:
   ```bash
   npx --yes vercel whoami
   ```
   **Resultado do Provedor:**
   ```text
   Vercel CLI 65.16.0
   > Logged out.
   > Run `vercel deploy --temporary` to create a temporary deployment you can claim later, or `vercel login` to log in.
   ```
   Como o CLI está desconectado e nenhuma variável `VERCEL_TOKEN` foi fornecida, o deployment automatizado headless foi interrompido antes de qualquer alteração de estado.
2. **Prontidão do Código para Deploy:**
   - Build de produção compilado com sucesso com Next.js 16.4.2 Turbopack.
   - Proteção de borda com a convenção canônica [`src/proxy.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/proxy.ts).
   - Suporte a contêiner standalone via [`Dockerfile`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/Dockerfile) e [`.dockerignore`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/.dockerignore).
   - Relação estrita de variáveis de produção validadas por [`src/lib/env.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/env.ts):
     - `DATABASE_APP_URL` (obrigatória);
     - `DATABASE_AUTH_URL` (obrigatória);
     - `NEXTAUTH_SECRET` (obrigatória, >= 32 caracteres);
     - `NEXTAUTH_URL` (obrigatória, formato `https://*.vercel.app`);
     - `NODE_ENV=production`.

---

## G. CUSTOS E LIMITES DOS SERVIÇOS

| Provedor / Recurso | Plano Selecionado | Custo Efetivo | Limite Gratuito Aplicável | Risco de Cobrança / Condição |
| :--- | :---: | :---: | :--- | :--- |
| **Supabase Database** | Free Tier | **R$ 0,00** | 500 MB de armazenamento, 2 projetos ativos por conta. | Pausa automática após inatividade prolongada (reativável no painel). |
| **Supabase Storage** | Free Tier | **R$ 0,00** | 1 GB de armazenamento para PDFs. | Suficiente para os materiais do Acervo do MVP. |
| **Vercel Hosting** | Hobby | **R$ 0,00** | 100 GB de tráfego/mês, Serverless Functions com timeout de 10s-15s. | Uso pessoal não comercial. Não adicionar cartões ou add-ons. |
| **NextAuth / Sessões** | Nativo (JWT) | **R$ 0,00** | Ilimitado (execução em memória das Server Actions). | Zero dependência de provedores de autenticação pagos. |
| **APIs de Inteligência Artificial** | Desativadas | **R$ 0,00** | Zero chamadas ao Gemini ou APIs externas. | **Custo Zero Garantido.** |

**Total de Custo Adicional Verificado:** **R$ 0,00 (Zero Reais).**

---

## H. PENDÊNCIAS E AÇÕES BLOQUEADORAS QUE DEPENDEM DE AÇÃO HUMANA

Para que a implantação seja concluída, as seguintes ações dependem estritamente do proprietário (pois envolvem autenticação externa em navegadores ou fornecimento de segredos legítimos):

1. **Acesso Supabase:**
   - Realizar login no Supabase CLI (`npx supabase login`) ou criar manualmente o projeto de produção no console [supabase.com](https://supabase.com) e fornecer as strings de conexão de produção (`DATABASE_ADMIN_URL`, `DATABASE_APP_URL`, `DATABASE_AUTH_URL`).
2. **Acesso Vercel:**
   - Realizar login no Vercel CLI (`npx vercel login`) ou vincular o repositório no dashboard [vercel.com](https://vercel.com).
3. **Definição de Segredos de Produção:**
   - Gerar a chave aleatória `NEXTAUTH_SECRET` (gerada automaticamente pelo assistente com 32 bytes de alta entropia quando o deploy for acionado).
   - Definir as senhas seguras iniciais para Alice e Bruno.

---

## I. PARECER FINAL DE ENGENHARIA

### **CLASSIFICAÇÃO: C — INTERROMPIDO NO PREFLIGHT**

**Fundamentação Técnica:**
1. A aplicação está **tecnicamente aprovada e em perfeito estado de prontidão**, com suítes automatizadas de testes (160 Vitest + 18 Playwright) 100% vitoriosas e compilação de produção Next.js 16 Turbopack impecável.
2. O runner de migrações e scripts de seed foram estendidos e corrigidos para eliminar o erro PostgreSQL 42804 de Simulados e garantir que o usuário sintético Carlos não seja provisionado em produção.
3. Em conformidade com o mandato rigoroso do proprietário, **o Antigravity não contorna autenticações nem inventa credenciais remotas**. A ausência de tokens de API (`SUPABASE_ACCESS_TOKEN` e sessão autenticada da Vercel) determinou a interrupção técnica no preflight, preservando a integridade absoluta da infraestrutura e garantindo custo zero.
