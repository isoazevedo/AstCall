import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  applyOps,
  type DeltaOp,
  type ServerConnectionStatus,
  type ServerId,
  type ServerSnapshot,
} from '@astcall/shared';

/**
 * Histórico do estado de cada servidor (máquina do tempo), em SQLite (`node:sqlite`).
 *
 * Grava duas coisas:
 * - **fotos** (`checkpoints`): o estado completo, a cada poucos minutos e após cada
 *   ressincronização;
 * - **lotes de deltas** (`batches`): as alterações do estado, como o painel ao vivo recebe.
 *   Cada gravação (a cada poucos segundos) vira uma linha com as alterações do período e o
 *   horário de cada uma: `[[ts, ops], ...]`.
 *
 * Fotos e lotes são gravados em JSON comprimido (zlib): o volume cai para ~1/6.
 *
 * Para saber o estado às 14:32: pega a última foto até 14:32 e aplica, em ordem, os lotes
 * gravados depois dela (até 14:32). Cada foto guarda o id do último lote já incluído nela
 * (`last_batch`), então não há dúvida sobre o que aplicar, mesmo com horários iguais.
 *
 * Também registra as mudanças de status da conexão com o PBX (para a tela avisar "PBX
 * desconectado neste horário"). Tudo mais antigo que o prazo de guarda é apagado por `prune`.
 */
export class HistoryStore {
  private readonly stmt: {
    insertBatch: StatementSync;
    insertCheckpoint: StatementSync;
    insertStatus: StatementSync;
    checkpointAt: StatementSync;
    batchesBetween: StatementSync;
    statusAt: StatementSync;
    range: StatementSync;
  };

