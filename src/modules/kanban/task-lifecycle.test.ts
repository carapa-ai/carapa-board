/**
 * Integration tests for dependency validation and stalled-run recovery.
 *
 * Each test group re-initialises an in-memory PGLite database so tests are
 * fully isolated from each other and from the on-disk production database.
 *
 * Coverage:
 *  - Dependency resolution: hasCircularDependency
 *  - Recovery from stalled runs: active_run bookkeeping + stuck-conversation sweep
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import {
  initDatabase,
  createTask,
  hasCircularDependency,
  insertActiveRun,
  getLastRunForStages,
  getStuckWorkingConversations,
  saveChatMessage,
  createConversation,
} from '../../db.js';

import { acquireConversationExecutionLease } from '../chat/conversation-execution-lease.js';

import type { ActiveRun } from './execution/types.js';
import type { Task } from './types.js';
import { truncateTestDb } from '../../test-helpers.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const PROJ = 'test-project';

/** Build a minimal Task fixture (only required fields). */
function taskFixture(
  overrides: Partial<Task> = {},
): Omit<Task, 'id' | 'created_at'> {
  return {
    project_id: PROJ,
    title: 'Test task',
    description: 'A task for tests',
    status: 'backlog',
    priority: 0,
    ...overrides,
  };
}

/** Build a minimal ActiveRun fixture. */
function runFixture(overrides: Partial<ActiveRun> = {}): ActiveRun {
  const rand = Math.random().toString(36).substring(2, 8);
  const now = new Date();
  const timeout = new Date(now.getTime() + 600_000);
  return {
    id: `run-${Date.now()}-${rand}`,
    group_folder: PROJ,
    chat_jid: `task-${rand}@kanban`,
    session_id: null,
    conversation_id: null,
    isMain: 0,
    isScheduledTask: 0,
    scheduled_task_id: null,
    task_id: null,
    sandbox_stack: 'carapa-bot',
    sandbox_service: 'agent',
    sandbox_instance: null,
    started_at: now.toISOString(),
    timeout_at: timeout.toISOString(),
    status: 'running',
    model: null,
    agent_name: null,
    tok_total: null,
    tok_output: null,
    tok_input: null,
    tok_cache_write: null,
    tok_cache_read: null,
    tok_context_last: null,
    model_name: null,
    tool_usage_count: null,
    stage: null,
    ...overrides,
  };
}

// Initialize once, then truncate between tests for fast isolation.
let initialized = false;
function useCleanLifecycleTestDatabase() {
  beforeEach(async () => {
    if (!initialized) {
      await initDatabase(':memory:');
      initialized = true;
    }
    await truncateTestDb();
  });
}

describe('active run lifecycle', () => {
  useCleanLifecycleTestDatabase();

  test('gets the latest run from the requested concrete stages', async () => {
    const task = await createTask(taskFixture());
    await insertActiveRun(
      runFixture({
        id: 'testing-old',
        task_id: task.id,
        stage: 'testing',
        started_at: '2026-01-01T00:00:00.000Z',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'active-newer',
        task_id: task.id,
        stage: 'in_progress',
        started_at: '2026-01-03T00:00:00.000Z',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'testing-latest',
        task_id: task.id,
        stage: 'testing',
        started_at: '2026-01-02T00:00:00.000Z',
      }),
    );

    expect((await getLastRunForStages(task.id, ['testing']))?.id).toBe(
      'testing-latest',
    );
  });
});

// ─── Dependency resolution ────────────────────────────────────────────────────

describe('dependency resolution: hasCircularDependency', () => {
  useCleanLifecycleTestDatabase();

  test('returns false for a valid linear dependency', async () => {
    const a = await createTask(taskFixture({ title: 'A' }));
    const b = await createTask(taskFixture({ title: 'B' }));
    // B → A is valid (B depends on A)
    expect(await hasCircularDependency(PROJ, b.id, [a.id])).toBe(false);
  });

  test('detects an indirect three-node cycle (A → B → C → A)', async () => {
    const a = await createTask(taskFixture({ title: 'A' }));
    const b = await createTask(
      taskFixture({ title: 'B', depends_on_ids: [a.id] }),
    );
    const c = await createTask(
      taskFixture({ title: 'C', depends_on_ids: [b.id] }),
    );
    // Attempting to make A depend on C creates A → B → C → A
    expect(await hasCircularDependency(PROJ, a.id, [c.id])).toBe(true);
  });
});

// ─── Stuck conversation sweep ─────────────────────────────────────────────────

describe('getStuckWorkingConversations – stuck conversation detection', () => {
  useCleanLifecycleTestDatabase();

  test('returns a conversation that has only user messages and no running agent', async () => {
    const conv = await createConversation(PROJ);
    await saveChatMessage({
      group_folder: PROJ,
      role: 'user',
      content: 'Hello?',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conv.id,
    });

    const stuck = await getStuckWorkingConversations();
    expect(stuck.some((c) => c.id === conv.id)).toBe(true);
  });

  test('does not return a conversation that has an assistant reply', async () => {
    const conv = await createConversation(PROJ);
    const base = new Date(Date.now() - 5000).toISOString();
    await saveChatMessage({
      group_folder: PROJ,
      role: 'user',
      content: 'Hi',
      source: 'web',
      created_at: base,
      conversation_id: conv.id,
    });
    await saveChatMessage({
      group_folder: PROJ,
      role: 'assistant',
      content: 'Hello!',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conv.id,
    });

    const stuck = await getStuckWorkingConversations();
    expect(stuck.some((c) => c.id === conv.id)).toBe(false);
  });

  test('does not return a conversation with an active running agent for that conversation', async () => {
    const conv = await createConversation(PROJ);
    await saveChatMessage({
      group_folder: PROJ,
      role: 'user',
      content: 'Process this',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conv.id,
    });

    // Insert a running chat-mode active_run scoped to this conversation
    const run = runFixture({ task_id: null, conversation_id: conv.id });
    await insertActiveRun(run);

    const stuck = await getStuckWorkingConversations();
    expect(stuck.some((c) => c.id === conv.id)).toBe(false);
  });

  test('does not return an admitted conversation still preparing its agent run', async () => {
    const conv = await createConversation(PROJ);
    await saveChatMessage({
      group_folder: PROJ,
      role: 'user',
      content: 'Wait for checkout preparation',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conv.id,
    });
    await acquireConversationExecutionLease(conv.id, 'human-preflight');

    const stuck = await getStuckWorkingConversations();
    expect(stuck.some((c) => c.id === conv.id)).toBe(false);
  });

  test('still returns a stuck conversation when another conversation in the group is running', async () => {
    const convStuck = await createConversation(PROJ);
    const convRunning = await createConversation(PROJ);
    await saveChatMessage({
      group_folder: PROJ,
      role: 'user',
      content: 'Unanswered',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: convStuck.id,
    });
    await saveChatMessage({
      group_folder: PROJ,
      role: 'user',
      content: 'In flight',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: convRunning.id,
    });
    await insertActiveRun(
      runFixture({ task_id: null, conversation_id: convRunning.id }),
    );

    const stuck = await getStuckWorkingConversations();
    expect(stuck.some((c) => c.id === convStuck.id)).toBe(true);
    expect(stuck.some((c) => c.id === convRunning.id)).toBe(false);
  });
});
