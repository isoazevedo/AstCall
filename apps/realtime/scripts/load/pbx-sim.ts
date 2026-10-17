/**
 * PBX simulado para o teste de carga (roda numa worker thread).
 *
 * Fala o protocolo AMI por TCP e gera chamadas sintéticas com a mesma sequência de eventos
 * das gravações reais do laboratório (test/fixtures): chamadas diretas ramal → ramal e
 * chamadas por fila (entra, espera, toca o membro, atende, desliga ou abandona).
 *
 * Mantém o estado vivo (canais, bridges, chamadores na fila) para responder às listas
 * (CoreShowChannels, BridgeList, QueueStatus...) com a verdade — assim a sincronização e a
 * reconciliação periódica do AstCall trabalham como num Asterisk de verdade.
 *
 * O CallerIDName do canal de origem leva o instante em que a chamada começou ("lt:<ms>"):
 * os clientes medem quanto tempo o evento levou até chegar ao navegador.
 */
import { createServer, type Socket } from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';
import { parseBlock, serializeAction } from '../../src/ami/AmiParser.js';
import type { AmiMessage } from '../../src/ami/types.js';

export interface SimOptions {
  endpoints: number;
  queues: number;
  membersPerQueue: number;
  /** Chamadas simultâneas desejadas. */
  calls: number;
  /** Duração média da conversa (s). */
  talkSeconds: number;
  /** Fração das chamadas que passam por fila (0..1). */
  queueRatio: number;
  /** Porta TCP do AMI simulado (padrão: qualquer porta livre). */
  port?: number;
  /**
   * Perfil de demonstração (prints, testes manuais): ramais a partir de 2001 com nomes de
   * pessoas, filas com nomes reais, clientes ligando de fora por um tronco e alguns ramais
   * desconectados. Sem ele, o simulador gera dados de teste de carga (ramais 10000+ e o
   * CallerIDName "lt:<ms>" para medir a latência).
   */
  demo?: boolean;
}

/** Mensagens trocadas com a thread principal. */
export type SimCommand = { cmd: 'start' } | { cmd: 'stop' } | { cmd: 'stats' };
export type SimReply =
  | { type: 'listening'; port: number }
  | {
      type: 'stats';
      events: number;
      liveChannels: number;
      liveCalls: number;
      waiting: number;
      callsStarted: number;
      callsEnded: number;
    }
  | { type: 'stopped' };

type Fields = Record<string, string>;

const opts = workerData as SimOptions;
const CTX = 'from-internal-sim';
const ext = (i: number) => String((opts.demo ? 2001 : 10000) + i); // ramais 2001… ou 10000…
const DEMO_QUEUES = ['suporte', 'vendas', 'financeiro', 'cobranca', 'retencao', 'ouvidoria'];
const queueName = (q: number) => (opts.demo ? (DEMO_QUEUES[q] ?? `fila${q}`) : `fila${q}-sim`);

// ---- perfil de demonstração
const FIRST = [
  'Ana',
  'Bruno',
  'Carla',
  'Diego',
  'Elisa',
  'Fábio',
  'Gabriela',
  'Heitor',
  'Isabela',
  'João',
  'Larissa',
  'Marcos',
  'Natália',
  'Otávio',
  'Paula',
  'Rafael',
  'Sofia',
  'Thiago',
  'Vanessa',
  'Wagner',
];
const LAST = [
  'Souza',
  'Lima',
  'Costa',
  'Rocha',
  'Alves',
  'Pereira',
  'Martins',
  'Barbosa',
  'Ribeiro',
  'Gomes',
];
/** Nome fixo de cada ramal no perfil de demonstração. */
const personName = (e: string) => {
  const i = Number(e) - 2001;
  return `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`;
};
/** Tronco por onde chegam as ligações de clientes (só no perfil de demonstração). */
const TRUNK = 'operadora';
/** Ramais desconectados (sem telefone registrado) no perfil de demonstração: ~15%. */
const offline = new Set<string>();
if (opts.demo) {
  for (let i = 0; i < opts.endpoints; i++) if (i % 7 === 5) offline.add(ext(i));
}
/** Número de telefone de cliente (fictício, faixa de documentação não existe em telefonia). */
const customerNumber = () =>
  `11 9${String(1000 + Math.floor(Math.random() * 9000))}-${String(1000 + Math.floor(Math.random() * 9000))}`;
