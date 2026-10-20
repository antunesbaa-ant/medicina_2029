-- MEDICINA 2029 — F1.04
-- Fixtures para Validação Rigorosa de Row-Level Security (RLS) e Isolamento
-- Todos os dados são estritamente artificiais sob o domínio example.invalid.
--
-- Cobertura:
-- - Par 1 (Vinculado): Estudante 1 + Responsável 1 (vinculados em responsavel_estudante)
-- - Par 2 (Cross-Tenant): Estudante 2 + Responsável 2 (sem vínculo com o Par 1)
-- - Dados pessoais da estudante (sessões, cards, tentativas, erros, redações, checkins, livros, simulados)
-- - Acervo de materiais enviado por responsável 1 vs responsável 2
-- - Conteúdos aprovados vs conteúdos em rascunho
-- - Indicadores para views agregadas quinzenais e trimestrais

-- 1. PERFIS
INSERT INTO perfis (id, auth_user_id, nome, email, password_hash, papel) VALUES
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Estudante Ficticia 1 F1.04', 'estudante1.f104@example.invalid', '$2a$12$e80yvVzVzG7QkQeQ0yvVzOzY1N9l2B0rX9qW8v7u6t5s4r3q2p1o0', 'estudante'),
  ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Responsavel Ficticio 1 F1.04', 'responsavel1.f104@example.invalid', '$2a$12$f91zwW0W0H8RlRfR1zwW0P0Z2O0m3C1sY0rX0w8v7u6t5s4r3q2p1', 'responsavel'),
  ('10000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'Estudante Ficticia 2 F1.04', 'estudante2.f104@example.invalid', '$2a$12$g02axX1X1I9SmSgS2axX1Q1A3P1n4D2tZ1sY1x9w8v7u6t5s4r3q2', 'estudante'),
  ('20000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'Responsavel Ficticio 2 F1.04', 'responsavel2.f104@example.invalid', '$2a$12$h13byY2Y2J0TnThT3byY2R2B4Q2o5E3ua2tZ2y0x9w8v7u6t5s4r3', 'responsavel')
ON CONFLICT (id) DO UPDATE SET
  auth_user_id = EXCLUDED.auth_user_id,
  nome = EXCLUDED.nome,
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  papel = EXCLUDED.papel;

-- 1.1 ALLOWLIST (Apenas Estudante 1 e Responsável 1 são autorizados; Estudante 2 fica fora para testes)
INSERT INTO allowlist (email) VALUES
  ('estudante1.f104@example.invalid'),
  ('responsavel1.f104@example.invalid')
ON CONFLICT (email) DO NOTHING;

-- 2. VÍNCULO RESPONSÁVEL - ESTUDANTE (Singleton para o Par 1)
INSERT INTO responsavel_estudante (vinculo_id, responsavel_perfil_id, estudante_perfil_id) VALUES
  (1, '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001')
ON CONFLICT (vinculo_id) DO UPDATE SET
  responsavel_perfil_id = EXCLUDED.responsavel_perfil_id,
  estudante_perfil_id = EXCLUDED.estudante_perfil_id;

-- 3. DISCIPLINAS E TÓPICOS GLOBAIS
INSERT INTO disciplinas (id, nome, area, cor_hex, ordem) VALUES
  ('30000000-0000-4000-8000-000000000001', 'Biologia Ficticia', 'natureza', '#22C55E', 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO topicos (
  id, disciplina_id, nome, serie_prevista, incidencia_enem,
  incidencia_uece, pre_requisito_topico_id, ordem, cobertura_material
) VALUES
  ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Citologia Ficticia', 1, 3, 3, NULL, 1, 'coberto'),
  ('31000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 'Genetica Ficticia', 1, 3, 2, '31000000-0000-4000-8000-000000000001', 2, 'coberto')
ON CONFLICT (id) DO NOTHING;

-- 4. CICLOS E BLOCOS
INSERT INTO ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana) VALUES
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Ciclo Ficticio Estudante 1', 2027, true, 5),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Ciclo Ficticio Estudante 2', 2027, false, 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ciclo_blocos (id, ciclo_id, ordem, disciplina_id, tipo, estilo_alvo, duracao_min) VALUES
  ('41000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 1, '30000000-0000-4000-8000-000000000001', 'conteudo', 'enem', 50),
  ('41000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', 1, '30000000-0000-4000-8000-000000000001', 'conteudo', 'enem', 50)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ciclo_estado (ciclo_id, proxima_ordem) VALUES
  ('40000000-0000-4000-8000-000000000001', 1),
  ('40000000-0000-4000-8000-000000000002', 1)
ON CONFLICT (ciclo_id) DO NOTHING;

-- 5. SESSÕES DE ESTUDO (Dados Pessoais Brutos - Estudante 1 vs Estudante 2)
INSERT INTO sessoes (
  id, perfil_id, ciclo_bloco_id, topico_id, iniciada_em, encerrada_em,
  segundos_efetivos, segundos_pausa, etapa_atingida, concluida, nota_livre
) VALUES
  ('42000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '41000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001',
   now() - interval '2 days', now() - interval '2 days' + interval '50 minutes', 2700, 300, 'registro', true, 'Sessao confidencial Estudante 1'),
  ('42000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   '41000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000001',
   now() - interval '3 days', now() - interval '3 days' + interval '45 minutes', 2400, 300, 'registro', true, 'Sessao confidencial Estudante 2')
ON CONFLICT (id) DO NOTHING;

-- 6. FLASHCARDS E REVISÕES
INSERT INTO cards (
  id, perfil_id, topico_id, frente, verso, origem, status, suspenso,
  fonte_chunk_ids, due, stability, difficulty, elapsed_days, scheduled_days,
  reps, lapses, state, last_review
) VALUES
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000001', 'Frente Card E1', 'Verso Card E1', 'manual',
   'aprovado', false, '[]'::jsonb, now(), 1.0, 5.0, 0, 1, 1, 0, 'review', now() - interval '1 day'),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000001', 'Frente Card E2', 'Verso Card E2', 'manual',
   'aprovado', false, '[]'::jsonb, now(), 1.0, 5.0, 0, 1, 1, 0, 'review', now() - interval '1 day')
ON CONFLICT (id) DO NOTHING;

INSERT INTO card_revisoes (
  id, card_id, revisado_em, rating, state_anterior, stability_anterior, duracao_ms
) VALUES
  ('51000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
   now() - interval '1 day', 'good', 'learning', 1.0, 1500),
  ('51000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002',
   now() - interval '1 day', 'good', 'learning', 1.0, 1500)
ON CONFLICT (id) DO NOTHING;

-- 7. ACERVO DE ARQUIVOS (Responsável 1 vs Responsável 2)
INSERT INTO acervo_arquivos (
  id, disciplina_id, titulo, tipo_material, autor_fonte, serie_alvo, vestibular,
  file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento,
  hash_conteudo
) VALUES
  ('60000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001',
   'Apostila Citologia R1', 'apostila', 'Fonte R1', 1, 'ENEM',
   'f1_04/apostila-r1.pdf', 'application/pdf', 2048, 1,
   '20000000-0000-4000-8000-000000000001', 'concluido',
   '1111111111111111111111111111111111111111111111111111111111111111'),
  ('60000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001',
   'Apostila Genetica R2', 'apostila', 'Fonte R2', 1, 'UECE',
   'f1_04/apostila-r2.pdf', 'application/pdf', 4096, 1,
   '20000000-0000-4000-8000-000000000002', 'concluido',
   '2222222222222222222222222222222222222222222222222222222222222222')
ON CONFLICT (id) DO NOTHING;

INSERT INTO acervo_paginas (id, arquivo_id, numero, texto_extraido, metodo_extracao, confianca_ocr) VALUES
  ('61000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 1, 'Texto citologia R1', 'nativo', 1.0),
  ('61000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002', 1, 'Texto genetica R2', 'nativo', 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO acervo_chunks (
  id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo,
  topico_id, confianca_classificacao, tokens
) VALUES
  ('62000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 1, 1, 1, 'Chunk citologia R1', 'exposicao_teorica', '31000000-0000-4000-8000-000000000001', 1.0, 5),
  ('62000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002', 1, 1, 1, 'Chunk genetica R2', 'exposicao_teorica', '31000000-0000-4000-8000-000000000002', 1.0, 5)
ON CONFLICT (id) DO NOTHING;

-- 8. CONTEÚDOS CURADOS (Aprovados vs Rascunho)
-- Materiais
INSERT INTO materiais (
  id, topico_id, titulo, corpo, tipo, tempo_leitura_min, status, origem, aprovado_por, aprovado_em, versao
) VALUES
  ('90000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001',
   'Resumo Citologia Aprovado', 'Corpo do material de citologia aprovado.', 'resumo', 15,
   'aprovado', 'manual', '20000000-0000-4000-8000-000000000001', now(), 1),
  ('90000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000001',
   'Rascunho Citologia Nao Aprovado', 'Corpo do material em rascunho nao curado.', 'resumo', 10,
   'rascunho', 'manual', NULL, NULL, 1)
ON CONFLICT (id) DO NOTHING;

-- Perguntas Ativas
INSERT INTO perguntas_ativas (id, topico_id, pergunta, resposta, estilo, status) VALUES
  ('91000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'Pergunta Aprovada?', 'Resposta aprovada.', 'conteudista', 'aprovado'),
  ('91000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000001', 'Pergunta Rascunho?', 'Resposta rascunho.', 'conteudista', 'rascunho')
ON CONFLICT (id) DO NOTHING;

-- Questões
INSERT INTO questoes (
  id, procedencia, fonte, ano, fase, numero, disciplina_id, estilo, dificuldade,
  enunciado, alternativas, gabarito, resolucao, status, arquivo_origem_id, ativa
) VALUES
  ('70000000-0000-4000-8000-000000000001', 'oficial', 'ENEM', 2026, 'unica', 1,
   '30000000-0000-4000-8000-000000000001', 'enem', 'media',
   'Enunciado questao aprovada F1.04?',
   '[{"letra":"A","texto":"Alternativa correta"}]'::jsonb, 'A', 'Resolucao completa aprovada.',
   'aprovado', '60000000-0000-4000-8000-000000000001', true),
  ('70000000-0000-4000-8000-000000000002', 'gerada', 'IA', 2027, 'unica', 2,
   '30000000-0000-4000-8000-000000000001', 'enem', 'dificil',
   'Enunciado questao rascunho F1.04?',
   '[{"letra":"A","texto":"Alternativa preliminar"}]'::jsonb, 'A', 'Resolucao preliminar.',
   'rascunho', '60000000-0000-4000-8000-000000000001', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO questao_topicos (questao_id, topico_id) VALUES
  ('70000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001'),
  ('70000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000001');

-- 9. SIMULADOS E ANÁLISES (Estudante 1 vs Estudante 2)
INSERT INTO simulados (
  id, perfil_id, formato, data, condicoes_reais, duracao_min, local, composicao_procedencia
) VALUES
  ('73000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'enem', now() - interval '5 days', true, 300, 'Casa', '{"oficial":1}'::jsonb),
  ('73000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   'enem', now() - interval '6 days', true, 300, 'Escola', '{"oficial":1}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO simulado_questoes (simulado_id, questao_id, ordem, area) VALUES
  ('73000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 1, 'natureza'),
  ('73000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 1, 'natureza');

INSERT INTO simulado_areas (id, simulado_id, area, acertos, total, nota_estimated) VALUES
  ('73100000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', 'natureza', 1, 1, 750),
  ('73100000-0000-4000-8000-000000000002', '73000000-0000-4000-8000-000000000002', 'natureza', 1, 1, 680)
ON CONFLICT (id) DO NOTHING;

INSERT INTO simulado_analise (
  id, simulado_id, concluida, tres_assuntos_fracos, erros_estrategia, minutos_analise, realizada_em
) VALUES
  ('73200000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001',
   true, '[]'::jsonb, 'Estrategia consistente E1', 15, now() - interval '4 days'),
  ('73200000-0000-4000-8000-000000000002', '73000000-0000-4000-8000-000000000002',
   true, '[]'::jsonb, 'Estrategia consistente E2', 12, now() - interval '5 days')
ON CONFLICT (id) DO NOTHING;

-- 10. TENTATIVAS E ERROS
INSERT INTO tentativas (
  id, perfil_id, questao_id, sessao_id, simulado_id, alternativa_marcada,
  correta, segundos, confianca, criado_em
) VALUES
  ('71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '70000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001',
   '73000000-0000-4000-8000-000000000001', 'A', true, 60, 'certeza', now() - interval '2 days'),
  ('71000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   '70000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000002',
   '73000000-0000-4000-8000-000000000002', 'A', true, 70, 'certeza', now() - interval '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO erros (
  id, perfil_id, questao_id, tentativa_id, descricao_livre, disciplina_id,
  topico_id, estilo, tipo_erro, conceito_correto
) VALUES
  ('72000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '70000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001',
   'Erro de teste controlado E1', '30000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000001', 'enem', 'conteudo', 'Conceito citologia'),
  ('72000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   '70000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002',
   'Erro de teste controlado E2', '30000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000001', 'enem', 'conteudo', 'Conceito citologia')
ON CONFLICT (id) DO NOTHING;

-- 11. REDAÇÕES E REPERTÓRIOS
INSERT INTO generos (
  id, nome, finalidade, interlocutor, estrutura, marcas_linguagem,
  erro_que_descaracteriza, ficha_completa
) VALUES
  ('81000000-0000-4000-8000-000000000001', 'Artigo de Opiniao Ficticio', 'Convencimento',
   'Leitor de jornal', 'Titulo, tese, argumentos, conclusao', 'Padrao culto', 'Fuga ao tema', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO redacoes (
  id, perfil_id, formato, genero_id, tema, escrita_em, texto, minutos_gastos,
  nota_total, competencias, corrigida_por
) VALUES
  ('80000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'enem', '81000000-0000-4000-8000-000000000001', 'Tema Redacao E1',
   now() - interval '3 days', 'Texto da redacao escrita pela Estudante 1.', 55, 920, '{}'::jsonb, 'Corretor Ficticio'),
  ('80000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   'enem', '81000000-0000-4000-8000-000000000001', 'Tema Redacao E2',
   now() - interval '4 days', 'Texto da redacao escrita pela Estudante 2.', 60, 860, '{}'::jsonb, 'Corretor Ficticio')
ON CONFLICT (id) DO NOTHING;

INSERT INTO repertorios (id, perfil_id, referencia, resumo_2_linhas, temas_aplicaveis, categoria) VALUES
  ('82000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Obra Sociologica E1', 'Resumo obra E1.', '["saude", "etica"]'::jsonb, 'filosofia'),
  ('82000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   'Obra Sociologica E2', 'Resumo obra E2.', '["educacao"]'::jsonb, 'sociologia')
ON CONFLICT (id) DO NOTHING;

-- 12. CHECK-INS E LIVROS (Bem-estar e leitura pessoal)
INSERT INTO checkins (
  id, perfil_id, data, horas_sono, exercicio_min, humor, energia, nota_livre
) VALUES
  ('84000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   current_date - 1, 8.0, 30, 4, 4, 'Check-in confidencial Estudante 1'),
  ('84000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   current_date - 1, 7.5, 20, 3, 3, 'Check-in confidencial Estudante 2')
ON CONFLICT (id) DO NOTHING;

INSERT INTO livros (
  id, perfil_id, titulo, autor, ano_plano, iniciado_em, notas
) VALUES
  ('85000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Literatura Brasileira E1', 'Autor Classico', 2027, '2027-01-05 10:00:00', 'Notas confidenciais E1'),
  ('85000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   'Literatura Brasileira E2', 'Autor Moderno', 2027, '2027-01-08 10:00:00', 'Notas confidenciais E2')
ON CONFLICT (id) DO NOTHING;

-- 13. REVISÕES TRIMESTRAIS (Vínculo Estudante + Responsável)
INSERT INTO revisoes_trimestrais (
  id, estudante_perfil_id, registrada_por_perfil_id, trimestre, ano,
  aderencia_pct, cards_atrasados, media_enem, acerto_uece_pct, divergencia_trilhos,
  tipo_erro_predominante, redacoes_escritas, redacoes_reescritas, media_sono,
  conversa, decisoes, fechada_em
) VALUES
  ('83000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   1, 2027, 85.0, 5, 740.0, 78.0, 0.0, 'conteudo', 4, 1, 8.0,
   'Conversa alinhamento Par 1', 'Decisoes pactuadas Par 1', now() - interval '10 days'),
  ('83000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002',
   1, 2027, 80.0, 10, 710.0, 72.0, 0.0, 'distracao', 3, 0, 7.5,
   'Conversa alinhamento Par 2', 'Decisoes pactuadas Par 2', now() - interval '12 days')
ON CONFLICT (id) DO NOTHING;

-- 14. FILA DE CURADORIA
INSERT INTO curadoria_fila (
  id, artefato_tipo, artefato_id, topico_id, prioridade, criado_em, decisao
) VALUES
  ('92000000-0000-4000-8000-000000000001', 'questao', '70000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000001', 1, now(), 'pendente')
ON CONFLICT (id) DO NOTHING;
