#!/usr/bin/env node

/**
 * ==============================================================================
 * MEDICINA 2029 — H2.04: PREPARAÇÃO DA HOMOLOGAÇÃO FUNCIONAL
 * ==============================================================================
 * Gerenciador e Lançador Seguro para Homologação Funcional com Dados 100% Sintéticos
 * no Supabase Staging (ynfocaorhadizlvbnzrt).
 *
 * Princípios de Governança e Segurança:
 * 1. Zero PII: Dados exclusivamente artificiais e determinísticos (RFC 4122 v4).
 * 2. Três Personas Didáticas:
 *    - Alice (Estudante Tutelada);
 *    - Bruno (Responsável Tutor de Alice);
 *    - Carlos (Segundo Estudante Independente — Prova de Isolamento e Zero Leakage).
 * 3. Matriz de Segurança e RLS:
 *    - Fronteira hermética entre estudantes (Alice não vê Carlos; Carlos não vê Alice);
 *    - Responsável acessa apenas o estudante vinculado (Bruno vê Alice; Bruno NÃO vê Carlos);
 *    - Visão agregada quinzenal (Princípio 1.2 da ESPEC: zero acesso a sessões individuais brutas);
 *    - Bloqueio de escalada de privilégios.
 * 4. Conexão e TLS Estrito:
 *    - Conexão exclusiva ao Session Pooler aws-0-us-east-1.pooler.supabase.com:5432;
 *    - Rejeição absoluta a endpoints produtivos;
 *    - Validação de certificado CA prod-ca-2021.crt com fingerprint SHA-256 canônico;
 *    - Entrada de senhas oculta no terminal (sem eco, sem histórico, sem argv).
 * 5. Procedimento de Limpeza Completa (Cleanup/Teardown):
 *    - Expurgo reversível e atômico de 100% dos registros sintéticos;
 *    - Retorno do banco staging exatamente ao baseline inicial auditado.
 * ==============================================================================
 */

import crypto from 'node:crypto';
import readline from 'node:readline';
import tls from 'node:tls';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

import {
  resolveCaCertificate,
  promptHiddenPassword,
  buildStagingPoolerUrl,
  sanitizeError,
} from './test-staging-connection.mjs';
import { getMigrationManifest } from './migrate-staging.mjs';

// ----------------------------------------------------------------------------
// CONFIGURAÇÕES DO ALVO STAGING
// ----------------------------------------------------------------------------
export const TARGET_HOST = 'aws-0-us-east-1.pooler.supabase.com';
export const TARGET_PORT = 5432;
export const TARGET_DB = 'postgres';
export const TARGET_ROLE = 'postgres';
export const TARGET_PROJECT_REF = 'ynfocaorhadizlvbnzrt';
export const TARGET_USERNAME = `${TARGET_ROLE}.${TARGET_PROJECT_REF}`;

/**
 * Tabelas estruturais canônicas obrigatórias no baseline de Staging
 */
export const CANONICAL_CORE_TABLES = [
  'perfis',
  'allowlist',
  'ciclos',
  'ciclo_blocos',
  'ciclo_estado',
  'cards',
  'card_revisoes',
  'acervo_arquivos',
  'acervo_paginas',
  'acervo_chunks',
  'acervo_jobs',
  'responsavel_estudante',
  'disciplinas',
  'topicos',
  'sessoes',
  'tentativas',
  'erros',
  'operacoes_idempotentes',
];

/**
 * Validação estrita de configuração e parâmetros da conexão de Staging (Pré-Conexão)
 * Exige correspondência EXATA com o host, porta, db, usuário e project ref canônicos.
 * @param {string | object} configOrUrl
 * @returns {{ valid: boolean, host: string, port: number, db: string, user: string, projectRef: string }}
 */
export function validateStagingConnectionConfig(configOrUrl) {
  let host, port, db, user;

  if (typeof configOrUrl === 'string') {
    let parsed;
    try {
      parsed = new URL(configOrUrl);
    } catch (err) {
      throw new Error(`VIOLAÇÃO DE CONFIGURAÇÃO: URL de conexão inválida: ${sanitizeError(err)}`);
    }
    host = parsed.hostname;
    port = parsed.port ? parseInt(parsed.port, 10) : 5432;
    db = parsed.pathname.replace(/^\//, '');
    user = decodeURIComponent(parsed.username);
  } else if (configOrUrl && typeof configOrUrl === 'object') {
    host = configOrUrl.host;
    port = configOrUrl.port ? parseInt(configOrUrl.port, 10) : 5432;
    db = configOrUrl.database || configOrUrl.db;
    user = configOrUrl.user || configOrUrl.username;
  } else {
    throw new Error('VIOLAÇÃO DE CONFIGURAÇÃO: Parâmetro de conexão inválido.');
  }

  // 1. Host estrito (Session Pooler aws-0-us-east-1.pooler.supabase.com)
  if (host !== TARGET_HOST) {
    throw new Error(
      `VIOLAÇÃO DE HOST: Host de conexão "${host}" inválido. Esperado estritamente o Session Pooler "${TARGET_HOST}".`
    );
  }

  // 2. Porta estrita (5432 = Session Pooler; porta 6543 = transaction pooler rejeitada)
  if (port !== TARGET_PORT) {
    throw new Error(
      `VIOLAÇÃO DE PORTA: Porta "${port}" inválida. Esperada estritamente a porta 5432 do Session Pooler.`
    );
  }

  // 3. Banco estrito (postgres)
  if (db !== TARGET_DB) {
    throw new Error(
      `VIOLAÇÃO DE BANCO: Banco "${db}" inválido. Esperado estritamente o banco "${TARGET_DB}".`
    );
  }

  // 4. Usuário da conexão com tenant project_ref estrito
  if (user !== TARGET_USERNAME) {
    throw new Error(
      `VIOLAÇÃO DE USUÁRIO: Usuário de conexão "${user}" inválido. Esperado estritamente "${TARGET_USERNAME}".`
    );
  }

  // 5. Verificação explícita do sufixo do projeto
  if (!user.endsWith(`.${TARGET_PROJECT_REF}`)) {
    throw new Error(
      `VIOLAÇÃO DE TENANT: Usuário "${user}" não referencia o projeto de staging "${TARGET_PROJECT_REF}".`
    );
  }

  return {
    valid: true,
    host,
    port,
    db,
    user,
    projectRef: TARGET_PROJECT_REF,
  };
}

// ----------------------------------------------------------------------------
// IDENTIFICADORES CANÔNICOS DETERMINÍSTICOS (RFC 4122 v4)
// ----------------------------------------------------------------------------
export const PERSONA_ALICE = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'alice@medicina2029.staging',
  nome: 'Alice Estudante Sintética',
  papel: 'estudante',
  descricao: 'Estudante regular vinculada ao responsável Bruno',
};

export const PERSONA_BRUNO = {
  id: '20000000-0000-4000-8000-000000000001',
  email: 'bruno@medicina2029.staging',
  nome: 'Bruno Responsável Sintético',
  papel: 'responsavel',
  descricao: 'Responsável e tutor pedagógico exclusivo de Alice',
};

export const PERSONA_CARLOS = {
  id: '30000000-0000-4000-8000-000000000001',
  email: 'carlos@medicina2029.staging',
  nome: 'Carlos Estudante Sintético Independente',
  papel: 'estudante',
  descricao: 'Segundo estudante independente para teste de isolamento RLS e zero vazamento',
};

export const STAGING_ALICE_CICLO_ID = '40000000-0000-4000-8000-000000000001';
export const STAGING_CARLOS_CICLO_ID = '40000000-0000-4000-8000-000000000003';
export const STAGING_ARQUIVO_ID = 'f0000000-0000-4000-8000-000000000001';

export const STAGING_ALICE_BLOCO_IDS = Array.from(
  { length: 28 },
  (_, i) => `41000000-0000-4000-8000-${(i + 1).toString().padStart(12, '0')}`
);
export const STAGING_CARLOS_BLOCO_IDS = Array.from(
  { length: 28 },
  (_, i) => `42000000-0000-4000-8000-${(i + 1).toString().padStart(12, '0')}`
);

export const STAGING_ALICE_CARD_IDS = [
  'c1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000003',
];
export const STAGING_CARLOS_CARD_IDS = [
  'c2000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000002',
];

/**
 * Controle de Operações Físicas no Supabase Storage:
 * Operações na API REST do Storage não integram a transação PostgreSQL.
 * Na primeira homologação, uploads e deleções físicas de blobs estão DESABILITADAS.
 * Apenas metadados em public.acervo_arquivos são manipulados transacionalmente.
 */
export const STORAGE_OPERATIONS_ENABLED = false;