/** Identificador de quem liga: nome do ramal (demo) ou a marca de tempo (teste de carga). */
const callerName = (e: string) => (opts.demo ? personName(e) : `lt:${Date.now()}`);
const calleeName = (e: string) => (opts.demo ? personName(e) : e);

// ------------------------------------------------------------------ estado vivo

interface LiveChannel {
  name: string;
  uniqueid: string;
  linkedid: string;
  num: string;
  cidName: string;
  state: 'Ring' | 'Ringing' | 'Up' | 'Down';
  bridgeId: string;
  createdAt: number;
}

const channels = new Map<string, LiveChannel>();
const bridges = new Map<string, string[]>();
const busy = new Set<string>(); // ramais em uso
const waiting = new Map<string, { queue: string; uniqueid: string; joinedAt: number }>();
/** Membros de fila ("fila|ramal"); pausedReason vazio = não pausado. */
const members = new Map<
  string,
  {
    calls: number;
    incall: boolean;
    ringing: boolean;
    pausedReason: string;
    /** Fim da última chamada atendida (s desde 1970; 0 = nenhuma). */
    lastCall: number;
  }
>();
const devState = new Map<string, string>();
/** Totais por fila, informados no QueueParams (como o Asterisk faz). */
const queueStats = new Map<
  string,
  { completed: number; abandoned: number; holdSum: number; talkSum: number; withinSL: number }
>();
const statsOf = (q: string) => {
  let st = queueStats.get(q);
  if (!st) {
    st = { completed: 0, abandoned: 0, holdSum: 0, talkSum: 0, withinSL: 0 };
    queueStats.set(q, st);
  }
  return st;
};
/** Nível de serviço das filas simuladas (s). */
const SERVICE_LEVEL_S = 20;

let seq = 0;
let chanSeq = 0;
let events = 0;
let callsStarted = 0;
let callsEnded = 0;
let running = false;
const timers = new Set<NodeJS.Timeout>();
const sockets = new Set<Socket>();

for (let q = 0; q < opts.queues; q++) {
  for (let m = 0; m < opts.membersPerQueue; m++) {
    members.set(`${queueName(q)}|${ext((q * opts.membersPerQueue + m) % opts.endpoints)}`, {
      calls: 0,
      incall: false,
      ringing: false,
      lastCall: 0,
      // demonstração: alguns membros pausados, como numa operação real
      pausedReason: opts.demo && m % 5 === 3 ? (q % 2 ? 'Treinamento' : 'Almoço') : '',
    });
  }
}

const later = (ms: number, fn: () => void) => {
  const t = setTimeout(() => {
    timers.delete(t);
    if (running) fn();
  }, ms);
  timers.add(t);
};
/** Aleatório em torno de `mean` (±50%). */
const around = (mean: number) => mean * (0.5 + Math.random());

function emit(fields: Fields): void {
  events++;
  const data = serializeAction(fields);
  for (const s of sockets) if ((s as Socket & { authed?: boolean }).authed) s.write(data);
}

function chanFields(ch: LiveChannel, prefix = ''): Fields {
  const stateNum = { Down: '0', Ring: '4', Ringing: '5', Up: '6' }[ch.state];
  return {
    [`${prefix}Channel`]: ch.name,
    [`${prefix}ChannelState`]: stateNum,
    [`${prefix}ChannelStateDesc`]: ch.state,
    [`${prefix}CallerIDNum`]: ch.num,
    [`${prefix}CallerIDName`]: ch.cidName,
    [`${prefix}Context`]: CTX,
    [`${prefix}Uniqueid`]: ch.uniqueid,
    [`${prefix}Linkedid`]: ch.linkedid,
  };
}

