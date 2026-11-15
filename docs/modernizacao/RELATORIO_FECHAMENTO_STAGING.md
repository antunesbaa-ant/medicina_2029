# MEDICINA 2029 — RELATÓRIO DE FECHAMENTO CONTROLADO DO STAGING

**Data de Emissão:** 15 de Novembro de 2026  
**Ambiente Alvo:** Supabase Staging (`ynfocaorhadizlvbnzrt`)  
**Ponto de Extremidade:** `aws-0-us-east-1.pooler.supabase.com:5432` (Session Pooler)  
**Validação Criptográfica TLS:** Estrita (`prod-ca-2021.crt`, `rejectUnauthorized: true`)  
**Identidade Técnica Conectada:** `medicina_app` (Role de menor privilégio de runtime)  
**Custo Financeiro Adicional:** US$ 0,00  
**Parecer Consolidado do MVP:** **APROVADO COM RESSALVAS TÉCNICAS ADMINISTRATIVAS**  

---

## 1. ESTADO REAL DOS GÊNEROS UECE E RECONCILIAÇÃO DE ESCOPO

### 1.1 Registros Efetivamente Persistidos na Tabela `public.generos`
A consulta transacional realizada sob contexto de responsável pedagógico (`medicina.set_context('20000000-0000-4000-8000-000000000001', 'responsavel')`) confirma a presença de **exatamente 5 registros canônicos**, sem duplicidades ou linhas corrompidas:

```sql
SELECT id, nome, interlocutor, ficha_completa 
FROM public.generos 
ORDER BY id ASC;
```

| ID Canônico (UUID v4) | Nome do Gênero | Interlocutor e Canal Pedagógico | Ficha Completa |
| :--- | :--- | :--- | :---: |
| `00000000-0000-4000-a000-000000000001` | **Manifesto** | Sociedade civil, comunidade acadêmica ou autoridades públicas; voz de um coletivo ou representação social legítima. | `true` |
| `00000000-0000-4000-a000-000000000002` | **Carta ao Leitor** | Equipe de redação/editoria de veículo de imprensa ou leitores do periódico (vedada qualquer assinatura nominal). | `true` |
| `00000000-0000-4000-a000-000000000003` | **Artigo de Opinião** | Leitores de jornais, revistas ou portais de grande circulação. | `true` |
| `00000000-0000-4000-a000-000000000004` | **Crônica Argumentativa** | Público leitor de crônicas e folhetins contemporâneos que buscam reflexão humanizada sobre a realidade cotidiana. | `true` |
| `00000000-0000-4000-a000-000000000005` | **Resenha Crítica** | Público leitor interessado em apreciação artística, literária ou científica e recomendações fundamentadas. | `true` |

### 1.2 Reconciliação entre o Escopo Autorizado e o Cadastrado
- **Escopo Autorizado no Lote Anterior:** O proprietário autorizou a carga de exatamente 5 gêneros: *Carta ao Leitor*, *Artigo de Opinião*, *Crônica Argumentativa*, *Manifesto* e *Resenha Crítica*.
- **Conformidade de Nomes:** **100% aderente.** Os cinco gêneros persistidos correspondem estritamente à matriz pedagógica formalmente solicitada.
- **Histórico de Rascunhos Anteriores:** Em fases preliminares (`src/db/seed.ts` e versão preliminar não aplicada da proposta SQL), constavam propostas contemplando "Carta Aberta", "Discurso / Pronunciamento" e "Crônica" genérica. Na execução do lote final, esses itens não foram gravados no banco remoto, permanecendo exclusivamente a lista autorizada de 5 gêneros.

### 1.3 Avaliação Pedagógica de Conteúdo (CEV/UECE)
A inspeção dos campos pedagógicos confirma alinhamento rigoroso com as normas editalícias da Comissão Executiva do Vestibular da UECE (CEV/UECE):
1. **Fator Eliminatório de Descaracterização:** Todos os 5 registros destacam que a CEV/UECE anula sumariamente provas com rubrica, assinatura nominal, pseudônimo não solicitado ou sinal identificador no corpo da folha definitiva.
2. **Carta ao Leitor:** Exige referência explícita à matéria ou fato jornalístico preexistente, vedando transformação em correspondência privada sigilosa.
3. **Crônica Argumentativa:** Exige equilíbrio entre narrativa cotidiana breve e posicionamento crítico-reflexivo, vedando estrutura fria de dissertação puramente acadêmica.
4. **Manifesto:** Fixa a 1ª pessoa do plural (`nós`), tom enfático/conclamatório e apelo público urgente à mobilização.
5. **Resenha Crítica:** Impõe julgamento crítico de valor estético/conceitual fundamentado, desautorizando mero resumo descritivo.

