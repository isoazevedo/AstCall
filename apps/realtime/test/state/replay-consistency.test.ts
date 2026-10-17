import { describe, expect, it } from 'vitest';
import type { DeltaOp, ServerSnapshot } from '@astcall/shared';
import { compact } from '../../src/ws/index.js';
import { loadFixture, replay } from '../helpers/replay.js';

/**
 * Consistência do protocolo com as gravações reais: um cliente que recebe o snapshot em
 * QUALQUER ponto e depois só os deltas (como o navegador) tem que chegar exatamente ao
 * estado do servidor — inclusive com os deltas compactados em lotes, como o ServerFeed envia.
 */

const FIXTURES = [
  '01-chamada-atendida.jsonl',
  '02-nao-atendida.jsonl',
  '03-transferencia-cega.jsonl',
  '04-transferencia-assistida.jsonl',
  '05-fila.jsonl',
  '06-registro-ramal.jsonl',
  '07-espera-e-retomada.jsonl',
  '08-fila-abandono.jsonl',
  '09-fila-dois-membros.jsonl',
  '10-fila-pausa.jsonl',
  '11-acoes-painel.jsonl',
  '12-escuta.jsonl',
];

const KEYS = {
  endpoint: 'endpoints',
  channel: 'channels',
  bridge: 'bridges',
  call: 'calls',
  queue: 'queues',
  queueMember: 'queueMembers',
  queueEntry: 'queueEntries',
} as const satisfies Record<DeltaOp['entity'], keyof ServerSnapshot>;

/** Estado do "navegador": um mapa por entidade, montado do snapshot e atualizado por deltas. */
type Mirror = Record<keyof ServerSnapshot, Map<string, unknown>>;

const idOf = (key: keyof ServerSnapshot, e: Record<string, unknown>) =>
  String(key === 'endpoints' || key === 'queues' ? (e.id ?? e.name) : (e.id ?? e.uniqueid));

function mirrorFrom(snapshot: ServerSnapshot): Mirror {
  const m = {} as Mirror;
  for (const key of Object.values(KEYS)) {
    m[key] = new Map(
      (snapshot[key] as unknown as Record<string, unknown>[]).map((e) => [idOf(key, e), e]),
    );
  }
  return m;
}

function apply(m: Mirror, ops: DeltaOp[]): void {
  for (const op of ops) {
    const map = m[KEYS[op.entity]];
    if (op.op === 'upsert') map.set(op.id, structuredClone(op.data));
    else map.delete(op.id);
  }
}

/** Forma comparável: entidades ordenadas por id. */
function normalize(m: Mirror) {
  return Object.fromEntries(
    Object.entries(m).map(([k, map]) => [
      k,
      [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ]),
  );
}

describe('replay: snapshot + deltas = estado do servidor', () => {
  it.each(FIXTURES)('%s (snapshot em vários pontos, deltas um a um)', (name) => {
    const events = loadFixture(name);
    const final = mirrorFrom(replay(events).snapshot);
    for (let cut = 0; cut <= events.length; cut += Math.max(1, Math.floor(events.length / 15))) {
      const first = replay(events.slice(0, cut));
      const rest = replay(events.slice(cut), { store: first.store });
      const client = mirrorFrom(first.snapshot);
      apply(client, rest.deltas);
      expect(normalize(client), `corte no evento ${cut}`).toEqual(normalize(final));
    }
  });

  it.each(FIXTURES)('%s (deltas compactados em lotes, como o ServerFeed)', (name) => {
    const events = loadFixture(name);
    const { store, snapshot } = replay([]);
    const client = mirrorFrom(snapshot);
    // Lotes de tamanhos variados simulam a janela de 50 ms com tráfego irregular
    const sizes = [1, 3, 7, 2, 13];
    let i = 0;
    let batch = 0;
    while (i < events.length) {
      const size = sizes[batch++ % sizes.length]!;
      const { deltas } = replay(events.slice(i, i + size), { store });
      apply(client, compact(deltas));
      i += size;
    }
    expect(normalize(client)).toEqual(normalize(mirrorFrom(store.snapshot())));
  });
});
