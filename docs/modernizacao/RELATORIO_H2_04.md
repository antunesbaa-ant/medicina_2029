# MEDICINA 2029 — H2.04: PREPARAÇÃO DA HOMOLOGAÇÃO FUNCIONAL
## Relatório Técnico de Engenharia, Matriz de Prontidão, Personas Sintéticas e Procedimento Seguro de Homologação

---

### Sumário Executivo

O presente documento consolida a preparação técnica e metodológica para a **Homologação Funcional do Medicina 2029 em ambiente de Supabase Staging (`ynfocaorhadizlvbnzrt`)**, utilizando dados 100% sintéticos (Zero PII).

A fase anterior (**H2.03-R2D**) homologou com sucesso a recuperação física e lógica do backup baseline criptografado no PostgreSQL local descartável (`pg-test-restore` na porta 5433), confirmando:
- Aplicação canônica das 9 migrações estruturais;
- Validação das 5 conexões técnicas com papéis de menor privilégio;
- Verificação do catálogo com as 10 funções canônicas do domínio no schema `medicina`;
- Conformidade integral em 7/7 etapas de auditoria com status `100% APTO`.

O objetivo da tarefa **H2.04** é preparar o plano e os artefatos de homologação funcional da aplicação, distinguindo o que está efetivamente operacional do que depende de serviços de nuvem ou integrações mockadas, provando matematicamente o isolamento de Row-Level Security (RLS) entre múltiplos estudantes e estabelecendo o procedimento reversível de limpeza pós-homologação.

---

### 1. Estado Atual das Funcionalidades

Para garantir rigor técnico, a aplicação foi submetida a uma auditoria estrita de código e dependências. **O sistema não é presumido 100% operacional apenas porque o banco foi validado**. As funcionalidades foram categorizadas em três grupos fundamentais:

| Módulo / Funcionalidade | Classificação | Status Atual | Detalhamento Técnico & Dependências |
| :--- | :--- | :--- | :--- |
| **Autenticação por Credenciais** | **Pronta (Ready)** | Operacional | Implementada em `src/lib/auth-options.ts`. Utiliza chamada a `medicina.autenticar_por_email` com bcrypt e hash padrão de benchmark (`TIMING_BENCHMARK_HASH`) para proteção estrita contra *timing side-channel attacks*. |
| **Proteção de Rotas (Middleware)** | **Pronta (Ready)** | Operacional | Configurada em `src/middleware.ts` com NextAuth `withAuth`. Intercepta compulsivamente rotas de aplicação (`/`, `/ciclo`, `/acervo`, `/caderno-erros`, `/responsavel`) e libera apenas rotas públicas (`/login`, `/api/auth/*` e estáticos). |
| **Autorização & Contexto RLS** | **Pronta (Ready)** | Operacional | Implementada em `src/lib/authorization.ts` e `src/db/rls-context.ts`. Injeta `medicina.set_context(perfil_id, papel)` transacionalmente com `SET LOCAL` descartável no `COMMIT`/`ROLLBACK`. |
| **Vínculo Responsável-Estudante** | **Pronta (Ready)** | Operacional | Tabela `public.responsavel_estudante` e função canônica `medicina.current_managed_estudante_id()`. O responsável tem escopo restrito ao estudante tutorado. |
| **Acompanhamento Quinzenal (ESPEC 1.2)** | **Pronta (Ready)** | Operacional | View agregada `public.vw_acompanhamento_quinzenal` e Server Action `obterAcompanhamentoQuinzenal()`. Respeita a diretriz de privacidade da ESPEC: zero acesso a sessões individuais brutas pelo responsável. |
| **Ciclo de Estudos Pedagógico** | **Pronta (Ready)** | Operacional | Server Actions em `src/app/actions/ciclo.ts`. Distribuição de 28 blocos semanais, avanço modular de ordem e reconciliação com `pg_advisory_xact_lock`. |
| **Sessões de Estudo & Cronômetro** | **Pronta (Ready)** | Operacional | Server Actions em `src/app/actions/sessao.ts`. Controle de etapas pedagógicas, reconciliação temporal no servidor com teto anti-fraude de relógio cliente e advisory locks contra concorrência. |
| **Caderno de Erros Pedagógico** | **Pronta (Ready)** | Operacional | Server Action em `src/app/actions/cadernoErros.ts`. Consulta filtrada por disciplina, tipo de erro (`conteudo`, `interpretacao`, `distracao`, `calculo`, `tempo`) e resolução. |
| **Flashcards com Algoritmo FSRS** | **Pronta (Ready)** | Operacional | Implementado em `src/app/actions/fsrs.ts` via biblioteca `ts-fsrs`. Agendamento de repetição espaçada, recálculo de estabilidade, dificuldade e estados (`new`, `learning`, `review`, `relearning`). |
| **Supabase Storage (Acervo Privado)** | **Dependente de Infra** | Infraestrutura | Módulo `src/lib/supabaseStorage.ts`. Requer existência física do bucket privado `acervo` no projeto Staging e políticas de storage ativas (migração Step 7). Fallback persistente registra metadados em `public.acervo_arquivos` com deduplicação SHA-256. |
| **Fila de Ingestão de Documentos** | **Dependente de Infra** | Infraestrutura | Tabela `public.acervo_jobs` e `src/lib/acervoPipelineWorker.ts`. Modelo durável com leases e advisory lock. Execução depende da ativação de worker em background ou invocação controlada sob demanda. |
| **Busca Híbrida (Full-Text + Vetorial)** | **Dependente de Infra** | Infraestrutura | Função `medicina.fn_busca_hibrida_acervo` com pgvector `0.8.2` (HNSW) e dicionário de língua portuguesa. A busca textual opera imediatamente; a busca vetorial para queries dinâmicas requer embeddings de 1536 dimensões. |
| **Geração de Conteúdo IA (Gemini)** | **Pendente / Mockada** | Mockada | Módulo `src/lib/gemini.ts`. Em conformidade com a restrição de custo zero, chamadas pagas da API do Google Gemini permanecem desativadas em homologação baseline, operando via mocks determinísticos. |
| **OCR de Documentos Escaneados** | **Pendente / Mockada** | Mockada | Pipeline de extração visual. Documentos didáticos de homologação são estruturados nativamente em PDF 1.4 com fluxo de texto embutido, dispensando OCR de imagem. |
| **Disparo de E-mails Transacionais** | **Pendente / Mockada** | Mockada | Gestão de convites e recuperação de conta controlada via `public.allowlist` estática de homologação, sem dependência de SMTP externo. |

