import type { ServerConnectionStatus, ServerId, ServerInfo } from './servers.js';

/**
 * Protocolo WebSocket entre navegador e backend.
 * Versão inicial: apenas autenticação e status de servidores.
 * Snapshot e deltas serão detalhados junto com o store (itens 3 a 5 do roadmap).
 */

/** Versão do protocolo; mudanças incompatíveis devem incrementá-la. */
export const PROTOCOL_VERSION = 1;

// ---------- Cliente → servidor ----------

/** Primeira mensagem obrigatória: o token não vai na URL para não vazar em logs. */
export interface AuthMessage {
  t: 'auth';
  token: string;
}

export interface SubscribeMessage {
  t: 'subscribe';
  servers: ServerId[];
}

export type ClientMessage = AuthMessage | SubscribeMessage;

// ---------- Servidor → cliente ----------

export interface AuthOkMessage {
  t: 'auth_ok';
  protocol: typeof PROTOCOL_VERSION;
  /** Servidores que o usuário pode ver. */
  servers: ServerInfo[];
}

export interface ServerStatusMessage {
  t: 'server_status';
  server: ServerId;
  status: ServerConnectionStatus;
}

export interface ErrorMessage {
  t: 'error';
  code: string;
  message: string;
}

export type ServerMessage = AuthOkMessage | ServerStatusMessage | ErrorMessage;
