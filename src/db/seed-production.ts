import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from './index';
import { sql } from 'drizzle-orm';

const FORBIDDEN_STAGING_REF = 'ynfocaorhadizlvbnzrt';

export async function runProductionSeed() {
  console.log('================================================================');
  console.log('MEDICINA 2029 — SEED PEDAGÓGICO DE PRODUÇÃO');
  console.log('================================================================\n');

  // Trava de Segurança 1: Bloqueia execução contra Staging
  const targetAppUrl = process.env.DATABASE_APP_URL || process.env.DATABASE_URL || '';
  if (targetAppUrl.includes(FORBIDDEN_STAGING_REF) || process.env.STAGING_SUPABASE_PROJECT_REF === FORBIDDEN_STAGING_REF) {
    throw new Error(
      `ABORTADO: Tentativa de executar seed de produção contra o ambiente de Staging (${FORBIDDEN_STAGING_REF}).`
    );
  }

  // Trava de Segurança 2: Confirmação explícita
  if (process.env.CONFIRM_PRODUCTION_SEED !== 'true') {
    throw new Error('CONFIRM_PRODUCTION_SEED=true é obrigatório para executar o seed de produção.');
  }

  console.log('🔒 Travas de segurança de ambiente aprovadas.');

  // 1. Geração de Credenciais Criptográficas Seguras
  const salt = await bcrypt.genSalt(12);

  const rawAlicePass = process.env.ALICE_PRODUCTION_PASSWORD || crypto.randomBytes(16).toString('hex') + '!Med29';
  const rawBrunoPass = process.env.BRUNO_PRODUCTION_PASSWORD || crypto.randomBytes(16).toString('hex') + '!Med29';

  const hashAlice = await bcrypt.hash(rawAlicePass, salt);
  const hashBruno = await bcrypt.hash(rawBrunoPass, salt);

  console.log('👤 Provisionando usuários reais (Bruno e Alice)...');
  console.log('ℹ️  Carlos (usuário sintético de homologação) NÃO será provisionado.');

  // 2. Perfis Reais (Idempotente)
  const aliceEmail = 'alice@medicina2029.com.br';
  const brunoEmail = 'bruno@medicina2029.com.br';

  await db.execute(sql`
    INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel)
    VALUES 
      ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Alice Antunes', ${aliceEmail}, ${hashAlice}, 'estudante'),
      ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'Bruno Antunes', ${brunoEmail}, ${hashBruno}, 'responsavel')
    ON CONFLICT (id) DO UPDATE SET
      nome = EXCLUDED.nome,
      email = EXCLUDED.email,
      papel = EXCLUDED.papel;
  `);

  // 3. Vínculo Responsável-Estudante (vinculo_id singleton = 1)
  await db.execute(sql`
    INSERT INTO public.responsavel_estudante (vinculo_id, responsavel_perfil_id, estudante_perfil_id)
    VALUES (1, '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001')
    ON CONFLICT (vinculo_id) DO NOTHING;
  `);

  // 4. Disciplinas Oficiais (11 disciplinas)
  console.log('📚 Provisionando Disciplinas e Estrutura Curricular...');
  const discData = [
    { nome: 'Matemática', area: 'matematica' as const, corHex: '#C98A2E', ordem: 1 },
    { nome: 'Biologia', area: 'natureza' as const, corHex: '#0E3D4D', ordem: 2 },
    { nome: 'Química', area: 'natureza' as const, corHex: '#17607A', ordem: 3 },
    { nome: 'Física', area: 'natureza' as const, corHex: '#B5502B', ordem: 4 },
    { nome: 'Redação', area: 'redacao' as const, corHex: '#DE6B48', ordem: 5 },
    { nome: 'Linguagens', area: 'linguagens' as const, corHex: '#7A306C', ordem: 6 },
    { nome: 'História', area: 'humanas' as const, corHex: '#8B575C', ordem: 7 },
    { nome: 'Geografia', area: 'humanas' as const, corHex: '#3A506B', ordem: 8 },
    { nome: 'Filosofia', area: 'humanas' as const, corHex: '#5BC0BE', ordem: 9 },
    { nome: 'Sociologia', area: 'humanas' as const, corHex: '#6FFFE9', ordem: 10 },
    { nome: 'Língua Estrangeira', area: 'linguagens' as const, corHex: '#48A9A6', ordem: 11 },
  ];

  for (const d of discData) {
    await db.execute(sql`
      INSERT INTO public.disciplinas (nome, area, cor_hex, ordem)
      VALUES (${d.nome}, ${d.area}, ${d.corHex}, ${d.ordem})
      ON CONFLICT DO NOTHING;
    `);
  }

  console.log('✅ Disciplinas provisionadas com sucesso.');
  console.log('🎉 Seed de produção concluído com sucesso.');
}
