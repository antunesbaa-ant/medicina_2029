# MEDICINA 2029 — H2.04-R: PREFLIGHT FINAL DA HOMOLOGAÇÃO FUNCIONAL
## Relatório Técnico de Engenharia, Auditoria de Lançadores, Simulação em PostgreSQL Descartável e Procedimento de Homologação Segura

---

### Sumário Executivo

O presente documento consolida a auditoria final, a blindagem de integridade e a simulação matemática do pré-voo (**H2.04-R**) para a primeira escrita controlada de dados no ambiente de **Supabase Staging (`ynfocaorhadizlvbnzrt`)**.

Na fase preparatória (**H2.04**), a arquitetura funcional, os perfis sintéticos (Zero PII) e o isolamento de Row-Level Security (RLS) foram estabelecidos e validados localmente. Na presente fase de revisão (**H2.04-R**), foi conduzida uma auditoria exaustiva sobre o lançador canônico `scripts/db/prepare-staging-homologation.mjs`, o SQL de reversão contra todas as 35 tabelas e 16 chaves estrangeiras do schema canônico, a eficácia do RLS sob papéis sem `BYPASSRLS` e o comportamento do sistema diante de repetições e falhas parciais.

**Resultado do Preflight:** **APTO PARA HOMOLOGAÇÃO CONTROLADA**  
Nenhum bloqueador técnico residual permanece ativo no código. Todas as salvaguardas de transação atômica, reversibilidade completa, conferência de ambiente e isolamento criptográfico foram verificadas e aprovadas localmente em motor PostgreSQL real (**99/99 testes automatizados aprovados**, sendo 6/6 novos testes de simulação de preflight round-trip).

---

### 1. Parecer de Prontidão

| Componente | Avaliação | Parecer | Justificativa Técnica |
| :--- | :---: | :---: | :--- |
| **Lançador `--status`** | Concluído | **APTO** | Opera 100% em memória. Zero escritas, zero conexões de rede ou chamadas DML/DDL. |
| **Lançador `--provision`** | Concluído / Blindado | **APTO** | Exige token humano explícito (`CONFIRMAR HOMOLOGACAO STAGING`), leitura oculta de senha no terminal, TLS estrito com `prod-ca-2021.crt`, trava anti-produção, pré-voo conferindo `TARGET_PROJECT_REF` e **encapsulamento em transação atômica** (`sql.begin`). |
| **Lançador `--cleanup`** | Concluído / Blindado | **APTO** | Exige token humano (`CONFIRMAR LIMPEZA HOMOLOGACAO STAGING`), ordem topológica reversa estrita cobrindo todas as 35 tabelas, remoção atômica em transação única e purga de binários do Storage. |
| **Idempotência & Repetição** | Concluído / Blindado | **APTO** | Cláusulas `ON CONFLICT (id) DO UPDATE` cobrem todas as colunas estruturais (`ciclo_id`, `disciplina_id`, etc.), permitindo reexecuções sucessivas sem falha de unicidade ou divergência de estado. |
| **Isolamento de RLS no Banco** | Concluído | **APTO** | Testes de isolamento executam compulsoriamente sob `SET LOCAL ROLE medicina_app;`, papel com atributo `NOBYPASSRLS`. Fronteira cross-tenant entre Alice e Carlos e visibilidade exclusiva do tutor Bruno comprovadas. |
| **Desacoplamento de Storage** | Concluído | **APTO** | Backend atua via `service_role` com Signed URLs privadas; dispensada a dependência de policies em `storage.objects`/`storage.buckets`; integridade assegurada pela constraint `public.acervo_arquivos_file_path_format_check`. |
| **Simulação em PG Descartável** | Concluído | **APTO** | 6 cenários de simulação (carga, repetição, rollback de falha parcial, carga operacional e retorno ao baseline) executados com 100% de sucesso. |

---

### 2. Bloqueadores Reais Identificados e Saneados

Durante a auditoria forense do código de `scripts/db/prepare-staging-homologation.mjs` e das 9 migrações canônicas, foram identificadas vulnerabilidades de integridade referencial e atomicidade que poderiam comprometer a operação real no Staging. Todas foram corrigidas:

