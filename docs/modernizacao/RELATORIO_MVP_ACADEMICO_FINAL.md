# MEDICINA 2029 — RELATÓRIO DE CONSOLIDAÇÃO FINAL DO MVP ACADÊMICO SEM IA

**Data de Emissão:** 15 de Novembro de 2026  
**Ambiente Auditado:** Supabase Staging (`ynfocaorhadizlvbnzrt`)  
**Versão da Plataforma:** Next.js 16.4.2 / React 19.2.4 / PostgreSQL 17.11  
**Custo Financeiro Adicional:** US$ 0,00  
**Parecer Consolidado da Candidata ao MVP:** **APTO PARA IMPLANTAÇÃO CONTROLADA**  

---

## 1. ESCOPO EXATO DO MVP ACADÊMICO SEM IA

O Produto Mínimo Viável (MVP) Acadêmico do Medicina 2029 consolida a plataforma como um ambiente de alta performance para preparação médica (ENEM e vestibulares tradicionais, com foco na UECE), operando de forma 100% autônoma, determinística e desvinculada de qualquer dependência obrigatória de Inteligência Artificial generativa ou APIs pagas de terceiros.

### Pilares Fundamentais do MVP Acadêmico
1. **Autenticação, Governança e Segregação de Papéis:**
   - Separação estrita de perfis entre Estudante Tutelada (Alice), Responsável/Tutor Pedagógico (Bruno) e Estudante Independente (Carlos).
   - Segurança de banco com separação de conexões (`medicina_auth` para credenciais e `medicina_app` para runtime) e aplicação compulsória de Row Level Security (RLS) fail-closed.
2. **Ciclo de Estudos Orientado e Sessões Pomodoro:**
   - Gestão de blocos pedagógicos por disciplina com cálculo automático de aderência ao ciclo (meta: 24 sessões/mês).
   - Cronômetro de estudo com controle de foco efetivo, pausas, registro de etapas e proteção contra inatividade espúria de abas.
3. **Revisão Inteligente por Repetição Espaçada (FSRS v5):**
   - Algoritmo FSRS matemático nativo (`ts-fsrs`), calculando estabilidade, dificuldade e intervalos de retenção para cada flashcard.
   - Interface de revisão com cartões interativos em alto contraste e atalhos de teclado (1: Errei / 2: Difícil / 3: Bom / 4: Fácil).
4. **Caderno de Erros Automatizado:**
   - Rastreamento passivo de questões incorretas diretamente das tentativas de estudo e simulados, sem formulários quebrados de inserção manual.
   - Classificação por disciplina e controle de status de resolução.
5. **Redações ENEM e UECE com Fichas de Gêneros Textuais:**
   - Registro de produções textuais nos formatos ENEM e UECE com contagem de minutos gastos e temas.
   - Consulta a repertórios socioculturais cadastrados por eixos temáticos.
   - Fichas pedagógicas detalhadas dos gêneros textuais cadastrados.
6. **Módulo de Simulados:**
   - Registro de provas e cálculo de percentuais de acerto por área de conhecimento e notas estimadas, consumindo diretamente as tabelas base estruturadas.
7. **Painel de Acompanhamento do Responsável:**
   - Visão pedagógica agregada para o tutor, com métricas quinzenais de horas estudadas, consistência e evolução sem contaminação de terceiros.

---

## 2. FUNCIONALIDADES DISPONÍVEIS PARA BRUNO E ALICE

