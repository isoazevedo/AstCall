/**
 * Teste de carga do backend de tempo real, com PBX e navegadores simulados (nada externo).
 *
 * Uso (na raiz do repositório):
 *   npm run load-test
 *   npm run load-test -- --endpoints 1000 --calls 300 --clients 50 --scoped 20 --duration 120
 *   npm run load-test -- --out relatorio.json
 *
 * Opções (padrão entre parênteses):
 *   --endpoints (500)   ramais do PBX simulado
 *   --queues (10)       filas          --members (10)  membros por fila
 *   --calls (200)       chamadas simultâneas desejadas
 *   --talk (30)         duração média da conversa (s)
 *   --queue-ratio (0.4) fração das chamadas que passam por fila
 *   --clients (20)      navegadores vendo tudo (sem escopo)
 *   --scoped (10)       navegadores com escopo de empresa (10% dos ramais e 1 fila cada)
 *   --duration (60)     duração do teste (s)
 *   --out               grava o relatório em JSON
 *
 * Arquitetura: o backend real (AmiConnection → Synchronizer → ServerStore → ServerFeed → Hub)
 * roda na thread principal; o PBX simulado e os navegadores rodam em worker threads, para
 * que a medida de ocupação do event loop (ELU) seja só a do backend.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { WS_PATH, type ServerSnapshot } from '@astcall/shared';
import { AmiConnection } from '../src/ami/index.js';
import { LocalIssuer, TokenVerifier } from '../src/auth/index.js';
import type { AuthConfig } from '../src/config/index.js';
import { createLogger } from '../src/logger.js';
import { ServerStore } from '../src/state/ServerStore.js';
import { Synchronizer } from '../src/sync/Synchronizer.js';
import { Hub, ServerFeed } from '../src/ws/index.js';
import type { ClientsReply } from './load/clients.js';
import type { SimOptions, SimReply } from './load/pbx-sim.js';

const { values } = parseArgs({
  options: {
    endpoints: { type: 'string', default: '500' },
    queues: { type: 'string', default: '10' },
    members: { type: 'string', default: '10' },
    calls: { type: 'string', default: '200' },
    talk: { type: 'string', default: '30' },
    'queue-ratio': { type: 'string', default: '0.4' },
    clients: { type: 'string', default: '20' },
    scoped: { type: 'string', default: '10' },
    duration: { type: 'string', default: '60' },
    out: { type: 'string' },
  },
});
const num = (v: string | undefined) => Number(v);
const sim: SimOptions = {
  endpoints: num(values.endpoints),
  queues: num(values.queues),
  membersPerQueue: num(values.members),
  calls: num(values.calls),
  talkSeconds: num(values.talk),
  queueRatio: num(values['queue-ratio']),
};
const CLIENTS = num(values.clients);
const SCOPED = num(values.scoped);
const DURATION_S = num(values.duration);
const SAMPLE_MS = 5_000;

const log = createLogger('error', false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mb = (b: number) => Math.round(b / 1024 / 1024);

// ------------------------------------------------------------------ workers

/** Worker com o mesmo carregador TypeScript (tsx) e condições desta execução. */
function worker(file: string, data: unknown): Worker {
  return new Worker(new URL(file, import.meta.url), {
    workerData: data,
    execArgv: process.execArgv,
  });
}

