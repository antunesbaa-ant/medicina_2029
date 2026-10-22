import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  gerarManifestoBackupStorage,
  gerarManifestoDeRegistrosDb,
  gerarManifestoDeDiretorio,
  validarAssinaturaManifesto,
  validarIntegridadeBackupFisico,
  validarIntegridadeBackupDiretorio,
  reconciliarManifestoComBanco,
  compararManifestos,
  serializarManifestoJson,
  deserializarManifestoJson,
  salvarManifestoEmArquivo,
  carregarManifestoDeArquivo,
  calcularSha256Manifesto,
  calcularSha256Buffer,
  normalizarStoragePath,
  StorageBackupError,
  type StorageBackupManifest,
  type RegistroAcervoBancoParaManifesto,
  type ObjetoEntradaManifesto,
} from './storageBackupManifest';

describe('StorageBackupManifest — F1.15 Manifesto Criptográfico e Integridade de Storage', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-manifest-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function criarPdfSintetico(conteudoTexto: string): Buffer {
    // Formato canônico sintético seguro compatível com validador de PDF
    return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Title (${conteudoTexto}) >>\nendobj\n%%EOF\n`, 'utf8');
  }

  // =========================================================================
  // 1. Geração de Manifesto e Assinatura SHA-256 Canônica
  // =========================================================================
  describe('1. Geração de manifesto e hashing SHA-256 canônico', () => {
    it('deve gerar manifesto canônico determinístico com hash SHA-256 válido', () => {
      const pdf1 = criarPdfSintetico('Documento Med 1');
      const pdf2 = criarPdfSintetico('Documento Med 2');

      const manifesto = gerarManifestoBackupStorage({
        bucket: 'acervo',
        version: '1.0',
        geradoEm: '2026-10-21T10:00:00.000Z',
        objetos: [
          // Ordem intencionalmente desordenada para testar ordenação canônica
          { storagePath: 'acervo/z_segundo.pdf', conteudo: pdf2, arquivoId: 'id-002' },
          { storagePath: 'acervo/a_primeiro.pdf', conteudo: pdf1, arquivoId: 'id-001' },
        ],
      });

      expect(manifesto.version).toBe('1.0');
      expect(manifesto.bucket).toBe('acervo');
      expect(manifesto.geradoEm).toBe('2026-10-21T10:00:00.000Z');
      expect(manifesto.totalObjetos).toBe(2);
      expect(manifesto.totalBytes).toBe(pdf1.length + pdf2.length);
      expect(manifesto.sha256Manifesto).toMatch(/^[0-9a-f]{64}$/);

      // Garante ordenação canônica estrita por storagePath ascendente
      expect(manifesto.objetos[0].storagePath).toBe('acervo/a_primeiro.pdf');
      expect(manifesto.objetos[0].arquivoId).toBe('id-001');
      expect(manifesto.objetos[0].tamanhoBytes).toBe(pdf1.length);
      expect(manifesto.objetos[0].hashSha256).toBe(calcularSha256Buffer(pdf1));
      expect(manifesto.objetos[0].mimeType).toBe('application/pdf');

      expect(manifesto.objetos[1].storagePath).toBe('acervo/z_segundo.pdf');
      expect(manifesto.objetos[1].arquivoId).toBe('id-002');
      expect(manifesto.objetos[1].tamanhoBytes).toBe(pdf2.length);

      // Validação da assinatura
      const validacao = validarAssinaturaManifesto(manifesto);
      expect(validacao.valido).toBe(true);
      expect(validacao.hashCalculado).toBe(manifesto.sha256Manifesto);
    });

    it('deve garantir determinismo: duas gerações com entradas na mesma ou em ordens diferentes geram o mesmo hash', () => {
      const pdf1 = criarPdfSintetico('Arquivo Alpha');
      const pdf2 = criarPdfSintetico('Arquivo Beta');
      const pdf3 = criarPdfSintetico('Arquivo Gamma');

      const fixedDate = '2026-10-21T12:00:00.000Z';

      const m1 = gerarManifestoBackupStorage({
        bucket: 'acervo',
        geradoEm: fixedDate,
        objetos: [
          { storagePath: 'acervo/c_gamma.pdf', conteudo: pdf3 },
          { storagePath: 'acervo/a_alpha.pdf', conteudo: pdf1 },
          { storagePath: 'acervo/b_beta.pdf', conteudo: pdf2 },
        ],
      });

      const m2 = gerarManifestoBackupStorage({
        bucket: 'acervo',
        geradoEm: fixedDate,
        objetos: [
          { storagePath: 'acervo/b_beta.pdf', conteudo: pdf2 },
          { storagePath: 'acervo/c_gamma.pdf', conteudo: pdf3 },
          { storagePath: 'acervo/a_alpha.pdf', conteudo: pdf1 },
        ],
      });

      expect(m1.sha256Manifesto).toBe(m2.sha256Manifesto);
      expect(m1.totalBytes).toBe(m2.totalBytes);
      expect(m1.totalObjetos).toBe(3);
    });

    it('deve alterar radicalmente o sha256Manifesto ao alterar qualquer metadado ou byte de objeto', () => {
      const pdfOriginal = criarPdfSintetico('Original');
      const pdfAlterado = criarPdfSintetico('Adulterado');
      const fixedDate = '2026-10-21T12:00:00.000Z';

      const mOriginal = gerarManifestoBackupStorage({
        bucket: 'acervo',
        geradoEm: fixedDate,
        objetos: [{ storagePath: 'acervo/doc.pdf', conteudo: pdfOriginal }],
      });

      const mAlterado = gerarManifestoBackupStorage({
        bucket: 'acervo',
        geradoEm: fixedDate,
        objetos: [{ storagePath: 'acervo/doc.pdf', conteudo: pdfAlterado }],
      });

      expect(mOriginal.sha256Manifesto).not.toBe(mAlterado.sha256Manifesto);
    });

    it('deve invalidar a assinatura se o manifesto for adulterado manualmente', () => {
      const pdf = criarPdfSintetico('Conteúdo Segredo');
      const manifesto = gerarManifestoBackupStorage({
        bucket: 'acervo',
        objetos: [{ storagePath: 'acervo/segredo.pdf', conteudo: pdf }],
      });

      expect(validarAssinaturaManifesto(manifesto).valido).toBe(true);

      // Adulteração 1: Tamanho adulterado
      const adulteradoTamanho: StorageBackupManifest = {
        ...manifesto,
        totalBytes: manifesto.totalBytes + 1,
      };
      expect(validarAssinaturaManifesto(adulteradoTamanho).valido).toBe(false);

      // Adulteração 2: Hash do objeto alterado
      const adulteradoObjeto: StorageBackupManifest = {
        ...manifesto,
        objetos: [
          {
            ...manifesto.objetos[0],
            hashSha256: '0000000000000000000000000000000000000000000000000000000000000000',
          },
        ],
      };
      expect(validarAssinaturaManifesto(adulteradoObjeto).valido).toBe(false);

      // Adulteração 3: Hash do manifesto falsificado
      const adulteradoHashManifesto: StorageBackupManifest = {
        ...manifesto,
        sha256Manifesto: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      };
      expect(validarAssinaturaManifesto(adulteradoHashManifesto).valido).toBe(false);
    });

    it('deve rejeitar caminhos duplicados com DUPLICATE_OBJECT_PATH', () => {
      const pdf1 = criarPdfSintetico('Doc A');
      const pdf2 = criarPdfSintetico('Doc B');

      expect(() =>
        gerarManifestoBackupStorage({
          objetos: [
            { storagePath: 'acervo/mesmo_caminho.pdf', conteudo: pdf1 },
            { storagePath: 'acervo/mesmo_caminho.pdf', conteudo: pdf2 },
          ],
        })
      ).toThrow(StorageBackupError);

      try {
        gerarManifestoBackupStorage({
          objetos: [
            { storagePath: 'acervo/mesmo.pdf', conteudo: pdf1 },
            { storagePath: 'acervo/mesmo.pdf', conteudo: pdf2 },
          ],
        });
      } catch (err) {
        expect((err as StorageBackupError).code).toBe('DUPLICATE_OBJECT_PATH');
      }
    });

    it('deve rejeitar caminhos inválidos ou com tentativa de path traversal', () => {
      expect(() => normalizarStoragePath('../arquivo.pdf')).toThrow(StorageBackupError);
      expect(() => normalizarStoragePath('acervo/../../etc/passwd')).toThrow(StorageBackupError);
      expect(() => normalizarStoragePath('acervo\\windows\\path.pdf')).toThrow(StorageBackupError);
    });

    it('deve permitir objetos sem buffer se tamanhoBytes e hashSha256 forem explicitamente declarados', () => {
      const hashValido = createHash('sha256').update('dummy').digest('hex');
      const manifesto = gerarManifestoBackupStorage({
        objetos: [
          {
            storagePath: 'acervo/pre_computado.pdf',
            tamanhoBytes: 54321,
            hashSha256: hashValido,
            mimeType: 'application/pdf',
          },
        ],
      });

      expect(manifesto.totalObjetos).toBe(1);
      expect(manifesto.totalBytes).toBe(54321);
      expect(validarAssinaturaManifesto(manifesto).valido).toBe(true);
    });
  });

  // =========================================================================
  // 2. Validação Física de Backup com Arquivos Sintéticos
  // =========================================================================
  describe('2. Validação física de backup com arquivos sintéticos', () => {
    it('deve validar com sucesso um backup íntegro com arquivos sintéticos em diretório temporário', () => {
      // Cria estrutura de diretório de backup simulada
      const acervoDir = path.join(tempDir, 'acervo');
      fs.mkdirSync(acervoDir, { recursive: true });

      const pdf1 = criarPdfSintetico('Anatomia Humana - Aula 1');
      const pdf2 = criarPdfSintetico('Fisiologia Renal - Capítulo 3');
      const png1 = Buffer.from('fake-png-bytes-figura-1', 'utf8');

      fs.writeFileSync(path.join(acervoDir, 'anatomia.pdf'), pdf1);
      fs.writeFileSync(path.join(acervoDir, 'fisiologia.pdf'), pdf2);
      fs.writeFileSync(path.join(acervoDir, 'figura1.png'), png1);

      // Gera o manifesto a partir do diretório
      const manifesto = gerarManifestoDeDiretorio(tempDir, { bucket: 'acervo' });
      expect(manifesto.totalObjetos).toBe(3);
      expect(manifesto.totalBytes).toBe(pdf1.length + pdf2.length + png1.length);

      // Salva o manifesto no diretório (deve ser ignorado durante validação)
      const manifestoPath = path.join(tempDir, 'manifest.json');
      salvarManifestoEmArquivo(manifesto, manifestoPath);

      // Validação da integridade física
      const resultado = validarIntegridadeBackupDiretorio(tempDir, manifesto);

      expect(resultado.integro).toBe(true);
      expect(resultado.manifestoValido).toBe(true);
      expect(resultado.totais.manifestados).toBe(3);
      expect(resultado.totais.encontradosFisicamente).toBe(3);
      expect(resultado.totais.integros).toBe(3);
      expect(resultado.totais.ausentes).toBe(0);
      expect(resultado.totais.corrompidos).toBe(0);
      expect(resultado.totais.orfaos).toBe(0);
      expect(resultado.objetosIntegros).toHaveLength(3);
      expect(resultado.objetosIntegros).toContain('acervo/anatomia.pdf');
      expect(resultado.objetosIntegros).toContain('acervo/fisiologia.pdf');
      expect(resultado.objetosIntegros).toContain('acervo/figura1.png');
    });

    it('deve validar integridade física em memória com buffers sintéticos', () => {
      const b1 = criarPdfSintetico('Item 1');
      const b2 = criarPdfSintetico('Item 2');

      const manifesto = gerarManifestoBackupStorage({
        objetos: [
          { storagePath: 'acervo/item1.pdf', conteudo: b1 },
          { storagePath: 'acervo/item2.pdf', conteudo: b2 },
        ],
      });

      const backupFisico = [
        { storagePath: 'acervo/item1.pdf', conteudo: b1 },
        { storagePath: 'acervo/item2.pdf', conteudo: b2 },
      ];

      const resultado = validarIntegridadeBackupFisico(manifesto, backupFisico);
      expect(resultado.integro).toBe(true);
      expect(resultado.totais.integros).toBe(2);
      expect(resultado.totais.ausentes).toBe(0);
      expect(resultado.totais.corrompidos).toBe(0);
    });
  });

  // =========================================================================
  // 3. Detecção de Objeto Ausente
  // =========================================================================
  describe('3. Detecção de objeto ausente', () => {
    it('deve detectar quando um objeto listado no manifesto não existe no storage físico', () => {
      const b1 = criarPdfSintetico('Item Presente');
      const b2 = criarPdfSintetico('Item Perdido');

      const manifesto = gerarManifestoBackupStorage({
        objetos: [
          { storagePath: 'acervo/presente.pdf', conteudo: b1, arquivoId: 'id-pres' },
          { storagePath: 'acervo/perdido.pdf', conteudo: b2, arquivoId: 'id-perd' },
        ],
      });

      // Simula backup onde 'perdido.pdf' sumiu do disco
      const backupFisico = [{ storagePath: 'acervo/presente.pdf', conteudo: b1 }];

      const resultado = validarIntegridadeBackupFisico(manifesto, backupFisico);

      expect(resultado.integro).toBe(false);
      expect(resultado.totais.manifestados).toBe(2);
      expect(resultado.totais.encontradosFisicamente).toBe(1);
      expect(resultado.totais.integros).toBe(1);
      expect(resultado.totais.ausentes).toBe(1);
      expect(resultado.totais.corrompidos).toBe(0);

      expect(resultado.objetosAusentes).toHaveLength(1);
      expect(resultado.objetosAusentes[0].storagePath).toBe('acervo/perdido.pdf');
      expect(resultado.objetosAusentes[0].arquivoId).toBe('id-perd');
      expect(resultado.objetosAusentes[0].tamanhoEsperado).toBe(b2.length);
      expect(resultado.objetosAusentes[0].hashEsperado).toBe(calcularSha256Buffer(b2));
    });

    it('deve detectar múltiplos objetos ausentes no diretório', () => {
      const acervoDir = path.join(tempDir, 'acervo');
      fs.mkdirSync(acervoDir, { recursive: true });

      const p1 = criarPdfSintetico('PDF 1');
      const p2 = criarPdfSintetico('PDF 2');
      const p3 = criarPdfSintetico('PDF 3');

      // Gera manifesto com 3 arquivos
      const manifesto = gerarManifestoBackupStorage({
        objetos: [
          { storagePath: 'acervo/p1.pdf', conteudo: p1 },
          { storagePath: 'acervo/p2.pdf', conteudo: p2 },
          { storagePath: 'acervo/p3.pdf', conteudo: p3 },
        ],
      });

      // Mas apenas p1 foi efetivamente escrito no disco (p2 e p3 ausentes)
      fs.writeFileSync(path.join(acervoDir, 'p1.pdf'), p1);

      const resultado = validarIntegridadeBackupDiretorio(tempDir, manifesto);

      expect(resultado.integro).toBe(false);
      expect(resultado.totais.ausentes).toBe(2);
      expect(resultado.objetosAusentes.map((o) => o.storagePath).sort()).toEqual([
        'acervo/p2.pdf',
        'acervo/p3.pdf',
      ]);
    });
  });

  // =========================================================================
  // 4. Detecção de Objeto Corrompido
  // =========================================================================
  describe('4. Detecção de objeto corrompido (tamanho ou SHA-256 adulterado)', () => {
    it('deve detectar corrupção de conteúdo quando o tamanho é mantido mas o SHA-256 diverge', () => {
      const original = Buffer.from('AAAA-conteudo-original-12345', 'utf8');
      const corrompido = Buffer.from('AAAB-conteudo-original-12345', 'utf8'); // mesmo tamanho, 1 byte alterado

      expect(original.length).toBe(corrompido.length);
      expect(calcularSha256Buffer(original)).not.toBe(calcularSha256Buffer(corrompido));

      const manifesto = gerarManifestoBackupStorage({
        objetos: [{ storagePath: 'acervo/modificado.pdf', conteudo: original, arquivoId: 'id-mod' }],
      });

      const backupFisico = [{ storagePath: 'acervo/modificado.pdf', conteudo: corrompido }];

      const resultado = validarIntegridadeBackupFisico(manifesto, backupFisico);

      expect(resultado.integro).toBe(false);
      expect(resultado.totais.corrompidos).toBe(1);
      expect(resultado.totais.integros).toBe(0);

      const detalhe = resultado.objetosCorrompidos[0];
      expect(detalhe.storagePath).toBe('acervo/modificado.pdf');
      expect(detalhe.arquivoId).toBe('id-mod');
      expect(detalhe.motivo).toBe('sha256_divergente');
      expect(detalhe.esperadoTamanho).toBe(original.length);
      expect(detalhe.realTamanho).toBe(corrompido.length);
      expect(detalhe.esperadoSha256).toBe(calcularSha256Buffer(original));
      expect(detalhe.realSha256).toBe(calcularSha256Buffer(corrompido));
    });

    it('deve detectar corrupção de tamanho quando o arquivo é truncado ou ampliado', () => {
      const original = Buffer.from('conteudo-completo-original', 'utf8');
      const truncado = Buffer.from('conteudo-completo', 'utf8');

      const manifesto = gerarManifestoBackupStorage({
        objetos: [{ storagePath: 'acervo/truncado.pdf', conteudo: original }],
      });

      const backupFisico = [{ storagePath: 'acervo/truncado.pdf', conteudo: truncado }];

      const resultado = validarIntegridadeBackupFisico(manifesto, backupFisico);

      expect(resultado.integro).toBe(false);
      expect(resultado.totais.corrompidos).toBe(1);

      const detalhe = resultado.objetosCorrompidos[0];
      expect(detalhe.motivo).toBe('tamanho_e_sha256_divergentes');
      expect(detalhe.esperadoTamanho).toBe(original.length);
      expect(detalhe.realTamanho).toBe(truncado.length);
    });

    it('deve detectar arquivo corrompido fisicamente no disco durante varredura de diretório', () => {
      const acervoDir = path.join(tempDir, 'acervo');
      fs.mkdirSync(acervoDir, { recursive: true });

      const pdfIntegro = criarPdfSintetico('PDF Integro');
      const pdfParaCorromper = criarPdfSintetico('PDF que sofrera adulteracao');

      // Gera manifesto com conteúdo original
      const manifesto = gerarManifestoBackupStorage({
        objetos: [
          { storagePath: 'acervo/integro.pdf', conteudo: pdfIntegro },
          { storagePath: 'acervo/alvo.pdf', conteudo: pdfParaCorromper },
        ],
      });

      // Grava no disco o pdf íntegro e uma versão adulterada do alvo
      fs.writeFileSync(path.join(acervoDir, 'integro.pdf'), pdfIntegro);
      fs.writeFileSync(path.join(acervoDir, 'alvo.pdf'), Buffer.from('lixo-binario-corrompido', 'utf8'));

      const resultado = validarIntegridadeBackupDiretorio(tempDir, manifesto);

      expect(resultado.integro).toBe(false);
      expect(resultado.totais.integros).toBe(1);
      expect(resultado.totais.corrompidos).toBe(1);
      expect(resultado.objetosCorrompidos[0].storagePath).toBe('acervo/alvo.pdf');
    });
  });

  // =========================================================================
  // 5. Detecção de Objetos Órfãos no Storage
  // =========================================================================
  describe('5. Detecção de objetos órfãos no storage físico', () => {
    it('deve detectar arquivo no storage que não consta no manifesto', () => {
      const b1 = criarPdfSintetico('Doc Cadastrado');
      const bOrfao = criarPdfSintetico('Doc Orfao Intruso');

      const manifesto = gerarManifestoBackupStorage({
        objetos: [{ storagePath: 'acervo/cadastrado.pdf', conteudo: b1 }],
      });

      const backupFisico = [
        { storagePath: 'acervo/cadastrado.pdf', conteudo: b1 },
        { storagePath: 'acervo/intruso_orfao.pdf', conteudo: bOrfao },
      ];

      const resultadoEstrito = validarIntegridadeBackupFisico(manifesto, backupFisico, { permitirOrfaos: false });
      expect(resultadoEstrito.integro).toBe(false);
      expect(resultadoEstrito.totais.orfaos).toBe(1);
      expect(resultadoEstrito.objetosOrfaos[0].storagePath).toBe('acervo/intruso_orfao.pdf');
      expect(resultadoEstrito.objetosOrfaos[0].tamanhoBytes).toBe(bOrfao.length);

      // Quando permitirOrfaos: true, não invalida o backup, mas reporta o diagnóstico
      const resultadoPermissivo = validarIntegridadeBackupFisico(manifesto, backupFisico, { permitirOrfaos: true });
      expect(resultadoPermissivo.integro).toBe(true);
      expect(resultadoPermissivo.totais.orfaos).toBe(1);
    });
  });

  // =========================================================================
  // 6. Reconciliação entre Manifesto e Banco de Dados (`acervo_arquivos`)
  // =========================================================================
  describe('6. Reconciliação entre manifesto e registros do banco de dados', () => {
    it('deve reconciliar perfeitamente quando banco e manifesto estão 100% alinhados', () => {
      const h1 = createHash('sha256').update('doc-1').digest('hex');
      const h2 = createHash('sha256').update('doc-2').digest('hex');

      const registrosBanco: RegistroAcervoBancoParaManifesto[] = [
        {
          id: 'uuid-arq-1',
          filePath: `acervo/${h1}.pdf`,
          hashConteudo: h1,
          tamanhoBytes: 1024,
          mime: 'application/pdf',
        },
        {
          id: 'uuid-arq-2',
          filePath: `acervo/${h2}.pdf`,
          hashConteudo: h2,
          tamanhoBytes: 2048,
          mime: 'application/pdf',
        },
      ];

      const manifesto = gerarManifestoDeRegistrosDb(registrosBanco);

      const relatorio = reconciliarManifestoComBanco(manifesto, registrosBanco);

      expect(relatorio.reconciliado).toBe(true);
      expect(relatorio.totais.registrosBanco).toBe(2);
      expect(relatorio.totais.objetosManifesto).toBe(2);
      expect(relatorio.totais.integros).toBe(2);
      expect(relatorio.totais.inconsistencias).toBe(0);
      expect(relatorio.totais.dbSemObjetoManifesto).toBe(0);
      expect(relatorio.totais.manifestoSemRegistroDb).toBe(0);
      expect(relatorio.totais.divergenciasMetadados).toBe(0);
      expect(relatorio.inconsistencias).toHaveLength(0);
    });

    it('deve detectar divergência: registro no banco sem arquivo no storage/manifesto', () => {
      const h1 = createHash('sha256').update('doc-1').digest('hex');
      const hFaltante = createHash('sha256').update('doc-faltante').digest('hex');

      const registrosBanco: RegistroAcervoBancoParaManifesto[] = [
        {
          id: 'uuid-1',
          filePath: `acervo/${h1}.pdf`,
          hashConteudo: h1,
          tamanhoBytes: 1024,
          mime: 'application/pdf',
        },
        {
          id: 'uuid-faltante',
          filePath: `acervo/${hFaltante}.pdf`,
          hashConteudo: hFaltante,
          tamanhoBytes: 5000,
          mime: 'application/pdf',
        },
      ];

      // O manifesto contém apenas o primeiro objeto
      const manifesto = gerarManifestoBackupStorage({
        objetos: [
          {
            storagePath: `acervo/${h1}.pdf`,
            arquivoId: 'uuid-1',
            tamanhoBytes: 1024,
            hashSha256: h1,
            mimeType: 'application/pdf',
          },
        ],
      });

      const relatorio = reconciliarManifestoComBanco(manifesto, registrosBanco);

      expect(relatorio.reconciliado).toBe(false);
      expect(relatorio.totais.integros).toBe(1);
      expect(relatorio.totais.dbSemObjetoManifesto).toBe(1);

      const erro = relatorio.inconsistencias.find((i) => i.tipo === 'db_sem_objeto_manifesto');
      expect(erro).toBeDefined();
      expect(erro?.arquivoId).toBe('uuid-faltante');
      expect(erro?.storagePath).toBe(`acervo/${hFaltante}.pdf`);
    });

    it('deve detectar divergência: arquivo no storage/manifesto sem registro no banco', () => {
      const h1 = createHash('sha256').update('doc-1').digest('hex');
      const hOrfao = createHash('sha256').update('doc-orfao').digest('hex');

      const registrosBanco: RegistroAcervoBancoParaManifesto[] = [
        {
          id: 'uuid-1',
          filePath: `acervo/${h1}.pdf`,
          hashConteudo: h1,
          tamanhoBytes: 1024,
          mime: 'application/pdf',
        },
      ];

      const manifesto = gerarManifestoBackupStorage({
        objetos: [
          {
            storagePath: `acervo/${h1}.pdf`,
            arquivoId: 'uuid-1',
            tamanhoBytes: 1024,
            hashSha256: h1,
            mimeType: 'application/pdf',
          },
          {
            storagePath: `acervo/${hOrfao}.pdf`,
            arquivoId: null,
            tamanhoBytes: 4096,
            hashSha256: hOrfao,
            mimeType: 'application/pdf',
          },
        ],
      });

      const relatorio = reconciliarManifestoComBanco(manifesto, registrosBanco);

      expect(relatorio.reconciliado).toBe(false);
      expect(relatorio.totais.manifestoSemRegistroDb).toBe(1);

      const erro = relatorio.inconsistencias.find((i) => i.tipo === 'manifesto_sem_registro_db');
      expect(erro).toBeDefined();
      expect(erro?.storagePath).toBe(`acervo/${hOrfao}.pdf`);
    });

    it('deve detectar divergências de tamanho, hash e MIME entre banco e manifesto', () => {
      const hBanco = createHash('sha256').update('versao-banco').digest('hex');
      const hManifesto = createHash('sha256').update('versao-storage').digest('hex');

      const registrosBanco: RegistroAcervoBancoParaManifesto[] = [
        {
          id: 'uuid-divergente',
          filePath: 'acervo/divergente.pdf',
          hashConteudo: hBanco,
          tamanhoBytes: 1000,
          mime: 'application/pdf',
        },
      ];

      const manifesto = gerarManifestoBackupStorage({
        objetos: [
          {
            storagePath: 'acervo/divergente.pdf',
            arquivoId: 'uuid-divergente',
            tamanhoBytes: 1500, // Tamanho diferente
            hashSha256: hManifesto, // Hash diferente
            mimeType: 'application/octet-stream', // MIME diferente
          },
        ],
      });

      const relatorio = reconciliarManifestoComBanco(manifesto, registrosBanco);

      expect(relatorio.reconciliado).toBe(false);
      expect(relatorio.totais.divergenciasMetadados).toBe(3);

      const tipos = relatorio.inconsistencias.map((i) => i.tipo);
      expect(tipos).toContain('tamanho_divergente');
      expect(tipos).toContain('hash_divergente');
      expect(tipos).toContain('mime_divergente');
    });

    it('deve detectar duplicidades no banco de dados para o mesmo path ou hash', () => {
      const hComum = createHash('sha256').update('mesmo-conteudo').digest('hex');

      const registrosBanco: RegistroAcervoBancoParaManifesto[] = [
        {
          id: 'reg-1',
          filePath: 'acervo/duplicado.pdf',
          hashConteudo: hComum,
          tamanhoBytes: 2000,
          mime: 'application/pdf',
        },
        {
          id: 'reg-2',
          filePath: 'acervo/duplicado.pdf', // Mesmo filePath
          hashConteudo: hComum, // Mesmo hash
          tamanhoBytes: 2000,
          mime: 'application/pdf',
        },
      ];

      const manifesto = gerarManifestoBackupStorage({
        objetos: [
          {
            storagePath: 'acervo/duplicado.pdf',
            arquivoId: 'reg-1',
            tamanhoBytes: 2000,
            hashSha256: hComum,
            mimeType: 'application/pdf',
          },
        ],
      });

      const relatorio = reconciliarManifestoComBanco(manifesto, registrosBanco);

      expect(relatorio.reconciliado).toBe(false);
      expect(relatorio.totais.duplicadosBanco).toBe(2);

      const tipos = relatorio.inconsistencias.map((i) => i.tipo);
      expect(tipos).toContain('duplicidade_db_filepath');
      expect(tipos).toContain('duplicidade_db_hash');
    });
  });

  // =========================================================================
  // 7. Comparação Diferencial e Utilitários de I/O de Manifesto
  // =========================================================================
  describe('7. Comparação diferencial e persistência de manifesto em arquivo', () => {
    it('deve comparar dois manifestos e reportar adicionados, removidos e modificados', () => {
      const pdfA = criarPdfSintetico('Doc A');
      const pdfB = criarPdfSintetico('Doc B');
      const pdfBMod = criarPdfSintetico('Doc B Modificado');
      const pdfC = criarPdfSintetico('Doc C Novo');

      const m1 = gerarManifestoBackupStorage({
        geradoEm: '2026-10-21T00:00:00.000Z',
        objetos: [
          { storagePath: 'acervo/doc_a.pdf', conteudo: pdfA },
          { storagePath: 'acervo/doc_b.pdf', conteudo: pdfB },
        ],
      });

      const m2 = gerarManifestoBackupStorage({
        geradoEm: '2026-10-21T12:00:00.000Z',
        objetos: [
          // doc_a removido
          { storagePath: 'acervo/doc_b.pdf', conteudo: pdfBMod }, // modificado
          { storagePath: 'acervo/doc_c.pdf', conteudo: pdfC }, // adicionado
        ],
      });

      const diff = compararManifestos(m1, m2);

      expect(diff.iguais).toBe(false);
      expect(diff.adicionados).toHaveLength(1);
      expect(diff.adicionados[0].storagePath).toBe('acervo/doc_c.pdf');

      expect(diff.removidos).toHaveLength(1);
      expect(diff.removidos[0].storagePath).toBe('acervo/doc_a.pdf');

      expect(diff.modificados).toHaveLength(1);
      expect(diff.modificados[0].storagePath).toBe('acervo/doc_b.pdf');
      expect(diff.modificados[0].alteracoes).toContain('hashSha256');
    });

    it('deve serializar e deserializar manifesto via string JSON validando assinatura', () => {
      const pdf = criarPdfSintetico('Teste JSON');
      const entradaTipada: ObjetoEntradaManifesto = {
        storagePath: 'acervo/tipado.pdf',
        conteudo: pdf,
      };

      const manifesto = gerarManifestoBackupStorage({
        bucket: 'acervo',
        objetos: [entradaTipada],
      });

      const json = serializarManifestoJson(manifesto, true);
      expect(json).toContain('"bucket": "acervo"');

      const deserializado = deserializarManifestoJson(json, true);
      expect(deserializado.sha256Manifesto).toBe(manifesto.sha256Manifesto);
      expect(calcularSha256Manifesto(deserializado)).toBe(manifesto.sha256Manifesto);

      expect(() => deserializarManifestoJson('{ invalid json', true)).toThrow(StorageBackupError);
    });

    it('deve salvar e recarregar manifesto de arquivo local validando a assinatura', () => {
      const pdf = criarPdfSintetico('Persistência Teste');
      const manifesto = gerarManifestoBackupStorage({
        bucket: 'acervo',
        objetos: [{ storagePath: 'acervo/persistencia.pdf', conteudo: pdf, arquivoId: 'id-pers' }],
      });

      const arquivoDestino = path.join(tempDir, 'backup-manifest.json');
      salvarManifestoEmArquivo(manifesto, arquivoDestino);

      expect(fs.existsSync(arquivoDestino)).toBe(true);

      const carregado = carregarManifestoDeArquivo(arquivoDestino, true);
      expect(carregado.sha256Manifesto).toBe(manifesto.sha256Manifesto);
      expect(carregado.totalObjetos).toBe(1);
      expect(carregado.objetos[0].storagePath).toBe('acervo/persistencia.pdf');

      // Se adulterar o arquivo JSON manualmente, carregarManifestoDeArquivo deve lançar SIGNATURE_MISMATCH
      const jsonAdulterado = fs
        .readFileSync(arquivoDestino, 'utf8')
        .replace('acervo/persistencia.pdf', 'acervo/hack.pdf');
      fs.writeFileSync(arquivoDestino, jsonAdulterado, 'utf8');

      expect(() => carregarManifestoDeArquivo(arquivoDestino, true)).toThrow(StorageBackupError);
    });
  });
});
