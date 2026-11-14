# MEDICINA 2029 — AUDITORIA FINAL DE HOMOLOGAÇÃO DO FSRS
## CERTIDÃO TÉCNICA DE AUDITORIA PÓS-TESTE NO SUPABASE STAGING

**Data da Auditoria:** 13 de Novembro de 2026  
**Ambiente Auditado:** Supabase Staging (`ynfocaorhadizlvbnzrt`) — Session Pooler porta 5432  
**Identidade Técnica Conectada:** `medicina_app` (`aws-0-us-east-1.pooler.supabase.com:5432/postgres`)  
**Validação Criptográfica TLS:** Certificado CA emitido por Supabase (`~/Downloads/prod-ca-2021.crt`), com `rejectUnauthorized: true`  
**Modo de Auditoria:** EXCLUSIVAMENTE LEITURA (`SET default_transaction_read_only = on; SET TRANSACTION READ ONLY;`)  
**Status da Auditoria:** **APROVADO COM RESSALVAS**  

---

## 1. RESUMO EXECUTIVO E PARECER TÉCNICO

O operador realizou a homologação funcional assistida do módulo de Repetição Espaçada FSRS na interface web (`/revisao`), autenticado com o perfil sintético da estudante **Alice**. 

Durante o ciclo operacional:
1. A interface apresentou inicialmente uma falha de validação indicando duração de revisão superior a 3.600.000 ms (60 minutos).
2. Após atualização da página (reload) pelo operador, o teste transcorreu sem intercorrências, culminando na tela de confirmação *"Revisões Concluídas!"*.
3. Foi realizada **uma única auditoria técnica de leitura** no Supabase Staging, com conexões criptografadas TLS estritas e sob transação exclusivamente de leitura (`READ ONLY`), para certificar a integridade do banco de dados e a precisão do motor FSRS.

### Parecer Final Consolidado: **APROVADO COM RESSALVAS**

- **Homologação Funcional e FSRS Remoto:** **APROVADO (100% de Conformidade)**. Todas as 3 avaliações foram persistidas atomicamente em `public.card_revisoes`, com agendamentos, estabilidades, dificuldades e intervalos FSRS matematicamente perfeitos.
- **Isolamento Multi-inquilino (RLS):** **APROVADO (100% de Conformidade)**. O perfil independente de Carlos e o responsável Bruno permaneceram plenamente isolados e intactos.
- **Integridade Pós-Erro:** **APROVADO (Zero Resíduos)**. O erro de duração inicial foi contido pela barreira de validação, não deixando qualquer resíduo, travamento de transação ou linha corrompida.
- **Ressalvas de Frontend (UI/UX):** Duas melhorias pontuais foram identificadas na interface local (necessidade de clamp na medição de tempo de tela inativa e correção de contraste do texto frente/verso em tema escuro), para as quais este relatório prescreve a correção mínima recomendada.

---

## 2. EVIDÊNCIAS DA AUDITORIA NO SUPABASE STAGING

A auditoria passiva direta no PostgreSQL Staging gerou os seguintes resultados auditados:

### 2.1 Diagnóstico de Sessão e Isolamento Fail-Closed

| Parâmetro Auditado | Valor Obtido no Banco | Critério de Aceitação | Conformidade |
| :--- | :---: | :---: | :---: |
| **Banco de Dados Conectado** | `postgres` | `postgres` | **APROVADO** |
| **Usuário Técnico** | `medicina_app` | `medicina_app` | **APROVADO** |
| **Session User** | `medicina_app` | `medicina_app` | **APROVADO** |
| **Modo Read-Only de Transação** | `on` | `on` | **APROVADO** |
| **Consulta em `cards` sem Contexto RLS** | **0 linhas** | 0 linhas (Fail-Closed) | **APROVADO** |
| **Consulta em `card_revisoes` sem Contexto RLS** | **0 linhas** | 0 linhas (Fail-Closed) | **APROVADO** |

---

### 2.2 Verificação das 3 Avaliações de Alice em `public.card_revisoes`