  private constructor(
    private readonly db: DatabaseSync,
    private readonly maxGapMs: number,
  ) {
    // Versão do formato: se mudar, o histórico antigo é descartado (é só um histórico recente)
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (version !== SCHEMA_VERSION) {
      db.exec(`DROP TABLE IF EXISTS batches; DROP TABLE IF EXISTS checkpoints;
        DROP TABLE IF EXISTS status; PRAGMA user_version = ${SCHEMA_VERSION};`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ops BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS batches_server_ts ON batches (server, ts);
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server TEXT NOT NULL,
        ts INTEGER NOT NULL,
        last_batch INTEGER NOT NULL,
        data BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS checkpoints_server_ts ON checkpoints (server, ts);
      CREATE TABLE IF NOT EXISTS status (
        server TEXT NOT NULL,
        ts INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS status_server_ts ON status (server, ts);
    `);
    this.stmt = {
      insertBatch: db.prepare('INSERT INTO batches (server, ts, ops) VALUES (?, ?, ?)'),
      insertCheckpoint: db.prepare(
        `INSERT INTO checkpoints (server, ts, last_batch, data)
         VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM batches), ?)`,
      ),
      insertStatus: db.prepare('INSERT INTO status (server, ts, status) VALUES (?, ?, ?)'),
      checkpointAt: db.prepare(
        `SELECT ts, last_batch, data FROM checkpoints
         WHERE server = ? AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1`,
      ),
      batchesBetween: db.prepare(
        `SELECT ops FROM batches WHERE server = ? AND id > ? AND ts <= ? ORDER BY id`,
      ),
      statusAt: db.prepare(
        `SELECT status FROM status WHERE server = ? AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT 1`,
      ),
      range: db.prepare(`SELECT MIN(ts) AS first FROM checkpoints WHERE server = ?`),
    };
  }

  /**
   * Abre (ou cria) o banco. `file` pode ser ":memory:" (testes).
   * `maxGapMs`: foto mais antiga que isso antes do horário pedido = o AstCall não estava
   * gravando naquele horário (desligado). Use um pouco mais que o dobro do intervalo das fotos.
   */
  static async open(file: string, options: { maxGapMs?: number } = {}): Promise<HistoryStore> {
    const { DatabaseSync } = await import('node:sqlite');
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    return new HistoryStore(db, options.maxGapMs ?? Number.POSITIVE_INFINITY);
  }

  close(): void {
    this.db.close();
  }

  /** Grava lotes de deltas (em ordem de horário) numa linha só. */
  addBatches(server: ServerId, batches: readonly { ts: number; ops: DeltaOp[] }[]): void {
    if (batches.length === 0) return;
    const entries: BatchEntry[] = batches.map((b) => [b.ts, b.ops]);
    this.stmt.insertBatch.run(server, batches[0]!.ts, pack(entries));
  }

  /**
   * Grava uma foto do estado. Os lotes pendentes devem ter sido gravados antes: a foto
   * considera incluídos todos os lotes já no banco.
   */
  addCheckpoint(server: ServerId, ts: number, snapshot: ServerSnapshot): void {
    this.stmt.insertCheckpoint.run(server, ts, pack(snapshot));
  }

  addStatus(server: ServerId, ts: number, status: ServerConnectionStatus): void {
    this.stmt.insertStatus.run(server, ts, status);
  }

  /**
   * Estado do servidor no horário `at` (ms). `null` se não houver foto até lá (antes do
   * início do histórico ou depois do prazo de guarda); `'gap'` se a última foto é antiga
   * demais — o AstCall estava desligado naquele horário e o estado guardado não vale mais.
   */
  stateAt(server: ServerId, at: number): HistoryState | 'gap' | null {
    const cp = this.stmt.checkpointAt.get(server, at) as
      { ts: number; last_batch: number; data: Uint8Array } | undefined;
    if (!cp) return null;
    if (at - cp.ts > this.maxGapMs) return 'gap';
    let snapshot = unpack<ServerSnapshot>(cp.data);
    // linhas que começam até `at`; dentro delas, só as alterações até `at`
    const rows = this.stmt.batchesBetween.all(server, cp.last_batch, at) as {
      ops: Uint8Array;
    }[];
    const ops = rows.flatMap((r) =>
      unpack<BatchEntry[]>(r.ops).flatMap(([ts, batch]) => (ts <= at ? batch : [])),
    );
    if (ops.length > 0) snapshot = applyOps(snapshot, ops);
    const st = this.stmt.statusAt.get(server, at) as { status: string } | undefined;
    return { snapshot, status: (st?.status as ServerConnectionStatus | undefined) ?? null };
  }

  /** Horário mais antigo disponível no histórico do servidor (null = vazio). */
  firstAt(server: ServerId): number | null {
    const row = this.stmt.range.get(server) as { first: number | null } | undefined;
    return row?.first ?? null;
  }

  /**
   * Apaga o que for anterior a `before` (ms). Mantém a última foto anterior ao corte de
   * cada servidor e os lotes posteriores a ela, para o horário do corte continuar
   * reconstruível.
   */
  prune(before: number): void {
    this.transaction(() => {
      const servers = this.db.prepare('SELECT DISTINCT server FROM checkpoints').all() as {
        server: string;
      }[];
      for (const { server } of servers) {
        const keep = this.stmt.checkpointAt.get(server, before) as
          { ts: number; last_batch: number } | undefined;
        if (!keep) continue;
        this.db.prepare('DELETE FROM checkpoints WHERE server = ? AND ts < ?').run(server, keep.ts);
        this.db
          .prepare('DELETE FROM batches WHERE server = ? AND id <= ?')
          .run(server, keep.last_batch);
        this.db.prepare('DELETE FROM status WHERE server = ? AND ts < ?').run(server, before);
      }
    });
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

const SCHEMA_VERSION = 1;

/** Estado reconstruído num horário e a situação da conexão com o PBX naquele momento. */
export interface HistoryState {
  snapshot: ServerSnapshot;
  status: ServerConnectionStatus | null;
}

/** Uma gravação de deltas: horário (ms) e as alterações daquele momento. */
type BatchEntry = [number, DeltaOp[]];

const pack = (value: unknown): Uint8Array => deflateRawSync(JSON.stringify(value));
const unpack = <T>(blob: Uint8Array): T => JSON.parse(inflateRawSync(blob).toString()) as T;
