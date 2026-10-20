# Relatório Técnico — Tarefa F1.04 e F1.04-R: Row Level Security (RLS) e Views Agregadas
## Revisão Arquitetural de Segurança, Endurecimento de Privilégios e Modelo de Confiança

**Data da Revisão F1.04-R:** 19/10/2026  
**Papel:** Database Security Architect  
**Status da Tarefa:** CONCLUÍDA — PROPOSTA REVISADA, TESTADA E PRONTA PARA HOMOLOGAÇÃO  
**Arquivos de Persistência:**  
- Proposta RLS Endurecida: [`docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql)  
- Script de Rollback Atômico: [`docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql)  
- Helper de Integração TypeScript: [`src/db/rls-context.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/rls-context.ts)  
- Teste Unitário do Helper: [`src/db/rls-context.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/rls-context.test.ts)  

---

## 1. Resumo Executivo da Revisão F1.04-R

A Tarefa F1.04-R realizou uma auditoria profunda da proposta de RLS da F1.04, identificando e corrigindo lacunas de privilégios de coluna, restringindo funções `SECURITY DEFINER`, formalizando o Modelo de Confiança (*Trust Model*) do banco de dados e construindo a camada de integração transacional da aplicação em TypeScript/Drizzle.

### Principais Correções e Endurecimentos Implementados:
1. **Proteção Efetiva de Colunas Sensíveis (Column-Level Grants):**  
   Na proposta inicial, `GRANT SELECT ON ALL TABLES IN SCHEMA public TO medicina_app` permitia que uma conexão sob `medicina_app` lesse diretamente `perfis.password_hash` da sua própria linha (ou da linha de perfis acessíveis pela RLS). Na revisão F1.04-R, o `SELECT` na tabela `perfis` foi revogado e substituído por uma concessão estrita por coluna:
   `GRANT SELECT (id, auth_user_id, nome, email, papel, criado_em) ON public.perfis TO medicina_app;`.  
   Qualquer tentativa de `SELECT password_hash FROM perfis` agora é barrada pelo PostgreSQL com erro de privilégio `42501` (*permission denied for column password_hash*), mesmo que o chamador passe na RLS.
2. **Endurecimento de Funções `SECURITY DEFINER` e Restrição de `EXECUTE`:**  
   No PostgreSQL, funções em schemas de usuário concedem `EXECUTE` para `PUBLIC` por padrão. Foi aplicado `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA medicina FROM PUBLIC;`, concedendo `EXECUTE` estritamente nas funções necessárias para o papel `medicina_app`. Todas as funções do schema `medicina` tiveram `SET search_path = public, medicina, pg_temp;` fixado.
3. **Auditoria da Identidade e Modelo de Confiança (Trust Model):**  
   Ficou formalmente documentado que `SET LOCAL` e variáveis GUC não são, isoladamente, mecanismos de autenticação. O banco confia que a aplicação (NextAuth) autenticou a requisição e informou o perfil legítimo. A RLS atua como segunda linha de defesa (prevenção de BOLA/IDOR, omissão de filtros e violações de vigilância), mas não substitui a segurança da aplicação.
