import { describe, expect, test } from 'bun:test';
import {
  appendActiveStreamContent,
  activeChatReplayEvents,
  appendTaskStreamEntry,
  captureActiveStreamReplay,
  MAX_ACTIVE_STREAM_CHARS,
  queueClientEvent,
  queueClientReplay,
  shouldReplayActiveStream,
  chatReplayCompleteEvent,
  broadcast,
  getActiveMainStreamBoundaryForConv,
  getActiveStreamBoundaryForConv,
  getViewingDeviceIds,
  isConversationViewedByUser,
  UserAccessCache,
  updateConversationPresence,
} from './ws-events.js';

describe('active WebSocket stream reconnect buffer', () => {
  test('main steering ignores a concurrently active persona boundary', () => {
    const conversationId = 'conversation-main-steering-boundary';
    broadcast({
      type: 'chat_started',
      payload: {
        folder: 'project',
        conversation_id: conversationId,
        streamKey: 'run-main-steering-boundary',
      },
    });
    broadcast({
      type: 'chat_output',
      payload: {
        conversation_id: conversationId,
        streamKey: 'run-main-steering-boundary',
        content: 'main',
      },
    });
    broadcast({
      type: 'chat_persona_started',
      payload: {
        conversation_id: conversationId,
        message: { id: 'persona-message', content: '' },
      },
    });
    broadcast({
      type: 'chat_persona_output',
      payload: {
        conversation_id: conversationId,
        messageId: 'persona-message',
        content: 'persona',
      },
    });

    expect(getActiveStreamBoundaryForConv(conversationId)).toEqual({
      streamKey: 'run-main-steering-boundary',
      targetMessageId: 'persona-message',
      contentOffset: 7,
    });
    expect(getActiveMainStreamBoundaryForConv(conversationId)).toEqual({
      streamKey: 'run-main-steering-boundary',
      contentOffset: 4,
    });

    broadcast({
      type: 'chat_completed',
      payload: {
        conversation_id: conversationId,
        streamKey: 'run-main-steering-boundary',
      },
    });
  });

  test('captures a fixed reconnect boundary before later live chunks arrive', () => {
    const active = {
      startedPayload: {
        folder: 'project',
        conversation_id: 'conversation-1',
        streamKey: 'run-1',
      },
      streamKey: 'run-1',
      content: 'snapshot content',
    };

    const replay = captureActiveStreamReplay([['conversation-1', active]]);
    active.content += ' live continuation';
    active.startedPayload.folder = 'changed-after-capture';

    expect(replay[0]?.[1].content).toBe('snapshot content');
    expect(replay[0]?.[1].startedPayload.folder).toBe('project');
  });

  test('replays the background tasks a reconnecting browser must still see', () => {
    const events = activeChatReplayEvents('conversation-background', {
      startedPayload: {
        folder: 'project',
        conversation_id: 'conversation-background',
        streamKey: 'run-background',
      },
      streamKey: 'run-background',
      content: '',
      backgroundTasks: [{ id: 'a1', description: 'Sleep agent' }],
    });
    expect(events.map((event) => event.type)).toEqual([
      'chat_started',
      'chat_background_tasks',
    ]);
    expect(events[1].payload).toMatchObject({
      conversation_id: 'conversation-background',
      tasks: [{ id: 'a1', description: 'Sleep agent' }],
    });
  });

  test('replays the participant currently streaming on another device', () => {
    const events = activeChatReplayEvents('conversation-persona', {
      startedPayload: {
        folder: 'project',
        conversation_id: 'conversation-persona',
        streamKey: 'run-persona',
        personaDriven: true,
        canonicalPersonaTurns: true,
      },
      streamKey: 'run-persona',
      content: '',
      activePersona: {
        messageId: 'persona-message',
        content: 'Work already streamed',
        startedPayload: {
          folder: 'project',
          conversation_id: 'conversation-persona',
          message: {
            id: 'persona-message',
            sender_name: 'Researcher',
          },
        },
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      'chat_started',
      'chat_persona_started',
      'chat_persona_output',
    ]);
    expect(events[2]?.payload).toMatchObject({
      conversation_id: 'conversation-persona',
      messageId: 'persona-message',
      content: 'Work already streamed',
      contentOffset: 0,
    });
  });

  test('groups interleaved task entries in reconnect snapshots', () => {
    let entries: Array<{
      id: string;
      content: string;
      startOffset: number;
      endOffset: number;
      complete: boolean;
    }> = [];
    for (const [id, content] of [
      ['tool_call:A', 'A-start'],
      ['tool_call:B', 'B-start'],
      ['tool_call:A', 'A-result'],
      ['tool_call:B', 'B-result'],
    ]) {
      const startOffset = entries.at(-1)?.endOffset ?? 0;
      entries = appendTaskStreamEntry(entries, id, content, startOffset);
    }

    expect(entries).toEqual([
      {
        id: 'tool_call:A',
        content: 'A-startA-result',
        startOffset: 0,
        endOffset: 15,
        complete: true,
      },
      {
        id: 'tool_call:B',
        content: 'B-startB-result',
        startOffset: 15,
        endOffset: 30,
        complete: true,
      },
    ]);
  });

  test('retains a contiguous suffix from the oldest open task entry', () => {
    let entries: Array<{
      id: string;
      content: string;
      startOffset: number;
      endOffset: number;
      complete: boolean;
    }> = [];
    entries = appendTaskStreamEntry(
      entries,
      'tool_call:A',
      'A-start',
      0,
      false,
    );
    entries = appendTaskStreamEntry(
      entries,
      'tool_call:B',
      'B'.repeat(40_000),
      7,
      false,
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      'tool_call:A',
      'tool_call:B',
    ]);
    entries = appendTaskStreamEntry(
      entries,
      'tool_call:A',
      'A-result',
      40_007,
      true,
    );
    expect(entries[0]).toMatchObject({
      id: 'tool_call:B',
      complete: false,
    });
    expect(entries.some((entry) => entry.id === 'tool_call:A')).toBe(false);
  });

  test('stamps chat deltas with their absolute stream offsets', () => {
    const conversationId = 'conversation-chat-output-offset';
    broadcast({
      type: 'chat_started',
      payload: {
        folder: 'project',
        conversation_id: conversationId,
        streamKey: 'run-chat-output-offset',
      },
    });
    const first = {
      type: 'chat_output' as const,
      payload: {
        conversation_id: conversationId,
        streamKey: 'run-chat-output-offset',
        content: 'The keyword',
        contentOffset: undefined as number | undefined,
      },
    };
    const second = {
      type: 'chat_output' as const,
      payload: {
        conversation_id: conversationId,
        streamKey: 'run-chat-output-offset',
        content: ' is Bula.',
        contentOffset: undefined as number | undefined,
      },
    };

    broadcast(first);
    broadcast(second);

    expect(first.payload.contentOffset).toBe(0);
    expect(second.payload.contentOffset).toBe(11);
    broadcast({
      type: 'chat_completed',
      payload: {
        conversation_id: conversationId,
        streamKey: 'run-chat-output-offset',
      },
    });
  });

  test('stamps participant deltas with their absolute stream offsets', () => {
    const conversationId = 'conversation-persona-output-offset';
    broadcast({
      type: 'chat_started',
      payload: {
        folder: 'project',
        conversation_id: conversationId,
        streamKey: 'run-persona-output-offset',
      },
    });
    broadcast({
      type: 'chat_persona_started',
      payload: {
        folder: 'project',
        conversation_id: conversationId,
        message: { id: 'persona-message', content: '' },
      },
    });
    const first = {
      type: 'chat_persona_output' as const,
      payload: {
        conversation_id: conversationId,
        messageId: 'persona-message',
        content: 'Partial',
        contentOffset: undefined as number | undefined,
      },
    };
    const second = {
      type: 'chat_persona_output' as const,
      payload: {
        conversation_id: conversationId,
        messageId: 'persona-message',
        content: ' response',
        contentOffset: undefined as number | undefined,
      },
    };

    broadcast(first);
    broadcast(second);

    expect(first.payload.contentOffset).toBe(0);
    expect(second.payload.contentOffset).toBe(7);
    broadcast({
      type: 'chat_completed',
      payload: {
        conversation_id: conversationId,
        streamKey: 'run-persona-output-offset',
      },
    });
  });

  test('tracks the device viewing a conversation until presence is cleared', () => {
    const client = {
      __userId: 'user-1',
      __deviceId: 'device-1',
    } as any;

    updateConversationPresence(client, { conversation_id: 'conversation-1' });
    expect(getViewingDeviceIds('user-1', 'conversation-1')).toEqual(
      new Set(['device-1']),
    );
    expect(getViewingDeviceIds('other-user', 'conversation-1')).toEqual(
      new Set(),
    );
    expect(isConversationViewedByUser('user-1', 'conversation-1')).toBe(true);
    expect(isConversationViewedByUser('other-user', 'conversation-1')).toBe(
      false,
    );

    updateConversationPresence(client, null);
    expect(getViewingDeviceIds('user-1', 'conversation-1')).toEqual(new Set());
    expect(isConversationViewedByUser('user-1', 'conversation-1')).toBe(false);
  });

  test('tracks authenticated viewing even when the socket session has no device id', () => {
    const client = { __userId: 'user-2' } as any;

    updateConversationPresence(client, { conversation_id: 'conversation-2' });
    expect(isConversationViewedByUser('user-2', 'conversation-2')).toBe(true);
    expect(getViewingDeviceIds('user-2', 'conversation-2')).toEqual(new Set());

    updateConversationPresence(client, null);
  });

  test('serializes authenticated event delivery across reversed access lookup timing', async () => {
    const sent: string[] = [];
    const client = {
      readyState: 1,
      __userId: 'user-1',
      send: (value: string) => sent.push(value),
    } as any;
    let lookups = 0;
    let releaseFirst!: () => void;
    const firstLookup = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const access = {
      isAdmin: true,
      explicitProjects: new Set<string>(),
      implicitProjectConvIds: new Map<string, Set<string>>(),
      expires: Date.now() + 1000,
    };
    const loadAccess = async () => {
      lookups++;
      if (lookups === 1) await firstLookup;
      return access;
    };

    queueClientEvent(
      client,
      {
        type: 'run_finished',
        payload: { project_id: 'p', task_id: 't', run_id: 'old' },
      },
      loadAccess,
    );
    const delivered = queueClientEvent(
      client,
      {
        type: 'task_started',
        payload: { project_id: 'p', task_id: 't', run_id: 'new' },
      },
      loadAccess,
    );

    await Promise.resolve();
    expect(sent).toEqual([]);
    releaseFirst();
    await delivered;
    expect(sent.map((value) => JSON.parse(value).type)).toEqual([
      'run_finished',
      'task_started',
    ]);
  });

  test('discards an in-flight access load that overlaps a project rename', async () => {
    const oldProjectId = 'project-before-rename';
    const newProjectId = 'project-after-rename';
    let projects = [oldProjectId];
    let projectLoads = 0;
    let releaseFirstLoad!: () => void;
    let markFirstLoadStarted!: () => void;
    const firstLoadStarted = new Promise<void>((resolve) => {
      markFirstLoadStarted = resolve;
    });
    const firstLoadGate = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    const cache = new UserAccessCache(
      {
        getUserById: async () => ({ role: 'user' }) as any,
        getProjectsForUser: async () => {
          projectLoads++;
          const snapshot = [...projects];
          if (projectLoads === 1) {
            markFirstLoadStarted();
            await firstLoadGate;
          }
          return snapshot;
        },
        getImplicitProjectIdsForUser: async () => [],
        getSharedConversationIds: async () => [],
      },
      30_000,
    );

    const sent: string[] = [];
    const client = {
      readyState: 1,
      __userId: 'rename-race-user',
      send: (value: string) => sent.push(value),
    } as any;
    const delivered = queueClientEvent(
      client,
      {
        type: 'task_updated',
        payload: { project_id: newProjectId, id: 'renamed-task' },
      },
      (userId) => cache.load(userId),
    );
    await firstLoadStarted;
    projects = [newProjectId];
    cache.migrateProject(oldProjectId, newProjectId);
    releaseFirstLoad();
    await delivered;

    expect(projectLoads).toBe(2);
    expect(sent.map((value) => JSON.parse(value).type)).toEqual([
      'task_updated',
    ]);
    const access = await cache.load('rename-race-user');
    expect(access.explicitProjects).toEqual(new Set([newProjectId]));
    expect(access.explicitProjects.has(oldProjectId)).toBe(false);
  });

  test('delivers live events only after reconnect replay finishes', async () => {
    const sent: string[] = [];
    const client = {
      readyState: 1,
      __userId: 'replay-user',
      send: (value: string) => sent.push(JSON.parse(value).type),
    } as any;
    const adminAccess = async () =>
      ({
        isAdmin: true,
        explicitProjects: new Set<string>(),
        implicitProjectConvIds: new Map(),
      }) as any;
    let releaseReplay!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });

    queueClientReplay(client, async () => {
      sent.push('snapshot-started');
      await replayGate;
      sent.push('snapshot-finished');
    });
    const delivered = queueClientEvent(
      client,
      {
        type: 'chat_output',
        payload: {
          conversation_id: 'conversation-1',
          content: ' continuation',
        },
      },
      adminAccess,
    );

    await Promise.resolve();
    expect(sent).toEqual(['snapshot-started']);
    releaseReplay();
    await delivered;
    expect(sent).toEqual([
      'snapshot-started',
      'snapshot-finished',
      'chat_output',
    ]);
  });

  test('retains responses with more than 1,000 small Codex chunks', () => {
    let content = '';
    for (let i = 0; i < 1_500; i++) {
      content = appendActiveStreamContent(content, `${i},`);
    }
    expect(content.startsWith('0,1,2,')).toBe(true);
    expect(content.endsWith('1499,')).toBe(true);
  });

  test('bounds pathological output by characters while retaining the latest tail', () => {
    const prefix = 'a'.repeat(MAX_ACTIVE_STREAM_CHARS);
    const content = appendActiveStreamContent(prefix, 'latest');
    expect(content.length).toBe(MAX_ACTIVE_STREAM_CHARS);
    expect(content.endsWith('latest')).toBe(true);
  });

  test('replays a known conversation when its single-row lookup has no computed status', () => {
    expect(shouldReplayActiveStream({ status: undefined })).toBe(true);
    expect(shouldReplayActiveStream({ status: 'working' })).toBe(true);
    expect(shouldReplayActiveStream({ status: 'finished' })).toBe(false);
    expect(shouldReplayActiveStream(null)).toBe(false);
  });

  test('replay-complete boundary contains only access-filtered active conversations', () => {
    const event = chatReplayCompleteEvent(
      [
        ['allowed-conv', { startedPayload: { folder: 'allowed' } }],
        ['private-conv', { startedPayload: { folder: 'private' } }],
      ],
      (payload) => payload.folder === 'allowed',
    );

    expect(event).toEqual({
      type: 'chat_replay_complete',
      payload: { activeConversationIds: ['allowed-conv'] },
    });
  });
});
