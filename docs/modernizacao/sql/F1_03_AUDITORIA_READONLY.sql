-- MEDICINA 2029 — F1.03
-- Auditoria agregada de identidade, ownership e integridade referencial.
--
-- SEGURANCA:
--   1. Execute somente em copia autorizada do banco.
--   2. Confirme que o host e o nome do banco sao de auditoria/teste.
--   3. O script abre uma transacao READ ONLY e retorna apenas contagens.
--   4. Nenhum UUID, nome, e-mail, texto pedagogico ou segredo e exibido.

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

-- A execucao so e valida quando transaction_read_only = on.
SELECT
  current_database() AS database_name,
  current_user AS database_user,
  inet_server_addr() IS NULL OR inet_server_addr() IN ('127.0.0.1'::inet, '::1'::inet) AS server_is_local,
  current_setting('transaction_read_only') AS transaction_read_only;

-- 1. Cardinalidade dos perfis, sem expor dados pessoais.
SELECT papel::text AS papel, count(*)::bigint AS quantidade
FROM perfis
GROUP BY papel
ORDER BY papel;

SELECT
  count(*) FILTER (WHERE id = auth_user_id)::bigint AS identidade_interna_igual_externa,
  (
    SELECT count(*)
    FROM perfis interno
    JOIN perfis externo ON externo.auth_user_id = interno.id
    WHERE externo.id <> interno.id
  )::bigint AS colisoes_cruzadas_id_auth_user_id,
  (
    SELECT count(*)
    FROM (
      SELECT lower(email)
      FROM perfis
      WHERE email IS NOT NULL
      GROUP BY lower(email)
      HAVING count(*) > 1
    ) duplicados_email
  )::bigint AS grupos_email_case_insensitive_duplicados
FROM perfis;

-- 2. Constraints existentes que ainda nao foram validadas.
SELECT
  count(*) FILTER (WHERE contype = 'f' AND NOT convalidated)::bigint AS fks_nao_validadas,
  count(*) FILTER (WHERE contype = 'c' AND NOT convalidated)::bigint AS checks_nao_validados
FROM pg_constraint c
JOIN pg_namespace n ON n.oid = c.connamespace
WHERE n.nspname = 'public';

-- 3. Owners diretos: orfaos e possivel uso indevido de auth_user_id como FK.
WITH owners AS (
  SELECT 'sessoes'::text AS origem, perfil_id AS owner_id FROM sessoes
  UNION ALL SELECT 'cards', perfil_id FROM cards
  UNION ALL SELECT 'tentativas', perfil_id FROM tentativas
  UNION ALL SELECT 'erros', perfil_id FROM erros
  UNION ALL SELECT 'redacoes', perfil_id FROM redacoes
  UNION ALL SELECT 'simulados', perfil_id FROM simulados
  UNION ALL SELECT 'checkins', perfil_id FROM checkins
  UNION ALL SELECT 'livros', perfil_id FROM livros
  UNION ALL SELECT 'acervo_arquivos', enviado_por FROM acervo_arquivos
  UNION ALL SELECT 'materiais_aprovados', aprovado_por FROM materiais WHERE aprovado_por IS NOT NULL
)
SELECT
  origem,
  count(*)::bigint AS total,
  count(*) FILTER (WHERE perfil_por_id.id IS NULL)::bigint AS owners_orfaos,
  count(*) FILTER (
    WHERE perfil_por_id.id IS NULL AND perfil_por_auth.auth_user_id IS NOT NULL
  )::bigint AS valores_que_casam_somente_auth_user_id
FROM owners
LEFT JOIN perfis perfil_por_id ON perfil_por_id.id = owners.owner_id
LEFT JOIN perfis perfil_por_auth ON perfil_por_auth.auth_user_id = owners.owner_id
GROUP BY origem
ORDER BY origem;

-- 4. Papel incoerente com o tipo do registro.
WITH dados_estudante AS (
  SELECT 'sessoes'::text AS origem, perfil_id FROM sessoes
  UNION ALL SELECT 'cards', perfil_id FROM cards
  UNION ALL SELECT 'tentativas', perfil_id FROM tentativas
  UNION ALL SELECT 'erros', perfil_id FROM erros
  UNION ALL SELECT 'redacoes', perfil_id FROM redacoes
  UNION ALL SELECT 'simulados', perfil_id FROM simulados
  UNION ALL SELECT 'checkins', perfil_id FROM checkins
  UNION ALL SELECT 'livros', perfil_id FROM livros
), dados_responsavel AS (
  SELECT 'acervo_arquivos'::text AS origem, enviado_por AS perfil_id FROM acervo_arquivos
  UNION ALL SELECT 'materiais_aprovados', aprovado_por FROM materiais WHERE aprovado_por IS NOT NULL
)
SELECT origem, count(*)::bigint AS owners_com_papel_incorreto
FROM dados_estudante d
JOIN perfis p ON p.id = d.perfil_id
WHERE p.papel <> 'estudante'
GROUP BY origem
UNION ALL
SELECT origem, count(*)::bigint
FROM dados_responsavel d
JOIN perfis p ON p.id = d.perfil_id
WHERE p.papel <> 'responsavel'
GROUP BY origem
ORDER BY origem;

