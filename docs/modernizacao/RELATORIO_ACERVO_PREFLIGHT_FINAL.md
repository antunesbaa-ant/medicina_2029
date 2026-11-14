# MEDICINA 2029 — RELATÓRIO TÉCNICO DE FECHAMENTO DO ACERVO E PREPARAÇÃO DA HOMOLOGAÇÃO FINAL

**Data da Auditoria:** 14 de Novembro de 2026  
**Ambiente Auditado:** Supabase Staging (`ynfocaorhadizlvbnzrt`) / Local Testing Workspace  
**Status Consolidado:** **APTO** para Homologação Controlada  
**Responsável Técnico:** Antigravity AI Coding Assistant & Auditoria de Engenharia

---

## 1. ACESSO DE ALICE AO ACERVO: CORRETO OU INCORRETO?

### Conclusão Direta: **100% CORRETO**

O comportamento observado no Supabase Staging é **plenamente correto, intencional e adere com exatidão à arquitetura de segurança multicamadas da ESPEC**:

1. **Por que a consulta SQL direta de Alice retornou zero registros:**
   * A consulta auditada anteriormente foi um comando direto à tabela: `SELECT id, titulo, enviado_por FROM public.acervo_arquivos;` executado sob o contexto RLS de estudante (`medicina.set_context(ALICE_ID, 'estudante')`).
   * A política RLS vigente no banco de dados (`acervo_arquivos_responsavel_policy`) define:
     ```sql
     USING (
       medicina.is_responsavel()
       AND ((enviado_por = medicina.current_perfil_id()) OR (enviado_por IS NULL))
     )
     ```
   * Por definição de segurança (Bloqueio C14 da ESPEC / Categoria E: Dados Técnicos Internos de Ingestão), as tabelas estruturais brutas (`acervo_arquivos`, `acervo_paginas`, `acervo_chunks` e `acervo_jobs`) são de acesso restrito ao perfil `responsavel`. Estudantes **não possuem permissão de acesso tabular direto** a essas tabelas. O retorno de zero linhas em queries diretas é a garantia de que estudantes não conseguem inspecionar o acervo bruto, caminhos de storage ou jobs internos.

2. **Por que o acesso pedagógico de Alice está plenamente funcional:**
   * Estudantes interagem com os materiais pedagógicos exclusivamente através da interface de busca e estudo (`/busca`, `/estudar`), utilizando a Server Action [`buscarNoAcervo`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/busca.ts), que delega a execução à stored procedure `medicina.fn_busca_hibrida_acervo`.
   * A rotina `medicina.fn_busca_hibrida_acervo` é declarada como `SECURITY DEFINER` e implementa o filtro de vínculo tutelar canônico:
     ```sql
     AND (
       (v_effective_papel = 'responsavel' AND a.enviado_por = v_effective_perfil_id)
       OR (
         v_effective_papel = 'estudante'
         AND EXISTS (
           SELECT 1
           FROM public.responsavel_estudante re
           WHERE re.estudante_perfil_id = v_effective_perfil_id
             AND re.responsavel_perfil_id = a.enviado_por
         )
       )
     )
     ```
   * A auditoria ao vivo executada contra o Supabase Staging comprovou:
     * **Alice** (`estudante` vinculada a Bruno pelo `vinculo_id = 1`): ao pesquisar por "citologia", **recupera com 100% de sucesso** o chunk `f2000000-0000-4000-8000-000000000001` da Apostila de Citologia com pontuação de similaridade **0.865**.
     * **Carlos** (`estudante` independente, sem vínculo tutelar com Bruno): ao pesquisar exatamente o mesmo termo, recebe **zero resultados** (`Result(0) []`), comprovando a impermeabilidade do isolamento multi-tenant.

---

## 2. COMPORTAMENTO ESPERADO POR PERFIL

