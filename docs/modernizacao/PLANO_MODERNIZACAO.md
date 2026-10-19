# Medicina 2029 — Plano de Modernização

**Origem:** Auditoria F1.01

**Princípio:** menor alteração segura possível; sem refatoração ampla sem necessidade

**Estado:** F1.02 concluída em 19/10/2026; demais tarefas aguardam autorização

## 1. Estratégia geral

O trabalho deve seguir a ordem **contenção → identidade/autorização → integridade → persistência → pipeline → qualidade**. Cada tarefa abaixo deve ser implementada em branch/commit independente, com testes próprios e reversão documentada.

Regras para todas as tarefas:

- preservar o comportamento funcional não relacionado;
- não executar migrations em produção sem backup validado e janela aprovada;
- não usar mocks de runtime como mecanismo de disponibilidade;
- não aceitar IDs de usuário enviados pelo cliente como identidade;
- não avançar para dados reais enquanto qualquer P0 aplicável permanecer aberto;
- registrar a evidência de teste e o risco residual ao concluir cada tarefa.

## 2. Sequência recomendada

```text
F1.02 Autorização imediata
   ├── F1.03 Identidade e ownership
   ├── F1.04 RLS e views
   └── F1.05 Isolamento do backup/restore
          ↓
F1.06 Dependências e segredos
          ↓
F1.07 Contratos de erro / remoção de falso sucesso
          ↓
F1.08 Atomicidade e idempotência
          ↓
F1.09 Validação e constraints
          ↓
F1.10 Storage e upload seguro
          ↓
F1.11 Fila durável do pipeline
          ↓
F1.12 IA, fontes e recuperação real
          ↓
F1.13 Estado server-side do ciclo/cronômetro
          ↓
F1.14 Backup completo e recuperação
          ↓
F1.15 Testes de segurança/E2E e operação
```

## 3. Tarefas propostas

### F1.02 — Guardas de autenticação e autorização nas Server Actions

**Status:** concluída em 19/10/2026.

- **Objetivo:** garantir que toda operação valide sessão e papel na própria action.
- **Arquivos potencialmente afetados:** novo helper server-only em `src/lib` ou `src/app`; todos os arquivos em `src/app/actions`; pages administrativas.
- **Dependências:** nenhuma; é a primeira contenção.
- **Riscos:** regressão por bloquear fluxos que hoje dependem de acesso implícito; circular import se o helper reutilizar `authOptions` incorretamente.
- **Estratégia:** criar `requireUser`/`requireRole`; negar por padrão; aplicar primeiro em backup, curadoria, acervo, responsável e reset de ciclo; depois nas demais actions.
- **Testes necessários:** chamada anônima, estudante e responsável para cada classe de action; tentativa direta sem visitar a página.
- **Critérios de aceite:** nenhuma action mutável executa sem sessão; operações administrativas negam estudante; `/lacunas` recebe proteção coerente; respostas não revelam detalhes.
- **Reversão:** reverter apenas o helper e suas chamadas; manter testes de segurança para demonstrar o risco reaberto.
- **Resultado:** 37/37 Server Actions com guarda server-side; papel revalidado no banco; operações administrativas e pessoais separadas; ownership aplicado aos recursos com proprietário disponível; 71/71 testes e build aprovados.
- **Riscos residuais:** RLS, restore destrutivo, hashes no backup, tabelas globais e ausência de vínculo responsável–estudante seguem para tarefas específicas.

### F1.03 — Identidade canônica e ownership

**Status:** parcialmente antecipada pela F1.02; saneamento histórico e decisões de schema permanecem pendentes.