Sob contexto RLS ativo de Alice (`medicina.set_context('10000000-0000-4000-8000-000000000001', 'estudante')`), foram localizadas exatamente **3 avaliações** gravadas na tabela `public.card_revisoes`:

| Campo / Atributo | Card #1: Biologia (ATP) | Card #2: Física (Velocidade) | Card #3: Redação (ENEM) |
| :--- | :---: | :---: | :---: |
| **ID da Revisão** | `0f74dd2b-00da-4c2b-a589-f7b59de15a2f` | `b386827e-28bc-4ae8-a67e-579e9777aca7` | `0dd7c874-f466-4d44-b8f0-9e1da25804bb` |
| **Card ID Relacionado** | `c1000000-0000-4000-8000-000000000001` | `c1000000-0000-4000-8000-000000000002` | `c1000000-0000-4000-8000-000000000003` |
| **Data/Hora de Gravação** | `2026-11-13 23:09:27.315 UTC` | `2026-11-13 23:09:47.592 UTC` | `2026-11-13 23:10:01.177 UTC` |
| **Nota Registrada (`rating`)** | **`good` (Bom / 3)** | **`easy` (Fácil / 4)** | **`again` (Errei / 1)** |
| **Nota Esperada** | `good` (Bom) | `easy` (Fácil) | `again` (Errei) |
| **Estado Anterior** | `new` | `learning` | `review` |
| **Estabilidade Anterior** | `1.0` | `1.0` | `1.0` |
| **Duração Registrada (`duracao_ms`)** | `3.180 ms` (~3,18 s) | `16.208 ms` (~16,21 s) | `9.544 ms` (~9,54 s) |
| **Conformidade da Nota** | **100% EXATA** | **100% EXATA** | **100% EXATA** |

---

### 2.3 Verificação dos Estados e Agendamentos FSRS em `public.cards`

A inspeção detalhada dos registros na tabela `public.cards` confirmou a aplicação rigorosa do algoritmo FSRS:

#### Card #1: Biologia Celular — Mitocôndria e ATP
- **Identificador:** `c1000000-0000-4000-8000-000000000001`
- **Tópico / Disciplina:** Biologia Celular e Mitocôndrias / Biologia
- **Frente / Verso:** *"Mitocôndria produz ATP via?"* / *"Respiração Celular."*
- **Evolução de Estado:** de `new` para **`learning`**
- **Repetições (`reps`):** incrementado de `1` para **`2`**
- **Lapsos (`lapses`):** mantido em **`0`**
- **Estabilidade FSRS (`stability`):** calculada em **`1.05072037`**
- **Dificuldade FSRS (`difficulty`):** calculada em **`2.99222837`**
- **Dias Agendados (`scheduled_days`):** **`0`** (passo intra-dia de aprendizagem)
- **Data da Revisão (`last_review`):** `2026-11-13 23:09:27.315 UTC`
- **Novo Vencimento (`due`):** `2026-11-13 23:19:27.315 UTC` (exatamente **+10 minutos**, respeitando o intervalo de memorização inicial)
- **Avaliação:** **CONFORME**

#### Card #2: Física — Cinemática e Velocidade Média
- **Identificador:** `c1000000-0000-4000-8000-000000000002`
- **Tópico / Disciplina:** Cinemática Escalar e Vetorial / Física
- **Frente / Verso:** *"Fórmula da velocidade média no MRU?"* / *"v = delta_s / delta_t."*
- **Evolução de Estado:** de `learning` promovido para **`review`**
- **Repetições (`reps`):** incrementado de `1` para **`2`**
- **Lapsos (`lapses`):** mantido em **`0`**
- **Estabilidade FSRS (`stability`):** expandida para **`1.80755662`**
- **Dificuldade FSRS (`difficulty`):** recalculada para **`1.0`** (dificuldade mínima decorrente da classificação Fácil)
- **Dias Agendados (`scheduled_days`):** **`2 dias`**
- **Data da Revisão (`last_review`):** `2026-11-13 23:09:47.592 UTC`
- **Novo Vencimento (`due`):** `2026-11-15 23:09:47.592 UTC` (exatamente **+2 dias**, espaçando o conteúdo consolidado)
- **Avaliação:** **CONFORME**

