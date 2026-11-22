import { describe, test, expect, afterEach } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { buildLimiter } from './rate-limit.js';

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function startApp(handler: express.RequestHandler): Promise<string> {
  const app = express();
  app.set('trust proxy', 1); // honor X-Forwarded-For so tests can vary client IP
  app.post('/login', handler, (_req, res) => res.json({ ok: true }));
  app.post('/login-fail', handler, (_req, res) =>
    res.status(401).json({ error: 'bad creds' }),
  );
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = (server!.address() as { port: number }).port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function post(url: string, ip = '10.0.0.1') {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'X-Forwarded-For': ip },
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

describe('rate limiter', () => {
  test('allows up to max requests, blocks the next', async () => {
    const limiter = buildLimiter({ max: 3, windowMs: 60_000 });
    const url = (await startApp(limiter)) + '/login';

    expect((await post(url)).status).toBe(200);
    expect((await post(url)).status).toBe(200);
    expect((await post(url)).status).toBe(200);
    const blocked = await post(url);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBeDefined();
  });

  test('limits per IP independently', async () => {
    const limiter = buildLimiter({ max: 1, windowMs: 60_000 });
    const url = (await startApp(limiter)) + '/login';

    expect((await post(url, '10.0.0.10')).status).toBe(200);
    expect((await post(url, '10.0.0.10')).status).toBe(429);
    // Different IP gets its own bucket.
    expect((await post(url, '10.0.0.11')).status).toBe(200);
  });

  test('skipSuccessfulRequests only counts failed requests', async () => {
    const limiter = buildLimiter({
      max: 2,
      windowMs: 60_000,
      skipSuccessfulRequests: true,
    });
    const baseUrl = await startApp(limiter);

    // Successful requests don't decrement the budget.
    for (let i = 0; i < 10; i++) {
      expect((await post(baseUrl + '/login')).status).toBe(200);
    }
    // Two failures land within the budget.
    expect((await post(baseUrl + '/login-fail')).status).toBe(401);
    expect((await post(baseUrl + '/login-fail')).status).toBe(401);
    // The third failure is throttled.
    expect((await post(baseUrl + '/login-fail')).status).toBe(429);
  });
});
