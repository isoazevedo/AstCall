import type {
  Bridge,
  Call,
  Channel,
  DeltaMessage,
  Endpoint,
  Queue,
  QueueEntry,
  QueueMember,
  ServerConnectionStatus,
  ServerInfo,
  SnapshotMessage,
} from '@astcall/shared';

/**
 * Estado de UM servidor Asterisk no navegador.
 * Usa objetos simples (Record) para funcionar bem com a reatividade do Vue.
 */
export interface ServerState {
  id: string;
  name: string;
  status: ServerConnectionStatus;
  /** Já recebeu um snapshot do epoch atual (o estado na tela é confiável)? */
  hasSnapshot: boolean;
  epoch: number | null;
  seq: number;
  endpoints: Record<string, Endpoint>;
  channels: Record<string, Channel>;
  bridges: Record<string, Bridge>;
  calls: Record<string, Call>;
  queues: Record<string, Queue>;
  queueMembers: Record<string, QueueMember>;
  queueEntries: Record<string, QueueEntry>;
}

export function createServerState(info: ServerInfo): ServerState {
  return {
    id: info.id,
    name: info.name,
    status: info.status,
    hasSnapshot: false,
    epoch: null,
    seq: 0,
    endpoints: {},
    channels: {},
    bridges: {},
    calls: {},
    queues: {},
    queueMembers: {},
    queueEntries: {},
  };
}

const byKey = <T>(items: T[], key: (item: T) => string): Record<string, T> =>
  Object.fromEntries(items.map((item) => [key(item), item]));

/** Substitui todo o estado pelo snapshot. */
export function applySnapshot(state: ServerState, msg: SnapshotMessage): void {
  state.epoch = msg.epoch;
  state.seq = msg.seq;
  state.endpoints = byKey(msg.data.endpoints, (e) => e.id);
  state.channels = byKey(msg.data.channels, (c) => c.uniqueid);
  state.bridges = byKey(msg.data.bridges, (b) => b.id);
  state.calls = byKey(msg.data.calls, (c) => c.id);
  state.queues = byKey(msg.data.queues ?? [], (q) => q.name);
  state.queueMembers = byKey(msg.data.queueMembers ?? [], (m) => m.id);
  state.queueEntries = byKey(msg.data.queueEntries ?? [], (e) => e.id);
  state.hasSnapshot = true;
}

/**
 * Aplica um lote de deltas. Retorna 'gap' (sem aplicar nada) se o lote não for o próximo
 * esperado — o chamador deve pedir um `resync`. Lotes antigos/duplicados são ignorados.
 */
export function applyDelta(state: ServerState, msg: DeltaMessage): 'ok' | 'gap' | 'ignored' {
  if (!state.hasSnapshot || msg.epoch !== state.epoch) return 'gap';
  if (msg.seq <= state.seq) return 'ignored';
  if (msg.seq !== state.seq + 1) return 'gap';

  for (const op of msg.ops) {
    const table = tableOf(state, op.entity);
    if (op.op === 'upsert') table[op.id] = op.data;
    else delete table[op.id];
  }
  state.seq = msg.seq;
  return 'ok';
}

function tableOf(state: ServerState, entity: DeltaMessage['ops'][number]['entity']) {
  switch (entity) {
    case 'endpoint':
      return state.endpoints as Record<string, unknown>;
    case 'channel':
      return state.channels as Record<string, unknown>;
    case 'bridge':
      return state.bridges as Record<string, unknown>;
    case 'call':
      return state.calls as Record<string, unknown>;
    case 'queue':
      return state.queues as Record<string, unknown>;
    case 'queueMember':
      return state.queueMembers as Record<string, unknown>;
    case 'queueEntry':
      return state.queueEntries as Record<string, unknown>;
  }
}
