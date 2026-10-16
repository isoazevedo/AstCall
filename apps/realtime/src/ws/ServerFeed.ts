import type { EventEmitter } from 'node:events';
import type {
  DeltaMessage,
  DeltaOp,
  ServerConnectionStatus,
  ServerId,
  ServerSnapshot,
  ServerStatusMessage,
  SnapshotMessage,
} from '@astcall/shared';

/** O que o feed precisa do store, da sincronização e da conexão (interfaces mínimas, testáveis). */
export interface FeedSources {
  store: EventEmitter<{ deltas: [DeltaOp[]] }> & { snapshot(): ServerSnapshot };
  sync: EventEmitter<{ syncing: []; synced: [{ epoch: number; durationMs: number }] }> & {
    readonly epoch: number;
    readonly syncing: boolean;
  };
  conn: EventEmitter<{ status: [ServerConnectionStatus] }> & {
    readonly status: ServerConnectionStatus;
  };
}

/** Quem recebe as mensagens de um servidor (uma sessão WebSocket). */
export interface FeedSubscriber {
  send(msg: SnapshotMessage | DeltaMessage | ServerStatusMessage): void;
}

/**
 * Distribui o estado de UM servidor Asterisk aos assinantes:
 *
 * - agrupa os deltas do store em lotes (janela de `batchMs`) e numera cada lote (`seq`);
 * - durante uma sincronização descarta os deltas (o estado está sendo reconstruído) e,
 *   ao terminar, envia um snapshot novo com `epoch` atualizado e `seq` = 0;
 * - repassa mudanças de status (conectando, sincronizando, pronto, desconectado).
 */
export class ServerFeed {
  private readonly subscribers = new Set<FeedSubscriber>();
  private pending: DeltaOp[] = [];
  private timer: NodeJS.Timeout | undefined;
  private seq = 0;
  private lastStatus: ServerConnectionStatus;

  constructor(
    readonly serverId: ServerId,
    readonly name: string,
    private readonly src: FeedSources,
    private readonly batchMs = 50,
  ) {
    this.lastStatus = this.status;

    src.store.on('deltas', (ops) => {
      if (this.src.sync.syncing) return; // será coberto pelo snapshot do "synced"
      this.pending.push(...ops);
      this.timer ??= setTimeout(() => this.flush(), this.batchMs);
    });

    src.sync.on('syncing', () => {
      this.discardPending();
      this.publishStatus();
    });

    src.sync.on('synced', () => {
      this.discardPending();
      this.seq = 0;
      this.publishStatus();
      for (const sub of this.subscribers) sub.send(this.snapshotMessage());
    });

    src.conn.on('status', () => this.publishStatus());
  }

  /** Status efetivo: conexão pronta mas ressincronizando (após reload) conta como "syncing". */
  get status(): ServerConnectionStatus {
    const s = this.src.conn.status;
    return s === 'ready' && this.src.sync.syncing ? 'syncing' : s;
  }

  /** O estado está completo (já houve ao menos uma sincronização e nenhuma em andamento)? */
  get hasState(): boolean {
    return this.src.sync.epoch > 0 && !this.src.sync.syncing;
  }

  subscribe(sub: FeedSubscriber): void {
    if (this.subscribers.has(sub)) return;
    this.subscribers.add(sub);
    sub.send(this.statusMessage());
    this.sendSnapshot(sub);
  }

  unsubscribe(sub: FeedSubscriber): void {
    this.subscribers.delete(sub);
  }

  /** Envia um snapshot a um assinante (ex.: pedido de resync). */
  sendSnapshot(sub: FeedSubscriber): void {
    if (!this.hasState) return; // chegará no próximo "synced"
    // Entrega antes o lote pendente aos demais, para o snapshot refletir o seq atual
    this.flush();
    sub.send(this.snapshotMessage());
  }

  close(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.subscribers.clear();
  }

  // ---------------------------------------------------------------------------

  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return;
    const msg: DeltaMessage = {
      t: 'delta',
      server: this.serverId,
      epoch: this.src.sync.epoch,
      seq: ++this.seq,
      ops: compact(this.pending),
    };
    this.pending = [];
    for (const sub of this.subscribers) sub.send(msg);
  }

  private discardPending(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
  }

  private snapshotMessage(): SnapshotMessage {
    return {
      t: 'snapshot',
      server: this.serverId,
      epoch: this.src.sync.epoch,
      seq: this.seq,
      data: this.src.store.snapshot(),
    };
  }

  private statusMessage(): ServerStatusMessage {
    return { t: 'server_status', server: this.serverId, status: this.status };
  }

  private publishStatus(): void {
    const status = this.status;
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    const msg = this.statusMessage();
    for (const sub of this.subscribers) sub.send(msg);
  }
}

/**
 * Dentro de um lote, só a última operação de cada entidade importa
 * (ex.: 5 upserts do mesmo canal viram 1). Mantém a ordem da última ocorrência.
 */
export function compact(ops: DeltaOp[]): DeltaOp[] {
  const last = new Map<string, DeltaOp>();
  for (const op of ops) {
    const key = `${op.entity}:${op.id}`;
    last.delete(key); // reinsere no fim para preservar a ordem da última ocorrência
    last.set(key, op);
  }
  return [...last.values()];
}
