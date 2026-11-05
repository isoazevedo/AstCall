import { describe, expect, it } from 'vitest';
import type { QueueForecast } from '@astcall/shared';
import {
  DEFAULT_COPILOT_PREFS,
  loadCopilotPrefs,
  saveCopilotPrefs,
  suggestions,
  type CopilotInput,
} from '../src/lib/copilot';
import type { EndpointView, QueueMemberView, QueueView } from '../src/lib/view';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const member = (ext: string, extra: Partial<QueueMemberView> = {}): QueueMemberView => ({
  id: `suporte|PJSIP/${ext}`,
  label: ext,
  interface: `PJSIP/${ext}`,
  stateLabel: 'Livre',
  tone: 'success',
  paused: false,
  pausedReason: '',
  pausedSince: null,
  inCall: false,
  callsTaken: 0,
  lastCall: null,
  penalty: 0,
  dynamic: false,
  endpointId: ext,
  rank: 0,
  ...extra,
});

const paused = (ext: string, minutesAgo: number, reason = 'Almoço') =>
  member(ext, { paused: true, rank: 2, pausedReason: reason, pausedSince: NOW - minutesAgo * MIN });

const forecast = (extra: Partial<QueueForecast> = {}): QueueForecast => ({
  queue: 'suporte',
  status: 'ok',
  windowMin: 15,
  arrivalsPerMin: 2,
  ahtSec: 120,
  ahtEstimated: false,
  agentsAvailable: 1,
  agentsNeeded: 3,
  slForecast: 40,
  slTarget: 80,
  slSeconds: 20,
  trend: 'up',
  risk: 'high',
  etaAt: {},
  ...extra,
});

const queue = (members: QueueMemberView[], extra: Partial<QueueView> = {}): QueueView => ({
  name: 'suporte',
  strategy: 'ringall',
  completed: 0,
  abandoned: 0,
  holdtime: 0,
  talktime: 0,
  serviceLevel: 20,
  serviceLevelPerf: 0,
  waiting: [],
  members,
  available: members.filter((m) => m.rank === 0).length,
  busy: members.filter((m) => m.rank === 1).length,
  paused: members.filter((m) => m.rank === 2).length,
  offline: members.filter((m) => m.rank === 3).length,
  forecast: forecast(),
  ...extra,
});

const ep = (id: string, extra: Partial<EndpointView> = {}): EndpointView => ({
  id,
  label: 'Livre',
  tone: 'success',
  group: 'free',
  userAgent: null,
  address: null,
  activeChannels: 0,
  trunk: false,
  offlineSince: null,
  quality: null,
  ...extra,
});

const input = (extra: Partial<CopilotInput> = {}): CopilotInput => ({
  queues: [],
  endpoints: [],
  can: { queue: true, manage: true },
  prefs: DEFAULT_COPILOT_PREFS,
  dismissed: new Map(),
  now: NOW,
  ...extra,
});