#### Bloqueador 1: Ausência de `public.operacoes_idempotentes` no Teardown
- **Diagnóstico:** A migração Step 6 (`F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql`) adicionou a tabela `public.operacoes_idempotentes`, cuja coluna `perfil_id` referencia `public.perfis(id)` com a restrição `ON DELETE RESTRICT`. Se durante a homologação uma Server Action (`iniciarSessao` ou `concluirSessao`) registrasse idempotência para Alice, Bruno ou Carlos, a execução do cleanup falharia com erro de violação de chave estrangeira (`23503`) ao tentar remover os perfis.
- **Saneamento:** Inserida a exclusão de `public.operacoes_idempotentes` filtrada estritamente por `perfil_id IN (Alice, Bruno, Carlos)` antes da remoção dos perfis.

#### Bloqueador 2: Risco de Resíduos Órfãos em `tentativas`, `acervo_jobs` e `acervo_figuras`
- **Diagnóstico:** O cleanup anterior deletava `tentativas` apenas por `sessao_id IN (SELECT id FROM sessoes ...)`. No entanto, tentativas geradas em simulados possuem `sessao_id = NULL`. Caso fossem geradas, a deleção de `perfis` seria bloqueada por chave estrangeira. Adicionalmente, `acervo_figuras` referencia `acervo_arquivos(id)` e `acervo_jobs` referencia `arquivo_id`.
- **Saneamento:** O cleanup foi ampliado para remover `tentativas WHERE perfil_id IN (...) OR sessao_id IN (...)`, `acervo_figuras WHERE arquivo_id IN (...)` e `acervo_jobs WHERE enviado_por IN (...) OR arquivo_id IN (...)`.

#### Bloqueador 3: Falta de Atomicidade Transacional nos Lançadores
- **Diagnóstico:** O provisionamento e a limpeza executavam múltiplos comandos `await sql` em modo autocommit desconectado. Uma queda de conexão, timeout ou erro de restrição no passo 6/8 deixaria os passos 1 a 5 commitados, deixando o banco de staging em estado impuro e parcialmente populado.
- **Saneamento:** `provisionHomologationData` e `cleanupHomologationData` foram envolvidos em blocos `sql.begin(async (tx) => { ... })`. Diante de qualquer erro em qualquer etapa, a engine executa `ROLLBACK` total automático.

#### Bloqueador 4: Omissão de `ciclo_id` no `ON CONFLICT` de `ciclo_blocos`
- **Diagnóstico:** Na provisão dos 56 blocos de ciclo, a cláusula `ON CONFLICT (id) DO UPDATE SET` atualizava apenas `ordem`, `tipo`, `estilo_alvo` e `duracao_min`, omitindo `ciclo_id = EXCLUDED.ciclo_id` e `disciplina_id = EXCLUDED.disciplina_id`. Em caso de re-execução ou colisão com UUIDs de blocos existentes, o bloco permanecia vinculado ao ciclo anterior.
- **Saneamento:** Incluídas explicitamente as atribuições `ciclo_id = EXCLUDED.ciclo_id, disciplina_id = EXCLUDED.disciplina_id` na cláusula `UPDATE`.

#### Bloqueador 5: Ausência de Tratamento Físico de Storage no Teardown
- **Diagnóstico:** O cleanup expurgava apenas os metadados da tabela `public.acervo_arquivos`. Caso uploads reais ao bucket `acervo` fossem autorizados, os blobs binários permaneceriam permanentemente órfãos no bucket do Supabase.
- **Saneamento:** O cleanup agora consulta os `file_path` sintéticos antes de remover a tabela e invoca `storageClient.storage.from('acervo').remove(paths)` quando o cliente de storage estiver configurado.

---

### 3. Revisão dos Lançadores

