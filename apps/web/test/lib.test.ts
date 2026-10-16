import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Call,
  Channel,
  DeltaMessage,
  DeltaOp,
  QueueMember,
  ServerMessage,
  SnapshotMessage,
} from '@astcall/shared';
import { MonitorConnection, type ConnectionState } from '../src/lib/MonitorConnection';
import { applyDelta, applySnapshot, createServerState } from '../src/lib/serverState';
import {
  addressFromUri,
  callView,
  compareEndpointIds,
  formatDuration,
  queueView,
  waitTone,
} from '../src/lib/view';

// ------------------------------------------------------------------ estado

const snapshot = (epoch: number, seq: number): SnapshotMessage => ({
  t: 'snapshot',
  server: 'pbx1',
  epoch,
  seq,
  data: {
    endpoints: [{ id: '9001', deviceState: 'NOT_INUSE', contacts: [], activeChannels: 0 }],
    channels: [],
    bridges: [],
    calls: [],
    queues: [],
    queueMembers: [],
    queueEntries: [],
  },
});

const delta = (epoch: number, seq: number, ops: DeltaMessage['ops']): DeltaMessage => ({
  t: 'delta',
  server: 'pbx1',
  epoch,
  seq,
  ops,
});

const endpointUpsert = (state: 'INUSE' | 'NOT_INUSE'): DeltaOp => ({
  op: 'upsert',
  entity: 'endpoint',
  id: '9001',
  data: { id: '9001', deviceState: state, contacts: [], activeChannels: 1 },
});

describe('serverState', () => {
  it('aplica snapshot e deltas em sequência', () => {
    const s = createServerState({
      id: 'pbx1',
      name: 'PBX',
      status: 'ready',
      permissions: ['view'],
    });
    applySnapshot(s, snapshot(1, 5));
    expect(s.hasSnapshot).toBe(true);
    expect(applyDelta(s, delta(1, 6, [endpointUpsert('INUSE')]))).toBe('ok');
    expect(s.endpoints['9001']?.deviceState).toBe('INUSE');
    expect(applyDelta(s, delta(1, 7, [{ op: 'remove', entity: 'endpoint', id: '9001' }]))).toBe(
      'ok',
    );
    expect(s.endpoints['9001']).toBeUndefined();
  });

  it('detecta lacuna, epoch diferente e ausência de snapshot', () => {
    const s = createServerState({
      id: 'pbx1',
      name: 'PBX',
      status: 'ready',
      permissions: ['view'],
    });
    expect(applyDelta(s, delta(1, 1, []))).toBe('gap'); // sem snapshot
    applySnapshot(s, snapshot(1, 0));
    expect(applyDelta(s, delta(1, 2, [endpointUpsert('INUSE')]))).toBe('gap'); // pulou o 1
    expect(s.endpoints['9001']?.deviceState).toBe('NOT_INUSE'); // nada aplicado
    expect(applyDelta(s, delta(2, 1, []))).toBe('gap'); // epoch novo sem snapshot
    expect(applyDelta(s, delta(1, 0, []))).toBe('ignored'); // antigo
  });
});

// ------------------------------------------------------------------ visão

function channel(uniqueid: string, num: string, extra: Partial<Channel> = {}): Channel {
  return {
    uniqueid,
    name: `PJSIP/${num}-0001`,
    linkedid: '1.1',
    state: 'Up',
    callerId: { num, name: '' },
    connectedLine: { num: '', name: '' },
    context: '',
    exten: '',
    application: null,
    endpointId: num,
    isLocal: false,
    bridgeId: null,
    dialedBy: null,
    dialStatus: null,
    onHold: false,
    recording: false,
    spying: null,
    spiedBy: null,
    queue: null,
    inQueue: false,
    createdAt: 0,
    answeredAt: null,
    ...extra,
  };
}

const call = (extra: Partial<Call>): Call => ({
  id: '1.1',
  channelIds: [],
  bridgeIds: [],
  status: 'talking',
  links: [],
  recording: false,
  queue: null,
  monitored: false,
  startedAt: 0,
  answeredAt: null,
  ...extra,
});

