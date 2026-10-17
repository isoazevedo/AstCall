import { describe, expect, it } from 'vitest';
import {
  abandonRate,
  loadTvPrefs,
  nextScreen,
  oldestWaitingSince,
  parseRotate,
  saveTvPrefs,
  TV_PREFS_KEY,
  type TvPrefs,
} from '../src/lib/tv';
import type { QueueView } from '../src/lib/view';

/** localStorage de mentira. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
  };
}

const fallback: TvPrefs = { rotate: true, screen: 'queues' };

describe('parseRotate', () => {
  it('sem atributo: 15 s, ligado', () => {
    expect(parseRotate(undefined)).toEqual({ seconds: 15, enabled: true });
    expect(parseRotate('')).toEqual({ seconds: 15, enabled: true });
  });

  it('"0" começa desligado mantendo o intervalo padrão', () => {
    expect(parseRotate('0')).toEqual({ seconds: 15, enabled: false });
  });

  it('respeita o valor e aplica os limites', () => {
    expect(parseRotate('30')).toEqual({ seconds: 30, enabled: true });
    expect(parseRotate('1')).toEqual({ seconds: 5, enabled: true });
    expect(parseRotate('99999')).toEqual({ seconds: 600, enabled: true });
    expect(parseRotate('abc')).toEqual({ seconds: 15, enabled: true });
  });
});

describe('nextScreen', () => {
  it('alterna entre as telas disponíveis', () => {
    expect(nextScreen(['queues', 'calls'], 'queues')).toBe('calls');
    expect(nextScreen(['queues', 'calls'], 'calls')).toBe('queues');
  });

  it('com uma tela só, fica nela', () => {
    expect(nextScreen(['calls'], 'calls')).toBe('calls');
  });

  it('tela atual indisponível: vai para a primeira', () => {
    expect(nextScreen(['calls'], 'queues')).toBe('calls');
  });
});

describe('preferências do modo TV', () => {
  it('sem nada salvo: usa o padrão', () => {
    expect(loadTvPrefs(fallback, memoryStorage())).toEqual(fallback);
  });

  it('salva e lê de volta', () => {
    const st = memoryStorage();
    saveTvPrefs({ rotate: false, screen: 'calls' }, st);
    expect(loadTvPrefs(fallback, st)).toEqual({ rotate: false, screen: 'calls' });
  });

  it('ignora valores inválidos ou JSON quebrado', () => {
    expect(
      loadTvPrefs(fallback, memoryStorage({ [TV_PREFS_KEY]: '{"rotate":"x","screen":"foo"}' })),
    ).toEqual(fallback);
    expect(loadTvPrefs(fallback, memoryStorage({ [TV_PREFS_KEY]: '{oops' }))).toEqual(fallback);
  });

  it('armazenamento que lança erro não derruba o painel', () => {
    const broken = {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('bloqueado');
      },
    };
    expect(loadTvPrefs(fallback, broken)).toEqual(fallback);
    expect(() => saveTvPrefs(fallback, broken)).not.toThrow();
  });
});

describe('números das filas', () => {
  const base = { completed: 0, abandoned: 0, waiting: [] } as unknown as QueueView;
  const entry = (joinedAt: number) => ({ joinedAt }) as QueueView['waiting'][number];

  it('maior espera = entrada mais antiga', () => {
    expect(oldestWaitingSince(base)).toBeNull();
    expect(oldestWaitingSince({ ...base, waiting: [entry(5000), entry(2000)] })).toBe(2000);
  });

  it('taxa de abandono', () => {
    expect(abandonRate(base)).toBe(0);
    expect(abandonRate({ ...base, completed: 3, abandoned: 1 })).toBe(25);
  });
});
