/**
 * Modo demonstração: PBX simulado + backend real, sem nenhum Asterisk.
 *
 * Uso (na raiz do repositório):
 *   npm run demo          → PBX simulado na porta 5039 + backend na porta 8090
 *   npm run dev:web       → (outro terminal) painel em http://localhost:5173
 *
 * Opções: --endpoints (40) --queues (3) --members (4) --calls (16) --talk (90)
 *
 * O PBX simulado gera chamadas diretas e chamadas de clientes pelas filas (Suporte, Vendas,
 * Financeiro...), com ramais 2001+ com nomes de pessoas, alguns desconectados e alguns
 * membros pausados. Nada é real: serve para conhecer o painel, testar e tirar prints.
 *
 * O login é o do modo standalone (usuários de `npm run user`). Pare o `npm run dev:realtime`
 * antes: os dois usam a porta 8090.
 */
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import type { SimOptions, SimReply } from './load/pbx-sim.js';

const { values } = parseArgs({
  options: {
    endpoints: { type: 'string', default: '40' },
    queues: { type: 'string', default: '3' },
    members: { type: 'string', default: '4' },
    calls: { type: 'string', default: '16' },
    talk: { type: 'string', default: '90' },
  },
});

const PORT = 5039; // a mesma de config/servers.demo.json
const sim: SimOptions = {
  endpoints: Number(values.endpoints),
  queues: Number(values.queues),
  membersPerQueue: Number(values.members),
  calls: Number(values.calls),
  talkSeconds: Number(values.talk),
  queueRatio: 0.7,
  port: PORT,
  demo: true,
};

const pbx = new Worker(new URL('./load/pbx-sim.ts', import.meta.url), {
  workerData: sim,
  execArgv: process.execArgv,
});
await new Promise<void>((resolve, reject) => {
  pbx.on('error', reject);
  pbx.on('message', (m: SimReply) => m.type === 'listening' && resolve());
});
pbx.postMessage({ cmd: 'start' });
console.log(
  `PBX de demonstração na porta ${PORT}: ${sim.endpoints} ramais, ${sim.queues} filas, ` +
    `~${sim.calls} chamadas simultâneas.`,
);

// Backend real apontando para o PBX simulado (variáveis definidas aqui têm precedência
// sobre o .env). O main.ts inicia o backend ao ser importado.
process.env.SERVERS_FILE = 'config/servers.demo.json';
process.env.AMI_DEMO_USERNAME = 'demo';
process.env.AMI_DEMO_SECRET = 'demo';
await import('../src/main.js');
