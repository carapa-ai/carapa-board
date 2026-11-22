import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test';
import { JEV_URL, PRIVACY_LOCAL_ENDPOINT_PREFIXES } from '../config.js';
import { initDatabase } from '../db.js';
import { logger } from '../logger.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import {
  __resetJevBreakerForTests,
  __setJevFailoverConfigForTests,
  JevError,
  jevSystemOne,
  jevSystemOneBatch,
} from './jev-client.js';

const jid = `jev-privacy-${process.pid}@web`;
const folder = `jev-privacy-${process.pid}`;
const localPrefixes = PRIVACY_LOCAL_ENDPOINT_PREFIXES as string[];
const localBase = 'http://api-relay.test:8080/laya';

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  localPrefixes.push(localBase);
  await registerGroup(jid, {
    jid,
    name: 'Jev privacy',
    folder,
    trigger: '@jev',
    added_at: new Date().toISOString(),
    settings: { privacyMode: 'strict' },
  });
});
afterAll(async () => {
  localPrefixes.splice(localPrefixes.indexOf(localBase), 1);
  await unregisterGroup(jid);
});

const okFetch = () =>
  mock(async () => Response.json({ answers: { q: { choice: 'a' } } }));
const request = { state: 's', questions: { q: { type: 'choice' } } };

