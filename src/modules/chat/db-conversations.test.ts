import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  conversationAgentSessions,
  conversationExecutionLeases,
  conversations as conversationRows,
  projects,
  tasks,
} from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
/**
 * Tests for conversation and chat message CRUD functions in src/db.ts.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  initDatabase,
  createConversation,
  getConversation,
  ConversationWorktreeInUseError,
  ConversationWorktreeTransitionInProgressError,
  transitionConversationsFromRemovedWorktree,
  getConversations,
  getAttentionConversations,
  updateConversation,
  updateConversationPreview,
  markConversationRead,
  resolvePendingConversation,
  rebuildConversationAggregatesFromTranscript,
  deleteConversation,
  forkConversation,
  setConversationSessionId,
  updateConversationWorktreePath,
  setConversationRuntimeSelection,
  setConversationMainAiUser,
  insertAiUserRow,
  getConversationSessionId,
  getConversationMainPersonaSourceObservation,
  resolveConversationMainPersonaGeneration,
  saveChatMessage,
  getChatMessages,
  insertActiveRun,
  createOrEnableConversationPublicShare,
  revokeConversationPublicShare,
  createUser,
  createTask,
} from '../../db.js';

import type { ActiveRun } from '../kanban/execution/types.js';
import {
  runFixture as baseRunFixture,
  taskFixture,
  truncateTestDb,
} from '../../test-helpers.js';
import { conversationStatusFromAggregates } from './db-chats.js';
import { chatTranscriptPath } from '../../group-dir.js';
import { archiveOldTranscripts } from '../transcripts/transcript-store.js';
import { resolveEffectiveMainAiUser } from '../ai-users/orchestrator.js';
import type { RegisteredGroup } from '../../types.js';
import { mainPersonaSessionKey } from '../ai-users/session-revision.js';
import {
  acquireConversationExecutionLease,
  releaseConversationExecutionLease,
} from './conversation-execution-lease.js';

const GROUP = 'conv-test-group';

async function resolveTestPersonaGeneration(
  conversationId: string,
  fingerprint: string,
): Promise<number> {
  const source =
    await getConversationMainPersonaSourceObservation(conversationId);
  const generation = await resolveConversationMainPersonaGeneration(
    conversationId,
    fingerprint,
    source,
  );
  if (generation === null) throw new Error('Unexpected stale test observation');
  return generation;
}

function runFixture(overrides: Partial<ActiveRun> = {}): ActiveRun {
  return baseRunFixture({
    group_folder: GROUP,
    chat_jid: `chat-${Math.random().toString(36).substring(2, 8)}@kanban`,
    ...overrides,
  });
}

beforeAll(() => initDatabase(':memory:'));

beforeEach(truncateTestDb);

// ─── createConversation ───────────────────────────────────────────────────────

describe('createConversation', () => {
  test('applies shared-conversation visibility before pagination', async () => {
    const shared = await createConversation(GROUP);
    await drizzleDbRef.current
      .update(conversationRows)
      .set({ created_at: '2020-01-01T00:00:00Z' })
      .where(eq(conversationRows.id, shared.id));
    await createConversation(GROUP);
    await createConversation(GROUP);

    const page = await getConversations(GROUP, 1, 0, {
      allowedConversationIds: [shared.id],
    });
    expect(page.map((conversation) => conversation.id)).toEqual([shared.id]);
  });

  test('returns every project-and-branch match to the shared checkout and clears all sessions', async () => {
    const bound = await createConversation(GROUP, {
      use_worktree: true,
      branch_name: 'feature/removed',
    });
    const alsoBound = await createConversation(GROUP, {
      use_worktree: true,
      branch_name: 'feature/removed',
    });
    const unrelated = await createConversation(GROUP, {
      use_worktree: true,
      branch_name: 'feature/kept',
    });
    const otherProject = await createConversation('other-project', {
      use_worktree: true,
      branch_name: 'feature/removed',
    });
    await updateConversationWorktreePath(
      bound.id,
      '.worktrees/feature/removed',
    );
    await updateConversationWorktreePath(
      alsoBound.id,
      '.worktrees/feature/removed',
    );
    await updateConversationWorktreePath(
      unrelated.id,
      '.worktrees/feature/kept',
    );
    await setConversationSessionId(bound.id, 'codex', 'removed-session');
    await setConversationSessionId(bound.id, 'claude', 'removed-claude');
    await setConversationSessionId(alsoBound.id, 'codex', 'removed-too');
    await setConversationSessionId(unrelated.id, 'codex', 'kept-session');
    await setConversationSessionId(otherProject.id, 'codex', 'other-session');
    await drizzleDbRef.current
      .update(conversationRows)
      .set({ session_id: 'legacy-removed-session' })
      .where(eq(conversationRows.id, bound.id));

    const removed: string[] = [];
    const transition = await transitionConversationsFromRemovedWorktree(
      GROUP,
      'feature/removed',
      async () => {
        removed.push('feature/removed');
        return 'removed';
      },
    );
    expect(transition.result).toBe('removed');
    expect(new Set(transition.affectedConversationIds)).toEqual(
      new Set([bound.id, alsoBound.id]),
    );
    expect(removed).toEqual(['feature/removed']);
    expect(await getConversation(bound.id)).toMatchObject({
      use_worktree: 0,
      branch_name: null,
      worktree_path: null,
      worktreeMissing: false,
      session_id: null,
    });
    expect(await getConversationSessionId(bound.id, 'codex')).toBeNull();
    expect(await getConversationSessionId(bound.id, 'claude')).toBeNull();
    expect(await getConversation(alsoBound.id)).toMatchObject({
      use_worktree: 0,
      branch_name: null,
      worktree_path: null,
    });
    expect(await getConversationSessionId(alsoBound.id, 'codex')).toBeNull();
    expect(await getConversation(unrelated.id)).toMatchObject({
      use_worktree: 1,
      branch_name: 'feature/kept',
      worktree_path: '.worktrees/feature/kept',
      worktreeMissing: false,
    });
    expect(await getConversationSessionId(unrelated.id, 'codex')).toBe(
      'kept-session',
    );

    expect(await getConversation(otherProject.id)).toMatchObject({
      use_worktree: 1,
      branch_name: 'feature/removed',
    });
    expect(await getConversationSessionId(otherProject.id, 'codex')).toBe(
      'other-session',
    );
  });

  test('leaves bindings and sessions unchanged when removal fails', async () => {
    const conversation = await createConversation(GROUP, {
      use_worktree: true,
      branch_name: 'failed-removal',
    });
    await updateConversationWorktreePath(
      conversation.id,
      '.worktrees/failed-removal',
    );
    await setConversationSessionId(conversation.id, 'codex', 'kept-session');

    await expect(
      transitionConversationsFromRemovedWorktree(
        GROUP,
        'failed-removal',
        async () => {
          throw new Error('CarapaBox failed');
        },
      ),
    ).rejects.toThrow('CarapaBox failed');
    expect(await getConversation(conversation.id)).toMatchObject({
      use_worktree: 1,
      branch_name: 'failed-removal',
      worktree_path: '.worktrees/failed-removal',
    });
    expect(await getConversationSessionId(conversation.id, 'codex')).toBe(
      'kept-session',
    );
  });

  test('rejects removal before CarapaBox when an affected run owns the conversation lease', async () => {
    const conversation = await createConversation(GROUP, {
      use_worktree: true,
      branch_name: 'busy-removal',
    });
    const lease = await acquireConversationExecutionLease(
      conversation.id,
      'active-run',
    );
    expect(lease).not.toBeNull();
    let removalCalled = false;

    await expect(
      transitionConversationsFromRemovedWorktree(
        GROUP,
        'busy-removal',
        async () => {
          removalCalled = true;
        },
      ),
    ).rejects.toBeInstanceOf(ConversationWorktreeInUseError);
    expect(removalCalled).toBe(false);
    expect(await getConversation(conversation.id)).toMatchObject({
      use_worktree: 1,
      branch_name: 'busy-removal',
    });
    await releaseConversationExecutionLease(conversation.id, 'active-run');

    await insertActiveRun(
      runFixture({
        conversation_id: conversation.id,
        task_id: null,
        status: 'running',
      }),
    );
    await expect(
      transitionConversationsFromRemovedWorktree(
        GROUP,
        'busy-removal',
        async () => {
          removalCalled = true;
        },
      ),
    ).rejects.toBeInstanceOf(ConversationWorktreeInUseError);
    expect(removalCalled).toBe(false);
  });

  test('holds concurrent turn admission until the removed binding is committed', async () => {
    const conversation = await createConversation(GROUP, {
      use_worktree: true,
      branch_name: 'racing-removal',
    });
    let markRemovalStarted!: () => void;
    const removalStarted = new Promise<void>((resolve) => {
      markRemovalStarted = resolve;
    });
    let finishRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });
    const transition = transitionConversationsFromRemovedWorktree(
      GROUP,
      'racing-removal',
      async () => {
        markRemovalStarted();
        await removalGate;
      },
    );
    await removalStarted;

    const completions: string[] = [];
    const orderedTransition = transition.then((result) => {
      completions.push('transition');
      return result;
    });
    const admission = acquireConversationExecutionLease(
      conversation.id,
      'new-turn',
    ).then((lease) => {
      completions.push('admission');
      return lease;
    });

    finishRemoval();
    await orderedTransition;
    const lease = await admission;
    expect(completions).toEqual(['transition', 'admission']);
    expect(lease).not.toBeNull();
    expect(await getConversation(conversation.id)).toMatchObject({
      use_worktree: 0,
      worktree_path: null,
      branch_name: null,
    });
    await releaseConversationExecutionLease(conversation.id, 'new-turn');
  });

  test('rejects a branch binding admitted after removal takes its snapshot', async () => {
    let markRemovalStarted!: () => void;
    const removalStarted = new Promise<void>((resolve) => {
      markRemovalStarted = resolve;
    });
    let finishRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });
    const transition = transitionConversationsFromRemovedWorktree(
      GROUP,
      'late-binding-removal',
      async () => {
        markRemovalStarted();
        await removalGate;
      },
    );
    await removalStarted;

    await expect(
      createConversation(GROUP, {
        use_worktree: true,
        branch_name: 'late-binding-removal',
        ownerUserId: 'late-binding-owner',
      }),
    ).rejects.toBeInstanceOf(ConversationWorktreeTransitionInProgressError);

    finishRemoval();
    await transition;
    expect(
      (await getConversations(GROUP, 100)).some(
        (conversation) => conversation.branch_name === 'late-binding-removal',
      ),
    ).toBe(false);
  });
});

describe('message sender identity', () => {
  test('persists senderUserId without requiring a duplicated sender name', async () => {
    const conv = await createConversation(GROUP);
    await saveChatMessage({
      group_folder: GROUP,
      role: 'user',
      content: 'Shared conversation message',
      senderUserId: 'user-alex',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conv.id,
    });

    const [message] = await getChatMessages(GROUP, 10, conv.id);
    expect(message.senderUserId).toBe('user-alex');
    expect(message.sender_name).toBeNull();
  });
});

// ─── getConversations ─────────────────────────────────────────────────────────

describe('getConversations', () => {
  test('filters owner and triggerer before pagination and resolves nested users', async () => {
    const owner = await createUser('conversation-owner', 'pw', 'user');
    const triggerer = await createUser('conversation-triggerer', 'pw', 'user');
    const matching = await createConversation(GROUP, {
      ownerUserId: owner.id,
      triggerSource: 'user',
    });
    await updateConversation(matching.id, GROUP, {
      lastTriggeredByUserId: triggerer.id,
      lastTriggerSource: 'user',
      lastTriggeredAt: '2026-08-08T00:00:00.000Z',
    });
    await createConversation(GROUP, {
      ownerUserId: owner.id,
      triggerSource: 'user',
    });

    const conversations = await getConversations(GROUP, 1, 0, {
      ownerUserId: owner.id,
      triggeredByUserId: triggerer.id,
    });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      id: matching.id,
      owner: { id: owner.id, username: 'conversation-owner' },
      latestTrigger: {
        user: { id: triggerer.id, username: 'conversation-triggerer' },
        source: 'user',
      },
    });
  });

  test('treats incomplete native imports as idle historical conversations', () => {
    expect(
      conversationStatusFromAggregates({
        id: 'conv-cursor-native-session',
        last_user_at: '2026-03-16T10:00:00.000Z',
        last_assistant_at: '2026-03-16T09:59:00.000Z',
        read_at: '2026-03-16T09:59:00.000Z',
      }),
    ).toBe('idle');
  });

  test('treats a resumed incomplete native import with an active run as working', () => {
    expect(
      conversationStatusFromAggregates(
        {
          id: 'conv-antigravity-native-session',
          last_user_at: '2026-03-16T10:00:00.000Z',
          last_assistant_at: '2026-03-16T09:59:00.000Z',
          read_at: '2026-03-16T09:59:00.000Z',
        },
        true,
      ),
    ).toBe('working');
  });

  test('returns publicly shared conversations first and marks active shares', async () => {
    const shared = await createConversation(GROUP);
    const pinned = await createConversation(GROUP);
    await updateConversationPreview(shared.id, 'Public conversation');
    await updateConversationPreview(pinned.id, 'Pinned conversation');
    await updateConversation(pinned.id, GROUP, { pinned: true });
    await createOrEnableConversationPublicShare(shared.id, null);

    const conversations = await getConversations(GROUP);

    expect(conversations[0]).toMatchObject({
      id: shared.id,
      publiclyShared: true,
    });
    expect(conversations[1]).toMatchObject({
      id: pinned.id,
      publiclyShared: false,
    });

    await revokeConversationPublicShare(shared.id);
    expect((await getConversations(GROUP))[0]).toMatchObject({
      id: pinned.id,
      publiclyShared: false,
    });
  });

  test('orders unpinned conversations by their latest assistant response', async () => {
    const recentlyAnswered = await createConversation(GROUP);
    const recentlyCreated = await createConversation(GROUP);
    const responseTime = Date.now() + 1_000;

    await saveChatMessage({
      group_folder: GROUP,
      role: 'assistant',
      content: 'Older response',
      source: 'web',
      created_at: new Date(responseTime).toISOString(),
      conversation_id: recentlyCreated.id,
    });
    await saveChatMessage({
      group_folder: GROUP,
      role: 'assistant',
      content: 'Latest response',
      source: 'web',
      created_at: new Date(responseTime + 1_000).toISOString(),
      conversation_id: recentlyAnswered.id,
    });

    const conversations = await getConversations(GROUP);

    expect(
      conversations.map((conversation) => conversation.last_assistant_at),
    ).toEqual([
      new Date(responseTime + 1_000).toISOString(),
      new Date(responseTime).toISOString(),
    ]);
    expect(conversations.map((conversation) => conversation.id)).toEqual([
      recentlyAnswered.id,
      recentlyCreated.id,
    ]);
  });

  test('assigns idle status when no messages exist', async () => {
    await createConversation(GROUP);
    const convs = await getConversations(GROUP);
    expect(convs[0].status).toBe('idle');
  });

  test('assigns working status when last message is from user', async () => {
    const conv = await createConversation(GROUP);
    await saveChatMessage({
      group_folder: GROUP,
      role: 'user',
      content: 'Hello',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conv.id,
    });
    const convs = await getConversations(GROUP);
    expect(convs[0].status).toBe('working');
  });

  test('assigns failed status only from structured assistant outcome', async () => {
    const conv = await createConversation(GROUP);
    await saveChatMessage({
      group_folder: GROUP,
      role: 'assistant',
      content: 'Selected model is at capacity. Please try a different model.',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conv.id,
      failed: true,
    });

    expect((await getConversations(GROUP))[0]?.status).toBe('failed');
    expect((await getAttentionConversations())[0]?.status).toBe('failed');
  });

  test('ordinary assistant prose containing error remains finished and a later success clears failure', async () => {
    const conv = await createConversation(GROUP);
    const first = '2026-06-30T04:00:00.000Z';
    const second = '2026-06-30T04:01:00.000Z';
    await saveChatMessage({
      group_folder: GROUP,
      role: 'assistant',
      content: 'Error handling is now implemented.',
      source: 'web',
      created_at: first,
      conversation_id: conv.id,
    });
    expect((await getConversations(GROUP))[0]?.status).toBe('finished');

    await saveChatMessage({
      group_folder: GROUP,
      role: 'assistant',
      content: 'A failed provider response',
      source: 'web',
      created_at: second,
      conversation_id: conv.id,
      failed: true,
    });
    expect((await getConversations(GROUP))[0]?.status).toBe('failed');

    await saveChatMessage({
      group_folder: GROUP,
      role: 'assistant',
      content: 'Recovered successfully',
      source: 'web',
      created_at: '2026-06-30T04:02:00.000Z',
      conversation_id: conv.id,
    });
    expect((await getConversations(GROUP))[0]?.status).toBe('finished');
  });

  test('keeps an approved-plan action pending after viewing until the next user instruction', async () => {
    const conv = await createConversation(GROUP);
    await saveChatMessage({
      group_folder: GROUP,
      role: 'assistant',
      content: 'Plan ready for implementation',
      source: 'web',
      created_at: '2026-08-01T10:00:00.000Z',
      conversation_id: conv.id,
      pending: true,
    });

    expect((await getConversations(GROUP))[0]?.status).toBe('pending');
    await markConversationRead(GROUP, conv.id);
    expect((await getConversations(GROUP))[0]?.status).toBe('pending');

    await saveChatMessage({
      group_folder: GROUP,
      role: 'user',
      content: 'Start implementing',
      source: 'web',
      created_at: '2026-08-01T10:01:00.000Z',
      conversation_id: conv.id,
    });
    expect((await getConversations(GROUP))[0]?.status).toBe('working');
  });

  test('resolves a handled pending plan and preserves that state after aggregate rebuild', async () => {
    const conv = await createConversation(GROUP);
    await saveChatMessage({
      group_folder: GROUP,
      role: 'assistant',
      content: 'Plan ready for implementation',
      source: 'web',
      created_at: '2026-08-01T10:00:00.000Z',
      conversation_id: conv.id,
      pending: true,
    });

    expect(await resolvePendingConversation(GROUP, conv.id)).toBe(true);
    expect((await getConversations(GROUP))[0]?.status).toBe('idle');

    await rebuildConversationAggregatesFromTranscript(GROUP, conv.id);
    expect((await getConversations(GROUP))[0]?.status).toBe('idle');
    expect(await resolvePendingConversation(GROUP, conv.id)).toBe(false);
  });

  test('marking a future-dated assistant response read removes it from attention', async () => {
    const conv = await createConversation(GROUP);
    const futureAssistantAt = new Date(Date.now() + 60_000).toISOString();
    await saveChatMessage({
      group_folder: GROUP,
      role: 'assistant',
      content: 'Imported response with clock skew',
      source: 'web',
      created_at: futureAssistantAt,
      conversation_id: conv.id,
    });

    expect(
      (await getAttentionConversations()).map((item) => item.id),
    ).toContain(conv.id);
    await markConversationRead(GROUP, conv.id);

    expect((await getConversation(conv.id))?.read_at).toBe(futureAssistantAt);
    expect(
      (await getAttentionConversations()).map((item) => item.id),
    ).not.toContain(conv.id);
    expect((await getConversations(GROUP))[0]?.status).toBe('idle');
  });
});

// ─── deleteConversation ───────────────────────────────────────────────────────

describe('deleteConversation', () => {
  test('removes the conversation row', async () => {
    const conv = await createConversation(GROUP);
    await saveChatMessage({
      group_folder: GROUP,
      role: 'user',
      content: 'Hi',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conv.id,
    });
    const transcriptPath = chatTranscriptPath(GROUP, undefined, conv.id);
    expect(fs.existsSync(transcriptPath)).toBe(true);
    await deleteConversation(GROUP, conv.id);
    // Conversation row is gone...
    expect(await getConversations(GROUP)).toHaveLength(0);
    expect(await getConversation(conv.id)).toBeUndefined();
    // ...and so is the transcript, with its index sidecar.
    expect(fs.existsSync(transcriptPath)).toBe(false);
    expect(fs.existsSync(`${transcriptPath}.transcript-index.json`)).toBe(
      false,
    );
    expect(await getChatMessages(GROUP, 10, conv.id)).toEqual([]);
  });

  test('erases archived copies and keeps other conversations in the bundle', async () => {
    const doomed = await createConversation(GROUP);
    const keeper = await createConversation(GROUP);
    for (const conv of [doomed, keeper]) {
      await saveChatMessage({
        group_folder: GROUP,
        role: 'user',
        content: `secret ${conv.id}`,
        source: 'web',
        created_at: new Date().toISOString(),
        conversation_id: conv.id,
      });
    }
    const tDir = path.dirname(chatTranscriptPath(GROUP, undefined, doomed.id));
    const doomedName = path.basename(
      chatTranscriptPath(GROUP, undefined, doomed.id),
    );
    const keeperName = path.basename(
      chatTranscriptPath(GROUP, undefined, keeper.id),
    );
    const keeperBytes = fs.readFileSync(path.join(tDir, keeperName));
    const old = new Date(Date.now() - 400 * 86400_000);
    for (const name of [doomedName, keeperName]) {
      fs.utimesSync(path.join(tDir, name), old, old);
    }
    expect(await archiveOldTranscripts()).toBeGreaterThanOrEqual(2);
    const bundle = path.join(
      tDir,
      'archive',
      `${old.toISOString().slice(0, 10)}.tar.gz`,
    );
    expect(
      execFileSync('tar', ['-tzf', bundle], { encoding: 'utf8' }),
    ).toContain(doomedName);

    await deleteConversation(GROUP, doomed.id);

    const members = execFileSync('tar', ['-tzf', bundle], { encoding: 'utf8' });
    expect(members).not.toContain(doomedName);
    expect(members).toContain(keeperName);
    expect(
      execFileSync('tar', ['-xzOf', bundle, keeperName]).equals(keeperBytes),
    ).toBe(true);
  });

  test('fails closed and keeps the row when a bundle cannot be safely rewritten', async () => {
    const conv = await createConversation(GROUP);
    await saveChatMessage({
      group_folder: GROUP,
      role: 'user',
      content: 'still here',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conv.id,
    });
    const aDir = path.join(
      path.dirname(chatTranscriptPath(GROUP, undefined, conv.id)),
      'archive',
    );
    fs.mkdirSync(aDir, { recursive: true });
    const outside = path.join(aDir, '..', 'outside.tar.gz');
    execFileSync('tar', ['-czf', outside, '-C', aDir, '.']);
    const link = path.join(aDir, '2000-01-01.tar.gz');
    fs.symlinkSync(outside, link);
    try {
      await expect(deleteConversation(GROUP, conv.id)).rejects.toThrow();
      expect(await getConversation(conv.id)).toBeDefined();
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outside, { force: true });
    }
  });

  test('fails closed when a bundle holds a non-regular member', async () => {
    const conv = await createConversation(GROUP);
    const aDir = path.join(
      path.dirname(chatTranscriptPath(GROUP, undefined, conv.id)),
      'archive',
    );
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'erase-staging-'));
    fs.mkdirSync(aDir, { recursive: true });
    const bundle = path.join(aDir, '2000-01-02.tar.gz');
    try {
      fs.symlinkSync('/etc/hostname', path.join(staging, 'evil.jsonl'));
      execFileSync('tar', ['-czf', bundle, '-C', staging, 'evil.jsonl']);
      await expect(deleteConversation(GROUP, conv.id)).rejects.toThrow();
      expect(await getConversation(conv.id)).toBeDefined();
    } finally {
      fs.rmSync(bundle, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  test('cascades conversation persistence while preserving unrelated data', async () => {
    await drizzleDbRef.current.insert(projects).values({
      id: GROUP,
      jid: `${GROUP}@web`,
      name: 'Conversation tests',
      folder: GROUP,
      trigger: '!',
      added_at: new Date().toISOString(),
      is_main: 0,
    });
    const ownedTask = await createTask(
      taskFixture({ project_id: GROUP, title: 'Owned task' }),
    );
    const controlTask = await createTask(
      taskFixture({ project_id: GROUP, title: 'Control task' }),
    );
    const ownedConversation = await createConversation(GROUP);
    const controlConversation = await createConversation(GROUP);
    await setConversationSessionId(
      ownedConversation.id,
      'codex@relay',
      'owned-native-session',
    );
    await setConversationSessionId(
      controlConversation.id,
      'codex@relay',
      'control-native-session',
    );
    await acquireConversationExecutionLease(
      ownedConversation.id,
      'owned-conversation-run',
    );
    await acquireConversationExecutionLease(
      controlConversation.id,
      'control-conversation-run',
    );

    const handle = drizzleDbRef.current as unknown as {
      $client?: PGlite;
      _?: { client?: PGlite };
      session?: { client?: PGlite };
    };
    const client = handle.$client ?? handle._?.client ?? handle.session?.client;
    if (!client) throw new Error('PGlite client unavailable');
    await client.exec("SET session_replication_role = 'origin'");
    try {
      await deleteConversation(GROUP, ownedConversation.id);
    } finally {
      await client.exec("SET session_replication_role = 'replica'");
    }

    expect(
      await drizzleDbRef.current
        .select()
        .from(conversationExecutionLeases)
        .where(
          eq(conversationExecutionLeases.conversation_id, ownedConversation.id),
        ),
    ).toHaveLength(0);
    expect(
      await drizzleDbRef.current
        .select()
        .from(conversationAgentSessions)
        .where(
          eq(conversationAgentSessions.conversation_id, ownedConversation.id),
        ),
    ).toHaveLength(0);

    expect(await getConversation(controlConversation.id)).toBeDefined();
    expect(
      await drizzleDbRef.current
        .select()
        .from(conversationExecutionLeases)
        .where(
          eq(
            conversationExecutionLeases.conversation_id,
            controlConversation.id,
          ),
        ),
    ).toHaveLength(1);
    expect(
      await getConversationSessionId(controlConversation.id, 'codex@relay'),
    ).toBe('control-native-session');
    expect(
      (
        await drizzleDbRef.current
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.project_id, GROUP))
      ).map((task) => task.id),
    ).toEqual(expect.arrayContaining([ownedTask.id, controlTask.id]));
  });
});

// ─── forkConversation ─────────────────────────────────────────────────────────

describe('forkConversation', () => {
  test('creates a new conversation linked to the source and copies per-agent sessions', async () => {
    const source = await createConversation(GROUP);
    await setConversationSessionId(source.id, 'claude-llama.sh', 'sess-abc');
    const fork = await forkConversation(GROUP, source.id);
    expect(fork.id).not.toBe(source.id);
    expect(fork.forked_from).toBe(source.id);
    expect(await getConversationSessionId(fork.id, 'claude-llama.sh')).toBe(
      'sess-abc',
    );
  });

  test('inherits the current persona watermark without colliding with copied historical sessions', async () => {
    const source = await createConversation(GROUP);
    const personaA = 'main-persona:v1:fork-persona-a';
    const personaB = 'main-persona:v1:fork-persona-b';
    const runtimeKey = 'codex@relay';
    const firstGeneration = await resolveTestPersonaGeneration(
      source.id,
      personaA,
    );
    await setConversationSessionId(
      source.id,
      mainPersonaSessionKey(runtimeKey, firstGeneration),
      'fork-historical-a',
    );
    await setConversationMainAiUser(source.id, { mode: 'none' });
    const currentGeneration = await resolveTestPersonaGeneration(
      source.id,
      personaB,
    );
    await setConversationSessionId(
      source.id,
      mainPersonaSessionKey(runtimeKey, currentGeneration),
      'fork-current-b',
    );

    const fork = await forkConversation(GROUP, source.id);
    const [forkScope] = await drizzleDbRef.current
      .select({
        fingerprint: conversationRows.mainPersonaFingerprint,
        generation: conversationRows.mainPersonaGeneration,
      })
      .from(conversationRows)
      .where(eq(conversationRows.id, fork.id));
    expect(forkScope).toEqual({
      fingerprint: personaB,
      generation: currentGeneration,
    });
    expect(
      await getConversationSessionId(
        fork.id,
        mainPersonaSessionKey(runtimeKey, firstGeneration),
      ),
    ).toBe('fork-historical-a');
    expect(
      await getConversationSessionId(
        fork.id,
        mainPersonaSessionKey(runtimeKey, currentGeneration),
      ),
    ).toBe('fork-current-b');
    expect(await resolveTestPersonaGeneration(fork.id, personaB)).toBe(
      currentGeneration,
    );

    await setConversationMainAiUser(fork.id, { mode: 'inherit' });
    const returnedGeneration = await resolveTestPersonaGeneration(
      fork.id,
      personaA,
    );
    expect(returnedGeneration).toBe(currentGeneration + 1);
    expect(
      await getConversationSessionId(
        fork.id,
        mainPersonaSessionKey(runtimeKey, returnedGeneration),
      ),
    ).toBeNull();
  });

  test('persists and returns the forking user attribution', async () => {
    const user = await createUser('conversation-forker', 'pw', 'user');
    const source = await createConversation(GROUP);
    const fork = await forkConversation(GROUP, source.id, {
      ownerUserId: user.id,
      triggerSource: 'user',
    });

    expect(fork).toMatchObject({
      ownerUserId: user.id,
      lastTriggeredByUserId: user.id,
      lastTriggerSource: 'user',
      owner: { id: user.id, username: user.username },
      latestTrigger: {
        user: { id: user.id, username: user.username },
        source: 'user',
      },
    });
    expect(await getConversation(fork.id)).toMatchObject({
      ownerUserId: user.id,
      owner: { id: user.id, username: user.username },
    });
  });

  test('copies the structured runtime selection', async () => {
    const source = await createConversation(GROUP);
    await setConversationRuntimeSelection(source.id, {
      harnessId: 'claude-code',
      modelId: 'qwen',
      reasoning: 'high',
    });
    const fork = await forkConversation(GROUP, source.id);
    expect(fork.runtimeSelection).toEqual({
      harnessId: 'claude-code',
      modelId: 'qwen',
      reasoning: 'high',
    });
  });
});

describe('main AI persona selection', () => {
  test('persists and clears the selection', async () => {
    const conv = await createConversation(GROUP);
    const now = new Date().toISOString();
    await insertAiUserRow({
      id: 'persona-main',
      name: 'Luna',
      presetId: 'fast',
      promptPath: 'ai-users/persona-main/prompt.md',
      avatarPath: null,
      identity: 'Luna',
      turn: 'after',
      tools: [],
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });

    await setConversationMainAiUser(conv.id, {
      mode: 'persona',
      aiUserId: 'persona-main',
    });
    expect((await getConversation(conv.id))?.mainAiUserId).toBe('persona-main');
    expect((await getConversation(conv.id))?.mainAiUserMode).toBe('persona');
    expect((await getConversations(GROUP))[0].mainAiUserId).toBe(
      'persona-main',
    );

    await setConversationMainAiUser(conv.id, { mode: 'none' });
    expect((await getConversation(conv.id))?.mainAiUserId).toBeNull();
    expect((await getConversation(conv.id))?.mainAiUserMode).toBe('none');

    await setConversationMainAiUser(conv.id, { mode: 'inherit' });
    expect((await getConversation(conv.id))?.mainAiUserMode).toBe('inherit');
  });

  test('inherits the project default while preserving explicit none and persona overrides', async () => {
    const conv = await createConversation(GROUP);
    const now = new Date().toISOString();
    for (const id of ['project-default-persona', 'conversation-persona']) {
      await insertAiUserRow({
        id,
        name: id,
        presetId: 'fast',
        promptPath: `ai-users/${id}/prompt.md`,
        avatarPath: null,
        identity: id,
        turn: 'after',
        tools: [],
        enabled: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    const group: RegisteredGroup = {
      name: 'Test',
      folder: GROUP,
      trigger: '',
      added_at: now,
      settings: { defaultMainAiUserId: 'project-default-persona' },
    };

    expect((await resolveEffectiveMainAiUser(conv.id, group))?.id).toBe(
      'project-default-persona',
    );
    await setConversationMainAiUser(conv.id, { mode: 'none' });
    expect(await resolveEffectiveMainAiUser(conv.id, group)).toBeUndefined();
    await setConversationMainAiUser(conv.id, {
      mode: 'persona',
      aiUserId: 'conversation-persona',
    });
    expect((await resolveEffectiveMainAiUser(conv.id, group))?.id).toBe(
      'conversation-persona',
    );
  });
});

// ─── setConversationSessionId / getConversationSessionId ─────────────────────

describe('setConversationSessionId / getConversationSessionId', () => {
  test('advances persona generations monotonically and isolates late native sessions', async () => {
    const conv = await createConversation(GROUP);
    const personaA = 'main-persona:v1:persona-a';
    const personaB = 'main-persona:v1:persona-b';
    const firstA = await resolveTestPersonaGeneration(conv.id, personaA);
    expect(firstA).toBe(1);
    expect(
      await Promise.all([
        resolveTestPersonaGeneration(conv.id, personaA),
        resolveTestPersonaGeneration(conv.id, personaA),
      ]),
    ).toEqual([1, 1]);
    await setConversationMainAiUser(conv.id, { mode: 'none' });
    const personaBGeneration = await resolveTestPersonaGeneration(
      conv.id,
      personaB,
    );
    await setConversationMainAiUser(conv.id, { mode: 'inherit' });
    const secondA = await resolveTestPersonaGeneration(conv.id, personaA);
    expect([firstA, personaBGeneration, secondA]).toEqual([1, 2, 3]);
    const [persistedScope] = await drizzleDbRef.current
      .select({
        fingerprint: conversationRows.mainPersonaFingerprint,
        generation: conversationRows.mainPersonaGeneration,
      })
      .from(conversationRows)
      .where(eq(conversationRows.id, conv.id));
    expect(persistedScope).toEqual({
      fingerprint: personaA,
      generation: 3,
    });
    // Resolution is stateless; reading again uses the database values that a
    // restarted Board process sees rather than any process-local cache.
    expect(await resolveTestPersonaGeneration(conv.id, personaA)).toBe(3);

    const firstAKey = mainPersonaSessionKey('codex@relay', firstA);
    const personaBKey = mainPersonaSessionKey(
      'codex@relay',
      personaBGeneration,
    );
    const secondAKey = mainPersonaSessionKey('codex@relay', secondA);
    expect(new Set([firstAKey, personaBKey, secondAKey]).size).toBe(3);
    await setConversationSessionId(conv.id, firstAKey, 'native-a-first');
    await setConversationSessionId(conv.id, personaBKey, 'native-b');
    await setConversationSessionId(conv.id, 'ai:invited@relay', 'invited');
    // A late completion/recovery from generation 1 remains attached to its
    // exact historical key and cannot populate generation 3.
    await setConversationSessionId(conv.id, firstAKey, 'native-a-late');
    expect(await getConversationSessionId(conv.id, secondAKey)).toBeNull();
    await setConversationSessionId(conv.id, secondAKey, 'native-a-second');
    expect(await getConversationSessionId(conv.id, firstAKey)).toBe(
      'native-a-late',
    );
    expect(await getConversationSessionId(conv.id, secondAKey)).toBe(
      'native-a-second',
    );
    expect(await getConversationSessionId(conv.id, 'ai:invited@relay')).toBe(
      'invited',
    );
  });

  test('rejects an older persona observation after a newer transition commits', async () => {
    const conv = await createConversation(GROUP);
    const personaA = 'main-persona:v1:atomic-persona-a';
    const personaB = 'main-persona:v1:atomic-persona-b';
    const stalePersonaA = await getConversationMainPersonaSourceObservation(
      conv.id,
    );
    expect(
      await resolveConversationMainPersonaGeneration(
        conv.id,
        personaA,
        stalePersonaA,
      ),
    ).toBe(1);

    await setConversationMainAiUser(conv.id, { mode: 'none' });
    const currentPersonaB = await getConversationMainPersonaSourceObservation(
      conv.id,
    );
    expect(
      await resolveConversationMainPersonaGeneration(
        conv.id,
        personaB,
        currentPersonaB,
      ),
    ).toBe(2);
    expect(
      await resolveConversationMainPersonaGeneration(
        conv.id,
        personaA,
        stalePersonaA,
      ),
    ).toBeNull();
    expect(
      await resolveConversationMainPersonaGeneration(
        conv.id,
        personaB,
        currentPersonaB,
      ),
    ).toBe(2);
    const [persistedScope] = await drizzleDbRef.current
      .select({
        fingerprint: conversationRows.mainPersonaFingerprint,
        generation: conversationRows.mainPersonaGeneration,
      })
      .from(conversationRows)
      .where(eq(conversationRows.id, conv.id));
    expect(persistedScope).toEqual({
      fingerprint: personaB,
      generation: 2,
    });
  });

  test('upserts when called twice for same (conversation, agent)', async () => {
    const conv = await createConversation(GROUP);
    await setConversationSessionId(conv.id, 'claude-llama.sh', 'first');
    await setConversationSessionId(conv.id, 'claude-llama.sh', 'second');
    expect(await getConversationSessionId(conv.id, 'claude-llama.sh')).toBe(
      'second',
    );
  });

  test('keeps the recorded session mode on writes that omit it', async () => {
    const conv = await createConversation(GROUP);
    const sessionMode = async () =>
      (
        await drizzleDbRef.current
          .select({ chat_mode: conversationAgentSessions.chat_mode })
          .from(conversationAgentSessions)
          .where(eq(conversationAgentSessions.conversation_id, conv.id))
      )[0]?.chat_mode;
    await setConversationSessionId(conv.id, 'codex', 'session-plan', 'plan');
    expect(await sessionMode()).toBe('plan');

    // Recovery-style writes that omit mode metadata preserve it.
    await setConversationSessionId(conv.id, 'codex', 'session-plan-2');
    expect(await sessionMode()).toBe('plan');
  });

  test('null session_id deletes the row', async () => {
    const conv = await createConversation(GROUP);
    await setConversationSessionId(conv.id, 'claude-llama.sh', 'sess');
    await setConversationSessionId(conv.id, 'claude-llama.sh', null);
    expect(
      await getConversationSessionId(conv.id, 'claude-llama.sh'),
    ).toBeNull();
  });
});

// ─── saveChatMessage / getChatMessages ────────────────────────────────────────

describe('saveChatMessage and getChatMessages', () => {
  test('filters by conversation_id when provided', async () => {
    const conv1 = await createConversation(GROUP);
    const conv2 = await createConversation(GROUP);
    await saveChatMessage({
      group_folder: GROUP,
      role: 'user',
      content: 'In conv 1',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conv1.id,
    });
    await saveChatMessage({
      group_folder: GROUP,
      role: 'user',
      content: 'In conv 2',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conv2.id,
    });
    const msgs1 = await getChatMessages(GROUP, 10, conv1.id);
    expect(msgs1.length).toBeGreaterThan(0);
    expect(msgs1.every((m) => m.conversation_id === conv1.id)).toBe(true);
  });

  test('respects limit parameter', async () => {
    const conv = await createConversation(GROUP);
    for (let i = 0; i < 5; i++) {
      await saveChatMessage({
        group_folder: GROUP,
        role: 'user',
        content: `msg ${i}`,
        source: 'web',
        created_at: new Date().toISOString(),
        conversation_id: conv.id,
      });
    }
    const messages = await getChatMessages(GROUP, 3, conv.id);
    expect(messages).toHaveLength(3);
  });
});
