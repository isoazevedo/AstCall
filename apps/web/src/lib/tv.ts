import type { QueueView } from './view';

/**
 * Lógica do modo TV (wallboard), sem Vue: telas, rodízio e preferências salvas.
 * Fica fora dos componentes para ser testada sem navegador.
 */

/** Telas do modo TV, na ordem do rodízio. */
export type TvScreen = 'queues' | 'calls';
export const TV_SCREENS: readonly TvScreen[] = ['queues', 'calls'];

export const TV_SCREEN_LABEL: Record<TvScreen, string> = {
  queues: 'Filas',
  calls: 'Chamadas',
};

/** Intervalo padrão do rodízio (segundos) e limites aceitos no atributo `rotate`. */
export const TV_ROTATE_DEFAULT_S = 15;
const ROTATE_MIN_S = 5;
const ROTATE_MAX_S = 600;

/**
 * Lê o atributo `rotate` (vem como texto do HTML). Vazio → padrão; "0" → rodízio começa
 * desligado (mantém o intervalo padrão para quando o usuário ligar).
 */
export function parseRotate(value: string | number | undefined): {
  seconds: number;
  enabled: boolean;
} {
  if (value === undefined || value === '') return { seconds: TV_ROTATE_DEFAULT_S, enabled: true };
  const n = Number(value);
  if (!Number.isFinite(n)) return { seconds: TV_ROTATE_DEFAULT_S, enabled: true };
  if (n <= 0) return { seconds: TV_ROTATE_DEFAULT_S, enabled: false };
  return { seconds: Math.min(ROTATE_MAX_S, Math.max(ROTATE_MIN_S, Math.round(n))), enabled: true };
}

/** Próxima tela do rodízio, considerando só as telas disponíveis. */
export function nextScreen(available: readonly TvScreen[], current: TvScreen): TvScreen {
  if (available.length === 0) return current;
  const i = available.indexOf(current);
  return available[(i + 1) % available.length]!;
}

// ------------------------------------------------------------------ preferências

/** O que o modo TV lembra entre recargas (por navegador). */
export interface TvPrefs {
  rotate: boolean;
  screen: TvScreen;
}

export const TV_PREFS_KEY = 'astcall.tv';

/** Subconjunto do localStorage usado aqui (permite testar com um objeto simples). */
type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // navegação privada / armazenamento bloqueado
  }
}

/** Lê as preferências salvas, completando o que faltar com `fallback`. */
export function loadTvPrefs(fallback: TvPrefs, storage = defaultStorage()): TvPrefs {
  try {
    const raw = storage?.getItem(TV_PREFS_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<TvPrefs>;
    return {
      rotate: typeof saved.rotate === 'boolean' ? saved.rotate : fallback.rotate,
      screen: TV_SCREENS.includes(saved.screen as TvScreen)
        ? (saved.screen as TvScreen)
        : fallback.screen,
    };
  } catch {
    return fallback;
  }
}

export function saveTvPrefs(prefs: TvPrefs, storage = defaultStorage()): void {
  try {
    storage?.setItem(TV_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // sem armazenamento: a preferência vale só até recarregar
  }
}

// ------------------------------------------------------------------ dados

/** Entrada mais antiga ainda aguardando na fila (ms), ou null se ninguém aguarda. */
export function oldestWaitingSince(q: QueueView): number | null {
  if (q.waiting.length === 0) return null;
  return Math.min(...q.waiting.map((e) => e.joinedAt));
}

/** Percentual de abandono (0–100) das chamadas encerradas na fila. */
export function abandonRate(q: QueueView): number {
  const total = q.completed + q.abandoned;
  return total === 0 ? 0 : (q.abandoned / total) * 100;
}