describe('copiloto: fila em risco', () => {
  it('sugere retomar quem está pausado há mais tempo e adicionar ramais livres que faltam', () => {
    const q = queue([member('2001'), paused('2002', 10), paused('2003', 40)]);
    const s = suggestions(
      input({
        queues: [q],
        endpoints: [ep('2001'), ep('2009'), ep('2010'), ep('operadora', { trunk: true })],
      }),
    );
    expect(s.map((x) => x.id)).toEqual([
      'resume|suporte|PJSIP/2003', // pausado há 40 min vem primeiro
      'resume|suporte|PJSIP/2002',
      'add|suporte|2009', // faltam 2: 2009 e 2010 (2001 já é da fila; tronco nunca)
      'add|suporte|2010',
    ]);
    expect(s[0]).toMatchObject({
      severity: 'high',
      title: 'Retomar 2003 na fila suporte',
      actionLabel: 'Retomar',
    });
    expect(s[0]!.detail).toContain('Em pausa há 40 min (Almoço)');
    const fresh = suggestions(input({ queues: [queue([paused('2004', 0, '')])] }));
    expect(fresh[0]!.detail).toContain('Em pausa há menos de 1 min.');
  });

  it('cada ramal livre é sugerido para uma fila só, a mais grave primeiro', () => {
    const warn = queue([member('2001')], {
      name: 'financeiro',
      forecast: forecast({ risk: 'warn', slForecast: 70, agentsNeeded: 2 }),
    });
    const high = queue([member('2002')], { name: 'vendas' });
    const s = suggestions(input({ queues: [warn, high], endpoints: [ep('2009')] }));
    expect(s.map((x) => x.id)).toEqual(['add|vendas|2009', 'risk|financeiro']);
  });

  it('ramal em pausa em outra fila não é sugerido como livre', () => {
    const other = queue([paused('2009', 5)], {
      name: 'vendas',
      forecast: forecast({ risk: 'ok', slForecast: 95 }),
    });
    const s = suggestions(
      input({ queues: [queue([member('2001')]), other], endpoints: [ep('2009')] }),
    );
    expect(s.map((x) => x.id)).toEqual(['risk|suporte']);
  });

  it('só sugere o que o usuário pode fazer', () => {
    const q = queue([paused('2002', 10)]);
    const onlyPause = suggestions(
      input({ queues: [q], endpoints: [ep('2009')], can: { queue: true, manage: false } }),
    );
    expect(onlyPause.map((x) => x.action?.kind)).toEqual(['resume']);
    const onlyManage = suggestions(
      input({ queues: [q], endpoints: [ep('2009')], can: { queue: false, manage: true } }),
    );
    expect(onlyManage.map((x) => x.action?.kind)).toEqual(['add']);
    expect(suggestions(input({ queues: [q], can: { queue: false, manage: false } }))).toEqual([]);
  });

  it('gente esperando sem atendente livre e nada a sugerir: aviso sem ação', () => {
    const entry = {
      id: 'suporte|c1',
      queue: 'suporte',
      uniqueid: 'c1',
      channel: '',
      callerId: { num: '1', name: '' },
      position: 1,
      joinedAt: NOW,
    };
    const q = queue([member('2001', { rank: 1, inCall: true })], {
      waiting: [entry],
      forecast: null,
    });
    const s = suggestions(input({ queues: [q] }));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: 'risk|suporte', severity: 'high', action: null });
    expect(s[0]!.detail).toContain('1 aguardando e nenhum atendente livre');
  });

  it('fila dentro da meta: nenhuma sugestão de risco', () => {
    const q = queue([member('2001'), paused('2002', 5)], {
      forecast: forecast({ risk: 'ok', slForecast: 95 }),
    });
    expect(suggestions(input({ queues: [q], endpoints: [ep('2009')] }))).toEqual([]);
  });
});

describe('copiloto: pausas longas', () => {
  const calm = (members: QueueMemberView[]) =>
    queue(members, { forecast: forecast({ risk: 'ok', slForecast: 95 }) });

  it('avisa pausa acima do limite, uma vez por atendente, com ação de retomar', () => {
    const s = suggestions(input({ queues: [calm([paused('2002', 45), paused('2003', 10)])] }));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      id: 'long|PJSIP/2002',
      severity: 'info',
      title: '2002 em pausa há 45 min',
      action: { kind: 'resume' },
    });
  });

  it('respeita motivos ignorados e o limite configurado (0 desliga)', () => {
    const q = calm([paused('2002', 45, 'Treinamento')]);
    expect(
      suggestions(
        input({ queues: [q], prefs: { longPauseMin: 30, ignoreReasons: ['treinamento'] } }),
      ),
    ).toEqual([]);
    expect(
      suggestions(input({ queues: [q], prefs: { longPauseMin: 0, ignoreReasons: [] } })),
    ).toEqual([]);
    expect(
      suggestions(input({ queues: [q], prefs: { longPauseMin: 60, ignoreReasons: [] } })),
    ).toEqual([]);
  });

  it('sugestão dispensada some até o prazo acabar', () => {
    const q = calm([paused('2002', 45)]);
    const dismissed = new Map([['long|PJSIP/2002', NOW + 10 * MIN]]);
    expect(suggestions(input({ queues: [q], dismissed }))).toEqual([]);
    expect(suggestions(input({ queues: [q], dismissed, now: NOW + 11 * MIN }))).toHaveLength(1);
  });
});

describe('preferências do copiloto', () => {
  it('salva, carrega e corrige valores inválidos', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    expect(loadCopilotPrefs(storage)).toEqual(DEFAULT_COPILOT_PREFS);
    saveCopilotPrefs({ longPauseMin: 45, ignoreReasons: ['Treinamento'] }, storage);
    expect(loadCopilotPrefs(storage)).toEqual({ longPauseMin: 45, ignoreReasons: ['Treinamento'] });
    data.set('astcall.copiloto', '{"longPauseMin":-3,"ignoreReasons":"x"}');
    expect(loadCopilotPrefs(storage)).toEqual(DEFAULT_COPILOT_PREFS);
  });
});
