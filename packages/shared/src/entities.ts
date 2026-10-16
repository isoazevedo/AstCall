/**
 * Entidades do estado de um servidor Asterisk, como o frontend as recebe.
 * O servidor a que pertencem vem na mensagem (snapshot/delta), não em cada entidade.
 */

/** Estado de dispositivo do Asterisk (DeviceStateChange). */
export type DeviceState =
  | 'UNKNOWN'
  | 'NOT_INUSE'
  | 'INUSE'
  | 'BUSY'
  | 'INVALID'
  | 'UNAVAILABLE'
  | 'RINGING'
  | 'RINGINUSE'
  | 'ONHOLD';

/** Número e nome de uma parte da chamada ("" quando o Asterisk informa <unknown>). */
export interface PartyId {
  num: string;
  name: string;
}

/** Um contato registrado de um endpoint PJSIP (ex.: o softphone). */
export interface Contact {
  uri: string;
  /** Reachable, Unreachable, NonQualified (sem qualify), Unknown... */
  status: string;
  /** Tempo de ida e volta em ms (só com qualify ativo). */
  rttMs: number | null;
  userAgent: string | null;
}

/** Endpoint PJSIP (ramal ou tronco). Chave: nome do endpoint (ex.: "9001"). */
export interface Endpoint {
  id: string;
  deviceState: DeviceState;
  contacts: Contact[];
  /** Canais ativos deste endpoint (calculado). */
  activeChannels: number;
}

/** Canal ativo. Chave: Uniqueid. */
export interface Channel {
  uniqueid: string;
  /** Nome do canal (ex.: "PJSIP/9001-0000002c"). */
  name: string;
  /** Identificador da chamada a que o canal pertence (pode mudar em transferências). */
  linkedid: string;
  /** Estado textual do Asterisk: Down, Ring, Ringing, Up, Busy... */
  state: string;
  callerId: PartyId;
  connectedLine: PartyId;
  context: string;
  exten: string;
  /** Aplicação do dialplan em execução (ex.: "Dial", "Queue"), quando conhecida. */
  application: string | null;
  /** Endpoint PJSIP dono do canal (null para Local e outras tecnologias). */
  endpointId: string | null;
  /** Canal Local (metade de um par ";1"/";2"). */
  isLocal: boolean;
  /** Bridge em que o canal está agora. */
  bridgeId: string | null;
  /** Uniqueid do canal que discou para este (DialBegin). */
  dialedBy: string | null;
  /** Último status de discagem deste canal como originador: RINGING, ANSWER, NOANSWER, BUSY, CANCEL... */
  dialStatus: string | null;
  onHold: boolean;
  recording: boolean;
  /** Fila por onde o canal entrou (continua preenchida depois do atendimento). */
  queue: string | null;
  /** Aguardando na fila agora (entre QueueCallerJoin e QueueCallerLeave). */
  inQueue: boolean;
  /** Epoch em ms. */
  createdAt: number;
  answeredAt: number | null;
}

/** Bridge (mistura de áudio) com N canais. Chave: BridgeUniqueid. */
export interface Bridge {
  id: string;
  type: string;
  technology: string;
  channelIds: string[];
  createdAt: number;
}

/** Situação resumida de uma chamada. */
export type CallStatus = 'dialing' | 'ringing' | 'queued' | 'talking' | 'held' | 'other';

/**
 * Chamada: todos os canais com o mesmo Linkedid (calculada a partir dos canais).
 * Transferências e filas mantêm o Linkedid, então continuam sendo a mesma chamada.
 */
export interface Call {
  id: string;
  channelIds: string[];
  bridgeIds: string[];
  status: CallStatus;
  /**
   * Grupos de canais reais (não Local) que estão se ouvindo, atravessando bridges e pares
   * de canais Local. Ex.: [["<uniqueid 9002>", "<uniqueid 9005>"]].
   */
  links: string[][];
  recording: boolean;
  /** Fila por onde a chamada passou (null se não passou por fila). */
  queue: string | null;
  startedAt: number;
  answeredAt: number | null;
}

// ------------------------------------------------------------------ filas

/** Fila (app_queue). Chave: nome da fila. Estatísticas acumuladas desde o último reload/reset. */
export interface Queue {
  name: string;
  strategy: string;
  /** Limite de chamadores (0 = sem limite). */
  max: number;
  /** Atendidas (completadas). */
  completed: number;
  abandoned: number;
  /** Espera média em segundos (média do Asterisk). */
  holdtime: number;
  /** Conversa média em segundos (média do Asterisk). */
  talktime: number;
  /** Nível de serviço configurado (segundos) e % de atendidas dentro dele. */
  serviceLevel: number;
  serviceLevelPerf: number;
  weight: number;
}

/** Membro (agente) de uma fila. Chave: "<fila>|<interface>". */
export interface QueueMember {
  id: string;
  queue: string;
  /** Interface que recebe as chamadas (ex.: "PJSIP/9001", "Local/9001@ctx"). */
  interface: string;
  name: string;
  /** Endpoint PJSIP associado, quando dá para identificar (ex.: "9001"). */
  endpointId: string | null;
  /** Estado de dispositivo do membro. */
  status: DeviceState;
  paused: boolean;
  pausedReason: string;
  /** Início da pausa atual (ms), quando conhecido. */
  pausedSince: number | null;
  inCall: boolean;
  callsTaken: number;
  /** Fim da última chamada atendida (ms). */
  lastCall: number | null;
  penalty: number;
  /** static (configurado), dynamic (QueueAdd) ou realtime. */
  membership: string;
}

/** Chamador aguardando numa fila. Chave: "<fila>|<uniqueid>". */
export interface QueueEntry {
  id: string;
  queue: string;
  uniqueid: string;
  channel: string;
  callerId: PartyId;
  position: number;
  /** Entrada na fila (ms). */
  joinedAt: number;
}
