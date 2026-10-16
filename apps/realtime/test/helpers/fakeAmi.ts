import { createServer, type Server, type Socket } from 'node:net';
import { parseBlock, serializeAction } from '../../src/ami/AmiParser.js';
import type { AmiMessage } from '../../src/ami/types.js';

/** Resposta do servidor falso a uma action: mensagens a enviar (o ActionID é preenchido sozinho). */
export type FakeReply = Record<string, string | undefined>;
export type FakeHandler = (action: AmiMessage, socket: Socket) => FakeReply[] | void;

/**
 * Servidor AMI falso para testes: aceita conexões TCP locais, envia a saudação e
 * responde às actions conforme os handlers registrados. Login aceita usuário "user"/"pass".
 */
export class FakeAmiServer {
  readonly received: AmiMessage[] = [];
  readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private readonly handlers = new Map<string, FakeHandler>();
  port = 0;

  constructor() {
    this.server = createServer((socket) => this.onConnection(socket));
    this.on('login', (a) => [
      a.username === 'user' && a.secret === 'pass'
        ? { Response: 'Success', Message: 'Authentication accepted' }
        : { Response: 'Error', Message: 'Authentication failed' },
    ]);
    this.on('ping', () => [{ Response: 'Success', Ping: 'Pong' }]);
    this.on('logoff', (_a, socket) => {
      setImmediate(() => socket.end());
      return [{ Response: 'Goodbye', Message: 'Thanks for all the fish.' }];
    });
  }

  /** Registra o comportamento para uma action (nome em minúsculas). */
  on(action: string, handler: FakeHandler): this {
    this.handlers.set(action.toLowerCase(), handler);
    return this;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    if (addr && typeof addr === 'object') this.port = addr.port;
  }

  /** Envia um evento para todos os clientes conectados. */
  broadcast(fields: Record<string, string>): void {
    for (const s of this.sockets) s.write(serializeAction(fields));
  }

  /** Derruba todas as conexões (simula queda do Asterisk). */
  dropAll(): void {
    for (const s of this.sockets) s.destroy();
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.write('Asterisk Call Manager/11.0.0\r\n');

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\r\n\r\n')) !== -1) {
        const action = parseBlock(buffer.slice(0, end));
        buffer = buffer.slice(end + 4);
        if (action) this.handle(action, socket);
      }
    });
  }

  private handle(action: AmiMessage, socket: Socket): void {
    this.received.push(action);
    const handler = this.handlers.get((action.action ?? '').toLowerCase());
    const replies = handler
      ? handler(action, socket)
      : [{ Response: 'Error', Message: 'Invalid/unknown command' }];
    for (const reply of replies ?? []) {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(reply)) if (v !== undefined) fields[k] = v;
      socket.write(serializeAction({ ...fields, ActionID: action.actionid ?? '' }));
    }
  }
}
