import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import fsp from 'node:fs/promises';
import os from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCanvas } from '@napi-rs/canvas';
import { initDatabase } from '../db.js';
import { getGroupDir } from '../group-dir.js';
import { groupFsTestHooks } from '../lib/group-fs.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import projectsRouter from './projects.js';

const folder = `project-file-content-${process.pid}`;
const jid = `${folder}@web`;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  await registerGroup(jid, {
    jid,
    name: 'Project file content test',
    folder,
    trigger: '!',
    added_at: new Date().toISOString(),
  });

  const app = express();
  app.use(projectsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await unregisterGroup(jid);
  await fsp.rm(getGroupDir(folder), { recursive: true, force: true });
});

describe('GET /projects/:pid/files/group/content thumbnail errors', () => {
  test('returns 404 when the image disappears after the initial stat', async () => {
    const filePath = `${getGroupDir(folder)}/image.png`;
    const source = createCanvas(4, 4);
    await fsp.mkdir(getGroupDir(folder), { recursive: true });
    await fsp.writeFile(filePath, await source.encode('png'));

    // The image vanishes after the group dir was pinned, before the leaf open.
    groupFsTestHooks.beforeOpen = async (_label, segment) => {
      if (segment === 'image.png') await fsp.unlink(filePath);
    };

    try {
      const response = await fetch(
        `${baseUrl}/projects/${folder}/files/group/content?path=image.png&thumbnail=1`,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'File not found' });
    } finally {
      groupFsTestHooks.beforeOpen = undefined;
    }
  });
});

describe('GET /projects/:pid/files/group/content raw bytes', () => {
  const get = (name: string) =>
    fetch(`${baseUrl}/projects/${folder}/files/group/content?path=${name}`);

  test('sandboxes active content and forces a download', async () => {
    await fsp.mkdir(getGroupDir(folder), { recursive: true });
    await fsp.writeFile(
      `${getGroupDir(folder)}/logo.svg`,
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const response = await get('logo.svg');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe(
      "sandbox; default-src 'none'",
    );
    expect(response.headers.get('content-disposition')).toStartWith(
      'attachment',
    );
    expect(response.headers.get('content-type')).toStartWith('image/svg+xml');
  });

  test('only adds nosniff to a PNG', async () => {
    await fsp.mkdir(getGroupDir(folder), { recursive: true });
    await fsp.writeFile(
      `${getGroupDir(folder)}/pic.png`,
      await createCanvas(4, 4).encode('png'),
    );
    const response = await get('pic.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(response.headers.get('content-type')).toStartWith('image/png');
  });
});

describe('GET /projects/:pid/files/group/content symlinks', () => {
  test('refuses symlinks leaving the group dir and still serves normal files', async () => {
    const root = getGroupDir(folder);
    const outside = await fsp.mkdtemp(`${os.tmpdir()}/group-symlink-outside-`);
    try {
      await fsp.mkdir(root, { recursive: true });
      await fsp.writeFile(`${outside}/secret.txt`, 'TOP-SECRET');
      await fsp.writeFile(`${root}/plain.txt`, 'plain');
      await fsp.symlink(`${outside}/secret.txt`, `${root}/link-out.txt`);
      await fsp.symlink(outside, `${root}/dirlink`);

      const get = (p: string, method = 'GET') =>
        fetch(`${baseUrl}/projects/${folder}/files/group/content?path=${p}`, {
          method,
        });
      for (const p of ['link-out.txt', 'dirlink/secret.txt']) {
        for (const method of ['GET', 'HEAD']) {
          const res = await get(p, method);
          expect(res.status).toBe(400);
          expect(await res.text()).not.toContain('TOP-SECRET');
        }
      }
      const ok = await get('plain.txt');
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { content: string }).content).toBe('plain');
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('GET /projects/:pid/files/group/content folder swap', () => {
  test('a subdir swapped for a link while it is opened never returns the target bytes', async () => {
    const root = getGroupDir(folder);
    const outside = await fsp.mkdtemp(`${os.tmpdir()}/group-swap-outside-`);
    try {
      await fsp.mkdir(`${root}/sub`, { recursive: true });
      await fsp.writeFile(`${root}/sub/note.txt`, 'inside');
      await fsp.writeFile(`${outside}/note.txt`, 'TOP-SECRET');
      let swapped = false;
      groupFsTestHooks.beforeOpen = async (_label, segment) => {
        if (swapped || segment !== 'sub') return;
        swapped = true;
        await fsp.rm(`${root}/sub`, { recursive: true });
        await fsp.symlink(outside, `${root}/sub`);
      };
      const res = await fetch(
        `${baseUrl}/projects/${folder}/files/group/content?path=sub/note.txt`,
      );
      expect(swapped).toBe(true);
      expect([400, 404]).toContain(res.status);
      expect(await res.text()).not.toContain('TOP-SECRET');
    } finally {
      groupFsTestHooks.beforeOpen = undefined;
      await fsp.rm(`${root}/sub`, { recursive: true, force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('HEAD /projects/:pid/files/group/content', () => {
  test('reports the file size, not the GET JSON envelope size', async () => {
    const content = 'hello world\n';
    await fsp.mkdir(getGroupDir(folder), { recursive: true });
    await fsp.writeFile(`${getGroupDir(folder)}/notes.txt`, content);

    const response = await fetch(
      `${baseUrl}/projects/${folder}/files/group/content?path=notes.txt`,
      { method: 'HEAD' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(
      String(Buffer.byteLength(content)),
    );
  });
});

describe('GET /projects/:pid/files/group search scope', () => {
  test('limits search to the requested subdirectory and rejects traversal', async () => {
    const root = getGroupDir(folder);
    const objective = `${root}/objectives/obj-1`;
    await fsp.mkdir(`${objective}/reports`, { recursive: true });
    await fsp.mkdir(`${root}/other`, { recursive: true });
    await fsp.writeFile(`${objective}/reports/morning-brief.md`, '# brief');
    await fsp.writeFile(`${root}/other/brief-outside.md`, '# outside');

    const search = async (query: string) =>
      fetch(`${baseUrl}/projects/${folder}/files/group?${query}`);
    const entries = async (query: string) =>
      ((await (await search(query)).json()) as { entries: unknown[] }).entries;

    expect(await entries('search=brief&path=objectives/obj-1')).toEqual([
      {
        kind: 'file',
        name: 'morning-brief.md',
        path: 'objectives/obj-1/reports/morning-brief.md',
        sizeBytes: '# brief'.length,
      },
    ]);

    expect(
      (await entries('search=brief')).map((e) => (e as { path: string }).path),
    ).toContain('other/brief-outside.md');
    expect(await entries('search=brief&path=objectives/missing')).toEqual([]);
    expect((await search('search=brief&path=../other')).status).toBe(400);
  });
});

describe('GET /projects/:pid/files/group sort params', () => {
  test('rejects an invalid sort or order and accepts valid ones', async () => {
    await fsp.mkdir(getGroupDir(folder), { recursive: true });
    const get = (query: string) =>
      fetch(`${baseUrl}/projects/${folder}/files/group?${query}`);
    for (const query of ['sort=size', 'order=up', 'sort=modified&order=x']) {
      const response = await get(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid sort' });
    }
    expect((await get('sort=modified&order=desc')).status).toBe(200);
  });
});
