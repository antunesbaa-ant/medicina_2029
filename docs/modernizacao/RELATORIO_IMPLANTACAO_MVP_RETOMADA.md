# MEDICINA 2029 — RELATÓRIO DE RETOMADA E DESBLOQUEIO DE ACESSOS DA IMPLANTAÇÃO DO MVP ACADÊMICO SEM IA

**Data de Emissão:** 15 de Novembro de 2026  
**Ambiente Auditado:** Repositório Local, Vercel Cloud CLI, Supabase CLI, Engine Descartável PostgreSQL 17 (PGlite + pgvector)  
**Versão da Plataforma:** Next.js 16.4.2 (Turbopack) / React 19.2.4 / Node.js 24 / PostgreSQL 17.11  
**Custo Financeiro Adicional:** **R$ 0,00 / US$ 0,00**  
**Classificação Final do Resultado:** **IMPLANTAÇÃO PARCIAL NÃO LIBERADA**  

---

## 1. RESUMO EXECUTIVO E AUTENTICAÇÕES OBTIDAS

Em atendimento ao comando de desbloqueio e retomada, os fluxos oficiais de autenticação assistida foram acionados:

### 1.1 Vercel (Autenticação Concluída com Sucesso)
- **Status:** **AUTENTICADO COM SUCESSO.**
- **Identidade:** Usuário `antunesbaa-7420`.
- **Time Ativo:** `antunesbaa-7420s-projects` (antunesbaa-7420's projects).
- **Plano de Hospedagem:** **Hobby (US$ 0,00 / Custo Zero Confirmado)**.
- **Prontidão:** A ferramenta oficial Vercel CLI encontra-se conectada e pronta para execução de deployments de produção via CLI sem necessidade de Git push.

### 1.2 Supabase (Impedimento de Autorização Web)
- **Status:** **AGUARDANDO AUTORIZAÇÃO WEB DO TITULAR.**
- **Diagnóstico Técnico:** A ferramenta oficial Supabase CLI opera através de um fluxo criptográfico baseado em sessão única (`https://supabase.com/dashboard/cli/login?session_id=...`). Diferentemente da Vercel, o Supabase não conclui o emparelhamento por callback local sem a confirmação e aprovação explícita do titular autenticado na sessão web do dashboard.
- **Preservação de Segurança:** Em cumprimento à Diretriz Permanente A (sem contornar MFA/CAPTCHA e sem exigir que o proprietário execute comandos manuais ou copie tokens no chat), a criação remota de infraestrutura de banco de dados aguarda a confirmação de acesso ou criação do projeto no Supabase.

---

## 2. VALIDAÇÃO DOS DADOS DOS USUÁRIOS REAIS (BRUNO E ALICE)

Conforme a determinação expressa da Seção 2 do Mandato:
1. **Auditoria de E-mails:** Os endereços preliminares `bruno@medicina2029.com.br` e `alice@medicina2029.com.br` foram auditados no repositório. Identificou-se que a conta Git ativa do proprietário utiliza o alias `273623931+antunesbaa-ant@users.noreply.github.com` e não há registro de propriedade de domínio próprio `@medicina2029.com.br`.
2. **Bloqueio Preventivo de Inserção:** Em estrita observância à regra *"Não criar contas reais com esses e-mails até confirmar a identidade e a titularidade adequada"*, a criação de usuários foi formalmente suspensa até a confirmação humana dos endereços reais de e-mail que Bruno e Alice utilizarão no acesso ao sistema.
3. **Isolamento de Homologação:** Nenhuma credencial ou identidade sintética foi importada do Staging (`ynfocaorhadizlvbnzrt`), mantendo Carlos estritamente fora do ambiente de produção.

---

## 3. VALIDAÇÃO INTEGRAL DA CADEIA DE 11 MIGRAÇÕES EM BANCO DESCARTÁVEL REAL

Para atender à exigência da Seção 4 (*"Não considerar validação estática por hashes equivalente a execução bem-sucedida das migrações"*), foi configurado um ambiente local descartável baseado na engine **PGlite (PostgreSQL 17)** com suporte nativo à extensão `pgvector`.

O script [`scripts/db/validate-disposable-migrations.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/validate-disposable-migrations.mjs) executou a cadeia canônica completa de 11 migrações:

| Etapa | Arquivo Canônico Executado | Resultado no Banco Descartável | Tempo de Execução |
| :---: | :--- | :---: | :---: |
| 1/11 | `drizzle/0000_greedy_loki.sql` | **Aprovado** (Estrutura base, perfis, acervo) | 148 ms |
| 2/11 | `drizzle/0001_dry_talos.sql` | **Aprovado** (Campos de autenticação) | 12 ms |
| 3/11 | `drizzle/0002_little_swarm.sql` | **Aprovado** (Atributo de vestibular) | < 1 ms |
| 4/11 | `drizzle/0003_f1_03_r_expansao.sql` | **Aprovado** (Ciclos e `responsavel_estudante`) | 75 ms |
| 5/11 | `docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql` | **Aprovado** (Schema `medicina`, roles e RLS) | 49 ms |
| 6/11 | `docs/modernizacao/propostas/F1_09_INTEGRIDADE_E_IDEMPOTENCIA_PROPOSTA.sql` | **Aprovado** (Constraints e idempotência) | 11 ms |
| 7/11 | `docs/modernizacao/propostas/F1_10_STORAGE_POLICIES_PROPOSTA.sql` | **Aprovado** (Políticas de segurança do storage) | 3 ms |
| 8/11 | `docs/modernizacao/propostas/F1_11_FILA_INGESTAO_PROPOSTA.sql` | **Aprovado** (Fila estrutural de jobs) | 12 ms |
| 9/11 | `docs/modernizacao/propostas/F1_12_BUSCA_VETORIAL_E_INDICES_PROPOSTA.sql` | **Aprovado** (Preservação de `vector(1536)`) | 5 ms |
| 10/11 | `docs/modernizacao/propostas/H2_05_FIX_SIMULADOS_EVOLUCAO_PROPOSTA.sql` | **Aprovado** (**Correção 42804 de Simulados**) | 1 ms |
| 11/11 | `docs/modernizacao/propostas/H2_05_SEED_GENEROS_UECE_PROPOSTA.sql` | **Aprovado** (**5 Gêneros Textuais Oficiais UECE**) | 1 ms |

### 3.1 Descobertas e Correções Críticas Realizadas
1. **Correção do Erro 42804:** A view `public.vw_simulados_evolucao` foi consultada no banco descartável e retornou com sucesso integral sem disparar o erro de incompatibilidade de tipos entre `timestamp` e `date`.
2. **Descoberta na Tabela `responsavel_estudante`:** O teste real no PostgreSQL revelou que a tabela `responsavel_estudante` possui como chave primária `vinculo_id smallint PRIMARY KEY DEFAULT 1` com restrição singleton (`vinculo_id = 1`), não existindo coluna com o nome `id`. O script de seed de produção ([`src/db/seed-production.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/seed-production.ts)) foi imediatamente corrigido para respeitar o schema exato do banco.
3. **Preservação Vetorial:** A coluna `public.acervo_chunks.embedding` foi inspecionada via catálogo `information_schema` e confirmada como `USER-DEFINED` (`vector(1536)`).
4. **Idempotência:** A reexecução dos seeds e da migração 11 comprovou que a contagem de gêneros se manteve estritamente em 5, sem duplicação de dados.

