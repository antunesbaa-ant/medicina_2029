#!/usr/bin/env node

/**
 * MEDICINA 2029 — H2.01-R
 * Lançador Seguro e Interativo do Seed de Staging (seed-staging)
 *
 * Popula o ambiente de homologação (ynfocaorhadizlvbnzrt) com dados 100% sintéticos (Zero PII):
 *   - Fixa o projeto ynfocaorhadizlvbnzrt e Session Pooler aws-0-us-east-1.pooler.supabase.com:5432.
 *   - Utiliza a role administrativa postgres.ynfocaorhadizlvbnzrt (com BYPASSRLS para contornar
 *     a restrição de inserção em public.allowlist e public.perfis imposta ao medicina_app).
 *   - Exige confirmação humana explícita ("CONFIRMAR SEED STAGING").
 *   - Entrada oculta de senha no terminal (sem eco, sem histórico, sem argv).
 *   - Validação TLS estrita com rejectUnauthorized: true e cadeia CA (prod-ca-2021.crt).
 *   - Idempotência absoluta via ON CONFLICT em todas as entidades.
 */

import tls from 'node:tls';
import readline from 'node:readline';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

import {
  resolveCaCertificate,
  promptHiddenPassword,
  buildStagingPoolerUrl,
  sanitizeError,
} from './test-staging-connection.mjs';

import {
  createSyntheticPdfBuffer,
  STAGING_ALICE_EMAIL,
  STAGING_ALICE_PERFIL_ID,
  STAGING_BRUNO_EMAIL,
  STAGING_BRUNO_PERFIL_ID,
  STAGING_CICLO_ID,
} from '../../src/db/seed-staging.ts';

export const TARGET_HOST = 'aws-0-us-east-1.pooler.supabase.com';
export const TARGET_PORT = 5432;
export const TARGET_DB = 'postgres';
export const TARGET_ROLE = 'postgres';
export const TARGET_PROJECT_REF = 'ynfocaorhadizlvbnzrt';
export const TARGET_USERNAME = `${TARGET_ROLE}.${TARGET_PROJECT_REF}`;

