import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeltaOp, ServerSnapshot } from '@astcall/shared';
import type { AmiMessage } from '../../src/ami/types.js';
import type { RecordLine } from '../../src/ami/AmiRecorder.js';
import { applyEvent } from '../../src/handlers/index.js';
import { ServerStore } from '../../src/state/ServerStore.js';

export interface FixtureEvent {
  t: number;
  msg: AmiMessage;
}

/** Carrega uma fixture (gravação anonimizada) de test/fixtures. */
export function loadFixture(name: string): FixtureEvent[] {
  const raw = readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as RecordLine)
    .filter((l): l is FixtureEvent => 'msg' in l);
}

/**
 * Reproduz os eventos no store, parando logo após o primeiro evento que satisfaz `until`
 * (ou no fim da fixture). `repeat` aplica cada evento N vezes (teste de idempotência).
 */
export function replay(
  events: FixtureEvent[],
  options: { until?: (msg: AmiMessage) => boolean; repeat?: number; store?: ServerStore } = {},
): { store: ServerStore; snapshot: ServerSnapshot; deltas: DeltaOp[] } {
  const store = options.store ?? new ServerStore();
  const deltas: DeltaOp[] = [];
  for (const ev of events) {
    for (let i = 0; i < (options.repeat ?? 1); i++) deltas.push(...applyEvent(store, ev.msg, ev.t));
    if (options.until?.(ev.msg)) break;
  }
  return { store, snapshot: store.snapshot(), deltas };
}

/** Predicado: evento `event` cujo canal começa com `channelPrefix` (opcional). */
export function at(event: string, channelPrefix?: string) {
  return (msg: AmiMessage) =>
    msg.event === event && (!channelPrefix || (msg.channel ?? '').startsWith(channelPrefix));
}

/** Predicado que só é verdadeiro na N-ésima ocorrência (1 = primeira) de `match`. */
export function nth(n: number, match: (msg: AmiMessage) => boolean) {
  let count = 0;
  return (msg: AmiMessage) => match(msg) && ++count === n;
}

/** Uniqueid do canal cujo nome começa com o prefixo (ex.: "PJSIP/9002"). */
export function uid(snapshot: ServerSnapshot, prefix: string): string {
  const ch = snapshot.channels.find((c) => c.name.startsWith(prefix));
  if (!ch) throw new Error(`Canal ${prefix} não encontrado no snapshot`);
  return ch.uniqueid;
}

/** Normaliza os grupos de links para comparação (ordem não importa). */
export function linksByName(snapshot: ServerSnapshot, callId: string): string[][] {
  const call = snapshot.calls.find((c) => c.id === callId);
  if (!call) throw new Error(`Chamada ${callId} não encontrada`);
  const name = (id: string) =>
    snapshot.channels.find((c) => c.uniqueid === id)!.name.replace(/-[0-9a-f]+$/, '');
  return call.links.map((g) => g.map(name).sort()).sort();
}
