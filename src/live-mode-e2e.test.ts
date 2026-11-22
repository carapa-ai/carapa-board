import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { LiveConversationMetadata } from '../ui/src/lib/live-mode.js';
import { sttTextEvent } from '../ui/src/lib/live-voice-protocol.js';
import { synthesizeLiveStatus } from '../ui/src/lib/live-speech-client.js';
import { speechForLiveActivity } from '../ui/src/lib/live-speech-protocol.js';
import {
  clearLiveActivitiesForTest,
  getLiveActivities,
  stripLiveMarkers,
  upsertLiveActivity,
} from './modules/chat/live-activity.js';
import { filterLiveActivitiesForAccess } from './modules/objectives/ws-events.js';
import { getChatMessages, initDatabase, saveChatMessage } from './db.js';
import { readChatTranscript } from './group-dir.js';

let server: Server;
let wss: WebSocketServer;
let origin: string;
const requests: string[] = [];
const ttsBodies: string[] = [];
const endpointRuns = new Map<string, { state: string; messages: string[] }>();
beforeAll(async () => {
  await initDatabase(':memory:');
  server = createServer((req, res) => {
    const url = req.url || '';
    requests.push(url);
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (url === '/tts') {
        ttsBodies.push(body);
        res.writeHead(200, { 'content-type': 'audio/ogg' });
        res.end('local-audio');
        return;
      }
      const input = body ? JSON.parse(body) : {};
      if (url === '/message') {
        endpointRuns.get(input.conversationId)!.messages.push(input.content);
        upsertLiveActivity({
          folder: input.projectId,
          conversation_id: input.conversationId,
          state: 'working',
          status: 'Instruction received',
        });
        res.writeHead(202).end();
        return;
      }
      if (url === '/stop') {
        endpointRuns.get(input.conversationId)!.state = 'stopped';
        upsertLiveActivity({
          folder: input.projectId,
          conversation_id: input.conversationId,
          state: 'needs_input',
          status: 'Stopped by user',
        });
        res.writeHead(200).end();
        return;
      }
      res.writeHead(404).end();
    });
  });
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/stt') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (client) =>
      wss.emit('connection', client, req),
    );
  });
  wss.on('connection', (client) =>
    client.on('message', () => {
      requests.push('/stt');
      client.send(JSON.stringify({ type: 'partial', text: 'give me status' }));
      client.send(
        JSON.stringify({ type: 'final', text: 'give me status of Beta inbox' }),
      );
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  wss.close();
  server.close();
});

const metadata: LiveConversationMetadata[] = [
  {
    conversationId: 'alpha',
    projectId: 'project',
    projectName: 'Project',
    title: 'Alpha build',
    preview: 'compiling',
    state: 'working',
    status: 'building',
    updatedAt: '2026-07-11',
  },
  {
    conversationId: 'beta',
    projectId: 'project',
    projectName: 'Project',
    title: 'Beta inbox',
    preview: 'waiting',
    state: 'working',
    status: 'waiting',
    updatedAt: '2026-07-11',
  },
];

describe('Live Mode endpoint-mocked end-to-end flow', () => {
  test('routes STT commands across parallel runs and recovers an authorized reconnect snapshot', async () => {
    clearLiveActivitiesForTest();
    requests.length = 0;
    endpointRuns.clear();
    endpointRuns.set('alpha', { state: 'working', messages: [] });
    endpointRuns.set('beta', { state: 'working', messages: [] });
    const socket = new WebSocket(`ws://${origin}/stt`);
    const final = new Promise<string>((resolve, reject) => {
      socket.on('message', (data) => {
        const event = sttTextEvent(JSON.parse(String(data)));
        if (event.final) resolve(event.final);
      });
      socket.on('error', reject);
    });
    await new Promise<void>((resolve) =>
      socket.on('open', () => {
        socket.send(
          JSON.stringify({ type: 'start', protocol: 'carapa.live-stt.v1' }),
        );
        resolve();
      }),
    );
    const spokenCommand = await final;
    socket.close();
    for (const item of metadata)
      upsertLiveActivity({
        folder: item.projectId,
        conversation_id: item.conversationId,
        state: 'working',
        status: item.status,
      });
    expect(spokenCommand).toBe('give me status of Beta inbox');
    await fetch(`http://${origin}/message`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'project',
        content: 'send Beta inbox archive it',
        conversationId: 'beta',
      }),
    });
    await fetch(`http://${origin}/stop`, {
      method: 'POST',
      body: JSON.stringify({ projectId: 'project', conversationId: 'beta' }),
    });
    expect(endpointRuns.get('beta')).toEqual({
      state: 'stopped',
      messages: ['send Beta inbox archive it'],
    });
    expect(endpointRuns.get('alpha')?.state).toBe('working');
    const snapshot = filterLiveActivitiesForAccess(getLiveActivities(), {
      isAdmin: false,
      explicitProjects: new Set(['project']),
      implicitProjectConvIds: new Map(),
    });
    expect(snapshot.map((item) => item.conversation_id).sort()).toEqual([
      'alpha',
      'beta',
    ]);
    expect(
      snapshot.find((item) => item.conversation_id === 'beta')?.state,
    ).toBe('needs_input');
    expect(
      snapshot.find((item) => item.conversation_id === 'alpha')?.state,
    ).toBe('working');
    expect(
      filterLiveActivitiesForAccess(getLiveActivities(), {
        isAdmin: false,
        explicitProjects: new Set(),
        implicitProjectConvIds: new Map([['project', new Set(['alpha'])]]),
      }).map((item) => item.conversation_id),
    ).toEqual(['alpha']);
    const tts = await synthesizeLiveStatus(
      fetch,
      `http://${origin}/tts`,
      'beta',
      'Beta inbox: stopped',
      'registry',
    );
    expect(new TextDecoder().decode(tts.audio)).toBe('local-audio');
    expect(
      requests.every((path) =>
        ['/stt', '/tts', '/message', '/stop'].includes(path),
      ),
    ).toBe(true);
  });

  test('keeps hidden markers and raw output out of persisted prose and production speech input', async () => {
    const longStatus =
      `Inspecting files. ${'Checking another relevant implementation detail. '.repeat(8)}`.trim();
    expect(longStatus.length).toBeGreaterThan(240);
    const raw = `Answer [[live: ${longStatus}]]\n<tool_result>secret-token</tool_result>`;
    const persisted = stripLiveMarkers(raw)
      .content.replace(/<tool_result>[\s\S]*?<\/tool_result>/g, '')
      .trim();
    ttsBodies.length = 0;
    const speech = speechForLiveActivity(
      {
        conversationId: 'alpha',
        title: 'Alpha build',
        state: 'working',
        status: longStatus,
        preview: raw,
      } as any,
      'alpha',
      false,
    )!;
    await synthesizeLiveStatus(
      fetch,
      `http://${origin}/tts`,
      'alpha',
      speech.text,
      'registry',
    );
    await expect(
      synthesizeLiveStatus(
        fetch,
        `http://${origin}/tts`,
        'alpha',
        raw,
        undefined,
      ),
    ).rejects.toThrow('registry status');
    expect(persisted).toBe('Answer');
    expect(persisted).not.toContain('[[live:');
    expect(speech.text).toBe(longStatus);
    expect(ttsBodies.at(-1)).toContain(JSON.stringify(longStatus));
    expect(ttsBodies.at(-1)).not.toContain('secret-token');
    expect(ttsBodies.at(-1)).not.toContain('tool_result');
  });

  test('sanitizes assistant prose at the canonical persistence boundary', async () => {
    const group = `live-privacy-${Date.now()}`;
    const conversationId = `conv-${Date.now()}`;
    const raw =
      'Visible [[live: private status]]<tool_result>secret-token</tool_result> answer';
    await saveChatMessage({
      group_folder: group,
      conversation_id: conversationId,
      role: 'assistant',
      content: raw,
      sender_name: null,
      source: 'web',
      created_at: new Date().toISOString(),
    });
    const stored = await getChatMessages(group, 20, conversationId);
    expect(
      stored.find((message) => message.role === 'assistant')?.content,
    ).toBe('Visible  answer');
    const canonical = JSON.stringify(readChatTranscript(group, conversationId));
    expect(canonical).not.toContain('[[live:');
    expect(canonical).not.toContain('secret-token');
    expect(canonical).not.toContain('tool_result');
  });
});
