import { describe, expect, test } from 'bun:test';
import { InFlightCoalescer } from './in-flight-coalescer.js';

describe('InFlightCoalescer', () => {
  test('shares concurrent work for the same key', async () => {
    const coalescer = new InFlightCoalescer();
    let loads = 0;
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const load = () => {
      loads++;
      return pending;
    };

    const first = coalescer.run('same', load);
    const second = coalescer.run('same', load);
    release('result');

    expect(await Promise.all([first, second])).toEqual(['result', 'result']);
    expect(loads).toBe(1);
  });

  test('does not retain a completed result', async () => {
    const coalescer = new InFlightCoalescer();
    let loads = 0;
    const load = async () => ++loads;

    expect(await coalescer.run('key', load)).toBe(1);
    await Promise.resolve();
    expect(await coalescer.run('key', load)).toBe(2);
  });

  test('does not retain a failed request', async () => {
    const coalescer = new InFlightCoalescer();
    let loads = 0;
    const load = async () => {
      loads++;
      if (loads === 1) throw new Error('failed');
      return 'recovered';
    };

    await expect(coalescer.run('key', load)).rejects.toThrow('failed');
    await Promise.resolve();
    expect(await coalescer.run('key', load)).toBe('recovered');
  });
});
