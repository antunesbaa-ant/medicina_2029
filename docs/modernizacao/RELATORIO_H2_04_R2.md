# MEDICINA 2029 — RELATÓRIO TÉCNICO H2.04-R2
## PORTÃO FINAL PARA O PRIMEIRO SEED REMOTO NO SUPABASE STAGING

---

### SUMÁRIO EXECUTIVO
* **Identificador da Tarefa:** MEDICINA 2029 — H2.04-R2
* **Fase:** Portão de Segurança Final Pré-Seed Remoto
* **Data de Emissão:** 31 de Outubro de 2026
* **Ambiente Alvo:** Supabase Staging (`ynfocaorhadizlvbnzrt`)
* **Endpoint Canônico:** `aws-0-us-east-1.pooler.supabase.com:5432` (Session Pooler)
* **Certificado CA:** `prod-ca-2021.crt` (SHA-256: `955d5402a50a006ecc0e2ce1c9e429e289bf6b3bfdf5ec9535eef22f2efd1ae7`)
* **Parecer Técnico Conclusivo:** **APTO COM PROTEÇÃO TOTAL (GREEN GATE)**
* **Estado Operacional:** **NENHUM DADO FOI ESCRITO NO STAGING REMOTO NESTA TAREFA**. O banco remoto permanece 100% no estado baseline limpo.

---

### 1. ARQUITETURA DE PROTEÇÃO CONTRA COLISÕES E IDENTIDADE CANÔNICA

Em conformidade rigorosa com a diretriz de **não utilizar `ON CONFLICT DO UPDATE` como substituto de verificação de identidade**, foi implementado o portão transacional `verifySeedIdentityAndCollisions(sql)` acionado no Passo `[0/8]` de `provisionHomologationData`, antes de qualquer instrução DML (`INSERT` ou `UPDATE`).

#### 1.1 Matriz de Identificadores Sintéticos Canônicos (RFC 4122 v4)
| Entidade | Identificador Fixo | Posse / Vínculo Esperado | E-mail / Referência Canônica |
| :--- | :--- | :--- | :--- |
| **Alice (Estudante)** | `10000000-0000-4000-8000-000000000001` | Próprio perfil | `alice@medicina2029.staging` |
| **Bruno (Responsável)** | `20000000-0000-4000-8000-000000000001` | Tutor de Alice | `bruno@medicina2029.staging` |
| **Carlos (Independente)** | `30000000-0000-4000-8000-000000000001` | Próprio perfil | `carlos@medicina2029.staging` |
| **Ciclo Alice** | `40000000-0000-4000-8000-000000000001` | `estudante_perfil_id = Alice.id` | 28 blocos (`41000000-...-0001` a `0028`) |
| **Ciclo Carlos** | `40000000-0000-4000-8000-000000000003` | `estudante_perfil_id = Carlos.id` | 28 blocos (`42000000-...-0001` a `0028`) |
| **Cards Alice (3)** | `c1000000-...-0001` a `0003` | `perfil_id = Alice.id` | Tópicos de Biologia, Física e Redação |
| **Cards Carlos (2)** | `c2000000-...-0001` a `0002` | `perfil_id = Carlos.id` | Tópicos de Matemática e Química |
| **Acervo Apostila** | `f0000000-0000-4000-8000-000000000001` | `enviado_por = Bruno.id` | PDF Sintético com chunk e job vinculados |
| **Tutoria Exclusiva** | `vinculo_id = 1` | `Bruno -> Alice` | `responsavel=Bruno.id`, `estudante=Alice.id` |

