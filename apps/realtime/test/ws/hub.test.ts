import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  WS_CLOSE,
  WS_PATH,
  type ServerConnectionStatus,
  type ServerMessage,
  type ServerPermissions,
} from '@astcall/shared';
import { ActionError } from '../../src/actions/index.js';
import { LocalIssuer, TokenVerifier } from '../../src/auth/index.js';
import type { AuthConfig } from '../../src/config/index.js';
import { applyEvent } from '../../src/handlers/index.js';
import { createLogger } from '../../src/logger.js';
import { ServerStore } from '../../src/state/ServerStore.js';
import { compact, Hub, ServerFeed, type HubOptions } from '../../src/ws/index.js';

const log = createLogger('silent', false);

/** Sincronização falsa: o teste decide quando começa e termina. */
class FakeSync extends EventEmitter<{
  syncing: [];
  synced: [{ epoch: number; durationMs: number }];
}> {
  epoch = 0;
  syncing = false;
  start() {
    this.syncing = true;
    this.emit('syncing');
  }
  finish() {
    this.syncing = false;
    this.epoch++;
    this.emit('synced', { epoch: this.epoch, durationMs: 0 });
  }
}

class FakeConn extends EventEmitter<{ status: [ServerConnectionStatus] }> {
  status: ServerConnectionStatus = 'ready';
  set(s: ServerConnectionStatus) {
    this.status = s;
    this.emit('status', s);
  }
}

let dir: string;
let auth: AuthConfig;
let issuer: LocalIssuer;
let verifier: TokenVerifier;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'astcall-ws-'));
  const keys = await generateKeyPair('RS256', { extractable: true });
  writeFileSync(join(dir, 'priv.pem'), await exportPKCS8(keys.privateKey));
  writeFileSync(join(dir, 'pub.pem'), await exportSPKI(keys.publicKey));
  auth = {
    mode: 'local',
    ttlSeconds: 600,
    local: {
      issuer: 'astcall',
      privateKeyFile: join(dir, 'priv.pem'),
      publicKeyFile: join(dir, 'pub.pem'),
      usersDbFile: ':memory:',
      refreshTtlHours: 1,
      cookieSecure: false,
    },
    external: { issuer: 'azcall', publicKeyFile: undefined },
  };
  issuer = await LocalIssuer.create(auth);
  verifier = await TokenVerifier.create(auth);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ---- Ambiente por teste: 2 servidores, hub e servidor HTTP
let http: Server;
let hub: Hub;
let url: string;
let servers: Record<
  string,
  { store: ServerStore; sync: FakeSync; conn: FakeConn; feed: ServerFeed }
>;
const clients: WebSocket[] = [];

function setup(hubOptions: HubOptions = {}) {
  servers = {};
  const feeds = new Map<string, ServerFeed>();
  for (const id of ['pbx1', 'pbx2']) {
    const store = new ServerStore();
    const sync = new FakeSync();
    const conn = new FakeConn();
    const feed = new ServerFeed(id, id.toUpperCase(), { store, sync, conn }, 20);
    feeds.set(id, feed);
    servers[id] = { store, sync, conn, feed };
  }
  hub = new Hub(feeds, verifier, log, { authTimeoutMs: 200, ...hubOptions });
  http = createServer();
  hub.attach(http);
  return new Promise<void>((resolve) =>
    http.listen(0, '127.0.0.1', () => {
      url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}${WS_PATH}`;
      resolve();
    }),
  );
}

beforeEach(() => setup());
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  hub.close();
  await new Promise((r) => http.close(r));
});

/** Cliente de teste que guarda as mensagens e permite esperar por uma específica. */
async function client() {
  const ws = new WebSocket(url);
  clients.push(ws);
  const received: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] =
    [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    received.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  await new Promise((r) => ws.once('open', r));

  return {
    ws,
    received,
    closed,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    next<T extends ServerMessage['t']>(
      t: T,
      pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
    ) {
      const found = received.find((m) => m.t === t && pred(m as never));
      if (found) return Promise.resolve(found as Extract<ServerMessage, { t: T }>);
      return new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout esperando ${t}`)), 1000);
        waiters.push({
          pred: (m) => m.t === t && pred(m as never),
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m as Extract<ServerMessage, { t: T }>);
          },
        });
      });
    },
  };
}

async function token(perms: ServerPermissions = { '*': ['view'] }, username = 'ana') {
  return (await issuer.issue({ username, name: 'Ana', perms })).token;
}

async function authedClient(perms?: ServerPermissions) {
  const c = await client();
  c.send({ t: 'auth', token: await token(perms) });
  await c.next('auth_ok');
  return c;
}