describe('view', () => {
  it('callView usa os links para mostrar quem fala com quem (ignorando Local)', () => {
    const channels = {
      a: channel('a', '9002'),
      l1: channel('l1', '', { isLocal: true, name: 'Local/9005@ctx-1;1', endpointId: null }),
      b: channel('b', '9005', { callerId: { num: '9005', name: 'Recepção' } }),
    };
    const v = callView(call({ channelIds: ['a', 'l1', 'b'], links: [['a', 'b']] }), channels);
    expect(v.parties.map((p) => p.num)).toEqual(['9002', '9005']);
    expect(v.parties[1]?.name).toBe('Recepção');
    expect(v.label).toBe('Em conversa');
  });

  it('sem links (tocando), mostra os canais reais em ordem', () => {
    const channels = { a: channel('a', '9002'), b: channel('b', '9001', { state: 'Ringing' }) };
    const v = callView(call({ status: 'ringing', channelIds: ['a', 'b'] }), channels);
    expect(v.parties.map((p) => p.num)).toEqual(['9002', '9001']);
    expect(v.tone).toBe('warning');
  });

  it('canal de supervisor aparece como "escutando" o alvo', () => {
    const channels = {
      alvo: channel('alvo', '9002', { spiedBy: 'sup' }),
      sup: channel('sup', '9005', { spying: 'alvo', linkedid: '2.2' }),
    };
    const v = callView(call({ id: '2.2', status: 'other', channelIds: ['sup'] }), channels);
    expect(v.label).toBe('Escutando');
    expect(v.parties.map((p) => p.num)).toEqual(['9005']);
    expect(v.spyTarget?.num).toBe('9002');
    const monitored = callView(call({ channelIds: ['alvo'], monitored: true }), channels);
    expect(monitored.monitored).toBe(true);
    expect(monitored.spyTarget).toBeNull();
  });

  it('formatDuration, ordenação e endereço do contato', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(['9010', 'tronco', '9002'].sort(compareEndpointIds)).toEqual(['9002', '9010', 'tronco']);
    expect(addressFromUri('sip:9001@192.0.2.1:53051;ob')).toBe('192.0.2.1:53051');
  });
});

// ------------------------------------------------------------------ conexão

/** WebSocket falso controlado pelo teste. */
class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  // helpers do teste
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const tokenOk = (expiresAt = Date.now() + 600_000) =>
  new Response(JSON.stringify({ token: 'tok', expiresAt }), { status: 200 });

describe('MonitorConnection', () => {
  let states: ConnectionState[];
  let messages: ServerMessage[];
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    states = [];
    messages = [];
    fetchFn = vi.fn(async () => tokenOk());
  });
  afterEach(() => vi.useRealTimers());

  const make = () =>
    new MonitorConnection({
      wsUrl: '/monitor-ws',
      tokenUrl: '/auth/refresh',
      baseUrl: 'https://pbx.exemplo.com/painel/',
      onMessage: (m) => messages.push(m),
      onState: (s) => states.push(s),
      fetchFn: fetchFn as unknown as typeof fetch,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });

  const authOk = (expiresAt = Date.now() + 600_000): ServerMessage => ({
    t: 'auth_ok',
    protocol: 1,
    user: { sub: 'ana', name: 'Ana' },
    expiresAt,
    servers: [{ id: 'pbx1', name: 'PBX', status: 'ready', permissions: ['view'] }],
  });

  it('busca o token, autentica e assina os servidores visíveis', async () => {
    const c = make();
    c.start();
    await vi.waitFor(() => expect(FakeWS.instances).toHaveLength(1));
    const ws = FakeWS.instances[0]!;
    expect(ws.url).toBe('wss://pbx.exemplo.com/monitor-ws');
    ws.open();
    expect(ws.sent[0]).toEqual({ t: 'auth', token: 'tok' });
    ws.receive(authOk());
    expect(ws.sent[1]).toEqual({ t: 'subscribe', servers: ['pbx1'] });
    expect(states).toEqual(['connecting', 'online']);
    expect(messages[0]?.t).toBe('auth_ok');
    expect(fetchFn).toHaveBeenCalledWith(
      '/auth/refresh',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
  });

  it('sessão expirada no token-url vira auth-required (sem reconectar)', async () => {
    fetchFn.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    make().start();
    await vi.waitFor(() => expect(states).toContain('auth-required'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.instances).toHaveLength(0);
  });

  it('reconecta com backoff quando a conexão cai', async () => {
    make().start();
    await vi.waitFor(() => expect(FakeWS.instances).toHaveLength(1));
    FakeWS.instances[0]!.open();
    FakeWS.instances[0]!.receive(authOk());
    FakeWS.instances[0]!.drop();
    expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(FakeWS.instances).toHaveLength(2);
    const ws2 = FakeWS.instances[1]!;
    ws2.open();
    ws2.receive(authOk());
    expect(ws2.sent).toContainEqual({ t: 'subscribe', servers: ['pbx1'] }); // assina de novo
    expect(states.at(-1)).toBe('online');
  });

  it('renova o token antes de expirar sem reconectar', async () => {
    make().start();
    await vi.waitFor(() => expect(FakeWS.instances).toHaveLength(1));
    const ws = FakeWS.instances[0]!;
    ws.open();
    ws.receive(authOk(Date.now() + 120_000)); // expira em 2 min → renova em ~1 min
    fetchFn.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'tok2', expiresAt: Date.now() + 720_000 }), {
        status: 200,
      }),
    );
    await vi.advanceTimersByTimeAsync(61_000);
    expect(ws.sent).toContainEqual({ t: 'auth', token: 'tok2' });
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('stop() encerra e não reconecta', async () => {
    const c = make();
    c.start();
    await vi.waitFor(() => expect(FakeWS.instances).toHaveLength(1));
    c.stop();
    FakeWS.instances[0]!.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(states.at(-1)).toBe('stopped');
  });
});

