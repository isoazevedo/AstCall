import type { QueueForecast } from '@astcall/shared';
import { formatDuration, type Tone } from './view';

/**
 * Textos e cores da previsão de fila (sem Vue), a partir do `queueForecast` que o backend
 * calcula. Fica fora dos componentes para ser testado e reaproveitado (card, modo TV).
 */

export interface ForecastView {
  /** Selo de situação: "Dentro da meta", "Abaixo da meta", "Vai estourar". */
  riskLabel: string;
  tone: Tone;
  /** "Previsto 62% · meta 80% em 20 s" ou null sem previsão numérica. */
  slText: string | null;
  /** "Precisa de 5 atendentes, tem 3" (só quando faltam) ou null. */
  shortage: string | null;
  /** Atendentes faltando para a meta (0 = suficiente). */
  missing: number;
  /** "2,4 chamadas/min" e a tendência. */
  arrivals: string;
  trend: QueueForecast['trend'];
  /** Tempo médio de atendimento formatado ("1:32") ou null. */
  aht: string | null;
  /** Aviso quando a previsão ainda não é confiável. */
  note: string | null;
}

const RISK: Record<QueueForecast['risk'], { label: string; tone: Tone }> = {
  ok: { label: 'Dentro da meta', tone: 'success' },
  warn: { label: 'Abaixo da meta', tone: 'warning' },
  high: { label: 'Vai estourar', tone: 'danger' },
};

export function forecastView(f: QueueForecast): ForecastView {
  // Sem previsão calculada (fila sem entradas) e nada em risco: não há meta a cumprir agora
  const r =
    f.slForecast === null && f.risk === 'ok'
      ? { label: 'Sem movimento', tone: 'secondary' as Tone }
      : RISK[f.risk];
  const missing = f.agentsNeeded === null ? 0 : Math.max(0, f.agentsNeeded - f.agentsAvailable);
  const per = f.arrivalsPerMin.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  return {
    riskLabel: r.label,
    tone: r.tone,
    slText:
      f.slForecast === null
        ? null
        : `Previsto ${f.slForecast}% · meta ${f.slTarget}% em ${f.slSeconds} s`,
    shortage:
      missing > 0
        ? `Precisa de ${f.agentsNeeded} ${f.agentsNeeded === 1 ? 'atendente' : 'atendentes'}, tem ${f.agentsAvailable}`
        : null,
    missing,
    arrivals: `${per} ${f.arrivalsPerMin === 1 ? 'chamada' : 'chamadas'}/min`,
    trend: f.trend,
    aht:
      f.ahtSec === null
        ? null
        : `${formatDuration(f.ahtSec)}${f.ahtEstimated ? ' (estimativa inicial)' : ''}`,
    note:
      f.status === 'warming'
        ? 'Coletando dados desde o início do monitoramento: a previsão fica mais precisa nos próximos minutos.'
        : f.status === 'idle'
          ? `Sem entradas nos últimos ${f.windowMin} min.`
          : null,
  };
}

/** Previsão de atendimento de um chamador: "agora", "~1 min", "~4 min"; null sem estimativa. */
export function etaText(etaAt: number | undefined, now: number): string | null {
  if (etaAt === undefined) return null;
  const s = (etaAt - now) / 1000;
  if (s <= 15) return 'agora';
  const min = Math.max(1, Math.round(s / 60));
  return `~${min} min`;
}
