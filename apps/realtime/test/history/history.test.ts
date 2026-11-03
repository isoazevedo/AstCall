import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyOps,
  emptySnapshot,
  SNAPSHOT_TABLES,
  type EntityName,
  type ServerConnectionStatus,
  type ServerSnapshot,
} from '@astcall/shared';
import { applyEvent } from '../../src/handlers/index.js';
import { HistoryRecorder } from '../../src/history/HistoryRecorder.js';
import { HistoryStore } from '../../src/history/HistoryStore.js';
import { ServerStore } from '../../src/state/ServerStore.js';
import { scopeSnapshot } from '../../src/state/visibility.js';
import { loadFixture } from '../helpers/replay.js';

/**
 * Máquina do tempo: o estado reconstruído (foto + deltas gravados) num horário qualquer tem
 * que ser idêntico ao estado ao vivo naquele horário — conferido com gravações reais.
 */

/** Ordena as listas pela chave de cada entidade (a ordem não faz parte do estado). */
function normalize(s: ServerSnapshot): ServerSnapshot {
  const out = { ...s };
  for (const entity of Object.keys(SNAPSHOT_TABLES) as EntityName[]) {
    const { field, key } = SNAPSHOT_TABLES[entity];
    const items = [...((s[field] ?? []) as never[])];
    (out as Record<string, unknown>)[field] = items.sort((a, b) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
    );
  }
  return out;
}

/** Fontes mínimas do gravador: store real, sincronização e conexão simuladas. */
function sources(store: ServerStore) {
  const sync = Object.assign(new EventEmitter(), { epoch: 1, syncing: false });
  const conn = Object.assign(new EventEmitter(), {
    status: 'ready' as ServerConnectionStatus,
  });
  return { store, sync, conn } as never as ConstructorParameters<typeof HistoryRecorder>[2] & {
    sync: typeof sync;
    conn: typeof conn;
  };
}

const opened: HistoryStore[] = [];
async function openHistory(): Promise<HistoryStore> {
  const h = await HistoryStore.open(':memory:');
  opened.push(h);
  return h;
}
afterEach(() => {
  vi.useRealTimers();
  for (const h of opened.splice(0)) h.close();
});

describe('applyOps', () => {
  it('insere, atualiza e remove sem alterar o snapshot original', () => {
    const base = emptySnapshot();
    base.queues = [{ name: 'suporte' } as never];
    const out = applyOps(base, [
      { op: 'upsert', entity: 'queue', id: 'vendas', data: { name: 'vendas' } as never },
      { op: 'upsert', entity: 'queue', id: 'suporte', data: { name: 'suporte', x: 1 } as never },
      { op: 'remove', entity: 'queue', id: 'vendas' },
    ]);
    expect(out.queues).toEqual([{ name: 'suporte', x: 1 }]);
    expect(base.queues).toEqual([{ name: 'suporte' }]);
  });
});

describe('histórico com gravações reais', () => {
  it.each([
    '01-chamada-atendida.jsonl',
    '04-transferencia-assistida.jsonl',
    '09-fila-dois-membros.jsonl',
    '10-fila-pausa.jsonl',
    '12-escuta.jsonl',
  ])('%s: estado reconstruído = estado ao vivo em cada horário', async (fixture) => {
    vi.useFakeTimers();
    const events = loadFixture(fixture);
    const history = await openHistory();
    const store = new ServerStore();
    let clock = events[0]!.t;
    const rec = new HistoryRecorder('pbx1', history, sources(store), {
      checkpointMs: 3_600_000, // fotos só quando o teste pedir
      now: () => clock,
    });

    // foto inicial (estado vazio) e, no meio do replay, uma segunda foto
    rec.checkpoint();
    const live = new Map<number, ServerSnapshot>();
    events.forEach((ev, i) => {
      clock = ev.t;
      applyEvent(store, ev.msg, ev.t);
      if (i === Math.floor(events.length / 2)) rec.checkpoint();
      // compara no fim de cada grupo de eventos com o mesmo horário
      const lastOfTs = events[i + 1]?.t !== ev.t;
      if (lastOfTs) {
        rec.flush();
        live.set(ev.t, store.snapshot());
      }
    });
    rec.close();

    expect(live.size).toBeGreaterThan(2);
    for (const [t, expected] of live) {
      const got = history.stateAt('pbx1', t);
      expect(got, `horário ${t}`).not.toBeNull();
      expect(normalize(got!.snapshot)).toEqual(normalize(expected));
    }
  });
});

