# Medicina 2029 — Relatório Técnico F1.05

**Tarefa:** F1.05 — Proteção de Backups e Bloqueio de Restauração Insegura
**Fase:** 1 — Confiabilidade e Segurança
**Data da execução:** 19 de outubro de 2026
**Classificação:** **APROVADA**
**Escopo:** contenção do restore destrutivo, exportação administrativa segura, manifesto versionado e validação exclusivamente em memória

## 1. Resumo executivo

A vulnerabilidade crítica do fluxo interativo de backup e restauração foi contida. A interface não importa nem chama mais a operação histórica de restore e não disponibiliza seletor de arquivo. No servidor, `restaurarDadosCompletos` preserva o nome exportado apenas por compatibilidade com chamadas antigas, exige o papel `responsavel` e retorna sempre uma negação pública antes de interpretar o conteúdo ou iniciar qualquer leitura operacional, transação, `DELETE` ou `INSERT`.

A exportação deixou de consultar linhas completas. As 32 coleções são selecionadas por allowlists positivas de colunas. A projeção de `perfis` contém somente `id`, `nome`, `papel` e `criadoEm`; não inclui `passwordHash`, `authUserId` nem e-mail. A geração também rejeita recursivamente nomes de campos associados a senhas, tokens, cookies, segredos, chaves de API ou credenciais.

Foi criado o formato de exportação 1, com manifesto, contagens e hash SHA-256 sobre uma serialização determinística de `dados`. O validador é puro, trabalha em memória, aplica contratos fechados de estrutura e possui limites contra arquivos excessivos, profundidade e explosão de erros. Validar um arquivo não inicia nem autoriza restauração.

A interface agora identifica corretamente o JSON como exportação administrativa: ele contém dados pessoais e pedagógicos, não inclui os objetos binários do Supabase Storage, não é um backup completo e não é restaurável automaticamente.

Os gates finais passaram: TypeScript, build, lint dirigido, `git diff --check` e a suíte completa com 16 arquivos e 114/114 testes. Nenhuma migration, seed, restauração, exclusão, conexão com banco real, acesso ao Supabase remoto, commit, push ou deploy foi executado.

## 2. Diagnóstico inicial e classificação dos riscos

| Prioridade | Problema | Causa e arquivos | Consequência antes da F1.05 | Correção aplicada | Evidência de validação |
|---|---|---|---|---|---|
| P0 | restauração destrutiva disponível na aplicação | `src/app/actions/backup.ts` continha uma transação com exclusão e reinserção global; `ResponsavelPage.tsx` enviava o JSON | perda ou corrupção total dos dados por arquivo parcial, inválido ou malicioso | remoção integral do corpo destrutivo; action bloqueada server-side; caller e input removidos da UI | chamada direta retorna negação; mocks confirmam zero `select`, `transaction`, `delete`, `insert` ou `update` após o guard |
| P0 | hash de senha e identidade de autenticação exportáveis | seleção integral de `perfis` | exposição de material de autenticação e aumento do impacto de vazamento | projeção positiva somente de `id`, `nome`, `papel` e `criadoEm` | inspeção da seleção e testes negativos para `passwordHash`, `authUserId` e outros segredos |
| P1 | falso conceito de backup completo | JSON não continha objetos do Storage nem garantia de recuperação integral | confiança indevida numa cópia incapaz de restaurar o sistema | nomenclatura, UI e manifesto afirmam explicitamente que é exportação administrativa, sem Storage e não restaurável | teste estrutural da interface e flags do manifesto |
| P1 | arquivo sem versão, completude ou integridade verificável | objeto JSON bruto sem contrato | omissões, alterações e formatos incompatíveis não eram detectados | formato 1, lista canônica de coleções, contagens e hash de integridade | testes de alteração, coleção ausente, contagem divergente e versão desconhecida |
| P2 | validação incompleta e potencial consumo excessivo de memória/CPU | parsing sem contrato e sem limites | arquivo malformado ou excessivo poderia consumir recursos; valores incompatíveis passavam | contrato fechado de campos/tipos e limites defensivos antes e durante a inspeção | testes de tamanho, registros, profundidade, ciclo, tipos, datas, enums e campos ausentes |
| P3 | interface e nome do arquivo induziam interpretação errada | textos “backup completo” e “restaurar” | confusão operacional | textos e nome de download alterados para exportação administrativa | teste estrutural do componente |

## 3. Auditoria do fluxo anterior

O inventário encontrou um único caminho normal para restore:

1. `src/components/ResponsavelPage.tsx` lia um `.json` com `FileReader`;
2. o componente chamava `restaurarDadosCompletos`;
3. `src/app/actions/backup.ts` validava parcialmente o objeto;
4. uma transação apagava as tabelas em ordem de dependência;
5. as coleções presentes no JSON eram reinseridas.

Não foi encontrado endpoint HTTP, rota de API ou alias alternativo para a restauração. Ainda assim, ocultar a UI seria insuficiente porque Server Actions podem ser chamadas diretamente. Por isso, o bloqueio foi aplicado também no servidor e o código destrutivo deixou de existir na action.

O export anterior consultava todas as colunas de todas as tabelas listadas. Isso incluía a linha completa de `perfis`, com dados de autenticação. Embora a F1.02 já restringisse a action ao responsável, autorização não tornava seguro exportar segredos nem restaurar globalmente dados fornecidos pelo cliente.

## 4. Solução implementada

### 4.1 Bloqueio da restauração

`restaurarDadosCompletos` agora:

- exige `requireRole('responsavel')`;
- não interpreta o JSON;
- não chama o banco para ler o conteúdo da exportação;
- não inicia transação;
- não executa `DELETE`, `INSERT` ou `UPDATE`;
- retorna `{ sucesso: false }` com mensagem pública fixa.

O guard pode consultar a sessão e o perfil para autenticar o responsável. Essa leitura de autorização não é restauração nem efeito colateral. Usuários anônimos e estudantes são negados pelo guard antes de qualquer operação do fluxo.

Na interface foram removidos o import da action, o handler, `FileReader`, o input de arquivo e a chamada de restore. Um aviso informa que a restauração pela interface está indisponível por segurança.

### 4.2 Exportação administrativa segura

`exportarDadosCompletos` mantém o nome público por compatibilidade, mas seu resultado mudou de um suposto backup para uma exportação administrativa versionada. A action exige `responsavel` antes de consultar dados.

As consultas usam seleção explícita baseada em `EXPORT_COLLECTION_FIELDS`. Isso evita a fragilidade de buscar a linha completa e depois excluir alguns campos. Se uma coluna sensível for acrescentada futuramente ao schema, ela não passará automaticamente a fazer parte do arquivo.

A exportação contém 32 coleções:

`perfis`, `responsavelEstudante`, `generos`, `disciplinas`, `topicos`, `materiais`, `perguntasAtivas`, `questoes`, `questaoTopicos`, `curadoriaFila`, `sessoes`, `ciclos`, `cicloBlocos`, `cicloEstado`, `tentativas`, `erros`, `cards`, `cardRevisoes`, `checkins`, `redacoes`, `repertorios`, `simulados`, `simuladoQuestoes`, `simuladoAreas`, `simuladoAnalise`, `revisoesTrimestrais`, `livros`, `acervoArquivos`, `acervoPaginas`, `acervoChunks`, `acervoFiguras` e `geracoes`.

O arquivo não inclui:

- `passwordHash`;
- `authUserId`;
- e-mail de login;
- senhas, tokens, cookies ou sessões;
- segredos e chaves de API;
- credenciais de serviços;
- conteúdo binário dos objetos do Storage.

Metadados e caminhos do acervo permanecem no JSON, mas os objetos apontados por esses caminhos não são copiados. Por isso, a exportação não é um mecanismo de recuperação de desastre.

### 4.3 Manifesto e serialização determinística

O manifesto contém:

- aplicativo: `Medicina 2029`;
- versão do formato: `1`;
- data/hora ISO da exportação;
- tipo: `exportacao_administrativa_pessoal`;
- lista ordenada das coleções;
- quantidade de registros por coleção;
- confirmação de exclusão de segredos;
- indicação de que objetos do Storage não estão incluídos;
- indicação de que o arquivo não é restaurável automaticamente;
- algoritmo `SHA-256`;
- hash de integridade.

Para calcular o hash:

1. somente o objeto `dados` participa; o manifesto fica fora;
2. valores `Date` válidos são convertidos para ISO 8601;
3. chaves de objetos são ordenadas lexicograficamente em todos os níveis;
4. propriedades com valor `undefined` são omitidas;
5. a ordem dos arrays é preservada;
6. o valor normalizado é serializado como JSON UTF-8 sem espaçamento;
7. aplica-se SHA-256 e o resultado é representado em hexadecimal minúsculo.

