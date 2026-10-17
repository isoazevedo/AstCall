import type {
  Call,
  CallStatus,
  Channel,
  DeviceState,
  Endpoint,
  Queue,
  QueueEntry,
  QueueMember,
} from '@astcall/shared';

/**
 * Funções puras que transformam o estado bruto em dados prontos para a tela
 * (rótulos, cores, participantes de uma chamada). Ficam fora dos componentes para
 * serem testadas sem navegador.
 */

/** Tons do tema (mapeados para as cores do Frest no CSS). */
export type Tone = 'success' | 'primary' | 'warning' | 'danger' | 'info' | 'secondary';

/** Grupo usado nos filtros de ramais. */
export type EndpointGroup = 'free' | 'busy' | 'offline';

export interface EndpointView {
  id: string;
  label: string;
  tone: Tone;
  group: EndpointGroup;
  userAgent: string | null;
  /** IP:porta do contato registrado, quando houver. */
  address: string | null;
  activeChannels: number;
}

const DEVICE: Record<DeviceState, { label: string; tone: Tone; group: EndpointGroup }> = {
  NOT_INUSE: { label: 'Livre', tone: 'success', group: 'free' },
  INUSE: { label: 'Em uso', tone: 'primary', group: 'busy' },
  BUSY: { label: 'Ocupado', tone: 'danger', group: 'busy' },
  RINGING: { label: 'Tocando', tone: 'warning', group: 'busy' },
  RINGINUSE: { label: 'Em uso + tocando', tone: 'warning', group: 'busy' },
  ONHOLD: { label: 'Em espera', tone: 'info', group: 'busy' },
  UNAVAILABLE: { label: 'Indisponível', tone: 'secondary', group: 'offline' },
  INVALID: { label: 'Inválido', tone: 'secondary', group: 'offline' },
  UNKNOWN: { label: 'Desconhecido', tone: 'secondary', group: 'offline' },
};

export function endpointView(ep: Endpoint): EndpointView {
  const d = DEVICE[ep.deviceState] ?? DEVICE.UNKNOWN;
  const contact = ep.contacts[0];
  return {
    id: ep.id,
    label: d.label,
    tone: d.tone,
    group: d.group,
    userAgent: contact?.userAgent ?? null,
    address: contact ? addressFromUri(contact.uri) : null,
    activeChannels: ep.activeChannels,
  };
}

/** "sip:9001@192.0.2.1:53051;ob" → "192.0.2.1:53051". */
export function addressFromUri(uri: string): string | null {
  const m = /@([^;>]+)/.exec(uri);
  return m?.[1] ?? null;
}

/** Ordena "9001" < "9010" < "tronco-sp" (números primeiro, em ordem numérica). */
export function compareEndpointIds(a: string, b: string): number {
  return a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });
}

// ------------------------------------------------------------------ chamadas

export interface Party {
  uniqueid: string;
  num: string;
  name: string;
  endpointId: string | null;
}

export interface CallView {
  id: string;
  status: CallStatus;
  label: string;
  tone: Tone;
  /** Quem está ligado a quem (ex.: [A, B]); se ninguém está em conversa, todos os canais reais. */
  parties: Party[];
  /** Há mais de um grupo conversando ao mesmo tempo (ex.: consulta numa transferência)? */
  extraGroups: Party[][];
  recording: boolean;
  /** Fila por onde a chamada passou. */
  queue: string | null;
  /** Algum participante está sendo escutado por um supervisor. */
  monitored: boolean;
  /** Esta "chamada" é um supervisor escutando: quem está sendo escutado. */
  spyTarget: Party | null;
  startedAt: number;
  answeredAt: number | null;
}

const CALL_STATUS: Record<CallStatus, { label: string; tone: Tone }> = {
  dialing: { label: 'Discando', tone: 'info' },
  ringing: { label: 'Tocando', tone: 'warning' },
  queued: { label: 'Na fila', tone: 'info' },
  talking: { label: 'Em conversa', tone: 'success' },
  held: { label: 'Em espera', tone: 'info' },
  other: { label: 'Em andamento', tone: 'secondary' },
};

function party(ch: Channel): Party {
  return {
    uniqueid: ch.uniqueid,
    num: ch.callerId.num || ch.endpointId || ch.name,
    name: ch.callerId.name && ch.callerId.name !== ch.callerId.num ? ch.callerId.name : '',
    endpointId: ch.endpointId,
  };
}

