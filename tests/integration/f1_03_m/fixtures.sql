-- MEDICINA 2029 — F1.03-M
-- Fixtures integralmente artificiais para banco PostgreSQL descartavel.
-- Os UUIDs internos dos perfis sao deliberadamente diferentes de auth_user_id.

INSERT INTO perfis (id, auth_user_id, nome, email, password_hash, papel) VALUES
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Estudante Ficticia F1.03-M', 'estudante.f103m@example.invalid', NULL, 'estudante'),
  ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Responsavel Ficticio F1.03-M', 'responsavel.f103m@example.invalid', NULL, 'responsavel');

INSERT INTO disciplinas (id, nome, area, cor_hex, ordem) VALUES
  ('30000000-0000-4000-8000-000000000001', 'Disciplina Ficticia', 'natureza', '#123456', 1);

INSERT INTO topicos (
  id, disciplina_id, nome, serie_prevista, incidencia_enem,
  incidencia_uece, pre_requisito_topico_id, ordem, cobertura_material
) VALUES
  ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Topico Base Ficticio', 1, 3, 3, NULL, 1, 'coberto'),
  ('31000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 'Topico Dependente Ficticio', 1, 2, 2, '31000000-0000-4000-8000-000000000001', 2, 'parcial');

INSERT INTO ciclos (id, nome, ano_letivo, ativo, blocos_previstos_semana) VALUES
  ('40000000-0000-4000-8000-000000000001', 'Ciclo Ficticio', 2027, true, 5);

INSERT INTO ciclo_blocos (id, ciclo_id, ordem, disciplina_id, tipo, estilo_alvo, duracao_min) VALUES
  ('41000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 1, '30000000-0000-4000-8000-000000000001', 'conteudo', 'enem', 50);

INSERT INTO ciclo_estado (ciclo_id, proxima_ordem) VALUES
  ('40000000-0000-4000-8000-000000000001', 1);

INSERT INTO sessoes (
  id, perfil_id, ciclo_bloco_id, topico_id, iniciada_em, encerrada_em,
  segundos_efetivos, segundos_pausa, etapa_atingida, concluida, nota_livre
) VALUES (
  '42000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001',
  '2027-01-10 12:00:00', '2027-01-10 12:50:00', 2700, 300, 'registro', true, 'Fixture F1.03-M'
);

INSERT INTO cards (
  id, perfil_id, topico_id, frente, verso, origem, status, suspenso,
  fonte_chunk_ids, due, stability, difficulty, elapsed_days, scheduled_days,
  reps, lapses, state, last_review
) VALUES (
  '50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001', 'Frente ficticia', 'Verso ficticio', 'manual',
  'aprovado', false, '[]'::jsonb, '2027-01-11 12:00:00', 1.0, 5.0, 0, 1, 0, 0, 'new', NULL
);

INSERT INTO card_revisoes (
  id, card_id, revisado_em, rating, state_anterior, stability_anterior, duracao_ms
) VALUES (
  '51000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
  '2027-01-11 12:00:00', 'good', 'new', 1.0, 1200
);

INSERT INTO acervo_arquivos (
  id, disciplina_id, titulo, tipo_material, autor_fonte, serie_alvo, vestibular,
  file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento,
  hash_conteudo
) VALUES (
  '60000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001',
  'Arquivo Ficticio', 'apostila', 'Fonte Ficticia', 1, 'TESTE',
  'f1_03_m/arquivo-ficticio.pdf', 'application/pdf', 1024, 1,
  '20000000-0000-4000-8000-000000000001', 'concluido',
  '0000000000000000000000000000000000000000000000000000000000000001'
);

INSERT INTO acervo_paginas (id, arquivo_id, numero, texto_extraido, metodo_extracao, confianca_ocr) VALUES
  ('61000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 1, 'Texto inteiramente ficticio.', 'nativo', 1.0);

INSERT INTO acervo_chunks (
  id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo,
  topico_id, confianca_classificacao, embedding, tokens
) VALUES (
  '62000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001',
  1, 1, 1, 'Chunk inteiramente ficticio.', 'exposicao_teorica',
  '31000000-0000-4000-8000-000000000001', 1.0, NULL, 4
);

INSERT INTO questoes (
  id, procedencia, fonte, ano, fase, numero, disciplina_id, estilo, dificuldade,
  enunciado, alternativas, gabarito, resolucao, status, arquivo_origem_id,
  fonte_chunk_ids, ativa
) VALUES (
  '70000000-0000-4000-8000-000000000001', 'extraida', 'FIXTURE', 2027, 'unica', 1,
  '30000000-0000-4000-8000-000000000001', 'enem', 'media', 'Enunciado ficticio?',
  '[{"letra":"A","texto":"Alternativa ficticia"}]'::jsonb, 'A', 'Resolucao ficticia',
  'aprovado', '60000000-0000-4000-8000-000000000001',
  '["62000000-0000-4000-8000-000000000001"]'::jsonb, true
);

INSERT INTO questao_topicos (questao_id, topico_id) VALUES
  ('70000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001');

INSERT INTO simulados (
  id, perfil_id, formato, data, condicoes_reais, duracao_min, local, composicao_procedencia
) VALUES (
  '73000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'enem', '2027-02-01 12:00:00', true, 300, 'Local Ficticio', '{"oficial":1}'::jsonb
);

INSERT INTO simulado_questoes (simulado_id, questao_id, ordem, area) VALUES
  ('73000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 1, 'natureza');

INSERT INTO simulado_areas (id, simulado_id, area, acertos, total, nota_estimated) VALUES
  ('73100000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', 'natureza', 1, 1, 700);

INSERT INTO simulado_analise (
  id, simulado_id, concluida, tres_assuntos_fracos, erros_estrategia, minutos_analise, realizada_em
) VALUES (
  '73200000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001',
  true, '[]'::jsonb, 'Nenhum; fixture.', 10, '2027-02-02 12:00:00'
);

INSERT INTO tentativas (
  id, perfil_id, questao_id, sessao_id, simulado_id, alternativa_marcada,
  correta, segundos, confianca
) VALUES (
  '71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000001', 'A', true, 60, 'certeza'
);

INSERT INTO erros (
  id, perfil_id, questao_id, tentativa_id, descricao_livre, disciplina_id,
  topico_id, estilo, tipo_erro, conceito_correto
) VALUES (
  '72000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001',
  'Erro ficticio controlado', '30000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001', 'enem', 'conteudo', 'Conceito ficticio'
);

INSERT INTO generos (
  id, nome, finalidade, interlocutor, estrutura, marcas_linguagem,
  erro_que_descaracteriza, ficha_completa
) VALUES (
  '81000000-0000-4000-8000-000000000001', 'Genero Ficticio', 'Finalidade ficticia',
  'Interlocutor ficticio', 'Estrutura ficticia', 'Marcas ficticias', 'Erro ficticio', true
);

INSERT INTO redacoes (
  id, perfil_id, formato, genero_id, tema, escrita_em, texto, minutos_gastos,
  nota_total, competencias, corrigida_por, reescrita_de_id, observacoes
) VALUES
  ('80000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'genero_uece',
   '81000000-0000-4000-8000-000000000001', 'Tema ficticio', '2027-03-01 12:00:00',
   'Texto ficticio original.', 60, 800, '{}'::jsonb, 'Corretor ficticio', NULL, NULL),
  ('80000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'genero_uece',
   '81000000-0000-4000-8000-000000000001', 'Tema ficticio reescrito', '2027-03-02 12:00:00',
   'Texto ficticio reescrito.', 55, 850, '{}'::jsonb, 'Corretor ficticio',
   '80000000-0000-4000-8000-000000000001', NULL);

INSERT INTO repertorios (id, referencia, resumo_2_linhas, temas_aplicaveis, categoria) VALUES
  ('82000000-0000-4000-8000-000000000001', 'Referencia ficticia', 'Resumo ficticio.', '["tema"]'::jsonb, 'teste');

INSERT INTO revisoes_trimestrais (
  id, trimestre, ano, aderencia_pct, cards_atrasados, media_enem, acerto_uece_pct,
  divergencia_trilhos, tipo_erro_predominante, redacoes_escritas,
  redacoes_reescritas, media_sono, conversa, decisoes
) VALUES (
  '83000000-0000-4000-8000-000000000001', 1, 2027, 90.0, 0, 700.0, 80.0,
  0.0, 'conteudo', 2, 1, 8.0, 'Conversa ficticia.', 'Decisoes ficticias.'
);

INSERT INTO checkins (
  id, perfil_id, data, horas_sono, exercicio_min, humor, energia, nota_livre
) VALUES (
  '84000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '2027-01-10 08:00:00', 8.0, 30, 4, 4, 'Check-in ficticio.'
);

INSERT INTO livros (
  id, perfil_id, titulo, autor, ano_plano, iniciado_em, concluido_em, notas
) VALUES (
  '85000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'Livro Ficticio', 'Autor Ficticio', 2027, '2027-01-01 12:00:00', NULL, 'Fixture F1.03-M'
);
