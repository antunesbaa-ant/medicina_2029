# Relatório Técnico — Tarefa F1.06: Atualização de Dependências Críticas, Segurança de Segredos e Separação de Conexões
## Mitigação de Vulnerabilidades no Next.js, Eliminação de Fallbacks Hardcoded, Validação Centralizada de Ambiente e Isolamento de Provedores

**Data:** 19/10/2026  
**Papel:** Lead Security & Modernization Orchestrator / Subagentes Especialistas  
**Status da Tarefa:** **CONCLUÍDA — APROVADA (100% dos testes aprovados, build Turbopack bem-sucedido, quality gates cumpridos)**  
**Arquivos de Persistência e Implementação:**  
- Atualização de Dependências: [`package.json`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/package.json) e [`package-lock.json`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/package-lock.json)  
- Validação Centralizada de Ambiente: [`src/lib/env.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/env.ts)  
- Teste Unitário da Validação de Ambiente: [`src/lib/env.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/env.test.ts)  
- Serviço de IA com Segregação Rigorosa: [`src/lib/gemini.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/gemini.ts)  
- Teste Unitário do Provedor de IA: [`src/lib/gemini.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/gemini.test.ts)  
- Conexões Segregadas do Banco de Dados: [`src/db/index.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/index.ts)  
- Autenticação com Conexão Dedicada: [`src/lib/auth-options.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/auth-options.ts)  
- Armazenamento com Lazy Loading Seguro: [`src/lib/supabaseStorage.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/supabaseStorage.ts)  
- Arquivo de Exemplo Documentado: [`.env.example`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/.env.example)  
- Plano de Modernização Atualizado: [`docs/modernizacao/PLANO_MODERNIZACAO.md`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/PLANO_MODERNIZACAO.md)  

---

## 1. Resumo Executivo da Tarefa F1.06

A tarefa **F1.06** abordou dois eixos críticos de confiabilidade e segurança do projeto Medicina 2029: a auditoria e atualização de dependências de runtime vulneráveis e a eliminação de fragilidades no manuseio de credenciais, conexões de banco de dados e segregação de serviços externos.

### Principais Conquistas Técnicas:
1. **Atualização Segura do Next.js (16.2.12 → 16.4.2):**
   - Removida a vulnerabilidade crítica de execução remota de código (RCE) não-autenticada no Next.js (GHSA-p293-qw3h-jr36).
   - Eliminadas vulnerabilidades de SSRF em Image Optimization e envenenamento de cache.
   - Preservada 100% de compatibilidade com React 19.2.4, NextAuth 4.24.15 e Drizzle 0.45.2.
   - Turbopack compilou com sucesso todas as 17 rotas da aplicação em 530ms.
2. **Mitigação de Vulnerabilidades Transitivas (`npm audit`):**
   - Vulnerabilidades totais reduzidas de 18 para 9.
   - **0 vulnerabilidades críticas** remanescentes.
   - **0 vulnerabilidades de runtime em produção.**
   - As 9 remanescentes são restritas a ferramentas de desenvolvimento/build em tempo de compilação (`drizzle-kit` esbuild e `eslint-config-next` braces).
3. **Eliminação de Fallbacks Inseguros Hardcoded:**  
   Em `src/lib/supabaseStorage.ts`, existia uma URL real de projeto Supabase hardcoded (`https://ewruxhmcqznraszvbfes.supabase.co`). Em `src/db/index.ts`, existia uma connection string com senha hardcoded (`postgresql://postgres:postgres@localhost:54322/postgres`). Ambos os fallbacks foram sumariamente eliminados, substituídos por validações defensivas e conexões parametrizadas.
4. **Separação Rigorosa dos Provedores de Inteligência Artificial:**  
   Em `src/lib/gemini.ts`, a linha `process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY` permitia o reuso indevido de chaves da Anthropic no endpoint da Google. Foi imposta a segregação absoluta: o Gemini consome unicamente `GEMINI_API_KEY`, rejeitando ativamente chaves de outros provedores. Além disso, a credencial deixou de ser transmitida na query string da URL (onde ficava exposta a logs de proxy e servidores) e passou a trafegar exclusivamente via cabeçalho HTTP `x-goog-api-key`.
5. **Segregação das Conexões PostgreSQL (`medicina_auth` vs `medicina_app`):**  
   Alinhado à arquitetura de privilégios mínimos validada na F1.04-C, `src/db/index.ts` passou a suportar `DATABASE_AUTH_URL` (para NextAuth com papel `medicina_auth`) e `DATABASE_APP_URL` (para as Server Actions cotidianas sob `medicina_app`), mantendo `DATABASE_URL` como fallback seguro em transição e desenvolvimento.
6. **Camada Centralizada de Validação de Ambiente (`src/lib/env.ts`):**  
   Implementação de rotina centralizada de auditoria de variáveis de ambiente. Em produção, impõe entropia mínima para `NEXTAUTH_SECRET` (mínimo 32 caracteres), proíbe segredos padrão fracos, exige HTTPS em `NEXTAUTH_URL`, rejeita URLs de banco apontando para localhost/127.0.0.1 e barra o uso de chaves cruzadas. Em ambiente de testes (`NODE_ENV === 'test'`), assegura permissividade controlada sem quebrar a suíte Vitest.
7. **Criação do Modelo Oficial `.env.example`:**  
   Documentação exaustiva de todas as variáveis de ambiente necessárias para o ecossistema da aplicação, com placeholders fictícios seguros e orientações de boas práticas.

---

## 2. Auditoria e Endurecimento Técnico

### 2.1 Armazenamento Supabase Storage (`src/lib/supabaseStorage.ts`)
- **Problema Anterior:** Inicialização estática no carregamento do módulo apontando para `https://ewruxhmcqznraszvbfes.supabase.co` e chave anônima vazia `''`.
- **Solução Implementada:**
  - Remoção de qualquer URL real em código.
  - Função `getSupabaseClient()` com verificação obrigatória de `SUPABASE_URL` e `SUPABASE_ANON_KEY`. Caso ausentes, lança erro explícito orientando a configuração.
  - Proxy defensivo `export const supabase` para permitir resolução sob demanda (lazy initialization) sem quebrar importações em tempo de compilação ou suítes de teste.
  - Sanitização de mensagens de log no `uploadToSupabaseStorage` e `obterUrlAssinadaSupabase`, logando apenas `error.message` sem despejar objetos brutos que possam conter cabeçalhos HTTP.

### 2.2 Provedor de IA Google Gemini (`src/lib/gemini.ts`)
- **Problema Anterior:** `const apiKey = process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY;` e envio na URL via `?key=${apiKey}`.
- **Solução Implementada:**
  - Aceitação exclusiva de `process.env.GEMINI_API_KEY`.
  - Detecção ativa e emissão de warning defensivo caso `ANTHROPIC_API_KEY` seja detectada no ambiente sem `GEMINI_API_KEY`, bloqueando a chamada.
  - Envio da chave de API via cabeçalho HTTP padrão `x-goog-api-key: apiKey`.
  - Tratamento de exceções e erros de rede com mensagens genéricas em `console.warn`, assegurando que em nenhum cenário a chave seja impressa nos logs.
  - Fallback determinístico inteligente preservado para desenvolvimento e testes offline.

### 2.3 Conexões Segregadas PostgreSQL (`src/db/index.ts` e `src/lib/auth-options.ts`)
- **Problema Anterior:** Única connection string global com fallback hardcoded contendo credencial de desenvolvimento (`localhost:54322`).
- **Solução Implementada:**
  - `resolveDatabaseAppUrl()`: resolve `DATABASE_APP_URL` com fallback para `DATABASE_URL`. Em produção, caso ambas faltem, lança erro de configuração.
  - `resolveDatabaseAuthUrl()`: resolve `DATABASE_AUTH_URL` com fallback para `DATABASE_URL`.
  - Exportação de instâncias segregadas:
    - `client` e `db`: para Server Actions e consultas da aplicação (papel `medicina_app`).
    - `authClient` e `authDb`: para a rota NextAuth (papel `medicina_auth`).
  - Atualização de `src/lib/auth-options.ts` para canalizar a autenticação via `authDb`, respeitando a segregação de roles de banco da F1.04-C.

### 2.4 Camada de Validação de Ambiente (`src/lib/env.ts`)
- **Regras Estritas em Produção (`NODE_ENV === 'production'`):**
  - `NEXTAUTH_SECRET`: obrigatório, mínimo 32 caracteres, proibição de lista negra de segredos fracos (`secret`, `password`, `change-me`, etc.).
  - `NEXTAUTH_URL`: obrigatório iniciar com `https://`.
  - `DATABASE_URL` / `DATABASE_APP_URL`: obrigatório e proibição de `localhost` / `127.0.0.1` (exceto com flag `ALLOW_LOCALHOST_IN_PRODUCTION=true`).
  - Provedor de IA: proibição de `ANTHROPIC_API_KEY` sem `GEMINI_API_KEY`.
- **Regras em Desenvolvimento (`NODE_ENV === 'development'`):**
  - Emite `warnings` informativos no console sem abortar o processo, permitindo setup progressivo.
- **Regras em Teste (`NODE_ENV === 'test'`):**
  - Não exige segredos de produção nem conectividade externa, viabilizando execução mockada e rápida da suíte Vitest.

---

## 3. Cobertura de Testes Automatizados

A tarefa adicionou duas novas suítes de testes unitários dedicadas, elevando a cobertura do projeto de 123 para 140 testes:

### 3.1 Testes de Segurança de IA ([`src/lib/gemini.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/gemini.test.ts))
1. **Fallback sem chave:** Executa gerador determinístico inteligente sem quebra e sem erros.
2. **Rejeição de chave Anthropic:** Comprova que `ANTHROPIC_API_KEY` não é chamada no fetch e que log de alerta não expõe a chave.
3. **Cabeçalho seguro:** Comprova que `GEMINI_API_KEY` é enviada no cabeçalho `x-goog-api-key` e nunca na URL.
4. **Sem vazamento em erro HTTP (401/500):** Comprova que respostas de erro não expõem a chave nos logs.
5. **Sem vazamento em exceção de rede:** Comprova que timeouts e erros de conexão tratam a falha de forma sanitizada.

### 3.2 Testes de Validação de Ambiente ([`src/lib/env.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/lib/env.test.ts))
1. **Aprovação de ambiente completo em produção:** Sucesso com todas as variáveis válidas.
2. **Rejeição de secret curto (< 32 caracteres):** Falha com mensagem de entropia mínima.
3. **Rejeição de secret ausente em produção:** Falha por ausência obrigatória.
4. **Rejeição de segredos padrão inseguros:** Bloqueio de valores de dicionário fraco.
5. **Rejeição de localhost em produção:** Bloqueio de URLs locais em ambiente produtivo.
6. **Bypass controlado de localhost em produção:** Permissão explícita via `ALLOW_LOCALHOST_IN_PRODUCTION=true`.
7. **Rejeição de NEXTAUTH_URL sem HTTPS em produção:** Exigência estrita de TLS.
8. **Rejeição de chave cruzada de IA:** Bloqueio de `ANTHROPIC_API_KEY` isolada.
9. **Avisos em desenvolvimento:** Verificação de alertas não-bloqueantes.
10. **Permissividade em teste:** Execução limpa sob `NODE_ENV === 'test'`.
11. **Comportamento de `getValidatedEnv`:** Lançamento de exceção em produção inválida e retorno em produção válida.
12. **Helpers de ambiente (`isProduction`, `isTest`, `isDevelopment`):** Verificação lógica precisa.

---

## 4. Quality Gates

```bash
# 1. Typecheck estrito TypeScript
npx tsc --noEmit
# Resultado: 0 erros

# 2. Suíte de testes unitários Vitest
npm run test:run
# Resultado: 19 test files, 140/140 testes aprovados (+17 novos testes)

# 3. Integridade do schema Drizzle
npx drizzle-kit check
# Resultado: Everything's fine

# 4. Formatação e espaços em branco Git
git diff --check
# Resultado: 0 violações
```

---

## 5. Conclusão e Recomendação para a Próxima Tarefa

A tarefa **F1.06** está integralmente concluída e aprovada. Todas as brechas de vazamento de segredos, reuso cruzado de provedores e fallbacks inseguros foram sanadas.

O próximo passo obrigatório na trilha de modernização é a **Tarefa F1.07 — Contratos explícitos de erro e remoção de falso sucesso**, garantindo que as Server Actions retornem estruturas discriminadas `{ok: true, data}` ou `{ok: false, code}` e eliminem capturas silenciosas de erros de banco.