-- 5. Colunas relacionais que ainda nao possuem FK no schema.
SELECT 'topicos.pre_requisito_topico_id' AS relacao, count(*)::bigint AS orfaos
FROM topicos filho
LEFT JOIN topicos pai ON pai.id = filho.pre_requisito_topico_id
WHERE filho.pre_requisito_topico_id IS NOT NULL AND pai.id IS NULL
UNION ALL
SELECT 'questoes.arquivo_origem_id', count(*)::bigint
FROM questoes q
LEFT JOIN acervo_arquivos a ON a.id = q.arquivo_origem_id
WHERE q.arquivo_origem_id IS NOT NULL AND a.id IS NULL
UNION ALL
SELECT 'tentativas.simulado_id', count(*)::bigint
FROM tentativas t
LEFT JOIN simulados s ON s.id = t.simulado_id
WHERE t.simulado_id IS NOT NULL AND s.id IS NULL
UNION ALL
SELECT 'redacoes.reescrita_de_id', count(*)::bigint
FROM redacoes filha
LEFT JOIN redacoes original ON original.id = filha.reescrita_de_id
WHERE filha.reescrita_de_id IS NOT NULL AND original.id IS NULL
ORDER BY relacao;

-- 6. Coerencia transitiva de ownership e relacionamentos redundantes.
SELECT 'tentativa_sessao_owner' AS regra, count(*)::bigint AS inconsistencias
FROM tentativas t
JOIN sessoes s ON s.id = t.sessao_id
WHERE t.perfil_id <> s.perfil_id
UNION ALL
SELECT 'tentativa_simulado_owner', count(*)::bigint
FROM tentativas t
JOIN simulados s ON s.id = t.simulado_id
WHERE t.perfil_id <> s.perfil_id
UNION ALL
SELECT 'erro_tentativa_owner', count(*)::bigint
FROM erros e
JOIN tentativas t ON t.id = e.tentativa_id
WHERE e.perfil_id <> t.perfil_id
UNION ALL
SELECT 'erro_tentativa_questao', count(*)::bigint
FROM erros e
JOIN tentativas t ON t.id = e.tentativa_id
WHERE e.questao_id <> t.questao_id
UNION ALL
SELECT 'redacao_reescrita_owner', count(*)::bigint
FROM redacoes filha
JOIN redacoes original ON original.id = filha.reescrita_de_id
WHERE filha.perfil_id <> original.perfil_id
UNION ALL
SELECT 'sessao_topico_disciplina_bloco', count(*)::bigint
FROM sessoes s
JOIN ciclo_blocos b ON b.id = s.ciclo_bloco_id
JOIN topicos t ON t.id = s.topico_id
WHERE b.disciplina_id <> t.disciplina_id
UNION ALL
SELECT 'figura_chunk_arquivo', count(*)::bigint
FROM acervo_figuras f
JOIN acervo_chunks c ON c.id = f.chunk_id
WHERE f.arquivo_id <> c.arquivo_id
ORDER BY regra;