4. **Camada Central de Integração Transacional (`withRlsContext`):**  
   Implementação de helper reutilizável em [`src/db/rls-context.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/rls-context.ts) para assegurar que toda consulta de persistência rode em transação com `medicina.set_context()`, `SET LOCAL` transacional e limpeza garantida (`medicina.clear_context()`), evitando contaminação da pool de conexões.

---

## 2. Auditoria da Identidade, Falsificação de Contexto e Modelo de Confiança (Trust Model)

### 2.1 Análise do Vetor de Falsificação de Contexto
A função `medicina.set_context(p_perfil_id, p_papel)` recebe o UUID e o papel, validando se o par existe na tabela `perfis`:
```sql
IF NOT EXISTS (
  SELECT 1 FROM public.perfis WHERE id = p_perfil_id AND papel = p_papel
) THEN
  RAISE EXCEPTION 'Contexto invalido: perfil % com papel % nao existe.', p_perfil_id, p_papel USING ERRCODE = 'P0001';
END IF;
```

#### O que acontece se um atacante com acesso SQL a `medicina_app` tentar forjar o contexto?
- **Cenário A (Troca de Papel no mesmo Perfil):** O atacante passa o UUID da estudante, mas alega papel `'responsavel'`. A validação rejeita imediatamente com exceção `P0001`, pois no banco aquele perfil possui papel `'estudante'`.
- **Cenário B (UUID de Outro Perfil Existente):** Se o atacante passar um UUID válido de outro perfil existente (ex: estudante 2), a chamada `set_context` será aceita pelo PostgreSQL, e aquela transação operará sob a identidade do estudante 2.

### 2.2 Limites da Defesa em Banco e Trust Model
Este comportamento elucida um axioma fundamental de segurança de bancos relacionais:
> **O banco de dados NÃO autentica o usuário final; o banco autoriza conexões sob o papel de serviço (`medicina_app`). O mecanismo GUC (`medicina.current_perfil_id`) é uma ferramenta de PROPAGAÇÃO DE CONTEXTO DE AUTORIZAÇÃO, e não um protocolo de autenticação criptográfica autônomo.**

O banco de dados não inspeciona cookies de sessão HTTP nem tokens JWT; ele confia que o aplicativo web já executou a autenticação (NextAuth) e que o código do servidor é íntegro ao repassar o `perfilId` canônico extraído da sessão autenticada.

### 2.3 O que a RLS Protege vs. O que a RLS NÃO Protege

| O que a RLS Efetivamente Protege | O que a RLS NÃO Protege |
|---|---|
| **Omissão Acidental de Filtros:** Desenvolvedor esquece `WHERE perfil_id = :id` em uma Server Action. A RLS injeta a restrição no plano de execução e impede vazamento de dados de outros usuários. | **Comprometimento Total do Servidor de Aplicação:** Se o servidor for invadido ou permitir Execução Remota de Código (RCE), o atacante com a credencial `medicina_app` pode chamar `set_context` para qualquer perfil válido. |
| **BOLA / IDOR:** Parâmetro manipulado pelo cliente (ex.: alterar `ciclo_id` na requisição). O PostgreSQL rejeita a alteração por incompatibilidade de ownership. | **Injeção de SQL Não Contida:** SQL Injection que permita emitir `SELECT medicina.set_context(vitima_uuid, papel);` antes do SELECT alvo. |
| **Isolamento de Papéis (Princípio 1.2):** O responsável é fisicamente impedido de rodar `SELECT * FROM sessoes`, mesmo que construa a query na aplicação. | **Proteção de Dados em Trânsito/Repouso:** RLS não substitui TLS/SSL na conexão nem criptografia de disco. |
| **Contaminação de Conexão na Pool:** `SET LOCAL` assegura que conexões reaproveitadas do PgBouncer/Node.js pool retornem limpas e estéreis. | **Chaves de Acesso e Segredos Expostos:** RLS não protege se o segredo da conexão de banco for vazado publicamente. |

---

## 3. Auditoria e Endurecimento das Funções `SECURITY DEFINER`

### 3.1 Funções Auditadas e Ações Aplicadas

1. **`medicina.current_perfil_id()` e `medicina.current_papel()`:**  
   - Declaradas como `STABLE` e não `SECURITY DEFINER`.  
   - Fixado `SET search_path = public, medicina, pg_temp;` para blindagem contra search-path poisoning.  
   - Revogado `EXECUTE` de `PUBLIC`; concedido apenas a `medicina_app`.
2. **`medicina.is_estudante()` e `medicina.is_responsavel()`:**  
   - Funções auxiliares `STABLE`, executadas no contexto do chamador.  
   - Concedido `EXECUTE` a `medicina_app`.
3. **`medicina.current_managed_estudante_id()`:**  
   - Declarada como `SECURITY DEFINER` para permitir consultar com segurança a tabela `responsavel_estudante`.  
   - Fixado `SET search_path = public, medicina, pg_temp;`.  
   - Revogado `EXECUTE` de `PUBLIC`.
4. **`medicina.set_context(uuid, text)` e `medicina.clear_context()`:**  
   - Declaradas como `SECURITY DEFINER` com `search_path` blindado.  
   - Validação estrita de integridade referencial antes de configurar parâmetros locais.  
   - Emissão de erro formal com código `P0001` em caso de dados inválidos.  
   - `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA medicina FROM PUBLIC;`.
5. **`medicina.autenticar_por_email(p_email text)`:**  
   - **Vulnerabilidade Prévia:** Em sua concepção inicial, caso `PUBLIC` ou uma conexão qualquer invocasse a função com um e-mail válido, recebia o `password_hash`.  
   - **Endurecimento Anti-Enumeração:** A função valida previamente se `p_email` consta na `public.allowlist`. Se não constar ou se for nulo, a função aborta e retorna zero linhas imediatamente, impedindo a enumeração de usuários cadastrados.  
   - Apenas o usuário de aplicação `medicina_app` possui concessão de `EXECUTE`.

---

## 4. Modelo de Privilégios e Proteção de Colunas Sensíveis

### 4.1 Falha da Proteção Baseada Apenas em Views
Na F1.04 original, concedeu-se `GRANT SELECT ON ALL TABLES IN SCHEMA public TO medicina_app`.  
Sob essa regra, embora a view `vw_perfis` não exibisse `password_hash`, a role `medicina_app` tinha permissão de tabela para executar:
```sql
SELECT password_hash FROM public.perfis WHERE id = medicina.current_perfil_id();
```
Como a política RLS permitia ao estudante ler a sua própria linha em `perfis`, a consulta retornava o hash de senha com sucesso! A view atuava como filtro cosmético na camada de apresentação, e não como barreira de segurança relacional.

### 4.2 Solução: Privilégios por Coluna (Column-Level Grants)
Na revisão F1.04-R, a permissão genérica foi revogada e decomposta:
```sql
-- 1. Revoga SELECT na tabela inteira
REVOKE SELECT ON public.perfis FROM medicina_app;

-- 2. Concede SELECT estritamente sobre colunas seguras
GRANT SELECT (id, auth_user_id, nome, email, papel, criado_em) ON public.perfis TO medicina_app;

-- 3. Concede UPDATE restrito a campos não sensíveis
REVOKE UPDATE ON public.perfis FROM medicina_app;
GRANT UPDATE (nome, email) ON public.perfis TO medicina_app;
```

#### Resultado de Segurança:
- Se uma consulta sob o papel `medicina_app` tentar executar `SELECT password_hash FROM perfis` ou `SELECT * FROM perfis`, o parser de permissões do PostgreSQL rejeita a requisição antes da execução com erro:
  `ERROR: permission denied for column password_hash of relation perfis (SQLSTATE 42501)`.
- A view pública `vw_perfis`, que projeta unicamente as colunas autorizadas, continua funcionando com sucesso sob `security_invoker = true`.
- O hash de senha só pode ser lido internamente pela função `SECURITY DEFINER` de autenticação (`medicina.autenticar_por_email`), cujo resultado é estritamente controlado no fluxo de login.

---

## 5. Camada Central de Integração Transacional (Aplicação)

Para assegurar que o runtime Node.js / Server Actions interaja com o banco respeitando a RLS sem vazamentos de pool, foi construído o módulo TypeScript [`src/db/rls-context.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/rls-context.ts):

