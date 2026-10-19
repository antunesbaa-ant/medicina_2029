-- Escritas equivalentes ao contrato anterior. Devem continuar validas depois
-- da expansao, enquanto os novos owners permanecem nullable.
INSERT INTO ciclos (
  id, nome, ano_letivo, ativo, blocos_previstos_semana
) VALUES (
  '41000000-0000-4000-8000-000000000001',
  'Ciclo legado pos-expansao', 2028, false, 7
);

INSERT INTO repertorios (
  id, referencia, resumo_2_linhas, temas_aplicaveis, categoria
) VALUES (
  '42000000-0000-4000-8000-000000000001',
  'Referencia legada artificial', 'Resumo artificial', '["tema-artificial"]', 'teste'
);

INSERT INTO revisoes_trimestrais (
  id, trimestre, ano, aderencia_pct, cards_atrasados, redacoes_escritas,
  redacoes_reescritas, media_sono, conversa, decisoes
) VALUES (
  '43000000-0000-4000-8000-000000000001',
  4, 2028, 80, 0, 1, 0, 8, 'Conversa artificial', 'Decisao artificial'
);
