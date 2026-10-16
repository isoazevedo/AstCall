import { EventEmitter } from 'node:events';
import type { AmiConnection } from '../ami/AmiConnection.js';
import { AmiActionError, type AmiMessage } from '../ami/types.js';
import { applyEvent } from '../handlers/index.js';
import type { Logger } from '../logger.js';
import type { ServerStore } from '../state/ServerStore.js';

/** Uma action de lista usada na sincronização. */
export interface SyncList {
  action: string;
  /** Opcional: se falhar (ex.: módulo não carregado), a sincronização continua. */
  optional: boolean;
}

/**
 * Listas consultadas a cada sincronização, na ordem.
 * QueueStatus vem depois dos canais para marcar quem está "na fila". Opcional: o módulo de
 * filas pode não estar carregado. ConfBridge e estacionamento entram nos itens 10 e 11.
 */
export const SYNC_LISTS: readonly SyncList[] = [
  { action: 'PJSIPShowEndpoints', optional: false },
  { action: 'PJSIPShowContacts', optional: false },
  { action: 'DeviceStateList', optional: false },
  { action: 'BridgeList', optional: false },
  { action: 'CoreShowChannels', optional: false },
  { action: 'QueueStatus', optional: true },
];

/** Módulos cujo reload pode mudar o estado que mantemos ("All" = core reload, usado pelo AzCall). */
const RELOAD_RELEVANT = /^(all|.*pjsip.*|app_queue.*|app_confbridge.*|res_parking.*)$/i;

/** Algumas listas respondem "Response: Error" quando estão vazias. */
function isEmptyListError(err: unknown): boolean {
  return (
    err instanceof AmiActionError &&
    /no .*found|no active|nothing/i.test(err.response.message ?? '')
  );
}

export interface SynchronizerOptions {
  /** Espera após um Reload antes de ressincronizar (vários reloads seguidos viram um só). */
  reloadDebounceMs?: number;
  /**
   * Intervalo da reconciliação das filas (QueueStatus). O Asterisk não envia eventos quando
   * médias/totais mudam; a reconciliação também corrige divergências. 0 = desligada.
   */
  queueRefreshMs?: number;
}

type SyncEvents = {
  /** Começou uma sincronização: o estado foi zerado e está sendo reconstruído. */
  syncing: [];
  /** Sincronização concluída: o estado está completo. `epoch` aumenta a cada uma. */
  synced: [{ epoch: number; durationMs: number }];
};

/**
 * Mantém o `ServerStore` de um servidor em sincronia com o Asterisk:
 *
 * - aplica os eventos AMI ao store;
 * - a cada conexão (via `onConnected`), zera o estado e o reconstrói com as listas do AMI;
 * - após um `Reload` relevante, ressincroniza (com debounce).
 *
 * Ordenação: os itens das listas são aplicados no momento em que chegam, intercalados com os
 * eventos ao vivo na mesma ordem do stream TCP. Assim, um evento posterior a um item sempre
 * prevalece, sem precisar de buffer.
 *
 * Durante a sincronização o store emite deltas normalmente; quem envia estado aos navegadores
 * deve ignorá-los entre `syncing` e `synced` e então enviar um snapshot novo.
 */
export class Synchronizer extends EventEmitter<SyncEvents> {
  private _epoch = 0;
  private _syncing = false;
  private current: Promise<void> | undefined;
  private again = false;
  private reloadTimer: NodeJS.Timeout | undefined;
  private queueTimer: NodeJS.Timeout | undefined;
  private refreshingQueues = false;
  private readonly log: Logger;
  private readonly reloadDebounceMs: number;
  private readonly queueRefreshMs: number;

  constructor(
    private readonly conn: AmiConnection,
    private readonly store: ServerStore,
    log: Logger,
    options: SynchronizerOptions = {},
  ) {
    super();
    this.log = log.child({ server: conn.serverId });
    this.reloadDebounceMs = options.reloadDebounceMs ?? 3_000;
    this.queueRefreshMs = options.queueRefreshMs ?? 60_000;
    // Cada nova conexão AMI dispara uma sincronização completa
    conn.setOnConnected(() => this.run());
    conn.on('event', (ev) => this.onEvent(ev));
    conn.on('status', (status) => {
      if (status === 'disconnected') {
        this.cancelScheduledResync();
        clearInterval(this.queueTimer);
        this.queueTimer = undefined;
      }
    });
    this.on('synced', () => this.startQueueRefresh());
  }

  get epoch(): number {
    return this._epoch;
  }

  get syncing(): boolean {
    return this._syncing;
  }

