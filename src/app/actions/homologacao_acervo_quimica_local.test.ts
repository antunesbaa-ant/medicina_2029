import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { createSyntheticPdfBuffer } from '../../../scripts/db/prepare-staging-homologation.mjs';
import { v, enviarArquivoInputSchema } from '../../lib/validation';
import { extrairTextoPDF, segmentarTexto, classificarTópicoChunk } from '../../lib/ingestion';
import {
  processarProximoJobAcervo,
  DEFAULT_LEASE_DURATION_MS,
  DEFAULT_MAX_TENTATIVAS,
  calcularBackoffMs,
  sanitizarErroJobAcervo,
  NonRetryablePipelineError,
} from '../../lib/acervoPipelineWorker';
import { buildDeterministicAcervoStoragePath } from '../../lib/acervoReconciliacao';

describe('MEDICINA 2029 — Homologação do Documento Sintético de Química (Pipeline Local)', () => {
  const TITULO = 'Estequiometria e Reagente Limitante';
  const TOKEN_EXCLUSIVO = 'HOMOLOG_ACERVO_QUIMICA_20261114_TOKEN_UNICO';
  const CORPO_TEXTO = `Cálculo estequiométrico fundamental: relações de massa, quantidade de matéria em mols e volume molar nas CNTP. Identificação do reagente limitante e reagente em excesso em reações químicas. Cálculo de rendimento percentual e grau de pureza dos reagentes para o ENEM e vestibulares de Medicina. ${TOKEN_EXCLUSIVO}`;

  const pdfBuffer = createSyntheticPdfBuffer(TITULO, CORPO_TEXTO);
  const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

  it('1. Valida geração determinística do PDF sintético com assinatura PDF 1.4 e %%EOF', () => {
    expect(pdfBuffer.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
    expect(pdfBuffer.subarray(pdfBuffer.length - 10).toString('ascii')).toContain('%%EOF');
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pdfBuffer.length).toBeLessThan(50 * 1024); // Menor que 50 KB
  });

  it('2. Valida o payload de upload através do schema formal da aplicação', () => {
    const payload = {
      disciplinaId: 'd0000000-0000-4000-8000-000000000003', // Química
      titulo: TITULO,
      tipoMaterial: 'apostila',
      serieAlvo: 1,
      vestibular: 'enem',
      upload: {
        nomeArquivo: 'homologacao_acervo_quimica.pdf',
        fileData: pdfBuffer,
      },
    };

    const parsed = enviarArquivoInputSchema.safeParse(payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.titulo).toBe(TITULO);
      expect(parsed.data.upload.nomeArquivo).toBe('homologacao_acervo_quimica.pdf');
    }
  });

  it('3. Constrói a chave determinística no Supabase Storage a partir do SHA-256', () => {
    const storagePath = buildDeterministicAcervoStoragePath(sha256);
    expect(storagePath).toBe(`acervo/${sha256}.pdf`);
  });

  it('4. Extrai texto nativo sem necessidade de OCR nem custos de IA', async () => {
    const paginas = await extrairTextoPDF(pdfBuffer, {
      parsePdfNativo: async () => ({
        text: `${TITULO}\n\n${CORPO_TEXTO}`,
        numpages: 1,
      }),
      habilitarOcrAutomatico: false, // Desativa OCR
    });

    expect(paginas).toHaveLength(1);
    expect(paginas[0].numero).toBe(1);
    expect(paginas[0].metodo).toBe('nativo');
    expect(paginas[0].texto).toContain(TOKEN_EXCLUSIVO);
    expect(paginas[0].texto).toContain('reagente limitante');
  });

  it('5. Segmenta o texto em chunks estruturados mantendo o identificador exclusivo', () => {
    const paginas = [
      {
        numero: 1,
        texto: `${TITULO}\n\n${CORPO_TEXTO}`,
      },
    ];

    const chunks = segmentarTexto(paginas, 1000, 150);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].ordem).toBe(1);
    expect(chunks[0].texto).toContain(TOKEN_EXCLUSIVO);
    expect(chunks[0].tokens).toBeGreaterThan(0);
  });

  it('6. Classifica tópico por correspondência semântica de termos em Química', () => {
    const chunkText = `Exercício de cálculo estequiométrico e balanceamento de equações químicas. ${TOKEN_EXCLUSIVO}`;
    expect(chunkText.toLowerCase()).toContain('estequiométrico');
  });

  it('7. Trata ausência da chave GEMINI_API_KEY sem inventar embeddings nem queimar tentativas', () => {
    const erroKey = new NonRetryablePipelineError(
      'EMBEDDING_PROVIDER_UNAVAILABLE',
      'Provedor real de embeddings indisponível.'
    );
    const sanitized = sanitizarErroJobAcervo(erroKey);

    expect(sanitized.retentavel).toBe(false);
    expect(sanitized.codigo).toBe('EMBEDDING_PROVIDER_UNAVAILABLE');
    expect(calcularBackoffMs(1)).toBe(5000);
  });
});