export function promptConfirmation(promptText = 'Digite "CONFIRMAR SEED STAGING" para prosseguir: ') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function executeControlledStagingSeed({
  password,
  caCertPath,
  confirmation,
  studentPassword,
  responsiblePassword,
  sqlInstance = null,
  storageClient = null,
  logger = console.log,
}) {
  if (confirmation !== 'CONFIRMAR SEED STAGING') {
    throw new Error(
      `OPERAÇÃO CANCELADA: Confirmação humana explícita não fornecida (esperado "CONFIRMAR SEED STAGING", recebido "${confirmation}").`
    );
  }

  process.env.APP_ENV = 'staging';
  process.env.CONFIRM_STAGING_SEED = 'true';
  process.env.STAGING_SUPABASE_PROJECT_REF = TARGET_PROJECT_REF;
  process.env.CONFIRM_ISOLATED_STAGING_ENVIRONMENT = 'true';

  let resolvedStorage = storageClient;
  if (!resolvedStorage && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_URL) {
    resolvedStorage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  let caInfo = null;
  let sql = sqlInstance;
  let shouldCloseSql = false;

  if (!sql) {
    if (!password) {
      throw new Error('Senha administrativa não fornecida.');
    }

    caInfo = resolveCaCertificate(caCertPath);
    if (!caInfo) {
      throw new Error('CERTIFICADO TLS AUSENTE: O certificado CA do Supabase (prod-ca-2021.crt) não foi localizado.');
    }

    if (caInfo.metadata?.fingerprint256 !== '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA') {
      throw new Error(
        `FALHA DE SEGURANÇA: Fingerprint SHA-256 do certificado CA diverge do canônico do Supabase! ` +
        `Obtido: ${caInfo.metadata?.fingerprint256}`
      );
    }

    const dbUrl = buildStagingPoolerUrl(password);
    const sslOptions = {
      rejectUnauthorized: true,
      ca: [...tls.rootCertificates, caInfo.content],
    };

    sql = postgres(dbUrl, {
      max: 1,
      connect_timeout: 20,
      idle_timeout: 10,
      ssl: sslOptions,
    });
    shouldCloseSql = true;
  }

  const startTime = Date.now();

  try {
    logger('🔒 Conexão administrativa (BYPASSRLS) estabelecida.');
    logger('🌱 Iniciando carga sintética idempotente no Supabase Staging...');

    // Resolução de senhas sintéticas dos perfis de teste
    const pwdEstudante = studentPassword || crypto.randomBytes(16).toString('hex');
    const pwdResponsavel = responsiblePassword || crypto.randomBytes(16).toString('hex');

    const salt = await bcrypt.genSalt(10);
    const hashEstudante = await bcrypt.hash(pwdEstudante, salt);
    const hashResponsavel = await bcrypt.hash(pwdResponsavel, salt);

    // 1. Inserir na Allowlist
    logger('   • Atualizando public.allowlist com usuários sintéticos...');
    await sql`
      INSERT INTO public.allowlist (email)
      VALUES (${STAGING_ALICE_EMAIL}), (${STAGING_BRUNO_EMAIL})
      ON CONFLICT (email) DO NOTHING;
    `;

    // 2. Inserir Perfis
    logger('   • Criando/atualizando perfis sintéticos (Alice e Bruno)...');
    await sql`
      INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
      VALUES
        (${STAGING_ALICE_PERFIL_ID}::uuid, ${STAGING_ALICE_PERFIL_ID}::uuid, 'Alice Estudante Sintética', ${STAGING_ALICE_EMAIL}, ${hashEstudante}, 'estudante'),
        (${STAGING_BRUNO_PERFIL_ID}::uuid, ${STAGING_BRUNO_PERFIL_ID}::uuid, 'Bruno Responsável Sintético', ${STAGING_BRUNO_EMAIL}, ${hashResponsavel}, 'responsavel')
      ON CONFLICT (id) DO UPDATE SET
        nome = EXCLUDED.nome,
        email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        papel = EXCLUDED.papel;
    `;

    // 3. Vínculo Responsável-Estudante
    logger('   • Configurando vínculo de tutoria pedagógica...');
    await sql`
      INSERT INTO public.responsavel_estudante (vinculo_id, responsavel_perfil_id, estudante_perfil_id)
      VALUES (1, ${STAGING_BRUNO_PERFIL_ID}::uuid, ${STAGING_ALICE_PERFIL_ID}::uuid)
      ON CONFLICT (vinculo_id) DO UPDATE SET
        responsavel_perfil_id = EXCLUDED.responsavel_perfil_id,
        estudante_perfil_id = EXCLUDED.estudante_perfil_id;
    `;

    // 4. Disciplinas
    logger('   • Inserindo 5 disciplinas canônicas...');
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

    // 5. Tópicos
    logger('   • Inserindo 10 tópicos sintéticos de alta relevância...');
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

    // 6. Ciclo e Blocos
    logger('   • Configurando ciclo pedagógico (28 blocos semanais)...');
    await sql`
      INSERT INTO public.ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana)
      VALUES (${STAGING_CICLO_ID}::uuid, ${STAGING_ALICE_PERFIL_ID}::uuid, 'Ciclo Sintético Homologação 2029', 2027, true, 28)
      ON CONFLICT (id) DO UPDATE SET
        nome = EXCLUDED.nome, ano_letivo = EXCLUDED.ano_letivo, ativo = EXCLUDED.ativo, blocos_previstos_semana = EXCLUDED.blocos_previstos_semana;
    `;

    const tiposBloco = ['conteudo', 'questoes', 'revisao_srs'];
    const estilos = ['enem', 'misto', 'conteudista'];
    for (let i = 1; i <= 28; i++) {
      const disc = discConfigs[(i - 1) % discConfigs.length];
      const tipo = tiposBloco[(i - 1) % tiposBloco.length];
      const estiloAlvo = estilos[(i - 1) % estilos.length];
      const blocoId = `41000000-0000-4000-8000-${i.toString().padStart(12, '0')}`;

      await sql`
        INSERT INTO public.ciclo_blocos (id, ciclo_id, disciplina_id, ordem, tipo, estilo_alvo, duracao_min)
        VALUES (${blocoId}::uuid, ${STAGING_CICLO_ID}::uuid, ${disc.id}::uuid, ${i}, ${tipo}, ${estiloAlvo}, 50)
        ON CONFLICT (id) DO UPDATE SET
          ordem = EXCLUDED.ordem, tipo = EXCLUDED.tipo, estilo_alvo = EXCLUDED.estilo_alvo, duracao_min = EXCLUDED.duracao_min;
      `;
    }

    await sql`
      INSERT INTO public.ciclo_estado (ciclo_id, proxima_ordem)
      VALUES (${STAGING_CICLO_ID}::uuid, 1)
      ON CONFLICT (ciclo_id) DO UPDATE SET proxima_ordem = 1;
    `;

    // 7. Cards FSRS
    logger('   • Inserindo 6 flashcards FSRS com estados representativos...');
    const agora = new Date();
    const dezDiasFrente = new Date(agora.getTime() + 10 * 86_400_000);
    const cincoDiasAtras = new Date(agora.getTime() - 5 * 86_400_000);
    const cardsConfigs = [
      { id: 'c1000000-0000-4000-8000-000000000001', topicoId: topicosConfigs[2].id, frente: 'Qual a principal função da mitocôndria?', verso: 'Produção de ATP via respiração celular.', state: 'new', due: agora, stability: 0.0, difficulty: 0.0, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0 },
      { id: 'c1000000-0000-4000-8000-000000000002', topicoId: topicosConfigs[3].id, frente: 'O que diz a 1ª Lei de Mendel?', verso: 'Cada caráter é determinado por um par de fatores que se segregam na formação dos gametas.', state: 'learning', due: agora, stability: 1.5, difficulty: 4.0, elapsedDays: 1, scheduledDays: 1, reps: 1, lapses: 0 },
      { id: 'c1000000-0000-4000-8000-000000000003', topicoId: topicosConfigs[4].id, frente: 'Em condições normais de CNTP, qual o volume ocupado por 1 mol de gás ideal?', verso: '22,4 Litros.', state: 'review', due: dezDiasFrente, stability: 12.0, difficulty: 3.0, elapsedDays: 15, scheduledDays: 25, reps: 4, lapses: 0 },
      { id: 'c1000000-0000-4000-8000-000000000004', topicoId: topicosConfigs[6].id, frente: 'Fórmula da velocidade média no MRU?', verso: 'v = delta_s / delta_t.', state: 'review', due: cincoDiasAtras, stability: 8.0, difficulty: 3.5, elapsedDays: 12, scheduledDays: 7, reps: 3, lapses: 0 },
      { id: 'c1000000-0000-4000-8000-000000000005', topicoId: topicosConfigs[0].id, frente: 'Definição de grandezas inversamente proporcionais?', verso: 'O produto entre os valores correspondentes é constante.', state: 'relearning', due: agora, stability: 0.8, difficulty: 6.0, elapsedDays: 3, scheduledDays: 1, reps: 2, lapses: 1 },
      { id: 'c1000000-0000-4000-8000-000000000006', topicoId: topicosConfigs[8].id, frente: 'Quais os 5 elementos obrigatórios da proposta de intervenção no ENEM?', verso: 'Agente, Ação, Meio/Modo, Efeito e Detalhamento.', state: 'review', due: dezDiasFrente, stability: 15.0, difficulty: 2.5, elapsedDays: 20, scheduledDays: 30, reps: 5, lapses: 0 },
    ];
    for (const c of cardsConfigs) {
      await sql`
        INSERT INTO public.cards (id, perfil_id, topico_id, frente, verso, origem, status, suspenso, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state)
        VALUES (${c.id}::uuid, ${STAGING_ALICE_PERFIL_ID}::uuid, ${c.topicoId}::uuid, ${c.frente}, ${c.verso}, 'manual', 'aprovado', false, ${c.due}, ${c.stability}, ${c.difficulty}, ${c.elapsedDays}, ${c.scheduledDays}, ${c.reps}, ${c.lapses}, ${c.state})
        ON CONFLICT (id) DO UPDATE SET
          frente = EXCLUDED.frente, verso = EXCLUDED.verso, due = EXCLUDED.due, stability = EXCLUDED.stability, difficulty = EXCLUDED.difficulty, elapsed_days = EXCLUDED.elapsed_days, scheduled_days = EXCLUDED.scheduled_days, reps = EXCLUDED.reps, lapses = EXCLUDED.lapses, state = EXCLUDED.state;
      `;
    }

    // 8. Arquivos Didáticos Sintéticos (PDFs válidos, Chunks e Embeddings)
    logger('   • Inserindo 3 apostilas sintéticas com embeddings e jobs...');
    const pdfDefinitions = [
      { id: 'f0000000-0000-4000-8000-000000000001', disciplinaId: discConfigs[1].id, titulo: 'Apostila Sintética — Citologia e Respiração', slug: 'citologia' },
      { id: 'f0000000-0000-4000-8000-000000000002', disciplinaId: discConfigs[2].id, titulo: 'Apostila Sintética — Estequiometria Básica', slug: 'estequiometria' },
      { id: 'f0000000-0000-4000-8000-000000000003', disciplinaId: discConfigs[0].id, titulo: 'Apostila Sintética — Matemática e Proporções', slug: 'proporcoes' },
    ];

    const mockVector = new Array(1536).fill(0);
    mockVector[0] = 0.6;
    mockVector[1] = 0.8;
    const vectorStr = `[${mockVector.join(',')}]`;

    for (const doc of pdfDefinitions) {
      const buffer = createSyntheticPdfBuffer(doc.titulo, `Conteúdo sintético de teste para ${doc.titulo}.`);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const filePath = `acervo/${sha256}_${doc.slug}.pdf`;

      await sql`
        INSERT INTO public.acervo_arquivos (id, disciplina_id, titulo, tipo_material, serie_alvo, vestibular, file_path, mime, tamanho_bytes, paginas, enviado_por, status_processamento, hash_conteudo)
        VALUES (${doc.id}::uuid, ${doc.disciplinaId}::uuid, ${doc.titulo}, 'apostila', 1, 'ENEM/UECE', ${filePath}, 'application/pdf', ${buffer.length}, 1, ${STAGING_BRUNO_PERFIL_ID}::uuid, 'concluido', ${sha256})
        ON CONFLICT (id) DO UPDATE SET
          titulo = EXCLUDED.titulo, file_path = EXCLUDED.file_path, tamanho_bytes = EXCLUDED.tamanho_bytes, hash_conteudo = EXCLUDED.hash_conteudo, status_processamento = 'concluido';
      `;

      const paginaId = `f1000000-0000-4000-8000-${doc.id.slice(24)}`;
      await sql`
        INSERT INTO public.acervo_paginas (id, arquivo_id, numero, texto_extraido, metodo_extracao, confianca_ocr)
        VALUES (${paginaId}::uuid, ${doc.id}::uuid, 1, 'Texto extraido da pagina sintetica', 'nativo', 1.0)
        ON CONFLICT (id) DO UPDATE SET texto_extraido = EXCLUDED.texto_extraido;
      `;

      const chunkId = `f2000000-0000-4000-8000-${doc.id.slice(24)}`;
      await sql`
        INSERT INTO public.acervo_chunks (id, arquivo_id, pagina_inicial, pagina_final, ordem, texto, tipo_conteudo, topico_id, confianca_classificacao, embedding, tokens)
        VALUES (${chunkId}::uuid, ${doc.id}::uuid, 1, 1, 1, 'Texto do chunk teorico sintético', 'exposicao_teorica', ${topicosConfigs[2].id}::uuid, 0.95, ${vectorStr}::vector, 35)
        ON CONFLICT (id) DO UPDATE SET texto = EXCLUDED.texto, embedding = EXCLUDED.embedding;
      `;

      const jobId = `f3000000-0000-4000-8000-${doc.id.slice(24)}`;
      await sql`
        INSERT INTO public.acervo_jobs (id, arquivo_id, enviado_por, status, etapa_atual, tentativas, max_tentativas, concluido_em)
        VALUES (${jobId}::uuid, ${doc.id}::uuid, ${STAGING_BRUNO_PERFIL_ID}::uuid, 'concluido', 'concluido', 1, 3, ${agora})
        ON CONFLICT (id) DO UPDATE SET status = 'concluido', etapa_atual = 'concluido';
      `;

      if (resolvedStorage) {
        const { error: uploadError } = await resolvedStorage.storage
          .from('acervo')
          .upload(filePath, buffer, { contentType: 'application/pdf', upsert: true });
        if (uploadError) {
          logger(`   ⚠️  Aviso: Falha ao enviar ${filePath} para o Supabase Storage: ${uploadError.message}`);
        } else {
          logger(`   📦 Objeto binário sincronizado no Storage: ${filePath}`);
        }
      }
    }

    if (!resolvedStorage) {
      logger('   ℹ️  Nota de Storage: SUPABASE_SERVICE_ROLE_KEY não configurada nesta sessão.');
      logger('       Metadados registrados no banco; sincronização de binários com o bucket acervo pendente.');
    }

    const elapsed = Date.now() - startTime;
    logger(`\n✅ SEED CONCLUÍDO COM SUCESSO EM ${elapsed}ms!`);

    return {
      success: true,
      perfis: 2,
      disciplinas: discConfigs.length,
      topicos: topicosConfigs.length,
      ciclos: 1,
      blocos: 28,
      cards: cardsConfigs.length,
      arquivos: pdfDefinitions.length,
      duracaoMs: elapsed,
    };
  } finally {
    if (shouldCloseSql && sql) {
      await sql.end();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const caArg = args.find((a) => a.startsWith('--ca='))?.split('=')[1] ||
                args.find((a) => a.startsWith('--ca-cert='))?.split('=')[1];

  console.log('================================================================');
  console.log('MEDICINA 2029 — LANÇADOR SEGURO DE SEED SINTÉTICO (STAGING)');
  console.log('================================================================');
  console.log(`Projeto Alvo:        ${TARGET_PROJECT_REF}`);
  console.log(`Session Pooler:      ${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`Administrador:       ${TARGET_USERNAME}`);
  console.log(`Banco:               ${TARGET_DB}`);
  console.log('Isolamento:          Zero PII, Senhas Bcrypt, IDs Determinísticos');
  console.log('================================================================\n');

  let adminPassword = '';

  try {
    adminPassword = await promptHiddenPassword('Digite a senha da role postgres do Supabase: ');
    if (!adminPassword) {
      console.error('❌ Senha administrativa não fornecida. Abortando.');
      process.exit(1);
    }

    console.log('\n⚠️  ATENÇÃO: Esta operação inserirá dados sintéticos de teste no Supabase Staging.');
    const confirmation = await promptConfirmation();

    await executeControlledStagingSeed({
      password: adminPassword,
      caCertPath: caArg,
      confirmation,
    });

    console.log('\n================================================================');
    console.log('🎉 SEED SINTÉTICO CARREGADO COM ÊXITO NO STAGING!');
    console.log('================================================================\n');
  } catch (err) {
    console.error('\n❌ ERRO NA EXECUÇÃO DO SEED:');
    console.error(sanitizeError(err));
    process.exit(1);
  } finally {
    adminPassword = '';
  }
}

if (process.argv[1]?.includes('apply-staging-seed')) {
  main();
}