- **Objetivo:** eliminar UUIDs hardcoded e a confusão entre `authUserId` e `perfis.id`.
- **Arquivos potencialmente afetados:** auth route, `src/db/schema.ts` apenas se necessário, actions de sessão/check-in/redação/simulado/FSRS/dashboard/responsável/curadoria/acervo e componentes que enviam `perfilId`.
- **Dependências:** F1.02.
- **Riscos:** dados históricos associados a identificadores incorretos; necessidade de saneamento antes de constraint adicional.
- **Estratégia:** resolver o perfil pelo identificador autenticado; retornar contexto `{perfilId,papel}`; remover `perfilId` dos inputs do cliente; adicionar ownership em todas as queries por ID.
- **Testes necessários:** integração com dois perfis reais; FK; usuário não lê/altera registro alheio; ausência de UUID fixo no runtime.
- **Critérios de aceite:** inserts usam `perfis.id` existente; nenhum módulo de runtime contém IDs de perfil fixos; queries sensíveis têm filtro de ownership.
- **Reversão:** feature flag temporária somente em ambiente de teste e rollback do commit; não restaurar IDs hardcoded em produção.

### F1.04 — RLS e views agregadas versionadas

- **Objetivo:** tornar a separação estudante/responsável verificável no banco.
- **Arquivos potencialmente afetados:** novas migrations Drizzle, schema de views/tipos, actions de responsável.
- **Dependências:** F1.02 e definição da identidade da F1.03; auditoria read-only do Supabase externo aprovada.
- **Riscos:** lockout total por policy incorreta; conexão owner/service role pode contornar RLS; divergência com policies manuais externas.
- **Estratégia:** inventariar policies externas; criar migrations idempotentes; habilitar RLS tabela a tabela; views agregadas quinzenais/trimestrais; role de mínimo privilégio; testar em banco descartável.
- **Testes necessários:** estudante só lê próprios dados e conteúdo aprovado; responsável não lê `sessoes` bruta; anônimo não lê tabela; action não usa role que bypassa RLS.
- **Critérios de aceite:** policies versionadas para todas as tabelas aplicáveis; matriz de acesso automatizada passa; rollback ensaiado.
- **Reversão:** migration de rollback testada em banco descartável; nunca desabilitar RLS em produção sem janela e contenção compensatória.

### F1.05 — Isolamento imediato do backup/restore

- **Objetivo:** impedir exfiltração, elevação e destruição por chamadas normais da aplicação.
- **Arquivos potencialmente afetados:** `src/app/actions/backup.ts`, `src/components/ResponsavelPage.tsx`, guards/auditoria.
- **Dependências:** F1.02; F1.03 para identidade.
- **Riscos:** indisponibilizar temporariamente restore pela UI; manter falso senso de segurança se apenas esconder o botão.
- **Estratégia:** desabilitar restore interativo até redesenho; exigir responsável + reautenticação; remover `passwordHash` do export; validar versão/tamanho antes de qualquer mutação; audit log.
- **Testes necessários:** anônimo/estudante negados; export não contém hashes; JSON inválido não inicia transação; restore exige modo operacional.
- **Critérios de aceite:** nenhuma rota/action normal apaga base; dados de autenticação não saem no arquivo; tentativa inválida é side-effect free.
- **Reversão:** reativar somente versão anterior em ambiente isolado; nunca reexpor restore inseguro em produção.

### F1.06 — Atualização de dependências críticas e separação de segredos

- **Objetivo:** remover vulnerabilidades críticas de runtime e impedir chave cruzada entre provedores.
- **Arquivos potencialmente afetados:** `package.json`, lockfile, `src/lib/gemini.ts`, documentação/env example futura.
- **Dependências:** pode ocorrer em paralelo com F1.03/F1.04, mas exige suíte mínima verde.
- **Riscos:** regressão de framework; mudança de comportamento do Turbopack/middleware; rotação de segredo necessária.
- **Estratégia:** upgrade patch isolado do Next.js para versão corrigida vigente; atualizar transitivas compatíveis; usar somente chave Gemini no endpoint Gemini; adicionar validação de env no startup.
- **Testes necessários:** TypeScript, lint baseline, build, smoke de todas as rotas, login, actions críticas e `npm audit`.
- **Critérios de aceite:** zero vulnerabilidade crítica conhecida no audit; nenhuma chave de outro provedor pode alcançar o endpoint; build e login funcionam.
- **Reversão:** rollback do lock/package em commit único; se segredo tiver sido exposto, rotação não é revertida.

