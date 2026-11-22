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
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { DATA_DIR } from '../config.js';
import { createConversation, getChatMessages, initDatabase } from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { effectiveProjectUploadDir } from '../sandbox/effective-settings.js';
import { getGroupByFolder, loadState } from '../state-manager.js';
import {
  attachWebSocket,
  createWsTicket,
  setSessionVerifier,
} from '../modules/objectives/ws-events.js';
import { signUserJwt, verifyJwt } from '../lib/auth-jwt.js';
import { WebSocket } from 'ws';

setSessionVerifier((session) => verifyJwt(session) !== null);

const runnerAttachments: unknown[] = [];
const runChatAgent = mock(
  async (
    _group: unknown,
    _prompt: string,
    _jid: string,
    _onChunk: unknown,
    _sessionId: unknown,
    _fork?: boolean,
    _conversationId?: string,
    _workDir?: string,
    options?: { attachments?: unknown },
  ) => {
    runnerAttachments.push(options?.attachments);
    return { result: 'ok', telemetry: undefined, isLlm: false };
  },
);
mock.module('../agent-runner.js', () => ({
  runChatAgent,
  resolveChatAgent: (_group: unknown, override?: string | null) =>
    override || 'default',
  ipcRelay: new EventEmitter(),
}));
mock.module('../../agent-runner.js', () => ({
  runChatAgent,
  resolveChatAgent: (_group: unknown, override?: string | null) =>
    override || 'default',
  ipcRelay: new EventEmitter(),
}));
const { default: conversationsRouter } = await import('./conversations.js');
const { getChatAgents } = await import('../lib/chat-agents.js');

