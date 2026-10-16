import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { AmiParser, serializeAction } from './AmiParser.js';
import {
  AmiActionError,
  AmiDisconnectedError,
  AmiTimeoutError,
  type AmiActionFields,
  type AmiListResult,
  type AmiMessage,
} from './types.js';

export interface AmiClientOptions {
  /** Tempo máximo para conectar e receber a saudação. */
  connectTimeoutMs?: number;
  /** Tempo padrão de espera por uma resposta simples. */
  actionTimeoutMs?: number;
  /** Tempo padrão de espera por uma lista completa. */
  listTimeoutMs?: number;
}

type ClientEvents = {
  /** Toda mensagem recebida (respostas, itens de lista e eventos), antes do roteamento. */
  message: [AmiMessage];
  /** Evento assíncrono do Asterisk (não pertencente a uma lista em andamento). */
  event: [AmiMessage];
  /** A conexão foi encerrada; `error` indica o motivo quando não foi um fechamento pedido. */
  close: [Error | undefined];
};

interface Pending {
  action: string;
  isList: boolean;
  resolve: (value: AmiMessage | AmiListResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  response?: AmiMessage;
  events: AmiMessage[];
}

/**
 * Cliente AMI de baixo nível: uma conexão TCP, envio de actions e recebimento de eventos.
 * Não reconecta sozinho — isso é papel do `AmiConnection`.
 *
 * Correlação: cada action recebe um `ActionID` único; a resposta (e, nas listas, os eventos
 * de item e o evento final) voltam com o mesmo `ActionID`.
 */
export class AmiClient extends EventEmitter<ClientEvents> {
  private socket: Socket | undefined;
  private readonly parser = new AmiParser();
  private readonly pending = new Map<string, Pending>();
  private readonly idPrefix = randomBytes(4).toString('hex');
  private seq = 0;
  private closeError: Error | undefined;

  private readonly connectTimeoutMs: number;
  private readonly actionTimeoutMs: number;
  private readonly listTimeoutMs: number;

  constructor(options: AmiClientOptions = {}) {
    super();
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.actionTimeoutMs = options.actionTimeoutMs ?? 10_000;
    this.listTimeoutMs = options.listTimeoutMs ?? 60_000;
  }

  /** Versão do protocolo AMI informada pelo Asterisk na saudação. */
  get protocolVersion(): string | undefined {
    return this.parser.greeting;
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  /** Abre a conexão e aguarda a linha de saudação do Asterisk. */
  connect(host: string, port: number): Promise<void> {
    if (this.socket) throw new Error('AmiClient já foi conectado; crie uma nova instância');

    return new Promise((resolve, reject) => {
      const socket = new Socket();
      this.socket = socket;
      socket.setEncoding('utf8'); // trata caracteres multibyte quebrados entre pacotes
      socket.setNoDelay(true);

      let greeted = false;
      const timer = setTimeout(() => {
        socket.destroy(new Error(`Tempo esgotado ao conectar em ${host}:${port}`));
      }, this.connectTimeoutMs);

      socket.on('data', (chunk: string) => {
        let messages: AmiMessage[];
        try {
          messages = this.parser.feed(chunk);
        } catch (err) {
          socket.destroy(err as Error);
          return;
        }
        if (!greeted && this.parser.greeting !== undefined) {
          greeted = true;
          clearTimeout(timer);
          resolve();
        }
        for (const msg of messages) this.dispatch(msg);
      });

      socket.on('error', (err) => {
        this.closeError ??= err;
      });

      socket.on('close', () => {
        clearTimeout(timer);
        const error = this.closeError;
        if (!greeted) reject(error ?? new Error(`Conexão encerrada por ${host}:${port}`));
        this.failAllPending();
        this.emit('close', error);
      });

      socket.connect(port, host);
    });
  }

  /** Autentica e liga o recebimento de eventos. */
  async login(username: string, secret: string): Promise<void> {
    await this.sendAction('Login', { Username: username, Secret: secret, Events: 'on' });
  }

  /** Envia uma action simples e aguarda a resposta. Rejeita com `AmiActionError` em "Response: Error". */
  sendAction(
    action: string,
    fields: AmiActionFields = {},
    timeoutMs = this.actionTimeoutMs,
  ): Promise<AmiMessage> {
    return this.send(action, fields, false, timeoutMs) as Promise<AmiMessage>;
  }

  /**
   * Envia uma action de lista (ex.: CoreShowChannels) e aguarda todos os itens até o
   * evento final com "EventList: Complete".
   */
  sendListAction(
    action: string,
    fields: AmiActionFields = {},
    timeoutMs = this.listTimeoutMs,
  ): Promise<AmiListResult> {
    return this.send(action, fields, true, timeoutMs) as Promise<AmiListResult>;
  }

  /** Encerra a conexão (envia Logoff quando possível). */
  async close(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.sendAction('Logoff', {}, 2_000);
    } catch {
      // o Asterisk pode fechar antes de responder; não é um problema
    }
    this.socket?.destroy();
  }