#### 1.2 Regras de Detecção Fail-Closed
1. **Colisão de UUID em `perfis`:** Se o UUID de Alice existir vinculado a qualquer outro e-mail que não seja `alice@medicina2029.staging`, aborta imediatamente com `COLISAO_IDENTIDADE_DETECTADA`.
2. **Colisão de E-mail em `perfis`:** Se o e-mail de Alice existir vinculado a qualquer outro UUID, aborta imediatamente.
3. **Colisão em `ciclos`:** Se o ciclo de Alice existir com proprietário diferente de Alice, aborta imediatamente.
4. **Colisão em `ciclo_blocos`:** Se qualquer um dos 56 blocos sintéticos pertencer a ciclo não canônico, aborta imediatamente.
5. **Colisão em `cards`:** Se qualquer card sintético pertencer a perfil de terceiro, aborta imediatamente.
6. **Colisão em `acervo_arquivos`:** Se o arquivo sintético pertencer a autor diferente de Bruno, aborta imediatamente.
7. **Colisão em `responsavel_estudante`:** Se `vinculo_id = 1` possuir participantes divergentes de Bruno e Alice, aborta imediatamente.
8. **Diferenciação de Reexecução Legítima:** Quando o registro preexistente coincide exatamente em UUID e e-mail/posse com o seed sintético, a rotina reconhece a legitimidade e executa a atualização idempotente sem criar duplicatas.

---

### 2. LIMPEZA SEGURA E RETORNO AO BASELINE (TEARDOWN)

A rotina de limpeza `cleanupHomologationData` foi auditada para garantir isolamento estrito e integridade relacional absoluta:

1. **Expurgo Exclusivo de Dados Sintéticos:** Todas as cláusulas `DELETE` utilizam filtros explícitos vinculados aos UUIDs sintéticos (`syntheticPerfis = [Alice, Bruno, Carlos]`) ou e-mails sintéticos (`syntheticEmails`).
2. **Preservação de Registros Externos:** Comprovado em teste que perfis, ciclos e cards de desenvolvedores ou terceiros (ex: `dev@medicina2029.test`) permanecem 100% intocados durante a provisão e a limpeza.
3. **Preservação da Allowlist Inicial:** Os e-mails originais do baseline (`estudante@medicina2029.com.br` e `responsavel@medicina2029.com.br`) são estritamente preservados; apenas os 3 e-mails `.staging` são expurgados.
4. **Preservação das Migrações:** A tabela canônica `public._medicina_staging_migrations` não sofre mutações durante o cleanup, garantindo que o histórico das 9 migrações permaneça íntegro.
5. **Ordem Reversa de FKs (35 Tabelas):** A deleção segue estritamente a ordem inversa das chaves estrangeiras:
   * `curadoria_fila` -> `acervo_jobs` -> `acervo_figuras` -> `acervo_chunks` -> `acervo_paginas` -> `acervo_arquivos` -> `operacoes_idempotentes` -> `erros` -> `tentativas` -> `sessoes` -> `card_revisoes` -> `cards` -> `materiais` -> `repertorios` -> `livros` -> `redacoes` -> `simulado_questoes` -> `simulado_areas` -> `simulado_analise` -> `simulados` -> `ciclo_estado` -> `ciclo_blocos` -> `ciclos` -> `revisoes_trimestrais` -> `checkins` -> `responsavel_estudante` -> `perfis` -> `allowlist`.

---

### 3. GOVERNANÇA DE STORAGE E AUDITORIA DA SERVICE ROLE KEY

#### 3.1 Desacoplamento Transacional de Blobs
* As chamadas à API REST do Supabase Storage não participam da transação PostgreSQL (`BEGIN / COMMIT / ROLLBACK`).
* Para garantir atomicidade de 100%, a constante `STORAGE_OPERATIONS_ENABLED = false` foi estabelecida como padrão.
* **Na primeira homologação, nem o provisionamento faz upload físico de blobs, nem a limpeza executa remoção física de arquivos via REST.** Apenas metadados em `public.acervo_arquivos` são manipulados na transação.
* Isso elimina o risco de transações divididas e orfandade de arquivos sem compensação automática.

