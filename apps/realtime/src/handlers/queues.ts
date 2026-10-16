import type { DeviceState, QueueMember } from '@astcall/shared';
import type { AmiMessage } from '../ami/index.js';
import { party, touchChannel, type Handler } from './util.js';

/**
 * Handlers de filas (app_queue): parâmetros/estatísticas, membros e chamadores aguardando.
 *
 * Fontes: itens da lista `QueueStatus` (QueueParams, QueueMember, QueueEntry) na
 * sincronização/reconciliação, e eventos ao vivo (QueueMember*, QueueCaller*, Agent*).
 */

/** Códigos numéricos de estado de dispositivo usados pelas filas (QueueMemberStatus "Status"). */
const DEVICE_BY_CODE: DeviceState[] = [
  'UNKNOWN',
  'NOT_INUSE',
  'INUSE',
  'BUSY',
  'INVALID',
  'UNAVAILABLE',
  'RINGING',
  'RINGINUSE',
  'ONHOLD',
];

const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : 0);

/** Epoch em segundos ("0" = nunca) → ms ou null. */
const epochMs = (v: string | undefined) => (num(v) > 0 ? num(v) * 1000 : null);

/** Interface do membro: "Interface" nos eventos, "Location" no QueueStatus. */
const ifaceOf = (msg: AmiMessage) => msg.interface || msg.location;

/** Campos do membro presentes no evento/item (os ausentes ficam undefined e não sobrescrevem). */
function memberPatch(msg: AmiMessage): Partial<QueueMember> {
  const patch: Partial<QueueMember> = {
    name: msg.membername || msg.name || undefined,
    membership: msg.membership || undefined,
  };
  if (msg.status !== undefined) patch.status = DEVICE_BY_CODE[num(msg.status)] ?? 'UNKNOWN';
  if (msg.paused !== undefined) {
    patch.paused = msg.paused === '1';
    patch.pausedReason = msg.pausedreason ?? msg.reason ?? '';
    // LastPause = início da pausa atual (quando informado)
    const since = epochMs(msg.lastpause);
    if (patch.paused && since) patch.pausedSince = since;
  }
  if (msg.incall !== undefined) patch.inCall = msg.incall === '1';
  if (msg.callstaken !== undefined) patch.callsTaken = num(msg.callstaken);
  if (msg.lastcall !== undefined) patch.lastCall = epochMs(msg.lastcall);
  if (msg.penalty !== undefined) patch.penalty = num(msg.penalty);
  return patch;
}

const upsertMemberFrom: Handler = (store, msg, ts) => {
  const iface = ifaceOf(msg);
  if (!msg.queue || !iface) return;
  store.upsertMember(msg.queue, iface, memberPatch(msg), ts);
};

export const queueHandlers: Record<string, Handler> = {
  // ---- Itens da lista QueueStatus (sincronização e reconciliação)
  queueparams: (store, msg) => {
    if (!msg.queue) return;
    const q = store.ensureQueue(msg.queue);
    q.strategy = msg.strategy ?? q.strategy;
    q.max = num(msg.max);
    q.completed = num(msg.completed);
    q.abandoned = num(msg.abandoned);
    q.holdtime = num(msg.holdtime);
    q.talktime = num(msg.talktime);
    q.serviceLevel = num(msg.servicelevel);
    q.serviceLevelPerf = num(msg.servicelevelperf);
    q.weight = num(msg.weight);
  },

  queuemember: upsertMemberFrom,

  queueentry: (store, msg, ts) => {
    if (!msg.queue || !msg.uniqueid) return;
    store.upsertEntry(
      msg.queue,
      msg.uniqueid,
      {
        channel: msg.channel,
        callerId: party(msg.calleridnum, msg.calleridname),
        position: num(msg.position),
        joinedAt: ts - num(msg.wait) * 1000,
      },
      ts,
    );
  },

  // ---- Membros (eventos ao vivo)
  queuememberadded: upsertMemberFrom,
  queuememberstatus: upsertMemberFrom,
  queuememberpause: upsertMemberFrom,
  queuememberpenalty: upsertMemberFrom,

  queuememberremoved: (store, msg) => {
    const iface = ifaceOf(msg);
    if (msg.queue && iface) store.removeMember(`${msg.queue}|${iface}`);
  },

  // ---- Chamadores
  queuecallerjoin: (store, msg, ts) => {
    if (!msg.queue || !msg.uniqueid) return;
    touchChannel(store, msg, ts);
    store.upsertEntry(
      msg.queue,
      msg.uniqueid,
      {
        channel: msg.channel,
        callerId: party(msg.calleridnum, msg.calleridname),
        position: num(msg.position),
      },
      ts,
    );
  },

  queuecallerleave: (store, msg, ts) => {
    if (!msg.queue || !msg.uniqueid) return;
    touchChannel(store, msg, ts);
    store.removeEntry(msg.queue, msg.uniqueid);
  },

  queuecallerabandon: (store, msg) => {
    if (!msg.queue || !msg.uniqueid) return;
    if (store.firstTime(`abandon|${msg.queue}|${msg.uniqueid}`)) {
      store.ensureQueue(msg.queue).abandoned++;
    }
    store.removeEntry(msg.queue, msg.uniqueid);
  },

  // ---- Agentes (membro tocando / atendeu / terminou)
  agentconnect: (store, msg, ts) => {
    // Garante a fila no canal do chamador mesmo se o QueueCallerJoin foi perdido
    touchChannel(store, msg, ts, msg.queue ? { queue: msg.queue } : {});
    touchChannel(store, msg, ts, {}, 'dest');
  },

  agentcomplete: (store, msg) => {
    if (!msg.queue || !msg.uniqueid) return;
    if (store.firstTime(`complete|${msg.queue}|${msg.uniqueid}`)) {
      store.ensureQueue(msg.queue).completed++;
    }
  },
};
