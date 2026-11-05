import type { DeltaOp, ServerConnectionStatus, ServerId } from '@astcall/shared';
import type { FeedSources } from '../ws/ServerFeed.js';
import type { HistoryStore } from './HistoryStore.js';

export interface HistoryRecorderOptions {
  /** Intervalo entre as fotos do estado (ms). */
  checkpointMs: number;
  /** Intervalo de gravação dos lotes pendentes (ms); cada gravação vira uma linha no banco. */
  flushMs?: number;
  /** Relógio (testes). */
  now?: () => number;
}

/**
 * Grava o histórico de UM servidor: as alterações do estado (deltas) e fotos periódicas.
 *
 * - Durante uma ressincronização os deltas são ignorados (o estado está sendo refeito); ao
 *   terminar, grava uma foto nova — a partir dela o histórico volta a ser contínuo.
 * - Os deltas ficam num buffer e vão para o banco a cada `flushMs`, numa linha comprimida,
 *   para não escrever no disco a cada evento do AMI.
 * - Antes de cada foto o buffer é gravado: a foto inclui tudo o que já está no banco.
 */
export class HistoryRecorder {
  private pending: { ts: number; ops: DeltaOp[] }[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly now: () => number;
  private readonly onDeltas = (ops: DeltaOp[]) => {
    if (!this.src.sync.syncing) this.pending.push({ ts: this.now(), ops });
  };
  private readonly onSynced = () => this.checkpoint();
  private readonly onStatus = (status: ServerConnectionStatus) =>
    this.history.addStatus(this.serverId, this.now(), status);

  constructor(
    private readonly serverId: ServerId,
    private readonly history: HistoryStore,
    private readonly src: FeedSources,
    options: HistoryRecorderOptions,
  ) {
    this.now = options.now ?? Date.now;
    src.store.on('deltas', this.onDeltas);
    src.sync.on('synced', this.onSynced);
    src.conn.on('status', this.onStatus);
    this.timers.push(setInterval(() => this.flush(), options.flushMs ?? 2000));
    this.timers.push(setInterval(() => this.checkpoint(), options.checkpointMs));
  }

  /** Grava os lotes pendentes. */
  flush(): void {
    if (this.pending.length === 0) return;
    const batches = this.pending;
    this.pending = [];
    this.history.addBatches(this.serverId, batches);
  }

  /** Grava uma foto do estado atual (se não estiver no meio de uma ressincronização). */
  checkpoint(): void {
    if (this.src.sync.syncing) return;
    this.flush();
    this.history.addCheckpoint(this.serverId, this.now(), this.src.store.snapshot());
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.src.store.off('deltas', this.onDeltas);
    this.src.sync.off('synced', this.onSynced);
    this.src.conn.off('status', this.onStatus);
    this.flush();
    // encerrando: daqui em diante não há gravação (a tela avisa em vez de mostrar dados velhos)
    this.history.addStatus(this.serverId, this.now(), 'disconnected');
  }
}
