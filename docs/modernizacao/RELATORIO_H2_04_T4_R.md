# MEDICINA 2029 — RELATÓRIO TÉCNICO H2.04-T4-R
## DIAGNÓSTICO DE CICLO ATIVO NÃO EXIBIDO PARA ALICE E CORREÇÃO DO CONTEXTO RLS

**Data da Auditoria:** 09 de novembro de 2026  
**Ambiente:** Supabase Staging (`ynfocaorhadizlvbnzrt`) & Código Local Medicina 2029  
**Status Final:** **APTO COM CORREÇÃO TÉCNICA LOCAL CONCLUÍDA**

---

### 1. SUMÁRIO EXECUTIVO

Durante a homologação funcional no ambiente Staging (`H2.04-T3-R3`), a estudante sintética Alice realizou login com sucesso e navegou pelas interfaces. Contudo, ao carregar a rota `/ciclo`, a aplicação exibiu a mensagem *"Nenhum ciclo ativo no servidor"*, *"Bloco 0 de 0"* e a fila de estudos vazia.

A presente auditoria técnica investigou o esquema e os dados no Supabase Staging e o código-fonte das Server Actions do Next.js. O diagnóstico comprovou:

1. **Os dados remotos no Supabase Staging estão 100% íntegros:**
   - O ciclo sintético de Alice (`id: 40000000-0000-4000-8000-000000000001`, *"Ciclo Alice 2029"*) existe, está marcado com `ativo: true`, associado ao perfil de Alice e configurado para 28 blocos.
   - Todos os 28 blocos previstos continuam persistidos na tabela `public.ciclo_blocos`, todos com disciplinas válidas e ordenados de 1 a 28.
   - O estado em `public.ciclo_estado` está persistido com `proxima_ordem: 1`.

2. **A causa raiz foi categorizada como Categoria E (Problema de autorização ou contexto RLS):**
   - As tabelas `public.ciclos`, `public.ciclo_blocos`, `public.ciclo_estado` e `public.sessoes` possuem `FORCE ROW LEVEL SECURITY`.
   - As políticas PostgreSQL exigem que `medicina.current_perfil_id()` corresponda ao perfil do estudante e que `medicina.is_estudante()` seja verdadeiro.
   - A Server Action `obterCicloAtivo()` em `src/app/actions/ciclo.ts` executava consultas diretas `db.select()` fora de transação e **sem invocar `applyRlsContext(tx, estudante.id, estudante.papel)`**.
   - Como consequência do princípio *fail-closed*, o PostgreSQL sob a role `medicina_app` retornava 0 linhas, induzindo a Server Action a retornar `null` para o front-end.

3. **Correção e validação locais concluídas com êxito:**
   - As Server Actions de leitura (`obterCicloAtivo`, `obterProgressoSemanalCiclo` e `obterTopicosPorDisciplina`) foram atualizadas para rodar compulsoriamente dentro de transação Drizzle com `applyRlsContext(tx, ...)`.
   - Uma suíte de testes de regressão direcionada (`src/app/actions/h2_04_t4_r_ciclo_rls.test.ts`) foi implementada, com 6 novos testes aprovados (totalizando 86 testes locais de autenticação, autorização e ciclo aprovados, 0 falhas).

---

### 2. AUDITORIA DOS DADOS NO SUPABASE STAGING

A inspeção foi realizada exclusivamente em modo de leitura via `DATABASE_APP_URL` (role `medicina_app`, projeto `ynfocaorhadizlvbnzrt`), sem realizar qualquer modificação de dados remotos.

#### 2.1 Consulta Direta sem Contexto RLS (Comportamento Anterior)

```sql
SELECT count(*) FROM public.ciclos;
-- Resultado: 0 linhas
```

**Constatação:** Sob a conexão técnica `medicina_app`, como o contexto da sessão não havia sido definido via `medicina.set_context()`, a política `ciclos_estudante_policy` avaliou `medicina.is_estudante()` como `false`, filtrando todas as linhas no PostgreSQL.

#### 2.2 Consulta Transacional com Contexto RLS de Alice

Ao aplicar o contexto da estudante Alice (`perfil_id: 10000000-0000-4000-8000-000000000001`, `papel: estudante`):

```sql
SELECT
  current_user,
  medicina.current_perfil_id(),
  medicina.current_papel(),
  medicina.is_estudante();
-- Resultado:
-- current_user: medicina_app
-- current_perfil_id: 10000000-0000-4000-8000-000000000001
-- current_papel: estudante
-- is_estudante: true
```

Consulta de ciclos sob o contexto:
```sql
SELECT id, nome, ano_letivo, ativo, estudante_perfil_id, blocos_previstos_semana, criado_em
FROM public.ciclos
WHERE estudante_perfil_id = '10000000-0000-4000-8000-000000000001'::uuid;
-- Resultado: 1 registro encontrado
-- id: 40000000-0000-4000-8000-000000000001
-- nome: Ciclo Alice 2029
-- ano_letivo: 2027
-- ativo: true
-- blocos_previstos_semana: 28
```

Consulta de blocos e disciplinas sob o contexto:
```sql
SELECT count(*) AS total_blocos
FROM public.ciclo_blocos cb
INNER JOIN public.disciplinas d ON cb.disciplina_id = d.id
WHERE cb.ciclo_id = '40000000-0000-4000-8000-000000000001'::uuid;
-- Resultado: exatamente 28 blocos válidos vinculados a disciplinas ativas
```

