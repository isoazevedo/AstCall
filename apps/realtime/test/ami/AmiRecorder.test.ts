import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AmiConnection } from '../../src/ami/AmiConnection.js';
import { AmiRecorder, type RecordLine } from '../../src/ami/AmiRecorder.js';
import { createLogger } from '../../src/logger.js';
import { FakeAmiServer } from '../helpers/fakeAmi.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('AmiRecorder', () => {
  it('grava mensagens recebidas e mudanças de status, sem a senha', async () => {
    const server = new FakeAmiServer();
    await server.listen();
    dir = mkdtempSync(join(tmpdir(), 'astcall-rec-'));

    const conn = new AmiConnection(
      {
        id: 'pbx1',
        name: 'Teste',
        host: '127.0.0.1',
        port: server.port,
        enabled: true,
        username: 'user',
        secret: 'pass',
      },
      createLogger('silent', false),
    );
    const recorder = new AmiRecorder(dir, conn);
    const ready = new Promise<void>((r) => conn.on('status', (s) => s === 'ready' && r()));
    conn.start();
    await ready;

    const got = new Promise((r) => conn.once('event', r));
    server.broadcast({ Event: 'Newchannel', Uniqueid: '1.1', Channel: 'PJSIP/1001-00000001' });
    await got;
    await conn.stop();
    await recorder.close();
    await server.close();

    const raw = readFileSync(recorder.file, 'utf8');
    const lines = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as RecordLine);
    expect(lines.some((l) => 'status' in l && l.status === 'ready')).toBe(true);
    expect(lines.some((l) => 'msg' in l && l.msg.event === 'Newchannel')).toBe(true);
    expect(raw).not.toContain('pass'); // apenas tráfego recebido: o Login enviado não aparece
  });
});