  /** Fecha imediatamente, sem Logoff (ex.: keepalive falhou). */
  destroy(reason?: Error): void {
    if (reason) this.closeError ??= reason;
    this.socket?.destroy();
  }

  // ---------------------------------------------------------------------------

  private send(
    action: string,
    fields: AmiActionFields,
    isList: boolean,
    timeoutMs: number,
  ): Promise<AmiMessage | AmiListResult> {
    if (!this.connected) return Promise.reject(new AmiDisconnectedError(action));

    const actionId = `${this.idPrefix}-${++this.seq}`;
    let packet: string;
    try {
      packet = serializeAction({ Action: action, ActionID: actionId, ...normalizeFields(fields) });
    } catch (err) {
      return Promise.reject(err as Error);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject(new AmiTimeoutError(action, timeoutMs));
      }, timeoutMs);
      this.pending.set(actionId, { action, isList, resolve, reject, timer, events: [] });
      this.socket!.write(packet);
    });
  }

  /** Encaminha cada mensagem recebida: resposta de action, item de lista ou evento assíncrono. */
  private dispatch(msg: AmiMessage): void {
    this.emit('message', msg);
    const pending = msg.actionid ? this.pending.get(msg.actionid) : undefined;

    if (msg.response !== undefined) {
      if (!pending) return; // resposta de action já expirada
      this.handleResponse(msg.actionid!, pending, msg);
      return;
    }

    if (msg.event !== undefined) {
      if (pending?.isList && pending.response) {
        if (msg.eventlist?.toLowerCase() === 'complete') {
          this.finish(msg.actionid!, pending);
          pending.resolve({ response: pending.response, events: pending.events, complete: msg });
        } else {
          pending.events.push(msg);
        }
        return;
      }
      // Eventos com ActionID que não pertencem a uma lista em andamento (ex.: OriginateResponse)
      // seguem como eventos normais.
      this.emit('event', msg);
    }
  }

  private handleResponse(actionId: string, pending: Pending, msg: AmiMessage): void {
    if (msg.response?.toLowerCase() === 'error') {
      this.finish(actionId, pending);
      pending.reject(new AmiActionError(pending.action, msg));
      return;
    }
    if (!pending.isList) {
      this.finish(actionId, pending);
      pending.resolve(msg);
      return;
    }
    // Lista: a resposta inicial abre a coleta. Se não indicar lista, não haverá itens.
    if (msg.eventlist?.toLowerCase() === 'start') {
      pending.response = msg;
    } else {
      this.finish(actionId, pending);
      pending.resolve({ response: msg, events: [], complete: msg });
    }
  }

  private finish(actionId: string, pending: Pending): void {
    clearTimeout(pending.timer);
    this.pending.delete(actionId);
  }

  private failAllPending(): void {
    for (const [actionId, pending] of this.pending) {
      this.finish(actionId, pending);
      pending.reject(new AmiDisconnectedError(pending.action));
    }
  }
}

/** Converte os campos para texto e remove os indefinidos. */
function normalizeFields(fields: AmiActionFields): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value : String(value);
  }
  return out;
}
