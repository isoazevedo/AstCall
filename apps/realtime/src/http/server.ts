import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '../logger.js';

/** Contexto de uma requisição já interpretada. */
export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** IP do cliente (considera X-Forwarded-For quando `trustProxy`). */
  ip: string;
  cookies: Record<string, string>;
}

export type RouteHandler = (ctx: RequestContext) => Promise<void> | void;

/** Erro com status HTTP e mensagem segura para devolver ao cliente. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Servidor HTTP mínimo (node:http) com roteamento exato por "MÉTODO /caminho".
 * Atende só as rotas de autenticação; o WebSocket (item 5) usa o mesmo servidor.
 */
export function createHttpServer(
  routes: Record<string, RouteHandler>,
  options: { trustProxy: boolean; log: Logger },
): Server {
  const log = options.log.child({ mod: 'http' });

  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const handler = routes[`${req.method} ${path}`];
    const ctx: RequestContext = {
      req,
      res,
      ip: clientIp(req, options.trustProxy),
      cookies: parseCookies(req.headers.cookie),
    };

    // Respostas de API nunca devem ser cacheadas (contêm tokens)
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (!handler) {
      sendJson(res, 404, { error: 'não encontrado' });
      return;
    }
    Promise.resolve()
      .then(() => handler(ctx))
      .catch((err: unknown) => {
        if (err instanceof HttpError) {
          for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
          sendJson(res, err.status, { error: err.message });
          return;
        }
        log.error({ err: (err as Error).message, path }, 'Erro interno na requisição');
        if (!res.headersSent) sendJson(res, 500, { error: 'erro interno' });
      });
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** Lê o corpo JSON com limite de tamanho. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'envie Content-Type: application/json');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'corpo da requisição muito grande');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export interface CookieOptions {
  path: string;
  maxAgeSeconds: number;
  secure: boolean;
}

/** Cookie HttpOnly + SameSite=Strict (não acessível por JS nem enviado de outros sites). */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'desconhecido';
}