---

### 2. Especificação dos Usuários Sintéticos (Zero PII)

Para homologar a plataforma sem expor dados pessoais reais (Zero PII) e provar a eficácia dos guardrails de segurança, foram estabelecidos cenários para **três personas determinísticas**:

```
                 ┌──────────────────────────────────────────────┐
                 │          Bruno Responsável Sintético         │
                 │      (20000000-0000-4000-8000-000000000001)  │
                 │          bruno@medicina2029.staging          │
                 └──────────────────────┬───────────────────────┘
                                        │
                         Vínculo Tutelar│ Exclusivo
                   (responsavel_estudante │ vinculo_id = 1)
                                        ▼
    ┌────────────────────────────────────────┐       ┌────────────────────────────────────────┐
    │        Alice Estudante Sintética       │       │    Carlos Estudante Independente       │
    │  (10000000-0000-4000-8000-000000000001)│       │  (30000000-0000-4000-8000-000000000001)│
    │       alice@medicina2029.staging       │       │       carlos@medicina2029.staging      │
    ├────────────────────────────────────────┤       ├────────────────────────────────────────┤
    │ • Ciclo Alice (28 blocos)              │       │ • Ciclo Carlos (28 blocos indep.)      │
    │ • Cards FSRS de Alice                  │  RLS  │ • Cards FSRS de Carlos                 │
    │ • Sessões de Estudo de Alice           │ ISOL. │ • Sessões de Estudo de Carlos          │
    │ • Erros de Estudo de Alice             │◄─────►│ • Erros de Estudo de Carlos            │
    │ • Visível em visão quinzenal a Bruno   │       │ • BLOQUEIO TOTAL A BRUNO (HTTP 403)    │
    └────────────────────────────────────────┘       └────────────────────────────────────────┘
```

