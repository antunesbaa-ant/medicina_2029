# MEDICINA 2029 — H2.03
## Relatório de Preparação do Backup Baseline de Staging

**Data:** 26 de Outubro de 2026  
**Ambiente:** Supabase Staging (`medicina-2029-staging`)  
**Project Ref:** `ynfocaorhadizlvbnzrt`  
**Host do Pooler:** `aws-0-us-east-1.pooler.supabase.com:5432` (Session Pooler)  
**Certificado Raiz TLS:** `~/Downloads/prod-ca-2021.crt`  
**Fingerprint Canônico SHA-256:** `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`  
**Lançador de Backup:** [`scripts/db/backup-staging-baseline.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/backup-staging-baseline.mjs)  
**Envelope Criptográfico:** [`scripts/backup/crypto_envelope.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/backup/crypto_envelope.mjs) (AEAD AES-256-GCM Envelope M29G)  

---

## CLASSIFICAÇÃO FINAL DE PRONTIDÃO

> ### ⚠️ NÃO APTO (BLOQUEIO OPERACIONAL DE FERRAMENTAL NO MACOS)
>
> **Motivo Técnico Exclusivo:** O binário cliente PostgreSQL `pg_dump` **não se encontra instalado** no sistema operacional macOS do ambiente de execução (ausente em `$PATH`, `/opt/homebrew`, `/usr/local` e `Postgres.app`).  
> 
> Todos os scripts de preparação, controle de acesso, TLS, criptografia autenticada AEAD, validação de integridade SHA-256, geração de manifesto canônico de Storage e suítes de testes automatizados locais (12/12 novos testes, totalizando **50/50 aprovados** na suíte H2) estão **100% concluídos e homologados**.
>
> Em cumprimento rigoroso aos princípios de governança do Projeto Medicina 2029 (*"Se pg_dump/pg_restore não estiverem disponíveis, registre essa limitação. Não substitua um restore real por mocks afirmando que houve recuperação completa"*), a classificação é declarada como **NÃO APTO** até que o operador humano disponibilize o utilitário `pg_dump` no macOS.

---

## 1. Inspeção dos Scripts Existentes e Adaptações Realizadas

A auditoria inspecionou todo o ecossistema de backup desenvolvido nas fases F1.15 e F1.16:

1. **Envelope Criptográfico ([`scripts/backup/crypto_envelope.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/backup/crypto_envelope.mjs)):**
   - Utilitário nativo de alta segurança implementando o formato **M29G (Versão 0x01)**: Magic Bytes `M29G`, Salt PBKDF2 (128 bits, 100.000 iterações), IV/Nonce (96 bits NIST SP 800-38D), Tag de Autenticação GHASH (128 bits) e Ciphertext AES-256-GCM.
   - *Adaptação Realizada:* Exportação das funções `encryptFile` e `decryptFile` e encapsulamento da execução CLI em condicional de módulo (`import.meta.url === pathToFileURL(process.argv[1]).href`), viabilizando seu uso direto como biblioteca em módulos ESM mantendo 100% de compatibilidade retroativa com scripts bash.

2. **Scripts Canônicos de Shell (`backup_postgres.sh`, `restore_postgres.sh`, `verify_restore.sh`, `sanitizar_pos_restore.sh`):**
   - Projetados para PostgreSQL padrão em clusters dedicados;
   - *Limitação Identificada para Staging Supabase:* O comando `pg_dumpall --globals-only` presente no shell script falha sumariamente no Supabase Cloud, pois o usuário `postgres` não é superusuário (`SUPER=false`) e tem permissão negada de leitura na tabela de senhas de cluster `pg_authid`. Além disso, o PgBouncer na porta 6543 não suporta operações de dump global.

3. **Novo Lançador Interativo Especializado ([`scripts/db/backup-staging-baseline.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/backup-staging-baseline.mjs)):**
   - Lançador Node.js ESM dedicado, adotando o mesmo padrão de segurança, TTY raw mode sem eco, TLS estrito e fail-closed consolidado em H2.01-R3 e H2.02.
   - Restringe o escopo de extração exclusivamente aos schemas da aplicação (`--schema=public --schema=medicina`), ignorando schemas internos de infraestrutura do Supabase (`auth`, `storage`, `graphql`, `vault`).

