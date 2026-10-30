# RELATÓRIO TÉCNICO DE ENGENHARIA — MEDICINA 2029
## H2.03-R2B: Correção da Transmissão Segura da Chave de Descriptografia

**Data:** 29 de Outubro de 2026  
**Status:** CONCLUÍDO E HOMOLOGADO (Aguardando Autorização Humana)  
**Ambiente:** macOS Darwin (arm64) | Docker Local 127.0.0.1:5433 (`pg-test-restore`)  
**Paridade Binária Alvo:** PostgreSQL 18.x + pgvector 0.8.2 (Imagem: `pgvector/pgvector:0.8.2-pg18-trixie`)  
**Backup Baseline:** `backups/medicina2029_backup_baseline_20261026_230000Z`  
**Testes de Regressão e Segurança:** 59/59 testes Vitest aprovados (100%) + 6/6 testes criptográficos  

---

### 1. Diagnóstico e Análise da Causa Raiz

#### 1.1 Contexto da Ocorrência
Durante a primeira tentativa de restauração no contêiner isolado local (`pg-test-restore`), o script `scripts/backup/restore_postgres.sh` executou normalmente suas checagens de isolamento e solicitou a chave mestra de forma interativa:
```text
🔑 Digite a chave mestra de descriptografia do backup:
```
Após o operador inserir a chave correta, o script abortou imediatamente ao tentar decifrar o manifesto com o seguinte erro:
```text
ERRO: Variável de ambiente BACKUP_ENCRYPTION_KEY não definida!
```

#### 1.2 Mecânica da Falha
1. **Escopo de Variáveis no Bash:**
   O comando interativo no script de shell executava:
   ```bash
   read -r -s BACKUP_ENCRYPTION_KEY
   ```
   No Bash, uma atribuição via `read` instancia uma variável restrita à sessão do shell corrente, **sem marcá-la para exportação** aos processos filhos.
2. **Ausência de Suporte a IPC Seguro no Utilitário Node.js:**
   O utilitário criptográfico `scripts/backup/crypto_envelope.mjs` invocava:
   ```javascript
   const passphrase = process.env.BACKUP_ENCRYPTION_KEY;
   ```
   Como o processo filho `node` foi gerado sem a chave em `process.env`, a variável resultava em `undefined`, abortando a decifragem.
3. **Por que NÃO usar `export BACKUP_ENCRYPTION_KEY`:**
   Exigir `export` ou expor a chave no ambiente herdado de subprocessos viola as boas práticas de governança de segredos: qualquer comando subsequente ou ferramenta de inspeção teria acesso à chave em memória de processos.

---

### 2. Solução de Engenharia Implementada

Para resolver a raiz do problema sem enfraquecer o isolamento de credenciais, foi implementada uma arquitetura baseada em **IPC anônimo via Standard Input (`stdin` / descritor de arquivo)**:

```
[ Usuário digita chave (TTY) / Redirecionamento ]
                       │
                       ▼
            [ Variável Local Bash ]
                       │
                       ▼
    printf '%s' "${KEY}" | node crypto_envelope.mjs decrypt ... --key-stdin
                       │
             (Pipe Anônimo no Kernel)
                       │
                       ▼
       [ fd 0 / stdin no processo Node ]  ──►  [ Decifragem AES-256-GCM ]
                       │                                     │
                       ▼                                     ▼
      [ Purga de memória (unset) ]              [ Manifesto & Dump Claros ]
```

#### 2.1 Alterações em `scripts/backup/crypto_envelope.mjs`
1. **Adição do Argumento `--key-stdin`:** Lê a chave mestra diretamente do `stdin` (fd 0) de forma síncrona através de `readFileSync(0, 'utf8')`.
2. **Adição do Argumento `--key-fd=<n>`:** Permite ler a chave a partir de um descritor de arquivo arbitrário aberto.
3. **Fallback Inteligente:** Caso não seja um terminal interativo (`!process.stdin.isTTY`), tenta ler do stream de entrada caso o descritor esteja alimentado.
4. **Preservação de Retrocompatibilidade:** Mantida a verificação opcional de `process.env.BACKUP_ENCRYPTION_KEY` para testes legados que já configuravam variáveis de teste.
5. **Purga em Memória:** Bloco `finally { passphrase = ''; }` garantindo eliminação imediata da referência em memória após a conclusão do ciclo criptográfico.
6. **Zero Exposição em Logs/Processos:** Nenhuma chave em linha de comando (`ps aux`), e mensagens de erro não revelam senhas ou dados parciais.

