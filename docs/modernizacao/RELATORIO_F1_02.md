# Medicina 2029 — Relatório Técnico F1.02

**Tarefa:** F1.02 — Autenticação e Autorização  
**Fase:** 1 — Confiabilidade e Segurança  
**Data da execução:** 18 e 19 de outubro de 2026  
**Repositório analisado:** `medicina_2029-main`  
**Estado:** implementação e validação concluídas; aguardando avaliação

## 1. Resumo executivo

A tarefa criou uma camada central de autenticação e autorização e aplicou proteção server-side às 37 Server Actions encontradas. A identidade efetiva agora é obtida da sessão NextAuth validada e reconsultada na tabela `perfis`; o papel usado para autorizar é o valor atual do banco, não apenas a claim do JWT.

As constantes de perfil que correspondiam a `authUserId` foram removidas dos fluxos de runtime alterados. Inserts e filtros pessoais agora usam `perfis.id`, que é a chave referenciada pelas FKs. O cliente deixou de enviar `perfilId` para iniciar sessão de estudo e fazer upload. Operações por ID de sessão, card, erro e arquivo passaram a ser escopadas pelo proprietário.

Backup, restauração, acervo, curadoria, painel de lacunas e acompanhamento agregado exigem o papel `responsavel`. Sessões, check-in, caderno de erros, dashboard pessoal, FSRS, redações, simulados e reestudo exigem `estudante`. Leituras curriculares, busca e leitura do ciclo exigem usuário autenticado.

Não houve migration, seed, acesso a dados reais, restauração, limpeza, alteração de credenciais, deploy, commit ou push. A suíte completa terminou com 12 arquivos e 71 testes aprovados; TypeScript e build também passaram. O lint global continua bloqueado pela dívida técnica preexistente.

## 2. Objetivo da intervenção

- centralizar a obtenção da identidade autenticada;
- revalidar perfil e papel no banco em cada fronteira sensível;
- impedir que IDs recebidos do cliente funcionem como autorização;
- separar operações de estudante e responsável;
- aplicar ownership a dados pessoais e uploads;
- negar acesso antes de qualquer efeito no banco, Storage ou Gemini;
- emitir erros públicos estáveis sem dados sensíveis;
- preservar o NextAuth e o schema existentes, sem migração.

## 3. Diagnóstico inicial

### 3.1 NextAuth e sessão

O Credentials Provider consultava `perfis.email`, validava o hash bcrypt e colocava `perfil.id` e `perfil.papel` no JWT. A sessão tinha estratégia JWT e duração de 30 dias. Não havia revalidação do perfil ou do papel no banco durante esse período.

O middleware protegia navegação por existência de token, e algumas páginas administrativas verificavam a claim de papel, mas nenhuma das 37 Server Actions consultava sessão. Consequentemente, uma chamada direta à action contornava a proteção da página.

As mensagens de login diferenciavam conta inexistente e senha incorreta, permitindo enumeração de conta.

### 3.2 `authUserId` e `perfis.id`

`perfis.id` é a PK usada por todas as FKs de domínio. `authUserId` é outro UUID, único, sem ser a PK. O seed fixa `authUserId`, mas deixa `perfis.id` ser gerado. Diversas actions e componentes usavam os UUIDs fixos do seed como se fossem `perfilId`, criando risco de falha de FK, leituras vazias e associação incorreta.

A sessão NextAuth já fornece `perfis.id`. Portanto, a contenção segura não exigiu mudança de schema nem migração: a aplicação passou a usar somente o `id` da sessão revalidado contra `perfis.id`. Não foi criado fallback por `authUserId`, pois os dois espaços de identificadores são distintos e uma busca ambígua ocultaria o problema.

### 3.3 Papéis e vínculo familiar

O schema contém os papéis `estudante` e `responsavel`, mas não contém uma relação explícita responsável–estudante. A especificação atual prevê exatamente uma estudante e um responsável. Para preservar essa arquitetura sem migration, consultas agregadas do responsável resolvem o único perfil estudante e falham fechado quando existem zero ou mais de um.

Essa compatibilidade é segura para o modelo atual de duas contas, mas não suporta múltiplas famílias. Uma relação explícita será necessária antes de ampliar o número de usuários.

