import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import cors from 'cors';
import express from 'express';
import type { Server } from 'node:http';
import { buildCorsOptions } from './cors.js';

async function listen(corsOrigin: string | undefined) {
  const app = express();
  app.use(cors(buildCorsOptions(corsOrigin)));
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}/ping` };
}

async function acao(url: string, origin?: string) {
  const res = await fetch(url, origin ? { headers: { Origin: origin } } : {});
  expect(res.status).toBe(200);
  return res.headers.get('access-control-allow-origin');
}

describe('CORS_ORIGIN', () => {
  const servers: Server[] = [];
  let unset: string;
  let explicit: string;
  let wildcard: string;

  beforeAll(async () => {
    const [a, b, c] = await Promise.all([
      listen(undefined),
      listen('https://board.example'),
      listen('*'),
    ]);
    servers.push(a.server, b.server, c.server);
    [unset, explicit, wildcard] = [a.url, b.url, c.url];
  });
  afterAll(() => servers.forEach((s) => s.close()));

  test('unset: foreign origins get no allow header; same-origin and app origins work', async () => {
    expect(await acao(unset, 'https://evil.example')).toBeNull();
    expect(await acao(unset)).toBeNull();
    for (const o of [
      'http://localhost',
      'https://localhost',
      'capacitor://localhost',
    ]) {
      expect(await acao(unset, o)).toBe(o);
    }
  });

  test('explicit list keeps its behaviour; * still reflects any origin', async () => {
    expect(await acao(explicit, 'https://board.example')).toBe(
      'https://board.example',
    );
    expect(await acao(explicit, 'https://evil.example')).toBeNull();
    expect(await acao(wildcard, 'https://evil.example')).toBe(
      'https://evil.example',
    );
  });
});
