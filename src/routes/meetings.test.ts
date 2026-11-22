import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import {
  createSession,
  deleteSession,
  getFullTranscript,
  getSession,
} from '../lib/meeting-recordings.js';
import { initDatabase } from '../db.js';
import { createConversation } from '../modules/chat/db-chats.js';
import { groupArtifactsDir } from '../modules/chat/artifacts.js';
import {
  createUser,
  upsertConversationMember,
  upsertProjectMember,
} from '../modules/knowledge/db-kb.js';
import { loadState, registerGroup } from '../state-manager.js';
import { queueClientEvent } from '../modules/objectives/ws-events.js';
import meetingsRouter, {
  meetingTranscriptEvent,
  transcriptAccess,
} from './meetings.js';

let baseUrl = '';
let server: Server | undefined;
let u1Id = '';
let bobId = '';
let recordingId = '';
let textRecordingId = '';

function postChunk(id: string, bytes: number) {
  const form = new FormData();
  form.append(
    'audio',
    new Blob([new Uint8Array(bytes)], { type: 'audio/ogg' }),
    'chunk.ogg',
  );
  return fetch(`${baseUrl}/api/projects/p1/meetings/record/${id}/chunk`, {
    method: 'POST',
    body: form,
  });
}

describe('meeting recording chunk upload', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
    await loadState();
    u1Id = (await createUser('meet-u1', 'pw', 'user')).id;
    bobId = (await createUser('meet-bob', 'pw', 'user')).id;
    await registerGroup('p1@web', {
      name: 'p1',
      folder: 'p1',
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: u1Id,
    });
    recordingId = createSession({
      conversation_id: (await createConversation('p1')).id,
      group_folder: 'p1',
      user_id: u1Id,
    }).recording_id;
    textRecordingId = createSession({
      conversation_id: (await createConversation('p1')).id,
      group_folder: 'p1',
      user_id: u1Id,
    }).recording_id;
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.authUser = { id: u1Id, username: 'u1', role: 'user' };
      next();
    });
    app.use('/api', meetingsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    deleteSession(recordingId);
    deleteSession(textRecordingId);
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  test('accepts a small chunk and rejects an oversized one with 413 before the session lookup', async () => {
    const ok = await postChunk(recordingId, 64 * 1024);
    expect(ok.status).toBe(200);
    // Unknown session id: 413 (not 404) proves the size cap fires before the lookup.
    const res = await postChunk('missing-session', 9 * 1024 * 1024);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Audio chunk too large' });
  });

  test('appends on-device transcript text without audio and ignores a repeated part', async () => {
    const post = (text: string) =>
      fetch(
        `${baseUrl}/api/projects/p1/meetings/record/${textRecordingId}/transcript`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        },
      );
    expect((await post('Bună ziua tuturor.')).status).toBe(200);
    expect((await post('Bună ziua tuturor.')).status).toBe(200);
    expect((await post('Începem ședința.')).status).toBe(200);
    expect((await post('   ')).status).toBe(400);

    const session = getSession(textRecordingId)!;
    expect(session.all_chunks).toHaveLength(0);
    expect(getFullTranscript(session)).toContain('Bună ziua tuturor.');
    expect(getFullTranscript(session)).toContain('Începem ședința.');
    expect(session.transcript_parts).toHaveLength(2);
  });

  test('on-device transcript text bumps last_activity_at and a >30 min old active session still stops', async () => {
    const session = getSession(textRecordingId)!;
    const now = Date.now();
    session.started_at = new Date(now - 31 * 60_000);
    session.last_activity_at = now - 29 * 60_000;
    const stale = session.last_activity_at;

    // Idle 29 min, just under the limit: accepted, and activity is refreshed.
    const res = await fetch(
      `${baseUrl}/api/projects/p1/meetings/record/${textRecordingId}/transcript`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Continuăm discuția.' }),
      },
    );
    expect(res.status).toBe(200);
    expect(session.last_activity_at).toBeGreaterThan(stale);

    const stop = await fetch(
      `${baseUrl}/api/projects/p1/meetings/record/${textRecordingId}/stop`,
      { method: 'POST' },
    );
    expect(stop.status).toBe(200);

    // Idle > 30 min: the session is gone.
    const idle = createSession({
      conversation_id: (await createConversation('p1')).id,
      group_folder: 'p1',
      user_id: u1Id,
    });
    idle.last_activity_at = Date.now() - 31 * 60_000;
    expect((await postChunk(idle.recording_id, 64 * 1024)).status).toBe(404);
  });

  test('concurrent stops of one recording share one finalization', async () => {
    const conversation = await createConversation('p1');
    const session = createSession({
      conversation_id: conversation.id,
      group_folder: 'p1',
      user_id: u1Id,
    });
    expect((await postChunk(session.recording_id, 64 * 1024)).status).toBe(200);

    const stop = () =>
      fetch(
        `${baseUrl}/api/projects/p1/meetings/record/${session.recording_id}/stop`,
        { method: 'POST' },
      );
    const [a, b] = await Promise.all([stop(), stop()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const bodyA = (await a.json()) as { audio_url?: string };
    expect(await b.json()).toEqual(bodyA);
    expect(bodyA.audio_url).toBeTruthy();

    const files = readdirSync(
      path.join(groupArtifactsDir('p1'), 'meetings'),
    ).filter(
      (f) => f.startsWith(`${conversation.id}-`) && !f.endsWith('.meta.json'),
    );
    expect(files).toHaveLength(1);
  });
});