export function callView(call: Call, channels: Record<string, Channel>): CallView {
  const toParties = (ids: string[]) =>
    ids
      .map((id) => channels[id])
      .filter((c): c is Channel => !!c)
      .map(party);

  let parties: Party[];
  let extraGroups: Party[][] = [];
  if (call.links.length > 0) {
    [parties = [], ...extraGroups] = call.links.map(toParties);
  } else {
    // Ninguém conversando ainda (discando/tocando): mostra os canais reais em ordem de criação
    parties = toParties(call.channelIds.filter((id) => !channels[id]?.isLocal));
  }

  // Canal de supervisor em escuta: mostra "quem escuta" e "quem é escutado"
  const spyer = call.channelIds.map((id) => channels[id]).find((c) => c?.spying);
  const target = spyer?.spying ? channels[spyer.spying] : undefined;
  // O CallerID do canal do supervisor é "Escuta <alvo>" (para o telefone dele): na tela,
  // identifique-o pelo próprio ramal.
  if (spyer) parties = [{ ...party(spyer), num: spyer.endpointId ?? party(spyer).num, name: '' }];

  const s = spyer
    ? { label: 'Escutando', tone: 'info' as Tone }
    : (CALL_STATUS[call.status] ?? CALL_STATUS.other);
  return {
    id: call.id,
    status: call.status,
    label: s.label,
    tone: s.tone,
    monitored: call.monitored ?? false,
    spyTarget: target ? party(target) : null,
    parties,
    extraGroups,
    recording: call.recording,
    queue: call.queue ?? null,
    startedAt: call.startedAt,
    answeredAt: call.answeredAt,
  };
}

/** Segundos → "m:ss" ou "h:mm:ss". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ------------------------------------------------------------------ filas

/** Limites de espera na fila (segundos) para destacar o chamador. */
export const WAIT_WARNING_S = 60;
export const WAIT_DANGER_S = 180;

/** Tom da espera conforme os limites (usado com o relógio ao vivo). */
export function waitTone(waitSeconds: number): Tone {
  if (waitSeconds >= WAIT_DANGER_S) return 'danger';
  if (waitSeconds >= WAIT_WARNING_S) return 'warning';
  return 'secondary';
}

export interface QueueMemberView {
  id: string;
  /** Ramal (quando identificável) ou o nome/interface do membro. */
  label: string;
  interface: string;
  stateLabel: string;
  tone: Tone;
  paused: boolean;
  pausedReason: string;
  pausedSince: number | null;
  inCall: boolean;
  callsTaken: number;
  lastCall: number | null;
  penalty: number;
  /** Membro dinâmico (QueueAdd/login de agente). Os fixos vêm do cadastro (queues.conf). */
  dynamic: boolean;
  /** Ramal do membro, quando é um PJSIP identificável. */
  endpointId: string | null;
  /** Ordem de exibição: disponíveis, em atendimento, pausados, indisponíveis. */
  rank: number;
}

export interface QueueView {
  name: string;
  strategy: string;
  completed: number;
  abandoned: number;
  holdtime: number;
  talktime: number;
  serviceLevel: number;
  serviceLevelPerf: number;
  waiting: QueueEntry[];
  members: QueueMemberView[];
  available: number;
  busy: number;
  paused: number;
  offline: number;
}

function memberView(m: QueueMember): QueueMemberView {
  const d = DEVICE[m.status] ?? DEVICE.UNKNOWN;
  const offline = d.group === 'offline';
  const rank = offline ? 3 : m.paused ? 2 : d.group === 'busy' || m.inCall ? 1 : 0;
  return {
    id: m.id,
    label: m.endpointId ?? m.name,
    interface: m.interface,
    stateLabel: m.paused && !offline ? 'Pausado' : d.label,
    tone: m.paused && !offline ? 'warning' : d.tone,
    paused: m.paused,
    pausedReason: m.pausedReason,
    pausedSince: m.pausedSince,
    inCall: m.inCall,
    callsTaken: m.callsTaken,
    lastCall: m.lastCall,
    penalty: m.penalty,
    dynamic: m.membership === 'dynamic',
    endpointId: m.endpointId,
    rank,
  };
}

/** Junta fila, membros e chamadores aguardando numa estrutura pronta para o card. */
export function queueView(
  q: Queue,
  members: Record<string, QueueMember>,
  entries: Record<string, QueueEntry>,
): QueueView {
  const ms = Object.values(members)
    .filter((m) => m.queue === q.name)
    .map(memberView)
    .sort((a, b) => a.rank - b.rank || compareEndpointIds(a.label, b.label));
  return {
    name: q.name,
    strategy: q.strategy,
    completed: q.completed,
    abandoned: q.abandoned,
    holdtime: q.holdtime,
    talktime: q.talktime,
    serviceLevel: q.serviceLevel,
    serviceLevelPerf: q.serviceLevelPerf,
    waiting: Object.values(entries)
      .filter((e) => e.queue === q.name)
      .sort((a, b) => a.position - b.position),
    members: ms,
    available: ms.filter((m) => m.rank === 0).length,
    busy: ms.filter((m) => m.rank === 1).length,
    paused: ms.filter((m) => m.rank === 2).length,
    offline: ms.filter((m) => m.rank === 3).length,
  };
}

/** Rótulo amigável da estratégia de distribuição. */
export function strategyLabel(strategy: string): string {
  const labels: Record<string, string> = {
    ringall: 'Tocar todos',
    leastrecent: 'Menos recente',
    fewestcalls: 'Menos chamadas',
    random: 'Aleatória',
    rrmemory: 'Rodízio',
    rrordered: 'Rodízio ordenado',
    linear: 'Linear',
    wrandom: 'Aleatória ponderada',
  };
  return labels[strategy] ?? strategy;
}
