import type {
  Bridge,
  Call,
  Channel,
  Endpoint,
  Queue,
  QueueEntry,
  QueueMember,
} from './entities.js';

/** Tipos de entidade do estado e o formato de cada uma. */
export interface EntityMap {
  endpoint: Endpoint;
  channel: Channel;
  bridge: Bridge;
  call: Call;
  queue: Queue;
  queueMember: QueueMember;
  queueEntry: QueueEntry;
}

export type EntityName = keyof EntityMap;

/**
 * Uma alteração no estado. `upsert` sempre leva a entidade completa (as entidades são
 * pequenas e isso simplifica o frontend); `remove` leva só o id.
 */
export type DeltaOp = {
  [K in EntityName]:
    | { op: 'upsert'; entity: K; id: string; data: EntityMap[K] }
    | { op: 'remove'; entity: K; id: string };
}[EntityName];

/** Estado completo de um servidor, enviado ao conectar e após cada ressincronização. */
export interface ServerSnapshot {
  endpoints: Endpoint[];
  channels: Channel[];
  bridges: Bridge[];
  calls: Call[];
  queues: Queue[];
  queueMembers: QueueMember[];
  queueEntries: QueueEntry[];
}
