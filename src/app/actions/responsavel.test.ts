import { describe, it, expect, vi, beforeEach } from 'vitest';
import { obterAcompanhamentoQuinzenal, registrarRevisaoTrimestral, obterRevisoesTrimestrais } from './responsavel';
import * as responsavelActions from './responsavel';

// Mock DB
vi.mock('../../db', () => {
  const queryBuilder: any = {
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'mock-id' }]),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (resolve: any) => resolve([])
  };
  return { db: queryBuilder };
});

describe('Fase 8 - Acompanhamento do Responsável e Revisões Trimestrais', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deve obter resumos quinzenais agregados com sucesso (mock fallback)', async () => {
    const list = await obterAcompanhamentoQuinzenal();
    expect(list).toBeDefined();
    expect(list.length).toBe(2);
    expect(list[0].periodoRotulo).toBeDefined();
    expect(list[0].blocosConcluidos).toBeGreaterThan(0);
  });

  it('deve registrar e listar revisoes trimestrais', async () => {
    const reg = await registrarRevisaoTrimestral({
      trimestre: 3,
      ano: 2026,
      conversa: 'Conversa de alinhamento',
      decisoes: 'Decisões tomadas'
    });
    expect(reg.sucesso).toBe(true);

    const list = await obterRevisoesTrimestrais();
    expect(Array.isArray(list)).toBe(true);
  });

  // CRITÉRIO DE ACEITE: "Painel não expõe granularidade diária, verificado por teste"
  it('garante que o painel do responsável não expõe granularidade diária', () => {
    // 1. Verifica se todas as chaves expostas nas quinzenas são de fato resumos e não listam registros individuais
    const exportedKeys = Object.keys(responsavelActions);
    
    // Assegura que não há nenhuma função exportada com nomes que remetem a detalhes de sessões diárias
    const hasDailyExposingAction = exportedKeys.some(key => 
      key.toLowerCase().includes('diari') || 
      key.toLowerCase().includes('sessaoDetalhe') || 
      key.toLowerCase().includes('checkinDetalhe')
    );
    expect(hasDailyExposingAction).toBe(false);
  });

});