**Conclusão Pedagógica:** O conteúdo está correto, completo e sem necessidade de correções pedagógicas adicionais. Nenhuma modificação, substituição ou exclusão foi realizada.

---

## 2. DIMENSÃO REAL DOS EMBEDDINGS E AUDITORIA DO ACERVO

### 2.1 Tipo e Dimensão Declarada no Catálogo PostgreSQL
Consulta ao catálogo relacional (`pg_attribute` e `information_schema`):
```sql
SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) as full_type
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'acervo_chunks' AND a.attname = 'embedding';
```
- **Tipo Real no Catálogo:** `USER-DEFINED` (extensão `vector` do schema `extensions`).
- **Dimensão Declarada no PostgreSQL:** `extensions.vector(1536)`.
- **Racional Arquitetural:** O schema inicial foi modelado conforme o padrão de 1536 dimensões (compatível com `text-embedding-ada-002`).

### 2.2 Dimensão Efetiva do Vetor Persistido e Presença de Dados
Consulta à tupla existente na tabela `public.acervo_chunks`:
```sql
SELECT id, arquivo_id, ordem,
       embedding IS NOT NULL as has_embedding,
       extensions.vector_dims(embedding) as dims,
       substring(embedding::text from 1 for 60) as sample_vector
FROM public.acervo_chunks;
```
- **Existência de Embedding:** `has_embedding: true`.
- **Dimensão Efetiva do Vetor:** **1536 dimensões**.
- **Conteúdo Vetorial Gravado:** Vetor sintético unitário iniciado por `[0.6, 0.8, 0, 0, 0, ...]` persistido durante a homologação da migração inicial F1.12. Não foram realizadas chamadas externas a provedores de IA, respeitando o custo zero.

### 2.3 Identificador, Tamanho e Hash do Documento de Citologia
Consulta à tabela `public.acervo_arquivos`:
```sql
SELECT id, titulo, tipo_material, tamanho_bytes, paginas, status_processamento, hash_conteudo, file_path
FROM public.acervo_arquivos;
```
- **Identificador (`id`):** `f0000000-0000-4000-8000-000000000001`
- **Título:** `Apostila Citologia`
- **Tipo de Material:** `apostila`
- **Tamanho Real:** **666 bytes** (1 página)
- **Hash de Conteúdo (`hash_conteudo` SHA-256):** `918ae7f2a3d1052b9bd7bfec017851f95afe2c676a9b53d2a0f39c610df37cf7`
- **Caminho no Storage (`file_path`):** `acervo/918ae7f2a3d1052b9bd7bfec017851f95afe2c676a9b53d2a0f39c610df37cf7_citologia.pdf`
- **Status de Processamento:** `concluido`

### 2.4 Esclarecimento Técnico das Divergências Anteriores
1. **Divergência de Tamanho (~1.85 MB vs 666 bytes):** O valor de ~1.85 MB citado em relatórios provém do arquivo de ensaio local de Química/Biologia utilizado nos testes mockados Vitest em disco (`homologacao_acervo_quimica_local.test.ts`). No Supabase Staging remoto, o arquivo sempre foi o fixture sintético mínimo de 666 bytes provisionado em H1.07. O banco não sofreu contaminação.
2. **Divergência de Dimensão (768 vs 1536):** O modelo gratuito Google Gemini `text-embedding-004` produz vetores de 768 dimensões, ao passo que a coluna remota foi tipada como `vector(1536)`. Essa incompatibilidade constitui uma pendência técnica para a ativação do pipeline gratuito de novos documentos no Acervo, demandando alteração de schema DDL ou camada adaptadora.

---

## 3. INVENTÁRIO CONSOLIDADO DE FLASHCARDS POR ESTUDANTE

### 3.1 Quantidade Global e Isolamento RLS
A tabela `public.cards` possui `FORCE ROW LEVEL SECURITY`. O comportamento das consultas varia conforme o contexto de autenticação:

