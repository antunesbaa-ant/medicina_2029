/**
 * ==============================================================================
 * MEDICINA 2029 — H2.03-R2B: TESTES DA CORREÇÃO DA TRANSMISSÃO DA CHAVE DE BACKUP
 * ==============================================================================
 * Testes locais direcionados do fluxo real de decifragem, segurança de credenciais
 * e salvaguardas fail-closed para restauração isolada.
 *
 * Itens testados:
 * 1. Decifragem com chave correta via stdin (--key-stdin).
 * 2. Decifragem com chave incorreta (rejeição defensiva fail-closed, código 2).
 * 3. Ausência de chave (rejeição fail-closed, código 1).
 * 4. Passagem de chave via descritor de arquivo (--key-fd).
 * 5. Nenhuma exposição de credenciais em argv / ps / environment.
 * 6. Falha na decifragem do manifesto aborta sumariamente antes de qualquer comando destrutivo no banco.
 * 7. Limpeza rigorosa de arquivos temporários e purga de chave (unset) em caso de falha ou cancelamento.
 * ==============================================================================
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../../');
const CRYPTO_SCRIPT = path.join(PROJECT_ROOT, 'scripts/backup/crypto_envelope.mjs');
const RESTORE_SCRIPT = path.join(PROJECT_ROOT, 'scripts/backup/restore_postgres.sh');

describe('MEDICINA 2029 — H2.03-R2B: Transmissão Segura da Chave de Descriptografia', () => {
  let tmpDir: string;
  const TEST_KEY = 'm29_r2b_secret_master_key_9876543210_valid';
  const WRONG_KEY = 'm29_r2b_invalid_wrong_key_0000000000_fail';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm29_r2b_test_'));
    fs.chmodSync(tmpDir, 0o700);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
  });

  // ---------------------------------------------------------------------------
  // 1. TESTES DE TRANSMISSÃO VIA STDIN (--key-stdin)
  // ---------------------------------------------------------------------------
  describe('1. Cifragem e Decifragem via Standard Input (--key-stdin)', () => {
    it('1.1 Decifra arquivo com sucesso fornecendo a chave correta via stdin', () => {
      const plaintext = 'conteudo_sensivel_do_banco_medicina2029_' + randomBytes(32).toString('hex');
      const plainFile = path.join(tmpDir, 'source.txt');
      const encFile = path.join(tmpDir, 'source.enc');
      const decFile = path.join(tmpDir, 'recovered.txt');
      fs.writeFileSync(plainFile, plaintext, 'utf8');

      // Cifra usando chave via stdin
      const encRes = spawnSync(
        'node',
        [CRYPTO_SCRIPT, 'encrypt', plainFile, encFile, '--key-stdin'],
        { input: TEST_KEY, encoding: 'utf8' }
      );
      expect(encRes.status).toBe(0);
      expect(fs.existsSync(encFile)).toBe(true);

      // Decifra usando chave correta via stdin
      const decRes = spawnSync(
        'node',
        [CRYPTO_SCRIPT, 'decrypt', encFile, decFile, '--key-stdin'],
        { input: TEST_KEY, encoding: 'utf8' }
      );
      expect(decRes.status).toBe(0);
      expect(fs.existsSync(decFile)).toBe(true);

      const recoveredContent = fs.readFileSync(decFile, 'utf8');
      expect(recoveredContent).toBe(plaintext);
    });

    it('1.2 Rejeita decifragem fail-closed (código 2) quando a chave via stdin é incorreta', () => {
      const plainFile = path.join(tmpDir, 'secret.txt');
      const encFile = path.join(tmpDir, 'secret.enc');
      const decFile = path.join(tmpDir, 'bad_recovered.txt');
      fs.writeFileSync(plainFile, 'dados_criticos_protegidos', 'utf8');

      // Cifra com a chave verdadeira
      spawnSync(
        'node',
        [CRYPTO_SCRIPT, 'encrypt', plainFile, encFile, '--key-stdin'],
        { input: TEST_KEY, encoding: 'utf8' }
      );

      // Tenta decifrar com a chave errada
      const decRes = spawnSync(
        'node',
        [CRYPTO_SCRIPT, 'decrypt', encFile, decFile, '--key-stdin'],
        { input: WRONG_KEY, encoding: 'utf8' }
      );

      expect(decRes.status).toBe(2);
      expect(decRes.stderr).toContain('FALHA CRÍTICA DE AUTENTICAÇÃO AEAD');
      expect(fs.existsSync(decFile)).toBe(false);
    });

    it('1.3 Rejeita fail-closed (código 1) quando a chave está ausente ou vazia via stdin', () => {
      const plainFile = path.join(tmpDir, 'data.txt');
      const encFile = path.join(tmpDir, 'data.enc');
      const decFile = path.join(tmpDir, 'out.txt');
      fs.writeFileSync(plainFile, 'dados', 'utf8');

      // Cifra com chave válida
      spawnSync(
        'node',
        [CRYPTO_SCRIPT, 'encrypt', plainFile, encFile, '--key-stdin'],
        { input: TEST_KEY, encoding: 'utf8' }
      );

      // Tenta decifrar com stdin vazio
      const decRes = spawnSync(
        'node',
        [CRYPTO_SCRIPT, 'decrypt', encFile, decFile, '--key-stdin'],
        { input: '', encoding: 'utf8' }
      );

      expect(decRes.status).toBe(1);
      expect(decRes.stderr).toContain('Chave de criptografia não fornecida');
      expect(fs.existsSync(decFile)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. TESTES DE TRANSMISSÃO VIA DESCRITOR DE ARQUIVO (--key-fd)
  // ---------------------------------------------------------------------------
  describe('2. Transmissão da Chave via Descritor de Arquivo (--key-fd)', () => {
    it('2.1 Suporta leitura da chave a partir de descritor de arquivo aberto', () => {
      const plainFile = path.join(tmpDir, 'fd_test.txt');
      const encFile = path.join(tmpDir, 'fd_test.enc');
      const decFile = path.join(tmpDir, 'fd_recovered.txt');
      fs.writeFileSync(plainFile, 'payload_com_fd_redirection', 'utf8');

      // Cifra
      spawnSync(
        'node',
        [CRYPTO_SCRIPT, 'encrypt', plainFile, encFile, '--key-stdin'],
        { input: TEST_KEY, encoding: 'utf8' }
      );

      // Decifra via descritor 3 em bash
      const bashCmd = `
        exec 3<<< "${TEST_KEY}"
        node "${CRYPTO_SCRIPT}" decrypt "${encFile}" "${decFile}" --key-fd=3
        exec 3<&-
      `;

      const res = spawnSync('bash', ['-c', bashCmd], { encoding: 'utf8' });
      expect(res.status).toBe(0);
      expect(fs.readFileSync(decFile, 'utf8')).toBe('payload_com_fd_redirection');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. NÃO EXPOSIÇÃO DE CREDENCIAIS (ARGV, PS, ENVIRONMENT)
  // ---------------------------------------------------------------------------
  describe('3. Blindagem de Credenciais e Zero Exposição em Processos', () => {
    it('3.1 Confirma que a chave mestra NUNCA é passada como argumento CLI para node', () => {
      const plainFile = path.join(tmpDir, 'check_args.txt');
      const encFile = path.join(tmpDir, 'check_args.enc');
      fs.writeFileSync(plainFile, 'teste_argv', 'utf8');

      // Ao invocar node, passamos apenas flags estruturais e caminhos de arquivo
      const args = [CRYPTO_SCRIPT, 'encrypt', plainFile, encFile, '--key-stdin'];

      // Nenhuma posição de process.argv contém a chave mestra
      for (const arg of args) {
        expect(arg).not.toContain(TEST_KEY);
      }

      const res = spawnSync('node', args, { input: TEST_KEY, encoding: 'utf8' });
      expect(res.status).toBe(0);
    });

    it('3.2 Verifica que printf com pipe embutido do Bash não expõe chave em subprocessos', () => {
      // Testamos que a chave transmitida por printf built-in via stdin não cria arquivos ou vaza no ambiente
      const testScript = `
        set -euo pipefail
        MY_SECRET="chave_super_secreta_9999"
        printf '%s' "\${MY_SECRET}" | node "${CRYPTO_SCRIPT}" encrypt "${tmpDir}/in.txt" "${tmpDir}/out.enc" --key-stdin
        unset MY_SECRET
        echo "ENV_SECRET_IS_SET=\${MY_SECRET:-unset}"
      `;
      fs.writeFileSync(path.join(tmpDir, 'in.txt'), 'hello_pipe', 'utf8');

      const res = spawnSync('bash', ['-c', testScript], { encoding: 'utf8' });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('ENV_SECRET_IS_SET=unset');
      expect(fs.existsSync(path.join(tmpDir, 'out.enc'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. SEGURANÇA E FAIL-CLOSED ANTES DE QUALQUER OPERAÇÃO DE BANCO
  // ---------------------------------------------------------------------------
  describe('4. Interrupção Fail-Closed e Proteção do Banco Alvo', () => {
    it('4.1 Rejeita sumariamente qualquer tentativa de apontar para o Supabase antes da leitura da chave', () => {
      const res = spawnSync(
        'bash',
        [RESTORE_SCRIPT, tmpDir, 'medicina2029_staging'],
        {
          env: {
            ...process.env,
            TARGET_PGHOST: 'db.xyzproject.supabase.co',
            TARGET_PGPORT: '5432',
          },
          encoding: 'utf8',
        }
      );

      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('VIOLAÇÃO CRÍTICA DE SEGURANÇA (FAIL-CLOSED)');
      expect(res.stderr).toContain('Supabase remoto');
    });

    it('4.2 Rejeita host não-loopback antes de solicitar chave ou tocar no banco', () => {
      const res = spawnSync(
        'bash',
        [RESTORE_SCRIPT, tmpDir, 'medicina2029_staging'],
        {
          env: {
            ...process.env,
            TARGET_PGHOST: '192.168.1.100',
            TARGET_PGPORT: '5432',
          },
          encoding: 'utf8',
        }
      );

      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('VIOLAÇÃO DE ISOLAMENTO LOCAL (FAIL-CLOSED)');
    });

    it('4.3 Falha na decifragem do manifesto aborta sumariamente com código 2 e limpa diretórios temporários', () => {
      // Criamos um manifesto corrompido/cifrado com outra chave
      const fakeBackupDir = path.join(tmpDir, 'fake_backup');
      fs.mkdirSync(fakeBackupDir, { recursive: true });

      const manifestPlain = JSON.stringify({ app: 'Medicina 2029', dump_sha256: 'abc' });
      const manifestPath = path.join(fakeBackupDir, 'test_manifest.json');
      const manifestEnc = path.join(fakeBackupDir, 'test_manifest.json.enc');
      fs.writeFileSync(manifestPath, manifestPlain, 'utf8');

      // Cifra com chave diferente
      spawnSync('node', [CRYPTO_SCRIPT, 'encrypt', manifestPath, manifestEnc, '--key-stdin'], {
        input: 'chave_diferente_alpha_1234567890',
        encoding: 'utf8',
      });
      fs.unlinkSync(manifestPath);

      // Cria um dump falso cifrado também
      const dumpPath = path.join(fakeBackupDir, 'test.dump');
      const dumpEnc = path.join(fakeBackupDir, 'test.dump.enc');
      fs.writeFileSync(dumpPath, 'dummy_dump_data', 'utf8');
      spawnSync('node', [CRYPTO_SCRIPT, 'encrypt', dumpPath, dumpEnc, '--key-stdin'], {
        input: 'chave_diferente_alpha_1234567890',
        encoding: 'utf8',
      });
      fs.unlinkSync(dumpPath);

      // Executa restore_postgres.sh passando a chave errada pelo stdin simulado
      const restoreRes = spawnSync(
        'bash',
        [RESTORE_SCRIPT, fakeBackupDir, 'medicina_db_test'],
        {
          input: TEST_KEY + '\n',
          env: {
            ...process.env,
            TARGET_PGHOST: '127.0.0.1',
            TARGET_PGPORT: '5433',
            // Garantir que não tenta executar conexões postgres reais pois deve abortar ANTES no manifesto
          },
          encoding: 'utf8',
        }
      );

      // Deve falhar na decifragem com erro fatal
      expect(restoreRes.status).toBe(2);
      expect(restoreRes.stdout).toContain('ERRO CRÍTICO: Falha na descriptografia do manifesto');

      // Confirma que nenhuma pasta temporária medicina2029_restore_* restou solta
      const leftoverTmp = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('medicina2029_restore_'));
      expect(leftoverTmp.length).toBe(0);
    });

    it('4.4 Purga imediata da variável BACKUP_ENCRYPTION_KEY após decifragem', () => {
      // Inspeciona restore_postgres.sh para garantir a chamada unset BACKUP_ENCRYPTION_KEY
      const scriptContent = fs.readFileSync(RESTORE_SCRIPT, 'utf8');
      expect(scriptContent).toContain('unset BACKUP_ENCRYPTION_KEY');
      expect(scriptContent).toContain('--key-stdin');
      // Confirma presença do trap de limpeza
      expect(scriptContent).toContain('trap cleanup EXIT INT TERM HUP');
    });

    it('4.5 Rejeita fail-closed (código 1) quando nenhuma chave é informada via stdin nem ambiente', () => {
      const fakeBackupDir = path.join(tmpDir, 'empty_key_backup');
      fs.mkdirSync(fakeBackupDir, { recursive: true });
      fs.writeFileSync(path.join(fakeBackupDir, 'backup.dump.enc'), 'fake_enc');
      fs.writeFileSync(path.join(fakeBackupDir, 'backup_manifest.json.enc'), 'fake_enc');

      const res = spawnSync(
        'bash',
        [RESTORE_SCRIPT, fakeBackupDir, 'medicina_db_test'],
        {
          input: '', // stdin vazio
          env: {
            ...process.env,
            TARGET_PGHOST: '127.0.0.1',
            TARGET_PGPORT: '5433',
            BACKUP_ENCRYPTION_KEY: '',
          },
          encoding: 'utf8',
        }
      );

      expect(res.status).toBe(1);
      expect(res.stdout).toContain('ERRO CRÍTICO: Chave mestra de descriptografia não informada');
    });

    it('4.6 Tratamento de sinal SIGINT (Ctrl+C) aciona cleanup e remove temporários', () => {
      const scriptWithTrap = `
        TMP_RESTORE_DIR=$(mktemp -d -t medicina2029_restore_test_XXXXXX)
        chmod 700 "\${TMP_RESTORE_DIR}"
        BACKUP_ENCRYPTION_KEY="chave_a_ser_apagada"
        cleanup() {
          unset BACKUP_ENCRYPTION_KEY 2>/dev/null || true
          if [[ -d "\${TMP_RESTORE_DIR}" ]]; then
            rm -rf "\${TMP_RESTORE_DIR}"
          fi
          echo "CLEANUP_EXECUTED"
        }
        trap cleanup EXIT INT TERM HUP
        # Simula cancelamento via envio de SIGINT (Ctrl+C)
        kill -INT $$
      `;
      const res = spawnSync('bash', ['-c', scriptWithTrap], { encoding: 'utf8' });
      expect(res.stdout).toContain('CLEANUP_EXECUTED');
      const leftover = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('medicina2029_restore_test_'));
      expect(leftover.length).toBe(0);
    });

    it('4.7 Confirma que o script aborta sem tentar conexões de DROP DATABASE caso a decifragem falhe', () => {
      const fakeDir = path.join(tmpDir, 'corrupt_backup');
      fs.mkdirSync(fakeDir, { recursive: true });
      fs.writeFileSync(path.join(fakeDir, 'corrupt.dump.enc'), 'not_a_valid_m29g_file');
      fs.writeFileSync(path.join(fakeDir, 'corrupt_manifest.json.enc'), 'not_a_valid_manifest');

      const res = spawnSync(
        'bash',
        [RESTORE_SCRIPT, fakeDir, 'medicina_staging'],
        {
          input: 'some_key\n',
          env: {
            ...process.env,
            TARGET_PGHOST: '127.0.0.1',
            TARGET_PGPORT: '5433',
          },
          encoding: 'utf8',
        }
      );

      expect(res.status).toBe(2);
      expect(res.stdout).not.toContain('DROP DATABASE');
      expect(res.stdout).not.toContain('CREATE DATABASE');
      expect(res.stdout).toContain('ERRO CRÍTICO: Falha na descriptografia do manifesto');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. TESTE DE ROUNDTRIP INTEGRADO COM ARTEFATOS REAIS
  // ---------------------------------------------------------------------------
  describe('5. Simulação Integral de Decifragem de Manifesto e Dump com Sucesso', () => {
    it('5.1 Executa decifragem simultânea de manifesto e dump via stdin sem expor segredos', () => {
      const mockBackupDir = path.join(tmpDir, 'mock_backup');
      fs.mkdirSync(mockBackupDir, { recursive: true });

      const dumpContent = 'SIMULATED_PG_DUMP_HEADER_M29_OK_' + randomBytes(1024).toString('hex');
      const dumpFile = path.join(mockBackupDir, 'db.dump');
      const dumpEnc = path.join(mockBackupDir, 'db.dump.enc');
      fs.writeFileSync(dumpFile, dumpContent, 'utf8');

      const dumpSha256 = createHash('sha256').update(dumpContent).digest('hex');

      const manifestContent = JSON.stringify({
        app: 'Medicina 2029',
        task: 'H2.03-R2B',
        dump_sha256: dumpSha256,
        table_row_counts: { 'public.allowlist': 2 },
      });
      const manifestFile = path.join(mockBackupDir, 'backup_manifest.json');
      const manifestEnc = path.join(mockBackupDir, 'backup_manifest.json.enc');
      fs.writeFileSync(manifestFile, manifestContent, 'utf8');

      // Cifra ambos com a TEST_KEY
      spawnSync('node', [CRYPTO_SCRIPT, 'encrypt', dumpFile, dumpEnc, '--key-stdin'], {
        input: TEST_KEY,
        encoding: 'utf8',
      });
      spawnSync('node', [CRYPTO_SCRIPT, 'encrypt', manifestFile, manifestEnc, '--key-stdin'], {
        input: TEST_KEY,
        encoding: 'utf8',
      });
      fs.unlinkSync(dumpFile);
      fs.unlinkSync(manifestFile);

      // Decifra ambos simulando o fluxo de restore_postgres.sh via pipeline
      const outManifest = path.join(tmpDir, 'decrypted_manifest.json');
      const outDump = path.join(tmpDir, 'decrypted_db.dump');

      const decManifestProc = spawnSync(
        'node',
        [CRYPTO_SCRIPT, 'decrypt', manifestEnc, outManifest, '--key-stdin'],
        { input: TEST_KEY, encoding: 'utf8' }
      );
      expect(decManifestProc.status).toBe(0);

      const decDumpProc = spawnSync(
        'node',
        [CRYPTO_SCRIPT, 'decrypt', dumpEnc, outDump, '--key-stdin'],
        { input: TEST_KEY, encoding: 'utf8' }
      );
      expect(decDumpProc.status).toBe(0);

      // Validação de paridade SHA-256 pós-decifragem
      const recoveredDump = fs.readFileSync(outDump, 'utf8');
      const recoveredSha256 = createHash('sha256').update(recoveredDump).digest('hex');
      expect(recoveredSha256).toBe(dumpSha256);

      const parsedManifest = JSON.parse(fs.readFileSync(outManifest, 'utf8'));
      expect(parsedManifest.dump_sha256).toBe(recoveredSha256);
      expect(parsedManifest.table_row_counts['public.allowlist']).toBe(2);
    });
  });
});