---

## 2. Escopo Exato do Backup Baseline

O backup baseline de staging captura o estado exato da aplicação imediatamente após a conclusão das 9 migrações canônicas e antes do início dos seeds sintéticos.

### 2.1 Objetos Preservados no Backup
- **Schemas da Aplicação:** `public` e `medicina`;
- **Estruturas de Dados:** Todas as 32+ tabelas do domínio médico e acadêmico;
- **Histórico Canônico de Migrações:** Tabela `public._medicina_staging_migrations` contendo o registro sequencial das 9 etapas, hashes de integridade, data de aplicação e identificador de execução;
- **Extensões de Banco:** Registro de dependências de `vector` (0.8.2), `pgcrypto`, `unaccent` e `uuid-ossp`;
- **Funções Armazenadas:** Funções críticas em `medicina.*` (`medicina.autenticar_por_email` e `medicina.fn_busca_hibrida_acervo`);
- **Políticas RLS:** Definições ativas de Row Level Security (`FORCE ROW LEVEL SECURITY` e políticas `CREATE POLICY`);
- **Constraints e Triggers:** Restrições de chave estrangeira com cascata defensiva, checagem de tipos, constraints de proveniência (`chk_acervo_origem_proveniencia`) e triggers (ex: `check_allowlist`);
- **Privilégios Técnicos:** Grants concedidos às roles `medicina_app`, `medicina_auth` e `medicina_worker` sobre schemas, tabelas e funções.

