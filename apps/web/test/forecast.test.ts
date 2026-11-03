import { describe, expect, it } from 'vitest';
import type { QueueForecast } from '@astcall/shared';
import { etaText, forecastView } from '../src/lib/forecast';

const base: QueueForecast = {
  queue: 'suporte',
  status: 'ok',
  windowMin: 15,
  arrivalsPerMin: 2.4,
  ahtSec: 92,
  ahtEstimated: false,
  agentsAvailable: 3,
  agentsNeeded: 6,
  slForecast: 0,
  slTarget: 80,
  slSeconds: 20,
  trend: 'up',
  risk: 'high',
  etaAt: {},
};

describe('forecastView', () => {
  it('fila que vai estourar: selo vermelho, previsão e atendentes faltando', () => {
    const v = forecastView(base);
    expect(v).toMatchObject({
      riskLabel: 'Vai estourar',
      tone: 'danger',
      slText: 'Previsto 0% · meta 80% em 20 s',
      shortage: 'Precisa de 6 atendentes, tem 3',
      missing: 3,
      arrivals: '2,4 chamadas/min',
      aht: '1:32',
      note: null,
    });
  });

  it('dentro da meta: sem aviso de falta de atendentes', () => {
    const v = forecastView({ ...base, risk: 'ok', slForecast: 96, agentsNeeded: 2 });
    expect(v).toMatchObject({
      riskLabel: 'Dentro da meta',
      tone: 'success',
      shortage: null,
      missing: 0,
    });
  });

  it('sem movimento ou coletando dados: sem número e com o aviso', () => {
    const idle = forecastView({
      ...base,
      status: 'idle',
      risk: 'ok',
      arrivalsPerMin: 0,
      slForecast: null,
      agentsNeeded: null,
    });
    expect(idle.slText).toBeNull();
    expect(idle).toMatchObject({ riskLabel: 'Sem movimento', tone: 'secondary' });
    expect(idle.note).toBe('Sem entradas nos últimos 15 min.');
    expect(forecastView({ ...base, status: 'warming' }).note).toMatch(/Coletando dados/);
  });
});

it('tempo médio padrão aparece como estimativa inicial', () => {
  expect(forecastView({ ...base, ahtSec: 180, ahtEstimated: true }).aht).toBe(
    '3:00 (estimativa inicial)',
  );
});

describe('etaText', () => {
  const now = 1_000_000;
  it('agora, minutos aproximados ou sem estimativa', () => {
    expect(etaText(undefined, now)).toBeNull();
    expect(etaText(now + 10_000, now)).toBe('agora');
    expect(etaText(now + 50_000, now)).toBe('~1 min');
    expect(etaText(now + 4 * 60_000, now)).toBe('~4 min');
  });
});
