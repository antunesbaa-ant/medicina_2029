-- Escritas do contrato atualizado, usando exclusivamente perfis.id artificiais.
INSERT INTO ciclos (
  id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana
) VALUES (
  '51000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'Ciclo atualizado', 2029, false, 8
);

INSERT INTO repertorios (
  id, perfil_id, referencia, resumo_2_linhas, temas_aplicaveis, categoria
) VALUES (
  '52000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'Referencia atualizada artificial', 'Resumo artificial', '["tema-artificial"]', 'teste'
);

INSERT INTO revisoes_trimestrais (
  id, estudante_perfil_id, registrada_por_perfil_id, trimestre, ano,
  aderencia_pct, cards_atrasados, redacoes_escritas, redacoes_reescritas,
  media_sono, conversa, decisoes
) VALUES (
  '53000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  1, 2029, 85, 0, 1, 0, 8, 'Conversa artificial', 'Decisao artificial'
);