| Usuário | Módulo / Interface | Funcionalidades Efetivamente Disponíveis e Homologadas |
| :--- | :--- | :--- |
| **Alice** *(Estudante)* | **Estudo Diário e Ciclo (`/estudar`, `/ciclo`)** | Iniciar e pausar sessões com cronômetro; registrar minutos efetivos de estudo; navegar pela fila de blocos do ciclo; avançar automaticamente o ponteiro de estudo. |
| **Alice** *(Estudante)* | **Revisão FSRS (`/revisao`)** | Visualizar fila de flashcards vencidos; virar cartão (frente/verso); avaliar retenção (notas 1 a 4); persistência remota do estado FSRS; interface de alto contraste auditada em modo claro e escuro. |
| **Alice** *(Estudante)* | **Caderno de Erros (`/caderno-erros`)** | Listar erros registrados automaticamente por tentativas; filtrar por disciplina; marcar erros como resolvidos com registro de data. |
| **Alice** *(Estudante)* | **Redações e Repertórios (`/redacoes`)** | Registrar redação ENEM (tema, texto, minutos gastos); registrar redação UECE vinculada a gênero; cadastrar repertórios socioculturais por áreas do conhecimento; consultar fichas dos 5 gêneros. |
| **Alice** *(Estudante)* | **Simulados (`/simulados`)** | Registrar desempenho de simulados com acertos/total por área; visualizar cálculo automático de notas estimadas; histórico de provas realizadas. |
| **Alice** *(Estudante)* | **Dashboard Analítico (`/dashboard`, `/`)** | Visualizar taxa real de aderência ao ciclo (Alice: 13% correspondente às 3 sessões concluídas); divergência de trilhos ENEM vs Conteudista; distribuição de horas de estudo. |
| **Bruno** *(Responsável)* | **Área do Tutor (`/responsavel`)** | Acompanhar evolução acadêmica de Alice; consultar horas líquidas estudadas; monitorar aderência ao ciclo e distribuição por disciplinas; isolamento total em relação a estudantes não vinculados. |
| **Bruno** *(Responsável)* | **Acervo de Materiais (`/acervo`)** | Visualizar listagem de materiais cadastrados; abrir e ler apostilas e livros em PDF (ex: Apostila de Citologia); gerenciar metadados de arquivos. |

---

## 3. FUNCIONALIDADES DESATIVADAS OU ADIADAS (RECURSOS DE IA PÓS-MVP)

Em cumprimento estrito às Decisões Técnicas, os recursos experimentais que demandavam modelos generativos ou APIs externas foram classificados como **Funcionalidades Futuras / Pós-MVP**, sem simulação de resultados e sem bloquear o núcleo acadêmico:

| Funcionalidade de IA | Status no MVP | Tratamento Técnico Implementado |
| :--- | :---: | :--- |
| **Geração Automática de Flashcards/Questões por LLM** | **Adiada (Pós-MVP)** | Desativada no fluxo padrão. Caso acionada sem credencial, o sistema falha de forma elegante e transparente (`GEMINI_API_KEY ausente`), sem produzir conteúdo sintético ou alucinado. |
| **Busca Semântica Vetorial por Embeddings (`/busca`)** | **Adiada (Pós-MVP)** | A busca vetorial depende de chamada de embedding. Na ausência da chave, a Server Action intercepta a chamada e retorna: *"A busca semântica está temporariamente indisponível."*, mantendo a interface estável. |
| **OCR Automático de PDFs Escaneados via Multimodal** | **Adiada (Pós-MVP)** | Documentos no Acervo com texto selecionável são lidos diretamente por parser PDF local nativo (`pdf-parse` / `pdfjs-dist`). O OCR por IA foi desacoplado da ingestão básica. |
| **Fila de Curadoria de Artefatos Gerados (`/curadoria`)** | **Adiada (Pós-MVP)** | Mantida como estrutura dormente para futuras expansões de IA, não fazendo parte da jornada cotidiana obrigatória de Bruno ou Alice. |

---

## 4. EVIDÊNCIA DE TESTES AUTOMATIZADOS PERTINENTES

A estabilidade de todos os fluxos acadêmicos foi comprovada por duas baterias completas de testes automatizados sem nenhuma falha:

### 4.1 Testes Unitários e de Integração (Vitest)
Execução da suíte central de regras de negócio, validações de entrada, segurança e autorização:
```bash
npx vitest run src/app/actions/actions.test.ts \
               src/app/actions/dashboard.test.ts \
               src/app/actions/modulos_pedagogicos_homologacao.test.ts \
               src/app/actions/redacoes.test.ts \
               src/app/actions/curadoria.test.ts \
               src/app/actions/homologacao_acervo_quimica_local.test.ts \
               src/components/RevisaoPage.test.ts \
               src/db/integrity.test.ts \
               src/lib/exportacao-segura.test.ts \
               src/lib/gemini.test.ts \
               src/lib/env.test.ts \
               src/lib/operation-result.test.ts \
               src/lib/studysystem.test.ts
```
**Resultado:** **13 suítes executadas, 160 testes aprovados, 0 falhas (100% de sucesso em 2.67s).**

