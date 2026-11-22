import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import express from 'express';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import { signUserJwt, verifyJwt } from '../lib/auth-jwt.js';
import { eq, sql } from 'drizzle-orm';

import {
  createConversation,
  createUser,
  saveChatMessage,
  getChatMessages,
  getPendingChatMessages,
  getQueuedChatMessageStates,
  updateConversation,
  getConversations,
  createObjectiveConversation,
  createObjective,
  getObjective,
  createScheduledTask,
  getConversation,
  getAiUserRow,
  getConversationSessionId,
  getTaskById,
  initDatabase,
  insertAiUserTeamRow,
  inviteConversationAiUser,
  listConversationAiUserRows,
  replaceAiUserTeamMembers,
  setConversationAgentCmd,
  setConversationRuntimeSelection,
  setConversationSessionId,
  transitionConversationsFromRemovedWorktree,
  updateConversationWorktreePath,
  setMainConversationAiUser,
  updateScheduledTaskAfterRun,
  insertPublicPromptRequest,
  getPublicPromptRequest,
  createNotificationPayload,
  publishAiUserEmote,
  unpublishAiUserEmote,
  updateAiUserPersonaRow,
} from '../db.js';
import { MAX_HANDOFF_LENGTH } from '../config.js';
import {
  beginDirectFollowupDispatch,
  completeActiveRun,
  getActiveRunById,
  stopClaimedDirectFollowupRuns,
} from '../db/active-runs.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import * as messageSpeech from '../modules/tts/message-speech.js';
import {
  activeRuns,
  aiTurnRuns,
  conversationExecutionLeases,
  conversationLiveQueueItems,
  conversations as conversationRows,
  taskRunLogs,
} from '../db/schema.js';
import {
  getGroupByFolder,
  loadState,
  registeredGroups,
  updateGroup,
} from '../state-manager.js';
import {
  appendChatTranscriptEntry,
  getGroupDir,
  readChatTranscript,
} from '../group-dir.js';
import {
  insertAiTurnRun,
  insertAiUserRow,
} from '../modules/ai-users/db-ai-users.js';
import { getActiveStreamKeyForConv } from '../modules/objectives/ws-events.js';
import { chatAbortKey, chatRunAbortControllers } from '../sandbox/process.js';
import {
  getChatAgents,
  getRuntimeCatalog,
  runtimeSessionKey,
} from '../lib/chat-agents.js';
import {
  getResolvedRuntimeConfig,
  resolveSessionAgentKey,
} from '../lib/resolve-agent-config.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { upsertConversationMember } from '../modules/knowledge/db-kb.js';
import {
  aiUserDirectory,
  removeAiUserEmoteAsset,
  writeImmutableAiUserEmote,
  writeAiUserPrompt,
} from '../modules/ai-users/storage.js';
import { mainPersonaSessionKey } from '../modules/ai-users/session-revision.js';
import {
  type MainAiUserContext,
  resolveMainAiUserContext,
  resolveMainPersonaSession,
} from '../modules/ai-users/orchestrator.js';
import { writeArtifactFile } from '../modules/chat/artifacts.js';
import { initObjectiveFolder } from '../modules/objectives/objective-folder.js';
import { archivedCarapaRunV1Paths } from '../modules/transcripts/carapa-run-v1.js';
import {
  acquireConversationExecutionLease,
  getConversationExecutionLease,
  releaseConversationExecutionLease,
} from '../modules/chat/conversation-execution-lease.js';
import { subscribePublicConversation } from '../modules/chat/public-conversation-events.js';
import { awaitFormResponse } from '../modules/push/pending-responses.js';
import {
  attachWebSocket,
  setSessionVerifier,
  createWsTicket,
} from '../modules/objectives/ws-events.js';

setSessionVerifier((session) => verifyJwt(session) !== null);
const adminWsTicket = () => createWsTicket(signUserJwt('route-admin-user'));

const calls: Array<{
  prompt: string;
  conversationId?: string;
  sessionId: string | null | undefined;
  ephemeral: boolean;
  captureInspection?: boolean;
  allowedToolNames?: string[];
  harnessId?: string;
  harnessKind?: string;
  modelId?: string;
  runtimeModel?: string;
  modelOverride?: string | null;
  reasoningEffort?: string;
  senderUserId?: string | null;
  triggeredByUserId?: string | null;
  triggerSource?: string;
  skipSharedCheckoutLease?: boolean;
  skipBaseBranchSync?: boolean;
  mainPersonaGeneration?: number;
  systemPromptSuffix?: string;
  personaSessionRevision?: string;
  agentId?: string;
  agentCmd?: string;
}> = [];
const runnerEvents = new EventEmitter();
function waitForRunner(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve) => {
    const onEntry = () => {
      if (!predicate()) return;
      runnerEvents.off('entry', onEntry);
      resolve();
    };
    runnerEvents.on('entry', onEntry);
  });
}
let releaseHeldMainTurn: (() => void) | undefined;
let releaseFirstSerialFollowup: (() => void) | undefined;
let releaseSilentPersonaTurn: (() => void) | undefined;
const runChatAgent = mock(
  async (
    _group: { folder?: string },
    prompt: string,
    _jid: string,
    _onChunk: unknown,
    sessionId: string | null | undefined,
    _fork?: boolean,
    _conversationId?: string,
    _workDir?: string,
    options?: {
      captureInspection?: boolean;
      ephemeral?: boolean;
      agentConfig?: {
        id?: string;
        agentCmd?: string;
        allowedToolNames?: string[];
        harnessId?: string;
        harnessKind?: string;
        modelId?: string;
        model?: string;
      };
      model?: string | null;
      reasoning_effort?: string;
      senderUserId?: string | null;
      triggeredByUserId?: string | null;
      triggerSource?: string;
      skipSharedCheckoutLease?: boolean;
      skipBaseBranchSync?: boolean;
      mainPersonaGeneration?: number;
      systemPromptSuffix?: string;
      personaSessionRevision?: string;
      beforeSteeringComplete?: () => void | Promise<void>;
      signal?: AbortSignal;
    },
  ) => {
    calls.push({
      prompt,
      conversationId: _conversationId,
      sessionId,
      ephemeral: options?.ephemeral === true,
      captureInspection: options?.captureInspection,
      allowedToolNames: options?.agentConfig?.allowedToolNames,
      harnessId: options?.agentConfig?.harnessId,
      harnessKind: options?.agentConfig?.harnessKind,
      modelId: options?.agentConfig?.modelId,
      runtimeModel: options?.agentConfig?.model,
      modelOverride: options?.model,
      reasoningEffort: options?.reasoning_effort,
      senderUserId: options?.senderUserId,
      triggeredByUserId: options?.triggeredByUserId,
      triggerSource: options?.triggerSource,
      skipSharedCheckoutLease: options?.skipSharedCheckoutLease,
      skipBaseBranchSync: options?.skipBaseBranchSync,
      mainPersonaGeneration: options?.mainPersonaGeneration,
      systemPromptSuffix: options?.systemPromptSuffix,
      personaSessionRevision: options?.personaSessionRevision,
      agentId: options?.agentConfig?.id,
      agentCmd: options?.agentConfig?.agentCmd,
    });
    runnerEvents.emit('entry');
    if (
      !options?.ephemeral &&
      prompt.includes('Hold this main turn for queued-addressing coverage.') &&
      !prompt.includes('This must be sent as the next turn.')
    ) {
      await new Promise<void>((resolve) => {
        releaseHeldMainTurn = resolve;
        runnerEvents.emit('entry');
      });
    }
    if (
      !options?.ephemeral &&
      prompt.includes('Serial follow-up one must finish first.')
    ) {
      await new Promise<void>((resolve) => {
        releaseFirstSerialFollowup = resolve;
        runnerEvents.emit('entry');
      });
    }
    if (
      !options?.ephemeral &&
      _group?.folder &&
      _conversationId &&
      (prompt.includes('Hold this main turn for queued-addressing coverage.') ||
        prompt.includes('This must be sent as the next turn.') ||
        prompt.includes('This still belongs to the running direct turn.') ||
        prompt.includes(
          'Preserve the follow-up owner after a lost acknowledgement.',
        ))
    ) {
      // Production agent runners append streamed assistant output to the
      // canonical JSONL transcript. This fake runner must model that boundary
      // for ordering assertions because the route's final save intentionally
      // uses skipTranscript to avoid writing the streamed response twice.
      appendChatTranscriptEntry(_group.folder, _conversationId, {
        type: 'message',
        role: 'assistant',
        content: 'ok',
        created_at: new Date().toISOString(),
      });
    }
    if (
      options?.ephemeral &&
      prompt.includes('@Morgan use a tool before answering.')
    ) {
      return {
        result: '> **peek_files**\n\n> inspected files',
        telemetry: undefined,
        isLlm: false,
        inspection: {
          systemPrompt: 'persona system',
          prompt,
          transcript: JSON.stringify({
            type: 'tool_call',
            id: 'call-1',
            status: 'completed',
            name: 'peek_files',
            output: 'inspected files',
          }),
        },
      };
    }
    if (options?.ephemeral && prompt.includes('@Morgan remain silent')) {
      await new Promise<void>((resolve) => {
        releaseSilentPersonaTurn = resolve;
        runnerEvents.emit('entry');
      });
      return { result: '', telemetry: undefined, isLlm: false };
    }
    if (
      options?.ephemeral &&
      prompt.includes('previous tool-assisted attempt')
    ) {
      const final =
        'Morgan summarized the tool findings.\n<!-- talking-stick: stop -->';
      return {
        result: final,
        telemetry: undefined,
        isLlm: false,
        inspection: {
          systemPrompt: 'persona system',
          prompt,
          transcript: JSON.stringify({
            type: 'message',
            id: 'msg-1',
            role: 'assistant',
            content: final,
            status: 'completed',
          }),
        },
      };
    }
    if (prompt.includes('Trigger automatic compaction attribution.')) {
      return {
        result: 'ok',
        telemetry: { tok_context_last: 90, context_size: 100 },
        isLlm: false,
      };
    }
    if (prompt.includes('Single persona high-context check.')) {
      return {
        result: 'High-context single persona response',
        telemetry: { tok_context_last: 90, context_size: 100 },
        isLlm: false,
      };
    }
    if (prompt.includes('Provider failure released tail.')) {
      return {
        result: '⚠️ Provider failed.',
        telemetry: undefined,
        isLlm: true,
        failed: true,
      };
    }
    if (prompt.includes('Early follow-up error released tail.')) {
      throw new Error('early follow-up failure');
    }
    if (prompt.includes('User stop released tail.')) {
      if (_group.folder && _conversationId) {
        appendChatTranscriptEntry(_group.folder, _conversationId, {
          type: 'message',
          role: 'assistant',
          content: '',
          created_at: new Date().toISOString(),
        });
        appendChatTranscriptEntry(_group.folder, _conversationId, {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'stopped-tool-call',
                name: 'peek_files',
                input: { path: 'src' },
              },
            ],
          },
          created_at: new Date().toISOString(),
        });
      }
      return {
        result: '⚠️ Run stopped by user.',
        telemetry: undefined,
        isLlm: true,
      };
    }
    if (
      prompt.includes('Stop this dispatched follow-up before provider work.')
    ) {
      const signal = options?.signal;
      if (!signal) throw new Error('Direct follow-up signal was not installed');
      if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
      return {
        result: '⚠️ Run stopped by user.',
        telemetry: undefined,
        isLlm: true,
      };
    }
    if (
      options?.ephemeral &&
      prompt.includes('Public inspection capture probe')
    ) {
      return {
        result: 'Public persona response',
        telemetry: undefined,
        isLlm: false,
        inspection:
          options.captureInspection === false
            ? undefined
            : {
                systemPrompt: 'captured inspection',
                prompt,
                transcript: 'captured inspection',
              },
      };
    }
    if (!options?.ephemeral && prompt.includes('Marker-only handoff')) {
      return {
        result: '<!-- talking-stick: Morgan -->',
        telemetry: undefined,
        isLlm: false,
      };
    }
    if (!options?.ephemeral) await options?.beforeSteeringComplete?.();
    return {
      result: options?.ephemeral
        ? 'Morgan handled the addressed request.\n<!-- talking-stick: stop -->'
        : 'ok',
      telemetry: undefined,
      isLlm: false,
    };
  },
);

// Keep the HTTP test at the route/runner boundary. The fake runner avoids a
// sandbox process while recording exactly what the route would execute.
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
const { aiUsersAdminRouter } = await import('./ai-users.js');
// Load after the route-level agent-runner mock so recovery uses the same real
// Direct boundary without contacting an external provider.
const {
  claimReleasedDirectFollowup,
  dispatchClaimedDirectFollowup,
  directFollowupRunId,
  enqueuePersistedDirectFollowup,
  recoverDirectFollowups,
} = await import('../modules/chat/direct-followups.js');
const { routeFormResponse } =
  await import('../modules/push/form-response-router.js');
const { handleAckPayloadSession } = await import('./push.js');
const { processMessage: processWhatsAppMessage } =
  await import('../modules/whatsapp/whatsapp-router.js');
const { getMessagingClient } =
  await import('../modules/whatsapp/messaging-client.js');
const { registerWhatsAppMessaging } =
  await import('../modules/whatsapp/index.js');
const { getMessagingProvider, setMessagingProvider } =
  await import('../modules/messaging/registry.js');
const { TOOLSET_MODULES } = await import('../modules/tools/registry.js');
const { runPublicPersonaTurns, setPublicPersonaTurnOverride } =
  await import('../modules/chat/public-persona-runner.js');

