import type { Call, CallStatus, Channel, DeviceState, Endpoint } from '@astcall/shared';

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
  startedAt: number;
  answeredAt: number | null;
}

const CALL_STATUS: Record<CallStatus, { label: string; tone: Tone }> = {
  dialing: { label: 'Discando', tone: 'info' },
  ringing: { label: 'Tocando', tone: 'warning' },
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

  const s = CALL_STATUS[call.status] ?? CALL_STATUS.other;
  return {
    id: call.id,
    status: call.status,
    label: s.label,
    tone: s.tone,
    parties,
    extraGroups,
    recording: call.recording,
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
