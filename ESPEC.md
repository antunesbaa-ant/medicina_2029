# PROMPT DE CONSTRUÇÃO — SISTEMA DE GERENCIAMENTO DE ESTUDOS
## Versão 2.0 — com motor de ingestão e geração de conteúdo

> **Como usar este arquivo**
>
> 1. Crie uma pasta vazia para o projeto e abra o terminal da IDE nela.
> 2. Coloque o PDF `Plano-Medicina-Fortaleza-2027-2030.pdf` dentro da pasta.
> 3. Salve este arquivo como `ESPEC.md` na raiz e escreva ao agente: *"Leia ESPEC.md integralmente e o PDF do planejamento, depois execute a Seção 14 — Primeira Ação."*
> 4. **Peça uma fase por vez.** A Seção 11 — Fases de Entrega define as fases e os critérios de aceite.

---

# CONTEXTO

Você vai construir um sistema web privado de gerenciamento de estudos para uma estudante que iniciará o 1º ano do ensino médio em março de 2027 e prestará ENEM e vestibulares de Medicina em Fortaleza/CE ao final de 2029.

O sistema é a implementação operacional de um documento de planejamento pedagógico já existente — o arquivo `Plano-Medicina-Fortaleza-2027-2030.pdf`, anexo a este projeto. **Leia o PDF inteiro antes de escrever qualquer código.** Ele não é material de apoio: é a especificação funcional do domínio. Toda regra de negócio deste sistema deriva dele.

Se houver conflito entre este documento e o PDF, o PDF prevalece em matéria pedagógica; este documento prevalece em matéria técnica.

**Horizonte de uso:** 34 meses de operação contínua, de março de 2027 a dezembro de 2029, com uso diário. O sistema precisa ser mantível por uma pessoa só e sobreviver a três anos sem reescrita.

**O que distingue este sistema de um app de estudos genérico:** ele possui um motor de ingestão que transforma material didático enviado pelo responsável — livros, apostilas, listas, slides, anotações — no conteúdo teórico, nas questões, nos flashcards e nos simulados que a estudante consome, tudo dentro do método definido no plano. Esse motor é o coração do sistema e está especificado na Seção 6 — O Motor de Ingestão e Geração.

---

# 1. PRINCÍPIOS DE PRODUTO — INEGOCIÁVEIS

Estes princípios vêm do documento de planejamento e têm precedência sobre qualquer decisão de implementação. Quando houver dúvida de design, resolva por eles.

### 1.1 O sistema nunca culpa

O plano estabelece que, se a aderência cair abaixo de 70%, **o plano está errado — não a estudante**. Incorpore isso literalmente:

- Aderência baixa dispara sugestão de **reduzir a carga prevista**, nunca cobrança para estudar mais.
- Proibido: sequências de dias ("streaks") que se quebram, notificações de culpa, contadores de dias perdidos, linguagem avaliativa da pessoa.
- Um dia sem estudo não gera dívida, alerta vermelho ou pendência acumulada. O ciclo simplesmente não avança.

### 1.2 O painel do responsável não é vigilância

O documento afirma explicitamente que monitorar horas de estudo diariamente é uma das práticas parentais que mais prejudicam o desempenho. Portanto:

- O responsável **não** vê: sessões individuais, horários de estudo, o que ela estudou hoje, log de atividade em tempo real.
- O responsável **vê**: tendências trimestrais agregadas, evolução de simulados, indicadores de bem-estar, a fila de curadoria de conteúdo e o formulário de revisão trimestral.
- Granularidade mínima do painel: **quinzenal**. Não existe visão diária.
- Isso é regra de arquitetura, não de UI: implemente na camada de dados (RLS e views agregadas), não escondendo botões.

**Observação importante:** a área de curadoria de conteúdo (Seção 6 — O Motor de Ingestão e Geração) é do responsável e é de uso intenso e diário. Ela é sobre *material*, não sobre *comportamento da estudante* — e por isso não fere este princípio. Mantenha as duas áreas visualmente e arquiteturalmente separadas.

### 1.3 O plano pertence à estudante

Ela precisa poder editar o ciclo, reordenar blocos, ajustar a carga semanal e pausar módulos sem pedir autorização. Não construa nada que exija aprovação do responsável para o estudo acontecer.

### 1.4 Registrar o erro é mais importante que acertar

O caderno de erros é a ferramenta de maior valor do plano. Registrar um erro deve ser a ação mais rápida da interface — menos cliques que qualquer outra operação.

### 1.5 Dois trilhos, sempre

Toda questão, tentativa, erro, flashcard e simulado carrega obrigatoriamente a classificação de estilo: `enem` (contextualizado, interpretativo) ou `conteudista` (técnico, direto — padrão UECE). **A divergência de desempenho entre os dois trilhos é o indicador mais diagnóstico do sistema.**

Isto vale também para a geração: ao produzir material a partir de uma fonte, o motor deve gerar as duas variantes.

### 1.6 Sustentabilidade é dado de primeira classe

Sono, exercício e bem-estar são indicadores de topo do dashboard, com o mesmo peso visual das notas. Alerta quando a média de sono cai abaixo de 7h30.

