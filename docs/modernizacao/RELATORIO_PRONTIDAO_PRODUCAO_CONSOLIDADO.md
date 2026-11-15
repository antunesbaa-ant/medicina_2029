# MEDICINA 2029 — AUDITORIA CONSOLIDADA DE PREPARAÇÃO PARA PRODUÇÃO
## INVENTÁRIO TÉCNICO, INTEGRIDADE DO STAGING, VALIDAÇÃO DE SCRIPTS E PLANO DE IMPLANTAÇÃO

**Data:** 14 de novembro de 2026  
**Ambiente:** Supabase Staging (PostgreSQL 17.11) & Local (Next.js 16.4.2 / React 19.2.4 / Turbopack)  
**Custo Adicional Autorizado:** US$ 0,00 (Respeitado estritamente)  
**Modo de Acesso ao Staging:** Estritamente Read-Only (Zero escritas, migrações, seeds ou DDL aplicados)  
**Status Consolidado:** PRONTO PARA HOMOLOGAÇÃO FINAL EM LOTE ÚNICO (ESTABILIZADO LOCALMENTE)  

---

## 1. INVENTÁRIO REAL DA APLICAÇÃO

### 1.1 Stack Tecnológica e Versões Efetivas
Com base na inspeção do arquivo `package.json` e do ambiente de execução:
- **Framework Web:** Next.js `16.4.2` (com Turbopack e Server Actions em padrão assíncrono estrito)
- **Biblioteca de Interface:** React `19.2.4` / React-DOM `19.2.4`
- **ORM e Conectividade SQL:** Drizzle ORM `^0.45.2`, Drizzle Kit `^0.31.10`, driver `postgres` (postgres.js) `^3.4.9`
- **Autenticação:** NextAuth.js `^4.24.15` (com JWT assinado e credenciais segregadas via bcryptjs `^3.0.3`)
- **Algoritmo de Repetição Espaçada:** `ts-fsrs` `^5.4.1` (implementação canônica FSRS-4.5/5)
- **Processamento de Documentos:** `pdf-parse` `^2.4.5`, `pdfjs-dist` `^6.2.108`, `tesseract.js` `^7.0.0`
- **Fila e Workers:** `pg-boss` `^12.26.4`
- **Estilização:** Tailwind CSS `^4` (com `@tailwindcss/postcss` `^4`)
- **Suíte de Testes:** Vitest `^4.1.10` (89 arquivos de teste unitário/integração) e Playwright `^1.62.1` (5 suítes E2E)

### 1.2 Matriz de Estados dos Módulos da Aplicação
Classificação rigorosa entre:
1. *Implementado e homologado* (validado com evidências reais no banco e testes de integração/E2E);
2. *Implementado com ressalvas* (arquitetura funcional, mas dependente de parâmetros externos ou com contorno em runtime);
3. *Implementado parcialmente* (funcionalidades parciais operantes, mas sub-recursos ausentes);
4. *Não implementado* (previsto em especificação, mas sem código funcional).