### F1.07 — Contratos explícitos de erro e remoção de falso sucesso

- **Objetivo:** impedir que falhas de persistência sejam apresentadas como sucesso.
- **Arquivos potencialmente afetados:** `sessao.ts`, `checkin.ts`, `ciclo.ts`, `dashboard.ts`, `redacoes.ts`, `lacunas.ts`, `responsavel.ts`, componentes consumidores.
- **Dependências:** F1.03.
- **Riscos:** a UI passará a exibir erros antes ocultos; aumento aparente de falhas até a infraestrutura ser corrigida.
- **Estratégia:** retorno discriminado `{ok,data}`/`{ok:false,code}`; remover mocks de catches; diferenciar vazio de indisponível; retry explícito; correlation ID; mocks somente via adaptador de demo/teste.
- **Testes necessários:** falha de DB, timeout e zero linhas; UI não avança ponteiro nem marca check-in; logs sem segredos.
- **Critérios de aceite:** nenhuma action retorna sucesso quando não persistiu; dashboard nunca troca erro por dado plausível; usuário recebe ação de retry.
- **Reversão:** reverter por módulo; não reintroduzir mocks silenciosos, usar estado de manutenção explícito.

### F1.08 — Atomicidade, idempotência e concorrência

- **Objetivo:** tornar operações multi-etapa consistentes.
- **Arquivos potencialmente afetados:** `sessao.ts`, `fsrs.ts`, `simulados.ts`, `curadoria.ts`, `reestudo.ts`; schema/migrations de chaves idempotentes.
- **Dependências:** F1.03 e F1.07.
- **Riscos:** locks/deadlocks; repetição de requests antigos; rollback de efeitos externos ao DB.
- **Estratégia:** transação por caso de uso; ordem correta de operações; idempotency key para conclusão/revisão/upload; locking otimista ou row lock no ponteiro; ações externas antes/depois com outbox.
- **Testes necessários:** falha em cada etapa, retry, duplo clique, duas abas, concorrência no ponteiro, rollback do log FSRS.
- **Critérios de aceite:** ou todo o caso de uso persiste ou nada persiste; retry não duplica; ponteiro avança uma vez.
- **Reversão:** rollback dos commits por fluxo; constraints novas exigem migration reversível ensaiada.

### F1.09 — Validação runtime e integridade relacional

- **Objetivo:** validar todo input não confiável e reforçar regras no banco.
- **Arquivos potencialmente afetados:** actions, schema compartilhado de validação, `src/db/schema.ts`, novas migrations.
- **Dependências:** F1.03; recomendado após F1.08 para conhecer as transações.
- **Riscos:** dados legados inválidos impedirem constraints; compatibilidade de formulários.
- **Estratégia:** schemas pequenos por action; limites de texto/arrays/números/datas; checks de humor/energia/série/incidência/acertos; FKs ausentes; uniques/PKs em associações; saneamento prévio somente após auditoria autorizada.
- **Testes necessários:** valores de borda, payload enorme, divisão por zero, datas inválidas, associação duplicada e órfãos.
- **Critérios de aceite:** entrada inválida é rejeitada antes do DB; banco impede estados impossíveis; erros públicos são estáveis.
- **Reversão:** remover constraints apenas por migration de rollback; validadores podem ser revertidos por módulo.

### F1.10 — Upload e Storage confiáveis