---

## 4. ESTRATÉGIA DE BACKUP E RECUPERAÇÃO AUTÔNOMA (CUSTO ZERO)

Para atender integralmente aos requisitos de segurança sem contratar serviços de nuvem adicionais, foi desenvolvido e validado o utilitário [`scripts/db/backup-production-engine.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/backup-production-engine.mjs):

1. **Cifragem Autenticada:** Utilização do envelope binário **AES-256-GCM (M29G)** com tag de autenticação de 128 bits e derivação de chaves via PBKDF2 (100.000 iterações), garantindo confidencialidade e integridade contra adulteração.
2. **Destino Independente:** Os snapshots são gravados em diretório seguro e isolado fora da árvore do Git (`~/.medicina2029/backups/production/`), com permissões restritas de sistema de arquivos (`chmod 700`).
3. **Teste Real de Restauração:** O motor executa a decifragem do dump cifrado e realiza a restauração completa em uma instância descartável do PGlite, validando por queries de contagem (`SELECT count(*)`) que todos os registros são recuperáveis antes de confirmar o sucesso.
4. **Automação Periódica Nativa do macOS:** Foi gerada a especificação de serviço nativo do sistema (`LaunchAgent`), localizada em [`docs/modernizacao/br.com.medicina2029.production-backup.plist`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/br.com.medicina2029.production-backup.plist), permitindo agendamento diário automático às 03:00 com registro de logs e retenção controlada de 14 dias sem custo financeiro.

---

## 5. PARECER FINAL E STATUS DE IMPLANTAÇÃO

### **CLASSIFICAÇÃO: IMPLANTAÇÃO PARCIAL NÃO LIBERADA**

### Justificativa Técnica:
1. **Vercel Hobby:** Totalmente autenticada e validada no plano gratuito para o usuário `antunesbaa-7420`.
2. **Código e Build:** Compilação de produção e suítes de teste (160 Vitest + 18 Playwright) 100% aprovadas.
3. **Migrações e Seeds:** 11 migrações canônicas validadas com sucesso em banco PostgreSQL descartável, com correção definitiva do erro 42804 e seed dos 5 gêneros UECE.
4. **Backups:** Mecanismo de cifragem AES-256-GCM, teste de restauração descartável e automação periódica gerados a custo zero.
5. **Condições Pendentes para Publicação Real:**
   - Obtenção da autorização de acesso ao Supabase (ou fornecimento dos parâmetros de conexão do banco de produção).
   - Confirmação humana dos endereços de e-mail reais de Bruno e Alice.

O sistema não foi liberado para uso prematuro, garantindo que nenhum dado real seja exposto sem a infraestrutura de banco e os backups completamente provisionados.