#### Card #3: Redação — Proposta de Intervenção ENEM
- **Identificador:** `c1000000-0000-4000-8000-000000000003`
- **Tópico / Disciplina:** Estrutura Dissertativa-Argumentativa / Redação
- **Frente / Verso:** *"Elementos da intervenção no ENEM?"* / *"Agente, Ação, Meio/Modo, Efeito e Detalhamento."*
- **Evolução de Estado:** de `review` para **`relearning`** (regressão por esquecimento)
- **Repetições (`reps`):** incrementado de `1` para **`2`**
- **Lapsos (`lapses`):** incrementado de `0` para **`1`** (registro auditável de erro)
- **Estabilidade FSRS (`stability`):** reduzida drasticamente para **`0.35504029`** (penalidade padrão por lapso)
- **Dificuldade FSRS (`difficulty`):** elevada para **`7.68437596`** (penalidade de aumento de esforço cognitivo)
- **Dias Agendados (`scheduled_days`):** **`0`** (reaprendizado intra-dia imediato)
- **Data da Revisão (`last_review`):** `2026-11-13 23:10:01.177 UTC`
- **Novo Vencimento (`due`):** `2026-11-13 23:20:01.177 UTC` (exatamente **+10 minutos**, priorizando a recuperação do conteúdo)
- **Avaliação:** **CONFORME**

---

### 2.4 Análise de Duplicações, Perdas e Atomicidade Transacional

- **Avaliações Duplicadas:** **ZERO**. Não houve retentativas salvas em duplicidade (`count = 1` para cada um dos 3 cards).
- **Avaliações Perdidas:** **ZERO**. Todas as 3 ações do operador resultaram em linhas correspondentes em `card_revisoes`.
- **Consistência Parcial:** **ZERO**. Os campos `cards.last_review` e `card_revisoes.revisado_em` coincidem com precisão de microssegundos em cada registro, confirmando atomicidade transacional via `db.transaction(...)`.

---

### 2.5 Isolamento Multi-inquilino de Carlos e Bruno

1. **Estudante Independente Carlos (`30000000-0000-4000-8000-000000000001`):**
   - Sob o contexto RLS de Carlos, foram encontrados **exatamente 2 cards** (`c2000000-0000-4000-8000-000000000001` de Matemática e `c2000000-0000-4000-8000-000000000002` de Química).
   - Ambos os cards permaneceram **100% inalterados**:
     * `last_review`: `null`
     * `reps`: `1`, `lapses`: `0`, `due`: `2026-11-01`
   - Total de revisões de Carlos em `card_revisoes`: **0 linhas**.
   - Ciclo de estudos de Carlos (`Ciclo Carlos Independente 2029`) e seus **28 blocos semanais**: **100% intactos**.
2. **Responsável Bruno (`20000000-0000-4000-8000-000000000001`):**
   - Bruno possui visualização do catálogo curricular sob a política `cards_responsavel_admin_policy`, mas possui **acesso direto estritamente bloqueado** a revisões individuais dos alunos (`card_revisoes`: 0 linhas), preservando o Princípio de Menor Privilégio e a segregação pedagógica.

---

### 2.6 Impacto do Erro de Duração no Banco de Dados

- **Registros com Duração Inválida no Banco:** **ZERO**. As durações salvas foram de 3.180 ms, 16.208 ms e 9.544 ms, todas estritamente dentro da faixa `1 <= duracao_ms <= 3.600.000`.
- **Transações Bloqueadas ou Travadas:** **ZERO**.
- **Mecanismo Protetor:** O erro exibido inicialmente na interface ocorreu antes da chamada ao banco, sendo rejeitado pelo Valibot em `registrarRevisaoCardInputSchema` na Server Action. O PostgreSQL permaneceu 100% protegido contra dados espúrios.

---

## 3. INSPEÇÃO LOCAL: CAUSAS PROVÁVEIS E DIAGNÓSTICO DE UI

### 3.1 Causa do Erro de Duração Superior a 3.600.000 ms (60 minutos)

