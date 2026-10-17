import type { Permission } from './auth.js';

/**
 * Ações que o painel pode pedir ao backend (lista fechada).
 * O navegador nunca envia nomes de canal nem actions AMI: só o nome da ação e parâmetros
 * de alto nível; o backend valida, confere a permissão e monta a action AMI.
 */
export interface ActionParams {
  /** Pausa/retoma um membro de fila. `queue` null = em todas as filas do membro. */
  queuePause: { queue: string | null; interface: string; paused: boolean; reason?: string };
  /**
   * Adiciona o ramal `endpoint` à fila como membro dinâmico (QueueAdd). Com
   * `persistentmembers=yes` no Asterisk ele continua na fila após reload/reinício.
   */
  queueAdd: { queue: string; endpoint: string; penalty: number; paused: boolean };
  /** Remove um membro dinâmico da fila (membros fixos vêm do cadastro e não podem sair). */
  queueRemove: { queue: string; interface: string };
  /** Altera a penalidade do membro na fila (em membro fixo, vale até o próximo reload). */
  queuePenalty: { queue: string; interface: string; penalty: number };
  /** Desliga um canal (identificado pelo Uniqueid). */
  hangup: { uniqueid: string };
  /** Transferência cega: o participante `uniqueid` passa a falar com o número `to`. */
  transfer: { uniqueid: string; to: string };
  /** Faz o ramal `from` tocar e, ao atender, discar para `to`. */
  originate: { from: string; to: string };
  /**
   * Escuta (ChanSpy): faz o ramal `listener` tocar e, ao atender, escuta o canal `uniqueid`.
   * listen = só ouvir; whisper = falar só com o ramal monitorado; barge = falar com os dois.
   */
  spy: { uniqueid: string; listener: string; mode: SpyMode };
}

export type SpyMode = 'listen' | 'whisper' | 'barge';

export type ActionName = keyof ActionParams;

/** Permissão exigida por ação (validada no backend; o painel usa para mostrar os botões). */
export const ACTION_PERMISSION: Record<ActionName, Permission> = {
  queuePause: 'queue',
  queueAdd: 'queue_manage',
  queueRemove: 'queue_manage',
  queuePenalty: 'queue_manage',
  hangup: 'hangup',
  transfer: 'transfer',
  originate: 'originate',
  spy: 'spy',
};

/** Faixa aceita para a penalidade de membro de fila. */
export const PENALTY_MAX = 1000;

/** Números de destino aceitos: dígitos e * # + (ex.: 9005, *600, +5511999999999). */
export const DIAL_TARGET = /^[0-9*#+]{1,32}$/;