// ----------------------------------------------------------------------------
// CLASSIFICAÇÃO DE FUNCIONALIDADES (ESTADO ATUAL)
// ----------------------------------------------------------------------------
export const FEATURE_STATUS_MATRIX = {
  prontas: [
    {
      modulo: 'Autenticação e Sessão',
      descricao: 'Login/logout via NextAuth Credentials com medicina.autenticar_por_email e hash bcrypt de tempo constante.',
      pronto: true,
      seguranca: 'Mitigação de timing side-channels via hash benchmark canônico.'
    },
    {
      modulo: 'Proteção de Rotas',
      descricao: 'NextAuth Middleware protegendo rotas privadas contra requisições anônimas.',
      pronto: true,
      seguranca: 'Fail-closed com redirecionamento compulsório para /login.'
    },
    {
      modulo: 'Autorização e RLS',
      descricao: 'Contexto RLS transacional via medicina.set_context(uuid, papel) com SET LOCAL.',
      pronto: true,
      seguranca: 'Rejeição P0001 para descompasso de papel; zero vazamento cross-tenant.'
    },
    {
      modulo: 'Vínculo Responsável-Estudante',
      descricao: 'Tabela public.responsavel_estudante e função medicina.current_managed_estudante_id().',
      pronto: true,
      seguranca: 'Responsável acessa unicamente o estudante vinculado; bloqueio total a outros estudantes.'
    },
    {
      modulo: 'Acompanhamento Quinzenal',
      descricao: 'View agregada public.vw_acompanhamento_quinzenal.',
      pronto: true,
      seguranca: 'Princípio 1.2 da ESPEC: zero acesso a sessões individuais brutas pelo responsável.'
    },
    {
      modulo: 'Ciclo de Estudos',
      descricao: 'Gestão de 28 blocos pedagógicos, cálculo modular de ordem e reconciliação por advisory lock.',
      pronto: true,
      seguranca: 'Isolamento por estudantePerfilId via RLS.'
    },
    {
      modulo: 'Sessões de Estudo e Cronômetro',
      descricao: 'Início, atualização com teto temporal do servidor e conclusão de sessões.',
      pronto: true,
      seguranca: 'pg_advisory_xact_lock contra duplicação de cliques; anti-adulteração de relógio cliente.'
    },
    {
      modulo: 'Caderno de Erros',
      descricao: 'Registro e filtragem relacional de erros de estudo.',
      pronto: true,
      seguranca: 'Acesso restrito ao estudante autor.'
    },
    {
      modulo: 'Flashcards FSRS',
      descricao: 'Algoritmo de repetição espaçada FSRS (estabilidade, dificuldade, agendamento de revisão).',
      pronto: true,
      seguranca: 'Estados new, learning, review, relearning vinculados estritamente ao perfilId.'
    }
  ],
  dependentesInfraestrutura: [
    {
      modulo: 'Supabase Storage (Acervo Privado)',
      descricao: 'Bucket privado "acervo" com upload assinado e download protegido por tokens de vida curta.',
      dependencia: 'Requer bucket acervo configurado e policies de storage aplicadas (migração Step 7).',
      comportamento: 'Fallback estrutural registra metadados em acervo_arquivos com hash SHA-256 e tamanho exato.'
    },
    {
      modulo: 'Fila de Ingestão de Documentos',
      descricao: 'Fila transacional acervo_jobs com advisory lock e controle de tentativas.',
      dependencia: 'Requer worker de background ativo ou invocação sob demanda controlada.',
      comportamento: 'Tabela estruturada no banco com idempotência e retry exponencial.'
    },
    {
      modulo: 'Busca Semântica Híbrida',
      descricao: 'Busca combinada (Full-Text Search + pgvector HNSW via fn_busca_hibrida_acervo).',
      dependencia: 'Busca textual full-text opera nativamente; busca vetorial depende de embeddings de 1536 dimensões.',
      comportamento: 'Fallback gracioso para busca textual e sanitização com teto de 500 caracteres.'
    }
  ],
  pendentesOuMockadas: [
    {
      modulo: 'API Externa do Gemini',
      descricao: 'Geração de questões, flashcards e extração semântica com IA.',
      status: 'Mockada/Desativada em homologação baseline (restrição de custo zero).',
      plano: 'Utilização de mocks determinísticos e artefatos sintéticos pré-calculados.'
    },
    {
      modulo: 'OCR de PDFs Digitalizados',
      descricao: 'Extração visual de documentos sem camada de texto nativa.',
      status: 'Mockado para 100% dos testes (usam PDFs sintéticos nativos com texto embutido).',
      plano: 'Processamento nativo direto do fluxo de texto PDF 1.4.'
    },
    {
      modulo: 'Disparo de E-mails Transacionais',
      descricao: 'Envio de convites e links de recuperação de senha.',
      status: 'Controlado via allowlist estática de staging.',
      plano: 'Sem envio de e-mails reais; credenciais são injetadas de forma controlada.'
    }
  ]
};

// ----------------------------------------------------------------------------
// GERADOR DE PDF SINTÉTICO (PDF 1.4 DETERMINÍSTICO)
// ----------------------------------------------------------------------------
export function createSyntheticPdfBuffer(title, bodyText) {
  const contentStream = `BT
/F1 14 Tf
72 720 Td
(${title.replace(/[()\\]/g, '\\$&')}) Tj
0 -28 Td
/F1 11 Tf
(${bodyText.replace(/[()\\]/g, '\\$&')}) Tj
ET`;

  const streamLength = Buffer.byteLength(contentStream, 'utf8');

  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  const obj3 =
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n';
  const obj4 = '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  const obj5 = `5 0 obj\n<< /Length ${streamLength} >>\nstream\n${contentStream}\nendstream\nendobj\n`;

  const header = '%PDF-1.4\n';

  const offset1 = Buffer.byteLength(header, 'utf8');
  const offset2 = offset1 + Buffer.byteLength(obj1, 'utf8');
  const offset3 = offset2 + Buffer.byteLength(obj2, 'utf8');
  const offset4 = offset3 + Buffer.byteLength(obj3, 'utf8');
  const offset5 = offset4 + Buffer.byteLength(obj4, 'utf8');
  const startXref = offset5 + Buffer.byteLength(obj5, 'utf8');

  const pad = (n) => n.toString().padStart(10, '0');

  const xref = `xref
0 6
0000000000 65535 f \r
${pad(offset1)} 00000 n \r
${pad(offset2)} 00000 n \r
${pad(offset3)} 00000 n \r
${pad(offset4)} 00000 n \r
${pad(offset5)} 00000 n \r
trailer
<< /Size 6 /Root 1 0 R >>
startxref
${startXref}
%%EOF`;

  return Buffer.from(header + obj1 + obj2 + obj3 + obj4 + obj5 + xref, 'utf8');
}

