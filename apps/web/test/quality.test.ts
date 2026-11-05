import { describe, expect, it } from 'vitest';
import type { Channel, EndpointQuality, VoiceQuality } from '@astcall/shared';
import {
  callQuality,
  DEGRADED_ALERT_MS,
  degradedTrunks,
  qualityBadge,
  qualityLevel,
} from '../src/lib/quality';

const q = (mes: number, extra: Partial<VoiceQuality> = {}): VoiceQuality => ({
  mes,
  jitterMs: 19.5,
  rttMs: 140,
  lossPct: 0.1,
  updatedAt: 0,
  ...extra,
});

describe('faixas da nota', () => {
  it('boa a partir de 80, regular de 60 a 79, ruim abaixo de 60', () => {
    expect([80, 79.9, 60, 59.9].map(qualityLevel)).toEqual(['good', 'fair', 'fair', 'poor']);
  });
});

describe('qualityBadge', () => {
  it('selo com a nota e o detalhe em português', () => {
    expect(qualityBadge(q(86.3))).toEqual({
      label: 'Voz boa 86',
      tone: 'success',
      title: 'Qualidade de voz: nota 86 de 100 · jitter 19,5 ms · atraso 140 ms · perda 0,1%',
    });
    expect(qualityBadge(q(48, { rttMs: null })).title).not.toContain('atraso');
    expect(qualityBadge(q(72)).tone).toBe('warning');
  });
});

describe('callQuality', () => {
  it('a pior medição entre os canais da chamada', () => {
    const channels = {
      a: { quality: q(86) },
      b: { quality: q(64) },
      c: { quality: null },
    } as unknown as Record<string, Channel>;
    expect(callQuality(['a', 'b', 'c'], channels)?.mes).toBe(64);
    expect(callQuality(['c', 'x'], channels)).toBeNull();
  });
});

describe('degradedTrunks', () => {
  const eq = (mes: number, degradedSince: number | null): EndpointQuality => ({
    mes,
    channels: 2,
    degradedSince,
    updatedAt: 0,
  });
  it('só troncos abaixo do limite há 2 min ou mais, piores primeiro', () => {
    const now = 1_000_000;
    const list = degradedTrunks(
      [
        { id: 'operadora', trunk: true, quality: eq(62, now - DEGRADED_ALERT_MS) },
        { id: 'backup', trunk: true, quality: eq(40, now - 5 * 60_000) },
        { id: 'recente', trunk: true, quality: eq(50, now - 60_000) }, // há 1 min: ainda não
        { id: '2001', trunk: false, quality: eq(30, now - 10 * 60_000) }, // ramal: não
        { id: 'ok', trunk: true, quality: eq(85, null) },
      ],
      now,
    );
    expect(list.map((d) => d.id)).toEqual(['backup', 'operadora']);
  });
});