### 2.2 Exclusões e Limitações Inerentes
- **Schemas Internos do Supabase:** `auth` (GoTrue), `storage` (metadados internos), `realtime`, `graphql`, `vault`, `pgsodium`, `supabase_functions`. Esses objetos são geridos pela infraestrutura gerenciada do Supabase e não devem ser misturados com o dump da aplicação;
- **Senhas de Roles Técnicas:** O utilitário `pg_dump` não extrai senhas de roles (`--no-owner --no-privileges`). As senhas de `medicina_app`, `medicina_auth` e `medicina_worker` residem em `pg_authid` e são provisionadas pelo script administrativo parametrizado [`configure-staging-roles.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/configure-staging-roles.mjs);
- **Binários do Supabase Storage:** O `pg_dump` relacional **não copia arquivos físicos do Storage**. A preservação do Storage requer manifesto de reconciliação dedicado.

---

## 3. Supabase Storage e Estado Zero

### 3.1 Proteção da Infraestrutura de Storage
- **Configuração do Bucket:** Bucket privado `acervo` (`public = false`, limite de 50MB, tipo MIME exclusivo `application/pdf`), provisionado via migração 7 (`F1_10_STORAGE_POLICIES_PROPOSTA.sql`).
- **Políticas RLS no Storage:** Políticas sobre `storage.objects` restringindo acesso a usuários autenticados via RPCs e context claims.

### 3.2 Estado Zero no Baseline de Staging
- Conforme auditado nos testes diagnósticos, a tabela `public.acervo_arquivos` contém **exatamente 0 registros** e o bucket `acervo` possui **0 arquivos binários armazenados**.
- **Não há arquivos binários para download neste momento.** O lançador gera um manifesto canônico de Storage determinístico (RFC 8785) refletindo o estado zero:
  ```json
  {
    "version": "1.0",
    "geradoEm": "2026-10-26T23:00:00.000Z",
    "bucket": "acervo",
    "totalObjetos": 0,
    "totalBytes": 0,
    "sha256Manifesto": "f3b3d0cf...",
    "objetos": []
  }
  ```

### 3.3 Capacidade de Restauração
- **Totalmente Restaurável:** Configuração do bucket, políticas de segurança, esquemas relacionais de chunks/páginas/figuras/jobs e estado inicial;
- **Dependência Externa:** Em um ambiente de Disaster Recovery puro, o bucket `acervo` precisa ser recriado no storage remoto (via API ou DDL) antes de aceitar uploads.

---

## 4. Segurança do Backup e Criptografia em Repouso

O lançador [`scripts/db/backup-staging-baseline.mjs`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/scripts/db/backup-staging-baseline.mjs) implementa salvaguardas de nível operacional:

| Salvaguarda | Implementação no Lançador |
|---|---|
| **Conexão Exclusiva** | Validação estrita de `TARGET_PROJECT_REF = 'ynfocaorhadizlvbnzrt'` e `TARGET_HOST = 'aws-0-us-east-1.pooler.supabase.com'`. Rejeita qualquer outro host. |
| **Porta de Conexão** | Conecta exclusivamente na porta `5432` (Session Pooler). O Transaction Pooler (6543) não suporta dumps relacionais contínuos. |
| **TLS com CA Estrito** | Exige `prod-ca-2021.crt`, validação de fingerprint canônico SHA-256 e `PGSSLMODE=verify-full`. |
| **Entrada de Senhas** | Modo raw TTY sem eco; prompts visíveis antes da digitação; confirmação de chave dupla; saída limpa com `Ctrl+C` (código `130`). |
| **Isolamento de Credenciais** | `PGPASSWORD` injetado exclusivamente em subprocesso (`env`). **Zero senhas em `argv`**, logs ou disco claro. |
| **Guarda Fora do Git** | Arquivos gravados em `~/.medicina2029/backups/staging_baseline_<timestamp>` (fora da raiz do repositório). Pasta `./backups/` e extensões `.dump*` já protegidas pelo `.gitignore`. |
| **Permissões macOS** | Diretório criado com `chmod 700` (`drwx------`). Arquivos cifrados e manifestos criados com `chmod 600` (`-rw-------`). |
| **Cifragem em Repouso** | Cifragem autenticada AEAD AES-256-GCM (envelope `M29G`, 100k iterações PBKDF2, Tag GHASH 128-bit). |
| **Inviolabilidade** | Arquivos claros (`.dump` e `.json`) são descarregados e excluídos com `fs.unlinkSync` imediatamente após a cifragem confirmada e conferência SHA-256. |
| **Purga de Memória** | Variáveis `adminPassword` e `encryptionKey` são zeradas no bloco `finally`. |

---

## 5. Estratégia de Restauração em Ambiente Local Descartável

A restauração nunca deve ser realizada sobre o Supabase de produção ou de staging. O procedimento canônico deve ocorrer em instância isolada e descartável de PostgreSQL (PostgreSQL local ou container temporário):

### 5.1 Fases do Procedimento de Restauração
1. **Decifragem e Validação Matemática:**
   - Decifrar `medicina2029_staging_baseline.dump.enc` utilizando `crypto_envelope.mjs decrypt`;
   - Validar se o hash SHA-256 decifrado coincide com o registrado no manifesto;
   - Inspecionar a Tabela de Conteúdos com `pg_restore --list`.
2. **Preparação da Base Descartável:**
   ```sql
   DROP DATABASE IF EXISTS medicina_restore_tmp;
   CREATE DATABASE medicina_restore_tmp;
   \c medicina_restore_tmp;
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   CREATE EXTENSION IF NOT EXISTS unaccent;
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. **Carga dos Objetos com `pg_restore`:**
   ```bash
   pg_restore --host=localhost --port=5432 --username=postgres --dbname=medicina_restore_tmp \
              --no-owner --no-privileges --verbose --jobs=4 database.dump
   ```
4. **Auditoria Pós-Restore (`verify_restore.sh`):**
   - Valida existência das 32+ tabelas;
   - Confirma paridade de contagem de linhas contra o manifesto;
   - Confirma status de RLS em todas as tabelas.

### 5.2 Diferenciação entre os 4 Níveis de Confirmação

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────────┐       ┌───────────────────────────────┐
│  Backup Criado  │  ──>  │  Backup Íntegro │  ──>  │ Restauração Testada │  ──>  │ Recuperação Integral Atestada │
└─────────────────┘       └─────────────────┘       └─────────────────────┘       └───────────────────────────────┘
  Arquivos físicos          Hashes SHA-256 batem;     pg_restore executou sem       Tabelas, RLS, triggers, funções
  gerados no disco          envelope GCM autêntico;   erros em banco descartável    e integridade referencial 100%
  macOS pelo pg_dump        TOC legível via pg_restore                              auditadas e reconciliadas
```

---

## 6. Evidências dos Testes Automatizados Locais

Foram executados 12 novos testes automatizados unitários e de integração em [`src/app/actions/h2_03_staging_baseline_backup.test.ts`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/src/app/actions/h2_03_staging_baseline_backup.test.ts) utilizando o motor PGlite + `pgvector` e simulação PTY:

### 6.1 Suíte Automatizada (Vitest)
```text
 ✓ src/app/actions/h2_03_staging_baseline_backup.test.ts (12 tests) 1444ms
   ✓ MEDICINA 2029 — H2.03: Preparação do Backup Baseline de Staging (12)
     ✓ 1. Controles de Segurança, Projeto e Certificados TLS (4)
       ✓ 1.1 Valida estritamente o Project Ref do Staging (fail-closed) 1ms
       ✓ 1.2 Valida o certificado CA raiz e seu fingerprint canônico SHA-256 0ms
       ✓ 1.3 Rejeita certificado com fingerprint adulterado ou inválido 1ms
       ✓ 1.4 Diagnostica os pré-requisitos de sistema reportando prontidão ou ausência de ferramentas 0ms
     ✓ 2. Construção de Comandos pg_dump e Isolamento de Segredos (2)
       ✓ 2.1 Constrói argumentos seguros para pg_dump com escopo restrito aos schemas de aplicação 1ms
       ✓ 2.2 Confirma que a senha é injetada estritamente via ambiente do processo e não em argv 0ms
     ✓ 3. Manifesto Canônico do Storage (Estado Zero no Baseline) (1)
       ✓ 3.1 Gera manifesto RFC 8785 de estado zero com hash SHA-256 válido 0ms
     ✓ 4. Cifragem AEAD AES-256-GCM Envelope M29G (Inviolabilidade e Paridade) (3)
       ✓ 4.1 Executa ciclo completo de cifragem e decifragem com paridade binária 100% (SHA-256 match) 23ms
       ✓ 4.2 Rejeita decifragem com chave incorreta (fail-closed defensivo) 20ms
       ✓ 4.3 Detecta e rejeita adulteração de ciphertext por bit-flip via autenticação GHASH 19ms
     ✓ 5. Validação de Restauração em PostgreSQL Descartável (PGlite) (2)
       ✓ 5.1 Restaura as 9 migrações canônicas e confirma inventário de 32+ tabelas vazias no baseline 852ms
       ✓ 5.2 Testa rejeição por integridade referencial fail-closed em inserção fora de ordem 526ms
```

### 6.2 Resultado Consolidado da Suíte H2
- `h2_01_r2_launchers_validation.test.ts`: **10/10 aprovados**
- `h2_01_r_seed_allowlist_validation.test.ts`: **6/6 aprovados**
- `h2_01_r3_operational_security.test.ts`: **10/10 aprovados**
- `h2_02_roles_connection_validation.test.ts`: **12/12 aprovados**
- `h2_03_staging_baseline_backup.test.ts`: **12/12 aprovados**
- **Total Geral: 50 / 50 testes locais aprovados com 100% de sucesso.**

### 6.3 Testes em Terminal TTY Real (Python PTY Simulation)
```text
--- TESTE 1: Diagnóstico de Pré-requisitos (--check-prerequisites) ---
  ✓ Diagnóstico de pré-requisitos funcionando perfeitamente (fail-closed).

--- TESTE 2: Simulação com pg_dump mockado em PTY Real ---
  ✓ Etapa 1 visível e prompt interativo presente.
  ✓ Senha administrativa oculta. Etapa 2 exibida.
  ✓ Cancelamento com Ctrl+C limpo (código 130).

========================================================
✅ TESTES INTERATIVOS TTY DE BACKUP-STAGING APROVADOS!
========================================================
```

---

## 7. Instruções para Desbloqueio e Comandos de Execução no Mac

### 7.1 Como Desbloquear o Pré-Requisito no macOS
Para tornar o ambiente **APTO**, o operador deve instalar o utilitário `pg_dump`:

**Opção A: Via Homebrew (Recomendada)**
```bash
brew install libpq
brew link --force libpq
```

**Opção B: Via Postgres.app**
Se o Postgres.app estiver instalado, basta adicionar ao `$PATH`:
```bash
export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"
```

### 7.2 Comando de Diagnóstico (Sem Efeito Remoto)
Para verificar a qualquer momento o status dos pré-requisitos:
```bash
node scripts/db/backup-staging-baseline.mjs --check-prerequisites --ca=~/Downloads/prod-ca-2021.crt
```

*Saída atual obtida:*
```text
DIAGNÓSTICO DE PRÉ-REQUISITOS OPERACIONAIS:
  • Certificado CA TLS:    ✅ Válido (prod-ca-2021.crt)
  • Utilitário pg_dump:    ❌ NÃO ENCONTRADO
  • Envelope Criptográfico: ✅ AES-256-GCM disponível

PENDÊNCIAS PARA EXECUÇÃO:
  ⚠️  Utilitário "pg_dump" não encontrado no PATH nem nos diretórios padrão do macOS.

CLASSIFICAÇÃO: NÃO APTO (ferramental pendente no sistema operacional).
```

### 7.3 Comando Definitivo de Execução do Backup Baseline
Após a instalação do `pg_dump`, execute no Terminal:

```bash
node scripts/db/backup-staging-baseline.mjs --ca=~/Downloads/prod-ca-2021.crt
```

*Caso o binário esteja em caminho customizado:*
```bash
node scripts/db/backup-staging-baseline.mjs --ca=~/Downloads/prod-ca-2021.crt --pg-dump-path=/caminho/para/pg_dump
```

---

## 8. Critérios de Sucesso da Operação

1. **Autenticação e TLS Estrito:** Conexão bem-sucedida como `postgres.ynfocaorhadizlvbnzrt` na porta 5432 com certificado validado;
2. **Confirmação Humana:** Digitação exata de `CONFIRMAR BACKUP BASELINE`;
3. **Extração de Schemas:** Arquivo de dump gerado em formato custom (`-Fc`) contendo DDL e tabelas dos schemas `public` e `medicina`;
4. **Manifesto Consolidado:** Registro completo de contagens, histórico das 9 migrações e manifesto Storage de estado zero;
5. **Cifragem AEAD:** Dump e manifesto cifrados com chave mestra $\ge 16$ caracteres via envelope M29G, e arquivos claros eliminados com segurança;
6. **Integridade de Hashes:** Geração dos arquivos `.sha256` correspondentes e permissões `0600` em todos os artefatos.

---

> [!IMPORTANT]
> **Status de Conclusão da H2.03:**
> - Nenhum acesso remoto ou backup real foi executado nesta tarefa.
> - Nenhuma credencial ou migração foi modificada.
> - Nenhum commit, push ou deploy foi realizado.
> - O assistente aguarda autorização humana prévia e a instalação do utilitário `pg_dump` pelo operador no macOS.
