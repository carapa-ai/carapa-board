/**
 * End-to-end http-service security checks — boots the real express app
 * against an in-memory DB and verifies the auth gate and artifact serving.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'node:http';
import { initDatabase } from './db.js';
import { drizzleDbRef } from './db/drizzle-client.js';
import { projects, users } from './db/schema.js';
import { eq } from 'drizzle-orm';
import {
  getGroupByFolder,
  loadState,
  registerGroup,
  unregisterGroup,
} from './state-manager.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { appendChatTranscriptEntry } from './group-dir.js';
import { createConversation } from './modules/chat/db-chats.js';
import { upsertConversationMember } from './modules/knowledge/db-kb.js';
import { effectiveProjectUploadDir } from './sandbox/effective-settings.js';
import { artifactThumbnailPath } from './modules/chat/artifact-thumbnails.js';
import { signUserJwt } from './lib/auth-jwt.js';
import { groupFsTestHooks } from './lib/group-fs.js';

const PROJECT_FOLDER = 'http-e2e-share-project';
const OTHER_FOLDER = 'http-e2e-other-project';
const OWNER_ID = 'http-e2e-owner';
const IMPLICIT_ID = 'http-e2e-implicit';

let server: Server;
let baseUrl: string;
let userJwt: string;
async function authedFetch(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any }> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (rest.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const r = await fetch(baseUrl + path, { ...rest, headers });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

beforeAll(async () => {
  await initDatabase(':memory:');
  const db = drizzleDbRef.current;

  // Seed user + project.
  await db
    .insert(users)
    .values({
      id: OWNER_ID,
      username: 'e2e-owner',
      password_hash: 'unused',
      role: 'user',
      created_at: new Date().toISOString(),
      disabled: 0,
    })
    .onConflictDoNothing();
  await db
    .insert(users)
    .values({
      id: IMPLICIT_ID,
      username: 'e2e-implicit',
      password_hash: 'unused',
      role: 'user',
      created_at: new Date().toISOString(),
      disabled: 0,
    })
    .onConflictDoNothing();
  userJwt = signUserJwt(OWNER_ID);
  for (const folder of [PROJECT_FOLDER, OTHER_FOLDER]) {
    await db
      .insert(projects)
      .values({
        id: folder,
        jid: `${folder}@bridge`,
        name: folder,
        folder,
        trigger: '!',
        added_at: new Date().toISOString(),
        is_main: 0,
        user_id: OWNER_ID,
      })
      .onConflictDoNothing();
  }

  await loadState();

  // Import the real app AFTER seeding so its module-level side effects
  // don't race with the DB init.
  const httpService = await import('./http-service.js');
  const { app } = httpService;
  // Artifact routes use state-manager's indexed folder lookup, so register
  // through its public API after http-service finishes loading persisted state.
  for (const folder of [PROJECT_FOLDER, OTHER_FOLDER]) {
    await registerGroup(`${folder}@bridge`, {
      name: folder,
      folder,
      jid: `${folder}@bridge`,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: OWNER_ID,
    });
  }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const folder of [PROJECT_FOLDER, OTHER_FOLDER]) {
    await unregisterGroup(`${folder}@bridge`);
  }
});

describe('http-service end-to-end', () => {
  test('artifact thumbnails are authorized, generated on request, and immutable', async () => {
    const artifactsRoot = path.join(GROUPS_DIR, PROJECT_FOLDER, 'artifacts');
    const sourcePath = path.join(artifactsRoot, 'images', 'lazy.png');
    const thumbnailPath = artifactThumbnailPath(
      artifactsRoot,
      'images/lazy.png',
    );
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.rm(thumbnailPath, { force: true });
    const canvas = createCanvas(640, 320);
    await fs.writeFile(sourcePath, await canvas.encode('png'));

    const unauthorized = await fetch(
      `${baseUrl}/artifacts/${PROJECT_FOLDER}/thumbnails/images/lazy.png.jpg?v=1`,
    );
    expect(unauthorized.status).toBe(403);
    expect(Bun.file(thumbnailPath).size).toBe(0);

    const response = await fetch(
      `${baseUrl}/artifacts/${PROJECT_FOLDER}/thumbnails/images/lazy.png.jpg?v=1`,
      {
        headers: { Authorization: `Bearer ${userJwt}` },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/jpeg');
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(Bun.file(thumbnailPath).size).toBeGreaterThan(0);
    await fs.rm(path.join(GROUPS_DIR, PROJECT_FOLDER, 'artifacts'), {
      recursive: true,
      force: true,
    });
  });

  test('artifact files get nosniff and active content is sandboxed as a download', async () => {
    const artifactsRoot = path.join(GROUPS_DIR, PROJECT_FOLDER, 'artifacts');
    const dir = path.join(artifactsRoot, 'upload', 'conv-1');
    await fs.mkdir(dir, { recursive: true });
    const canvas = createCanvas(8, 8);
    await fs.writeFile(path.join(dir, 'a.png'), await canvas.encode('png'));
    await fs.writeFile(path.join(dir, 'a.pdf'), '%PDF-1.4\n%%EOF\n');
    await fs.writeFile(path.join(dir, 'a.html'), '<script>alert(1)</script>');
    await fs.writeFile(path.join(dir, 'a.svg'), '<svg onload="alert(1)"/>');
    await fs.writeFile(path.join(dir, 'a.xml'), '<a/>');
    const get = (name: string) =>
      fetch(`${baseUrl}/artifacts/${PROJECT_FOLDER}/upload/conv-1/${name}`, {
        headers: { Authorization: `Bearer ${userJwt}` },
      });

    for (const name of ['a.png', 'a.pdf']) {
      const r = await get(name);
      expect(r.status).toBe(200);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('content-disposition') ?? '').not.toContain(
        'attachment',
      );
    }
    for (const name of ['a.html', 'a.svg', 'a.xml']) {
      const r = await get(name);
      expect(r.status).toBe(200);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('content-security-policy')).toContain('sandbox');
      expect(r.headers.get('content-disposition')).toStartWith('attachment');
    }
    await fs.rm(artifactsRoot, { recursive: true, force: true });
  });

  test('artifact reads refuse a topic dir swapped to another project and never write there', async () => {
    const artifactsRoot = path.join(GROUPS_DIR, PROJECT_FOLDER, 'artifacts');
    const otherRoot = path.join(GROUPS_DIR, OTHER_FOLDER, 'artifacts');
    const topic = path.join(artifactsRoot, 'topic');
    const otherTopic = path.join(otherRoot, 'topic');
    const png = await createCanvas(32, 32).encode('png');
    for (const dir of [topic, otherTopic]) {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(path.join(topic, 'a.png'), png);
    await fs.writeFile(path.join(otherTopic, 'a.png'), png);
    await fs.writeFile(path.join(otherTopic, 'secret.txt'), 'other project');
    await fs.writeFile(path.join(topic, 'secret.txt'), 'own project');
    const get = (url: string) =>
      fetch(`${baseUrl}/artifacts/${PROJECT_FOLDER}/${url}`, {
        headers: { Authorization: `Bearer ${userJwt}` },
      });
    try {
      let swapped = false;
      groupFsTestHooks.beforeOpen = async (_label, segment) => {
        if (swapped || segment !== 'topic') return;
        swapped = true;
        await fs.rm(topic, { recursive: true, force: true });
        await fs.symlink(otherTopic, topic);
      };
      const swappedRead = await get('topic/secret.txt');
      groupFsTestHooks.beforeOpen = undefined;
      expect(swapped).toBe(true);
      expect(swappedRead.status).toBe(404);
      expect(await swappedRead.text()).not.toContain('other project');

      // A symlinked `thumbnails` dir must not receive a generated thumbnail.
      await fs.rm(topic, { force: true });
      await fs.mkdir(topic);
      await fs.writeFile(path.join(topic, 'a.png'), png);
      await fs.symlink(otherRoot, path.join(artifactsRoot, 'thumbnails'));
      const thumbnail = await get('thumbnails/topic/a.png.jpg');
      expect(thumbnail.status).toBe(404);
      const queried = await get('topic/a.png?thumbnail=1');
      expect(queried.status).toBe(404);
      expect(await fs.readdir(otherRoot)).toEqual(['topic']);
      expect((await fs.readdir(otherTopic)).sort()).toEqual([
        'a.png',
        'secret.txt',
      ]);
    } finally {
      groupFsTestHooks.beforeOpen = undefined;
      await fs.rm(artifactsRoot, { recursive: true, force: true });
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  describe('chat-only user file access', () => {
    const get = (url: string) =>
      fetch(`${baseUrl}${url}`, {
        headers: { Authorization: `Bearer ${signUserJwt(IMPLICIT_ID)}` },
      });
    const entry = (cid: string, role: string, content: string, extra = {}) => ({
      type: 'message',
      role,
      content,
      conversation_id: cid,
      created_at: new Date().toISOString(),
      ...extra,
    });

    test('uploads are readable only when a conversation of theirs references them', async () => {
      const group = getGroupByFolder(PROJECT_FOLDER)!;
      const uploadRoot = effectiveProjectUploadDir(group, DATA_DIR);
      const convA = await createConversation(PROJECT_FOLDER);
      await upsertConversationMember(IMPLICIT_ID, convA.id, 'viewer');
      await fs.mkdir(uploadRoot, { recursive: true });
      await fs.writeFile(path.join(uploadRoot, 'shown.txt'), 'shown');
      await fs.writeFile(path.join(uploadRoot, 'hidden.txt'), 'hidden');
      try {
        appendChatTranscriptEntry(
          PROJECT_FOLDER,
          convA.id,
          entry(convA.id, 'user', 'see file', {
            attachments: [{ url: `/uploads/${PROJECT_FOLDER}/shown.txt` }],
          }),
        );
        expect((await get(`/uploads/${PROJECT_FOLDER}/shown.txt`)).status).toBe(
          200,
        );
        expect(
          (await get(`/uploads/${PROJECT_FOLDER}/hidden.txt`)).status,
        ).toBe(403);
      } finally {
        await fs.rm(path.join(uploadRoot, 'shown.txt'), { force: true });
        await fs.rm(path.join(uploadRoot, 'hidden.txt'), { force: true });
        await fs.rm(path.join(GROUPS_DIR, PROJECT_FOLDER, 'transcripts'), {
          recursive: true,
          force: true,
        });
      }
    });

    test('artifacts follow the references in their own conversations', async () => {
      const artifactsRoot = path.join(GROUPS_DIR, PROJECT_FOLDER, 'artifacts');
      const png = await createCanvas(32, 32).encode('png');
      const convA = await createConversation(PROJECT_FOLDER);
      const convB = await createConversation(PROJECT_FOLDER);
      await upsertConversationMember(IMPLICIT_ID, convA.id, 'viewer');
      for (const dir of ['images', 'reports', `upload/${convA.id}`]) {
        await fs.mkdir(path.join(artifactsRoot, dir), { recursive: true });
      }
      await fs.mkdir(path.join(artifactsRoot, 'upload', convB.id), {
        recursive: true,
      });
      await fs.writeFile(path.join(artifactsRoot, 'images', 'a.png'), png);
      await fs.writeFile(path.join(artifactsRoot, 'images', 'a'), 'prefix');
      await fs.writeFile(path.join(artifactsRoot, 'reports', 'secret.md'), 's');
      await fs.writeFile(path.join(artifactsRoot, 'reports', 'b.md'), 'b');
      await fs.writeFile(
        path.join(artifactsRoot, 'upload', convA.id, 'x.png'),
        png,
      );
      await fs.writeFile(
        path.join(artifactsRoot, 'upload', convB.id, 'x.png'),
        png,
      );
      try {
        appendChatTranscriptEntry(
          PROJECT_FOLDER,
          convA.id,
          entry(
            convA.id,
            'assistant',
            `Here: ![a](/artifacts/${PROJECT_FOLDER}/images/a.png)`,
          ),
        );
        appendChatTranscriptEntry(
          PROJECT_FOLDER,
          convB.id,
          entry(convB.id, 'assistant', 'Notes: artifacts/reports/b.md'),
        );
        const art = (rel: string) => get(`/artifacts/${PROJECT_FOLDER}/${rel}`);
        expect((await art('images/a.png')).status).toBe(200);
        expect((await art('thumbnails/images/a.png.jpg')).status).toBe(200);
        expect((await art('reports/secret.md')).status).toBe(403);
        expect((await art('reports/b.md')).status).toBe(403);
        expect((await art('images/a')).status).toBe(403);
        expect((await art(`upload/${convA.id}/x.png`)).status).toBe(200);
        expect((await art(`upload/${convB.id}/x.png`)).status).toBe(403);
      } finally {
        await fs.rm(artifactsRoot, { recursive: true, force: true });
        await fs.rm(path.join(GROUPS_DIR, PROJECT_FOLDER, 'transcripts'), {
          recursive: true,
          force: true,
        });
      }
    });
  });

  test('returns presentation identity from auth check', async () => {
    await drizzleDbRef.current
      .update(users)
      .set({ displayName: 'Owner Display' })
      .where(eq(users.id, OWNER_ID));

    const auth = await authedFetch('/api/auth/check', { token: userJwt });
    expect(auth.status).toBe(200);
    expect(auth.body.user).toMatchObject({
      id: OWNER_ID,
      username: 'e2e-owner',
      displayName: 'Owner Display',
      avatarUrl: null,
    });
  });

  test('auth gate: case variants and deleted users are not unauthenticated', async () => {
    const r = await authedFetch('/API/projects');
    expect(r.status).toBe(401);

    // A JWT for a user that no longer exists must not fall back to main.
    const deleted = await authedFetch('/api/projects', {
      token: signUserJwt('http-e2e-deleted-user'),
    });
    expect(deleted.status).toBe(401);
  });
});
