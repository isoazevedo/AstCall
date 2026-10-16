import type { Permission } from './auth.js';

/**
 * Identificador de um servidor Asterisk (ex.: "pbx1").
 * Toda entidade de estado e toda mensagem WebSocket carregam esse id,
 * pois o projeto é desenhado para múltiplos servidores desde o início.
 */
export type ServerId = string;

/** Estado da conexão do backend com o AMI de um servidor. */
export type ServerConnectionStatus = 'connecting' | 'syncing' | 'ready' | 'disconnected';

/** Informações públicas de um servidor (sem credenciais), seguras para enviar ao navegador. */
export interface ServerInfo {
  id: ServerId;
  name: string;
  status: ServerConnectionStatus;
  /**
   * Permissões do usuário neste servidor (já somando o curinga "*"). O painel usa para
   * mostrar só os botões permitidos; o backend valida de novo a cada ação.
   */
  permissions: Permission[];
}
