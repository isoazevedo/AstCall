import type { Channel, EndpointQuality, VoiceQuality } from '@astcall/shared';
import type { Tone } from './view';

/**
 * Qualidade de voz no painel (sem Vue): faixas da nota MES, textos e o aviso de tronco com
 * qualidade degradada. A nota (0–100) vem do Asterisk, medida pelo backend a cada 10 s.
 */

export type QualityLevel = 'good' | 'fair' | 'poor';

/** Faixas: boa a partir de 80, regular de 60 a 79, ruim abaixo de 60. */
export function qualityLevel(mes: number): QualityLevel {
  return mes >= 80 ? 'good' : mes >= 60 ? 'fair' : 'poor';
}

const LEVEL: Record<QualityLevel, { label: string; tone: Tone }> = {
  good: { label: 'Voz boa', tone: 'success' },
  fair: { label: 'Voz regular', tone: 'warning' },
  poor: { label: 'Voz ruim', tone: 'danger' },
};

const num = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

/** Selo de uma medição: "Voz boa 86", tom e o detalhe para o title. */
export function qualityBadge(q: VoiceQuality): { label: string; tone: Tone; title: string } {
  const level = LEVEL[qualityLevel(q.mes)];
  const parts = [`nota ${Math.round(q.mes)} de 100`, `jitter ${num(q.jitterMs)} ms`];
  if (q.rttMs !== null) parts.push(`atraso ${q.rttMs} ms`);
  parts.push(`perda ${num(q.lossPct)}%`);
  return {
    label: `${level.label} ${Math.round(q.mes)}`,
    tone: level.tone,
    title: `Qualidade de voz: ${parts.join(' · ')}`,
  };
}

/** Qualidade de uma chamada: a do pior canal em conversa que tem medição. */
export function callQuality(
  channelIds: readonly string[],
  channels: Record<string, Channel>,
): VoiceQuality | null {
  let worst: VoiceQuality | null = null;
  for (const id of channelIds) {
    const q = channels[id]?.quality;
    if (q && (!worst || q.mes < worst.mes)) worst = q;
  }
  return worst;
}

/** Tempo com a qualidade abaixo do limite para o painel avisar (2 min). */
export const DEGRADED_ALERT_MS = 2 * 60_000;

export interface DegradedItem {
  id: string;
  mes: number;
  channels: number;
  since: number;
}

/** Troncos com a média abaixo do limite há pelo menos `DEGRADED_ALERT_MS`, piores primeiro. */
export function degradedTrunks(
  endpoints: readonly { id: string; trunk: boolean; quality: EndpointQuality | null }[],
  now: number,
): DegradedItem[] {
  return endpoints
    .filter((e) => e.trunk && e.quality?.degradedSince != null)
    .filter((e) => now - e.quality!.degradedSince! >= DEGRADED_ALERT_MS)
    .map((e) => ({
      id: e.id,
      mes: e.quality!.mes,
      channels: e.quality!.channels,
      since: e.quality!.degradedSince!,
    }))
    .sort((a, b) => a.mes - b.mes);
}
