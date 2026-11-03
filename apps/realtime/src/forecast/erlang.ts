/**
 * Erlang C — o modelo clássico de dimensionamento de call center (fila M/M/N).
 *
 * Entradas:
 * - `traffic` (A): carga em erlangs = ritmo de entrada (chamadas/s) × tempo médio de
 *   atendimento (s). Ex.: 2 chamadas/min com atendimento de 3 min → A = 6;
 * - `agents` (N): atendentes disponíveis para atender.
 *
 * Se N ≤ A, a fila cresce sem parar (o sistema não dá conta): a chance de esperar é 100%.
 */

/** Probabilidade de um chamador ter de esperar (0..1). */
export function erlangC(agents: number, traffic: number): number {
  if (agents <= 0) return 1;
  if (traffic <= 0) return 0;
  if (agents <= traffic) return 1;
  // Erlang B pela recorrência (numericamente estável, sem fatoriais grandes)
  let b = 1;
  for (let k = 1; k <= agents; k++) b = (traffic * b) / (k + traffic * b);
  return (agents * b) / (agents - traffic * (1 - b));
}

/**
 * Nível de serviço previsto (0..1): fração dos chamadores atendidos em até `targetSec`.
 * SL = 1 − C(N, A) · e^(−(N − A) · t / AHT)
 */
export function serviceLevel(
  agents: number,
  traffic: number,
  ahtSec: number,
  targetSec: number,
): number {
  if (traffic <= 0) return 1;
  if (agents <= traffic || ahtSec <= 0) return 0;
  const c = erlangC(agents, traffic);
  return Math.min(1, Math.max(0, 1 - c * Math.exp((-(agents - traffic) * targetSec) / ahtSec)));
}

/** Menor número de atendentes que atinge a meta (`targetSl` em 0..1). */
export function agentsNeeded(
  traffic: number,
  ahtSec: number,
  targetSec: number,
  targetSl: number,
  max = 1000,
): number {
  if (traffic <= 0) return 0;
  for (let n = Math.max(1, Math.floor(traffic) + 1); n <= max; n++) {
    if (serviceLevel(n, traffic, ahtSec, targetSec) >= targetSl) return n;
  }
  return max;
}
