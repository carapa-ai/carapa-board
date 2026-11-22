import { describe, expect, test } from 'bun:test';
import {
  createProviderUsageLoader,
  selectCapacityCandidate,
} from './capacity.js';
import type { ProviderUsageAccount } from './tools.js';

const account = (
  provider: string,
  capacity: number | undefined,
  windows: Array<[label: string, usedPercent: number, resetsAt?: string]>,
): ProviderUsageAccount => ({
  provider,
  capacity,
  windows: windows.map(([label, usedPercent, resetsAt]) => ({
    label,
    usedPercent,
    resetsAt,
    remainingCapacity:
      capacity === undefined
        ? undefined
        : Math.round((capacity * (100 - usedPercent)) / 100),
  })),
});

const claude = { harnessId: 'claude', modelId: 'opus-5-5' };
const codex = { harnessId: 'codex', modelId: 'astra-6' };

describe('selectCapacityCandidate', () => {
  test('skips an account with a window at 95% or more and picks the one with room', () => {
    const choice = selectCapacityCandidate(
      [claude, codex],
      [
        account('anthropic', 100, [['Weekly', 97]]),
        account('codex', 50, [['Weekly', 20]]),
      ],
    );
    expect(choice).toEqual({
      candidate: codex,
      capacityReason: 'most-remaining',
      remainingCapacity: 40,
    });
    // Any window counts, not only the shortest.
    expect(
      selectCapacityCandidate(
        [claude, codex],
        [
          account('anthropic', 100, [
            ['5-hour', 10],
            ['Weekly', 95],
          ]),
          account('codex', 1, [['Weekly', 90]]),
        ],
      ).candidate,
    ).toBe(codex);
  });

  test('ranks by remaining capacity of the shortest window, then sooner reset, then config order', () => {
    const accounts = (codexUsed: number, codexReset?: string) => [
      account('anthropic', 100, [
        ['Weekly', 90],
        ['5-hour', 50, '2026-01-01T05:00:00.000Z'],
      ]),
      account('codex', 100, [['5-hour', codexUsed, codexReset]]),
    ];
    // The shortest window of claude has 50 left, not the weekly 10.
    expect(
      selectCapacityCandidate([claude, codex], accounts(40)).candidate,
    ).toBe(codex);
    expect(
      selectCapacityCandidate([claude, codex], accounts(60)).candidate,
    ).toBe(claude);
    expect(
      selectCapacityCandidate(
        [claude, codex],
        accounts(50, '2026-01-01T03:00:00.000Z'),
      ).candidate,
    ).toBe(codex);
    expect(
      selectCapacityCandidate(
        [claude, codex],
        accounts(50, '2026-01-01T09:00:00.000Z'),
      ).candidate,
    ).toBe(claude);
    expect(
      selectCapacityCandidate([claude, codex], accounts(50)).candidate,
    ).toBe(claude);
  });

  test('ranks unknown capacity after known capacity, in config order', () => {
    const accounts = [
      account('anthropic', undefined, [['Weekly', 10]]),
      account('codex', 50, [['Weekly', 90]]),
    ];
    expect(selectCapacityCandidate([claude, codex], accounts)).toEqual({
      candidate: codex,
      capacityReason: 'most-remaining',
      remainingCapacity: 5,
    });
    // Known capacity is exhausted, so the unknown one is next.
    expect(
      selectCapacityCandidate(
        [codex, claude],
        [account('codex', 50, [['Weekly', 99]]), accounts[0]!],
      ),
    ).toEqual({ candidate: claude, capacityReason: 'unknown-capacity' });
  });

  test('uses config order when every candidate is exhausted, and when usage or capacity is missing', () => {
    expect(
      selectCapacityCandidate(
        [claude, codex],
        [
          account('anthropic', 100, [['Weekly', 96]]),
          account('codex', 50, [['Weekly', 99]]),
        ],
      ),
    ).toEqual({
      candidate: claude,
      capacityReason: 'capacity-exhausted',
      remainingCapacity: 4,
    });
    expect(selectCapacityCandidate([claude, codex], null)).toEqual({
      candidate: claude,
      capacityReason: 'usage-unavailable',
    });
    expect(
      selectCapacityCandidate(
        [claude, codex],
        [
          account('anthropic', undefined, [['Weekly', 99]]),
          account('codex', undefined, [['Weekly', 1]]),
        ],
      ),
    ).toEqual({ candidate: claude, capacityReason: 'unknown-capacity' });
  });

  test('a single candidate is returned without a capacity reason', () => {
    expect(selectCapacityCandidate([claude], null)).toEqual({
      candidate: claude,
    });
  });
});

describe('createProviderUsageLoader', () => {
  test('caches a lookup for the interval, shares concurrent lookups and falls back to null', async () => {
    let now = 1_000;
    let calls = 0;
    let result: { accounts: ProviderUsageAccount[] } | null = {
      accounts: [account('codex', 50, [['Weekly', 20]])],
    };
    const load = createProviderUsageLoader(
      async () => {
        calls++;
        if (!result) throw new Error('box down');
        return result;
      },
      { ttlMs: 60_000, now: () => now },
    );

    const [a, b] = await Promise.all([load(), load()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);

    now += 59_000;
    expect(await load()).toBe(a);
    expect(calls).toBe(1);

    // After the interval an unreachable Box yields null, and that is cached too.
    now += 2_000;
    result = null;
    expect(await load()).toBeNull();
    expect(await load()).toBeNull();
    expect(calls).toBe(2);

    now += 60_000;
    result = { accounts: [] };
    expect(await load()).toEqual([]);
    expect(calls).toBe(3);
  });
});