#### Persona 1: Alice Estudante Sintética
- **UUID Canônico:** `10000000-0000-4000-8000-000000000001`
- **E-mail:** `alice@medicina2029.staging`
- **Papel:** `estudante`
- **Vínculo Tutelar:** Tutelada por Bruno em `public.responsavel_estudante`.
- **Artefatos Didáticos:** Possui ciclo ativo de 28 blocos pedagógicos semanais (`STAGING_ALICE_CICLO_ID = 40000000-0000-4000-8000-000000000001`), cards FSRS ativos, histórico de sessões e erros catalogados.
- **Autorização:** Acessa somente as suas próprias entidades didáticas. Proibida de acessar Carlos e proibida de enviar arquivos para o acervo.

#### Persona 2: Bruno Responsável Sintético
- **UUID Canônico:** `20000000-0000-4000-8000-000000000001`
- **E-mail:** `bruno@medicina2029.staging`
- **Papel:** `responsavel`
- **Vínculo Tutelar:** Tutor exclusivo de Alice (`vinculo_id = 1`).
- **Artefatos Operacionais:** Envia apostilas didáticas sintéticas para o acervo (`public.acervo_arquivos`), efetua curadoria de itens gerados (`public.curadoria_fila`) e consulta acompanhamento quinzenal.
- **Autorização:** Visualiza exclusivamente dados agregados de Alice via `public.vw_acompanhamento_quinzenal` e `medicina.current_managed_estudante_id()`. Bloqueado de ver sessões brutas individuais de Alice (Princípio 1.2 da ESPEC) e sumariamente bloqueado de acessar qualquer dado de Carlos.

#### Persona 3: Carlos Estudante Sintético Independente
- **UUID Canônico:** `30000000-0000-4000-8000-000000000001`
- **E-mail:** `carlos@medicina2029.staging`
- **Papel:** `estudante`
- **Vínculo Tutelar:** **Nenhum**. Carlos é um estudante autônomo sem responsável cadastrado.
- **Artefatos Didáticos:** Ciclo próprio de 28 blocos semanais (`STAGING_CARLOS_CICLO_ID = 40000000-0000-4000-8000-000000000003`), cards próprios e sessões independentes.
- **Propósito de Segurança:** Validar a fronteira cross-tenant e o isolamento fail-closed de RLS. Provar que Alice não enxerga Carlos, Carlos não enxerga Alice e Bruno não tem visibilidade alguma sobre Carlos.

---

### 3. Matriz de Segurança e Isolamento RLS

Os testes automatizados executados sobre motor PostgreSQL real validaram a eficácia dos guardrails e das políticas de segurança:

| Cenário de Teste | Operação Avaliada | Ator | Resultado Esperado | Resultado Observado | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **RLS-01** | Leitura de `public.ciclos` e `cards` | Alice (`estudante`) | Apenas dados onde `perfil_id = Alice` (Zero linhas de Carlos). | Retornou 1 ciclo e cards de Alice; 0 registros de Carlos. | **APROVADO** |
| **RLS-02** | Leitura de `public.ciclos` e `cards` | Carlos (`estudante`) | Apenas dados onde `perfil_id = Carlos` (Zero linhas de Alice). | Retornou 1 ciclo e cards de Carlos; 0 registros de Alice. | **APROVADO** |
| **RLS-03** | Resolução de Estudante Tutelado | Bruno (`responsavel`) | `medicina.current_managed_estudante_id()` retorna Alice. | Retornou estritamente o UUID de Alice. | **APROVADO** |
| **RLS-04** | Tentativa de Leitura de Sessões Brutas | Bruno (`responsavel`) | 0 linhas retornadas na tabela `public.sessoes` (Princípio 1.2 ESPEC). | 0 linhas retornadas. | **APROVADO** |
| **RLS-05** | Tentativa de Acesso a Estudante Não Vinculado | Bruno (`responsavel`) | Bloqueio total em consultas aos ciclos e sessões de Carlos. | 0 linhas retornadas para qualquer query de Carlos. | **APROVADO** |
| **RLS-06** | Escalada de Privilégio (Role Mismatch) | Alice (`estudante`) | `SELECT medicina.set_context(Alice, 'responsavel')` deve falhar com erro fatal `P0001`. | Rejeitado: `Contexto invalido: perfil ... com papel responsavel nao existe.` | **APROVADO** |
| **RLS-07** | UUID Forjado / Inexistente | Qualquer | `SELECT medicina.set_context('0000...0000', 'estudante')` deve falhar com `P0001`. | Rejeitado fail-closed: `Contexto invalido: perfil ... com papel estudante nao existe.` | **APROVADO** |
| **RLS-08** | Restrição de Upload Privado | Estudante | Tentativa de estudante invocar `enviarArquivo` é rejeitada por `requireRole`. | Lança `AuthorizationError('FORBIDDEN')` antes de tocar storage ou banco. | **APROVADO** |

