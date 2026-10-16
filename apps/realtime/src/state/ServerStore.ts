import { EventEmitter } from 'node:events';
import type {
  Bridge,
  Call,
  CallStatus,
  Channel,
  Contact,
  DeltaOp,
  Endpoint,
  EntityMap,
  EntityName,
  ServerSnapshot,
} from '@astcall/shared';

/** Quantos Uniqueids desligados lembrar, para não "ressuscitar" canais com eventos atrasados. */
const HUNG_UP_MEMORY = 1000;

type StoreEvents = { deltas: [DeltaOp[]] };

/**
 * Estado em memória de UM servidor Asterisk.
 *
 * Os handlers alteram o estado pelos métodos abaixo; ao final de cada evento AMI,
 * `flush()` recalcula os dados derivados (chamadas e contadores dos endpoints) só para o
 * que foi afetado, compara com o que já foi enviado e emite apenas os deltas que de fato
 * mudaram alguma coisa.
 */
export class ServerStore extends EventEmitter<StoreEvents> {
  readonly endpoints = new Map<string, Endpoint>();
  readonly channels = new Map<string, Channel>();
  readonly bridges = new Map<string, Bridge>();
  readonly calls = new Map<string, Call>();

  // Índices auxiliares
  private readonly byLinkedid = new Map<string, Set<string>>();
  private readonly byEndpoint = new Map<string, Set<string>>();
  private readonly hungUp = new Set<string>();

  // O que mudou desde o último flush()
  private readonly dirty = {
    endpoint: new Set<string>(),
    channel: new Set<string>(),
    bridge: new Set<string>(),
    call: new Set<string>(),
  };

  /** Última versão enviada de cada entidade ("entidade:id" → JSON), para evitar deltas repetidos. */
  private readonly emitted = new Map<string, string>();

  // ---------------------------------------------------------------- canais

  /**
   * Cria ou atualiza um canal. Para criar, o patch precisa trazer o nome do canal.
   * Retorna undefined se o canal não existe e não pode ser criado (ex.: já desligou).
   */
  upsertChannel(uniqueid: string, patch: Partial<Channel>, ts: number): Channel | undefined {
    let ch = this.channels.get(uniqueid);
    if (!ch) {
      if (this.hungUp.has(uniqueid) || !patch.name) return undefined;
      ch = newChannel(uniqueid, patch.name, patch.linkedid ?? uniqueid, ts);
      this.channels.set(uniqueid, ch);
    }
    const prevLinkedid = ch.linkedid;
    const prevEndpoint = ch.endpointId;

    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (ch as unknown as Record<string, unknown>)[key] = value;
    }
    if (patch.name) {
      ch.endpointId = endpointFromChannelName(patch.name);
      ch.isLocal = patch.name.startsWith('Local/');
    }
    if (ch.state === 'Up' && ch.answeredAt === null) ch.answeredAt = ts;

    // Mantém os índices quando o Linkedid ou o endpoint mudam
    if (prevLinkedid !== ch.linkedid) {
      this.unindex(this.byLinkedid, prevLinkedid, uniqueid);
      this.dirty.call.add(prevLinkedid);
    }
    this.index(this.byLinkedid, ch.linkedid, uniqueid);
    if (prevEndpoint !== ch.endpointId) {
      if (prevEndpoint) {
        this.unindex(this.byEndpoint, prevEndpoint, uniqueid);
        this.dirty.endpoint.add(prevEndpoint);
      }
    }
    if (ch.endpointId) this.index(this.byEndpoint, ch.endpointId, uniqueid);