// ----------------------------------------------------------------------------
// VERIFICAÇÃO DE IDENTIDADE E COLISÕES PRÉ-DML (FAIL-CLOSED)
// ----------------------------------------------------------------------------
export async function verifySeedIdentityAndCollisions(sql) {
  const collisions = [];

  // 1. Perfis: verificar colisão de UUID ou e-mail sintético
  const existingPerfis = await sql`
    SELECT id, email, papel, nome FROM public.perfis
    WHERE id IN (${PERSONA_ALICE.id}::uuid, ${PERSONA_BRUNO.id}::uuid, ${PERSONA_CARLOS.id}::uuid)
       OR email IN (${PERSONA_ALICE.email}, ${PERSONA_BRUNO.email}, ${PERSONA_CARLOS.email});
  `;

  for (const p of existingPerfis) {
    const idStr = String(p.id).toLowerCase();
    const emailStr = String(p.email).toLowerCase();

    // Alice
    if (idStr === PERSONA_ALICE.id.toLowerCase() && emailStr !== PERSONA_ALICE.email.toLowerCase()) {
      collisions.push(`Perfil Alice ID (${idStr}) colide com e-mail não sintético: "${emailStr}"`);
    }
    if (emailStr === PERSONA_ALICE.email.toLowerCase() && idStr !== PERSONA_ALICE.id.toLowerCase()) {
      collisions.push(`Perfil Alice e-mail (${emailStr}) colide com ID não sintético: "${idStr}"`);
    }

    // Bruno
    if (idStr === PERSONA_BRUNO.id.toLowerCase() && emailStr !== PERSONA_BRUNO.email.toLowerCase()) {
      collisions.push(`Perfil Bruno ID (${idStr}) colide com e-mail não sintético: "${emailStr}"`);
    }
    if (emailStr === PERSONA_BRUNO.email.toLowerCase() && idStr !== PERSONA_BRUNO.id.toLowerCase()) {
      collisions.push(`Perfil Bruno e-mail (${emailStr}) colide com ID não sintético: "${idStr}"`);
    }

    // Carlos
    if (idStr === PERSONA_CARLOS.id.toLowerCase() && emailStr !== PERSONA_CARLOS.email.toLowerCase()) {
      collisions.push(`Perfil Carlos ID (${idStr}) colide com e-mail não sintético: "${emailStr}"`);
    }
    if (emailStr === PERSONA_CARLOS.email.toLowerCase() && idStr !== PERSONA_CARLOS.id.toLowerCase()) {
      collisions.push(`Perfil Carlos e-mail (${emailStr}) colide com ID não sintético: "${idStr}"`);
    }
  }

  // 2. Ciclos: verificar se IDs fixos pertencem a outros estudantes
  const existingCiclos = await sql`
    SELECT id, estudante_perfil_id, nome FROM public.ciclos
    WHERE id IN (${STAGING_ALICE_CICLO_ID}::uuid, ${STAGING_CARLOS_CICLO_ID}::uuid);
  `;
  for (const c of existingCiclos) {
    const cId = String(c.id).toLowerCase();
    const ownerId = String(c.estudante_perfil_id).toLowerCase();
    if (cId === STAGING_ALICE_CICLO_ID.toLowerCase() && ownerId !== PERSONA_ALICE.id.toLowerCase()) {
      collisions.push(`Ciclo Alice ID (${cId}) colide com proprietário externo: "${ownerId}"`);
    }
    if (cId === STAGING_CARLOS_CICLO_ID.toLowerCase() && ownerId !== PERSONA_CARLOS.id.toLowerCase()) {
      collisions.push(`Ciclo Carlos ID (${cId}) colide com proprietário externo: "${ownerId}"`);
    }
  }

  // 3. Ciclo Blocos: verificar se blocos pertencem a ciclos externos
  const existingBlocos = await sql`
    SELECT id, ciclo_id FROM public.ciclo_blocos
    WHERE id::text LIKE '41000000-0000-4000-8000-%'
       OR id::text LIKE '42000000-0000-4000-8000-%';
  `;
  for (const b of existingBlocos) {
    const bId = String(b.id).toLowerCase();
    const cicloId = String(b.ciclo_id).toLowerCase();
    if (STAGING_ALICE_BLOCO_IDS.some((id) => id.toLowerCase() === bId) && cicloId !== STAGING_ALICE_CICLO_ID.toLowerCase()) {
      collisions.push(`Bloco de estudo ID (${bId}) colide com ciclo externo: "${cicloId}"`);
    }
    if (STAGING_CARLOS_BLOCO_IDS.some((id) => id.toLowerCase() === bId) && cicloId !== STAGING_CARLOS_CICLO_ID.toLowerCase()) {
      collisions.push(`Bloco de estudo ID (${bId}) colide com ciclo externo: "${cicloId}"`);
    }
  }

  // 4. Cards: verificar se cards pertencem a outros perfis
  const existingCards = await sql`
    SELECT id, perfil_id FROM public.cards
    WHERE id::text LIKE 'c1000000-0000-4000-8000-%'
       OR id::text LIKE 'c2000000-0000-4000-8000-%';
  `;
  for (const card of existingCards) {
    const cId = String(card.id).toLowerCase();
    const perfilId = String(card.perfil_id).toLowerCase();
    if (STAGING_ALICE_CARD_IDS.some((id) => id.toLowerCase() === cId) && perfilId !== PERSONA_ALICE.id.toLowerCase()) {
      collisions.push(`Card Alice ID (${cId}) colide com perfil externo: "${perfilId}"`);
    }
    if (STAGING_CARLOS_CARD_IDS.some((id) => id.toLowerCase() === cId) && perfilId !== PERSONA_CARLOS.id.toLowerCase()) {
      collisions.push(`Card Carlos ID (${cId}) colide com perfil externo: "${perfilId}"`);
    }
  }

  // 5. Acervo Arquivo: verificar se arquivo fixo pertence a outro autor
  const existingArquivos = await sql`
    SELECT id, enviado_por FROM public.acervo_arquivos
    WHERE id = ${STAGING_ARQUIVO_ID}::uuid;
  `;
  for (const a of existingArquivos) {
    const envPor = String(a.enviado_por).toLowerCase();
    if (envPor !== PERSONA_BRUNO.id.toLowerCase()) {
      collisions.push(`Arquivo acervo ID (${STAGING_ARQUIVO_ID}) colide com autor externo: "${envPor}"`);
    }
  }

  // 6. Tutoria: verificar vínculo fixo vinculo_id = 1 e participantes
  const existingVinculos = await sql`
    SELECT vinculo_id, responsavel_perfil_id, estudante_perfil_id
    FROM public.responsavel_estudante
    WHERE vinculo_id = 1
       OR responsavel_perfil_id IN (${PERSONA_ALICE.id}::uuid, ${PERSONA_BRUNO.id}::uuid, ${PERSONA_CARLOS.id}::uuid)
       OR estudante_perfil_id IN (${PERSONA_ALICE.id}::uuid, ${PERSONA_BRUNO.id}::uuid, ${PERSONA_CARLOS.id}::uuid);
  `;
  for (const v of existingVinculos) {
    const respId = String(v.responsavel_perfil_id).toLowerCase();
    const estId = String(v.estudante_perfil_id).toLowerCase();
    if (
      v.vinculo_id !== 1 ||
      respId !== PERSONA_BRUNO.id.toLowerCase() ||
      estId !== PERSONA_ALICE.id.toLowerCase()
    ) {
      collisions.push(
        `Vínculo de tutoria inesperado envolvendo personas sintéticas: vinculo_id=${v.vinculo_id}, resp="${respId}", est="${estId}"`
      );
    }
  }

  if (collisions.length > 0) {
    const msg = `COLISAO_IDENTIDADE_DETECTADA: Foram encontradas ${collisions.length} colisão(ões) com registros não pertencentes ao seed:\n- ${collisions.join('\n- ')}`;
    throw new Error(msg);
  }

  return {
    ok: true,
    checkedEntities: {
      perfis: existingPerfis.length,
      ciclos: existingCiclos.length,
      blocos: existingBlocos.length,
      cards: existingCards.length,
      arquivos: existingArquivos.length,
      vinculos: existingVinculos.length,
    },
  };
}

