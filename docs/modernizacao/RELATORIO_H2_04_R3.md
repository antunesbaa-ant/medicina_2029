# MEDICINA 2029 — RELATÓRIO TÉCNICO H2.04-R3
## CORREÇÃO DO PORTÃO DE IDENTIDADE DO STAGING (SESSION POOLER)

---

### SUMÁRIO EXECUTIVO
* **Identificador da Tarefa:** MEDICINA 2029 — H2.04-R3
* **Fase:** Correção Arquitetural do Portão de Identidade do Supabase Session Pooler
* **Data de Emissão:** 31 de Outubro de 2026
* **Ambiente Alvo:** Supabase Staging (`ynfocaorhadizlvbnzrt`)
* **Endpoint Canônico:** `aws-0-us-east-1.pooler.supabase.com:5432` (Session Pooler)
* **Certificado CA:** `prod-ca-2021.crt` (SHA-256: `955d5402a50a006ecc0e2ce1c9e429e289bf6b3bfdf5ec9535eef22f2efd1ae7`)
* **Parecer Técnico Conclusivo:** **APTO — PORTÃO DE IDENTIDADE RECALIBRADO COM SUCESSO (GREEN GATE)**
* **Estado Operacional:** **NENHUMA ESCRITA FOI EXECUTADA NO STAGING REMOTO**. O banco permanece 100% no estado baseline limpo.

---

### 1. DIAGNÓSTICO E CAUSA RAIZ DO ABORTO NO PREFLIGHT REMOTO

#### 1.1 O Incidente Observado
Na execução remota de pré-voo com o script `prepare-staging-homologation.mjs` da etapa H2.04-R2:
* A conexão TLS estrita foi estabelecida com sucesso com o Session Pooler;
* A autenticação de rede foi bem-sucedida;
* O processo abortou com a mensagem:
  ```text
  DB="postgres" | ROLE="postgres"
  VIOLAÇÃO DE AMBIENTE: Conexão efetuada com usuário inesperado (postgres). Esperado projeto "ynfocaorhadizlvbnzrt".
  ```

#### 1.2 Mecânica Interna do Supabase Shared Session Pooler (PgBouncer)
1. **Usuário de Conexão na Borda (PgBouncer):** `postgres.ynfocaorhadizlvbnzrt`. O sufixo `.ynfocaorhadizlvbnzrt` é exigido pelo pooler compartilhado do Supabase exclusivamente para rotear a conexão TCP/TLS para a instância isolada do tenant correto.
2. **Papel Efetivo no PostgreSQL Interno:** Uma vez roteada e autenticada a conexão dentro da máquina virtual do banco, o papel ativo do PostgreSQL retornado por `current_user` e `session_user` é simplesmente `postgres`.
3. **Causa Raiz do Falso Bloqueio:** O código anterior realizava uma asserção ingênua exigindo que a string retornada por `current_user` contivesse o identificador do projeto (`!diag.user_name.includes(TARGET_PROJECT_REF)`). Como `current_user` retorna `postgres`, a verificação causava um **falso bloqueio sistemático** no ambiente real do Supabase Staging, apesar da conexão estar perfeitamente roteada e autenticada no tenant correto.

---

### 2. ARQUITETURA DA SOLUÇÃO: SEPARAÇÃO CONCEITUAL E VALIDAÇÃO MULTICAMADAS

Para eliminar o falso positivo sem reduzir os rigorosos guardrails contra conexão ao projeto errado, a validação de ambiente foi dividida em quatro camadas interdependentes:

```
[1. Pré-Conexão: Parâmetros e URL]
  ├── Host: aws-0-us-east-1.pooler.supabase.com (EXATO)
  ├── Porta: 5432 (Session Pooler EXATO; porta 6543 rejeitada)
  ├── Banco: postgres (EXATO)
  ├── Usuário: postgres.ynfocaorhadizlvbnzrt (EXATO)
  └── TLS: rejectUnauthorized=true + prod-ca-2021.crt
           │
           ▼
[2. Pós-Conexão: Sessão Ativa do PostgreSQL]
  ├── current_database(): 'postgres'
  └── current_user / session_user: 'postgres' ou 'postgres.ynfocaorhadizlvbnzrt'
           │
           ▼
[3. Inspeção Remota Passiva: Impressão Digital do Banco]
  ├── Nove Migrações Canônicas: count = 9 em public._medicina_staging_migrations
  ├── Paridade Criptográfica: SHA-256 das 9 migrações idênticos aos arquivos locais
  ├── Allowlist Baseline: presença de estudante@ e responsavel@medicina2029.com.br
  ├── Estrutura Canônica: 18 tabelas essenciais confirmadas via to_regclass
  ├── Portão Anti-Colisão: 0 colisões com personas sintéticas (Alice, Bruno, Carlos)
  ├── Roles RLS: anon e authenticated sem BYPASSRLS
  └── Storage Decoupling: STORAGE_OPERATIONS_ENABLED = false
           │
           ▼
[4. Transação de Provisionamento: Portão Idêntico Pré-DML]
  └── Passo [0/8]: Revalidação da sessão + verifySeedIdentityAndCollisions antes de qualquer INSERT
```

