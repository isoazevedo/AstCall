import { forecastView } from './forecast';
import type { EndpointView, QueueMemberView, QueueView } from './view';

/**
 * Copiloto do supervisor (sem Vue): olha as filas, a previsão e os ramais e sugere ações que
 * o painel já sabe fazer — sempre com confirmação. Regras:
 *
 * 1. Fila em risco (abaixo da meta, vai estourar, ou gente esperando sem atendente livre):
 *    - "Retomar" atendentes pausados nessa fila (quem está em pausa há mais tempo primeiro);
 *    - "Adicionar" ramais livres que não são da fila (quantos faltarem, até 2);
 *    - sem nada a sugerir (ou sem permissão), um aviso sem ação.
 * 2. Pausa longa (padrão 30 min), mesmo sem risco — exceto motivos ignorados (ex.: Treinamento).
 *
 * Só sugere o que o usuário pode fazer: "Retomar" exige `queue`; "Adicionar", `queue_manage`.
 */

export interface CopilotPrefs {
  /** Avisar pausas a partir de N minutos (0 = não avisa). */
  longPauseMin: number;
  /** Motivos de pausa que não geram aviso de pausa longa (sem diferenciar maiúsculas). */
  ignoreReasons: string[];
}

export const DEFAULT_COPILOT_PREFS: CopilotPrefs = { longPauseMin: 30, ignoreReasons: [] };

export const COPILOT_PREFS_KEY = 'astcall.copiloto';

/** Por quanto tempo "Dispensar" esconde uma sugestão. */
export const DISMISS_MS = 10 * 60_000;

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Preferências salvas no navegador (completadas com o padrão). */
export function loadCopilotPrefs(storage = defaultStorage()): CopilotPrefs {
  try {
    const raw = storage?.getItem(COPILOT_PREFS_KEY);
    if (!raw) return { ...DEFAULT_COPILOT_PREFS, ignoreReasons: [] };
    const p = JSON.parse(raw) as Partial<CopilotPrefs>;
    return {
      longPauseMin:
        typeof p.longPauseMin === 'number' && Number.isFinite(p.longPauseMin) && p.longPauseMin >= 0
          ? Math.floor(p.longPauseMin)
          : DEFAULT_COPILOT_PREFS.longPauseMin,
      ignoreReasons: Array.isArray(p.ignoreReasons)
        ? p.ignoreReasons.filter((r): r is string => typeof r === 'string')
        : [],
    };
  } catch {
    return { ...DEFAULT_COPILOT_PREFS, ignoreReasons: [] };
  }
}