O hash permite detectar alteração do conteúdo. Ele **não é assinatura digital, MAC ou prova de autenticidade**, porque qualquer pessoa que altere o arquivo também pode recalcular um novo hash.

### 4.4 Validação em memória

`validarExportacaoSegura` não importa banco, Storage nem actions. A função:

- aceita objeto ou string JSON;
- rejeita JSON malformado;
- exige raiz contendo exclusivamente `manifesto` e `dados`;
- exige conjunto exato de campos do manifesto;
- valida aplicação, versão, tipo, timestamp e flags;
- exige as 32 coleções e rejeita coleções desconhecidas;
- confere o mapa de contagens;
- usa contrato fechado para todos os campos das 32 coleções;
- valida presença inclusive de campos nullable, que devem aparecer como `null`;
- valida string, inteiro, número finito, booleano, data ISO, UUID, enum e JSON;
- rejeita campos não permitidos e nomes associados a segredos em qualquer profundidade;
- recalcula e compara o hash.

Limites defensivos:

| Limite | Valor |
|---|---:|
| string JSON recebida | 10 MiB |
| registros totais | 100.000 |
| profundidade | 20 níveis |
| nós inspecionados | 500.000 |
| erros retornados | 100 |

Esses limites protegem o validador e não representam capacidade de backup. A action `validarArquivoExportacao` exige responsável e apenas chama a rotina em memória; não inicia escrita. Um resultado válido não chama nem habilita restore.

## 5. Arquivos da F1.05

### Código e interface modificados

- `src/app/actions/backup.ts`;
- `src/app/actions/backup.test.ts`;
- `src/components/ResponsavelPage.tsx`.

### Código e testes criados

- `src/lib/exportacao-segura.ts`;
- `src/lib/exportacao-segura.test.ts`;
- `src/components/ResponsavelPage.test.ts`.

### Documentação

- `docs/modernizacao/PLANO_MODERNIZACAO.md`;
- `docs/modernizacao/RELATORIO_F1_05.md`.

O worktree já continha alterações e arquivos das F1.03, F1.03-M e F1.03-R. Eles foram preservados. Nenhuma alteração anterior foi descartada ou sobrescrita deliberadamente.

## 6. Testes e resultados

### 6.1 Gates finais executados

| Verificação | Resultado |
|---|---|
| `npx tsc --noEmit` | **PASSOU** |
| `npm run test:run` | **PASSOU** — 16 arquivos, 114/114 testes |
| `npm run build` | **PASSOU** — compilação, TypeScript interno e geração das rotas concluídos |
| ESLint dos seis arquivos TS/TSX da F1.05 | **PASSOU** |
| `git diff --check` | **PASSOU** |

Avisos não bloqueantes e preexistentes: o Vitest/Vite informa futura mudança do carregador de configuração; o Next.js informa depreciação da convenção `middleware` em favor de `proxy`.

### 6.2 Cobertura específica de segurança

Os testes demonstram:

1. usuário não autenticado não exporta;
2. estudante não exporta administrativamente;
3. responsável obtém somente a projeção permitida;
4. `passwordHash` e `authUserId` não aparecem;
5. campos de segredo são rejeitados recursivamente;
6. manifesto e contagens são produzidos;
7. alteração do conteúdo invalida o hash;
8. coleção ausente é detectada;
9. contagem divergente é detectada;
10. versão desconhecida é rejeitada;
11. JSON e estruturas inválidas são rejeitados;
12. validação não chama operações de escrita;
13. restore não chama `DELETE`, `INSERT`, `UPDATE` nem transação;
14. chamada direta ao restore permanece bloqueada;
15. detalhes internos não aparecem no erro público;
16. a suíte completa das funcionalidades existentes continua verde.

Também são cobertos contratos de tipos, campos nullable ausentes, UUIDs, enums, datas inválidas, número excessivo de registros, arquivo maior que o limite, profundidade excessiva e referência cíclica em entrada programática.

### 6.3 Natureza dos testes e limitações

- Os testes das Server Actions usam mocks de autorização e banco.
- Os testes do formato e validador são unitários puros em memória.
- O teste da interface é estrutural e confirma a ausência do caller/input de restore.
- Não foi executado restore, nem mesmo em banco descartável, porque esta tarefa existe para bloquear esse fluxo.
- Não foi usado PostgreSQL real, banco remoto, Supabase, Storage ou dado real.
- Não foram executados E2E de navegador nem teste de volume com 100.000 registros válidos completos.
- A suíte verde não constitui teste de recuperação integral.

## 7. Critérios de aceite

