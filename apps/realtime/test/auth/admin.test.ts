import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdminUser } from '@astcall/shared';
import { AuditLog } from '../../src/audit/AuditLog.js';
import { adminRoutes, LocalIssuer, TokenVerifier, UserRepository } from '../../src/auth/index.js';
import type { AuthConfig } from '../../src/config/index.js';
import { createHttpServer } from '../../src/http/server.js';
import { createLogger } from '../../src/logger.js';

const log = createLogger('silent', false);
const PASSWORD = 'senha-forte-123';

let dir: string;
let auth: AuthConfig;
let azcallKey: CryptoKey;
let issuer: LocalIssuer;
let verifier: TokenVerifier;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'astcall-admin-'));
  const local = await generateKeyPair('RS256', { extractable: true });
  const ext = await generateKeyPair('RS256', { extractable: true });
  azcallKey = ext.privateKey;
  writeFileSync(join(dir, 'priv.pem'), await exportPKCS8(local.privateKey));
  writeFileSync(join(dir, 'pub.pem'), await exportSPKI(local.publicKey));
  writeFileSync(join(dir, 'azcall.pem'), await exportSPKI(ext.publicKey));
  auth = {
    mode: 'both',
    ttlSeconds: 600,
    local: {
      issuer: 'astcall',
      privateKeyFile: join(dir, 'priv.pem'),
      publicKeyFile: join(dir, 'pub.pem'),
      usersDbFile: ':memory:',
      refreshTtlHours: 12,
      cookieSecure: false,
    },
    external: { issuer: 'azcall', publicKeyFile: join(dir, 'azcall.pem') },
  };
  issuer = await LocalIssuer.create(auth);
  verifier = await TokenVerifier.create(auth);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let base: string;
let repo: UserRepository;
let auditFile: string;
let audit: AuditLog;

beforeEach(async () => {
  repo = await UserRepository.open(':memory:', { bcryptCost: 4 });
  // admin: pode gerenciar usuários; ana: só vê o painel
  repo.createUser({
    username: 'admin',
    name: 'Admin',
    password: PASSWORD,
    perms: { '*': ['view', 'users'] },
  });
  repo.createUser({ username: 'ana', name: 'Ana', password: PASSWORD, perms: { '*': ['view'] } });
  auditFile = join(dir, `audit-${Date.now()}-${Math.random()}.jsonl`);
  audit = new AuditLog(auditFile, log);
  const routes = adminRoutes({ users: repo, verifier, localIssuer: 'astcall', log, audit });
  const server = createHttpServer(routes, { trustProxy: false, log });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return () => server.close();
});

/** Token do próprio AstCall com as permissões atuais do usuário no banco. */
async function tokenOf(username: string): Promise<string> {
  const u = repo.getByUsername(username)!;
  return (await issuer.issue(u)).token;
}