#### 2.2 Alterações em `scripts/backup/restore_postgres.sh`
1. **Transmissão via Pipe Embutido do Bash:**
   Manifesto:
   ```bash
   printf '%s' "${BACKUP_ENCRYPTION_KEY}" | node "${CRYPTO_SCRIPT}" decrypt "${ENC_MANIFEST}" "${MANIFEST_FILE}" --key-stdin
   ```
   Dump:
   ```bash
   printf '%s' "${BACKUP_ENCRYPTION_KEY}" | node "${CRYPTO_SCRIPT}" decrypt "${ENC_DUMP}" "${DUMP_TO_RESTORE}" --key-stdin
   ```
   Como `printf` é um built-in do Bash, nenhum processo intermediário é bifurcado com argumentos no sistema operacional.
2. **Atualização dos Fallbacks OpenSSL e GPG:**
   - OpenSSL: Uso de `-pass stdin` (lê senha de stdin, eliminando `env:`).
   - GPG: Uso de `--passphrase-fd 0` (lê de stdin).
3. **Purga Imediata após a Decifragem:**
   Imediatamente após decifrar o manifesto e o dump (e antes de qualquer conexão ou operação de banco):
   ```bash
   unset BACKUP_ENCRYPTION_KEY
   ```
4. **Blindagem do Trap de Limpeza:**
   O tratador de sinais e encerramento (`trap cleanup EXIT INT TERM HUP`) foi atualizado para purgar a variável e destruir qualquer resíduo temporário:
   ```bash
   cleanup() {
     unset BACKUP_ENCRYPTION_KEY 2>/dev/null || true
     if [[ -d "${TMP_RESTORE_DIR}" ]]; then
       rm -rf "${TMP_RESTORE_DIR}"
     fi
   }
   ```
5. **Ordem Estrita de Operações (Proteção contra Destruição Indesejada):**
   A validação da chave, decifragem do manifesto, decifragem do dump, verificação de hash SHA-256 e teste de integridade da TOC com `pg_restore --list` ocorrem **ANTES** de qualquer comando no banco de dados (`DROP DATABASE` / `CREATE DATABASE`). Se a chave estiver errada ou os dados adulterados, o script aborta com código 2 sem tocar em nenhum objeto ou catálogo existente.

#### 2.3 Atualização em `scripts/backup/backup_postgres.sh`
- Alinhamento para cifragem via pipe stdin com a flag `--key-stdin`.

---

### 3. Matriz de Testes e Resultados de Validação

Foi desenvolvido um suite dedicado de testes automatizados:
`src/app/actions/h2_03_r2b_key_transmission_fix.test.ts` (14 casos de teste).

| Categoria | Caso de Teste | Comportamento Esperado | Resultado |
|---|---|---|:---:|
| **Transmissão Segura** | Decifragem via `--key-stdin` com chave correta | Decifragem bem-sucedida, paridade de bytes | ✅ APROVADO |
| **Fail-Closed Defensivo** | Decifragem via `--key-stdin` com chave incorreta | Aborta com código 2, erro GHASH AEAD | ✅ APROVADO |
| **Chave Ausente** | Entrada via stdin vazia ou não fornecida | Aborta com código 1 (fail-closed) | ✅ APROVADO |
| **Descritor de Arquivo** | Leitura de chave via `--key-fd=3` | Leitura íntegra a partir do FD | ✅ APROVADO |
| **Zero Exposição** | Inspeção de `process.argv` e `ps` | Chave ausente nos argumentos CLI | ✅ APROVADO |
| **Zero Exposição** | Pipe embutido `printf` do Bash | Segredo não persiste no ambiente | ✅ APROVADO |
| **Bloqueio Remoto** | Alvo apontando para host `supabase.co` | Recusa sumária antes da leitura da chave | ✅ APROVADO |
| **Bloqueio Remoto** | Alvo apontando para IP externo não-local | Recusa sumária (loopback obrigatório) | ✅ APROVADO |
| **Proteção do Alvo** | Chave incorreta no manifesto | Aborta código 2, nenhum DROP DATABASE executado | ✅ APROVADO |
| **Limpeza de Temporários** | Aborto por manifesto inválido | Diretório temporário `medicina2029_restore_*` destruído | ✅ APROVADO |
| **Purga de Chave** | Conclusão da decifragem | Chamada explícita de `unset BACKUP_ENCRYPTION_KEY` | ✅ APROVADO |
| **Tratamento de Sinais** | Simulação de Ctrl+C (`SIGINT`) | Trap acionado, remoção total de temporários | ✅ APROVADO |
| **Roundtrip Completo** | Decifragem simultânea de dump e manifesto | Validação de SHA-256 e contagem da allowlist = 2 | ✅ APROVADO |