### 1.7 Nenhum conteúdo gerado chega à estudante sem aprovação humana

**Este é o princípio central do motor de ingestão.** Todo artefato produzido automaticamente — resumo, pergunta, flashcard, questão, resolução — nasce no estado `rascunho` e só se torna visível para a estudante após aprovação explícita do responsável.

A razão é concreta: um erro conceitual em material de estudo não é um bug que se corrige depois. Ele é memorizado por repetição espaçada, reforçado por três anos e reaparece na prova. O custo de revisar é baixo; o custo de não revisar é alto e silencioso.

Não existe modo "confiar e publicar automaticamente". Não implemente um.

### 1.8 Hierarquia de procedência das questões

O plano é explícito: *"questões de bancos comerciais treinam conteúdo; as provas reais treinam o exame."* O sistema deve respeitar esta ordem de prioridade, e exibi-la:

| Nível | Origem | Uso |
|---|---|---|
| **1 — Ouro** | Provas oficiais anteriores (ENEM, UECE, Unifor, Unichristus) | Simulados e treino de exame. Insubstituíveis |
| **2 — Prata** | Questões **extraídas** de material enviado (listas de apostilas, exercícios de livro) | Consolidação de conteúdo, prática de volume |
| **3 — Bronze** | Questões **geradas** por IA a partir do material | Reforço de tópico, preenchimento de lacunas |

**Regras derivadas:**
- Simulados no formato oficial devem usar **no mínimo 80% de questões de nível 1**. Se não houver questões suficientes, o sistema avisa e não completa com material gerado silenciosamente.
- A estudante sempre vê a procedência da questão que está resolvendo.
- Nas métricas de desempenho, acerto em questão de nível 3 não é ponderado igual a nível 1 — sinalize a composição da amostra.

---

# 2. USUÁRIOS E ACESSO

Exatamente **duas contas**, criadas manualmente. Sem cadastro público, sem convites, sem recuperação por link aberto.

| Papel | Quem | Acesso |
|---|---|---|
| `estudante` | A filha | Acesso total aos módulos de estudo e aos próprios dados. Vê apenas conteúdo aprovado |
| `responsavel` | O pai | Curadoria de conteúdo (total) + visões agregadas de desempenho (somente leitura, quinzenal ou maior) |

**Requisitos:**
- Autenticação por e-mail e senha, com allowlist de dois endereços validada no servidor. Qualquer outro e-mail é rejeitado antes da criação de sessão.
- Row Level Security ativo em **todas** as tabelas. Nenhuma tabela pública.
- O papel `responsavel` acessa apenas views agregadas de desempenho, nunca `sessoes` bruta.
- O papel `estudante` nunca lê registros com `status != 'aprovado'`.
- Sessão longa (30 dias) — a estudante usará no celular diariamente.

---

# 3. STACK

Use exatamente esta stack, salvo impedimento técnico real — nesse caso, pare e explique antes de trocar.

| Camada | Escolha |
|---|---|
| Framework | Next.js (App Router) + TypeScript em modo estrito |
| UI | Tailwind CSS + shadcn/ui |
| Banco | Supabase (PostgreSQL) com RLS + extensão **pgvector** |
| Auth | Supabase Auth |
| Storage | Supabase Storage, buckets privados |
| ORM | Drizzle ORM com migrations versionadas |
| Fila de jobs | **pg-boss** (fila em Postgres — evita mais um serviço para manter) |
| Extração de PDF | `unpdf` ou `pdf-parse` para texto nativo; `pdfjs-dist` para posição e imagens |
| OCR | `tesseract.js` com idioma `por`; fallback para modelo de visão quando a confiança for baixa |
| Geração | **Anthropic API** (Claude), com processamento em lote quando possível |
| Embeddings | `text-embedding` compatível com pgvector, dimensão fixa e documentada |
| Gráficos | Recharts |
| Repetição espaçada | `ts-fsrs` (algoritmo FSRS) |
| Editor | TipTap |
| Matemática | KaTeX |
| Testes | Vitest (unitário) + Playwright (E2E) |
| Deploy | Vercel |
| PWA | Instalável, com leitura offline de conteúdo aprovado e flashcards |

**Restrições:**
- Sem `any` no TypeScript. Sem `@ts-ignore` sem comentário justificando.
- Toda migration versionada e reversível. Nunca altere schema direto no painel do Supabase.
- Timezone `America/Fortaleza`. Datas em UTC no banco, convertidas na borda.
- Sem telemetria de terceiros. Sistema privado, nenhum dado sai para analytics externo.
- Jobs longos **nunca** rodam em request HTTP. Sempre na fila, com estado persistido e retomável.

---

# 4. MODELO DE DADOS — NÚCLEO

Nomes em português para o domínio, inglês para infraestrutura.

### 4.1 Base curricular

```
perfis(id, auth_user_id, nome, papel, criado_em)

disciplinas(id, nome, area, cor_hex, ordem)
  area ∈ {linguagens, humanas, natureza, matematica, redacao}

topicos(id, disciplina_id, nome, serie_prevista, incidencia_enem, incidencia_uece,
        pre_requisito_topico_id, ordem, cobertura_material)
  serie_prevista ∈ {1,2,3}
  incidencia_* ∈ 1..5
  cobertura_material ∈ {sem_fonte, parcial, coberto}   -- calculado pelo motor
```