#### 3.2 Auditoria da `SUPABASE_SERVICE_ROLE_KEY`
* **Uso Exclusivo no Servidor:** A chave mestra `SUPABASE_SERVICE_ROLE_KEY` é referenciada unicamente em rotas de backend e módulos de infraestrutura (`src/lib/supabaseStorage.ts`, `src/lib/env.ts`).
* **Bloqueio Ativo de Exposição Client-Side:** O validador central `src/lib/env.ts` (linhas 88–89) rejeita sumariamente qualquer tentativa de configuração com o prefixo `NEXT_PUBLIC_` (`INSECURE_CONFIGURATION`), impedindo que a chave seja injetada em bundles compilados de navegadores.
* **Isolamento de Acesso ao Staging:** O script lançador conecta-se diretamente ao pooler PostgreSQL com a credencial de conexão TLS administrativa (`postgres.ynfocaorhadizlvbnzrt`), sem trafegar a chave service_role pela rede desnecessariamente.

---

### 4. MATRIZ DE TESTES AUTOMATIZADOS (107/107 APROVADOS)

Bateria completa de validação executada em ambiente descartável com motor PostgreSQL real (PGlite + extensão pgvector):

| ID | Cenário de Teste | Arquivo de Teste | Status | Tempo |
| :---: | :--- | :--- | :---: | :---: |
| **01** | Pré-Voo de Leitura (Baseline, 9 migrações, allowlist, roles RLS) | `h2_04_r2_collision_gate.test.ts` | **APROVADO** | 6ms |
| **02** | Bloqueio de Colisão por UUID de Alice (Fail-Closed defensivo) | `h2_04_r2_collision_gate.test.ts` | **APROVADO** | 174ms |
| **03** | Bloqueio de Colisão por E-mail de Alice (Fail-Closed defensivo) | `h2_04_r2_collision_gate.test.ts` | **APROVADO** | 168ms |
| **04** | Preservação de Dados Externos Preexistentes (Perfil/Ciclo Dev) | `h2_04_r2_collision_gate.test.ts` | **APROVADO** | 191ms |
| **05** | Reexecução Legítima e Idempotência (Zero duplicações) | `h2_04_r2_collision_gate.test.ts` | **APROVADO** | 180ms |
| **06** | Falha Parcial e Rollback Transacional (Zero órfãos) | `h2_04_r2_collision_gate.test.ts` | **APROVADO** | 1ms |
| **07** | Bloqueio de Operações Físicas no Supabase Storage | `h2_04_r2_collision_gate.test.ts` | **APROVADO** | 8ms |
| **08** | Limpeza Segura e Retorno Estrito ao Baseline Inicial | `h2_04_r2_collision_gate.test.ts` | **APROVADO** | 2ms |
| **09** | Simulação de Pré-Voo Completo com 6 cenários da H2.04-R | `h2_04_r_preflight_simulation.test.ts` | **APROVADO** | 1228ms |
| **10** | Plano de Homologação Funcional e Inventário de Actions (18 testes) | `h2_04_functional_homologation_plan.test.ts` | **APROVADO** | 2627ms |
| **11** | Diagnóstico de Funções do Supabase (5 testes) | `h2_03_r2d_functions_diagnosis.test.ts` | **APROVADO** | 815ms |
| **12** | Auditoria e Validação de Restauração de Baseline (11 testes) | `h2_03_r2c_restore_audit_fix.test.ts` | **APROVADO** | 5241ms |
| **13** | Transmissão de Chaves e Criptografia AEAD M29G (14 testes) | `h2_03_r2b_key_transmission_fix.test.ts` | **APROVADO** | 832ms |
| **14** | Restauração Isolada do Backup Baseline de Staging (20 testes) | `h2_03_r2_isolated_restore_preparation.test.ts` | **APROVADO** | 115ms |
| **15** | Recuperação de Baseline e DDL Canônico (13 testes) | `h2_03_r_baseline_recovery_validation.test.ts` | **APROVADO** | 1614ms |
| **16** | Backup Baseline e Cifragem Envelope (12 testes) | `h2_03_staging_baseline_backup.test.ts` | **APROVADO** | 1384ms |

