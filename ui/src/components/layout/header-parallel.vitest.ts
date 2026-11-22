import { describe, expect, test } from 'vitest';
import { clampParallelism } from './header';

describe('clampParallelism', () => {
  test('never offers 0 and caps at the server maximum of 10', () => {
    expect(clampParallelism(0)).toBe(1);
    expect(clampParallelism(-3)).toBe(1);
    expect(clampParallelism(1)).toBe(1);
    expect(clampParallelism(7)).toBe(7);
    expect(clampParallelism(11)).toBe(10);
  });
});