async function call(path: string, token: string | null, body?: unknown, method = 'POST') {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const list = async (token: string) =>
  (await call('/admin/users', token, undefined, 'GET')).body as AdminUser[];

describe('autorização', () => {
  it('exige token; recusa quem não tem a permissão users', async () => {
    expect((await call('/admin/users', null, undefined, 'GET')).status).toBe(401);
    expect((await call('/admin/users', 'lixo', undefined, 'GET')).status).toBe(401);
    expect((await call('/admin/users', await tokenOf('ana'), undefined, 'GET')).status).toBe(403);
    expect((await call('/admin/users', await tokenOf('admin'), undefined, 'GET')).status).toBe(200);
  });

  it('token do AzCall nunca administra usuários, mesmo com a permissão users', async () => {
    const token = await new SignJWT({ name: 'X', perms: { '*': ['users'] } })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('admin') // mesmo nome de um administrador local
      .setIssuer('azcall')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(azcallKey);
    expect((await call('/admin/users', token, undefined, 'GET')).status).toBe(401);
  });

  it('administrador desativado perde o acesso na hora (vale o banco, não o token)', async () => {
    const token = await tokenOf('admin');
    repo.createUser({
      username: 'bia',
      name: 'Bia',
      password: PASSWORD,
      perms: { '*': ['users'] },
    });
    repo.setActive('admin', false);
    expect((await call('/admin/users', token, undefined, 'GET')).status).toBe(403);
  });
});

describe('operações', () => {
  it('lista, cria, altera nome/permissões, desativa e remove', async () => {
    const t = await tokenOf('admin');
    expect((await list(t)).map((u) => u.username)).toEqual(['admin', 'ana']);

    const created = await call('/admin/users', t, {
      username: 'carla',
      name: 'Carla',
      password: PASSWORD,
      perms: ['view', 'queue'],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      username: 'carla',
      perms: ['view', 'queue'],
      active: true,
    });
    expect(repo.verifyPassword('carla', PASSWORD)?.perms).toEqual({ '*': ['view', 'queue'] });

    const upd = await call('/admin/users/update', t, {
      username: 'carla',
      name: 'Carla Souza',
      perms: ['view'],
      active: false,
    });
    expect(upd.body).toMatchObject({ name: 'Carla Souza', perms: ['view'], active: false });

    expect((await call('/admin/users/remove', t, { username: 'carla' })).status).toBe(204);
    expect(repo.getByUsername('carla')).toBeUndefined();
  });

  it('troca a senha (mínimo de 10 caracteres)', async () => {
    const t = await tokenOf('admin');
    expect(
      (await call('/admin/users/password', t, { username: 'ana', password: 'curta' })).status,
    ).toBe(400);
    expect(
      (await call('/admin/users/password', t, { username: 'ana', password: 'nova-senha-456' }))
        .status,
    ).toBe(204);
    expect(repo.verifyPassword('ana', 'nova-senha-456')).toBeDefined();
  });

  it('valida dados: usuário repetido, inválido ou inexistente; permissão desconhecida', async () => {
    const t = await tokenOf('admin');
    const create = (b: object) =>
      call('/admin/users', t, { username: 'x', password: PASSWORD, perms: [], ...b });
    expect((await create({ username: 'ana' })).body.error).toMatch(/já existe/);
    expect((await create({ username: 'com espaço' })).status).toBe(400);
    expect((await create({ perms: ['root'] })).status).toBe(400);
    expect((await call('/admin/users/update', t, { username: 'ze', name: 'x' })).status).toBe(404);
  });
});

describe('proteções', () => {
  it('ninguém desativa, remove ou tira a própria permissão de administrar', async () => {
    const t = await tokenOf('admin');
    expect(
      (await call('/admin/users/update', t, { username: 'admin', active: false })).status,
    ).toBe(400);
    expect(
      (await call('/admin/users/update', t, { username: 'admin', perms: ['view'] })).status,
    ).toBe(400);
    expect((await call('/admin/users/remove', t, { username: 'admin' })).status).toBe(400);
    // mudar o próprio nome pode
    expect(
      (await call('/admin/users/update', t, { username: 'admin', name: 'Chefe' })).status,
    ).toBe(200);
  });

  it('sempre sobra ao menos um administrador ativo', async () => {
    repo.createUser({
      username: 'bia',
      name: 'Bia',
      password: PASSWORD,
      perms: { '*': ['users'] },
    });
    const tBia = await tokenOf('bia');
    // bia pode tirar o admin (ainda sobra ela)
    expect(
      (await call('/admin/users/update', tBia, { username: 'admin', perms: ['view'] })).status,
    ).toBe(200);
    // agora bia é a única: ninguém consegue tirá-la (ela mesma também não)
    expect((await call('/admin/users/remove', tBia, { username: 'bia' })).status).toBe(400);
  });

  it('registra na auditoria, sem senhas', async () => {
    const t = await tokenOf('admin');
    await call('/admin/users', t, {
      username: 'dani',
      name: 'Dani',
      password: PASSWORD,
      perms: ['view'],
    });
    await call('/admin/users/password', t, { username: 'dani', password: 'outra-senha-789' });
    await audit.close();
    const text = readFileSync(auditFile, 'utf8');
    const lines = text
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.action)).toEqual(['userCreate', 'userPassword']);
    expect(lines[0]).toMatchObject({ user: 'admin', params: { username: 'dani' } });
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('outra-senha-789');
  });
});
