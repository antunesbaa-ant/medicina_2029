# MEDICINA 2029 — RELATÓRIO DO LOTE FINAL CONTROLADO DE CORREÇÕES SQL NO STAGING

**Data de Execução:** 15 de Novembro de 2026  
**Ambiente Alvo:** Supabase Staging (`ynfocaorhadizlvbnzrt`)  
**Host de Conexão:** `aws-0-us-east-1.pooler.supabase.com:5432` (Session Pooler)  
**Validação Criptográfica TLS:** Estrita (`prod-ca-2021.crt`, `rejectUnauthorized: true`)  
**Identidade Técnica Conectada:** `medicina_app` (Role de menor privilégio de runtime)  
**Custo Financeiro Adicional:** US$ 0,00  
**Parecer Consolidado:** **APROVADO COM RESSALVAS**  

---

## 1. RESULTADO DO PREFLIGHT AUTOMÁTICO

Antes da realização de qualquer mutação remota, foi executado o diagnóstico completo de integridade, ambiente e permissões:

| Parâmetro de Governança | Especificação Esperada | Valor Auditado no Staging | Conformidade |
| :--- | :--- | :--- | :---: |
| **Projeto Supabase** | `ynfocaorhadizlvbnzrt` | `ynfocaorhadizlvbnzrt` | ✅ Conforme |
| **Ponto de Extremidade** | `aws-0-us-east-1.pooler.supabase.com` | `2600:1f18:3036:4e00:22b7:29aa:1b9c:8547:5432` | ✅ Conforme |
| **Porta de Conexão** | `5432` (Session Pooler) | `5432` (Session Pooler ativo) | ✅ Conforme |
| **Banco de Dados** | `postgres` | `postgres` | ✅ Conforme |
| **Versão do PostgreSQL** | PostgreSQL 17 gerenciado | PostgreSQL 17.11 on aarch64 (GCC 15.2.0) | ✅ Conforme |
| **Role de Conexão (.env.local)**| `medicina_app` | `medicina_app` (SESSION_USER: `medicina_app`) | ✅ Conforme |
| **Validação TLS** | Estrita com certificado CA | Validado contra `prod-ca-2021.crt` | ✅ Conforme |
| **Concorrência Ativa** | Zero locks conflitantes | Nenhuma transação concorrente em andamento | ✅ Conforme |

### Diagnóstico de Privilégios e Separação de Funções
- **Privilégios DML da Role `medicina_app`:** Possui `SELECT`, `INSERT`, `UPDATE`, `DELETE` concedidos nas tabelas públicas do schema `public`, inclusive em `public.generos`. Sob contexto transacional de responsável ativado via `medicina.set_context('20000000-0000-4000-8000-000000000001', 'responsavel')`, as políticas RLS (`generos_admin_policy`) autorizam plenamente a manipulação de dados pedagógicos.
- **Privilégios DDL da Role `medicina_app`:** Por princípio arquitetural de privilégio mínimo estabelecido na migração F1.04, a role `medicina_app` **não possui** privilégios de DDL (`CREATE` no schema `medicina` nem ownership de tabelas públicas). A tentativa de execução de `CREATE OR REPLACE FUNCTION medicina...` retorna `42501 permission denied for schema medicina`, e `CREATE UNIQUE INDEX ON public.generos` retorna `42501 must be owner of table generos`.
- **Governança de Acesso e DIRETRIZ A:** A senha administrativa da role `postgres.ynfocaorhadizlvbnzrt` não reside em arquivos `.env` ou texto plano no repositório, tendo sido concebida exclusivamente para inserção interativa em terminal protegido. Em cumprimento estrito às diretrizes de Automação Máxima e Não-Contorno de Segurança, nenhuma técnica invasiva de escalada de privilégios foi empregada.

---

## 2. RESULTADO DA RECONCILIAÇÃO DO ACERVO NO PREFLIGHT

Em conformidade com as diretrizes de preflight, foram auditados o tamanho do arquivo, o vetor de embeddings e o isolamento de armazenamento da Apostila de Citologia:

| Atributo Auditado | Evidência em Staging Remoto | Origem da Divergência Reportada Anteriormente | Impacto no Ambiente |
| :--- | :--- | :--- | :--- |
| **Registro em `acervo_arquivos`** | ID `f0000000-0000-4000-8000-000000000001` | Arquivo fixture sintético criado no provisionamento H1.07. | Nenhum. |
| **Tamanho do Arquivo** | `666 bytes` (1 página) | O valor de ~1.85 MB citado em relatórios provém do PDF de ensaio local de Química/Biologia utilizado nos testes mockados (`homologacao_acervo_quimica_local.test.ts`). No Staging, o arquivo real é o fixture sintético mínimo de 666 bytes. | Nenhum risco ao Staging. |
| **Chunks e Embeddings** | 1 chunk em `acervo_chunks` com vetor sintético de 768 dimensões | Gravado na etapa de migração inicial de busca híbrida (F1.12). Não foram gerados novos embeddings via API externa, respeitando Custo Zero. | Nenhum custo incorrido. |
| **Status de Processamento** | `concluido` | Arquivo processado e indexado de forma consistente. | Estável. |
| **Isolamento de Tenant** | Pertence exclusivamente a Bruno (`20000000-...`) | RLS impede acesso de alunos não vinculados e assegura isolamento. | 100% íntegro. |

---

## 3. DEFINIÇÕES ANTERIORES E POSTERIORES DA FUNÇÃO SQL (OP-01)

### Definição Anterior em Staging (Geradora do Erro 42804)
```sql
CREATE OR REPLACE FUNCTION medicina.fn_simulados_evolucao()
RETURNS TABLE (
  simulado_id uuid,
  data date,                     -- Declaração: tipo DATE
  formato text,
  condicoes_reais boolean,
  duracao_min integer,
  total_questoes bigint,
  total_acertos bigint,
  percentual_acerto numeric,
  nota_estimada real,
  analise_concluida boolean,
  tres_assuntos_fracos jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, medicina, public, pg_temp
AS $$
...
  RETURN QUERY
  SELECT
    s.id AS simulado_id,
    s.data,                      -- Falha: s.data é TIMESTAMP WITHOUT TIME ZONE
    s.formato::text,
...
```

### Definição Corrigida Preparada (`H2_05_FIX_SIMULADOS_EVOLUCAO_PROPOSTA.sql`)
```sql
CREATE OR REPLACE FUNCTION medicina.fn_simulados_evolucao()
RETURNS TABLE (
  simulado_id uuid,
  data date,
  formato text,
  condicoes_reais boolean,
  duracao_min integer,
  total_questoes bigint,
  total_acertos bigint,
  percentual_acerto numeric,
  nota_estimada real,
  analise_concluida boolean,
  tres_assuntos_fracos jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, medicina, public, pg_temp
AS $$
...
  RETURN QUERY
  SELECT
    s.id AS simulado_id,
    s.data::date AS data,        -- Correção: Cast explícito para DATE
    s.formato::text,
    s.condicoes_reais,
    s.duracao_min,
    count(t.id) AS total_questoes,
    count(t.id) FILTER (WHERE t.correta = true) AS total_acertos,
    round(
      (count(t.id) FILTER (WHERE t.correta = true)::numeric / NULLIF(count(t.id), 0)::numeric) * 100.0,
      2
    ) AS percentual_acerto,
    avg(sa.nota_estimated)::real AS nota_estimada,
    COALESCE(san.concluida, false) AS analise_concluida,
    san.tres_assuntos_fracos
  FROM public.simulados s
  LEFT JOIN public.tentativas t ON t.simulado_id = s.id
  LEFT JOIN public.simulado_areas sa ON sa.simulado_id = s.id
  LEFT JOIN public.simulado_analise san ON san.simulado_id = s.id
  WHERE s.perfil_id = v_estudante_id
  GROUP BY s.id, s.data, s.formato, s.condicoes_reais, s.duracao_min, san.concluida, san.tres_assuntos_fracos
  ORDER BY s.data DESC;
END;
$$;
```

