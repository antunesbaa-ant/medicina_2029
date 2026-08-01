import { db, client } from './index';
import {
  perfis,
  disciplinas,
  topicos,
  ciclos,
  cicloBlocos,
  cicloEstado,
  generos
} from './schema';
import { eq } from 'drizzle-orm';

async function main() {
  console.log('Iniciando seed do banco de dados...');

  try {
    // 1. Limpar tabelas na ordem correta
    console.log('Limpando dados antigos...');
    await db.delete(cicloEstado);
    await db.delete(cicloBlocos);
    await db.delete(ciclos);
    await db.delete(topicos);
    await db.delete(disciplinas);
    await db.delete(generos);
    await db.delete(perfis);

    // 2. Seeding Perfis
    console.log('Seeding Perfis...');
    const [estudante] = await db.insert(perfis).values({
      authUserId: '00000000-0000-0000-0000-000000000001',
      nome: 'Alice Antunes (Estudante)',
      papel: 'estudante'
    }).returning();

    const [responsavel] = await db.insert(perfis).values({
      authUserId: '00000000-0000-0000-0000-000000000002',
      nome: 'Bruno (Responsável)',
      papel: 'responsavel'
    }).returning();

    console.log('Perfis criados:', { estudante: estudante.id, responsavel: responsavel.id });

    // 3. Seeding Disciplinas
    console.log('Seeding Disciplinas...');
    const discData = [
      { nome: 'Matemática', area: 'matematica' as const, corHex: '#C98A2E', ordem: 1 },
      { nome: 'Biologia', area: 'natureza' as const, corHex: '#0E3D4D', ordem: 2 },
      { nome: 'Química', area: 'natureza' as const, corHex: '#17607A', ordem: 3 },
      { nome: 'Física', area: 'natureza' as const, corHex: '#B5502B', ordem: 4 },
      { nome: 'Redação', area: 'redacao' as const, corHex: '#DE6B48', ordem: 5 },
      { nome: 'Linguagens', area: 'linguagens' as const, corHex: '#7A306C', ordem: 6 },
      { nome: 'História', area: 'humanas' as const, corHex: '#8B575C', ordem: 7 },
      { nome: 'Geografia', area: 'humanas' as const, corHex: '#3A506B', ordem: 8 },
      { nome: 'Filosofia', area: 'humanas' as const, corHex: '#5BC0BE', ordem: 9 },
      { nome: 'Sociologia', area: 'humanas' as const, corHex: '#6FFFE9', ordem: 10 },
      { nome: 'Língua Estrangeira', area: 'linguagens' as const, corHex: '#48A9A6', ordem: 11 },
    ];

    const insertedDisciplinas: Record<string, string> = {};
    for (const d of discData) {
      const [res] = await db.insert(disciplinas).values(d).returning();
      insertedDisciplinas[d.nome] = res.id;
    }
    console.log('Disciplinas criadas:', Object.keys(insertedDisciplinas));

    // 4. Seeding Tópicos
    console.log('Seeding Tópicos...');
    const topicosData = [
      // Matemática
      { nome: 'Razão e Proporção', disc: 'Matemática', serie: 1, enem: 5, uece: 4, ordem: 1 },
      { nome: 'Porcentagem', disc: 'Matemática', serie: 1, enem: 5, uece: 4, ordem: 2 },
      { nome: 'Funções de 1º e 2º Grau', disc: 'Matemática', serie: 1, enem: 4, uece: 5, ordem: 3 },
      { nome: 'Geometria Plana', disc: 'Matemática', serie: 1, enem: 4, uece: 5, ordem: 4 },
      { nome: 'Geometria Espacial', disc: 'Matemática', serie: 2, enem: 4, uece: 5, ordem: 5 },
      { nome: 'Geometria Analítica', disc: 'Matemática', serie: 2, enem: 2, uece: 4, ordem: 6 },
      { nome: 'Trigonometria', disc: 'Matemática', serie: 2, enem: 3, uece: 5, ordem: 7 },
      { nome: 'Probabilidade', disc: 'Matemática', serie: 2, enem: 5, uece: 4, ordem: 8 },
      { nome: 'Estatística', disc: 'Matemática', serie: 2, enem: 5, uece: 3, ordem: 9 },
      { nome: 'Matemática Financeira e Juros', disc: 'Matemática', serie: 3, enem: 4, uece: 4, ordem: 10 },
      { nome: 'Análise Combinatória', disc: 'Matemática', serie: 2, enem: 4, uece: 5, ordem: 11 },

      // Biologia
      { nome: 'Citologia e Membrana Celular', disc: 'Biologia', serie: 1, enem: 4, uece: 5, ordem: 1 },
      { nome: 'Bioquímica Celular', disc: 'Biologia', serie: 1, enem: 3, uece: 5, ordem: 2 },
      { nome: 'Ecologia e Ecossistemas', disc: 'Biologia', serie: 1, enem: 5, uece: 4, ordem: 3 },
      { nome: 'Genética Mendeliana', disc: 'Biologia', serie: 2, enem: 4, uece: 5, ordem: 4 },
      { nome: 'Fisiologia Humana', disc: 'Biologia', serie: 2, enem: 5, uece: 5, ordem: 5 },
      { nome: 'Evolução', disc: 'Biologia', serie: 2, enem: 4, uece: 4, ordem: 6 },
      { nome: 'Saúde Pública e Viroses', disc: 'Biologia', serie: 3, enem: 5, uece: 4, ordem: 7 },

      // Química
      { nome: 'Atomística e Tabela Periódica', disc: 'Química', serie: 1, enem: 3, uece: 4, ordem: 1 },
      { nome: 'Ligações Químicas', disc: 'Química', serie: 1, enem: 3, uece: 4, ordem: 2 },
      { nome: 'Funções Inorgânicas', disc: 'Química', serie: 1, enem: 3, uece: 5, ordem: 3 },
      { nome: 'Estequiometria', disc: 'Química', serie: 1, enem: 5, uece: 5, ordem: 4 },
      { nome: 'Química Orgânica (Cadeias e Funções)', disc: 'Química', serie: 2, enem: 5, uece: 5, ordem: 5 },
      { nome: 'Físico-Química e Soluções', disc: 'Química', serie: 2, enem: 4, uece: 5, ordem: 6 },
      { nome: 'Eletroquímica', disc: 'Química', serie: 2, enem: 4, uece: 5, ordem: 7 },
      { nome: 'Equilíbrio Químico', disc: 'Química', serie: 3, enem: 4, uece: 5, ordem: 8 },
      { nome: 'Termoquímica', disc: 'Química', serie: 3, enem: 4, uece: 4, ordem: 9 },
      { nome: 'Química Ambiental', disc: 'Química', serie: 3, enem: 5, uece: 3, ordem: 10 },

      // Física
      { nome: 'Cinemática e Movimento', disc: 'Física', serie: 1, enem: 3, uece: 5, ordem: 1 },
      { nome: 'Leis de Newton e Dinâmica', disc: 'Física', serie: 1, enem: 4, uece: 5, ordem: 2 },
      { nome: 'Trabalho, Energia e Conservação', disc: 'Física', serie: 1, enem: 5, uece: 5, ordem: 3 },
      { nome: 'Termologia e Calorimetria', disc: 'Física', serie: 2, enem: 4, uece: 4, ordem: 4 },
      { nome: 'Óptica Geométrica', disc: 'Física', serie: 2, enem: 3, uece: 4, ordem: 5 },
      { nome: 'Ondulatória e Fenômenos Ondulatórios', disc: 'Física', serie: 2, enem: 5, uece: 4, ordem: 6 },
      { nome: 'Eletricidade e Circuitos', disc: 'Física', serie: 2, enem: 5, uece: 5, ordem: 7 },

      // Redação
      { nome: 'Estrutura Dissertativo-Argumentativa ENEM', disc: 'Redação', serie: 1, enem: 5, uece: 1, ordem: 1 },

      // Linguagens, Humanas e outras
      { nome: 'Interpretação de Texto', disc: 'Linguagens', serie: 1, enem: 5, uece: 4, ordem: 1 },
      { nome: 'Variação Linguística e Funções da Linguagem', disc: 'Linguagens', serie: 1, enem: 5, uece: 3, ordem: 2 },
      { nome: 'Literatura Brasileira Contemporânea', disc: 'Linguagens', serie: 2, enem: 4, uece: 5, ordem: 3 },
      { nome: 'Gramática Normativa', disc: 'Linguagens', serie: 2, enem: 2, uece: 5, ordem: 4 },
      { nome: 'Brasil República', disc: 'História', serie: 2, enem: 5, uece: 4, ordem: 1 },
      { nome: 'Geopolítica Global', disc: 'Geografia', serie: 2, enem: 4, uece: 4, ordem: 1 },
      { nome: 'Filosofia Moderna e Iluminismo', disc: 'Filosofia', serie: 2, enem: 4, uece: 3, ordem: 1 },
      { nome: 'Sociologia e Movimentos Sociais', disc: 'Sociologia', serie: 2, enem: 4, uece: 3, ordem: 1 },
      { nome: 'Vocabulário e Compreensão Textual', disc: 'Língua Estrangeira', serie: 1, enem: 5, uece: 4, ordem: 1 },
    ];

    for (const t of topicosData) {
      const discId = insertedDisciplinas[t.disc];
      if (!discId) {
        console.error(`Disciplina ${t.disc} não encontrada para o tópico ${t.nome}`);
        continue;
      }
      await db.insert(topicos).values({
        disciplinaId: discId,
        nome: t.nome,
        seriePrevista: t.serie,
        incidenciaEnem: t.enem,
        incidenciaUece: t.uece,
        ordem: t.ordem,
        coberturaMaterial: 'sem_fonte'
      });
    }
    console.log('Tópicos criados com sucesso!');

    // 5. Seeding Gêneros Textuais
    console.log('Seeding Gêneros Textuais...');
    const generosData = [
      {
        nome: 'Crônica',
        finalidade: 'Narrar fatos cotidianos sob uma ótica subjetiva, poética ou humorística.',
        interlocutor: 'Leitor comum de jornais, revistas ou blogs literários.',
        estrutura: 'Narrativa curta, poucos personagens, tempo e espaço reduzidos, desfecho reflexivo ou inesperado.',
        marcasLinguagem: 'Tom informal ou coloquial leve, humor, ironia, subjetividade, uso da primeira ou terceira pessoa.',
        erroQueDescaracteriza: 'Apresentar caráter estritamente dissertativo, sem elementos narrativos/descritivos ou ambientação cotidiana.',
        fichaCompleta: false
      },
      {
        nome: 'Artigo de Opinião',
        finalidade: 'Defender uma tese sobre tema social, político ou cultural relevante para convencer o leitor.',
        interlocutor: 'Leitores de jornais, revistas e portais de opinião.',
        estrutura: 'Título atraente, contextualização do tema, apresentação da tese, fundamentação argumentativa e conclusão persuasiva.',
        marcasLinguagem: 'Linguagem clara, objetiva, verbos no presente, marcas de autoria e modalizadores que indicam posicionamento.',
        erroQueDescaracteriza: 'Ausência de posicionamento do autor ou linguagem excessivamente técnica e neutra (expositiva).',
        fichaCompleta: false
      },
      {
        nome: 'Carta Argumentativa',
        finalidade: 'Persuadir um destinatário específico a adotar determinado ponto de vista ou tomar providências.',
        interlocutor: 'O destinatário formal a quem a carta é endereçada (e.g., uma autoridade, um diretor).',
        estrutura: 'Local e data, vocativo, introdução (assunto e tese), desenvolvimento argumentativo, conclusão e assinatura.',
        marcasLinguagem: 'Marcas explícitas de interlocução (uso do vocativo e pronomes de tratamento), linguagem formal e polida.',
        erroQueDescaracteriza: 'Falta do cabeçalho formal, desrespeito ao vocativo ou ausência de diálogo com o destinatário na argumentação.',
        fichaCompleta: false
      },
      {
        nome: 'Editorial',
        finalidade: 'Expressar a opinião oficial do veículo de comunicação (jornal, revista) sobre um fato recente.',
        interlocutor: 'O público leitor geral daquele veículo de comunicação.',
        estrutura: 'Introdução com exposição do fato e posicionamento do veículo, corpo de argumentos robustos, e fechamento sintético.',
        marcasLinguagem: 'Impessoalidade (geralmente terceira pessoa ou primeira pessoa do plural representando a instituição), clareza e formalidade.',
        erroQueDescaracteriza: 'Uso de linguagem subjetiva individualizada ou assinatura em nome de uma pessoa física.',
        fichaCompleta: false
      },
      {
        nome: 'Relato',
        finalidade: 'Apresentar a narração de um acontecimento real vivido ou testemunhado pelo autor.',
        interlocutor: 'Pessoas interessadas em fatos históricos, depoimentos de vida ou estudos de caso.',
        estrutura: 'Contextualização de tempo, espaço e agentes envolvidos, desenvolvimento cronológico dos acontecimentos e conclusão.',
        marcasLinguagem: 'Verbos no pretérito, primeira pessoa do singular ou plural, riqueza de detalhes descritivos e marcas temporais.',
        erroQueDescaracteriza: 'Fictionalização absurda sem base factual ou ausência total de encadeamento temporal e descrições.',
        fichaCompleta: false
      },
      {
        nome: 'Resenha Crítica',
        finalidade: 'Descrever e avaliar uma obra artística, científica ou literária para orientar o leitor.',
        interlocutor: 'Leitores que buscam recomendações ou análises sobre livros, filmes, álbuns ou artigos.',
        estrutura: 'Identificação da obra, resumo informativo do conteúdo e julgamento crítico (argumentação fundamentada sobre qualidades/defeitos).',
        marcasLinguagem: 'Linguagem objetiva com marcas avaliativas explícitas, adjetivação precisa e tom analítico.',
        erroQueDescaracteriza: 'Resumir a obra sem emitir qualquer juízo de valor ou emitir críticas sem fundamentá-las em aspectos da obra.',
        fichaCompleta: false
      },
      {
        nome: 'Divulgação Científica',
        finalidade: 'Traduzir conceitos e pesquisas científicas complexas para o entendimento do público geral.',
        interlocutor: 'Leitor leigo interessado em ciência e tecnologia.',
        estrutura: 'Introdução com apresentação do problema científico, explicação da metodologia de forma simples, resultados e impacto social.',
        marcasLinguagem: 'Metáforas explicativas, analogias, evitação de jargões técnicos excessivos sem explicação e precisão factual.',
        erroQueDescaracteriza: 'Foco em achismos sem base em pesquisas validadas ou linguagem hermética sem preocupação didática.',
        fichaCompleta: false
      },
      {
        nome: 'Manifesto',
        finalidade: 'Declarar publicamente as intenções, convicções ou reivindicações de um grupo sobre uma causa.',
        interlocutor: 'A sociedade civil, governantes ou o público-alvo da causa defendida.',
        estrutura: 'Título provocativo, justificativa da causa, corpo com as propostas/reivindicações em formato de tópicos e fecho com convocação à ação.',
        marcasLinguagem: 'Tom enérgico, exortativo, verbos no imperativo, uso recorrente de primeira pessoa do plural ("nós").',
        erroQueDescaracteriza: 'Uso de tom apático, puramente acadêmico, ou ausência de uma exortação ou chamada para ação clara.',
        fichaCompleta: false
      },
      {
        nome: 'Carta Aberta',
        finalidade: 'Manifestar uma opinião, denúncia ou apelo coletivo para toda a sociedade sobre um tema de interesse público.',
        interlocutor: 'O público em geral, embora possa se reportar a uma autoridade nominal específica.',
        estrutura: 'Vocativo geral (e.g., "À Sociedade de Fortaleza"), introdução com o objetivo, desenvolvimento argumentativo e fecho formal.',
        marcasLinguagem: 'Linguagem de grande apelo persuasivo, tom formal mas acessível, forte presença de marcas coletivas (nós).',
        erroQueDescaracteriza: 'Tratar de tema estritamente privado ou direcionar o debate sem relevância pública ampla.',
        fichaCompleta: false
      }
    ];

    for (const g of generosData) {
      await db.insert(generos).values(g);
    }
    console.log('Gêneros textuais criados com sucesso!');

    // 6. Seeding Ciclos de Estudo
    console.log('Seeding Ciclos de Estudo...');
    
    // Ciclo 2027 (12 blocos)
    const [ciclo2027] = await db.insert(ciclos).values({
      nome: 'Ciclo Padrão — 2027 (1º Ano)',
      anoLetivo: 2027,
      ativo: true,
      blocosPrevistosSemana: 12
    }).returning();

    const blocos2027 = [
      { nomeDisc: 'Matemática', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Biologia', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Redação', tipo: 'redacao' as const, estilo: 'enem' as const },
      { nomeDisc: 'Química', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Matemática', tipo: 'questoes' as const, estilo: 'enem' as const },
      { nomeDisc: 'Física', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Linguagens', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Química', tipo: 'questoes' as const, estilo: 'enem' as const },
      { nomeDisc: 'Matemática', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Biologia', tipo: 'questoes' as const, estilo: 'enem' as const },
      { nomeDisc: 'História', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Língua Estrangeira', tipo: 'lingua_estrangeira' as const, estilo: 'enem' as const },
    ];

    for (let i = 0; i < blocos2027.length; i++) {
      const b = blocos2027[i];
      await db.insert(cicloBlocos).values({
        cicloId: ciclo2027.id,
        ordem: i + 1,
        disciplinaId: insertedDisciplinas[b.nomeDisc]!,
        tipo: b.tipo,
        estiloAlvo: b.estilo,
        duracaoMin: 50
      });
    }

    await db.insert(cicloEstado).values({
      cicloId: ciclo2027.id,
      proximaOrdem: 1
    });

    // Ciclo 2028 (16 blocos - Conforme o PDF)
    const [ciclo2028] = await db.insert(ciclos).values({
      nome: 'Ciclo Padrão — 2028 (2º Ano)',
      anoLetivo: 2028,
      ativo: false,
      blocosPrevistosSemana: 16
    }).returning();

    const blocos2028 = [
      { nomeDisc: 'Biologia', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Matemática', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Redação', tipo: 'redacao' as const, estilo: 'misto' as const },
      { nomeDisc: 'História', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Química', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Matemática', tipo: 'questoes' as const, estilo: 'enem' as const }, // misto no PDF
      { nomeDisc: 'Física', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Linguagens', tipo: 'conteudo' as const, estilo: 'enem' as const }, // Literatura no PDF
      { nomeDisc: 'Química', tipo: 'conteudo' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Matemática', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Biologia', tipo: 'conteudo' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Física', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Linguagens', tipo: 'conteudo' as const, estilo: 'enem' as const }, // Linguagens e gramática
      { nomeDisc: 'Língua Estrangeira', tipo: 'lingua_estrangeira' as const, estilo: 'enem' as const },
      { nomeDisc: 'Geografia', tipo: 'conteudo' as const, estilo: 'enem' as const }, // Geografia, Filosofia e Sociologia
      { nomeDisc: 'Matemática', tipo: 'caderno_erros' as const, estilo: 'misto' as const }, // Caderno de erros e Anki
    ];

    for (let i = 0; i < blocos2028.length; i++) {
      const b = blocos2028[i];
      await db.insert(cicloBlocos).values({
        cicloId: ciclo2028.id,
        ordem: i + 1,
        disciplinaId: insertedDisciplinas[b.nomeDisc]!,
        tipo: b.tipo,
        estiloAlvo: b.estilo,
        duracaoMin: 50
      });
    }

    await db.insert(cicloEstado).values({
      cicloId: ciclo2028.id,
      proximaOrdem: 1
    });

    // Ciclo 2029 (28 blocos - Carga de 23 horas)
    const [ciclo2029] = await db.insert(ciclos).values({
      nome: 'Ciclo Padrão — 2029 (3º Ano)',
      anoLetivo: 2029,
      ativo: false,
      blocosPrevistosSemana: 28
    }).returning();

    const blocos2029 = [
      { nomeDisc: 'Biologia', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Matemática', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Redação', tipo: 'redacao' as const, estilo: 'enem' as const },
      { nomeDisc: 'Química', tipo: 'conteudo' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Física', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Matemática', tipo: 'conteudo' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Biologia', tipo: 'conteudo' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Redação', tipo: 'redacao' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Química', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Física', tipo: 'conteudo' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Matemática', tipo: 'questoes' as const, estilo: 'enem' as const },
      { nomeDisc: 'História', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Geografia', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Linguagens', tipo: 'conteudo' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Linguagens', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Química', tipo: 'questoes' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Matemática', tipo: 'questoes' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Biologia', tipo: 'questoes' as const, estilo: 'enem' as const },
      { nomeDisc: 'Física', tipo: 'questoes' as const, estilo: 'enem' as const },
      { nomeDisc: 'Redação', tipo: 'redacao' as const, estilo: 'enem' as const },
      { nomeDisc: 'História', tipo: 'conteudo' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Geografia', tipo: 'conteudo' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Filosofia', tipo: 'conteudo' as const, estilo: 'enem' as const },
      { nomeDisc: 'Língua Estrangeira', tipo: 'lingua_estrangeira' as const, estilo: 'conteudista' as const },
      { nomeDisc: 'Matemática', tipo: 'questoes' as const, estilo: 'enem' as const },
      { nomeDisc: 'Química', tipo: 'questoes' as const, estilo: 'enem' as const },
      { nomeDisc: 'Matemática', tipo: 'caderno_erros' as const, estilo: 'misto' as const },
      { nomeDisc: 'Matemática', tipo: 'revisao_srs' as const, estilo: 'misto' as const },
    ];

    for (let i = 0; i < blocos2029.length; i++) {
      const b = blocos2029[i];
      await db.insert(cicloBlocos).values({
        cicloId: ciclo2029.id,
        ordem: i + 1,
        disciplinaId: insertedDisciplinas[b.nomeDisc]!,
        tipo: b.tipo,
        estiloAlvo: b.estilo,
        duracaoMin: 50
      });
    }

    await db.insert(cicloEstado).values({
      cicloId: ciclo2029.id,
      proximaOrdem: 1
    });

    console.log('Ciclos de estudos criados com sucesso!');

    console.log('Seed concluído com sucesso!');
  } catch (error) {
    console.error('Erro durante o seed:', error);
  } finally {
    await client.end();
  }
}

main();