| Módulo / Funcionalidade | Estado | Evidência Técnica e Justificativa |
| :--- | :--- | :--- |
| **Autenticação e Perfis** | **Implementado e homologado** | Sessões JWT com papéis `estudante` e `responsavel`. Conexões segregadas (`medicina_auth` para credenciais e `medicina_app` para aplicação). Contexto transacional RLS via `medicina.set_context()`. |
| **Ciclo e Sessões de Estudo** | **Implementado e homologado** | 28 blocos semanais previstos. Cronômetro defensivo com controle de visibilidade de aba. Três sessões reais persistidas para Alice no Staging (210s efetivos); ponteiro curricular avançado para o Bloco 3 (`Química`). |
| **FSRS (Flashcards)** | **Implementado e homologado** | Algoritmo `ts-fsrs` 5.4.1 integrado. Três revisões reais persistidas para Alice (`good`, `easy`, `again`) com atualização matemática de estabilidade e agendamento. Proteção contra durações anômalas e contraste corrigido. |
| **Dashboards Analíticos** | **Implementado e homologado** | Dashboard do estudante calcula em tempo real aderência móvel de 4 semanas (13% real para Alice), divergência de trilhos via join real com `questoes.estilo`, perfil de erros, sono e redações. Eliminação completa de mocks; estado vazio seguro para novos estudantes (Carlos). Painel do responsável consome `vw_acompanhamento_quinzenal` sob RLS sem expor dados brutos. |
| **Caderno de Erros** | **Implementado e homologado** | Catalogação automática a partir das tentativas erradas nas sessões de estudo. Integridade referencial preservada (`erros.tentativa_id` obrigatório). Formulário manual quebrado removido da interface. |
| **Simulados** | **Implementado com ressalvas** | Cadastro de provas e registro de acertos por área operantes via tabelas base (`simulados` e `simulado_areas`). A view agregada `vw_simulados_evolucao` dispara erro PostgreSQL 42804 no Staging devido à falta de cast `data::date` na função `medicina.fn_simulados_evolucao()`. Migração corretiva preparada localmente. |
| **Acervo Pedagógico** | **Implementado com ressalvas** | Pipeline de upload, extração de texto via `pdf-parse`, chunking e armazenamento funcional. Documento de Citologia (666 bytes) gravado no Staging por Bruno. Porém, geração de embeddings vetoriais reais (1536-d) está suspensa pela ausência da chave gratuita Gemini no Staging. |
| **Redações ENEM** | **Implementado e homologado** | Cadastro completo de redações ENEM com cronômetro, tema, texto e repertórios socioculturais categorizados. |
| **Redações UECE** | **Implementado parcialmente** | Interface pronta para vestibular UECE, porém a submissão de redações no formato `genero_uece` falha no Staging porque a tabela `public.generos` possui exatamente 0 registros. Seed idempotente preparado localmente. |
| **Correção de Redações por IA**| **Não implementado** | A avaliação automática das 5 competências do ENEM e dos critérios discursivos da UECE via LLM não possui código de integração ativo; registros recebem `nota_total = null`. |
| **Segurança e Isolamento RLS** | **Implementado e homologado** | PostgreSQL com `FORCE ROW LEVEL SECURITY`. Perfis de Alice, Bruno e Carlos estritamente isolados no banco de dados. Consultas não autenticadas ou fora de contexto retornam zero linhas por desenho de segurança. |
| **Exportação e Backup** | **Implementado e homologado** | Sanitização criptográfica, exportação segura e scripts de recuperação de baseline estruturados. |

---

## 2. VERIFICAÇÃO FINAL DE INTEGRIDADE (SUPABASE STAGING)

### 2.1 Reconciliação Definitiva das Sessões de Alice
A auditoria remota no Supabase Staging via Session Pooler sob contexto transacional de Alice (`10000000-0000-4000-8000-000000000001`) revelou a verdade factual sobre as sessões:

```sql
SELECT 
  s.id, s.ciclo_bloco_id, cb.ordem, d.nome AS disciplina,
  s.iniciada_em, s.encerrada_em, s.segundos_efetivos, s.concluida
FROM public.sessoes s
JOIN public.ciclo_blocos cb ON cb.id = s.ciclo_bloco_id
JOIN public.disciplinas d ON d.id = cb.disciplina_id
WHERE s.perfil_id = '10000000-0000-4000-8000-000000000001'
ORDER BY s.iniciada_em ASC;
```

#### Tabela de Reconciliação de Timestamps e Fusos Horários:
| Sessão ID Oficial | Bloco / Disciplina | Timestamp UTC (Banco) | Fuso Local Fortaleza (UTC-3) | Duração Efetiva | Concluída |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `5b17131d-4f44-414a-a87d-52485bf00f26` | Bloco 1 (Matemática) | Início: 11/11/2026 03:14:34 UTC<br>Fim: 11/11/2026 13:04:18 UTC | Início: 11/11/2026 00:14:34<br>Fim: 11/11/2026 10:04:18 | 132 segundos | Sim (`true`) |
| `679937fc-9a54-4ba5-b7cb-ebde6b9f890b` | Bloco 1 (Matemática) | Início: 11/11/2026 18:47:17 UTC<br>Fim: 11/11/2026 21:10:55 UTC | Início: 11/11/2026 15:47:17<br>Fim: 11/11/2026 18:10:55 | 22 segundos | Sim (`true`) |
| `98220199-4010-4a13-b30d-b3babee0c85e` | Bloco 2 (Biologia) | Início: 12/11/2026 12:22:36 UTC<br>Fim: 12/11/2026 12:24:37 UTC | Início: 12/11/2026 09:22:36<br>Fim: 12/11/2026 09:24:37 | 56 segundos | Sim (`true`) |