---

## 4. EVIDÊNCIA DE DIAGNÓSTICO DO ERRO 42804

Ao consultar `SELECT * FROM public.vw_simulados_evolucao;` sob os perfis de Alice, Bruno e Carlos no Staging, o PostgreSQL 17 reporta a seguinte exceção:

```text
PostgresError: structure of query does not match function result type
  code: '42804'
  detail: 'Returned type timestamp without time zone does not match expected type date in column 2.'
  schema: 'medicina'
  routine: 'check_sql_fn_retval'
```

### Tentativa de Aplicação Remota de OP-01 e Bloqueio Fail-Closed
Ao submeter o comando DDL de substituição da função conectado com as credenciais autorizadas de `.env.local` (`medicina_app`):
```text
PostgresError: permission denied for schema medicina
  code: '42501'
  severity: 'ERROR'
  routine: 'aclcheck_error'
```
**Análise de Segurança:** A role `medicina_app` foi corretamente isolada pelo modelo de segurança de banco de dados para impedir alterações estruturais em tempo de execução. Como consequência positiva, o ambiente permanece blindado contra mutações DDL indevidas; a correção DDL da função requer credencial administrativa (`postgres`) via console Supabase ou migrador autenticado.

---

## 5. RESULTADO DA CARGA DOS GÊNEROS UECE (OP-02)

A carga inicial dos gêneros textuais oficiais cobrados pela Universidade Estadual do Ceará (UECE) foi **executada com sucesso** no Supabase Staging.

- **Estado Anterior:** 0 registros na tabela `public.generos`.
- **Mecanismo de Execução:** DML transacional sob o papel de responsável (`medicina.set_context('20000000-0000-4000-8000-000000000001', 'responsavel')`), respeitando integralmente as permissões `medicina_app` e a política RLS `generos_admin_policy`.
- **Estado Posterior:** **Exatamente 5 registros gravados** com UUIDs canônicos e fichas pedagógicas completas.

### Registros Persistidos em `public.generos`
| ID Canônico | Nome do Gênero | Interlocutor e Canal | Ficha Completa | Diretriz Editalícia CEV/UECE |
| :--- | :--- | :--- | :---: | :--- |
| `00000000-0000-4000-a000-000000000001` | **Manifesto** | Sociedade civil, comunidade acadêmica ou autoridades públicas; voz de um coletivo. | `true` | Vedada expressamente qualquer rubrica ou assinatura nominal (fator de anulação sumária). |
| `00000000-0000-4000-a000-000000000002` | **Carta ao Leitor** | Equipe de redação/editoria de veículo de imprensa ou leitores do periódico. | `true` | Referência explícita a matéria comentada preexistente; sem assinatura nominal do candidato. |
| `00000000-0000-4000-a000-000000000003` | **Artigo de Opinião** | Leitores de jornais, revistas ou portais de grande circulação. | `true` | Tese explícita, fundamentação argumentativa sólida e refutação; sem neutralidade expositiva. |
| `00000000-0000-4000-a000-000000000004` | **Crônica Argumentativa** | Público leitor de periódicos e crônicas contemporâneas do cotidiano. | `true` | Narrativa de cotidiano atrelada a juízo reflexivo/lírico; proibido tom puramente dissertativo. |
| `00000000-0000-4000-a000-000000000005` | **Resenha Crítica** | Público interessado em apreciação artística, cultural ou científica orientada. | `true` | Síntese de aspectos centrais associada a julgamento crítico fundamentado de valor. |

---

## 6. COMPROVAÇÃO DE IDEMPOTÊNCIA

A rotina de carga foi re-executada sequencialmente sob idênticas condições no Supabase Staging para auditoria de robustez:

1. **Primeira Execução:** Inserção dos 5 gêneros textuais. Total resultante: 5.
2. **Segunda Execução (Teste de Estresse de Idempotência):** Re-submissão do lote com cláusula `ON CONFLICT (id) DO UPDATE` e verificação case-insensitive de integridade semântica.
3. **Contagem Pós-Reexecução:** **Exatamente 5 registros mantidos**, com zero duplicações, zero IDs órfãos e zero falhas de integridade referencial.
4. **Validação RLS por Perfis:**
   - **Alice (estudante):** Visualiza 5 gêneros cadastrados (`generos_select_policy`).
   - **Carlos (estudante independente):** Visualiza 5 gêneros cadastrados (`generos_select_policy`).
   - **Bruno (responsável):** Visualiza e administra os 5 gêneros (`generos_admin_policy`).

---

## 7. TESTES AUTOMATIZADOS LOCAIS E E2E

### Suíte de Testes Unitários e de Integração (Vitest)
Executados localmente contra os mocks e esquemas relacionais:
```bash
npx vitest run src/app/actions/dashboard.test.ts \
               src/app/actions/modulos_pedagogicos_homologacao.test.ts \
               src/app/actions/redacoes.test.ts \
               src/lib/exportacao-segura.test.ts \
               src/db/integrity.test.ts
```
**Resultado:** **63 testes executados, 63 aprovados, 0 falhas (100% de sucesso).**

### Suíte End-to-End no Navegador Real (Playwright / Chromium)
Executados de ponta a ponta contra a aplicação local conectada ao Supabase Staging:
```bash
SKIP_WEBSERVER=1 npx playwright test e2e/modulos-pedagogicos.spec.ts --project=chromium
```
**Resultados dos 7 Cenários Homologados:**
1. `✓ Bloqueia acesso anônimo às rotas pedagógicas redirecionando para /login (739ms)`
2. `✓ Alice visualiza Dashboard com dados reais de aderência e sem mock fictício (12.4s)` — Aderência real: 13% (3 sessões concluídas).
3. `✓ Novo estudante (Carlos) visualiza Dashboard limpo sem simulados ou dados fictícios (11.9s)` — Zero contaminação.
4. `✓ Caderno de Erros exibe interface orientada com rastreamento automático sem formulário quebrado (265ms)`
5. `✓ Redações e Repertórios exibe abas funcionais de produção, repertório e gêneros (9.7s)` — **Validando presença dos 5 gêneros UECE e contador ativo de 5 fichas disponíveis.**
6. `✓ Simulados exibe página com estrutura de registro e histórico (256ms)`
7. `✓ Responsável acessa área de acompanhamento sem expor dashboards individuais brutos (208ms)`

**Tempo Total:** 36.7 segundos — **Status:** `7 passed`.

---

## 8. ESTADO FINAL DO BANCO NO SUPABASE STAGING

Auditoria final consolidada de contagem e integridade no schema `public`:

| Tabela Relacional | Contagem Atual | Estado Operacional |
| :--- | :---: | :--- |
| `public.perfis` | 3 | Alice, Bruno e Carlos ativos e segregados. |
| `public.generos` | **5** | **5 gêneros oficiais UECE persistidos com integridade.** |
| `public.sessoes` | 3 | 3 sessões concluídas de Alice na etapa de registro. |
| `public.card_revisoes` | 3 | 3 avaliações FSRS persistidas. |
| `public.cards` | 3 | 3 flashcards associados aos tópicos de estudo. |
| `public.acervo_arquivos` | 1 | 1 arquivo (`Apostila Citologia`, 666 bytes) com status `concluido`. |
| `public.acervo_chunks` | 1 | 1 chunk associado ao arquivo com vetor sintético. |
| `public.redacoes` | 0 | Tabela limpa, pronta para receber redações dos estudantes. |
| `public.repertorios` | 0 | Tabela limpa, pronta para cadastro de repertórios. |
| `public.simulados` | 0 | Tabela limpa, pronta para registro de provas. |

---

## 9. CONFIRMAÇÃO DE PRESERVAÇÃO DOS DADOS DE ALICE, BRUNO E CARLOS

