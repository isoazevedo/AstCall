import { describe, expect, it } from 'vitest';
import {
  ALERT_PREFS_KEY,
  DEFAULT_ALERT_PREFS,
  downItems,
  dueAlerts,
  loadAlertPrefs,
  saveAlertPrefs,
  sinceText,
  type AlertPrefs,
} from '../src/lib/disconnects';
import type { EndpointView } from '../src/lib/view';

const NOW = 1_000_000_000_000;
const MIN = 60_000;

const ep = (id: string, extra: Partial<EndpointView> = {}): EndpointView => ({
  id,
  label: 'Indisponível',
  tone: 'secondary',
  group: 'offline',
  userAgent: null,
  address: null,
  activeChannels: 0,
  trunk: false,
  offlineSince: null,
  quality: null,
  ...extra,
});

const prefs = (p: Partial<AlertPrefs> = {}): AlertPrefs => ({
  ...DEFAULT_ALERT_PREFS,
  enabled: true,
  ...p,
});

describe('downItems', () => {
  it('só alerta a queda vista pelo backend e depois da tolerância', () => {
    const items = downItems(
      [
        ep('2001', { offlineSince: NOW - 10_000 }), // caiu há 10 s: dentro da tolerância
        ep('2002', { offlineSince: NOW - 31_000 }), // caiu há 31 s: alerta
        ep('2003'), // já estava offline ao iniciar: sem alerta
        ep('2004', { group: 'free' }), // online: fora da lista
      ],
      prefs(),
      NOW,
    );
    expect(items.map((i) => [i.id, i.alerting, i.alertCount])).toEqual([
      ['2002', true, 1],
      ['2001', false, 0],
      ['2003', false, 0],
    ]);
  });

  it('repete a cada N minutos (0 = uma vez só)', () => {
    const down = [ep('2001', { offlineSince: NOW - 30_000 - 5 * MIN })];
    expect(downItems(down, prefs({ repeatMin: 2 }), NOW)[0]!.alertCount).toBe(3); // 0, 2, 4 min
    expect(downItems(down, prefs({ repeatMin: 0 }), NOW)[0]!.alertCount).toBe(1);
  });

  it('troncos primeiro e respeita a lista de vigiados', () => {
    const list = [
      ep('2001', { offlineSince: NOW - 5 * MIN }),
      ep('operadora', { trunk: true, offlineSince: NOW - MIN }),
      ep('2002', { offlineSince: NOW - 2 * MIN }),
    ];
    expect(downItems(list, prefs(), NOW).map((i) => i.id)).toEqual(['operadora', '2001', '2002']);
    expect(downItems(list, prefs({ watch: ['2002'] }), NOW).map((i) => i.id)).toEqual(['2002']);
  });
});

describe('dueAlerts', () => {
  it('dispara quando o número de alertas devidos sobe; ao carregar não repete os antigos', () => {
    const fired = new Map<string, number>();
    const at = (min: number) =>
      downItems(
        [ep('2001', { offlineSince: NOW - 30_000 })],
        prefs({ repeatMin: 2 }),
        NOW + min * MIN,
      );
    // página aberta com o ramal já caído há tempos: registra sem disparar
    expect(dueAlerts(at(3), fired, true)).toEqual([]);
    expect(dueAlerts(at(3.5), fired).map((i) => i.alertCount)).toEqual([]);
    expect(dueAlerts(at(4), fired).map((i) => i.alertCount)).toEqual([3]);
  });

  it('nova queda depois de voltar ao ar começa do zero', () => {
    const fired = new Map<string, number>();
    const down = (since: number) => downItems([ep('2001', { offlineSince: since })], prefs(), NOW);
    expect(dueAlerts(down(NOW - MIN), fired)).toHaveLength(1);
    expect(dueAlerts([], fired)).toEqual([]); // voltou
    expect(dueAlerts(down(NOW - 40_000), fired)).toHaveLength(1); // caiu de novo
  });
});

describe('preferências e textos', () => {
  it('salva e lê; valores inválidos voltam ao padrão', () => {
    const data: Record<string, string> = {};
    const st = {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => void (data[k] = v),
    };
    saveAlertPrefs(prefs({ repeatMin: 5, watch: ['2001'] }), st);
    expect(loadAlertPrefs(st)).toMatchObject({ enabled: true, repeatMin: 5, watch: ['2001'] });
    data[ALERT_PREFS_KEY] = '{"repeatMin":-3,"graceSec":"x"}';
    expect(loadAlertPrefs(st)).toMatchObject({ repeatMin: 2, graceSec: 30, watch: null });
  });

  it('tempo fora do ar', () => {
    expect(sinceText(null, NOW)).toBe('desde antes do monitoramento');
    expect(sinceText(NOW - 20_000, NOW)).toBe('há menos de 1 min');
    expect(sinceText(NOW - 7 * MIN, NOW)).toBe('há 7 min');
    expect(sinceText(NOW - 125 * MIN, NOW)).toBe('há 2 h 05 min');
  });
});
