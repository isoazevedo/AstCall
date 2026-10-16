import { EventEmitter } from 'node:events';
import type { ServerConnectionStatus, ServerId } from '@astcall/shared';
import type { AmiServerConfig } from '../config/index.js';
import type { Logger } from '../logger.js';
import { AmiClient, type AmiClientOptions } from './AmiClient.js';
import {
  AmiDisconnectedError,
  type AmiActionFields,
  type AmiListResult,
  type AmiMessage,
} from './types.js';

export interface AmiConnectionOptions extends AmiClientOptions {
  /** Espera mínima antes de reconectar (dobra a cada falha). */
  backoffMinMs?: number;
  /** Espera máxima antes de reconectar. */
  backoffMaxMs?: number;
  /** Intervalo do keepalive (action Ping). */
  pingIntervalMs?: number;
  /**
   * Chamado a cada conexão bem-sucedida, logo após o login, com o estado em `syncing`.
   * É aqui que a sincronização completa do estado vai acontecer (item 4 do roadmap).
   * Se lançar erro, a conexão é derrubada e refeita.
   */
  onConnected?: (connection: AmiConnection) => Promise<void>;
}

type ConnectionEvents = {
  status: [ServerConnectionStatus];
  event: [AmiMessage];
  /** Toda mensagem recebida do Asterisk (usado pelo gravador). */
  message: [AmiMessage];
};

/**
 * Mantém a conexão AMI de UM servidor Asterisk sempre viva:
 * conecta, autentica, chama `onConnected`, monitora com Ping e reconecta com backoff
 * exponencial quando a conexão cai.
 *
 * Os eventos do Asterisk são repassados pelo evento `event`.
 */
export class AmiConnection extends EventEmitter<ConnectionEvents> {
  readonly serverId: ServerId;
  private readonly log: Logger;
  private readonly opts: Required<Omit<AmiConnectionOptions, 'onConnected'>> &
    Pick<AmiConnectionOptions, 'onConnected'>;

  private client: AmiClient | undefined;
  private running = false;
  private _status: ServerConnectionStatus = 'disconnected';
  private pingTimer: NodeJS.Timeout | undefined;
  private wakeUp: (() => void) | undefined;
  private loopDone: Promise<void> | undefined;

  constructor(
    private readonly config: AmiServerConfig,
    log: Logger,
    options: AmiConnectionOptions = {},
  ) {
    super();
    this.serverId = config.id;
    this.log = log.child({ server: config.id });
    this.opts = {
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      actionTimeoutMs: options.actionTimeoutMs ?? 10_000,
      listTimeoutMs: options.listTimeoutMs ?? 60_000,
      backoffMinMs: options.backoffMinMs ?? 1_000,
      backoffMaxMs: options.backoffMaxMs ?? 30_000,
      pingIntervalMs: options.pingIntervalMs ?? 30_000,
      onConnected: options.onConnected,
    };
  }

  get status(): ServerConnectionStatus {
    return this._status;
  }

  /** Versão do protocolo AMI da conexão atual. */
  get protocolVersion(): string | undefined {
    return this.client?.protocolVersion;
  }

  /** Inicia o ciclo de conexão (não aguarda conectar). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = this.loop();
  }

  /** Para de reconectar e encerra a conexão atual. */
  async stop(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    await this.client?.close();
    this.client?.destroy(); // caso ainda estivesse conectando
    await this.loopDone;
  }

  /** Envia uma action simples pela conexão atual. */
  sendAction(action: string, fields?: AmiActionFields, timeoutMs?: number): Promise<AmiMessage> {
    const client = this.client;
    if (!client?.connected) return Promise.reject(new AmiDisconnectedError(action));
    return client.sendAction(action, fields, timeoutMs);
  }

  /** Envia uma action de lista pela conexão atual. */
  sendListAction(
    action: string,
    fields?: AmiActionFields,
    timeoutMs?: number,
  ): Promise<AmiListResult> {
    const client = this.client;
    if (!client?.connected) return Promise.reject(new AmiDisconnectedError(action));
    return client.sendListAction(action, fields, timeoutMs);
  }

  // ---------------------------------------------------------------------------

  private setStatus(status: ServerConnectionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.log.info({ status }, 'Status da conexão AMI');
    this.emit('status', status);
  }

  /** Laço principal: conecta, espera cair, aguarda o backoff e tenta de novo. */
  private async loop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      const ok = await this.runOnce();
      if (!this.running) break;
      failures = ok ? 0 : failures + 1;
      const delay = this.backoffDelay(failures);
      this.log.info({ delayMs: delay }, 'Reconectando ao AMI em breve');
      await this.sleep(delay);
    }
    this.setStatus('disconnected');
  }

  /**
   * Uma "vida" da conexão. Retorna true se chegou a ficar pronta
   * (para zerar o backoff), false se falhou antes disso.
   */
  private async runOnce(): Promise<boolean> {
    const { host, port, username, secret } = this.config;
    const client = new AmiClient(this.opts);
    this.client = client;
    const closed = new Promise<Error | undefined>((resolve) => client.once('close', resolve));
    client.on('event', (msg) => this.emit('event', msg));
    client.on('message', (msg) => this.emit('message', msg));

    let reachedReady = false;
    try {
      this.setStatus('connecting');
      await client.connect(host, port);
      await client.login(username, secret);
      if (!this.running) throw new Error('Conexão interrompida por stop()');
      this.log.info({ ami: client.protocolVersion }, 'Conectado e autenticado no AMI');

      this.setStatus('syncing');
      await this.opts.onConnected?.(this);
      if (!client.connected) throw new Error('Conexão caiu durante a sincronização');

      this.setStatus('ready');
      reachedReady = true;
      this.startPing(client);

      const reason = await closed;
      this.log.warn({ err: reason?.message }, 'Conexão AMI encerrada');
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'Falha na conexão AMI');
      client.destroy();
    } finally {
      this.stopPing();
      client.removeAllListeners('event');
      client.removeAllListeners('message');
      this.setStatus('disconnected');
    }
    return reachedReady;
  }

  private startPing(client: AmiClient): void {
    this.pingTimer = setInterval(() => {
      client.sendAction('Ping').catch((err: Error) => {
        this.log.warn({ err: err.message }, 'Keepalive falhou; derrubando a conexão');
        client.destroy(err);
      });
    }, this.opts.pingIntervalMs);
  }

  private stopPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  /** Backoff exponencial com variação aleatória de ±20% (evita reconexões sincronizadas). */
  private backoffDelay(failures: number): number {
    // 0 ou 1 falha → espera mínima; depois dobra a cada nova falha
    const exponent = Math.max(0, failures - 1);
    const base = Math.min(this.opts.backoffMaxMs, this.opts.backoffMinMs * 2 ** exponent);
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  /** Espera interrompível por `stop()`. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakeUp = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeUp = done;
    });
  }
}