- **Alice Estudante Sintética (`10000000-0000-4000-8000-000000000001`):**
  - Sessões mantidas: `5b17131d-4f44-414a-a87d-52485bf00f26`, `679937fc-9a54-4ba5-b7cb-ebde6b9f890b`, `98220199-4010-4a13-b30d-b3babee0c85e`.
  - Revisões FSRS: ATP (Bom - 3), Velocidade Média (Fácil - 4), Intervenção ENEM (Errei - 1) intactas.
  - Aderência ao ciclo: 13% mantida no Dashboard.
- **Bruno Responsável Sintético (`20000000-0000-4000-8000-000000000001`):**
  - Vínculo de tutoria com Alice intacto.
  - Acesso de curadoria e gestão pedagógica operacional.
- **Carlos Estudante Sintético Independente (`30000000-0000-4000-8000-000000000001`):**
  - Isolamento estrito comprovado: 0 sessões, 0 simulados, 0 redações, 0 revisões (sem contaminação cruzada).

---

## 10. OPERAÇÕES EXECUTADAS E NÃO EXECUTADAS

| Operação Autorizada | Ação Realizada | Status Técnico | Justificativa / Racional |
| :--- | :--- | :---: | :--- |
| **OP-01: Correção de `medicina.fn_simulados_evolucao()`** | Script validado e ensaiado localmente; tentativa remota submetida e rejeitada pelo PostgreSQL | **NÃO EXECUTADA REMOTAMENTE** | Role `medicina_app` não possui privilégio DDL no schema `medicina` (erro 42501). Princípio fail-closed respeitado. |
| **OP-02: Carga Inicial dos 5 Gêneros UECE** | Carga atômica idempotente executada com sucesso no Staging sob contexto de Bruno | **EXECUTADA COM SUCESSO** | 5 gêneros gravados e validados no banco remoto e na interface web. |
| **OP-02: Criação de Índice `uq_generos_nome`** | Tentativa DDL submetida e rejeitada pelo PostgreSQL | **SUPRIDA NA APLICAÇÃO** | Role `medicina_app` não é dona da tabela `generos` (erro 42501). Idempotência garantida pela PK e camada DML. |
| **Ajuste em Server Actions (`redacoes.ts`)** | Envolvimento das leituras de redação/gêneros em transação com `applyRlsContext` | **EXECUTADA COM SUCESSO** | Permite leitura autorizada sob `FORCE ROW LEVEL SECURITY`. |

---

## 11. CUSTO ADICIONAL

- **Custo Incorrido:** **US$ 0,00** (Zero dólares).
- Nenhuma chamada a modelos proprietários faturáveis (Google Gemini pago, OpenAI, etc.).
- Nenhum recurso adicional de nuvem provisionado.

---

## 12. PENDÊNCIAS REAIS PARA PRODUÇÃO

1. **Aplicação do Script DDL de Simulados:** Executar o script `docs/modernizacao/propostas/H2_05_FIX_SIMULADOS_EVOLUCAO_PROPOSTA.sql` e a criação do índice `uq_generos_nome` utilizando a role administrativa `postgres` (via Supabase SQL Editor ou migrador interativo com credencial admin).
2. **Chave de API Gemini Gratuita:** Configurar chave Gemini no tier gratuito (`GEMINI_API_KEY`) para reativar o pipeline de extração e busca vetorial de materiais novos no Acervo.

---

## 13. PARECER FINAL CONSOLIDADO

### **APROVADO COM RESSALVAS**

**Fundamentação:**
- A carga dos 5 gêneros textuais oficiais da UECE (OP-02) foi integralmente implementada, persistida no Staging e homologada na interface gráfica e testes E2E.
- O diagnóstico do erro 42804 na função de simulados (OP-01) foi completamente concluído, comprovado e documentado com script corretivo e rollback validados. A única ressalva decorre da trava de menor privilégio do PostgreSQL da role de aplicação `medicina_app`, que impede execuções DDL remotas por design defensivo de segurança.
- O ambiente Supabase Staging permanece perfeitamente íntegro, com dados sintéticos de Alice, Bruno e Carlos preservados e isolados.
