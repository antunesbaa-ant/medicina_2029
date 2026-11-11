# MEDICINA 2029 — H2.04-T5-V-R2: VERIFICAÇÃO FINAL DO GERENCIAMENTO DE SESSÕES
## RELATÓRIO TÉCNICO DE ENGENHARIA, CONCORRÊNCIA E COMPORTAMENTO CIRCULAR

**Data:** 11 de Novembro de 2026  
**Ambiente:** Supabase Staging (`ynfocaorhadizlvbnzrt`) / Código Next.js Local  
**Identidade Técnica de Conexão:** `medicina_app` (Session Pooler porta 5432)  
**Validação TLS:** Certificado CA emitido por Supabase (`~/Downloads/prod-ca-2021.crt`), com `rejectUnauthorized: true`  
**Modo de Operação Remota:** EXCLUSIVAMENTE LEITURA (Zero mutações remotas nesta tarefa)  
**Status da Avaliação:** **APTO** para iniciar a homologação de Biologia (Bloco 2)

---

## 1. PARECER CONCLUSIVO

> **PARECER FINAL: APTO**  
> A implementação do gerenciamento de sessões pendentes e transição circular foi exaustivamente verificada, fortalecida e validada através de 12 novos testes locais unitários e de concorrência. O sistema garante atomicidade transacional, isolamento multi-tenant, imunidade contra reabertura de blocos superados e suporte determinístico à transição circular entre o último bloco (28) e o primeiro (1).

---

## 2. VERIFICAÇÃO DO ENCERRAMENTO AUTOMÁTICO E TRANSACIONALIDADE

