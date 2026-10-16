import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { AmiConnection } from './AmiConnection.js';
import type { AmiMessage } from './types.js';

/**
 * Uma linha do arquivo de gravação (JSON Lines).
 * - `msg`: mensagem recebida do Asterisk (evento, resposta ou item de lista);
 * - `status`: mudança de estado da conexão (marca reconexões na gravação).
 */
export type RecordLine = { t: number; msg: AmiMessage } | { t: number; status: string };

/**
 * Grava tudo o que o Asterisk envia em um arquivo `.jsonl`, uma mensagem por linha,
 * com o horário de chegada. As gravações viram fixtures de teste (cenários reais
 * reproduzidos contra o store).
 *
 * Só o tráfego RECEBIDO é gravado: as actions enviadas (incluindo o Login com a senha)
 * nunca vão para o arquivo. Mesmo assim, as gravações contêm dados reais (números,
 * nomes) — anonimizar antes de versionar.
 */
export class AmiRecorder {
  readonly file: string;
  private readonly stream: WriteStream;

  constructor(dir: string, connection: AmiConnection) {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    this.file = join(dir, `${connection.serverId}-${stamp}.jsonl`);
    this.stream = createWriteStream(this.file, { flags: 'a' });

    connection.on('message', (msg) => this.write({ t: Date.now(), msg }));
    connection.on('status', (status) => this.write({ t: Date.now(), status }));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }

  private write(line: RecordLine): void {
    this.stream.write(`${JSON.stringify(line)}\n`);
  }
}
