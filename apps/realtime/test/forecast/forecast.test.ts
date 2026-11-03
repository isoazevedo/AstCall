import { describe, expect, it } from 'vitest';
import { agentsNeeded, erlangC, serviceLevel } from '../../src/forecast/erlang.js';
import { QueueForecaster } from '../../src/forecast/QueueForecaster.js';
import { applyEvent } from '../../src/handlers/index.js';
import { ServerStore } from '../../src/state/ServerStore.js';

const MIN = 60_000;
const T0 = 1_800_000_000_000;

describe('Erlang C', () => {
  it('confere com o valor de referência (M/M/3 com 2 erlangs → 4/9)', () => {
    expect(erlangC(3, 2)).toBeCloseTo(4 / 9, 10);
  });

  it('com atendentes de menos (N ≤ A) a espera é certa e o nível de serviço é zero', () => {
    expect(erlangC(2, 2)).toBe(1);
    expect(erlangC(0, 1)).toBe(1);
    expect(serviceLevel(4, 6, 180, 20)).toBe(0);
  });

  it('nível de serviço cresce com mais atendentes e com meta mais folgada', () => {
    const sl = (n: number, t = 20) => serviceLevel(n, 6, 180, t);
    expect(sl(7)).toBeLessThan(sl(8));
    expect(sl(8)).toBeLessThan(sl(9));
    expect(sl(8, 20)).toBeLessThan(sl(8, 60));
  });

  it('atendentes necessários é o menor N que bate a meta', () => {
    const n = agentsNeeded(6, 180, 20, 0.8);
    expect(serviceLevel(n, 6, 180, 20)).toBeGreaterThanOrEqual(0.8);
    expect(serviceLevel(n - 1, 6, 180, 20)).toBeLessThan(0.8);
    expect(agentsNeeded(0, 180, 20, 0.8)).toBe(0);
  });
});

/** Fila "suporte" com `free` membros livres, `busy` em atendimento e `paused` pausados. */
function scenario(opts: { free?: number; busy?: number; paused?: number } = {}) {
  const store = new ServerStore();
  applyEvent(
    store,
    { event: 'QueueParams', queue: 'suporte', strategy: 'ringall', servicelevel: '20' },
    T0,
  );
  let ext = 2001;
  const member = (status: string, paused = '0', incall = '0') =>
    applyEvent(
      store,
      {
        event: 'QueueMember',
        queue: 'suporte',
        location: `PJSIP/${ext++}`,
        status,
        paused,
        incall,
      },
      T0,
    );
  for (let i = 0; i < (opts.free ?? 0); i++) member('1');
  for (let i = 0; i < (opts.busy ?? 0); i++) member('2', '0', '1');
  for (let i = 0; i < (opts.paused ?? 0); i++) member('1', '1');
  return store;
}

/** Forecaster já "aquecido" (monitorando há mais de uma janela). */
const forecaster = () => new QueueForecaster({ startedAt: T0 - 60 * MIN });

/** `n` entradas e atendimentos de `talk` s espalhados pelos últimos `minutes` minutos. */
function feed(f: QueueForecaster, n: number, talk: number, minutes = 15, now = T0) {
  for (let i = 0; i < n; i++) {
    const t = now - (minutes * MIN * (i + 0.5)) / n;
    f.onEvent({ event: 'QueueCallerJoin', queue: 'suporte' }, t);
    f.onEvent({ event: 'AgentComplete', queue: 'suporte', talktime: String(talk) }, t);
  }
}