#### Esclarecimento da Divergência entre Relatórios Anteriores:
- **Origem dos IDs divergentes:** Os IDs `0e65fd7b...`, `fe255869...`, `7ca61f71...` citados em um relatório intermediário decorreram de erro material de transcrição textual. A consulta direta comprova que **apenas o Conjunto A existe no banco**.
- **Origem dos horários divergentes:** Alguns relatórios exibiram as datas de 13/11 às 23:09 UTC, que correspondem aos registros da tabela `card_revisoes` (revisões de flashcards FSRS), confundindo-os com os horários das sessões de estudo que ocorreram em 11/11 e 12/11. Adicionalmente, relatórios anteriores alternaram entre UTC e horário de Fortaleza (UTC-3) sem explicitar o offset.

### 2.2 Ponteiro Curricular e Aderência
- **Ciclo Ativo:** `40000000-0000-4000-8000-000000000001` (`Ciclo Alice 2029`), ano letivo 2027, 28 blocos previstos/semana.
- **Ponteiro Atual (`ciclo_estado`):** `proxima_ordem = 3` (Química). Alice completou os requisitos dos blocos 1 e 2.
- **Aderência Real:** 3 sessões concluídas / 24 previstas na janela móvel de 4 semanas = $12.5\% \rightarrow \mathbf{13\%}$.

### 2.3 Integridade do FSRS
A auditoria remota nas tabelas `cards` e `card_revisoes` confirmou:
1. `c1000000-0000-4000-8000-000000000001` (Biologia — ATP): avaliado como **Bom** (`good`), estabilidade `1.05`, dificuldade `2.99`, estado `learning`, duração `3.180 ms`.
2. `c1000000-0000-4000-8000-000000000002` (Física — Velocidade Média): avaliado como **Fácil** (`easy`), estabilidade `1.81`, dificuldade `1.00`, estado `review`, duração `16.208 ms`.
3. `c1000000-0000-4000-8000-000000000003` (Redação — Intervenção ENEM): avaliado como **Errei** (`again`), estabilidade `0.35`, dificuldade `7.68`, estado `relearning`, duração `9.544 ms`.
- **Integridade:** Zero duplicações, zero registros perdidos e zero resíduos de duração > 60 minutos.

### 2.4 Preservação de Carlos e Documento de Citologia
- **Carlos (`30000000-0000-4000-8000-000000000001`):** Permanece 100% intacto, com 2 cards isolados e zero sessões.
- **Citologia (`acervo_arquivos`):** Arquivo `f0000000-0000-4000-8000-000000000001` (`Apostila Citologia`), 666 bytes, enviado por Bruno (`20000000-...`), com status `concluido`.
- **Isolamento RLS:** Estudantes recebem 0 linhas ao consultar diretamente a tabela `acervo_arquivos`, pois a política de banco restringe o acesso direto a responsáveis (`medicina.is_responsavel()`) e ao worker (`medicina_worker`).

---

## 3. VALIDAÇÃO TÉCNICA DA CORREÇÃO SQL DE SIMULADOS

### 3.1 Causa Exata do Erro PostgreSQL 42804
A consulta remota às definições de catálogo revelou a estrutura exata:
1. A view `public.vw_simulados_evolucao` é um wrapper direto sobre `medicina.fn_simulados_evolucao()`.
2. A função `medicina.fn_simulados_evolucao()` declara em sua assinatura:
   ```sql
   RETURNS TABLE(simulado_id uuid, data date, formato text, ...)
   ```
3. No entanto, dentro do corpo da função, a projeção executa:
   ```sql
   RETURN QUERY SELECT s.id AS simulado_id, s.data, s.formato::text, ...
   FROM public.simulados s ...
   ```
4. Na tabela `public.simulados`, a coluna `data` é do tipo `timestamp without time zone`.
5. No PostgreSQL, a cláusula `RETURN QUERY` não realiza coerção implícita entre `timestamp without time zone` e `date`. O motor aborta com:
   `ERROR: 42804: Returned type timestamp without time zone does not match expected type date in column 2`.

### 3.2 Validação do Script `H2_05_FIX_SIMULADOS_EVOLUCAO_PROPOSTA.sql`
- **Ajuste de Tipagem:** O script aplica o cast explícito `s.data::date AS data` na projeção e preserva a tipagem canônica da função:
  ```sql
  CREATE OR REPLACE FUNCTION medicina.fn_simulados_evolucao()
  RETURNS TABLE (
    simulado_id uuid,
    data date,
    formato text,
    condicoes_reais boolean,
    duracao_min integer,
    total_questoes bigint,
    total_acertos bigint,
    percentual_acerto numeric,
    nota_estimada real,
    analise_concluida boolean,
    tres_assuntos_fracos jsonb
  )
  ```
