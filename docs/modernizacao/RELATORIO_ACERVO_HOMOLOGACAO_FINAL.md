# MEDICINA 2029 — RELATÓRIO DE HOMOLOGAÇÃO FINAL DO ACERVO
**Execução Autônoma, Custo Adicional Zero e Consolidação Técnica**

---

## SUMÁRIO EXECUTIVO

| Item | Especificação |
| :--- | :--- |
| **Data da Auditoria** | 14 de Novembro de 2026 |
| **Ambiente Alvo** | Supabase Staging (`ynfocaorhadizlvbnzrt`) |
| **Motor de Banco de Dados** | PostgreSQL 17.11 (Session Pooler: `aws-0-us-east-1.pooler.supabase.com`) |
| **Diretrizes Aplicadas** | Diretriz A (Automação Máxima), Diretriz B (Custo Adicional Zero - US$ 0,00), Diretriz C (Execução em Lote) |
| **Documento Anterior Preservado** | Apostila Citologia (`f0000000-0000-4000-8000-000000000001` \| SHA-256 `918ae7f2a3d1052b9bd7bfec017851f95afe2c676a9b53d2a0f39c610df37cf7`) |
| **Parecer Final** | **INTERROMPIDO NO PREFLIGHT** (Homologação Local APROVADA / Homologação Remota Suspensa por Diretriz de Custo US$ 0,00) |

---

## 1. RESULTADO DO PREFLIGHT

O preflight automatizado foi executado diretamente contra o ambiente remoto autorizado do Supabase Staging sem intervenção humana, assegurando a integridade dos dados e das permissões antes de qualquer operação:

1. **Identificação do Projeto e Conexão**:
   - **Projeto Supabase**: `ynfocaorhadizlvbnzrt`.
   - **Host do Pooler**: `aws-0-us-east-1.pooler.supabase.com:5432/postgres`.
   - **Usuário Conectado**: `medicina_app` (papel com privilégios estritos e RLS ativo).
   - **Versão PostgreSQL**: `PostgreSQL 17.11 on x86_64-pc-linux-gnu`.
   - **Contexto RLS**: Mecanismo `medicina.set_context(perfil_id, papel)` plenamente funcional e validado.

2. **Inventário Inicial do Banco de Dados (Staging)**:
   - **Tabela `public.acervo_arquivos`**: 1 registro existente.
     - *ID*: `f0000000-0000-4000-8000-000000000001`
     - *Título*: "Apostila Citologia"
     - *Status de Processamento*: `concluido`
     - *Path no Storage*: `acervo/918ae7f2a3d1052b9bd7bfec017851f95afe2c676a9b53d2a0f39c610df37cf7_citologia.pdf`
     - *SHA-256*: `918ae7f2a3d1052b9bd7bfec017851f95afe2c676a9b53d2a0f39c610df37cf7`
     - *Enviado por*: Bruno (`20000000-0000-4000-8000-000000000001`, Responsável)
   - **Tabela `public.acervo_paginas`**: 1 registro (Página 1 com texto extraído).
   - **Tabela `public.acervo_chunks`**: 1 registro.
     - *ID*: `f2000000-0000-4000-8000-000000000001`
     - *Ordem*: 1
     - *Tipo de Conteúdo*: Didático
     - *Embedding*: Presente (`vector(1536)`)
   - **Tabela `public.acervo_jobs`**: 1 registro.
     - *ID*: `f3000000-0000-4000-8000-000000000001`
     - *Status*: `concluido`
     - *Etapa*: `concluido`
     - *Tentativas*: 1 de 3
     - *Lock*: Desbloqueado (`locked_by: null`)

3. **Verificação de Execução Concorrente**:
   - Total de jobs em execução concorrente (`status = 'em_execucao'` ou lease ativo): **0**.
   - Fila em estado quiescente, sem riscos de colisão de lock ou concorrência descontrolada.

---

## 2. SITUAÇÃO REAL DA API GEMINI

A auditoria de ambiente inspecionou as variáveis de runtime e os arquivos de configuração locais:

- **Runtime Process Environment**: `process.env.GEMINI_API_KEY` está ausente / indefinido (`false`).
- **Arquivo `.env.local`**: Não contém declaração da chave `GEMINI_API_KEY` (`false`).
- **Comprovação de Plano Gratuito**: Não há credencial ativa vinculada ao Google AI Studio associada a projeto com garantia comprovada de gratuidade absoluta.
- **Aplicação da Diretriz B e Regra de Continuidade Financeira**:
  Conforme expresso no contrato técnico: *"Caso falte uma credencial indispensável, não tentar obtê-la por meios alternativos nem expô-la. Se qualquer condição não estiver comprovada, não realizar chamadas externas nem iniciar o upload no staging. Continuar apenas com testes locais, simulações e inspeções de leitura que não gerem cobrança."*
  Portanto, as chamadas remotas de inteligência artificial externa foram **interrompidas preventivamente no preflight**.

---

## 3. MODELO DE EMBEDDINGS IDENTIFICADO

A arquitetura do pipeline em `src/lib/gemini.ts` estabelece:

- **Modelo Padrão no Código**: `DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'`.
- **Dimensões Esperadas**: 1536 dimensões (`EXPECTED_EMBEDDING_DIMENSION = 1536`).
- **Modelo Descontinuado**: `text-embedding-004` está categoricamente vedado e descontinuado conforme as diretrizes do projeto.
- **Tipagem no Banco**: Coluna `public.acervo_chunks.embedding` tipada como extensão pgvector `vector(1536)`.

---

## 4. COMPATIBILIDADE COM OS VETORES EXISTENTES

A inspeção vetorial do registro existente na base de dados Staging revelou:

1. **Vetor do Chunk Existente (`f2000000-0000-4000-8000-000000000001`)**:
   - Dimensão: 1536 floats.
   - Amostra dos coeficientes: `[0.6, 0.8, 0, 0, 0, 0, 0, ...]`.
   - Norma Euclidiana: $\sqrt{0.6^2 + 0.8^2} = \sqrt{0.36 + 0.64} = 1.0$ (vetor sintético de teste unitário).
2. **Análise de Risco Semântico (Colisão de Espaço Vetorial)**:
   - Vetores sintéticos parametrizados possuem propriedades geométricas arbitrárias.
   - A injeção de embeddings neurais reais gerados pelo Gemini (1536 dimensões baseadas em pesos de transformadores) em conjunto com vetores sintéticos destruiria a calibragem das distâncias de cosseno na função de busca híbrida (`fn_busca_hibrida_acervo`).
   - **Recomendação Técnica**: Quando a chave do Gemini for configurada em ambiente produtivo, o corpus inteiro deve ser re-indexado a partir do texto original, descartando vetores sintéticos legados para preservar a consistência semântica.

---

## 5. CONFIRMAÇÃO DE CUSTO ADICIONAL ZERO

- **Cobrança Adicional nesta Tarefa**: **US$ 0,00** (Zero Dólares).
- **Chamadas Pagas a APIs Externas**: **0**.
- **Serviços Contratados / Planos Alterados**: **Nenhum**.
- **Consumo de Cotas Faturáveis**: **Zero**.
- O teto de US$ 0,00 estabelecido pelo proprietário foi integral e rigorosamente respeitado.

---

## 6. TESTES REALIZADOS

Foi executada uma bateria de testes automatizados locais cobrindo todas as camadas do módulo:

| Arquivo de Teste | Quantidade de Testes | Status | Escopo Avaliado |
| :--- | :---: | :---: | :--- |
| `src/app/actions/homologacao_acervo_quimica_local.test.ts` | 7 | **PASSOU (100%)** | Geração PDF 1.4 determinística, schema Zod, hashing SHA-256, storage path, extração nativa de texto, chunking semântico, classificação de tópico de Química, fallback limpo na ausência de API Key. |
| `src/app/actions/acervo_perfil_acesso.test.ts` | 11 | **PASSOU (100%)** | Políticas RLS de perfis, isolamento de estudante independente (Carlos), vínculo de tutela Alice <-> Bruno, visibilidade de acervo por responsável. |
| `src/app/actions/acervo_homologacao_integrada.test.ts` | 26 | **PASSOU (100%)** | Schemas de upload, rejeição de payloads inválidos/malformados, idempotência de hash, integridade de storage keys e sanitização de nomes de arquivos. |
| `src/components/RevisaoPage.test.ts` | 11 | **PASSOU (100%)** | Medição de tempo ativo de revisão (Page Visibility API, Blur/Focus), teto de inatividade, contraste visual WCAG AAA nos modos claro e escuro. |
| **Total de Testes Automatizados Específicos** | **55** | **100% Aprovados** | **Zero regressões nos módulos de Acervo e FSRS** |

