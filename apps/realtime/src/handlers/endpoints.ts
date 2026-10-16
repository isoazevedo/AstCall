import { normalizeDeviceState, parseRtt, type Handler } from './util.js';

/**
 * Handlers de endpoints PJSIP: estado do dispositivo e contatos registrados.
 * Só dispositivos "PJSIP/<nome>" viram endpoints (ignora Queue:, Custom:, Local/...).
 */
export const endpointHandlers: Record<string, Handler> = {
  devicestatechange: (store, msg) => {
    const m = /^PJSIP\/([^/]+)$/.exec(msg.device ?? '');
    if (!m?.[1]) return;
    store.ensureEndpoint(m[1]).deviceState = normalizeDeviceState(msg.state);
  },

  contactstatus: (store, msg) => {
    const endpointId = msg.endpointname || msg.aor;
    if (!endpointId || !msg.uri) return;
    const status = msg.contactstatus ?? 'Unknown';
    if (status === 'Removed') {
      store.removeContact(endpointId, msg.uri);
      return;
    }
    const previous = store.endpoints.get(endpointId)?.contacts.find((c) => c.uri === msg.uri);
    store.upsertContact(endpointId, {
      uri: msg.uri,
      // Created/Updated não dizem se o contato responde; mantém o status anterior
      status:
        status === 'Created' || status === 'Updated' ? (previous?.status ?? 'Unknown') : status,
      rttMs: parseRtt(msg.roundtripusec),
      userAgent: msg.useragent ?? previous?.userAgent ?? null,
    });
  },

  // ---- Itens de lista da sincronização
  endpointlist: (store, msg) => {
    if (!msg.objectname) return;
    store.ensureEndpoint(msg.objectname).deviceState = normalizeDeviceState(msg.devicestate);
  },

  contactlist: (store, msg) => {
    if (!msg.endpoint || !msg.uri) return;
    store.upsertContact(msg.endpoint, {
      uri: msg.uri,
      status: msg.status || 'Unknown',
      rttMs: parseRtt(msg.roundtripusec),
      userAgent: msg.useragent || null,
    });
  },
};