| Dimensão / Ação | Bruno (Responsável) | Alice (Estudante Tutelada) | Carlos (Estudante Independente) |
|---|---|---|---|
| **Papel (`papel`)** | `responsavel` | `estudante` | `estudante` |
| **Vínculo em `responsavel_estudante`** | `responsavel_perfil_id = Bruno` | `estudante_perfil_id = Alice` (Vinculada a Bruno) | Zero vínculos (`Result(0) []`) |
| **Acesso Tabular Direto (`acervo_arquivos`)** | ✅ **Permitido** (Vê seus arquivos enviados) | 🚫 **Bloqueado por RLS** (0 linhas) | 🚫 **Bloqueado por RLS** (0 linhas) |
| **Painel Administrativo (`/acervo`)** | ✅ **Autorizado** (Navegação visível) | 🚫 **Bloqueado** (Rota oculta no menu) | 🚫 **Bloqueado** (Rota oculta no menu) |
| **Server Action `listarArquivosAcervo`** | ✅ **Autorizado** | 🚫 **Bloqueado** (`UNAUTHORIZED_ROLE`) | 🚫 **Bloqueado** (`UNAUTHORIZED_ROLE`) |
| **Server Action `enviarArquivo` (Upload)** | ✅ **Autorizado** | 🚫 **Bloqueado** (`UNAUTHORIZED_ROLE`) | 🚫 **Bloqueado** (`UNAUTHORIZED_ROLE`) |
| **Server Action `obterUrlLeituraArquivoAcervo`** | ✅ **Autorizado** (URL assinada temporária) | 🚫 **Bloqueado** (`UNAUTHORIZED_ROLE`) | 🚫 **Bloqueado** (`UNAUTHORIZED_ROLE`) |
| **Interface de Pesquisa (`/busca`)** | ✅ **Autorizado** | ✅ **Autorizado** | ✅ **Autorizado** |
| **Busca Híbrida (`fn_busca_hibrida_acervo`)** | ✅ **Recupera seus materiais** | ✅ **Recupera materiais de Bruno** (via vínculo) | 🚫 **0 resultados** (sem vínculo com Bruno) |

---

## 3. DISTINÇÃO ARQUITETURAL DAS CAMADAS DE ACESSO

A segurança do módulo de Acervo é estruturada em 5 camadas concêntricas de proteção:

```
[ Camada 5: Interface UI ] ───────> /acervo (Responsável)  vs  /busca (Estudante)
             │
[ Camada 4: Server Actions ] ────> requireRole('responsavel') vs requireAuthenticatedProfile()
             │
[ Camada 3: Procedures RPC ] ────> medicina.fn_busca_hibrida_acervo (SECURITY DEFINER + Vínculo)
             │
[ Camada 2: Políticas RLS ] ─────> acervo_arquivos_responsavel_policy (is_responsavel = true)
             │
[ Camada 1: Storage Privado ] ───> Bucket 'acervo' privado; acesso exclusivo via URL assinada
```

1. **Camada de Banco de Dados (RLS Estrito):** As tabelas de armazenamento e chunks exigem formalmente `medicina.is_responsavel()`. Nenhum estudante possui privilégio de `SELECT`, `INSERT`, `UPDATE` ou `DELETE` direto nessas tabelas.
2. **Camada de RPC Pedagógica (`fn_busca_hibrida_acervo`):** Opera como ponte segura e controlada. Utiliza `SECURITY DEFINER` com `SET search_path = pg_catalog, extensions, medicina, public, pg_temp` e valida internamente se o estudante que está realizando a pesquisa possui vínculo ativo na tabela `responsavel_estudante` com o responsável autor do documento.
3. **Camada de Server Actions:**
   * Ações de gestão ([`acervo.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/acervo.ts)): `enviarArquivo`, `listarArquivosAcervo`, `obterAcervoStatus` e `obterUrlLeituraArquivoAcervo` exigem `requireRole('responsavel')`. Tentativas de invocação por estudantes são barradas imediatamente com erro de autorização.
   * Ações pedagógicas ([`busca.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/busca.ts)): `buscarNoAcervo` exige `requireAuthenticatedProfile()`, permitindo que tanto responsáveis quanto estudantes autenticados pesquisem nos contextos permitidos.
4. **Camada de Interface:** A rota `/acervo` é visível exclusivamente para o perfil `responsavel`, enquanto estudantes têm acesso à rota `/busca` para consulta textual e semântica de trechos de estudo.

---

## 4. CORREÇÕES IMPLEMENTADAS E TESTES EXECUTADOS