O campo `cobertura_material` é derivado: indica se existe material enviado suficiente para aquele tópico. Alimenta o painel de lacunas do responsável (6.8 — Painel de lacunas).

### 4.2 Ciclo de estudos — modelar como FILA, não como calendário

Este é o ponto onde a maioria das implementações erra. O documento é explícito: **não é uma grade semanal**. É uma fila que avança quando a estudante estuda, e que não gera atraso quando ela não estuda.

```
ciclos(id, nome, ano_letivo, ativo, blocos_previstos_semana, criado_em)

ciclo_blocos(id, ciclo_id, ordem, disciplina_id, tipo, estilo_alvo, duracao_min)
  tipo ∈ {conteudo, questoes, redacao, caderno_erros, revisao_srs, lingua_estrangeira}
  estilo_alvo ∈ {enem, conteudista, misto}

ciclo_estado(ciclo_id, proxima_ordem)   -- ponteiro único da fila
```

**Regras obrigatórias:**
- Concluir uma sessão avança `proxima_ordem` em 1; ao passar do último, volta a 1.
- Não existe "bloco atrasado" nem "bloco perdido". Dia sem estudo, nada acontece.
- A estudante pode reordenar, adicionar, remover ou pular blocos livremente.
- `blocos_previstos_semana` é o denominador da aderência e é editável por ela.

### 4.3 Sessões e cronômetro

```
sessoes(id, perfil_id, ciclo_bloco_id, topico_id, iniciada_em, encerrada_em,
        segundos_efetivos, segundos_pausa, etapa_atingida, concluida, nota_livre)
  etapa_atingida ∈ {revisao, conteudo, questoes, registro}
```

O bloco de 50 minutos tem estrutura fixa definida no plano, e o cronômetro deve guiá-la explicitamente:

| Minutos | Etapa | O que o sistema faz |
|---|---|---|
| 00–05 | Revisão do bloco anterior da matéria | Exibe os cards e erros do último bloco daquela disciplina |
| 05–33 | Conteúdo novo | Abre o material teórico aprovado do tópico; permite criar perguntas de recuperação ativa |
| 33–48 | Questões | Serve no mínimo 8 questões do tópico, respeitando a hierarquia de procedência (1.8 — Hierarquia de procedência das questões) |
| 48–50 | **Registro** | Tela de registro de erros e criação de cards. **Não é pulável** |
| +10 | Pausa | Cronômetro de pausa, com aviso de que não é hora de celular |

**A etapa de registro não pode ser pulada.** O documento afirma que ela é exatamente o que separa o método de "estudar bastante". Encerrar antes grava `etapa_atingida` menor e isso aparece como dado no dashboard — sem culpabilização.

### 4.4 Conteúdo teórico e recuperação ativa

```
materiais(id, topico_id, titulo, corpo, tipo, tempo_leitura_min,
          status, origem, fonte_chunk_ids, gerado_em, aprovado_por, aprovado_em, versao)
  tipo ∈ {resumo, formulario, mapa_mental, esquema}
  status ∈ {rascunho, em_revisao, aprovado, rejeitado, desatualizado}
  origem ∈ {manual, gerado}

perguntas_ativas(id, topico_id, pergunta, resposta, estilo, status, fonte_chunk_ids)
```

O plano proíbe resumo em prosa: todo material gera perguntas. A partir de 2028, cada tópico precisa ter **pelo menos uma pergunta de cada estilo**. O sistema sinaliza tópicos que não atendam.

### 4.5 Repetição espaçada (FSRS)

```
cards(id, perfil_id, topico_id, frente, verso, origem, status, suspenso,
      fonte_chunk_ids,
      due, stability, difficulty, elapsed_days, scheduled_days,
      reps, lapses, state, last_review)
  origem ∈ {manual, material, erro, questao, gerado}
  state ∈ {new, learning, review, relearning}

card_revisoes(id, card_id, revisado_em, rating, state_anterior, stability_anterior, duracao_ms)
  rating ∈ {again, hard, good, easy}
```

Use `ts-fsrs` com parâmetros padrão. Persista o estado completo no card. Registre **todas** as revisões — o histórico permite reotimizar parâmetros depois de meses de uso real.

### 4.6 Banco de questões

```
questoes(id, procedencia, fonte, ano, fase, numero, disciplina_id, estilo,
         dificuldade, enunciado, alternativas, gabarito, resolucao,
         imagem_url, status, arquivo_origem_id, fonte_chunk_ids,
         confianca_geracao, ativa)
  procedencia ∈ {oficial, extraida, gerada}        -- ver hierarquia 1.8
  fonte ∈ {ENEM, UECE, UNIFOR, UNICHRISTUS, UERJ, UFPR, APOSTILA, LIVRO, AUTORAL}
  alternativas: jsonb [{letra, texto}]
  status ∈ {rascunho, em_revisao, aprovado, rejeitado}

questao_topicos(questao_id, topico_id)   -- N:N

tentativas(id, perfil_id, questao_id, sessao_id, simulado_id,
           alternativa_marcada, correta, segundos, confianca, criado_em)
  confianca ∈ {certeza, duvida, chute}
```