    this.touchChannel(ch);
    return ch;
  }

  /** Remove um canal (Hangup), tirando-o da bridge em que estiver. */
  removeChannel(uniqueid: string): void {
    this.rememberHangup(uniqueid);
    const ch = this.channels.get(uniqueid);
    if (!ch) return;
    if (ch.bridgeId) this.removeFromBridge(ch.bridgeId, uniqueid);
    this.touchChannel(ch);
    this.channels.delete(uniqueid);
    this.unindex(this.byLinkedid, ch.linkedid, uniqueid);
    if (ch.endpointId) this.unindex(this.byEndpoint, ch.endpointId, uniqueid);
  }

  // ---------------------------------------------------------------- bridges

  ensureBridge(
    id: string,
    patch: Partial<Pick<Bridge, 'type' | 'technology'>>,
    ts: number,
  ): Bridge {
    let bridge = this.bridges.get(id);
    if (!bridge) {
      bridge = { id, type: '', technology: '', channelIds: [], createdAt: ts };
      this.bridges.set(id, bridge);
    }
    if (patch.type) bridge.type = patch.type;
    if (patch.technology) bridge.technology = patch.technology;
    this.dirty.bridge.add(id);
    return bridge;
  }

  addToBridge(bridgeId: string, uniqueid: string, ts: number): void {
    const bridge = this.ensureBridge(bridgeId, {}, ts);
    const ch = this.channels.get(uniqueid);
    if (ch?.bridgeId && ch.bridgeId !== bridgeId) this.removeFromBridge(ch.bridgeId, uniqueid);
    if (!bridge.channelIds.includes(uniqueid)) bridge.channelIds.push(uniqueid);
    if (ch) {
      ch.bridgeId = bridgeId;
      this.touchChannel(ch);
    }
  }

  removeFromBridge(bridgeId: string, uniqueid: string): void {
    const bridge = this.bridges.get(bridgeId);
    if (bridge) {
      bridge.channelIds = bridge.channelIds.filter((id) => id !== uniqueid);
      this.dirty.bridge.add(bridgeId);
    }
    const ch = this.channels.get(uniqueid);
    if (ch?.bridgeId === bridgeId) {
      ch.bridgeId = null;
      this.touchChannel(ch);
    }
  }

  removeBridge(id: string): void {
    const bridge = this.bridges.get(id);
    if (!bridge) return;
    for (const uniqueid of bridge.channelIds) {
      const ch = this.channels.get(uniqueid);
      if (ch?.bridgeId === id) {
        ch.bridgeId = null;
        this.touchChannel(ch);
      }
    }
    this.bridges.delete(id);
    this.dirty.bridge.add(id);
  }

  // ---------------------------------------------------------------- endpoints

  ensureEndpoint(id: string): Endpoint {
    let ep = this.endpoints.get(id);
    if (!ep) {
      ep = { id, deviceState: 'UNKNOWN', contacts: [], activeChannels: 0 };
      this.endpoints.set(id, ep);
    }
    this.dirty.endpoint.add(id);
    return ep;
  }

  upsertContact(endpointId: string, contact: Contact): void {
    const ep = this.ensureEndpoint(endpointId);
    const idx = ep.contacts.findIndex((c) => c.uri === contact.uri);
    if (idx === -1) ep.contacts.push(contact);
    else ep.contacts[idx] = contact;
  }

  removeContact(endpointId: string, uri: string): void {
    const ep = this.ensureEndpoint(endpointId);
    ep.contacts = ep.contacts.filter((c) => c.uri !== uri);
  }

  // ---------------------------------------------------------------- ciclo

  /**
   * Recalcula os dados derivados do que mudou e devolve (e emite) os deltas.
   * Deve ser chamado ao final de cada evento AMI.
   */
  flush(): DeltaOp[] {
    for (const linkedid of this.dirty.call) this.recomputeCall(linkedid);
    for (const id of this.dirty.endpoint) {
      const ep = this.endpoints.get(id);
      if (ep) ep.activeChannels = this.byEndpoint.get(id)?.size ?? 0;
    }

    const ops: DeltaOp[] = [];
    this.collect('channel', this.channels, ops);
    this.collect('bridge', this.bridges, ops);
    this.collect('call', this.calls, ops);
    this.collect('endpoint', this.endpoints, ops);
    if (ops.length > 0) this.emit('deltas', ops);
    return ops;
  }

  /** Estado completo (para enviar a um cliente recém-conectado). */
  snapshot(): ServerSnapshot {
    return structuredClone({
      endpoints: [...this.endpoints.values()],
      channels: [...this.channels.values()],
      bridges: [...this.bridges.values()],
      calls: [...this.calls.values()],
    });
  }

  /** Zera o estado (antes de uma ressincronização). Não emite deltas: os clientes recebem um snapshot novo. */
  clear(): void {
    this.endpoints.clear();
    this.channels.clear();
    this.bridges.clear();
    this.calls.clear();
    this.byLinkedid.clear();
    this.byEndpoint.clear();
    this.hungUp.clear();
    this.emitted.clear();
    for (const set of Object.values(this.dirty)) set.clear();
  }

  // ---------------------------------------------------------------- internos

  /** Marca o canal e tudo o que depende dele (chamada e endpoint) para o próximo flush. */
  private touchChannel(ch: Channel): void {
    this.dirty.channel.add(ch.uniqueid);
    this.dirty.call.add(ch.linkedid);
    if (ch.endpointId) this.dirty.endpoint.add(ch.endpointId);
  }

  private recomputeCall(linkedid: string): void {
    const ids = this.byLinkedid.get(linkedid);
    const chans = [...(ids ?? [])]
      .map((id) => this.channels.get(id))
      .filter((c): c is Channel => c !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.uniqueid.localeCompare(b.uniqueid));

    if (chans.length === 0) {
      this.calls.delete(linkedid);
      return;
    }

    const links = computeLinks(chans);
    const answered = chans.map((c) => c.answeredAt).filter((t): t is number => t !== null);
    this.calls.set(linkedid, {
      id: linkedid,
      channelIds: chans.map((c) => c.uniqueid),
      bridgeIds: [...new Set(chans.map((c) => c.bridgeId).filter((b): b is string => !!b))].sort(),
      status: computeStatus(chans, links),
      links,
      recording: chans.some((c) => c.recording),
      startedAt: Math.min(...chans.map((c) => c.createdAt)),
      answeredAt: answered.length > 0 ? Math.min(...answered) : null,
    });
  }

  /** Gera os deltas de um tipo de entidade a partir do conjunto "sujo". */
  private collect<K extends EntityName>(
    entity: K,
    map: Map<string, EntityMap[K]>,
    ops: DeltaOp[],
  ): void {
    for (const id of this.dirty[entity]) {
      const key = `${entity}:${id}`;
      const current = map.get(id);
      if (current) {
        const json = JSON.stringify(current);
        if (this.emitted.get(key) === json) continue;
        this.emitted.set(key, json);
        ops.push({ op: 'upsert', entity, id, data: structuredClone(current) } as DeltaOp);
      } else if (this.emitted.delete(key)) {
        ops.push({ op: 'remove', entity, id } as DeltaOp);
      }
    }
    this.dirty[entity].clear();
  }

  private rememberHangup(uniqueid: string): void {
    this.hungUp.add(uniqueid);
    if (this.hungUp.size > HUNG_UP_MEMORY) {
      const oldest = this.hungUp.values().next().value;
      if (oldest !== undefined) this.hungUp.delete(oldest);
    }
  }

  private index(map: Map<string, Set<string>>, key: string, value: string): void {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(value);
  }

  private unindex(map: Map<string, Set<string>>, key: string, value: string): void {
    const set = map.get(key);
    set?.delete(value);
    if (set?.size === 0) map.delete(key);
  }
}