// ----------------------------------------------------------------------------
// PRÉ-VOO E AUDITORIA EXCLUSIVAMENTE DE LEITURA (READ-ONLY)
// ----------------------------------------------------------------------------
export async function runPreflightAudit({
  sql,
  expectedManifest = null,
  skipHashCheck = false,
  logger = console.log,
}) {
  logger('🔍 Executando Pré-Voo e Auditoria de Leitura no Banco de Staging...');

  // 1. Sessão e Banco de Dados (Separação conceitual de conexão x papel interno)
  const [diag] = await sql`
    SELECT current_database() AS db_name, current_user AS user_name, session_user AS session_user_name;
  `;
  logger(`   • Sessão ativa: DB="${diag.db_name}" | ROLE="${diag.user_name}" | SESSION_USER="${diag.session_user_name}"`);

  // O Session Pooler do Supabase (PgBouncer) estabelece a conexão interna como role 'postgres'
  const allowedRoles = [TARGET_ROLE, TARGET_USERNAME];
  if (!allowedRoles.includes(diag.user_name)) {
    throw new Error(
      `VIOLAÇÃO DE PAPEL POSTGRESQL: Papel interno conectado "${diag.user_name}" inesperado. Esperado um de: ${allowedRoles.join(', ')}.`
    );
  }
  if (diag.db_name !== TARGET_DB) {
    throw new Error(
      `VIOLAÇÃO DE BANCO DE DADOS: Banco conectado "${diag.db_name}" inesperado. Esperado "${TARGET_DB}".`
    );
  }

  // 2. Histórico das 9 migrações e validação de hashes SHA-256
  const migRows = await sql`
    SELECT ordem, rel_path, sha256 FROM public._medicina_staging_migrations
    ORDER BY ordem ASC;
  `;
  logger(`   • Migrações canônicas aplicadas: ${migRows.length}/9 registradas em _medicina_staging_migrations.`);
  if (migRows.length !== 9) {
    throw new Error(`HISTORICO_MIGRACOES_INCOMPLETO: Esperadas exatamente 9 migrações aplicadas no staging, encontradas ${migRows.length}.`);
  }

  // Validação de paridade dos hashes SHA-256
  if (!skipHashCheck) {
    let manifestToCompare = expectedManifest;
    if (!manifestToCompare && migRows[0]?.rel_path?.startsWith('drizzle/')) {
      try {
        manifestToCompare = getMigrationManifest();
      } catch (mErr) {
        logger(`   ⚠️  Aviso: Não foi possível carregar manifesto de arquivos locais: ${mErr instanceof Error ? mErr.message : String(mErr)}`);
      }
    }

    if (manifestToCompare && Array.isArray(manifestToCompare)) {
      for (const exp of manifestToCompare) {
        const recorded = migRows.find((r) => r.ordem === exp.ordem);
        if (!recorded) {
          throw new Error(`MIGRACAO_AUSENTE: Migração ordem ${exp.ordem} (${exp.relPath}) não registrada no banco.`);
        }
        if (recorded.rel_path !== exp.relPath) {
          throw new Error(`MIGRACAO_PATH_DIVERGENTE: Ordem ${exp.ordem} possui caminho "${recorded.rel_path}", esperado "${exp.relPath}".`);
        }
        if (recorded.sha256 !== exp.sha256) {
          throw new Error(
            `MIGRACAO_HASH_DIVERGENTE: Hash SHA-256 da migração ${exp.ordem} (${exp.relPath}) diverge! Registrado: ${recorded.sha256}, Esperado: ${exp.sha256}`
          );
        }
      }
      logger(`   • Hashes SHA-256 das 9 migrações canônicas 100% verificados e validados contra o manifesto.`);
    } else {
      for (const r of migRows) {
        if (!r.rel_path || !r.sha256 || r.sha256.length !== 64) {
          throw new Error(`MIGRACAO_REGISTRO_INVALIDO: Registro de migração ${r.ordem} possui dados corrompidos.`);
        }
      }
      logger(`   • 9 registros de migração validados com formato canônico (hashes SHA-256 de 64 caracteres).`);
    }
  }

  // 3. Integridade da Allowlist Baseline
  const allowlistRows = await sql`
    SELECT email FROM public.allowlist ORDER BY email ASC;
  `;
  const allowlistEmails = allowlistRows.map((r) => r.email);
  const baselineRequired = ['estudante@medicina2029.com.br', 'responsavel@medicina2029.com.br'];
  const missingBaseline = baselineRequired.filter((e) => !allowlistEmails.includes(e));
  if (missingBaseline.length > 0) {
    throw new Error(`ALLOWLIST_BASELINE_CORROMPIDA: E-mails essenciais do baseline ausentes: ${missingBaseline.join(', ')}`);
  }
  logger(`   • Allowlist baseline íntegra: ${allowlistRows.length} e-mail(s) cadastrado(s) (baseline preservado).`);

  // 4. Estrutura Canônica das Tabelas Essenciais
  logger('   • Verificando presença da estrutura canônica de tabelas...');
  for (const table of CANONICAL_CORE_TABLES) {
    const [chk] = await sql`SELECT to_regclass(${'public.' + table}) as tbl;`;
    if (!chk?.tbl) {
      throw new Error(`ESTRUTURA_CANONICA_INCOMPLETA: Tabela obrigatória "public.${table}" não encontrada no catálogo.`);
    }
  }
  logger(`   • ${CANONICAL_CORE_TABLES.length} tabelas canônicas verificadas e confirmadas no catálogo.`);

  // 5. Verificação de Colisões com o Seed Sintético
  logger('   • Verificando integridade e colisões com identidades sintéticas...');
  const collisionResult = await verifySeedIdentityAndCollisions(sql);
  logger(`   • Zero colisões detectadas (${collisionResult.checkedEntities.perfis} perfis sintéticos verificados).`);

  // 6. Roles técnicas e BypassRLS
  const roles = await sql`
    SELECT rolname, rolbypassrls FROM pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'postgres', 'service_role');
  `;
  const nonPrivRoles = roles.filter((r) => ['anon', 'authenticated'].includes(r.rolname));
  for (const r of nonPrivRoles) {
    if (r.rolbypassrls) {
      throw new Error(`VIOLACAO_RLS: Role técnica "${r.rolname}" possui BYPASSRLS ativado!`);
    }
  }
  if (nonPrivRoles.length > 0) {
    logger(`   • Roles de aplicação auditadas (${nonPrivRoles.map((r) => r.rolname).join(', ')}): BYPASSRLS=false rigorosamente garantido.`);
  }

  // 7. Auditoria de Storage Decoupling
  logger(`   • Supabase Storage: Operações físicas em blobs estão ${STORAGE_OPERATIONS_ENABLED ? 'ATIVAS' : 'DESABILITADAS'} (garantia de atomicidade no PostgreSQL).`);

  logger('✅ PRÉ-VOO APROVADO: Conexão estrita ao Session Pooler, 9 migrações canônicas válidas, estrutura completa e zero colisões.\n');

  return {
    success: true,
    db: diag.db_name,
    role: diag.user_name,
    sessionUser: diag.session_user_name,
    migrationsCount: migRows.length,
    allowlistCount: allowlistRows.length,
    tablesCount: CANONICAL_CORE_TABLES.length,
    nonPrivRolesOk: true,
  };
}

// ----------------------------------------------------------------------------
// VALIDAÇÃO PÓS-SEED POR UUIDS E ESCOPOS DE PROPRIEDADE
// ----------------------------------------------------------------------------
export async function validatePostSeedIntegrity({ sql, logger = console.log }) {
  logger('🔬 Validando Integridade Pós-Seed por UUIDs e Escopos de Propriedade...');

  // 1. Perfis e Papéis
  const perfis = await sql`
    SELECT id, email, papel, nome FROM public.perfis
    WHERE id IN (${PERSONA_ALICE.id}::uuid, ${PERSONA_BRUNO.id}::uuid, ${PERSONA_CARLOS.id}::uuid);
  `;
  if (perfis.length !== 3) {
    throw new Error(`VALIDACAO_POS_SEED_FALHOU: Esperados 3 perfis sintéticos, encontrados ${perfis.length}.`);
  }
  const alice = perfis.find((p) => String(p.id).toLowerCase() === PERSONA_ALICE.id.toLowerCase());
  const bruno = perfis.find((p) => String(p.id).toLowerCase() === PERSONA_BRUNO.id.toLowerCase());
  const carlos = perfis.find((p) => String(p.id).toLowerCase() === PERSONA_CARLOS.id.toLowerCase());

  if (!alice || alice.email !== PERSONA_ALICE.email || alice.papel !== 'estudante') {
    throw new Error(`VALIDACAO_POS_SEED_FALHOU: Perfil de Alice corrompido: ${JSON.stringify(alice)}`);
  }
  if (!bruno || bruno.email !== PERSONA_BRUNO.email || bruno.papel !== 'responsavel') {
    throw new Error(`VALIDACAO_POS_SEED_FALHOU: Perfil de Bruno corrompido: ${JSON.stringify(bruno)}`);
  }
  if (!carlos || carlos.email !== PERSONA_CARLOS.email || carlos.papel !== 'estudante') {
    throw new Error(`VALIDACAO_POS_SEED_FALHOU: Perfil de Carlos corrompido: ${JSON.stringify(carlos)}`);
  }
  logger('   [✓] Perfis sintéticos: Alice (estudante), Bruno (responsavel) e Carlos (estudante) confirmados.');

  // 2. Vínculo Tutelar
  const vinculos = await sql`
    SELECT vinculo_id, responsavel_perfil_id, estudante_perfil_id
    FROM public.responsavel_estudante
    WHERE vinculo_id = 1;
  `;
  if (
    vinculos.length !== 1 ||
    String(vinculos[0].responsavel_perfil_id).toLowerCase() !== PERSONA_BRUNO.id.toLowerCase() ||
    String(vinculos[0].estudante_perfil_id).toLowerCase() !== PERSONA_ALICE.id.toLowerCase()
  ) {
    throw new Error(`VALIDACAO_POS_SEED_FALHOU: Vínculo tutelar incorreto: ${JSON.stringify(vinculos[0])}`);
  }
  logger('   [✓] Vínculo tutelar: Bruno -> Alice estritamente validado.');

  // 3. Ciclos e Blocos
  const ciclos = await sql`
    SELECT id, estudante_perfil_id, blocos_previstos_semana FROM public.ciclos
    WHERE id IN (${STAGING_ALICE_CICLO_ID}::uuid, ${STAGING_CARLOS_CICLO_ID}::uuid);
  `;
  if (ciclos.length !== 2) {
    throw new Error(`VALIDACAO_POS_SEED_FALHOU: Esperados 2 ciclos independentes, encontrados ${ciclos.length}.`);
  }

  const blocosAlice = await sql`
    SELECT count(*) as count FROM public.ciclo_blocos WHERE ciclo_id = ${STAGING_ALICE_CICLO_ID}::uuid;
  `;
  const blocosCarlos = await sql`
    SELECT count(*) as count FROM public.ciclo_blocos WHERE ciclo_id = ${STAGING_CARLOS_CICLO_ID}::uuid;
  `;
  if (Number(blocosAlice[0].count) !== 28 || Number(blocosCarlos[0].count) !== 28) {
    throw new Error(`VALIDACAO_POS_SEED_FALHOU: Blocos incorretos: Alice=${blocosAlice[0].count}, Carlos=${blocosCarlos[0].count}`);
  }
  logger('   [✓] Ciclos e blocos: Alice (28 blocos) e Carlos (28 blocos) independentes confirmados.');

  // 4. Cards FSRS
  const cardsAlice = await sql`
    SELECT count(*) as count FROM public.cards WHERE perfil_id = ${PERSONA_ALICE.id}::uuid;
  `;
  const cardsCarlos = await sql`
    SELECT count(*) as count FROM public.cards WHERE perfil_id = ${PERSONA_CARLOS.id}::uuid;
  `;
  if (Number(cardsAlice[0].count) !== 3 || Number(cardsCarlos[0].count) !== 2) {
    throw new Error(`VALIDACAO_POS_SEED_FALHOU: Cards incorretos: Alice=${cardsAlice[0].count}, Carlos=${cardsCarlos[0].count}`);
  }
  logger('   [✓] Flashcards FSRS: 3 de Alice e 2 de Carlos vinculados a seus respectivos perfis.');

  // 5. Acervo Didático
  const arquivos = await sql`
    SELECT id, enviado_por, status_processamento FROM public.acervo_arquivos
    WHERE id = ${STAGING_ARQUIVO_ID}::uuid;
  `;
  if (arquivos.length !== 1 || String(arquivos[0].enviado_por).toLowerCase() !== PERSONA_BRUNO.id.toLowerCase()) {
    throw new Error(`VALIDACAO_POS_SEED_FALHOU: Arquivo sintético ausente ou com autor incorreto.`);
  }
  logger('   [✓] Acervo didático: Apostila Citologia (enviada por Bruno) confirmada.');

  logger('✨ VALIDAÇÃO PÓS-SEED CONCLUÍDA: Todos os UUIDs e vínculos estão íntegros!\n');
  return { success: true };
}

