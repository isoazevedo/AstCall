import {
  WS_CLOSE,
  type ActionName,
  type ActionParams,
  type ActionResultMessage,
  type ClientMessage,
  type ServerMessage,
  type TokenResponse,
} from '@astcall/shared';

/** Situação da conexão, para a interface. */
export type ConnectionState =
  | 'idle'
  | 'connecting' // buscando token / abrindo o WebSocket
  | 'online' // autenticado e recebendo dados
  | 'reconnecting' // caiu; tentando de novo
  | 'auth-required' // sessão expirou: precisa de novo login
  | 'stopped';

export interface MonitorConnectionOptions {
  /** URL do WebSocket (pode ser relativa, ex.: "/monitor-ws"). */
  wsUrl: string;
  /** Endpoint que devolve { token, expiresAt } usando o cookie da sessão. */
  tokenUrl: string;
  onMessage: (msg: ServerMessage) => void;
  onState: (state: ConnectionState) => void;
  /** Renovar o token este tempo antes de expirar. */
  renewBeforeMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  // Injeções para teste
  fetchFn?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  baseUrl?: string;
}

/** O endpoint de token respondeu 401/403: não adianta tentar de novo sem login. */
class AuthRequiredError extends Error {}

/**
 * Conexão do navegador com o backend:
 * busca o token no `tokenUrl`, abre o WebSocket, autentica, assina todos os servidores
 * visíveis, renova o token antes de expirar e reconecta com backoff se a conexão cair.
 *
 * Não conhece Vue: entrega as mensagens em `onMessage` e o estado em `onState`.
 */
export class MonitorConnection {
  private ws: WebSocket | undefined;
  private state: ConnectionState = 'idle';
  private failures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private reqSeq = 0;
  private readonly pendingActions = new Map<
    string,
    { resolve: (r: ActionResultMessage) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly opts: Required<Omit<MonitorConnectionOptions, 'baseUrl'>> & { baseUrl?: string };

  constructor(options: MonitorConnectionOptions) {
    this.opts = {
      renewBeforeMs: 60_000,
      backoffMinMs: 1_000,
      backoffMaxMs: 30_000,
      fetchFn: (...args) => fetch(...args),
      WebSocketImpl: globalThis.WebSocket,
      ...options,
    };
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.renewTimer);
    this.ws?.close(1000, 'cliente encerrou');
    this.ws = undefined;
    this.setState('stopped');
  }

  /**
   * Pede uma ação ao backend e aguarda o `action_result` (no máximo 10 s).
   * Nunca rejeita: falhas viram { ok: false, code, error }.
   */
  sendAction<K extends ActionName>(
    server: string,
    name: K,
    params: ActionParams[K],
  ): Promise<ActionResultMessage> {
    const reqId = `a${++this.reqSeq}`;
    if (this.ws?.readyState !== 1 || this.state !== 'online') {
      return Promise.resolve(fail(reqId, 'disconnected', 'sem conexão com o servidor'));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(reqId);
        resolve(fail(reqId, 'timeout', 'o servidor não respondeu a tempo'));
      }, 10_000);
      this.pendingActions.set(reqId, { resolve, timer });
      this.send({ t: 'action', reqId, server, name, params } as ClientMessage);
    });
  }

  /** Pede um snapshot novo de um servidor (ex.: lacuna na numeração dos deltas). */
  resync(server: string): void {
    this.send({ t: 'resync', server });
  }

  // ---------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setState(this.failures > 0 ? 'reconnecting' : 'connecting');

    let token: string;
    try {
      token = (await this.fetchToken()).token;
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        this.setState('auth-required');
        return; // sem sessão: aguarda novo login (start() de novo)
      }
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    const ws = new this.opts.WebSocketImpl(this.absoluteWsUrl());
    this.ws = ws;
    ws.onopen = () => this.send({ t: 'auth', token });
    ws.onmessage = (ev) => this.onRawMessage(ev.data);
    ws.onclose = (ev) => this.onClose(ws, ev.code);
  }

  private onRawMessage(data: unknown): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(data)) as ServerMessage;
    } catch {
      return;
    }
    if (msg.t === 'action_result') {
      const pending = this.pendingActions.get(msg.reqId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingActions.delete(msg.reqId);
        pending.resolve(msg);
      }
      return;
    }
    if (msg.t === 'auth_ok') {
      const firstAuth = this.state !== 'online';
      this.failures = 0;
      this.setState('online');
      this.scheduleRenew(msg.expiresAt);
      // Na primeira autenticação desta conexão, assina todos os servidores visíveis
      if (firstAuth) this.send({ t: 'subscribe', servers: msg.servers.map((s) => s.id) });
    }
    this.opts.onMessage(msg);
  }

  private onClose(ws: WebSocket, code: number): void {
    if (ws !== this.ws) return; // conexão antiga
    this.ws = undefined;
    clearTimeout(this.renewTimer);
    // Ações sem resposta: a conexão caiu, não dá para saber se foram executadas
    for (const [reqId, p] of this.pendingActions) {
      clearTimeout(p.timer);
      p.resolve(fail(reqId, 'disconnected', 'a conexão caiu antes da confirmação'));
    }
    this.pendingActions.clear();
    if (this.stopped) return;
    // Toda reconexão busca um token novo no token-url; se a sessão acabou, ele responde
    // 401 e o estado vira "auth-required". Códigos de auth só aparecem no log.
    if (code === WS_CLOSE.AUTH_FAILED || code === WS_CLOSE.TOKEN_EXPIRED) {
      console.info(`[ast-monitor] conexão fechada pelo servidor (${code}); renovando token`);
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.failures++;
    this.setState('reconnecting');
    const exp = Math.max(0, this.failures - 1);
    const base = Math.min(this.opts.backoffMaxMs, this.opts.backoffMinMs * 2 ** exp);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  /** Renova o token antes de expirar e reenvia `auth` na mesma conexão. */
  private scheduleRenew(expiresAt: number): void {
    clearTimeout(this.renewTimer);
    const delay = Math.max(5_000, expiresAt - Date.now() - this.opts.renewBeforeMs);
    this.renewTimer = setTimeout(async () => {
      try {
        const { token } = await this.fetchToken();
        this.send({ t: 'auth', token });
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          this.stopped = true;
          this.ws?.close(1000, 'sessão expirada');
          this.setState('auth-required');
        } else {
          this.scheduleRenew(Date.now() + this.opts.renewBeforeMs + 10_000); // tenta em ~10 s
        }
      }
    }, delay);
  }

  private async fetchToken(): Promise<TokenResponse> {
    const res = await this.opts.fetchFn(this.opts.tokenUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) throw new AuthRequiredError();
    if (!res.ok) throw new Error(`token-url respondeu ${res.status}`);
    return (await res.json()) as TokenResponse;
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === 1 /* OPEN */) this.ws.send(JSON.stringify(msg));
  }

  private absoluteWsUrl(): string {
    const base = this.opts.baseUrl ?? globalThis.location?.href ?? 'http://localhost/';
    const url = new URL(this.opts.wsUrl, base);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    return url.toString();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState(state);
  }
}

function fail(reqId: string, code: string, error: string): ActionResultMessage {
  return { t: 'action_result', reqId, ok: false, code, error };
}
