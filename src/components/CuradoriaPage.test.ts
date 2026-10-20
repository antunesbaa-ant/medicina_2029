import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const fonte = readFileSync(resolve(process.cwd(), 'src/components/CuradoriaPage.tsx'), 'utf8');

describe('CuradoriaPage — erros de geração e persistência', () => {
  it('remove itens somente após confirmação discriminada', () => {
    expect(fonte.match(/if \(res\.ok\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(fonte).not.toContain('if (res.sucesso)');
  });

  it('não apresenta fallback de IA como geração concluída', () => {
    expect(fonte).toContain('via Gemini');
    expect(fonte).toContain('setGeracaoMsg(`Erro: ${res.message}`)');
    expect(fonte).not.toContain('Artefatos enfileirados para curadoria');
  });
});