// ------------------------------------------------------------------ funções puras

function newChannel(uniqueid: string, name: string, linkedid: string, ts: number): Channel {
  return {
    uniqueid,
    name,
    linkedid,
    state: 'Unknown',
    callerId: { num: '', name: '' },
    connectedLine: { num: '', name: '' },
    context: '',
    exten: '',
    application: null,
    endpointId: endpointFromChannelName(name),
    isLocal: name.startsWith('Local/'),
    bridgeId: null,
    dialedBy: null,
    dialStatus: null,
    onHold: false,
    recording: false,
    createdAt: ts,
    answeredAt: null,
  };
}

/** "PJSIP/9001-0000002c" → "9001". Outras tecnologias (Local etc.) → null. */
export function endpointFromChannelName(name: string): string | null {
  const m = /^PJSIP\/(.+)-[0-9a-f]+$/i.exec(name);
  return m?.[1] ?? null;
}

/** "Local/9005@ctx-00000001;2" → "Local/9005@ctx-00000001" (identifica o par ;1/;2). */
function localPairKey(name: string): string | null {
  const m = /^(Local\/.+);[12]$/.exec(name);
  return m?.[1] ?? null;
}

/**
 * Agrupa os canais reais que estão se ouvindo: canais na mesma bridge estão ligados, e as
 * duas metades de um canal Local também (o áudio atravessa o par). Grupos com menos de dois
 * canais reais são descartados.
 */
function computeLinks(chans: Channel[]): string[][] {
  const parent = new Map<string, string>(chans.map((c) => [c.uniqueid, c.uniqueid]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  const firstInBridge = new Map<string, string>();
  const firstInPair = new Map<string, string>();
  for (const c of chans) {
    if (c.bridgeId) {
      const other = firstInBridge.get(c.bridgeId);
      if (other) union(c.uniqueid, other);
      else firstInBridge.set(c.bridgeId, c.uniqueid);
    }
    const pair = c.isLocal ? localPairKey(c.name) : null;
    if (pair) {
      const other = firstInPair.get(pair);
      if (other) union(c.uniqueid, other);
      else firstInPair.set(pair, c.uniqueid);
    }
  }

  const groups = new Map<string, string[]>();
  for (const c of chans) {
    if (c.isLocal) continue;
    const root = find(c.uniqueid);
    groups.set(root, [...(groups.get(root) ?? []), c.uniqueid]);
  }
  return [...groups.values()].filter((g) => g.length >= 2);
}

function computeStatus(chans: Channel[], links: string[][]): CallStatus {
  if (links.length > 0) return chans.some((c) => c.onHold) ? 'held' : 'talking';
  if (chans.some((c) => c.state === 'Ringing' || c.dialStatus === 'RINGING')) return 'ringing';
  if (chans.some((c) => c.dialStatus === 'DIALING' || c.dialStatus === 'PROGRESS'))
    return 'dialing';
  return 'other';
}
