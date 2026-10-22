import net from 'node:net';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROJECT_ROOT = process.cwd();
const MODULE_ROOT = '/tmp/pglite-f104-modules/node_modules';

const { PGlite } = await import(pathToFileURL(path.join(MODULE_ROOT, '@electric-sql/pglite/dist/index.js')).href);
const { vector } = await import(pathToFileURL(path.join(MODULE_ROOT, '@electric-sql/pglite-pgvector/dist/index.js')).href);
const { fromNodeSocket } = await import(pathToFileURL(path.join(MODULE_ROOT, 'pg-gateway/dist/platforms/node/index.js')).href);
const bcrypt = (await import(pathToFileURL(path.join(PROJECT_ROOT, 'node_modules/bcryptjs/index.js')).href)).default;

console.log('⚡ Inicializando PGlite com suporte a pgvector...');
const db = new PGlite({
  extensions: { vector }
});
await db.waitReady;

function readSql(relativePath) {
  const fullPath = path.join(PROJECT_ROOT, relativePath);
  if (!existsSync(fullPath)) return '';
  return readFileSync(fullPath, 'utf8').replaceAll('--> statement-breakpoint', '\n');
}

console.log('🔄 Aplicando migrações DDL...');
await db.exec(readSql('drizzle/0000_greedy_loki.sql'));
await db.exec(readSql('drizzle/0001_dry_talos.sql'));
await db.exec(readSql('drizzle/0002_little_swarm.sql'));
await db.exec(readSql('drizzle/0003_f1_03_r_expansao.sql'));

console.log('🔒 Aplicando propostas de segurança e extensões...');
await db.exec(readSql('docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql'));
await db.exec(readSql('docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql'));
await db.exec(readSql('docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql'));
await db.exec(readSql('docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql'));
await db.exec(readSql('docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql'));

console.log('🌱 Populando dados de desenvolvimento e usuários de acesso...');
const salt = await bcrypt.genSalt(10);
const hashEstudante = await bcrypt.hash('senha_estudante_2029', salt);
const hashResponsavel = await bcrypt.hash('senha_responsavel_2029', salt);

// Inserir perfis
await db.exec(`
  INSERT INTO public.perfis (id, auth_user_id, nome, email, password_hash, papel) VALUES
    ('10000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'Alice Antunes (Estudante)', 'alice@medicina2029.com.br', '${hashEstudante}', 'estudante'),
    ('20000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000002', 'Bruno (Responsável)', 'bruno@medicina2029.com.br', '${hashResponsavel}', 'responsavel')
  ON CONFLICT (id) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    email = EXCLUDED.email;

  INSERT INTO public.allowlist (email) VALUES
    ('alice@medicina2029.com.br'),
    ('bruno@medicina2029.com.br')
  ON CONFLICT (email) DO NOTHING;

  INSERT INTO public.responsavel_estudante (vinculo_id, responsavel_perfil_id, estudante_perfil_id) VALUES
    (1, '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001')
  ON CONFLICT (vinculo_id) DO NOTHING;

  -- Disciplinas básicas
  INSERT INTO public.disciplinas (id, nome, area, cor_hex, ordem) VALUES
    ('30000000-0000-4000-8000-000000000001', 'Biologia', 'natureza', '#0E3D4D', 1),
    ('30000000-0000-4000-8000-000000000002', 'Química', 'natureza', '#17607A', 2),
    ('30000000-0000-4000-8000-000000000003', 'Matemática', 'matematica', '#C98A2E', 3),
    ('30000000-0000-4000-8000-000000000004', 'Física', 'natureza', '#B5502B', 4),
    ('30000000-0000-4000-8000-000000000005', 'Redação', 'redacao', '#DE6B48', 5)
  ON CONFLICT (id) DO NOTHING;

  -- Tópicos iniciais
  INSERT INTO public.topicos (id, disciplina_id, nome, serie_prevista, incidencia_enem, incidencia_uece, ordem, cobertura_material) VALUES
    ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Citologia e Membrana Celular', 1, 5, 4, 1, 'coberto'),
    ('31000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'Estequiometria Básica', 1, 5, 5, 1, 'coberto'),
    ('31000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'Razão, Proporção e Regra de Três', 1, 5, 4, 1, 'coberto')
  ON CONFLICT (id) DO NOTHING;

  -- Ciclo de Estudos inicial para Alice
  INSERT INTO public.ciclos (id, estudante_perfil_id, nome, ano_letivo, ativo, blocos_previstos_semana) VALUES
    ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Ciclo Foco Medicina 2029', 2027, true, 12)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.ciclo_blocos (id, ciclo_id, ordem, disciplina_id, tipo, estilo_alvo, duracao_min) VALUES
    ('41000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 1, '30000000-0000-4000-8000-000000000001', 'conteudo', 'enem', 50),
    ('41000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', 2, '30000000-0000-4000-8000-000000000002', 'conteudo', 'enem', 50),
    ('41000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000001', 3, '30000000-0000-4000-8000-000000000003', 'conteudo', 'enem', 50)
  ON CONFLICT (id) DO NOTHING;
`);

console.log('✅ Base de dados preparada com sucesso!');

const server = net.createServer(async (socket) => {
  try {
    await fromNodeSocket(socket, {
      serverVersion: '16.3 (PGlite Medicina 2029)',
      auth: {
        method: 'trust'
      },
      onStartup: async () => {
        await db.waitReady;
        return false;
      },
      onMessage: async (data, { isAuthenticated }) => {
        if (!isAuthenticated) return;
        try {
          const results = await db.execProtocol(data);
          return results.data;
        } catch (err) {
          console.error('execProtocol error:', err);
        }
      }
    });
  } catch (err) {
    console.error('Socket error:', err);
  }
});

const PORT = 5432;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 Servidor PostgreSQL (PGlite Wire Gateway) ativo em 127.0.0.1:${PORT}`);
  console.log(`📡 URL de conexão: postgres://postgres:postgres@localhost:${PORT}/medicina_dev`);
});
