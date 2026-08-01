// Mocks estáticos de disciplinas
export const MOCK_DISCIPLINAS = {
  Matematica: { id: 'd1d1d1d1-1111-1111-1111-111111111111', nome: 'Matemática', area: 'matematica' as const, corHex: '#C98A2E', ordem: 1 },
  Biologia: { id: 'd1d1d1d1-2222-2222-2222-222222222222', nome: 'Biologia', area: 'natureza' as const, corHex: '#0E3D4D', ordem: 2 },
  Redacao: { id: 'd1d1d1d1-3333-3333-3333-333333333333', nome: 'Redação', area: 'redacao' as const, corHex: '#DE6B48', ordem: 5 },
  Quimica: { id: 'd1d1d1d1-4444-4444-4444-444444444444', nome: 'Química', area: 'natureza' as const, corHex: '#17607A', ordem: 3 },
  Fisica: { id: 'd1d1d1d1-5555-5555-5555-555555555555', nome: 'Física', area: 'natureza' as const, corHex: '#B5502B', ordem: 4 },
  Linguagens: { id: 'd1d1d1d1-6666-6666-6666-666666666666', nome: 'Linguagens', area: 'linguagens' as const, corHex: '#7A306C', ordem: 6 },
  Historia: { id: 'd1d1d1d1-7777-7777-7777-777777777777', nome: 'História', area: 'humanas' as const, corHex: '#8B575C', ordem: 7 },
  Geografia: { id: 'd1d1d1d1-8888-8888-8888-888888888888', nome: 'Geografia', area: 'humanas' as const, corHex: '#3A506B', ordem: 8 },
  Filosofia: { id: 'd1d1d1d1-9999-9999-9999-999999999999', nome: 'Filosofia', area: 'humanas' as const, corHex: '#5BC0BE', ordem: 9 },
  Sociologia: { id: 'd1d1d1d1-aaaa-aaaa-aaaa-aaaaaaaaaaaa', nome: 'Sociologia', area: 'humanas' as const, corHex: '#6FFFE9', ordem: 10 },
  LinguaEstrangeira: { id: 'd1d1d1d1-bbbb-bbbb-bbbb-bbbbbbbbbbbb', nome: 'Língua Estrangeira', area: 'linguagens' as const, corHex: '#48A9A6', ordem: 11 }
};