function once<T extends { type: string }>(w: Worker, type: T['type']): Promise<T> {
  return new Promise((resolve) => {
    const fn = (m: T) => {
      if (m.type === type) {
        w.off('message', fn);
        resolve(m);
      }
    };
    w.on('message', fn);
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

// ------------------------------------------------------------------ main

console.log('AstCall — teste de carga (PBX e navegadores simulados)');
console.log(
  `  ${sim.endpoints} ramais · ${sim.queues} filas × ${sim.membersPerQueue} membros · ` +
    `${sim.calls} chamadas simultâneas (conversa ~${sim.talkSeconds}s, ${sim.queueRatio * 100}% por fila)`,
);
console.log(`  ${CLIENTS} navegadores sem escopo + ${SCOPED} com escopo · ${DURATION_S}s\n`);

// Chaves temporárias para emitir tokens dos navegadores simulados
const dir = mkdtempSync(join(tmpdir(), 'astcall-load-'));
const keys = await generateKeyPair('RS256', { extractable: true });
writeFileSync(join(dir, 'priv.pem'), await exportPKCS8(keys.privateKey));
writeFileSync(join(dir, 'pub.pem'), await exportSPKI(keys.publicKey));
const auth: AuthConfig = {
  mode: 'local',
  ttlSeconds: 3600,
  local: {
    issuer: 'astcall',
    privateKeyFile: join(dir, 'priv.pem'),
    publicKeyFile: join(dir, 'pub.pem'),
    usersDbFile: ':memory:',
    refreshTtlHours: 1,
    cookieSecure: false,
  },
  external: { issuer: 'azcall', publicKeyFile: undefined },
};
const issuer = await LocalIssuer.create(auth);
const verifier = await TokenVerifier.create(auth);

// 1. PBX simulado
const pbx = worker('./load/pbx-sim.ts', sim);
const { port: amiPort } = await once<Extract<SimReply, { type: 'listening' }>>(pbx, 'listening');

// 2. Backend real
const store = new ServerStore();
const conn = new AmiConnection(
  {
    id: 'pbx1',
    name: 'Simulado',
    host: '127.0.0.1',
    port: amiPort,
    enabled: true,
    username: 'load',
    secret: 'load',
  },
  log,
);
const sync = new Synchronizer(conn, store, log);
const feed = new ServerFeed('pbx1', 'Simulado', { store, sync, conn });
const hub = new Hub(new Map([['pbx1', feed]]), verifier, log);
const http = createServer();
hub.attach(http);
await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}${WS_PATH}`;

const synced = new Promise<{ durationMs: number }>((r) => sync.once('synced', r));
conn.start();
const firstSync = await synced;
console.log(
  `Sincronização inicial: ${firstSync.durationMs} ms (${store.endpoints.size} ramais, ` +
    `${store.queueMembers.size} membros de fila)`,
);

// 3. Tokens: o primeiro cliente (auditor) vê tudo; os com escopo veem 10% dos ramais
const tokens: string[] = [];
const scopes: (string[] | null)[] = [];
for (let i = 0; i < CLIENTS; i++) {
  scopes.push(null);
  tokens.push(
    (await issuer.issue({ username: `tv${i}`, name: `TV ${i}`, perms: { '*': ['view'] } })).token,
  );
}
const slice = Math.max(1, Math.floor(sim.endpoints / 10));
for (let i = 0; i < SCOPED; i++) {
  const start = (i * slice) % sim.endpoints;
  const endpoints = Array.from({ length: slice }, (_, k) =>
    String(10000 + ((start + k) % sim.endpoints)),
  );
  const queues = sim.queues > 0 ? [`fila${i % sim.queues}-sim`] : [];
  scopes.push(endpoints);
  tokens.push(
    await new SignJWT({
      name: `Empresa ${i}`,
      perms: { pbx1: ['view'] },
      scope: { pbx1: { endpoints, queues } },
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject(`empresa${i}`)
      .setIssuer('astcall')
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(keys.privateKey),
  );
}

// 4. Navegadores simulados
const clients = worker('./load/clients.ts', { url, tokens, scopes });
await once<Extract<ClientsReply, { type: 'ready' }>>(clients, 'ready');
console.log(`${tokens.length} navegadores conectados e com snapshot.\n`);

// 5. Carga + amostragem
pbx.postMessage({ cmd: 'start' });
const samples: Record<string, number>[] = [];
const allLatencies: number[] = [];
const allScopedLatencies: number[] = [];
let lastElu = performance.eventLoopUtilization();
let lastCpu = process.cpuUsage();
let lastEvents = 0;
let lastMessages = 0;
let lastBytes = 0;
let lastTime = Date.now();
let resyncs = 0;
let closed = 0;
let peakRss = 0;
const totalClients = tokens.length;

console.log(
  '   t  eventos/s  ELU%  CPU%  RSS(MB) heap(MB)  canais chamadas aguard.  msg/s/nav  KB/s/nav  lat.p50  lat.p95',
);
const started = Date.now();
while (Date.now() - started < DURATION_S * 1000) {
  await sleep(SAMPLE_MS);
  pbx.postMessage({ cmd: 'stats' });
  clients.postMessage({ cmd: 'stats' });
  const [s, c] = await Promise.all([
    once<Extract<SimReply, { type: 'stats' }>>(pbx, 'stats'),
    once<Extract<ClientsReply, { type: 'stats' }>>(clients, 'stats'),
  ]);
  const now = Date.now();
  const dt = (now - lastTime) / 1000;
  const elu = performance.eventLoopUtilization(lastElu);
  const cpu = process.cpuUsage(lastCpu);
  const mem = process.memoryUsage();
  peakRss = Math.max(peakRss, mem.rss);
  const lat = [...c.latencies].sort((a, b) => a - b);
  allLatencies.push(...c.latencies);
  allScopedLatencies.push(...c.scopedLatencies);
  resyncs = c.resyncs;
  closed = c.closed;
  const row = {
    t: Math.round((now - started) / 1000),
    eventsPerSec: Math.round((s.events - lastEvents) / dt),
    elu: Math.round(elu.utilization * 100),
    // CPU do processo inteiro (inclui as threads do PBX e dos navegadores simulados)
    cpu: Math.round(((cpu.user + cpu.system) / 1000 / (dt * 1000)) * 100),
    rssMb: mb(mem.rss),
    heapMb: mb(mem.heapUsed),
    channels: store.channels.size,
    calls: store.calls.size,
    waiting: store.queueEntries.size,
    msgPerSecPerClient: Math.round((c.messages - lastMessages) / dt / totalClients),
    kbPerSecPerClient: Math.round((c.bytes - lastBytes) / dt / totalClients / 1024),
    latP50: percentile(lat, 50),
    latP95: percentile(lat, 95),
  };
  samples.push(row);
  console.log(
    `${String(row.t).padStart(4)}  ${String(row.eventsPerSec).padStart(9)}  ${String(row.elu).padStart(4)}  ` +
      `${String(row.cpu).padStart(4)}  ${String(row.rssMb).padStart(7)}  ${String(row.heapMb).padStart(7)}  ` +
      `${String(row.channels).padStart(6)}  ${String(row.calls).padStart(8)}  ${String(row.waiting).padStart(7)}  ` +
      `${String(row.msgPerSecPerClient).padStart(9)}  ${String(row.kbPerSecPerClient).padStart(8)}  ` +
      `${String(row.latP50).padStart(5)}ms  ${String(row.latP95).padStart(5)}ms`,
  );
  lastElu = performance.eventLoopUtilization();
  lastCpu = process.cpuUsage();
  lastEvents = s.events;
  lastMessages = c.messages;
  lastBytes = c.bytes;
  lastTime = now;
}

// 6. Para a carga e confere: a cópia do auditor (snapshot + deltas) = estado do servidor
pbx.postMessage({ cmd: 'stop' });
await once(pbx, 'stopped');
await sleep(1_000); // deixa sair o último lote
clients.postMessage({ cmd: 'mirror' });
const { state } = await once<Extract<ClientsReply, { type: 'mirror' }>>(clients, 'mirror');
const server = store.snapshot();
const idOf = (key: string, e: Record<string, unknown>) =>
  String(key === 'endpoints' || key === 'queues' ? (e.id ?? e.name) : (e.id ?? e.uniqueid));
const diffs: string[] = [];
for (const key of Object.keys(server) as (keyof ServerSnapshot)[]) {
  const mine = new Map(state[key] ?? []);
  const theirs = server[key] as unknown as Record<string, unknown>[];
  if (mine.size !== theirs.length)
    diffs.push(`${key}: navegador ${mine.size} × servidor ${theirs.length}`);
  for (const e of theirs) {
    const id = idOf(key, e);
    if (JSON.stringify(mine.get(id)) !== JSON.stringify(e)) {
      diffs.push(`${key} ${id} diferente`);
      if (diffs.length > 10) break;
    }
  }
}

// 7. Relatório
const sorted = allLatencies.sort((a, b) => a - b);
const sortedScoped = allScopedLatencies.sort((a, b) => a - b);
const steady = samples.slice(1); // descarta a rampa inicial
const avg = (k: string) =>
  Math.round(steady.reduce((a, s) => a + (s[k] ?? 0), 0) / Math.max(1, steady.length));
const max = (k: string) => Math.max(0, ...steady.map((s) => s[k] ?? 0));
const report = {
  config: { ...sim, clients: CLIENTS, scoped: SCOPED, durationS: DURATION_S },
  initialSyncMs: firstSync.durationMs,
  eventsPerSec: { avg: avg('eventsPerSec'), max: max('eventsPerSec') },
  eluPercent: { avg: avg('elu'), max: max('elu') },
  peakRssMb: mb(peakRss),
  latencyMs: {
    samples: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  },
  scopedLatencyMs: {
    samples: sortedScoped.length,
    p50: percentile(sortedScoped, 50),
    p95: percentile(sortedScoped, 95),
    p99: percentile(sortedScoped, 99),
    max: sortedScoped.at(-1) ?? 0,
  },
  perClient: { msgPerSec: avg('msgPerSecPerClient'), kbPerSec: avg('kbPerSecPerClient') },
  resyncs,
  clientsClosed: closed,
  consistent: diffs.length === 0,
  diffs,
  samples,
};

console.log('\nResumo');
console.log(`  Sincronização inicial: ${report.initialSyncMs} ms`);
console.log(`  Eventos AMI/s: média ${report.eventsPerSec.avg}, pico ${report.eventsPerSec.max}`);
console.log(
  `  Ocupação do event loop do backend: média ${report.eluPercent.avg}%, pico ${report.eluPercent.max}%`,
);
console.log(`  Memória (RSS do processo): pico ${report.peakRssMb} MB`);
console.log(
  `  Latência PBX → navegador sem escopo (${report.latencyMs.samples} amostras): p50 ${report.latencyMs.p50} ms · ` +
    `p95 ${report.latencyMs.p95} ms · p99 ${report.latencyMs.p99} ms · máx ${report.latencyMs.max} ms`,
);
console.log(
  `  Latência com escopo (${report.scopedLatencyMs.samples} amostras): p50 ${report.scopedLatencyMs.p50} ms · ` +
    `p95 ${report.scopedLatencyMs.p95} ms · p99 ${report.scopedLatencyMs.p99} ms · máx ${report.scopedLatencyMs.max} ms`,
);
console.log(
  `  Por navegador: ${report.perClient.msgPerSec} msg/s, ${report.perClient.kbPerSec} KB/s`,
);
console.log(`  Ressincronizações: ${resyncs} · conexões perdidas: ${closed}`);
console.log(
  report.consistent
    ? '  Consistência: OK (snapshot + deltas do navegador = estado do servidor)'
    : `  Consistência: DIVERGIU\n    ${diffs.join('\n    ')}`,
);
if (values.out) {
  writeFileSync(values.out, JSON.stringify(report, null, 2));
  console.log(`\nRelatório gravado em ${values.out}`);
}

// 8. Encerramento
clients.postMessage({ cmd: 'close' });
hub.close();
feed.close();
http.close();
await conn.stop();
await pbx.terminate();
rmSync(dir, { recursive: true, force: true });
process.exit(report.consistent && closed === 0 ? 0 : 1);