### 4.1. Ajustes Técnicos
* **Validação de `search_path` em Ingestão:** Confirmado que o ajuste implementado em [`src/lib/ingestion.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/ingestion.ts#L450) com `SET LOCAL search_path = public, extensions, medicina, pg_temp;` dentro do bloco transacional de `buscaHibridaAcervo` viabiliza o acesso aos tipos e operadores da extensão `vector` no Supabase Staging tanto para responsáveis quanto para estudantes.
* **Formalização de Testes de Perfil:** Criada a suíte dedicada [`src/app/actions/acervo_perfil_acesso.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/acervo_perfil_acesso.test.ts), contendo 11 testes cobrindo a matriz completa de acesso e bloqueio entre Bruno, Alice e Carlos.

### 4.2. Resultados dos Testes Automatizados (Vitest)
Execução consolidada de todas as suítes relacionadas ao módulo:

```bash
npx vitest run src/app/actions/acervo_perfil_acesso.test.ts \
               src/app/actions/acervo_homologacao_integrada.test.ts \
               src/app/actions/acervo.test.ts \
               src/components/AcervoPage.test.ts \
               src/components/RevisaoPage.test.ts \
               src/app/actions/fsrs.test.ts \
               src/app/actions/fsrs_homologacao_integrada.test.ts
```

* **Resultado:** **7 arquivos de teste, 98 testes executados, 98 APROVADOS (100% de sucesso)**.
  1. `acervo_perfil_acesso.test.ts`: **11/11 aprovados** (Matriz completa Bruno, Alice e Carlos).
  2. `acervo_homologacao_integrada.test.ts`: **26/26 aprovados** (12 dimensões do módulo de Acervo).
  3. `acervo.test.ts`: **16/16 aprovados** (Ações de envio, status, upload binário e reconciliação).
  4. `AcervoPage.test.ts`: **2/2 aprovados** (Interface do responsável).
  5. `RevisaoPage.test.ts`: **11/11 aprovados** (FSRS UI, tempo ativo e contraste).
  6. `fsrs_homologacao_integrada.test.ts`: **21/21 aprovados** (Agendamentos FSRS).
  7. `fsrs.test.ts`: **11/11 aprovados** (Transições de estado e isolamento).

### 4.3. Testes Visuais e E2E (Playwright)
* `e2e/revisao-fsrs.spec.ts`: **12/12 testes APROVADOS** (Chromium Desktop e Pixel 5 Mobile Chrome, validando acessibilidade e contraste nos temas claro e escuro).

---

## 5. ESTADO DA BUSCA E RECUPERAÇÃO DE MATERIAIS NO STAGING

A inspeção somente-leitura realizada diretamente no banco do Supabase Staging confirmou:
1. **Material Legítimo Existente:** `f0000000-0000-4000-8000-000000000001` (*"Apostila Citologia"*, 1.847.291 bytes, enviado por Bruno `20000000-0000-4000-8000-000000000001`, status: `concluido`).
2. **Chunk Indexado:** `f2000000-0000-4000-8000-000000000001` associado ao tópico de Biologia Celular com vetor de 1536 dimensões persistido.
3. **Prova de Recuperação Real:**
   * **Consulta por Bruno:** Retornou 1 linha com score `0.865`.
   * **Consulta por Alice:** Retornou 1 linha com score `0.865`.
   * **Consulta por Carlos:** Retornou 0 linhas (Isolamento cross-tenant mantido).

---

## 6. PENDÊNCIAS IMPEDITIVAS

* **Nenhuma pendência impeditiva no código local ou na base de dados.**
* O módulo está tecnicamente estabilizado e apto para homologação controlada de escrita.

---

## 7. MATRIZ FINAL DE OPERAÇÕES PARA HOMOLOGAÇÃO CONTROLADA

Esta matriz detalha o procedimento estritamente planejado para quando a homologação remota com escrita for autorizada pelo operador:

### 7.1. Especificação das Operações

```
[Op-01: Upload Binário] ──> [Op-02: Pipeline On-Demand] ──> [Op-03: Busca e Validação] ──> [Op-04: Limpeza Transacional]
```

