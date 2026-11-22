import { describe, expect, test } from 'bun:test';
import { createGetProviderUsageTool } from './tools.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const context = { group_folder: 'project' };
const run = (tool: ReturnType<typeof createGetProviderUsageTool>) =>
  tool.handler({}, {} as any, context).then((out) => JSON.parse(out));
const configured = { url: 'http://box.invalid', token: 'secret' };

describe('get_provider_usage', () => {
  test('returns only the allow-listed projection with ISO times', async () => {
    const request = (async (url: URL) =>
      String(url).endsWith('/usage')
        ? json({
            usage: {
              a1: {
                windows: [
                  {
                    label: '5-hour',
                    usedPercent: 12,
                    resetsAt: 1_000_000_000_000,
                    models: ['m'],
                    token: 'leak',
                  },
                ],
                plan: 'max',
                fetchedAt: 1_000_000_000_000,
                credentialId: 'leak',
              },
              a2: { error: 'boom', fetchedAt: 1_000_000_000_000 },
            },
          })
        : json({
            accounts: [
              {
                id: 'a1',
                provider: 'anthropic',
                label: 'Main',
                scope: 'shared',
                client: 'leak',
                credentialId: 'leak',
              },
              { id: 'a2', provider: 'codex', label: 'Other', scope: 'client' },
            ],
          })) as unknown as typeof fetch;
    const result = await run(
      createGetProviderUsageTool(request, () => configured),
    );
    const iso = '2001-09-09T01:46:40.000Z';
    expect(result).toEqual({
      accounts: [
        {
          provider: 'anthropic',
          label: 'Main',
          scope: 'shared',
          plan: 'max',
          windows: [{ label: '5-hour', usedPercent: 12, resetsAt: iso }],
          fetchedAt: iso,
        },
        {
          provider: 'codex',
          label: 'Other',
          scope: 'client',
          windows: null,
          error: 'boom',
          fetchedAt: iso,
        },
      ],
      fetchedAt: iso,
    });
  });

  test('projects tier and capacity and derives remainingCapacity, ignoring invalid values', async () => {
    const request = (async (url: URL) =>
      String(url).endsWith('/usage')
        ? json({
            usage: {
              big: {
                windows: [{ label: 'Weekly', usedPercent: 87 }],
                fetchedAt: 1_000_000_000_000,
              },
              free: {
                windows: [{ label: 'Weekly', usedPercent: 0 }],
                fetchedAt: 1_000_000_000_000,
              },
              bad: {
                windows: [{ label: 'Weekly', usedPercent: 50 }],
                fetchedAt: 1_000_000_000_000,
              },
            },
          })
        : json({
            accounts: [
              {
                id: 'big',
                provider: 'anthropic',
                label: 'Max',
                scope: 'shared',
                tier: 'max 20x',
                capacity: 100,
              },
              {
                id: 'free',
                provider: 'codex',
                label: 'Free',
                scope: 'client',
                capacity: 1,
              },
              {
                id: 'bad',
                provider: 'codex',
                label: 'Bad',
                scope: 'client',
                tier: 'x'.repeat(41),
                capacity: 2.5,
              },
            ],
          })) as unknown as typeof fetch;
    const result = (await run(
      createGetProviderUsageTool(request, () => configured),
    )) as { accounts: Array<Record<string, unknown>> };
    const [big, free, bad] = result.accounts;
    expect(big).toMatchObject({
      tier: 'max 20x',
      capacity: 100,
      windows: [{ label: 'Weekly', usedPercent: 87, remainingCapacity: 13 }],
    });
    expect(free).toMatchObject({
      capacity: 1,
      windows: [{ usedPercent: 0, remainingCapacity: 1 }],
    });
    expect(bad).not.toHaveProperty('tier');
    expect(bad).not.toHaveProperty('capacity');
    expect(bad.windows).toEqual([
      { label: 'Weekly', usedPercent: 50, resetsAt: undefined },
    ]);
  });

  test.each([
    ['missing token', fetch, { url: configured.url, token: '' }],
    [
      'fetch failure',
      (async () => {
        throw new Error('http://box.invalid down');
      }) as unknown as typeof fetch,
      configured,
    ],
    [
      'non-2xx response',
      (async () => json({ detail: 'secret' }, 500)) as unknown as typeof fetch,
      configured,
    ],
  ])('returns a generic error on %s', async (_name, request, config) => {
    expect(
      await run(createGetProviderUsageTool(request, () => config)),
    ).toEqual({ error: 'Provider usage unavailable' });
  });
});