- **Objetivo:** garantir que sucesso signifique arquivo privado realmente persistido e validado.
- **Arquivos potencialmente afetados:** `acervo.ts`, `supabaseStorage.ts`, `AcervoPage.tsx`, configuração de Storage e testes.
- **Dependências:** F1.02, F1.03, F1.07 e auditoria das policies externas.
- **Riscos:** custo de upload; arquivos grandes; compatibilidade serverless; mudanças de policy bloquearem acesso.
- **Estratégia:** upload presigned/streaming; key aleatória; `upsert:false`; limite server-side; magic bytes; metadados depois da confirmação; bucket privado; URLs curtas; reconciliação objeto↔registro.
- **Testes necessários:** arquivo válido, não-PDF, oversized, corrompido, duplicado, falha Storage, race e URL expirada.
- **Critérios de aceite:** sem objeto não há status de sucesso; nenhum arquivo é público; hash/tamanho conferem; falha é recuperável.
- **Reversão:** manter leitor compatível com keys antigas; rollback de policy ensaiado antes da aplicação.

### F1.11 — Fila durável e pipeline retomável

- **Objetivo:** retirar processamento longo das requisições e tornar cada etapa idempotente.
- **Arquivos potencialmente afetados:** `acervo.ts`, `curadoria.ts`, novo worker/pg-boss, tabelas de job/gerações e configuração de deploy.
- **Dependências:** F1.10; F1.08.
- **Riscos:** duplicidade de jobs; worker indisponível; aumento de complexidade operacional.
- **Estratégia:** publicar job após commit do arquivo; worker separado; estados por etapa; retry/backoff; heartbeat; dead-letter; custo/duração; reprocessar sem apagar versão aprovada.
- **Testes necessários:** worker morto, retry, job duplicado, retomada, falha por etapa e concorrência.
- **Critérios de aceite:** request retorna após enfileirar; fechamento do processo não perde job; falha é visível e reprocessável.
- **Reversão:** pausar consumidores e voltar temporariamente a processamento manual explícito, nunca Promise solta.

### F1.12 — IA, proveniência, OCR e busca reais

- **Objetivo:** eliminar conteúdo/embeddings/OCR simulados no runtime e cumprir o portão de fonte.
- **Arquivos potencialmente afetados:** `gemini.ts`, `ingestion.ts`, `curadoria.ts`, schema de gerações/chunks, migrations de índices.
- **Dependências:** F1.11 e F1.09.
- **Riscos:** custo de API, mudança de ranking, reindexação, conteúdo legado sem fonte.
- **Estratégia:** falhar fechado sem provedor; resposta validada por schema; `fonteChunkIds` obrigatório; embeddings reais versionados; HNSW + `tsvector` pt; OCR real e visão abaixo do limiar; bloquear publicação sem fonte.
- **Testes necessários:** provider ausente, JSON inválido, prompt injection no documento, item sem fonte, relevância conhecida, página correta e OCR de amostra.
- **Critérios de aceite:** nenhum mock entra em produção; todo item publicado aponta para chunks/páginas; busca híbrida supera baseline definido.
- **Reversão:** manter índice anterior até validação; feature flag para desligar geração, não para publicar conteúdo simulado.

### F1.13 — Estado server-side do ciclo e cronômetro

- **Objetivo:** estabelecer uma única fonte de verdade e sincronização entre dispositivos.
- **Arquivos potencialmente afetados:** `CronometroPage.tsx`, `CicloPage.tsx`, `HojePage.tsx`, `sessao.ts`, `ciclo.ts`, possivelmente schema/migration de versão/checkpoint.
- **Dependências:** F1.03, F1.07 e F1.08.
- **Riscos:** sessões locais antigas; conflitos multiaba; carga de heartbeat.
- **Estratégia:** versão de sessão/checkpoint no servidor; persistência periódica e em eventos; localStorage como cache com user/session/version/TTL; reconciliação; BroadcastChannel opcional para abas.
- **Testes necessários:** refresh, offline curto, troca de dispositivo, duas abas, clock drift, limpeza do storage e retomada.
- **Critérios de aceite:** ponteiro e tempo convergem ao servidor; limpar navegador não perde progresso persistido; avanço ocorre uma vez.
- **Reversão:** manter leitura temporária do formato local antigo para migração; não voltar a torná-lo autoridade.

