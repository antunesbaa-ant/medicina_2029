# Relatório Técnico — Tarefa F1.04-R: Revisão de Segurança, Endurecimento de Privilégios e Integração RLS
## Auditoria Arquitetural, Modelo de Confiança (Trust Model) e Suíte de Testes com 26 Cenários de Segurança

**Data da Validação F1.04-R:** 19/10/2026  
**Papéis:** RLS Test Suite Engineer & Database Security Architect  
**Status da Tarefa:** **CONCLUÍDA — APROVADA (100% dos testes aprovados, rollback e idempotência atestados)**  
**Ambiente de Execução:** PostgreSQL 18.6 isolado e descartável em memória (PGlite WASM) com extensão `vector` 0.8.7.  
**Restrição Estrita de Ambiente:** Nenhum banco de produção, Supabase remoto ou credencial externa foi acessado. Dados estritamente sintéticos sob o domínio de teste reservado RFC 2606/6761 (`example.invalid`).  

---

### Arquivos do Pacote F1.04-R
- **Proposta RLS Endurecida:** [`docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql)
- **Script de Rollback Atômico:** [`docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql)
- **Suíte de Testes Automatizada (26 Cenários):** [`scripts/f1_04/run-rls-validation.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/f1_04/run-rls-validation.mjs)
- **Fixtures Artificiais de Teste:** [`tests/integration/f1_04/fixtures.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/tests/integration/f1_04/fixtures.sql)
- **Helper de Integração TypeScript:** [`src/db/rls-context.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/rls-context.ts)
- **Testes Unitários da Integração:** [`src/db/rls-context.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/rls-context.test.ts)
- **Relatório de Arquitetura de Segurança:** [`docs/modernizacao/RELATORIO_F1_04.md`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/RELATORIO_F1_04.md)
- **Plano de Modernização Atualizado:** [`docs/modernizacao/PLANO_MODERNIZACAO.md`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/PLANO_MODERNIZACAO.md)

---

## 1. Resumo Executivo da Tarefa F1.04-R

A tarefa **F1.04-R** complementou e homologou a proposta arquitetural de Row-Level Security (RLS) desenvolvida na F1.04, aplicando um endurecimento rigoroso de segurança, implementando a camada transacional de integração com a aplicação, formalizando o modelo de confiança (*Trust Model*) do banco de dados e expandindo a suíte de validação automatizada de 18 para 26 cenários de segurança e isolamento.

### Principais Entregas e Endurecimentos:
1. **Proteção Defensiva por Coluna (Column-Level Grants):**  
   Revogação do `SELECT` irrestrito sobre a tabela `public.perfis` para a role `medicina_app`, substituído por concessões seletivas apenas em colunas seguras (`id`, `auth_user_id`, `nome`, `email`, `papel`, `criado_em`). Consultas diretas que tentem acessar a coluna `password_hash` são rejeitadas pelo PostgreSQL com código `42501` (*insufficient privilege*).
2. **Blindagem de Funções `SECURITY DEFINER` e Restrição de Privilégios:**  
   Revogação de permissão `EXECUTE` de `PUBLIC` em todas as funções do schema `medicina` e fixação de `SET search_path = public, medicina, pg_temp;`. Criação explícita da role `medicina_anon` (sem privilégios), demonstrando rejeição `42501` caso conexões não autorizadas tentem invocar `medicina.set_context`.
3. **Mecanismo Anti-Enumeração na Autenticação:**  
   A função `medicina.autenticar_por_email` checa compulsoriamente a tabela `public.allowlist`. E-mails inexistentes ou fora da allowlist retornam zero linhas imediatamente, prevenindo ataques de enumeração e timing attacks.