## 4. Estratégia de autenticação e autorização

### 4.1 Configuração reutilizável

`authOptions` foi movido para `src/lib/auth-options.ts`. A rota NextAuth apenas instancia o handler e reexporta a configuração para manter compatibilidade com imports existentes.

As falhas de login passaram a retornar a mesma mensagem pública, independentemente de o e-mail existir ou a senha estar incorreta.

### 4.2 Camada central

`src/lib/authorization.ts` fornece:

- `requireAuthenticatedProfile()`: exige sessão, extrai `session.user.id`, consulta `perfis.id` e falha fechado;
- `requireRole(role)`: autoriza pelo papel reconsultado no banco;
- `requireManagedStudentProfile()`: exige responsável e retorna somente quando existe exatamente uma estudante;
- `assertOwnership(expectedId, actualId)`: nega identificadores divergentes;
- `AuthorizationError`: usa apenas `UNAUTHENTICATED` e `FORBIDDEN`, com mensagens públicas genéricas.

O helper não usa `session.user.role` como autoridade final e não resolve identidade por e-mail ou `authUserId`.

### 4.3 Ownership e ordem dos guards

Os guards são executados antes dos blocos `try/catch` operacionais e antes de banco, Storage ou Gemini. Assim, negações não são convertidas em lista vazia, mock ou falso sucesso.

Operações com recursos pessoais combinam o ID solicitado com o `perfilId` autenticado no predicado. Arquivos do acervo combinam `arquivoId` e `enviadoPor`. IDs inexistentes e recursos de outro usuário produzem a mesma resposta pública, evitando enumeração.

## 5. Operações protegidas

| Grupo | Política aplicada | Ownership/escopo |
|---|---|---|
| Backup e restauração | `responsavel` | operação global; guarda antes de select/transaction |
| Upload e acervo | `responsavel` | `enviadoPor = perfil.id`; status/listagem escopados |
| Curadoria e geração | `responsavel` | arquivo pertence ao responsável; aprovação registra responsável; card usa estudante resolvida |
| Lacunas | `responsavel` | erros filtrados pela única estudante gerenciada |
| Acompanhamento e revisão trimestral | `responsavel` | agregados da única estudante; revisão permanece global por limite do schema |
| Criação/reset do ciclo | `responsavel` | preserva o fluxo atual da UI; divergência com ESPEC documentada |
| Busca e catálogos/ciclo | autenticado | dados globais; sem proprietário no schema |
| Sessões e cronômetro | `estudante` | criação usa perfil da sessão; update/conclusão usam `id + perfilId` |
| Check-in | `estudante` | insert usa perfil da sessão |
| Caderno de erros | `estudante` | leitura/update filtrados por perfil; insert usa perfil da sessão |
| FSRS/flashcards | `estudante` | consulta e revisão usam `card.id + perfilId` |
| Redações | `estudante` | leitura e insert usam perfil da sessão |
| Repertórios | `estudante` | role-only; tabela não possui owner |
| Simulados | `estudante` | lista, trava e insert usam perfil da sessão |
| Reestudo | `estudante` | role-only; ciclo não possui owner |
| Dashboard pessoal | `estudante` | todas as métricas pessoais usam perfil da sessão |

Total: **37 de 37 Server Actions** possuem exigência explícita de autenticação ou papel no servidor.

## 6. Alterações implementadas

### 6.1 Identidade e login

- configuração NextAuth extraída para módulo reutilizável;
- login deixou de revelar se a conta existe;
- sessão continua baseada em JWT e NextAuth, conforme restrição;
- perfil e papel são recarregados no banco a cada autorização;
- `authUserId` permaneceu inalterado e não foi usado como FK.

### 6.2 Remoção de identidade controlada pelo cliente

- `iniciarSessao` não recebe mais `perfilId`;
- `enviarArquivo` não recebe mais `perfilId`;
- `CronometroPage` e `AcervoPage` foram adaptados às assinaturas seguras;
- UUIDs fixos de estudante/responsável foram removidos das actions de runtime.

### 6.3 Proteção contra IDOR

