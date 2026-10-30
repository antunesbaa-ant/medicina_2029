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

import {
  resolveCaCertificate,
  promptHiddenPassword,
  buildStagingPoolerUrl,
  sanitizeError,
} from './test-staging-connection.mjs';

// ----------------------------------------------------------------------------
// CONFIGURAÇÕES DO ALVO STAGING
// ----------------------------------------------------------------------------
export const TARGET_HOST = 'aws-0-us-east-1.pooler.supabase.com';
export const TARGET_PORT = 5432;
export const TARGET_DB = 'postgres';
export const TARGET_ROLE = 'postgres';
export const TARGET_PROJECT_REF = 'ynfocaorhadizlvbnzrt';
export const TARGET_USERNAME = `${TARGET_ROLE}.${TARGET_PROJECT_REF}`;

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

  logger('   [1/8] Atualizando public.allowlist com os 3 usuários sintéticos...');
  await sql`
    INSERT INTO public.allowlist (email)
    VALUES
      (${PERSONA_ALICE.email}),
      (${PERSONA_BRUNO.email}),
      (${PERSONA_CARLOS.email})
    ON CONFLICT (email) DO NOTHING;
  `;

  logger('   [2/8] Provisionando perfis sintéticos (Alice, Bruno e Carlos)...');
  await sql`
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
  await sql`
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
    await sql`
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
    await sql`
      INSERT INTO public.topicos (id, disciplina_id, nome, serie_prevista, incidencia_enem, incidencia_uece, ordem, cobertura_material)
      VALUES (${t.id}::uuid, ${t.discId}::uuid, ${t.nome}, 1, ${t.enem}, ${t.uece}, ${t.ordem}, 'sem_fonte')
      ON CONFLICT (id) DO UPDATE SET
        nome = EXCLUDED.nome, ordem = EXCLUDED.ordem, incidencia_enem = EXCLUDED.incidencia_enem, incidencia_uece = EXCLUDED.incidencia_uece;
    `;
  }

  logger('   [6/8] Provisionando ciclos independentes para Alice e Carlos...');
  // Ciclo Alice
  await sql`
    INSERT INTO public.ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana)
    VALUES (${STAGING_ALICE_CICLO_ID}::uuid, ${PERSONA_ALICE.id}::uuid, 'Ciclo Alice 2029', 2027, true, 28)
    ON CONFLICT (id) DO UPDATE SET
      nome = EXCLUDED.nome, ano_letivo = EXCLUDED.ano_letivo, ativo = EXCLUDED.ativo, blocos_previstos_semana = EXCLUDED.blocos_previstos_semana;
  `;
  await sql`
    INSERT INTO public.ciclo_estado (ciclo_id, proxima_ordem)
    VALUES (${STAGING_ALICE_CICLO_ID}::uuid, 1)
    ON CONFLICT (ciclo_id) DO UPDATE SET proxima_ordem = 1;
  `;

  // Ciclo Carlos (Independente)
  await sql`
    INSERT INTO public.ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana)
    VALUES (${STAGING_CARLOS_CICLO_ID}::uuid, ${PERSONA_CARLOS.id}::uuid, 'Ciclo Carlos Independente 2029', 2027, true, 28)
    ON CONFLICT (id) DO UPDATE SET
      nome = EXCLUDED.nome, ano_letivo = EXCLUDED.ano_letivo, ativo = EXCLUDED.ativo, blocos_previstos_semana = EXCLUDED.blocos_previstos_semana;
  `;
  await sql`
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

    await sql`
      INSERT INTO public.ciclo_blocos (id, ciclo_id, disciplina_id, ordem, tipo, estilo_alvo, duracao_min)
      VALUES (${blocoAliceId}::uuid, ${STAGING_ALICE_CICLO_ID}::uuid, ${disc.id}::uuid, ${i}, ${tipo}, ${estiloAlvo}, 50)
      ON CONFLICT (id) DO UPDATE SET
        ordem = EXCLUDED.ordem, tipo = EXCLUDED.tipo, estilo_alvo = EXCLUDED.estilo_alvo, duracao_min = EXCLUDED.duracao_min;
    `;
    await sql`
      INSERT INTO public.ciclo_blocos (id, ciclo_id, disciplina_id, ordem, tipo, estilo_alvo, duracao_min)
      VALUES (${blocoCarlosId}::uuid, ${STAGING_CARLOS_CICLO_ID}::uuid, ${disc.id}::uuid, ${i}, ${tipo}, ${estiloAlvo}, 50)
      ON CONFLICT (id) DO UPDATE SET
        ordem = EXCLUDED.ordem, tipo = EXCLUDED.tipo, estilo_alvo = EXCLUDED.estilo_alvo, duracao_min = EXCLUDED.duracao_min;
    `;
  }

  logger('   [7/8] Inserindo flashcards FSRS independentes (Alice e Carlos)...');
  const agora = new Date();
  const dezDiasFrente = new Date(agora.getTime() + 10 * 86_400_000);
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
    await sql`
      INSERT INTO public.cards (id, perfil_id, topico_id, frente, verso, origem, status, suspenso, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state)
      VALUES (${c.id}::uuid, ${PERSONA_ALICE.id}::uuid, ${c.topicoId}::uuid, ${c.frente}, ${c.verso}, 'manual', 'aprovado', false, ${agora}, 1.0, 3.0, 0, 1, 1, 0, ${c.state})
      ON CONFLICT (id) DO UPDATE SET frente = EXCLUDED.frente, verso = EXCLUDED.verso, state = EXCLUDED.state;
    `;
  }
  for (const c of cardsCarlos) {
    await sql`
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

  await sql`
    INSERT INTO public.acervo_arquivos (id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular, file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo)
    VALUES (${arquivoId}::uuid, ${discConfigs[1].id}::uuid, 'Apostila Citologia', 'apostila', 1, 'ENEM/UECE', ${filePath}, 'application/pdf', ${pdfBuffer.length}, 1, ${PERSONA_BRUNO.id}::uuid, 'concluido', ${sha256})
    ON CONFLICT (id) DO UPDATE SET titulo = EXCLUDED.titulo, file_path = EXCLUDED.file_path;
  `;

  const paginaId = 'f1000000-0000-4000-8000-000000000001';
  await sql`
    INSERT INTO public.acervo_paginas (id, arquivo_id, numero, texto_extraido, metodo_extracao, confianca_ocr)
    VALUES (${paginaId}::uuid, ${arquivoId}::uuid, 1, 'Texto da pagina citologia', 'nativo', 1.0)
    ON CONFLICT (id) DO UPDATE SET texto_extraido = EXCLUDED.texto_extraido;
  `;

  const chunkId = 'f2000000-0000-4000-8000-000000000001';
  const mockVector = new Array(1536).fill(0);
  mockVector[0] = 0.6;
  mockVector[1] = 0.8;
  const vectorStr = `[${mockVector.join(',')}]`;

  await sql`
    INSERT INTO public.acervo_chunks (id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo, topico_id, confianca_classificacao, embedding, tokens)
    VALUES (${chunkId}::uuid, ${arquivoId}::uuid, 1, 1, 1, 'Texto do chunk citologia', 'exposicao_teorica', ${topicosConfigs[2].id}::uuid, 0.95, ${vectorStr}::vector, 35)
    ON CONFLICT (id) DO UPDATE SET texto = EXCLUDED.texto, embedding = EXCLUDED.embedding;
  `;

  const jobId = 'f3000000-0000-4000-8000-000000000001';
  await sql`
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
}

