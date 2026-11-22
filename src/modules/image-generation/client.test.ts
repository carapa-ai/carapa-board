import { afterEach, describe, expect, test } from 'bun:test';

import { ImageProviderError, callCodex, callGemini } from './client.js';

const originalFetch = globalThis.fetch;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Codex OAuth image client', () => {
  test('generates through the relay with server-controlled model and size', async () => {
    let requestUrl = '';
    let requestBody: any;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await callCodex('a lighthouse', [], '16:9');

    expect(requestUrl).toEndWith('/codex/images/generations');
    expect(requestBody).toMatchObject({
      prompt: 'a lighthouse',
      model: 'gpt-image-2',
      quality: 'auto',
      size: '1536x1024',
      output_format: 'png',
    });
    expect(result.provider).toBe('openai-codex');
    expect(result.mimetype).toBe('image/png');
  });

  test('uses the model chosen by the caller instead of the configured default', async () => {
    let requestBody: any;
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await callCodex('a lighthouse', [], '1:1', undefined, {
      gptModel: 'gpt-image-2.6-flare',
    });

    expect(requestBody.model).toBe('gpt-image-2.6-flare');
    expect(result.model).toBe('gpt-image-2.6-flare');
  });

  test('sends up to five edit references as JSON data URLs through the relay', async () => {
    let requestBody: any;
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const references = Array.from({ length: 5 }, () => ({
      data: png.toString('base64'),
      mimetype: 'image/png' as const,
    }));

    await callCodex('edit these', references, 'auto');

    expect(requestBody.model).toBe('gpt-image-2');
    expect(requestBody.images).toHaveLength(5);
    expect(requestBody.images[0]).toEqual({
      image_url: `data:image/png;base64,${png.toString('base64')}`,
    });
  });

  test('marks auth, quota, endpoint, and server failures as fallback eligible', async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      globalThis.fetch = (async () =>
        new Response('', { status })) as unknown as typeof fetch;
      const error = await callCodex('test', [], 'auto').catch((err) => err);
      expect(error).toBeInstanceOf(ImageProviderError);
      expect(error.fallbackEligible).toBe(true);
    }
  });

  test('does not make validation failures fallback eligible', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: 'not-base64' }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const error = await callCodex('test', [], 'auto').catch((err) => err);
    expect(error).toBeInstanceOf(ImageProviderError);
    expect(error.fallbackEligible).toBe(false);
  });

  test('never falls back when an otherwise eligible status is a safety refusal', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            type: 'image_generation_user_error',
            code: 'content_policy_violation',
            message: 'Request was blocked by safety filters',
          },
        }),
        { status: 403 },
      )) as unknown as typeof fetch;

    const error = await callCodex('test', [], 'auto').catch((err) => err);
    expect(error).toBeInstanceOf(ImageProviderError);
    expect(error.fallbackEligible).toBe(false);
  });
});

describe('Gemini fallback client', () => {
  test('preserves rate-limit status so callers can show an actionable error', async () => {
    globalThis.fetch = (async () =>
      new Response('', { status: 429 })) as unknown as typeof fetch;

    const error = await callGemini('an avatar', [], '1:1', undefined, {
      timeoutMs: 900_000,
    }).catch((err) => err);

    expect(error).toBeInstanceOf(ImageProviderError);
    expect(error.status).toBe(429);
  });

  test('forwards all references through the cloud-image contract', async () => {
    let requestBody: any;
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }) as typeof fetch;

    const result = await callGemini(
      'combine',
      [
        { data: png.toString('base64'), mimetype: 'image/png' },
        { data: png.toString('base64'), mimetype: 'image/png' },
      ],
      '1:1',
    );

    expect(requestBody.images).toHaveLength(2);
    expect(requestBody.aspect_ratio).toBe('1:1');
    expect(result.provider).toBe('gemini');
  });
});
