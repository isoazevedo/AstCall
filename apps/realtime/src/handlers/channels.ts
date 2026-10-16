import { parseDuration, readChannel, touchChannel, type Handler } from './util.js';

/**
 * Handlers de canais: ciclo de vida (Newchannel → Hangup), mudanças de estado,
 * identificação, discagem, espera e gravação.
 */

/** Eventos que só atualizam o snapshot do canal. */
const snapshotOnly: Handler = (store, msg, ts) => {
  touchChannel(store, msg, ts);
};

export const channelHandlers: Record<string, Handler> = {
  newchannel: snapshotOnly,
  newstate: snapshotOnly,
  newcallerid: snapshotOnly,
  newconnectedline: snapshotOnly,

  newexten: (store, msg, ts) => {
    touchChannel(store, msg, ts, { application: msg.application || null });
  },

  rename: (store, msg, ts) => {
    touchChannel(store, msg, ts, { name: msg.newname });
  },

  hangup: (store, msg) => {
    if (msg.uniqueid) store.removeChannel(msg.uniqueid);
  },

  // ---- Discagem. O canal de origem pode faltar (ex.: discagem iniciada por um canal Local).
  dialbegin: (store, msg, ts) => {
    const caller = touchChannel(store, msg, ts, { dialStatus: 'DIALING' });
    touchChannel(store, msg, ts, { dialedBy: caller?.uniqueid ?? null }, 'dest');
  },

  dialstate: (store, msg, ts) => {
    touchChannel(store, msg, ts, { dialStatus: msg.dialstatus || null });
    touchChannel(store, msg, ts, {}, 'dest');
  },

  dialend: (store, msg, ts) => {
    touchChannel(store, msg, ts, { dialStatus: msg.dialstatus || null });
    touchChannel(store, msg, ts, {}, 'dest');
  },

  // ---- Espera e gravação
  hold: (store, msg, ts) => {
    touchChannel(store, msg, ts, { onHold: true });
  },
  unhold: (store, msg, ts) => {
    touchChannel(store, msg, ts, { onHold: false });
  },
  mixmonitorstart: (store, msg, ts) => {
    touchChannel(store, msg, ts, { recording: true });
  },
  mixmonitorstop: (store, msg, ts) => {
    touchChannel(store, msg, ts, { recording: false });
  },

  // ---- Item de lista da sincronização (CoreShowChannels)
  coreshowchannel: (store, msg, ts) => {
    const snap = readChannel(msg);
    if (!snap) return;
    const createdAt = ts - parseDuration(msg.duration) * 1000;
    const up = snap.patch.state === 'Up';
    store.upsertChannel(
      snap.uniqueid,
      {
        ...snap.patch,
        application: msg.application || null,
        createdAt,
        // Horário exato do atendimento é desconhecido; aproxima pelo início do canal.
        answeredAt: up ? createdAt : null,
      },
      ts,
    );
    if (msg.bridgeid) store.addToBridge(msg.bridgeid, snap.uniqueid, ts);
  },
};
