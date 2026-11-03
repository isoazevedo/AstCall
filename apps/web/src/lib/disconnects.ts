import type { EndpointView } from './view';

/**
 * Alertas de desconexão (sem Vue): quem está fora do ar, se já passou a tolerância e quantos
 * alertas cada um já deveria ter recebido. Fica fora dos componentes para ser testado.
 *
 * Regras:
 * - só gera alerta a queda que o backend viu acontecer (`offlineSince` preenchido): um aparelho
 *   que já estava offline quando o monitoramento começou aparece na lista, mas sem alerta;
 * - a queda só conta depois da tolerância (ex.: 30 s), para quedas rápidas não alarmarem;
 * - enquanto continuar fora, o alerta se repete a cada `repeatMin` minutos (0 = só uma vez).
 */

export interface AlertPrefs {
  enabled: boolean;
  sound: boolean;
  /** Notificação do navegador (aparece mesmo com a aba em segundo plano). */
  notify: boolean;
  /** Repetir o alerta a cada N minutos enquanto continuar offline (0 = não repetir). */
  repeatMin: number;
  /** Tolerância (s): quedas mais curtas que isso não geram alerta. */
  graceSec: number;
  /** Endpoints vigiados; null = todos. */
  watch: string[] | null;
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  enabled: false,
  sound: true,
  notify: false,
  repeatMin: 2,
  graceSec: 30,
  watch: null,
};

export const ALERT_PREFS_KEY = 'astcall.alertas';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Preferências salvas no navegador (completadas com o padrão). */
export function loadAlertPrefs(storage = defaultStorage()): AlertPrefs {
  try {
    const raw = storage?.getItem(ALERT_PREFS_KEY);
    if (!raw) return { ...DEFAULT_ALERT_PREFS };
    const p = JSON.parse(raw) as Partial<AlertPrefs>;
    const num = (v: unknown, def: number) =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : def;
    return {
      enabled: p.enabled === true,
      sound: p.sound !== false,
      notify: p.notify === true,
      repeatMin: num(p.repeatMin, DEFAULT_ALERT_PREFS.repeatMin),
      graceSec: num(p.graceSec, DEFAULT_ALERT_PREFS.graceSec),
      watch: Array.isArray(p.watch) ? p.watch.filter((x) => typeof x === 'string') : null,
    };
  } catch {
    return { ...DEFAULT_ALERT_PREFS };
  }
}

export function saveAlertPrefs(prefs: AlertPrefs, storage = defaultStorage()): void {
  try {
    storage?.setItem(ALERT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // sem armazenamento: vale até recarregar
  }
}

/** Um endpoint fora do ar, como a tela mostra. */
export interface DownItem {
  id: string;
  trunk: boolean;
  /** Desde quando (ms); null = já estava offline quando o monitoramento começou. */
  since: number | null;
  /** Passou da tolerância e é vigiado: gera alerta. */
  alerting: boolean;
  /** Quantos alertas já deveriam ter tocado (0 enquanto não alerta). */
  alertCount: number;
}

export function isWatched(prefs: AlertPrefs, id: string): boolean {
  return prefs.watch === null || prefs.watch.includes(id);
}

/** Lista dos endpoints vigiados fora do ar, com a situação de alerta de cada um. */
export function downItems(endpoints: EndpointView[], prefs: AlertPrefs, now: number): DownItem[] {
  const graceMs = prefs.graceSec * 1000;
  const repeatMs = prefs.repeatMin * 60_000;
  const items: DownItem[] = [];
  for (const e of endpoints) {
    if (e.group !== 'offline' || !isWatched(prefs, e.id)) continue;
    const since = e.offlineSince;
    const elapsed = since === null ? -1 : now - since;
    const alerting = since !== null && elapsed >= graceMs;
    const alertCount = !alerting
      ? 0
      : repeatMs > 0
        ? 1 + Math.floor((elapsed - graceMs) / repeatMs)
        : 1;
    items.push({ id: e.id, trunk: e.trunk, since, alerting, alertCount });
  }
  // Troncos primeiro (a operação fica sem ligar para fora), depois a queda mais antiga
  return items.sort(
    (a, b) =>
      Number(b.trunk) - Number(a.trunk) ||
      Number(b.alerting) - Number(a.alerting) ||
      (a.since ?? Infinity) - (b.since ?? Infinity) ||
      a.id.localeCompare(b.id, 'pt-BR', { numeric: true }),
  );
}

/**
 * Quais itens precisam de alerta agora: o número de alertas devidos subiu desde o último
 * disparo. `fired` guarda, por endpoint, quantos já tocaram (é atualizado aqui).
 * Na primeira vez (`init`), só registra o que já estava devido, sem disparar — recarregar a
 * página não repete alertas antigos.
 */
export function dueAlerts(items: DownItem[], fired: Map<string, number>, init = false): DownItem[] {
  const due: DownItem[] = [];
  const present = new Set<string>();
  for (const it of items) {
    present.add(it.id);
    const last = fired.get(it.id) ?? 0;
    if (it.alertCount > last) {
      if (!init) due.push(it);
      fired.set(it.id, it.alertCount);
    }
  }
  // voltou ao ar (ou saiu da lista vigiada): a próxima queda começa do zero
  for (const id of [...fired.keys()]) if (!present.has(id)) fired.delete(id);
  return due;
}

/** "agora", "há 3 min", "há 2 h 05 min". */
export function sinceText(since: number | null, now: number): string {
  if (since === null) return 'desde antes do monitoramento';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return 'há menos de 1 min';
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  return `há ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
