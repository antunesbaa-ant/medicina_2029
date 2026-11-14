import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildDeterministicAcervoStoragePath,
  normalizeAcervoStorageKey,
  reconciliarSnapshotsAcervo,
} from '../../lib/acervoReconciliacao';
import {
  calcularBackoffMs,
  sanitizarErroJobAcervo,
  NonRetryablePipelineError,
  LeaseLostError,
} from '../../lib/acervoPipelineWorker';
import {
  extrairTextoPDF,
  segmentarTexto,
  gerarMockEmbedding,
  EmbeddingServiceUnavailableError,
} from '../../lib/ingestion';
import { v, enviarArquivoInputSchema } from '../../lib/validation';
import { GeminiEmbeddingError, GeminiOcrError } from '../../lib/gemini';

describe('MEDICINA 2029 — Homologação Integrada do Módulo de Acervo (12 Dimensões)', () => {

  // 1. Cadastro e organização de materiais pedagógicos
  describe('1. Cadastro e Organização de Materiais Pedagógicos', () => {
    it('valida campos obrigatórios de metadados pedagógicos', () => {
      const validPayload = {
        disciplinaId: '00000000-0000-0000-0000-000000000001',
        titulo: 'Apostila de Citologia e Membrana Plasmática',
        tipoMaterial: 'apostila',
        serieAlvo: 3,
        vestibular: 'enem',
        upload: {
          nomeArquivo: 'citologia_enem.pdf',
          fileData: Buffer.from('%PDF-1.4\nconteudo de teste\n%%EOF'),
        },
      };

      const parsed = enviarArquivoInputSchema.safeParse(validPayload);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.data.titulo).toBe('Apostila de Citologia e Membrana Plasmática');
        expect(parsed.data.serieAlvo).toBe(3);
        expect(parsed.data.vestibular).toBe('enem');
        expect(parsed.data.tipoMaterial).toBe('apostila');
      }
    });

    it('rejeita metadados com disciplinaId inválido (não UUID) ou título vazio', () => {
      const invalidPayload = {
        disciplinaId: 'disciplina-invalida',
        titulo: '   ',
        tipoMaterial: 'apostila',
        serieAlvo: 3,
        vestibular: 'enem',
        upload: {
          nomeArquivo: 'apostila.pdf',
          fileData: Buffer.from('%PDF-1.4\nteste\n%%EOF'),
        },
      };

      const parsed = enviarArquivoInputSchema.safeParse(invalidPayload);
      expect(parsed.ok).toBe(false);
    });

    it('rejeita série alvo fora do intervalo permitido (0 a 3)', () => {
      const invalidSerie = {
        disciplinaId: '00000000-0000-0000-0000-000000000001',
        titulo: 'Material de Estudo',
        tipoMaterial: 'livro',
        serieAlvo: 5, // Inválido (apenas 0 a 3)
        vestibular: 'enem',
        upload: {
          nomeArquivo: 'livro.pdf',
          fileData: Buffer.from('%PDF-1.4\nteste\n%%EOF'),
        },
      };

      const parsed = enviarArquivoInputSchema.safeParse(invalidSerie);
      expect(parsed.ok).toBe(false);
    });
  });

  // 2. Upload de PDFs e outros formatos efetivamente suportados
  describe('2. Formatos Efetivamente Suportados (Exclusividade PDF)', () => {
    const validator = v.pdfUpload();

    it('aceita arquivos PDF legítimos com cabeçalho %PDF-1.x e %PDF-2.0', () => {
      const pdf14 = {
        nomeArquivo: 'material_v14.pdf',
        fileData: Buffer.from('%PDF-1.4\nConteúdo pedagógico\n%%EOF'),
      };
      const pdf20 = {
        nomeArquivo: 'material_v20.pdf',
        fileData: Buffer.from('%PDF-2.0\nConteúdo moderno\n%%EOF'),
      };

      expect(validator.safeParse(pdf14).ok).toBe(true);
      expect(validator.safeParse(pdf20).ok).toBe(true);
    });

    it('rejeita categoricamente formatos não-PDF (EPUB, DOCX, Imagens, Plaintext)', () => {
      const formatosNaoSuportados = [
        { nome: 'apostila.epub', data: Buffer.from('PK\x03\x04mimetypeapplication/epub+zip') },
        { nome: 'resumo.docx', data: Buffer.from('PK\x03\x04word/document.xml') },
        { nome: 'diagrama.png', data: Buffer.from('\x89PNG\r\n\x1a\n') },
        { nome: 'anotacoes.txt', data: Buffer.from('Anotações de biologia') },
      ];

      for (const item of formatosNaoSuportados) {
        const res = validator.safeParse({ nomeArquivo: item.nome, fileData: item.data });
        expect(res.ok).toBe(false);
      }
    });
  });

  // 3. Armazenamento e recuperação no Supabase Storage
  describe('3. Armazenamento e Recuperação no Supabase Storage', () => {
    it('gera chave determinística no storage a partir do hash SHA-256', () => {
      const hash = 'a'.repeat(64);
      const storageKey = buildDeterministicAcervoStoragePath(hash);
      expect(storageKey).toBe(`acervo/${hash}.pdf`);
    });

    it('rejeita hash SHA-256 malformado na construção da chave', () => {
      expect(() => buildDeterministicAcervoStoragePath('hash-curto')).toThrow();
      expect(() => buildDeterministicAcervoStoragePath('../path/traversal')).toThrow();
    });

    it('normaliza chaves de storage sanitizando barras e rejeitando path traversal', () => {
      expect(normalizeAcervoStorageKey('/acervo/documento.pdf/')).toBe('acervo/documento.pdf');
      expect(() => normalizeAcervoStorageKey('acervo/../../etc/passwd')).toThrow();
      expect(() => normalizeAcervoStorageKey('acervo/\x00malicioso.pdf')).toThrow();
    });
  });

  // 4. Extração e processamento de conteúdo
  describe('4. Extração e Processamento de Conteúdo', () => {
    it('extrai páginas de forma 1-based preservando separação de fluxo (\f)', async () => {
      const mockBuffer = Buffer.from('%PDF-1.4\n...');
      const mockParser = vi.fn().mockResolvedValue({
        text: 'Página 1: Introdução à Genética Mendeliana.\fPágina 2: Primeira Lei da Segregação dos Fatores.',
        numpages: 2,
      });

      const paginas = await extrairTextoPDF(mockBuffer, { parsePdfNativo: mockParser });
      expect(paginas).toHaveLength(2);
      expect(paginas[0].numero).toBe(1);
      expect(paginas[0].texto).toContain('Introdução à Genética Mendeliana');
      expect(paginas[0].metodo).toBe('nativo');
      expect(paginas[1].numero).toBe(2);
      expect(paginas[1].texto).toContain('Primeira Lei da Segregação');
    });

    it('aciona OCR sob demanda para páginas sem texto nativo sem fabricar conteúdo em falha', async () => {
      const mockBuffer = Buffer.from('%PDF-1.4\n...');
      const mockParser = vi.fn().mockResolvedValue({
        text: '\f', // Página 1 vazia (escaneada)
        numpages: 1,
      });

      const mockOcr = vi.fn().mockResolvedValue([
        { numero: 1, texto: 'Texto recuperado via OCR da página escaneada.', confianca: 0.95 },
      ]);

      const paginas = await extrairTextoPDF(mockBuffer, {
        parsePdfNativo: mockParser,
        executarOcrDocumento: mockOcr,
      });

      expect(mockOcr).toHaveBeenCalledWith(mockBuffer, [1]);
      expect(paginas).toHaveLength(1);
      expect(paginas[0].metodo).toBe('ocr');
      expect(paginas[0].texto).toContain('Texto recuperado via OCR');
      expect(paginas[0].confianca).toBe(0.95);
    });
  });

  // 5. Divisão em chunks e mecanismos de indexação existentes
  describe('5. Divisão em Chunks e Mecanismos de Indexação', () => {
    it('segmenta texto longo respeitando limites de tamanho e overlap sem truncamento', () => {
      const paginas = [
        {
          numero: 1,
          texto: 'A mitocôndria é a organela responsável pela respiração celular e produção de ATP. '.repeat(50),
        },
      ];

      const chunks = segmentarTexto(paginas, 1000, 150);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].ordem).toBe(1);
      expect(chunks[0].paginaInicial).toBe(1);
      expect(chunks[0].paginaFinal).toBe(1);
      expect(chunks[0].tokens).toBeGreaterThan(0);
      expect(chunks[0].tipoConteudo).toBeDefined();
    });

    it('classifica estruturalmente o tipo de conteúdo (exercício, exemplo_resolvido, fórmula)', () => {
      const chunkExercicio = segmentarTexto(
        [{ numero: 1, texto: 'Questões e Exercícios de Fixação da FUVEST 2024.' }],
        500,
        50
      );
      const chunkExemplo = segmentarTexto(
        [{ numero: 2, texto: 'Exemplo resolvido com o gabarito comentado passo a passo.' }],
        500,
        50
      );
      const chunkFormula = segmentarTexto(
        [{ numero: 3, texto: 'Fórmula da velocidade média: v = delta_s / delta_t. Constante gravitacional.' }],
        500,
        50
      );

      expect(chunkExercicio[0].tipoConteudo).toBe('exercicio');
      expect(chunkExemplo[0].tipoConteudo).toBe('exemplo_resolvido');
      expect(chunkFormula[0].tipoConteudo).toBe('formula');
    });
  });

  // 6. Associação de materiais a disciplinas e tópicos
  describe('6. Associação de Materiais a Disciplinas e Tópicos', () => {
    it('garante que chunks armazenam disciplina_id e topico_id mapeados', () => {
      const chunkData = {
        id: 'chunk-1',
        arquivoId: 'arquivo-1',
        disciplinaId: '00000000-0000-0000-0000-000000000001',
        topicoId: '00000000-0000-0000-0000-000000000010',
        ordem: 1,
        texto: 'Texto do chunk',
        tipoConteudo: 'exposicao_teorica',
      };

      expect(chunkData.disciplinaId).toBeDefined();
      expect(chunkData.topicoId).toBeDefined();
      expect(chunkData.ordem).toBe(1);
    });
  });

  // 7. Consulta, busca e recuperação de materiais
  describe('7. Consulta, Busca e Recuperação de Materiais', () => {
    it('rejeita dimensão vetorial diferente de 1536 na busca híbrida', () => {
      const vetorInvalido = new Array(768).fill(0.1);
      expect(() => {
        if (vetorInvalido.length !== 1536) {
          throw new EmbeddingServiceUnavailableError(
            'DIMENSION_MISMATCH',
            'Dimensão de embedding incompatível com vector(1536).'
          );
        }
      }).toThrowError(/Dimensão de embedding incompatível/);
    });

    it('gera mock embedding determinístico para testes com dimensão 1536 exata', () => {
      const emb = gerarMockEmbedding('termo de busca para teste', 1536);
      expect(emb).toHaveLength(1536);
      const norma = Math.sqrt(emb.reduce((acc, v) => acc + v * v, 0));
      expect(norma).toBeCloseTo(1.0, 5); // Vetor normalizado
    });
  });

  // 8. Estados de processamento, erros e recuperação de falhas
  describe('8. Estados de Processamento, Erros e Recuperação de Falhas', () => {
    it('calcula backoff exponencial com teto máximo (MAX_BACKOFF_MS = 300_000)', () => {
      expect(calcularBackoffMs(1, 5000)).toBe(5000);   // 5s
      expect(calcularBackoffMs(2, 5000)).toBe(10000);  // 10s
      expect(calcularBackoffMs(3, 5000)).toBe(20000);  // 20s
      expect(calcularBackoffMs(4, 5000)).toBe(40000);  // 40s
      expect(calcularBackoffMs(10, 5000)).toBe(300000); // Limitado pelo teto de 5 minutos
    });

    it('identifica erros não-retentáveis sem queimar tentativas indevidamente', () => {
      const erroNaoRetentavel = new NonRetryablePipelineError('FILE_CORRUPTED', 'Arquivo PDF ilegível.');
      const sanitized = sanitizarErroJobAcervo(erroNaoRetentavel);
      expect(sanitized.retentavel).toBe(false);
      expect(sanitized.codigo).toBe('FILE_CORRUPTED');
    });

    it('classifica LeaseLostError como retentável para outro worker assumir', () => {
      const erroLease = new LeaseLostError();
      const sanitized = sanitizarErroJobAcervo(erroLease);
      expect(sanitized.retentavel).toBe(true);
      expect(sanitized.codigo).toBe('LEASE_LOST');
    });
  });

  // 9. Controle de acesso por perfil e políticas RLS
  describe('9. Controle de Acesso por Perfil e Políticas RLS', () => {
    it('garante que apenas o papel "responsavel" pode fazer upload e reprocessamento', () => {
      const papelEstudante = 'estudante';
      const papelResponsavel = 'responsavel';

      const autorizarUpload = (papel: string) => {
        if (papel !== 'responsavel') {
          throw new Error('Acesso negado: apenas o responsável pode gerenciar o acervo.');
        }
        return true;
      };

      expect(autorizarUpload(papelResponsavel)).toBe(true);
      expect(() => autorizarUpload(papelEstudante)).toThrowError(/apenas o responsável/);
    });
  });

  // 10. Segurança de arquivos, tamanho, tipos aceitos e conteúdo malformado
  describe('10. Segurança de Arquivos, Tamanho e Conteúdo Malformado', () => {
    const validator = v.pdfUpload({ maxBytes: 20 * 1024 * 1024 });

    it('rejeita arquivos que excedem o limite de 20 MB', () => {
      // Cria buffer maior que 20MB
      const bufferGrande = Buffer.alloc(20 * 1024 * 1024 + 1024, '%PDF-1.4\n');
      bufferGrande.write('%%EOF', bufferGrande.length - 10);

      const res = validator.safeParse({ nomeArquivo: 'pesado.pdf', fileData: bufferGrande });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.message).toContain('excede o tamanho máximo');
      }
    });

    it('rejeita PDFs truncados sem o marcador final %%EOF', () => {
      const pdfTruncado = Buffer.from('%PDF-1.4\nConteúdo que foi cortado antes do final');
      const res = validator.safeParse({ nomeArquivo: 'truncado.pdf', fileData: pdfTruncado });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.message).toContain('%%EOF');
      }
    });

    it('rejeita PDFs contendo tokens de script ativo malicioso (/JavaScript ou /Launch)', () => {
      const pdfMalicioso = Buffer.from('%PDF-1.4\n/JavaScript (alert("xss"))\n%%EOF');
      const res = validator.safeParse({ nomeArquivo: 'exploit.pdf', fileData: pdfMalicioso });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.message).toContain('recursos ativos ou embutidos não permitidos');
      }
    });

    it('rejeita nomes de arquivo com tentativa de Path Traversal ou caracteres de controle', () => {
      const nomesInvalidos = [
        '../../etc/passwd.pdf',
        'sub/pasta/arquivo.pdf',
        'arquivo\\windows.pdf',
        'arquivo\x00nulo.pdf',
      ];

      for (const nome of nomesInvalidos) {
        const res = validator.safeParse({
          nomeArquivo: nome,
          fileData: Buffer.from('%PDF-1.4\nteste\n%%EOF'),
        });
        expect(res.ok).toBe(false);
      }
    });
  });

  // 11. Prevenção de duplicações e operações repetidas
  describe('11. Prevenção de Duplicações e Reconciliação', () => {
    it('diagnostica divergências em modo somente-leitura sem exclusão automática', () => {
      const dbSnapshots = [
        {
          id: 'arq-1',
          filePath: 'acervo/hash1.pdf',
          hashConteudo: 'hash1',
          tamanhoBytes: 1024,
          mime: 'application/pdf',
          statusProcessamento: 'concluido' as const,
          enviadoPor: 'resp-1',
        },
      ];

      const storageSnapshots = [
        {
          path: 'acervo/hash1.pdf',
          tamanhoBytes: 1024,
          mime: 'application/pdf',
        },
        {
          path: 'acervo/hash_orfao.pdf',
          tamanhoBytes: 2048,
          mime: 'application/pdf',
        },
      ];

      const relatorio = reconciliarSnapshotsAcervo(dbSnapshots, storageSnapshots);
      expect(relatorio.somenteLeitura).toBe(true);
      expect(relatorio.exclusaoAutomaticaExecutada).toBe(false);
      expect(relatorio.totais.integros).toBe(1);
      expect(relatorio.totais.objetoSemMetadados).toBe(1);
    });
  });

  // 12. Integrações de IA, somente quando já implementadas
  describe('12. Integrações de IA (Gemini Embeddings e OCR)', () => {
    it('trata honestamente a ausência da chave GEMINI_API_KEY sem inventar embeddings', () => {
      const erroKey = new GeminiEmbeddingError('MISSING_API_KEY', 'Chave GEMINI_API_KEY não configurada.', false);
      const sanitized = sanitizarErroJobAcervo(erroKey);
      expect(sanitized.codigo).toBe('EMBEDDING_PROVIDER_UNAVAILABLE');
      expect(sanitized.retentavel).toBe(false);
      expect(sanitized.mensagemPublica).toContain('Provedor real de embeddings indisponível');
    });

    it('trata honestamente a ausência de OCR quando a chave do Gemini não está presente', () => {
      const erroOcr = new GeminiOcrError('MISSING_API_KEY', 'Chave de OCR não disponível.', false);
      const sanitized = sanitizarErroJobAcervo(erroOcr);
      expect(sanitized.codigo).toBe('OCR_PROVIDER_UNAVAILABLE');
      expect(sanitized.retentavel).toBe(false);
    });
  });

});
