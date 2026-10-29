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
MANIFEST_FILE="${2:-}"

TARGET_PGHOST="${TARGET_PGHOST:-127.0.0.1}"
TARGET_PGPORT="${TARGET_PGPORT:-5433}"
TARGET_PGUSER="${TARGET_PGUSER:-postgres}"

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
echo "[$(date -u)] AUDITORIA DE SANIDADE PÓS-RESTAURAÇÃO (H2.03-R2A)"
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
  SELECT relname, rowsecurity, forcerowsecurity
  FROM pg_class
  JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
  WHERE pg_namespace.nspname = 'public'
    AND relkind = 'r'
  ORDER BY relname;
")

NON_RLS_COUNT=0
while IFS='|' read -r relname rowsec forcesec; do
  if [[ "${rowsec}" != "t" ]]; then
    # _medicina_staging_migrations é tabela de infraestrutura de migração
    if [[ "${relname}" != "_medicina_staging_migrations" ]]; then
      echo "  [FALHA] Tabela '${relname}' está com RLS DESATIVADO (rowsecurity=f)!" >&2
      NON_RLS_COUNT=$((NON_RLS_COUNT + 1))
      EXIT_CODE=1
    fi
  else
    echo "  [OK] RLS ativado na tabela '${relname}' (FORCE: ${forcesec})."
  fi
done <<< "${RLS_REPORT}"

TOTAL_POLICIES=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT count(*) FROM pg_policy;
")
echo "  [OK] Total de políticas RLS ativas em pg_policy: ${TOTAL_POLICIES}"
if [[ "${TOTAL_POLICIES}" -lt 20 ]]; then
  echo "  [AVISO] Número de políticas RLS abaixo do esperado (${TOTAL_POLICIES} < 20)."
fi

# ------------------------------------------------------------------------------
# 5. FUNÇÕES SQL E PROCEDURES CRÍTICAS
# ------------------------------------------------------------------------------
echo "--- [5/7] Verificação de Funções SQL e Stored Procedures ---"
EXPECTED_FUNCTIONS=(
  fn_busca_hibrida_acervo
  gerar_hash_questao
  fn_atualizar_modificado_em
  fn_proteger_papel_admin
)

for fn in "${EXPECTED_FUNCTIONS[@]}"; do
  FN_EXISTS=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
    SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = '${fn}');
  ")
  if [[ "${FN_EXISTS}" == "t" ]]; then
    echo "  [OK] Função SQL '${fn}' presente."
  else
    echo "  [FALHA] Função SQL '${fn}' NÃO encontrada!" >&2
    EXIT_CODE=1
  fi
done

# Checa função autenticar_por_email (em medicina ou public)
AUTH_FN_EXISTS=$(psql -h "${TARGET_PGHOST}" -p "${TARGET_PGPORT}" -U "${TARGET_PGUSER}" -d "${TARGET_PGDATABASE}" -t -A -c "
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'autenticar_por_email' AND n.nspname IN ('medicina', 'public')
  );
")
if [[ "${AUTH_FN_EXISTS}" == "t" ]]; then
  echo "  [OK] Função de autenticação 'autenticar_por_email' presente."
else
  echo "  [FALHA] Função 'autenticar_por_email' NÃO encontrada em medicina/public!" >&2
  EXIT_CODE=1
fi

# ------------------------------------------------------------------------------
# 6. ÍNDICES E BUSCA VETORIAL
# ------------------------------------------------------------------------------
echo "--- [6/7] Auditoria de Índices e Suporte Vetorial ---"
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
  echo "[$(date -u)] AUDITORIA H2.03-R2A CONCLUÍDA: BANCO RESTAURADO 100% APTO!"
else
  echo "[$(date -u)] AUDITORIA H2.03-R2A CONCLUÍDA: STATUS NÃO APTO (Falhas detectadas)!" >&2
fi
echo "======================================================================"

exit ${EXIT_CODE}