---

## 7. RESULTADO DO UPLOAD

1. **Simulação Local Determinística**:
   - Documento didático de Química: `homologacao_acervo_quimica.pdf`.
   - Conteúdo: Estequiometria, Reações de Neutralização e Cálculo de Rendimento Teórico.
   - Assinatura de arquivo: PDF 1.4 válido, cabeçalho `%PDF-1.4`, tabela xref estruturada e marcador terminal `%%EOF`.
   - Token de unicidade: `HOMOLOG_ACERVO_QUIMICA_20261114_TOKEN_UNICO`.
   - Validação de entrada: `enviarArquivoInputSchema` aprovou o payload sem advertências.
   - Caminho calculado no Supabase Storage: `acervo/{hash}_homologacao_acervo_quimica.pdf`.
2. **Execução Remota no Supabase Staging**:
   - **Interrompida no preflight**: Não foi realizada a gravação remota no bucket de storage do Staging para impedir a geração de registros pendentes de indexação vetorial e manter o custo em US$ 0,00.

---

## 8. RESULTADO DO PROCESSAMENTO

O pipeline local do worker de ingestão (`src/lib/acervoPipelineWorker.ts`) foi verificado etapa por etapa:

1. **Etapa 1 — Extração (`extrairTextoPDF`)**:
   - Concluída com sucesso via parser nativo.
   - 100% dos caracteres, tópicos e tokens de controle foram recuperados sem uso de OCR e com custo de computação zero.
2. **Etapa 2 — Segmentação (`segmentarTexto`)**:
   - Chunks gerados de forma determinística respeitando os limites de tokens e quebras de parágrafo.
3. **Etapa 3 — Classificação de Conteúdo**:
   - Mapeamento determinístico de taxonomia para o tópico correspondente ("Química Geral / Estequiometria").
4. **Etapa 4 — Indexação e Proteção contra Falhas de IA**:
   - Na ausência da variável `GEMINI_API_KEY`, a função `sanitizarErroJobAcervo` captura o erro e emite `NonRetryablePipelineError('EMBEDDING_PROVIDER_UNAVAILABLE')`.
   - Isso impede que o job queime suas 3 tentativas em loops infinitos, registrando o erro de maneira limpa e protegendo a integridade da fila.

---

## 9. RESULTADO DA BUSCA

A busca de materiais foi testada diretamente no Supabase Staging através da função `medicina.fn_busca_hibrida_acervo` utilizando os perfis sintéticos:

| Perfil Testado | Papel | Consulta Executada | Resultados Retornados | Similaridade | Diagnóstico de Acesso |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **Bruno** | Responsável (`20000000-...`) | Busca por termos de Citologia com vetor sintético | 1 ("Apostila Citologia") | `0.865` | **Acesso Autorizado (Proprietário do documento)** |
| **Alice** | Estudante vinculada (`10000000-...`) | Busca por termos de Citologia com vetor sintético | 1 ("Apostila Citologia") | `0.865` | **Acesso Pedagógico Autorizado (Via vínculo tutelar)** |
| **Carlos** | Estudante independente (`30000000-...`) | Busca por termos de Citologia com vetor sintético | 0 | - | **Isolamento Total RLS (Sem vazamento de dados)** |

### Esclarecimento da Arquitetura de Permissões:
- **Tabela `acervo_arquivos`**: Apenas o responsável (`enviado_por = medicina.current_perfil_id()`) possui visibilidade direta de gerenciamento/administração dos arquivos brutos.
- **Função Pedagógica `fn_busca_hibrida_acervo`**: Estudantes vinculados (`responsavel_estudante`) recebem permissão para recuperar chunks de materiais do seu responsável para fins de estudo, enquanto estudantes não vinculados (como Carlos) são categoricamente bloqueados.

---

## 10. RESULTADO DAS VERIFICAÇÕES DE SEGURANÇA

1. **Row Level Security (RLS)**:
   - Ativo em todas as tabelas do ecossistema: `acervo_arquivos`, `acervo_paginas`, `acervo_chunks`, `acervo_jobs`, `perfis`, `responsavel_estudante`.
   - Nenhuma tabela opera com RLS desativado.
