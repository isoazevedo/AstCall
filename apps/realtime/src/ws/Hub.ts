import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import {
  hasPermission,
  PROTOCOL_VERSION,
  WS_CLOSE,
  WS_PATH,
  type ServerId,
  type ServerMessage,
  type TokenClaims,
} from '@astcall/shared';
import { AuthError, type TokenVerifier } from '../auth/tokens.js';
import type { Logger } from '../logger.js';
import type { FeedSubscriber, ServerFeed } from './ServerFeed.js';

export interface HubOptions {
  /** Prazo para a primeira mensagem `auth`. */
  authTimeoutMs?: number;
  /** Folga após o `exp` do token antes de desconectar (o cliente deve renovar antes). */
  expiryGraceMs?: number;
  /** Intervalo do ping de keepalive. */
  pingIntervalMs?: number;
  /** Acima disso de dados pendentes no socket, o cliente é considerado lento e desconectado. */
  maxBufferedBytes?: number;
}

const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), token: z.string().min(1).max(8192) }),
  z.object({ t: z.literal('subscribe'), servers: z.array(z.string()).max(100) }),
  z.object({ t: z.literal('unsubscribe'), servers: z.array(z.string()).max(100) }),
  z.object({ t: z.literal('resync'), server: z.string() }),
]);

/**
 * Hub WebSocket: autentica os clientes, controla a que servidores cada um tem acesso e
 * liga as sessões aos `ServerFeed`s. Todo acesso exige a permissão `view` no servidor.
 */
export class Hub {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Set<Session>();
  private readonly pingTimer: NodeJS.Timeout;
  private readonly log: Logger;
  readonly opts: Required<HubOptions>;

  constructor(
    private readonly feeds: Map<ServerId, ServerFeed>,
    readonly verifier: Pick<TokenVerifier, 'verify'>,
    log: Logger,
    options: HubOptions = {},
  ) {
    this.log = log.child({ mod: 'ws' });
    this.opts = {
      authTimeoutMs: options.authTimeoutMs ?? 5_000,
      expiryGraceMs: options.expiryGraceMs ?? 5_000,
      pingIntervalMs: options.pingIntervalMs ?? 30_000,
      maxBufferedBytes: options.maxBufferedBytes ?? 4 * 1024 * 1024,
    };
    // noServer: o upgrade é tratado em attach(), só no caminho WS_PATH
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.pingTimer = setInterval(() => {
      for (const s of this.sessions) s.heartbeat();
    }, this.opts.pingIntervalMs);
  }

  /** Liga o hub ao servidor HTTP (upgrade apenas em WS_PATH). */
  attach(http: Server): void {
    http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== WS_PATH) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
  }

  /** Feed de um servidor, se o usuário puder vê-lo. */
  feedFor(claims: TokenClaims, serverId: ServerId): ServerFeed | undefined {
    const feed = this.feeds.get(serverId);
    return feed && hasPermission(claims.perms, serverId, 'view') ? feed : undefined;
  }

  /** Servidores visíveis para o usuário. */
  visibleFeeds(claims: TokenClaims): ServerFeed[] {
    return [...this.feeds.values()].filter((f) => hasPermission(claims.perms, f.serverId, 'view'));
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  close(): void {
    clearInterval(this.pingTimer);
    for (const s of this.sessions) s.close(WS_CLOSE.GOING_AWAY, 'servidor encerrando');
    this.wss.close();
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const session = new Session(ws, this, this.log.child({ ip: req.socket.remoteAddress }));
    this.sessions.add(session);
    ws.on('close', () => {
      session.dispose();
      this.sessions.delete(session);
    });
  }
}

