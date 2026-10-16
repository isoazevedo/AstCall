import { describe, expect, it } from 'vitest';
import { applyEvent } from '../../src/handlers/index.js';
import { normalizeDeviceState, parseDuration, party } from '../../src/handlers/util.js';
import { endpointFromChannelName, ServerStore } from '../../src/state/ServerStore.js';

const T = 1_700_000_000_000;

function newchannel(uniqueid: string, channel: string, linkedid = uniqueid) {
  return { event: 'Newchannel', uniqueid, channel, linkedid, channelstatedesc: 'Ring' };
}

describe('ServerStore + handlers', () => {
  it('não recria um canal já desligado quando chega um evento atrasado', () => {
    const store = new ServerStore();
    applyEvent(store, newchannel('1.1', 'PJSIP/9001-00000001'), T);
    applyEvent(store, { event: 'Hangup', uniqueid: '1.1', channel: 'PJSIP/9001-00000001' }, T);
    const deltas = applyEvent(
      store,
      { event: 'MixMonitorStop', uniqueid: '1.1', channel: 'PJSIP/9001-00000001' },
      T,
    );
    expect(store.channels.size).toBe(0);
    expect(deltas).toEqual([]);
  });

  it('cria a bridge quando o BridgeEnter chega sem BridgeCreate', () => {
    const store = new ServerStore();
    applyEvent(store, newchannel('1.1', 'PJSIP/9001-00000001'), T);
    applyEvent(
      store,
      {
        event: 'BridgeEnter',
        bridgeuniqueid: 'b1',
        uniqueid: '1.1',
        channel: 'PJSIP/9001-00000001',
      },
      T,
    );
    expect(store.bridges.get('b1')?.channelIds).toEqual(['1.1']);
    expect(store.channels.get('1.1')?.bridgeId).toBe('b1');
  });

  it('ignora eventos sem canal de origem (ex.: DialState só com destino)', () => {
    const store = new ServerStore();
    const deltas = applyEvent(
      store,
      { event: 'DialState', destuniqueid: '9.9', dialstatus: 'RINGING' },
      T,
    );
    expect(deltas).toEqual([]);
  });

  it('Rename atualiza o nome e o endpoint do canal', () => {
    const store = new ServerStore();
    applyEvent(store, newchannel('1.1', 'PJSIP/9001-00000001'), T);
    applyEvent(
      store,
      {
        event: 'Rename',
        uniqueid: '1.1',
        channel: 'PJSIP/9001-00000001',
        newname: 'PJSIP/9003-00000009',
      },
      T,
    );
    expect(store.channels.get('1.1')).toMatchObject({
      name: 'PJSIP/9003-00000009',
      endpointId: '9003',
    });
  });

  it('move o canal de chamada quando o Linkedid muda', () => {
    const store = new ServerStore();
    applyEvent(store, newchannel('1.1', 'PJSIP/9001-00000001'), T);
    applyEvent(store, newchannel('2.2', 'PJSIP/9002-00000002'), T);
    expect(store.calls.size).toBe(2);
    const deltas = applyEvent(
      store,
      { event: 'Newstate', uniqueid: '2.2', channel: 'PJSIP/9002-00000002', linkedid: '1.1' },
      T,
    );
    expect(store.calls.size).toBe(1);
    expect(store.calls.get('1.1')?.channelIds).toEqual(['1.1', '2.2']);
    expect(deltas).toContainEqual({ op: 'remove', entity: 'call', id: '2.2' });
  });

  it('CoreShowChannel calcula o início pela duração e entra na bridge', () => {
    const store = new ServerStore();
    applyEvent(
      store,
      {
        event: 'CoreShowChannel',
        uniqueid: '1.1',
        linkedid: '1.1',
        channel: 'PJSIP/9001-00000001',
        channelstatedesc: 'Up',
        duration: '00:01:05',
        bridgeid: 'b1',
        application: 'Dial',
      },
      T,
    );
    const ch = store.channels.get('1.1')!;
    expect(ch.createdAt).toBe(T - 65_000);
    expect(ch.answeredAt).toBe(T - 65_000);
    expect(ch.application).toBe('Dial');
    expect(store.bridges.get('b1')?.channelIds).toEqual(['1.1']);
  });

  it('EndpointList e ContactList montam o endpoint com estado e contato', () => {
    const store = new ServerStore();
    applyEvent(store, { event: 'EndpointList', objectname: '9001', devicestate: 'Not in use' }, T);
    applyEvent(
      store,
      {
        event: 'ContactList',
        endpoint: '9001',
        uri: 'sip:9001@192.0.2.1:5060',
        status: 'NonQualified',
        roundtripusec: 'N/A',
        useragent: 'MicroSIP/3.22.12',
      },
      T,
    );
    expect(store.endpoints.get('9001')).toEqual({
      id: '9001',
      deviceState: 'NOT_INUSE',
      activeChannels: 0,
      contacts: [
        {
          uri: 'sip:9001@192.0.2.1:5060',
          status: 'NonQualified',
          rttMs: null,
          userAgent: 'MicroSIP/3.22.12',
        },
      ],
    });
  });

  it('clear() zera tudo sem emitir deltas', () => {
    const store = new ServerStore();
    applyEvent(store, newchannel('1.1', 'PJSIP/9001-00000001'), T);
    store.clear();
    expect(store.snapshot()).toEqual({
      endpoints: [],
      channels: [],
      bridges: [],
      calls: [],
      queues: [],
      queueMembers: [],
      queueEntries: [],
    });
    expect(store.flush()).toEqual([]);
  });
});

