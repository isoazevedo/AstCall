import type { DeltaOp } from '@astcall/shared';
import type { AmiMessage } from '../ami/index.js';
import type { ServerStore } from '../state/ServerStore.js';
import { bridgeHandlers } from './bridges.js';
import { channelHandlers } from './channels.js';
import { endpointHandlers } from './endpoints.js';
import type { Handler } from './util.js';

/** Tabela evento AMI (em minúsculas) → handler. Eventos fora da tabela são ignorados. */
export const HANDLERS: Readonly<Record<string, Handler>> = {
  ...channelHandlers,
  ...bridgeHandlers,
  ...endpointHandlers,
};

/**
 * Aplica um evento AMI ao store e devolve os deltas resultantes.
 * Todos os handlers são idempotentes: aplicar o mesmo evento duas vezes não corrompe o estado.
 */
export function applyEvent(store: ServerStore, msg: AmiMessage, ts = Date.now()): DeltaOp[] {
  const handler = msg.event ? HANDLERS[msg.event.toLowerCase()] : undefined;
  handler?.(store, msg, ts);
  return store.flush();
}

export type { Handler } from './util.js';