**O campo `confianca` da tentativa é obrigatório** e a interface deve capturá-lo em um toque, junto da resposta. Razão: o plano determina que questões *acertadas por chute* entrem no caderno de erros. Sem esse campo, isso é indetectável.

### 4.7 Caderno de erros — a ferramenta central

```
erros(id, perfil_id, questao_id, tentativa_id, descricao_livre,
      disciplina_id, topico_id, estilo, tipo_erro, conceito_correto,
      criado_em, resolvido_em, vezes_revisado)
  tipo_erro ∈ {conteudo, interpretacao, distracao, calculo, tempo}
```

**Regras:**
- Rascunho de erro criado automaticamente quando a tentativa for incorreta **ou** correta com `confianca = 'chute'`.
- `conceito_correto` é escrito por ela, com as próprias palavras. O sistema **não** preenche automaticamente com a resolução — copiar a resolução anula o valor pedagógico do campo. Exiba a resolução ao lado, mas exija texto próprio.
- Card FSRS gerado a partir do erro em um clique.
- **Revisão de sexta-feira:** sessão automática de 15 minutos com os erros da semana. Ritual fixo do plano.
- **Modo véspera de prova:** visão que mostra *apenas* o caderno de erros — único material da semana anterior a qualquer prova.

### 4.8 Redação

```
generos(id, nome, finalidade, interlocutor, estrutura, marcas_linguagem,
        erro_que_descaracteriza, ficha_completa)

redacoes(id, perfil_id, formato, genero_id, tema, escrita_em, texto, arquivo_url,
         minutos_gastos, nota_total, competencias, corrigida_por,
         reescrita_de_id, observacoes)
  formato ∈ {enem, genero_uece}

repertorios(id, referencia, resumo_2_linhas, temas_aplicaveis, categoria, criado_em)
```

Pré-carregue os **nove gêneros** do plano: crônica, artigo de opinião, carta argumentativa, editorial, relato, resenha crítica, divulgação científica, manifesto, carta aberta. Fichas começam vazias — ela as preenche ao longo de 2028.

`reescrita_de_id` implementa a regra de ouro: toda redação abaixo da meta é reescrita. O dashboard mostra a razão entre escritas e reescritas.

Meta de repertório: 40 referências até o fim de 2028, com sub-banco temático de saúde pública.

### 4.9 Simulados

```
simulados(id, perfil_id, formato, data, condicoes_reais, duracao_min, local,
          composicao_procedencia)
  formato ∈ {enem, uece_1fase, uece_2fase, privada}
  composicao_procedencia: jsonb {oficial: n, extraida: n, gerada: n}

simulado_questoes(simulado_id, questao_id, ordem, area)

simulado_areas(id, simulado_id, area, acertos, total, nota_estimada)

simulado_analise(id, simulado_id, concluida, tres_assuntos_fracos,
                 erros_estrategia, minutos_analise, realizada_em)
```

**Regra crítica:** o plano determina protocolo obrigatório de análise de 2 horas no dia seguinte, e afirma que simulado sem análise vale 20% do que poderia valer.

- Simulado sem `analise.concluida = true` aparece como **pendente** e **não entra** no cálculo das médias.
- O sistema **não permite** registrar novo simulado enquanto houver análise pendente. Trava deliberada.
- `composicao_procedencia` é exibida junto do resultado — um simulado com 60% de questões geradas não é comparável a um com 100% oficiais.

### 4.10 Bem-estar, revisão trimestral e leitura

```
checkins(id, perfil_id, data, horas_sono, exercicio_min, humor, energia, nota_livre)
  humor, energia ∈ 1..5

revisoes_trimestrais(id, trimestre, ano, aderencia_pct, cards_atrasados,
                     media_enem, acerto_uece_pct, divergencia_trilhos,
                     tipo_erro_predominante, redacoes_escritas, redacoes_reescritas,
                     media_sono, conversa, decisoes, fechada_em)

livros(id, perfil_id, titulo, autor, ano_plano, iniciado_em, concluido_em, notas)
```

Campos numéricos da revisão trimestral preenchidos automaticamente; `conversa` e `decisoes` manualmente. É o único ponto em que a conta do responsável escreve fora da curadoria.

---

# 5. MODELO DE DADOS — MOTOR DE INGESTÃO

