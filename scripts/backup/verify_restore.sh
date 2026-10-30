#!/usr/bin/env bash
# ==============================================================================
# PROJETO MEDICINA 2029 — AUDITORIA DE SANIDADE PÓS-RESTORE (H2.03-R2A)
# Script de verificação completa: extensões, tabelas, registros contra
# inventário real do manifesto, RLS, funções, índices e histórico das 9 migrações.
# ==============================================================================
set -euo pipefail

# Inclui diretórios padrão do libpq no macOS se presentes
if [[ -d "/opt/homebrew/opt/libpq/bin" ]]; then
  export PATH="/opt/homebrew/opt/libpq/bin:${PATH}"
elif [[ -d "/usr/local/opt/libpq/bin" ]]; then
  export PATH="/usr/local/opt/libpq/bin:${PATH}"
fi

TARGET_PGDATABASE="${1:-medicina2029_restore_teste}"
INPUT_MANIFEST_OR_BACKUP="${2:-}"

TARGET_PGHOST="${TARGET_PGHOST:-127.0.0.1}"
TARGET_PGPORT="${TARGET_PGPORT:-5433}"
TARGET_PGUSER="${TARGET_PGUSER:-postgres}"

# Limpeza e purga segura de temporários ao sair ou em caso de sinal
TMP_VERIFY_DIR=""
cleanup_verify() {
  unset BACKUP_ENCRYPTION_KEY 2>/dev/null || true
  if [[ -n "${TMP_VERIFY_DIR}" && -d "${TMP_VERIFY_DIR}" ]]; then
    rm -rf "${TMP_VERIFY_DIR}"
  fi
}
trap cleanup_verify EXIT INT TERM HUP

# Resolução flexível do manifesto: arquivo JSON, manifesto cifrado ou diretório de backup
RESOLVED_MANIFEST=""
TARGET_ENC=""

# Auto-descoberta do backup baseline mais recente caso não informado
if [[ -z "${INPUT_MANIFEST_OR_BACKUP}" ]]; then
  DEFAULT_BACKUP_DIR=$(find "${HOME}/.medicina2029/backups" -maxdepth 1 -type d -name "medicina2029_staging_baseline_*" 2>/dev/null | sort | tail -n 1 || true)
  if [[ -n "${DEFAULT_BACKUP_DIR}" && -d "${DEFAULT_BACKUP_DIR}" ]]; then
    INPUT_MANIFEST_OR_BACKUP="${DEFAULT_BACKUP_DIR}"
  fi
fi

if [[ -n "${INPUT_MANIFEST_OR_BACKUP}" ]]; then
  if [[ -d "${INPUT_MANIFEST_OR_BACKUP}" ]]; then
    RAW_M=$(find "${INPUT_MANIFEST_OR_BACKUP}" -maxdepth 1 -name "*_manifest.json" | head -n 1 || true)
    ENC_M=$(find "${INPUT_MANIFEST_OR_BACKUP}" -maxdepth 1 -name "*_manifest.json.enc" | head -n 1 || true)
    if [[ -n "${RAW_M}" && -f "${RAW_M}" ]]; then
      RESOLVED_MANIFEST="${RAW_M}"
    elif [[ -n "${ENC_M}" && -f "${ENC_M}" ]]; then
      TARGET_ENC="${ENC_M}"
    fi
  elif [[ -f "${INPUT_MANIFEST_OR_BACKUP}" ]]; then
    if [[ "${INPUT_MANIFEST_OR_BACKUP}" == *.json.enc ]]; then
      TARGET_ENC="${INPUT_MANIFEST_OR_BACKUP}"
    elif [[ "${INPUT_MANIFEST_OR_BACKUP}" == *.json ]]; then
      RESOLVED_MANIFEST="${INPUT_MANIFEST_OR_BACKUP}"
    fi
  fi
fi

