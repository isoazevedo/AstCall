/**
 * Uma mensagem AMI (evento ou resposta) já interpretada.
 * As chaves dos cabeçalhos são normalizadas para minúsculas, pois o Asterisk
 * não é consistente na capitalização (ex.: "Uniqueid" x "UniqueID").
 * Cabeçalhos repetidos têm os valores unidos por "\n".
 */
export type AmiMessage = Record<string, string>;

/** Campos de uma action. Arrays geram o mesmo cabeçalho repetido (ex.: vários "Variable"). */
export type AmiActionFields = Record<string, string | number | boolean | string[] | undefined>;

/** Resultado de uma action de lista (ex.: CoreShowChannels). */
export interface AmiListResult {
  /** Resposta inicial ("Response: Success", "EventList: start"). */
  response: AmiMessage;
  /** Eventos de item da lista, sem o evento final "...Complete". */
  events: AmiMessage[];
  /** Evento final da lista (ex.: "CoreShowChannelsComplete"). */
  complete: AmiMessage;
}

/** A action foi respondida com "Response: Error". */
export class AmiActionError extends Error {
  override name = 'AmiActionError';
  constructor(
    readonly action: string,
    readonly response: AmiMessage,
  ) {
    super(`Action ${action} falhou: ${response.message ?? 'erro sem mensagem'}`);
  }
}

/** A action não foi respondida a tempo. */
export class AmiTimeoutError extends Error {
  override name = 'AmiTimeoutError';
  constructor(
    readonly action: string,
    timeoutMs: number,
  ) {
    super(`Action ${action} sem resposta após ${timeoutMs} ms`);
  }
}

/** A conexão caiu (ou não estava aberta) enquanto a action aguardava resposta. */
export class AmiDisconnectedError extends Error {
  override name = 'AmiDisconnectedError';
  constructor(readonly action: string) {
    super(`Conexão AMI indisponível durante a action ${action}`);
  }
}
