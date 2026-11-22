// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { cacheHitPercent } from './cache-hit-rate';

describe('chat telemetry regressions', () => {
  test('uses the reported input-token convention for cache rate', () => {
    expect(cacheHitPercent(2_108, 20_224, 'fresh')).toBeCloseTo(90.56, 2);
    expect(cacheHitPercent(5_618, 1_500, 'total')).toBeCloseTo(26.7, 1);
    expect(cacheHitPercent(2_108, 20_224, 'total')).toBe(100);
    expect(cacheHitPercent(4, 42_410, 'fresh', 9_435)).toBeCloseTo(81.8, 1);
    expect(cacheHitPercent(2, 0, 'fresh', 51_388)).toBe(0);
  });
});
