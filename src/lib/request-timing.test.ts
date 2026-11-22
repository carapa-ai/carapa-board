import { expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { requestTiming, type RequestTimingLogger } from './request-timing.js';

test('request logging excludes user-supplied query parameters', async () => {
  let resolveLoggedRoute!: (route: unknown) => void;
  const loggedRoute = new Promise<unknown>((resolve) => {
    resolveLoggedRoute = resolve;
  });
  const log: RequestTimingLogger = {
    debug: (fields) => resolveLoggedRoute(fields.route),
    info: (fields) => resolveLoggedRoute(fields.route),
    warn: (fields) => resolveLoggedRoute(fields.route),
  };
  const app = express();
  app.use(requestTiming({ slowMs: 5_000, log, forceEnabled: true }));
  app.get('/q', (_req, res) => res.json({ ok: true }));

  const server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () =>
      resolve(listeningServer),
    );
  });
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(
      `http://127.0.0.1:${port}/q?secret=hunter2&page=3`,
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(await loggedRoute).toBe('/q');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('slow request warn carries loopLagMs', async () => {
  const warned: Record<string, unknown>[] = [];
  const log: RequestTimingLogger = {
    debug: () => {},
    info: () => {},
    warn: (fields) => warned.push(fields),
  };
  const app = express();
  app.use(requestTiming({ slowMs: 1, log, forceEnabled: true }));
  app.get('/slow', (_req, res) => {
    const until = Date.now() + 5;
    while (Date.now() < until);
    res.json({ ok: true });
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/slow`);
    await response.arrayBuffer();
    await new Promise((resolve) => setImmediate(resolve));
    expect(warned).toHaveLength(1);
    expect(warned[0].loopLagMs).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
