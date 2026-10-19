import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const fonte = readFileSync(resolve(process.cwd(), 'src/components/ResponsavelPage.tsx'), 'utf8');

describe('ResponsavelPage — superfície de exportação e restauração', () => {
  it('não importa nem aciona a Server Action histórica de restauração', () => {
    expect(fonte).not.toContain('restaurarDadosCompletos');
    expect(fonte).not.toContain('handleRestaurar');
    expect(fonte).not.toMatch(/<input[\s\S]*?type=["']file["']/);
  });

  it('identifica o JSON como exportação parcial e não restaurável', () => {
    expect(fonte).toContain('Exportar Dados Administrativos (JSON)');
    expect(fonte).toContain('não contém segredos');
    expect(fonte).toContain('objetos binários do Storage');
    expect(fonte).toContain('não constitui um backup completo ou restaurável');
    expect(fonte).toContain('restauração pela interface está temporariamente indisponível por segurança');
  });
});