const newchannel = (uniqueid: string, channel: string) => ({
  event: 'Newchannel',
  uniqueid,
  channel,
  linkedid: uniqueid,
  channelstatedesc: 'Ring',
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('autenticação', () => {
  it('fecha a conexão sem auth no prazo (4001)', async () => {
    const c = await client();
    expect((await c.closed).code).toBe(WS_CLOSE.AUTH_FAILED);
  });

  it('fecha com token inválido', async () => {
    const c = await client();
    c.send({ t: 'auth', token: 'abc.def.ghi' });
    const err = await c.next('error');
    expect(err.code).toBe('auth_failed');
    expect((await c.closed).code).toBe(WS_CLOSE.AUTH_FAILED);
  });

  it('fecha se outra mensagem vier antes do auth', async () => {
    const c = await client();
    c.send({ t: 'subscribe', servers: ['pbx1'] });
    expect((await c.closed).code).toBe(WS_CLOSE.AUTH_FAILED);
  });

  it('fecha com mensagem fora do protocolo', async () => {
    const c = await authedClient();
    c.send({ t: 'hackear' });
    expect((await c.closed).code).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });

  it('auth_ok lista só os servidores com permissão view', async () => {
    const c = await client();
    c.send({ t: 'auth', token: await token({ pbx2: ['view'], pbx1: ['hangup'] }) });
    const ok = await c.next('auth_ok');
    expect(ok.user).toEqual({ sub: 'ana', name: 'Ana' });
    expect(ok.servers.map((s) => s.id)).toEqual(['pbx2']);
    expect(ok.expiresAt).toBeGreaterThan(Date.now());
  });

  it('desconecta quando o token expira sem renovação (4008)', async () => {
    await new Promise<void>((r) => {
      hub.close();
      http.close(() => r());
    });
    await setup({ expiryGraceMs: 0 });
    const shortIssuer = await LocalIssuer.create({ ...auth, ttlSeconds: 1 });
    const c = await client();
    c.send({
      t: 'auth',
      token: (await shortIssuer.issue({ username: 'ana', name: 'Ana', perms: {} })).token,
    });
    await c.next('auth_ok');
    expect((await c.closed).code).toBe(WS_CLOSE.TOKEN_EXPIRED);
  });

  it('renovação com token de outro usuário é recusada', async () => {
    const c = await authedClient();
    c.send({ t: 'auth', token: await token({ '*': ['view'] }, 'outro') });
    expect((await c.closed).code).toBe(WS_CLOSE.AUTH_FAILED);
  });

  it('renovação que remove a permissão tira a assinatura do servidor', async () => {
    servers.pbx1!.sync.finish();
    const c = await authedClient({ pbx1: ['view'] });
    c.send({ t: 'subscribe', servers: ['pbx1'] });
    await c.next('snapshot');
    c.send({ t: 'auth', token: await token({ pbx1: [] }) });
    await c.next('auth_ok', (m) => m.servers.length === 0);
    const before = c.received.length;
    applyEvent(servers.pbx1!.store, newchannel('1.1', 'PJSIP/9001-00000001'));
    await sleep(60);
    expect(c.received.length).toBe(before);
  });
});

describe('assinatura e estado', () => {
  it('recusa servidor sem permissão', async () => {
    const c = await authedClient({ pbx1: ['view'] });
    c.send({ t: 'subscribe', servers: ['pbx2', 'inexistente'] });
    const err = await c.next('error');
    expect(err.code).toBe('forbidden');
  });

  it('envia status e snapshot ao assinar um servidor pronto', async () => {
    servers.pbx1!.sync.finish();
    applyEvent(servers.pbx1!.store, newchannel('1.1', 'PJSIP/9001-00000001'));
    await sleep(40); // deixa o lote anterior à assinatura ser descartado/enviado
    const c = await authedClient();
    c.send({ t: 'subscribe', servers: ['pbx1'] });
    const status = await c.next('server_status');
    expect(status).toEqual({ t: 'server_status', server: 'pbx1', status: 'ready' });
    const snap = await c.next('snapshot');
    expect(snap.epoch).toBe(1);
    expect(snap.data.channels.map((ch) => ch.uniqueid)).toEqual(['1.1']);
  });

  it('agrupa deltas em lotes numerados', async () => {
    servers.pbx1!.sync.finish();
    const c = await authedClient();
    c.send({ t: 'subscribe', servers: ['pbx1'] });
    const snap = await c.next('snapshot');
    const store = servers.pbx1!.store;
    applyEvent(store, newchannel('1.1', 'PJSIP/9001-00000001'));
    applyEvent(store, newchannel('1.2', 'PJSIP/9002-00000002'));
    const d1 = await c.next('delta');
    expect(d1.seq).toBe(snap.seq + 1);
    expect(d1.ops.filter((o) => o.entity === 'channel').map((o) => o.id)).toEqual(['1.1', '1.2']);
    applyEvent(store, { event: 'Hangup', uniqueid: '1.1', channel: 'PJSIP/9001-00000001' });
    const d2 = await c.next('delta', (m) => m.seq === d1.seq + 1);
    expect(d2.ops).toContainEqual({ op: 'remove', entity: 'channel', id: '1.1' });
  });

  it('não envia deltas durante a sincronização; depois manda snapshot com epoch novo', async () => {
    const { sync, conn, store } = servers.pbx1!;
    sync.finish();
    const c = await authedClient();
    c.send({ t: 'subscribe', servers: ['pbx1'] });
    await c.next('snapshot');

    sync.start();
    await c.next('server_status', (m) => m.status === 'syncing');
    applyEvent(store, newchannel('1.1', 'PJSIP/9001-00000001'));
    await sleep(60);
    expect(c.received.some((m) => m.t === 'delta')).toBe(false);

    sync.finish();
    const snap = await c.next('snapshot', (m) => m.epoch === 2);
    expect(snap.seq).toBe(0);
    expect(snap.data.channels).toHaveLength(1);
    await c.next('server_status', (m) => m.status === 'ready');
    void conn;
  });

  it('servidor ainda não sincronizado: snapshot só chega no synced', async () => {
    const c = await authedClient();
    c.send({ t: 'subscribe', servers: ['pbx2'] });
    await c.next('server_status');
    await sleep(40);
    expect(c.received.some((m) => m.t === 'snapshot')).toBe(false);
    servers.pbx2!.sync.finish();
    expect((await c.next('snapshot')).epoch).toBe(1);
  });

  it('repassa queda de conexão AMI', async () => {
    servers.pbx1!.sync.finish();
    const c = await authedClient();
    c.send({ t: 'subscribe', servers: ['pbx1'] });
    await c.next('snapshot');
    servers.pbx1!.conn.set('disconnected');
    await c.next('server_status', (m) => m.status === 'disconnected');
  });

  it('resync devolve um snapshot novo; unsubscribe para os deltas', async () => {
    servers.pbx1!.sync.finish();
    const c = await authedClient();
    c.send({ t: 'subscribe', servers: ['pbx1'] });
    await c.next('snapshot');
    c.send({ t: 'resync', server: 'pbx1' });
    await sleep(40);
    expect(c.received.filter((m) => m.t === 'snapshot')).toHaveLength(2);

    c.send({ t: 'unsubscribe', servers: ['pbx1'] });
    await sleep(20);
    const before = c.received.length;
    applyEvent(servers.pbx1!.store, newchannel('1.1', 'PJSIP/9001-00000001'));
    await sleep(60);
    expect(c.received.length).toBe(before);
  });

  it('rejeita upgrade fora do caminho do WebSocket', async () => {
    const wrong = new WebSocket(url.replace(WS_PATH, '/outro'));
    const err = await new Promise((resolve) => wrong.on('error', resolve));
    expect(err).toBeTruthy();
  });
});

describe('compact', () => {
  it('mantém só a última operação de cada entidade, na ordem da última ocorrência', () => {
    const up = (id: string, state: string) =>
      ({ op: 'upsert', entity: 'bridge', id, data: { id, type: state } }) as never;
    const ops = compact([
      up('a', '1'),
      up('b', '1'),
      up('a', '2'),
      { op: 'remove', entity: 'bridge', id: 'b' },
    ]);
    expect(ops).toEqual([up('a', '2'), { op: 'remove', entity: 'bridge', id: 'b' }]);
  });
});

describe('ações pelo WebSocket', () => {
  it('auth_ok informa as permissões efetivas por servidor', async () => {
    const c = await client();
    c.send({ t: 'auth', token: await token({ '*': ['view'], pbx1: ['hangup'] }) });
    const ok = await c.next('auth_ok');
    const pbx1 = ok.servers.find((s) => s.id === 'pbx1');
    expect(pbx1?.permissions.sort()).toEqual(['hangup', 'view']);
  });

  it('executa e responde action_result com o mesmo reqId', async () => {
    const calls: unknown[] = [];
    await new Promise<void>((r) => {
      hub.close();
      http.close(() => r());
    });
    await setup({
      actions: {
        execute: async (claims: { sub: string }, server: string, name: string, params: unknown) => {
          calls.push({ sub: claims.sub, server, name, params });
          if (name === 'hangup') throw new ActionError('not_found', 'a chamada já terminou');
        },
      },
    });
    const c = await authedClient({ pbx1: ['view', 'queue', 'hangup'] });
    c.send({ t: 'action', reqId: 'r1', server: 'pbx1', name: 'queuePause', params: { x: 1 } });
    expect(await c.next('action_result', (m) => m.reqId === 'r1')).toEqual({
      t: 'action_result',
      reqId: 'r1',
      ok: true,
    });
    c.send({ t: 'action', reqId: 'r2', server: 'pbx1', name: 'hangup', params: {} });
    expect(await c.next('action_result', (m) => m.reqId === 'r2')).toMatchObject({
      ok: false,
      code: 'not_found',
      error: 'a chamada já terminou',
    });
    // sem permissão de ver o servidor: nem chega ao executor
    c.send({ t: 'action', reqId: 'r3', server: 'pbx2', name: 'hangup', params: {} });
    expect(await c.next('action_result', (m) => m.reqId === 'r3')).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(calls).toEqual([
      { sub: 'ana', server: 'pbx1', name: 'queuePause', params: { x: 1 } },
      { sub: 'ana', server: 'pbx1', name: 'hangup', params: {} },
    ]);
  });

  it('sem executor configurado, toda ação é recusada', async () => {
    const c = await authedClient();
    c.send({ t: 'action', reqId: 'r1', server: 'pbx1', name: 'hangup', params: {} });
    expect(await c.next('action_result')).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
