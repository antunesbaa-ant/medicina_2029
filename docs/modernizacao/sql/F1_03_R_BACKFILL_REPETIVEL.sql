-- MEDICINA 2029 — F1.03-R
-- Backfill repetivel para executar DEPOIS do cutover da aplicacao compativel
-- e ANTES de qualquer tentativa de contracao. Nao escolhe owners em estados
-- ambiguos e nao sobrescreve owners ja preenchidos.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  estudante_id uuid;
  responsavel_id uuid;
BEGIN
  IF (SELECT count(*) FROM perfis WHERE papel = 'estudante') <> 1
    OR (SELECT count(*) FROM perfis WHERE papel = 'responsavel') <> 1
  THEN
    RAISE EXCEPTION
      'F1.03-R backfill abortado: esperado exatamente um estudante e um responsavel.';
  END IF;

  SELECT id INTO estudante_id FROM perfis WHERE papel = 'estudante';
  SELECT id INTO responsavel_id FROM perfis WHERE papel = 'responsavel';

  IF EXISTS (
    SELECT 1
    FROM perfis interno
    JOIN perfis externo ON externo.auth_user_id = interno.id
    WHERE externo.id <> interno.id
  ) THEN
    RAISE EXCEPTION
      'F1.03-R backfill abortado: colisao cruzada de identidades.';
  END IF;

  IF (SELECT count(*) FROM responsavel_estudante) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM responsavel_estudante
      WHERE responsavel_perfil_id = responsavel_id
        AND estudante_perfil_id = estudante_id
    )
  THEN
    RAISE EXCEPTION
      'F1.03-R backfill abortado: vinculo responsavel-estudante ausente ou divergente.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ciclos
    WHERE estudante_perfil_id IS NOT NULL
      AND estudante_perfil_id <> estudante_id
  ) OR EXISTS (
    SELECT 1 FROM repertorios
    WHERE perfil_id IS NOT NULL
      AND perfil_id <> estudante_id
  ) OR EXISTS (
    SELECT 1 FROM revisoes_trimestrais
    WHERE (estudante_perfil_id IS NOT NULL AND estudante_perfil_id <> estudante_id)
       OR (registrada_por_perfil_id IS NOT NULL AND registrada_por_perfil_id <> responsavel_id)
  ) THEN
    RAISE EXCEPTION
      'F1.03-R backfill abortado: owner preenchido diverge do vinculo autorizado.';
  END IF;

  UPDATE ciclos
  SET estudante_perfil_id = estudante_id
  WHERE estudante_perfil_id IS NULL;

  UPDATE repertorios
  SET perfil_id = estudante_id
  WHERE perfil_id IS NULL;

  UPDATE revisoes_trimestrais
  SET estudante_perfil_id = COALESCE(estudante_perfil_id, estudante_id),
      registrada_por_perfil_id = COALESCE(registrada_por_perfil_id, responsavel_id)
  WHERE estudante_perfil_id IS NULL OR registrada_por_perfil_id IS NULL;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ciclos WHERE estudante_perfil_id IS NULL)
    OR EXISTS (SELECT 1 FROM repertorios WHERE perfil_id IS NULL)
    OR EXISTS (
      SELECT 1 FROM revisoes_trimestrais
      WHERE estudante_perfil_id IS NULL OR registrada_por_perfil_id IS NULL
    )
  THEN
    RAISE EXCEPTION
      'F1.03-R backfill abortado: valores nulos permaneceram apos o preenchimento.';
  END IF;
END
$$;

COMMIT;