```
acervo_arquivos(id, disciplina_id, titulo, tipo_material, autor_fonte, serie_alvo,
                arquivo_path, mime, tamanho_bytes, paginas,
                enviado_por, enviado_em, status_processamento, erro_processamento,
                hash_conteudo)
  tipo_material ∈ {livro, apostila, slide, lista_exercicios, anotacao_aula,
                   prova_oficial, resumo_proprio, outro}
  status_processamento ∈ {aguardando, extraindo, segmentando, classificando,
                          indexando, concluido, falhou}

acervo_paginas(id, arquivo_id, numero, texto_extraido, metodo_extracao,
               confianca_ocr, imagem_path)
  metodo_extracao ∈ {nativo, ocr, visao}

acervo_chunks(id, arquivo_id, pagina_inicial, pagina_final, ordem,
              texto, tipo_conteudo, topico_id, confianca_classificacao,
              embedding vector(N), tokens)
  tipo_conteudo ∈ {exposicao_teorica, exemplo_resolvido, questao,
                   exercicio, definicao, formula, figura_legenda}

acervo_figuras(id, arquivo_id, pagina, bbox, imagem_path, legenda, chunk_id)

geracoes(id, tipo_artefato, topico_id, arquivo_ids, chunk_ids,
         modelo, prompt_versao, custo_tokens, iniciada_em, concluida_em,
         status, itens_gerados, itens_aprovados, itens_rejeitados)
  tipo_artefato ∈ {resumo, formulario, perguntas_ativas, cards, questoes, resolucoes}

curadoria_fila(id, artefato_tipo, artefato_id, topico_id, prioridade,
               criado_em, revisado_em, decisao, motivo_rejeicao, editado)
  decisao ∈ {pendente, aprovado, rejeitado, editado_e_aprovado}
```

**Rastreabilidade obrigatória:** todo artefato publicado mantém `fonte_chunk_ids`. A estudante deve poder clicar em qualquer resumo, card ou questão e ver *de qual página de qual arquivo aquilo veio*. Isso serve para conferência e para aprofundamento.

---

# 6. O MOTOR DE INGESTÃO E GERAÇÃO

Este é o subsistema mais complexo do projeto. Construa-o como um pipeline de etapas independentes e retomáveis, orquestradas por fila. Se uma etapa falhar, as anteriores não se perdem.

```
Upload → Extração → Segmentação → Classificação → Indexação → Geração → Curadoria → Publicação
```

### 6.1 Upload

Interface do responsável, organizada por disciplina.

- Formatos: PDF (nativo e escaneado), DOCX, PPTX, imagens (JPG/PNG — fotos de páginas de livro), TXT, MD.
- Upload múltiplo, com arrastar e soltar. Barra de progresso por arquivo.
- Metadados obrigatórios no envio: disciplina, tipo de material, série alvo. Opcionais: título, autor/fonte.
- Deduplicação por `hash_conteudo` — avisar se o arquivo já existe.
- Limite prático: arquivos de até 200 MB e 800 páginas. Acima disso, orientar a dividir.
- Buckets privados. Nenhum arquivo acessível por URL pública; sempre por URL assinada de curta duração.

### 6.2 Extração

- **PDF nativo:** extrair texto preservando ordem de leitura e número de página. Detectar colunas.
- **PDF escaneado ou imagem:** OCR com `tesseract.js` em português. Registrar `confianca_ocr`.
- **Confiança baixa (< 70%):** reprocessar a página com modelo de visão da Anthropic API, que lida melhor com fórmulas, tabelas e manuscrito.
- **Fórmulas:** converter para LaTeX quando reconhecíveis. Marcar quando não for possível.
- **Figuras e diagramas:** extrair como imagem separada com bbox e página. Muitas questões dependem de figura — sem isso, a questão gerada fica inutilizável.
- **DOCX/PPTX:** extração estruturada preservando hierarquia de títulos.

Toda página extraída fica visível ao responsável, lado a lado com o original, para conferência por amostragem.

### 6.3 Segmentação

- Chunks semânticos de 500 a 1.000 tokens, com sobreposição de ~15%.
- Respeitar fronteiras naturais: seções, títulos, fim de exercício.
- Cada chunk guarda página inicial e final.
- Classificar `tipo_conteudo` — distinguir exposição teórica de exercício é essencial, porque exercícios viram questões **extraídas** (nível 2), não geradas (nível 3).

### 6.4 Classificação por tópico

- Classificar cada chunk contra a taxonomia de `topicos` existente, usando embeddings + modelo.
- Registrar `confianca_classificacao`.
- Confiança abaixo de 0,7 → vai para fila de classificação manual, não é descartado.
- Um chunk pode mapear para mais de um tópico.
- **Nunca criar tópicos novos automaticamente.** A taxonomia é curricular e definida pelo plano; se nada encaixar, sinalize para revisão humana.

### 6.5 Indexação

- Embeddings em `pgvector`, com índice HNSW.
- Busca híbrida: semântica (vetor) + textual (`tsvector` em português).
- A busca alimenta tanto a geração quanto uma funcionalidade de consulta direta para a estudante ("onde no meu material fala sobre equilíbrio químico?").

### 6.6 Geração

Jobs disparados por tópico, sempre a partir dos chunks daquele tópico. **A geração é ancorada na fonte: o modelo trabalha apenas com o material recuperado, nunca com conhecimento próprio livre.**

Artefatos a gerar:

| Artefato | Especificação |
|---|---|
| **Resumo teórico** | Objetivo e enxuto, como o plano exige. Não é enciclopédia. Máximo de 800 palavras por tópico. Estruturado em conceitos, não em prosa corrida |
| **Formulário** | Fórmulas, definições e constantes essenciais do tópico, em formato de consulta rápida |
| **Perguntas de recuperação ativa** | Mínimo de 6 por tópico, obrigatoriamente incluindo ao menos 2 de cada estilo (conceitual/ENEM e técnica/UECE) |
| **Flashcards** | 10 a 20 por tópico, frente curta e verso único. Um conceito por card — nunca cards com listas longas |
| **Questões extraídas** | Exercícios já presentes no material, transcritos fielmente com gabarito quando disponível. `procedencia = 'extraida'` |
| **Questões geradas** | Novas questões nos **dois estilos**, com 5 alternativas, gabarito e resolução passo a passo. `procedencia = 'gerada'` |
| **Resoluções** | Para questões oficiais sem resolução no acervo |