#### Resumo Consolidado de Todos os Testes Locais
```text
✓ src/app/actions/h2_03_r2b_key_transmission_fix.test.ts (14 tests) -> 14 passed
✓ src/app/actions/h2_03_r2_isolated_restore_preparation.test.ts (20 tests) -> 20 passed
✓ src/app/actions/h2_03_r_baseline_recovery_validation.test.ts (13 tests) -> 13 passed
✓ src/app/actions/h2_03_staging_baseline_backup.test.ts (12 tests) -> 12 passed
✓ scripts/backup/test_crypto_roundtrip.sh (6 tests) -> 6 passed

TOTAL: 59 testes Vitest + 6 testes de criptografia shell (100% SUCESSO)
```

---

### 4. Estado da Infraestrutura Local e Verificações Pré-Execução

Antes de executar a nova tentativa de restauração, confirme as seguintes pré-condições no ambiente:

1. **Contêiner Ativo e Preservado:**
   - Nome: `pg-test-restore`
   - Imagem: `pgvector/pgvector:0.8.2-pg18-trixie`
   - Porta: `127.0.0.1:5433`
   - Status verificado: Em execução contínua.
2. **Arquivo de Senha Efêmera SCRAM-SHA-256:**
   - A variável `PGPASSFILE` deve estar exportada na sessão do terminal apontando para o arquivo temporário gerado no passo de inicialização do contêiner.
   - Caso uma nova sessão de terminal seja utilizada, confirme que o cliente `psql` consegue conectar via:
     ```bash
     psql -h 127.0.0.1 -p 5433 -U postgres -d postgres -c "SELECT version();"
     ```
3. **Backup Baseline Preservado:**
   - Arquivo cifrado: `backups/medicina2029_backup_baseline_20261026_230000Z/medicina2029_backup_baseline_20261026_230000Z.dump.enc`
   - Manifesto cifrado: `backups/medicina2029_backup_baseline_20261026_230000Z/medicina2029_backup_baseline_20261026_230000Z_manifest.json.enc`
   - Formato verificado: Envelope `M29G` v1 (AES-256-GCM com Tag de 128 bits).

---

### 5. Procedimento Operacional Definitivo para Restauração

Após a devida autorização humana, execute o comando definitivo abaixo no terminal onde o contêiner e o `PGPASSFILE` foram configurados:

```bash
TARGET_PGHOST=127.0.0.1 \
TARGET_PGPORT=5433 \
TARGET_PGUSER=postgres \
bash scripts/backup/restore_postgres.sh \
  backups/medicina2029_backup_baseline_20261026_230000Z \
  medicina2029_restore_teste
```

#### O que esperar durante a execução:
1. O script exibirá o prompt:
   ```text
   🔑 Digite a chave mestra de descriptografia do backup:
   ```
2. Digite a chave mestra (os caracteres não serão exibidos na tela por segurança).
3. O script decifrará o manifesto e o dump via pipe stdin em memória, purgará a chave, conferirá o hash SHA-256, recriará o banco local `medicina2029_restore_teste`, aplicará as roles locais e o schema extensions, executará `pg_restore` (exigindo código zero) e rodará a auditoria `verify_restore.sh`.
4. Ao final com êxito, será exibido:
   ```text
   ======================================================================
   RESTAURAÇÃO CONCLUÍDA COM ÊXITO!
   Banco restaurado: medicina2029_restore_teste
   ======================================================================
   ```

---

### 6. Destruição do Ambiente e Limpeza Pós-Restauração

Após a conferência dos resultados da restauração, destrua o ambiente descartável e os segredos temporários com o comando:

```bash
docker stop pg-test-restore
rm -rf "${SEC_TMP}"
unset PGPASSFILE
```

---

### 7. Critérios de Homologação (APTO / NÃO APTO)

- [x] **APTO:** Causa raiz diagnosticada com precisão cirúrgica (variável não exportada no Bash + ausência de stdin no Node).
- [x] **APTO:** Chave mestra transmitida estritamente via pipe IPC anônimo (`stdin`), sem uso de `export` ou arquivos permanentes.
- [x] **APTO:** Zero exposição de segredos em argumentos de processo (`ps aux`), histórico do shell, logs ou relatórios.
- [x] **APTO:** Purga imediata em memória via `unset BACKUP_ENCRYPTION_KEY` e limpeza em caso de erro/sinais (`trap cleanup`).
- [x] **APTO:** Fail-closed estrito mantido: falha na decifragem aborta com código 2 antes de qualquer conexão ou alteração no banco de dados.
- [x] **APTO:** Contêiner existente `pg-test-restore` e backup original rigorosamente preservados.
- [x] **APTO:** 59/59 testes automatizados locais aprovados com 100% de sucesso.
- [x] **APTO:** Relatórios idênticos gerados com conferência estrita de SHA-256.
- [x] **APTO:** Nenhuma ação proibida realizada (sem acesso ao Supabase, sem seed, sem worker, sem commit/push/deploy).

---
*Assinado eletronicamente pela equipe de engenharia do Projeto Medicina 2029.*