describe('HistoryStore', () => {
  it('sem foto até o horário: null; com foto, aplica só os lotes posteriores a ela', async () => {
    const h = await openHistory();
    expect(h.stateAt('pbx1', 1000)).toBeNull();
    const q = (name: string) => ({ op: 'upsert', entity: 'queue', id: name, data: { name } });
    h.addBatches('pbx1', [{ ts: 900, ops: [q('antes')] as never }]);
    h.addCheckpoint('pbx1', 1000, { ...emptySnapshot(), queues: [{ name: 'antes' }] as never });
    // mesmo horário da foto, mas gravado depois dela: tem que entrar
    h.addBatches('pbx1', [{ ts: 1000, ops: [q('depois')] as never }]);
    h.addBatches('pbx1', [{ ts: 2000, ops: [q('futuro')] as never }]);
    // outro servidor não interfere
    h.addBatches('pbx2', [{ ts: 1500, ops: [q('outro')] as never }]);

    expect(h.stateAt('pbx1', 999)).toBeNull();
    expect(h.stateAt('pbx1', 1500)!.snapshot.queues.map((x) => x.name)).toEqual([
      'antes',
      'depois',
    ]);
    expect(h.stateAt('pbx1', 2000)!.snapshot.queues).toHaveLength(3);
    expect(h.firstAt('pbx1')).toBe(1000);
    expect(h.firstAt('pbx2')).toBeNull();
  });

  it('status da conexão no horário', async () => {
    const h = await openHistory();
    h.addCheckpoint('pbx1', 0, emptySnapshot());
    h.addStatus('pbx1', 100, 'ready');
    h.addStatus('pbx1', 200, 'disconnected');
    expect(h.stateAt('pbx1', 150)!.status).toBe('ready');
    expect(h.stateAt('pbx1', 250)!.status).toBe('disconnected');
  });

  it('prune apaga o antigo mas o horário do corte continua reconstruível', async () => {
    const h = await openHistory();
    const q = (name: string) => ({ op: 'upsert', entity: 'queue', id: name, data: { name } });
    h.addCheckpoint('pbx1', 0, emptySnapshot());
    h.addBatches('pbx1', [{ ts: 50, ops: [q('a')] as never }]);
    h.addCheckpoint('pbx1', 100, { ...emptySnapshot(), queues: [{ name: 'a' }] as never });
    h.addBatches('pbx1', [{ ts: 150, ops: [q('b')] as never }]);
    h.addCheckpoint('pbx1', 300, emptySnapshot());

    h.prune(200);
    expect(h.firstAt('pbx1')).toBe(100); // a foto de 100 cobre o horário 200
    expect(h.stateAt('pbx1', 50)).toBeNull();
    expect(h.stateAt('pbx1', 200)!.snapshot.queues.map((x) => x.name)).toEqual(['a', 'b']);
  });
});

describe('HistoryRecorder', () => {
  it('ignora deltas durante a ressincronização e grava uma foto ao terminar', async () => {
    vi.useFakeTimers();
    const h = await openHistory();
    const store = new ServerStore();
    const src = sources(store);
    let clock = 1000;
    const rec = new HistoryRecorder('pbx1', h, src, { checkpointMs: 60_000, now: () => clock });

    src.sync.syncing = true;
    store.emit('deltas', [{ op: 'remove', entity: 'queue', id: 'x' }]);
    store.queues.set('suporte', { name: 'suporte' } as never);
    clock = 2000;
    src.sync.syncing = false;
    src.sync.emit('synced', { epoch: 2, durationMs: 5 });
    src.conn.emit('status', 'ready');

    expect(h.stateAt('pbx1', 1500)).toBeNull();
    const at = h.stateAt('pbx1', 2000)!;
    expect(at.snapshot.queues.map((q) => q.name)).toEqual(['suporte']);
    expect(at.status).toBe('ready');

    // foto periódica pelo timer
    clock = 70_000;
    vi.advanceTimersByTime(60_000);
    expect(h.firstAt('pbx1')).toBe(2000);
    rec.close();
  });
});

describe('scopeSnapshot', () => {
  it('recorta pelo escopo usando os canais do próprio horário', () => {
    const ch = (uniqueid: string, endpointId: string, linkedid: string) =>
      ({ uniqueid, endpointId, linkedid, queue: null }) as never;
    const snap: ServerSnapshot = {
      ...emptySnapshot(),
      endpoints: [{ id: '9001' }, { id: '9002' }] as never,
      channels: [ch('a', '9001', 'a'), ch('b', 'Avoip', 'a'), ch('c', '9002', 'c')],
      calls: [
        { id: 'a', channelIds: ['a', 'b'] },
        { id: 'c', channelIds: ['c'] },
      ] as never,
      queues: [{ name: 'suporte' }, { name: 'vendas' }] as never,
    };
    const out = scopeSnapshot({ endpoints: ['9001'], queues: ['suporte'] }, snap);
    expect(out.endpoints.map((e) => e.id)).toEqual(['9001']);
    // a chamada do 9001 aparece inteira (inclusive o tronco do outro lado)
    expect(out.calls.map((c) => c.id)).toEqual(['a']);
    expect(out.channels.map((c) => c.uniqueid)).toEqual(['a', 'b']);
    expect(out.queues.map((q) => q.name)).toEqual(['suporte']);
  });
});