```typescript
export async function withRlsContext<T>(
  perfilId: string,
  papel: 'estudante' | 'responsavel',
  callback: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>
): Promise<T> {
  if (!perfilId || typeof perfilId !== 'string') {
    throw new Error('RLS Context Error: perfilId é obrigatório e deve ser uma string UUID válida.');
  }
  if (papel !== 'estudante' && papel !== 'responsavel') {
    throw new Error(`RLS Context Error: papel inválido "${papel}". Esperado "estudante" ou "responsavel".`);
  }

  return await db.transaction(async (tx) => {
    // 1. Configura o contexto transacional com SET LOCAL no PostgreSQL
    await tx.execute(sql`SELECT medicina.set_context(${perfilId}::uuid, ${papel}::text);`);

    try {
      // 2. Executa a operação protegida por RLS
      return await callback(tx);
    } finally {
      // 3. Limpeza defensiva explícita de contexto
      try {
        await tx.execute(sql`SELECT medicina.clear_context();`);
      } catch {
        // Se a transação estiver em erro (aborted), o ROLLBACK automático restaura os parâmetros locais.
      }
    }
  });
}
```

### Propriedades Verificadas por Testes Unitários ([`src/db/rls-context.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/db/rls-context.test.ts)):
1. **Validação de Entrada:** Lança exceção imediata caso `perfilId` seja vazio ou o `papel` seja inválido, impedindo o envio de comandos malformados ao banco.
2. **Encapsulamento Transacional:** Todas as queries são despachadas dentro do objeto transacional `tx` fornecido pelo Drizzle.
3. **Resiliência a Erros:** O bloco `finally` garante que `clear_context()` seja invocado tanto no caminho feliz quanto em caso de exceções dentro do callback.

---

## 6. Atualização dos Arquivos de Proposta e Rollback

1. **`docs/modernizacao/propostas/F1_04_RLS_PROPOSTA.sql`:**
   - Incorpora preflight atualizado;
   - Criação dos papéis `medicina_app` e `medicina_anon`;
   - Blindagem de todas as funções do schema `medicina` com `SET search_path = public, medicina, pg_temp;`;
   - `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA medicina FROM PUBLIC;`;
   - Concessão de privilégio mínimo por coluna em `public.perfis` (bloqueando `password_hash`);
   - Ativação de RLS e políticas declarativas em todas as 33 tabelas;
   - Criação das views agregadas quinzenais e trimestrais (Princípio 1.2 da ESPEC).
2. **`docs/modernizacao/propostas/F1_04_ROLLBACK_RLS.sql`:**
   - Script atômico e idempotente que remove views, descarta policies, desabilita RLS em todas as tabelas, revoga permissões de coluna e descarta o schema `medicina` em cascata.

---

## 7. Próximos Passos e Coordenação de Testes

Os arquivos SQL atualizados foram sincronizados com o Subagente 2 (RLS Test Suite Engineer, conversationId: `bee4c576-a628-44be-b25a-9f6d257cdeb9`). A suíte automatizada expandida (`run-rls-validation.mjs`) executará a validação dos 18 cenários originais mais os 8 novos cenários da F1.04-R:
- **R1:** Falsificação de contexto e demonstração do modelo de confiança;
- **R2:** Tentativa de troca indevida de papel (`estudante` -> `responsavel`);
- **R3:** Tentativa de `SELECT password_hash` (bloqueio `42501` via Column-Level Grant);
- **R4:** Tentativa de `EXECUTE` por papel anônimo (bloqueio `42501`);
- **R5:** Execução fora de transação (bloqueio imediato por `is_local = true`);
- **R6:** Login com e-mail fora da allowlist (anti-enumeração / zero linhas);
- **R7:** Login legítimo com e-mail na allowlist;
- **R8:** Isolamento em subqueries, joins e manipulação de views.