4. **Camada Transacional TypeScript (`withRlsContext`):**  
   Criação de helper seguro em [`src/db/rls-context.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/rls-context.ts) para envolver operações Drizzle em transações locais atômicas com `medicina.set_context` e limpeza defensiva obrigatória (`medicina.clear_context`), prevenindo contaminação de pool de conexões.
5. **Suíte de Testes Expandida (26/26 Cenários Aprovados):**  
   Execução automatizada em PostgreSQL 18.6 PGlite com 18 cenários de linha de base e 8 novos cenários específicos de auditoria (R1 a R8), alcançando 100% de aprovação.
6. **Ensaio de Rollback e Idempotência:**  
   Execução do script de rollback comprovou remoção integral de views (0 restantes), desativação de RLS em 100% das tabelas (0 restantes) e re-aplicação limpa da proposta sem colisões de objetos.

---

## 2. Auditoria de Identidade, Falsificação de Contexto e Modelo de Confiança (Trust Model)

### 2.1 Análise do Vetor de Falsificação de Contexto (Cenário R1)
No PostgreSQL com RLS baseado em variáveis de configuração local (`current_setting`), a função `medicina.set_context(p_perfil_id uuid, p_papel text)` verifica se o perfil e o papel existem na tabela `perfis`:

```sql
IF NOT EXISTS (
  SELECT 1 FROM public.perfis WHERE id = p_perfil_id AND papel::text = p_papel
) THEN
  RAISE EXCEPTION 'Contexto invalido: perfil % com papel % nao existe.', p_perfil_id, p_papel USING ERRCODE = 'P0001';
END IF;
```

O Cenário **R1** avaliou o que ocorre quando uma conexão operando com a role da aplicação (`medicina_app`) fornece um UUID válido correspondente a outro estudante (`S2_ID`):
- O banco valida que `S2_ID` existe e é estudante, configurando os parâmetros locais de sessão.
- **Resultado:** A transação passa a ter acesso aos dados pertencentes a `S2_ID`, mas é **estritamente bloqueada** de visualizar ou alterar qualquer dado de `S1_ID`. O RLS cumpre fielmente seu propósito de confinar a sessão à identidade assertada.

### 2.2 Fronteira entre Aplicação e Banco de Dados (Trust Model)
Este comportamento documenta o axioma fundamental do modelo de segurança adotado:
> **O banco de dados PostgreSQL NÃO autentica o usuário humano; o banco autoriza conexões sob a identidade de serviço da aplicação (`medicina_app`). O mecanismo GUC (`medicina.set_context`) é um protocolo de propagação de contexto de autorização transacional e NÃO substitui a autenticação do servidor.**

A camada de aplicação (NextAuth / Server Actions) é a guardiã da autenticação: ela valida cookies HTTP, sessões criptografadas e restringe qual `perfilId` é repassado ao banco. O RLS atua como uma **segunda linha de defesa relacional em profundidade** (*defense-in-depth*).

### 2.3 Matriz de Responsabilidade de Segurança

| Vetor de Risco | RLS no Banco Protege? | Mecanismo de Contenção |
|---|:---:|---|
| **Omissão acidental de `WHERE perfil_id = ?`** | **SIM** | O RLS intercepta o plano da query e injeta automaticamente os predicados de ownership. |
| **BOLA / IDOR via payload manipulado** | **SIM** | Tentativa de atualizar/inserir dados com IDs de outros perfis é rejeitada pelo RLS com erro `42501` ou zero linhas afetadas. |
| **Acesso Indevido do Responsável a Sessões Brutas (Princípio 1.2)** | **SIM** | Políticas RLS barram o responsável de ler a tabela `sessoes` bruta, canalizando o acesso para a view agregada `vw_acompanhamento_quinzenal`. |
| **Contaminação de Conexão na Pool (Connection Pool Leak)** | **SIM** | Configuração `is_local => true` (`SET LOCAL`) descarta o contexto ao final de cada transação / rollback. |
| **Leitura Direta de Senhas / Hashes** | **SIM** | Column-Level Grants revogam `SELECT` em `perfis.password_hash` para a role da aplicação. |
| **Invasão / RCE Total no Servidor Web** | **NÃO** | Atacante com controle do runtime Node.js e posse da credencial `medicina_app` pode chamar `set_context` para outros UUIDs. Proteção depende de IAM e segurança de servidor. |
| **Vazamento da Credencial de Banco** | **NÃO** | Proteção depende da segregação de segredos e rotação de credenciais (endereçada na F1.06). |

---

## 3. Endurecimento das Funções e Modelo de Privilégios

### 3.1 Tratamento de Incoerência de Papel (Cenário R2)
Quando um chamador sob `medicina_app` tenta chamar `medicina.set_context` com um UUID legítimo mas fornecendo um papel divergente do cadastrado em `perfis` (ex.: perfil de estudante declarando-se `'responsavel'`), ou fornecendo um UUID inexistente:
- O banco aborta a transação emitindo `RAISE EXCEPTION` com código `P0001` (*raise_exception*).
- Nenhuma permissão é concedida, mantendo o estado fail-closed.

### 3.2 Column-Level Grants em `public.perfis` (Cenário R3)
Para garantir defesa em profundidade real além da apresentação da view `vw_perfis`:
- `REVOKE SELECT ON public.perfis FROM medicina_app;`
- `GRANT SELECT (id, auth_user_id, nome, email, papel, criado_em) ON public.perfis TO medicina_app;`
- Tentativas de emitir `SELECT password_hash FROM perfis` ou `SELECT * FROM perfis` falham na fase de autorização de colunas do PostgreSQL com código de erro `42501`.

### 3.3 Bloqueio de Papel Não Privilegiado `medicina_anon` (Cenário R4)
- A role `medicina_anon` foi provisionada sem concessão de `USAGE` no schema `medicina` e sem `SELECT` em `perfis`.
- Tentativas de chamada a `medicina.set_context` sob essa role são bloqueadas na origem pelo PostgreSQL com erro `42501`.

### 3.4 Comportamento Fail-Closed Fora de Transação (Cenário R5)
- Como `medicina.set_context` invoca `set_config(..., is_local => true)`, qualquer chamada executada fora de um bloco transacional explícito (`BEGIN ... COMMIT`) é autocomitada e descartada imediatamente.
- Consultas subsequentes encontram `current_setting('medicina.current_perfil_id', true)` vazio/nulo, resultando em 0 linhas retornadas.

### 3.5 Autenticação Anti-Enumeração e Guarda na Allowlist (Cenários R6 e R7)
A função `medicina.autenticar_por_email(p_email text)` é `SECURITY DEFINER` e opera com privilégio controlado para NextAuth:
- **Cenário R6:** E-mail fora da allowlist (`estudante2.f104@example.invalid`) ou inexistente retorna 0 linhas imediatamente.
- **Cenário R7:** E-mail cadastrado na allowlist e existente em perfis (`estudante1.f104@example.invalid`) retorna a linha completa incluindo o hash de senha para verificação pelo NextAuth.

### 3.6 Isolamento em Subqueries, Joins e Views Agregadas (Cenário R8)
- Consultas relacionais complexas (JOINs entre `sessoes` e `perfis`, filtros `IN (SELECT id FROM perfis WHERE ...)` e acessos à view `vw_revisoes_trimestrais` com `security_invoker = true`) garantem que o filtro RLS seja injetado recursivamente em cada nó do plano de consulta.
- Tentativas de junção contra registros de outro estudante sob o contexto de `S1_ID` retornam exatamente 0 linhas.

---

## 4. Camada de Integração Transacional da Aplicação (`src/db/rls-context.ts`)

Para viabilizar o consumo seguro das políticas RLS no código TypeScript/Drizzle da aplicação, foi implementado o helper:

```typescript
export async function withRlsContext<T>(
  perfilId: string,
  papel: 'estudante' | 'responsavel',
  callback: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>
): Promise<T> {
  if (!perfilId || typeof perfilId !== 'string') {
    throw new Error('RLS Context Error: perfilId é obrigatório e deve ser uma string UUID válida.');
  }
  if (papel !== 'estudante' && papel !== 'responsavel') {
    throw new Error(`RLS Context Error: papel inválido "${papel}". Esperado "estudante" ou "responsavel".`);
  }

  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT medicina.set_context(${perfilId}::uuid, ${papel}::text);`);
    try {
      return await callback(tx);
    } finally {
      try {
        await tx.execute(sql`SELECT medicina.clear_context();`);
      } catch {
        // Se a transação abortou, o rollback do PostgreSQL já descarta os parâmetros locais
      }
    }
  });
}
```

O helper foi validado pela suíte Vitest em [`src/db/rls-context.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/rls-context.test.ts), cobrindo:
1. Rejeição síncrona de inputs inválidos antes de abrir transação no banco;
2. Configuração transacional e limpeza defensiva no bloco `finally`;
3. Tratamento transparente de exceções com preservação do rollback atômico.

---

## 5. Matriz Completa de Validação de Segurança (26 Cenários)

A suíte automatizada em [`scripts/f1_04/run-rls-validation.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/f1_04/run-rls-validation.mjs) executou os 26 cenários em instância PGlite PostgreSQL 18.6 com pgvector 0.8.7.

| ID | Cenário de Teste | Papel DB / Contexto | Ação Realizada | Resultado Esperado | Status |
|:---:|---|---|---|---|:---:|
| **1** | Usuário não autenticado | `medicina_app` / Sem contexto | `SELECT` em `sessoes`, `cards`, `redacoes`, `checkins` | Retorna 0 linhas (Fail-Closed) | **PASS** |
| **2** | Estudante autenticada | `medicina_app` / Estudante 1 | `SELECT` e `INSERT` em dados próprios e materiais aprovados | Operações bem-sucedidas restritas ao owner | **PASS** |
| **3** | Responsável autenticado | `medicina_app` / Responsável 1 | `SELECT` em acervo próprio e `vw_acompanhamento_quinzenal` | Zero sessões brutas; view agregada acessível | **PASS** |
| **4** | Responsável sem vínculo | `medicina_app` / Responsável 2 | Tentativa de leitura de view/dados de Estudante 1 | 0 linhas retornadas | **PASS** |
| **5** | Acesso cross-tenant | `medicina_app` / Estudante 1 | `SELECT * FROM sessoes WHERE perfil_id = S2` | 0 linhas retornadas | **PASS** |
| **6** | INSERT com owner forjado | `medicina_app` / Estudante 1 | `INSERT INTO sessoes (perfil_id = S2)` | Rejeitado por `WITH CHECK` (erro `42501`) | **PASS** |
| **7** | UPDATE indevido | `medicina_app` / Estudante 1 | `UPDATE sessoes SET nota_livre WHERE perfil_id = S2` | 0 linhas afetadas | **PASS** |
| **8** | DELETE indevido | `medicina_app` / Estudante 1 | `DELETE FROM sessoes WHERE perfil_id = S2` | 0 linhas afetadas | **PASS** |
| **9** | Conteúdos não aprovados | `medicina_app` / Estudante 1 | `SELECT * FROM materiais WHERE status = 'rascunho'` | 0 linhas retornadas (Princípio 1.7) | **PASS** |
| **10** | Indicadores agregados | `medicina_app` / Responsável 1 | `SELECT * FROM vw_acompanhamento_quinzenal` | 1 quinzena agregada consolidada | **PASS** |
| **11** | Omissão de dados sensíveis | `medicina_app` / Estudante 1 | `SELECT * FROM vw_perfis` | Projeção segura sem coluna `password_hash` | **PASS** |
| **12** | Evasão via Subquery/JOIN | `medicina_app` / Estudante 1 | Subquery aninhada tentando alcançar sessões de S2 | RLS injetado em cascata; 0 linhas | **PASS** |
| **13** | Operações sem contexto | `medicina_app` / Sem contexto | `INSERT INTO cards` sem contexto configurado | Bloqueado pelo RLS (erro `42501`) | **PASS** |
| **14** | Contexto com papel inválido | `medicina_app` / Papel fake | `medicina.set_context(S1, 'hacker')` | Rejeitado na validação de contexto (`P0001`) | **PASS** |
| **15** | Transações sucessivas | `medicina_app` / S1 depois S2 | Transações sequenciais na mesma conexão física | Sem vazamento de contexto entre perfis | **PASS** |
| **16** | Reutilização de conexões | `medicina_app` / Pós-DISCARD | Reset de conexão com `DISCARD ALL` | Conexão estéril retorna 0 linhas (Fail-Closed) | **PASS** |
| **17** | Ownership em tabelas filhas | `medicina_app` / Estudante 1 | `SELECT` e `INSERT` em `card_revisoes` | Herança estrita do ownership do card pai | **PASS** |
| **18** | Bloqueio de DDL/Bypass | `medicina_app` / Sem contexto | `ALTER TABLE sessoes DISABLE ROW LEVEL SECURITY` | Rejeitado pelo PostgreSQL (erro `42501`) | **PASS** |
| **R1** | Falsificação com UUID válido | `medicina_app` / Estudante 2 | Validação do Trust Model e isolamento para S2 | Retorna dados de S2; zero dados de S1 | **PASS** |
| **R2** | Incoerência de Papel | `medicina_app` / Estudante 1 | `medicina.set_context(S1, 'responsavel')` | Exceção explícita `P0001` no `set_context` | **PASS** |
| **R3** | Tentativa de SELECT Hash | `medicina_app` / Estudante 1 | `SELECT password_hash FROM perfis` | Rejeição `42501` por Column-Level Grant | **PASS** |
| **R4** | Chamada por medicina_anon | `medicina_anon` / Anônimo | Tentativa de `medicina.set_context` e `perfis` | Rejeição `42501` por ausência de permissão | **PASS** |
| **R5** | Execução fora de transação | `medicina_app` / Autocommit | `set_context` autocomitado seguido de `SELECT` | Contexto descartado via `is_local`; 0 linhas | **PASS** |
| **R6** | Anti-enumeração por e-mail | `medicina_app` / Não allowlist | `medicina.autenticar_por_email(S2_EMAIL)` | Retorna 0 linhas (proteção contra enumeração) | **PASS** |
| **R7** | Autenticação allowlist | `medicina_app` / Na allowlist | `medicina.autenticar_por_email(S1_EMAIL)` | Retorna credenciais válidas para NextAuth | **PASS** |
| **R8** | Isolamento em Subqueries/Views | `medicina_app` / Estudante 1 | JOINs cross-tenant e `vw_revisoes_trimestrais` | Retorna apenas dados de S1; 0 dados de S2 | **PASS** |

**Taxa de Sucesso da Suíte:** **100.0% (26 de 26 cenários aprovados)**

---

## 6. Ensaio de Rollback e Idempotência

O procedimento de rollback atômico e re-aplicação foi executado na sequência imediata à validação:
1. **Execução de `F1_04_ROLLBACK_RLS.sql`:**
   - Remoção de views de segurança (`vw_perfis`, `vw_acompanhamento_quinzenal`, `vw_simulados_evolucao`, `vw_revisoes_trimestrais`);
   - Desabilitação de Row-Level Security em todas as 33 tabelas;
   - Remoção de todas as políticas de linha;
   - Restauração de permissões de tabela e descarte em cascata do schema `medicina`.
   - **Resultado do rollback:** 0 views restantes, 0 tabelas com RLS ativo.
2. **Re-aplicação de `F1_04_RLS_PROPOSTA.sql`:**
   - O script completo de proposta foi re-aplicado sobre a mesma base.
   - **Resultado da re-aplicação:** Sucesso total sem erros de sintaxe, sem colisões de tipos ou identificadores, atestando a idempotência da DDL.

---

## 7. Quality Gates do Projeto

Todos os gates obrigatórios de qualidade e tipagem foram executados e aprovados:

```bash
# 1. Typecheck estrito TypeScript
npx tsc --noEmit
# Resultado: 0 erros

# 2. Suíte de testes unitários Vitest
npm run test:run
# Resultado: 17 test files, 117/117 testes aprovados (incluindo rls-context.test.ts)

# 3. Integridade do schema Drizzle
npx drizzle-kit check
# Resultado: Everything's fine

# 4. Formatação e espaços em branco Git
git diff --check
# Resultado: 0 violações
```

---

## 8. Conclusão e Recomendações para as Próximas Tarefas

1. **Estado da Proposta RLS:**  
   A proposta arquitetural F1.04-R está formalmente validada, endurecida e pronta para ser aplicada em ambiente de banco de dados compartilhado/homologação quando a infraestrutura de deployment estiver disponível.
2. **Próximo Gate Obrigatório:**  
   Prosseguir para a tarefa **F1.06** (Atualização de dependências críticas e separação de segredos), mantendo a integridade da suíte de segurança verde e respeitando a governança do Plano de Modernização.
