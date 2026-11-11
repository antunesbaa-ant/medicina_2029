# MEDICINA 2029 — H2.04-T5-V-R: CORREÇÃO DO GERENCIAMENTO DE SESSÕES PENDENTES
## RELATÓRIO TÉCNICO DE ENGENHARIA DE SOFTWARE E CONSISTÊNCIA DE CICLO

**Data:** 11 de Novembro de 2026  
**Ambiente:** Supabase Staging (`ynfocaorhadizlvbnzrt`) / Código Next.js Local  
**Identidade Técnica da Conexão:** `medicina_app` (Session Pooler porta 5432)  
**Validação TLS:** Certificado CA emitido por Supabase (`~/Downloads/prod-ca-2021.crt`), com `rejectUnauthorized: true`  
**Modo de Operação Remota:** EXCLUSIVAMENTE LEITURA (Zero mutações remotas nesta tarefa)  
**Status da Avaliação:** **APTO COM RECOMENDAÇÃO OPERACIONAL**

---

## 1. CAUSA RAIZ DA SESSÃO ADICIONAL (SESSÃO #2)

Durante a rodada de homologação da tarefa anterior (`H2.04-T5-UI`), a interface do cronômetro foi reformulada para suportar resoluções de desktop até mobile.
Às **18:47:17 UTC (15:47:17 BRT)**, o navegador reabriu a rota:
`/estudar?blocoId=41000000-0000-4000-8000-000000000001&topicoId=e0000000-0000-4000-8000-000000000001`
(parâmetros herdados da navegação inicial do Bloco 1 — Matemática).

Nesse momento, a cadeia de chamadas produziu a segunda sessão devido a duas lacunas de proteção no código anterior:

1. **Lacuna em `obterEstadoSessaoCronometro`:**
   Como a Sessão #1 já estava concluída (`encerrada_em` preenchido às 13:04 UTC), a consulta por sessões abertas retornou vazia. Em seguida, ao resolver o próximo bloco a sugerir, o código verificou apenas a presença de `validado.cicloBlocoId`. Como o parâmetro continha o ID do Bloco 1, a função sugeriu o Bloco 1, **sem verificar** que o Bloco 1 já havia sido concluído e que o ciclo já apontava para `proxima_ordem = 2` (Biologia).
2. **Auto-inicialização no Componente `CronometroPage`:**
   Ao receber `statusSessao === 'nao_iniciada'` e um `blocoSugerido` para o Bloco 1, o Client Component invocou imediatamente `iniciarSessao(reconciliado.blocoId, reconciliado.topicoId)`.
3. **Ausência de Gate de Bloco Concluído em `iniciarSessao`:**
   A Server Action `iniciarSessao` validava apenas se existia outra sessão aberta no momento e a integridade relacional. Como não havia nenhuma sessão com `encerrada_em IS NULL`, ela executou o `INSERT INTO sessoes`, gerando a Sessão #2 (`679937fc-9a54-4ba5-b7cb-ebde6b9f890b`) com zero segundos e `concluida = false`.

---

## 2. REGRA ANTERIOR VS. REGRA CORRIGIDA DE RECUPERAÇÃO DE SESSÕES

