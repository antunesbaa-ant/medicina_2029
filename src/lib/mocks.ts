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
    { id: '11111111-1111-4000-8000-000000000001', nome: 'Razão e Proporção', incidenciaEnem: 5 },
    { id: '11111111-1111-4000-8000-000000000002', nome: 'Porcentagem', incidenciaEnem: 5 },
    { id: '11111111-1111-4000-8000-000000000003', nome: 'Funções de 1º e 2º Grau', incidenciaEnem: 4 },
    { id: '11111111-1111-4000-8000-000000000004', nome: 'Geometria Plana', incidenciaEnem: 4 },
    { id: '11111111-1111-4000-8000-000000000005', nome: 'Geometria Espacial', incidenciaEnem: 4 },
    { id: '11111111-1111-4000-8000-000000000006', nome: 'Análise Combinatória', incidenciaEnem: 4 },
    { id: '11111111-1111-4000-8000-000000000007', nome: 'Probabilidade', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-2222-2222-2222-222222222222': [
    { id: '11111111-2222-4000-8000-000000000001', nome: 'Citologia e Membrana Celular', incidenciaEnem: 4 },
    { id: '11111111-2222-4000-8000-000000000002', nome: 'Bioquímica Celular', incidenciaEnem: 3 },
    { id: '11111111-2222-4000-8000-000000000003', nome: 'Ecologia e Ecossistemas', incidenciaEnem: 5 },
    { id: '11111111-2222-4000-8000-000000000004', nome: 'Fisiologia Humana', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-3333-3333-3333-333333333333': [
    { id: '11111111-3333-4000-8000-000000000001', nome: 'Estrutura Dissertativo-Argumentativa ENEM', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-4444-4444-4444-444444444444': [
    { id: '11111111-4444-4000-8000-000000000001', nome: 'Atomística e Tabela Periódica', incidenciaEnem: 3 },
    { id: '11111111-4444-4000-8000-000000000002', nome: 'Ligações Químicas', incidenciaEnem: 3 },
    { id: '11111111-4444-4000-8000-000000000003', nome: 'Estequiometria', incidenciaEnem: 5 },
    { id: '11111111-4444-4000-8000-000000000004', nome: 'Química Orgânica', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-5555-5555-5555-555555555555': [
    { id: '11111111-5555-4000-8000-000000000001', nome: 'Cinemática e Movimento', incidenciaEnem: 3 },
    { id: '11111111-5555-4000-8000-000000000002', nome: 'Leis de Newton e Dinâmica', incidenciaEnem: 4 },
    { id: '11111111-5555-4000-8000-000000000003', nome: 'Ondulatória', incidenciaEnem: 5 },
    { id: '11111111-5555-4000-8000-000000000004', nome: 'Eletricidade e Circuitos', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-6666-6666-6666-666666666666': [
    { id: '11111111-6666-4000-8000-000000000001', nome: 'Interpretação de Texto', incidenciaEnem: 5 },
    { id: '11111111-6666-4000-8000-000000000002', nome: 'Variação Linguística', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-7777-7777-7777-777777777777': [
    { id: '11111111-7777-4000-8000-000000000001', nome: 'Brasil República', incidenciaEnem: 5 }
  ],
  'd1d1d1d1-8888-8888-8888-888888888888': [
    { id: '11111111-8888-4000-8000-000000000001', nome: 'Geopolítica Global', incidenciaEnem: 4 }
  ],
  'd1d1d1d1-9999-9999-9999-999999999999': [
    { id: '11111111-9999-4000-8000-000000000001', nome: 'Filosofia Moderna e Iluminismo', incidenciaEnem: 4 }
  ],
  'd1d1d1d1-aaaa-aaaa-aaaa-aaaaaaaaaaaa': [
    { id: '11111111-aaaa-4000-8000-000000000001', nome: 'Sociologia e Movimentos Sociais', incidenciaEnem: 4 }
  ],
  'd1d1d1d1-bbbb-bbbb-bbbb-bbbbbbbbbbbb': [
    { id: '11111111-bbbb-4000-8000-000000000001', nome: 'Vocabulário e Compreensão Textual', incidenciaEnem: 5 }
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
  { id: 'b1b1b1b1-0001-4000-8000-000000000001', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 1, disciplinaId: MOCK_DISCIPLINAS.Matematica.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Matematica },
  { id: 'b1b1b1b1-0002-4000-8000-000000000002', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 2, disciplinaId: MOCK_DISCIPLINAS.Biologia.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Biologia },
  { id: 'b1b1b1b1-0003-4000-8000-000000000003', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 3, disciplinaId: MOCK_DISCIPLINAS.Redacao.id, tipo: 'redacao' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Redacao },
  { id: 'b1b1b1b1-0004-4000-8000-000000000004', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 4, disciplinaId: MOCK_DISCIPLINAS.Quimica.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Quimica },
  { id: 'b1b1b1b1-0005-4000-8000-000000000005', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 5, disciplinaId: MOCK_DISCIPLINAS.Matematica.id, tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Matematica },
  { id: 'b1b1b1b1-0006-4000-8000-000000000006', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 6, disciplinaId: MOCK_DISCIPLINAS.Fisica.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Fisica },
  { id: 'b1b1b1b1-0007-4000-8000-000000000007', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 7, disciplinaId: MOCK_DISCIPLINAS.Linguagens.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Linguagens },
  { id: 'b1b1b1b1-0008-4000-8000-000000000008', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 8, disciplinaId: MOCK_DISCIPLINAS.Quimica.id, tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Quimica },
  { id: 'b1b1b1b1-0009-4000-8000-000000000009', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 9, disciplinaId: MOCK_DISCIPLINAS.Matematica.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Matematica },
  { id: 'b1b1b1b1-0010-4000-8000-000000000010', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 10, disciplinaId: MOCK_DISCIPLINAS.Biologia.id, tipo: 'questoes' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Biologia },
  { id: 'b1b1b1b1-0011-4000-8000-000000000011', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 11, disciplinaId: MOCK_DISCIPLINAS.Historia.id, tipo: 'conteudo' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.Historia },
  { id: 'b1b1b1b1-0012-4000-8000-000000000012', cicloId: 'c1c1c1c1-1111-1111-1111-111111111111', ordem: 12, disciplinaId: MOCK_DISCIPLINAS.LinguaEstrangeira.id, tipo: 'lingua_estrangeira' as const, estiloAlvo: 'enem' as const, duracaoMin: 50, disciplina: MOCK_DISCIPLINAS.LinguaEstrangeira }
];