describe('previsão das filas', () => {
  it('fila tranquila: dentro da meta e com menos atendentes necessários do que há', () => {
    const store = scenario({ free: 4 });
    const f = forecaster();
    feed(f, 15, 120); // 1 chamada/min, 2 min de atendimento → 2 erlangs para 4 atendentes
    const fc = f.forecast(store, 'suporte', T0);
    expect(fc).toMatchObject({
      status: 'ok',
      arrivalsPerMin: 1,
      ahtSec: 120,
      agentsAvailable: 4,
      slSeconds: 20,
      slTarget: 80,
      risk: 'ok',
    });
    expect(fc.slForecast).toBeGreaterThanOrEqual(80);
    expect(fc.agentsNeeded).toBeLessThanOrEqual(4);
  });

  it('fila sobrecarregada: nível de serviço baixo, risco alto e atendentes faltando', () => {
    const store = scenario({ free: 2, paused: 2 }); // pausados não contam
    const f = forecaster();
    feed(f, 45, 180); // 3/min × 3 min = 9 erlangs para 2 atendentes
    const fc = f.forecast(store, 'suporte', T0);
    expect(fc.agentsAvailable).toBe(2);
    expect(fc.slForecast).toBe(0);
    expect(fc.risk).toBe('high');
    expect(fc.agentsNeeded).toBeGreaterThan(9);
  });

  it('sem atendimento concluído ainda: usa o tempo médio padrão, marcado como estimativa', () => {
    const f = forecaster();
    f.onEvent({ event: 'QueueCallerJoin', queue: 'suporte' }, T0 - 2 * MIN);
    f.onEvent({ event: 'QueueCallerJoin', queue: 'suporte' }, T0 - MIN);
    const fc = f.forecast(scenario({ free: 2 }), 'suporte', T0);
    expect(fc).toMatchObject({ ahtSec: 180, ahtEstimated: true });
    expect(fc.slForecast).not.toBeNull();
    feed(f, 1, 60);
    expect(f.forecast(scenario({ free: 2 }), 'suporte', T0)).toMatchObject({
      ahtSec: 60,
      ahtEstimated: false,
    });
  });

  it('sem movimento na janela: "idle", sem previsão numérica', () => {
    const fc = forecaster().forecast(scenario({ free: 2 }), 'suporte', T0);
    expect(fc).toMatchObject({ status: 'idle', slForecast: null, agentsNeeded: null, risk: 'ok' });
  });

  it('logo após iniciar: "warming" e janela menor (mínimo 5 min)', () => {
    const f = new QueueForecaster({ startedAt: T0 - 2 * MIN });
    f.onEvent({ event: 'QueueCallerJoin', queue: 'suporte' }, T0 - MIN);
    const fc = f.forecast(scenario({ free: 1 }), 'suporte', T0);
    expect(fc.status).toBe('warming');
    expect(fc.windowMin).toBe(5);
    expect(fc.arrivalsPerMin).toBe(0.2);
  });

  it('chamador esperando sem nenhum atendente disponível: risco alto', () => {
    const store = scenario({ paused: 2 });
    applyEvent(
      store,
      { event: 'QueueCallerJoin', queue: 'suporte', uniqueid: 'c1', channel: 'X', position: '1' },
      T0 - 30_000,
    );
    expect(forecaster().forecast(store, 'suporte', T0).risk).toBe('high');
  });

  it('tendência: entrada recente bem acima da anterior = "up"', () => {
    const f = forecaster();
    feed(f, 3, 120, 10, T0 - 5 * MIN); // 3 nos 10 min anteriores
    feed(f, 10, 120, 5); // 10 nos últimos 5 min
    expect(f.forecast(scenario({ free: 3 }), 'suporte', T0).trend).toBe('up');
  });

  it('horário estimado: atendente livre atende já; o seguinte espera o próximo ficar livre', () => {
    const store = scenario({ free: 1, busy: 1 }); // 2001 livre, 2002 ocupado
    // o 2002 está numa chamada atendida há 90 s: com 2 min de média, fica livre em ~30 s
    applyEvent(
      store,
      {
        event: 'Newchannel',
        channel: 'PJSIP/2002-01',
        uniqueid: 'u1',
        linkedid: 'u1',
        channelstatedesc: 'Up',
      },
      T0 - 90_000,
    );
    const f = forecaster();
    feed(f, 15, 120);
    for (const [uid, pos] of [
      ['c1', '1'],
      ['c2', '2'],
      ['c3', '3'],
    ] as const) {
      applyEvent(
        store,
        {
          event: 'QueueCallerJoin',
          queue: 'suporte',
          uniqueid: uid,
          channel: `X/${uid}`,
          position: pos,
        },
        T0,
      );
    }
    const { etaAt } = f.forecast(store, 'suporte', T0);
    expect(etaAt.c1).toBe(T0); // o 2001 está livre
    expect(etaAt.c2).toBe(T0 + 30_000); // o 2002 termina a chamada em ~30 s
    expect(etaAt.c3).toBe(T0 + 120_000); // o 2001 termina o atendimento do c1
    expect(Object.values(etaAt).every((t) => t % 10_000 === 0)).toBe(true); // arredondado
  });

  it('grava no store e só gera delta quando a previsão muda', () => {
    const store = scenario({ free: 2 });
    const f = forecaster();
    feed(f, 10, 90);
    const deltas: string[] = [];
    store.on('deltas', (ops) => deltas.push(...ops.map((o) => `${o.op} ${o.entity}`)));
    f.update(store, T0);
    f.update(store, T0);
    expect(deltas).toEqual(['upsert queueForecast']);
    expect(store.snapshot().queueForecasts).toHaveLength(1);
  });
});
