/**
 * Limite de tentativas falhas por chave (ex.: IP e usuário) numa janela de tempo.
 * Em memória: suficiente para uma instância; com várias instâncias, mover para o Redis.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60_000,
  ) {}

  /** Segundos até liberar, se alguma das chaves estiver bloqueada; 0 se liberado. */
  blockedFor(keys: string[], now = Date.now()): number {
    let wait = 0;
    for (const key of keys) {
      const entry = this.hits.get(key);
      if (!entry) continue;
      if (entry.resetAt <= now) {
        this.hits.delete(key);
        continue;
      }
      if (entry.count >= this.maxFailures) wait = Math.max(wait, entry.resetAt - now);
    }
    return Math.ceil(wait / 1000);
  }

  fail(keys: string[], now = Date.now()): void {
    for (const key of keys) {
      const entry = this.hits.get(key);
      if (!entry || entry.resetAt <= now)
        this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      else entry.count++;
    }
  }

  reset(keys: string[]): void {
    for (const key of keys) this.hits.delete(key);
  }
}