describe('meeting recording after project access is gone', () => {
  let userServer: Server | undefined;
  let userUrl = '';
  const ids: string[] = [];

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.authUser = { id: u1Id, username: 'u1', role: 'user' };
      next();
    });
    app.use('/api', meetingsRouter);
    await new Promise<void>((resolve) => {
      userServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    userUrl = `http://127.0.0.1:${(userServer!.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const id of ids) deleteSession(id);
    if (userServer) {
      await new Promise<void>((resolve, reject) => {
        userServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  test("a user keeps no control of their own recording in a project they can no longer reach, or through another project's URL", async () => {
    await registerGroup('rev-lost@web', {
      name: 'rev-lost',
      folder: 'rev-lost',
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: bobId,
    });
    const { recording_id } = createSession({
      conversation_id: (await createConversation('rev-lost')).id,
      group_folder: 'rev-lost',
      user_id: u1Id,
    });
    ids.push(recording_id);
    const stop = (folder: string) =>
      fetch(
        `${userUrl}/api/projects/${folder}/meetings/record/${recording_id}/stop`,
        { method: 'POST' },
      );
    expect((await stop('p1')).status).toBe(404);
    expect((await stop('rev-lost')).status).toBe(403);
  });
});

describe('meeting recording access for admins', () => {
  let adminServer: Server | undefined;
  let adminUrl = '';
  const ids: string[] = [];

  beforeAll(async () => {
    for (const [folder, user_id] of [
      ['meet-owned', bobId],
      ['meet-ownerless', undefined],
    ] as const) {
      await registerGroup(`${folder}@web`, {
        name: folder,
        folder,
        trigger: '!',
        added_at: new Date().toISOString(),
        user_id,
      });
    }
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.authUser = { id: 'admin-1', username: 'admin', role: 'admin' };
      next();
    });
    app.use('/api', meetingsRouter);
    await new Promise<void>((resolve) => {
      adminServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    adminUrl = `http://127.0.0.1:${(adminServer!.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const id of ids) deleteSession(id);
    if (adminServer) {
      await new Promise<void>((resolve, reject) => {
        adminServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  test("an admin is refused another user's recording on a project owned by another user but keeps an ownerless one", async () => {
    const stop = async (folder: string) => {
      const { recording_id } = createSession({
        conversation_id: (await createConversation(folder)).id,
        group_folder: folder,
        user_id: bobId,
      });
      ids.push(recording_id);
      return fetch(
        `${adminUrl}/api/projects/${folder}/meetings/record/${recording_id}/stop`,
        { method: 'POST' },
      );
    };
    expect((await stop('meet-owned')).status).toBe(403);
    expect((await stop('meet-ownerless')).status).toBe(200);
  });

  test('a recording cannot be started through the URL of a project the conversation does not belong to', async () => {
    await registerGroup('meet-conv-other@web', {
      name: 'meet-conv-other',
      folder: 'meet-conv-other',
      trigger: '!',
      added_at: new Date().toISOString(),
    });
    const conv = await createConversation('meet-conv-other');
    const res = await fetch(
      `${adminUrl}/api/projects/meet-ownerless/meetings/record`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversation_id: conv.id }),
      },
    );
    expect(res.status).toBe(404);
  });
});