**Regras de geração inegociáveis:**

1. Toda saída cita os `chunk_ids` que a fundamentam. Sem citação, o artefato é rejeitado automaticamente antes de entrar na fila.
2. Se o material recuperado for insuficiente para o artefato, o job **retorna vazio com justificativa** — não inventa. Melhor um tópico sem conteúdo, sinalizado como lacuna, do que um tópico com conteúdo inventado.
3. Questões geradas devem ter distratores plausíveis, derivados de erros conceituais reais — não alternativas absurdas.
4. Detecção de duplicidade por similaridade de embedding antes de inserir na fila (limiar 0,92).
5. `confianca_geracao` registrada por item; itens de baixa confiança entram na fila com prioridade alta de revisão.
6. Versione os prompts de geração (`prompt_versao`). Quando um prompt melhorar, é preciso saber qual conteúdo foi gerado com a versão antiga.
7. Processamento em lote quando a API permitir, para reduzir custo. Registre `custo_tokens` por job — o responsável precisa enxergar o gasto acumulado.

### 6.7 Curadoria — o portão humano

Interface dedicada do responsável, otimizada para volume. Ela será usada por centenas de itens, então precisa ser rápida.

- **Fila priorizada:** por confiança (menor primeiro), por tópico próximo no cronograma, por tipo de artefato.
- **Tela dividida:** o artefato gerado à esquerda, os trechos-fonte à direita, com a página do PDF original visível.
- **Três ações, com atalhos de teclado:** aprovar (A), editar e aprovar (E), rejeitar (R). Rejeição pede motivo em um clique, entre motivos pré-definidos.
- **Aprovação em lote** permitida apenas para itens de alta confiança do mesmo tópico, e sempre com revisão visual prévia obrigatória — nunca um botão "aprovar tudo" cego.
- **Métricas de curadoria:** taxa de aprovação por tipo de artefato e por versão de prompt. Se um tipo tem taxa de rejeição alta, o prompt precisa mudar — não a paciência do revisor.

### 6.8 Painel de lacunas

Visão que cruza a taxonomia curricular com o acervo:

- Tópicos sem nenhum material enviado → `sem_fonte`
- Tópicos com material mas sem conteúdo aprovado → pendente de curadoria
- Tópicos de **alta incidência** (4–5) sem cobertura → destaque máximo. É o que o responsável deve providenciar primeiro.
- Cruzamento com o cronograma: tópicos que a estudante vai estudar nas próximas 4 semanas e ainda não têm conteúdo aprovado.

Esta tela é o painel de trabalho do responsável. Ela responde à pergunta: *"o que eu preciso enviar ou aprovar esta semana?"*

### 6.9 Reprocessamento

- Substituir um arquivo por versão corrigida marca todo o conteúdo derivado como `desatualizado` e o devolve à fila de curadoria.
- Reprocessar um arquivo não apaga o conteúdo já aprovado — cria nova versão para comparação.

### 6.10 Uso do acervo

O material enviado é de uso estritamente privado das duas contas. Não implemente compartilhamento, links públicos, exportação para terceiros ou qualquer forma de redistribuição. Buckets privados, URLs assinadas de curta duração, sem indexação.

---

# 7. MÉTRICAS DERIVADAS

Implemente como views materializadas ou funções SQL, com testes unitários próprios.

| Métrica | Cálculo | Alerta |
|---|---|---|
| **Aderência** | sessões concluídas ÷ blocos previstos, janela móvel de 4 semanas | < 70% por 8 semanas → sugerir reduzir carga |
| **Divergência de trilhos** | % acerto `enem` − % acerto `conteudista`, últimas 300 tentativas | Diferença > 15 pontos |
| **Perfil de erro** | distribuição por `tipo_erro`, últimos 90 dias | Um tipo > 40% |
| **Fila de revisão** | cards com `due < hoje` | > 300 cards |
| **Cobertura por área** | % de tópicos com sessão concluída, por área | Área < 10% do tempo total |
| **Média de sono** | média de `horas_sono`, últimos 14 dias | < 7h30 |
| **Redações** | escritas e reescritas vs. meta do ano | Abaixo da meta |
| **Evolução de simulados** | série por área, só simulados com análise concluída | Queda em 2 consecutivos |
| **Incidência vs. esforço** | tempo por tópico × incidência declarada | Alta incidência sem estudo |
| **Cobertura do acervo** | tópicos com conteúdo aprovado ÷ total de tópicos da série | Tópicos de alta incidência sem fonte |
| **Saúde da curadoria** | itens pendentes na fila; idade do item mais antigo | Fila > 200 itens ou item > 30 dias |

