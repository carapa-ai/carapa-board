import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import * as db from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import * as groupDir from '../group-dir.js';
import * as stateManager from '../state-manager.js';
import * as effectiveSettings from '../sandbox/effective-settings.js';
import publicConversationsRouter from './public-conversations.js';

const FOLDER = 'public-attach';

describe('GET public share attachments containment', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let token = '';
  let root = '';
  const urls: string[] = [];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-attach-'));
    // Artifacts are opened below GROUPS_DIR, so the group lives there for real.
    const groupRoot = groupDir.getGroupDir(FOLDER);
    fs.rmSync(groupRoot, { recursive: true, force: true });
    const uploadRoot = path.join(root, 'uploads');
    fs.mkdirSync(path.join(groupRoot, 'artifacts', 'docs'), {
      recursive: true,
    });
    fs.mkdirSync(uploadRoot, { recursive: true });
    fs.writeFileSync(path.join(root, 'secret.txt'), 'top secret');
    fs.writeFileSync(path.join(groupRoot, 'secret.txt'), 'group secret');
    fs.writeFileSync(
      path.join(groupRoot, 'artifacts', 'docs', 'ok.txt'),
      'artifact ok',
    );
    fs.writeFileSync(path.join(uploadRoot, 'ok.txt'), 'upload ok');
    fs.writeFileSync(path.join(uploadRoot, 'page.html'), '<script>1</script>');
    fs.symlinkSync(
      path.join(root, 'secret.txt'),
      path.join(groupRoot, 'artifacts', 'link.txt'),
    );
    fs.symlinkSync(
      path.join(root, 'secret.txt'),
      path.join(uploadRoot, 'link.txt'),
    );
    fs.mkdirSync(path.join(root, 'other-project'));
    fs.writeFileSync(
      path.join(root, 'other-project', 'ok.txt'),
      'other project',
    );
    fs.symlinkSync(
      path.join(root, 'other-project'),
      path.join(groupRoot, 'artifacts', 'linked-topic'),
    );

    spyOn(stateManager, 'getGroupByFolder').mockReturnValue({
      folder: FOLDER,
    } as any);
    spyOn(effectiveSettings, 'effectiveProjectUploadDir').mockReturnValue(
      uploadRoot,
    );

    await db.initDatabase(':memory:');
    const handle = drizzleDbRef.current as any;
    const client =
      handle?.$client ?? handle?._?.client ?? handle?.session?.client;
    const now = new Date().toISOString();
    await client.exec(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES ('public-attach-owner', 'public-attach-owner', 'test', 'user', '${now}')`,
    );
    await client.exec(
      `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main, user_id)
       VALUES ('${FOLDER}', '${FOLDER}@web', '${FOLDER}', '${FOLDER}', '!', '${now}', 0, 'public-attach-owner')`,
    );
    const conversation = await db.createConversation(FOLDER);
    token = (
      await db.createOrEnableConversationPublicShare(conversation.id, null)
    ).publicToken;

    urls.push(
      `/artifacts/${FOLDER}/docs/ok.txt`,
      `/artifacts/${FOLDER}/../secret.txt`,
      `/artifacts/${FOLDER}/../../secret.txt`,
      `/artifacts/${FOLDER}/link.txt`,
      `/artifacts/${FOLDER}/linked-topic/ok.txt`,
      `/artifacts/other-folder/docs/ok.txt`,
      `/uploads/${FOLDER}/ok.txt`,
      `/uploads/${FOLDER}/link.txt`,
      `/uploads/${FOLDER}/page.html`,
      `/uploads/other-folder/ok.txt`,
    );
    spyOn(groupDir, 'readChatTranscriptAsync').mockResolvedValue([
      {
        type: 'message',
        id: 'm1',
        role: 'assistant',
        content: 'files',
        timestamp: now,
        attachments: urls.map((url) => ({ type: 'document', url })),
      },
    ] as any);

    const app = express();
    app.use('/api/public', publicConversationsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    mock.restore();
    fs.rmSync(groupDir.getGroupDir(FOLDER), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  const fetchAttachment = (url: string) =>
    fetch(
      `${baseUrl}/api/public/conversations/${token}/attachments/m1/${urls.indexOf(url)}`,
    );

  test('serves normal artifact and upload files', async () => {
    const artifact = await fetchAttachment(`/artifacts/${FOLDER}/docs/ok.txt`);
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get('content-type')).toContain('text/plain');
    expect(await artifact.text()).toBe('artifact ok');
    const upload = await fetchAttachment(`/uploads/${FOLDER}/ok.txt`);
    expect(upload.status).toBe(200);
    expect(upload.headers.get('content-type')).toContain('text/plain');
    expect(await upload.text()).toBe('upload ok');
  });

  test('applies nosniff and sandboxes active content', async () => {
    const res = await fetchAttachment(`/uploads/${FOLDER}/page.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  test.each([
    `/artifacts/${FOLDER}/../secret.txt`,
    `/artifacts/${FOLDER}/../../secret.txt`,
    `/artifacts/${FOLDER}/link.txt`,
    `/artifacts/${FOLDER}/linked-topic/ok.txt`,
    `/artifacts/other-folder/docs/ok.txt`,
    `/uploads/${FOLDER}/link.txt`,
    `/uploads/other-folder/ok.txt`,
  ])('refuses %s', async (url) => {
    const res = await fetchAttachment(url);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Attachment not found' });
  });
});