describe('live meeting transcript delivery', () => {
  const registerProject = (folder: string, extra: object = {}) =>
    registerGroup(`${folder}@web`, {
      name: folder,
      folder,
      trigger: '!',
      added_at: new Date().toISOString(),
      ...extra,
    });

  // Delivery as the board performs it: the recipient's access resolved at
  // delivery time, then the unchanged common project filter.
  async function delivered(
    session: { conversation_id: string; group_folder: string },
    userId: string,
  ): Promise<boolean> {
    const event = meetingTranscriptEvent(
      { recording_id: 'rec-ws', ...session } as any,
      false,
      'secret',
    )!;
    expect((event.payload as { project_id?: string }).project_id).toBe(
      session.group_folder,
    );
    const sent: string[] = [];
    const client = {
      readyState: 1,
      __userId: userId,
      send: (value: string) => sent.push(value),
    } as any;
    await queueClientEvent(client, event, (uid) =>
      transcriptAccess(session, uid),
    );
    return sent.length === 1;
  }

  test('reaches only users who can see the recording project or its shared conversation', async () => {
    const member = (await createUser('ws-member', 'pw', 'user')).id;
    const sharee = (await createUser('ws-sharee', 'pw', 'user')).id;
    const otherSharee = (await createUser('ws-other-sharee', 'pw', 'user')).id;
    const outsider = (await createUser('ws-outsider', 'pw', 'user')).id;
    const conv = await createConversation('p1');
    const other = await createConversation('p1');
    await upsertProjectMember(member, 'p1', 'viewer');
    await upsertConversationMember(sharee, conv.id, 'viewer');
    await upsertConversationMember(otherSharee, other.id, 'viewer');
    const session = { conversation_id: conv.id, group_folder: 'p1' };

    expect(
      meetingTranscriptEvent(
        { ...session, recording_id: 'r' } as any,
        false,
        '',
      ),
    ).toBeNull();
    expect(await delivered(session, outsider)).toBe(false);
    expect(await delivered(session, member)).toBe(true);
    expect(await delivered(session, sharee)).toBe(true);
    expect(await delivered(session, otherSharee)).toBe(false);
    // The registered owner has access through ownership.
    expect(await delivered(session, u1Id)).toBe(true);
  });

  test('a personal main reaches its registered owner only, whatever membership rows say', async () => {
    const stray = (await createUser('ws-stray', 'pw', 'user')).id;
    await registerProject('meet-main', { is_main: true, user_id: u1Id });
    await upsertProjectMember(stray, 'meet-main', 'viewer');
    const conv = await createConversation('meet-main');
    await upsertConversationMember(stray, conv.id, 'viewer');
    const session = { conversation_id: conv.id, group_folder: 'meet-main' };
    expect(await delivered(session, u1Id)).toBe(true);
    expect(await delivered(session, stray)).toBe(false);
  });

  test('is dropped when the recording conversation no longer belongs to the folder, admins included', async () => {
    await registerProject('meet-conv-bound');
    const conv = await createConversation('meet-conv-bound');
    const admin = (await createUser('ws-admin', 'pw', 'admin')).id;
    const demoted = (await createUser('ws-demoted', 'pw', 'user')).id;
    const intact = {
      conversation_id: conv.id,
      group_folder: 'meet-conv-bound',
    };
    expect(await delivered(intact, admin)).toBe(true);
    // The role is read at delivery: a former admin of an ownerless project gets nothing.
    expect(await delivered(intact, demoted)).toBe(false);
    // A renamed project whose folder a new project reused, or a deleted conversation.
    expect(await delivered({ ...intact, group_folder: 'p1' }, admin)).toBe(
      false,
    );
    expect(await delivered({ ...intact, conversation_id: 'gone' }, admin)).toBe(
      false,
    );
  });
});