function newChannel(endpoint: string, linkedid: string | null, cidName: string): LiveChannel {
  const uniqueid = `1700000000.${++seq}`;
  const ch: LiveChannel = {
    name: `PJSIP/${endpoint}-${(++chanSeq).toString(16).padStart(8, '0')}`,
    uniqueid,
    linkedid: linkedid ?? uniqueid,
    num: endpoint,
    cidName,
    state: linkedid ? 'Down' : 'Ring',
    bridgeId: '',
    createdAt: Date.now(),
  };
  channels.set(uniqueid, ch);
  emit({ Event: 'Newchannel', ...chanFields(ch), Exten: endpoint });
  return ch;
}

function setState(ch: LiveChannel, state: LiveChannel['state']): void {
  ch.state = state;
  emit({ Event: 'Newstate', ...chanFields(ch) });
}

function device(endpoint: string, state: string): void {
  devState.set(endpoint, state);
  emit({ Event: 'DeviceStateChange', Device: `PJSIP/${endpoint}`, State: state });
}

function bridgeUp(a: LiveChannel, b: LiveChannel): string {
  const id = `sim-bridge-${++seq}`;
  bridges.set(id, []);
  const base = { BridgeUniqueid: id, BridgeType: 'basic', BridgeTechnology: 'simple_bridge' };
  emit({ Event: 'BridgeCreate', ...base });
  for (const ch of [b, a]) {
    ch.bridgeId = id;
    bridges.get(id)!.push(ch.uniqueid);
    emit({ Event: 'BridgeEnter', ...base, ...chanFields(ch) });
  }
  return id;
}

function hangup(ch: LiveChannel): void {
  if (ch.bridgeId) {
    const list = bridges.get(ch.bridgeId);
    emit({
      Event: 'BridgeLeave',
      BridgeUniqueid: ch.bridgeId,
      BridgeType: 'basic',
      ...chanFields(ch),
    });
    if (list) {
      list.splice(list.indexOf(ch.uniqueid), 1);
      if (list.length === 0) {
        bridges.delete(ch.bridgeId);
        emit({ Event: 'BridgeDestroy', BridgeUniqueid: ch.bridgeId, BridgeType: 'basic' });
      }
    }
    ch.bridgeId = '';
  }
  channels.delete(ch.uniqueid);
  emit({ Event: 'Hangup', ...chanFields(ch), Cause: '16', 'Cause-txt': 'Normal Clearing' });
}

function freeEndpoint(): string | null {
  for (let tries = 0; tries < 20; tries++) {
    const e = ext(Math.floor(Math.random() * opts.endpoints));
    if (!busy.has(e) && !offline.has(e)) return e;
  }
  return null;
}

/** Ramais do PBX (e o tronco, no perfil de demonstração). */
function* allEndpoints(): Generator<string> {
  for (let i = 0; i < opts.endpoints; i++) yield ext(i);
  if (opts.demo) yield TRUNK;
}

function endCall(endpoints: string[]): void {
  for (const e of endpoints) {
    busy.delete(e);
    device(e, 'NOT_INUSE');
  }
  callsEnded++;
}

// ------------------------------------------------------------------ chamada direta

function directCall(): void {
  const a = freeEndpoint();
  if (!a) return;
  busy.add(a);
  const b = freeEndpoint();
  if (!b) return void busy.delete(a);
  busy.add(b);
  callsStarted++;

  const ca = newChannel(a, null, callerName(a));
  device(a, 'INUSE');
  const cb = newChannel(b, ca.linkedid, calleeName(b));
  emit({ Event: 'DialBegin', ...chanFields(ca), ...chanFields(cb, 'Dest'), DialString: b });
  setState(cb, 'Ringing');
  device(b, 'RINGING');

  later(around(4000), () => {
    setState(cb, 'Up');
    emit({ Event: 'DialEnd', ...chanFields(ca), ...chanFields(cb, 'Dest'), DialStatus: 'ANSWER' });
    setState(ca, 'Up');
    bridgeUp(ca, cb);
    device(b, 'INUSE');
    later(around(opts.talkSeconds * 1000), () => {
      hangup(cb);
      hangup(ca);
      endCall([a, b]);
    });
  });
}