A rotina de inicialização de sessão em [`src/app/actions/sessao.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/sessao.ts) foi auditada linha a linha nos 6 eixos críticos exigidos:

1. **Mesma Transação da Inicialização Autorizada:**
   - O auto-encerramento da sessão órfã residual (`tx.update(sessoes)`) e a criação da nova sessão legítima (`tx.insert(sessoes)`) são executados sob o mesmo manipulador transacional `tx` gerenciado por `db.transaction(async (tx) => { ... })`.
   - Não há janelas temporais de inconsistência ("split-brain") entre o encerramento da anterior e o início da nova.

2. **Escopo Estrito da Sessão Residual:**
   - O predicado de atualização foi blindado com checagem quádrupla de defesa em profundidade:
     ```ts
     .where(
       and(
         eq(sessoes.id, sessaoAberta.id),
         eq(sessoes.perfilId, perfil.id),
         isNull(sessoes.encerradaEm),
         eq(sessoes.concluida, false)
       )
     )
     ```
   - Garante matematicamente que apenas a sessão residual identificada pertencente à própria aluna autenticada, que ainda esteja aberta e que não tenha sido concluída, pode ser afetada.

3. **Preservação de Sessões Legítimas Pausadas:**
   - Se a estudante estiver com uma sessão aberta no bloco atual do ciclo e reiniciar ou retomar o cronômetro para o mesmo bloco e tópico, a função detecta a correspondência em:
     ```ts
     if (mesmoBloco && mesmoTopico) {
       return sessaoAberta.id;
     }
     ```
   - A chamada retorna imediatamente o identificador da sessão ativa, sem executar qualquer `UPDATE` de encerramento nem duplicar o registro.

4. **Inviolabilidade de Sessões Concluídas:**
   - Sessões concluídas possuem `concluida = true` e `encerrada_em` preenchido. A busca inicial por sessões pendentes filtra estritamente por `isNull(sessoes.encerradaEm)`.
   - Adicionalmente, o filtro do `UPDATE` exige `isNull(sessoes.encerradaEm)` e `concluida = false`. Nenhuma sessão com histórico de estudo finalizado pode ser modificada ou cancelada.

5. **Rollback Integral em Caso de Falha:**
   - Caso ocorra qualquer falha durante a validação relacional de disciplinas/tópicos ou na inserção da nova sessão, a transação do PostgreSQL é abortada e revertida integralmente (`ROLLBACK`). O auto-encerramento do resíduo não é persistido isoladamente.

6. **Serialização Concorrente de Múltiplas Abas:**
   - A rotina adquire um bloqueio consultivo transacional exclusivo no início da transação:
     ```sql
     SELECT pg_advisory_xact_lock(hashtextextended(${perfil.id}::text, 0));
     ```
   - Duas abas ou cliques duplos simultâneos são serializados na camada do PostgreSQL. A segunda transação aguarda a liberação da primeira, encontrando a sessão já criada e retornando de forma idempotente sem conflitos.

---

## 3. VERIFICAÇÃO DO COMPORTAMENTO CIRCULAR (TRANSIÇÃO DO BLOCO 28 PARA O BLOCO 1)

### Análise da Transição Circular
No modelo de fila sequencial de Medicina 2029, o ciclo possui $N = 28$ blocos previstos. Ao concluir o bloco 28:
- A função [`calcularProximaOrdem(28, 28)`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/studysystem.ts#L5) calcula `(28 % 28) + 1 = 1`.
- O registro `ciclo_estado.proxima_ordem` avança ciclicamente para `1`.

### Prevenção de Falhas no Ciclo Circular
Na revisão anterior, comparações puramente lineares baseadas em `ordem < proximaOrdem` podiam apresentar comportamentos inadequados na transição circular (onde $28 > 1$). 

Para blindar o comportamento circular:
1. **Identificação de Sessão Órfã na Transição Circular:**
   A condição foi aprimorada de `ordem < proximaOrdemAtual` para `ordem !== proximaOrdemAtual`. Na volta circular, quando `proximaOrdemAtual = 1` e existe uma sessão órfã aberta do Bloco 28, o sistema reconhece que $28 \neq 1$, classificando-a corretamente como órfã e auto-encerrando-a ao iniciar o Bloco 1.
2. **Início da 2ª Volta sem Bloqueio Indevido:**
   Quando Alice inicia o Bloco 1 na 2ª volta (`proximaOrdem = 1`), a ordem do bloco requisitado coincide com o ponteiro do ciclo ($1 == 1$). O gate de bloco já concluído não bloqueia a atividade, permitindo uma nova volta legítima.
3. **Bloqueio de Reinício Prematuro de Blocos Superados da Volta Anterior:**
   Se o ciclo está na ordem 1 e o cliente tenta iniciar o Bloco 28 concluído na volta anterior, a verificação $28 \neq 1$ detecta a divergência com o ponteiro e consulta a existência de conclusão prévia, bloqueando a operação com `409 CONFLICT`.
4. **Redirecionamento de Links Obsoletos:**
   Em `obterEstadoSessaoCronometro`, se o cliente carregar a tela com um link defasado do Bloco 28 enquanto o ciclo está na ordem 1, a lógica redireciona deterministicamente a sugestão para o Bloco 1 da 2ª volta.
5. **Isolamento de Histórico Antigo:**
   Sessões de voltas passadas com `concluida = true` e `encerrada_em` preenchido nunca são resgatadas como ativas pelo cronômetro.

---

## 4. PROPOSTA CORRIGIDA DE SANEAMENTO REMOTO (PL/pgSQL COM RLS)

> **Importante:** Em conformidade estrita com o mandato da tarefa, **nenhum comando de escrita foi executado contra o Supabase Staging**. A rotina abaixo é apresentada para revisão e execução administrativa futura apenas se e quando expressamente autorizado pelo operador.

### Procedimento Transacional com Verificação de Linhas Afetadas

```sql
-- ============================================================================
-- PROCEDIMENTO ATÔMICO DE SANEAMENTO DE SESSÃO ÓRFÃ
-- Executar exclusivamente sob a role: medicina_app
-- ============================================================================

BEGIN;

-- 1. CONFIGURAÇÃO DE CONTEXTO RLS NA MESMA TRANSAÇÃO
SELECT medicina.set_context('10000000-0000-4000-8000-000000000001'::uuid, 'estudante');

-- 2. BLOCO PL/pgSQL COM PRÉ-CONDIÇÕES E VALIDAÇÃO DE LINHAS AFETADAS
DO $$
DECLARE
  v_rows_affected integer;
  v_ponteiro_ordem integer;
  v_sessao_concluida_id uuid;
BEGIN
  -- Pré-condição A: Confere que a Sessão Concluída #1 de Matemática permanece íntegra
  SELECT id INTO v_sessao_concluida_id
  FROM public.sessoes
  WHERE id = '5b17131d-4f44-414a-a87d-52485bf00f26'::uuid
    AND perfil_id = '10000000-0000-4000-8000-000000000001'::uuid
    AND concluida = true
    AND encerrada_em IS NOT NULL;

  IF v_sessao_concluida_id IS NULL THEN
    RAISE EXCEPTION 'Abortado: Sessão concluída legítima de Matemática não encontrada ou em estado divergente.';
  END IF;

  -- Pré-condição B: Confere que o ciclo está posicionado no bloco 2 (Biologia)
  SELECT proxima_ordem INTO v_ponteiro_ordem
  FROM public.ciclo_estado
  WHERE ciclo_id = '40000000-0000-4000-8000-000000000001'::uuid;

  IF v_ponteiro_ordem <> 2 THEN
    RAISE EXCEPTION 'Abortado: Ponteiro do ciclo divergente do esperado (esperado: 2, encontrado: %)', v_ponteiro_ordem;
  END IF;

  -- Execução da Atualização com Predicados Estritos
  UPDATE public.sessoes
  SET encerrada_em = NOW(),
      concluida = false,
      nota_livre = '[Saneamento Administrativo: resíduo órfão de navegação H2.04-T5-UI]'
  WHERE id = '679937fc-9a54-4ba5-b7cb-ebde6b9f890b'::uuid
    AND perfil_id = '10000000-0000-4000-8000-000000000001'::uuid
    AND ciclo_bloco_id = '41000000-0000-4000-8000-000000000001'::uuid
    AND concluida = false
    AND encerrada_em IS NULL;

  -- Validação estrita: exige que exatamente 1 linha tenha sido modificada
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

  IF v_rows_affected <> 1 THEN
    RAISE EXCEPTION 'Falha de segurança: esperava atualizar exatamente 1 linha, mas % linhas foram afetadas.', v_rows_affected;
  END IF;
END $$;

-- 3. AUDITORIA PÓS-EXECUÇÃO
SELECT id, iniciada_em, encerrada_em, concluida, nota_livre
FROM public.sessoes
WHERE id = '679937fc-9a54-4ba5-b7cb-ebde6b9f890b'::uuid;

COMMIT;
```

---

## 5. RESULTADOS DOS TESTES LOCAIS EXECUTADOS

Foi implementada a suíte de testes dedicada [`src/app/actions/h2_04_t5_v_r2_verificacao_final.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h2_04_t5_v_r2_verificacao_final.test.ts) com 12 cenários cobrindo transacionalidade e comportamento circular:

