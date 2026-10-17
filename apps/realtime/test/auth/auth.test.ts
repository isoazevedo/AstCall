import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasPermission, type LoginResponse, type TokenResponse } from '@astcall/shared';
import {
  authRoutes,
  LocalIssuer,
  RateLimiter,
  REFRESH_COOKIE,
  TokenVerifier,
  UserRepository,
} from '../../src/auth/index.js';
import type { AuthConfig } from '../../src/config/index.js';
import { createHttpServer } from '../../src/http/server.js';
import { createLogger } from '../../src/logger.js';

const log = createLogger('silent', false);
const PASSWORD = 'senha-forte-123';

let dir: string;
let auth: AuthConfig;
/** Chave privada do "AzCall" (emissor externo) para gerar tokens nos testes. */
let azcallKey: CryptoKey;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'astcall-auth-'));
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
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('tokens', () => {
  it('emite e valida um token local com as permissões', async () => {
    const issuer = await LocalIssuer.create(auth);
    const verifier = await TokenVerifier.create(auth);
    const { token, expiresAt } = await issuer.issue({
      username: 'ana',
      name: 'Ana',
      perms: { pbx1: ['view', 'hangup'] },
    });
    const claims = await verifier.verify(token);
    expect(claims).toMatchObject({ sub: 'ana', name: 'Ana', iss: 'astcall' });
    expect(claims.exp * 1000).toBe(expiresAt);
    expect(hasPermission(claims.perms, 'pbx1', 'hangup')).toBe(true);
    expect(hasPermission(claims.perms, 'pbx1', 'spy')).toBe(false);
  });

  it('aceita token do emissor externo (AzCall) assinado com a chave dele', async () => {
    const verifier = await TokenVerifier.create(auth);
    const token = await new SignJWT({ name: 'Bia', perms: { '*': ['view'] } })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('bia')
      .setIssuer('azcall')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(azcallKey);
    const claims = await verifier.verify(token);
    expect(hasPermission(claims.perms, 'qualquer', 'view')).toBe(true);
  });

  it('rejeita token assinado com chave errada para o emissor', async () => {
    const verifier = await TokenVerifier.create(auth);
    const forged = await new SignJWT({ name: 'X', perms: { '*': ['view'] } })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('x')
      .setIssuer('astcall') // finge ser o emissor local, mas assina com a chave do AzCall
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(azcallKey);
    await expect(verifier.verify(forged)).rejects.toThrow(/assinatura/);
  });

  it('rejeita emissor desconhecido, token expirado, malformado e perms em formato inválido', async () => {
    const verifier = await TokenVerifier.create(auth);
    const sign = (claims: Record<string, unknown>, iss: string, exp: string | number) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('x')
        .setIssuer(iss)
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(azcallKey);

    await expect(verifier.verify(await sign({ perms: {} }, 'outro', '5m'))).rejects.toThrow(
      /emissor não aceito/,
    );
    const past = Math.floor(Date.now() / 1000) - 120;
    await expect(verifier.verify(await sign({ perms: {} }, 'azcall', past))).rejects.toThrow(
      /expirado/,
    );
    await expect(verifier.verify('isso.nao.e-um-jwt')).rejects.toThrow(/malformado/);
    await expect(
      verifier.verify(await sign({ perms: { pbx1: 'view' } }, 'azcall', '5m')),
    ).rejects.toThrow(/claims inválidas/);
  });

  it('ignora permissões desconhecidas (emissor mais novo que o backend)', async () => {
    const verifier = await TokenVerifier.create(auth);
    const token = await new SignJWT({ name: 'Bia', perms: { pbx1: ['view', 'teleporte'] } })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('bia')
      .setIssuer('azcall')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(azcallKey);
    const claims = await verifier.verify(token);
    expect(claims.perms).toEqual({ pbx1: ['view'] });
  });

  it('no modo local não aceita tokens do AzCall', async () => {
    const verifier = await TokenVerifier.create({ ...auth, mode: 'local' });
    expect(verifier.issuers).toEqual(['astcall']);
  });
});

