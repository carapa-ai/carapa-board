/**
 * Shared test fixtures used across multiple test files.
 * Import from here instead of duplicating helpers in each test file.
 */
import type { Task } from './modules/kanban/types.js';
import type { ActiveRun } from './modules/kanban/execution/types.js';
import type { PGlite } from '@electric-sql/pglite';
import { drizzleDbRef } from './db/drizzle-client.js';

const TEST_PROJECT = 'test-project';

/** Build a minimal Task fixture (only required fields). */
export function taskFixture(
  overrides: Partial<Task> = {},
): Omit<Task, 'id' | 'created_at'> {
  return {
    project_id: TEST_PROJECT,
    title: 'Test task',
    description: 'A task for tests',
    status: 'backlog',
    priority: 0,
    ...overrides,
  };
}

/** Build a minimal ActiveRun fixture. */
export function runFixture(overrides: Partial<ActiveRun> = {}): ActiveRun {
  const rand = Math.random().toString(36).substring(2, 8);
  const now = new Date();
  return {
    id: `run-${Date.now()}-${rand}`,
    group_folder: TEST_PROJECT,
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
    timeout_at: new Date(now.getTime() + 600_000).toISOString(),
    status: 'running',
    model: null,
    agent_name: null,
    runtime_variant: null,
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

// --- Test isolation: truncate all tables ---

let fkChecksDisabled = false;

export async function truncateTestDb(): Promise<void> {
  // Use Drizzle client (drizzleDbRef.current.$client) for truncation because
  // test functions use Drizzle queries — the HTTP worker has a separate
  // PGlite instance that doesn't share state with drizzleDbRef.current.$client.
  // Tests run only against PGlite, so $client resolves to the PGlite handle
  // (the type comes from the drizzle() factory intersection, not the base
  // PgliteDatabase class — narrow with a typed cast).
  const handle = drizzleDbRef.current as unknown as
    | {
        $client?: PGlite;
        _?: { client?: PGlite };
        session?: { client?: PGlite };
      }
    | undefined;
  const client =
    handle?.$client ?? handle?._?.client ?? handle?.session?.client;
  if (!client) return;
  try {
    // FK constraints (added in 0001) reject fixtures keyed by ad-hoc project
    // IDs. Tests assert behavior that predates referential integrity; bypass
    // FK enforcement on the test PGlite instance instead of seeding a parent
    // row for every permutation. FK behavior itself is covered by dedicated
    // cascade tests.
    if (!fkChecksDisabled) {
      await client.exec("SET session_replication_role = 'replica'");
      fkChecksDisabled = true;
    }
    // Truncate in child→parent order so cascading deletes don't fight us if
    // someone re-enables FK checks for a specific suite later.
    // Keep the full reset in one PGlite call. Each exec crosses the JS/WASM
    // boundary, so issuing one statement per table dominated database-heavy
    // suites that reset before every case.
    await client.exec(`
      DELETE FROM conversation_public_shares;
      DELETE FROM conversation_members;
      DELETE FROM project_member_kanban_acknowledgements;
      DELETE FROM kb_members;
      DELETE FROM project_members;
      DELETE FROM knowledge_base_shares;
      DELETE FROM knowledge_documents;
      DELETE FROM device_keys;
      DELETE FROM task_messages;
      DELETE FROM task_run_logs;
      DELETE FROM task_stage_comments;
      DELETE FROM active_runs;
      DELETE FROM ai_turn_runs;
      DELETE FROM conversation_ai_users;
      DELETE FROM ai_user_team_members;
      DELETE FROM ai_user_teams;
      DELETE FROM ai_users;
      DELETE FROM external_issue_imports;
      DELETE FROM external_run_costs;
      DELETE FROM task_board_events;
      DELETE FROM objective_task_event_holds;
      -- chat_messages was dropped by migration 0002. Chat I/O tests use the
      -- transcript-backed saveChatMessage/getChatMessages path instead.
      DELETE FROM tasks;
      DELETE FROM conversations;
      DELETE FROM scheduled_tasks;
      DELETE FROM cronjobs;
      DELETE FROM dataset_tasks;
      DELETE FROM pending_memory_erasures;
      DELETE FROM memory_privacy_erasure_marks;
      DELETE FROM pending_graph_erasures;
      DELETE FROM pending_memory_invalidations;
      DELETE FROM memory_transcript_evidence;
      DELETE FROM memory_history_apply_operations;
      DELETE FROM memory_reflector_operations;
      DELETE FROM memory_reflector_runs;
      DELETE FROM memories;
      DELETE FROM objectives;
      DELETE FROM knowledge_bases;
      DELETE FROM projects;
      DELETE FROM users;
    `);
  } catch {}
}
