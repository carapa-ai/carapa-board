import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import {
  createConversation,
  getConversations,
  getQueuedChatMessageStates,
  initDatabase,
  createUser,
} from '../db.js';
import { signUserJwt } from '../lib/auth-jwt.js';
import { getActiveRunForConversation } from '../db/active-runs.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { readChatTranscript } from '../group-dir.js';
import { isProviderContextEntry } from '../modules/transcripts/transcript-store.js';
import { projects } from '../db/schema.js';
import { getChatAgents } from '../lib/chat-agents.js';
import {
  attachWebSocket,
  createWsTicket,
  getActiveStreamKeyForConv,
  setSessionVerifier,
} from '../modules/objectives/ws-events.js';
import { chatAbortKey, chatRunAbortControllers } from '../sandbox/process.js';
import {
  applyGroupUpdateInMemory,
  registeredGroups,
  unregisterGroup,
} from '../state-manager.js';
import conversationsRouter, {
  setDirectPendingReceiptTestBarrier,
} from './conversations.js';
import { hasOpenDirectLlmDeliveryGate } from '../modules/chat/direct-llm-delivery.js';

type ProviderControl = {
  aborted: Promise<void>;
  complete: (text: string) => void;
};

type WsEvent = {
  type: string;
  payload?: Record<string, unknown>;
};

const projectId = 'route-direct-stop';
const runtimeId = 'route-direct-stop-runtime';
const providerRequests: string[] = [];
const providerControls: ProviderControl[] = [];
const wsEvents: WsEvent[] = [];
const eventWaiters = new Set<() => void>();
let boardServer: Server | undefined;
let boardBaseUrl = '';
let providerServer: Bun.Server<unknown> | undefined;
let socket: WebSocket | undefined;

function waitForEventBoundary(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const check = () => {
      if (!predicate()) return;
      eventWaiters.delete(check);
      resolve();
    };
    eventWaiters.add(check);
  });
}
// The awaited state changes only after a real HTTP request is handled, so poll
// in real time; the deadline is a hang safeguard, not a success criterion.
async function waitForCondition(
  predicate: () => boolean,
  deadlineMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition was not reached');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function notifyEventBoundary(): void {
  for (const waiter of [...eventWaiters]) waiter();
}

function terminalEvents(conversationId: string): WsEvent[] {
  return wsEvents.filter(
    (event) =>
      event.type === 'chat_completed' &&
      event.payload?.conversation_id === conversationId,
  );
}

function stoppedActivityEvents(conversationId: string): WsEvent[] {
  return wsEvents.filter(
    (event) =>
      event.type === 'live_activity' &&
      event.payload?.conversation_id === conversationId &&
      event.payload?.completion_summary === 'Stopped by user.',
  );
}

function canonicalMessages(conversationId: string): Record<string, unknown>[] {
  return readChatTranscript(projectId, conversationId).filter(
    (entry): entry is Record<string, unknown> =>
      !!entry &&
      typeof entry === 'object' &&
      'type' in entry &&
      entry.type === 'message' &&
      !isProviderContextEntry(entry),
  );
}