| Critério | Resultado |
|---|---|
| restore destrutivo inacessível pelos caminhos normais | atendido |
| bloqueio implementado no servidor | atendido |
| nenhum segredo exportado pelas projeções | atendido |
| exportação protegida por autorização | atendido |
| manifesto versionado | atendido |
| validação de integridade | atendido |
| validação sem escrita | atendido |
| testes negativos impedem efeitos destrutivos | atendido |
| aplicação compila | atendido |
| funcionalidades independentes preservadas | atendido pela suíte existente |
| nenhum dado real alterado | atendido |

**Classificação final: APROVADA.**

Essa classificação vale para a contenção da F1.05. Ela não declara que o Medicina 2029 já possui backup operacional ou recuperação de desastre.

## 8. Riscos e limitações remanescentes

1. **P1 — não existe recuperação integral:** a exportação não inclui objetos binários do Storage e não pode recriar o ambiente.
2. **P1 — arquivo em claro:** apesar de não conter segredos de autenticação, o JSON contém dados pessoais, acadêmicos, textos e indicadores; deve ser tratado como informação privada.
3. **P1 — ausência de backup nativo ensaiado no alvo:** não há nesta tarefa snapshot PostgreSQL, PITR, `pg_dump`/`pg_restore` nativo do ambiente-alvo ou promoção validada.
4. **P2 — memória:** exportação e validação continuam materializando o JSON em memória; o limite de validação reduz abuso na entrada, mas a geração depende do volume consultado antes de serializar.
5. **P2 — autenticidade:** SHA-256 sem chave não comprova autoria e não impede adulteração acompanhada de recálculo.
6. **P2 — auditoria operacional:** não foi criado log persistente específico de exportações; isso deve ser coordenado com a estratégia de auditoria e retenção.
7. **P2 — restauração futura:** o nome histórico da action permanece exportado, embora bloqueado, para compatibilidade. Nenhum futuro restore deve reutilizar essa interface sem desenho operacional separado e autorização específica.

## 9. Arquitetura recomendada para recuperação completa

A futura F1.14 deve separar exportação para consulta de backup operacional:

1. criar snapshot consistente usando mecanismo nativo PostgreSQL compatível com a versão alvo;
2. registrar versão do schema, journal e artefatos das migrations;
3. inventariar e copiar os objetos do Supabase Storage, preservando metadados e hashes;
4. gerar manifesto do pacote com hashes por artefato e por objeto;
5. criptografar cópias com mecanismo autenticado e chaves fora do aplicativo;
6. aplicar IAM de mínimo privilégio e separação entre operador, aplicação e destino do backup;
7. manter cópias imutáveis, preferencialmente fora da conta ou ambiente primário;
8. definir retenção, expiração e descarte seguro;
9. documentar RPO, RTO, responsáveis e critérios de incidente;
10. restaurar primeiro em banco e bucket temporários, nunca sobre o ambiente ativo;
11. verificar schema, contagens, FKs, hashes, objetos e amostra funcional;
12. promover somente após revisão humana e autorização explícita;
13. executar exercícios periódicos e registrar tempo, falhas e evidências.

Não deve ser criado um botão de recuperação integral na interface comum. Operação de desastre exige runbook, credenciais separadas, dupla confirmação e ambiente temporário validado.

## 10. Confirmações de segurança

- produção não foi acessada;
- Supabase remoto e Storage não foram acessados;
- nenhum banco local ou remoto foi consultado;
- nenhum dado real foi usado;
- nenhuma migration ou contração foi executada;
- nenhum seed foi executado;
- nenhuma restauração foi executada;
- nenhum registro ou arquivo foi apagado;
- nenhuma credencial ou variável de ambiente foi lida ou alterada;
- nenhum commit, push ou deploy foi realizado;
- as mudanças anteriores do worktree foram preservadas.

## 11. Próxima tarefa recomendada

**F1.04 — RLS e views agregadas versionadas**, sem iniciá-la automaticamente.

O objetivo recomendado é tornar a separação estudante–responsável verificável no banco, inventariar políticas externas de forma autorizada, preparar policies e views versionadas e ensaiar a matriz de acesso em PostgreSQL descartável. Nenhuma policy deve ser aplicada em produção sem auditoria do ambiente-alvo e autorização específica.

A F1.14 permanece necessária para backup completo e recuperação testada. A contração da F1.03-R continua bloqueada até cumprir seus gates próprios, incluindo backup nativo restaurado e aprovação expressa.