// ------------------------------------------------------------------ chamada por fila

function memberStatus(queue: string, e: string): void {
  const m = members.get(`${queue}|${e}`)!;
  emit({
    Event: 'QueueMemberStatus',
    Queue: queue,
    MemberName: `PJSIP/${e}`,
    Interface: `PJSIP/${e}`,
    StateInterface: `PJSIP/${e}`,
    Membership: 'static',
    Penalty: '0',
    CallsTaken: String(m.calls),
    LastCall: String(m.lastCall),
    InCall: m.incall ? '1' : '0',
    Status: offline.has(e) ? '5' : m.ringing ? '6' : m.incall ? '2' : busy.has(e) ? '2' : '1',
    Paused: m.pausedReason ? '1' : '0',
    PausedReason: m.pausedReason,
  });
}

function queueCall(): void {
  const q = queueName(Math.floor(Math.random() * opts.queues));
  // Demonstração: o cliente liga de fora (tronco); teste de carga: um ramal liga para a fila
  const a = opts.demo ? TRUNK : freeEndpoint();
  if (!a) return;
  if (!opts.demo) busy.add(a);
  callsStarted++;
  const ca = opts.demo ? newChannel(a, null, '') : newChannel(a, null, callerName(a));
  if (opts.demo) {
    ca.num = customerNumber();
    ca.cidName = '';
  } else device(a, 'INUSE');
  setState(ca, 'Up'); // a aplicação Queue atende o chamador
  const joinedAt = Date.now();
  waiting.set(ca.uniqueid, { queue: q, uniqueid: ca.uniqueid, joinedAt });
  const pos = [...waiting.values()].filter((w) => w.queue === q).length;
  emit({
    Event: 'QueueCallerJoin',
    ...chanFields(ca),
    Queue: q,
    Position: String(pos),
    Count: String(pos),
  });

  const leave = () => {
    waiting.delete(ca.uniqueid);
    emit({ Event: 'QueueCallerLeave', ...chanFields(ca), Queue: q, Position: '1', Count: '0' });
  };

  const tryAgent = () => {
    if (!channels.has(ca.uniqueid)) return;
    if (Date.now() - joinedAt > 30_000) {
      // desiste depois de 30 s
      statsOf(q).abandoned++;
      emit({
        Event: 'QueueCallerAbandon',
        ...chanFields(ca),
        Queue: q,
        Position: '1',
        HoldTime: '30',
      });
      leave();
      hangup(ca);
      endCall(opts.demo ? [] : [a]);
      return;
    }
    const free = [...members.keys()]
      .filter((k) => k.startsWith(`${q}|`))
      .map((k) => k.split('|')[1]!)
      .filter((e) => !offline.has(e) && !members.get(`${q}|${e}`)!.pausedReason)
      .find((e) => !busy.has(e));
    if (!free) return later(1000, tryAgent);

    busy.add(free);
    const m = members.get(`${q}|${free}`)!;
    const cb = newChannel(free, ca.linkedid, calleeName(free));
    const agent = {
      ...chanFields(ca),
      ...chanFields(cb, 'Dest'),
      Queue: q,
      Interface: `PJSIP/${free}`,
      MemberName: `PJSIP/${free}`,
    };
    emit({ Event: 'AgentCalled', ...agent });
    setState(cb, 'Ringing');
    device(free, 'RINGING');
    m.ringing = true;
    memberStatus(q, free);

    later(around(3000), () => {
      setState(cb, 'Up');
      leave();
      m.ringing = false;
      m.incall = true;
      const hold = Math.round((Date.now() - joinedAt) / 1000);
      const answeredAt = Date.now();
      emit({
        Event: 'AgentConnect',
        ...agent,
        ...chanFields(cb, 'Dest'),
        HoldTime: String(hold),
        RingTime: '3',
      });
      bridgeUp(ca, cb);
      device(free, 'INUSE');
      memberStatus(q, free);
      later(around(opts.talkSeconds * 1000), () => {
        const talk = Math.round((Date.now() - answeredAt) / 1000);
        const st = statsOf(q);
        st.completed++;
        st.holdSum += hold;
        st.talkSum += talk;
        if (hold <= SERVICE_LEVEL_S) st.withinSL++;
        emit({
          Event: 'AgentComplete',
          ...agent,
          HoldTime: String(hold),
          TalkTime: String(talk),
          Reason: 'caller',
        });
        hangup(cb);
        hangup(ca);
        m.incall = false;
        m.calls++;
        m.lastCall = Math.floor(Date.now() / 1000);
        endCall(opts.demo ? [free] : [a, free]);
        memberStatus(q, free);
      });
    });
  };
  later(around(2000), tryAgent);
}