- atualização e conclusão de sessão exigem sessão pertencente à estudante autenticada;
- referências de tentativa usadas na conclusão são validadas por tentativa, estudante, sessão e questão antes da mutação;
- resolução de erro exige `erro.id + erros.perfilId`;
- revisão FSRS exige `card.id + cards.perfilId`;
- listagens e inserts pessoais usam o perfil autenticado;
- status, listagem e geração por arquivo do acervo exigem ownership do responsável.

### 6.4 Erros e falsos sucessos

- falhas de autorização não entram em fallbacks;
- sessão e check-in não retornam mais sucesso simulado quando o banco falha;
- catches alterados não devolvem `error.message` ao cliente;
- erro do pipeline persistido no status do acervo foi reduzido a texto público genérico.

### 6.5 Navegação por papel

- a raiz redireciona o responsável para `/responsavel` antes de consultar o dashboard da estudante;
- a navegação oculta rotas exclusivas do outro papel;
- as Server Actions continuam sendo a barreira efetiva, independentemente da página.

## 7. Arquivos modificados

### Novos

- `src/lib/auth-options.ts`
- `src/lib/authorization.ts`
- `src/lib/authorization.test.ts`
- `src/app/actions/authorization.test.ts`
- `docs/modernizacao/RELATORIO_F1_02.md`

### Autenticação, actions e consumidores

- `src/app/api/auth/[...nextauth]/route.ts`
- `src/app/actions/acervo.ts`
- `src/app/actions/backup.ts`
- `src/app/actions/busca.ts`
- `src/app/actions/cadernoErros.ts`
- `src/app/actions/checkin.ts`
- `src/app/actions/ciclo.ts`
- `src/app/actions/curadoria.ts`
- `src/app/actions/dashboard.ts`
- `src/app/actions/fsrs.ts`
- `src/app/actions/lacunas.ts`
- `src/app/actions/redacoes.ts`
- `src/app/actions/reestudo.ts`
- `src/app/actions/responsavel.ts`
- `src/app/actions/sessao.ts`
- `src/app/actions/simulados.ts`
- `src/app/page.tsx`
- `src/components/AcervoPage.tsx`
- `src/components/CronometroPage.tsx`
- `src/components/NavBar.tsx`

### Testes existentes adaptados

- `src/app/actions/acervo.test.ts`
- `src/app/actions/actions.test.ts`
- `src/app/actions/backup.test.ts`
- `src/app/actions/curadoria.test.ts`
- `src/app/actions/dashboard.test.ts`
- `src/app/actions/fsrs.test.ts`
- `src/app/actions/redacoes.test.ts`
- `src/app/actions/responsavel.test.ts`

### Documentação atualizada

- `docs/modernizacao/AUDITORIA_F1_01.md`
- `docs/modernizacao/PLANO_MODERNIZACAO.md`

## 8. Testes realizados e resultados

| Verificação | Resultado |
|---|---|
| `npx tsc --noEmit` | **PASSOU** |
| `npm run test:run` | **PASSOU** — 12 arquivos, 71/71 testes |
| `npm run build` | **PASSOU** — 17 rotas listadas; aviso de depreciação de `middleware` |
| lint dos módulos novos e testes novos | **PASSOU** |
| `npm run lint` | **FALHOU** — 172 ocorrências: 126 erros e 46 avisos |
| `git diff --check` | **PASSOU** |

O lint global já falhava na F1.01 com 199 ocorrências. A execução atual permanece bloqueada principalmente por `no-explicit-any`, regras de hooks, entidades JSX não escapadas e imports não usados em código preexistente. Os novos módulos `auth-options`, `authorization`, seus testes, a rota NextAuth e a raiz passaram no lint dirigido.

Os testes novos cobrem:

- sessão ausente e perfil inexistente;
- papel da claim divergente do papel no banco;
- estudante tentando operação administrativa;
- responsável tentando iniciar sessão de estudo;
- identidade efetiva aplicada a upload e sessão;
- IDs arbitrários de sessão, erro e card;
- negação antes de DB, transação e Storage;
- cardinalidade inválida de estudante gerenciada;
- acesso legítimo preservado;
- falha interna sem segredo na mensagem pública.

Todos os testes usam mocks. Nenhum banco, usuário ou bucket real foi acessado.

## 9. Problemas identificados durante a tarefa

