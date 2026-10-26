/**
 * MEDICINA 2029 — H1.02
 * Seed Idempotente e Seguro para Ambiente de Staging (seed-staging)
 *
 * Popula o ambiente de homologação com dados 100% sintéticos (Zero PII),
 * calculando hashes e tamanhos a partir dos bytes reais dos artefatos didáticos,
 * exigindo autorização explícita e bloqueando sumariamente qualquer tentativa
 * de execução contra bancos produtivos.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { db } from './index';
import {
  perfis,
  disciplinas,
  topicos,
  ciclos,
  cicloBlocos,
  cicloEstado,
  cards,
  acervoArquivos,
  acervoPaginas,
  acervoChunks,
} from './schema';
import { acervoJobs } from '../lib/acervoPipelineWorker';
import { assertStagingIsolation, isStagingEnvironment } from '../lib/envGuard';

export interface SeedStagingOptions {
  studentPassword?: string;
  responsiblePassword?: string;
  dryRun?: boolean;
  dbInstance?: any;
}

export interface SeedStagingSummary {
  perfisCriados: number;
  disciplinasCriadas: number;
  topicosCriados: number;
  ciclosCriados: number;
  blocosCriados: number;
  cardsCriados: number;
  arquivosCriados: number;
  paginasCriadas: number;
  chunksCriados: number;
  jobsCriados: number;
  tempoMs: number;
}

// ----------------------------------------------------------------------------
// IDENTIFICADORES CANÔNICOS DETERMINÍSTICOS (RFC 4122 v4 VÁLIDOS)
// ----------------------------------------------------------------------------
export const STAGING_ALICE_PERFIL_ID = '10000000-0000-4000-8000-000000000001';
export const STAGING_BRUNO_PERFIL_ID = '20000000-0000-4000-8000-000000000001';
export const STAGING_CICLO_ID = '40000000-0000-4000-8000-000000000001';

export const STAGING_ALICE_EMAIL = 'alice@medicina2029.staging';
export const STAGING_BRUNO_EMAIL = 'bruno@medicina2029.staging';

/**
 * Gera um buffer de PDF sintético perfeitamente válido conforme a especificação PDF 1.4,
 * contendo cabeçalho, catálogo, páginas, fluxo de texto, tabela de referências cruzadas e trailer.
 */
