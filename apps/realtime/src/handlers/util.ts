import type { Channel, DeviceState, PartyId } from '@astcall/shared';
import type { AmiMessage } from '../ami/index.js';
import type { ServerStore } from '../state/ServerStore.js';

/** Um handler aplica um evento AMI ao store. `ts` é o horário de chegada do evento (ms). */
export type Handler = (store: ServerStore, msg: AmiMessage, ts: number) => void;

/** Monta número/nome tratando o "<unknown>" do Asterisk como vazio. */
export function party(num: string | undefined, name: string | undefined): PartyId {
  const clean = (v: string | undefined) => (!v || v === '<unknown>' ? '' : v);
  return { num: clean(num), name: clean(name) };
}

/**
 * Lê o "snapshot de canal" que o Asterisk inclui em muitos eventos.
 * Alguns eventos trazem mais de um canal com prefixo (ex.: "Dest" no DialBegin,
 * "Transferee" nas transferências); use `prefix` para ler esses.
 * Retorna undefined se o evento não traz esse canal.
 */
export function readChannel(
  msg: AmiMessage,
  prefix = '',
): { uniqueid: string; patch: Partial<Channel> } | undefined {
  const get = (key: string) => msg[prefix + key];
  const uniqueid = get('uniqueid');
  if (!uniqueid) return undefined;
  const patch: Partial<Channel> = {
    name: get('channel'),
    linkedid: get('linkedid'),
    state: get('channelstatedesc'),
    context: get('context'),
    exten: get('exten'),
  };
  if (get('calleridnum') !== undefined) {
    patch.callerId = party(get('calleridnum'), get('calleridname'));
  }
  if (get('connectedlinenum') !== undefined) {
    patch.connectedLine = party(get('connectedlinenum'), get('connectedlinename'));
  }
  return { uniqueid, patch };
}

/** Aplica o snapshot de canal do evento (com patch extra opcional) e devolve o canal. */
export function touchChannel(
  store: ServerStore,
  msg: AmiMessage,
  ts: number,
  extra: Partial<Channel> = {},
  prefix = '',
): Channel | undefined {
  const snap = readChannel(msg, prefix);
  if (!snap) return undefined;
  return store.upsertChannel(snap.uniqueid, { ...snap.patch, ...extra }, ts);
}

const DEVICE_STATES: Record<string, DeviceState> = {
  'not in use': 'NOT_INUSE',
  'in use': 'INUSE',
  busy: 'BUSY',
  invalid: 'INVALID',
  unavailable: 'UNAVAILABLE',
  ringing: 'RINGING',
  'ring+inuse': 'RINGINUSE',
  'on hold': 'ONHOLD',
  unknown: 'UNKNOWN',
};

/**
 * Normaliza o estado de dispositivo. O DeviceStateChange usa "NOT_INUSE",
 * mas o EndpointList usa texto ("Not in use").
 */
export function normalizeDeviceState(value: string | undefined): DeviceState {
  if (!value) return 'UNKNOWN';
  const upper = value.toUpperCase();
  if (Object.values(DEVICE_STATES).includes(upper as DeviceState)) return upper as DeviceState;
  return DEVICE_STATES[value.toLowerCase()] ?? 'UNKNOWN';
}

/** "01:02:03" → segundos. */
export function parseDuration(value: string | undefined): number {
  if (!value) return 0;
  return value.split(':').reduce((acc, part) => acc * 60 + (Number(part) || 0), 0);
}

/** Round-trip em microssegundos → ms (null quando não há qualify). */
export function parseRtt(usec: string | undefined): number | null {
  const n = Number(usec);
  return usec && Number.isFinite(n) && n > 0 ? Math.round(n / 100) / 10 : null;
}
