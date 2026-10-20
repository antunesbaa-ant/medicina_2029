import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const fonte = readFileSync(resolve(process.cwd(), 'src/components/AcervoPage.tsx'), 'utf8');

describe('AcervoPage — confirmação honesta de upload', () => {
  it('exibe confirmação somente no ramo discriminado de sucesso', () => {
    expect(fonte).toContain('if (res.ok)');
    expect(fonte).toContain('setUploadMessage(res.data.mensagem)');
    expect(fonte).not.toContain('Arquivo enfileirado para processamento');
  });

  it('diferencia upload confirmado de processamento concluído', () => {
    expect(fonte).toContain("uploadMessage.startsWith('Upload confirmado')");
    expect(fonte).toContain("case 'concluido'");
    expect(fonte).toContain("case 'falhou'");
  });
});