#### 2.1 Validador de Configuração Pré-Conexão
Implementada a função exportada `validateStagingConnectionConfig(configOrUrl)` no arquivo `scripts/db/prepare-staging-homologation.mjs`:
* Rejeita hosts que não sejam `aws-0-us-east-1.pooler.supabase.com`;
* Rejeita portas diferentes de `5432` (ex.: porta 6543 do transaction pooler é rejeitada fail-closed);
* Rejeita banco diferente de `postgres`;
* Rejeita usuário que não seja estritamente `postgres.ynfocaorhadizlvbnzrt`;
* Rejeita ausência do sufixo `.ynfocaorhadizlvbnzrt`.

#### 2.2 Validação da Sessão Ativa
No handshake pós-conexão:
* `allowedRoles = ['postgres', 'postgres.ynfocaorhadizlvbnzrt']`;
* Rejeita papéis desconhecidos ou não administrativos;
* Valida `db_name === 'postgres'`.

#### 2.3 Impressão Digital Canônica do Staging (Somente-Leitura)
A comprovação de que o banco conectado é o staging do projeto `ynfocaorhadizlvbnzrt` não depende mais do nome da role interna, mas da validação determinística de seus artefatos:
1. **Nove Migrações Canônicas Registradas:** A tabela `public._medicina_staging_migrations` deve conter exatamente 9 registros.
2. **Conferência dos Hashes SHA-256 Canônicos:**
   * Ordem 1: `drizzle/0000_greedy_loki.sql` (`b1cf8d6741894a52543ca0edf7212dee9ee8945051cd01148ea60a3cbaf4b4c6`)
   * Ordem 2: `drizzle/0001_dry_talos.sql` (`8e82452e0071ee1ce5a1e38569ef8f69a0851ae3d8e229ebfd1b4969e3db9180`)
   * Ordem 3: `drizzle/0002_little_swarm.sql` (`c3ce3d3b1335bedb2deb46e2c14c018fe15370b60e7fdc415def17cb9de0343b`)
   * Ordem 4: `drizzle/0003_f1_03_r_expansao.sql` (`32be49be0da8ed6c675657ef0ecf14f54951491df0176cb66f1a450b8bab4e3f`)
   * Ordem 5: `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql` (`8aff8ea87bf6149a5ab003e74bb1cdcf5ad0611c853a25d098ad6c783907200f`)
   * Ordem 6: `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` (`96187040783e236b64bb70c15b9bf57c7ad39feb3d100a571bfa0e01eb5b55d1`)
   * Ordem 7: `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql` (`41dde50128b89ce9407dd03c97f53540451c5d6ae27d19edd3a5f789240d5fc0`)
   * Ordem 8: `docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql` (`e5a9ceea9daca82347c4af623bfb36156334fb4ae7525334e1f58626b41b8298`)
   * Ordem 9: `docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` (`b9474fa616038325f4677176d1cfc9e3ae29ab19e32545931acae7123c0aec1d`)
3. **Integridade da Allowlist Baseline:** Presença compulsória dos e-mails `estudante@medicina2029.com.br` e `responsavel@medicina2029.com.br`.
4. **Catálogo de 18 Tabelas Canônicas Obrigatórias:** Verificação passiva via `to_regclass` das tabelas `perfis`, `allowlist`, `ciclos`, `ciclo_blocos`, `ciclo_estado`, `cards`, `card_revisoes`, `acervo_arquivos`, `acervo_paginas`, `acervo_chunks`, `acervo_jobs`, `responsavel_estudante`, `disciplinas`, `topicos`, `sessoes`, `tentativas`, `erros`, `operacoes_idempotentes`.
5. **Portão Anti-Colisão:** Execução de `verifySeedIdentityAndCollisions(sql)` assegurando 0 colisões.

---

### 3. RESULTADOS DOS TESTES AUTOMATIZADOS (114/114 APROVADOS)