// ------------------------------------------------------------------ gerador

let genTimer: NodeJS.Timeout | undefined;

function startGenerator(): void {
  running = true;
  // Taxa de novas chamadas para manter ~`calls` simultâneas: calls / duração média (s)
  const perSecond = opts.calls / (opts.talkSeconds + 4);
  let credit = 0;
  genTimer = setInterval(() => {
    credit += perSecond / 20; // tick de 50 ms
    const live = callsStarted - callsEnded;
    while (credit >= 1) {
      credit--;
      if (live >= opts.calls * 1.2) break;
      if (Math.random() < opts.queueRatio && opts.queues > 0) queueCall();
      else directCall();
    }
  }, 50);
}

function stopGenerator(): void {
  running = false;
  clearInterval(genTimer);
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

// ------------------------------------------------------------------ servidor AMI

function list(socket: Socket, id: string, items: Fields[], complete: string): void {
  socket.write(serializeAction({ Response: 'Success', ActionID: id, EventList: 'start' }));
  for (const it of items) socket.write(serializeAction({ ...it, ActionID: id }));
  socket.write(
    serializeAction({
      Event: complete,
      ActionID: id,
      EventList: 'Complete',
      ListItems: String(items.length),
    }),
  );
}

function onAction(a: AmiMessage, socket: Socket & { authed?: boolean }): void {
  const id = a.actionid ?? '';
  const reply = (f: Fields): void => void socket.write(serializeAction({ ...f, ActionID: id }));
  switch ((a.action ?? '').toLowerCase()) {
    case 'login':
      socket.authed = true;
      return reply({ Response: 'Success', Message: 'Authentication accepted' });
    case 'ping':
      return reply({ Response: 'Success', Ping: 'Pong' });
    case 'logoff':
      reply({ Response: 'Goodbye' });
      return void setImmediate(() => socket.end());
    case 'pjsipshowendpoints':
      return list(
        socket,
        id,
        [...allEndpoints()].map((e) => ({
          Event: 'EndpointList',
          ObjectName: e,
          DeviceState: offline.has(e) ? 'Unavailable' : busy.has(e) ? 'In use' : 'Not in use',
        })),
        'EndpointListComplete',
      );
    case 'pjsipshowcontacts':
      return list(
        socket,
        id,
        [...allEndpoints()]
          .filter((e) => !offline.has(e))
          .map((e, i) => ({
            Event: 'ContactList',
            Endpoint: e,
            Uri: `sip:${e}@198.51.100.${(i % 250) + 1}:5060`,
            Status: 'Reachable',
            UserAgent: e === TRUNK ? 'Operadora SIP' : 'SimPhone/1.0',
            RoundtripUsec: '15000',
          })),
        'ContactListComplete',
      );
    case 'devicestatelist':
      return list(
        socket,
        id,
        [...allEndpoints()].map((e) => ({
          Event: 'DeviceStateChange',
          Device: `PJSIP/${e}`,
          State: offline.has(e) ? 'UNAVAILABLE' : (devState.get(e) ?? 'NOT_INUSE'),
        })),
        'DeviceStateListComplete',
      );
    case 'bridgelist':
      return list(
        socket,
        id,
        [...bridges.keys()].map((b) => ({
          Event: 'BridgeListItem',
          BridgeUniqueid: b,
          BridgeType: 'basic',
          BridgeTechnology: 'simple_bridge',
        })),
        'BridgeListComplete',
      );
    case 'coreshowchannels': {
      const now = Date.now();
      return list(
        socket,
        id,
        [...channels.values()].map((ch) => {
          const s = Math.floor((now - ch.createdAt) / 1000);
          const dur = `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
          return {
            Event: 'CoreShowChannel',
            ...chanFields(ch),
            Duration: dur,
            BridgeId: ch.bridgeId,
          };
        }),
        'CoreShowChannelsComplete',
      );
    }
    case 'queuestatus': {
      const items: Fields[] = [];
      for (let q = 0; q < opts.queues; q++) {
        const name = queueName(q);
        const st = statsOf(name);
        const avg = (sum: number) => String(st.completed ? Math.round(sum / st.completed) : 0);
        items.push({
          Event: 'QueueParams',
          Queue: name,
          Strategy: 'ringall',
          Max: '0',
          Completed: String(st.completed),
          Abandoned: String(st.abandoned),
          Holdtime: avg(st.holdSum),
          TalkTime: avg(st.talkSum),
          ServiceLevel: String(SERVICE_LEVEL_S),
          ServicelevelPerf: (st.completed ? (st.withinSL / st.completed) * 100 : 0).toFixed(1),
        });
        for (const [key, m] of members) {
          if (!key.startsWith(`${name}|`)) continue;
          const e = key.split('|')[1]!;
          items.push({
            Event: 'QueueMember',
            Queue: name,
            Name: `PJSIP/${e}`,
            Location: `PJSIP/${e}`,
            Membership: 'static',
            Penalty: '0',
            CallsTaken: String(m.calls),
            LastCall: String(m.lastCall),
            InCall: m.incall ? '1' : '0',
            Status: offline.has(e) ? '5' : m.ringing ? '6' : m.incall || busy.has(e) ? '2' : '1',
            Paused: m.pausedReason ? '1' : '0',
            PausedReason: m.pausedReason,
          });
        }
        let pos = 0;
        for (const w of waiting.values()) {
          if (w.queue !== name) continue;
          const ch = channels.get(w.uniqueid);
          if (!ch) continue;
          items.push({
            Event: 'QueueEntry',
            Queue: name,
            Position: String(++pos),
            Channel: ch.name,
            Uniqueid: ch.uniqueid,
            CallerIDNum: ch.num,
            CallerIDName: ch.cidName,
            Wait: String(Math.floor((Date.now() - w.joinedAt) / 1000)),
          });
        }
      }
      return list(socket, id, items, 'QueueStatusComplete');
    }
    default:
      return reply({ Response: 'Error', Message: 'Invalid/unknown command' });
  }
}

const server = createServer((socket: Socket & { authed?: boolean }) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  socket.setEncoding('utf8');
  socket.setNoDelay(true);
  socket.write('Asterisk Call Manager/9.0.0\r\n');
  let buf = '';
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let end: number;
    while ((end = buf.indexOf('\r\n\r\n')) !== -1) {
      const a = parseBlock(buf.slice(0, end));
      buf = buf.slice(end + 4);
      if (a) onAction(a, socket);
    }
  });
});

server.listen(opts.port ?? 0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    parentPort!.postMessage({ type: 'listening', port: addr.port } satisfies SimReply);
  }
});

parentPort!.on('message', (m: SimCommand) => {
  if (m.cmd === 'start') startGenerator();
  if (m.cmd === 'stop') {
    stopGenerator();
    parentPort!.postMessage({ type: 'stopped' } satisfies SimReply);
  }
  if (m.cmd === 'stats') {
    parentPort!.postMessage({
      type: 'stats',
      events,
      liveChannels: channels.size,
      liveCalls: callsStarted - callsEnded,
      waiting: waiting.size,
      callsStarted,
      callsEnded,
    } satisfies SimReply);
  }
});
