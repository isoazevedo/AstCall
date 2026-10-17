import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger.js';

/**
 * Uma linha do log de auditoria: quem pediu qual ação, onde, com quais parâmetros e o
 * resultado. Gravada como JSON (uma por linha) em `AUDIT_FILE`.
 */
export interface AuditEntry {
  /** Data/hora ISO 8601. */
  ts: string;
  /** `sub` do token (ex.: "ana", "azcall:12"). */
  user: string;
  /** Nome de exibição do token. */
  name: string;
  /** Emissor do token ("astcall" ou "azcall"). */
  iss: string;
  server: string;
  action: string;
  params: unknown;
  ok: boolean;
  /** Actions AMI enviadas (quando executou). */
  ami?: string[];
  /** Código do erro (forbidden, not_found, ami_error...) quando recusada. */
  code?: string;
  error?: string;
}

/**
 * Grava a auditoria em arquivo, em modo append. Sem arquivo configurado, não grava nada
 * (as ações continuam aparecendo no log geral).
 *
 * Rotação: use logrotate com `copytruncate` — o arquivo fica aberto em modo append, então
 * truncar é seguro (ver docs/AUDITORIA.md).
 */
export class AuditLog {
  private readonly stream: WriteStream | undefined;

  constructor(
    readonly file: string | undefined,
    private readonly log: Logger,
  ) {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    this.stream = createWriteStream(file, { flags: 'a', mode: 0o640 });
    this.stream.on('error', (err) =>
      this.log.error({ err: err.message, file }, 'Falha ao gravar a auditoria'),
    );
  }

  write(entry: AuditEntry): void {
    this.stream?.write(`${JSON.stringify(entry)}\n`);
  }

  /** Fecha o arquivo (encerramento do processo), esperando o que falta gravar. */
  close(): Promise<void> {
    return new Promise((resolve) => (this.stream ? this.stream.end(resolve) : resolve()));
  }
}
