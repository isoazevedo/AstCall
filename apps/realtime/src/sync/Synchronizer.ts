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
 * Filas, ConfBridge e estacionamento entram aqui junto com seus domínios (itens 9 a 11).
 */
export const SYNC_LISTS: readonly SyncList[] = [
  { action: 'PJSIPShowEndpoints', optional: false },
  { action: 'PJSIPShowContacts', optional: false },
  { action: 'DeviceStateList', optional: false },
  { action: 'BridgeList', optional: false },
  { action: 'CoreShowChannels', optional: false },
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
  private readonly log: Logger;
  private readonly reloadDebounceMs: number;

  constructor(
    private readonly conn: AmiConnection,
    private readonly store: ServerStore,
    log: Logger,
    options: SynchronizerOptions = {},
  ) {
    super();
    this.log = log.child({ server: conn.serverId });
    this.reloadDebounceMs = options.reloadDebounceMs ?? 3_000;
    // Cada nova conexão AMI dispara uma sincronização completa
    conn.setOnConnected(() => this.run());
    conn.on('event', (ev) => this.onEvent(ev));
    conn.on('status', (status) => {
      if (status === 'disconnected') this.cancelScheduledResync();
    });
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