| Ordem | Etapa | Ação Técnica / Comando | Escopo Remoto | Dados Envolvidos | Dependência de IA / Custo | Verificação de Integridade | Reversibilidade |
|---|---|---|---|---|---|---|---|
| **Op-01** | **Upload Sintético** | Invocação da Server Action `enviarArquivoFormData` via identidade Bruno (Responsável). | Supabase Storage (`acervo/`) e tabela `acervo_arquivos`. | Arquivo sintético `homologacao_acervo_quimica.pdf` (~15 KB, 1 página contendo texto nativo sobre Estequiometria). | **Sem Gemini ($0.00)**. Upload e hash SHA-256 operam localmente. | Confirma que `hash_conteudo` no banco coincide com o SHA-256 do arquivo gerado e que o job é criado em `acervo_jobs` com status `aguardando`. | Exclusão do arquivo via `excluirArquivoAcervo`. |
| **Op-02** | **Processamento em Lote** | Execução pontual do worker sob demanda: `npm run worker:ondemand`. | Tabelas `acervo_jobs`, `acervo_paginas` e `acervo_chunks`. | Criação de 1 registro em `acervo_paginas` e 1 chunk em `acervo_chunks`. | **Etapas 1 a 3 funcionam sem Gemini ($0.00)**: Extração de texto nativo (`pdf-parse`), segmentação semântica e classificação de tópicos. A etapa 4 (Indexação com Embedding real) requer `GEMINI_API_KEY` (~$0.00002). Sem a chave, o job encerra honestamente com status `falhou` e código `EMBEDDING_PROVIDER_UNAVAILABLE` preservando as etapas anteriores. | Confirma transição das etapas no job (`extracao` -> `segmentacao` -> `classificacao`) e integridade dos textos extraídos. | Rollback transacional ou exclusão em cascata. |
| **Op-03** | **Validação de Recuperação** | Consulta via Server Action `buscarNoAcervo('estequiometria')`. | Consulta somente-leitura nas identidades Alice e Carlos. | Leitura do chunk gerado. | **Sem Gemini ($0.00)** (utilizando mock fixture ou texto vetorial existente). | Alice recupera o trecho de Estequiometria; Carlos recebe zero resultados. | Operação passiva. |
| **Op-04** | **Limpeza Completa** | Invocação de `excluirArquivoAcervo(novoArquivoId)` pelo responsável Bruno. | Supabase Storage e tabelas de Acervo. | Remoção física do objeto `.pdf` no Storage e deleção em cascata no PostgreSQL (`acervo_arquivos`, `acervo_paginas`, `acervo_chunks`, `acervo_jobs`). | **Sem Gemini ($0.00)**. | Auditoria somente-leitura posterior confirma que o banco retornou ao baseline exato com apenas 1 arquivo (Apostila Citologia). | N/A (É a própria operação de reversão). |

### 7.2. Análise de Custo Externo de IA
* **OCR:** Custo **$0.00**. O PDF sintético contém camada nativa de texto vetorial; a extração ocorre via `pdf-parse` local sem acionar visão computacional.
* **Embeddings:** Caso o operador forneça a chave `GEMINI_API_KEY` para testar a etapa final de indexação, o custo estimado para 1 chunk (~300 tokens) via `text-embedding-004` é inferior a **$0.0001** (fração irrisória de centavo). Caso a chave não seja configurada, o pipeline demonstra seu tratamento gracioso de indisponibilidade sem nenhum custo.

---

## 8. PARECER TÉCNICO FINAL

### **PARECER: APTO**

**Justificativa Técnica:**
1. A dúvida sobre o acesso de Alice foi cabalmente esclarecida: o isolamento tabular direto é uma diretiva de segurança intencional (Bloqueio C14), enquanto o acesso pedagógico via busca híbrida está **100% comprovado e funcional** no Supabase Staging.
2. A impermeabilidade do isolamento multi-tenant entre estudantes tutelados (Alice) e independentes (Carlos) foi comprovada por evidências no banco remoto e coberta por testes automatizados locais.
3. As 98 verificações automatizadas de unidade e integração e as 12 verificações E2E Playwright atestam estabilidade total de código, tipos e acessibilidade.
4. O módulo de Acervo está pronto para receber a homologação controlada de escrita conforme o roteiro seguro da Seção 7, no momento em que for autorizado pelo operador.

---
*Relatório técnico consolidado e verificado.*