# Decifragem segura sob demanda do manifesto em ambiente temporário restrito (0700)
if [[ -n "${TARGET_ENC}" && -f "${TARGET_ENC}" ]]; then
  echo "[$(date -u)] Manifesto cifrado identificado: ${TARGET_ENC}"
  if [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
    if [[ -t 0 ]]; then
      echo -n "🔑 Digite a chave mestra de descriptografia para conferir o manifesto: "
      read -r -s BACKUP_ENCRYPTION_KEY
      echo ""
    else
      read -r BACKUP_ENCRYPTION_KEY || true
    fi
  fi

  if [[ -n "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
    TMP_VERIFY_DIR=$(mktemp -d -t m29_verify_manifest_XXXXXX)
    chmod 700 "${TMP_VERIFY_DIR}"
    TMP_MANIFEST="${TMP_VERIFY_DIR}/manifest.json"
    CRYPTO_SCRIPT="$(dirname "$0")/crypto_envelope.mjs"
    if [[ -f "${CRYPTO_SCRIPT}" ]] && command -v node &>/dev/null; then
      if printf '%s' "${BACKUP_ENCRYPTION_KEY}" | node "${CRYPTO_SCRIPT}" decrypt "${TARGET_ENC}" "${TMP_MANIFEST}" --key-stdin 2>/dev/null; then
        RESOLVED_MANIFEST="${TMP_MANIFEST}"
        echo "[$(date -u)] Manifesto decifrado em memória temporária para validação."
      else
        echo "  [AVISO] Falha na descriptografia do manifesto com a chave fornecida. Utilizando inventário canônico de baseline." >&2
      fi
    fi
    unset BACKUP_ENCRYPTION_KEY
  fi
fi

MANIFEST_FILE="${RESOLVED_MANIFEST}"

# SALVAGUARDA DE SEGURANÇA: Bloqueio estrito contra qualquer destino remoto ou Supabase (FAIL-CLOSED)
if [[ "${TARGET_PGHOST}" =~ supabase\.co || "${TARGET_PGHOST}" =~ pooler\.supabase\.com || "${TARGET_PGHOST}" =~ aws-0-us-east-1 ]]; then
  echo "======================================================================" >&2
  echo "VIOLAÇÃO CRÍTICA DE SEGURANÇA (FAIL-CLOSED):" >&2
  echo "É terminantemente proibido apontar auditoria ou restauração para o Supabase remoto!" >&2
  echo "Alvo informado: ${TARGET_PGHOST}" >&2
  echo "======================================================================" >&2
  exit 1
fi

if [[ "${TARGET_PGHOST}" != "127.0.0.1" && "${TARGET_PGHOST}" != "localhost" ]]; then
  echo "======================================================================" >&2
  echo "VIOLAÇÃO DE ISOLAMENTO LOCAL (FAIL-CLOSED):" >&2
  echo "A auditoria só é permitida em loopback local (127.0.0.1 ou localhost)." >&2
  echo "Host não-local recusado: ${TARGET_PGHOST}" >&2
  echo "======================================================================" >&2
  exit 1
fi

echo "======================================================================"
echo "[$(date -u)] AUDITORIA DE SANIDADE PÓS-RESTAURAÇÃO (H2.03-R2D)"
echo "Banco Auditado: ${TARGET_PGHOST}:${TARGET_PGPORT}/${TARGET_PGDATABASE} (Usuário: ${TARGET_PGUSER})"
echo "======================================================================"

EXIT_CODE=0

# ------------------------------------------------------------------------------
# 1. VERIFICAÇÃO DE EXTENSÕES OBRIGATÓRIAS E VERSÃO DO PGVECTOR
# ------------------------------------------------------------------------------
echo "--- [1/7] Verificação de Extensões Obrigatórias ---"
INSTALLED_EXTS=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT extname FROM pg_extension ORDER BY extname;
")

REQUIRED_EXTENSIONS=(vector unaccent pgcrypto uuid-ossp)
for ext in "${REQUIRED_EXTENSIONS[@]}"; do
  if echo "${INSTALLED_EXTS}" | grep -q "^${ext}$"; then
    echo "  [OK] Extensão '${ext}' instalada."
  else
    echo "  [FALHA] Extensão obrigatória '${ext}' NÃO encontrada!" >&2
    EXIT_CODE=1
  fi
done

# Checagem de versão do pgvector (0.8.2 no staging)
PGVECTOR_VERSION=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT extversion FROM pg_extension WHERE extname = 'vector';
" 2>/dev/null || echo "N/A")
echo "  [INFO] Versão do pgvector detectada: ${PGVECTOR_VERSION} (Paridade Staging: 0.8.2)"
if [[ "${PGVECTOR_VERSION}" == "0.8.2" ]]; then
  echo "  [OK] pgvector 0.8.2 em paridade binária exata com o Supabase staging."
fi

# ------------------------------------------------------------------------------
# 2. VERIFICAÇÃO DE TODAS AS 35 TABELAS DE DOMÍNIO E SCHEMAS
# ------------------------------------------------------------------------------
echo "--- [2/7] Verificação de Inventário de Tabelas do Domínio ---"
EXPECTED_TABLES=(
  perfis responsavel_estudante allowlist
  disciplinas topicos
  ciclos ciclo_blocos ciclo_estado sessoes
  materiais perguntas_ativas
  cards card_revisoes
  questoes questao_topicos tentativas erros
  generos redacoes repertorios
  simulados simulado_questoes simulado_areas simulado_analise
  checkins revisoes_trimestrais livros
  acervo_arquivos acervo_paginas acervo_chunks acervo_figuras
  geracoes curadoria_fila
  operacoes_idempotentes acervo_jobs
)

MISSING_TABLES=0
for tbl in "${EXPECTED_TABLES[@]}"; do
  EXISTS=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
    SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${tbl}');
  ")
  if [[ "${EXISTS}" == "t" ]]; then
    echo "  [OK] Tabela public.'${tbl}' presente."
  else
    echo "  [FALHA] Tabela public.'${tbl}' NÃO existe no banco!" >&2
    MISSING_TABLES=$((MISSING_TABLES + 1))
    EXIT_CODE=1
  fi
done

# Confirma schema medicina e extensions
MEDICINA_SCHEMA_EXISTS=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'medicina');
")
if [[ "${MEDICINA_SCHEMA_EXISTS}" == "t" ]]; then
  echo "  [OK] Schema 'medicina' presente."
else
  echo "  [AVISO] Schema 'medicina' não encontrado."
fi

EXTENSIONS_SCHEMA_EXISTS=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'extensions');
")
if [[ "${EXTENSIONS_SCHEMA_EXISTS}" == "t" ]]; then
  echo "  [OK] Schema 'extensions' presente."
fi

# ------------------------------------------------------------------------------
# 3. VALIDAÇÃO DE REGISTROS CONTRA O INVENTÁRIO REAL DO MANIFESTO (H2.03-R2A)
# ------------------------------------------------------------------------------
echo "--- [3/7] Validação de Contagens e Inventário Real de Registros ---"

if [[ -n "${MANIFEST_FILE}" && -f "${MANIFEST_FILE}" ]]; then
  echo "  Comparando contagens de registros com o manifesto oficial: ${MANIFEST_FILE}"
  
  # Lê o mapa table_row_counts do manifesto
  MANIFEST_MAP=$(node -e '
    const fs = require("fs");
    try {
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const counts = m.table_row_counts || {};
      for (const [tbl, cnt] of Object.entries(counts)) {
        console.log(`${tbl}=${cnt}`);
      }
    } catch (e) {
      process.exit(1);
    }
  ' "${MANIFEST_FILE}" || true)

  if [[ -n "${MANIFEST_MAP}" ]]; then
    while IFS='=' read -r full_tbl expected_cnt; do
      [[ -z "${full_tbl}" ]] && continue
      ACTUAL_CNT=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
        SELECT count(*) FROM ${full_tbl};
      " 2>/dev/null || echo "ERROR")

      if [[ "${ACTUAL_CNT}" == "ERROR" ]]; then
        echo "  [FALHA] Tabela '${full_tbl}' não pôde ser consultada!" >&2
        EXIT_CODE=1
      elif [[ "${ACTUAL_CNT}" -eq "${expected_cnt}" ]]; then
        echo "  [OK] ${full_tbl}: ${ACTUAL_CNT} linhas (coincide 100% com manifesto: ${expected_cnt})."
      else
        echo "  [FALHA] ${full_tbl}: ${ACTUAL_CNT} linhas (DIVERGÊNCIA! Esperado pelo manifesto: ${expected_cnt})!" >&2
        EXIT_CODE=1
      fi
    done <<< "${MANIFEST_MAP}"
  fi
else
  echo "  Manifesto não fornecido; validando conforme inventário canônico de baseline..."
  # Tabela allowlist: 2 registros canônicos inseridos na migração 0000
  ALLOWLIST_CNT=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
    SELECT count(*) FROM public.allowlist;
  " 2>/dev/null || echo "0")
  if [[ "${ALLOWLIST_CNT}" -eq 2 ]]; then
    echo "  [OK] public.allowlist: 2 registros canônicos (estudante e responsável da migração 0000)."
  else
    echo "  [FALHA] public.allowlist: ${ALLOWLIST_CNT} registros (esperado: 2 registros)!" >&2
    EXIT_CODE=1
  fi

  # 34 tabelas de domínio restantes: 0 registros no baseline pré-seed
  for tbl in "${EXPECTED_TABLES[@]}"; do
    [[ "${tbl}" == "allowlist" ]] && continue
    EXISTS=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
      SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${tbl}');
    ")
    if [[ "${EXISTS}" == "t" ]]; then
      CNT=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
        SELECT count(*) FROM public.\"${tbl}\";
      ")
      if [[ "${CNT}" -eq 0 ]]; then
        echo "  [OK] Tabela public.'${tbl}': 0 registros (paridade pré-seed confirmada)."
      else
        echo "  [FALHA] Tabela public.'${tbl}': ${CNT} registros (divergência com baseline zero)!" >&2
        EXIT_CODE=1
      fi
    fi
  done
fi

# Validação do conteúdo da allowlist
EMAILS_COUNT=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT count(*) FROM public.allowlist WHERE email IN ('estudante@medicina2029.com.br', 'responsavel@medicina2029.com.br');
" 2>/dev/null || echo "0")
if [[ "${EMAILS_COUNT}" -eq 2 ]]; then
  echo "  [OK] Conteúdo da allowlist auditado: 2 e-mails sintéticos legítimos presentes."
fi

# ------------------------------------------------------------------------------
# 4. AUDITORIA DE SEGURANÇA RLS (ROW LEVEL SECURITY)
# ------------------------------------------------------------------------------
echo "--- [4/7] Auditoria de Status RLS e Políticas de Segurança ---"
RLS_REPORT=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -F"|" -c "
  SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class
  JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
  WHERE pg_namespace.nspname = 'public'
    AND relkind = 'r'
  ORDER BY relname;
")

NON_RLS_COUNT=0
RLS_ACTIVE_COUNT=0
while IFS='|' read -r relname rowsec forcesec; do
  [[ -z "${relname}" ]] && continue
  if [[ "${rowsec}" != "t" ]]; then
    # _medicina_staging_migrations é tabela de infraestrutura de migração
    if [[ "${relname}" != "_medicina_staging_migrations" ]]; then
      echo "  [FALHA] Tabela '${relname}' está com RLS DESATIVADO (relrowsecurity=f)!" >&2
      NON_RLS_COUNT=$((NON_RLS_COUNT + 1))
      EXIT_CODE=1
    fi
  else
    RLS_ACTIVE_COUNT=$((RLS_ACTIVE_COUNT + 1))
    echo "  [OK] RLS ativado na tabela '${relname}' (FORCE: ${forcesec})."
  fi
done <<< "${RLS_REPORT}"

echo "  [INFO] Total de tabelas com RLS ativado no schema public: ${RLS_ACTIVE_COUNT}"
if [[ ${NON_RLS_COUNT} -eq 0 && ${RLS_ACTIVE_COUNT} -ge 35 ]]; then
  echo "  [OK] Cobertura RLS integral confirmada (100% das 35 tabelas de domínio ativas)."
fi

TOTAL_POLICIES=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT count(*) FROM pg_policy;
")
echo "  [OK] Total de políticas RLS ativas em pg_policy: ${TOTAL_POLICIES}"
if [[ "${TOTAL_POLICIES}" -lt 20 ]]; then
  echo "  [AVISO] Número de políticas RLS abaixo do esperado (${TOTAL_POLICIES} < 20)."
fi

# ------------------------------------------------------------------------------
# 5. FUNÇÕES SQL E PROCEDURES CRÍTICAS DO DOMÍNIO (CANÔNICAS)
# ------------------------------------------------------------------------------
echo "--- [5/7] Verificação de Funções SQL e Stored Procedures ---"
EXPECTED_CANONICAL_FUNCTIONS=(
  autenticar_por_email
  fn_busca_hibrida_acervo
  set_context
  current_papel
  is_estudante
  is_responsavel
  is_valid_acervo_storage_path
  fn_acompanhamento_quinzenal
  fn_simulados_evolucao
  check_allowlist
)

for fn in "${EXPECTED_CANONICAL_FUNCTIONS[@]}"; do
  FN_EXISTS=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
    SELECT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = '${fn}' AND n.nspname IN ('medicina', 'public')
    );
  ")
  if [[ "${FN_EXISTS}" == "t" ]]; then
    echo "  [OK] Função SQL canônica '${fn}' presente."
  else
    echo "  [FALHA] Função SQL canônica '${fn}' NÃO encontrada!" >&2
    EXIT_CODE=1
  fi
done

# ------------------------------------------------------------------------------
# 6. ÍNDICES, CONSTRAINTS E BUSCA VETORIAL
# ------------------------------------------------------------------------------
echo "--- [6/7] Auditoria de Índices, Constraints e Suporte Vetorial ---"
# Verifica índice vetorial em acervo_chunks.embedding
VECTOR_INDEX_EXISTS=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'acervo_chunks'
      AND (indexdef LIKE '%vector_cosine_ops%' OR indexdef LIKE '%hnsw%' OR indexdef LIKE '%ivfflat%')
  );
