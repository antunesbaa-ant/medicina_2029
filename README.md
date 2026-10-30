# 🩺 Medicina 2029

> **Sistema Web Privado de Gerenciamento e Aceleração de Estudos de Alta Performance**  
> Preparação pedagógica direcionada para o **ENEM** e vestibulares de alta concorrência de **Medicina** (UECE, Unifor, Unichristus).

---

[![Next.js](https://img.shields.io/badge/Next.js-16.4.2-black?style=for-the-badge&logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19.2.4-blue?style=for-the-badge&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%20%2F%2018%20(pgvector)-336791?style=for-the-badge&logo=postgresql)](https://www.postgresql.org/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-0.45.2-C5F74F?style=for-the-badge&logo=drizzle)](https://orm.drizzle.team/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC?style=for-the-badge&logo=tailwind-css)](https://tailwindcss.com/)
[![Vitest](https://img.shields.io/badge/Vitest-4.x-6E9F18?style=for-the-badge&logo=vitest)](https://vitest.dev/)
[![ts-fsrs](https://img.shields.io/badge/FSRS-5.4.1-orange?style=for-the-badge)](https://github.com/open-spaced-repetition/ts-fsrs)

---

## 📌 Sumário

1. [Visão Geral & Horizonte](#-visão-geral--horizonte)
2. [Princípios Inegociáveis de Produto](#-princípios-inegociáveis-de-produto)
3. [Módulos Funcionais](#-módulos-funcionais)
4. [Arquitetura & Engenharia de Segurança](#-arquitetura--engenharia-de-segurança)
5. [Motor de Ingestão Multimodal & IA](#-motor-de-ingestão-multimodal--ia)
6. [Resiliência, Backup Criptográfico & Auditoria](#-resiliência-backup-criptográfico--auditoria)
7. [Stack Tecnológica](#-stack-tecnológica)
8. [Estrutura do Repositório](#-estrutura-do-repositório)
9. [Guia de Início Rápido (Quickstart)](#-guia-de-início-rápido-quickstart)
10. [Testes & Homologação](#-testes--homologação)
11. [Governança & Documentação](#-governança--documentação)

---

## 🎯 Visão Geral & Horizonte

O **Medicina 2029** é a concretização em software de um plano pedagógico rigoroso concebido para conduzir a estudante do 1º ano do Ensino Médio à aprovação em Medicina no ciclo de 2029 em Fortaleza/CE.

* **Horizonte de Operação Contínua:** 34 meses de uso diário ininterrupto (março/2027 a dezembro/2029).
* **Foco Arquitetural:** Alta manutenibilidade, resiliência de longo prazo, isolamento de papéis (*least privilege*), integridade transacional de dados e *Human-in-the-Loop* estrito em todos os fluxos de IA.
* **Modelo Operacional Privado:** Sistema com dois perfis estruturais de acesso (`estudante` e `responsavel`), sem auto-cadastro público, sem links abertos e protegido por autenticação segura via NextAuth e Row-Level Security (RLS) no PostgreSQL.

---

## 🧭 Princípios Inegociáveis de Produto

Derivados da especificação canônica do planejamento pedagógico ([`ESPEC.md`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/ESPEC.md)):

1. **O sistema nunca culpa:** Se a aderência semanal ficar abaixo de 70%, o sistema sugere a redução da carga horária planejada, nunca punição. Sem *streaks* punitivos, sem perda de pontos ou contadores de dias perdidos.
2. **O painel do responsável não é vigilância:** Monitoramento diário invasivo prejudica o rendimento acadêmico. O responsável **não tem acesso** a horários em tempo real ou sessões individuais da estudante. A granularidade mínima de visualização é **quinzenal agregada** (enforçada na camada de banco via RLS e views dedicadas).
3. **O plano pertence à estudante:** Autonomia total para reordenar blocos, editar o ciclo semanal, ajustar a carga horária e pausar módulos sem exigir autorização prévia.
4. **Registrar o erro é prioritário:** Registrar falhas no Caderno de Erros é a ação de menor atrito da interface, categorizando as causas em conteúdo, interpretação, distração, cálculo ou tempo.
5. **Dois trilhos de avaliação (ENEM vs. UECE):** Todas as questões, tentativas, flashcards e simulados são classificados obrigatoriamente como `enem` (interpretativo/contextualizado) ou `conteudista` (técnico e direto — padrão UECE).
6. **Sustentabilidade como métrica de 1ª classe:** Indicadores de sono (mínimo recomendado de 7h30), exercício e bem-estar compartilham o topo do dashboard com o mesmo destaque visual das métricas de notas.
7. **Human-in-the-Loop inegociável na IA:** Nenhum resumo, questão ou flashcard sintetizado por IA chega à estudante sem aprovação humana expressa do responsável na fila de curadoria.
8. **Hierarquia de Procedência de Questões:**
   * **Nível 1 (Ouro):** Provas oficiais anteriores (ENEM, UECE, Unifor, Unichristus). Obrigatório no mínimo 80% em simulados formais.
   * **Nível 2 (Prata):** Questões extraídas de livros e apostilas de renome.
   * **Nível 3 (Bronze):** Questões geradas por IA para fechamento de lacunas pontuais (com sinalização visual clara da procedência).

---

## 🧩 Módulos Funcionais

```
┌────────────────────────────────────────────────────────────────────────┐
│                          MEDICINA 2029 PLATFORM                         │
└────────────────────────────────────────────────────────────────────────┘
       │                        │                        │
       ▼                        ▼                        ▼
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│  ESTUDANTE   │         │  RESPONSÁVEL │         │   BACKGROUND │
│              │         │              │         │   WORKERS    │
│ • Ciclo      │         │ • Curadoria  │         │ • OCR        │
│ • Sessões    │         │ • Ingestão   │         │ • Embeddings │
│ • FSRS Cards │         │ • Visão      │         │ • Pg-Boss    │
│ • Caderno    │         │   Quinzenal  │         │ • Reconcile  │
│ • Simulados  │         │ • Materiais  │         │ • Backups    │
└──────────────┘         └──────────────┘         └──────────────┘
```

| Módulo | Rota | Descrição |
|---|---|---|
| **Ciclo de Estudos** | `/ciclo` | Distribuição modular em 28 blocos semanais com locks transacionais (`pg_advisory_xact_lock`) prevenindo conflitos concorrentes. |
| **Sessão de Estudo** | `/estudar` | Execução guiada de blocos com cronômetro de estudo e reconciliação temporal no servidor (evita adulteração do relógio do cliente). |
| **Flashcards FSRS** | `/revisao` | Algoritmo moderno de Repetição Espaçada (*Free Spaced Repetition Scheduler* - `ts-fsrs`), superando o tradicional SM-2 em precisão e retenção. |
| **Caderno de Erros** | `/caderno-erros` | Taxonomia diagnóstica de causas-raiz com registro imediato de tentativas e planos de remediação. |
| **Acervo Didático** | `/acervo` | Repositório de PDFs com deduplicação por hash SHA-256 e armazenamento privado no Supabase Storage. |
| **Busca Híbrida** | `/busca` | Recuperação inteligente combinando busca textual e similaridade vetorial por cosseno (HNSW com `pgvector` em 1536 dimensões). |
| **Curadoria & Ingestão** | `/curadoria` | Fila exclusiva do responsável para validação, edição ou descarte de materiais fatiados e gerados por IA. |
| **Painel do Responsável** | `/responsavel` | Visão quinzenal agregada de desempenho e bem-estar, respeitando a privacidade estrita do estudante (ESPEC 1.2). |
| **Simulados & Redações** | `/simulados` / `/redacoes` | Provas cronometradas no modelo de exame e histórico de produções textuais alinhadas às 5 competências do ENEM. |

---

## 🔒 Arquitetura & Engenharia de Segurança

### 1. Isolamento de Conexões por Privilégio Mínimo (Least Privilege)

A aplicação não utiliza uma única conexão superusuária. O acesso ao PostgreSQL é segregado em três papéis técnicos distintos:

* **`medicina_app`**: Conexão principal das Server Actions da aplicação. Possui acesso restrito às tabelas de domínio, sendo bloqueada de ler `password_hash` da tabela de credenciais ou executar funções administrativas. Todas as operações operam sob RLS.
* **`medicina_auth`**: Conexão exclusiva utilizada pelo NextAuth (`/api/auth`) para autenticação de login e verificação segura de credenciais.
* **`medicina_worker`**: Conexão dedicada para os processos assíncronos do `pg-boss`, tarefas de OCR, chunking e indexação vetorial.

### 2. Multi-Tenant com RLS Fail-Closed Transacional

Todas as 35 tabelas de domínio possuem **Row-Level Security (RLS)** ativo com comportamento estritamente *fail-closed* (sem contexto, nenhuma linha é retornada).

A cada requisição autenticada, a sessão estabelece o contexto do usuário dentro da transação:
```sql
SELECT medicina.set_context(p_user_id := $1, p_role := $2);
```
Isso garante que um estudante jamais acesse dados de outro estudante e impede que o perfil responsável acesse diretamente registros de sessões diárias individuais.

### 3. Criptografia & Benchmark de Senhas

* Armazenamento com **bcrypt** cujo custo de rounds é benchmarked em tempo de inicialização para garantir resistência a ataques de força bruta sem degradar o runtime.
* Comparação em tempo constante para neutralizar ataques de temporização (*timing attacks*).

---

## 🤖 Motor de Ingestão Multimodal & IA

O pipeline de ingestão de materiais didáticos automatiza a transformação de livros e apostilas em conteúdo pedagógico estruturado:

```
[ Upload do PDF ]
       │
       ▼
[ Deduplicação SHA-256 ] ──► Armazenamento Privado (Supabase Storage)
       │
       ▼
[ Fila Pg-Boss ] ──► Worker Assíncrono com Papel medicina_worker
       │
       ├─► Extração de Texto Direta (pdfjs-dist / pdf-parse)
       ├─► OCR Multimodal para digitalizações (Google Gemini 2.5 Flash)
       │
       ▼
[ Chunking Semântico ]
       │
       ├─► Embeddings Vetoriais (gemini-embedding-001, 1536 dimensões)
       ├─► Indexação HNSW em PostgreSQL com pgvector
       │
       ▼
[ Fila de Curadoria Human-in-the-Loop ]
       │
       ▼
[ Aprovação Expressa do Responsável ] ──► Liberado para Estudo
```

---

## 🛡️ Resiliência, Backup Criptográfico & Auditoria

O projeto conta com um subsistema completo e autônomo de backup, criptografia e recuperação de desastres localizado em `scripts/backup/`:

* **Envelope Criptográfico AEAD AES-256-GCM (`crypto_envelope.mjs`):** Backups gerados pelo `pg_dump` são criptografados com cifra autenticada, chave derivada de alta entropia e vetor de inicialização único de 96 bits.
* **Validação por Manifesto SHA-256:** Cada backup gera um manifesto com hashes individuais de cada arquivo, contagens exatas de tabelas e metadados de execução.
* **Restauração Isolada em Contêiner Descartável (`restore_postgres.sh`):** Capacidade de restaurar dumps reais em contêiner Docker temporário (`127.0.0.1:5433`), recusando categoricamente qualquer conexão externa ou remota.
* **Auditoria de Integridade em 7 Etapas (`verify_restore.sh`):**
  1. Verificação de Extensões do Banco (`vector`, `pgcrypto`, `unaccent`, `uuid-ossp`).
  2. Verificação de Schemas do Sistema (`public`, `medicina`, `extensions`).
  3. Reconciliação Fina de Inventário de Registros contra o Manifesto do Backup.
  4. Auditoria de RLS e Integridade de Políticas de Segurança (verificação em `pg_class`).
  5. Catálogo de Integridade Relacional (Chaves Primárias e Estrangeiras).
  6. Catálogo de Funções SQL e Triggers Canônicos.
  7. Índices Vetoriais HNSW e Histórico Completo de Migrações.

---

## 🛠️ Stack Tecnológica

| Camada | Tecnologias Utilizadas |
|---|---|
| **Framework Web** | [Next.js 16.4.2](https://nextjs.org/) (App Router, Server Actions, React 19.2.4) |
| **Estilização** | [Tailwind CSS v4](https://tailwindcss.com/) com PostCSS |
| **Linguagem** | [TypeScript 5](https://www.typescriptlang.org/) (Modo Estrito) |
| **Banco de Dados** | [PostgreSQL 15 / 18](https://www.postgresql.org/) com extensão [pgvector](https://github.com/pgvector/pgvector) |
| **ORM & Migrações** | [Drizzle ORM 0.45.2](https://orm.drizzle.team/) + Drizzle Kit |
| **Autenticação** | [NextAuth.js 4.24.15](https://next-auth.js.org/) + `bcryptjs` |
| **Repetição Espaçada**| [ts-fsrs 5.4.1](https://github.com/open-spaced-repetition/ts-fsrs) |
| **Fila Assíncrona** | [pg-boss 12.26.4](https://github.com/timgit/pg-boss) |
| **IA & Embeddings** | Google Gemini 2.5 Flash (OCR multimodal) & gemini-embedding-001 (1536 dim) |
| **Armazenamento** | Supabase Storage (Bucket privado com controle RLS) |
| **Processamento PDF**| `pdfjs-dist`, `pdf-parse`, `tesseract.js` |
| **Testes** | [Vitest 4](https://vitest.dev/), [Playwright](https://playwright.dev/) |

---

## 📁 Estrutura do Repositório

```bash
medicina_2029/
├── src/
│   ├── app/                      # Rotas e páginas do Next.js App Router
│   │   ├── (auth)/login/         # Página de login com NextAuth
│   │   ├── acervo/               # Catálogo de PDFs e documentos
│   │   ├── actions/              # Server Actions da aplicação
│   │   ├── busca/                # Interface de busca semântica e híbrida
│   │   ├── caderno-erros/        # Caderno de erros pedagógico
│   │   ├── ciclo/                # Planejamento semanal de 28 blocos
│   │   ├── curadoria/            # Fila de curadoria e aprovação do responsável
│   │   ├── dashboard/            # Visão geral de métricas e sustentabilidade
│   │   ├── estudar/              # Sessões ativas com cronômetro seguro
│   │   ├── responsavel/          # Visão quinzenal agregada (ESPEC 1.2)
│   │   ├── revisao/              # Sessões de revisão espaçada FSRS
│   │   └── simulados/            # Provas formais cronometradas
│   ├── components/               # Componentes visuais reutilizáveis
│   ├── db/                       # Schema Drizzle, migrações e contexto RLS
│   │   ├── schema.ts             # Modelagem das 35 tabelas e enums do domínio
│   │   ├── rls-context.ts        # Gerenciamento de contexto medicina.set_context
│   │   └── index.ts              # Conexões segregadas de banco
│   └── lib/                      # Utilitários, clientes de IA e regras de negócio
├── drizzle/                      # Arquivos SQL gerados pelas migrações
├── scripts/
│   ├── backup/                   # Criptografia AEAD, rotinas de restore e auditoria
│   │   ├── crypto_envelope.mjs   # Envelope AES-256-GCM
│   │   ├── restore_postgres.sh   # Restauração isolada em Docker
│   │   └── verify_restore.sh     # Auditoria de 7 etapas do banco restaurado
│   ├── db/                       # Scripts de migração ordenada e configuração de roles
│   └── worker/                   # Runner assíncrono para tarefas de background
├── docs/
│   └── modernizacao/             # Runbooks, especificações e relatórios de marcos
├── ESPEC.md                      # Especificação funcional e pedagógica do sistema
└── package.json                  # Scripts e dependências do projeto
```

---

## 🚀 Guia de Início Rápido (Quickstart)

### Pré-requisitos

* **Node.js**: Versão 20.x ou superior (compatível com Node.js 22/24).
* **Docker** ou instância local do **PostgreSQL 15+** com suporte à extensão `pgvector`.

### 1. Clonar o Repositório e Instalar Dependências

```bash
git clone https://github.com/seu-usuario/medicina_2029.git
cd medicina_2029
npm install
```

### 2. Configurar Variáveis de Ambiente

Crie o arquivo `.env.local` a partir do modelo de exemplo:

```bash
cp .env.example .env.local
```

Preencha os valores obrigatórios em `.env.local`:
* `NEXTAUTH_SECRET`: Segredo de no mínimo 32 caracteres gerado via `openssl rand -base64 32`.
* `DATABASE_URL`: String de conexão com o PostgreSQL local para desenvolvimento.
* `GEMINI_API_KEY`: Chave da API Google AI Studio para recursos multimodais e embeddings.
* `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`: Acesso ao bucket privado de armazenamento didático.

### 3. Preparar o Banco de Dados

Execute as migrações estruturais do Drizzle:

```bash
# Executa as migrações locais
npm run db:migrate

# Opcional: Popular com dados sintéticos locais para testes
npm run db:seed
```

### 4. Executar o Servidor de Desenvolvimento

```bash
npm run dev
```

Acesse [http://localhost:3000](http://localhost:3000) no navegador.

### 5. Executar o Worker de Ingestão Assíncrona (Opcional)

Para processar filas de extração de texto, OCR e geração de embeddings:

```bash
npm run worker:ondemand
```

---

## 🧪 Testes & Homologação

A plataforma conta com políticas rígidas de **Zero PII** (Zero Informações Pessoais Identificáveis), operando exclusivamente com dados sintéticos durante testes e auditorias:

```bash
# Executa os testes unitários e de integração via Vitest
npm run test:run

# Executa os testes de ponta a ponta (E2E) com Playwright
npm run test:e2e
```

Para validar a integridade completa de um backup restaurado em ambiente Docker isolado:
```bash
./scripts/backup/verify_restore.sh \
  --host 127.0.0.1 \
  --port 5433 \
  --dbname medicina2029_restore_teste \
  --user postgres
```

---

## 📚 Governança & Documentação

* [`ESPEC.md`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/ESPEC.md): Especificação fundamental dos princípios pedagógicos e requisitos funcionais.
* [`docs/modernizacao/RUNBOOK_BACKUP_RECUPERACAO.md`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/RUNBOOK_BACKUP_RECUPERACAO.md): Procedimentos operacionais para backup e recuperação de desastres.
* [`docs/modernizacao/PLANO_MODERNIZACAO.md`](file:///Users/brunoantunes/Documents/Projetos%20IA/medicina_2029-main/docs/modernizacao/PLANO_MODERNIZACAO.md): Histórico técnico e marcos de modernização da plataforma.

---

<p align="center">
  <b>Medicina 2029</b> — Planejado com disciplina, construído com robustez.
</p>