**Resultado Global da Suíte:** **9 arquivos de teste, 107 testes executados, 107 testes aprovados (100% de sucesso em 17.93s).**

---

### 5. COMANDOS OPERACIONAIS HOMOLOGADOS

#### 5.1 Pré-Voo e Auditoria de Leitura (Sem Modificação de Dados)
Este comando conecta-se com TLS estrito, audita o projeto, confirma as 9 migrações, a integridade da allowlist baseline e a ausência de colisões:
```bash
node scripts/db/prepare-staging-homologation.mjs --preflight-audit --ca=scripts/db/prod-ca-2021.crt
```
*Não requer token de escrita pois opera exclusivamente com instruções `SELECT`.*

#### 5.2 Provisionamento Controlado (Primeiro Seed Remoto)
Quando autorizado pelo operador humano, este comando executa a provisão atômica com validação prévia de colisões:
```bash
node scripts/db/prepare-staging-homologation.mjs --provision --ca=scripts/db/prod-ca-2021.crt
```
*Exige digitação do token compulsório:* `CONFIRMAR HOMOLOGACAO STAGING`.

#### 5.3 Validação Pós-Seed por UUIDs e Escopos de Posse
Após o seed, este comando executa as verificações determinísticas de todos os UUIDs criados:
```bash
node scripts/db/prepare-staging-homologation.mjs --validate-seed --ca=scripts/db/prod-ca-2021.crt
```

#### 5.4 Limpeza Completa e Retorno ao Baseline (Cleanup)
Para expurgar 100% dos dados sintéticos e retornar o banco exatamente ao baseline:
```bash
node scripts/db/prepare-staging-homologation.mjs --cleanup --ca=scripts/db/prod-ca-2021.crt
```
*Exige digitação do token compulsório:* `CONFIRMAR LIMPEZA HOMOLOGACAO STAGING`.

---

### 6. CONSULTAS SQL DE AUDITORIA MANUAL PÓS-SEED

As consultas abaixo podem ser executadas no **SQL Editor** do Supabase Dashboard ou via `psql` para auditar a integridade estrutural pós-seed:

```sql
-- 1. Auditoria dos 3 perfis e papéis (Alice, Bruno, Carlos)
SELECT id, email, nome, papel, auth_user_id, criado_em
FROM public.perfis
WHERE id IN (
  '10000000-0000-4000-8000-000000000001'::uuid,
  '20000000-0000-4000-8000-000000000001'::uuid,
  '30000000-0000-4000-8000-000000000001'::uuid
)
ORDER BY papel DESC, nome ASC;
-- Esperado: 3 linhas (Alice: estudante, Bruno: responsavel, Carlos: estudante)

-- 2. Auditoria da allowlist (baseline + sintéticos)
SELECT email, criado_em
FROM public.allowlist
ORDER BY email ASC;
-- Esperado: 5 linhas (2 do baseline: estudante@ e responsavel@medicina2029.com.br + 3 sintéticos)

-- 3. Auditoria do vínculo exclusivo de tutoria (Bruno -> Alice)
SELECT vinculo_id, responsavel_perfil_id, estudante_perfil_id, criado_em
FROM public.responsavel_estudante
WHERE vinculo_id = 1;
-- Esperado: 1 linha (responsavel='2000...0001', estudante='1000...0001')

-- 4. Auditoria dos ciclos de estudo e blocos
SELECT c.id, c.nome, c.estudante_perfil_id, count(b.id) AS total_blocos
FROM public.ciclos c
LEFT JOIN public.ciclo_blocos b ON b.ciclo_id = c.id
WHERE c.id IN (
  '40000000-0000-4000-8000-000000000001'::uuid,
  '40000000-0000-4000-8000-000000000003'::uuid
)
GROUP BY c.id, c.nome, c.estudante_perfil_id;
-- Esperado: 2 linhas, cada uma com exatamente 28 blocos vinculados

-- 5. Auditoria de flashcards FSRS independentes
SELECT perfil_id, count(*) AS total_cards, array_agg(state) AS estados
FROM public.cards
WHERE perfil_id IN (
  '10000000-0000-4000-8000-000000000001'::uuid,
  '30000000-0000-4000-8000-000000000001'::uuid
)
GROUP BY perfil_id;
-- Esperado: 2 linhas (Alice: 3 cards; Carlos: 2 cards)

-- 6. Auditoria de integridade do acervo didático sintético
SELECT a.id, a.titulo, a.enviado_por, a.status_processamento,
       count(DISTINCT p.id) AS total_paginas,
       count(DISTINCT ch.id) AS total_chunks,
       count(DISTINCT j.id) AS total_jobs
FROM public.acervo_arquivos a
LEFT JOIN public.acervo_paginas p ON p.arquivo_id = a.id
LEFT JOIN public.acervo_chunks ch ON ch.arquivo_id = a.id
LEFT JOIN public.acervo_jobs j ON j.arquivo_id = a.id
WHERE a.id = 'f0000000-0000-4000-8000-000000000001'::uuid
GROUP BY a.id, a.titulo, a.enviado_por, a.status_processamento;
-- Esperado: 1 linha (autor: Bruno, status: 'concluido', 1 pagina, 1 chunk, 1 job)

-- 7. Confirmação de integridade do catálogo canônico das 9 migrações
SELECT count(*) AS total_migracoes
FROM public._medicina_staging_migrations;
-- Esperado: exatamente 9 migrações
```

---

### 7. PROCEDIMENTO DE ROLLBACK E CONTINGÊNCIA

Caso ocorra qualquer comportamento inesperado durante a homologação funcional, o operador dispõe de dois níveis de recuperação:

1. **Nível 1 — Teardown Transacional Imediato:**
   * Executar: `node scripts/db/prepare-staging-homologation.mjs --cleanup --ca=scripts/db/prod-ca-2021.crt`
   * Digitar o token: `CONFIRMAR LIMPEZA HOMOLOGACAO STAGING`
   * Tempo estimado: < 1 segundo.
   * Resultado: 100% dos dados sintéticos são expurgados via transação reversa, preservando a allowlist original e as 9 migrações.
2. **Nível 2 — Restauração Física Completa do Backup Baseline:**
   * Caso haja corrupção acidental do schema, utilizar o dump canônico de 27/10/2026 decifrado com o script `decrypt_backup.sh` e restaurado via `pg_restore` (procedimento 100% testado e aprovado na etapa H2.03-R2C).

---

### 8. DECLARAÇÃO DE GOVERNANÇA E RESTRIÇÕES CUMPRIDAS

* [x] **Zero Seed Remoto:** Nenhum registro foi inserido no Supabase Staging remoto nesta etapa.
* [x] **Zero Cleanup Remoto:** Nenhuma instrução de expurgo foi executada no banco remoto.
* [x] **Zero Impacto em Produção:** O banco de dados produtivo não foi acessado.
* [x] **Zero Ativação de Serviços Pagos:** APIs do Gemini, OCR externo e workers de background permaneceram desativados.
* [x] **Zero Modificações em Migrações:** As 9 migrações canônicas de staging não sofreram nenhuma alteração.
* [x] **Zero Commits / Pushes / Deploys:** O controle de versão permanece com a árvore de trabalho limpa para inspeção do usuário.

---

**PARECER FINAL: APTO PARA O PRIMEIRO SEED REMOTO NO SUPABASE STAGING.**  
*O portão de segurança H2.04-R2 está concluído e validado. Aguardando comando humano explícito para execução.*
