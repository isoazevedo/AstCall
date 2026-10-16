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

/** Chave curinga em `perms`: as permissões valem para todos os servidores. */
export const ALL_SERVERS = '*';

/**
 * Permissões por servidor, ex.: { "pbx1": ["view", "hangup"] }.
 * A chave "*" vale para todos os servidores e soma-se às permissões específicas.
 */
export type ServerPermissions = Record<ServerId, Permission[]>;

/** Verifica se `perms` concede `perm` no servidor `serverId` (considerando o curinga "*"). */
export function hasPermission(
  perms: ServerPermissions,
  serverId: ServerId,
  perm: Permission,
): boolean {
  return (
    (perms[serverId]?.includes(perm) ?? false) || (perms[ALL_SERVERS]?.includes(perm) ?? false)
  );
}

/** Permissões efetivas em um servidor: as específicas somadas às do curinga "*". */
export function permissionsFor(perms: ServerPermissions, serverId: ServerId): Permission[] {
  return [...new Set([...(perms[serverId] ?? []), ...(perms[ALL_SERVERS] ?? [])])];
}

/**
 * Resposta do endpoint de token (`token-url` do Web Component).
 * No modo standalone é o `POST /auth/refresh` do backend; no modo integrado, um endpoint do
 * AzCall. O componente chama com `credentials: 'same-origin'` (o cookie de sessão autentica).
 */
export interface TokenResponse {
  /** JWT RS256 de curta duração. */
  token: string;
  /** Expiração do token (ms desde a época Unix), para renovar antes. */
  expiresAt: number;
}

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
  /**
   * Escopo por servidor (multi-empresa). Ausente para um servidor = vê tudo nele.
   * Presente = só os endpoints (ramais e troncos) e filas listados — e as chamadas que os
   * envolvem. Ex.: { "pbx1": { endpoints: ["9001", "Avoip"], queues: ["suporte-default"] } }.
   */
  scope?: Record<ServerId, ServerScope>;
  /** Ramal do usuário (sugestão nos diálogos de "Ligar" e escuta). */
  extension?: string;
}

/** O que um usuário com escopo pode ver/agir num servidor. */
export interface ServerScope {
  /** Nomes de endpoints PJSIP (ramais e troncos). */
  endpoints: string[];
  /** Nomes de filas como estão no Asterisk (ex.: "suporte-default"). */
  queues: string[];
}

/** Resposta do `POST /auth/login` do modo standalone. */
export interface LoginResponse extends TokenResponse {
  user: { username: string; name: string; perms: ServerPermissions };
}
