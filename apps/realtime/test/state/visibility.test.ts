import { describe, expect, it } from 'vitest';
import type { DeltaOp, ServerScope, ServerSnapshot } from '@astcall/shared';
import { applyEvent } from '../../src/handlers/index.js';
import { ServerStore } from '../../src/state/ServerStore.js';
import { ScopedView, ScopeFilter } from '../../src/state/visibility.js';
import { loadFixture } from '../helpers/replay.js';

/** Cliente simulado: aplica snapshot/deltas como o navegador faria. */
function clientState(snapshot: ServerSnapshot) {
  const t = {
    endpoint: new Map(snapshot.endpoints.map((e) => [e.id, e])),
    channel: new Map(snapshot.channels.map((c) => [c.uniqueid, c])),
    bridge: new Map(snapshot.bridges.map((b) => [b.id, b])),
    call: new Map(snapshot.calls.map((c) => [c.id, c])),
    queue: new Map(snapshot.queues.map((q) => [q.name, q])),
    queueMember: new Map(snapshot.queueMembers.map((m) => [m.id, m])),
    queueEntry: new Map(snapshot.queueEntries.map((e) => [e.id, e])),
  } as Record<string, Map<string, unknown>>;
  return {
    apply(ops: DeltaOp[]) {
      for (const op of ops) {
        if (op.op === 'upsert') t[op.entity]!.set(op.id, op.data);
        else t[op.entity]!.delete(op.id);
      }
    },
    ids: () => Object.fromEntries(Object.entries(t).map(([k, m]) => [k, [...m.keys()].sort()])),
  };
}

const idsOf = (s: ServerSnapshot) => clientState(s).ids();

const SCOPES: Record<string, ServerScope> = {
  'só o 9001': { endpoints: ['9001'], queues: [] },
  'só o 9005': { endpoints: ['9005'], queues: [] },
  'fila suporte': { endpoints: [], queues: ['suporte-default'] },
  nada: { endpoints: [], queues: [] },
};

const FIXTURES = [
  '01-chamada-atendida.jsonl',
  '03-transferencia-cega.jsonl',
  '04-transferencia-assistida.jsonl',
  '05-fila.jsonl',
  '09-fila-dois-membros.jsonl',
  '11-acoes-painel.jsonl',
  '12-escuta.jsonl',
];

describe('ScopedView: deltas recortados reproduzem o snapshot recortado', () => {
  for (const fixture of FIXTURES) {
    for (const [scopeName, scope] of Object.entries(SCOPES)) {
      it(`${fixture} com escopo "${scopeName}"`, () => {
        const store = new ServerStore();
        const view = new ScopedView(new ScopeFilter(scope, store));
        const client = clientState(view.snapshot(store.snapshot()));
        for (const { t, msg } of loadFixture(fixture)) {
          client.apply(view.deltas(applyEvent(store, msg, t), store));
          // em TODO ponto da gravação o cliente tem exatamente o recorte do estado
          const expected = idsOf(new ScopeFilter(scope, store).filterSnapshot(store.snapshot()));
          expect(client.ids()).toEqual(expected);
        }
      });
    }
  }
});

describe('ScopeFilter: regras', () => {
  it('chamada da empresa mostra também o canal do outro lado (outra empresa/tronco)', () => {
    const store = new ServerStore();
    for (const { t, msg } of loadFixture('01-chamada-atendida.jsonl')) {
      applyEvent(store, msg, t);
      if (msg.event === 'BridgeEnter' && msg.channel?.startsWith('PJSIP/9002')) break;
    }
    const s = new ScopeFilter({ endpoints: ['9001'], queues: [] }, store).filterSnapshot(
      store.snapshot(),
    );
    expect(s.calls).toHaveLength(1);
    expect(s.channels.map((c) => c.name.slice(0, 10)).sort()).toEqual(['PJSIP/9001', 'PJSIP/9002']);
    expect(s.endpoints.map((e) => e.id)).toEqual(['9001']); // o ramal 9002 em si não aparece
  });

  it('fila da empresa: chamada que passou por ela é visível; fila de outra empresa não', () => {
    const store = new ServerStore();
    for (const { t, msg } of loadFixture('09-fila-dois-membros.jsonl')) {
      applyEvent(store, msg, t);
      if (msg.event === 'AgentConnect') break;
    }
    const suporte = new ScopeFilter({ endpoints: [], queues: ['suporte-default'] }, store);
    const marcacao = new ScopeFilter({ endpoints: [], queues: ['marcacao-default'] }, store);
    expect(suporte.filterSnapshot(store.snapshot()).calls).toHaveLength(1);
    expect(marcacao.filterSnapshot(store.snapshot()).calls).toHaveLength(0);
    expect(
      marcacao
        .filterSnapshot(store.snapshot())
        .queueMembers.every((m) => m.queue === 'marcacao-default'),
    ).toBe(true);
  });
});