// Mocks estáticos de tópicos
export const MOCK_TOPICOS: Record<string, Array<{ id: string; nome: string; incidenciaEnem: number }>> = {
  'd1d1d1d1-1111-1111-1111-111111111111': [
    { id: 't-mat-1', nome: 'Razão e Proporção', incidenciaEnem: 5 },
    { id: 't-mat-2', nome: 'Porcentagem', incidenciaEnem: 5 },
    { id: 't-mat-3', nome: 'Funções de 1º e 2º Grau', incidenciaEnem: 4 },
    { id: 't-mat-4', nome: 'Geometria Plana', incidenciaEnem: 4 },
    { id: 't-mat-5', nome: 'Geometria Espacial', incidenciaEnem: 4 },
    { id: 't-mat-6', nome: 'Análise Combinatória', incidenciaEnem: 4 },
    { id: 't-mat-7', nome: 'Probabilidade', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-2222-2222-2222-222222222222': [
    { id: 't-bio-1', nome: 'Citologia e Membrana Celular', incidenciaEnem: 4 },
    { id: 't-bio-2', nome: 'Bioquímica Celular', incidenciaEnem: 3 },
    { id: 't-bio-3', nome: 'Ecologia e Ecossistemas', incidenciaEnem: 5 },
    { id: 't-bio-4', nome: 'Fisiologia Humana', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-3333-3333-3333-333333333333': [
    { id: 't-red-1', nome: 'Estrutura Dissertativo-Argumentativa ENEM', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-4444-4444-4444-444444444444': [
    { id: 't-qui-1', nome: 'Atomística e Tabela Periódica', incidenciaEnem: 3 },
    { id: 't-qui-2', nome: 'Ligações Químicas', incidenciaEnem: 3 },
    { id: 't-qui-3', nome: 'Estequiometria', incidenciaEnem: 5 },
    { id: 't-qui-4', nome: 'Química Orgânica', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-5555-5555-5555-555555555555': [
    { id: 't-fis-1', nome: 'Cinemática e Movimento', incidenciaEnem: 3 },
    { id: 't-fis-2', nome: 'Leis de Newton e Dinâmica', incidenciaEnem: 4 },
    { id: 't-fis-3', nome: 'Ondulatória', incidenciaEnem: 5 },
    { id: 't-fis-4', nome: 'Eletricidade e Circuitos', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-6666-6666-6666-666666666666': [
    { id: 't-lin-1', nome: 'Interpretação de Texto', incidenciaEnem: 5 },
    { id: 't-lin-2', nome: 'Variação Linguística', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-7777-7777-7777-777777777777': [
    { id: 't-his-1', nome: 'Brasil República', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-8888-8888-8888-888888888888': [
    { id: 't-geo-1', nome: 'Geopolítica Global', incidenciaEnem: 4 }
  ],
  'd1d1d1d1-9999-9999-9999-999999999999': [
    { id: 't-fil-1', nome: 'Filosofia Moderna e Iluminismo', incidenciaEnem: 4 }
  ],
  'd1d1d1d1-aaaa-aaaa-aaaa-aaaaaaaaaaaa': [
    { id: 't-soc-1', nome: 'Sociologia e Movimentos Sociais', incidenciaEnem: 4 }
  ],
  'd1d1d1d1-bbbb-bbbb-bbbb-bbbbbbbbbbbb': [
    { id: 't-ext-1', nome: 'Vocabulário e Compreensão Textual', incidenciaEnem: 5 }
  ]
};

export const MOCK_CICLO_ATIVO = {
  id: 'c1c1c1c1-1111-1111-1111-111111111111',
  nome: 'Ciclo Padrão — 2027 (1º Ano)',
  anoLetivo: 2027,
  ativo: true,
  blocosPrevistosSemana: 12,
  criadoEm: new Date('2026-01-01')
};

export const MOCK_BLOCOS = [
  { id: 'b-1', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 1, disciplinaId: MOCK_DISCIPLINAS.Matematica.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Matematica },
  { id: 'b-2', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 2, disciplinaId: MOCK_DISCIPLINAS.Biologia.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Biologia },
  { id: 'b-3', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 3, disciplinaId: MOCK_DISCIPLINAS.Redacao.id, tipo: 'redacao' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Redacao },
  { id: 'b-4', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 4, disciplinaId: MOCK_DISCIPLINAS.Quimica.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Quimica },
  { id: 'b-5', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 5, disciplinaId: MOCK_DISCIPLINAS.Matematica.id, tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Matematica },
  { id: 'b-6', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 6, disciplinaId: MOCK_DISCIPLINAS.Fisica.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Fisica },
  { id: 'b-7', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 7, disciplinaId: MOCK_DISCIPLINAS.Linguagens.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Linguagens },
  { id: 'b-8', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 8, disciplinaId: MOCK_DISCIPLINAS.Quimica.id, tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Quimica },
  { id: 'b-9', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 9, disciplinaId: MOCK_DISCIPLINAS.Matematica.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Matematica },
  { id: 'b-10', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 10, disciplinaId: MOCK_DISCIPLINAS.Biologia.id, tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Biologia },
  { id: 'b-11', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 11, disciplinaId: MOCK_DISCIPLINAS.Historia.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Historia },
  { id: 'b-12', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 12, disciplinaId: MOCK_DISCIPLINAS.LinguaEstrangeira.id, tipo: 'lingua_estrangeira' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.LinguaEstrangeira }
];
