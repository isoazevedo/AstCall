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
  /**
   * Desde quando está offline (ms), quando o backend viu o endpoint cair (estava online e
   * ficou indisponível). null = online, ou offline desde antes do monitoramento começar.
   */
  offlineSince: number | null;
  /** Qualidade de voz média das conversas em curso deste endpoint (null = sem medição agora). */
  quality: EndpointQuality | null;
}

/**
 * Qualidade de voz de um canal, medida pelo Asterisk a partir do RTCP
 * (`CHANNEL(rtcp,all)`). A nota é o MES — Media Experience Score, de 0 a 100 — no pior dos
 * dois sentidos da conversa.
 */
export interface VoiceQuality {
  /** Nota de 0 a 100 (80+ boa, 60–79 regular, abaixo de 60 ruim). */
  mes: number;
  /** Maior variação de atraso (jitter) entre os dois sentidos, em ms. */
  jitterMs: number;
  /** Atraso de ida e volta, em ms (null antes do primeiro relatório RTCP). */
  rttMs: number | null;
  /** Maior perda de pacotes entre os dois sentidos, em % (acumulada na chamada). */
  lossPct: number;
  /** Quando foi medida (ms). */
  updatedAt: number;
}

/** Qualidade de voz de um endpoint (ex.: um tronco): média das conversas em curso. */
export interface EndpointQuality {
  /** Média das notas MES dos canais em conversa. */
  mes: number;
  /** Quantos canais entraram na média. */
  channels: number;
  /** Desde quando a média está abaixo do limite de alerta (ms); null = acima. */
  degradedSince: number | null;
  updatedAt: number;
}

/** Estados de dispositivo em que o endpoint está fora do ar (sem telefone registrado). */
export const OFFLINE_DEVICE_STATES: readonly DeviceState[] = ['UNAVAILABLE', 'INVALID', 'UNKNOWN'];

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
  /** Este canal é de um supervisor escutando outro canal (Uniqueid do canal escutado). */
  spying: string | null;
  /** Este canal está sendo escutado (Uniqueid do canal de quem escuta). */
  spiedBy: string | null;
  /** Fila por onde o canal entrou (continua preenchida depois do atendimento). */
  queue: string | null;
  /** Aguardando na fila agora (entre QueueCallerJoin e QueueCallerLeave). */
  inQueue: boolean;
  /** Epoch em ms. */
  createdAt: number;
  answeredAt: number | null;
  /** Qualidade de voz medida (só canais PJSIP em conversa, com áudio passando pelo Asterisk). */
  quality: VoiceQuality | null;
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
  /** Algum participante está sendo escutado por um supervisor. */
  monitored: boolean;
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

/**
 * Previsão de uma fila (calculada pelo backend a cada poucos segundos). Chave: nome da fila.
 *
 * Usa a janela recente (padrão 15 min): ritmo de entrada, tempo médio de atendimento e
 * atendentes disponíveis, com a fórmula Erlang C (padrão de call center).
 */
export interface QueueForecast {
  queue: string;
  /**
   * warming = ainda coletando dados (logo após o backend iniciar);
   * idle = sem entradas na janela (sem movimento para prever);
   * ok = previsão válida.
   */
  status: 'warming' | 'idle' | 'ok';
  /** Janela usada no cálculo (minutos). */
  windowMin: number;
  /** Ritmo de entrada (chamadas por minuto) na janela. */
  arrivalsPerMin: number;
  /** Tempo médio de atendimento (s) na janela (ou a média do Asterisk, ou o padrão). */
  ahtSec: number | null;
  /**
   * true = ainda não houve atendimento concluído: `ahtSec` é o valor padrão configurado
   * (estimativa inicial), até o primeiro atendimento terminar.
   */
  ahtEstimated: boolean;
  /** Atendentes logados, não pausados e registrados. */
  agentsAvailable: number;
  /** Atendentes necessários para atingir a meta; null sem dados suficientes. */
  agentsNeeded: number | null;
  /** Nível de serviço previsto (%); null sem dados suficientes. */
  slForecast: number | null;
  /** Meta de nível de serviço (%) e o tempo da meta (s). */
  slTarget: number;
  slSeconds: number;
  /** Ritmo de entrada recente comparado ao anterior. */
  trend: 'up' | 'stable' | 'down';
  /** ok = dentro da meta; warn = abaixo da meta; high = muito abaixo ou sem atendente com espera. */
  risk: 'ok' | 'warn' | 'high';
  /** Previsão de atendimento por chamador aguardando: uniqueid → horário estimado (ms). */
  etaAt: Record<string, number>;
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
