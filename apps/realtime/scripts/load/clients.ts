/**
 * Navegadores simulados para o teste de carga (roda numa worker thread).
 *
 * Cada cliente abre o WebSocket, autentica, recebe snapshot + deltas e:
 * - mede a latência: quando um canal novo com CallerIDName "lt:<ms>" chega, calcula
 *   agora − <ms> (do evento no PBX simulado até o navegador, incluindo o lote de 50 ms).
 *   Com escopo, só conta chamadas originadas por ramal da empresa: uma chamada de fora só
 *   fica visível quando passa a envolver a empresa (ex.: o membro atende depois da espera),
 *   e esse tempo é espera do chamador, não atraso de entrega;
 * - conta mensagens, bytes e ressincronizações (lacuna de seq);
 * - o cliente 0 ("auditor") mantém uma cópia completa do estado, comparada no fim com o
 *   estado do servidor.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { WebSocket } from 'ws';
import type { DeltaOp, ServerMessage, ServerSnapshot } from '@astcall/shared';

export interface ClientsOptions {
  url: string;
  tokens: string[];
  /** Ramais do escopo de cada token (null = sem escopo). */
  scopes: (string[] | null)[];
}

export type ClientsCommand = { cmd: 'stats' } | { cmd: 'mirror' } | { cmd: 'close' };
export type ClientsReply =
  | { type: 'ready'; connected: number }
  | {
      type: 'stats';
      messages: number;
      bytes: number;
      latencies: number[];
      scopedLatencies: number[];
      resyncs: number;
      closed: number;
    }
  | { type: 'mirror'; state: Record<string, [string, unknown][]> };

const opts = workerData as ClientsOptions;

const KEYS: Record<DeltaOp['entity'], keyof ServerSnapshot> = {
  endpoint: 'endpoints',
  channel: 'channels',
  bridge: 'bridges',
  call: 'calls',
  queue: 'queues',
  queueMember: 'queueMembers',
  queueEntry: 'queueEntries',
};

let messages = 0;
let bytes = 0;
let latencies: number[] = [];
let scopedLatencies: number[] = [];
let resyncs = 0;
let closed = 0;
const mirror = new Map<keyof ServerSnapshot, Map<string, unknown>>();

const idOf = (key: keyof ServerSnapshot, e: Record<string, unknown>) =>
  String(key === 'endpoints' || key === 'queues' ? (e.id ?? e.name) : (e.id ?? e.uniqueid));

function latencyFrom(ops: DeltaOp[], seen: Set<string>, scope: Set<string> | null): void {
  const now = Date.now();
  for (const op of ops) {
    if (op.op !== 'upsert' || op.entity !== 'channel' || seen.has(op.id)) continue;
    seen.add(op.id);
    const { name, num } = op.data.callerId;
    if (!name.startsWith('lt:')) continue;
    const ms = now - Number(name.slice(3));
    if (!scope) latencies.push(ms);
    else if (scope.has(num)) scopedLatencies.push(ms);
  }
}

function connect(token: string, auditor: boolean, scopeList: string[] | null): Promise<void> {
  const scope = scopeList ? new Set(scopeList) : null;
  return new Promise((resolve) => {
    const ws = new WebSocket(opts.url);
    const seenChannels = new Set<string>();
    const lastSeq = new Map<string, number>();
    ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token })));
    ws.on('close', () => closed++);
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      const text = raw.toString();
      messages++;
      bytes += text.length;
      const msg = JSON.parse(text) as ServerMessage;
      if (msg.t === 'auth_ok') {
        // como o painel: assina todos os servidores liberados no login
        ws.send(JSON.stringify({ t: 'subscribe', servers: msg.servers.map((x) => x.id) }));
      } else if (msg.t === 'snapshot') {
        lastSeq.set(msg.server, msg.seq);
        for (const ch of msg.data.channels) seenChannels.add(ch.uniqueid);
        if (auditor) {
          for (const key of Object.values(KEYS)) {
            const list = msg.data[key] as unknown as Record<string, unknown>[];
            mirror.set(key, new Map(list.map((e) => [idOf(key, e), e])));
          }
        }
        resolve();
      } else if (msg.t === 'delta') {
        const prev = lastSeq.get(msg.server);
        if (prev !== undefined && msg.seq !== prev + 1) {
          // perdeu um lote: pede o estado completo, como o painel faz
          resyncs++;
          ws.send(JSON.stringify({ t: 'resync', server: msg.server }));
        }
        lastSeq.set(msg.server, msg.seq);
        latencyFrom(msg.ops, seenChannels, scope);
        if (auditor) {
          for (const op of msg.ops) {
            const map = mirror.get(KEYS[op.entity])!;
            if (op.op === 'upsert') map.set(op.id, op.data);
            else map.delete(op.id);
          }
        }
      }
    });
  });
}

await Promise.all(opts.tokens.map((t, i) => connect(t, i === 0, opts.scopes[i] ?? null)));
parentPort!.postMessage({ type: 'ready', connected: opts.tokens.length } satisfies ClientsReply);

parentPort!.on('message', (m: ClientsCommand) => {
  if (m.cmd === 'stats') {
    parentPort!.postMessage({
      type: 'stats',
      messages,
      bytes,
      latencies,
      scopedLatencies,
      resyncs,
      closed,
    } satisfies ClientsReply);
    latencies = [];
    scopedLatencies = [];
  } else if (m.cmd === 'mirror') {
    const state: Record<string, [string, unknown][]> = {};
    for (const [k, map] of mirror) state[k] = [...map.entries()];
    parentPort!.postMessage({ type: 'mirror', state } satisfies ClientsReply);
  } else if (m.cmd === 'close') {
    process.exit(0);
  }
});