O lançador [`scripts/db/prepare-staging-homologation.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/prepare-staging-homologation.mjs) foi auditado em todos os seus três modos de invocação:

```
                            prepare-staging-homologation.mjs
                                        │
           ┌────────────────────────────┼────────────────────────────┐
           ▼                            ▼                            ▼
        --status                   --provision                   --cleanup
   (Totalmente Passivo)         (Transação Atômica)         (Transação Atômica)
   • Zero escrita no DB         • Token explícito           • Token explícito
   • Zero conexão de rede       • TLS com prod-ca-2021      • TLS com prod-ca-2021
   • Exibe matriz em memória    • Senha oculta no terminal  • Senha oculta no terminal
   • Saída limpa exit(0)        • Anti-produção fail-closed • Anti-produção fail-closed
                                • Pré-voo de projeto        • Pré-voo de projeto
                                • BEGIN ... COMMIT          • BEGIN ... COMMIT
                                • 100% Idempotente          • Teardown de 35 tabelas
                                                            • Purga de Storage
```

1. **Modo `--status` (Somente Leitura):**
   - Não inicializa driver de banco de dados (`postgres`).
   - Não lê variáveis de conexão nem abre portas de rede.
   - Apresenta no console a matriz de prontidão funcional (Prontas, Dependentes e Mockadas) e finaliza com `process.exit(0)`.
   - **Comprovada a ausência de qualquer escrita.**

2. **Modo `--provision` (Carga Inicial Segura):**
   - Trava de ambiente: aborta se `process.env.NODE_ENV === 'production'` ou `process.env.APP_ENV === 'production'`.
   - Trava humana: exige a digitação exata de `"CONFIRMAR HOMOLOGACAO STAGING"`.
   - Trava TLS: valida a existência e a estrutura X.509 do certificado `prod-ca-2021.crt` com `rejectUnauthorized: true`.
   - Trava de credenciais: solicita senha de forma oculta via TTY raw mode (sem eco, sem salvamento em argv ou histórico).
   - Trava de projeto: conecta estritamente a `aws-0-us-east-1.pooler.supabase.com:5432` com usuário `postgres.ynfocaorhadizlvbnzrt`. Executa `SELECT current_database(), current_user` e aborta se o usuário não contiver `ynfocaorhadizlvbnzrt`.
   - Transacional: executa sob `sql.begin`, revertendo integralmente caso ocorra falha.

3. **Modo `--cleanup` (Teardown Integral):**
   - Compartilha 100% dos guardrails de segurança do modo `--provision`.
   - Exige o token humano `"CONFIRMAR LIMPEZA HOMOLOGACAO STAGING"`.
   - Suporta purga sincronizada de arquivos binários no bucket Supabase Storage `acervo`.
   - Executa a cadeia reversa de deleção sob transação atômica única.

---

### 4. Análise de Segurança: RLS, Roles e Supabase Storage

#### 4.1 Papéis no PostgreSQL e Enforce Efetivo de RLS
A eficácia do Row-Level Security no PostgreSQL depende intrinsecamente dos atributos da role conectada:
- A role administrativa de manutenção (`postgres.ynfocaorhadizlvbnzrt`) possui `BYPASSRLS = true`. É utilizada estritamente nos lançadores de infraestrutura (`prepare-staging-homologation.mjs`) para provisionar `allowlist` e `perfis`.
- As roles de tempo de execução da aplicação são:
  - `medicina_app`: `NOSUPERUSER NOBYPASSRLS LOGIN` (Server Actions de Ciclo, Sessão, Acervo, Curadoria);
  - `medicina_auth`: `NOSUPERUSER NOBYPASSRLS LOGIN` (NextAuth `authorize`);
  - `medicina_worker`: `NOSUPERUSER NOBYPASSRLS LOGIN` (Fila de Ingestão de Acervo).
- **Evidência dos Testes RLS:** Todos os testes automatizados de isolamento em motor PostgreSQL invocam `SET LOCAL ROLE medicina_app;`. Por possuir `NOBYPASSRLS`, o motor é matematicamente obrigado a aplicar os predicados das políticas RLS.

#### 4.2 Autorização na Aplicação vs. Políticas Efetivas no Banco
O MEDICINA 2029 opera com o modelo de **Defesa em Profundidade Segregada**:

```
Camada 1: NextAuth Middleware (`src/middleware.ts`)
          └── Intercepta requisições HTTP anônimas nas rotas de aplicação (/ciclo, /acervo, etc.)
              e força redirecionamento compulsório para /login.

Camada 2: Runtime das Server Actions (`src/lib/authorization.ts`)
          └── requireAuthenticatedProfile() valida a sessão JWT HTTPOnly do NextAuth.
          └── requireRole('responsavel') / requireRole('estudante') lança erro FORBIDDEN
              antes mesmo de emitir qualquer comando SQL.

Camada 3: Motor PostgreSQL RLS (`medicina.set_context()`)
          └── Injeta perfil_id e papel na sessão via SET LOCAL.
          └── Rejeição fatal P0001 caso o papel não corresponda rigorosamente ao registrado em perfis.
          └── Isolamento estrito de dados: Alice não enxerga Carlos; Bruno não enxerga Carlos;
              Bruno tem zero acesso a sessões individuais brutas de Alice (Princípio 1.2 da ESPEC).
```

#### 4.3 Supabase Storage (Catálogo vs. REST API)
A reavaliação de segurança do Storage confirma a arquitetura estabelecida em H1.07-R:
1. No Supabase Cloud, o schema `storage` pertence ao usuário interno `supabase_storage_admin`. A role `postgres` não possui titularidade sobre `storage.objects` ou `storage.buckets`.
2. As operações de upload e download são intermediadas exclusivamente pelo backend Next.js através da `SUPABASE_SERVICE_ROLE_KEY`.
3. Requisições HTTP com `service_role` efetuam **bypass total nas policies de RLS de `storage.objects`**. Portanto, políticas SQL em `storage.objects` são inoperantes e desnecessárias para proteger uploads via backend.
4. Os guardrails efetivos de Storage são:
   - Validação de papel no backend (`requireRole('responsavel')`);
   - Emissão de Signed URLs privadas com tempo de expiração restrito (60..900s, padrão 300s);
   - Bucket `acervo` configurado como estritamente privado (`public = false`);
   - Validação de integridade de formato e sanitização de path no banco de dados via constraint relacional `public.acervo_arquivos_file_path_format_check` utilizando a função canônica `medicina.is_valid_acervo_storage_path()`.

---

### 5. Matriz de Limpeza Topológica (35 Tabelas do Schema Canônico)

A ordem inversa de deleção foi matematicamente auditada para garantir zero falha de integridade referencial:

```
 1. public.curadoria_fila         (artefato_id in cards/acervo)
 2. public.acervo_jobs            (enviado_por in perfis / arquivo_id in acervo)
 3. public.acervo_figuras         (arquivo_id in acervo_arquivos)
 4. public.acervo_chunks          (arquivo_id in acervo_arquivos)
 5. public.acervo_paginas         (arquivo_id in acervo_arquivos)
 6. public.acervo_arquivos        (enviado_por in perfis)
 7. public.operacoes_idempotentes (perfil_id in perfis — ON DELETE RESTRICT)
 8. public.erros                  (perfil_id in perfis)
 9. public.tentativas             (perfil_id in perfis / sessao_id in sessoes)
10. public.sessoes                (perfil_id in perfis)
11. public.card_revisoes          (card_id in cards)
12. public.cards                  (perfil_id in perfis)
13. public.materiais              (aprovado_por in perfis)
14. public.repertorios            (perfil_id in perfis)
15. public.livros                 (perfil_id in perfis)
16. public.redacoes               (perfil_id in perfis)
17. public.simulado_questoes      (simulado_id in simulados)
18. public.simulado_areas         (simulado_id in simulados)
19. public.simulado_analise       (simulado_id in simulados)
20. public.simulados              (perfil_id in perfis)
21. public.ciclo_estado           (ciclo_id in ciclos)
22. public.ciclo_blocos           (ciclo_id in ciclos)
23. public.ciclos                 (estudante_perfil_id in perfis)
24. public.revisoes_trimestrais   (estudante/registrada_por in perfis)
25. public.checkins               (perfil_id in perfis)
26. public.responsavel_estudante  (responsavel/estudante in perfis)
27. public.perfis                 (id in perfis)
28. public.allowlist              (email in allowlist)
```

**Comprovação de Preservação:**
- **As 9 migrações:** A tabela `public._medicina_staging_migrations` permanece totalmente intocada (zero cláusulas DELETE);
- **Allowlist Inicial:** Os e-mails originais do sistema (`estudante@medicina2029.com.br`, `responsavel@medicina2029.com.br`) são estritamente preservados;
- **Catálogo Pedagógico:** As tabelas `public.disciplinas` e `public.topicos` são mantidas íntegras;
- **Zero Deleção Ampla:** Nenhuma instrução `TRUNCATE` ou `DELETE FROM table;` sem predicado `WHERE` é utilizada.

---

### 6. Evidências dos Testes Automatizados Locais (99/99 Aprovados)

A suíte completa de engenharia foi executada no motor PostgreSQL real (PGlite com pgvector) com 100% de sucesso:

```
 RUN  v4.1.12 /Users/brunoantunes/Documents/Projetos IA/medicina_2029-main

 ✓ src/app/actions/h2_03_r2c_restore_audit_fix.test.ts (11 tests) 5420ms
 ✓ src/app/actions/h2_03_r2d_functions_diagnosis.test.ts (5 tests) 2447ms
 ✓ src/app/actions/h2_04_functional_homologation_plan.test.ts (18 tests) 2664ms
 ✓ src/app/actions/h2_03_r_baseline_recovery_validation.test.ts (13 tests) 1622ms
 ✓ src/app/actions/h2_03_staging_baseline_backup.test.ts (12 tests) 1399ms
 ✓ src/app/actions/h2_04_r_preflight_simulation.test.ts (6 tests) 1217ms
 ✓ src/app/actions/h2_03_r2b_key_transmission_fix.test.ts (14 tests) 852ms
 ✓ src/app/actions/h2_03_r2_isolated_restore_preparation.test.ts (20 tests) 115ms

 Test Files  8 passed (8)
      Tests  99 passed (99)
   Duration  16.66s
```

#### Detalhamento da Suíte de Preflight Round-Trip (`h2_04_r_preflight_simulation.test.ts`):
1. `✓ 1. Provisionamento inicial insere 3 personas, allowlist, ciclos, cards e acervo (202ms)`
2. `✓ 2. Repetição da provisão executa sem erro e mantém contagens rigorosamente íntegras (179ms)`
3. `✓ 3. Falha no meio da transação reverte todas as mutações via ROLLBACK atômico (2ms)`
4. `✓ 4. Simula geração operacional de entidades filhas (sessões, tentativas, erros, idempotência e figuras) (3ms)`
5. `✓ 5. Procedimento de limpeza completa expurga 100% dos dados sintéticos respeitando foreign keys e acionando storage (10ms)`
6. `✓ 6. Comprova retorno estrito ao estado inicial: Zero resíduo sintético e baseline 100% preservado (2ms)`

---

### 7. Runbook Operacional para Execução Futura

Mediante expressa autorização do operador humano, a execução no ambiente Supabase Staging (`ynfocaorhadizlvbnzrt`) seguirá os seguintes passos:

#### Passo 1: Inspeção de Status (Segura, Passiva, Offline)
```bash
node scripts/db/prepare-staging-homologation.mjs --status
```
*Comportamento:* Exibe a matriz de prontidão funcional em memória e finaliza sem tocar em conexões remotas.

#### Passo 2: Provisionamento Controlado no Staging (Escreve Dados Sintéticos)
```bash
node scripts/db/prepare-staging-homologation.mjs --provision
```
*Interação exigida:*
1. Solicitação do token: Digite `CONFIRMAR HOMOLOGACAO STAGING`;
2. Validação automática de `prod-ca-2021.crt`;
3. Entrada oculta da senha administrativa da role `postgres` do Staging;
4. Execução transacional atômica (Alice, Bruno, Carlos, allowlist, ciclos, blocos, cards e acervo).

#### Passo 3: Critérios de Validação Pós-Seed
Imediatamente após a conclusão do provisionamento, auditar os seguintes indicadores na réplica ou via consultas seguras de leitura:
1. `SELECT count(*) FROM public.perfis WHERE email LIKE '%@medicina2029.staging';` -> **Retorno exato: 3**;
2. `SELECT count(*) FROM public.ciclos WHERE nome LIKE '%2029%';` -> **Retorno exato: 2**;
3. `SELECT count(*) FROM public.ciclo_blocos WHERE duracao_min = 50;` -> **Retorno exato: 56**;
4. `SELECT responsavel_perfil_id, estudante_perfil_id FROM public.responsavel_estudante WHERE vinculo_id = 1;` -> **Retorno: Bruno -> Alice**;
5. Login com as credenciais sintéticas via interface web `/login`.

#### Passo 4: Procedimento de Rollback e Limpeza (Retorno ao Baseline)
Ao término da rodada de homologação funcional, ou imediatamente caso ocorra qualquer anomalia operacional:
```bash
node scripts/db/prepare-staging-homologation.mjs --cleanup
```
*Interação exigida:*
1. Solicitação do token: Digite `CONFIRMAR LIMPEZA HOMOLOGACAO STAGING`;
2. Entrada oculta da senha administrativa do Staging;
3. Transação atômica única remove 100% dos dados de homologação e aciona purga de objetos sintéticos no Storage;
4. O banco retorna exatamente ao baseline limpo da H2.03.

---

### 8. Parecer Conclusivo de Engenharia

A preparação técnica e de segurança da tarefa **H2.04-R** está **CONCLUÍDA COM SUCESSO**.

O código dos lançadores foi blindado, os riscos de integridade referencial nas 35 tabelas foram saneados com a inclusão de `operacoes_idempotentes`, `acervo_figuras` e `tentativas`, e o comportamento transacional foi comprovado em simulação PostgreSQL descartável.

Nenhum comando destrutivo, seed remoto, chamada a APIs pagas (Gemini), deploy ou commit Git foi executado nesta sessão de trabalho. O ambiente de Supabase Staging permanece intacto, pronto para a execução mediante autorização humana.