---

### 4. Procedimento de Limpeza Completa (Teardown Pós-Homologação)

Para garantir que a homologação não deixe nenhum resíduo artificial permanente no Supabase Staging, foi desenvolvido e testado o procedimento completo de limpeza reversa em lote, respeitando a integridade referencial estrita de todas as 16 chaves estrangeiras (`ON DELETE RESTRICT`):

```sql
-- PROTOCOLO TRANSACIONAL DE LIMPEZA PÓS-HOMOLOGAÇÃO
-- Identificadores dos 3 perfis sintéticos:
-- Alice:  10000000-0000-4000-8000-000000000001
-- Bruno:  20000000-0000-4000-8000-000000000001
-- Carlos: 30000000-0000-4000-8000-000000000001

BEGIN;

-- 1. Filas e Jobs Duráveis de Processamento
DELETE FROM public.curadoria_fila
WHERE artefato_id IN (
  SELECT id FROM public.cards WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
) OR artefato_id IN (
  SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
);

DELETE FROM public.acervo_jobs
WHERE enviado_por IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

-- 2. Chunks, Páginas e Arquivos Didáticos do Acervo
DELETE FROM public.acervo_chunks
WHERE arquivo_id IN (
  SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
);

DELETE FROM public.acervo_paginas
WHERE arquivo_id IN (
  SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
);

DELETE FROM public.acervo_arquivos
WHERE enviado_por IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

-- 3. Entidades Pedagógicas do Estudante (Erros, Tentativas e Sessões)
DELETE FROM public.erros
WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

DELETE FROM public.tentativas
WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
   OR sessao_id IN (
     SELECT id FROM public.sessoes WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
   );

DELETE FROM public.sessoes
WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

-- 4. Flashcards e Revisões FSRS
DELETE FROM public.card_revisoes
WHERE card_id IN (
  SELECT id FROM public.cards WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
);

DELETE FROM public.cards
WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

-- 5. Materiais Didáticos, Livros, Repertórios e Redações
DELETE FROM public.materiais
WHERE aprovado_por IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

DELETE FROM public.livros
WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

DELETE FROM public.repertorios
WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

DELETE FROM public.redacoes
WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

-- 6. Simulados, Áreas e Questões de Simulado
DELETE FROM public.simulado_questoes
WHERE simulado_id IN (
  SELECT id FROM public.simulados WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
);

DELETE FROM public.simulado_areas
WHERE simulado_id IN (
  SELECT id FROM public.simulados WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
);

DELETE FROM public.simulado_analise
WHERE simulado_id IN (
  SELECT id FROM public.simulados WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
);

DELETE FROM public.simulados
WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

-- 7. Ciclos Pedagógicos e Estado
DELETE FROM public.ciclo_estado
WHERE ciclo_id IN (
  SELECT id FROM public.ciclos WHERE estudante_perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
);

DELETE FROM public.ciclo_blocos
WHERE ciclo_id IN (
  SELECT id FROM public.ciclos WHERE estudante_perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
);

DELETE FROM public.ciclos
WHERE estudante_perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

-- 8. Vínculos de Tutoria, Revisões Trimestrais e Checkins
DELETE FROM public.revisoes_trimestrais
WHERE estudante_perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
   OR registrada_por_perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

DELETE FROM public.checkins
WHERE perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

DELETE FROM public.responsavel_estudante
WHERE responsavel_perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')
   OR estudante_perfil_id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

-- 9. Perfis Sintéticos e Allowlist
DELETE FROM public.perfis
WHERE id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

DELETE FROM public.allowlist
WHERE email IN ('alice@medicina2029.staging', 'bruno@medicina2029.staging', 'carlos@medicina2029.staging');

COMMIT;
```

---

### 5. Auditoria de Guardrails e Restrições Absolutas