Consulta do estado do ponteiro:
```sql
SELECT ciclo_id, proxima_ordem
FROM public.ciclo_estado
WHERE ciclo_id = '40000000-0000-4000-8000-000000000001'::uuid;
-- Resultado: ciclo_id: 40000000-0000-4000-8000-000000000001 | proxima_ordem: 1
```

**Conclusão da auditoria remota:** Nenhuma perda ou corrupção de dados ocorreu no Supabase Staging. O seed original permanece integralmente preservado.

---

### 3. AUDITORIA DE CÓDIGO E CLASSIFICAÇÃO DA CAUSA RAIZ

| Hipótese | Avaliação Técnica | Conclusão |
| :--- | :--- | :--- |
| **A. Ausência real de ciclo** | Registro existe no PostgreSQL com id `40000000-0000-4000-8000-000000000001`. | **Descartada** |
| **B. Ciclo existente, mas inativo** | Campo `ativo` possui valor booleano `true`. | **Descartada** |
| **C. Ciclo ativo sem blocos elegíveis** | Tabela `ciclo_blocos` possui 28 registros ordenados de 1 a 28 vinculados ao ciclo. | **Descartada** |
| **D. Consulta com filtro incorreto** | Filtros `where(and(eq(ciclos.ativo, true), eq(ciclos.estudantePerfilId, estudante.id)))` estão corretos. | **Descartada** |
| **E. Problema de autorização / contexto RLS** | Server Action utilizava conexão direta `db.select()` sem ativar `medicina.set_context` via `applyRlsContext`, acionando o filtro restritivo de RLS. | **CONFIRMADA (CAUSA RAIZ)** |
| **F. Falha no mapeamento de dados** | Estrutura de tipos `CicloAtivoData` condiz com o retorno esperado pela interface `CicloPage`. | **Descartada** |

#### Detalhamento da Falha

No arquivo `src/app/actions/ciclo.ts`:
- As mutações (`atualizarPonteiroCiclo`, `iniciarCicloEstudos`, `resetarPlanejamento`) já utilizavam transação com `applyRlsContext(tx, estudante.id, estudante.papel)`.
- As funções de consulta (`obterCicloAtivo`, `obterProgressoSemanalCiclo` e `obterTopicosPorDisciplina`), no entanto, foram implementadas com chamadas diretas a `db.select()`.
- Em ambiente com RLS estrito (Supabase Staging sob `medicina_app`), a omissão do contexto de sessão resulta em retorno de conjunto vazio pelo PostgreSQL.

---

### 4. CORREÇÃO TÉCNICA IMPLEMENTADA

No arquivo `src/app/actions/ciclo.ts`:

1. **`obterCicloAtivo()`:**
   Envelopado em `db.transaction(async (tx) => { ... })` com chamada preliminar a `await applyRlsContext(tx, estudante.id, estudante.papel)`. Todas as consultas de `ciclos`, `cicloBlocos`, `disciplinas` e `cicloEstado` foram convertidas para operar sobre `tx`.

2. **`obterProgressoSemanalCiclo()`:**
   Envelopado em `db.transaction(async (tx) => { ... })` com `await applyRlsContext(tx, estudante.id, estudante.papel)`. A consulta a `public.sessoes` opera sobre `tx`.

3. **`obterTopicosPorDisciplina()`:**
   Envelopado em `db.transaction(async (tx) => { ... })` com `await applyRlsContext(tx, perfil.id, perfil.papel)`. A consulta a `public.topicos` opera sobre `tx`.

---

### 5. VALIDAÇÃO E TESTES DE REGRESSÃO

Foi criado o arquivo de testes unitários `src/app/actions/h2_04_t4_r_ciclo_rls.test.ts` contemplando 6 cenários:
1. `obterCicloAtivo()` executa compulsoriamente dentro de transação aplicando `applyRlsContext` com o UUID e papel de Alice;
2. `obterCicloAtivo()` retorna os 28 blocos e o ponteiro `proximaOrdem: 1`;
3. `obterCicloAtivo()` retorna `null` caso não haja ciclo ativo sob o contexto RLS;
4. `obterCicloAtivo()` rejeita a execução em modo *fail-closed* caso `applyRlsContext` lance erro;
5. `obterProgressoSemanalCiclo()` executa sob contexto transacional e filtra sessões do estudante;
6. `obterTopicosPorDisciplina()` executa sob contexto transacional com validação estrita de UUID.

**Execução das suítes de teste (Vitest):**
- `h2_04_t4_r_ciclo_rls.test.ts`: **6 passed** (100%)
- `h2_04_t3_r3_login_redirect.test.ts`: **10 passed** (100%)
- `h2_04_t3_r2_staging_web_env.test.ts`: **17 passed** (100%)
- `actions.test.ts`: **22 passed** (100%)
- `authorization.test.ts` (actions + lib): **21 passed** (100%)
- `h2_04_functional_homologation_plan.test.ts`: **10 passed | 8 skipped** (100%)
- **Total:** **86 testes aprovados, 0 falhas**.

---

### 6. RECOMENDAÇÃO OPERACIONAL E CONCLUSÃO

- **Veredito:** **SISTEMA APTO PARA NOVO TESTE DE INTERFACE WEB EM STAGING**.
- **Orientação ao Operador:**
  1. Iniciar o servidor local apontando para o Supabase Staging:
     ```bash
     npm run staging:web
     ```
  2. Abrir o navegador em `http://127.0.0.1:3000/login` e autenticar como Alice (`alice@medicina2029.staging`).
  3. Navegar para `http://127.0.0.1:3000/ciclo`.
  4. Confirmar a exibição do ciclo *"Ciclo Alice 2029"*, o primeiro bloco da fila e o contador *"Bloco 1 de 28"*.