export function createSyntheticPdfBuffer(title: string, bodyText: string): Buffer {
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

  const pad = (n: number) => n.toString().padStart(10, '0');

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

/**
 * Validação de salvaguardas fail-closed para impedir execução fora de staging ou contra produção.
 */
export function assertCanRunStagingSeed(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): void {
  // 1. Proibição absoluta em produção
  if (env.NODE_ENV === 'production' && env.APP_ENV !== 'staging') {
    throw new Error('PRODUÇÃO BLOQUEADA: É expressamente proibido executar seed-staging em ambiente de produção!');
  }
  if (env.APP_ENV === 'production') {
    throw new Error('PRODUÇÃO BLOQUEADA: APP_ENV=production detectado. Seed sumariamente abortado!');
  }

  // 2. Exigência de autorização explícita
  const isAuthorized =
    env.CONFIRM_STAGING_SEED === 'true' ||
    env.ALLOW_STAGING_SEED === 'true' ||
    env.NODE_ENV === 'test';

  if (!isAuthorized) {
    throw new Error(
      'Seed de staging bloqueado: requer autorização explícita via variável CONFIRM_STAGING_SEED=true ou ALLOW_STAGING_SEED=true.'
    );
  }

  // 3. Se estiver em modo staging, valida o guardião fail-closed
  if (isStagingEnvironment(env)) {
    assertStagingIsolation(env);
  }

  // 4. Bloqueio contra bancos produtivos ou não identificados
  const dbUrl = env.DATABASE_URL || env.DATABASE_APP_URL || '';
  const prodRef = env.PRODUCTION_SUPABASE_PROJECT_REF?.trim();
  if (prodRef && dbUrl.includes(prodRef)) {
    throw new Error('PRODUÇÃO BLOQUEADA: DATABASE_URL aponta para o projeto de produção!');
  }
  if (dbUrl.includes('medicina_prod') || dbUrl.includes('production')) {
    throw new Error('PRODUÇÃO BLOQUEADA: Nome de banco produtivo detectado em DATABASE_URL!');
  }
}

/**
 * Executa a carga idempotente dos dados sintéticos de homologação.
 */
export async function seedStaging(options: SeedStagingOptions = {}): Promise<SeedStagingSummary> {
  assertCanRunStagingSeed(process.env);
  const targetDb = options.dbInstance ?? db;
  const startTime = Date.now();

  // 1. Resolução segura de senhas (sem hardcoding em ambiente publicado)
  let studentPassword = options.studentPassword || process.env.STAGING_STUDENT_PASSWORD?.trim();
  let responsiblePassword = options.responsiblePassword || process.env.STAGING_RESPONSIBLE_PASSWORD?.trim();

  if (!studentPassword || !responsiblePassword) {
    if (process.env.APP_ENV === 'staging') {
      // Em staging publicado, gera senhas aleatórias de alta entropia se não forem fornecidas via env
      studentPassword = studentPassword || crypto.randomBytes(16).toString('hex');
      responsiblePassword = responsiblePassword || crypto.randomBytes(16).toString('hex');
    } else {
      // Em testes automatizados e desenvolvimento local efêmero
      studentPassword = studentPassword || 'senha_staging_teste_2029';
      responsiblePassword = responsiblePassword || 'senha_staging_teste_2029';
    }
  }

  const salt = await bcrypt.genSalt(10);
  const hashEstudante = await bcrypt.hash(studentPassword, salt);
  const hashResponsavel = await bcrypt.hash(responsiblePassword, salt);

  // 2. Allowlist de Staging (Mandatória antes de inserir em perfis devido à trigger check_allowlist)
  await targetDb.execute(sql`
    INSERT INTO public.allowlist (email)
    VALUES (${STAGING_ALICE_EMAIL}), (${STAGING_BRUNO_EMAIL})
    ON CONFLICT (email) DO NOTHING;
  `);

  // 3. Perfis Sintéticos (Alice e Bruno)
  await targetDb
    .insert(perfis)
    .values([
      {
        id: STAGING_ALICE_PERFIL_ID,
        authUserId: STAGING_ALICE_PERFIL_ID,
        nome: 'Alice Estudante Sintética',
        email: STAGING_ALICE_EMAIL,
        passwordHash: hashEstudante,
        papel: 'estudante',
      },
      {
        id: STAGING_BRUNO_PERFIL_ID,
        authUserId: STAGING_BRUNO_PERFIL_ID,
        nome: 'Bruno Responsável Sintético',
        email: STAGING_BRUNO_EMAIL,
        passwordHash: hashResponsavel,
        papel: 'responsavel',
      },
    ])
    .onConflictDoUpdate({
      target: perfis.id,
      set: {
        nome: sql`excluded.nome`,
        email: sql`excluded.email`,
        passwordHash: sql`excluded.password_hash`,
        papel: sql`excluded.papel`,
      },
    });

  // 4. Vínculo Responsável-Estudante
  await targetDb.execute(sql`
    INSERT INTO public.responsavel_estudante (vinculo_id, responsavel_perfil_id, estudante_perfil_id)
    VALUES (1, ${STAGING_BRUNO_PERFIL_ID}::uuid, ${STAGING_ALICE_PERFIL_ID}::uuid)
    ON CONFLICT (vinculo_id) DO UPDATE SET
      responsavel_perfil_id = excluded.responsavel_perfil_id,
      estudante_perfil_id = excluded.estudante_perfil_id;
  `);

  // 5. Disciplinas Sintéticas Canônicas
  const discConfigs = [
    { id: 'd0000000-0000-4000-8000-000000000001', nome: 'Matemática', area: 'matematica' as const, corHex: '#C98A2E', ordem: 1 },
    { id: 'd0000000-0000-4000-8000-000000000002', nome: 'Biologia', area: 'natureza' as const, corHex: '#0E3D4D', ordem: 2 },
    { id: 'd0000000-0000-4000-8000-000000000003', nome: 'Química', area: 'natureza' as const, corHex: '#17607A', ordem: 3 },
    { id: 'd0000000-0000-4000-8000-000000000004', nome: 'Física', area: 'natureza' as const, corHex: '#B5502B', ordem: 4 },
    { id: 'd0000000-0000-4000-8000-000000000005', nome: 'Redação', area: 'redacao' as const, corHex: '#DE6B48', ordem: 5 },
  ];

  for (const d of discConfigs) {
    await targetDb
      .insert(disciplinas)
      .values(d)
      .onConflictDoUpdate({
        target: disciplinas.id,
        set: { nome: d.nome, area: d.area, corHex: d.corHex, ordem: d.ordem },
      });
  }

  // 6. Tópicos Sintéticos
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
    await targetDb
      .insert(topicos)
      .values({
        id: t.id,
        disciplinaId: t.discId,
        nome: t.nome,
        seriePrevista: 1,
        incidenciaEnem: t.enem,
        incidenciaUece: t.uece,
        ordem: t.ordem,
        coberturaMaterial: 'sem_fonte',
      })
      .onConflictDoUpdate({
        target: topicos.id,
        set: {
          nome: t.nome,
          ordem: t.ordem,
          incidenciaEnem: t.enem,
          incidenciaUece: t.uece,
        },
      });
  }

  // 7. Ciclo de Estudos Sintético (28 Blocos)
  await targetDb
    .insert(ciclos)
    .values({
      id: STAGING_CICLO_ID,
      estudantePerfilId: STAGING_ALICE_PERFIL_ID,
      nome: 'Ciclo Sintético Homologação 2029',
      anoLetivo: 2027,
      ativo: true,
      blocosPrevistosSemana: 28,
    })
    .onConflictDoUpdate({
      target: ciclos.id,
      set: {
        nome: 'Ciclo Sintético Homologação 2029',
        anoLetivo: 2027,
        ativo: true,
        blocosPrevistosSemana: 28,
      },
    });

  // 28 blocos pedagógicos estruturados
  const tiposBloco = ['conteudo', 'questoes', 'revisao_srs'] as const;
  const estilos = ['enem', 'misto', 'conteudista'] as const;
  for (let i = 1; i <= 28; i++) {
    const disc = discConfigs[(i - 1) % discConfigs.length];
    const tipo = tiposBloco[(i - 1) % tiposBloco.length];
    const estiloAlvo = estilos[(i - 1) % estilos.length];

    await targetDb
      .insert(cicloBlocos)
      .values({
        id: `41000000-0000-4000-8000-${i.toString().padStart(12, '0')}`,
        cicloId: STAGING_CICLO_ID,
        disciplinaId: disc.id,
        ordem: i,
        tipo,
        estiloAlvo,
        duracaoMin: 50,
      })
      .onConflictDoUpdate({
        target: cicloBlocos.id,
        set: {
          ordem: i,
          tipo,
          estiloAlvo,
          duracaoMin: 50,
        },
      });
  }

  // Estado do ciclo
  await targetDb
    .insert(cicloEstado)
    .values({
      cicloId: STAGING_CICLO_ID,
      proximaOrdem: 1,
    })
    .onConflictDoUpdate({
      target: cicloEstado.cicloId,
      set: {
        proximaOrdem: 1,
      },
    });

  // 8. FSRS Cards (6 Cards cobrindo todos os estados do algoritmo)
  const agora = new Date();
  const dezDiasFrente = new Date(agora.getTime() + 10 * 86_400_000);
  const quinzeDiasAtras = new Date(agora.getTime() - 15 * 86_400_000);

  const cardsConfigs = [
    {
      id: '30000000-0000-4000-8000-000000000001',
      topicoId: topicosConfigs[2].id, // Biologia
      frente: 'Qual é a função primordial das cristas mitocondriais?',
      verso: 'Aumentar a área de superfície da membrana interna para a cadeia de transporte de elétrons e síntese de ATP.',
      state: 'new',
      due: agora,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
    },
    {
      id: '30000000-0000-4000-8000-000000000002',
      topicoId: topicosConfigs[2].id,
      frente: 'Onde ocorre o ciclo de Krebs na célula eucariótica?',
      verso: 'Na matriz mitocondrial.',
      state: 'learning',
      due: agora,
      stability: 1.5,
      difficulty: 5.0,
      elapsedDays: 1,
      scheduledDays: 1,
      reps: 1,
      lapses: 0,
    },
    {
      id: '30000000-0000-4000-8000-000000000003',
      topicoId: topicosConfigs[6].id, // Física
      frente: 'Como se define aceleração escalar média?',
      verso: 'Razão entre a variação de velocidade escalar e o intervalo de tempo decorrido (Delta v / Delta t).',
      state: 'review',
      due: agora,
      stability: 3.2,
      difficulty: 4.8,
      elapsedDays: 3,
      scheduledDays: 3,
      reps: 2,
      lapses: 0,
    },
    {
      id: '30000000-0000-4000-8000-000000000004',
      topicoId: topicosConfigs[6].id,
      frente: 'No MUV, qual a equação que relaciona velocidade e posição sem o tempo?',
      verso: 'Equação de Torricelli: v^2 = v0^2 + 2 * a * Delta s.',
      state: 'review',
      due: dezDiasFrente,
      stability: 12.0,
      difficulty: 3.5,
      elapsedDays: 5,
      scheduledDays: 15,
      reps: 4,
      lapses: 0,
    },
    {
      id: '30000000-0000-4000-8000-000000000005',
      topicoId: topicosConfigs[8].id, // Redação
      frente: 'Quais são os 5 elementos obrigatórios da proposta de intervenção no ENEM?',
      verso: 'Agente, Ação, Meio/Modo, Efeito e Detalhamento de um dos elementos.',
      state: 'relearning',
      due: agora,
      stability: 1.0,
      difficulty: 6.5,
      elapsedDays: 2,
      scheduledDays: 1,
      reps: 3,
      lapses: 1,
    },
    {
      id: '30000000-0000-4000-8000-000000000006',
      topicoId: topicosConfigs[4].id, // Química
      frente: 'Em estequiometria, o que define o reagente limitante?',
      verso: 'É o reagente consumido totalmente primeiro, determinando a quantidade máxima de produto formado.',
      state: 'review',
      due: quinzeDiasAtras,
      stability: 4.0,
      difficulty: 5.5,
      elapsedDays: 20,
      scheduledDays: 5,
      reps: 3,
      lapses: 0,
    },
  ];

  for (const c of cardsConfigs) {
    await targetDb
      .insert(cards)
      .values({
        id: c.id,
        perfilId: STAGING_ALICE_PERFIL_ID,
        topicoId: c.topicoId,
        frente: c.frente,
        verso: c.verso,
        origem: 'manual',
        status: 'aprovado',
        suspenso: false,
        due: c.due,
        stability: c.stability,
        difficulty: c.difficulty,
        elapsedDays: c.elapsedDays,
        scheduledDays: c.scheduledDays,
        reps: c.reps,
        lapses: c.lapses,
        state: c.state,
      })
      .onConflictDoUpdate({
        target: cards.id,
        set: {
          frente: c.frente,
          verso: c.verso,
          due: c.due,
          stability: c.stability,
          difficulty: c.difficulty,
          state: c.state,
        },
      });
  }

  // 9. Documentos de Acervo com Bytes Reais e Hashes Determinísticos
  const pdfDefinitions = [
    {
      id: 'f0000000-0000-4000-8000-000000000001',
      disciplinaId: discConfigs[1].id,
      titulo: 'Biologia Celular: Estrutura e Função Mitocondrial',
      slug: 'biologia_celular_mitocondrias',
      conteudo: 'A respiracao celular produz ATP na membrana interna mitocondrial atraves da fosforilacao oxidativa.',
    },
    {
      id: 'f0000000-0000-4000-8000-000000000002',
      disciplinaId: discConfigs[3].id,
      titulo: 'Física: Fundamentos de Cinemática Escalar',
      slug: 'fisica_cinematica_vetorial',
      conteudo: 'No movimento retilineo uniforme a velocidade e constante e a aceleracao tangencial e nula.',
    },
    {
      id: 'f0000000-0000-4000-8000-000000000003',
      disciplinaId: discConfigs[4].id,
      titulo: 'Redação: Estrutura do Texto Dissertativo-Argumentativo',
      slug: 'redacao_dissertativa_argumentativa',
      conteudo: 'O paragrafo de introducao deve apresentar o tema, a tese clara e os dois argumentos centrais.',
    },
  ];

  let totalChunks = 0;
  let totalJobs = 0;

  for (const doc of pdfDefinitions) {
    const pdfBuffer = createSyntheticPdfBuffer(doc.titulo, doc.conteudo);
    const tamanhoBytes = pdfBuffer.length;
    const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    const filePath = `acervo/${sha256}_${doc.slug}.pdf`;

    await targetDb
      .insert(acervoArquivos)
      .values({
        id: doc.id,
        disciplinaId: doc.disciplinaId,
        titulo: doc.titulo,
        tipoMaterial: 'apostila',
        serieAlvo: 1,
        vestibular: 'ENEM/UECE',
        filePath,
        mime: 'application/pdf',
        tamanhoBytes,
        paginas: 1,
        enviadoPor: STAGING_BRUNO_PERFIL_ID,
        statusProcessamento: 'concluido',
        hashConteudo: sha256,
      })
      .onConflictDoUpdate({
        target: acervoArquivos.id,
        set: {
          titulo: doc.titulo,
          filePath,
          tamanhoBytes,
          hashConteudo: sha256,
          statusProcessamento: 'concluido',
        },
      });

    // Página sintética
    const paginaId = `f1000000-0000-4000-8000-${doc.id.slice(24)}`;
    await targetDb
      .insert(acervoPaginas)
      .values({
        id: paginaId,
        arquivoId: doc.id,
        numero: 1,
        textoExtraido: doc.conteudo,
        metodoExtracao: 'nativo',
        confiancaOcr: 1.0,
      })
      .onConflictDoUpdate({
        target: acervoPaginas.id,
        set: { textoExtraido: doc.conteudo },
      });

    // Chunk sintético com vetor de 1536 dimensões normalizado
    const chunkId = `f2000000-0000-4000-8000-${doc.id.slice(24)}`;
    const mockVector = new Array(1536).fill(0);
    // Distribuição determinística simples com norma unitária
    mockVector[0] = 0.6;
    mockVector[1] = 0.8;

    await targetDb
      .insert(acervoChunks)
      .values({
        id: chunkId,
        arquivoId: doc.id,
        paginaInicial: 1,
        paginaFinal: 1,
        ordem: 1,
        texto: doc.conteudo,
        tipoConteudo: 'exposicao_teorica',
        topicoId: topicosConfigs[2].id,
        confiancaClassificacao: 0.95,
        embedding: mockVector,
        tokens: 35,
      })
      .onConflictDoUpdate({
        target: acervoChunks.id,
        set: { texto: doc.conteudo, embedding: mockVector },
      });
    totalChunks++;

    // Job de fila sintético associado
    const jobId = `f3000000-0000-4000-8000-${doc.id.slice(24)}`;
    await targetDb
      .insert(acervoJobs)
      .values({
        id: jobId,
        arquivoId: doc.id,
        enviadoPor: STAGING_BRUNO_PERFIL_ID,
        status: 'concluido',
        etapaAtual: 'concluido',
        tentativas: 1,
        maxTentativas: 3,
        concluidoEm: agora,
      })
      .onConflictDoUpdate({
        target: acervoJobs.id,
        set: { status: 'concluido', etapaAtual: 'concluido' },
      });
    totalJobs++;
  }

  const tempoMs = Date.now() - startTime;

  return {
    perfisCriados: 2,
    disciplinasCriadas: discConfigs.length,
    topicosCriados: topicosConfigs.length,
    ciclosCriados: 1,
    blocosCriados: 28,
    cardsCriados: cardsConfigs.length,
    arquivosCriados: pdfDefinitions.length,
    paginasCriadas: pdfDefinitions.length,
    chunksCriados: totalChunks,
    jobsCriados: totalJobs,
    tempoMs,
  };
}

if (process.argv[1]?.includes('seed-staging')) {
  seedStaging()
    .then((summary) => {
      console.log('✅ Seed staging concluído com sucesso:', summary);
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Falha ao executar seed staging:', err);
      process.exit(1);
    });
}