Em conformidade rigorosa com os termos de governança do projeto, foram confirmados os seguintes parâmetros operacionais:

1. **Zero Acesso ao Supabase Staging Remoto nesta Tarefa:**
   - Nenhum usuário foi criado no ambiente remoto do Supabase durante a H2.04.
   - Nenhum seed remoto foi executado.
2. **Zero Custos de APIs Pagas:**
   - Nenhuma chamada à API Google Gemini foi realizada; 100% dos testes e artefatos utilizam vetores mockados determinísticos e estruturas sintéticas.
3. **Preservação de Integridade:**
   - Nenhuma migração existente foi alterada.
   - O ambiente de produção não foi acessado.
   - O contêiner descartável `pg-test-restore` permanece em execução e íntegro em `127.0.0.1:5433`.
4. **Governança Git:**
   - Nenhum comando `git commit`, `git push` ou `deploy` foi executado.
5. **Zero Vazamento de Credenciais:**
   - Nenhuma senha, token ou hash de senha é exposto em logs, relatórios ou argumentos CLI.

---

### 6. Evidências dos Testes Automatizados Locais

A suíte completa de testes automatizados locais foi executada com sucesso absoluto:
- **Suíte de Homologação Funcional H2.04 (`src/app/actions/h2_04_functional_homologation_plan.test.ts`):** 18/18 testes aprovados.
- **Suíte Global de Integridade e Recuperação H2.03 + H2.04:** 93/93 testes aprovados.

```
 RUN  v4.1.12 /Users/brunoantunes/Documents/Projetos IA/medicina_2029-main

 ✓ src/app/actions/h2_03_r2c_restore_audit_fix.test.ts (11 tests) 5766ms
 ✓ src/app/actions/h2_03_r2d_functions_diagnosis.test.ts (5 tests) 2626ms
 ✓ src/app/actions/h2_04_functional_homologation_plan.test.ts (18 tests) 2717ms
 ✓ src/app/actions/h2_03_r_baseline_recovery_validation.test.ts (13 tests) 1588ms
 ✓ src/app/actions/h2_03_staging_baseline_backup.test.ts (12 tests) 1454ms
 ✓ src/app/actions/h2_03_r2b_key_transmission_fix.test.ts (14 tests) 860ms
 ✓ src/app/actions/h2_03_r2_isolated_restore_preparation.test.ts (20 tests) 50ms

 Test Files  7 passed (7)
      Tests  93 passed (93)
   Duration  15.68s
```

---

### 7. Próximo Comando Seguro para Execução Mediante Autorização

Quando o operador humano decidir executar a homologação funcional real contra o Supabase Staging (`ynfocaorhadizlvbnzrt`), os comandos auditados, interativos e seguros são:

#### Passo 1: Inspecionar o Status das Funcionalidades (Somente Leitura)
```bash
node scripts/db/prepare-staging-homologation.mjs --status
```

#### Passo 2: Executar a Provisão dos 3 Usuários Sintéticos no Staging
> Exige confirmação humana explícita (`CONFIRMAR HOMOLOGACAO STAGING`), leitura oculta de senha no terminal e conexão TLS estrita validando `prod-ca-2021.crt`.
```bash
node scripts/db/prepare-staging-homologation.mjs --provision
```

#### Passo 3: Limpeza Completa Pós-Homologação (Retorno ao Baseline Limpo)
> Exige confirmação humana explícita (`CONFIRMAR LIMPEZA HOMOLOGACAO STAGING`), expurgando 100% dos dados sintéticos criados e restaurando a conformidade estrita do baseline auditado.
```bash
node scripts/db/prepare-staging-homologation.mjs --cleanup
```

---

### 8. Conclusão e Parecer de Engenharia

O plano de homologação funcional da H2.04 está **COMPLETO, TESTADO E HOMOLOGADO LOCALMENTE**.
A arquitetura de segurança comprova que o isolamento de Row-Level Security impede qualquer vazamento de dados entre estudantes distintos (Alice e Carlos) e garante que o tutor pedagógico (Bruno) acerte estritamente o estudante a ele vinculado, respeitando todas as diretrizes de privacidade da ESPEC.

O ambiente Staging permanece intacto, pronto para receber a carga controlada assim que autorizada formalmente pelo operador humano.