### F1.14 — Backup completo e recuperação testada

- **Objetivo:** oferecer recuperação real, incluindo acervo, sem expor segredos.
- **Arquivos potencialmente afetados:** novo módulo operacional de backup, Storage, schema de manifesto, documentação/runbook; substituição de `backup.ts`.
- **Dependências:** F1.05, F1.10 e F1.11.
- **Riscos:** custo/tempo, retenção de dados sensíveis, backup incompleto, restore destrutivo.
- **Estratégia:** manifesto versionado de todas as tabelas e objetos; hashes; criptografia autenticada; snapshot consistente; restore em base temporária; validação e promoção; agendamento semanal e retenção.
- **Testes necessários:** round-trip integral, arquivos, relações, corrupção de arquivo, versão incompatível, restore interrompido e recuperação.
- **Critérios de aceite:** amostra completa restaura com contagens/constraints/hashes iguais; credenciais não são exportadas; RTO/RPO documentados.
- **Reversão:** backups são append-only; nova versão não invalida a anterior; promoção só após validação.

### F1.15 — Testes de segurança, E2E e operação

- **Objetivo:** transformar as garantias anteriores em gates automatizados.
- **Arquivos potencialmente afetados:** testes Vitest/Playwright, configs, CI, README/runbooks; sem mudança funcional por si só.
- **Dependências:** todas as tarefas anteriores conforme o fluxo testado.
- **Riscos:** testes frágeis; E2E alterar dados compartilhados; tempo de pipeline.
- **Estratégia:** banco descartável por execução; fixtures sem credenciais fixas; E2E real desktop/mobile; threshold de cobertura para regras críticas; CI com TypeScript, lint, unitário, integração, E2E, build e audit.
- **Testes necessários:** os próprios gates, incluindo matriz de papéis, RLS, login, sessão+erro+ponteiro, FSRS conhecido, upload/job, curadoria, simulado pendente e backup round-trip.
- **Critérios de aceite:** nenhum placeholder; pipeline reproduzível; falha bloqueia merge; documentação contém setup/env/deploy/backup/pipeline sem segredos.
- **Reversão:** desabilitar temporariamente apenas teste comprovadamente flakey com issue e prazo; nunca remover gate de segurança sem substituto.

## 4. Backlog posterior à estabilização

Estas tarefas não devem competir com os P0/P1:

- completar PWA/offline com estratégia segura de cache;
- implementar telas M1–M19 ainda ausentes;
- adotar componentes/gráficos/editor/matemática quando o módulo exigir;
- eliminar `any`, reduzir warnings e estabelecer lint zero;
- explicitar timezone UTC/Fortaleza;
- adicionar headers defensivos no ponto de deploy confirmado;
- documentar rollbacks de migrations e operação individual.

## 5. Gates para uso com dados reais

O sistema só deve receber dados reais quando todos os itens abaixo estiverem comprovados:

- Server Actions autenticadas/autorizadas e com ownership;
- RLS/policies verificadas no ambiente alvo;
- identidade canônica sem UUIDs hardcoded;
- nenhuma resposta de sucesso sem persistência;
- operações críticas atômicas/idempotentes;
- versão crítica do Next.js atualizada;
- upload privado validado e recuperável;
- backup/restore round-trip aprovado;
- E2E reais de login, sessão e papéis passando;
- segredos rotacionados caso haja indício de uso cruzado ou credencial demo reutilizada.

## 6. Próxima tarefa

**Recomendação: F1.03 — Consolidação da identidade canônica e do ownership.**

Escopo inicial recomendado: auditar dados históricos somente em cópia isolada; decidir a relação responsável–estudante e o ownership das tabelas globais; preparar migration e rollback sem aplicação em produção; adicionar integração com dois perfis em banco descartável.

Não iniciar automaticamente. Aguardar aprovação explícita.
