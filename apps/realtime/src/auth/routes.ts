import { z } from 'zod';
import type { LoginResponse, TokenResponse } from '@astcall/shared';
import type { AuthConfig } from '../config/index.js';
import {
  HttpError,
  readJson,
  sendJson,
  serializeCookie,
  type RequestContext,
  type RouteHandler,
} from '../http/server.js';
import type { Logger } from '../logger.js';
import { RateLimiter } from './RateLimiter.js';
import type { LocalIssuer } from './tokens.js';
import type { UserRepository } from './UserRepository.js';

/** Nome do cookie de renovação. Restrito ao caminho /auth: não vai junto em outras requisições. */
export const REFRESH_COOKIE = 'astcall_refresh';
const COOKIE_PATH = '/auth';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

export interface AuthRoutesDeps {
  users: UserRepository;
  issuer: LocalIssuer;
  config: AuthConfig;
  log: Logger;
  limiter?: RateLimiter;
}

/**
 * Rotas do modo standalone:
 * - POST /auth/login   { username, password } → LoginResponse + cookie de renovação
 * - POST /auth/refresh (cookie)               → TokenResponse + cookie novo (rotação)
 * - POST /auth/logout  (cookie)               → 204, encerra a sessão
 *
 * O `/auth/refresh` é o `token-url` do Web Component no modo standalone.
 */
export function authRoutes(deps: AuthRoutesDeps): Record<string, RouteHandler> {
  const { users, issuer, config, log } = deps;
  const limiter = deps.limiter ?? new RateLimiter();
  const refreshTtlMs = config.local.refreshTtlHours * 3_600_000;

  const setRefreshCookie = (ctx: RequestContext, secret: string, expiresAt: number) => {
    ctx.res.setHeader(
      'Set-Cookie',
      serializeCookie(REFRESH_COOKIE, secret, {
        path: COOKIE_PATH,
        maxAgeSeconds: (expiresAt - Date.now()) / 1000,
        secure: config.local.cookieSecure,
      }),
    );
  };

  const clearRefreshCookie = (ctx: RequestContext) => {
    ctx.res.setHeader(
      'Set-Cookie',
      serializeCookie(REFRESH_COOKIE, '', {
        path: COOKIE_PATH,
        maxAgeSeconds: 0,
        secure: config.local.cookieSecure,
      }),
    );
  };

  return {
    'POST /auth/login': async (ctx) => {
      const parsed = loginSchema.safeParse(await readJson(ctx.req));
      if (!parsed.success) throw new HttpError(400, 'informe usuário e senha');
      const { username, password } = parsed.data;

      const keys = [`ip:${ctx.ip}`, `user:${username.toLowerCase()}`];
      const wait = limiter.blockedFor(keys);
      if (wait > 0) {
        log.warn({ ip: ctx.ip, username }, 'Login bloqueado por excesso de tentativas');
        throw new HttpError(429, 'muitas tentativas; aguarde e tente novamente', {
          'Retry-After': String(wait),
        });
      }

      const user = users.verifyPassword(username, password);
      if (!user) {
        limiter.fail(keys);
        log.warn({ ip: ctx.ip, username }, 'Falha de login');
        throw new HttpError(401, 'usuário ou senha inválidos'); // mesma mensagem para tudo
      }
      limiter.reset(keys);

      const session = users.createSession(user.id, refreshTtlMs);
      const { token, expiresAt } = await issuer.issue(user);
      setRefreshCookie(ctx, session.secret, session.expiresAt);
      log.info({ ip: ctx.ip, username: user.username }, 'Login');

      const body: LoginResponse = {
        token,
        expiresAt,
        user: { username: user.username, name: user.name, perms: user.perms },
      };
      sendJson(ctx.res, 200, body);
    },

    'POST /auth/refresh': async (ctx) => {
      const secret = ctx.cookies[REFRESH_COOKIE];
      const rotated = secret ? users.rotateSession(secret, refreshTtlMs) : undefined;
      if (!rotated) {
        clearRefreshCookie(ctx);
        throw new HttpError(401, 'sessão expirada; faça login novamente');
      }
      // Permissões vêm do banco a cada renovação: alterações valem no próximo token
      const { token, expiresAt } = await issuer.issue(rotated.user);
      setRefreshCookie(ctx, rotated.session.secret, rotated.session.expiresAt);
      const body: TokenResponse = { token, expiresAt };
      sendJson(ctx.res, 200, body);
    },

    'POST /auth/logout': (ctx) => {
      const secret = ctx.cookies[REFRESH_COOKIE];
      if (secret) users.revokeSession(secret);
      clearRefreshCookie(ctx);
      ctx.res.statusCode = 204;
      ctx.res.end();
    },
  };
}
