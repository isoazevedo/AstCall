import type { AmiMessage } from './types.js';

const MESSAGE_END = '\r\n\r\n';
const LINE_END = '\r\n';

/**
 * Parser incremental do protocolo AMI.
 *
 * O AMI é texto: cada mensagem é um bloco de linhas "Chave: Valor" terminado por uma
 * linha em branco ("\r\n\r\n"). Logo após conectar, o Asterisk envia uma única linha de
 * saudação ("Asterisk Call Manager/X.Y.Z") que não segue esse formato.
 *
 * Os dados chegam do socket em pedaços arbitrários; `feed()` acumula o texto e devolve
 * apenas as mensagens completas.
 */
export class AmiParser {
  private buffer = '';
  private greetingPending = true;

  /** Versão do protocolo informada na saudação (ex.: "11.0.0"), quando já recebida. */
  greeting: string | undefined;

  /** Recebe um pedaço de texto do socket e devolve as mensagens completas encontradas. */
  feed(chunk: string): AmiMessage[] {
    this.buffer += chunk;
    const messages: AmiMessage[] = [];

    if (this.greetingPending) {
      const idx = this.buffer.indexOf(LINE_END);
      if (idx === -1) return messages;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + LINE_END.length);
      this.greetingPending = false;
      this.greeting = line.replace(/^Asterisk Call Manager\//, '');
    }

    let end: number;
    while ((end = this.buffer.indexOf(MESSAGE_END)) !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + MESSAGE_END.length);
      const msg = parseBlock(block);
      if (msg) messages.push(msg);
    }
    return messages;
  }

  /** Descarta o estado (usar ao reconectar). */
  reset(): void {
    this.buffer = '';
    this.greetingPending = true;
    this.greeting = undefined;
  }
}

/** Converte um bloco de linhas "Chave: Valor" em objeto. */
export function parseBlock(block: string): AmiMessage | undefined {
  const msg: AmiMessage = {};
  let hasContent = false;
  for (const line of block.split(LINE_END)) {
    if (line === '') continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue; // linha fora do formato: ignora
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trimStart();
    msg[key] = key in msg ? `${msg[key]}\n${value}` : value;
    hasContent = true;
  }
  return hasContent ? msg : undefined;
}

/**
 * Serializa uma action para envio. Rejeita CR/LF nos valores: eles permitiriam
 * injetar cabeçalhos ou actions extras a partir de dados vindos do navegador.
 */
export function serializeAction(fields: Record<string, string | string[]>): string {
  let out = '';
  for (const [key, raw] of Object.entries(fields)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
        throw new Error(`Valor inválido no campo "${key}": quebras de linha não são permitidas`);
      }
      out += `${key}: ${value}${LINE_END}`;
    }
  }
  return out + LINE_END;
}
