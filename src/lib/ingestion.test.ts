import { describe, it, expect, vi } from 'vitest';
import {
  segmentarTexto,
  gerarMockEmbedding,
  extrairTextoPDF
} from './ingestion';

// Mock pdf-parse
vi.mock('pdf-parse', () => {
  return {
    default: vi.fn().mockResolvedValue({
      text: 'Página 1 de teste sobre Equilíbrio Químico.\fPágina 2 de teste com exercícios de estequiometria.'
    })
  };
});

describe('Motor de Ingestão - Ingestion Pipeline', () => {

  // 1. Extração de PDF
  describe('Extração de PDF', () => {
    it('deve extrair texto e separar por páginas corretas', async () => {
      const buffer = Buffer.from('PDF_DUMMY_DATA');
      const paginas = await extrairTextoPDF(buffer);
      
      expect(paginas.length).toBe(2);
      expect(paginas[0].numero).toBe(1);
      expect(paginas[0].texto).toContain('Página 1');
      expect(paginas[1].numero).toBe(2);
      expect(paginas[1].texto).toContain('Página 2');
    });
  });

  // 2. Segmentação Semântica
  describe('Segmentação Semântica', () => {
    it('deve segmentar texto longo respeitando limites e sobreposição', () => {
      const paginas = [
        { numero: 1, texto: 'Texto da página 1 contendo tópicos de estudo teóricos.' },
        { numero: 2, texto: 'Texto da página 2 contendo fórmulas e definições importantes.' },
        { numero: 3, texto: 'Texto da página 3 com exercícios adicionais e questões resolvidas.' }
      ];

      // Configura maxChars pequeno para forçar múltiplos chunks
      const chunks = segmentarTexto(paginas, 50, 10);
      
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].ordem).toBe(1);
      expect(chunks[0].paginaInicial).toBe(1);
      expect(chunks[chunks.length - 1].paginaFinal).toBe(3);
    });

    it('deve inferir o tipo de conteúdo do chunk corretamente', () => {
      const paginas = [
        { numero: 1, texto: 'Questões de biologia e exercícios de citologia celular.' }
      ];
      const chunks = segmentarTexto(paginas, 100, 10);
      expect(chunks[0].tipoConteudo).toBe('exercicio');
    });
  });

  // 3. Geração de Embedding Mock
  describe('Embeddings', () => {
    it('deve gerar vetor normalizado com dimensão 1536', () => {
      const text = 'Estudo de Medicina 2029';
      const vector = gerarMockEmbedding(text, 1536);
      
      expect(vector.length).toBe(1536);
      
      // Magnitude de um vetor normalizado deve ser aproximadamente 1
      const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
      expect(magnitude).toBeCloseTo(1, 5);
    });
  });

});