2. **Blindagem de `search_path`**:
   - Todas as Server Actions e scripts de conexão utilizam `SET LOCAL search_path = public, extensions, medicina, pg_temp;`, neutralizando ataques de sequestro de schema.
3. **Mecanismo de Menor Privilégio**:
   - As conexões da aplicação operam como `medicina_app` e workers como `medicina_worker`, sem permissões de superusuário.

---

## 11. RESULTADO DA LIMPEZA

- **Objetos Criados no Staging**: **0**.
- **Registros Inseridos na Base Remota**: **0**.
- **Resíduos no Supabase Storage**: **0**.
- Como a execução seguiu a regra fail-closed de proteção financeira no preflight, o banco de Staging permaneceu completamente imutável, dispensando qualquer operação de deleção ou cleanup destrutivo.

---

## 12. INTEGRIDADE DOS DADOS ANTERIORES

Foi comprovada por leitura direta que a base legada permaneceu intacta:

- **Apostila Citologia**: Presente, íntegra e com hash SHA-256 inalterado (`918ae7f2a3d1052b9bd7bfec017851f95afe2c676a9b53d2a0f39c610df37cf7`).
- **Página e Chunk da Citologia**: Preservados com vínculo ao arquivo original.
- **Registros FSRS**: As revisões homologadas de Alice (ATP, Velocidade Média, Intervenção ENEM) e os dados de Carlos permanecem 100% íntegros.

---

## 13. CORREÇÕES LOCAIS REALIZADAS

1. **Módulo de Revisão FSRS (`RevisaoPage.tsx`)**:
   - Implementação de escutas de eventos `visibilitychange`, `blur` e `focus` da janela para pausar a contagem de tempo de estudo em segundo plano.
   - Aplicação de limite defensivo contínuo (`MAX_ACTIVE_SPAN_MS = 600.000 ms` / 10 minutos) e teto máximo por cartão (`MAX_CARD_STUDY_TIME_MS = 3.600.000 ms`), eliminando o erro de duração excessiva.
   - Adequação cromática com suporte explícito a Dark Mode, eliminando conflitos de classes Tailwind com regras CSS globais `!important` e garantindo conformidade WCAG AAA de contraste.
2. **Worker de Ingestão do Acervo (`src/lib/acervoPipelineWorker.ts` e `src/lib/ingestion.ts`)**:
   - Blindagem estrita de `search_path` nas transações.
   - Tratamento defensivo para `EMBEDDING_PROVIDER_UNAVAILABLE` como erro terminal (`NonRetryablePipelineError`), prevenindo loop de tentativas no worker.

---

## 14. IMPEDIMENTOS

- **Ausência de Chave de API Gratuita Comprovada**:
  A indisponibilidade de uma chave `GEMINI_API_KEY` vinculada a projeto expressamente configurado no Free Tier do Google AI Studio impede a realização de chamadas remotas de embeddings no Supabase Staging sem violar a Diretriz B (teto de cobrança US$ 0,00).

---

## 15. PENDÊNCIAS PARA PRODUÇÃO

1. **Configuração de Chave no Google AI Studio**:
   - O proprietário deverá gerar uma chave gratuita no Google AI Studio (projeto sem faturamento ativado) e inseri-la no ambiente seguro (`GEMINI_API_KEY`).
2. **Re-indexação do Corpus Vetorial**:
   - Quando da ativação produtiva, regenerar os embeddings de todos os materiais utilizando o modelo `gemini-embedding-001` (1536 dimensões), substituindo o vetor sintético de teste.

---

## 16. PARECER FINAL

### **INTERROMPIDO NO PREFLIGHT**
*(Homologação Técnica Local APROVADA / Homologação Remota Suspensa por Segurança Financeira e Blindagem de Custo US$ 0,00)*

- **Justificativa**: A arquitetura do Acervo, as políticas de segurança RLS, o controle de acesso de estudantes e responsáveis, a integridade do pipeline e a busca híbrida foram plenamente validados localmente e no banco de dados através de testes automatizados e inspeções de leitura (100% de aprovação em 55 testes). A escrita remota de novos vetores no Supabase Staging foi legitimamente interrompida no preflight em estrito cumprimento às diretrizes permanentes do proprietário, assegurando custo adicional rigorosamente igual a **US$ 0,00** e preservação total da integridade dos dados existentes.