| Contexto da Consulta SQL | Quantidade de Cards Retornados | Comportamento RLS Explicado |
| :--- | :---: | :--- |
| **Consulta Direta (sem contexto)** | **0** | **Fail-Closed:** Como `medicina.current_perfil_id()` é nulo, as políticas recusam acesso por padrão, evitando vazamento anônimo. |
| **Contexto de Alice (`estudante`)** | **3** | Política `cards_estudante_select_policy` projeta estritamente os cards onde `perfil_id = alice_id`. |
| **Contexto de Carlos (`estudante`)** | **2** | Política `cards_estudante_select_policy` projeta estritamente os cards onde `perfil_id = carlos_id`. |
| **Contexto de Bruno (`responsavel`)**| **5** | Política `cards_responsavel_admin_policy` permite visão global tutorial dos cartões cadastrados. |

**Quantidade Global Real no Banco:** **5 cartões**.

### 3.2 Detalhamento dos Cartões de Alice (`10000000-0000-4000-8000-000000000001`)
| Card ID | Frente do Flashcard | Estado FSRS | Avaliações em `card_revisoes` |
| :--- | :--- | :---: | :--- |
| `c1000000-0000-4000-8000-000000000001` | Mitocôndria produz ATP via? | `learning` | 1 revisão gravada: nota **Bom (3)** (`good`) em 13/11/2026. |
| `c1000000-0000-4000-8000-000000000002` | Fórmula da velocidade média no MRU? | `review` | 1 revisão gravada: nota **Fácil (4)** (`easy`) em 13/11/2026. |
| `c1000000-0000-4000-8000-000000000003` | Elementos da intervenção no ENEM? | `relearning` | 1 revisão gravada: nota **Errei (1)** (`again`) em 13/11/2026. |

*Total de Alice:* 3 cartões e 3 revisões concluídas.

### 3.3 Detalhamento dos Cartões de Carlos (`30000000-0000-4000-8000-000000000001`)
| Card ID | Frente do Flashcard | Estado FSRS | Avaliações em `card_revisoes` |
| :--- | :--- | :---: | :--- |
| `c2000000-0000-4000-8000-000000000001` | Grandezas inversamente proporcionais têm? | `new` | Zero revisões gravadas (estado virgem). |
| `c2000000-0000-4000-8000-000000000002` | Volume molar na CNTP de gás ideal? | `review` | Zero revisões gravadas. |

*Total de Carlos:* 2 cartões e 0 revisões (isolamento relacional 100% preservado; Carlos nunca acessou ou modificou dados de Alice).

---

## 4. RESULTADO DA CORREÇÃO SQL DE SIMULADOS

### 4.1 Diagnóstico do Erro 42804
A execução de `SELECT * FROM public.vw_simulados_evolucao;` no PostgreSQL 17 do Supabase Staging falha com:
```text
PostgresError: structure of query does not match function result type
  code: '42804'
  detail: 'Returned type timestamp without time zone does not match expected type date in column 2.'
```
**Causa:** Na função `medicina.fn_simulados_evolucao()`, a cláusula `RETURNS TABLE` declara a coluna `data date`, mas o `SELECT` projeta `s.data`, que na tabela base `public.simulados` é do tipo `timestamp without time zone`.

### 4.2 Verificação de Mecanismo Administrativo de Migração
Foi inspecionado se existia algum mecanismo administrativo de migração configurado, autorizado e legitimamente acessível ao Antigravity sem exigir intervenção manual:
1. **Credenciais em `.env.local`:** Apenas `DATABASE_APP_URL` (`medicina_app`) e `DATABASE_AUTH_URL` (`medicina_auth`) estão presentes. Ambas são papéis de runtime restritos a DML sob RLS.
2. **Permissões no Schema `medicina`:** A role conectada `medicina_app` não possui o privilégio `CREATE` no schema `medicina` (`PostgresError 42501 permission denied for schema medicina`).
3. **Mecanismo de Migração do Repositório (`scripts/db/`):** Todos os lançadores históricos de migração administrativa (`apply-staging-step1.mjs` até `apply-staging-step9.mjs`) exigem senha interativa da role administrativa `postgres` digitada em terminal pelo operador (`promptHiddenPassword`). A credencial administrativa não reside em texto plano nem em variáveis de ambiente.
4. **Aplicação das Diretrizes de Segurança:** Em cumprimento estrito à proibição de solicitar senhas em texto aberto, tentar adivinhar credenciais ou contornar acessos administrativos, nenhuma nova tentativa de DDL foi executada. O bloqueio foi registrado de forma defensiva e fail-closed.