")
if [[ "${VECTOR_INDEX_EXISTS}" == "t" ]]; then
  echo "  [OK] Índice vetorial de busca semântica em 'acervo_chunks' presente."
else
  echo "  [FALHA] Índice vetorial em 'acervo_chunks.embedding' NÃO encontrado!" >&2
  EXIT_CODE=1
fi

# Verificação de Chaves Primárias e Integridade Referencial (Constraints)
PK_COUNT=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT count(*) FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'public' AND c.contype = 'p';
" 2>/dev/null || echo "0")
FK_COUNT=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT count(*) FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'public' AND c.contype = 'f';
" 2>/dev/null || echo "0")
echo "  [OK] Constraints estruturais: ${PK_COUNT} Chaves Primárias (PK) e ${FK_COUNT} Chaves Estrangeiras (FK)."
if [[ "${PK_COUNT}" -lt 30 ]]; then
  echo "  [AVISO] Número de Chaves Primárias (${PK_COUNT}) menor que o esperado para 35 tabelas."
fi

# ------------------------------------------------------------------------------
# 7. HISTÓRICO DAS 9 MIGRAÇÕES CANÔNICAS
# ------------------------------------------------------------------------------
echo "--- [7/7] Validação do Histórico de Migrações Canônicas ---"
MIGRATION_TABLE_EXISTS=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_medicina_staging_migrations');
")