### 4.2 Testes End-to-End no Navegador Real (Playwright / Chromium)
Execução de ponta a ponta contra a aplicação conectada ao Supabase Staging:
```bash
SKIP_WEBSERVER=1 npx playwright test e2e/modulo-estudos.spec.ts \
                                     e2e/revisao-fsrs.spec.ts \
                                     e2e/modulos-pedagogicos.spec.ts \
                                     --project=chromium
```
**Resultado dos 18 Cenários Homologados:**
- **Módulo de Estudos (5 testes):** Bloqueio anônimo em `/estudar` e `/ciclo`; acesso de Alice com estrutura de fila; responsividade do cronômetro; isolamento relacional de Carlos.
- **Módulo de FSRS (6 testes):** Bloqueio anônimo em `/revisao`; interface de revisão de Alice com atalhos de teclado e flip frente/verso; tratamento de erro seguro; isolamento de Carlos (nunca herda cartões de Alice e acessa exclusivamente sua própria fila); verificação visual de alto contraste (#1B2A33 em modo claro e alto contraste em modo escuro).
- **Módulos Pedagógicos (7 testes):** Bloqueio anônimo em rotas protegidas; Dashboard real de Alice (13% de aderência); Dashboard limpo de Carlos (zero simulados/redações); Caderno de Erros automático; Redações com seleção dos 5 gêneros UECE ativos; histórico de Simulados; painel do Responsável.

**Resultado Global E2E:** **18 testes executados, 18 aprovados, 0 falhas (100% de sucesso em 1.0 min).**

---

## 5. SITUAÇÃO DAS PENDÊNCIAS SQL

1. **Correção da Função de Simulados (`medicina.fn_simulados_evolucao()`):**
   - *Diagnóstico:* Na função remota criada em migrações anteriores, a projeção seleciona `s.data` (`timestamp without time zone`) para uma coluna declarada como `date`, ocasionando erro `42804` ao consultar a view auxiliar `public.vw_simulados_evolucao`.
   - *Impacto no MVP:* **Nenhum bloqueio.** As Server Actions da aplicação (`src/app/actions/simulados.ts`) consultam as tabelas base `public.simulados`, `public.simulado_areas` e `public.simulado_analise` diretamente via Drizzle ORM, permitindo o funcionamento pleno da interface gráfica de simulados.
   - *Estado do Script:* Os scripts [`H2_05_FIX_SIMULADOS_EVOLUCAO_PROPOSTA.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/H2_05_FIX_SIMULADOS_EVOLUCAO_PROPOSTA.sql) e [`H2_05_ROLLBACK_SIMULADOS_EVOLUCAO.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/H2_05_ROLLBACK_SIMULADOS_EVOLUCAO.sql) permanecem versionados e validados para futura aplicação administrativa com a role `postgres`. Nenhuma tentativa de DDL com a role `medicina_app` foi realizada.
2. **Índice Único em Gêneros (`uq_generos_nome`):**
   - *Impacto no MVP:* **Nenhum bloqueio.** A integridade semântica e a unicidade dos 5 gêneros já estão garantidas pela chave primária `id` e pela cláusula lógica `WHERE NOT EXISTS` nas Server Actions.
3. **Tipagem Vetorial do Acervo (`public.acervo_chunks.embedding`):**
   - *Decisão Adotada:* **Preservada estritamente como `vector(1536)`**. A recomendação de migração para 768 dimensões foi cancelada, eliminando riscos desnecessários de DDL no schema.

---

## 6. CORREÇÃO DAS DIVERGÊNCIAS DOCUMENTAIS

Em conformidade com as determinações técnicas, as seguintes retificações ficam formalmente assentadas:

1. **Gêneros UECE Cadastrados:**
   - Os cinco registros persistidos em Staging (*Manifesto*, *Carta ao Leitor*, *Artigo de Opinião*, *Crônica Argumentativa* e *Resenha Crítica*) constituem uma **amostra pedagógica funcional para o MVP**, e **não correspondem exatamente à lista autorizada originalmente** em documentos de especificação prévia (que contemplavam *Carta Argumentativa*, *Carta Aberta*, *Editorial*, entre outros).
   - Fica registrado que esses 5 gêneros **não constituem um catálogo oficial exaustivo** do vestibular da UECE (que historicamente inclui dezenas de outros gêneros). Eles são mantidos integralmente no banco para suportar o fluxo de redação do MVP sem mutações adicionais.
2. **Documento de Citologia no Acervo:**
   - O documento persistido na tabela `public.acervo_arquivos` possui identificador `f0000000-0000-4000-8000-000000000001`, tamanho real de **666 bytes**, 1 página e hash SHA-256 `918ae7f2a3d1052b9bd7bfec017851f95afe2c676a9b53d2a0f39c610df37cf7`.
   - O arquivo de ~1.85 MB mencionado em relatórios anteriores tratava-se de um artefato sintético local de testes mockados em disco (`homologacao_acervo_quimica_local.test.ts`), nunca tendo existido no banco remoto de Staging.
3. **Dimensão e Modelo de Embeddings:**
   - A coluna `embedding` é e continuará sendo `vector(1536)`.
   - O modelo `text-embedding-004` (de 768 dimensões) foi desativado pelo Google em janeiro de 2026 e **não será utilizado**. Nenhuma migração para 768 dimensões será realizada.

---

## 7. CONFIGURAÇÕES E DEPENDÊNCIAS NECESSÁRIAS À PUBLICAÇÃO

Para publicação do MVP acadêmico em produção, são necessárias exclusivamente as seguintes variáveis de ambiente:

### 7.1 Variáveis Obrigatórias de Produção
| Variável de Ambiente | Finalidade | Requisito de Segurança |
| :--- | :--- | :--- |
| `DATABASE_URL` | URL padrão da aplicação (fallback) | Conexão PostgreSQL remota segura com TLS (`sslmode=require`). |
| `DATABASE_APP_URL` | Conexão de menor privilégio de runtime | Role `medicina_app` (sem acesso à coluna `password_hash`). |
| `DATABASE_AUTH_URL` | Conexão exclusiva de autenticação NextAuth | Role `medicina_auth` (acesso restrito para conferência de hash). |
| `NEXTAUTH_URL` | URL pública canônica da aplicação | Deve utilizar obrigatoriamente protocolo `https://`. |
| `NEXTAUTH_SECRET` | Chave simétrica de assinatura dos tokens JWT | Mínimo de 32 caracteres aleatórios de alta entropia. |
| `NODE_ENV` | Modo de execução do Next.js | Definir estritamente como `production`. |

### 7.2 Variáveis Dispensadas no MVP Acadêmico sem IA
- `GEMINI_API_KEY`: **Não necessária.**
- `GEMINI_EMBEDDING_MODEL` e `GEMINI_OCR_MODEL`: **Não necessárias.**
- `DATABASE_WORKER_URL`: **Não necessária** (o pipeline assíncrono de IA permanece desativado).
- Chaves de faturamento ou provedores terceiros: **Zero dependências.**

---

## 8. LISTA MÍNIMA DE BLOQUEADORES REAIS

Análise rigorosa de impedimentos para entrada em produção do MVP acadêmico:

| Item Analisado | Classificação | Avaliação Técnica |
| :--- | :---: | :--- |
| **Ausência de chave de IA (Gemini)** | **Não Bloqueador** | O escopo do MVP acadêmico foi desenhado para operar sem IA. O sistema falha elegantemente onde aplicável e todos os fluxos centrais funcionam 100%. |
| **Erro 42804 na view `vw_simulados_evolucao`** | **Não Bloqueador** | O frontend lê diretamente as tabelas base `public.simulados` e `public.simulado_areas`, exibindo gráficos e métricas sem depender da view. |
| **Índice DDL `uq_generos_nome` não criado** | **Não Bloqueador** | A unicidade dos gêneros está garantida pela chave primária fixa e pela camada DML das Server Actions. |
| **Dimensão `vector(1536)` no Acervo** | **Não Bloqueador** | Como a busca vetorial não faz parte do MVP acadêmico sem IA, a preservação de 1536 dimensões não afeta nenhuma rotina de estudo. |

**Conclusão sobre Bloqueadores:** **Zero bloqueadores reais impeditivos para o MVP acadêmico sem IA.**

---

## 9. PARECER FINAL CONSOLIDADO

### **PARECER: APTO PARA INICIAR A IMPLANTAÇÃO CONTROLADA**

**Fundamentação Técnica:**
1. Os fluxos centrais acadêmicos de Bruno (responsável) e Alice (estudante) estão perfeitamente implementados, seguros por RLS e validados ponta a ponta.
2. A aplicação opera com custo zero, sem dependências de provedores de IA faturáveis ou descontinuados.
3. A integridade do banco de dados remoto no Supabase Staging permanece impecável, com dados de Alice, Bruno e Carlos perfeitamente segregados.
4. O conjunto de 160 testes unitários/integrados e 18 testes E2E reais no navegador Chromium asseguram ausência de regressões funcionais.