### 4.3 Estado dos Artefatos Preparados
Os scripts permanecem versionados, auditados e prontos para aplicação pelo processo formal de migração:
- Script de Correção: [`docs/modernizacao/propostas/H2_05_FIX_SIMULADOS_EVOLUCAO_PROPOSTA.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/H2_05_FIX_SIMULADOS_EVOLUCAO_PROPOSTA.sql)
- Script de Rollback: [`docs/modernizacao/propostas/H2_05_ROLLBACK_SIMULADOS_EVOLUCAO.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/H2_05_ROLLBACK_SIMULADOS_EVOLUCAO.sql)

*Impacto no Frontend:* Como as Server Actions da aplicação (`src/app/actions/simulados.ts`) consultam as tabelas base diretamente (`public.simulados` e `public.simulado_areas`), o módulo de Simulados funciona perfeitamente na interface web (aprovado nos 7 testes E2E Playwright). No entanto, em respeito às diretrizes, **o módulo não é declarado integralmente homologado em nível de banco de dados**.

---

## 5. PENDÊNCIAS EFETIVAMENTE IMPEDITIVAS PARA PRODUÇÃO

As únicas pendências reais que exigem execução administrativa antes do deploy de produção são:

1. **P-01 — Aplicação da Correção DDL de Simulados (`H2_05`):** Executar a correção de `medicina.fn_simulados_evolucao()` conectando como `postgres` no Supabase para viabilizar consultas diretas à view `vw_simulados_evolucao`.
2. **P-02 — Criação do Índice Único DDL em Gêneros (`uq_generos_nome`):** Executar `CREATE UNIQUE INDEX IF NOT EXISTS uq_generos_nome ON public.generos (lower(nome));` sob a role dona da tabela (`postgres`).
3. **P-03 — Compatibilização Vetorial do Acervo (`vector(1536)` vs `vector(768)`):** Adequar a coluna `acervo_chunks.embedding` para 768 dimensões, permitindo a ingestão real de arquivos via API gratuita do Google Gemini (`text-embedding-004`).

---

## 6. PARECER SOBRE A PRONTIDÃO DO MVP PARA PRODUÇÃO

### **PARECER: APROVADO COM RESSALVAS TÉCNICAS ADMINISTRATIVAS**

**Justificativa Técnica:**
- **Estabilidade do Núcleo da Aplicação:** 100% aprovado. Autenticação, Ciclos de Estudo, Sessões, Algoritmo FSRS de repetição espaçada, Dashboards analíticos com dados reais, Caderno de Erros automático, Redações e Fichas de Gêneros UECE estão consolidados, integrados e validados por 63 testes unitários e 7 testes E2E no Playwright.
- **Segurança e Isolamento RLS:** 100% íntegro. O banco de dados comprovou proteção estrita contra acesso anônimo, segregação absoluta entre perfis (Alice vs Carlos) e privilégios mínimos de runtime.
- **Ressalvas:** Circunscrevem-se a rotinas DDL de banco de dados que dependem da role administrativa `postgres` e da padronização dimensional dos embeddings para operação gratuita no Acervo.

---

## 7. PRÓXIMO PASSO MÍNIMO RECOMENDADO

Sem criar novas tarefas intermediárias, recomenda-se a execução de **um único lote administrativo de migração** via console Supabase SQL Editor (ou via script CLI fornecendo a senha do usuário `postgres` no prompt protegido):

1. Executar o script DDL consolidado contendo:
   - A substituição de `medicina.fn_simulados_evolucao()` com o cast `s.data::date AS data`.
   - A criação do índice `uq_generos_nome` em `public.generos`.
   - A adaptação da coluna `acervo_chunks.embedding` para `extensions.vector(768)`.
2. Validar o desaparecimento do erro 42804 na view `vw_simulados_evolucao`.
3. Iniciar o processo de deploy e publicação de produção.
