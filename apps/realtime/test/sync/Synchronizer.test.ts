import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'node:net';
import { AmiConnection } from '../../src/ami/AmiConnection.js';
import { serializeAction } from '../../src/ami/AmiParser.js';
import type { AmiMessage } from '../../src/ami/types.js';
import { createLogger } from '../../src/logger.js';
import { ServerStore } from '../../src/state/ServerStore.js';
import { Synchronizer } from '../../src/sync/Synchronizer.js';
import { FakeAmiServer } from '../helpers/fakeAmi.js';

const log = createLogger('silent', false);

type Item = Record<string, string>;

/** Conteúdo das listas que o servidor falso devolve (pode mudar durante o teste). */
let lists: Record<string, Item[] | 'empty-error' | 'error'>;
/** Eventos a "intercalar" no meio de uma lista: action → [índice do item, evento]. */
let interleave: Record<string, [number, Item]>;

let server: FakeAmiServer;
let conn: AmiConnection | undefined;
let store: ServerStore;
let sync: Synchronizer;

/** Responde uma action de lista escrevendo direto no socket (permite intercalar eventos). */
function serveList(action: string, completeEvent: string) {
  return (a: AmiMessage, socket: Socket) => {
    const id = a.actionid ?? '';
    const spec = lists[action] ?? [];
    const write = (f: Item) => socket.write(serializeAction(f));
    if (spec === 'empty-error')
      return void write({ Response: 'Error', ActionID: id, Message: 'No bridges found' });
    if (spec === 'error')
      return void write({ Response: 'Error', ActionID: id, Message: 'Invalid/unknown command' });
    write({ Response: 'Success', ActionID: id, EventList: 'start' });
    spec.forEach((item, i) => {
      write({ ...item, ActionID: id });
      const extra = interleave[action];
      if (extra && extra[0] === i) write(extra[1]); // evento assíncrono, sem ActionID
    });
    write({
      Event: completeEvent,
      ActionID: id,
      EventList: 'Complete',
      ListItems: String(spec.length),
    });
  };
}

function start(options: { reloadDebounceMs?: number; channelReconcileMs?: number } = {}) {
  store = new ServerStore();
  conn = new AmiConnection(
    {
      id: 'pbx1',
      name: 'T',
      host: '127.0.0.1',
      port: server.port,
      enabled: true,
      username: 'user',
      secret: 'pass',
    },
    log,
    { backoffMinMs: 20, backoffMaxMs: 50 },
  );
  sync = new Synchronizer(conn, store, log, options); // registra-se como onConnected
  conn.start();
}