function createProviderControl(
  request: Request,
  controller: ReadableStreamDefaultController<Uint8Array>,
): ProviderControl {
  const encoder = new TextEncoder();
  let settled = false;
  let resolveAborted!: () => void;
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });
  const finishAbort = () => {
    if (settled) return;
    settled = true;
    resolveAborted();
    notifyEventBoundary();
  };
  request.signal.addEventListener('abort', finishAbort, { once: true });
  controller.enqueue(
    encoder.encode(
      `data: ${JSON.stringify({
        type: 'response.created',
        response: {
          id: `response-${providerControls.length + 1}`,
          object: 'response',
          status: 'in_progress',
          model: 'test-model',
          output: [],
        },
      })}\n\n`,
    ),
  );

  return {
    aborted,
    complete: (text: string) => {
      if (settled) return;
      settled = true;
      const message = {
        id: `message-${providerControls.length + 1}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      };
      for (const event of [
        { type: 'response.output_text.delta', delta: text },
        { type: 'response.output_item.done', item: message },
        {
          type: 'response.completed',
          response: {
            id: `response-${providerControls.length + 1}`,
            object: 'response',
            status: 'completed',
            model: 'test-model',
            output: [message],
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          },
        },
      ]) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
      notifyEventBoundary();
    },
  };
}

async function startConversationRun(content: string) {
  const conversation = await createConversation(projectId);
  const requestIndex = providerControls.length;
  const response = await fetch(
    `${boardBaseUrl}/projects/${projectId}/messages`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content,
        conversation_id: conversation.id,
        agent_cmd: runtimeId,
        clientSubmissionId: `${conversation.id}-initial`,
      }),
    },
  );
  if (response.status !== 202) {
    throw new Error(
      `Run start failed (${response.status}): ${await response.text()}`,
    );
  }
  await waitForEventBoundary(() => providerControls.length > requestIndex);
  return { conversation, control: providerControls[requestIndex]! };
}

describe('Direct-LLM conversation stop lifecycle', () => {
  beforeAll(async () => {
    if (!drizzleDbRef.current) await initDatabase(':memory:');
    registeredGroups[`${projectId}@web`] = {
      name: 'Direct stop route',
      jid: `${projectId}@web`,
      folder: projectId,
      trigger: '!',
      added_at: new Date().toISOString(),
      is_main: false,
      settings: {},
    };
    applyGroupUpdateInMemory(`${projectId}@web`, {});
    await drizzleDbRef.current
      .insert(projects)
      .values({
        id: projectId,
        jid: `${projectId}@web`,
        name: 'Direct stop route',
        folder: projectId,
        trigger: '!',
        added_at: new Date().toISOString(),
        is_main: 0,
      })
      .onConflictDoNothing();

    providerServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        expect(url.pathname).toBe('/v1/responses');
        providerRequests.push(request.url);
        await request.text();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            providerControls.push(createProviderControl(request, controller));
            notifyEventBoundary();
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            connection: 'keep-alive',
          },
        });
      },
    });

    getChatAgents().push({
      id: runtimeId,
      label: 'Direct stop route runtime',
      harnessId: 'direct-stop',
      harnessKind: 'direct',
      modelId: 'test-model',
      model: 'test-model',
      wireApi: 'responses',
      baseUrl: `${providerServer.url}v1`,
      apiKey: 'local-test-key',
      sessionFamily: runtimeId,
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, {
        authUser: {
          username: 'direct-stop-admin',
          role: 'admin',
        },
      });
      next();
    });
    app.use(conversationsRouter);
    boardServer = app.listen(0, '127.0.0.1');
    await once(boardServer, 'listening');
    attachWebSocket(boardServer!);
    boardBaseUrl = `http://127.0.0.1:${(boardServer!.address() as AddressInfo).port}`;

    // WebSocket clients must be users; an admin receives every project event.
    const wsAdmin = await createUser('direct-stop-ws-admin', 'pw', 'admin');
    setSessionVerifier(() => true);
    const ticket = createWsTicket(signUserJwt(wsAdmin.id));
    socket = new WebSocket(
      `${boardBaseUrl.replace('http:', 'ws:')}/api/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    socket.on('message', (data) => {
      wsEvents.push(JSON.parse(String(data)) as WsEvent);
      notifyEventBoundary();
    });
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
  });

  afterAll(async () => {
    socket?.close();
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => socket!.once('close', resolve));
    }
    if (boardServer) {
      await new Promise<void>((resolve, reject) => {
        boardServer!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    providerServer?.stop(true);
    const agents = getChatAgents();
    const index = agents.findIndex((agent) => agent.id === runtimeId);
    if (index >= 0) agents.splice(index, 1);
    await unregisterGroup(`${projectId}@web`);
  });

  test.serial(
    'aborts the provider and settles one terminal lifecycle with an admitted message',
    async () => {
      const { conversation, control } = await startConversationRun(
        'Hold the provider response open.',
      );
      const admittedId = `${conversation.id}-admitted`;
      const admitted = await fetch(
        `${boardBaseUrl}/projects/${projectId}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: 'Reconcile this admitted message after Stop.',
            conversation_id: conversation.id,
            agent_cmd: runtimeId,
            clientSubmissionId: admittedId,
          }),
        },
      );
      expect(await admitted.json()).toMatchObject({
        delivery: 'pending',
        queueOwner: 'direct',
      });

      const stopBody = JSON.stringify({ conversation_id: conversation.id });
      const [firstStop, repeatedStop] = await Promise.all([
        fetch(`${boardBaseUrl}/projects/${projectId}/messages/stop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: stopBody,
        }),
        fetch(`${boardBaseUrl}/projects/${projectId}/messages/stop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: stopBody,
        }),
      ]);
      expect(await firstStop.json()).toEqual({ ok: true, stopped: true });
      expect(await repeatedStop.json()).toEqual({ ok: true, stopped: true });

      await Promise.all([
        control.aborted,
        waitForEventBoundary(
          () => terminalEvents(conversation.id).length === 1,
        ),
        waitForEventBoundary(
          () => stoppedActivityEvents(conversation.id).length >= 2,
        ),
      ]);

      expect(getActiveStreamKeyForConv(conversation.id)).toBeUndefined();
      expect(
        await getActiveRunForConversation(conversation.id),
      ).toBeUndefined();
      expect(
        chatRunAbortControllers.has(
          chatAbortKey(projectId, conversation.id, `${projectId}@web`),
        ),
      ).toBe(false);
      expect(
        (await getConversations(projectId)).find(
          (item) => item.id === conversation.id,
        )?.status,
      ).not.toBe('working');
      expect(terminalEvents(conversation.id)).toHaveLength(1);

      const queued = getQueuedChatMessageStates(projectId, conversation.id);
      expect(queued.released).toContain(admittedId);
      expect(queued.consumed).not.toContain(admittedId);
      const rows = canonicalMessages(conversation.id);
      expect(rows.filter((message) => message.role === 'user')).toHaveLength(2);
      expect(
        rows.filter((message) => message.role === 'assistant'),
      ).toHaveLength(1);
      expect(
        rows.filter((message) => message.content === '⏹ Stopped by user.'),
      ).toHaveLength(1);
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]).toStartWith('http://127.0.0.1:');
    },
  );

  test.serial(
    'drains an admitted receipt before Stop scans terminal releases',
    async () => {
      const requestCountBefore = providerRequests.length;
      const { conversation, control } = await startConversationRun(
        'Keep this provider open across a paused admission.',
      );
      const admittedId = `${conversation.id}-paused-admission`;
      let releaseReceipt!: () => void;
      const receiptReleased = new Promise<void>((resolve) => {
        releaseReceipt = resolve;
      });
      let markReceiptReached!: () => void;
      const receiptReached = new Promise<void>((resolve) => {
        markReceiptReached = resolve;
      });

      setDirectPendingReceiptTestBarrier(async (delivery) => {
        if (
          delivery.conversationId === conversation.id &&
          delivery.messageId === admittedId
        ) {
          markReceiptReached();
          await receiptReleased;
        }
      });

      try {
        const admittedRequest = fetch(
          `${boardBaseUrl}/projects/${projectId}/messages`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              content: 'Persist this receipt before terminal release scanning.',
              conversation_id: conversation.id,
              agent_cmd: runtimeId,
              clientSubmissionId: admittedId,
            }),
          },
        );
        await receiptReached;

        let stopSettled = false;
        const stopRequest = fetch(
          `${boardBaseUrl}/projects/${projectId}/messages/stop`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ conversation_id: conversation.id }),
          },
        ).then((response) => {
          stopSettled = true;
          return response;
        });

        await waitForCondition(
          () => !hasOpenDirectLlmDeliveryGate(conversation.id),
        );
        expect(stopSettled).toBe(false);
        expect(terminalEvents(conversation.id)).toHaveLength(0);

        releaseReceipt();
        const [admitted, stopped] = await Promise.all([
          admittedRequest,
          stopRequest,
        ]);
        expect(await admitted.json()).toMatchObject({
          delivery: 'pending',
          queueOwner: 'direct',
        });
        expect(await stopped.json()).toEqual({ ok: true, stopped: true });
        await Promise.all([
          control.aborted,
          waitForEventBoundary(
            () => terminalEvents(conversation.id).length === 1,
          ),
        ]);

        const queued = getQueuedChatMessageStates(projectId, conversation.id);
        expect(queued.released).toContain(admittedId);
        expect(queued.pending).not.toContain(admittedId);
        expect(queued.consumed).not.toContain(admittedId);
        const transcript = readChatTranscript(projectId, conversation.id);
        expect(
          transcript.filter(
            (entry) =>
              !!entry &&
              typeof entry === 'object' &&
              'type' in entry &&
              entry.type === 'direct_user_pending' &&
              'messageId' in entry &&
              entry.messageId === admittedId,
          ),
        ).toHaveLength(1);
        expect(
          transcript.filter(
            (entry) =>
              !!entry &&
              typeof entry === 'object' &&
              'type' in entry &&
              entry.type === 'queued_user_released' &&
              'messageId' in entry &&
              entry.messageId === admittedId,
          ),
        ).toHaveLength(1);
        expect(terminalEvents(conversation.id)).toHaveLength(1);
        expect(getActiveStreamKeyForConv(conversation.id)).toBeUndefined();
        expect(
          await getActiveRunForConversation(conversation.id),
        ).toBeUndefined();
        const rows = canonicalMessages(conversation.id);
        expect(rows.filter((message) => message.role === 'user')).toHaveLength(
          2,
        );
        expect(
          rows.filter((message) => message.role === 'assistant'),
        ).toHaveLength(1);
        expect(providerRequests).toHaveLength(requestCountBefore + 1);
        expect(providerRequests.at(-1)).toStartWith('http://127.0.0.1:');
      } finally {
        releaseReceipt();
        setDirectPendingReceiptTestBarrier(null);
      }
    },
  );

  test.serial(
    'settles exactly once when Stop races natural provider completion',
    async () => {
      const { conversation, control } = await startConversationRun(
        'Race this provider completion with Stop.',
      );
      const stopRequest = fetch(
        `${boardBaseUrl}/projects/${projectId}/messages/stop`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversation_id: conversation.id }),
        },
      );
      control.complete('Natural provider answer.');
      const stopped = await stopRequest;
      expect(await stopped.json()).toEqual({ ok: true, stopped: true });
      await waitForEventBoundary(
        () => terminalEvents(conversation.id).length === 1,
      );
      await waitForEventBoundary(
        () => stoppedActivityEvents(conversation.id).length >= 1,
      );

      expect(terminalEvents(conversation.id)).toHaveLength(1);
      expect(getActiveStreamKeyForConv(conversation.id)).toBeUndefined();
      expect(
        await getActiveRunForConversation(conversation.id),
      ).toBeUndefined();
      expect(
        (await getConversations(projectId)).find(
          (item) => item.id === conversation.id,
        )?.status,
      ).not.toBe('working');
      const rows = canonicalMessages(conversation.id);
      expect(rows.filter((message) => message.role === 'user')).toHaveLength(1);
      expect(
        rows.filter((message) => message.role === 'assistant'),
      ).toHaveLength(1);
    },
  );
});