- **Localização no Código:** [`src/components/RevisaoPage.tsx`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/components/RevisaoPage.tsx#L21-L55)
- **Mecanismo da Falha:**
  1. A referência de medição de tempo `cardShownTimestamp.current` é inicializada apenas no momento em que `carregarCards()` é executado:
     ```tsx
     cardShownTimestamp.current = Date.now();
     ```
  2. Caso o operador abra a tela de revisão e mantenha a aba do navegador aberta em segundo plano por mais de 60 minutos antes de responder ao primeiro cartão (ou se a aba foi restaurada de uma sessão inativa anterior), o cálculo de submissão resulta em:
     ```tsx
     const duracaoMs = Math.max(1, Date.now() - cardShownTimestamp.current);
     ```
     resultando em `duracaoMs > 3.600.000`.
  3. No arquivo [`src/lib/validation.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/validation.ts#L808-L813), a Server Action valida com Valibot:
     ```ts
     duracaoMs: v.number({
       label: 'Duração da revisão (ms)',
       integer: true,
       min: 1,
       max: 3_600_000,
     })
     ```
     e rejeita a requisição com o código `VALIDATION_ERROR`.
  4. Na interface, ao receber o erro de validação, a função `handleAnswer` atribui `setErroPersistencia(...)` e **não reinicia** o ponteiro `cardShownTimestamp.current`. Assim, qualquer clique repetido continuaria falhando indefinidamente.
  5. Ao atualizar a página (F5), `carregarCards()` executou novamente, resetando `cardShownTimestamp.current = Date.now()`, permitindo que as revisões transcorressem normalmente em poucos segundos.

---

### 3.2 Causa do Contraste Insuficiente no Flashcard (Frente/Verso)

- **Localização no Código:** [`src/components/RevisaoPage.tsx`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/components/RevisaoPage.tsx#L246-L274) e [`src/app/globals.css`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/globals.css#L53-L56)
- **Mecanismo da Falha:**
  1. **Conflito Severo com Modo Escuro (Dark Mode):**
     O container do flashcard utiliza a classe Tailwind `bg-white` (linha 246). No arquivo `globals.css` (linha 53), a regra de tema escuro força:
     ```css
     .dark .bg-white {
       background-color: #24353F !important;
       color: #F5F7F8 !important;
     }
     ```
     No entanto, o parágrafo de texto da pergunta/resposta (linha 263) possui uma classe utilitária rígida com cor fixa de tema claro:
     ```tsx
     <p className="... text-[#1B2A33]">
     ```
     Como a cor `#1B2A33` (azul-petróleo muito escuro) foi fixada inline, ela entra em conflito direto com o fundo `#24353F` (cinza-escuro azulado) em modo escuro. O contraste calculado é de apenas **1.15:1**, tornando a leitura impraticável.
  2. **Contraste de Instruções Secundárias (Modo Claro e Escuro):**
     Os textos de apoio *"Tópico: ..."* e *"Clique ou pressione Espaço para Revelar a Resposta"* utilizam a classe `text-gray-400` (#9CA3AF) sobre fundo branco (`#FFFFFF`) e creme (`#FBF8F3`). A taxa de contraste resultante é de **~2.85:1**, ficando abaixo do piso de acessibilidade WCAG 2.1 AA (mínimo de 4.5:1 para texto normal).

---

## 4. CORREÇÕES MÍNIMAS RECOMENDADAS (SEM ALTERAÇÕES REMOTAS)

Em estrita consonância com a diretriz de **não realizar novas escritas remotas**, as correções abaixo devem ser aplicadas exclusivamente no código local da interface:

### 4.1 Correção Defensiva da Medição de Duração em `RevisaoPage.tsx`

Limitar defensivamente `duracaoMs` ao teto de 3.600.000 ms e reiniciar o cronômetro do cartão caso ocorra erro ou quando a aba recuperar visibilidade:

```tsx
// src/components/RevisaoPage.tsx (handleAnswer)
const tempoDecorrido = Date.now() - cardShownTimestamp.current;
// Garante duracaoMs entre 1ms e 3.600.000ms mesmo se o usuário pausar o estudo
const duracaoMs = Math.min(3_600_000, Math.max(1, tempoDecorrido));

try {
  const resultado = await registrarRevisaoCard(activeCard.id, rating, duracaoMs);
  if (!resultado.sucesso) {
    setErroPersistencia(resultado.mensagem);
    // Reinicia o timestamp para permitir nova tentativa imediata sem F5
    cardShownTimestamp.current = Date.now();
    return;
  }
...
```

### 4.2 Correção do Contraste e Suporte a Dark Mode em `RevisaoPage.tsx`

Substituir as classes estáticas por classes responsivas ao tema do sistema:

```tsx
// 1. Container do Card (Linha 246):
className={`w-full min-h-[280px] md:min-h-[320px] bg-white dark:bg-[#1E2E38] rounded-2xl border border-gray-200/80 dark:border-gray-700 shadow-md p-8 flex flex-col justify-between cursor-pointer transition-all duration-300 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[#17607A] ${
  showVerso ? 'bg-gradient-to-b from-white to-[#FBF8F3] dark:from-[#1E2E38] dark:to-[#17242C] border-[#0E3D4D]/25 ring-2 ring-[#0E3D4D]/5' : ''
}`}

// 2. Metadados e Dica de Flip (Linhas 251 e 270):
// Trocar text-gray-400 por text-gray-600 dark:text-gray-300 (Contraste > 4.5:1)

// 3. Texto da Pergunta e Resposta (Linha 263):
// Adicionar suporte a dark mode:
<p className="font-['Lora'] text-base md:text-lg text-center leading-relaxed font-lora-read text-[#1B2A33] dark:text-[#F5F7F8]">
  {showVerso ? activeCard.verso : activeCard.frente}
</p>
```

---

## 5. TABELA DE VERIFICAÇÃO DOS ITENS SOLICITADOS

| Item | Descrição da Verificação | Resultado da Auditoria | Status |
| :---: | :--- | :--- | :---: |
| **1** | Quantidade de avaliações gravadas em `card_revisoes` | Exatamente **3 avaliações** persistidas. | **CONFIRMADO** |
| **2** | Biologia — ATP recebeu a nota Bom (3 / `good`) | Confirmado (`rating: 'good'`, `state: 'learning'`). | **CONFIRMADO** |
| **3** | Física — Velocidade Média recebeu Fácil (4 / `easy`) | Confirmado (`rating: 'easy'`, `state: 'review'`). | **CONFIRMADO** |
| **4** | Redação — Intervenção ENEM recebeu Errei (1 / `again`) | Confirmado (`rating: 'again'`, `state: 'relearning'`). | **CONFIRMADO** |
| **5** | Estados e agendamentos FSRS atualizados corretamente | Cálculos matemáticos FSRS 100% corretos e intervalos precisos. | **CONFIRMADO** |
| **6** | Avaliações duplicadas, perdidas ou parcialmente persistidas | Zero duplicatas, zero perdas e integridade atômica confirmada. | **CONFIRMADO** |
| **7** | Cartões e registros de Carlos permaneceram intactos | 2 cards, 0 revisões, ciclo e 28 blocos rigorosamente intactos. | **CONFIRMADO** |
| **8** | Efeito colateral do erro de duração no banco | Zero resíduos; erro contido no schema antes da mutação remota. | **CONFIRMADO** |
| **9** | Inspeção local da causa da duração > 3.600.000 ms | Diagnosticada (aba inativa + ausência de clamp defensivo). | **CONFIRMADO** |
| **10** | Inspeção local do contraste insuficiente frente/verso | Diagnosticada (conflito Dark Mode `.dark .bg-white` vs `text-[#1B2A33]`). | **CONFIRMADO** |

---

## 6. CONCLUSÃO

O módulo FSRS de Repetição Espaçada está **homologado com êxito** no ambiente Supabase Staging. A persistência remota é atômica, o isolamento multi-inquilino RLS opera de forma fail-closed absoluta e a biblioteca matemática FSRS entrega agendamentos coerentes com os parâmetros pedagógicos de preparação médica. As ressalvas encontradas referem-se a melhorias pontuais na experiência de usuário na interface frontend, já documentadas com suas correções mínimas.