describe('UserRepository', () => {
  let repo: UserRepository;
  beforeEach(async () => {
    repo = await UserRepository.open(':memory:', { bcryptCost: 4 });
  });

  it('cria usuário e confere a senha (usuário sem distinção de maiúsculas)', () => {
    repo.createUser({ username: 'ana', name: 'Ana', password: PASSWORD, perms: { '*': ['view'] } });
    expect(repo.verifyPassword('ANA', PASSWORD)?.username).toBe('ana');
    expect(repo.verifyPassword('ana', 'errada-errada')).toBeUndefined();
    expect(repo.verifyPassword('ninguem', PASSWORD)).toBeUndefined();
  });

  it('rejeita senha curta, usuário duplicado e permissão inexistente', () => {
    expect(() =>
      repo.createUser({ username: 'a', name: 'A', password: 'curta', perms: {} }),
    ).toThrow(/10 caracteres/);
    repo.createUser({ username: 'ana', name: 'Ana', password: PASSWORD, perms: {} });
    expect(() =>
      repo.createUser({ username: 'ana', name: 'Ana', password: PASSWORD, perms: {} }),
    ).toThrow(/já existe/);
    expect(() =>
      repo.createUser({
        username: 'bia',
        name: 'Bia',
        password: PASSWORD,
        perms: { '*': ['root' as never] },
      }),
    ).toThrow();
  });

  it('rotação de sessão invalida o segredo anterior', () => {
    const user = repo.createUser({ username: 'ana', name: 'Ana', password: PASSWORD, perms: {} });
    const s1 = repo.createSession(user.id, 60_000);
    const r1 = repo.rotateSession(s1.secret, 60_000);
    expect(r1?.user.username).toBe('ana');
    expect(repo.rotateSession(s1.secret, 60_000)).toBeUndefined(); // reuso do antigo falha
    expect(repo.rotateSession(r1!.session.secret, 60_000)).toBeDefined();
  });

  it('desativar usuário ou trocar a senha encerra as sessões', () => {
    const user = repo.createUser({ username: 'ana', name: 'Ana', password: PASSWORD, perms: {} });
    const s1 = repo.createSession(user.id, 60_000);
    repo.setPassword('ana', 'outra-senha-forte');
    expect(repo.rotateSession(s1.secret, 60_000)).toBeUndefined();
    const s2 = repo.createSession(user.id, 60_000);
    repo.setActive('ana', false);
    expect(repo.rotateSession(s2.secret, 60_000)).toBeUndefined();
    expect(repo.verifyPassword('ana', 'outra-senha-forte')).toBeUndefined();
  });

  it('sessão expirada não renova', () => {
    const user = repo.createUser({ username: 'ana', name: 'Ana', password: PASSWORD, perms: {} });
    const s = repo.createSession(user.id, -1);
    expect(repo.rotateSession(s.secret, 60_000)).toBeUndefined();
  });
});

describe('rotas HTTP /auth', () => {
  let base: string;
  let close: () => void;
  let repo: UserRepository;

  beforeEach(async () => {
    repo = await UserRepository.open(':memory:', { bcryptCost: 4 });
    repo.createUser({
      username: 'ana',
      name: 'Ana',
      password: PASSWORD,
      perms: { pbx1: ['view'] },
    });
    const issuer = await LocalIssuer.create(auth);
    const routes = authRoutes({
      users: repo,
      issuer,
      config: auth,
      log,
      limiter: new RateLimiter(3, 60_000),
    });
    const server = createHttpServer(routes, { trustProxy: false, log });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    return () => close();
  });

  const post = (path: string, body?: unknown, cookie?: string) =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  /** Extrai "nome=valor" do Set-Cookie. */
  const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';

  it('login devolve token válido, dados do usuário e cookie HttpOnly/SameSite', async () => {
    const res = await post('/auth/login', { username: 'ana', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as LoginResponse;
    expect(body.user).toEqual({ username: 'ana', name: 'Ana', perms: { pbx1: ['view'] } });
    const claims = await (await TokenVerifier.create(auth)).verify(body.token);
    expect(claims.sub).toBe('ana');
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain(`${REFRESH_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\/auth/);
  });

  it('login inválido responde 401 com mensagem genérica', async () => {
    const r1 = await post('/auth/login', { username: 'ana', password: 'errada-errada' });
    const r2 = await post('/auth/login', { username: 'ninguem', password: 'errada-errada' });
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(await r1.json()).toEqual(await r2.json());
  });

  it('bloqueia após excesso de tentativas (429 + Retry-After)', async () => {
    for (let i = 0; i < 3; i++) await post('/auth/login', { username: 'ana', password: 'x' });
    const res = await post('/auth/login', { username: 'ana', password: PASSWORD });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('refresh renova o token, troca o cookie e o antigo deixa de valer', async () => {
    const login = await post('/auth/login', { username: 'ana', password: PASSWORD });
    const c1 = cookieOf(login);
    const r1 = await post('/auth/refresh', undefined, c1);
    expect(r1.status).toBe(200);
    const body = (await r1.json()) as TokenResponse;
    expect(body.token).toBeTruthy();
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    const c2 = cookieOf(r1);
    expect(c2).not.toBe(c1);
    expect((await post('/auth/refresh', undefined, c1)).status).toBe(401);
    expect((await post('/auth/refresh', undefined, c2)).status).toBe(200);
  });

  it('refresh reflete permissões alteradas no banco', async () => {
    const login = await post('/auth/login', { username: 'ana', password: PASSWORD });
    repo.setPerms('ana', { pbx1: ['view', 'spy'] });
    const r = await post('/auth/refresh', undefined, cookieOf(login));
    const { token } = (await r.json()) as TokenResponse;
    const claims = await (await TokenVerifier.create(auth)).verify(token);
    expect(claims.perms).toEqual({ pbx1: ['view', 'spy'] });
  });

  it('logout encerra a sessão', async () => {
    const login = await post('/auth/login', { username: 'ana', password: PASSWORD });
    const c = cookieOf(login);
    expect((await post('/auth/logout', undefined, c)).status).toBe(204);
    expect((await post('/auth/refresh', undefined, c)).status).toBe(401);
  });

  it('valida corpo e tipo de conteúdo; rota inexistente dá 404', async () => {
    expect((await post('/auth/login', { username: 'ana' })).status).toBe(400);
    const noType = await fetch(base + '/auth/login', { method: 'POST', body: '{}' });
    expect(noType.status).toBe(415);
    expect((await fetch(base + '/nada')).status).toBe(404);
  });
});
