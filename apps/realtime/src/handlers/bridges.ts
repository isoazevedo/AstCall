import { touchChannel, type Handler } from './util.js';

/**
 * Handlers de bridges. Uma bridge tem N canais; entrar/sair atualiza tanto a bridge
 * quanto o `bridgeId` do canal. BridgeEnter sem BridgeCreate cria a bridge.
 */
export const bridgeHandlers: Record<string, Handler> = {
  bridgecreate: (store, msg, ts) => {
    if (!msg.bridgeuniqueid) return;
    store.ensureBridge(
      msg.bridgeuniqueid,
      { type: msg.bridgetype, technology: msg.bridgetechnology },
      ts,
    );
  },

  bridgeenter: (store, msg, ts) => {
    if (!msg.bridgeuniqueid) return;
    store.ensureBridge(
      msg.bridgeuniqueid,
      { type: msg.bridgetype, technology: msg.bridgetechnology },
      ts,
    );
    const ch = touchChannel(store, msg, ts);
    if (ch) store.addToBridge(msg.bridgeuniqueid, ch.uniqueid, ts);
  },

  bridgeleave: (store, msg, ts) => {
    if (!msg.bridgeuniqueid) return;
    const ch = touchChannel(store, msg, ts);
    if (ch) store.removeFromBridge(msg.bridgeuniqueid, ch.uniqueid);
  },

  bridgedestroy: (store, msg) => {
    if (msg.bridgeuniqueid) store.removeBridge(msg.bridgeuniqueid);
  },
};