**Interpretação da divergência** — exibir junto do número, porque são diagnósticos com tratamentos opostos:

- ENEM muito acima de conteudista → falta profundidade técnica → aumentar questões conteudistas e revisão de fórmulas e definições.
- Conteudista muito acima de ENEM → falta repertório interpretativo → aumentar leitura e questões contextualizadas.

---

# 8. MÓDULOS E TELAS

### Área da estudante

| Módulo | Descrição |
|---|---|
| **M1 · O Plano** | O conteúdo do PDF navegável em `/plano`, com busca. Cada parte linka para o módulo correspondente |
| **M2 · Hoje** | Tela inicial: próximo bloco da fila, botão de iniciar, fila de revisão do dia, check-in de bem-estar. Nada mais. Utilizável em 5 segundos, no celular |
| **M3 · Cronômetro** | Bloco de 50 min guiado por etapas (4.3 — Sessões e cronômetro), com pausa. Funciona com tela bloqueada e sobrevive a recarregamento — estado persistido no servidor |
| **M4 · Ciclo** | Editor da fila com arrastar e soltar, ponteiro visível, ciclos distintos por ano letivo |
| **M5 · Conteúdo** | Materiais aprovados por tópico, em markdown com KaTeX. Modo de recuperação ativa. Link para o trecho-fonte original |
| **M6 · Questões** | Resolução por tópico ou avulsa, com filtros. Procedência sempre visível. Captura de confiança em um toque |
| **M7 · Caderno de Erros** | Listagem filtrável, gráfico por tipo, ritual de sexta, modo véspera de prova |
| **M8 · Revisões** | Sessão FSRS com atalhos de teclado e gestos no celular. Projeção de carga de 30 dias |
| **M9 · Redação** | Dois formatos, fichas dos nove gêneros, banco de repertório, controle de reescrita |
| **M10 · Simulados** | Montagem, execução, resultados por área, formulário obrigatório de análise |
| **M11 · Dashboard** | Métricas da Seção 7 — Métricas Derivadas, com filtros de período. Sóbrio, sem gamificação |
| **M12 · Busca no acervo** | Consulta em linguagem natural ao material enviado, com trecho e página |

### Área do responsável

| Módulo | Descrição |
|---|---|
| **M13 · Acervo** | Upload por disciplina, status de processamento, visualização das páginas extraídas |
| **M14 · Curadoria** | A fila de aprovação descrita em 6.7 — Curadoria. Otimizada para volume |
| **M15 · Lacunas** | O painel de trabalho descrito em 6.8 — Painel de lacunas |
| **M16 · Geração** | Disparar jobs por tópico, acompanhar progresso e custo acumulado |
| **M17 · Acompanhamento** | Visões agregadas permitidas pela regra 1.2 — O painel do responsável não é vigilância. Granularidade mínima quinzenal |
| **M18 · Revisão Trimestral** | Formulário semi-preenchido, disparado em março, junho, setembro e dezembro |
| **M19 · Taxonomia** | Gestão de disciplinas e tópicos, com índices de incidência |

---

# 9. DIREÇÃO VISUAL

Continuidade deliberada com o ebook do planejamento, para que o sistema pareça a versão viva do livro.

```
Petróleo profundo  #0E3D4D   — primária, cabeçalhos, navegação
Petróleo médio     #17607A   — estados ativos
Terracota          #B5502B   — acentos, alertas de atenção
Âmbar              #C98A2E   — destaques, marcos
Creme              #FBF8F3   — fundo de leitura
Tinta              #1B2A33   — texto
```

**Tipografia:** Lora para leitura longa (conteúdo teórico, enunciados, o plano). Poppins para interface, títulos, números e tabelas.

**Diretrizes:**
- Densidade informacional alta, com respiro. Referência: dashboards editoriais sóbrios, não SaaS colorido.
- Modo escuro obrigatório — ela vai estudar à noite.
- **Mobile-first de verdade** na área da estudante. Alvos de toque ≥ 44px.
- A área do responsável é **desktop-first** — curadoria de volume exige teclado e tela grande.
- Acessibilidade: contraste AA, navegação por teclado, foco visível.
- **Zero gamificação.** Sem badges, confetes, streaks, níveis ou mascote.
- Animações discretas e rápidas. Nada que atrase uma ação repetida centenas de vezes.

---

# 10. DADOS INICIAIS (SEED)

Gere seeds realistas, não placeholders:

1. **Disciplinas e áreas** conforme a matriz do ENEM.
2. **Tópicos** — currículo completo do ensino médio, com `serie_prevista` e `incidencia_*` preenchidos a partir das tabelas de priorização do PDF (Parte IV).
3. **Três ciclos** — 2027 (12 blocos), 2028 (16 blocos) e 2029, exatamente como no plano.
4. **Nove gêneros textuais** com fichas vazias.
5. **Metas por ano** — carga semanal, questões, redações e simulados de cada ano, conforme as tabelas do PDF.
6. **Um arquivo de exemplo** processado ponta a ponta, para validar o pipeline sem depender de upload real.
7. **Dois usuários** criados por script, com senhas em variável de ambiente.

---

# 11. FASES DE ENTREGA

