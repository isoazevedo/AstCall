import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import type { ServerPermissions } from '@astcall/shared';
import { permsSchema } from './tokens.js';

/** Custo padrão do bcrypt (cada +1 dobra o tempo). bcryptjs é JS puro: 11 ≈ 0,2–0,4 s. */
const DEFAULT_BCRYPT_COST = 11;

export interface User {
  id: number;
  username: string;
  name: string;
  perms: ServerPermissions;
  active: boolean;
  createdAt: number;
}

interface UserRow {
  id: number;
  username: string;
  name: string;
  password_hash: string;
  perms: string;
  active: number;
  created_at: number;
}

/** Sessão de renovação recém-criada: o segredo vai para o cookie; no banco fica só o hash. */
export interface NewSession {
  secret: string;
  expiresAt: number;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Usuários e sessões do modo standalone, em SQLite (`node:sqlite`, nativo do Node 22).
 *
 * - Senhas: bcrypt.
 * - Sessões de renovação: segredo aleatório de 256 bits no cookie; no banco só o SHA-256.
 *   Cada renovação troca o segredo (rotação), invalidando o anterior.
 */
export class UserRepository {
  private readonly dummyHash: string;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly bcryptCost: number,
  ) {
    this.migrate();
    // Usado para gastar o mesmo tempo quando o usuário não existe (evita descobrir usuários)
    this.dummyHash = bcrypt.hashSync(randomBytes(16).toString('hex'), bcryptCost);
  }

  /**
   * Abre (ou cria) o banco. `file` pode ser ":memory:" (testes).
   * O módulo node:sqlite é carregado sob demanda.
   */
  static async open(file: string, options: { bcryptCost?: number } = {}): Promise<UserRepository> {
    const { DatabaseSync } = await import('node:sqlite');
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    return new UserRepository(db, options.bcryptCost ?? DEFAULT_BCRYPT_COST);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- usuários

  createUser(input: {
    username: string;
    name: string;
    password: string;
    perms: ServerPermissions;
  }): User {
    validatePassword(input.password);
    const perms = permsSchema.parse(input.perms);
    const now = Date.now();
    try {
      const result = this.db
        .prepare(
          'INSERT INTO users (username, name, password_hash, perms, active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
        )
        .run(
          input.username,
          input.name,
          bcrypt.hashSync(input.password, this.bcryptCost),
          JSON.stringify(perms),
          now,
        );
      return this.getById(Number(result.lastInsertRowid))!;
    } catch (err) {
      if (/UNIQUE/i.test((err as Error).message)) {
        throw new Error(`Usuário "${input.username}" já existe`, { cause: err });
      }
      throw err;
    }
  }

  getById(id: number): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  getByUsername(username: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  listUsers(): User[] {
    const rows = this.db
      .prepare('SELECT * FROM users ORDER BY username')
      .all() as unknown as UserRow[];
    return rows.map(toUser);
  }

  setPassword(username: string, password: string): void {
    validatePassword(password);
    const hash = bcrypt.hashSync(password, this.bcryptCost);
    this.mustChange(
      this.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username),
      username,
    );
    this.revokeSessionsOf(username); // troca de senha encerra as sessões abertas
  }

  setPerms(username: string, perms: ServerPermissions): void {
    const parsed = permsSchema.parse(perms);
    this.mustChange(
      this.db
        .prepare('UPDATE users SET perms = ? WHERE username = ?')
        .run(JSON.stringify(parsed), username),
      username,
    );
  }

  setActive(username: string, active: boolean): void {
    this.mustChange(
      this.db
        .prepare('UPDATE users SET active = ? WHERE username = ?')
        .run(active ? 1 : 0, username),
      username,
    );
    if (!active) this.revokeSessionsOf(username);
  }

  removeUser(username: string): void {
    this.mustChange(
      this.db.prepare('DELETE FROM users WHERE username = ?').run(username),
      username,
    );
  }

  /**
   * Confere usuário e senha. Retorna o usuário se válido e ativo; undefined caso contrário.
   * Sempre executa um bcrypt.compare, exista o usuário ou não (tempo constante).
   */
  verifyPassword(username: string, password: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      UserRow | undefined;
    const ok = bcrypt.compareSync(password, row?.password_hash ?? this.dummyHash);
    if (!row || !ok || !row.active) return undefined;
    return toUser(row);
  }

  // ---------------------------------------------------------------- sessões

  createSession(userId: number, ttlMs: number): NewSession {
    const secret = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = now + ttlMs;
    this.db
      .prepare(
        'INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(sha256(secret), userId, expiresAt, now);
    return { secret, expiresAt };
  }

  /**
   * Troca uma sessão válida por uma nova (rotação). Retorna o usuário e a nova sessão, ou
   * undefined se a sessão não existe, expirou ou o usuário foi desativado.
   */
  rotateSession(secret: string, ttlMs: number): { user: User; session: NewSession } | undefined {
    const hash = sha256(secret);
    const row = this.db
      .prepare('SELECT user_id, expires_at FROM sessions WHERE id_hash = ?')
      .get(hash) as { user_id: number; expires_at: number } | undefined;
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash);
    if (!row || row.expires_at < Date.now()) return undefined;
    const user = this.getById(row.user_id);
    if (!user?.active) return undefined;
    return { user, session: this.createSession(user.id, ttlMs) };
  }

  revokeSession(secret: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(secret));
  }

  /** Remove sessões expiradas (chamar periodicamente). */
  pruneSessions(): number {
    return Number(
      this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes,
    );
  }

  // ---------------------------------------------------------------- internos

  private revokeSessionsOf(username: string): void {
    this.db
      .prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)')
      .run(username);
  }

  private mustChange(result: { changes: number | bigint }, username: string): void {
    if (Number(result.changes) === 0) throw new Error(`Usuário "${username}" não encontrado`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY,
        username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        name          TEXT    NOT NULL,
        password_hash TEXT    NOT NULL,
        perms         TEXT    NOT NULL,          -- JSON: { "<servidor>|*": ["view", ...] }
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id_hash    TEXT    PRIMARY KEY,          -- SHA-256 do segredo do cookie
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    `);
  }
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    perms: permsSchema.parse(JSON.parse(row.perms)),
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

/** Regra mínima de senha (o usuário é um operador/supervisor de PBX). */
export function validatePassword(password: string): void {
  if (password.length < 10) throw new Error('A senha deve ter pelo menos 10 caracteres');
}
