import type { Bridge, Call, Channel, DeltaOp, ServerScope, ServerSnapshot } from '@astcall/shared';
import type { ServerStore } from './ServerStore.js';

/**
 * Regras de visibilidade de um usuário com escopo (multi-empresa, modo integrado ao AzCall).
 *
 * - Endpoints (ramais/troncos) e filas: visíveis se estiverem na lista do escopo.
 * - Chamadas: visíveis se ALGUM canal for de um endpoint do escopo ou tiver passado por uma
 *   fila do escopo. Uma chamada visível mostra todos os seus canais (inclusive o tronco ou o
 *   ramal de outra empresa do outro lado — faz parte da conversa da empresa).
 * - Canais e bridges seguem a chamada.
 */
export class ScopeFilter {
  private readonly endpoints: Set<string>;
  private readonly queues: Set<string>;

  constructor(
    scope: ServerScope,
    private readonly store: ServerStore,
  ) {
    this.endpoints = new Set(scope.endpoints);
    this.queues = new Set(scope.queues);
  }

  endpointVisible(id: string): boolean {
    return this.endpoints.has(id);
  }

  queueVisible(name: string): boolean {
    return this.queues.has(name);
  }

  /** O canal, por si só, pertence à empresa (ramal/tronco dela ou passou por fila dela)? */
  private ownsChannel(ch: Channel): boolean {
    return (
      (ch.endpointId !== null && this.endpoints.has(ch.endpointId)) ||
      (ch.queue !== null && this.queues.has(ch.queue))
    );
  }

  callVisible(call: Call): boolean {
    return call.channelIds.some((id) => {
      const ch = this.store.channels.get(id);
      return ch ? this.ownsChannel(ch) : false;
    });
  }

  channelVisible(ch: Channel): boolean {
    const call = this.store.calls.get(ch.linkedid);
    return call ? this.callVisible(call) : this.ownsChannel(ch);
  }

  bridgeVisible(b: Bridge): boolean {
    return b.channelIds.some((id) => {
      const ch = this.store.channels.get(id);
      return ch ? this.channelVisible(ch) : false;
    });
  }

  /** Canal visível pelo uniqueid (para as ações). */
  channelIdVisible(uniqueid: string): boolean {
    const ch = this.store.channels.get(uniqueid);
    return ch ? this.channelVisible(ch) : false;
  }

  /** Recorta um snapshot completo para o escopo. */
  filterSnapshot(s: ServerSnapshot): ServerSnapshot {
    return {
      endpoints: s.endpoints.filter((e) => this.endpointVisible(e.id)),
      channels: s.channels.filter((c) => this.channelVisible(c)),
      bridges: s.bridges.filter((b) => this.bridgeVisible(b)),
      calls: s.calls.filter((c) => this.callVisible(c)),
      queues: s.queues.filter((q) => this.queueVisible(q.name)),
      queueMembers: s.queueMembers.filter((m) => this.queueVisible(m.queue)),
      queueEntries: s.queueEntries.filter((e) => this.queueVisible(e.queue)),
    };
  }
}

/** Entidades cuja visibilidade muda com o tempo (dependem da chamada). */
const DYNAMIC = new Set(['channel', 'call', 'bridge']);

/**
 * Estado por assinante com escopo: o que já foi enviado a ele. Permite mandar `remove` quando
 * algo deixa de ser visível e completar a chamada quando ela passa a ser visível.
 */
export class ScopedView {
  private readonly sent = {
    channel: new Set<string>(),
    call: new Set<string>(),
    bridge: new Set<string>(),
  };

  constructor(readonly filter: ScopeFilter) {}

  /** Recorta o snapshot e registra o que foi enviado. */
  snapshot(s: ServerSnapshot): ServerSnapshot {
    const out = this.filter.filterSnapshot(s);
    this.sent.channel = new Set(out.channels.map((c) => c.uniqueid));
    this.sent.call = new Set(out.calls.map((c) => c.id));
    this.sent.bridge = new Set(out.bridges.map((b) => b.id));
    return out;
  }

  /**
   * Traduz um lote de deltas para este assinante.
   *
   * Endpoints e filas: filtrados pelo id. Chamadas, canais e bridges: a visibilidade depende
   * da chamada inteira e muda com o tempo (ex.: a chamada deixa de ser da empresa quando o
   * ramal dela sai numa transferência). Por isso, a cada lote, recalcula o conjunto visível e
   * compara com o que já foi enviado: o que saiu vira `remove`; o que entrou — ou mudou e
   * continua visível — vira `upsert`.
   */
  deltas(ops: DeltaOp[], store: ServerStore): DeltaOp[] {
    const out: DeltaOp[] = [];
    const changed = new Set<string>();
    for (const op of ops) {
      if (DYNAMIC.has(op.entity)) changed.add(`${op.entity}:${op.id}`);
      else if (staticVisible(op, this.filter)) out.push(op);
    }

    const visible = this.visibleNow(store);
    for (const kind of ['call', 'channel', 'bridge'] as const) {
      for (const id of this.sent[kind]) {
        if (!visible[kind].has(id)) {
          out.push({ op: 'remove', entity: kind, id } as DeltaOp);
          this.sent[kind].delete(id);
        }
      }
      for (const id of visible[kind]) {
        if (!this.sent[kind].has(id) || changed.has(`${kind}:${id}`)) {
          const data = currentEntity(kind, id, store)!;
          out.push({ op: 'upsert', entity: kind, id, data: structuredClone(data) } as DeltaOp);
          this.sent[kind].add(id);
        }
      }
    }
    return out;
  }

  /** Chamadas visíveis agora e, a partir delas, seus canais e bridges. */
  private visibleNow(store: ServerStore) {
    const v = { call: new Set<string>(), channel: new Set<string>(), bridge: new Set<string>() };
    for (const call of store.calls.values()) {
      if (!this.filter.callVisible(call)) continue;
      v.call.add(call.id);
      for (const id of call.channelIds) if (store.channels.has(id)) v.channel.add(id);
      for (const id of call.bridgeIds) if (store.bridges.has(id)) v.bridge.add(id);
    }
    // Bridges com algum canal visível (ex.: canal de outra chamada na mesma bridge)
    for (const b of store.bridges.values()) {
      if (!v.bridge.has(b.id) && b.channelIds.some((id) => v.channel.has(id))) v.bridge.add(b.id);
    }
    return v;
  }
}

function currentEntity(kind: 'channel' | 'call' | 'bridge', id: string, store: ServerStore) {
  if (kind === 'channel') return store.channels.get(id);
  if (kind === 'call') return store.calls.get(id);
  return store.bridges.get(id);
}

/** Endpoints e filas: a visibilidade sai do próprio id (não muda com o tempo). */
function staticVisible(op: DeltaOp, f: ScopeFilter): boolean {
  switch (op.entity) {
    case 'endpoint':
      return f.endpointVisible(op.id);
    case 'queue':
      return f.queueVisible(op.id);
    case 'queueMember':
    case 'queueEntry':
      // ids no formato "<fila>|<interface ou uniqueid>"
      return f.queueVisible(op.id.slice(0, op.id.indexOf('|')));
    default:
      return false;
  }
}