describe('POST /projects/:pid/messages attachment paths', () => {
  const projectId = 'attachment-paths-route';
  const otherProjectId = 'attachment-paths-other';
  const cliAgentId = 'attachment-paths-cli';
  let server: Server | undefined;
  let socket: WebSocket | undefined;
  let baseUrl = '';
  let uploadDir = '';
  let outsideDir = '';
  const completed = new EventEmitter();
  let completions = 0;

  beforeAll(async () => {
    await initDatabase(':memory:');
    const handle = drizzleDbRef.current as any;
    const client =
      handle?.$client ?? handle?._?.client ?? handle?.session?.client;
    const now = new Date().toISOString();
    await client.exec(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES ('route-admin-user', 'admin', 'test', 'admin', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    for (const id of [projectId, otherProjectId]) {
      await client.exec(
        `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main)
         VALUES ('${id}', '${id}@web', '${id}', '${id}', '!', '${now}', 0)
         ON CONFLICT (id) DO NOTHING`,
      );
    }
    await loadState();
    getChatAgents().push({
      id: cliAgentId,
      label: 'Attachment paths CLI',
      harnessId: 'codex',
      harnessKind: 'cli',
      modelId: 'default',
      agentCmd: cliAgentId,
      sessionFamily: cliAgentId,
    });
    uploadDir = effectiveProjectUploadDir(
      getGroupByFolder(projectId)!,
      DATA_DIR,
    );
    await fsp.mkdir(uploadDir, { recursive: true });
    outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'attachment-paths-'));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).authUser = {
        id: 'route-admin-user',
        username: 'admin',
        role: 'admin',
      };
      next();
    });
    app.use(conversationsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    attachWebSocket(server!);
    const port = (server!.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    const ticket = createWsTicket(signUserJwt('route-admin-user'));
    socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    socket.on('message', (raw) => {
      if (JSON.parse(String(raw)).type === 'chat_completed') {
        completions++;
        completed.emit('done');
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
  });

  afterAll(async () => {
    socket?.terminate();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    const agents = getChatAgents();
    const index = agents.findIndex((agent) => agent.id === cliAgentId);
    if (index >= 0) agents.splice(index, 1);
    await fsp.rm(outsideDir, { recursive: true, force: true });
    for (const name of await fsp.readdir(uploadDir).catch(() => [])) {
      await fsp.rm(path.join(uploadDir, name), { force: true });
    }
  });

  async function post(attachments: unknown[]) {
    const conversation = await createConversation(projectId);
    const before = completions;
    const res = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Look at the attachment.',
        conversation_id: conversation.id,
        agent_cmd: cliAgentId,
        attachments,
      }),
    });
    if (res.status < 500) {
      while (completions === before) {
        await new Promise((resolve) => completed.once('done', resolve));
      }
    }
    const messages = await getChatMessages(projectId, 100, conversation.id);
    return {
      status: res.status,
      persisted: messages.find((message) => message.role === 'user')
        ?.attachments,
    };
  }

  test('strips a path outside the upload dir and never reads the file', async () => {
    const secret = path.join(outsideDir, 'secret.txt');
    await fsp.writeFile(secret, 'top secret');
    const opened: string[] = [];
    const realOpen = fsp.open.bind(fsp);
    const open = spyOn(fsp, 'open').mockImplementation(((
      file: any,
      ...rest: any[]
    ) => {
      opened.push(String(file));
      return (realOpen as any)(file, ...rest);
    }) as any);
    const readFile = spyOn(fsp, 'readFile');
    const readFileSync = spyOn(fs, 'readFileSync');

    try {
      const { status, persisted } = await post([
        {
          type: 'document',
          mimetype: 'text/plain',
          filename: 'secret.txt',
          path: secret,
        },
        {
          type: 'audio',
          mimetype: 'audio/webm',
          filename: 'secret.webm',
          path: secret,
        },
      ]);

      expect(status).toBe(202);
      expect(persisted).toHaveLength(2);
      expect(persisted?.map((att) => att.filename)).toEqual([
        'secret.txt',
        'secret.webm',
      ]);
      for (const att of persisted ?? []) expect(att.path).toBeUndefined();
      expect(opened).not.toContain(secret);
      for (const call of [...readFile.mock.calls, ...readFileSync.mock.calls]) {
        expect(String(call[0])).not.toBe(secret);
      }
      expect(JSON.stringify(runnerAttachments.at(-1))).not.toContain(secret);
    } finally {
      open.mockRestore();
      readFile.mockRestore();
      readFileSync.mockRestore();
    }
  });

  test('keeps the path of a file the upload endpoint stored', async () => {
    const stored = path.join(uploadDir, `${Date.now()}-0a1b2c3d-note.txt`);
    await fsp.writeFile(stored, 'hello');

    const { status, persisted } = await post([
      {
        type: 'document',
        mimetype: 'text/plain',
        filename: 'note.txt',
        path: stored,
      },
    ]);

    expect(status).toBe(202);
    expect(persisted?.[0]?.path).toBe(stored);
  });

  test('strips a symlink and a path in another project upload dir', async () => {
    const target = path.join(outsideDir, 'target.txt');
    await fsp.writeFile(target, 'outside');
    const link = path.join(uploadDir, `${Date.now()}-1a2b3c4d-link.txt`);
    await fsp.symlink(target, link);
    const otherDir = effectiveProjectUploadDir(
      getGroupByFolder(otherProjectId)!,
      DATA_DIR,
    );
    await fsp.mkdir(otherDir, { recursive: true });
    const foreign = path.join(otherDir, `${Date.now()}-2a2b3c4d-other.txt`);
    await fsp.writeFile(foreign, 'other project');

    try {
      const { status, persisted } = await post([
        { type: 'document', mimetype: 'text/plain', path: link },
        { type: 'document', mimetype: 'text/plain', path: foreign },
      ]);

      expect(status).toBe(202);
      expect(persisted).toHaveLength(2);
      for (const att of persisted ?? []) expect(att.path).toBeUndefined();
    } finally {
      await fsp.rm(foreign, { force: true });
    }
  });

  test('drops an attachment without mimetype instead of failing', async () => {
    const { status, persisted } = await post([
      { type: 'document', filename: 'no-mimetype.txt' },
      { type: 'document', mimetype: 'text/plain', filename: 'kept.txt' },
    ]);

    expect(status).toBe(202);
    expect(persisted?.map((att) => att.filename)).toEqual(['kept.txt']);
  });
});
