import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConnectionStatus } from '@astcall/shared';
import { AmiConnection, type AmiConnectionOptions } from '../../src/ami/AmiConnection.js';
import type { AmiServerConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/logger.js';
import { FakeAmiServer } from '../helpers/fakeAmi.js';

const log = createLogger('silent', false);

let server: FakeAmiServer;
let conn: AmiConnection | undefined;

function makeConnection(options: AmiConnectionOptions = {}, secret = 'pass'): AmiConnection {
  const config: AmiServerConfig = {
    id: 'pbx1',
    name: 'Teste',
    host: '127.0.0.1',
    port: server.port,
    enabled: true,
    username: 'user',
    secret,
  };
  conn = new AmiConnection(config, log, { backoffMinMs: 20, backoffMaxMs: 50, ...options });
  return conn;
}

/** Aguarda a conexão atingir um status. */
function waitStatus(c: AmiConnection, status: ServerConnectionStatus): Promise<void> {
  if (c.status === status) return Promise.resolve();
  return new Promise((resolve) => {
    const listener = (s: ServerConnectionStatus) => {
      if (s === status) {
        c.off('status', listener);
        resolve();
      }
    };
    c.on('status', listener);
  });
}

beforeEach(async () => {
  server = new FakeAmiServer();
  await server.listen();
});

afterEach(async () => {
  await conn?.stop();
  conn = undefined;
  await server.close();
});

describe('AmiConnection', () => {
  it('passa por connecting → syncing → ready e chama onConnected', async () => {
    const statuses: ServerConnectionStatus[] = [];
    let syncCalls = 0;
    const c = makeConnection({
      onConnected: async (connection) => {
        syncCalls++;
        await connection.sendAction('Ping'); // a conexão já aceita actions durante o sync
      },
    });
    c.on('status', (s) => statuses.push(s));
    c.start();
    await waitStatus(c, 'ready');
    expect(statuses).toEqual(['connecting', 'syncing', 'ready']);
    expect(syncCalls).toBe(1);
  });

  it('reconecta e ressincroniza após queda', async () => {
    let syncCalls = 0;
    const c = makeConnection({ onConnected: async () => void syncCalls++ });
    c.start();
    await waitStatus(c, 'ready');

    server.dropAll();
    await waitStatus(c, 'disconnected');
    await waitStatus(c, 'ready');
    expect(syncCalls).toBe(2);
  });

  it('continua tentando enquanto o login falha', async () => {
    const c = makeConnection({}, 'errada');
    c.start();
    await new Promise((r) => setTimeout(r, 200));
    const logins = server.received.filter((a) => a.action === 'Login');
    expect(logins.length).toBeGreaterThanOrEqual(2);
    expect(c.status).not.toBe('ready');
  });

  it('refaz a conexão se onConnected falhar', async () => {
    let attempts = 0;
    const c = makeConnection({
      onConnected: async () => {
        if (++attempts === 1) throw new Error('falha simulada no sync');
      },
    });
    c.start();
    await waitStatus(c, 'ready');
    expect(attempts).toBe(2);
  });

  it('derruba a conexão quando o Ping não responde', async () => {
    server.on('ping', () => []); // Asterisk "travado"
    const c = makeConnection({ pingIntervalMs: 30, actionTimeoutMs: 30 });
    c.start();
    await waitStatus(c, 'ready');
    await waitStatus(c, 'disconnected');
  });

  it('repassa eventos do Asterisk', async () => {
    const c = makeConnection();
    c.start();
    await waitStatus(c, 'ready');
    const got = new Promise((resolve) => c.once('event', resolve));
    server.broadcast({ Event: 'DeviceStateChange', Device: 'PJSIP/1001', State: 'INUSE' });
    expect(await got).toMatchObject({ device: 'PJSIP/1001', state: 'INUSE' });
  });

  it('stop() encerra e não reconecta', async () => {
    const c = makeConnection();
    c.start();
    await waitStatus(c, 'ready');
    await c.stop();
    expect(c.status).toBe('disconnected');
    expect(server.received.some((a) => a.action === 'Logoff')).toBe(true);
    const logins = server.received.filter((a) => a.action === 'Login').length;
    await new Promise((r) => setTimeout(r, 100));
    expect(server.received.filter((a) => a.action === 'Login').length).toBe(logins);
  });
});