**Entregue uma fase por vez.** Ao final de cada uma, pare, rode os testes, faça o build e apresente um resumo do que funciona antes de seguir. Não avance sem confirmação.

| Fase | Escopo | Critério de aceite |
|---|---|---|
| **0** | Scaffolding, auth com allowlist, schema completo, RLS, pgvector, fila, seeds, deploy | Duas contas logam; terceiro e-mail rejeitado; `responsavel` não lê `sessoes` nem via API; `estudante` não lê conteúdo `rascunho` |
| **1** | Ciclo + cronômetro + sessões — **o laço diário completo** | Ela inicia um bloco, percorre as 4 etapas, registra um erro e o ponteiro avança. Utilizável ponta a ponta no celular |
| **2** | **Motor de ingestão, parte 1:** upload, extração, OCR, segmentação, classificação, indexação | Um PDF de 300 páginas é processado; chunks classificados por tópico; busca semântica retorna trecho com página correta |
| **3** | **Motor de ingestão, parte 2:** geração de artefatos + fila de curadoria + painel de lacunas | Gerar resumo, perguntas e questões nos dois estilos para um tópico; aprovar via fila; conteúdo aparece para a estudante. Item sem citação de fonte é bloqueado |
| **4** | Banco de questões + tentativas + caderno de erros | Resolver questão com captura de confiança; chute gera rascunho de erro; ritual de sexta funciona; procedência visível |
| **5** | FSRS + revisões + card a partir de erro | Agendamento validado por teste unitário contra casos conhecidos |
| **6** | Dashboard + métricas da Seção 7 — Métricas Derivadas | Divergência de trilhos calculada e explicada em tela |
| **7** | Redação + repertório + simulados com trava e regra de composição | Trava impede novo simulado com análise pendente; simulado avisa quando não há 80% de questões oficiais |
| **8** | Bem-estar + revisão trimestral + painel do responsável | Painel não expõe granularidade diária, verificado por teste |
| **9** | PWA offline + backup + export | Funciona offline para conteúdo aprovado e flashcards; export restaura em base limpa |

**Duas fases merecem investimento desproporcional:**

- **A Fase 1** é o laço diário. Se não for agradável de usar no celular, nada mais importa — o sistema não será usado.
- **A Fase 3** é o portão de curadoria. Se aprovar conteúdo for lento ou confuso, a fila acumula, o conteúdo não chega à estudante, e o motor inteiro vira peso morto.

---

# 12. QUALIDADE E OPERAÇÃO

- **Testes unitários obrigatórios** para: avanço do ponteiro do ciclo, cálculo de aderência, divergência de trilhos, agendamento FSRS, travas de simulado e de etapa de registro, e a regra que bloqueia artefato gerado sem citação de fonte.
- **E2E (Playwright)** para: login, sessão de estudo completa com registro de erro, revisão FSRS, upload e processamento de arquivo, aprovação na curadoria, e registro de simulado com análise.
- **Backup automático** — export completo em JSON, semanal, incluindo os arquivos do acervo. Três anos de dados e material não podem depender do plano gratuito de nenhum fornecedor. Inclua botão de export manual.
- **Migrations versionadas**, com rollback testado.
- **Observabilidade do pipeline:** log de cada job com duração, custo e resultado. Jobs falhos precisam ser reprocessáveis com um clique.
- **Controle de custo:** teto mensal configurável de gasto com a API. Ao atingir, pausar geração e avisar.
- `README.md` com setup, variáveis de ambiente, seed, deploy, restauração de backup e operação do pipeline.

---

# 13. O QUE NÃO FAZER

- Não modele o ciclo como calendário semanal. É uma fila. Reler 4.2 — Ciclo de estudos.
- Não crie streaks, badges, rankings ou qualquer mecânica que gere culpa ao falhar.
- Não dê ao responsável visão diária de atividade da estudante.
- Não permita que conteúdo gerado chegue à estudante sem aprovação humana explícita.
- Não gere conteúdo a partir de conhecimento próprio do modelo. Só do material indexado. Sem fonte, retorne vazio.
- Não crie tópicos novos automaticamente a partir do material.
- Não complete simulados com questões geradas sem avisar a composição.
- Não preencha automaticamente o campo `conceito_correto` do caderno de erros.
- Não permita pular a etapa de registro do bloco de 50 minutos.
- Não calcule médias incluindo simulados sem análise concluída.
- Não implemente compartilhamento público, links abertos ou exportação do acervo para terceiros.
- Não adicione integrações, chat, rede social ou funcionalidade não listada. Escopo fechado.
- Não otimize prematuramente para escala. São dois usuários.

---

# 14. PRIMEIRA AÇÃO

Antes de escrever código:

1. Leia o PDF `Plano-Medicina-Fortaleza-2027-2030.pdf` integralmente.
2. Apresente um resumo em até 25 linhas confirmando que entendeu: os dois trilhos, a natureza de fila do ciclo, o papel do caderno de erros, a hierarquia de procedência das questões, o portão de curadoria e as restrições do painel do responsável.
3. Liste quaisquer contradições ou ambiguidades entre o PDF e esta especificação.
4. Proponha o plano da Fase 0 e aguarde confirmação.

Não pule esta etapa.
