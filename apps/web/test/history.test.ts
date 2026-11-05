import { describe, expect, it } from 'vitest';
import { clampAt, formatAt, fromLocalInput, stepLabel, toLocalInput } from '../src/lib/history';

// horários locais (o teste não depende do fuso de quem roda)
const at = (d: number, h: number, m: number, s = 0) => new Date(2026, 10, d, h, m, s).getTime();

describe('clampAt', () => {
  const now = at(3, 15, 0, 0) + 400; // 15:00:00.400
  it('não passa de agora nem volta antes do início do histórico', () => {
    expect(clampAt(now + 60_000, null, now)).toBe(at(3, 15, 0));
    expect(clampAt(at(3, 9, 0), at(3, 10, 0), now)).toBe(at(3, 10, 0));
    expect(clampAt(at(3, 12, 30, 0) + 600, at(3, 10, 0), now)).toBe(at(3, 12, 30, 1));
  });
});

describe('formatAt', () => {
  const now = at(3, 15, 0);
  it('hoje só a hora; ontem; outros dias com a data', () => {
    expect(formatAt(at(3, 14, 32, 10), now)).toBe('14:32:10');
    expect(formatAt(at(2, 9, 5, 0), now)).toBe('ontem 09:05:00');
    expect(formatAt(at(1, 23, 59, 59), now)).toBe('01/11 23:59:59');
  });
});

describe('campo de data e hora', () => {
  it('ida e volta no formato do datetime-local', () => {
    const t = at(3, 14, 32, 10);
    expect(toLocalInput(t)).toBe('2026-11-03T14:32:10');
    expect(fromLocalInput(toLocalInput(t))).toBe(t);
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('xyz')).toBeNull();
  });
});

it('rótulos dos passos', () => {
  expect(stepLabel(-15)).toBe('−15 min');
  expect(stepLabel(1)).toBe('+1 min');
});