### Regra Anterior (Defeituosa)
- `obterEstadoSessaoCronometro`: Executava `SELECT ... FROM sessoes WHERE perfil_id = $1 AND encerrada_em IS NULL LIMIT 1`.
- Se encontrasse **qualquer** sessão aberta, retornava-a sumariamente como `em_andamento`.
- **Falha Crítica:** Se houvesse uma sessão aberta órfã de um bloco passado (como a Sessão #2 de Matemática, enquanto o ciclo está em Biologia), a rota `/estudar` sequestrava a aluna para a disciplina antiga, impedindo a progressão natural do ciclo.

### Regra Corrigida (Determinística e Resiliente)
1. **Prioridade do Ciclo Ativo:** O servidor consulta primeiro o ciclo ativo e o ponteiro atual (`ciclo_estado.proxima_ordem`).
2. **Critério de Validação da Sessão Aberta Legítima:**
   - **Navegação com Parâmetro Explícito (`?blocoId=...`):** A sessão aberta só é retornada se pertencer rigorosamente ao bloco solicitado. Sessões abertas de outros blocos são ignoradas.
   - **Navegação Direta sem Parâmetros (`/estudar`):** A sessão aberta só é retornada se o seu bloco coincidir com a atividade corrente apontada pelo ciclo (`bloco.ordem === proximaOrdem`). Se a sessão aberta pertencer a um bloco anterior (`bloco.ordem < proximaOrdem`), ela é classificada como **órfã/incompatível** e o servidor sugere o bloco atual do ciclo.
3. **Filtro de Links Obsoletos:** Se o cliente acessar `/estudar` com `blocoId` de um bloco anterior ao ponteiro atual do ciclo (`bloco.ordem < proximaOrdem`), o servidor desconsidera o parâmetro obsoleto e sugere com segurança a atividade corrente do ciclo (`proximaOrdemCiclo`).
4. **Proteção contra Reinício Indevido em `iniciarSessao`:** `iniciarSessao` rejeita com erro fail-closed (`409 CONFLICT`) qualquer tentativa de abrir nova sessão para blocos que já tenham sessão concluída e cujo ponteiro do ciclo já tenha avançado.
5. **Autocura de Resíduos em `iniciarSessao`:** Se existir uma sessão aberta de um bloco anterior que já foi superado pelo ciclo (`bloco.ordem < proximaOrdem`), ao iniciar legitimamente a atividade atual do ciclo, o resíduo anterior é automaticamente encerrado como incompleto (`concluida: false`), desimpedindo a estudante sem exigir intervenções manuais no banco.

---

## 3. CORREÇÕES LOCAIS IMPLEMENTADAS

### 3.1. Em [`src/app/actions/sessao.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/sessao.ts)
- **Bloqueio de Reabertura de Blocos Concluídos:**
  Valida se o bloco requisitado possui ordem inferior à `proximaOrdem` do ciclo ativo e já possui sessão concluída (`concluida = true`). Se verdadeiro, aborta com `CONFLICT: Este bloco do ciclo já foi concluído e o ciclo avançou para a próxima atividade.`
- **Tratamento de Sessões Órfãs Anteriores:**
  Caso exista uma sessão aberta de bloco superado pelo ciclo, a rotina a encerra com `encerradaEm = new Date()`, `concluida = false` e anotação rastreável em `notaLivre`, permitindo que a nova sessão seja criada.
- **Filtro Estrito em `obterEstadoSessaoCronometro`:**
  Avalia `pediuOutroBloco` e `blocoJaSuperado`. Sessões abertas residuais de blocos passados não são retornadas como `em_andamento`, fazendo o sistema sugerir o bloco correto da vez (Bloco 2 — Biologia).
- **Proteção de Fallback de `itemBloco`:**
  Redireciona links com `blocoId` defasado para o bloco correspondente a `proximaOrdemCiclo`.

### 3.2. Em [`src/components/CronometroPage.tsx`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/components/CronometroPage.tsx)
- **Sincronização de URL:**
  Quando a Server Action retorna um `blocoSugerido` divergente do parâmetro de URL (ex.: URL apontava para bloco 1, mas o ciclo já está no bloco 2), a página alinha a URL do navegador via `router.replace` sem recarregar a tela, mantendo coerência absoluta entre a barra de endereços e o estado real do cronômetro.

---

## 4. TESTES EXECUTADOS E RESULTADOS

Foi desenvolvida a suíte dedicada [`src/app/actions/h2_04_t5_v_r_gerenciamento_sessoes_pendentes.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h2_04_t5_v_r_gerenciamento_sessoes_pendentes.test.ts) com 8 testes cobrindo todos os cenários operacionais:

```text
 ✓ src/app/actions/h2_04_t5_v_r_gerenciamento_sessoes_pendentes.test.ts (8 tests) 5ms
   ✓ MEDICINA 2029 — H2.04-T5-V-R: Correção do Gerenciamento de Sessões Pendentes (8)
     ✓ 1. Resolução e Filtro de Sessões Órfãs de Blocos Anteriores (4)
       ✓ ignora sessão aberta de bloco anterior quando a navegação é direta (sem parâmetros) e sugere o bloco atual do ciclo
       ✓ ignora sessão aberta de outro bloco quando o cliente solicita explicitamente o bloco 2
       ✓ redireciona para o bloco ativo corrente quando acessado com link obsoleto de bloco anterior
       ✓ preserva integralmente a retomada de uma sessão legítima em andamento no bloco atual
     ✓ 2. Integridade e Regras de Inicialização (iniciarSessao) (3)
       ✓ rejeita reiniciar um bloco que já foi concluído e superado pelo ciclo
       ✓ auto-encerra sessão órfã de bloco anterior ao iniciar legitimamente a atividade atual do ciclo
       ✓ mantém bloqueio por conflito se a sessão aberta for de bloco válido e o estudante tentar abrir outro simultaneamente
     ✓ 3. Idempotência e Preservação do Avanço do Ciclo (1)
       ✓ retorna a sessão existente de forma idempotente sem duplicar o avanço ao finalizar sessão já concluída
```

Execução conjunta com a suíte de homologação H2.04:
```text
Test Files  9 passed | 5 skipped (14)
     Tests  97 passed | 71 skipped (168)
  Duration  3.06s
```
**Total de 97 testes locais aprovados com 100% de sucesso.**

Adicionalmente, uma simulação de leitura em staging comprovou que a nova lógica, alimentada com os dados reais de Alice no Supabase Staging:
- Na navegação sem parâmetros `/estudar`: sugere **Bloco 2 — Biologia (Biologia Celular e Mitocôndrias)** com `proximaOrdem = 2`.
- Na navegação com parâmetro explícito `blocoId=...0002`: sugere **Bloco 2 — Biologia**.
- Na navegação com link antigo `blocoId=...0001`: redireciona com segurança para **Bloco 2 — Biologia**.

---

## 5. SITUAÇÃO DA SESSÃO PENDENTE NO STAGING

| Atributo | Estado Real Comprovado |
| :--- | :--- |
| **ID da Sessão** | `679937fc-9a54-4ba5-b7cb-ebde6b9f890b` |
| **Perfil** | `10000000-0000-4000-8000-000000000001` (Alice Estudante Sintética) |
| **Bloco** | `41000000-0000-4000-8000-000000000001` (Bloco 1 — Matemática) |
| **Horário de Início** | `2026-11-11T18:47:17.658Z` (15:47:17 BRT) |
| **Horário de Encerramento** | `null` |
| **Duração Efetiva** | **0 segundos** |
| **Concluída** | **`false`** |
| **Impacto no Ciclo** | **Nenhum** (`ciclo_estado.proxima_ordem = 2` mantido intacto). |

---

## 6. NECESSIDADE OU NÃO DE SANEAMENTO REMOTO

### Avaliação Técnica
1. **Com as correções locais aplicadas, o saneamento remoto NÃO é bloqueador:**
   A rota `/estudar` e a Server Action `obterEstadoSessaoCronometro` não mais se deixam capturar por esse registro; elas filtram a sessão residual e exibem o Bloco 2 de Biologia.
2. **Recomendação:**
   Por higiene relacional e para eliminar o registro com `encerrada_em IS NULL`, recomenda-se um encerramento administrativo pontual.

### Proposta Específica de Saneamento Seguro (Aguardando Autorização)

```sql
-- 1. PRÉ-CONDIÇÕES DE SEGURANÇA
-- Executar sob a role medicina_app com contexto de Alice:
SELECT medicina.set_context('10000000-0000-4000-8000-000000000001'::uuid, 'estudante');

-- 2. OPERAÇÃO MÍNIMA NECESSÁRIA (Atômica e Idempotente)
UPDATE public.sessoes
SET encerrada_em = NOW(),
    concluida = false,
    nota_livre = '[Sessão cancelada: resíduo órfão de navegação durante homologação H2.04-T5-UI]'
WHERE id = '679937fc-9a54-4ba5-b7cb-ebde6b9f890b'::uuid
  AND perfil_id = '10000000-0000-4000-8000-000000000001'::uuid
  AND concluida = false
  AND encerrada_em IS NULL;

-- 3. VERIFICAÇÃO POSTERIOR
SELECT id, iniciada_em, encerrada_em, concluida, nota_livre
FROM public.sessoes
WHERE id = '679937fc-9a54-4ba5-b7cb-ebde6b9f890b'::uuid;
-- Deve retornar encerrada_em preenchido e concluida = false.

SELECT proxima_ordem FROM public.ciclo_estado WHERE ciclo_id = '40000000-0000-4000-8000-000000000001'::uuid;
-- Deve permanecer rigorosamente igual a 2.

-- 4. ESTRATÉGIA DE ROLLBACK (Se necessária)
-- UPDATE public.sessoes SET encerrada_em = NULL, concluida = false, nota_livre = NULL WHERE id = '679937fc-9a54-4ba5-b7cb-ebde6b9f890b'::uuid;
```

> **Atenção:** Em estrito cumprimento das restrições da tarefa, **nenhum comando de escrita foi executado contra o Supabase Staging**. A proposta acima aguarda autorização humana explícita do operador.

---

## 7. PROCEDIMENTO SEGURO PARA VALIDAR O PRÓXIMO BLOCO (BIOLOGIA)

1. Iniciar o servidor de homologação local:
   ```bash
   node scripts/db/launch-staging-web.mjs
   ```
2. Acessar no navegador:
   ```text
   http://127.0.0.1:3000/ciclo
   ```
3. Verificar na fila do ciclo:
   - Bloco 1 (Matemática): Marcado como concluído com check visual;
   - Bloco 2 (Biologia): Marcado como ativo ("Próximo Bloco");
4. Clicar no botão **"Estudar"** do Bloco 2:
   - A URL carregada será `/estudar?blocoId=41000000-0000-4000-8000-000000000002`;
   - O cronômetro iniciará com o título: **Biologia — Biologia Celular e Mitocôndrias**;
   - A etapa iniciará em **Revisão (5m)**;
   - O cronômetro estará limpo e pronto para a segunda sessão de estudo de Alice.

---

## 8. PARECER CONCLUSIVO

O gerenciamento de sessões pendentes e órfãs foi **completamente corrigido e blindado** no código da aplicação.
- A causa raiz foi neutralizada com gates determinísticos em `iniciarSessao` e `obterEstadoSessaoCronometro`.
- A sessão homologada de Matemática e o ponteiro `proxima_ordem = 2` permanecem intactos no staging.
- Nenhum dado remoto foi modificado durante esta tarefa.

**Parecer Final:** **APTO** para a homologação do Bloco 2 (Biologia).