  /**
   * Executa uma sincronização completa. Se já houver uma em andamento, agenda outra logo
   * em seguida e aguarda. Lança erro se uma lista obrigatória falhar.
   */
  run(): Promise<void> {
    if (this.current) {
      this.again = true;
      return this.current;
    }
    this.current = (async () => {
      try {
        do {
          this.again = false;
          await this.syncOnce();
        } while (this.again);
      } finally {
        this.current = undefined;
      }
    })();
    return this.current;
  }

  // ---------------------------------------------------------------------------

  private async syncOnce(): Promise<void> {
    const started = Date.now();
    this._syncing = true;
    this.emit('syncing');
    this.store.clear();

    try {
      for (const list of SYNC_LISTS) {
        let items = 0;
        try {
          await this.conn.sendListAction(list.action, {}, undefined, (item) => {
            items++;
            applyEvent(this.store, item);
          });
        } catch (err) {
          if (isEmptyListError(err)) {
            // lista vazia: nada a fazer
          } else if (list.optional) {
            this.log.warn(
              { action: list.action, err: (err as Error).message },
              'Lista opcional falhou',
            );
          } else {
            throw err;
          }
        }
        this.log.debug({ action: list.action, items }, 'Lista sincronizada');
      }
    } finally {
      this._syncing = false;
    }

    this.store.flush();
    this._epoch++;
    const durationMs = Date.now() - started;
    this.log.info(
      {
        epoch: this._epoch,
        durationMs,
        endpoints: this.store.endpoints.size,
        channels: this.store.channels.size,
        bridges: this.store.bridges.size,
      },
      'Estado sincronizado',
    );
    this.emit('synced', { epoch: this._epoch, durationMs });
  }

  /**
   * Reconciliação das filas: aplica o QueueStatus atual e remove membros/chamadores/filas que
   * não vieram na resposta — exceto os alterados por eventos durante a própria consulta
   * (um chamador que entrou no meio dela não pode ser removido por engano).
   */
  async refreshQueues(): Promise<void> {
    if (this._syncing || this.refreshingQueues) return;
    this.refreshingQueues = true;
    const seen = {
      queue: new Set<string>(),
      queueMember: new Set<string>(),
      queueEntry: new Set<string>(),
    };
    const touched = new Set<string>();
    const onDeltas = (ops: { entity: string; id: string }[]) => {
      for (const op of ops) touched.add(`${op.entity}:${op.id}`);
    };
    this.store.on('deltas', onDeltas);
    try {
      await this.conn.sendListAction('QueueStatus', {}, undefined, (item) => {
        applyEvent(this.store, item);
        if (item.event === 'QueueParams' && item.queue) seen.queue.add(item.queue);
        if (item.event === 'QueueMember' && item.queue) {
          seen.queueMember.add(`${item.queue}|${item.location || item.interface}`);
        }
        if (item.event === 'QueueEntry' && item.queue) {
          seen.queueEntry.add(`${item.queue}|${item.uniqueid}`);
        }
      });
      const stale = (entity: keyof typeof seen, id: string) =>
        !seen[entity].has(id) && !touched.has(`${entity}:${id}`);
      for (const e of [...this.store.queueEntries.values()]) {
        if (stale('queueEntry', e.id)) this.store.removeEntry(e.queue, e.uniqueid);
      }
      for (const m of [...this.store.queueMembers.values()]) {
        if (stale('queueMember', m.id)) this.store.removeMember(m.id);
      }
      for (const name of [...this.store.queues.keys()]) {
        if (stale('queue', name)) this.store.removeQueue(name);
      }
      this.store.flush();
    } catch (err) {
      if (!isEmptyListError(err)) {
        this.log.debug({ err: (err as Error).message }, 'Reconciliação das filas falhou');
      }
    } finally {
      this.store.off('deltas', onDeltas);
      this.refreshingQueues = false;
    }
  }

  private startQueueRefresh(): void {
    clearInterval(this.queueTimer);
    if (this.queueRefreshMs <= 0) return;
    this.queueTimer = setInterval(() => void this.refreshQueues(), this.queueRefreshMs);
  }

  private onEvent(ev: AmiMessage): void {
    applyEvent(this.store, ev);
    if (ev.event === 'Reload' && RELOAD_RELEVANT.test(ev.module ?? 'All')) {
      this.scheduleResync(`Reload ${ev.module ?? ''}`.trim());
    }
  }

  private scheduleResync(reason: string): void {
    if (this.conn.status !== 'ready') return; // a sincronização da conexão já vai cobrir
    this.cancelScheduledResync();
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      this.log.info({ reason }, 'Ressincronizando após reload');
      this.run().catch((err: Error) => {
        // Estado parcial não é aceitável: reconecta para refazer tudo do zero
        this.log.error({ err: err.message }, 'Falha na ressincronização');
        this.conn.reconnect('falha na ressincronização');
      });
    }, this.reloadDebounceMs);
  }

  private cancelScheduledResync(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
  }
}