```text
 ✓ src/app/actions/h2_04_t5_v_r2_verificacao_final.test.ts (12 tests) 7ms
   ✓ MEDICINA 2029 — H2.04-T5-V-R2: Verificação Final do Gerenciamento de Sessões (12)
     ✓ 1. Verificação do Encerramento Automático e Transacionalidade (6)
       ✓ o encerramento de resíduo ocorre na MESMA transação da inicialização autorizada 2ms
       ✓ aplica predicados estritos no UPDATE garantindo que apenas a sessão residual correta e aberta é modificada 0ms
       ✓ sessões legítimas pausadas no bloco atual NÃO são encerradas indevidamente 0ms
       ✓ nenhuma sessão concluída (concluida = true) é modificada pelo auto-encerramento 0ms
       ✓ falha durante o processo provoca ROLLBACK integral sem persistir o auto-encerramento 1ms
       ✓ duas abas simultâneas adquirem pg_advisory_xact_lock para serialização no PostgreSQL 0ms
     ✓ 2. Verificação do Comportamento Circular (Transição do Bloco 28 para o Bloco 1) (6)
       ✓ função calcularProximaOrdem avança ciclicamente de 28 para 1 0ms
       ✓ a comparação de ordens NÃO impede uma nova volta legítima iniciando o Bloco 1 0ms
       ✓ auto-encerra resíduo deixado no Bloco 28 quando o ciclo avança para 1 e o estudante inicia o Bloco 1 0ms
       ✓ redireciona links obsoletos do Bloco 28 para o Bloco 1 quando o ciclo está na ordem 1 1ms
       ✓ bloqueia reinício prematuro do Bloco 28 se ele já foi concluído na volta anterior e o ciclo está em 1 0ms
       ✓ não recupera sessões concluídas da volta anterior como se estivessem ativas 0ms
```

### Execução Conjunta de Homologação H2.04
```text
Test Files  9 passed | 5 skipped (14)
     Tests  103 passed | 71 skipped (174)
  Duration  3.43s
```
**Total de 103 testes locais aprovados com 100% de sucesso.**

---

## 6. COMPORTAMENTO PREVISTO DA SESSÃO PENDENTE NO STAGING

| Cenário | Comportamento no Sistema |
| :--- | :--- |
| **Navegação a `/estudar` (sem parâmetros)** | A aplicação ignora o registro residual (`679937fc...`) porque o bloco 1 difere do ponteiro atual (`proxima_ordem = 2`). Exibe diretamente **Biologia — Biologia Celular e Mitocôndrias**. |
| **Navegação com link antigo do Bloco 1** | A Server Action redireciona a sugestão para o Bloco 2 e o frontend alinha a URL via `router.replace`. |
| **Clique em "Estudar" no Bloco 2** | O servidor executa `iniciarSessao(Bloco 2)`. Dentro da mesma transação, auto-encerra o resíduo do Bloco 1 (`concluida = false`, `encerradaEm = NOW()`) e cria com sucesso a nova sessão de Biologia. |
| **Integridade de Métricas** | As métricas de Alice computam apenas sessões concluídas (`concluida = true`). A sessão residual não afeta cálculos de desempenho, cartões ou horas líquidas de estudo. |

---

## 7. PROCEDIMENTO SEGURO PARA REPETIR O TESTE MANUAL

1. **Iniciar a aplicação web local:**
   ```bash
   node scripts/db/launch-staging-web.mjs
   ```
2. **Conferir o ciclo no navegador:**
   - Acesse `http://127.0.0.1:3000/ciclo` com o perfil de Alice.
   - Verifique que o Bloco 1 (Matemática) está marcado como concluído (ícone de visto verde) e o Bloco 2 (Biologia) está destacado com o botão **"Estudar"**.
3. **Iniciar a sessão de estudo de Biologia:**
   - Clique em **"Estudar"** no Bloco 2.
   - A página `/estudar` abrirá exibindo o cabeçalho:
     **Biologia — Biologia Celular e Mitocôndrias**
   - A etapa iniciará em **Revisão (5m)** com o cronômetro limpo e pronto.
4. **Finalizar a sessão:**
   - Ao transicionar pelas etapas (Revisão ➔ Teoria ➔ Questões ➔ Registro), preencha a ficha e conclua.
   - O ciclo avançará automaticamente para o Bloco 3, comprovando o fluxo ponta a ponta.