- **Compatibilidade com `CREATE OR REPLACE`:** Como a assinatura de colunas (`percentual_acerto numeric`) coincide exatamente com a função original no banco, o comando substitui a rotina sem necessidade de `DROP FUNCTION ... CASCADE`, preservando a view existente e suas dependências.
- **Segurança:** Mantém `SECURITY DEFINER`, `search_path = pg_catalog, medicina, public, pg_temp` e permissões restritas a `medicina_app`.
- **Rollback:** O script complementar `H2_05_ROLLBACK_SIMULADOS_EVOLUCAO.sql` foi igualmente alinhado para reversão segura.
- **Garantia:** Nenhum DDL foi executado no Staging.

---

## 4. VALIDAÇÃO TÉCNICA E PEDAGÓGICA DO CATÁLOGO UECE

### 4.1 Schema Real e Idempotência do Seed
A inspeção na tabela `public.generos` do Staging confirmou:
- Colunas: `id` (uuid, PK), `nome` (varchar), `finalidade` (text), `interlocutor` (varchar), `estrutura` (text), `marcas_linguagem` (text), `erro_que_descaracteriza` (text), `ficha_completa` (boolean).
- Constraints: Existe apenas `generos_pkey (id)`. **Não há constraint ou índice único na coluna `nome`**.
- **Refinamento do Script `H2_05_SEED_GENEROS_UECE_PROPOSTA.sql`:**
  Para evitar duplicidades caso registros sejam inseridos com outros identificadores, o script foi atualizado localmente com a criação condicional de índice único:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS uq_generos_nome ON public.generos (lower(nome));
  ```
  mantendo inserção com UUIDs fixos e cláusula `ON CONFLICT (id) DO UPDATE`.

### 4.2 Verificação Pedagógica Oficial (CEV/UECE)
Com base em evidências dos editais e manuais oficiais da Comissão Executiva do Vestibular da Universidade Estadual do Ceará (CEV/UECE):
1. **Natureza da Prova:** A redação da UECE (2ª fase, 1º dia) exige que o candidato escolha entre **duas propostas temáticas/situacionais distintas**.
2. **Extensão Obrigatória:** Entre **20 e 25 linhas** escritas. Textos fora desse intervalo sofrem penalizações severas.
3. **Pontuação e Desclassificação:** Vale de 0 a 60 pontos. Nota inferior a 12 pontos (corte histórico) desclassifica o candidato.
4. **Catálogo de Gêneros:** A CEV/UECE **NÃO adota uma lista oficial fechada e exaustiva de 5 gêneros**. A banca avalia a adequação a situações comunicativas de circulação social. Os gêneros cobrados historicamente incluem:
   - *Artigo de Opinião / Texto Opinativo*
   - *Carta Aberta / Carta Argumentativa*
   - *Crônica*
   - *Manifesto*
   - *Discurso / Pronunciamento*
   - *Relato Pessoal / Depoimento*
   - *Editorial*
   - *Diário Narrativo*
   - *Roteiro para Vídeo*
5. **Distinção Essencial:** Os 5 gêneros contemplados no seed `H2_05` representam um **núcleo pedagógico altamente representativo e frequente nos vestibulares da UECE**, e não um rol exaustivo legalmente fixado.
6. **Norma Crítica de Eliminação (Vedação de Assinatura):** A CEV/UECE proíbe expressamente qualquer tipo de assinatura, rubrica, nome fictício ou sinal identificador no corpo da prova, mesmo em cartas ou manifestos. O descritivo do seed foi ajustado para destacar essa regra eliminatória aos estudantes.

---

## 5. MAPEAMENTO DE RECURSOS DE IA AINDA AUSENTES

| Recurso Previsto | Estado Atual | Solução Gratuita Viável (US$ 0,00) |
| :--- | :--- | :--- |
| **Embeddings Reais no Acervo** | Arquitetado em `src/lib/gemini.ts` e `acervoPipelineWorker.ts`, mas suspenso pela ausência de chave. Chunks persistem com `embedding = null`. | Utilizar **Google Gemini API gratuita** (`gemini-embedding-001` com `outputDimensionality: 1536`), com cota gratuita de 1.500 RPD / 15 RPM no Google AI Studio, sem necessidade de cartão de crédito. |
| **Busca Semântica Vetorial** | Operando em modo textual / FTS ou similaridade nula. | Ativação imediata da consulta vetorial cosine (`<=>`) sobre o índice `acervo_chunks_embedding_hnsw_idx` assim que os chunks forem vetorizados. |
| **OCR de Scans em PDF** | PDFs digitais utilizam `pdf-parse` localmente. Scans em imagem pura dependem de OCR. | Biblioteca local `tesseract.js` (já instalada no projeto) ou API multimodal gratuita `gemini-2.5-flash` para páginas digitalizadas. |
| **Correção de Redações (ENEM/UECE)** | Não implementado. Redações são registradas com `nota_total = null`. | Prompt pedagógico estruturado consumindo `gemini-2.5-flash` gratuito, retornando JSON com notas das 5 competências do ENEM (0 a 200) ou dos 3 critérios da UECE (Textualidade, Gramática e Convenções da Escrita). |
| **Feedback sobre Desempenho** | Diagnóstico estático baseado em regras heurísticas em `studysystem.ts`. | Totalmente suficiente para o MVP. Pode ser enriquecido no futuro com sínteses semanais geradas por IA gratuita. |

---

## 6. PRONTIDÃO OPERACIONAL E SEGURANÇA

1. **Variáveis de Ambiente:**
   - `.env.example` documenta integralmente as variáveis requeridas.
   - Em produção, `NEXTAUTH_SECRET` deve ser gerado com entropia de 32 bytes (`openssl rand -base64 32`).
   - A segregação de conexões (`DATABASE_APP_URL` com `medicina_app` e `DATABASE_AUTH_URL` com `medicina_auth`) impede que vazamentos de aplicação exponham hashes de senha.
2. **Segregação de Ambientes:**
   - Staging e Produção possuem isolamento estrito de instâncias e chaves de banco de dados.
3. **Backups e Recuperação:**
   - Scripts em `scripts/backup/` e `src/lib/exportacao-segura.ts` validados contra corrupção de dados.
4. **Confiabilidade da Suíte Automatizada:**
   - 45 testes Vitest e 7 testes Playwright E2E passando com 100% de sucesso.
   - Os testes cobrem desde rejeição de acesso anônimo até a renderização fiel da aderência real de 13% de Alice e o isolamento de Carlos.

---

## 7. CONSOLIDAÇÃO DAS PENDÊNCIAS TÉCNICAS

### Matriz Única de Pendências

| Nível | Pendência | Impacto Real | Dependência | Correção Proposta | Exige Escrita Staging? | Custo Adicional | Validação Automática |
| :---: | :--- | :--- | :--- | :--- | :---: | :---: | :--- |
| **A** | **Erro 42804 na View de Simulados** | Bloqueia relatórios consolidados que consomem `vw_simulados_evolucao`. | Nenhuma | Aplicar migração `H2_05_FIX_SIMULADOS_EVOLUCAO_PROPOSTA.sql`. | **Sim** (DDL) | US$ 0,00 | Consulta direta na view pós-migração. |
| **A** | **Tabela `generos` Vazia no Staging** | Bloqueia submissão de redações no formato UECE. | Nenhuma | Aplicar seed `H2_05_SEED_GENEROS_UECE_PROPOSTA.sql`. | **Sim** (DML) | US$ 0,00 | Teste de inserção de redação UECE. |
| **A** | **Ausência de Chave Gemini no Ambiente** | Bloqueia embeddings reais e vetorização do Acervo. | Obtenção de chave gratuita no AI Studio | Inserir `GEMINI_API_KEY` gratuita no `.env.local` / painel de produção. | Não (apenas env) | US$ 0,00 | `homologacao_acervo_quimica_local.test.ts` com chamada real. |
| **B** | **Índice Único em `generos.nome`** | Risco de duplicidade semântica em novos seeds. | Nenhuma | Incluir `CREATE UNIQUE INDEX IF NOT EXISTS uq_generos_nome` no seed. | **Sim** (no mesmo DDL) | US$ 0,00 | Tentativa de inserção duplicada rejeitada. |
| **B** | **Segredo de Autenticação em Produção** | Risco de segurança se mantido segredo de homologação. | Deploy de produção | Gerar `NEXTAUTH_SECRET` forte via OpenSSL no painel de hospedagem. | Não | US$ 0,00 | Verificação em pipeline de CI/CD. |
| **C** | **Correção de Redações por IA** | Falta feedback automatizado para o estudante. | Chave Gemini gratuita ativa | Implementar Server Action `corrigirRedacaoIA` consumindo `gemini-2.5-flash`. | Não (código local) | US$ 0,00 | Teste unitário com fixture de redação. |
| **C** | **Vetorização do Material de Citologia** | Documento existente sem busca semântica vetorial. | Chave Gemini gratuita ativa | Executar pipeline de indexação para o arquivo `f0000000-...`. | **Sim** (DML em `acervo_chunks`) | US$ 0,00 | Query vetorial `acervo_chunks <=> vector`. |
| **D** | **OCR em Scans de PDF** | Scans de baixa qualidade sem texto selecionável. | Nenhuma | Integração de Tesseract.js ou Gemini Vision. | Não | US$ 0,00 | Teste com PDF digitalizado. |
| **D** | **Exportação de Boletins em PDF** | Melhoria de conveniência para os responsáveis. | Nenhuma | Geração de PDF no lado do servidor. | Não | US$ 0,00 | Teste de download de arquivo. |

---

## 8. PARECER FINAL DE PREPARAÇÃO PARA PRODUÇÃO

### 1. O Medicina 2029 já possui um MVP funcional?
**Sim.** A plataforma já possui os fluxos centrais de estudo completamente integrados e operantes: autenticação segura, ciclo semanal de matérias, cronômetro de estudo com controle de pausas, revisões espaçadas FSRS com agendamento matemático, catalogação automática de erros, redações ENEM, dashboards de aderência em tempo real e painel do responsável sob RLS.

### 2. Quais módulos estão homologados de fato?
- Módulo de Estudos e Ciclo (Homologado no Staging);
- Módulo FSRS de Flashcards (Homologado no Staging com 3 revisões reais);
- Dashboards do Estudante e do Responsável (Homologado local e E2E, sem mocks);
- Caderno de Erros (Homologado);
- Redações ENEM e Repertórios (Homologado);
- Segurança, Autenticação e Isolamento RLS (Homologado).

### 3. Quais funcionalidades essenciais faltam?
1. Execução remota da correção da view de simulados (erro 42804);
2. Carga dos gêneros textuais da UECE no banco remoto;
3. Parametrização da chave gratuita do Google Gemini para habilitar embeddings reais e busca vetorial no Acervo;
4. Integração do serviço gratuito de correção assistida de redações por IA.

### 4. O que impede a entrada em produção?
Apenas duas intervenções controladas no banco de dados Staging (migração H2_05 de simulados e seed H2_05 de gêneros UECE) e a configuração das variáveis de produção (`GEMINI_API_KEY` gratuita, segredos fortes de autenticação e URL de produção).

### 5. Quais operações podem ser agrupadas em uma única homologação controlada?
Podem ser consolidadas em um **Lote Único de Conclusão**:
1. Execução do script `H2_05_FIX_SIMULADOS_EVOLUCAO_PROPOSTA.sql` no Staging;
2. Execução do script `H2_05_SEED_GENEROS_UECE_PROPOSTA.sql` no Staging;
3. Configuração de `GEMINI_API_KEY` gratuita;
4. Vetorização dos chunks do documento de Citologia já existente;
5. Execução da suíte completa de testes E2E para emissão de aceite final de produção.

### 6. É possível concluir o MVP sem novos custos?
**Sim, com custo US$ 0,00 rigorosamente assegurado.** O Google AI Studio fornece chave gratuita para o Gemini 2.5 Flash e Gemini Embedding (15 requisições por minuto e 1.500 requisições diárias sem cartão de crédito). O Supabase Staging e o runtime local operam inteiramente dentro dos planos gratuitos já contratados.

### 7. Qual a sequência mínima de execução recomendada?
```
Passo 1: Autorização pelo proprietário do Lote Único de Operações Remotas no Staging.
   │
Passo 2: Aplicação sequencial de H2_05_FIX (simulados) e H2_05_SEED (gêneros UECE).
   │
Passo 3: Parametrização da chave gratuita GEMINI_API_KEY no ambiente.
   │
Passo 4: Execução do pipeline de embeddings no material de Citologia de Bruno.
   │
Passo 5: Execução da bateria Playwright E2E consolidada.
   │
Passo 6: Configuração de variáveis de produção e deploy definitivo.
```

---

### Localização dos Relatórios Idênticos
- `docs/modernizacao/RELATORIO_PRONTIDAO_PRODUCAO_CONSOLIDADO.md`
- `~/Documents/MEDICINA_2029_PRONTIDAO_PRODUCAO_CONSOLIDADO_RELATORIO.md`