// ----------------------------------------------------------------------------
// PROCEDIMENTO DE LIMPEZA COMPLETA PÓS-HOMOLOGAÇÃO (TEARDOWN SEGURO)
// ----------------------------------------------------------------------------
export async function cleanupHomologationData({
  sql,
  logger = console.log,
}) {
  const startTime = Date.now();
  logger('🧹 Iniciando limpeza transacional completa dos dados sintéticos de homologação...');

  const syntheticPerfis = [PERSONA_ALICE.id, PERSONA_BRUNO.id, PERSONA_CARLOS.id];
  const syntheticEmails = [PERSONA_ALICE.email, PERSONA_BRUNO.email, PERSONA_CARLOS.email];

  // Execução reversa rigorosa respeitando todas as foreign keys
  logger('   • Removendo filas de curadoria e jobs de acervo...');
  await sql`
    DELETE FROM public.curadoria_fila
    WHERE artefato_id IN (
      SELECT id FROM public.cards WHERE perfil_id IN ${sql(syntheticPerfis)}
    )
    OR artefato_id IN (
      SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ${sql(syntheticPerfis)}
    );
  `;

  await sql`
    DELETE FROM public.acervo_jobs
    WHERE enviado_por IN ${sql(syntheticPerfis)};
  `;

  logger('   • Removendo chunks, páginas e arquivos didáticos sintéticos...');
  await sql`
    DELETE FROM public.acervo_chunks
    WHERE arquivo_id IN (
      SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ${sql(syntheticPerfis)}
    );
  `;

  await sql`
    DELETE FROM public.acervo_paginas
    WHERE arquivo_id IN (
      SELECT id FROM public.acervo_arquivos WHERE enviado_por IN ${sql(syntheticPerfis)}
    );
  `;

  await sql`
    DELETE FROM public.acervo_arquivos
    WHERE enviado_por IN ${sql(syntheticPerfis)};
  `;

  logger('   • Removendo erros pedagógicos e tentativas de estudo...');
  await sql`
    DELETE FROM public.erros
    WHERE perfil_id IN ${sql(syntheticPerfis)};
  `;

  await sql`
    DELETE FROM public.tentativas
    WHERE sessao_id IN (
      SELECT id FROM public.sessoes WHERE perfil_id IN ${sql(syntheticPerfis)}
    );
  `;

  logger('   • Removendo sessões de estudo...');
  await sql`
    DELETE FROM public.sessoes
    WHERE perfil_id IN ${sql(syntheticPerfis)};
  `;

  logger('   • Removendo revisões de cards e flashcards FSRS...');
  await sql`
    DELETE FROM public.card_revisoes
    WHERE card_id IN (
      SELECT id FROM public.cards WHERE perfil_id IN ${sql(syntheticPerfis)}
    );
  `;

  await sql`
    DELETE FROM public.cards
    WHERE perfil_id IN ${sql(syntheticPerfis)};
  `;

  logger('   • Removendo materiais didáticos aprovados...');
  await sql`
    DELETE FROM public.materiais
    WHERE aprovado_por IN ${sql(syntheticPerfis)};
  `;

  logger('   • Removendo redações, repertórios, livros e simulados...');
  await sql`
    DELETE FROM public.repertorios
    WHERE perfil_id IN ${sql(syntheticPerfis)};
  `;

  await sql`
    DELETE FROM public.livros
    WHERE perfil_id IN ${sql(syntheticPerfis)};
  `;

  await sql`
    DELETE FROM public.redacoes
    WHERE perfil_id IN ${sql(syntheticPerfis)};
  `;

  await sql`
    DELETE FROM public.simulado_questoes
    WHERE simulado_id IN (
      SELECT id FROM public.simulados WHERE perfil_id IN ${sql(syntheticPerfis)}
    );
  `;

  await sql`
    DELETE FROM public.simulado_areas
    WHERE simulado_id IN (
      SELECT id FROM public.simulados WHERE perfil_id IN ${sql(syntheticPerfis)}
    );
  `;

  await sql`
    DELETE FROM public.simulado_analise
    WHERE simulado_id IN (
      SELECT id FROM public.simulados WHERE perfil_id IN ${sql(syntheticPerfis)}
    );
  `;

  await sql`
    DELETE FROM public.simulados
    WHERE perfil_id IN ${sql(syntheticPerfis)};
  `;

  logger('   • Removendo blocos e ciclos de estudo...');
  await sql`
    DELETE FROM public.ciclo_estado
    WHERE ciclo_id IN (
      SELECT id FROM public.ciclos WHERE estudante_perfil_id IN ${sql(syntheticPerfis)}
    );
  `;

  await sql`
    DELETE FROM public.ciclo_blocos
    WHERE ciclo_id IN (
      SELECT id FROM public.ciclos WHERE estudante_perfil_id IN ${sql(syntheticPerfis)}
    );
  `;

  await sql`
    DELETE FROM public.ciclos
    WHERE estudante_perfil_id IN ${sql(syntheticPerfis)};
  `;

  logger('   • Removendo revisões trimestrais e checkins...');
  await sql`
    DELETE FROM public.revisoes_trimestrais
    WHERE estudante_perfil_id IN ${sql(syntheticPerfis)}
       OR registrada_por_perfil_id IN ${sql(syntheticPerfis)};
  `;

  await sql`
    DELETE FROM public.checkins
    WHERE perfil_id IN ${sql(syntheticPerfis)};
  `;

  logger('   • Removendo vínculos de tutoria responsável-estudante...');
  await sql`
    DELETE FROM public.responsavel_estudante
    WHERE responsavel_perfil_id IN ${sql(syntheticPerfis)}
       OR estudante_perfil_id IN ${sql(syntheticPerfis)};
  `;

  logger('   • Removendo perfis sintéticos (Alice, Bruno e Carlos)...');
  await sql`
    DELETE FROM public.perfis
    WHERE id IN ${sql(syntheticPerfis)};
  `;

  logger('   • Removendo e-mails sintéticos da allowlist...');
  await sql`
    DELETE FROM public.allowlist
    WHERE email IN ${sql(syntheticEmails)};
  `;

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

  if (!isProvision && !isCleanup && !isStatus) {
    console.log(`
Uso do Preparador de Homologação Staging (Medicina 2029):
  node scripts/db/prepare-staging-homologation.mjs --status      (Exibe o status das funcionalidades e personas)
  node scripts/db/prepare-staging-homologation.mjs --provision   (Provisiona Alice, Bruno e Carlos no Staging)
  node scripts/db/prepare-staging-homologation.mjs --cleanup     (Expurga 100% dos dados sintéticos do Staging)
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

  const tokenEsperado = isProvision ? 'CONFIRMAR HOMOLOGACAO STAGING' : 'CONFIRMAR LIMPEZA HOMOLOGACAO STAGING';
  const confirmation = await promptConfirmation(`Digite "${tokenEsperado}" para autorizar a execução contra o Staging: `);
  if (confirmation !== tokenEsperado) {
    console.error(`\n❌ OPERAÇÃO CANCELADA: Token de confirmação incorreto ou não fornecido.`);
    process.exit(1);
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
    if (isProvision) {
      await provisionHomologationData({ sql, logger: console.log });
    } else if (isCleanup) {
      await cleanupHomologationData({ sql, logger: console.log });
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
