import type { DeltaOp, ServerSnapshot } from './delta.js';
import type { ServerConnectionStatus, ServerId, ServerInfo } from './servers.js';

/**
 * Protocolo WebSocket entre navegador e backend (rota `/monitor-ws`).
 *
 * Fluxo:
 * 1. Cliente conecta e envia `auth` (o token não vai na URL para não vazar em logs).
 * 2. Servidor responde `auth_ok` com os servidores que o usuário pode ver.
 * 3. Cliente envia `subscribe`; para cada servidor pronto recebe um `snapshot`.
 * 4. Depois vêm `delta` numerados: `seq` = seq anterior + 1 dentro do mesmo `epoch`.
 *    Lacuna na numeração ou `epoch` diferente → o cliente envia `resync`.
 * 5. Antes de o token expirar, o cliente envia outro `auth` com um token novo.
 */

/** Versão do protocolo; mudanças incompatíveis devem incrementá-la. */
export const PROTOCOL_VERSION = 1;

/** Caminho do WebSocket no backend. */
export const WS_PATH = '/monitor-ws';

/** Códigos de fechamento usados pelo servidor. */
export const WS_CLOSE = {
  /** Sem `auth` válido a tempo, ou token inválido. */
  AUTH_FAILED: 4001,
  /** Mensagem inválida / fora do protocolo. */
  PROTOCOL_ERROR: 4002,
  /** Token expirou sem renovação. */
  TOKEN_EXPIRED: 4008,
  /** Cliente não consome as mensagens a tempo (buffer cheio). */
  TOO_SLOW: 4009,
  /** Servidor encerrando. */
  GOING_AWAY: 1001,
} as const;

// ---------- Cliente → servidor ----------

export interface AuthMessage {
  t: 'auth';
  token: string;
}

export interface SubscribeMessage {
  t: 'subscribe';
  servers: ServerId[];
}

export interface UnsubscribeMessage {
  t: 'unsubscribe';
  servers: ServerId[];
}

/** Pede um snapshot novo (ex.: o cliente detectou lacuna no `seq`). */
export interface ResyncMessage {
  t: 'resync';
  server: ServerId;
}

export type ClientMessage = AuthMessage | SubscribeMessage | UnsubscribeMessage | ResyncMessage;

// ---------- Servidor → cliente ----------

export interface AuthOkMessage {
  t: 'auth_ok';
  protocol: typeof PROTOCOL_VERSION;
  user: { sub: string; name: string };
  /** Expiração do token atual (ms): renovar antes. */
  expiresAt: number;
  /** Servidores que o usuário pode ver (permissão `view`). */
  servers: ServerInfo[];
}

export interface ServerStatusMessage {
  t: 'server_status';
  server: ServerId;
  status: ServerConnectionStatus;
}

export interface SnapshotMessage {
  t: 'snapshot';
  server: ServerId;
  epoch: number;
  seq: number;
  data: ServerSnapshot;
}

export interface DeltaMessage {
  t: 'delta';
  server: ServerId;
  epoch: number;
  seq: number;
  ops: DeltaOp[];
}

export interface ErrorMessage {
  t: 'error';
  code: string;
  message: string;
}

export type ServerMessage =
  AuthOkMessage | ServerStatusMessage | SnapshotMessage | DeltaMessage | ErrorMessage;