Criada a suíte dedicada [`src/app/actions/h2_04_r3_staging_identity_gate.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h2_04_r3_staging_identity_gate.test.ts) cobrindo todos os cenários exigidos:

| ID | Cenário de Teste H2.04-R3 | Resultado | Evidência Técnica |
| :---: | :--- | :---: | :--- |
| **01** | **Session Pooler Legítimo (`current_user='postgres'`)** | **APROVADO** | Aceita conexão com `db='postgres'` e `user='postgres'` sem falso positivo. |
| **02** | **Usuário com Project Ref Incorreto ou Ausente** | **APROVADO** | Rejeita `postgres.outrotenant`, `postgres` puro e `medicina_app` com erro `VIOLAÇÃO DE USUÁRIO`. |
| **03** | **Host ou Porta Incorretos** | **APROVADO** | Rejeita host de produção, `127.0.0.1`, porta `6543` (transaction pooler) e banco divergente. |
| **04** | **Histórico de Migrações Divergente** | **APROVADO** | Rejeita contagem < 9 (`HISTORICO_MIGRACOES_INCOMPLETO`) e hash adulterado (`MIGRACAO_HASH_DIVERGENTE`). |
| **05** | **Validação de Certificado TLS** | **APROVADO** | Rejeita caminho inválido ou certificado corrompido (`fail-closed`). |
| **06** | **Estrutura Canônica (18 Tabelas)** | **APROVADO** | Detecta ausência de tabela via `to_regclass` passivo (`ESTRUTURA_CANONICA_INCOMPLETA`). |
| **07** | **Portão Fail-Closed Antes de Qualquer INSERT** | **APROVADO** | Aborta transação no passo [0/8] antes de qualquer DML caso a sessão seja adulterada. |

#### Resumo da Bateria Completa de Testes
* `h2_04_r3_staging_identity_gate.test.ts`: **7/7 aprovados** (1071ms)
* `h2_04_r2_collision_gate.test.ts`: **8/8 aprovados** (1607ms)
* `h2_04_r_preflight_simulation.test.ts`: **6/6 aprovados** (1320ms)
* `h2_04_functional_homologation_plan.test.ts`: **18/18 aprovados** (2697ms)
* Demais 6 suítes da etapa H2.03: **75/75 aprovados**
* **Total Global:** **10 arquivos de teste, 114 testes executados, 114 testes aprovados (100% de sucesso em 19.49s).**

---

### 4. PROCEDIMENTO OPERACIONAL PARA NOVA TENTATIVA REMOTA

#### 4.1 Comando de Pré-Voo Somente-Leitura (100% Seguro)
Para realizar a nova verificação de pré-voo no Staging com o portão corrigido, execute no terminal:
```bash
node scripts/db/prepare-staging-homologation.mjs --preflight-audit --ca=scripts/db/prod-ca-2021.crt
```

#### 4.2 Fluxo de Execução Passiva Esperado
1. O lançador valida localmente os parâmetros da URL (`aws-0-us-east-1.pooler.supabase.com:5432/postgres` com usuário `postgres.ynfocaorhadizlvbnzrt`);
2. Solicita a senha da role `postgres` de forma oculta no terminal;
3. Estabelece a conexão TLS estrita utilizando `prod-ca-2021.crt` e `rejectUnauthorized: true`;
4. Exibe:
   ```text
   🔒 Conexão TLS estabelecida: DB="postgres" | ROLE="postgres" | SESSION_USER="postgres"
   🔍 Executando Pré-Voo e Auditoria de Leitura no Banco de Staging...
      • Sessão ativa: DB="postgres" | ROLE="postgres" | SESSION_USER="postgres" (Autenticado via postgres.ynfocaorhadizlvbnzrt)
      • Migrações canônicas aplicadas: 9/9 registradas em _medicina_staging_migrations.
      • Hashes SHA-256 das 9 migrações canônicas 100% verificados e validados.
      • Allowlist baseline íntegra: 2 e-mail(s) cadastrado(s) (baseline preservado).
      • Verificando presença da estrutura canônica de tabelas...
      • 18 tabelas canônicas verificadas e confirmadas no catálogo.
      • Verificando integridade e colisões com identidades sintéticas...
      • Zero colisões detectadas (0 perfis sintéticos verificados).
      • Roles de aplicação auditadas (anon, authenticated): BYPASSRLS=false rigorosamente garantido.
      • Supabase Storage: Operações físicas em blobs estão DESABILITADAS (garantia de atomicidade no PostgreSQL).
   ✅ PRÉ-VOO APROVADO: Conexão estrita ao Session Pooler, 9 migrações canônicas válidas, estrutura completa e zero colisões.
   ```
5. Encerra com código `0`, sem ter realizado nenhuma modificação de dados no Staging.

---

### 5. DECLARAÇÃO DE GOVERNANÇA E RESTRIÇÕES CUMPRIDAS

* [x] **Zero Seed Remoto:** Nenhum registro foi inserido no Supabase Staging remoto nesta etapa.
* [x] **Zero Cleanup Remoto:** Nenhuma exclusão foi executada no banco remoto.
* [x] **Zero Impacto em Produção:** O banco produtivo permaneceu completamente inacessado.
* [x] **Zero Ativação de APIs Pagas:** Gemini, OCR e background workers mantidos desativados.
* [x] **Zero Modificações em Migrações:** As 9 migrações canônicas de staging não sofreram nenhuma alteração.
* [x] **Zero Commits / Pushes / Deploys:** O controle de versão permanece com a árvore de trabalho limpa para inspeção do usuário.

---

**PARECER FINAL: APTO COM PORTÃO DE IDENTIDADE RECALIBRADO.**  
*O falso bloqueio do Session Pooler foi eliminado sem redução de segurança. O comando de pré-voo somente-leitura está pronto para nova execução.*