describe('POST /projects/:pid/messages runtime handoff', () => {
  const projectId = 'route-runtime-handoff';
  const destinationProjectId = 'route-runtime-handoff-destination';
  const addressedPersonaId = 'route-addressed-morgan';
  const addressedPersonaPresetId = 'route-addressed-persona-preset';
  const completionAgentId = 'route-completion-direct';
  const cliAgentId = 'route-test-cli';
  const qwenAgentId = 'route-qwen-default';
  const codexSolAgentId = 'route-codex-sol';
  async function mainPersonaGeneration(
    conversationId: string,
    context?: MainAiUserContext,
  ): Promise<number> {
    const { mainPersonaGeneration: generation } =
      await resolveMainPersonaSession(
        conversationId,
        getGroupByFolder(projectId)!,
        undefined,
        undefined,
        context,
      );
    return generation;
  }
  let server: Server | undefined;
  let baseUrl = '';
  let eventSocket: WebSocket;
  const boardEvents: Array<{ type: string; payload: Record<string, any> }> = [];
  const boardNotifications = new EventEmitter();
  function waitForBoardEvent(
    predicate: (event: (typeof boardEvents)[number]) => boolean,
  ): Promise<void> {
    if (boardEvents.some(predicate)) return Promise.resolve();
    return new Promise((resolve) => {
      const onEvent = (event: (typeof boardEvents)[number]) => {
        if (!predicate(event)) return;
        boardNotifications.off('event', onEvent);
        resolve();
      };
      boardNotifications.on('event', onEvent);
    });
  }
  function waitForCompletion(conversationId: string, count = 1): Promise<void> {
    return waitForBoardEvent(
      () =>
        boardEvents.filter(
          (event) =>
            event.type === 'chat_completed' &&
            event.payload.conversation_id === conversationId,
        ).length >= count,
    );
  }
  afterEach(() => {
    runnerEvents.removeAllListeners();
    boardNotifications.removeAllListeners();
  });
  test('does not capture or persist inspection for public persona runs', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    await updateGroup(`${projectId}@web`, {
      settings: { defaultMainAiUserId: addressedPersonaId },
    });
    await setMainConversationAiUser(conversation.id, {
      mode: 'persona',
      aiUserId: addressedPersonaId,
    });
    const publicModelId = `public-test-model-${conversation.id}`;
    getChatAgents().push({
      id: `llm:direct:${publicModelId}`,
      label: 'Public privacy test runtime',
      harnessId: 'direct',
      harnessKind: 'direct',
      modelId: publicModelId,
      model: publicModelId,
      baseUrl: 'http://direct.test/v1',
      sessionFamily: `public-privacy-${conversation.id}`,
    });
    const publicPreset = getRuntimeCatalog().presets.find(
      (preset) => preset.id === addressedPersonaPresetId,
    );
    if (publicPreset) {
      publicPreset.selection = { harnessId: 'direct', modelId: publicModelId };
    }
    if (!publicPreset) {
      getRuntimeCatalog().presets.push({
        id: addressedPersonaPresetId,
        label: 'Public privacy test preset',
        selection: { harnessId: 'direct', modelId: publicModelId },
      });
    }

    await runPublicPersonaTurns({
      conversationId: conversation.id,
      interactionId: `public-inspection-${conversation.id}`,
      prompt: 'Public inspection capture probe',
      visitorName: 'Public visitor',
    });

    const publicCalls = calls.filter(
      (call) => call.conversationId === conversation.id && call.ephemeral,
    );
    expect(publicCalls).toHaveLength(1);
    expect(publicCalls[0]?.captureInspection).toBe(false);
    const runs = await drizzleDbRef.current
      .select({ inspection: aiTurnRuns.inspection })
      .from(aiTurnRuns)
      .where(eq(aiTurnRuns.conversationId, conversation.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.inspection).toBeNull();
  });
  test.each([
    ['regular', false],
    ['persona', true],
  ])(
    'admits the next %s message from chat_completed',
    async (_kind, persona) => {
      const conversation = await createConversation(projectId);
      if (persona)
        await inviteConversationAiUser(
          conversation.id,
          addressedPersonaId,
          'route-admin-user',
        );
      const socket = new WebSocket(
        `ws://127.0.0.1:${(server!.address() as AddressInfo).port}/api/ws?ticket=${encodeURIComponent(adminWsTicket())}`,
      );
      const nextResponse = new Promise<number>((resolve, reject) => {
        socket.on('message', async (raw) => {
          const event = JSON.parse(String(raw));
          if (
            event.type === 'chat_completed' &&
            event.payload?.conversation_id === conversation.id
          ) {
            const response = await fetch(
              `${baseUrl}/projects/${projectId}/messages`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  conversation_id: conversation.id,
                  content: 'terminal-boundary follow-up',
                  ...(persona ? { agent_cmd: completionAgentId } : {}),
                }),
              },
            );
            resolve(response.status);
          }
        });
        socket.on('error', reject);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      await fetch(`${baseUrl}/projects/${projectId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversation.id,
          content: persona ? '@Morgan terminal boundary' : 'terminal boundary',
          ...(persona ? { agent_cmd: completionAgentId } : {}),
        }),
      });
      expect(await nextResponse).toBe(202);
      socket.close();
    },
  );
  test('creates active invitations from project defaults', async () => {
    const now = new Date().toISOString();
    const ids = [
      'route-default-main',
      'route-default-direct',
      'route-default-team',
    ];
    for (const id of ids) {
      await insertAiUserRow({
        id,
        name: id,
        identity: id,
        presetId: addressedPersonaPresetId,
        promptPath: `ai-users/${id}/prompt.md`,
        turn: 'after',
        tools: [],
        enabled: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    await insertAiUserTeamRow({
      id: 'route-default-team-id',
      name: 'Route defaults team',
      description: '',
      createdAt: now,
      updatedAt: now,
    });
    await replaceAiUserTeamMembers('route-default-team-id', [
      'route-default-main',
      'route-default-team',
    ]);
    await updateGroup(`${projectId}@web`, {
      settings: {
        defaultMainAiUserId: 'route-default-main',
        defaultInvitedAiUserIds: ['route-default-direct'],
        defaultInvitedAiUserTeamIds: ['route-default-team-id'],
      },
    });
    try {
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/conversations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      expect(response.status).toBe(201);
      const conversation = (await response.json()) as { id: string };
      const invitations = await listConversationAiUserRows(conversation.id);
      expect(invitations.map(({ aiUser }) => aiUser.id).sort()).toEqual([
        'route-default-direct',
        'route-default-team',
      ]);
      expect(
        invitations.every(({ membership }) => membership.status === 'active'),
      ).toBe(true);
    } finally {
      // A failed assertion must not leave a missing default-persona prompt in
      // project settings and turn every later route test into an ENOENT.
      await updateGroup(`${projectId}@web`, { settings: {} });
    }
  });

  test('runs a lone configured main persona once without talking-stick controls', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    await setMainConversationAiUser(conversation.id, {
      mode: 'persona',
      aiUserId: addressedPersonaId,
    });
    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversation.id,
        content: 'Single persona boundary check.',
      }),
    });
    expect(response.status).toBe(202);
    await waitForCompletion(conversation.id, 1);
    const mainCalls = calls.filter(
      (call) => call.conversationId === conversation.id && !call.ephemeral,
    );
    expect(mainCalls).toHaveLength(1);
    expect(mainCalls[0]?.mainPersonaGeneration).toBe(1);
    expect(mainCalls[0]?.prompt).not.toContain('talking-stick');
    expect(mainCalls[0]?.allowedToolNames).not.toContain('register_group');
    expect(
      (await getChatMessages(projectId, 10, conversation.id)).filter(
        (message) => message.role === 'assistant',
      ),
    ).toHaveLength(1);
  });

  test('refreshes a stale persona context after the newer persona commits first', async () => {
    const conversation = await createConversation(projectId);
    const personaBId = `main-persona-race-b-${Date.now()}`;
    const promptPath = await writeAiUserPrompt(
      personaBId,
      '---\nidentity: Current persona\n---\nAnswer as the current persona.',
    );
    const now = new Date().toISOString();
    await insertAiUserRow({
      id: personaBId,
      name: 'Current persona',
      identity: 'Current persona',
      presetId: addressedPersonaPresetId,
      promptPath,
      turn: 'after',
      tools: [],
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    const group = getGroupByFolder(projectId)!;

    try {
      await setMainConversationAiUser(conversation.id, {
        mode: 'persona',
        aiUserId: addressedPersonaId,
      });
      const stalePersonaA = await resolveMainAiUserContext(
        conversation.id,
        group,
      );
      expect(stalePersonaA?.aiUser.id).toBe(addressedPersonaId);
      expect(
        (
          await resolveMainPersonaSession(
            conversation.id,
            group,
            undefined,
            undefined,
            stalePersonaA,
          )
        ).mainPersonaGeneration,
      ).toBe(1);

      await setMainConversationAiUser(conversation.id, {
        mode: 'persona',
        aiUserId: personaBId,
      });
      const committedB = await resolveMainPersonaSession(
        conversation.id,
        group,
      );
      expect(committedB.mainAiUserContext?.aiUser.id).toBe(personaBId);
      expect(committedB.mainPersonaGeneration).toBe(2);

      // Force the rejected ordering: B is durable before delayed R1 submits
      // the A context it observed before the switch.
      const delayedA = await resolveMainPersonaSession(
        conversation.id,
        group,
        undefined,
        undefined,
        stalePersonaA,
      );
      expect(delayedA.mainAiUserContext?.aiUser.id).toBe(personaBId);
      expect(delayedA.mainPersonaGeneration).toBe(2);
      expect(
        (await resolveMainPersonaSession(conversation.id, group))
          .mainPersonaGeneration,
      ).toBe(2);
      expect(await getConversation(conversation.id)).toMatchObject({
        mainAiUserId: personaBId,
      });
      const [persisted] = await drizzleDbRef.current
        .select({
          fingerprint: conversationRows.mainPersonaFingerprint,
          generation: conversationRows.mainPersonaGeneration,
        })
        .from(conversationRows)
        .where(eq(conversationRows.id, conversation.id));
      expect(persisted).toEqual({
        fingerprint: committedB.mainAiUserContext!.sessionFingerprint,
        generation: 2,
      });
    } finally {
      await fs.rm(aiUserDirectory(personaBId), {
        recursive: true,
        force: true,
      });
    }
  });

  test('keeps concurrent persona prompt and row publications coherent', async () => {
    const conversation = await createConversation(projectId);
    const personaId = `main-persona-file-race-${Date.now()}`;
    const promptPath = await writeAiUserPrompt(
      personaId,
      '---\nidentity: Original guide\n---\nKeep the original instructions.',
    );
    const now = new Date().toISOString();
    await insertAiUserRow({
      id: personaId,
      name: 'Publication guide',
      identity: 'Original guide',
      presetId: addressedPersonaPresetId,
      promptPath,
      turn: 'after',
      tools: [],
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    await setMainConversationAiUser(conversation.id, {
      mode: 'persona',
      aiUserId: personaId,
    });
    const group = getGroupByFolder(projectId)!;

    try {
      const original = await resolveMainAiUserContext(conversation.id, group);
      expect(original).toBeDefined();
      expect(
        (
          await resolveMainPersonaSession(
            conversation.id,
            group,
            undefined,
            undefined,
            original,
          )
        ).mainPersonaGeneration,
      ).toBe(1);
      // Reproduce the two-request ordering from production. Both requests
      // write their prompt before either publishes its row, C publishes, then
      // the older B request publishes last. The final effective persona must
      // be wholly B, never B's row metadata paired with C's prompt bytes.
      const promptBPath = await writeAiUserPrompt(
        personaId,
        '---\nidentity: Guide B\n---\nUse only the B instructions.',
      );
      const publishC = await fetch(`${baseUrl}/admin/ai-users/${personaId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Guide C',
          prompt: '---\nidentity: Guide C\n---\nUse only the C instructions.',
        }),
      });
      expect(publishC.status).toBe(200);
      expect(await publishC.json()).toMatchObject({
        name: 'Guide C',
        identity: 'Guide C',
        prompt: expect.stringContaining('Use only the C instructions.'),
        promptPath: expect.not.stringMatching(/\/prompt\.md$/),
      });
      await updateAiUserPersonaRow(personaId, {
        name: 'Guide B',
        promptPath: promptBPath,
        identity: 'Guide B',
        updatedAt: new Date().toISOString(),
      });
      const published = await resolveMainPersonaSession(conversation.id, group);
      expect(published.mainAiUserContext?.aiUser).toMatchObject({
        name: 'Guide B',
        identity: 'Guide B',
        promptPath: promptBPath,
      });
      expect(published.mainAiUserContext?.systemPromptSuffix).toContain(
        'Use only the B instructions.',
      );
      expect(published.mainAiUserContext?.systemPromptSuffix).not.toContain(
        'Use only the C instructions.',
      );
      expect(published.mainPersonaGeneration).toBe(2);
      const [persisted] = await drizzleDbRef.current
        .select({
          fingerprint: conversationRows.mainPersonaFingerprint,
          generation: conversationRows.mainPersonaGeneration,
        })
        .from(conversationRows)
        .where(eq(conversationRows.id, conversation.id));
      expect(persisted).toEqual({
        fingerprint: published.mainAiUserContext!.sessionFingerprint,
        generation: 2,
      });
    } finally {
      await fs.rm(aiUserDirectory(personaId), {
        recursive: true,
        force: true,
      });
    }
  });

  test('changes the effective persona fingerprint when emote instructions change', async () => {
    const conversation = await createConversation(projectId);
    const personaId = `main-emote-revision-${Date.now()}`;
    const promptPath = await writeAiUserPrompt(
      personaId,
      '---\nidentity: Expressive guide\n---\nRespond with care.',
    );
    const now = new Date().toISOString();
    await insertAiUserRow({
      id: personaId,
      name: 'Expressive guide',
      identity: 'Expressive guide',
      presetId: addressedPersonaPresetId,
      promptPath,
      turn: 'after',
      tools: [],
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    await setMainConversationAiUser(conversation.id, {
      mode: 'persona',
      aiUserId: personaId,
    });

    try {
      const group = getGroupByFolder(projectId)!;
      const withoutEmote = await resolveMainAiUserContext(
        conversation.id,
        group,
      );
      const initialGeneration = await mainPersonaGeneration(
        conversation.id,
        withoutEmote,
      );
      expect(initialGeneration).toBe(1);
      expect(await mainPersonaGeneration(conversation.id, withoutEmote)).toBe(
        initialGeneration,
      );
      expect(withoutEmote?.systemPromptSuffix).not.toContain(
        'available visual emotes',
      );

      const emote = await writeImmutableAiUserEmote(
        personaId,
        'Focused',
        '.png',
        Buffer.from('emote'),
      );
      await publishAiUserEmote(personaId, emote, new Date().toISOString());
      const withEmote = await resolveMainAiUserContext(conversation.id, group);
      expect(withEmote?.sessionFingerprint).not.toBe(
        withoutEmote?.sessionFingerprint,
      );
      expect(withEmote?.systemPromptSuffix).toContain(
        'Your available visual emotes are: focused.',
      );
      const emoteGeneration = await mainPersonaGeneration(
        conversation.id,
        withEmote,
      );
      expect(emoteGeneration).toBe(2);

      const regeneratedEmote = await writeImmutableAiUserEmote(
        personaId,
        'Focused',
        '.png',
        Buffer.from('regenerated emote'),
      );
      const published = await publishAiUserEmote(
        personaId,
        regeneratedEmote,
        new Date().toISOString(),
      );
      await removeAiUserEmoteAsset(published!.replaced!);
      const regenerated = await resolveMainAiUserContext(
        conversation.id,
        group,
      );
      expect(regenerated?.sessionFingerprint).toBe(
        withEmote?.sessionFingerprint,
      );
      expect(await mainPersonaGeneration(conversation.id, regenerated)).toBe(
        emoteGeneration,
      );

      const unpublished = await unpublishAiUserEmote(
        personaId,
        'focused',
        new Date().toISOString(),
      );
      await removeAiUserEmoteAsset(unpublished!.removed!);
      const removed = await resolveMainAiUserContext(conversation.id, group);
      expect(removed?.sessionFingerprint).toBe(
        withoutEmote?.sessionFingerprint,
      );
      expect(await mainPersonaGeneration(conversation.id, removed)).toBe(3);
      expect(removed?.systemPromptSuffix).not.toContain(
        'available visual emotes',
      );
    } finally {
      await fs.rm(aiUserDirectory(personaId), {
        recursive: true,
        force: true,
      });
    }
  });

  test('keeps emote routing stable when deletion publication fails and repairs it on retry', async () => {
    const conversation = await createConversation(projectId);
    const personaId = `main-emote-publication-${Date.now()}`;
    const promptPath = await writeAiUserPrompt(
      personaId,
      '---\nidentity: Durable guide\n---\nRespond with care.',
    );
    const now = new Date().toISOString();
    const originalEmote = await writeImmutableAiUserEmote(
      personaId,
      'Focused',
      '.png',
      Buffer.from('emote'),
    );
    await insertAiUserRow({
      id: personaId,
      name: 'Durable guide',
      identity: 'Durable guide',
      presetId: addressedPersonaPresetId,
      promptPath,
      turn: 'after',
      tools: [],
      publishedEmotes: [originalEmote],
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    await setMainConversationAiUser(conversation.id, {
      mode: 'persona',
      aiUserId: personaId,
    });

    let constraintInstalled = false;
    try {
      const group = getGroupByFolder(projectId)!;
      const initial = await resolveMainPersonaSession(conversation.id, group);
      expect(initial.mainPersonaGeneration).toBe(1);
      expect(initial.mainAiUserContext?.emoteNames).toEqual(['focused']);

      // Force publication failures around both production orderings: a new
      // immutable file before its manifest update, and deletion's manifest
      // update before file cleanup. The old asset and routing observation must
      // remain intact until an idempotent retry publishes the deletion.
      await drizzleDbRef.current.execute(
        sql.raw(`
          ALTER TABLE ai_users
          ADD CONSTRAINT test_emote_publication_failure
          CHECK (id <> '${personaId}' OR persona_revision < 1)
        `),
      );
      constraintInstalled = true;
      const candidate = await writeImmutableAiUserEmote(
        personaId,
        'Focused',
        '.png',
        Buffer.from('replacement'),
      );
      await expect(
        publishAiUserEmote(personaId, candidate, new Date().toISOString()),
      ).rejects.toThrow('Failed query: update "ai_users"');
      expect(await getAiUserRow(personaId)).toMatchObject({
        publishedEmotes: [originalEmote],
        personaRevision: 0,
      });
      const stillPublished = await fetch(
        `${baseUrl}/ai-users/${personaId}/emotes/focused`,
      );
      expect(stillPublished.status).toBe(200);
      expect(Buffer.from(await stillPublished.arrayBuffer()).toString()).toBe(
        'emote',
      );
      await removeAiUserEmoteAsset(candidate);

      const failed = await fetch(
        `${baseUrl}/admin/ai-users/${personaId}/emotes/focused`,
        { method: 'DELETE' },
      );
      expect(failed.status).toBe(400);
      expect(await getAiUserRow(personaId)).toMatchObject({
        publishedEmotes: [originalEmote],
        personaRevision: 0,
      });
      const afterFailedDeletion = await fetch(
        `${baseUrl}/ai-users/${personaId}/emotes/focused`,
      );
      expect(afterFailedDeletion.status).toBe(200);

      const afterFailure = await resolveMainPersonaSession(
        conversation.id,
        group,
      );
      expect(afterFailure.mainPersonaGeneration).toBe(1);
      expect(afterFailure.mainAiUserContext?.emoteNames).toEqual(['focused']);

      await drizzleDbRef.current.execute(
        sql`ALTER TABLE ai_users DROP CONSTRAINT test_emote_publication_failure`,
      );
      constraintInstalled = false;
      const retried = await fetch(
        `${baseUrl}/admin/ai-users/${personaId}/emotes/focused`,
        { method: 'DELETE' },
      );
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual({ ok: true });

      const repaired = await resolveMainPersonaSession(conversation.id, group);
      expect(repaired.mainPersonaGeneration).toBe(2);
      expect(repaired.mainAiUserContext?.emoteNames).toEqual([]);
      expect(
        await fetch(`${baseUrl}/ai-users/${personaId}/emotes/focused`),
      ).toMatchObject({ status: 404 });
    } finally {
      if (constraintInstalled) {
        await drizzleDbRef.current.execute(
          sql`ALTER TABLE ai_users DROP CONSTRAINT test_emote_publication_failure`,
        );
      }
      await fs.rm(aiUserDirectory(personaId), {
        recursive: true,
        force: true,
      });
    }
  });

  test('serializes manual persona rounds behind a durable conversation owner', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    await inviteConversationAiUser(
      conversation.id,
      addressedPersonaId,
      'route-admin-user',
    );
    const ownerId = `external-persona-owner-${conversation.id}`;
    expect(
      await acquireConversationExecutionLease(conversation.id, ownerId),
    ).not.toBeNull();
    try {
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/persona-round`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      );
      expect(response.status).toBe(409);
      expect(calls).toHaveLength(0);
      expect(
        await getConversationExecutionLease(conversation.id),
      ).toMatchObject({ ownerId });
    } finally {
      await releaseConversationExecutionLease(conversation.id, ownerId);
    }
  });

  test('recovers an aged terminal lease when a human continues the conversation', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    await saveChatMessage({
      group_folder: projectId,
      role: 'assistant',
      content: 'The previous turn is complete.',
      sender_name: null,
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    const staleOwnerId = `stale-human-owner-${conversation.id}`;
    await acquireConversationExecutionLease(conversation.id, staleOwnerId);
    await drizzleDbRef.current
      .update(conversationExecutionLeases)
      .set({ acquired_at: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(conversationExecutionLeases.conversation_id, conversation.id));
    const staleController = new AbortController();
    chatRunAbortControllers.set(
      chatAbortKey(projectId, conversation.id, `${projectId}@web`),
      staleController,
    );

    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversation.id,
        content: 'Continue after the completed turn',
        agent_cmd: cliAgentId,
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).not.toHaveProperty('delivery');
    expect(staleController.signal.aborted).toBe(true);
    await waitForRunner(() =>
      calls.some((call) =>
        call.prompt.includes('Continue after the completed turn'),
      ),
    );
    expect(
      calls.some((call) =>
        call.prompt.includes('Continue after the completed turn'),
      ),
    ).toBe(true);
  });

  test('serializes objective and form-response producers behind a durable owner', async () => {
    calls.length = 0;
    const objective = await createObjective({
      project_id: projectId,
      title: 'Alternate producer serialization',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      trigger_config: null,
      metadata: null,
      work_dir: null,
      cost_limit_usd: null,
    });
    const objectiveConversation = await createObjectiveConversation(
      projectId,
      objective.id,
    );
    const objectiveOwnerId = `external-objective-owner-${objectiveConversation.id}`;
    await acquireConversationExecutionLease(
      objectiveConversation.id,
      objectiveOwnerId,
    );
    try {
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            objective_id: objective.id,
            content: 'Queue behind the externally owned objective turn.',
            conversation_id: objectiveConversation.id,
            agent_cmd: cliAgentId,
          }),
        },
      );
      expect(response.status).toBe(200);
      const queued = (await response.json()) as {
        delivery: string;
        queueOwner: string;
      };
      expect(queued).toMatchObject({
        delivery: 'queued',
        queueOwner: 'browser',
      });
      expect(calls).toHaveLength(0);
    } finally {
      await releaseConversationExecutionLease(
        objectiveConversation.id,
        objectiveOwnerId,
      );
    }

    const formConversation = await createConversation(projectId);
    const formOwnerId = `external-form-owner-${formConversation.id}`;
    await acquireConversationExecutionLease(formConversation.id, formOwnerId);
    try {
      const now = new Date().toISOString();
      await routeFormResponse(
        {
          id: `form-payload-${formConversation.id}`,
          user_id: 'route-admin-user',
          kind: 'json_form',
          summary: 'Form response serialization',
          content: JSON.stringify({ fields: [{ name: 'answer' }] }),
          action_url: null,
          respond_to_kind: 'chat',
          respond_to_id: formConversation.id,
          respond_to_objective_id: null,
          form_response: null,
          created_at: now,
          delivered_at: null,
          acked_at: null,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        { answer: 'Durably serialized' },
      );
      expect(calls).toHaveLength(0);
      expect(
        (await getChatMessages(projectId, 10, formConversation.id)).some(
          (message) => message.content.includes('Durably serialized'),
        ),
      ).toBe(true);
      expect(
        await getConversationExecutionLease(formConversation.id),
      ).toMatchObject({ ownerId: formOwnerId });
    } finally {
      await releaseConversationExecutionLease(formConversation.id, formOwnerId);
    }
    await waitForRunner(() =>
      calls.some(
        (call) =>
          call.conversationId === formConversation.id &&
          call.prompt.includes('Durably serialized'),
      ),
    );
    expect(
      calls.filter(
        (call) =>
          call.conversationId === formConversation.id &&
          call.prompt.includes('Durably serialized'),
      ),
    ).toHaveLength(1);
  });

  test('lets an admitted form response reuse its generation-scoped native session', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const runtime = getResolvedRuntimeConfig(
      registeredGroups[`${projectId}@web`],
      conversation.runtimeSelection,
      conversation.last_agent_cmd,
    )!;
    const generation = await mainPersonaGeneration(conversation.id);
    await setConversationSessionId(
      conversation.id,
      mainPersonaSessionKey(runtimeSessionKey(runtime), generation),
      'form-response-generation-session',
    );
    const now = new Date().toISOString();

    await routeFormResponse(
      {
        id: `form-native-session-${conversation.id}`,
        user_id: 'route-admin-user',
        kind: 'json_form',
        summary: 'Form response native session reuse',
        content: JSON.stringify({ fields: [{ name: 'answer' }] }),
        action_url: null,
        respond_to_kind: 'chat',
        respond_to_id: conversation.id,
        respond_to_objective_id: null,
        form_response: null,
        created_at: now,
        delivered_at: null,
        acked_at: null,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      { answer: 'Reuse the current native thread' },
    );

    await waitForRunner(() =>
      calls.some(
        (call) =>
          call.conversationId === conversation.id &&
          call.prompt.includes('Reuse the current native thread'),
      ),
    );
    expect(
      calls.find(
        (call) =>
          call.conversationId === conversation.id &&
          call.prompt.includes('Reuse the current native thread'),
      ),
    ).toMatchObject({
      sessionId: undefined,
      mainPersonaGeneration: generation,
    });
  });

  test('keeps a queued form-response runtime binding resolvable after main persona removal', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    await setMainConversationAiUser(conversation.id, {
      mode: 'persona',
      aiUserId: addressedPersonaId,
    });
    const group = registeredGroups[`${projectId}@web`];
    const runtime = getResolvedRuntimeConfig(group);
    expect(runtime?.id).toBeTruthy();
    await setConversationAgentCmd(
      conversation.id,
      `ai-main:${addressedPersonaId}`,
    );
    const ownerId = `external-form-persona-owner-${conversation.id}`;
    await acquireConversationExecutionLease(conversation.id, ownerId);
    const now = new Date().toISOString();
    const payloadId = `form-persona-removal-${conversation.id}`;
    try {
      await routeFormResponse(
        {
          id: payloadId,
          user_id: 'route-admin-user',
          kind: 'json_form',
          summary: 'Queued form response before persona removal',
          content: JSON.stringify({ fields: [{ name: 'answer' }] }),
          action_url: null,
          respond_to_kind: 'chat',
          respond_to_id: conversation.id,
          respond_to_objective_id: null,
          form_response: null,
          created_at: now,
          delivered_at: null,
          acked_at: null,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        { answer: 'Queued before main persona removal' },
      );
      expect(
        readChatTranscript(projectId, conversation.id).find(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            (entry as { type?: unknown }).type === 'direct_user_pending' &&
            (entry as { messageId?: unknown }).messageId === payloadId,
        ),
      ).toMatchObject({
        agentCmd: runtime!.id,
        runtimeSelection: {
          harnessId: runtime!.harnessId,
          modelId: runtime!.modelId,
        },
      });

      await setMainConversationAiUser(conversation.id, { mode: 'none' });
      const removalGeneration = await mainPersonaGeneration(conversation.id);
      expect(removalGeneration).toBe(2);
      await releaseConversationExecutionLease(conversation.id, ownerId);
      await waitForRunner(() =>
        calls.some(
          (call) =>
            call.conversationId === conversation.id &&
            call.prompt.includes('Queued before main persona removal'),
        ),
      );
      const launched = calls.find(
        (call) =>
          call.conversationId === conversation.id &&
          call.prompt.includes('Queued before main persona removal'),
      );
      expect(launched).toMatchObject({
        agentId: runtime!.id,
        mainPersonaGeneration: removalGeneration,
      });
      expect(launched?.systemPromptSuffix).toBeUndefined();
    } finally {
      await releaseConversationExecutionLease(conversation.id, ownerId);
    }
  });

  test('does not enqueue a form response already consumed by its waiting agent', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const payload = await createNotificationPayload({
      user_id: 'route-admin-user',
      kind: 'json_form',
      summary: 'Waited form response',
      content: JSON.stringify({
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      }),
      respond_to: { kind: 'chat', id: conversation.id },
    });
    const waiting = awaitFormResponse(payload.id, 1_000);
    let responseBody: unknown;

    await handleAckPayloadSession(
      {
        authUser: { id: 'route-admin-user' },
        params: { id: payload.id },
        body: { form_response: { answer: 'Handled by the awaiter' } },
      },
      { json: (value: unknown) => (responseBody = value) },
      () => {
        throw new Error('authenticated request unexpectedly fell through');
      },
    );

    expect(responseBody).toEqual({ ok: true });
    expect(await waiting).toEqual({
      status: 'submitted',
      values: { answer: 'Handled by the awaiter' },
    });
    await waitForBoardEvent(
      (event) =>
        event.type === 'chat_message' &&
        event.payload.message?.id === payload.id,
    );
    expect(
      (await getChatMessages(projectId, 10, conversation.id)).some(
        (message) => message.id === payload.id,
      ),
    ).toBe(true);
    expect(calls).toHaveLength(0);
    expect(
      readChatTranscript(projectId, conversation.id).some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'direct_user_pending' &&
          'messageId' in entry &&
          entry.messageId === payload.id,
      ),
    ).toBe(false);
  });

  test('executes an accepted WhatsApp turn exactly once after lease contention', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const ownerId = `external-whatsapp-owner-${conversation.id}`;
    await acquireConversationExecutionLease(conversation.id, ownerId);
    const timestamp = new Date(Date.now() + 60_000).toISOString();
    const remoteMessage = {
      id: `whatsapp-contention-${conversation.id}`,
      chat_id: `${projectId}@web`,
      sender: 'visitor@wa',
      sender_name: 'WhatsApp visitor',
      content: '!accepted WhatsApp contention turn',
      timestamp,
    };
    const previousProvider = getMessagingProvider();
    const previousTools = TOOLSET_MODULES.project_setup;
    registerWhatsAppMessaging();
    const client = getMessagingClient() as any;
    const originalGetMessagesSince = client.getMessagesSince;
    const originalSendMessage = client.sendMessage;
    const outbound: Array<{ jid: string; text: string }> = [];
    const delivered = Promise.withResolvers<void>();
    client.getMessagesSince = async () => [remoteMessage];
    client.sendMessage = async (jid: string, text: string) => {
      outbound.push({ jid, text });
      delivered.resolve();
    };
    try {
      expect(await processWhatsAppMessage(remoteMessage)).toBe(true);
      expect(
        calls.filter((call) => call.conversationId === conversation.id),
      ).toHaveLength(0);
      await releaseConversationExecutionLease(conversation.id, ownerId);
      await delivered.promise;
      expect(
        calls.filter(
          (call) =>
            call.conversationId === conversation.id &&
            call.prompt.includes('accepted WhatsApp contention turn'),
        ),
      ).toHaveLength(1);
      expect(outbound).toHaveLength(1);
      expect(outbound[0]).toMatchObject({
        jid: `${projectId}@web`,
      });
      expect(outbound[0].text).toEndWith(': ok');
    } finally {
      client.getMessagesSince = originalGetMessagesSince;
      client.sendMessage = originalSendMessage;
      setMessagingProvider(previousProvider);
      TOOLSET_MODULES.project_setup = previousTools;
      await releaseConversationExecutionLease(conversation.id, ownerId);
    }
  });

  test('keeps a queued WhatsApp runtime binding resolvable after main persona removal', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    await setMainConversationAiUser(conversation.id, {
      mode: 'persona',
      aiUserId: addressedPersonaId,
    });
    const group = registeredGroups[`${projectId}@web`];
    const runtime = getResolvedRuntimeConfig(group);
    expect(runtime?.id).toBeTruthy();
    const ownerId = `external-whatsapp-persona-owner-${conversation.id}`;
    await acquireConversationExecutionLease(conversation.id, ownerId);
    const remoteMessage = {
      id: `whatsapp-persona-removal-${conversation.id}`,
      chat_id: `${projectId}@web`,
      sender: 'visitor@wa',
      sender_name: 'WhatsApp visitor',
      content: '!queued before main persona removal',
      timestamp: new Date(Date.now() + 90_000).toISOString(),
    };
    const previousProvider = getMessagingProvider();
    const previousTools = TOOLSET_MODULES.project_setup;
    registerWhatsAppMessaging();
    const client = getMessagingClient() as any;
    const originalGetMessagesSince = client.getMessagesSince;
    const originalSendMessage = client.sendMessage;
    const delivered = Promise.withResolvers<void>();
    client.getMessagesSince = async () => [remoteMessage];
    client.sendMessage = async () => delivered.resolve();
    try {
      expect(await processWhatsAppMessage(remoteMessage)).toBe(true);
      expect(
        readChatTranscript(projectId, conversation.id).find(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            (entry as { type?: unknown }).type === 'direct_user_pending' &&
            (entry as { messageId?: unknown }).messageId === remoteMessage.id,
        ),
      ).toMatchObject({
        agentCmd: runtime!.id,
        runtimeSelection: {
          harnessId: runtime!.harnessId,
          modelId: runtime!.modelId,
        },
      });

      await setMainConversationAiUser(conversation.id, { mode: 'none' });
      const removalGeneration = await mainPersonaGeneration(conversation.id);
      expect(removalGeneration).toBe(2);
      await setConversationSessionId(
        conversation.id,
        mainPersonaSessionKey(runtimeSessionKey(runtime!), removalGeneration),
        'queued-whatsapp-generation-session',
      );
      await releaseConversationExecutionLease(conversation.id, ownerId);
      await delivered.promise;
      const launched = calls.find(
        (call) =>
          call.conversationId === conversation.id &&
          call.prompt.includes('queued before main persona removal'),
      );
      expect(launched).toMatchObject({
        agentId: runtime!.id,
        mainPersonaGeneration: removalGeneration,
        sessionId: undefined,
      });
      expect(launched?.systemPromptSuffix).toBeUndefined();
    } finally {
      client.getMessagesSince = originalGetMessagesSince;
      client.sendMessage = originalSendMessage;
      setMessagingProvider(previousProvider);
      TOOLSET_MODULES.project_setup = previousTools;
      await releaseConversationExecutionLease(conversation.id, ownerId);
    }
  });

  test('refreshes the WhatsApp native session after removal wins lease admission', async () => {
    calls.length = 0;
    const branch = `whatsapp-removal-${Date.now()}`;
    const conversation = await createConversation(projectId, {
      use_worktree: true,
      branch_name: branch,
    });
    await updateConversationWorktreePath(
      conversation.id,
      `.worktrees/${branch}`,
    );
    const group = registeredGroups[`${projectId}@web`];
    const sessionKey = resolveSessionAgentKey(
      group,
      undefined,
      conversation.runtimeSelection,
    );
    await setConversationSessionId(
      conversation.id,
      sessionKey,
      'removed-whatsapp-session',
    );
    const remoteMessage = {
      id: `whatsapp-removal-${conversation.id}`,
      chat_id: `${projectId}@web`,
      sender: 'visitor@wa',
      sender_name: 'WhatsApp visitor',
      content: '!continue after WhatsApp removal',
      timestamp: new Date(Date.now() + 120_000).toISOString(),
    };
    const previousProvider = getMessagingProvider();
    const previousTools = TOOLSET_MODULES.project_setup;
    registerWhatsAppMessaging();
    const client = getMessagingClient() as any;
    const originalGetMessagesSince = client.getMessagesSince;
    const originalSendMessage = client.sendMessage;
    client.getMessagesSince = async () => [remoteMessage];
    client.sendMessage = async () => undefined;
    try {
      expect(
        await processWhatsAppMessage(remoteMessage, {
          beforeConversationExecutionLease: async () => {
            await transitionConversationsFromRemovedWorktree(
              projectId,
              branch,
              async () => undefined,
            );
          },
        }),
      ).toBe(true);
      const launched = calls.find(
        (call) => call.conversationId === conversation.id,
      );
      expect(launched?.sessionId).toBeUndefined();
      expect(await getConversationSessionId(conversation.id, sessionKey)).toBe(
        null,
      );
      expect(await getConversation(conversation.id)).toMatchObject({
        use_worktree: 0,
        worktree_path: null,
        branch_name: null,
      });
    } finally {
      client.getMessagesSince = originalGetMessagesSince;
      client.sendMessage = originalSendMessage;
      setMessagingProvider(previousProvider);
      TOOLSET_MODULES.project_setup = previousTools;
    }
  });

  test('executes an accepted public persona turn exactly once after lease contention', async () => {
    const conversation = await createConversation(projectId);
    const interactionId = `public-contention-${conversation.id}`;
    const createdAt = new Date().toISOString();
    const userMessage = await saveChatMessage({
      id: interactionId,
      group_folder: projectId,
      role: 'user',
      content: 'accepted public contention turn',
      sender_name: 'Public visitor',
      source: 'public',
      publicInteractionId: interactionId,
      created_at: createdAt,
      conversation_id: conversation.id,
    });
    await insertPublicPromptRequest({
      id: interactionId,
      conversationId: conversation.id,
      visitorHash: 'public-contention-visitor',
      status: 'running',
      createdAt,
    });
    const ownerId = `external-public-owner-${conversation.id}`;
    await acquireConversationExecutionLease(conversation.id, ownerId);
    const executions: string[] = [];
    const publicCompleted = Promise.withResolvers<void>();
    const unsubscribe = subscribePublicConversation(conversation.id, {
      write: (data: string) => {
        if (data.includes('"type":"changed"')) publicCompleted.resolve();
      },
    } as never);
    setPublicPersonaTurnOverride(async (options) => {
      executions.push(options.interactionId);
      return 2;
    });
    try {
      await enqueuePersistedDirectFollowup({
        message: userMessage,
        metadata: {
          conversationId: conversation.id,
          executionContent: userMessage.content,
          agentCmd: cliAgentId,
          triggerSource: 'public',
          delivery: {
            kind: 'public-persona',
            interactionId,
            visitorName: 'Public visitor',
          },
        },
      });
      expect(executions).toEqual([]);
      await releaseConversationExecutionLease(conversation.id, ownerId);
      await publicCompleted.promise;
      expect(executions).toEqual([interactionId]);
      expect(await getPublicPromptRequest(interactionId)).toMatchObject({
        status: 'completed',
        responderCount: 2,
      });
    } finally {
      unsubscribe();
      setPublicPersonaTurnOverride();
      await releaseConversationExecutionLease(conversation.id, ownerId);
    }
  });

  beforeAll(async () => {
    await initDatabase(':memory:');
    const handle = drizzleDbRef.current as any;
    const client =
      handle?.$client ?? handle?._?.client ?? handle?.session?.client;
    await client.exec(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES ('route-admin-user', 'admin', 'test', 'admin', '${new Date().toISOString()}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.exec(
      `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main)
       VALUES ('${projectId}', '${projectId}@web', 'Route handoff', '${projectId}', '!', '${new Date().toISOString()}', 0)
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.exec(
      `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main)
       VALUES ('${destinationProjectId}', '${destinationProjectId}@web', 'Route handoff destination', '${destinationProjectId}', '!', '${new Date().toISOString()}', 0)
       ON CONFLICT (id) DO NOTHING`,
    );
    await loadState();
    const promptPath = await writeAiUserPrompt(
      addressedPersonaId,
      // Saved personas can still name WhatsApp's toolset after it is disabled.
      '---\nidentity: Morgan\nturn: after\ntools: [advanced]\n---\nAnswer only as Morgan.',
    );
    const now = new Date().toISOString();
    await insertAiUserRow({
      id: addressedPersonaId,
      name: 'Morgan',
      identity: 'Morgan',
      presetId: addressedPersonaPresetId,
      promptPath,
      turn: 'after',
      tools: ['advanced'],
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    getRuntimeCatalog().presets.push({
      id: addressedPersonaPresetId,
      label: 'Route addressed persona',
      selection: { harnessId: 'direct', modelId: 'default' },
    });
    getChatAgents().push({
      id: completionAgentId,
      label: 'Route completion direct',
      harnessId: 'direct',
      harnessKind: 'direct',
      modelId: 'default',
      model: 'default',
      baseUrl: 'http://direct.test/v1',
      sessionFamily: completionAgentId,
    });
    getChatAgents().push({
      id: cliAgentId,
      label: 'Route test CLI',
      harnessId: 'codex',
      harnessKind: 'cli',
      modelId: 'default',
      agentCmd: cliAgentId,
      sessionFamily: cliAgentId,
    });
    getChatAgents().push({
      id: qwenAgentId,
      label: 'Route Qwen default',
      harnessId: 'direct',
      harnessKind: 'direct',
      modelId: 'qwen3.8',
      model: 'qwen3.8',
      baseUrl: 'http://direct.test/v1',
      sessionFamily: qwenAgentId,
    });
    getChatAgents().push({
      id: codexSolAgentId,
      label: 'Route Codex Sol',
      harnessId: 'codex',
      harnessKind: 'cli',
      modelId: 'gpt-5.6-sol',
      model: 'gpt-5.6-sol',
      agentCmd: 'codex',
      sessionFamily: 'codex',
      reasoningOptions: ['low', 'high'],
      reasoningDefault: 'low',
      reasoningMap: { low: 'low', high: 'high' },
    });

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      // Each route exchange owns its connection; pooled idle sockets are not
      // part of the handoff contract and can expire while a worker is held.
      res.setHeader('Connection', 'close');
      const requestedUserId = req.headers['x-test-user-id'];
      const projectAccessLevel = req.headers['x-test-project-access'];
      if (projectAccessLevel === 'implicit') {
        (req as any).projectAccess = { kind: 'implicit' };
      } else if (typeof projectAccessLevel === 'string') {
        (req as any).projectAccess = {
          kind: 'explicit',
          level: projectAccessLevel,
        };
      }
      if (req.headers['x-test-agent']) {
        (req as any).tokenScope = { group_folder: projectId };
        (req as any).authCredentialKind = 'agent';
        return next();
      }
      (req as any).authUser = req.headers['x-test-denied-user']
        ? {
            id: 'route-user-without-conversation-access',
            username: 'denied',
            role: 'user',
          }
        : {
            id:
              typeof requestedUserId === 'string'
                ? requestedUserId
                : 'route-admin-user',
            username: 'admin',
            role: req.headers['x-test-non-admin'] ? 'user' : 'admin',
          };
      next();
    });
    app.use(conversationsRouter);
    app.use(aiUsersAdminRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    attachWebSocket(server!);
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    eventSocket = new WebSocket(
      `ws://127.0.0.1:${(server!.address() as AddressInfo).port}/api/ws?ticket=${encodeURIComponent(adminWsTicket())}`,
    );
    eventSocket.on('message', (raw) => {
      const event = JSON.parse(String(raw));
      boardEvents.push(event);
      boardNotifications.emit('event', event);
    });
    await new Promise<void>((resolve, reject) => {
      eventSocket.once('open', resolve);
      eventSocket.once('error', reject);
    });
  });

  afterAll(async () => {
    eventSocket?.terminate();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    const presets = getRuntimeCatalog().presets;
    const presetIndex = presets.findIndex(
      (preset) => preset.id === addressedPersonaPresetId,
    );
    if (presetIndex >= 0) presets.splice(presetIndex, 1);
    const agents = getChatAgents();
    const completionAgentIndex = agents.findIndex(
      (agent) => agent.id === completionAgentId,
    );
    if (completionAgentIndex >= 0) agents.splice(completionAgentIndex, 1);
    const cliAgentIndex = agents.findIndex((agent) => agent.id === cliAgentId);
    if (cliAgentIndex >= 0) agents.splice(cliAgentIndex, 1);
    for (const agentId of [qwenAgentId, codexSolAgentId]) {
      const index = agents.findIndex((agent) => agent.id === agentId);
      if (index >= 0) agents.splice(index, 1);
    }
    await fs.rm(aiUserDirectory(addressedPersonaId), {
      recursive: true,
      force: true,
    });
  });

  test('starts the post-removal turn fresh with the canonical transcript handoff', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId, {
      use_worktree: true,
      branch_name: 'removed-task-branch',
    });
    await updateConversationWorktreePath(
      conversation.id,
      '.worktrees/removed-task-branch',
    );
    await saveChatMessage({
      group_folder: projectId,
      conversation_id: conversation.id,
      role: 'user',
      content: 'Canonical question before removal.',
      source: 'web',
      created_at: '2026-09-01T00:00:00.000Z',
    });
    await saveChatMessage({
      group_folder: projectId,
      conversation_id: conversation.id,
      role: 'assistant',
      content: 'Canonical answer before removal.',
      source: 'web',
      created_at: '2026-09-01T00:00:01.000Z',
    });
    await setConversationSessionId(
      conversation.id,
      cliAgentId,
      'removed-native-session',
    );

    await transitionConversationsFromRemovedWorktree(
      projectId,
      'removed-task-branch',
      async () => undefined,
    );
    expect(await getChatMessages(projectId, 10, conversation.id)).toHaveLength(
      2,
    );

    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversation.id,
        content: 'Continue after removal.',
        agent_cmd: cliAgentId,
      }),
    });
    expect(response.status).toBe(202);
    await waitForRunner(() =>
      calls.some((call) => call.conversationId === conversation.id),
    );
    const launched = calls.find(
      (call) => call.conversationId === conversation.id,
    );
    expect(launched?.sessionId).toBeNull();
    expect(launched?.prompt).toContain('Canonical question before removal.');
    expect(launched?.prompt).toContain('Canonical answer before removal.');
    expect(await getConversation(conversation.id)).toMatchObject({
      use_worktree: 0,
      worktree_path: null,
      branch_name: null,
    });
    await waitForCompletion(conversation.id);
    const visibleMessages = await getChatMessages(
      projectId,
      10,
      conversation.id,
    );
    expect(
      visibleMessages.every(
        (message) => !message.content.startsWith('[CONTEXT_SUMMARY:'),
      ),
    ).toBe(true);
  });

  test('rejects an HTTP branch binding admitted during worktree removal', async () => {
    const branch = `route-removal-admission-${Date.now()}`;
    let markRemovalStarted!: () => void;
    const removalStarted = new Promise<void>((resolve) => {
      markRemovalStarted = resolve;
    });
    let finishRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });
    const transition = transitionConversationsFromRemovedWorktree(
      projectId,
      branch,
      async () => {
        markRemovalStarted();
        await removalGate;
      },
    );
    await removalStarted;

    try {
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/conversations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ use_worktree: true, branch }),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'Worktree removal is in progress; retry after it finishes',
        branch,
      });
    } finally {
      finishRemoval();
      await transition;
    }
    expect(
      (await getConversations(projectId, 100)).some(
        (conversation) => conversation.branch_name === branch,
      ),
    ).toBe(false);
  });

  test('conversation-owned removal resets every conversation sharing the branch', async () => {
    const owner = await createConversation(projectId, { use_worktree: true });
    const branch = `chat-${owner.id}`;
    const shared = await createConversation(projectId, {
      use_worktree: true,
      branch_name: branch,
    });
    await updateConversationWorktreePath(owner.id, `.worktrees/${branch}`);
    await updateConversationWorktreePath(shared.id, `.worktrees/${branch}`);
    await setConversationSessionId(owner.id, cliAgentId, 'owner-session');
    await setConversationSessionId(shared.id, 'claude', 'shared-session');
    await updateGroup(`${projectId}@web`, {
      settings: { repositoryLocation: '/host/repos/route-runtime-handoff' },
    });
    const client = getSandboxClient() as any;
    const originalSandboxWorktree = client.sandboxWorktree;
    const removals: Array<{ branch?: string }> = [];
    client.sandboxWorktree = async (
      _stack: string,
      _action: string,
      options: { branch?: string },
    ) => {
      removals.push(options);
      return { stdout: 'removed', isError: false };
    };
    try {
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/conversations/${owner.id}/worktree`,
        { method: 'DELETE' },
      );
      expect(response.status).toBe(200);
      expect(removals).toHaveLength(1);
      expect(removals[0]).toMatchObject({ branch });
      for (const conversationId of [owner.id, shared.id]) {
        expect(await getConversation(conversationId)).toMatchObject({
          use_worktree: 0,
          worktree_path: null,
          branch_name: null,
        });
      }
      expect(await getConversationSessionId(owner.id, cliAgentId)).toBeNull();
      expect(await getConversationSessionId(shared.id, 'claude')).toBeNull();
    } finally {
      client.sandboxWorktree = originalSandboxWorktree;
      await updateGroup(`${projectId}@web`, { settings: {} });
    }
  });

  test('refuses to delete a conversation while it has an active run', async () => {
    const conversation = await createConversation(projectId);
    appendChatTranscriptEntry(projectId, conversation.id, {
      id: 'active-run-delete-entry',
      role: 'user',
      content: 'must survive a refused delete',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    const runId = `delete-active-run-${conversation.id}`;
    await drizzleDbRef.current.insert(activeRuns).values({
      id: runId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      conversation_id: conversation.id,
      sandbox_stack: 'test',
      sandbox_service: 'test',
      started_at: new Date().toISOString(),
      timeout_at: new Date(Date.now() + 60_000).toISOString(),
      status: 'running',
    });

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}`,
      { method: 'DELETE' },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Conversation has an active run; stop it before deleting',
    });
    expect(await getConversation(conversation.id)).toBeDefined();
    expect(readChatTranscript(projectId, conversation.id)).toHaveLength(1);

    await drizzleDbRef.current
      .delete(activeRuns)
      .where(eq(activeRuns.id, runId));
    // An admitted submission that has not created its run yet holds the lease.
    const leaseOwner = `human:delete-fence-${conversation.id}`;
    expect(
      await acquireConversationExecutionLease(conversation.id, leaseOwner),
    ).not.toBeNull();
    const leased = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}`,
      { method: 'DELETE' },
    );
    expect(leased.status).toBe(409);
    expect(readChatTranscript(projectId, conversation.id)).toHaveLength(1);
    await releaseConversationExecutionLease(conversation.id, leaseOwner);
    const deleted = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);
    expect(await getConversation(conversation.id)).toBeUndefined();
    expect(readChatTranscript(projectId, conversation.id)).toEqual([]);
  });

  describe('POST commit scope and viewer guard', () => {
    let memberId: string;
    let gitCalls: string[];
    let branchCalls: unknown[];
    let originalGit: unknown;
    let originalBranch: unknown;
    beforeAll(async () => {
      memberId = (await createUser('route-commit-member', 'pw', 'user')).id;
      await updateGroup(`${projectId}@web`, {
        settings: { repositoryLocation: '/host/repos/route-runtime-handoff' },
      });
      const client = getSandboxClient() as any;
      originalGit = client.sandboxGit;
      originalBranch = client.sandboxBranch;
      client.sandboxGit = async (_stack: string, args: string) => {
        gitCalls.push(args);
        return { stdout: 'file.txt', isError: false };
      };
      client.sandboxBranch = async (...args: unknown[]) => {
        branchCalls.push(args);
        return { stdout: 'committed', isError: false };
      };
    });
    afterAll(async () => {
      const client = getSandboxClient() as any;
      client.sandboxGit = originalGit;
      client.sandboxBranch = originalBranch;
      await updateGroup(`${projectId}@web`, { settings: {} });
    });
    const commit = (
      conversationId: string,
      access?: 'viewer' | 'editor' | 'implicit',
      projectOverride = projectId,
    ) =>
      fetch(
        `${baseUrl}/projects/${projectOverride}/conversations/${conversationId}/commit`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(access
              ? {
                  'x-test-non-admin': '1',
                  'x-test-user-id': memberId,
                  'x-test-project-access': access,
                }
              : {}),
          },
          body: JSON.stringify({ message: 'x', stagedOnly: true }),
        },
      );
    const gitCommits = () => gitCalls.filter((c) => c.includes('commit -m'));
    beforeEach(() => {
      gitCalls = [];
      branchCalls = [];
    });

    test('404s a conversation that belongs to another project without touching git', async () => {
      const foreign = await createConversation(destinationProjectId);
      const response = await commit(foreign.id);
      expect(response.status).toBe(404);
      expect(gitCalls).toEqual([]);
      expect(branchCalls).toEqual([]);
    });

    test('repo read routes 404 a conversation from another project without touching git', async () => {
      const foreign = await createConversation(destinationProjectId);
      const base = `${baseUrl}/projects/${projectId}/conversations/${foreign.id}`;
      const requests: Array<[string, string]> = [
        ['GET', `${base}/diff`],
        ['GET', `${base}/commit-message`],
        ['GET', `${base}/files/repo`],
        ['GET', `${base}/files/repo/content?path=file.txt`],
        ['HEAD', `${base}/files/repo/content?path=file.txt`],
      ];
      for (const [method, url] of requests) {
        const response = await fetch(url, { method });
        expect({ url, status: response.status }).toEqual({ url, status: 404 });
      }
      expect(gitCalls).toEqual([]);
      expect(branchCalls).toEqual([]);
    });

    test('files/repo/content still serves a conversation of the same project', async () => {
      const conversation = await createConversation(projectId);
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/files/repo/content?path=file.txt`,
      );
      expect(response.status).toBe(200);
      expect(gitCalls.length).toBeGreaterThan(0);
    });

    test('files/repo/content sandboxes an SVG and only nosniffs a PNG', async () => {
      const get = (name: string) =>
        fetch(
          `${baseUrl}/projects/${projectId}/files/repo/content?path=${name}`,
        );
      const svg = await get('logo.svg');
      expect(svg.status).toBe(200);
      expect(svg.headers.get('x-content-type-options')).toBe('nosniff');
      expect(svg.headers.get('content-security-policy')).toBe(
        "sandbox; default-src 'none'",
      );
      expect(svg.headers.get('content-disposition')).toStartWith('attachment');
      expect(svg.headers.get('content-type')).toStartWith('image/svg+xml');
      const png = await get('pic.png');
      expect(png.headers.get('x-content-type-options')).toBe('nosniff');
      expect(png.headers.get('content-security-policy')).toBeNull();
      expect(png.headers.get('content-disposition')).toBeNull();
    });

    test('an explicit project viewer cannot commit the shared checkout through a conversation', async () => {
      const conversation = await createConversation(projectId);
      await upsertConversationMember(memberId, conversation.id, 'editor');
      const response = await commit(conversation.id, 'viewer');
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Write access to this project required',
      });
      expect(gitCalls).toEqual([]);
    });

    test('a conversation editor still commits their own worktree', async () => {
      const conversation = await createConversation(projectId, {
        use_worktree: true,
      });
      await updateConversationWorktreePath(
        conversation.id,
        `.worktrees/chat-${conversation.id}`,
      );
      await upsertConversationMember(memberId, conversation.id, 'editor');
      const response = await commit(conversation.id, 'viewer');
      expect(response.status).toBe(200);
      expect(gitCommits()).toHaveLength(1);
      expect(gitCommits()[0]).toContain(`.worktrees/chat-${conversation.id}`);
    });

    const asMember = (access: 'implicit' | 'viewer') => ({
      'content-type': 'application/json',
      'x-test-non-admin': '1',
      'x-test-user-id': memberId,
      'x-test-project-access': access,
    });

    test('a chat-only conversation editor cannot commit the shared checkout', async () => {
      const conversation = await createConversation(projectId);
      await upsertConversationMember(memberId, conversation.id, 'editor');
      const response = await commit(conversation.id, 'implicit');
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Write access to this project required',
      });
      expect(gitCalls).toEqual([]);
    });

    test('a chat-only conversation editor cannot merge its worktree into the default branch', async () => {
      const conversation = await createConversation(projectId, {
        use_worktree: true,
      });
      await updateConversationWorktreePath(
        conversation.id,
        `.worktrees/chat-${conversation.id}`,
      );
      await upsertConversationMember(memberId, conversation.id, 'editor');
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/worktree/merge`,
        {
          method: 'POST',
          headers: asMember('implicit'),
          body: '{}',
        },
      );
      expect(response.status).toBe(403);
      expect(gitCalls).toEqual([]);
      expect(branchCalls).toEqual([]);
    });

    test.each(['implicit', 'viewer'] as const)(
      'a %s project member cannot fork a conversation',
      async (access) => {
        const conversation = await createConversation(projectId);
        await upsertConversationMember(memberId, conversation.id, 'editor');
        const before = (await getConversations(projectId, 500)).length;
        const response = await fetch(
          `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/fork`,
          { method: 'POST', headers: asMember(access), body: '{}' },
        );
        expect(response.status).toBe(403);
        expect((await getConversations(projectId, 500)).length).toBe(before);
      },
    );

    test('agent credentials cannot commit or stage the shared checkout', async () => {
      const headers = {
        'content-type': 'application/json',
        'x-test-agent': '1',
      };
      const commitResponse = await fetch(
        `${baseUrl}/projects/${projectId}/commit`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ message: 'x', stagedOnly: true }),
        },
      );
      expect(commitResponse.status).toBe(403);
      const indexResponse = await fetch(
        `${baseUrl}/projects/${projectId}/git/index`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: 'stageAll' }),
        },
      );
      expect(indexResponse.status).toBe(403);
      expect(gitCalls).toEqual([]);
    });

    test('project writers and admins keep committing the shared checkout', async () => {
      const conversation = await createConversation(projectId);
      await upsertConversationMember(memberId, conversation.id, 'editor');
      for (const access of ['editor', undefined] as const) {
        gitCalls = [];
        const response = await commit(conversation.id, access);
        expect(response.status).toBe(200);
        expect(gitCommits()).toHaveLength(1);
        expect(gitCommits()[0]).not.toContain('.worktrees');
      }
    });
  });

  test('routes an exact Work Live @persona message without invoking the main agent', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    await inviteConversationAiUser(
      conversation.id,
      addressedPersonaId,
      'route-admin-user',
    );

    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '@Morgan can you inspect this?',
        conversation_id: conversation.id,
        liveMode: true,
        liveModeKind: 'work',
        liveModeSessionId: `route-live-${conversation.id}`,
      }),
    });
    expect(response.status).toBe(202);

    await waitForRunner(() => calls.length > 0);
    await waitForCompletion(conversation.id, 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain('@Morgan can you inspect this?');
    expect(calls[0]?.ephemeral).toBe(true);
  });

  test.each([
    {
      label: 'a plain main agent (no persona)',
      mainPersona: false,
      speakerId: messageSpeech.MAIN_AGENT_SPEAKER_ID,
    },
    {
      label: 'a main persona',
      mainPersona: true,
      speakerId: addressedPersonaId,
    },
  ])(
    'queues and speaks the Persona-kind Live reply of $label',
    async ({ mainPersona, speakerId }) => {
      calls.length = 0;
      const conversation = await createConversation(projectId);
      await setMainConversationAiUser(
        conversation.id,
        mainPersona
          ? { mode: 'persona', aiUserId: addressedPersonaId }
          : { mode: 'none' },
      );
      const spoken = Promise.withResolvers<messageSpeech.PersonaSpeechInput>();
      const speechSpy = spyOn(
        messageSpeech,
        'ensurePersonaMessageSpeech',
      ).mockImplementation(async (input) => {
        // Earlier tests' non-live replies may still be synthesizing.
        if (input.conversationId === conversation.id) spoken.resolve(input);
        throw new Error('speech synthesis is not available in this test');
      });
      const liveModeSessionId = `persona-live-${conversation.id}`;
      try {
        const started = await fetch(
          `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/persona-live-mode`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              enabled: true,
              liveModeKind: 'personas',
              liveModeSessionId,
            }),
          },
        );
        expect(started.status).toBe(200);
        const response = await fetch(
          `${baseUrl}/projects/${projectId}/messages`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              content: 'Speak this reply.',
              conversation_id: conversation.id,
              liveMode: true,
              liveModeKind: 'personas',
              liveModeSessionId,
            }),
          },
        );
        expect(response.status).toBe(202);
        const input = await spoken.promise;
        expect(input.speakerId).toBe(speakerId);
        if (!mainPersona) {
          // No persona voice: the TTS defaults apply.
          expect(input.voice).toBeUndefined();
          expect(input.lang).toBeUndefined();
        }
        const [queued] = await drizzleDbRef.current
          .select()
          .from(conversationLiveQueueItems)
          .where(
            eq(conversationLiveQueueItems.conversationId, conversation.id),
          );
        expect(queued).toMatchObject({
          messageId: input.messageId,
          participantId: speakerId,
        });
        await waitForCompletion(conversation.id, 1);
      } finally {
        speechSpy.mockRestore();
      }
    },
  );

  describe('invited persona warm-session revision', () => {
    const quinnId = 'route-revision-quinn';

    async function createQuinn(tools: string[]) {
      const promptPath = await writeAiUserPrompt(
        quinnId,
        '---\nidentity: Quinn\nturn: before\n---\nAnswer only as Quinn.',
      );
      const now = new Date().toISOString();
      await insertAiUserRow({
        id: quinnId,
        name: 'Quinn',
        identity: 'Quinn',
        presetId: addressedPersonaPresetId,
        promptPath,
        turn: 'before',
        tools,
        enabled: 1,
        createdAt: now,
        updatedAt: now,
      });
    }

    async function takeQuinnTurn(
      conversationId: string,
      content: string,
      completed: number,
    ) {
      const before = calls.filter((call) => call.ephemeral).length;
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, conversation_id: conversationId }),
        },
      );
      expect(response.status).toBe(202);
      await waitForRunner(
        () => calls.filter((call) => call.ephemeral).length > before,
      );
      await waitForCompletion(conversationId, completed);
      return calls.filter((call) => call.ephemeral)[before]!;
    }

    afterAll(async () => {
      await fs.rm(aiUserDirectory(quinnId), { recursive: true, force: true });
    });

    test('changes the revision when only the persona toolsets change', async () => {
      calls.length = 0;
      await createQuinn([]);
      const conversation = await createConversation(projectId);
      await inviteConversationAiUser(
        conversation.id,
        quinnId,
        'route-admin-user',
      );

      const first = await takeQuinnTurn(conversation.id, 'Quinn, go.', 1);
      expect(first.systemPromptSuffix).toContain(
        'Permitted toolsets: core only.',
      );

      await updateAiUserPersonaRow(quinnId, { tools: ['web'] });
      const second = await takeQuinnTurn(conversation.id, 'Quinn, again.', 2);

      expect(first.personaSessionRevision).toBeTruthy();
      expect(second.personaSessionRevision).not.toBe(
        first.personaSessionRevision,
      );
      expect(second.systemPromptSuffix).toContain('Permitted toolsets: web.');
    });

    test('keeps the revision stable across phases and sends the phase per turn', async () => {
      calls.length = 0;
      await updateAiUserPersonaRow(quinnId, { tools: ['web'] });
      const conversation = await createConversation(projectId);
      await inviteConversationAiUser(
        conversation.id,
        quinnId,
        'route-admin-user',
      );

      // A direct name mention runs the persona in the 'any' phase; an
      // unaddressed message runs it in its own 'before' phase.
      const mentioned = await takeQuinnTurn(
        conversation.id,
        '@Quinn please weigh in.',
        1,
      );
      const before = await takeQuinnTurn(conversation.id, 'Anything else?', 2);

      expect(mentioned.prompt).toContain('Talking-stick phase: any.');
      expect(before.prompt).toContain('Talking-stick phase: before.');
      expect(before.personaSessionRevision).toBe(
        mentioned.personaSessionRevision,
      );
      for (const call of [mentioned, before])
        expect(call.systemPromptSuffix).not.toContain('Talking-stick phase');
    });
  });

  test('delivers validated open-file metadata only to the agent prompt', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'fix this',
        conversation_id: conversation.id,
        agent_cmd: cliAgentId,
        openFileContext: {
          source: 'group',
          path: '.env',
          line: 2,
          column: 4,
          unsavedChanges: true,
        },
      }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      userMessage: { content: string };
    };
    expect(body.userMessage.content).toBe('fix this');
    await waitForRunner(() => calls.length > 0);
    expect(calls[0]?.prompt).toContain(
      '<open-file-context encoding="json-ascii">',
    );
    expect(calls[0]?.prompt).toContain('"path":".env"');
    expect(calls[0]?.prompt).not.toContain('SECRET=[REDACTED]');

    const visible = (
      readChatTranscript(projectId, conversation.id) as Array<
        Record<string, unknown>
      >
    ).filter((entry) => entry.type === 'message');
    expect(visible.find((entry) => entry.role === 'user')?.content).toBe(
      'fix this',
    );
    expect(JSON.stringify(visible)).not.toContain('open-file-context');
    expect(JSON.stringify(visible)).not.toContain('unsavedChanges');
  });

  test('rejects content-smuggling fields in open-file metadata', async () => {
    const conversation = await createConversation(projectId);
    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'fix this',
        conversation_id: conversation.id,
        openFileContext: {
          source: 'group',
          path: '.env',
          content: 'SECRET=[REDACTED]',
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'openFileContext contains unknown fields',
    });
  });

  test('validates open-file metadata before auto-creating a conversation', async () => {
    const before = await getConversations(projectId, 500, 0);
    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'fix this',
        openFileContext: { source: 'group', path: '../outside' },
      }),
    });
    expect(response.status).toBe(400);
    const after = await getConversations(projectId, 500, 0);
    expect(after.map((conversation) => conversation.id)).toEqual(
      before.map((conversation) => conversation.id),
    );
  });

  test('accepts Repo main and matching worktree identity but rejects a foreign pin', async () => {
    calls.length = 0;
    const main = await createConversation(projectId);
    const mainResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'main file',
          conversation_id: main.id,
          agent_cmd: cliAgentId,
          openFileContext: {
            source: 'repo',
            path: 'src/main.ts',
            repoContext: 'main',
          },
        }),
      },
    );
    expect(mainResponse.status).toBe(202);
    const worktree = await createConversation(projectId, {
      use_worktree: true,
    });
    const worktreeResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'worktree file',
          conversation_id: worktree.id,
          agent_cmd: cliAgentId,
          openFileContext: {
            source: 'repo',
            path: 'src/worktree.ts',
            repoContext: 'conversationWorktree',
            conversationId: worktree.id,
          },
        }),
      },
    );
    expect(worktreeResponse.status).toBe(202);
    const foreignResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'wrong worktree',
          conversation_id: main.id,
          openFileContext: {
            source: 'repo',
            path: 'src/worktree.ts',
            repoContext: 'conversationWorktree',
            conversationId: worktree.id,
          },
        }),
      },
    );
    expect(foreignResponse.status).toBe(400);
    await waitForRunner(() => calls.length >= 2);
    expect(
      calls.some((call) => call.prompt.includes('"repoContext":"main"')),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.prompt.includes(`"conversationId":"${worktree.id}"`),
      ),
    ).toBe(true);
  });

  test('delivers objective context agent-only and validates before auto-create', async () => {
    calls.length = 0;
    const objective = await createObjective({
      project_id: projectId,
      title: 'Open file objective route',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      trigger_config: null,
      metadata: null,
      work_dir: null,
      cost_limit_usd: null,
    });
    await initObjectiveFolder(projectId, objective.id, objective);
    const before = await getConversations(projectId, 50, 0, {
      objectiveId: objective.id,
    });
    const invalid = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective_id: objective.id,
        content: 'invalid',
        openFileContext: { source: 'group', path: '../bad' },
      }),
    });
    expect(invalid.status).toBe(400);
    expect(
      await getConversations(projectId, 50, 0, { objectiveId: objective.id }),
    ).toHaveLength(before.length);

    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective_id: objective.id,
        content: 'objective fix',
        openFileContext: {
          source: 'artifact',
          path: 'plans/objective.md',
          line: 3,
          column: 2,
        },
      }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      userMessage: { content: string };
    };
    expect(body.userMessage.content).toBe('objective fix');
    const objectiveConversation = (
      await getConversations(projectId, 50, 0, { objectiveId: objective.id })
    )[0];
    const messagesResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages?limit=10&conversation_id=${objectiveConversation?.id ?? ''}`,
    );
    const messages = (await messagesResponse.json()) as Array<
      Record<string, unknown>
    >;
    const listedHumanMessage = messages.find(
      (message) => message.content === 'objective fix',
    );
    expect(listedHumanMessage).toMatchObject({
      senderUserId: 'route-admin-user',
      sender_name: 'admin',
      senderAvatarUrl: null,
    });
    await waitForRunner(() => calls.length > 0);
    expect(calls[0]?.prompt).toContain('"path":"plans/objective.md"');
  });

  test('resolves objective chat runtimes exactly like normal chat without objective event overrides', async () => {
    calls.length = 0;
    const selectedRuntime = {
      harnessId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoning: 'high',
    };
    const objective = await createObjective({
      project_id: projectId,
      title: 'Objective chat runtime parity',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      trigger_config: null,
      metadata: null,
      eventRuntimeSelection: selectedRuntime,
      work_dir: null,
      cost_limit_usd: null,
    });
    const selectedAgent = getResolvedRuntimeConfig(
      getGroupByFolder(projectId)!,
      selectedRuntime,
    )!;
    const comparableRuntime = (call: (typeof calls)[number]) => ({
      agentId: call.agentId,
      agentCmd: call.agentCmd,
      harnessId: call.harnessId,
      harnessKind: call.harnessKind,
      modelId: call.modelId,
      runtimeModel: call.runtimeModel,
      modelOverride: call.modelOverride,
      reasoningEffort: call.reasoningEffort,
    });
    const postAndCapture = async (
      route: string,
      body: Record<string, unknown>,
    ) => {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const responseBody = await response.text();
      expect(response.status, `${route}: ${responseBody}`).toBe(202);
      const payload = JSON.parse(responseBody) as { conversation_id: string };
      await waitForRunner(() =>
        calls.some((call) => call.conversationId === payload.conversation_id),
      );
      await waitForCompletion(payload.conversation_id);
      return {
        conversationId: payload.conversation_id,
        call: calls.find(
          (call) => call.conversationId === payload.conversation_id,
        )!,
      };
    };
    const normalRoute = `/projects/${projectId}/messages`;
    const objectiveRoute = normalRoute;

    await updateGroup(`${projectId}@web`, {
      settings: {
        chatRuntimeSelection: {
          harnessId: 'direct',
          modelId: 'qwen3.8',
        },
      },
    });
    try {
      const normalExisting = await createConversation(projectId);
      const objectiveExisting = await createObjectiveConversation(
        projectId,
        objective.id,
      );
      for (const conversation of [normalExisting, objectiveExisting]) {
        const generation = await mainPersonaGeneration(conversation.id);
        await setConversationSessionId(
          conversation.id,
          mainPersonaSessionKey(runtimeSessionKey(selectedAgent), generation),
          `selected-session-${conversation.id}`,
        );
      }
      const normalSelected = await postAndCapture(normalRoute, {
        content: 'Normal selected runtime parity.',
        conversation_id: normalExisting.id,
        runtimeSelection: selectedRuntime,
      });
      const objectiveSelected = await postAndCapture(objectiveRoute, {
        objective_id: objective.id,
        content: 'Objective selected runtime parity.',
        conversation_id: objectiveExisting.id,
        runtimeSelection: selectedRuntime,
      });
      expect(comparableRuntime(objectiveSelected.call)).toEqual(
        comparableRuntime(normalSelected.call),
      );
      expect(comparableRuntime(objectiveSelected.call)).toEqual({
        agentId: codexSolAgentId,
        agentCmd: 'codex',
        harnessId: 'codex',
        harnessKind: 'cli',
        modelId: 'gpt-5.6-sol',
        runtimeModel: 'gpt-5.6-sol',
        modelOverride: 'gpt-5.6-sol',
        reasoningEffort: 'high',
      });
      expect(objectiveSelected.call.sessionId).toBe(
        `selected-session-${objectiveExisting.id}`,
      );

      const normalNew = await postAndCapture(normalRoute, {
        content: 'Normal new selected runtime parity.',
        runtimeSelection: selectedRuntime,
      });
      const objectiveNew = await postAndCapture(objectiveRoute, {
        objective_id: objective.id,
        content: 'Objective new selected runtime parity.',
        runtimeSelection: selectedRuntime,
      });
      expect(comparableRuntime(objectiveNew.call)).toEqual(
        comparableRuntime(normalNew.call),
      );

      const normalStored = await createConversation(projectId);
      const objectiveStored = await createObjectiveConversation(
        projectId,
        objective.id,
      );
      await setConversationRuntimeSelection(normalStored.id, selectedRuntime);
      await setConversationRuntimeSelection(
        objectiveStored.id,
        selectedRuntime,
      );
      const normalStoredResult = await postAndCapture(normalRoute, {
        content: 'Normal stored runtime parity.',
        conversation_id: normalStored.id,
      });
      const objectiveStoredResult = await postAndCapture(objectiveRoute, {
        objective_id: objective.id,
        content: 'Objective stored runtime parity.',
        conversation_id: objectiveStored.id,
      });
      expect(comparableRuntime(objectiveStoredResult.call)).toEqual(
        comparableRuntime(normalStoredResult.call),
      );

      const normalPersona = await createConversation(projectId);
      const objectivePersona = await createObjectiveConversation(
        projectId,
        objective.id,
      );
      for (const conversation of [normalPersona, objectivePersona]) {
        await setMainConversationAiUser(conversation.id, {
          mode: 'persona',
          aiUserId: addressedPersonaId,
        });
      }
      const normalDefault = await postAndCapture(normalRoute, {
        content: 'Normal project default persona parity.',
        conversation_id: normalPersona.id,
        liveMode: true,
        liveModeKind: 'work',
        liveModeSessionId: `runtime-parity-${normalPersona.id}`,
      });
      const objectiveDefault = await postAndCapture(objectiveRoute, {
        objective_id: objective.id,
        content: 'Objective project default persona parity.',
        conversation_id: objectivePersona.id,
      });
      expect(comparableRuntime(objectiveDefault.call)).toEqual(
        comparableRuntime(normalDefault.call),
      );
      expect(comparableRuntime(objectiveDefault.call)).toMatchObject({
        agentId: `ai-main:${addressedPersonaId}`,
        harnessId: 'direct',
        harnessKind: 'direct',
        modelId: 'qwen3.8',
        runtimeModel: 'qwen3.8',
        modelOverride: 'qwen3.8',
      });

      await updateGroup(`${projectId}@web`, { settings: {} });
      const normalFallback = await postAndCapture(normalRoute, {
        content: 'Normal global fallback parity.',
      });
      const objectiveFallback = await postAndCapture(objectiveRoute, {
        objective_id: objective.id,
        content: 'Objective global fallback parity.',
      });
      expect(comparableRuntime(objectiveFallback.call)).toEqual(
        comparableRuntime(normalFallback.call),
      );
      expect(objectiveFallback.call.agentId).not.toBe(qwenAgentId);
    } finally {
      await updateGroup(`${projectId}@web`, { settings: {} });
    }

    expect(await getObjective(objective.id)).toMatchObject({
      eventRuntimeSelection: selectedRuntime,
    });
  });

  test('routes objective native sessions by the durable main persona generation', async () => {
    calls.length = 0;
    const personaId = `objective-main-persona-${Date.now()}`;
    const promptPath = await writeAiUserPrompt(
      personaId,
      '---\nidentity: Objective guide\n---\nKeep objective work concise.',
    );
    const now = new Date().toISOString();
    await insertAiUserRow({
      id: personaId,
      name: 'Objective guide',
      identity: 'Objective guide',
      presetId: addressedPersonaPresetId,
      promptPath,
      turn: 'after',
      tools: [],
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    const objective = await createObjective({
      project_id: projectId,
      title: 'Objective persona routing',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      trigger_config: null,
      metadata: null,
      work_dir: null,
      cost_limit_usd: null,
    });
    const conversation = await createObjectiveConversation(
      projectId,
      objective.id,
    );
    const chatRuntime = getResolvedRuntimeConfig(getGroupByFolder(projectId)!)!;
    const conversationCalls = () =>
      calls.filter(
        (call) => call.conversationId === conversation.id && !call.ephemeral,
      );
    const completedCount = () =>
      boardEvents.filter(
        (event) =>
          event.type === 'chat_completed' &&
          event.payload.conversation_id === conversation.id,
      ).length;
    const send = async (content: string) => {
      const callCount = conversationCalls().length;
      const completedBefore = completedCount();
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            objective_id: objective.id,
            content,
            conversation_id: conversation.id,
          }),
        },
      );
      expect(response.status).toBe(202);
      await waitForRunner(() => conversationCalls().length > callCount);
      await waitForCompletion(conversation.id, completedBefore + 1);
      expect(conversationCalls()).toHaveLength(callCount + 1);
      return conversationCalls().at(-1)!;
    };

    try {
      await setMainConversationAiUser(conversation.id, { mode: 'none' });
      const noPersonaGeneration = await mainPersonaGeneration(conversation.id);
      const noPersonaKey = mainPersonaSessionKey(
        runtimeSessionKey(chatRuntime),
        noPersonaGeneration,
      );
      await setConversationSessionId(
        conversation.id,
        noPersonaKey,
        'objective-no-persona-session',
      );
      expect(await send('Objective without a main persona.')).toMatchObject({
        sessionId: 'objective-no-persona-session',
        mainPersonaGeneration: noPersonaGeneration,
      });
      expect(
        await send('Objective without a main persona again.'),
      ).toMatchObject({ sessionId: 'objective-no-persona-session' });

      await setMainConversationAiUser(conversation.id, {
        mode: 'persona',
        aiUserId: personaId,
      });
      const attached = await resolveMainAiUserContext(
        conversation.id,
        getGroupByFolder(projectId)!,
      );
      expect(attached).toBeDefined();
      const attachedGeneration = await mainPersonaGeneration(
        conversation.id,
        attached,
      );
      const attachedKey = mainPersonaSessionKey(
        runtimeSessionKey(attached!.agentConfig),
        attachedGeneration,
      );
      await setConversationSessionId(
        conversation.id,
        attachedKey,
        'objective-attached-persona-session',
      );
      expect(
        await send('Objective after attaching its main persona.'),
      ).toMatchObject({
        sessionId: 'objective-attached-persona-session',
        mainPersonaGeneration: attachedGeneration,
        agentId: `ai-main:${personaId}`,
      });

      await inviteConversationAiUser(
        conversation.id,
        addressedPersonaId,
        'route-admin-user',
      );
      expect(
        await send('An invited persona must not rotate the objective session.'),
      ).toMatchObject({
        sessionId: 'objective-attached-persona-session',
        mainPersonaGeneration: attachedGeneration,
      });

      const editedPromptPath = await writeAiUserPrompt(
        personaId,
        '---\nidentity: Objective guide\n---\nUse the newly edited objective instructions.',
      );
      await updateAiUserPersonaRow(personaId, {
        promptPath: editedPromptPath,
        updatedAt: new Date().toISOString(),
      });
      const edited = await resolveMainAiUserContext(
        conversation.id,
        getGroupByFolder(projectId)!,
      );
      expect(edited!.sessionFingerprint).not.toBe(attached!.sessionFingerprint);
      const editedGeneration = await mainPersonaGeneration(
        conversation.id,
        edited,
      );
      const editedKey = mainPersonaSessionKey(
        runtimeSessionKey(edited!.agentConfig),
        editedGeneration,
      );
      await setConversationSessionId(
        conversation.id,
        editedKey,
        'objective-edited-persona-session',
      );
      expect(
        await send('Objective after editing its main persona.'),
      ).toMatchObject({
        sessionId: 'objective-edited-persona-session',
        mainPersonaGeneration: editedGeneration,
        systemPromptSuffix: expect.stringContaining(
          'Use the newly edited objective instructions.',
        ),
      });
      expect(
        await send('Objective after the persona edit again.'),
      ).toMatchObject({ sessionId: 'objective-edited-persona-session' });

      await setMainConversationAiUser(conversation.id, {
        mode: 'persona',
        aiUserId: addressedPersonaId,
      });
      const switched = await resolveMainAiUserContext(
        conversation.id,
        getGroupByFolder(projectId)!,
      );
      const switchedGeneration = await mainPersonaGeneration(
        conversation.id,
        switched,
      );
      const switchedKey = mainPersonaSessionKey(
        runtimeSessionKey(switched!.agentConfig),
        switchedGeneration,
      );
      await setConversationSessionId(
        conversation.id,
        switchedKey,
        'objective-switched-persona-session',
      );
      expect(
        await send('Objective after switching its main persona.'),
      ).toMatchObject({
        sessionId: 'objective-switched-persona-session',
        mainPersonaGeneration: switchedGeneration,
      });

      await setMainConversationAiUser(conversation.id, {
        mode: 'persona',
        aiUserId: personaId,
      });
      const returned = await resolveMainAiUserContext(
        conversation.id,
        getGroupByFolder(projectId)!,
      );
      expect(returned?.sessionFingerprint).toBe(edited?.sessionFingerprint);
      const returnedGeneration = await mainPersonaGeneration(
        conversation.id,
        returned,
      );
      const returnedKey = mainPersonaSessionKey(
        runtimeSessionKey(returned!.agentConfig),
        returnedGeneration,
      );
      await setConversationSessionId(
        conversation.id,
        returnedKey,
        'objective-returned-persona-session',
      );
      expect(
        await send('Objective after returning to its earlier main persona.'),
      ).toMatchObject({
        sessionId: 'objective-returned-persona-session',
        mainPersonaGeneration: returnedGeneration,
      });

      await setMainConversationAiUser(conversation.id, { mode: 'none' });
      const removedGeneration = await mainPersonaGeneration(conversation.id);
      expect([
        noPersonaGeneration,
        attachedGeneration,
        editedGeneration,
        switchedGeneration,
        returnedGeneration,
        removedGeneration,
      ]).toEqual([1, 2, 3, 4, 5, 6]);
      const removedKey = mainPersonaSessionKey(
        runtimeSessionKey(chatRuntime),
        removedGeneration,
      );
      await setConversationSessionId(
        conversation.id,
        removedKey,
        'objective-removed-persona-session',
      );
      expect(
        await send('Objective after removing its main persona.'),
      ).toMatchObject({
        sessionId: 'objective-removed-persona-session',
        mainPersonaGeneration: removedGeneration,
      });
      expect(
        await send('Objective after removing its main persona again.'),
      ).toMatchObject({ sessionId: 'objective-removed-persona-session' });
    } finally {
      await fs.rm(aiUserDirectory(personaId), {
        recursive: true,
        force: true,
      });
    }
  });

  test('objective Direct owner auto-runs an admitted tail across a requested runtime switch', async () => {
    calls.length = 0;
    releaseHeldMainTurn = undefined;
    const objective = await createObjective({
      project_id: projectId,
      title: 'Objective direct ownership',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      trigger_config: null,
      metadata: null,
      work_dir: null,
      cost_limit_usd: null,
    });
    const conversation = await createObjectiveConversation(
      projectId,
      objective.id,
    );
    const first = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective_id: objective.id,
        content: 'Hold this main turn for queued-addressing coverage.',
        conversation_id: conversation.id,
        agent_cmd: completionAgentId,
      }),
    });
    expect(first.status).toBe(202);
    await waitForRunner(() => !!releaseHeldMainTurn);

    const secondBody = JSON.stringify({
      content: 'This still belongs to the running direct turn.',
      conversation_id: conversation.id,
      agent_cmd: cliAgentId,
      clientSubmissionId: `objective-direct-${conversation.id}`,
    });
    const second = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: secondBody,
    });
    expect(await second.json()).toMatchObject({
      delivery: 'pending',
      queueOwner: 'direct',
      userMessage: { steeringDelivery: 'pending' },
    });
    const retry = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: secondBody,
    });
    expect(await retry.json()).toMatchObject({
      delivery: 'pending',
      queueOwner: 'direct',
    });
    (releaseHeldMainTurn as (() => void) | undefined)?.();
    const messageId = `objective-direct-${conversation.id}`;
    await waitForCompletion(conversation.id, 2);
    const objectiveCalls = calls.filter((call) => !call.ephemeral);
    expect(objectiveCalls).toHaveLength(2);
    expect(objectiveCalls[1]).toMatchObject({
      harnessId: 'direct',
      harnessKind: 'direct',
      modelId: 'default',
      modelOverride: 'default',
    });
    expect(objectiveCalls[1]?.agentId).not.toBe(codexSolAgentId);
    expect(
      getQueuedChatMessageStates(projectId, conversation.id),
    ).toMatchObject({
      consumed: [messageId],
      released: [],
    });
    const retryAfterCompletion = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: secondBody,
      },
    );
    expect(await retryAfterCompletion.json()).toMatchObject({
      delivery: 'followup',
      queueOwner: 'server',
      userMessage: { id: messageId },
    });
    expect(calls.filter((call) => !call.ephemeral)).toHaveLength(2);
  });

  test('queues another account before objective DirectLLM or CLI steering', async () => {
    calls.length = 0;
    releaseHeldMainTurn = undefined;
    const objective = await createObjective({
      project_id: projectId,
      title: 'Objective account boundary',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      trigger_config: null,
      metadata: null,
      work_dir: null,
      cost_limit_usd: null,
    });
    const conversation = await createObjectiveConversation(
      projectId,
      objective.id,
    );
    const first = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': 'route-admin-user',
      },
      body: JSON.stringify({
        objective_id: objective.id,
        content: 'Hold this main turn for queued-addressing coverage.',
        conversation_id: conversation.id,
        agent_cmd: completionAgentId,
      }),
    });
    expect(first.status).toBe(202);
    await waitForRunner(() => !!releaseHeldMainTurn);
    expect(releaseHeldMainTurn).toBeDefined();
    const second = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': `objective-other-${conversation.id}`,
      },
      body: JSON.stringify({
        objective_id: objective.id,
        content: 'Do not inject this objective turn under the first account.',
        conversation_id: conversation.id,
        agent_cmd: cliAgentId,
        delivery: 'steer',
      }),
    });
    expect(await second.json()).toMatchObject({
      delivery: 'queued',
      queueOwner: 'browser',
    });
    expect(
      calls.some((call) =>
        call.prompt.includes('Do not inject this objective turn'),
      ),
    ).toBe(false);
    (releaseHeldMainTurn as (() => void) | undefined)?.();
  });

  test('objective chat keeps an active Codex turn browser-owned across a requested direct switch', async () => {
    calls.length = 0;
    releaseHeldMainTurn = undefined;
    const objective = await createObjective({
      project_id: projectId,
      title: 'Objective browser ownership',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      trigger_config: null,
      metadata: null,
      work_dir: null,
      cost_limit_usd: null,
    });
    const conversation = await createObjectiveConversation(
      projectId,
      objective.id,
    );
    const first = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective_id: objective.id,
        content: 'Hold this main turn for queued-addressing coverage.',
        conversation_id: conversation.id,
        agent_cmd: cliAgentId,
      }),
    });
    expect(first.status).toBe(202);
    await waitForRunner(() => !!releaseHeldMainTurn);

    const queuedContent = 'Do not persist this into the active Codex turn.';
    const second = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective_id: objective.id,
        content: queuedContent,
        conversation_id: conversation.id,
        agent_cmd: completionAgentId,
      }),
    });
    expect(await second.json()).toMatchObject({
      delivery: 'queued',
      queueOwner: 'browser',
    });
    expect(
      readChatTranscript(projectId, conversation.id).some(
        (entry) =>
          (entry as { type?: unknown }).type === 'message' &&
          (entry as { content?: unknown }).content === queuedContent,
      ),
    ).toBe(false);
    (releaseHeldMainTurn as (() => void) | undefined)?.();
  });

  test('retries a tool-only addressed persona turn and publishes its final prose', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    await inviteConversationAiUser(
      conversation.id,
      addressedPersonaId,
      'route-admin-user',
    );

    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '@Morgan use a tool before answering.',
        conversation_id: conversation.id,
        liveMode: true,
        liveModeKind: 'work',
        liveModeSessionId: `route-tool-live-${conversation.id}`,
      }),
    });
    expect(response.status).toBe(202);
    await waitForRunner(() => calls.length >= 2);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.ephemeral)).toBe(true);
    expect(calls[1]?.harnessKind).toBe('direct');
    expect(calls[1]?.allowedToolNames).toEqual([]);
    type RouteMessage = { type?: string; role?: string; content?: string };
    let messages: RouteMessage[] = [];
    await waitForCompletion(conversation.id, 1);
    messages = (
      readChatTranscript(projectId, conversation.id) as RouteMessage[]
    ).filter((entry) => entry.type === 'message' && entry.role === 'assistant');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('Morgan summarized the tool findings.');
  });

  test('automatically advances a marker-only handoff without a failure message', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    await inviteConversationAiUser(
      conversation.id,
      addressedPersonaId,
      'route-admin-user',
    );

    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Marker-only handoff',
        conversation_id: conversation.id,
      }),
    });
    expect(response.status).toBe(202);

    await waitForRunner(() => calls.length >= 2);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.ephemeral).toBe(false);
    expect(calls[1]?.ephemeral).toBe(true);
    let messages = await getChatMessages(projectId, 20, conversation.id);
    await waitForCompletion(conversation.id);
    messages = await getChatMessages(projectId, 20, conversation.id);
    expect(
      messages.some(
        (message) =>
          message.sender_name === 'Morgan' &&
          message.content === 'Morgan handled the addressed request.',
      ),
    ).toBe(true);

    expect(
      messages.some((message) =>
        message.content.includes('The agent failed to respond'),
      ),
    ).toBe(false);
    expect(await getConversationExecutionLease(conversation.id)).toBeNull();
  });

  test('completion follow-up produces one second run in canonical transcript order', async () => {
    calls.length = 0;
    releaseHeldMainTurn = undefined;
    const conversation = await createConversation(projectId);

    const firstResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Hold this main turn for queued-addressing coverage.',
          conversation_id: conversation.id,
          agent_cmd: cliAgentId,
        }),
      },
    );
    expect(firstResponse.status).toBe(202);
    await waitForRunner(() => !!releaseHeldMainTurn);
    expect(releaseHeldMainTurn).toBeDefined();

    const queuedResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'This must be sent as the next turn.',
          conversation_id: conversation.id,
          agent_cmd: cliAgentId,
          attachments: [
            {
              type: 'audio',
              mimetype: 'audio/webm',
              filename: 'queued.webm',
              path: '/nonexistent/queued.webm',
              transcript: 'queued audio transcript',
              transcriptionSource: 'test',
            },
          ],
        }),
      },
    );
    expect(queuedResponse.status).toBe(200);
    const queuedBody = await queuedResponse.json();
    expect(queuedBody).toMatchObject({
      conversation_id: conversation.id,
      delivery: 'queued',
      queueOwner: 'browser',
    });
    expect(
      readChatTranscript(projectId, conversation.id).some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { type?: unknown }).type === 'message' &&
          (entry as { content?: unknown }).content ===
            'This must be sent as the next turn.',
      ),
    ).toBe(false);
    expect(
      readChatTranscript(projectId, conversation.id).some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { type?: unknown }).type === 'audio_transcription',
      ),
    ).toBe(false);
    (releaseHeldMainTurn as (() => void) | undefined)?.();

    await waitForCompletion(conversation.id, 1);

    expect(await getConversationExecutionLease(conversation.id)).toBeNull();
    expect(getActiveStreamKeyForConv(conversation.id)).toBeUndefined();
    // The fake runner replaces the production runner, so mirror its finally
    // cleanup of the per-conversation run claim before delivering the
    // completion-triggered follow-up.
    chatRunAbortControllers.delete(
      chatAbortKey(projectId, conversation.id, `${projectId}@web`),
    );

    // This is the POST made by the completion queue drainer. The first request
    // proved the backend did not insert turn two into the active turn; this
    // request proves the same payload is accepted once the completion boundary
    // releases ownership.
    const followUpResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'This must be sent as the next turn.',
          conversation_id: conversation.id,
          attachments: [
            {
              type: 'audio',
              mimetype: 'audio/webm',
              filename: 'queued.webm',
              path: '/nonexistent/queued.webm',
              transcript: 'queued audio transcript',
              transcriptionSource: 'test',
            },
          ],
        }),
      },
    );
    expect(followUpResponse.status).toBe(202);
    await waitForCompletion(conversation.id, 2);

    const canonicalTurns = readChatTranscript(projectId, conversation.id)
      .filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { type?: unknown }).type === 'message',
      )
      .map((entry) => ({
        role: (entry as { role?: unknown }).role,
        content: (entry as { content?: unknown }).content,
      }));
    expect(calls.filter((call) => !call.ephemeral)).toHaveLength(2);
    expect(canonicalTurns).toEqual([
      {
        role: 'user',
        content: 'Hold this main turn for queued-addressing coverage.',
      },
      { role: 'assistant', content: 'ok' },
      {
        role: 'user',
        content:
          'This must be sent as the next turn.\n\n[Voice message transcript]: queued audio transcript',
      },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(
      readChatTranscript(projectId, conversation.id).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { type?: unknown }).type === 'audio_transcription',
      ),
    ).toHaveLength(1);
  });

  test('acknowledges DirectLLM mid-turn injection without creating a persona queue item', async () => {
    calls.length = 0;
    releaseHeldMainTurn = undefined;
    const conversation = await createConversation(projectId);
    const firstResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Hold this main turn for queued-addressing coverage.',
          conversation_id: conversation.id,
        }),
      },
    );
    expect(firstResponse.status).toBe(202);
    await waitForRunner(() => !!releaseHeldMainTurn);

    const injectedResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Inject this into the active direct turn.',
          conversation_id: conversation.id,
          openFileContext: {
            source: 'group',
            path: 'notes/direct.txt',
            line: 6,
            column: 4,
          },
        }),
      },
    );
    expect(injectedResponse.status).toBe(200);
    expect(await injectedResponse.json()).toMatchObject({
      delivery: 'pending',
      queueOwner: 'direct',
      userMessage: {
        content: 'Inject this into the active direct turn.',
        steeringDelivery: 'pending',
      },
    });
    expect(
      readChatTranscript(projectId, conversation.id).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { type?: unknown }).type === 'message' &&
          (entry as { role?: unknown }).role === 'user' &&
          (entry as { content?: unknown }).content ===
            'Inject this into the active direct turn.',
      ),
    ).toHaveLength(1);
    const pending = await getPendingChatMessages(
      projectId,
      conversation.id,
      '1970-01-01T00:00:00.000Z',
    );
    expect(
      pending.find((message) =>
        message.content.includes('Inject this into the active direct turn.'),
      )?.executionContent,
    ).toContain('"path":"notes/direct.txt"');
    (releaseHeldMainTurn as (() => void) | undefined)?.();
  });

  test('queues another account instead of injecting into an active DirectLLM turn', async () => {
    calls.length = 0;
    releaseHeldMainTurn = undefined;
    const conversation = await createConversation(projectId);
    const firstUserId = 'route-admin-user';
    const secondUserId = `direct-other-${conversation.id}`;
    const firstResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-user-id': firstUserId,
        },
        body: JSON.stringify({
          content: 'Hold this main turn for queued-addressing coverage.',
          conversation_id: conversation.id,
          agent_cmd: completionAgentId,
          runtimeSelection: { harnessId: 'direct', modelId: 'default' },
        }),
      },
    );
    expect(firstResponse.status).toBe(202);
    await waitForRunner(() => !!releaseHeldMainTurn);
    expect(releaseHeldMainTurn).toBeDefined();

    const secondResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-user-id': secondUserId,
        },
        body: JSON.stringify({
          content: 'Do not inject this under the first account.',
          conversation_id: conversation.id,
          agent_cmd: completionAgentId,
          runtimeSelection: { harnessId: 'direct', modelId: 'default' },
        }),
      },
    );
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({
      delivery: 'queued',
      queueOwner: 'browser',
    });
    expect(
      calls.some((call) =>
        call.prompt.includes('Do not inject this under the first account.'),
      ),
    ).toBe(false);
    expect(
      readChatTranscript(projectId, conversation.id).some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { content?: unknown }).content ===
            'Do not inject this under the first account.',
      ),
    ).toBe(false);
    (releaseHeldMainTurn as (() => void) | undefined)?.();
  });

  test('reports a direct steer as pending until DirectLLM records absorption', async () => {
    calls.length = 0;
    releaseHeldMainTurn = undefined;
    const conversation = await createConversation(projectId);
    const firstResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Hold this main turn for queued-addressing coverage.',
          conversation_id: conversation.id,
        }),
      },
    );
    expect(firstResponse.status).toBe(202);
    await waitForRunner(() => !!releaseHeldMainTurn);

    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Steer the active direct response.',
        conversation_id: conversation.id,
        delivery: 'steer',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      delivery: 'pending',
      queueOwner: 'direct',
      userMessage: { steeringDelivery: 'pending' },
    });
    (releaseHeldMainTurn as (() => void) | undefined)?.();
  });

  test('reconstructs DirectLLM ownership when the first HTTP acknowledgement is lost', async () => {
    calls.length = 0;
    releaseHeldMainTurn = undefined;
    const conversation = await createConversation(projectId);
    const firstResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Hold this main turn for queued-addressing coverage.',
          conversation_id: conversation.id,
        }),
      },
    );
    expect(firstResponse.status).toBe(202);
    await waitForRunner(() => !!releaseHeldMainTurn);

    const clientSubmissionId = `lost-direct-ack-${conversation.id}`;
    const body = JSON.stringify({
      content: 'Preserve the follow-up owner after a lost acknowledgement.',
      conversation_id: conversation.id,
      clientSubmissionId,
    });
    const admitted = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(admitted.status).toBe(200);

    // Retry the same stable ID while the run is still open. This response is
    // what lets the browser retain its server-owned mirror until completion.
    const retry = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(await retry.json()).toMatchObject({
      delivery: 'pending',
      queueOwner: 'direct',
      userMessage: {
        id: clientSubmissionId,
        steeringDelivery: 'pending',
      },
    });
    expect(
      readChatTranscript(projectId, conversation.id).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'id' in entry &&
          entry.id === clientSubmissionId,
      ),
    ).toHaveLength(1);
    const reconciliation = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/queued-messages/reconcile`,
      { method: 'POST' },
    );
    expect(await reconciliation.json()).toMatchObject({
      active: true,
      pending: [clientSubmissionId],
      released: [],
      withdrawn: [],
      queueOwners: { [clientSubmissionId]: 'direct' },
    });
    expect(
      readChatTranscript(projectId, conversation.id).some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'queued_user_released' &&
          'messageId' in entry &&
          entry.messageId === clientSubmissionId,
      ),
    ).toBe(false);
    (releaseHeldMainTurn as (() => void) | undefined)?.();
    await waitForCompletion(conversation.id, 2);
    const transcriptAfterAutomaticFollowup = readChatTranscript(
      projectId,
      conversation.id,
    );
    expect(
      calls.filter(
        (call) =>
          !call.ephemeral &&
          (call.prompt.includes(
            'Hold this main turn for queued-addressing coverage.',
          ) ||
            call.prompt.includes(
              'Preserve the follow-up owner after a lost acknowledgement.',
            )),
      ),
    ).toHaveLength(2);
    expect(
      transcriptAfterAutomaticFollowup.filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'queued_user_consumed' &&
          'messageId' in entry &&
          entry.messageId === clientSubmissionId,
      ),
    ).toHaveLength(1);
    expect(
      transcriptAfterAutomaticFollowup.some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'direct_followup_finished' &&
          'messageId' in entry &&
          entry.messageId === clientSubmissionId,
      ),
    ).toBe(true);

    const retryAfterCompletion = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      },
    );
    expect(await retryAfterCompletion.json()).toMatchObject({
      delivery: 'followup',
      queueOwner: 'server',
      userMessage: { id: clientSubmissionId },
    });
    expect(
      calls.filter(
        (call) =>
          !call.ephemeral &&
          (call.prompt.includes(
            'Hold this main turn for queued-addressing coverage.',
          ) ||
            call.prompt.includes(
              'Preserve the follow-up owner after a lost acknowledgement.',
            )),
      ),
    ).toHaveLength(2);
  });

  test('stops claimed and just-dispatched Direct follow-ups exactly once', async () => {
    for (const [state, content] of [
      ['claimed', 'Stop this claimed follow-up before dispatch.'],
      ['dispatched', 'Stop this dispatched follow-up before provider work.'],
    ] as const) {
      calls.length = 0;
      const conversation = await createConversation(projectId);
      const messageId = `stop-${state}-${conversation.id}`;
      await saveChatMessage({
        id: messageId,
        group_folder: projectId,
        role: 'user',
        content,
        source: 'web',
        created_at: new Date().toISOString(),
        conversation_id: conversation.id,
      });
      appendChatTranscriptEntry(projectId, conversation.id, {
        type: 'direct_user_pending',
        messageId,
        conversation_id: conversation.id,
        agentCmd: completionAgentId,
        executionContent: content,
        created_at: new Date().toISOString(),
      });
      appendChatTranscriptEntry(projectId, conversation.id, {
        type: 'queued_user_released',
        messageId,
        conversation_id: conversation.id,
        created_at: new Date().toISOString(),
      });
      const claimed = await claimReleasedDirectFollowup(
        projectId,
        conversation.id,
        messageId,
      );
      expect(claimed?.won).toBe(true);

      const dispatch =
        state === 'dispatched' && claimed
          ? dispatchClaimedDirectFollowup(claimed.claim.runId)
          : undefined;
      if (dispatch) {
        await waitForRunner(() =>
          calls.some((call) => call.prompt.includes(content)),
        );
        expect(calls.some((call) => call.prompt.includes(content))).toBe(true);
      }

      const stopped = await fetch(
        `${baseUrl}/projects/${projectId}/messages/stop`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversation_id: conversation.id }),
        },
      );
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toEqual({ ok: true, stopped: true });
      if (dispatch) expect(await dispatch).toBe(true);

      const runId = directFollowupRunId(projectId, conversation.id, messageId);
      expect(await getActiveRunById(runId)).toMatchObject({
        status: state === 'claimed' ? 'error' : 'completed',
      });
      const transcript = readChatTranscript(projectId, conversation.id);
      expect(
        transcript.filter(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            'type' in entry &&
            entry.type === 'queued_user_consumed' &&
            'messageId' in entry &&
            entry.messageId === messageId,
        ),
      ).toHaveLength(1);
      expect(
        transcript.filter(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            'type' in entry &&
            entry.type === 'direct_followup_finished' &&
            'messageId' in entry &&
            entry.messageId === messageId,
        ),
      ).toHaveLength(1);
      expect(
        transcript.filter(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            'role' in entry &&
            entry.role === 'assistant' &&
            'content' in entry &&
            entry.content === '⚠️ Run stopped by user.',
        ),
      ).toHaveLength(1);

      await recoverDirectFollowups();
      expect(
        readChatTranscript(projectId, conversation.id).filter(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            'role' in entry &&
            entry.role === 'assistant' &&
            'content' in entry &&
            entry.content === '⚠️ Run stopped by user.',
        ),
      ).toHaveLength(1);
    }
  });

  test('recovers a stopped Direct claim before its finish receipt is durable', async () => {
    const conversation = await createConversation(projectId);
    const messageId = `stopping-recovery-${conversation.id}`;
    const content = 'Finish this stopped claim after restart.';
    await saveChatMessage({
      id: messageId,
      group_folder: projectId,
      role: 'user',
      content,
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'direct_user_pending',
      messageId,
      conversation_id: conversation.id,
      agentCmd: completionAgentId,
      executionContent: content,
      created_at: new Date().toISOString(),
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'queued_user_released',
      messageId,
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });
    const claimed = await claimReleasedDirectFollowup(
      projectId,
      conversation.id,
      messageId,
    );
    expect(claimed?.won).toBe(true);
    expect(
      await stopClaimedDirectFollowupRuns(projectId, conversation.id),
    ).toHaveLength(1);
    expect(
      claimed ? await getActiveRunById(claimed.claim.runId) : null,
    ).toMatchObject({
      stage: 'direct-followup:stopping',
      status: 'running',
    });

    await recoverDirectFollowups();
    const runId = directFollowupRunId(projectId, conversation.id, messageId);
    expect(await getActiveRunById(runId)).toMatchObject({
      stage: 'direct-followup:stopping',
      status: 'error',
    });
    expect(await dispatchClaimedDirectFollowup(runId)).toBe(false);
    await recoverDirectFollowups();

    const transcript = readChatTranscript(projectId, conversation.id);
    expect(
      transcript.filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'queued_user_consumed' &&
          'messageId' in entry &&
          entry.messageId === messageId,
      ),
    ).toHaveLength(1);
    expect(
      transcript.filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'direct_followup_finished' &&
          'messageId' in entry &&
          entry.messageId === messageId,
      ),
    ).toHaveLength(1);
    expect(
      transcript.filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'role' in entry &&
          entry.role === 'assistant' &&
          'content' in entry &&
          entry.content === '⚠️ Run stopped by user.',
      ),
    ).toHaveLength(1);
  });

  test('boot recovery dispatches a claimed Direct follow-up at most once', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const messageId = `restart-direct-${conversation.id}`;
    await saveChatMessage({
      id: messageId,
      group_folder: projectId,
      role: 'user',
      content: 'Resume this claimed follow-up after restart.',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'direct_user_pending',
      messageId,
      conversation_id: conversation.id,
      agentCmd: completionAgentId,
      executionContent: 'Resume this claimed follow-up after restart.',
      triggeredByUserId: null,
      triggerSource: 'system',
      created_at: new Date().toISOString(),
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'queued_user_released',
      messageId,
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });
    const claimed = await claimReleasedDirectFollowup(
      projectId,
      conversation.id,
      messageId,
    );
    expect(claimed?.won).toBe(true);

    await recoverDirectFollowups();
    await waitForCompletion(conversation.id, 1);

    expect(
      calls.filter(
        (call) =>
          !call.ephemeral &&
          call.prompt.includes('Resume this claimed follow-up after restart.'),
      ),
    ).toHaveLength(1);
    expect(
      claimed ? (await getActiveRunById(claimed.claim.runId))?.status : null,
    ).toBe('completed');
    expect(
      readChatTranscript(projectId, conversation.id).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'direct_followup_finished' &&
          'messageId' in entry &&
          entry.messageId === messageId,
      ),
    ).toHaveLength(1);
  });

  test('boot recovery dispatches a claimed CLI-chat follow-up whose blocking lease belongs to a dead run', async () => {
    // The stuck-row shape: a CLI-harness chat, no newer activity, and the lease
    // of a run that died with the previous process. That lease expires only
    // after MCP_AGENT_TIMEOUT + 60 s (days) and nothing renews it.
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const messageId = `cli-stuck-${conversation.id}`;
    const content = `Queued while the CLI turn was being recovered ${conversation.id}.`;
    await saveChatMessage({
      id: messageId,
      group_folder: projectId,
      role: 'user',
      content,
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'direct_user_pending',
      messageId,
      conversation_id: conversation.id,
      agentCmd: cliAgentId,
      runtimeSelection: { harnessId: 'codex', modelId: 'default' },
      executionContent: content,
      triggeredByUserId: null,
      triggerSource: 'user',
      created_at: new Date().toISOString(),
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'queued_user_released',
      messageId,
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });
    expect(
      (await claimReleasedDirectFollowup(projectId, conversation.id, messageId))
        ?.won,
    ).toBe(true);
    const deadOwner = `human:cli-run-${conversation.id}`;
    await acquireConversationExecutionLease(conversation.id, deadOwner);
    await drizzleDbRef.current
      .update(conversationExecutionLeases)
      .set({
        updated_at: new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
      })
      .where(eq(conversationExecutionLeases.conversation_id, conversation.id));
    const runId = directFollowupRunId(projectId, conversation.id, messageId);
    try {
      await recoverDirectFollowups();
      for (let i = 0; i < 200; i++) {
        if ((await getActiveRunById(runId))?.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await releaseConversationExecutionLease(conversation.id, deadOwner);
    }

    expect(await getActiveRunById(runId)).toMatchObject({
      status: 'completed',
    });
    expect(
      calls.filter((call) => !call.ephemeral && call.prompt.includes(content)),
    ).toHaveLength(1);
  });

  test('boot recovery finishes direct follow-up admission after only the pending receipt was durable', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const messageId = `pending-only-restart-${conversation.id}`;
    const content = 'Recover the accepted prompt from the admission gap.';
    await saveChatMessage({
      id: messageId,
      group_folder: projectId,
      role: 'user',
      content,
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'direct_user_pending',
      messageId,
      conversation_id: conversation.id,
      agentCmd: completionAgentId,
      executionContent: content,
      triggeredByUserId: 'route-admin-user',
      triggerSource: 'user',
      created_at: new Date().toISOString(),
    });

    await recoverDirectFollowups();
    const runId = directFollowupRunId(projectId, conversation.id, messageId);
    await waitForCompletion(conversation.id, 1);

    expect(
      calls.filter((call) => !call.ephemeral && call.prompt.includes(content)),
    ).toHaveLength(1);
    expect(await getActiveRunById(runId)).toMatchObject({
      status: 'completed',
    });
    expect(
      readChatTranscript(projectId, conversation.id).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'queued_user_released' &&
          'messageId' in entry &&
          entry.messageId === messageId,
      ),
    ).toHaveLength(1);
  });

  test('recovery terminalizes dispatched output without a duplicate assistant', async () => {
    const conversation = await createConversation(projectId);
    const messageId = `dispatched-direct-${conversation.id}`;
    await saveChatMessage({
      id: messageId,
      group_folder: projectId,
      role: 'user',
      content: 'Do not duplicate recovered provider output.',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'direct_user_pending',
      messageId,
      conversation_id: conversation.id,
      agentCmd: completionAgentId,
      executionContent: 'Do not duplicate recovered provider output.',
      created_at: new Date().toISOString(),
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'queued_user_released',
      messageId,
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });
    const claimed = await claimReleasedDirectFollowup(
      projectId,
      conversation.id,
      messageId,
    );
    expect(claimed?.won).toBe(true);
    expect(
      claimed
        ? await beginDirectFollowupDispatch(
            claimed.claim.runId,
            conversation.id,
          )
        : false,
    ).toBe(true);
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'queued_user_consumed',
      messageId,
      consumer: 'direct-followup',
      runId: claimed?.claim.runId,
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      id: `${messageId}-assistant`,
      type: 'message',
      role: 'assistant',
      content: 'Recovered provider answer.',
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });

    await recoverDirectFollowups();

    const transcript = readChatTranscript(projectId, conversation.id);
    expect(
      transcript.filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'role' in entry &&
          entry.role === 'assistant' &&
          'content' in entry &&
          typeof entry.content === 'string',
      ),
    ).toHaveLength(1);
    expect(
      transcript.some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'content' in entry &&
          typeof entry.content === 'string' &&
          entry.content.includes('interrupted after provider dispatch'),
      ),
    ).toBe(false);
    expect(
      claimed ? (await getActiveRunById(claimed.claim.runId))?.status : null,
    ).toBe('error');
  });

  test('does not duplicate an objective projection recovered after its finish-receipt crash window', async () => {
    const objective = await createObjective({
      project_id: projectId,
      title: 'Recovered Direct objective',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      trigger_config: null,
      metadata: null,
      work_dir: null,
      cost_limit_usd: null,
    });
    const conversation = await createObjectiveConversation(
      projectId,
      objective.id,
    );
    const messageId = `objective-dispatched-${conversation.id}`;
    const userMessage = await saveChatMessage({
      id: messageId,
      group_folder: projectId,
      role: 'user',
      content: 'Recover this objective provider output.',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
      objective_id: objective.id,
    });

    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'direct_user_pending',
      messageId,
      conversation_id: conversation.id,
      objectiveId: objective.id,
      agentCmd: completionAgentId,
      executionContent: 'Recover this objective provider output.',
      created_at: new Date().toISOString(),
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'queued_user_released',
      messageId,
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });
    const claimed = await claimReleasedDirectFollowup(
      projectId,
      conversation.id,
      messageId,
    );
    expect(claimed?.won).toBe(true);
    expect(
      claimed
        ? await beginDirectFollowupDispatch(
            claimed.claim.runId,
            conversation.id,
          )
        : false,
    ).toBe(true);
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'queued_user_consumed',
      messageId,
      consumer: 'direct-followup',
      runId: claimed?.claim.runId,
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      id: `${messageId}-provider-assistant`,
      type: 'message',
      role: 'assistant',
      content: 'Recovered objective provider answer.',
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });
    const assistant = await saveChatMessage({
      group_folder: projectId,
      role: 'assistant',
      content: 'Recovered objective provider answer.',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
      objective_id: objective.id,
      failed: false,
      skipTranscript: true,
    });

    await recoverDirectFollowups();

    const objectiveMessages = await getChatMessages(
      projectId,
      100,
      conversation.id,
    );
    expect(
      objectiveMessages.filter(
        (message) =>
          message.role === 'assistant' &&
          message.content === 'Recovered objective provider answer.',
      ),
    ).toHaveLength(1);
  });

  test('keeps a legacy released Direct message browser-retryable', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const messageId = `legacy-released-${conversation.id}`;
    await saveChatMessage({
      id: messageId,
      group_folder: projectId,
      role: 'user',
      content: 'Retry this legacy released message.',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'direct_user_pending',
      messageId,
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'queued_user_released',
      messageId,
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });

    const retry = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Retry this legacy released message.',
        conversation_id: conversation.id,
        clientSubmissionId: messageId,
        agent_cmd: completionAgentId,
      }),
    });
    expect(retry.status).toBe(202);
    expect(
      calls.filter((call) =>
        call.prompt.includes('Retry this legacy released message.'),
      ),
    ).toHaveLength(1);
    expect(
      readChatTranscript(projectId, conversation.id).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'message' &&
          'id' in entry &&
          entry.id === messageId,
      ),
    ).toHaveLength(1);
  });

  test('retries a legacy consumed Direct message without duplicating its receipt', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const messageId = `legacy-consumed-${conversation.id}`;
    await saveChatMessage({
      id: messageId,
      group_folder: projectId,
      role: 'user',
      content: 'Retry this orphaned legacy consumption.',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    for (const entry of [
      { type: 'direct_user_pending', messageId },
      { type: 'queued_user_released', messageId },
      { type: 'queued_user_consumed', messageId },
    ]) {
      appendChatTranscriptEntry(projectId, conversation.id, {
        ...entry,
        conversation_id: conversation.id,
        created_at: new Date().toISOString(),
      });
    }

    const retry = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Retry this orphaned legacy consumption.',
        conversation_id: conversation.id,
        clientSubmissionId: messageId,
        agent_cmd: completionAgentId,
      }),
    });
    expect(retry.status).toBe(202);
    expect(
      calls.filter((call) =>
        call.prompt.includes('Retry this orphaned legacy consumption.'),
      ),
    ).toHaveLength(1);
    expect(
      readChatTranscript(projectId, conversation.id).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'queued_user_consumed' &&
          'messageId' in entry &&
          entry.messageId === messageId,
      ),
    ).toHaveLength(1);
  });

  test('keeps new project and objective posts behind a durable claimed run', async () => {
    calls.length = 0;
    const objective = await createObjective({
      project_id: projectId,
      title: 'Durable busy objective',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      trigger_config: null,
      metadata: null,
      work_dir: null,
      cost_limit_usd: null,
    });
    const cases = [
      {
        conversation: await createConversation(projectId),
        endpoint: `${baseUrl}/projects/${projectId}/messages`,
        objectiveId: undefined,
      },
      {
        conversation: await createObjectiveConversation(
          projectId,
          objective.id,
        ),
        endpoint: `${baseUrl}/projects/${projectId}/messages`,
        objectiveId: objective.id,
      },
    ];
    for (const [index, busyCase] of cases.entries()) {
      const ownerMessageId = `durable-busy-owner-${index}-${busyCase.conversation.id}`;
      await saveChatMessage({
        id: ownerMessageId,
        group_folder: projectId,
        role: 'user',
        content: 'Durable server owner.',
        source: 'web',
        created_at: new Date().toISOString(),
        conversation_id: busyCase.conversation.id,
        objective_id: busyCase.objectiveId,
      });
      appendChatTranscriptEntry(projectId, busyCase.conversation.id, {
        type: 'direct_user_pending',
        messageId: ownerMessageId,
        conversation_id: busyCase.conversation.id,
        objectiveId: busyCase.objectiveId,
        agentCmd: completionAgentId,
        executionContent: 'Durable server owner.',
        created_at: new Date().toISOString(),
      });
      appendChatTranscriptEntry(projectId, busyCase.conversation.id, {
        type: 'queued_user_released',
        messageId: ownerMessageId,
        conversation_id: busyCase.conversation.id,
        created_at: new Date().toISOString(),
      });
      const claimed = await claimReleasedDirectFollowup(
        projectId,
        busyCase.conversation.id,
        ownerMessageId,
      );
      expect(claimed?.won).toBe(true);

      const blockedContent = `Wait behind durable owner ${index}.`;
      const blocked = await fetch(busyCase.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: blockedContent,
          conversation_id: busyCase.conversation.id,
          agent_cmd: completionAgentId,
        }),
      });
      expect(await blocked.json()).toMatchObject({
        delivery: 'queued',
        queueOwner: 'browser',
      });
      expect(calls.some((call) => call.prompt.includes(blockedContent))).toBe(
        false,
      );
      if (claimed) await completeActiveRun(claimed.claim.runId, 'error');
    }
  });

  test('serializes multiple released Direct follow-ups per conversation', async () => {
    calls.length = 0;
    releaseHeldMainTurn = undefined;
    releaseFirstSerialFollowup = undefined;
    const conversation = await createConversation(projectId);
    const initial = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Hold this main turn for queued-addressing coverage.',
        conversation_id: conversation.id,
      }),
    });
    expect(initial.status).toBe(202);
    await waitForRunner(() => !!releaseHeldMainTurn);

    for (const [clientSubmissionId, content] of [
      ['serial-direct-one', 'Serial follow-up one must finish first.'],
      ['serial-direct-two', 'Serial follow-up two must wait.'],
    ] as const) {
      const admitted = await fetch(
        `${baseUrl}/projects/${projectId}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content,
            conversation_id: conversation.id,
            clientSubmissionId: `${clientSubmissionId}-${conversation.id}`,
          }),
        },
      );
      expect(await admitted.json()).toMatchObject({
        delivery: 'pending',
        queueOwner: 'direct',
      });
    }
    (releaseHeldMainTurn as (() => void) | undefined)?.();
    await waitForRunner(() => !!releaseFirstSerialFollowup);
    expect(releaseFirstSerialFollowup).toBeDefined();
    expect(
      calls.some((call) =>
        call.prompt.includes('Serial follow-up two must wait.'),
      ),
    ).toBe(false);
    const secondMessageId = `serial-direct-two-${conversation.id}`;
    expect(
      await dispatchClaimedDirectFollowup(
        directFollowupRunId(projectId, conversation.id, secondMessageId),
      ),
    ).toBe(false);
    expect(
      readChatTranscript(projectId, conversation.id).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'queued_user_consumed' &&
          'messageId' in entry &&
          entry.messageId === secondMessageId,
      ),
    ).toHaveLength(0);

    (releaseFirstSerialFollowup as (() => void) | undefined)?.();
    await waitForCompletion(conversation.id, 3);
    expect(
      calls.filter(
        (call) =>
          call.prompt.includes('Serial follow-up one must finish first.') ||
          call.prompt.includes('Serial follow-up two must wait.'),
      ),
    ).toHaveLength(2);
  });
  test('does not attribute an earlier response to a later pre-output restart', async () => {
    const conversation = await createConversation(projectId);
    const firstMessageId = `serial-recovery-one-${conversation.id}`;
    const secondMessageId = `serial-recovery-two-${conversation.id}`;
    for (const [messageId, executionContent] of [
      [firstMessageId, 'Complete before the next claimed restart.'],
      [secondMessageId, 'Restart before producing provider output.'],
    ] as const) {
      await saveChatMessage({
        id: messageId,
        group_folder: projectId,
        role: 'user',
        content: executionContent,
        source: 'web',
        created_at: new Date().toISOString(),
        conversation_id: conversation.id,
      });
      appendChatTranscriptEntry(projectId, conversation.id, {
        type: 'direct_user_pending',
        messageId,
        conversation_id: conversation.id,
        agentCmd: completionAgentId,
        executionContent,
        created_at: new Date().toISOString(),
      });
      appendChatTranscriptEntry(projectId, conversation.id, {
        type: 'queued_user_released',
        messageId,
        conversation_id: conversation.id,
        created_at: new Date().toISOString(),
      });
      expect(
        (
          await claimReleasedDirectFollowup(
            projectId,
            conversation.id,
            messageId,
          )
        )?.won,
      ).toBe(true);
    }

    expect(
      readChatTranscript(projectId, conversation.id).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'queued_user_consumed',
      ),
    ).toHaveLength(0);

    const firstAssistant = await saveChatMessage({
      group_folder: projectId,
      role: 'assistant',
      content: 'First follow-up response.',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'direct_followup_finished',
      messageId: firstMessageId,
      runId: directFollowupRunId(projectId, conversation.id, firstMessageId),
      assistantMessageId: firstAssistant.id,
      outcome: 'completed',
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });
    await completeActiveRun(
      directFollowupRunId(projectId, conversation.id, firstMessageId),
      'completed',
    );

    const secondRunId = directFollowupRunId(
      projectId,
      conversation.id,
      secondMessageId,
    );
    expect(
      await beginDirectFollowupDispatch(secondRunId, conversation.id),
    ).toBe(true);
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'queued_user_consumed',
      messageId: secondMessageId,
      consumer: 'direct-followup',
      runId: secondRunId,
      conversation_id: conversation.id,
      created_at: new Date().toISOString(),
    });

    await recoverDirectFollowups();

    const transcript = readChatTranscript(projectId, conversation.id);
    expect(
      transcript.find(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'direct_followup_finished' &&
          'messageId' in entry &&
          entry.messageId === secondMessageId,
      ),
    ).toMatchObject({
      assistantMessageId: `${secondRunId}:failure`,
      outcome: 'failed',
    });
    expect(
      transcript.flatMap((entry) =>
        entry &&
        typeof entry === 'object' &&
        'role' in entry &&
        entry.role === 'assistant' &&
        'content' in entry &&
        typeof entry.content === 'string'
          ? [entry.content]
          : [],
      ),
    ).toEqual([
      'First follow-up response.',
      '⚠️ The queued message was interrupted after provider dispatch and was not replayed to avoid a duplicate response.',
    ]);
  });

  test('persists failed, stopped, and early-error released-tail responses exactly once', async () => {
    for (const terminalCase of [
      {
        content: 'Provider failure released tail.',
        expectedRunStatus: 'error',
        expectedOutcome: 'failed',
        expectedResponse: '⚠️ Provider failed.',
      },
      {
        content: 'User stop released tail.',
        expectedRunStatus: 'completed',
        expectedOutcome: 'completed',
        expectedResponse: '⚠️ Run stopped by user.',
      },
      {
        content: 'Early follow-up error released tail.',
        expectedRunStatus: 'error',
        expectedOutcome: 'failed',
        expectedResponse:
          '⚠️ The agent failed to respond: early follow-up failure',
      },
    ] as const) {
      releaseHeldMainTurn = undefined;
      const conversation = await createConversation(projectId);
      const initial = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Hold this main turn for queued-addressing coverage.',
          conversation_id: conversation.id,
        }),
      });
      expect(initial.status).toBe(202);
      await waitForRunner(() => !!releaseHeldMainTurn);
      const messageId = `terminal-tail-${terminalCase.expectedOutcome}-${conversation.id}`;
      const admitted = await fetch(
        `${baseUrl}/projects/${projectId}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: terminalCase.content,
            conversation_id: conversation.id,
            clientSubmissionId: messageId,
          }),
        },
      );
      expect(await admitted.json()).toMatchObject({
        delivery: 'pending',
        queueOwner: 'direct',
      });
      (releaseHeldMainTurn as (() => void) | undefined)?.();
      const runId = directFollowupRunId(projectId, conversation.id, messageId);
      await waitForCompletion(conversation.id, 2);
      expect((await getActiveRunById(runId))?.status).toBe(
        terminalCase.expectedRunStatus,
      );
      expect(
        readChatTranscript(projectId, conversation.id).some(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            'type' in entry &&
            entry.type === 'direct_followup_finished' &&
            'messageId' in entry &&
            entry.messageId === messageId &&
            'outcome' in entry &&
            entry.outcome === terminalCase.expectedOutcome,
        ),
      ).toBe(true);
      expect(
        readChatTranscript(projectId, conversation.id).filter(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            'role' in entry &&
            entry.role === 'assistant' &&
            'content' in entry &&
            entry.content === terminalCase.expectedResponse,
        ),
      ).toHaveLength(1);
      await recoverDirectFollowups();
      expect(
        readChatTranscript(projectId, conversation.id).filter(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            'role' in entry &&
            entry.role === 'assistant' &&
            'content' in entry &&
            entry.content === terminalCase.expectedResponse,
        ),
      ).toHaveLength(1);
    }
  });
  test('leaves a rejected Codex steer browser-owned without persisting a duplicate turn', async () => {
    calls.length = 0;
    releaseHeldMainTurn = undefined;
    const conversation = await createConversation(projectId);
    const firstResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Hold this main turn for queued-addressing coverage.',
          conversation_id: conversation.id,
          agent_cmd: cliAgentId,
        }),
      },
    );
    expect(firstResponse.status).toBe(202);
    await waitForRunner(() => !!releaseHeldMainTurn);

    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Retry this after the Codex run.',
        conversation_id: conversation.id,
        agent_cmd: cliAgentId,
        delivery: 'steer',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      delivery: 'queued',
      queueOwner: 'browser',
    });
    expect(
      readChatTranscript(projectId, conversation.id).some(
        (entry) =>
          (entry as { type?: string }).type === 'message' &&
          (entry as { content?: string }).content ===
            'Retry this after the Codex run.',
      ),
    ).toBe(false);
    (releaseHeldMainTurn as (() => void) | undefined)?.();
  });

  test('denies queue reconciliation without conversation write access', async () => {
    const conversation = await createConversation(projectId);
    appendChatTranscriptEntry(projectId, conversation.id, {
      id: 'private-persona-prompt',
      type: 'queued_user_message',
      role: 'user',
      content: 'must remain private and pending',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });

    const denied = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/queued-messages/reconcile`,
      { method: 'POST', headers: { 'x-test-denied-user': '1' } },
    );
    expect(denied.status).toBe(403);

    const authorized = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/queued-messages/reconcile`,
      { method: 'POST' },
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      active: false,
      pending: [],
      consumed: [],
      released: ['private-persona-prompt'],
      withdrawn: [],
      queueOwners: {},
    });
  });

  test('withdraws a restored persona prompt before a browser action', async () => {
    const conversation = await createConversation(projectId);
    appendChatTranscriptEntry(projectId, conversation.id, {
      id: 'restored-persona-prompt',
      type: 'queued_user_message',
      role: 'user',
      content: 'change this after refresh',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    const url = `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/queued-messages/restored-persona-prompt`;

    const denied = await fetch(url, {
      method: 'DELETE',
      headers: { 'x-test-denied-user': '1' },
    });
    expect(denied.status).toBe(403);

    const withdrawn = await fetch(url, { method: 'DELETE' });
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toEqual({
      withdrawn: true,
      released: false,
    });

    const repeated = await fetch(url, { method: 'DELETE' });
    expect(await repeated.json()).toEqual({
      withdrawn: false,
      released: false,
    });
    expect(
      await getPendingChatMessages(
        projectId,
        conversation.id,
        '2000-01-01T00:00:00.000Z',
      ),
    ).toEqual([]);
    expect(getQueuedChatMessageStates(projectId, conversation.id)).toEqual({
      pending: [],
      consumed: [],
      released: [],
      withdrawn: ['restored-persona-prompt'],
      queueOwners: {},
    });

    appendChatTranscriptEntry(projectId, conversation.id, {
      id: 'refresh-released-prompt',
      type: 'queued_user_message',
      role: 'user',
      content: 'edit while refresh reconciliation returns',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });
    const reconciliation = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/queued-messages/reconcile`,
      { method: 'POST' },
    );
    expect(reconciliation.status).toBe(200);
    const released = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/queued-messages/refresh-released-prompt`,
      { method: 'DELETE' },
    );
    expect(await released.json()).toEqual({
      withdrawn: false,
      released: true,
    });
  });

  test('keeps a reconciled production persona prompt server-owned', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const messageId = `refresh-server-owned-${conversation.id}`;
    appendChatTranscriptEntry(projectId, conversation.id, {
      id: messageId,
      type: 'queued_user_message',
      role: 'user',
      content: 'Dispatch this restored production persona prompt once.',
      source: 'web',
      senderUserId: 'route-admin-user',
      triggerSource: 'user',
      queuedExecutionContent:
        'Dispatch this restored production persona prompt once.',
      queuedAgentCmd: completionAgentId,
      queuedChatMode: null,
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });

    const reconciliation = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/queued-messages/reconcile`,
      { method: 'POST' },
    );
    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toMatchObject({
      active: false,
      pending: [],
      released: [],
      withdrawn: [],
    });

    const withdrawal = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/queued-messages/${messageId}`,
      { method: 'DELETE' },
    );
    expect(await withdrawal.json()).toEqual({
      withdrawn: false,
      released: false,
    });
    await waitForCompletion(conversation.id);
    expect(
      calls.filter((call) =>
        call.prompt.includes(
          'Dispatch this restored production persona prompt once.',
        ),
      ),
    ).toHaveLength(1);
  });

  test('retries a lost message acknowledgement without starting the turn twice', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const clientSubmissionId = 'browser-submission-lost-ack';
    const body = JSON.stringify({
      content: 'Run this stable browser submission once.',
      conversation_id: conversation.id,
      agent_cmd: cliAgentId,
      clientSubmissionId,
    });

    // Treat the first response as lost: the browser retains the same queued
    // candidate and retries its stable ID after observing completion.
    const first = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(202);
    const retry = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      conversation_id: conversation.id,
      userMessage: { id: clientSubmissionId },
    });
    await waitForRunner(() => calls.length >= 1);
    expect(calls).toHaveLength(1);
    expect(
      readChatTranscript(projectId, conversation.id).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { id?: unknown }).id === clientSubmissionId,
      ),
    ).toHaveLength(1);
  });

  test('queues a concurrent second submission before chat_started is published', async () => {
    calls.length = 0;
    releaseHeldMainTurn = undefined;
    const conversation = await createConversation(projectId);
    const first = fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Hold this main turn for queued-addressing coverage.',
        conversation_id: conversation.id,
        agent_cmd: cliAgentId,
      }),
    });
    const second = fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Queue this concurrent second turn.',
        conversation_id: conversation.id,
        agent_cmd: cliAgentId,
      }),
    });
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({
      delivery: 'queued',
      queueOwner: 'browser',
    });
    expect(
      readChatTranscript(projectId, conversation.id).some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { content?: unknown }).content ===
            'Queue this concurrent second turn.',
      ),
    ).toBe(false);
    (releaseHeldMainTurn as (() => void) | undefined)?.();
  });

  test('keeps a queued exact @persona message away from the main runtime', async () => {
    calls.length = 0;
    releaseHeldMainTurn = undefined;
    const conversation = await createConversation(projectId);
    const queuedTriggerer = await createUser(
      `queued-triggerer-${conversation.id}`,
      'pw',
      'user',
    );
    await inviteConversationAiUser(
      conversation.id,
      addressedPersonaId,
      'route-admin-user',
    );
    const liveMode = {
      liveMode: true,
      liveModeKind: 'work',
      liveModeSessionId: `route-queued-live-${conversation.id}`,
    };

    const firstResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Hold this main turn for queued-addressing coverage.',
          conversation_id: conversation.id,
          ...liveMode,
        }),
      },
    );
    expect(firstResponse.status).toBe(202);
    await waitForRunner(() => !!releaseHeldMainTurn);
    expect(releaseHeldMainTurn).toBeDefined();

    const queuedResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-user-id': queuedTriggerer.id,
        },
        body: JSON.stringify({
          content: '@Morgan handle the queued follow-up.',
          conversation_id: conversation.id,
          clientSubmissionId: 'stable-persona-queue-id',
          clientSubmissionIds: [
            'stable-persona-queue-id',
            'stable-persona-queue-second-id',
          ],
          attachments: [
            {
              type: 'document',
              mimetype: 'text/plain',
              filename: 'persona-notes.txt',
              url: '/api/attachments/persona-notes.txt',
            },
          ],
          deepLinks: [
            { label: 'Queued task', href: '/projects/route-runtime-handoff' },
          ],
          agent_cmd: cliAgentId,
          runtimeSelection: { harnessId: 'codex', modelId: 'default' },
          chat_mode: 'plan',
          memoryContext: { level: 'minimal' },
          ...liveMode,
        }),
      },
    );
    expect(queuedResponse.status).toBe(200);
    expect(await queuedResponse.json()).toMatchObject({
      delivery: 'queued',
      queueOwner: 'persona',
      queuedMessageId: 'stable-persona-queue-id',
    });
    expect(await getConversation(conversation.id)).toMatchObject({
      lastTriggeredByUserId: queuedTriggerer.id,
      lastTriggerSource: 'user',
    });
    const retriedResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-user-id': queuedTriggerer.id,
        },
        body: JSON.stringify({
          content: '@Morgan handle the queued follow-up.',
          conversation_id: conversation.id,
          clientSubmissionId: 'stable-persona-queue-id',
          clientSubmissionIds: [
            'stable-persona-queue-id',
            'stable-persona-queue-second-id',
          ],
          attachments: [
            {
              type: 'document',
              mimetype: 'text/plain',
              filename: 'persona-notes.txt',
              url: '/api/attachments/persona-notes.txt',
            },
          ],
          deepLinks: [
            { label: 'Queued task', href: '/projects/route-runtime-handoff' },
          ],
          agent_cmd: cliAgentId,
          runtimeSelection: { harnessId: 'codex', modelId: 'default' },
          chat_mode: 'plan',
          memoryContext: { level: 'minimal' },
          ...liveMode,
        }),
      },
    );
    expect(await retriedResponse.json()).toMatchObject({
      delivery: 'queued',
      queueOwner: 'persona',
      queuedMessageId: 'stable-persona-queue-id',
    });
    expect(
      readChatTranscript(projectId, conversation.id).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { type?: unknown }).type === 'queued_user_message' &&
          (entry as { id?: unknown }).id === 'stable-persona-queue-id',
      ),
    ).toHaveLength(1);
    expect(
      readChatTranscript(projectId, conversation.id).find(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { type?: unknown }).type === 'queued_user_message' &&
          (entry as { id?: unknown }).id === 'stable-persona-queue-id',
      ),
    ).toMatchObject({
      attachments: [expect.objectContaining({ filename: 'persona-notes.txt' })],
      deepLinks: [
        { label: 'Queued task', href: '/projects/route-runtime-handoff' },
      ],
      queuedAgentCmd: cliAgentId,
      queuedRuntimeSelection: { harnessId: 'codex', modelId: 'default' },
      queuedChatMode: 'plan',
      queuedMemoryContextLevel: 'minimal',
      clientSubmissionIds: [
        'stable-persona-queue-id',
        'stable-persona-queue-second-id',
      ],
    });
    expect(
      readChatTranscript(projectId, conversation.id).some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { content?: unknown }).content ===
            '@Morgan handle the queued follow-up.',
      ),
    ).toBe(true);
    (releaseHeldMainTurn as (() => void) | undefined)?.();

    await waitForRunner(() =>
      calls.some((call) =>
        call.prompt.includes('@Morgan handle the queued follow-up.'),
      ),
    );
    const queuedDeliveries = calls.filter((call) =>
      call.prompt.includes('@Morgan handle the queued follow-up.'),
    );
    expect(queuedDeliveries).toHaveLength(1);
    expect(queuedDeliveries[0]?.ephemeral).toBe(true);
    expect(queuedDeliveries[0]).toMatchObject({
      senderUserId: queuedTriggerer.id,
      triggeredByUserId: queuedTriggerer.id,
      triggerSource: 'user',
    });
    expect(await getConversation(conversation.id)).toMatchObject({
      lastTriggeredByUserId: queuedTriggerer.id,
      lastTriggerSource: 'user',
    });
    const deliveredRows = readChatTranscript(projectId, conversation.id).filter(
      (entry) =>
        !!entry &&
        typeof entry === 'object' &&
        (entry as { type?: unknown }).type === 'message' &&
        (entry as { role?: unknown }).role === 'user' &&
        (entry as { content?: unknown }).content ===
          '@Morgan handle the queued follow-up.',
    );
    expect(deliveredRows).toHaveLength(1);
    expect(deliveredRows[0]).toMatchObject({
      attachments: [expect.objectContaining({ filename: 'persona-notes.txt' })],
      deepLinks: [
        { label: 'Queued task', href: '/projects/route-runtime-handoff' },
      ],
      clientSubmissionIds: [
        'stable-persona-queue-id',
        'stable-persona-queue-second-id',
      ],
    });
  });

  test('attributes automatic compaction to the originating human', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const triggerer = await createUser(
      `compaction-triggerer-${conversation.id}`,
      'pw',
      'user',
    );

    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': triggerer.id,
      },
      body: JSON.stringify({
        content: 'Trigger automatic compaction attribution.',
        conversation_id: conversation.id,
        agent_cmd: cliAgentId,
      }),
    });
    expect(response.status).toBe(202);

    await waitForRunner(() =>
      calls.some((call) => call.prompt.includes('Please summarize')),
    );
    const compactionCall = calls.find((call) =>
      call.prompt.includes('Please summarize'),
    );
    expect(compactionCall).toMatchObject({
      triggeredByUserId: triggerer.id,
      triggerSource: 'user',
    });
  });

  test('releases a persona-owned prompt when the addressed persona produces no response', async () => {
    calls.length = 0;
    releaseSilentPersonaTurn = undefined;
    const conversation = await createConversation(projectId);
    await inviteConversationAiUser(
      conversation.id,
      addressedPersonaId,
      'route-admin-user',
    );
    const liveMode = {
      liveMode: true,
      liveModeKind: 'work',
      liveModeSessionId: `route-silent-live-${conversation.id}`,
    };
    const firstResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: '@Morgan remain silent',
          conversation_id: conversation.id,
          ...liveMode,
        }),
      },
    );
    expect(firstResponse.status).toBe(202);
    await waitForRunner(() => !!releaseSilentPersonaTurn);
    expect(releaseSilentPersonaTurn).toBeDefined();
    const queuedResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'release this after persona failure',
          conversation_id: conversation.id,
          ...liveMode,
        }),
      },
    );
    const queued = (await queuedResponse.json()) as {
      queueOwner?: string;
      queuedMessageId?: string;
    };
    expect(queued.queueOwner).toBe('persona');

    (releaseSilentPersonaTurn as (() => void) | undefined)?.();
    await waitForCompletion(conversation.id, 1);
    expect(
      readChatTranscript(projectId, conversation.id).some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { type?: unknown }).type === 'queued_user_released' &&
          (entry as { messageId?: unknown }).messageId ===
            queued.queuedMessageId,
      ),
    ).toBe(true);
  });

  test('keeps unaddressed and invalid @mentions on the normal main-first path', async () => {
    for (const content of [
      'Please inspect this normally.',
      '@Nobody inspect this.',
    ]) {
      calls.length = 0;
      const conversation = await createConversation(projectId);
      await inviteConversationAiUser(
        conversation.id,
        addressedPersonaId,
        'route-admin-user',
      );
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content,
            conversation_id: conversation.id,
            liveMode: true,
            liveModeKind: 'work',
            liveModeSessionId: `route-fallback-live-${conversation.id}`,
          }),
        },
      );
      expect(response.status).toBe(202);
      let conversationCalls = calls.filter(
        (call) => call.conversationId === conversation.id,
      );
      await waitForRunner(
        () =>
          calls.filter((call) => call.conversationId === conversation.id)
            .length >= 2,
      );
      conversationCalls = calls.filter(
        (call) => call.conversationId === conversation.id,
      );
      expect(conversationCalls).toHaveLength(2);
      expect(conversationCalls.map((call) => call.ephemeral)).toEqual([
        false,
        true,
      ]);
    }
  });

  async function sendAfter(sourceRuntime: string): Promise<{
    prompt: string;
    sessionId: string | null | undefined;
    ephemeral: boolean;
    mainPersonaGeneration?: number;
  }> {
    calls.length = 0;
    const conv = await createConversation(projectId);
    await setConversationSessionId(
      conv.id,
      sourceRuntime,
      `${sourceRuntime}-native-session`,
    );
    appendChatTranscriptEntry(projectId, conv.id, {
      type: 'message',
      role: 'user',
      content: `Earlier request for ${sourceRuntime}`,
    });
    appendChatTranscriptEntry(projectId, conv.id, {
      type: 'message',
      role: 'assistant',
      content: `Prior ${sourceRuntime} context`,
    });

    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: `Current prompt from ${sourceRuntime} to the configured runtime`,
        conversation_id: conv.id,
        runtimeSelection: { harnessId: 'direct', modelId: 'default' },
      }),
    });
    expect(response.status).toBe(202);

    await waitForRunner(() => calls.length > 0);
    expect(calls).toHaveLength(1);
    return calls[0]!;
  }

  test('a structured runtime starts fresh and sends the current prompt exactly once', async () => {
    const prompt =
      'Current prompt from prior-runtime to the configured runtime';
    const call = await sendAfter('prior-runtime');

    expect(call.sessionId).toBeNull();
    expect(call.mainPersonaGeneration).toBe(1);
    expect(call.prompt).not.toContain('prior-runtime-native-session');
    expect(call.prompt.split(prompt)).toHaveLength(2);
  });

  test('resumed native runtime receives all human turns around an invited persona reply', async () => {
    calls.length = 0;
    const conversation = await createConversation(projectId);
    const nativeSession = `route-persona-gap-${conversation.id}`;
    const generation = await mainPersonaGeneration(conversation.id);
    await setConversationSessionId(
      conversation.id,
      mainPersonaSessionKey(cliAgentId, generation),
      nativeSession,
    );
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'thread.started',
      thread_id: nativeSession,
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      type: 'message',
      role: 'assistant',
      content: 'Main output already present in the native thread.',
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      id: `queued-a-${conversation.id}`,
      type: 'message',
      role: 'user',
      content: 'First prompt queued while Morgan was active.',
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      id: `queued-b-${conversation.id}`,
      type: 'message',
      role: 'user',
      content: 'Second prompt queued while Morgan was active.',
    });
    appendChatTranscriptEntry(projectId, conversation.id, {
      id: `morgan-${conversation.id}`,
      type: 'message',
      role: 'assistant',
      content: 'Morgan completed her invited-persona response.',
      sender_name: 'Morgan',
      senderUserId: `ai:${addressedPersonaId}`,
    });

    const currentPrompt = 'Angy should continue with all intervening context.';
    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: currentPrompt,
        conversation_id: conversation.id,
        agent_cmd: cliAgentId,
      }),
    });
    expect(response.status).toBe(202);
    let conversationCalls = calls.filter(
      (call) => call.conversationId === conversation.id,
    );
    await waitForRunner(() =>
      calls.some((call) => call.conversationId === conversation.id),
    );
    conversationCalls = calls.filter(
      (call) => call.conversationId === conversation.id,
    );

    expect(conversationCalls).toHaveLength(1);
    const call = conversationCalls[0]!;
    expect(call.sessionId).toBe(nativeSession);
    expect(
      call.prompt.split('First prompt queued while Morgan was active.'),
    ).toHaveLength(2);
    expect(
      call.prompt.split('Second prompt queued while Morgan was active.'),
    ).toHaveLength(2);
    expect(
      call.prompt.split('Morgan completed her invited-persona response.'),
    ).toHaveLength(2);
    expect(call.prompt).not.toContain(
      'Main output already present in the native thread.',
    );
    expect(call.prompt.split(currentPrompt)).toHaveLength(2);
  });

  test('rejects a legacy agent alias instead of applying the chat default', async () => {
    const conv = await createConversation(projectId);
    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Use the old alias',
        conversation_id: conv.id,
        agent_cmd: 'default',
      }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      'Unknown runtime binding',
    );
  });

  test('rejects a conversation ID owned by another project before starting an agent', async () => {
    calls.length = 0;
    const foreignConversation = await createConversation(destinationProjectId);

    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'This prompt must not leak into the other project.',
        conversation_id: foreignConversation.id,
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Conversation not found' });
    expect(calls).toHaveLength(0);
  });

  test('rejects an objective conversation whose objective is missing before starting an agent', async () => {
    calls.length = 0;
    const objectiveConversation = await createObjectiveConversation(
      projectId,
      'route-objective-context',
    );

    const response = await fetch(`${baseUrl}/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'This prompt must not enter an orphaned objective chat.',
        conversation_id: objectiveConversation.id,
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Objective not found' });
    expect(calls).toHaveLength(0);
  });

  test('loads a captured persona prompt and transcript only from its conversation endpoint', async () => {
    const conversation = await createConversation(projectId);
    const now = new Date().toISOString();
    const aiUserId = `route-inspection-persona-${Date.now()}`;
    const messageId = `route-inspection-turn-${Date.now()}`;
    await insertAiUserRow({
      id: aiUserId,
      name: 'Inspector',
      identity: 'Inspector persona',
      presetId: 'test-preset',
      promptPath: 'test.md',
      turn: 'after',
      tools: [],
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    await insertAiTurnRun({
      id: messageId,
      conversationId: conversation.id,
      aiUserId,
      phase: 'after',
      presetId: 'test-preset',
      effectiveToolsets: ['core'],
      decision: 'select',
      status: 'completed',
      createdAt: now,
      startedAt: now,
      completedAt: now,
      inspection: {
        systemPrompt: 'Exact system prompt',
        prompt: 'Exact turn prompt',
        transcript: '{"type":"assistant","content":"Full provider output"}',
        handoff: { decision: { kind: 'select', aiUserId } },
      },
    });

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/persona-turns/${messageId}/inspection`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      messageId,
      aiUserId,
      systemPrompt: 'Exact system prompt',
      prompt: 'Exact turn prompt',
      transcript: '{"type":"assistant","content":"Full provider output"}',
      handoff: { decision: { kind: 'select', aiUserId } },
    });

    const wrongProject = await fetch(
      `${baseUrl}/projects/${destinationProjectId}/conversations/${conversation.id}/persona-turns/${messageId}/inspection`,
    );
    expect(wrongProject.status).toBe(404);
  });

  test('bounds oversized handoff content and metadata while preserving markers', async () => {
    const source = await createConversation(projectId);
    await updateConversation(source.id, projectId, {
      title: 'Oversized title '.repeat(2_000),
    });
    appendChatTranscriptEntry(projectId, source.id, {
      type: 'message',
      role: 'user',
      content: 'Oversized user context '.repeat(10_000),
    });
    appendChatTranscriptEntry(projectId, source.id, {
      type: 'message',
      role: 'assistant',
      content: 'Oversized assistant context '.repeat(10_000),
    });

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${source.id}/handoff`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationProjectId }),
      },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    const entries = readChatTranscript(
      destinationProjectId,
      body.conversation.id,
    );
    const handoff = (entries as Array<{ content?: unknown }>).find(
      (entry) =>
        typeof entry.content === 'string' &&
        entry.content.includes('[CONVERSATION_HANDOFF]'),
    )?.content;
    if (typeof handoff !== 'string') throw new Error('Handoff was not stored');

    expect(handoff.length).toBeLessThanOrEqual(MAX_HANDOFF_LENGTH);
    expect(handoff.startsWith('[CONVERSATION_HANDOFF]')).toBe(true);
    expect(handoff.endsWith('[/CONVERSATION_HANDOFF]')).toBe(true);
    expect(handoff).toContain('… [truncated]');
    expect(handoff).toContain('Oversized assistant context');
    expect(handoff).not.toContain('Oversized user context');
  });

  test('signals context omitted by the handoff message cap', async () => {
    const source = await createConversation(projectId);
    for (let index = 0; index < 13; index += 1) {
      appendChatTranscriptEntry(projectId, source.id, {
        type: 'message',
        role: index % 2 === 0 ? 'user' : 'assistant',
        content:
          index === 0
            ? 'Oldest capped context'
            : index === 12
              ? 'Newest retained context'
              : `Context entry ${index}`,
      });
    }

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${source.id}/handoff`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationProjectId }),
      },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    const entries = readChatTranscript(
      destinationProjectId,
      body.conversation.id,
    );
    const handoff = (entries as Array<{ content?: unknown }>).find(
      (entry) =>
        typeof entry.content === 'string' &&
        entry.content.includes('[CONVERSATION_HANDOFF]'),
    )?.content;
    if (typeof handoff !== 'string') throw new Error('Handoff was not stored');

    expect(handoff.length).toBeLessThanOrEqual(MAX_HANDOFF_LENGTH);
    expect(handoff.startsWith('[CONVERSATION_HANDOFF]')).toBe(true);
    expect(handoff.endsWith('[/CONVERSATION_HANDOFF]')).toBe(true);
    expect(handoff).toContain('Truncation notice:');
    expect(handoff).toContain('Newest retained context');
    expect(handoff).not.toContain('Oldest capped context');
  });

  test('cross-project handoff creates visible context without inheriting session state', async () => {
    const source = await createConversation(projectId);
    await setConversationSessionId(source.id, 'codex', 'source-native-session');
    appendChatTranscriptEntry(projectId, source.id, {
      type: 'message',
      role: 'user',
      content: 'Investigate the warm Codex MCP transcript gap.',
    });
    appendChatTranscriptEntry(projectId, source.id, {
      type: 'message',
      role: 'assistant',
      content: 'The warm translator drops mcpToolCall items.',
    });

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${source.id}/handoff`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationProjectId }),
      },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect(body.handoffCreated).toBe(true);
    expect(body.destinationProjectId).toBe(destinationProjectId);
    expect(body.conversation.group_folder).toBe(destinationProjectId);
    expect(body.conversation.session_id).toBeNull();
    expect(body.conversation.forked_from).toBeNull();
    expect(body.conversation.worktree_path).toBeNull();
    expect(body.conversation.last_agent_cmd).toBeNull();
    expect(body.conversation.runtimeSelection).toBeNull();

    const entries = (await import('../group-dir.js')).readChatTranscript(
      destinationProjectId,
      body.conversation.id,
    );
    const content = entries.map((entry: any) => entry.content || '').join('\n');
    expect(content).toContain('[CONVERSATION_HANDOFF]');
    expect(content).toContain('Investigate the warm Codex MCP transcript gap.');
    expect(content).toContain('The warm translator drops mcpToolCall items.');
    expect(content).not.toContain('source-native-session');
  });

  test('handoff preserves an explicit structured runtime selection including reasoning', async () => {
    const source = await createConversation(projectId);
    // Persist a picker choice that differs from the catalog's binding default.
    // The handoff must copy the selection verbatim, not rematerialize the
    // binding and substitute its reasoningDefault.
    const runtimeSelection = {
      harnessId: 'direct',
      modelId: 'default',
      reasoning: 'high',
    };
    await setConversationRuntimeSelection(source.id, runtimeSelection);

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${source.id}/handoff`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationProjectId }),
      },
    );

    expect(response.status).toBe(201);
    expect(
      ((await response.json()) as any).conversation.runtimeSelection,
    ).toEqual(runtimeSelection);
  });

  test('fork preserves explicit reasoning when the forked turn uses the copied runtime', async () => {
    const source = await createConversation(projectId);
    const runtimeSelection = {
      harnessId: 'direct',
      modelId: 'default',
      reasoning: 'high',
    };
    await setConversationRuntimeSelection(source.id, runtimeSelection);
    appendChatTranscriptEntry(projectId, source.id, {
      id: 'fork-user',
      type: 'message',
      role: 'user',
      content: 'Keep the selected reasoning.',
    });
    appendChatTranscriptEntry(projectId, source.id, {
      id: 'fork-assistant',
      type: 'assistant',
      role: 'assistant',
      agent_name: 'llm:direct:default',
      content: 'Done.',
    });

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${source.id}/fork`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messageId: 'fork-assistant',
          includeAssistantTurn: true,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as any).conversation.runtimeSelection,
    ).toEqual(runtimeSelection);
  });

  test('handoff ignores the source legacy agent command when no runtime is requested', async () => {
    const source = await createConversation(projectId);
    await setConversationAgentCmd(source.id, 'retired-runtime');

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${source.id}/handoff`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationProjectId }),
      },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect(body.conversation.runtimeSelection).toBeNull();
  });

  test('resolves stored sender IDs for transcript labels and conversation participants', async () => {
    const conversation = await createConversation(projectId);
    appendChatTranscriptEntry(projectId, conversation.id, {
      id: 'shared-user-message',
      type: 'message',
      role: 'user',
      content: 'Shared message',
      senderUserId: 'route-admin-user',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });

    const transcriptResponse = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/transcript`,
    );
    const transcript = (await transcriptResponse.json()) as any;
    expect(
      transcript.entries.find(
        (entry: any) => entry.id === 'shared-user-message',
      ),
    ).toMatchObject({ senderUserId: 'route-admin-user', sender_name: 'admin' });

    const listResponse = await fetch(
      `${baseUrl}/projects/${projectId}/conversations?limit=10&offset=0`,
    );
    const conversations = (await listResponse.json()) as any[];
    expect(
      conversations.find((item) => item.id === conversation.id)?.participants,
    ).toEqual([{ userId: 'route-admin-user', name: 'admin', avatarUrl: null }]);
    const messagesResponse = await fetch(
      `${baseUrl}/projects/${projectId}/messages?conversation_id=${conversation.id}`,
    );
    const messages = (await messagesResponse.json()) as any[];
    expect(messages[0]?.senderUserId).toBe('route-admin-user');
    expect(messages[0]?.sender_name).toBe('admin');
    expect(messages[0]?.senderAvatarUrl).toBeNull();
  });

  test('older conversation pages do not scan transcripts for cost metadata', async () => {
    const older = await createConversation(projectId);
    appendChatTranscriptEntry(projectId, older.id, {
      type: 'message',
      role: 'assistant',
      content: 'older page',
      telemetry: { cost_usd: 1 },
    });
    await drizzleDbRef.current
      .update(conversationRows)
      .set({ created_at: '2100-01-01T00:00:00.000Z' })
      .where(eq(conversationRows.id, older.id));
    const newer = await createConversation(projectId);
    await drizzleDbRef.current
      .update(conversationRows)
      .set({ created_at: '2101-01-01T00:00:00.000Z' })
      .where(eq(conversationRows.id, newer.id));
    appendChatTranscriptEntry(projectId, newer.id, {
      type: 'message',
      role: 'assistant',
      content: 'first page',
      telemetry: { cost_usd: 2 },
    });

    const firstResponse = await fetch(
      `${baseUrl}/projects/${projectId}/conversations?limit=1&offset=0`,
    );
    const firstPage = (await firstResponse.json()) as Array<
      Record<string, unknown>
    >;
    expect(firstPage[0]?.costUsd).toBe(2);

    const olderResponse = await fetch(
      `${baseUrl}/projects/${projectId}/conversations?limit=1&offset=1`,
    );
    const olderPage = (await olderResponse.json()) as Array<
      Record<string, unknown>
    >;
    expect(olderPage[0]?.id).toBe(older.id);
    expect('costUsd' in olderPage[0]!).toBe(false);
  });

  test('conversation detail remains available outside paginated list pages', async () => {
    const owner = await createUser('deep-link-owner', 'pw', 'user');
    const conversation = await createConversation(projectId, {
      ownerUserId: owner.id,
      triggerSource: 'user',
    });
    const response = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: conversation.id,
      owner: { id: owner.id, username: 'deep-link-owner' },
      latestTrigger: {
        user: { id: owner.id, username: 'deep-link-owner' },
        source: 'user',
      },
    });
  });

  test('mark-as-read waits for persistence before responding', async () => {
    const conversation = await createConversation(projectId);
    expect(conversation.read_at).toBeNull();

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/read`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect((await getConversation(conversation.id))?.read_at).not.toBeNull();
  });

  test('resolve-pending clears a handled plan from the conversation list', async () => {
    const conversation = await createConversation(projectId);
    await saveChatMessage({
      group_folder: projectId,
      conversation_id: conversation.id,
      role: 'assistant',
      content: 'Plan ready',
      source: 'web',
      created_at: new Date().toISOString(),
      pending: true,
    });
    expect(
      (await getConversations(projectId)).find(
        (item) => item.id === conversation.id,
      )?.status,
    ).toBe('pending');

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/conversations/${conversation.id}/resolve-pending`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, resolved: true });
    expect(
      (await getConversations(projectId)).find(
        (item) => item.id === conversation.id,
      )?.status,
    ).toBe('idle');
  });

  test('reports scheduled task running state in list and detail responses', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const idleTaskId = `scheduled-idle-${suffix}`;
    const runningTaskId = `scheduled-visible-running-${suffix}`;
    const pausedClaimTaskId = `scheduled-paused-claim-${suffix}`;
    const createdAt = new Date().toISOString();
    for (const [id, status, nextRun] of [
      [idleTaskId, 'active', new Date(Date.now() + 60_000).toISOString()],
      [runningTaskId, 'active', null],
      [pausedClaimTaskId, 'paused', null],
    ] as const) {
      await createScheduledTask({
        id,
        group_folder: projectId,
        chat_jid: `${projectId}@web`,
        prompt: `Running state ${id}`,
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: nextRun,
        status,
        created_at: createdAt,
      });
    }

    const runId = `scheduled-visible-run-${suffix}`;
    await drizzleDbRef.current.insert(activeRuns).values({
      id: runId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      isScheduledTask: 1,
      scheduled_task_id: runningTaskId,
      sandbox_stack: 'custom-test-stack',
      sandbox_service: 'custom-test-service',
      started_at: new Date().toISOString(),
      timeout_at: new Date(Date.now() + 60_000).toISOString(),
      status: 'running',
    });

    const listResponse = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks`,
    );
    expect(listResponse.status).toBe(200);
    const tasks = (await listResponse.json()) as Array<{
      id: string;
      running: boolean;
      runningSince: string | null;
    }>;
    expect(tasks.find(({ id }) => id === idleTaskId)?.running).toBe(false);
    // paused + null next_run is a claim a pause landed on: still running
    expect(tasks.find(({ id }) => id === pausedClaimTaskId)?.running).toBe(
      true,
    );
    expect(tasks.find(({ id }) => id === runningTaskId)?.running).toBe(true);
    expect(
      tasks.find(({ id }) => id === runningTaskId)?.runningSince,
    ).toBeTruthy();

    const detailUrl = `${baseUrl}/projects/${projectId}/scheduled-tasks/${runningTaskId}`;
    const runningDetail = await fetch(detailUrl);
    expect(runningDetail.status).toBe(200);
    expect((await runningDetail.json()) as { running: boolean }).toMatchObject({
      running: true,
    });

    await drizzleDbRef.current
      .update(activeRuns)
      .set({ status: 'completed', completed_at: new Date().toISOString() })
      .where(eq(activeRuns.id, runId));
    const finalizingDetail = await fetch(detailUrl);
    expect(
      (await finalizingDetail.json()) as { running: boolean },
    ).toMatchObject({ running: true });

    await drizzleDbRef.current.insert(taskRunLogs).values({
      task_id: runningTaskId,
      run_id: runId,
      run_at: new Date().toISOString(),
      duration_ms: 1,
      status: 'success',
      result: 'Done',
    });
    const completedDetail = await fetch(detailUrl);
    expect(
      (await completedDetail.json()) as { running: boolean },
    ).toMatchObject({ running: false });
  });

  test('scheduled-task PATCH validates runtime overrides', async () => {
    const taskId = `scheduled-runtime-route-${Date.now()}`;
    await createScheduledTask({
      id: taskId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Run with inherited chat runtime',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtimeSelection: { harnessId: 'direct' } }),
      },
    );

    expect(response.status).toBe(400);
    expect((await getTaskById(taskId))?.runtimeSelection).toBeNull();
  });

  test('edits all camelCase fields without reactivating a completed task', async () => {
    const taskId = `scheduled-completed-edit-${Date.now()}`;
    await createScheduledTask({
      id: taskId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'old',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() + 60_000).toISOString(),
      context_mode: 'isolated',
      next_run: null,
      status: 'completed',
      created_at: new Date().toISOString(),
    });
    const response = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'new',
          contextMode: 'group',
          runtimeSelection: null,
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      prompt: 'new',
      contextMode: 'group',
      status: 'completed',
      nextRun: null,
    });
  });

  test('rejects non-ISO one-off values and normalizes offset timestamps', async () => {
    const taskId = `scheduled-once-iso-${Date.now()}`;
    await createScheduledTask({
      id: taskId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Run once',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const invalid = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scheduleType: 'once',
          scheduleValue: '12/31/2099',
        }),
      },
    );
    expect(invalid.status).toBe(400);

    const offset = '2099-12-31T12:30:00+02:00';
    const valid = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scheduleType: 'once', scheduleValue: offset }),
      },
    );
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({
      scheduleType: 'once',
      scheduleValue: '2099-12-31T10:30:00.000Z',
      nextRun: '2099-12-31T10:30:00.000Z',
    });
  });

  test('reactivates a completed task only when its cadence actually changes', async () => {
    const taskId = `scheduled-completed-cadence-${Date.now()}`;
    const oldValue = new Date(Date.now() + 60_000).toISOString();
    await createScheduledTask({
      id: taskId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Completed prompt',
      schedule_type: 'once',
      schedule_value: oldValue,
      context_mode: 'isolated',
      next_run: null,
      status: 'completed',
      created_at: new Date().toISOString(),
    });

    const promptOnly = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Updated prompt',
          scheduleType: 'once',
          scheduleValue: oldValue,
        }),
      },
    );
    expect(await promptOnly.json()).toMatchObject({
      status: 'completed',
      nextRun: null,
    });

    const newValue = new Date(Date.now() + 120_000).toISOString();
    const cadence = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scheduleValue: newValue,
          status: 'paused',
        }),
      },
    );
    expect(await cadence.json()).toMatchObject({
      status: 'active',
      nextRun: newValue,
    });
  });

  test('rejects null cadence fields without recalculating or reactivating', async () => {
    const recurringId = `scheduled-null-cadence-${Date.now()}`;
    const recurringNextRun = new Date(Date.now() + 60_000).toISOString();
    await createScheduledTask({
      id: recurringId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Keep this cadence unchanged',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: recurringNextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    for (const payload of [{ scheduleType: null }, { scheduleValue: null }]) {
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/scheduled-tasks/${recurringId}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      expect(response.status).toBe(400);
    }
    expect(await getTaskById(recurringId)).toMatchObject({
      schedule_type: 'interval',
      schedule_value: '60000',
      next_run: recurringNextRun,
      status: 'active',
    });

    const completedId = `scheduled-null-completed-${Date.now()}`;
    const completedValue = new Date(Date.now() - 60_000).toISOString();
    await createScheduledTask({
      id: completedId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Remain completed',
      schedule_type: 'once',
      schedule_value: completedValue,
      context_mode: 'isolated',
      next_run: null,
      status: 'completed',
      created_at: new Date().toISOString(),
    });
    const invalidCompleted = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${completedId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scheduleType: null,
          scheduleValue: new Date(Date.now() + 120_000).toISOString(),
        }),
      },
    );
    expect(invalidCompleted.status).toBe(400);
    expect(await getTaskById(completedId)).toMatchObject({
      schedule_type: 'once',
      schedule_value: completedValue,
      next_run: null,
      status: 'completed',
    });
  });

  test('rejects edits while the scheduled task has a running active run', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const taskId = `scheduled-locked-${suffix}`;
    await createScheduledTask({
      id: taskId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Locked prompt',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });
    await drizzleDbRef.current.insert(activeRuns).values({
      id: `scheduled-running-${suffix}`,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      isScheduledTask: 1,
      scheduled_task_id: taskId,
      sandbox_stack: 'test',
      sandbox_service: 'test',
      started_at: new Date().toISOString(),
      timeout_at: new Date(Date.now() + 60_000).toISOString(),
      status: 'running',
    });

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Must not persist' }),
      },
    );
    expect(response.status).toBe(409);
    expect((await getTaskById(taskId))?.prompt).toBe('Locked prompt');

    const pauseResponse = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'paused',
          currentRunAction: 'finish',
        }),
      },
    );
    expect(pauseResponse.status).toBe(200);
    expect(await pauseResponse.json()).toMatchObject({
      status: 'paused',
      running: true,
    });
    expect((await getTaskById(taskId))?.status).toBe('paused');

    await drizzleDbRef.current
      .update(activeRuns)
      .set({ status: 'completed', completed_at: new Date().toISOString() })
      .where(eq(activeRuns.scheduled_task_id, taskId));
    const terminalResponse = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Still must not persist' }),
      },
    );
    expect(terminalResponse.status).toBe(409);
    expect((await getTaskById(taskId))?.prompt).toBe('Locked prompt');
  });

  test('scopes scheduled run history and formatted transcripts to their project and task', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const taskId = `scheduled-history-${suffix}`;
    const runId = `scheduled-history-run-${suffix}`;
    await createScheduledTask({
      id: taskId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'History prompt',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });
    await drizzleDbRef.current.insert(activeRuns).values({
      id: runId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      isScheduledTask: 1,
      scheduled_task_id: taskId,
      sandbox_stack: 'test',
      sandbox_service: 'test',
      started_at: new Date(Date.now() - 2_000).toISOString(),
      timeout_at: new Date(Date.now() + 60_000).toISOString(),
      completed_at: new Date().toISOString(),
      status: 'completed',
      model_name: 'route-model',
      tok_total: 42,
      cost_usd: 0.01,
    });
    await drizzleDbRef.current.insert(taskRunLogs).values([
      {
        task_id: taskId,
        run_id: runId,
        run_at: new Date().toISOString(),
        duration_ms: 2_000,
        status: 'success',
        result: 'Linked result',
      },
      {
        task_id: taskId,
        run_id: null,
        run_at: new Date(Date.now() - 5_000).toISOString(),
        duration_ms: 500,
        status: 'error',
        error: 'Legacy error',
      },
    ]);
    const transcriptDir = path.join(
      getGroupDir(projectId),
      'session-transcripts',
    );
    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(
      path.join(transcriptDir, `${runId}.prompt.txt`),
      'History prompt',
    );
    const v1Paths = archivedCarapaRunV1Paths(transcriptDir, runId);
    await fs.writeFile(
      v1Paths.manifest,
      JSON.stringify({
        format: 'carapa-run',
        version: 1,
        harness: 'opencode',
        requestedModel: null,
      }),
    );
    await fs.writeFile(
      v1Paths.events,
      [
        { type: 'run', status: 'started' },
        {
          type: 'message',
          id: 'answer-1',
          role: 'assistant',
          content: 'Canonical answer',
          status: 'completed',
        },
        { type: 'run', status: 'completed' },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );

    const historyResponse = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}/runs`,
    );
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as Array<any>;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      runId,
      modelName: 'route-model',
      tokTotal: 42,
      transcriptAvailable: true,
    });
    expect(history[1]).toMatchObject({
      runId: null,
      error: 'Legacy error',
      transcriptAvailable: false,
    });

    const forbidden = await fetch(
      `${baseUrl}/projects/${destinationProjectId}/scheduled-tasks/${taskId}/runs/${runId}/transcript`,
    );
    expect(forbidden.status).toBe(403);
    const wrongRun = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}/runs/not-owned/transcript`,
    );
    expect(wrongRun.status).toBe(404);
    const transcriptResponse = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}/runs/${runId}/transcript`,
    );
    expect(transcriptResponse.status).toBe(200);
    expect(await transcriptResponse.json()).toMatchObject({
      prompt: 'History prompt',
      entries: [{ role: 'assistant', content: 'Canonical answer' }],
      format: 'carapa-run',
      version: 1,
    });
    const v1Response = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}/runs/${runId}/transcript/v1`,
    );
    expect(v1Response.status).toBe(200);
    expect(await v1Response.json()).toMatchObject({
      format: 'carapa-run',
      version: 1,
      manifest: { harness: 'opencode' },
    });
  });

  test('keeps an occurrence visible while its canonical log finalizes and caps history at 50', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const taskId = `scheduled-finalizing-${suffix}`;
    const baseTime = Date.now() - 100_000;
    await createScheduledTask({
      id: taskId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Finalizing prompt',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });
    await drizzleDbRef.current.insert(taskRunLogs).values(
      Array.from({ length: 50 }, (_, index) => ({
        task_id: taskId,
        run_at: new Date(baseTime + index * 1_000).toISOString(),
        duration_ms: 100,
        status: 'success' as const,
        result: `History ${index}`,
      })),
    );
    const pendingRunId = `scheduled-finalizing-run-${suffix}`;
    await drizzleDbRef.current.insert(activeRuns).values({
      id: pendingRunId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      isScheduledTask: 1,
      scheduled_task_id: taskId,
      sandbox_stack: 'test',
      sandbox_service: 'test',
      started_at: new Date().toISOString(),
      timeout_at: new Date(Date.now() + 60_000).toISOString(),
      completed_at: new Date().toISOString(),
      status: 'completed',
    });

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}/runs`,
    );
    expect(response.status).toBe(200);
    const history = (await response.json()) as Array<any>;
    expect(history).toHaveLength(50);
    expect(history[0]).toMatchObject({
      runId: pendingRunId,
      status: 'finalizing',
      transcriptAvailable: false,
    });
    expect(history.some((row) => row.result === 'History 0')).toBe(false);

    // If the best-effort log insert fails but schedule finalization succeeds,
    // the old terminal active run must not remain a permanent polling bridge.
    await updateScheduledTaskAfterRun(
      taskId,
      new Date(Date.now() + 120_000).toISOString(),
      'Completed without a history row',
    );
    const finalizedResponse = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}/runs`,
    );
    const finalizedHistory = (await finalizedResponse.json()) as Array<any>;
    expect(finalizedHistory).toHaveLength(50);
    expect(finalizedHistory.some((row) => row.runId === pendingRunId)).toBe(
      false,
    );
  });

  test('resuming a recurring scheduled task advances a stale due time', async () => {
    const taskId = `scheduled-resume-${Date.now()}`;
    const staleNextRun = new Date(Date.now() - 60_000).toISOString();
    await createScheduledTask({
      id: taskId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Run after the resumed interval',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: staleNextRun,
      status: 'paused',
      created_at: new Date().toISOString(),
    });

    const resumedAt = Date.now();
    const response = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );

    expect(response.status).toBe(200);
    const resumed = (await response.json()) as {
      status: string;
      nextRun: string;
    };
    expect(resumed.status).toBe('active');
    expect(resumed.nextRun).not.toBe(staleNextRun);
    expect(new Date(resumed.nextRun).getTime()).toBeGreaterThanOrEqual(
      resumedAt + 60_000,
    );
    expect((await getTaskById(taskId))?.next_run).toBe(resumed.nextRun);
  });

  test('rejects resuming an invalid recurring schedule without activating it', async () => {
    const taskId = `scheduled-invalid-resume-${Date.now()}`;
    const staleNextRun = new Date(Date.now() - 60_000).toISOString();
    await createScheduledTask({
      id: taskId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Legacy task with an invalid interval',
      schedule_type: 'interval',
      schedule_value: '60000oops',
      context_mode: 'isolated',
      next_run: staleNextRun,
      status: 'paused',
      created_at: new Date().toISOString(),
    });

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid recurring schedule',
    });
    expect(await getTaskById(taskId)).toMatchObject({
      status: 'paused',
      next_run: staleNextRun,
    });
  });

  test('rejects reactivating a completed one-off scheduled task', async () => {
    const taskId = `scheduled-completed-${Date.now()}`;
    await createScheduledTask({
      id: taskId,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Already ran once',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      context_mode: 'isolated',
      next_run: null,
      status: 'completed',
      created_at: new Date().toISOString(),
    });

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Completed scheduled tasks cannot be reactivated',
    });
    expect(await getTaskById(taskId)).toMatchObject({
      status: 'completed',
      next_run: null,
    });
  });
});
