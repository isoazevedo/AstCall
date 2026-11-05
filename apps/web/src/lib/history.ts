/**
 * Funções da barra de histórico (máquina do tempo), sem Vue — testadas sem navegador.
 */

/** Passos dos botões de avanço/retrocesso (minutos). */
export const HISTORY_STEPS_MIN = [-15, -5, -1, 1, 5] as const;

/** Ao abrir o histórico, começa este tanto antes de agora. */
export const HISTORY_START_OFFSET_MS = 5 * 60_000;

/**
 * Mantém o horário dentro do que dá para rever: entre o início do histórico (`from`, se já
 * conhecido) e agora. Arredonda para o segundo.
 */
export function clampAt(at: number, from: number | null, now: number): number {
  const max = Math.floor(now / 1000) * 1000;
  const min = from ?? Number.NEGATIVE_INFINITY;
  return Math.max(min, Math.min(max, Math.round(at / 1000) * 1000));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "14:32:10" para hoje; "ontem 14:32:10"; "01/11 14:32:10" nos outros dias. */
export function formatAt(at: number, now: number): string {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return time;
  if (day(at) === day(now - 86_400_000)) return `ontem ${time}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`;
}

/** Valor para <input type="datetime-local"> (horário local, até os segundos). */
export function toLocalInput(at: number): string {
  const d = new Date(at);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Lê o valor de um <input type="datetime-local">; null se vazio ou inválido. */
export function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Texto do botão de passo: "−15 min", "+1 min". */
export function stepLabel(min: number): string {
  return `${min < 0 ? '−' : '+'}${Math.abs(min)} min`;
}
