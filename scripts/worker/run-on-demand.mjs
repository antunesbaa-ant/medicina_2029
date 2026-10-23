#!/usr/bin/env node

/**
 * MEDICINA 2029 — H1.02
 * Script CLI de Execução sob Demanda do Worker de Ingestão de Acervo
 *
 * Uso:
 *   node scripts/worker/run-on-demand.mjs [--max-jobs=N] [--max-duration=MS] [--exit-on-empty]
 *
 * Exemplo:
 *   node scripts/worker/run-on-demand.mjs --max-jobs=5 --max-duration=30000
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

// Parsing defensivo de argumentos CLI
const args = process.argv.slice(2);
let maxJobs = 10;
let maxDurationMs = 60000;
let exitOnEmpty = true;

for (const arg of args) {
  if (arg.startsWith('--max-jobs=')) {
    const val = parseInt(arg.split('=')[1], 10);
    if (!isNaN(val) && val > 0) maxJobs = val;
  } else if (arg.startsWith('--max-duration=')) {
    const val = parseInt(arg.split('=')[1], 10);
    if (!isNaN(val) && val > 0) maxDurationMs = val;
  } else if (arg === '--keep-polling') {
    exitOnEmpty = false;
  }
}

console.log('================================================================');
console.log('MEDICINA 2029 — WORKER SOB DEMANDA (SEM VM PERMANENTE)');
console.log(`Configuração: maxJobs=${maxJobs}, maxDurationMs=${maxDurationMs}ms, exitOnEmpty=${exitOnEmpty}`);
console.log('================================================================');

// Executa via tsx para carregar o módulo TypeScript com todas as tipagens e guards
const tsRunner = `
import { executarWorkerSobDemanda } from './src/lib/workerOnDemand';

async function main() {
  try {
    const summary = await executarWorkerSobDemanda({
      maxJobs: ${maxJobs},
      maxDurationMs: ${maxDurationMs},
      exitOnEmptyQueue: ${exitOnEmpty},
      onJobProcessed: (res, idx) => {
        console.log(\`[Job \${idx}] ID: \${res.jobId} - Status: \${res.statusFinal} - Etapa: \${res.etapaAtual}\`);
      }
    });

    console.log('----------------------------------------------------------------');
    console.log('RESUMO DA EXECUÇÃO SOB DEMANDA:');
    console.log(\`- Worker ID: \${summary.workerId}\`);
    console.log(\`- Total Processados: \${summary.totalProcessados}\`);
    console.log(\`- Concluídos: \${summary.concluidos}\`);
    console.log(\`- Falhos: \${summary.falhos}\`);
    console.log(\`- Reagendados: \${summary.reagendados}\`);
    console.log(\`- Motivo de Parada: \${summary.motivoParada}\`);
    console.log(\`- Duração Total: \${(summary.duracaoMs / 1000).toFixed(2)}s\`);
    console.log('----------------------------------------------------------------');
    process.exit(0);
  } catch (error) {
    console.error('ERRO FATAL NO WORKER SOB DEMANDA:', error);
    process.exit(1);
  }
}

main();
`;

const proc = spawn('npx', ['tsx', '-e', tsRunner], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
});

proc.on('close', (code) => {
  process.exit(code ?? 0);
});
