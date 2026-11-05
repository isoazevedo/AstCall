import { describe, expect, it } from 'vitest';
import { QualityMonitor } from '../../src/quality/QualityMonitor.js';
import { parseRtcpAll } from '../../src/quality/rtcp.js';
import { ServerStore } from '../../src/state/ServerStore.js';

/** Resposta real do laboratório (Asterisk 20.9), ligação ramal × fila, 2026-11-05. */
const LAB =
  'ssrc=1161303686;themssrc=2563013951;lp=0;rxjitter=0.019500;rxcount=1902;txjitter=0.017875;' +
  'txcount=1902;rlp=1;rtt=0.139556;rxmes=86.296140;txmes=86.704268';

describe('parseRtcpAll', () => {
  it('lê a resposta real: pior nota dos dois sentidos, jitter e atraso em ms, perda em %', () => {
    expect(parseRtcpAll(LAB, 1000)).toEqual({
      mes: 86.3,
      jitterMs: 19.5,
      rttMs: 140,
      lossPct: 0.1, // 1 perdido em 1903
      updatedAt: 1000,
    });
  });

  it('sem medição (vazio, sem MES ou MES zerado): null', () => {
    expect(parseRtcpAll('', 0)).toBeNull();
    expect(parseRtcpAll(undefined, 0)).toBeNull();
    expect(parseRtcpAll('ssrc=1;lp=0;rxcount=0', 0)).toBeNull();
    expect(parseRtcpAll('rxmes=0;txmes=0', 0)).toBeNull();
  });

  it('sem rtt ainda: rttMs null', () => {
    expect(parseRtcpAll('rxmes=90;txmes=91;rtt=0', 0)?.rttMs).toBeNull();
  });
});

/** Store com canais em conversa: dois no tronco, um ramal e um canal Local. */
function setup() {
  const store = new ServerStore();
  for (const [id, name] of [
    ['a', 'PJSIP/operadora-0001'],
    ['b', 'PJSIP/operadora-0002'],
    ['c', 'PJSIP/2001-0003'],
    ['d', 'Local/2001@ctx-0004;1'],
  ] as const) {
    store.upsertChannel(id, { name, linkedid: id, state: 'Up' }, 0);
  }
  store.ensureEndpoint('operadora');
  store.ensureEndpoint('2001');
  store.flush(0);
  return store;
}

/** AMI falso: nota por nome de canal; nome sem nota = canal que já terminou (erro). */
function fakeAmi(mesByChannel: Record<string, number>) {
  const asked: string[] = [];
  return {
    asked,
    async sendAction(_action: string, fields: Record<string, unknown> = {}) {
      const name = String(fields.Channel);
      asked.push(name);
      const mes = mesByChannel[name];
      if (mes === undefined) throw new Error('No such channel');
      return { response: 'Success', value: `rxmes=${mes};txmes=${mes + 1};rtt=0.05` };
    },
  };
}

describe('QualityMonitor', () => {
  it('mede só canais PJSIP em conversa e calcula a média por endpoint', async () => {
    const store = setup();
    const ami = fakeAmi({
      'PJSIP/operadora-0001': 60,
      'PJSIP/operadora-0002': 70,
      'PJSIP/2001-0003': 90,
    });
    await new QualityMonitor().update(store, ami, () => 5000);

    expect(ami.asked).not.toContain('Local/2001@ctx-0004;1');
    expect(store.channels.get('a')?.quality?.mes).toBe(60);
    expect(store.channels.get('d')?.quality).toBeNull();
    expect(store.endpoints.get('operadora')?.quality).toEqual({
      mes: 65,
      channels: 2,
      degradedSince: 5000, // média 65 < 70
      updatedAt: 5000,
    });
    expect(store.endpoints.get('2001')?.quality).toMatchObject({ mes: 90, degradedSince: null });
  });

  it('degradedSince continua desde a primeira queda; some quando a média volta ou não há conversa', async () => {
    const store = setup();
    const m = new QualityMonitor();
    await m.update(store, fakeAmi({ 'PJSIP/operadora-0001': 50 }), () => 1000);
    await m.update(store, fakeAmi({ 'PJSIP/operadora-0001': 55 }), () => 11_000);
    expect(store.endpoints.get('operadora')?.quality?.degradedSince).toBe(1000);

    await m.update(store, fakeAmi({ 'PJSIP/operadora-0001': 85 }), () => 21_000);
    expect(store.endpoints.get('operadora')?.quality?.degradedSince).toBeNull();

    store.removeChannel('a');
    store.removeChannel('b');
    await m.update(store, fakeAmi({}), () => 31_000);
    expect(store.endpoints.get('operadora')?.quality).toBeNull();
  });

  it('canal que terminou no meio da rodada não interrompe as outras medições', async () => {
    const store = setup();
    const ami = fakeAmi({ 'PJSIP/2001-0003': 88 });
    await new QualityMonitor().update(store, ami, () => 0);
    expect(ami.asked).toHaveLength(3);
    expect(store.channels.get('c')?.quality?.mes).toBe(88);
  });

  it('emite deltas do canal e do endpoint', async () => {
    const store = setup();
    const ops: string[] = [];
    store.on('deltas', (d) => ops.push(...d.map((o) => `${o.entity}:${o.id}`)));
    await new QualityMonitor().update(store, fakeAmi({ 'PJSIP/2001-0003': 88 }), () => 0);
    expect(ops).toEqual(expect.arrayContaining(['channel:c', 'endpoint:2001']));
  });
});