function waitSynced(epoch: number): Promise<void> {
  if (sync.epoch >= epoch) return Promise.resolve();
  return new Promise((resolve) => {
    const fn = (e: { epoch: number }) => {
      if (e.epoch >= epoch) {
        sync.off('synced', fn);
        resolve();
      }
    };
    sync.on('synced', fn);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A conexão passa a "ready" logo após o "synced" (quando o onConnected termina). */
function waitReady(): Promise<void> {
  if (conn!.status === 'ready') return Promise.resolve();
  return new Promise((resolve) => conn!.on('status', (s) => s === 'ready' && resolve()));
}

beforeEach(async () => {
  lists = {
    PJSIPShowEndpoints: [{ Event: 'EndpointList', ObjectName: '9001', DeviceState: 'In use' }],
    PJSIPShowContacts: [
      {
        Event: 'ContactList',
        Endpoint: '9001',
        Uri: 'sip:9001@192.0.2.1:5060',
        Status: 'NonQualified',
      },
    ],
    DeviceStateList: [{ Event: 'DeviceStateChange', Device: 'PJSIP/9001', State: 'INUSE' }],
    BridgeList: [
      {
        Event: 'BridgeListItem',
        BridgeUniqueid: 'b1',
        BridgeType: 'basic',
        BridgeTechnology: 'simple_bridge',
      },
    ],
    CoreShowChannels: [
      {
        Event: 'CoreShowChannel',
        Channel: 'PJSIP/9001-00000001',
        Uniqueid: '1.1',
        Linkedid: '1.1',
        ChannelStateDesc: 'Up',
        Duration: '00:00:30',
        BridgeId: 'b1',
      },
      {
        Event: 'CoreShowChannel',
        Channel: 'PJSIP/9002-00000002',
        Uniqueid: '1.2',
        Linkedid: '1.1',
        ChannelStateDesc: 'Up',
        Duration: '00:00:30',
        BridgeId: 'b1',
      },
    ],
  };
  interleave = {};
  server = new FakeAmiServer();
  server.on('pjsipshowendpoints', serveList('PJSIPShowEndpoints', 'EndpointListComplete'));
  server.on('pjsipshowcontacts', serveList('PJSIPShowContacts', 'ContactListComplete'));
  server.on('devicestatelist', serveList('DeviceStateList', 'DeviceStateListComplete'));
  server.on('bridgelist', serveList('BridgeList', 'BridgeListComplete'));
  server.on('coreshowchannels', serveList('CoreShowChannels', 'CoreShowChannelsComplete'));
  server.on('queuestatus', serveList('QueueStatus', 'QueueStatusComplete'));
  await server.listen();
});

afterEach(async () => {
  await conn?.stop();
  conn = undefined;
  await server.close();
});

describe('Synchronizer', () => {
  it('reconstrói o estado completo a partir das listas ao conectar', async () => {
    start();
    await waitSynced(1);
    expect(store.endpoints.get('9001')).toMatchObject({
      deviceState: 'INUSE',
      activeChannels: 1,
      contacts: [{ uri: 'sip:9001@192.0.2.1:5060', status: 'NonQualified' }],
    });
    expect(store.bridges.get('b1')).toMatchObject({ type: 'basic', channelIds: ['1.1', '1.2'] });
    const call = store.calls.get('1.1')!;
    expect(call.status).toBe('talking');
    expect(call.links).toEqual([['1.1', '1.2']]);
    await waitReady();
    expect(sync.syncing).toBe(false);
  });

  it('respeita a ordem do stream: evento entre itens prevalece sobre o item anterior', async () => {
    // Hangup do 1.1 chega logo depois do item do 1.1, antes do 1.2
    interleave.CoreShowChannels = [
      0,
      { Event: 'Hangup', Uniqueid: '1.1', Channel: 'PJSIP/9001-00000001' },
    ];
    start();
    await waitSynced(1);
    expect(store.channels.has('1.1')).toBe(false);
    expect(store.channels.has('1.2')).toBe(true);
  });

  it('trata "Response: Error" de lista vazia como lista vazia', async () => {
    lists.BridgeList = 'empty-error';
    start();
    await waitSynced(1);
    // a bridge ainda é criada pelos canais (BridgeId), apenas sem tipo
    expect(store.bridges.get('b1')?.type).toBe('');
  });

  it('falha em lista obrigatória derruba a conexão e tenta de novo', async () => {
    lists.CoreShowChannels = 'error';
    start();
    await sleep(200);
    expect(sync.epoch).toBe(0);
    const tries = server.received.filter((a) => a.action === 'CoreShowChannels').length;
    expect(tries).toBeGreaterThanOrEqual(2);
    // quando o Asterisk volta ao normal, sincroniza
    lists.CoreShowChannels = [];
    await waitSynced(1);
    await waitReady();
  });

  it('após reconectar descarta o estado antigo (canais que sumiram)', async () => {
    start();
    await waitSynced(1);
    expect(store.channels.size).toBe(2);
    lists.CoreShowChannels = [];
    lists.BridgeList = [];
    server.dropAll();
    await waitSynced(2);
    expect(store.channels.size).toBe(0);
    expect(store.calls.size).toBe(0);
  });

  it('ressincroniza uma vez após vários Reload seguidos', async () => {
    start({ reloadDebounceMs: 40 });
    await waitSynced(1);
    server.broadcast({ Event: 'Reload', Module: 'All', Status: '0' });
    server.broadcast({ Event: 'Reload', Module: 'All', Status: '0' });
    server.broadcast({ Event: 'Reload', Module: 'res_pjsip.so', Status: '0' });
    await waitSynced(2);
    await sleep(100);
    expect(sync.epoch).toBe(2);
  });

  it('ignora Reload de módulos irrelevantes', async () => {
    start({ reloadDebounceMs: 20 });
    await waitSynced(1);
    server.broadcast({ Event: 'Reload', Module: 'cdr', Status: '0' });
    await sleep(100);
    expect(sync.epoch).toBe(1);
  });

  it('aplica eventos ao vivo depois de sincronizado', async () => {
    start();
    await waitSynced(1);
    const changed = new Promise((r) => store.once('deltas', r));
    server.broadcast({
      Event: 'Hold',
      Uniqueid: '1.2',
      Channel: 'PJSIP/9002-00000002',
      Linkedid: '1.1',
    });
    await changed;
    expect(store.calls.get('1.1')?.status).toBe('held');
  });

  it('sincroniza filas e a reconciliação remove o que sumiu (sem remover o que acabou de mudar)', async () => {
    lists.QueueStatus = [
      {
        Event: 'QueueParams',
        Queue: 'suporte',
        Strategy: 'ringall',
        Completed: '3',
        Abandoned: '1',
      },
      { Event: 'QueueMember', Queue: 'suporte', Location: 'PJSIP/9001', Status: '1', Paused: '0' },
      { Event: 'QueueMember', Queue: 'suporte', Location: 'PJSIP/9002', Status: '5', Paused: '0' },
      { Event: 'QueueEntry', Queue: 'suporte', Uniqueid: 'q1', Position: '1', Wait: '10' },
    ];
    start();
    await waitSynced(1);
    expect(store.queues.get('suporte')).toMatchObject({ completed: 3, abandoned: 1 });
    expect(store.queueMembers.size).toBe(2);
    expect(store.queueEntries.size).toBe(1);

    // No Asterisk: 9002 saiu da fila e o chamador q1 foi embora sem evento; 9001 agora com 4 atendidas.
    // Durante a consulta chega um chamador novo (q2) — não pode ser removido.
    lists.QueueStatus = [
      {
        Event: 'QueueParams',
        Queue: 'suporte',
        Strategy: 'ringall',
        Completed: '4',
        Abandoned: '1',
      },
      {
        Event: 'QueueMember',
        Queue: 'suporte',
        Location: 'PJSIP/9001',
        Status: '1',
        Paused: '0',
        CallsTaken: '4',
      },
    ];
    interleave.QueueStatus = [
      0,
      {
        Event: 'QueueCallerJoin',
        Queue: 'suporte',
        Uniqueid: 'q2',
        Linkedid: 'q2',
        Channel: 'PJSIP/9005-00000009',
        Position: '1',
      },
    ];
    await sync.refreshQueues();
    expect(store.queues.get('suporte')?.completed).toBe(4);
    expect([...store.queueMembers.keys()]).toEqual(['suporte|PJSIP/9001']);
    expect([...store.queueEntries.keys()]).toEqual(['suporte|q2']);
  });

  it('reconciliação de canais: remove fantasmas, cria o que falta e não sobrescreve o que existe', async () => {
    start({ channelReconcileMs: 0 });
    await waitSynced(1);
    const answeredBefore = store.channels.get('1.1')!.answeredAt;

    // No Asterisk agora: o 1.2 desligou sem Hangup (evento perdido), a bridge b1 acabou sem
    // BridgeDestroy, e existe o 1.3 cujo Newchannel se perdeu. Durante a consulta nasce o 1.4.
    lists.BridgeList = 'empty-error';
    lists.CoreShowChannels = [
      {
        Event: 'CoreShowChannel',
        Channel: 'PJSIP/9001-00000001',
        Uniqueid: '1.1',
        Linkedid: '1.1',
        ChannelStateDesc: 'Up',
        Duration: '00:05:00', // o horário aproximado da lista não pode substituir o real
      },
      {
        Event: 'CoreShowChannel',
        Channel: 'PJSIP/9003-00000003',
        Uniqueid: '1.3',
        Linkedid: '1.3',
        ChannelStateDesc: 'Ring',
        Duration: '00:00:02',
      },
    ];
    interleave.CoreShowChannels = [
      0,
      {
        Event: 'Newchannel',
        Channel: 'PJSIP/9004-00000004',
        Uniqueid: '1.4',
        Linkedid: '1.4',
        ChannelStateDesc: 'Ring',
      },
    ];

    const result = await sync.reconcileChannels();
    expect(result).toEqual({
      channelsAdded: 1,
      channelsRemoved: 1,
      bridgesAdded: 0,
      bridgesRemoved: 1,
    });
    expect([...store.channels.keys()].sort()).toEqual(['1.1', '1.3', '1.4']);
    expect(store.bridges.size).toBe(0);
    expect(store.channels.get('1.1')).toMatchObject({ answeredAt: answeredBefore, bridgeId: null });
    // A chamada do canal fantasma deixa de existir; a do 1.1 continua
    expect(store.calls.has('1.1')).toBe(true);
  });

  it('reconciliação de canais sem divergência não altera nada', async () => {
    start({ channelReconcileMs: 0 });
    await waitSynced(1);
    const before = JSON.stringify(store.snapshot());
    const result = await sync.reconcileChannels();
    expect(result).toEqual({
      channelsAdded: 0,
      channelsRemoved: 0,
      bridgesAdded: 0,
      bridgesRemoved: 0,
    });
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });

  it('servidor sem o módulo de filas: sincroniza o resto normalmente', async () => {
    lists.QueueStatus = 'error';
    start();
    await waitSynced(1);
    expect(store.channels.size).toBe(2);
    expect(store.queues.size).toBe(0);
  });
});
