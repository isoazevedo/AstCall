import type { ServerId } from './servers.js';

/**
 * Permissões que podem ser concedidas a um usuário em um servidor.
 * O backend valida a permissão antes de enviar qualquer action ao AMI.
 */
export const PERMISSIONS = [
  'view', // ver o painel do servidor
  'originate', // originar chamadas
  'hangup', // desligar canais
  'transfer', // transferir e estacionar
  'spy', // escutar / sussurrar / intervir (ChanSpy)
  'record', // gravar (MixMonitor)
  'queue', // gerenciar membros de fila
  'conference', // gerenciar conferências ConfBridge
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Permissões por servidor, ex.: { "pbx1": ["view", "hangup"] }. */
export type ServerPermissions = Record<ServerId, Permission[]>;

/**
 * Claims do JWT aceito pelo backend de tempo real.
 * É o contrato comum entre o modo standalone (Node emite) e o modo integrado (AzCall emite).
 */
export interface TokenClaims {
  /** Identificador do usuário no emissor. */
  sub: string;
  /** Nome de exibição. */
  name: string;
  /** Emissor do token (ex.: "astcall" ou "azcall"). */
  iss: string;
  /** Expiração (segundos desde a época Unix). */
  exp: number;
  /** Emissão (segundos desde a época Unix). */
  iat: number;
  /** Permissões por servidor. */
  perms: ServerPermissions;
}