1. Não existe vínculo responsável–estudante no schema.
2. Backup ainda inclui `passwordHash` e restauração continua destrutiva para o responsável autorizado.
3. RLS e policies externas não estão versionadas nem foram verificadas.
4. Ciclo é global e sem proprietário; a UI atual permite ao responsável criar/resetar, divergindo da ESPEC, que atribui autonomia à estudante.
5. Repertórios e revisões trimestrais não têm coluna de proprietário.
6. A busca acessa chunks brutos e não demonstra um portão de conteúdo aprovado para a estudante.
7. O caderno de erro manual ainda depende de IDs simulados incompatíveis com FKs normais.
8. Algumas actions de leitura ainda convertem falha operacional em mock ou lista vazia.
9. Operações multi-etapa não são integralmente transacionais/idempotentes.
10. O JWT dura 30 dias e não possui mecanismo demonstrado de revogação imediata; as actions mitigam papel obsoleto ao reconsultar o banco.
11. O lint global permanece vermelho.

## 10. Riscos remanescentes

### P0

- RLS não verificada/versionada: a proteção implementada está na aplicação e não substitui defesa no banco.
- Restore autorizado ainda apaga e reinsere toda a base; requer isolamento operacional, validação e reautenticação.
- Backup autorizado ainda pode exportar hashes de senha e não inclui garantia completa dos objetos do Storage.

### P1

- ausência de relação responsável–estudante impede isolamento seguro em cenário com múltiplas famílias;
- dados históricos podem ter sido criados com identificadores incorretos; isso não foi inspecionado em dados reais;
- tabelas globais impedem ownership completo sem decisão de schema;
- busca pode expor conteúdo não aprovado;
- operações multi-etapa podem persistir parcialmente em falhas intermediárias.

### P2/P3

- validação runtime de payloads continua incompleta;
- fallbacks de demonstração ainda ocultam indisponibilidade em módulos não corrigidos nesta tarefa;
- dívida de lint e E2E placeholders permanecem.

## 11. Pendências e dependências futuras

- decidir e modelar a relação responsável–estudante antes de múltiplos usuários;
- auditar dados históricos em cópia isolada antes de qualquer saneamento/migração;
- versionar e testar RLS em banco descartável;
- separar backup operacional da UI e remover hashes do export;
- definir ownership para ciclo, repertórios e revisões trimestrais;
- aplicar validação runtime e transações/idempotência;
- restringir busca da estudante a conteúdo aprovado;
- substituir IDs simulados do caderno manual por modelo persistente válido;
- criar E2E reais com dois perfis e banco descartável.

## 12. Reversão

A reversão é feita por grupos independentes, sem mudança de dados:

1. restaurar a rota NextAuth e remover `auth-options.ts`/`authorization.ts` somente junto com as chamadas dependentes;
2. reverter assinaturas de sessão/upload e respectivos consumidores em conjunto;
3. reverter guards por módulo, mantendo os testes negativos para evidenciar a regressão;
4. reverter os filtros de navegação separadamente, pois não são a barreira de segurança;
5. não há migration, seed ou transformação de dados para desfazer.

Reverter os guards reabre as vulnerabilidades documentadas e não é recomendado fora de um rollback emergencial controlado.

## 13. Confirmações de segurança e integridade

- Nenhuma migration foi criada ou executada.
- Nenhum seed foi executado.
- Nenhum registro foi lido, alterado ou apagado em banco real.
- Nenhum arquivo real foi enviado ao Storage.
- Nenhuma variável de ambiente, credencial ou configuração de produção foi alterada.
- Nenhuma dependência foi instalada.
- Nenhum deploy foi realizado.
- Nenhum commit ou push foi realizado.
- Nenhum segredo é reproduzido neste relatório.

## 14. Próxima tarefa recomendada

**F1.03 — Consolidação da identidade canônica e do ownership**, limitada inicialmente a:

1. auditar, em cópia isolada e autorizada, se existem dados históricos vinculados incorretamente;
2. decidir a relação responsável–estudante e o ownership das tabelas hoje globais;
3. preparar a migration e o plano de rollback, sem aplicá-los em produção sem aprovação específica;
4. complementar os testes com dois perfis persistidos em banco descartável.

Parte da contenção originalmente prevista para F1.03 foi antecipada pela solicitação expressa desta F1.02. Não avançar automaticamente.