/** Uma conexão WebSocket de um navegador. */
class Session implements FeedSubscriber {
  private claims: TokenClaims | undefined;
  private readonly subscribed = new Map<ServerId, ServerFeed>();
  private authTimer: NodeJS.Timeout | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  private alive = true;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ws: WebSocket,
    private readonly hub: Hub,
    private log: Logger,
  ) {
    this.authTimer = setTimeout(
      () => this.close(WS_CLOSE.AUTH_FAILED, 'autenticação não recebida'),
      hub.opts.authTimeoutMs,
    );
    ws.on('pong', () => (this.alive = true));
    // Mensagens processadas em ordem (a validação do token é assíncrona)
    ws.on('message', (data, isBinary) => {
      this.queue = this.queue.then(() => this.onMessage(data, isBinary));
    });
    ws.on('error', (err) => this.log.debug({ err: err.message }, 'Erro no WebSocket'));
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > this.hub.opts.maxBufferedBytes) {
      this.log.warn({ user: this.claims?.sub }, 'Cliente lento; desconectando');
      this.close(WS_CLOSE.TOO_SLOW, 'cliente não acompanha as atualizações');
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  heartbeat(): void {
    if (!this.alive) {
      this.ws.terminate();
      return;
    }
    this.alive = false;
    this.ws.ping();
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }

  dispose(): void {
    clearTimeout(this.authTimer);
    clearTimeout(this.expiryTimer);
    for (const feed of this.subscribed.values()) feed.unsubscribe(this);
    this.subscribed.clear();
  }

  // ---------------------------------------------------------------------------

  private async onMessage(data: RawData, isBinary: boolean): Promise<void> {
    let parsed;
    try {
      if (isBinary) throw new Error('binário');
      parsed = clientMessageSchema.safeParse(JSON.parse(data.toString()));
    } catch {
      parsed = undefined;
    }
    if (!parsed?.success) {
      this.close(WS_CLOSE.PROTOCOL_ERROR, 'mensagem inválida');
      return;
    }
    const msg = parsed.data;

    if (msg.t === 'auth') return this.authenticate(msg.token);
    if (!this.claims) {
      this.close(WS_CLOSE.AUTH_FAILED, 'autentique-se primeiro');
      return;
    }

    switch (msg.t) {
      case 'subscribe':
        for (const id of msg.servers) {
          const feed = this.hub.feedFor(this.claims, id);
          if (!feed) {
            this.send({ t: 'error', code: 'forbidden', message: `sem acesso ao servidor ${id}` });
            continue;
          }
          this.subscribed.set(id, feed);
          feed.subscribe(this);
        }
        break;
      case 'unsubscribe':
        for (const id of msg.servers) {
          this.subscribed.get(id)?.unsubscribe(this);
          this.subscribed.delete(id);
        }
        break;
      case 'resync':
        this.subscribed.get(msg.server)?.sendSnapshot(this);
        break;
    }
  }

  /** Primeira autenticação ou renovação (novo token antes de expirar). */
  private async authenticate(token: string): Promise<void> {
    let claims: TokenClaims;
    try {
      claims = await this.hub.verifier.verify(token);
    } catch (err) {
      const reason = err instanceof AuthError ? err.message : 'token inválido';
      this.log.warn({ reason }, 'Autenticação WebSocket recusada');
      this.send({ t: 'error', code: 'auth_failed', message: reason });
      this.close(WS_CLOSE.AUTH_FAILED, reason);
      return;
    }
    // Uma renovação não pode trocar de usuário na mesma conexão
    if (this.claims && (this.claims.sub !== claims.sub || this.claims.iss !== claims.iss)) {
      this.close(WS_CLOSE.AUTH_FAILED, 'token de outro usuário');
      return;
    }

    const first = !this.claims;
    this.claims = claims;
    this.log = this.log.child({ user: claims.sub });
    clearTimeout(this.authTimer);
    this.authTimer = undefined;
    this.scheduleExpiry(claims.exp * 1000);

    // Permissões podem ter mudado: sai dos servidores que não pode mais ver
    for (const [id, feed] of this.subscribed) {
      if (!this.hub.feedFor(claims, id)) {
        feed.unsubscribe(this);
        this.subscribed.delete(id);
      }
    }

    this.send({
      t: 'auth_ok',
      protocol: PROTOCOL_VERSION,
      user: { sub: claims.sub, name: claims.name },
      expiresAt: claims.exp * 1000,
      servers: this.hub
        .visibleFeeds(claims)
        .map((f) => ({ id: f.serverId, name: f.name, status: f.status })),
    });
    if (first) this.log.info('Cliente WebSocket autenticado');
  }

  private scheduleExpiry(expMs: number): void {
    clearTimeout(this.expiryTimer);
    const delay = Math.max(0, expMs - Date.now() + this.hub.opts.expiryGraceMs);
    this.expiryTimer = setTimeout(() => {
      this.send({ t: 'error', code: 'token_expired', message: 'token expirado' });
      this.close(WS_CLOSE.TOKEN_EXPIRED, 'token expirado');
    }, delay);
  }
}
