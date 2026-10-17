import { z } from 'zod';
import { ALL_SERVERS, PERMISSIONS, type AdminUser, type Permission } from '@astcall/shared';
import type { AuditLog } from '../audit/AuditLog.js';
import {
  HttpError,
  readJson,
  sendJson,
  type RequestContext,
  type RouteHandler,
} from '../http/server.js';
import type { Logger } from '../logger.js';
import type { TokenVerifier } from './tokens.js';
import type { User, UserRepository } from './UserRepository.js';

export interface AdminRoutesDeps {
  users: UserRepository;
  verifier: Pick<TokenVerifier, 'verify'>;
  /** Emissor local: só tokens do próprio AstCall administram usuários (nunca os do AzCall). */
  localIssuer: string;
  log: Logger;
  audit?: AuditLog;
}

const username = z
  .string()
  .trim()
  .min(1, 'informe o usuário')
  .max(64)
  .regex(/^[a-z0-9._@-]+$/i, 'usuário: use letras, números e . _ @ -');
const perms = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);

const createSchema = z.object({
  username,
  name: z.string().trim().max(100).default(''),
  password: z.string().min(1, 'informe a senha').max(200),
  perms,
});
const updateSchema = z.object({
  username,
  name: z.string().trim().max(100).optional(),
  perms: perms.optional(),
  active: z.boolean().optional(),
});
const passwordSchema = z.object({ username, password: z.string().min(1).max(200) });
const removeSchema = z.object({ username });

/** Permissões do usuário em todos os servidores (a tela trabalha só com a chave "*"). */
const globalPerms = (u: User): Permission[] => u.perms[ALL_SERVERS] ?? [];
const isAdmin = (u: User) => u.active && globalPerms(u).includes('users');

function toAdminUser(u: User): AdminUser {
  return {
    username: u.username,
    name: u.name,
    perms: globalPerms(u),
    active: u.active,
    createdAt: u.createdAt,
  };
}

/**
 * Administração dos usuários do modo standalone (tela "Usuários" da SPA):
 *
 *   GET  /admin/users            → AdminUser[]
 *   POST /admin/users            { username, name, password, perms }  → 201 AdminUser
 *   POST /admin/users/update     { username, name?, perms?, active? } → AdminUser
 *   POST /admin/users/password   { username, password }              → 204
 *   POST /admin/users/remove     { username }                        → 204
 *
 * As permissões valem para todos os servidores (chave "*").
 *
 * Autorização: `Authorization: Bearer <token>` emitido pelo próprio AstCall, de um usuário
 * que — no banco, agora — está ativo e tem a permissão `users`. O banco é a fonte: um
 * administrador desativado perde o acesso na hora, sem esperar o token expirar. Como o token
 * vai num cabeçalho (não em cookie), não há risco de CSRF.
 *
 * Proteções: ninguém desativa, remove ou tira a própria permissão `users`, e sempre sobra
 * ao menos um administrador ativo. Tudo vai para a auditoria (sem senhas).
 */
export function adminRoutes(deps: AdminRoutesDeps): Record<string, RouteHandler> {
  const { users, verifier, localIssuer, log, audit } = deps;

  /** Confere o token e devolve o administrador que fez a requisição. */
  async function authorize(ctx: RequestContext): Promise<User> {
    const token = /^Bearer (.+)$/i.exec(ctx.req.headers.authorization ?? '')?.[1];
    if (!token) throw new HttpError(401, 'autenticação necessária');
    let sub: string;
    try {
      const claims = await verifier.verify(token);
      if (claims.iss !== localIssuer) throw new Error('emissor externo');
      sub = claims.sub;
    } catch {
      throw new HttpError(401, 'sessão expirada; faça login novamente');
    }
    const me = users.getByUsername(sub);
    if (!me || !isAdmin(me)) throw new HttpError(403, 'sem permissão para gerenciar usuários');
    return me;
  }

  async function body<T>(ctx: RequestContext, schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(await readJson(ctx.req));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'dados inválidos');
    }
    return parsed.data;
  }

  function target(name: string): User {
    const u = users.getByUsername(name);
    if (!u) throw new HttpError(404, `usuário "${name}" não encontrado`);
    return u;
  }

  /** Quantos administradores ativos restariam sem `who`. */
  function adminsWithout(who: string): number {
    return users.listUsers().filter((u) => isAdmin(u) && u.username !== who).length;
  }

  /** Executa a operação traduzindo erros do repositório (ex.: senha curta, usuário repetido). */
  function run(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  function record(me: User, action: string, params: Record<string, unknown>): void {
    audit?.write({
      ts: new Date().toISOString(),
      user: me.username,
      name: me.name,
      iss: localIssuer,
      server: '-',
      action,
      params,
      ok: true,
    });
    log.info({ admin: me.username, action, ...params }, 'Administração de usuários');
  }

  return {
    'GET /admin/users': async (ctx) => {
      await authorize(ctx);
      sendJson(ctx.res, 200, users.listUsers().map(toAdminUser));
    },

    'POST /admin/users': async (ctx) => {
      const me = await authorize(ctx);
      const b = await body(ctx, createSchema);
      let created: User | undefined;
      run(() => {
        created = users.createUser({
          username: b.username,
          name: b.name || b.username,
          password: b.password,
          perms: { [ALL_SERVERS]: b.perms },
        });
      });
      record(me, 'userCreate', { username: b.username, perms: b.perms });
      sendJson(ctx.res, 201, toAdminUser(created!));
    },

    'POST /admin/users/update': async (ctx) => {
      const me = await authorize(ctx);
      const b = await body(ctx, updateSchema);
      const u = target(b.username);
      const losesAdmin =
        isAdmin(u) && (b.active === false || (b.perms !== undefined && !b.perms.includes('users')));
      if (losesAdmin && u.username === me.username) {
        throw new HttpError(
          400,
          'você não pode desativar a si mesmo nem tirar a própria permissão de gerenciar usuários',
        );
      }
      if (losesAdmin && adminsWithout(u.username) === 0) {
        throw new HttpError(400, 'é preciso manter ao menos um administrador ativo');
      }
      run(() => {
        if (b.name !== undefined) users.setName(u.username, b.name || u.username);
        if (b.perms !== undefined) users.setPerms(u.username, { [ALL_SERVERS]: b.perms });
        if (b.active !== undefined) users.setActive(u.username, b.active); // desativar encerra as sessões
      });
      record(me, 'userUpdate', {
        username: u.username,
        name: b.name,
        perms: b.perms,
        active: b.active,
      });
      sendJson(ctx.res, 200, toAdminUser(target(u.username)));
    },

    'POST /admin/users/password': async (ctx) => {
      const me = await authorize(ctx);
      const b = await body(ctx, passwordSchema);
      const u = target(b.username);
      run(() => users.setPassword(u.username, b.password)); // encerra as sessões dele
      record(me, 'userPassword', { username: u.username });
      ctx.res.statusCode = 204;
      ctx.res.end();
    },

    'POST /admin/users/remove': async (ctx) => {
      const me = await authorize(ctx);
      const b = await body(ctx, removeSchema);
      const u = target(b.username);
      if (u.username === me.username) throw new HttpError(400, 'você não pode remover a si mesmo');
      if (isAdmin(u) && adminsWithout(u.username) === 0) {
        throw new HttpError(400, 'é preciso manter ao menos um administrador ativo');
      }
      run(() => users.removeUser(u.username));
      record(me, 'userRemove', { username: u.username });
      ctx.res.statusCode = 204;
      ctx.res.end();
    },
  };
}
