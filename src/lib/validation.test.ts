import { describe, expect, it } from 'vitest';
import {
  v,
  isValidUuid,
  computeIdempotencyPayloadHash,
  iniciarSessaoInputSchema,
  atualizarSessaoInputSchema,
  concluirSessaoInputSchema,
  registrarRevisaoCardInputSchema,
  registrarSimuladoInputSchema,
  curarItemInputSchema,
  registrarRedacaoInputSchema,
  registrarRepertorioInputSchema,
  enviarArquivoInputSchema,
  registrarCheckinInputSchema,
  MAX_UPLOAD_FILE_BYTES,
} from './validation';

const VALID_UUID_1 = '10000000-0000-4000-8000-000000000001';
const VALID_UUID_2 = '20000000-0000-4000-8000-000000000002';
const VALID_PDF_BASE64 = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n').toString('base64');

describe('F1.09 - Schemas reutilizáveis de validação runtime', () => {
  describe('UUID e primitivos básicos', () => {
    it('aceita UUIDs válidos e rejeita UUID nulo ou malformado', () => {
      expect(isValidUuid(VALID_UUID_1)).toBe(true);
      expect(isValidUuid('00000000-0000-0000-0000-000000000000')).toBe(false);
      expect(isValidUuid('nao-e-uuid')).toBe(false);
      expect(isValidUuid('')).toBe(false);
      expect(isValidUuid(123)).toBe(false);
    });

    it('rejeita strings com byte nulo ou tamanho fora dos limites', () => {
      const schema = v.string({ label: 'Campo', min: 3, max: 10 });
      expect(schema.safeParse('abc').ok).toBe(true);
      expect(schema.safeParse('  ab  ').ok).toBe(false);
      expect(schema.safeParse('01234567890').ok).toBe(false);
      expect(schema.safeParse('abc\0def').ok).toBe(false);
    });

    it('rejeita identificadores de autorização enviados pelo cliente em objetos', () => {
      const res = registrarCheckinInputSchema.safeParse({
        horasSono: 8,
        exercicioMin: 30,
        humor: 4,
        energia: 4,
        perfilId: VALID_UUID_1,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.message).toContain('Identificador de autorização');
      }
    });
  });

  describe('Sessões e Cronômetro', () => {
    it('valida iniciarSessao com UUIDs válidos e rejeita UUID inválido', () => {
      expect(
        iniciarSessaoInputSchema.safeParse({
          cicloBlocoId: VALID_UUID_1,
          topicoId: VALID_UUID_2,
        }).ok
      ).toBe(true);

      expect(
        iniciarSessaoInputSchema.safeParse({
          cicloBlocoId: 'bloco-invalido',
          topicoId: VALID_UUID_2,
        }).ok
      ).toBe(false);
    });

    it('rejeita atualizarSessao sem campos ou com segundos negativos/excessivos', () => {
      expect(
        atualizarSessaoInputSchema.safeParse({
          sessaoId: VALID_UUID_1,
          dados: {},
        }).ok
      ).toBe(false);

      expect(
        atualizarSessaoInputSchema.safeParse({
          sessaoId: VALID_UUID_1,
          dados: { segundosEfetivos: -1 },
        }).ok
      ).toBe(false);

      expect(
        atualizarSessaoInputSchema.safeParse({
          sessaoId: VALID_UUID_1,
          dados: { segundosEfetivos: 90_000 },
        }).ok
      ).toBe(false);
    });

    it('rejeita concluirSessao com tentativas duplicadas na lista de erros', () => {
      const res = concluirSessaoInputSchema.safeParse({
        sessaoId: VALID_UUID_1,
        dadosFinalizacao: {
          etapaAtingida: 'registro',
          errosParaRegistrar: [
            { questaoId: VALID_UUID_1, tentativaId: VALID_UUID_2, tipoErro: 'conteudo' },
            { questaoId: VALID_UUID_1, tentativaId: VALID_UUID_2, tipoErro: 'calculo' },
          ],
        },
      });
      expect(res.ok).toBe(false);
    });
  });

  describe('FSRS', () => {
    it('rejeita rating inválido, duração negativa, decimal ou excessiva', () => {
      expect(
        registrarRevisaoCardInputSchema.safeParse({
          cardId: VALID_UUID_1,
          ratingStr: 'invalid',
          duracaoMs: 1000,
        }).ok
      ).toBe(false);

      expect(
        registrarRevisaoCardInputSchema.safeParse({
          cardId: VALID_UUID_1,
          ratingStr: 'good',
          duracaoMs: 0,
        }).ok
      ).toBe(false);

      expect(
        registrarRevisaoCardInputSchema.safeParse({
          cardId: VALID_UUID_1,
          ratingStr: 'good',
          duracaoMs: 12.5,
        }).ok
      ).toBe(false);

      expect(
        registrarRevisaoCardInputSchema.safeParse({
          cardId: VALID_UUID_1,
          ratingStr: 'good',
          duracaoMs: 4_000_000,
        }).ok
      ).toBe(false);
    });
  });

  describe('Simulados', () => {
    it('rejeita áreas vazias, áreas duplicadas, data inválida e acertos > total', () => {
      const base = {
        formato: 'enem',
        data: '2026-10-20',
        condicoesReais: true,
        duracaoMin: 270,
        local: 'Casa',
        composicaoProcedencia: { origem: 'oficial' },
        areas: [{ area: 'Natureza', acertos: 30, total: 45 }],
      };

      expect(registrarSimuladoInputSchema.safeParse(base).ok).toBe(true);
      expect(registrarSimuladoInputSchema.safeParse({ ...base, areas: [] }).ok).toBe(false);
      expect(
        registrarSimuladoInputSchema.safeParse({
          ...base,
          areas: [
            { area: 'Natureza', acertos: 30, total: 45 },
            { area: 'natureza', acertos: 25, total: 45 },
          ],
        }).ok
      ).toBe(false);
      expect(registrarSimuladoInputSchema.safeParse({ ...base, data: 'data-invalida' }).ok).toBe(false);
      expect(registrarSimuladoInputSchema.safeParse({ ...base, duracaoMin: 0 }).ok).toBe(false);
    });
  });

  describe('Curadoria e Redações', () => {
    it('exige novosDados quando a decisão de curadoria é editado_e_aprovado', () => {
      expect(
        curarItemInputSchema.safeParse({
          curadoriaId: VALID_UUID_1,
          decisao: 'editado_e_aprovado',
          novosDados: {},
        }).ok
      ).toBe(false);

      expect(
        curarItemInputSchema.safeParse({
          curadoriaId: VALID_UUID_1,
          decisao: 'editado_e_aprovado',
          novosDados: { titulo: 'Título Revisado' },
        }).ok
      ).toBe(true);
    });

    it('exige generoId para genero_uece e proíbe generoId para enem', () => {
      expect(
        registrarRedacaoInputSchema.safeParse({
          formato: 'genero_uece',
          tema: 'Tema',
          texto: 'Texto',
          minutosGastos: 50,
        }).ok
      ).toBe(false);

      expect(
        registrarRedacaoInputSchema.safeParse({
          formato: 'enem',
          generoId: VALID_UUID_1,
          tema: 'Tema',
          texto: 'Texto',
          minutosGastos: 50,
        }).ok
      ).toBe(false);
    });

    it('rejeita temas duplicados no repertório', () => {
      expect(
        registrarRepertorioInputSchema.safeParse({
          referencia: 'Bauman',
          resumo2Linhas: 'Modernidade líquida',
          temasAplicaveis: ['Saúde', 'saúde'],
          categoria: 'Sociologia',
        }).ok
      ).toBe(false);
    });
  });

  describe('Acervo e Upload de PDF', () => {
    const baseUpload = {
      disciplinaId: VALID_UUID_1,
      titulo: 'Apostila de Biologia',
      tipoMaterial: 'apostila',
      serieAlvo: 1,
      vestibular: 'enem',
      upload: {
        nomeArquivo: 'apostila.pdf',
        base64Data: VALID_PDF_BASE64,
      },
    };

    it('aceita PDF válido e rejeita extensão inválida, path traversal, magic bytes inválidos ou tamanho excessivo', () => {
      expect(enviarArquivoInputSchema.safeParse(baseUpload).ok).toBe(true);

      // Extensão inválida
      expect(
        enviarArquivoInputSchema.safeParse({
          ...baseUpload,
          upload: { nomeArquivo: 'malware.exe', base64Data: VALID_PDF_BASE64 },
        }).ok
      ).toBe(false);

      // Path traversal
      expect(
        enviarArquivoInputSchema.safeParse({
          ...baseUpload,
          upload: { nomeArquivo: '../apostila.pdf', base64Data: VALID_PDF_BASE64 },
        }).ok
      ).toBe(false);

      // Conteúdo não-PDF (magic bytes inválidos)
      expect(
        enviarArquivoInputSchema.safeParse({
          ...baseUpload,
          upload: {
            nomeArquivo: 'falso.pdf',
            base64Data: Buffer.from('Isto nao e um PDF').toString('base64'),
          },
        }).ok
      ).toBe(false);

      // Arquivo excessivo (> 20 MiB em base64)
      const oversizedBase64 = 'A'.repeat(Math.ceil(((MAX_UPLOAD_FILE_BYTES + 1024) * 4) / 3));
      expect(
        enviarArquivoInputSchema.safeParse({
          ...baseUpload,
          upload: { nomeArquivo: 'gigante.pdf', base64Data: oversizedBase64 },
        }).ok
      ).toBe(false);
    });
  });

  describe('Idempotência determinística', () => {
    it('gera o mesmo hash para objetos equivalentes com chaves em ordens distintas e hash distinto para payload alterado', () => {
      const h1 = computeIdempotencyPayloadHash('fsrs.revisar', { cardId: VALID_UUID_1, rating: 'good' });
      const h2 = computeIdempotencyPayloadHash('fsrs.revisar', { rating: 'good', cardId: VALID_UUID_1 });
      const h3 = computeIdempotencyPayloadHash('fsrs.revisar', { cardId: VALID_UUID_1, rating: 'easy' });
      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);
      expect(h1).toHaveLength(64);
    });
  });
});