describe('filas (visão)', () => {
  const member = (iface: string, extra: Partial<QueueMember> = {}): QueueMember => ({
    id: `suporte|${iface}`,
    queue: 'suporte',
    interface: iface,
    name: iface,
    endpointId: iface.replace('PJSIP/', ''),
    status: 'NOT_INUSE',
    paused: false,
    pausedReason: '',
    pausedSince: null,
    inCall: false,
    callsTaken: 0,
    lastCall: null,
    penalty: 0,
    membership: 'static',
    ...extra,
  });

  it('ordena membros (disponível, atendendo, pausado, indisponível) e rotula a pausa', () => {
    const q = {
      name: 'suporte',
      strategy: 'ringall',
      max: 0,
      completed: 2,
      abandoned: 1,
      holdtime: 7,
      talktime: 30,
      serviceLevel: 0,
      serviceLevelPerf: 0,
      weight: 0,
    };
    const members = {
      a: member('PJSIP/9019', { status: 'UNAVAILABLE' }),
      b: member('PJSIP/9002', { paused: true, pausedReason: 'Almoço' }),
      c: member('PJSIP/9003', { status: 'INUSE', inCall: true }),
      d: member('PJSIP/9001'),
    };
    const entries = {
      x: {
        id: 'suporte|x',
        queue: 'suporte',
        uniqueid: 'x',
        channel: '',
        callerId: { num: '1', name: '' },
        position: 2,
        joinedAt: 0,
      },
      y: {
        id: 'suporte|y',
        queue: 'suporte',
        uniqueid: 'y',
        channel: '',
        callerId: { num: '2', name: '' },
        position: 1,
        joinedAt: 0,
      },
      z: {
        id: 'outra|z',
        queue: 'outra',
        uniqueid: 'z',
        channel: '',
        callerId: { num: '3', name: '' },
        position: 1,
        joinedAt: 0,
      },
    };
    const v = queueView(q, members, entries);
    expect(v.members.map((m) => m.label)).toEqual(['9001', '9003', '9002', '9019']);
    expect(v.members[2]).toMatchObject({
      stateLabel: 'Pausado',
      tone: 'warning',
      pausedReason: 'Almoço',
    });
    expect([v.available, v.busy, v.paused, v.offline]).toEqual([1, 1, 1, 1]);
    expect(v.waiting.map((e) => e.uniqueid)).toEqual(['y', 'x']);
  });

  it('cor da espera segue os limites de 60 s e 180 s', () => {
    expect(waitTone(59)).toBe('secondary');
    expect(waitTone(60)).toBe('warning');
    expect(waitTone(180)).toBe('danger');
  });
});
