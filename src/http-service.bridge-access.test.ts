/**
 * Upload serving access and hardening, exercised through the real
 * http-service app against an in-memory DB.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { initDatabase } from './db.js';
import { drizzleDbRef } from './db/drizzle-client.js';
import { projectMembers, projects, users } from './db/schema.js';
import { generateAgentToken } from './mcp/auth-tokens.js';
import {
  getGroupByFolder,
  loadState,
  registerGroup,
  unregisterGroup,
} from './state-manager.js';
import { DATA_DIR } from './config.js';
import { effectiveProjectUploadDir } from './sandbox/effective-settings.js';
import { signUserJwt } from './lib/auth-jwt.js';

const P = 'bridge-access-p';
const Q = 'bridge-access-q';
const now = () => new Date().toISOString();

let server: Server;
let baseUrl: string;
const jwt: Record<string, string> = {};

beforeAll(async () => {
  await initDatabase(':memory:');
  const db = drizzleDbRef.current;
  for (const [id, role] of [
    ['ba-owner', 'user'],
    ['ba-admin', 'admin'],
    ['ba-stranger', 'user'],
    ['ba-member', 'user'],
    ['ba-viewer', 'user'],
    ['ba-implicit', 'user'],
  ] as const) {
    await db.insert(users).values({
      id,
      username: id,
      password_hash: 'unused',
      role,
      created_at: now(),
      disabled: 0,
    });
    jwt[id] = signUserJwt(id);
  }
  for (const folder of [P, Q]) {
    await db.insert(projects).values({
      id: folder,
      jid: `${folder}@bridge`,
      name: folder,
      folder,
      trigger: '!',
      added_at: now(),
      is_main: 0,
      user_id: 'ba-owner',
    });
  }
  await db.insert(projectMembers).values([
    {
      user_id: 'ba-member',
      project_id: P,
      access_level: 'editor',
      created_at: now(),
    },
    {
      user_id: 'ba-viewer',
      project_id: P,
      access_level: 'viewer',
      created_at: now(),
    },
  ]);
  await loadState();
  const httpService = await import('./http-service.js');
  for (const folder of [P, Q]) {
    await registerGroup(`${folder}@bridge`, {
      name: folder,
      folder,
      jid: `${folder}@bridge`,
      trigger: '!',
      added_at: now(),
      user_id: 'ba-owner',
    });
  }
  await new Promise<void>((resolve) => {
    server = httpService.app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  for (const folder of [P, Q]) await unregisterGroup(`${folder}@bridge`);
});

describe('GET /uploads/:folder/:filename', () => {
  let uploadDir: string;
  let outsideDir: string;
  const png = Buffer.from('89504e470d0a1a0a00112233', 'hex');
  const get = (name: string, token: string) =>
    fetch(`${baseUrl}/uploads/${P}/${name}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  beforeAll(() => {
    uploadDir = effectiveProjectUploadDir(getGroupByFolder(P)!, DATA_DIR);
    outsideDir = fs.mkdtempSync(path.join(path.dirname(DATA_DIR), 'outside-'));
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, 'real.png'), png);
    fs.writeFileSync(path.join(uploadDir, 'x.html'), '<script>1</script>');
    fs.writeFileSync(path.join(uploadDir, 'x.svg'), '<svg onload="1"/>');
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top-secret');
    fs.symlinkSync(
      path.join(outsideDir, 'secret.txt'),
      path.join(uploadDir, 'escape.png'),
    );
    fs.symlinkSync('real.png', path.join(uploadDir, 'inner.png'));
  });

  afterAll(() => {
    for (const name of [
      'real.png',
      'x.html',
      'x.svg',
      'escape.png',
      'inner.png',
      'pipe.png',
    ])
      fs.rmSync(path.join(uploadDir, name), { force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  test('serves a regular upload, refuses symlinks and FIFOs', async () => {
    const t = await generateAgentToken({
      group_folder: P,
      permissions: { '*': ['*:*'] },
    });
    const ok = await get('real.png', t);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('image/png');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('content-disposition') ?? '').not.toContain(
      'attachment',
    );
    expect(Buffer.from(await ok.arrayBuffer()).equals(png)).toBe(true);

    for (const name of ['x.html', 'x.svg']) {
      const r = await get(name, t);
      expect(r.status).toBe(200);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('content-security-policy')).toContain('sandbox');
      expect(r.headers.get('content-disposition')).toStartWith('attachment');
    }

    for (const name of ['escape.png', 'inner.png', 'missing.png']) {
      const r = await get(name, t);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain('top-secret');
    }

    const fifo = path.join(uploadDir, 'pipe.png');
    if (spawnSync('mkfifo', [fifo]).status === 0) {
      expect((await get('pipe.png', t)).status).toBe(404);
    }

    expect((await get('real.png', jwt['ba-stranger'])).status).toBe(403);
  });
});