describe('jev client privacy gate', () => {
  test('a strict project refuses a remote Jev URL without fetching', async () => {
    const fetchImpl = okFetch();
    const error = await jevSystemOne({
      ...request,
      projectId: folder,
      url: 'http://hosted-jev.test/api',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(JevError);
    expect(error.kind).toBe('privacy');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('an unattributed call is refused too while any project is strict', async () => {
    const fetchImpl = okFetch();
    const error = await jevSystemOne({
      ...request,
      url: 'http://hosted-jev.test/api',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(error).toMatchObject({ kind: 'privacy' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a configured local prefix passes', async () => {
    const fetchImpl = okFetch();
    const result = await jevSystemOne({
      ...request,
      projectId: folder,
      url: localBase,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.answers.q?.choice).toBe('a');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('jev client failover', () => {
  const JEV_URL_FOR_TEST = JEV_URL;
  const primaryUrl = 'http://ninfer.test:8881';
  const fallbackUrl = 'http://hosted-jev.test/jev';
  const cooldownMs = 60_000;
  const projects = {
    off: `jev-fb-off-${process.pid}`,
    local_memory: `jev-fb-lm-${process.pid}`,
  };

  interface Call {
    url: string;
    authorization: string | null;
    body: Record<string, unknown>;
  }

  /** Routes by host; `primary` decides the primary's response, the fallback always answers. */
  function fakeFetch(primary: () => Response | Promise<Response> | Error) {
    const calls: Call[] = [];
    const impl = mock(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      calls.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
        body,
      });
      if (url.startsWith(fallbackUrl)) {
        const states = (body.states as string[] | undefined) ?? [];
        return url.endsWith('/batch')
          ? Response.json({
              results: states.map((state) => ({
                answers: { q: { choice: `fallback-batch:${state}` } },
              })),
            })
          : Response.json({
              answers: { q: { choice: `fallback:${body.state}` } },
            });
      }
      const outcome = await primary();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    return { calls, fetchImpl: impl as unknown as typeof fetch };
  }
  const ok = () => Response.json({ answers: { q: { choice: 'primary' } } });
  const networkError = () => new TypeError('connection refused');
  const hosts = (calls: Call[]) =>
    calls.map((call) =>
      call.url.startsWith(fallbackUrl) ? 'fallback' : 'primary',
    );

  beforeAll(async () => {
    // The primary is the preload's mock Jev server, standing in for a local ninfer.
    localPrefixes.push(JEV_URL);
    for (const [mode, folder] of Object.entries(projects)) {
      await registerGroup(`${folder}@web`, {
        jid: `${folder}@web`,
        name: folder,
        folder,
        trigger: '@jev',
        added_at: new Date().toISOString(),
        settings: { privacyMode: mode as 'off' | 'local_memory' },
      });
    }
  });
  afterAll(async () => {
    localPrefixes.splice(localPrefixes.indexOf(JEV_URL), 1);
    for (const folder of Object.values(projects)) {
      await unregisterGroup(`${folder}@web`);
    }
  });
  afterEach(() => {
    setSystemTime();
    __setJevFailoverConfigForTests();
  });

  function configure(breakerFailures = 3) {
    __setJevFailoverConfigForTests({
      fallback: {
        url: fallbackUrl,
        apiKey: 'fb-key',
        model: 'jev-latest',
        batch: false,
      },
      breakerFailures,
      breakerCooldownMs: cooldownMs,
    });
  }
  const call = (
    fetchImpl: typeof fetch,
    projectId: string | undefined = projects.off,
  ) =>
    jevSystemOne({
      ...request,
      projectId,
      apiKey: 'primary-key',
      model: 'ninfer-model',
      fetchImpl,
    });

  test('a healthy primary never contacts the fallback', async () => {
    configure();
    const { calls, fetchImpl } = fakeFetch(ok);
    expect((await call(fetchImpl)).answers.q?.choice).toBe('primary');
    expect(hosts(calls)).toEqual(['primary']);
  });

  test.each([
    ['network error', networkError],
    ['5xx', () => new Response('down', { status: 503 })],
  ])('an off project fails over after a primary %s', async (_name, outage) => {
    configure();
    const { calls, fetchImpl } = fakeFetch(outage);
    const result = await jevSystemOne({
      ...request,
      projectId: projects.off,
      apiKey: 'primary-key',
      model: 'ninfer-model',
      fetchImpl,
    });
    expect(result.answers.q?.choice).toBe('fallback:s');
    expect(hosts(calls)).toEqual(['primary', 'fallback']);
    expect(calls[0]).toMatchObject({
      authorization: 'Bearer primary-key',
      body: { model: 'ninfer-model' },
    });
    expect(calls[1]).toMatchObject({
      url: `${fallbackUrl}/v1/systemone`,
      authorization: 'Bearer fb-key',
      body: { model: 'jev-latest' },
    });
  });

  test('a primary timeout fails over to the fallback', async () => {
    configure();
    const { calls, fetchImpl } = fakeFetch(
      () => new DOMException('timed out', 'TimeoutError') as unknown as Error,
    );
    const result = await call(fetchImpl);
    expect(result.answers.q?.choice).toBe('fallback:s');
    expect(hosts(calls)).toEqual(['primary', 'fallback']);
  });

  test.each(['strict', 'local_memory'] as const)(
    'a %s project never reaches the fallback and sees the primary error',
    async (mode) => {
      configure();
      const { calls, fetchImpl } = fakeFetch(networkError);
      const error = await call(
        fetchImpl,
        mode === 'strict' ? folder : projects.local_memory,
      ).catch((e) => e);
      expect(error).toMatchObject({ kind: 'network' });
      expect(hosts(calls)).toEqual(['primary']);
    },
  );

  test.each([
    ['4xx', () => new Response('bad', { status: 400 }), 'http'],
    ['malformed', () => new Response('not json'), 'malformed'],
  ])('a primary %s does not fail over', async (_name, outcome, kind) => {
    configure();
    const { calls, fetchImpl } = fakeFetch(outcome);
    const error = await call(fetchImpl).catch((e) => e);
    expect(error).toMatchObject({ kind });
    expect(hosts(calls)).toEqual(['primary']);
  });

  test('an unconfigured primary URL is a config error, not a failover', async () => {
    configure();
    const { calls, fetchImpl } = fakeFetch(ok);
    const error = await jevSystemOne({
      ...request,
      projectId: projects.off,
      fetchImpl,
      url: '',
    }).catch((e) => e);
    expect(error).toMatchObject({ kind: 'config' });
    expect(calls).toHaveLength(0);
  });

  test('an explicit url never fails over', async () => {
    configure();
    const { calls, fetchImpl } = fakeFetch(networkError);
    const error = await jevSystemOne({
      ...request,
      projectId: projects.off,
      url: primaryUrl,
      fetchImpl,
    }).catch((e) => e);
    expect(error).toMatchObject({ kind: 'network' });
    expect(hosts(calls)).toEqual(['primary']);
  });

  test('without a configured fallback the primary error is thrown as before', async () => {
    __setJevFailoverConfigForTests({ fallback: undefined });
    const { calls, fetchImpl } = fakeFetch(networkError);
    const error = await call(fetchImpl).catch((e) => e);
    expect(error).toMatchObject({ kind: 'network' });
    expect(hosts(calls)).toEqual(['primary']);
  });

  test('the breaker skips the primary after repeated failures, then probes it after the cooldown', async () => {
    configure();
    let primaryUp = false;
    const { calls, fetchImpl } = fakeFetch(() =>
      primaryUp ? ok() : networkError(),
    );
    const start = Date.now();
    setSystemTime(start);
    for (let i = 0; i < 3; i++) await call(fetchImpl);
    expect(hosts(calls)).toEqual([
      'primary',
      'fallback',
      'primary',
      'fallback',
      'primary',
      'fallback',
    ]);

    calls.length = 0;
    await call(fetchImpl);
    expect(hosts(calls)).toEqual(['fallback']);

    // Cooldown over, primary still down: one probe, then the breaker re-opens.
    setSystemTime(start + cooldownMs + 1);
    calls.length = 0;
    await call(fetchImpl);
    await call(fetchImpl);
    expect(hosts(calls)).toEqual(['primary', 'fallback', 'fallback']);

    // Cooldown over again, primary back: a success resets the breaker.
    primaryUp = true;
    setSystemTime(start + 2 * cooldownMs + 2);
    calls.length = 0;
    expect((await call(fetchImpl)).answers.q?.choice).toBe('primary');
    expect((await call(fetchImpl)).answers.q?.choice).toBe('primary');
    expect(hosts(calls)).toEqual(['primary', 'primary']);
  });

  test('a strict project neither opens nor follows the breaker', async () => {
    configure(1);
    const { calls, fetchImpl } = fakeFetch(networkError);
    await call(fetchImpl, folder).catch(() => undefined);
    await call(fetchImpl, folder).catch(() => undefined);
    expect(hosts(calls)).toEqual(['primary', 'primary']);
    // The breaker is still closed for an off project.
    calls.length = 0;
    await call(fetchImpl);
    expect(hosts(calls)).toEqual(['primary', 'fallback']);
  });

  test('warn logs carry endpoint, kind and status but no request text', async () => {
    configure();
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const { fetchImpl } = fakeFetch(() => new Response('x', { status: 503 }));
      await jevSystemOne({
        state: 'SECRET-STATE',
        questions: { q: { type: 'choice', criteria: ['SECRET-QUESTION'] } },
        projectId: projects.off,
        fetchImpl,
      });
      const entries = warn.mock.calls.map(([fields]) => fields);
      expect(entries).toEqual([
        {
          event: 'jev_attempt_failed',
          endpoint: 'primary',
          kind: 'http',
          status: 503,
          path: '/v1/systemone',
          projectId: projects.off,
        },
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
    } finally {
      warn.mockRestore();
    }
  });

  test('a batch fails over to a fallback without batch support and keeps its order', async () => {
    configure();
    const { calls, fetchImpl } = fakeFetch(
      () => new Response('x', { status: 502 }),
    );
    const states = ['a', 'b', 'c', 'd'];
    const results = await jevSystemOneBatch({
      states,
      questions: request.questions,
      projectId: projects.off,
      batch: true,
      fetchImpl,
    });
    expect(results.map((r) => r.answers.q?.choice)).toEqual(
      states.map((state) => `fallback:${state}`),
    );
    expect(calls[0].url).toBe(`${JEV_URL_FOR_TEST}/v1/systemone/batch`);
    expect(
      calls.slice(1).every((c) => c.url === `${fallbackUrl}/v1/systemone`),
    ).toBe(true);
    expect(calls).toHaveLength(1 + states.length);
  });
});