// ----------------------------------------------------------------------------
// PROVISÃO CONTROLADA DOS DADOS DE HOMOLOGAÇÃO (3 PERSONAS)
// ----------------------------------------------------------------------------
export async function provisionHomologationData({
  sql,
  student1Password,
  responsiblePassword,
  student2Password,
  logger = console.log,
}) {
  const startTime = Date.now();

  const pwdAlice = student1Password || crypto.randomBytes(16).toString('hex');
  const pwdBruno = responsiblePassword || crypto.randomBytes(16).toString('hex');
  const pwdCarlos = student2Password || crypto.randomBytes(16).toString('hex');

  const salt = await bcrypt.genSalt(10);
  const hashAlice = await bcrypt.hash(pwdAlice, salt);
  const hashBruno = await bcrypt.hash(pwdBruno, salt);
  const hashCarlos = await bcrypt.hash(pwdCarlos, salt);

  const executeProvisioning = async (tx) => {
    logger('   [0/8] Verificando ambiente, ausência de colisões e integridade do seed...');
    const [sess] = await tx`
      SELECT current_database() AS db_name, current_user AS user_name, session_user AS session_user_name;
    `;
    const allowedRoles = [TARGET_ROLE, TARGET_USERNAME];
    if (!allowedRoles.includes(sess.user_name)) {
      throw new Error(
        `VIOLAÇÃO DE PAPEL POSTGRESQL: Papel interno conectado "${sess.user_name}" inesperado no provisionamento. Esperado um de: ${allowedRoles.join(', ')}.`
      );
    }
    if (sess.db_name !== TARGET_DB) {
      throw new Error(
        `VIOLAÇÃO DE BANCO DE DADOS: Banco conectado "${sess.db_name}" inesperado no provisionamento. Esperado "${TARGET_DB}".`
      );
    }

    await verifySeedIdentityAndCollisions(tx);

    logger('   [1/8] Atualizando public.allowlist com os 3 usuários sintéticos...');
    await tx`
      INSERT INTO public.allowlist (email)
      VALUES
        (${PERSONA_ALICE.email}),
        (${PERSONA_BRUNO.email}),
        (${PERSONA_CARLOS.email})
      ON CONFLICT (email) DO NOTHING;
    `;

    logger('   [2/8] Provisionando perfis sintéticos (Alice, Bruno e Carlos)...');
    await tx`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES
        (${PERSONA_ALICE.id}::uuid, ${PERSONA_ALICE.id}::uuid, ${PERSONA_ALICE.nome}, ${PERSONA_ALICE.email}, ${hashAlice}, ${PERSONA_ALICE.papel}),
        (${PERSONA_BRUNO.id}::uuid, ${PERSONA_BRUNO.id}::uuid, ${PERSONA_BRUNO.nome}, ${PERSONA_BRUNO.email}, ${hashBruno}, ${PERSONA_BRUNO.papel}),
        (${PERSONA_CARLOS.id}::uuid, ${PERSONA_CARLOS.id}::uuid, ${PERSONA_CARLOS.nome}, ${PERSONA_CARLOS.email}, ${hashCarlos}, ${PERSONA_CARLOS.papel})
      ON CONFLICT (id) DO UPDATE SET
        nome = EXCLUDED.nome,
        email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        papel = EXCLUDED.papel;
    `;

    logger('   [3/8] Estabelecendo vínculo de tutoria exclusivo (Bruno -> Alice)...');
    await tx`
      INSERT INTO public.responsavel_estudante (vinculo_id, responsavel_perfil_id, estudante_perfil_id)
      VALUES (1, ${PERSONA_BRUNO.id}::uuid, ${PERSONA_ALICE.id}::uuid)
      ON CONFLICT (vinculo_id) DO UPDATE SET
        responsavel_perfil_id = EXCLUDED.responsavel_perfil_id,
        estudante_perfil_id = EXCLUDED.estudante_perfil_id;
    `;

    logger('   [4/8] Assegurando as 5 disciplinas canônicas de vestibular...');
    const discConfigs = [
      { id: 'd0000000-0000-4000-8000-000000000001', nome: 'Matemática', area: 'matematica', corHex: '#C98A2E', ordem: 1 },
      { id: 'd0000000-0000-4000-8000-000000000002', nome: 'Biologia', area: 'natureza', corHex: '#0E3D4D', ordem: 2 },
      { id: 'd0000000-0000-4000-8000-000000000003', nome: 'Química', area: 'natureza', corHex: '#17607A', ordem: 3 },
      { id: 'd0000000-0000-4000-8000-000000000004', nome: 'Física', area: 'natureza', corHex: '#B5502B', ordem: 4 },
      { id: 'd0000000-0000-4000-8000-000000000005', nome: 'Redação', area: 'redacao', corHex: '#DE6B48', ordem: 5 },
    ];
    for (const d of discConfigs) {
      await tx`
        INSERT INTO public.disciplinas (id, nome, area, cor_hex, ordem)
        VALUES (${d.id}::uuid, ${d.nome}, ${d.area}, ${d.corHex}, ${d.ordem})
        ON CONFLICT (id) DO UPDATE SET
          nome = EXCLUDED.nome, area = EXCLUDED.area, cor_hex = EXCLUDED.cor_hex, ordem = EXCLUDED.ordem;
      `;
    }

    logger('   [5/8] Assegurando 10 tópicos pedagógicos essenciais...');
    const topicosConfigs = [
      { id: 'e0000000-0000-4000-8000-000000000001', discId: discConfigs[0].id, nome: 'Razão e Proporção', ordem: 1, enem: 5, uece: 4 },
      { id: 'e0000000-0000-4000-8000-000000000002', discId: discConfigs[0].id, nome: 'Funções de 1º e 2º Grau', ordem: 2, enem: 4, uece: 5 },
      { id: 'e0000000-0000-4000-8000-000000000003', discId: discConfigs[1].id, nome: 'Biologia Celular e Mitocôndrias', ordem: 1, enem: 5, uece: 5 },
      { id: 'e0000000-0000-4000-8000-000000000004', discId: discConfigs[1].id, nome: 'Genética Mendeliana', ordem: 2, enem: 5, uece: 4 },
      { id: 'e0000000-0000-4000-8000-000000000005', discId: discConfigs[2].id, nome: 'Estequiometria', ordem: 1, enem: 5, uece: 5 },
      { id: 'e0000000-0000-4000-8000-000000000006', discId: discConfigs[2].id, nome: 'Termoquímica', ordem: 2, enem: 4, uece: 4 },
      { id: 'e0000000-0000-4000-8000-000000000007', discId: discConfigs[3].id, nome: 'Cinemática Escalar e Vetorial', ordem: 1, enem: 4, uece: 5 },
      { id: 'e0000000-0000-4000-8000-000000000008', discId: discConfigs[3].id, nome: 'Dinâmica e Leis de Newton', ordem: 2, enem: 5, uece: 4 },
      { id: 'e0000000-0000-4000-8000-000000000009', discId: discConfigs[4].id, nome: 'Estrutura Dissertativa-Argumentativa', ordem: 1, enem: 5, uece: 5 },
      { id: 'e0000000-0000-4000-8000-000000000010', discId: discConfigs[4].id, nome: 'Proposta de Intervenção e Coesão', ordem: 2, enem: 5, uece: 4 },
    ];
    for (const t of topicosConfigs) {
      await tx`
        INSERT INTO public.topicos (id, disciplina_id, nome, serie_prevista, incidencia_enem, incidencia_uece, ordem, cobertura_material)
        VALUES (${t.id}::uuid, ${t.discId}::uuid, ${t.nome}, 1, ${t.enem}, ${t.uece}, ${t.ordem}, 'sem_fonte')
        ON CONFLICT (id) DO UPDATE SET
          nome = EXCLUDED.nome, ordem = EXCLUDED.ordem, incidencia_enem = EXCLUDED.incidencia_enem, incidencia_uece = EXCLUDED.incidencia_uece;
      `;
    }

    logger('   [6/8] Provisionando ciclos independentes para Alice e Carlos...');
    // Ciclo Alice
    await tx`
      INSERT INTO public.ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana)
      VALUES (${STAGING_ALICE_CICLO_ID}::uuid, ${PERSONA_ALICE.id}::uuid, 'Ciclo Alice 2029', 2027, true, 28)
      ON CONFLICT (id) DO UPDATE SET
        nome = EXCLUDED.nome, ano_letivo = EXCLUDED.ano_letivo, ativo = EXCLUDED.ativo, blocos_previstos_semana = EXCLUDED.blocos_previstos_semana;
    `;
    await tx`
      INSERT INTO public.ciclo_estado (ciclo_id, proxima_ordem)
      VALUES (${STAGING_ALICE_CICLO_ID}::uuid, 1)
      ON CONFLICT (ciclo_id) DO UPDATE SET proxima_ordem = 1;
    `;

    // Ciclo Carlos (Independente)
    await tx`
      INSERT INTO public.ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana)
      VALUES (${STAGING_CARLOS_CICLO_ID}::uuid, ${PERSONA_CARLOS.id}::uuid, 'Ciclo Carlos Independente 2029', 2027, true, 28)
      ON CONFLICT (id) DO UPDATE SET
        nome = EXCLUDED.nome, ano_letivo = EXCLUDED.ano_letivo, ativo = EXCLUDED.ativo, blocos_previstos_semana = EXCLUDED.blocos_previstos_semana;
    `;
    await tx`
      INSERT INTO public.ciclo_estado (ciclo_id, proxima_ordem)
      VALUES (${STAGING_CARLOS_CICLO_ID}::uuid, 1)
      ON CONFLICT (ciclo_id) DO UPDATE SET proxima_ordem = 1;
    `;

    // Blocos Alice (28) e Carlos (28)
    const tiposBloco = ['conteudo', 'questoes', 'revisao_srs'];
    const estilos = ['enem', 'misto', 'conteudista'];
    for (let i = 1; i <= 28; i++) {
      const disc = discConfigs[(i - 1) % discConfigs.length];
      const tipo = tiposBloco[(i - 1) % tiposBloco.length];
      const estiloAlvo = estilos[(i - 1) % estilos.length];

      const blocoAliceId = `41000000-0000-4000-8000-${i.toString().padStart(12, '0')}`;
      const blocoCarlosId = `42000000-0000-4000-8000-${i.toString().padStart(12, '0')}`;

      await tx`
        INSERT INTO public.ciclo_blocos (id, ciclo_id, disciplina_id, ordem, tipo, estilo_alvo, duracao_min)
        VALUES (${blocoAliceId}::uuid, ${STAGING_ALICE_CICLO_ID}::uuid, ${disc.id}::uuid, ${i}, ${tipo}, ${estiloAlvo}, 50)
        ON CONFLICT (id) DO UPDATE SET
          ciclo_id = EXCLUDED.ciclo_id, disciplina_id = EXCLUDED.disciplina_id, ordem = EXCLUDED.ordem, tipo = EXCLUDED.tipo, estilo_alvo = EXCLUDED.estilo_alvo, duracao_min = EXCLUDED.duracao_min;
      `;
      await tx`
        INSERT INTO public.ciclo_blocos (id, ciclo_id, disciplina_id, ordem, tipo, estilo_alvo, duracao_min)
        VALUES (${blocoCarlosId}::uuid, ${STAGING_CARLOS_CICLO_ID}::uuid, ${disc.id}::uuid, ${i}, ${tipo}, ${estiloAlvo}, 50)
        ON CONFLICT (id) DO UPDATE SET
          ciclo_id = EXCLUDED.ciclo_id, disciplina_id = EXCLUDED.disciplina_id, ordem = EXCLUDED.ordem, tipo = EXCLUDED.tipo, estilo_alvo = EXCLUDED.estilo_alvo, duracao_min = EXCLUDED.duracao_min;
      `;
    }

    logger('   [7/8] Inserindo flashcards FSRS independentes (Alice e Carlos)...');
    const agora = new Date();
    const cardsAlice = [
      { id: 'c1000000-0000-4000-8000-000000000001', topicoId: topicosConfigs[2].id, frente: 'Mitocôndria produz ATP via?', verso: 'Respiração Celular.', state: 'new' },
      { id: 'c1000000-0000-4000-8000-000000000002', topicoId: topicosConfigs[6].id, frente: 'Fórmula da velocidade média no MRU?', verso: 'v = delta_s / delta_t.', state: 'learning' },
      { id: 'c1000000-0000-4000-8000-000000000003', topicoId: topicosConfigs[8].id, frente: 'Elementos da intervenção no ENEM?', verso: 'Agente, Ação, Meio/Modo, Efeito e Detalhamento.', state: 'review' },
    ];
    const cardsCarlos = [
      { id: 'c2000000-0000-4000-8000-000000000001', topicoId: topicosConfigs[0].id, frente: 'Grandezas inversamente proporcionais têm?', verso: 'Produto constante.', state: 'new' },
      { id: 'c2000000-0000-4000-8000-000000000002', topicoId: topicosConfigs[4].id, frente: 'Volume molar na CNTP de gás ideal?', verso: '22,4 Litros.', state: 'review' },
    ];

    for (const c of cardsAlice) {
      await tx`
        INSERT INTO public.cards (id, perfil_id, topico_id, frente, verso, origem, status, suspenso, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state)
        VALUES (${c.id}::uuid, ${PERSONA_ALICE.id}::uuid, ${c.topicoId}::uuid, ${c.frente}, ${c.verso}, 'manual', 'aprovado', false, ${agora}, 1.0, 3.0, 0, 1, 1, 0, ${c.state})
        ON CONFLICT (id) DO UPDATE SET frente = EXCLUDED.frente, verso = EXCLUDED.verso, state = EXCLUDED.state;
      `;
    }
    for (const c of cardsCarlos) {
      await tx`
        INSERT INTO public.cards (id, perfil_id, topico_id, frente, verso, origem, status, suspenso, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state)
        VALUES (${c.id}::uuid, ${PERSONA_CARLOS.id}::uuid, ${c.topicoId}::uuid, ${c.frente}, ${c.verso}, 'manual', 'aprovado', false, ${agora}, 1.0, 3.0, 0, 1, 1, 0, ${c.state})
        ON CONFLICT (id) DO UPDATE SET frente = EXCLUDED.frente, verso = EXCLUDED.verso, state = EXCLUDED.state;
      `;
    }

    logger('   [8/8] Inserindo acervo didático sintético enviado pelo responsável Bruno...');
    const pdfBuffer = createSyntheticPdfBuffer('Biologia Celular', 'Conteudo sintetico sobre respiracao celular.');
    const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    const arquivoId = 'f0000000-0000-4000-8000-000000000001';
    const filePath = `acervo/${sha256}_citologia.pdf`;

    await tx`
      INSERT INTO public.acervo_arquivos (id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular, file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo)
      VALUES (${arquivoId}::uuid, ${discConfigs[1].id}::uuid, 'Apostila Citologia', 'apostila', 1, 'ENEM/UECE', ${filePath}, 'application/pdf', ${pdfBuffer.length}, 1, ${PERSONA_BRUNO.id}::uuid, 'concluido', ${sha256})
      ON CONFLICT (id) DO UPDATE SET titulo = EXCLUDED.titulo, file_path = EXCLUDED.file_path;
    `;

    const paginaId = 'f1000000-0000-4000-8000-000000000001';
    await tx`
      INSERT INTO public.acervo_paginas (id, arquivo_id, numero, texto_extraido, metodo_extracao, confianca_ocr)
      VALUES (${paginaId}::uuid, ${arquivoId}::uuid, 1, 'Texto da pagina citologia', 'nativo', 1.0)
      ON CONFLICT (id) DO UPDATE SET texto_extraido = EXCLUDED.texto_extraido;
    `;

    const chunkId = 'f2000000-0000-4000-8000-000000000001';
    const mockVector = new Array(1536).fill(0);
    mockVector[0] = 0.6;
    mockVector[1] = 0.8;
    const vectorStr = `[${mockVector.join(',')}]`;

    await tx`
      INSERT INTO public.acervo_chunks (id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo, topico_id, confianca_classificacao, embedding, tokens)
      VALUES (${chunkId}::uuid, ${arquivoId}::uuid, 1, 1, 1, 'Texto do chunk citologia', 'exposicao_teorica', ${topicosConfigs[2].id}::uuid, 0.95, ${vectorStr}::vector, 35)
      ON CONFLICT (id) DO UPDATE SET texto = EXCLUDED.texto, embedding = EXCLUDED.embedding;
    `;

    const jobId = 'f3000000-0000-4000-8000-000000000001';
    await tx`
      INSERT INTO public.acervo_jobs (id, arquivo_id, enviado_por, status, etapa_atual, tentativas, max_tentativas, concluido_em)
      VALUES (${jobId}::uuid, ${arquivoId}::uuid, ${PERSONA_BRUNO.id}::uuid, 'concluido', 'concluido', 1, 3, ${agora})
      ON CONFLICT (id) DO UPDATE SET status = 'concluido', etapa_atual = 'concluido';
    `;

    const elapsed = Date.now() - startTime;
    logger(`   ✅ Provisão dos 3 usuários e entidades didáticas concluída em ${elapsed}ms.`);

    return {
      success: true,
      perfis: 3,
      ciclos: 2,
      blocos: 56,
      cards: cardsAlice.length + cardsCarlos.length,
      arquivos: 1,
      duracaoMs: elapsed,
    };
  };

  if (typeof sql.begin === 'function') {
    return await sql.begin(executeProvisioning);
  }
  return await executeProvisioning(sql);
}

