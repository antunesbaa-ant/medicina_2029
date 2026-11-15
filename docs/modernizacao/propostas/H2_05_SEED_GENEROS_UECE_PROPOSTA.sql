-- ==============================================================================
-- MEDICINA 2029 — H2.05: SEED DE GÊNEROS TEXTUAIS OFICIAIS UECE (PROPOSTA)
-- ==============================================================================
-- Finalidade:
-- Provisionar os 5 gêneros textuais oficiais cobrados pela Universidade Estadual
-- do Ceará (UECE) na tabela public.generos:
--   1. Manifesto
--   2. Carta ao Leitor
--   3. Artigo de Opinião
--   4. Crônica Argumentativa
--   5. Resenha Crítica
--
-- Características:
-- - Idempotente: chave primária fixa e verificação de integridade semântica.
-- - Alinhado estritamente à matriz da CEV/UECE (vedação expressa de assinaturas).
-- - Contempla finalidade pedagógica, interlocutor, estrutura textual, marcas
--   de linguagem e o fator eliminatório de descaracterização (que zera a prova).
-- ==============================================================================

BEGIN;

-- Tentativa de criação do índice de integridade único case-insensitive
-- (Exige ownership da tabela; caso executado sob role restrita, a idempotência
-- é garantida em nível de DML pela chave primária e cláusula WHERE NOT EXISTS)
CREATE UNIQUE INDEX IF NOT EXISTS uq_generos_nome ON public.generos (lower(nome));

INSERT INTO public.generos (
  id,
  nome,
  finalidade,
  interlocutor,
  estrutura,
  marcas_linguagem,
  erro_que_descaracteriza,
  ficha_completa
)
VALUES
  (
    '00000000-0000-4000-a000-000000000001',
    'Manifesto',
    'Declarar publicamente uma denúncia, tomada de posição ou reivindicação coletiva urgente, conclamando a sociedade civil ou comunidade a agir.',
    'Sociedade civil, comunidade acadêmica ou autoridades públicas; voz de um coletivo ou representação social legítima.',
    'Título expressivo/exortativo, contextualização da causa e denúncia fundamentada, razões da reivindicação e conclamação final à mobilização coletiva (Atenção: a CEV/UECE proíbe expressamente qualquer tipo de assinatura, nome fictício ou sinal identificador no corpo da prova).',
    'Verbos no imperativo e no presente do indicativo, 1ª pessoa do plural (nós), tom enfático, assertivo, exortativo e persuasivo.',
    'Adotar tom passivo, apático ou estritamente individualista sem apelo público ou conclamação à ação, ou incluir qualquer rubrica/assinatura identificadora (fator de anulação sumária).',
    true
  ),
  (
    '00000000-0000-4000-a000-000000000002',
    'Carta ao Leitor',
    'Comentar, elogiar, criticar ou sugerir pautas a respeito de matérias publicadas em jornal ou revista, estabelecendo interlocução com a equipe editorial e público leitor.',
    'Equipe de redação/editoria de veículo de imprensa ou leitores do periódico (vedada qualquer assinatura nominal do candidato no vestibular UECE).',
    'Identificação do veículo/seção de referência, vocativo formal, referência explícita à matéria comentada, exposição do ponto de vista do leitor, argumentação e fórmula de cortesia final sem assinatura pessoal.',
    '1ª pessoa (singular ou plural), marcas explícitas de diálogo e interlocução, linguagem padrão clara, concisa e polidez crítica.',
    'Omitir a referência à matéria preexistente comentada, transformar o texto em correspondência privada sem relação com o periódico, ou assinar nominalmente ao final.',
    true
  ),
  (
    '00000000-0000-4000-a000-000000000003',
    'Artigo de Opinião',
    'Analisar criticamente um tema controverso da atualidade e defender uma tese fundamentada, visando persuadir e formar a opinião do público leitor.',
    'Leitores de jornais, revistas ou portais de grande circulação.',
    'Título instigante, contextualização do tema polêmico, tese explícita, corpo com fundamentação argumentativa sólida e refutação de contra-argumentos, e conclusão propositiva.',
    '1ª ou 3ª pessoa, recursos persuasivos, ironia moderada, conectivos interparágrafos consistentes, adjetivação expressiva e variedade lexical.',
    'Redigir texto puramente informativo, descritivo ou neutro sem emitir juízo de valor ou sem defender tese fundamentada e opinativa.',
    true
  ),
  (
    '00000000-0000-4000-a000-000000000004',
    'Crônica Argumentativa',
    'Refletir criticamente sobre fatos e costumes do cotidiano a partir de um olhar sensível, reflexivo ou irônico, articulando elementos narrativos à sustentação de uma opinião.',
    'Público leitor de crônicas e folhetins contemporâneos que buscam reflexão humanizada sobre a realidade cotidiana.',
    'Ponto de partida em episódio corriqueiro do dia a dia, desenvolvimento narrativo-reflexivo breve com ponderação crítica e desfecho reflexivo, lírico, irônico ou provocador.',
    'Linguagem coloquial refinada, recursos poéticos, diálogo rápido, metáforas cotidianas, fluidez narrativa e ritmo dinâmico.',
    'Adotar estrutura rígida e impessoal de dissertação acadêmica sem qualquer traço de cotidianidade, narratividade ou estilo lírico-reflexivo.',
    true
  ),
  (
    '00000000-0000-4000-a000-000000000005',
    'Resenha Crítica',
    'Descrever, sintetizar e avaliar criticamente uma obra cultural ou científica (livro, filme, peça, ensaio), orientando a percepção e o discernimento do leitor.',
    'Público leitor interessado em apreciação artística, literária ou científica e recomendações fundamentadas.',
    'Apresentação da obra e autor, resumo sucinto dos pontos centrais, juízo crítico fundamentado (pontos fortes e fracos) e recomendação ou consideração conclusiva.',
    'Linguagem culta, objetiva e analítica, rica em adjetivos avaliativos e operadores argumentativos que justificam a apreciação estética/conceitual.',
    'Limitar-se a um mero resumo ou sinopse sem emitir juízo crítico valorativo fundamentado sobre a qualidade da obra.',
    true
  )
ON CONFLICT (id) DO UPDATE SET
  nome = EXCLUDED.nome,
  finalidade = EXCLUDED.finalidade,
  interlocutor = EXCLUDED.interlocutor,
  estrutura = EXCLUDED.estrutura,
  marcas_linguagem = EXCLUDED.marcas_linguagem,
  erro_que_descaracteriza = EXCLUDED.erro_que_descaracteriza,
  ficha_completa = EXCLUDED.ficha_completa;

COMMIT;