export function saveCopilotPrefs(prefs: CopilotPrefs, storage = defaultStorage()): void {
  try {
    storage?.setItem(COPILOT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // sem armazenamento: vale até recarregar
  }
}

export type SuggestionAction =
  | { kind: 'resume'; queue: string; interface: string; label: string }
  | { kind: 'add'; queue: string; endpoint: string; members: string[] };

export interface Suggestion {
  /** Identificador estável (para dispensar e para o Vue não recriar a linha). */
  id: string;
  severity: 'high' | 'warn' | 'info';
  title: string;
  detail: string;
  action: SuggestionAction | null;
  /** Texto do botão da ação. */
  actionLabel: string | null;
}

export interface CopilotInput {
  queues: QueueView[];
  endpoints: EndpointView[];
  /** O que o usuário pode fazer (permissões no servidor). */
  can: { queue: boolean; manage: boolean };
  prefs: CopilotPrefs;
  /** Sugestões dispensadas: id → até quando (ms). */
  dismissed: ReadonlyMap<string, number>;
  now: number;
}

const ORDER = { high: 0, warn: 1, info: 2 } as const;

/** Minutos inteiros desde `since`. */
const minutes = (since: number | null, now: number) =>
  since === null ? 0 : Math.floor((now - since) / 60_000);

const pauseText = (m: QueueMemberView, now: number) => {
  const min = minutes(m.pausedSince, now);
  const reason = m.pausedReason ? ` (${m.pausedReason})` : '';
  if (m.pausedSince === null) return `Em pausa${reason}.`;
  return min < 1 ? `Em pausa há menos de 1 min${reason}.` : `Em pausa há ${min} min${reason}.`;
};

export function suggestions(input: CopilotInput): Suggestion[] {
  const { queues, endpoints, can, prefs, dismissed, now } = input;
  if (!can.queue && !can.manage) return [];
  const out: Suggestion[] = [];
  const resumed = new Set<string>(); // interfaces já sugeridas para retomar
  const offered = new Set<string>(); // ramais livres já sugeridos (cada um para uma fila só)
  // Quem está em pausa em alguma fila não conta como livre (o aparelho fica ocioso na pausa)
  for (const q of queues)
    for (const m of q.members) if (m.paused && m.endpointId) offered.add(m.endpointId);

  // Filas em risco, as mais graves primeiro (recebem os ramais livres antes)
  const atRisk: { q: QueueView; severity: 'high' | 'warn' }[] = [];
  for (const q of queues) {
    const noAgent = q.waiting.length > 0 && q.available === 0;
    const risk = q.forecast?.risk;
    if (noAgent || risk === 'high') atRisk.push({ q, severity: 'high' });
    else if (risk === 'warn') atRisk.push({ q, severity: 'warn' });
  }
  atRisk.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);

  for (const { q, severity } of atRisk) {
    const f = q.forecast;
    const v = f ? forecastView(f) : null;
    const why =
      v && v.slText
        ? `${v.riskLabel}: ${v.slText.toLowerCase()}`
        : `${q.waiting.length} aguardando e nenhum atendente livre`;
    let suggested = 0;

    // 1a. Retomar quem está pausado nesta fila (há mais tempo primeiro)
    if (can.queue) {
      const paused = q.members
        .filter((m) => m.paused && m.rank !== 3)
        .sort((a, b) => (a.pausedSince ?? now) - (b.pausedSince ?? now))
        .slice(0, 2);
      for (const m of paused) {
        out.push({
          id: `resume|${q.name}|${m.interface}`,
          severity,
          title: `Retomar ${m.label} na fila ${q.name}`,
          detail: `${why}. ${pauseText(m, now)}`,
          action: { kind: 'resume', queue: q.name, interface: m.interface, label: m.label },
          actionLabel: 'Retomar',
        });
        resumed.add(m.interface);
        suggested++;
      }
    }

    // 1b. Adicionar ramais livres que não são da fila (quantos faltarem, até 2)
    if (can.manage) {
      const members = q.members.map((m) => m.endpointId).filter((e): e is string => !!e);
      const inQueue = new Set(members);
      const wanted = Math.min(2, Math.max(1, v?.missing ?? 0));
      const free = endpoints
        .filter((e) => e.group === 'free' && !e.trunk && !inQueue.has(e.id) && !offered.has(e.id))
        .slice(0, wanted);
      for (const e of free) {
        offered.add(e.id);
        out.push({
          id: `add|${q.name}|${e.id}`,
          severity,
          title: `Adicionar o ramal ${e.id} à fila ${q.name}`,
          detail: `${why}. O ramal ${e.id} está livre e não é membro da fila.`,
          action: { kind: 'add', queue: q.name, endpoint: e.id, members },
          actionLabel: 'Adicionar',
        });
        suggested++;
      }
    }

    // 1c. Nada a sugerir: ao menos avisa
    if (suggested === 0) {
      out.push({
        id: `risk|${q.name}`,
        severity,
        title: `Fila ${q.name}: ${v?.riskLabel.toLowerCase() ?? 'sem atendente livre'}`,
        detail: `${why}. Nenhum atendente pausado ou ramal livre para sugerir.`,
        action: null,
        actionLabel: null,
      });
    }
  }

  // 2. Pausas longas (mesmo sem risco), uma por atendente
  if (can.queue && prefs.longPauseMin > 0) {
    const ignore = new Set(prefs.ignoreReasons.map((r) => r.trim().toLowerCase()).filter(Boolean));
    for (const q of queues) {
      for (const m of q.members) {
        if (!m.paused || m.rank === 3 || m.pausedSince === null || resumed.has(m.interface))
          continue;
        if (minutes(m.pausedSince, now) < prefs.longPauseMin) continue;
        if (ignore.has(m.pausedReason.trim().toLowerCase())) continue;
        resumed.add(m.interface);
        out.push({
          id: `long|${m.interface}`,
          severity: 'info',
          title: `${m.label} em pausa há ${minutes(m.pausedSince, now)} min`,
          detail: `Motivo: ${m.pausedReason || 'sem motivo'} · fila ${q.name}.`,
          action: { kind: 'resume', queue: q.name, interface: m.interface, label: m.label },
          actionLabel: 'Retomar',
        });
      }
    }
  }

  return out
    .filter((s) => (dismissed.get(s.id) ?? 0) <= now)
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
