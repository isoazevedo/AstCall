import type { DeltaOp, EntityName, ServerSnapshot } from './delta.js';

/**
 * Onde cada entidade fica no snapshot e qual campo é a sua chave (o mesmo `id` dos deltas).
 * Usado para aplicar deltas a um snapshot — por exemplo, para reconstruir o estado de um
 * horário passado a partir de uma foto e das alterações gravadas depois dela.
 */
export const SNAPSHOT_TABLES: {
  [K in EntityName]: { field: keyof ServerSnapshot; key: (item: never) => string };
} = {
  endpoint: { field: 'endpoints', key: (e: { id: string }) => e.id },
  channel: { field: 'channels', key: (c: { uniqueid: string }) => c.uniqueid },
  bridge: { field: 'bridges', key: (b: { id: string }) => b.id },
  call: { field: 'calls', key: (c: { id: string }) => c.id },
  queue: { field: 'queues', key: (q: { name: string }) => q.name },
  queueMember: { field: 'queueMembers', key: (m: { id: string }) => m.id },
  queueEntry: { field: 'queueEntries', key: (e: { id: string }) => e.id },
  queueForecast: { field: 'queueForecasts', key: (f: { queue: string }) => f.queue },
};

/** Snapshot vazio (servidor sem nada). */
export function emptySnapshot(): ServerSnapshot {
  return {
    endpoints: [],
    channels: [],
    bridges: [],
    calls: [],
    queues: [],
    queueMembers: [],
    queueEntries: [],
    queueForecasts: [],
  };
}

/**
 * Aplica deltas a um snapshot e devolve um snapshot novo (o original não é alterado).
 * A ordem dos itens de cada lista segue a de inserção: os que já existiam ficam no lugar,
 * os novos entram no fim — como no store do backend.
 */
export function applyOps(snapshot: ServerSnapshot, ops: readonly DeltaOp[]): ServerSnapshot {
  const tables = new Map<EntityName, Map<string, unknown>>();
  const table = (entity: EntityName) => {
    let t = tables.get(entity);
    if (!t) {
      const { field, key } = SNAPSHOT_TABLES[entity];
      const items = (snapshot[field] ?? []) as never[];
      t = new Map(items.map((item) => [key(item), item]));
      tables.set(entity, t);
    }
    return t;
  };
  for (const op of ops) {
    if (op.op === 'upsert') table(op.entity).set(op.id, op.data);
    else table(op.entity).delete(op.id);
  }
  const out = { ...snapshot };
  for (const [entity, t] of tables) {
    (out as Record<string, unknown>)[SNAPSHOT_TABLES[entity].field] = [...t.values()];
  }
  return out;
}
