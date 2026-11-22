import { describe, expect, test } from 'bun:test';
import {
  createGroundedSearch,
  type GroundedSearchResult,
} from './grounded-search.js';
import { webSearchDetailed } from './proxy.js';

const REDIRECT =
  'https://vertexaisearch.cloud.google.com/grounding-api-redirect';
const publicHost = async () => ['93.184.216.34'];

function fakeRelay(
  handlers: {
    relay?: () => Response;
    redirect?: (url: string) => Response;
  } = {},
) {
  const calls: string[] = [];
  const fetch = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith(REDIRECT)) {
      expect(init?.redirect).toBe('manual');
      return (
        handlers.redirect?.(url) ??
        new Response(null, {
          status: 302,
          headers: { location: `https://real.example/${url.split('/').pop()}` },
        })
      );
    }
    return (
      handlers.relay?.() ??
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: 'Cosine is supported.' }] },
              groundingMetadata: {
                groundingChunks: [
                  { web: { uri: `${REDIRECT}/a`, title: 'neo4j.com' } },
                  { web: { uri: `${REDIRECT}/b`, title: 'medium.com' } },
                ],
                groundingSupports: [
                  {
                    segment: { text: 'First claim.' },
                    groundingChunkIndices: [0],
                  },
                  {
                    segment: { text: 'Second claim.' },
                    groundingChunkIndices: [0, 1],
                  },
                ],
              },
            },
          ],
        }),
      )
    );
  }) as any;
  return { fetch, calls };
}

describe('createGroundedSearch', () => {
  test('resolves redirects, builds per-source snippets and caches by query', async () => {
    const { fetch, calls } = fakeRelay();
    const search = createGroundedSearch({
      url: 'http://relay/antigravity/',
      model: 'gemini-3-flash',
      fetch,
      resolveHost: publicHost,
    });
    const result = (await search('neo4j cosine')) as GroundedSearchResult;
    expect(result.summary).toBe('Cosine is supported.');
    expect(result.sources).toEqual([
      {
        title: 'neo4j.com',
        url: 'https://real.example/a',
        content: 'First claim. Second claim.',
      },
      {
        title: 'medium.com',
        url: 'https://real.example/b',
        content: 'Second claim.',
      },
    ]);
    expect(calls[0]).toBe(
      'http://relay/antigravity/v1beta/models/gemini-3-flash:generateContent',
    );
    const callCount = calls.length;
    expect(await search(' Neo4j Cosine ')).toEqual(result);
    expect(calls.length).toBe(callCount);
  });

  test('keeps the Google redirect when the target is not public', async () => {
    const { fetch } = fakeRelay({
      redirect: () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest' },
        }),
    });
    const search = createGroundedSearch({
      url: 'http://relay',
      model: 'm',
      fetch,
      resolveHost: publicHost,
    });
    const result = (await search('private redirect')) as GroundedSearchResult;
    expect(result.sources.map((s) => s.url)).toEqual([
      `${REDIRECT}/a`,
      `${REDIRECT}/b`,
    ]);
  });

  test('returns null on 429, malformed bodies and network errors, and when disabled', async () => {
    const cases = [
      fakeRelay({ relay: () => new Response('quota', { status: 429 }) }).fetch,
      fakeRelay({ relay: () => new Response('{}') }).fetch,
      (async () => {
        throw new Error('ECONNREFUSED');
      }) as any,
    ];
    for (const [i, fetch] of cases.entries()) {
      const search = createGroundedSearch({
        url: 'http://relay',
        model: 'm',
        fetch,
        resolveHost: publicHost,
      });
      expect(await search(`failing ${i}`)).toEqual(
        i === 1 ? null : { failure: i === 0 ? 'HTTP 429' : 'request failed' },
      );
    }
    const { fetch, calls } = fakeRelay();
    const disabled = createGroundedSearch({ url: '', model: 'm', fetch });
    expect(await disabled('anything')).toBeNull();
    expect(calls).toEqual([]);
  });

  test('caps calls per minute', async () => {
    const { fetch, calls } = fakeRelay({ relay: () => new Response('{}') });
    const search = createGroundedSearch({
      url: 'http://relay',
      model: 'm',
      fetch,
      resolveHost: publicHost,
    });
    for (let i = 0; i < 15; i++) await search(`cap ${i}`);
    expect(calls.length).toBe(10);
  });
});

describe('webSearchDetailed grounded fallback', () => {
  const realFetch = globalThis.fetch;
  const searxng = (body: unknown, status = 200) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status })) as any;
  };
  const grounded = {
    summary: 'S',
    sources: [{ title: 't', url: 'https://x.test', content: 'c' }],
  };

  test('is used only when SearXNG has no results or is down', async () => {
    try {
      searxng({ results: [], unresponsive_engines: [['brave', 'CAPTCHA']] });
      const used = await webSearchDetailed('q', async () => grounded);
      expect(used.grounded?.summary).toBe('S');
      expect(used.results).toEqual(grounded.sources);

      searxng({
        results: [{ title: 'T', url: 'https://a.test', content: 'C' }],
      });
      let called = false;
      const direct = await webSearchDetailed('q', async () => {
        called = true;
        return grounded;
      });
      expect(called).toBe(false);
      expect(direct.grounded).toBeUndefined();

      searxng({}, 500);
      expect(
        (await webSearchDetailed('q', async () => grounded)).grounded,
      ).toBeDefined();
      await expect(
        webSearchDetailed('q', async () => ({ failure: 'HTTP 429' })),
      ).rejects.toThrow('SearXNG returned 500');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('keeps the SearXNG outcome when the fallback yields nothing', async () => {
    try {
      searxng({ results: [], unresponsive_engines: [['brave', 'CAPTCHA']] });
      const out = await webSearchDetailed('q', async () => null);
      expect(out.results).toEqual([]);
      expect(out.unresponsiveEngines).toEqual([
        { engine: 'brave', reason: 'CAPTCHA' },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