// ----------------------------------------------------------------------------
// PROCEDIMENTO DE LIMPEZA COMPLETA PÓS-HOMOLOGAÇÃO (TEARDOWN SEGURO)
// ----------------------------------------------------------------------------
export async function cleanupHomologationData({
  sql,
  storageClient = null,
  logger = console.log,
}) {
  const startTime = Date.now();
  logger('🧹 Iniciando limpeza transacional completa dos dados sintéticos de homologação...');

  const syntheticPerfis = [PERSONA_ALICE.id, PERSONA_BRUNO.id, PERSONA_CARLOS.id];
  const syntheticEmails = [PERSONA_ALICE.email, PERSONA_BRUNO.email, PERSONA_CARLOS.email];

  if (storageClient) {
    if (!STORAGE_OPERATIONS_ENABLED) {
      logger('   🔒 Supabase Storage: Exclusão física de blobs está desabilitada na homologação H2.04-R2 (garantia de atomicidade 100% transacional no PostgreSQL).');
    } else {
      try {
        const filesToRemove = await sql`
          SELECT file_path FROM public.acervo_arquivos
          WHERE enviado_por IN ${sql(syntheticPerfis)};
        `;
        if (filesToRemove.length > 0) {
          const rawPaths = filesToRemove.map((f) => f.file_path.replace(/^acervo\//, ''));
          const { error: storageErr } = await storageClient.storage.from('acervo').remove(rawPaths);
          if (storageErr) {
            logger(`   ⚠️  Aviso: Falha ao remover arquivos do Storage: ${storageErr.message}`);
          } else {
            logger(`   🗑️  ${rawPaths.length} arquivo(s) sintético(s) removido(s) do bucket acervo.`);
          }
        }
      } catch (sErr) {
        logger(`   ⚠️  Exceção ao verificar Supabase Storage: ${sErr instanceof Error ? sErr.message : String(sErr)}`);
      }
    }
  }

  const executeCleanup = async (tx) => {
    // Execução reversa rigorosa respeitando todas as foreign keys
    logger('   • Removendo filas de curadoria e jobs de acervo...');
    await tx`
      DELETE FROM public.curadoria_fila
      WHERE artefato_id IN (
        SELECT id FROM public.cards WHERE perfil_id IN ${tx(syntheticPerfis)}
      )
      OR artefato_id IN (
        SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ${tx(syntheticPerfis)}
      );
    `;

    await tx`
      DELETE FROM public.acervo_jobs
      WHERE enviado_por IN ${tx(syntheticPerfis)}
         OR arquivo_id IN (
           SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ${tx(syntheticPerfis)}
         );
    `;

    logger('   • Removendo chunks, páginas, figuras e arquivos didáticos sintéticos...');
    await tx`
      DELETE FROM public.acervo_figuras
      WHERE arquivo_id IN (
        SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ${tx(syntheticPerfis)}
      );
    `;

    await tx`
      DELETE FROM public.acervo_chunks
      WHERE arquivo_id IN (
        SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ${tx(syntheticPerfis)}
      );
    `;

    await tx`
      DELETE FROM public.acervo_paginas
      WHERE arquivo_id IN (
        SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ${tx(syntheticPerfis)}
      );
    `;

    await tx`
      DELETE FROM public.acervo_arquivos
      WHERE enviado_por IN ${tx(syntheticPerfis)};
    `;

    logger('   • Removendo registros de operações idempotentes...');
    await tx`
      DELETE FROM public.operacoes_idempotentes
      WHERE perfil_id IN ${tx(syntheticPerfis)};
    `;

    logger('   • Removendo erros pedagógicos e tentativas de estudo...');
    await tx`
      DELETE FROM public.erros
      WHERE perfil_id IN ${tx(syntheticPerfis)};
    `;

    await tx`
      DELETE FROM public.tentativas
      WHERE perfil_id IN ${tx(syntheticPerfis)}
         OR sessao_id IN (
           SELECT id FROM public.sessoes WHERE perfil_id IN ${tx(syntheticPerfis)}
         );
    `;

    logger('   • Removendo sessões de estudo...');
    await tx`
      DELETE FROM public.sessoes
      WHERE perfil_id IN ${tx(syntheticPerfis)};
    `;

    logger('   • Removendo revisões de cards e flashcards FSRS...');
    await tx`
      DELETE FROM public.card_revisoes
      WHERE card_id IN (
        SELECT id FROM public.cards WHERE perfil_id IN ${tx(syntheticPerfis)}
      );
    `;

    await tx`
      DELETE FROM public.cards
      WHERE perfil_id IN ${tx(syntheticPerfis)};
    `;

    logger('   • Removendo materiais didáticos aprovados...');
    await tx`
      DELETE FROM public.materiais
      WHERE aprovado_por IN ${tx(syntheticPerfis)};
    `;

    logger('   • Removendo redações, repertórios, livros e simulados...');
    await tx`
      DELETE FROM public.repertorios
      WHERE perfil_id IN ${tx(syntheticPerfis)};
    `;

    await tx`
      DELETE FROM public.livros
      WHERE perfil_id IN ${tx(syntheticPerfis)};
    `;

    await tx`
      DELETE FROM public.redacoes
      WHERE perfil_id IN ${tx(syntheticPerfis)};
    `;

    await tx`
      DELETE FROM public.simulado_questoes
      WHERE simulado_id IN (
        SELECT id FROM public.simulados WHERE perfil_id IN ${tx(syntheticPerfis)}
      );
    `;

    await tx`
      DELETE FROM public.simulado_areas
      WHERE simulado_id IN (
        SELECT id FROM public.simulados WHERE perfil_id IN ${tx(syntheticPerfis)}
      );
    `;

    await tx`
      DELETE FROM public.simulado_analise
      WHERE simulado_id IN (
        SELECT id FROM public.simulados WHERE perfil_id IN ${tx(syntheticPerfis)}
      );
    `;

    await tx`
      DELETE FROM public.simulados
      WHERE perfil_id IN ${tx(syntheticPerfis)};
    `;

    logger('   • Removendo blocos e ciclos de estudo...');
    await tx`
      DELETE FROM public.ciclo_estado
      WHERE ciclo_id IN (
        SELECT id FROM public.ciclos WHERE estudante_perfil_id IN ${tx(syntheticPerfis)}
      );
    `;

    await tx`
      DELETE FROM public.ciclo_blocos
      WHERE ciclo_id IN (
        SELECT id FROM public.ciclos WHERE estudante_perfil_id IN ${tx(syntheticPerfis)}
      );
    `;

    await tx`
      DELETE FROM public.ciclos
      WHERE estudante_perfil_id IN ${tx(syntheticPerfis)};
    `;

    logger('   • Removendo revisões trimestrais e checkins...');
    await tx`
      DELETE FROM public.revisoes_trimestrais
      WHERE estudante_perfil_id IN ${tx(syntheticPerfis)}
         OR registrada_por_perfil_id IN ${tx(syntheticPerfis)};
    `;

    await tx`
      DELETE FROM public.checkins
      WHERE perfil_id IN ${tx(syntheticPerfis)};
    `;

    logger('   • Removendo vínculos de tutoria responsável-estudante...');
    await tx`
      DELETE FROM public.responsavel_estudante
      WHERE responsavel_perfil_id IN ${tx(syntheticPerfis)}
         OR estudante_perfil_id IN ${tx(syntheticPerfis)};
    `;

    logger('   • Removendo perfis sintéticos (Alice, Bruno e Carlos)...');
    await tx`
      DELETE FROM public.perfis
      WHERE id IN ${tx(syntheticPerfis)};
    `;

    logger('   • Removendo e-mails sintéticos da allowlist...');
    await tx`
      DELETE FROM public.allowlist
      WHERE email IN ${tx(syntheticEmails)};
    `;
  };

  if (typeof sql.begin === 'function') {
    await sql.begin(executeCleanup);
  } else {
    await executeCleanup(sql);
  }

  const elapsed = Date.now() - startTime;
  logger(`\n✨ LIMPEZA PÓS-HOMOLOGAÇÃO CONCLUÍDA EM ${elapsed}ms: 100% dos dados sintéticos foram expurgados!`);
  logger('   O banco retornou ao baseline limpo.');

  return {
    success: true,
    cleanedPerfis: syntheticPerfis.length,
    cleanedEmails: syntheticEmails.length,
    duracaoMs: elapsed,
  };
}

// ----------------------------------------------------------------------------
// INTERFACE DE EXECUÇÃO INTERATIVA
// ----------------------------------------------------------------------------
export function promptConfirmation(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.on('SIGINT', () => {
      rl.close();
      process.stdout.write('\n\nOperação cancelada pelo usuário (Ctrl+C).\n');
      process.exit(130);
    });

    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function executeControlledHomologationCli() {
  const args = process.argv.slice(2);
  const isProvision = args.includes('--provision');
  const isCleanup = args.includes('--cleanup');
  const isStatus = args.includes('--status');
  const isAudit = args.includes('--preflight-audit') || args.includes('--audit');
  const isValidate = args.includes('--validate-seed');

  if (!isProvision && !isCleanup && !isStatus && !isAudit && !isValidate) {
    console.log(`
Uso do Preparador de Homologação Staging (Medicina 2029):
  node scripts/db/prepare-staging-homologation.mjs --status           (Exibe o status das funcionalidades e personas)
  node scripts/db/prepare-staging-homologation.mjs --preflight-audit  (Auditoria de leitura: projeto, 9 migrações, baseline, zero colisões)
  node scripts/db/prepare-staging-homologation.mjs --provision        (Provisiona Alice, Bruno e Carlos no Staging com verificação transacional)
  node scripts/db/prepare-staging-homologation.mjs --validate-seed   (Validação pós-seed por UUIDs e escopo de propriedade)
  node scripts/db/prepare-staging-homologation.mjs --cleanup         (Expurga 100% dos dados sintéticos do Staging)
`);
    process.exit(0);
  }

  if (isStatus) {
    console.log('\n================================================================');
    console.log('MEDICINA 2029 — H2.04: STATUS DAS FUNCIONALIDADES PARA HOMOLOGAÇÃO');
    console.log('================================================================');
    console.log('\n1. FUNCIONALIDADES PRONTAS:');
    FEATURE_STATUS_MATRIX.prontas.forEach((f) => console.log(`   [✓] ${f.modulo}: ${f.descricao}`));
    console.log('\n2. DEPENDENTES DE INFRAESTRUTURA:');
    FEATURE_STATUS_MATRIX.dependentesInfraestrutura.forEach((f) => console.log(`   [!] ${f.modulo}: ${f.dependencia}`));
    console.log('\n3. PENDENTES OU MOCKADAS:');
    FEATURE_STATUS_MATRIX.pendentesOuMockadas.forEach((f) => console.log(`   [-] ${f.modulo}: ${f.status}`));
    console.log('\n================================================================\n');
    process.exit(0);
  }

  if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
    console.error('\n❌ ABORTO DE SEGURANÇA: Execução terminantemente proibida em ambiente de PRODUÇÃO.');
    process.exit(1);
  }

  // Operações de escrita exigem confirmação explícita
  if (isProvision || isCleanup) {
    const tokenEsperado = isProvision ? 'CONFIRMAR HOMOLOGACAO STAGING' : 'CONFIRMAR LIMPEZA HOMOLOGACAO STAGING';
    const confirmation = await promptConfirmation(`Digite "${tokenEsperado}" para autorizar a execução contra o Staging: `);
    if (confirmation !== tokenEsperado) {
      console.error(`\n❌ OPERAÇÃO CANCELADA: Token de confirmação incorreto ou não fornecido.`);
      process.exit(1);
    }
  }

  const caCertPath = args.find((a) => a.startsWith('--ca='))?.split('=')[1];
  const caInfo = resolveCaCertificate(caCertPath);
  if (!caInfo) {
    console.error('❌ ERRO TLS: Certificado CA do Supabase (prod-ca-2021.crt) não localizado.');
    process.exit(1);
  }

  const password = await promptHiddenPassword('Digite a senha da role administrativa postgres do Staging: ');
  if (!password) {
    console.error('❌ ERRO: Senha não fornecida.');
    process.exit(1);
  }

  const dbUrl = buildStagingPoolerUrl(password);

  // 1. Validação estrita dos parâmetros da conexão antes de qualquer handshake (Pré-Conexão)
  validateStagingConnectionConfig(dbUrl);

  const sql = postgres(dbUrl, {
    max: 1,
    connect_timeout: 20,
    idle_timeout: 10,
    ssl: {
      rejectUnauthorized: true,
      ca: [...tls.rootCertificates, caInfo.content],
    },
  });

  try {
    const [diag] = await sql`
      SELECT current_database() AS db_name, current_user AS user_name, session_user AS session_user_name;
    `;
    console.log(`🔒 Conexão TLS estabelecida: DB="${diag.db_name}" | ROLE="${diag.user_name}" | SESSION_USER="${diag.session_user_name}"`);

    // 2. Validação do papel e do banco na sessão ativa do PostgreSQL
    const allowedRoles = [TARGET_ROLE, TARGET_USERNAME];
    if (!allowedRoles.includes(diag.user_name)) {
      throw new Error(
        `VIOLAÇÃO DE PAPEL POSTGRESQL: Papel interno conectado "${diag.user_name}" inesperado. Esperado um de: ${allowedRoles.join(', ')}.`
      );
    }
    if (diag.db_name !== TARGET_DB) {
      throw new Error(
        `VIOLAÇÃO DE BANCO DE DADOS: Banco conectado "${diag.db_name}" inesperado. Esperado "${TARGET_DB}".`
      );
    }

    if (isAudit) {
      await runPreflightAudit({ sql, logger: console.log });
    } else if (isProvision) {
      await provisionHomologationData({ sql, logger: console.log });
    } else if (isValidate) {
      await validatePostSeedIntegrity({ sql, logger: console.log });
    } else if (isCleanup) {
      // Blobs físicos desabilitados por segurança na H2.04-R2
      await cleanupHomologationData({ sql, storageClient: null, logger: console.log });
    }
  } catch (err) {
    console.error('❌ Falha na operação de homologação:', sanitizeError(err));
    process.exit(1);
  } finally {
    await sql.end();
  }
}

if (process.argv[1]?.includes('prepare-staging-homologation.mjs')) {
  executeControlledHomologationCli().catch((err) => {
    console.error('Erro fatal:', err);
    process.exit(1);
  });
}