-- 7. Duplicidades que impedem constraints recomendadas.
SELECT 'ciclo_blocos(ciclo_id,ordem)' AS chave, count(*)::bigint AS grupos_duplicados
FROM (SELECT ciclo_id, ordem FROM ciclo_blocos GROUP BY ciclo_id, ordem HAVING count(*) > 1) d
UNION ALL
SELECT 'questao_topicos(questao_id,topico_id)', count(*)::bigint
FROM (SELECT questao_id, topico_id FROM questao_topicos GROUP BY questao_id, topico_id HAVING count(*) > 1) d
UNION ALL
SELECT 'simulado_questoes(simulado_id,questao_id)', count(*)::bigint
FROM (SELECT simulado_id, questao_id FROM simulado_questoes GROUP BY simulado_id, questao_id HAVING count(*) > 1) d
UNION ALL
SELECT 'simulado_questoes(simulado_id,ordem)', count(*)::bigint
FROM (SELECT simulado_id, ordem FROM simulado_questoes GROUP BY simulado_id, ordem HAVING count(*) > 1) d
UNION ALL
SELECT 'simulado_areas(simulado_id,area)', count(*)::bigint
FROM (SELECT simulado_id, area FROM simulado_areas GROUP BY simulado_id, area HAVING count(*) > 1) d
UNION ALL
SELECT 'simulado_analise(simulado_id)', count(*)::bigint
FROM (SELECT simulado_id FROM simulado_analise GROUP BY simulado_id HAVING count(*) > 1) d
UNION ALL
SELECT 'acervo_paginas(arquivo_id,numero)', count(*)::bigint
FROM (SELECT arquivo_id, numero FROM acervo_paginas GROUP BY arquivo_id, numero HAVING count(*) > 1) d
UNION ALL
SELECT 'acervo_chunks(arquivo_id,ordem)', count(*)::bigint
FROM (SELECT arquivo_id, ordem FROM acervo_chunks GROUP BY arquivo_id, ordem HAVING count(*) > 1) d
UNION ALL
SELECT 'acervo_arquivos(hash_conteudo)', count(*)::bigint
FROM (SELECT hash_conteudo FROM acervo_arquivos GROUP BY hash_conteudo HAVING count(*) > 1) d
UNION ALL
SELECT 'revisoes_trimestrais(ano,trimestre)', count(*)::bigint
FROM (SELECT ano, trimestre FROM revisoes_trimestrais GROUP BY ano, trimestre HAVING count(*) > 1) d
ORDER BY chave;

-- 8. Volume que exige backfill de ownership antes de qualquer contracao.
SELECT 'ciclos' AS tabela, count(*)::bigint AS registros_sem_owner_explicito FROM ciclos
UNION ALL SELECT 'repertorios', count(*)::bigint FROM repertorios
UNION ALL SELECT 'revisoes_trimestrais', count(*)::bigint FROM revisoes_trimestrais
ORDER BY tabela;

-- 9. Cardinalidades que precisam permanecer unitarias no modelo atual.
SELECT
  count(*) FILTER (WHERE ativo)::bigint AS ciclos_ativos,
  count(*)::bigint AS ciclos_totais
FROM ciclos;

-- 10. Forma e referencias dos arrays JSON de rastreabilidade.
WITH fontes AS (
  SELECT 'materiais'::text AS origem, id AS registro_id, fonte_chunk_ids AS ids FROM materiais WHERE fonte_chunk_ids IS NOT NULL
  UNION ALL SELECT 'perguntas_ativas', id, fonte_chunk_ids FROM perguntas_ativas WHERE fonte_chunk_ids IS NOT NULL
  UNION ALL SELECT 'cards', id, fonte_chunk_ids FROM cards WHERE fonte_chunk_ids IS NOT NULL
  UNION ALL SELECT 'questoes', id, fonte_chunk_ids FROM questoes WHERE fonte_chunk_ids IS NOT NULL
)
SELECT
  origem,
  count(*) FILTER (WHERE jsonb_typeof(ids) <> 'array')::bigint AS json_nao_array
FROM fontes
GROUP BY origem
ORDER BY origem;

WITH fontes AS (
  SELECT 'materiais'::text AS origem, id AS registro_id, fonte_chunk_ids AS ids FROM materiais WHERE fonte_chunk_ids IS NOT NULL
  UNION ALL SELECT 'perguntas_ativas', id, fonte_chunk_ids FROM perguntas_ativas WHERE fonte_chunk_ids IS NOT NULL
  UNION ALL SELECT 'cards', id, fonte_chunk_ids FROM cards WHERE fonte_chunk_ids IS NOT NULL
  UNION ALL SELECT 'questoes', id, fonte_chunk_ids FROM questoes WHERE fonte_chunk_ids IS NOT NULL
), elementos AS (
  SELECT
    origem,
    registro_id,
    elemento.valor
  FROM fontes
  CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(ids) = 'array' THEN ids ELSE '[]'::jsonb END
  ) AS elemento(valor)
), referencias AS (
  SELECT
    origem,
    registro_id,
    valor,
    valor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AS uuid_valido
  FROM elementos
)
SELECT
  r.origem,
  count(*) FILTER (WHERE NOT r.uuid_valido)::bigint AS valores_nao_uuid,
  count(*) FILTER (WHERE r.uuid_valido AND c.id IS NULL)::bigint AS chunks_inexistentes
FROM referencias r
LEFT JOIN acervo_chunks c ON c.id = CASE WHEN r.uuid_valido THEN r.valor::uuid END
GROUP BY r.origem
ORDER BY r.origem;

ROLLBACK;