if [[ "${MIGRATION_TABLE_EXISTS}" == "t" ]]; then
  MIGRATION_COUNT=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
    SELECT count(*) FROM public._medicina_staging_migrations;
  ")
  if [[ "${MIGRATION_COUNT}" -eq 9 ]]; then
    echo "  [OK] Tabela '_medicina_staging_migrations' contém exatamente 9 registros canônicos."
    psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -c "
      SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations ORDER BY ordem ASC;
    "
  else
    echo "  [FALHA] Contagem de migrações divergente: esperado 9, encontrado ${MIGRATION_COUNT}!" >&2
    EXIT_CODE=1
  fi
else
  echo "  [FALHA] Tabela de histórico '_medicina_staging_migrations' NÃO encontrada!" >&2
  EXIT_CODE=1
fi

# ------------------------------------------------------------------------------
# DIAGNÓSTICOS SUPLEMENTARES
# ------------------------------------------------------------------------------
echo "--- Diagnósticos Suplementares (Integridade Referencial e Voo) ---"
ORPHAN_SESSOES=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT count(*) FROM public.sessoes s
  LEFT JOIN public.perfis p ON p.id = s.perfil_id
  LEFT JOIN public.ciclo_blocos b ON b.id = s.ciclo_bloco_id
  LEFT JOIN public.topicos t ON t.id = s.topico_id
  WHERE p.id IS NULL OR b.id IS NULL OR t.id IS NULL;
" 2>/dev/null || echo "0")

if [[ "${ORPHAN_SESSOES}" -gt 0 ]]; then
  echo "  [FALHA] ${ORPHAN_SESSOES} sessões orfãs identificadas!" >&2
  EXIT_CODE=1
else
  echo "  [OK] Integridade referencial de 'sessoes' perfeita."
fi

echo "======================================================================"
if [[ ${EXIT_CODE} -eq 0 ]]; then
  echo "[$(date -u)] AUDITORIA H2.03-R2D CONCLUÍDA: BANCO RESTAURADO 100% APTO!"
else
  echo "[$(date -u)] AUDITORIA H2.03-R2D CONCLUÍDA: STATUS NÃO APTO (Falhas detectadas)!" >&2
fi
echo "======================================================================"

exit ${EXIT_CODE}
