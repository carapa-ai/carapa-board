import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { initDatabase } from '../db.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import { routeText } from './model-router.js';

const URL = 'http://jev.test';

function answerBody(
  tier: {
    choice: string;
    confidence?: number;
    answer_confidence?: number;
    probabilities?: object;
  },
  sensitive: number,
) {
  return {
    answers: {
      tier: { type: 'choice', ...tier },
      sensitive: { type: 'noul', noul: sensitive },
    },
  };
}

function jsonFetch(body: unknown, status = 200) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const route = (text: string, fetchImpl: typeof fetch, timeoutMs?: number) =>
  routeText(text, { engine: 'jev', url: URL, fetchImpl, timeoutMs });

describe('routeText', () => {
  it('returns a clean fast decision from one Jev call', async () => {
    const { fetchImpl, calls } = jsonFetch(
      answerBody({ choice: 'fast', confidence: 0.93 }, 0.02),
    );
    const decision = await route('rename a variable', fetchImpl);
    expect(decision).toMatchObject({
      tier: 'fast',
      rawTier: 'fast',
      confidence: 0.93,
      sensitive: 0.02,
      reason: 'clean',
    });
    expect(decision?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${URL}/v1/systemone`);
    expect(Object.keys(calls[0].body.questions)).toEqual(['tier', 'sensitive']);
  });

  it('escalates one tier below 0.6 confidence, using probabilities as fallback', async () => {
    const low = jsonFetch(
      answerBody({ choice: 'fast', confidence: 0.37 }, 0.1),
    );
    expect(await route('x', low.fetchImpl)).toMatchObject({
      tier: 'balanced',
      rawTier: 'fast',
      confidence: 0.37,
      reason: 'low-confidence-escalated',
    });

    const probabilities = jsonFetch(
      answerBody(
        { choice: 'balanced', probabilities: { balanced: 0.45, fast: 0.4 } },
        0.1,
      ),
    );
    expect(await route('x', probabilities.fetchImpl)).toMatchObject({
      tier: 'frontier',
      confidence: 0.45,
    });

    // Laya's `confidence` is uncalibrated; `answer_confidence` decides.
    const laya = jsonFetch(
      answerBody(
        { choice: 'fast', confidence: 0.37, answer_confidence: 0.91 },
        0.1,
      ),
    );
    expect(await route('x', laya.fetchImpl)).toMatchObject({
      tier: 'fast',
      confidence: 0.91,
      reason: 'clean',
    });
  });

  it('forces frontier when the request is sensitive', async () => {
    const { fetchImpl } = jsonFetch(
      answerBody({ choice: 'fast', confidence: 0.95 }, 0.99),
    );
    expect(
      await route('change the stripe webhook secret', fetchImpl),
    ).toMatchObject({
      tier: 'frontier',
      rawTier: 'fast',
      sensitive: 0.99,
      reason: 'sensitive-forced',
    });
  });

  it('returns null on timeout', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () =>
          reject(init.signal!.reason),
        );
      })) as unknown as typeof fetch;
    expect(await route('x', fetchImpl, 5)).toBeNull();
  });

  it('returns null on HTTP 503', async () => {
    const { fetchImpl } = jsonFetch({ error: 'unavailable' }, 503);
    expect(await route('x', fetchImpl)).toBeNull();
  });

  it('returns null on a malformed body', async () => {
    const notJson = (async () =>
      new Response('<html>oops</html>')) as unknown as typeof fetch;
    expect(await route('x', notJson)).toBeNull();

    const badTier = jsonFetch(
      answerBody({ choice: 'huge', confidence: 0.9 }, 0),
    );
    expect(await route('x', badTier.fetchImpl)).toBeNull();
  });

  it('does not call Jev when the engine is off or JEV_URL is empty', async () => {
    const { fetchImpl, calls } = jsonFetch(
      answerBody({ choice: 'fast', confidence: 0.9 }, 0),
    );
    expect(
      await routeText('x', { engine: 'off', url: URL, fetchImpl }),
    ).toBeNull();
    expect(
      await routeText('x', { engine: 'jev', url: '', fetchImpl }),
    ).toBeNull();
    expect(await routeText('x', { url: URL, fetchImpl })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  describe('privacy attribution', () => {
    const strictJid = `model-router-strict-${process.pid}@web`;
    const strictFolder = `model-router-strict-${process.pid}`;
    const openJid = `model-router-open-${process.pid}@web`;
    const openFolder = `model-router-open-${process.pid}`;
    const remoteUrl = 'http://hosted-jev.test';
    const body = answerBody({ choice: 'fast', confidence: 0.93 }, 0.02);

    beforeAll(async () => {
      await initDatabase(':memory:');
      await loadState();
    });
    afterAll(async () => {
      await unregisterGroup(strictJid);
      await unregisterGroup(openJid);
    });

    const register = (jid: string, folder: string, strict: boolean) =>
      registerGroup(jid, {
        jid,
        name: folder,
        folder,
        trigger: '@route',
        added_at: new Date().toISOString(),
        settings: strict ? { privacyMode: 'strict' } : {},
      });

    it('keeps the current model without calling a remote Jev for a strict project, while another project still routes', async () => {
      await register(strictJid, strictFolder, true);
      await register(openJid, openFolder, false);

      const refused = jsonFetch(body);
      expect(
        await routeText('x', {
          engine: 'jev',
          url: remoteUrl,
          fetchImpl: refused.fetchImpl,
          projectId: strictFolder,
        }),
      ).toBeNull();
      expect(refused.calls).toHaveLength(0);

      const allowed = jsonFetch(body);
      expect(
        await routeText('x', {
          engine: 'jev',
          url: remoteUrl,
          fetchImpl: allowed.fetchImpl,
          projectId: openFolder,
        }),
      ).toMatchObject({ tier: 'fast' });
      expect(allowed.calls).toHaveLength(1);
    });
  });
});