describe('filas', () => {
  const join = (uniqueid: string, position: number) => ({
    event: 'QueueCallerJoin',
    queue: 'suporte',
    uniqueid,
    linkedid: uniqueid,
    channel: `PJSIP/900${position}-0000000${position}`,
    calleridnum: `900${position}`,
    position: String(position),
  });

  it('quem estava atrás sobe de posição quando alguém sai da fila', () => {
    const store = new ServerStore();
    applyEvent(store, join('a', 1), T);
    applyEvent(store, join('b', 2), T);
    applyEvent(store, join('c', 3), T);
    applyEvent(
      store,
      { event: 'QueueCallerLeave', queue: 'suporte', uniqueid: 'a', position: '1' },
      T,
    );
    const pos = Object.fromEntries(
      [...store.queueEntries.values()].map((e) => [e.uniqueid, e.position]),
    );
    expect(pos).toEqual({ b: 1, c: 2 });
    expect(store.calls.get('b')?.status).toBe('queued');
  });

  it('desligar sem QueueCallerLeave também tira o chamador da fila', () => {
    const store = new ServerStore();
    applyEvent(store, join('a', 1), T);
    applyEvent(store, { event: 'Hangup', uniqueid: 'a', channel: 'PJSIP/9001-00000001' }, T);
    expect(store.queueEntries.size).toBe(0);
  });

  it('QueueEntry calcula a entrada pela espera informada', () => {
    const store = new ServerStore();
    applyEvent(
      store,
      {
        event: 'QueueEntry',
        queue: 'suporte',
        uniqueid: 'x',
        position: '1',
        wait: '42',
        calleridnum: '11999',
      },
      T,
    );
    expect(store.queueEntries.get('suporte|x')).toMatchObject({
      joinedAt: T - 42_000,
      position: 1,
    });
  });
});

describe('funções auxiliares', () => {
  it('endpointFromChannelName', () => {
    expect(endpointFromChannelName('PJSIP/9001-0000002c')).toBe('9001');
    expect(endpointFromChannelName('PJSIP/tronco-sp-0000002c')).toBe('tronco-sp');
    expect(endpointFromChannelName('Local/9005@ctx-00000001;1')).toBeNull();
  });

  it('normalizeDeviceState aceita os dois formatos do Asterisk', () => {
    expect(normalizeDeviceState('NOT_INUSE')).toBe('NOT_INUSE');
    expect(normalizeDeviceState('Not in use')).toBe('NOT_INUSE');
    expect(normalizeDeviceState('Ring+Inuse')).toBe('RINGINUSE');
    expect(normalizeDeviceState('qualquer')).toBe('UNKNOWN');
  });

  it('party trata <unknown> como vazio', () => {
    expect(party('<unknown>', '<unknown>')).toEqual({ num: '', name: '' });
  });

  it('parseDuration', () => {
    expect(parseDuration('01:02:03')).toBe(3723);
  });
});

describe('escuta (ChanSpy)', () => {
  it('marca quem escuta e quem é escutado; a chamada fica "monitorada"', () => {
    const store = new ServerStore();
    applyEvent(store, newchannel('1.1', 'PJSIP/9002-00000001'), T);
    applyEvent(store, newchannel('2.1', 'PJSIP/9005-00000002'), T);
    const spy = {
      spyerchannel: 'PJSIP/9005-00000002',
      spyeruniqueid: '2.1',
      spyerlinkedid: '2.1',
      spyeechannel: 'PJSIP/9002-00000001',
      spyeeuniqueid: '1.1',
      spyeelinkedid: '1.1',
    };
    applyEvent(store, { event: 'ChanSpyStart', ...spy }, T);
    expect(store.channels.get('2.1')?.spying).toBe('1.1');
    expect(store.channels.get('1.1')?.spiedBy).toBe('2.1');
    expect(store.calls.get('1.1')?.monitored).toBe(true);
    applyEvent(store, { event: 'ChanSpyStop', ...spy }, T);
    expect(store.channels.get('1.1')?.spiedBy).toBeNull();
    expect(store.calls.get('1.1')?.monitored).toBe(false);
  });
});
