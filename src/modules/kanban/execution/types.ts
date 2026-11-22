// Active agent runs (survive process restarts)

import type { TriggerSource, TriggerMetadata } from '../types.js';
import type { TestingRunDecision } from '../testing.js';

export interface ActiveRun {
  id: string;
  group_folder: string;
  chat_jid: string;
  session_id: string | null;
  conversation_id: string | null;
  isMain: number;
  isScheduledTask: number;
  scheduled_task_id: string | null;
  task_id: string | null;
  sandbox_stack: string;
  sandbox_service: string;
  sandbox_instance: string | null;
  started_at: string;
  timeout_at: string;
  /** Updated by the in-process stall watchdog whenever the agent emits a chunk;
   *  consumed by the recovery sweep to detect runs that went silent during a
   *  board restart. Optional because legacy rows may have NULL. */
  last_event_at?: string | null;
  status: 'running' | 'completed' | 'error' | 'timeout' | 'stalled';
  model: string | null;
  agent_name: string | null;
  /** Ask whose turn owns this run, for restart settlement. */
  agent_ask_id?: string | null;
  /** Exact conversation-session routing owner. Separate from agent_name so
   * recovery can resume revision-scoped sessions without changing attribution. */
  session_agent_key?: string | null;
  /** Exact executable/model/environment owner of a resumable native session. */
  runtime_variant?: string | null;
  /** Interrupted predecessor for a Board-reserved restart continuation. */
  restart_recovery_of_run_id?: string | null;
  /** Set after the reserved restart continuation launches in the harness. */
  restart_recovery_dispatched_at?: string | null;
  completed_at?: string | null;
  tok_total: number | null;
  tok_output: number | null;
  tok_input: number | null;
  tok_cache_write: number | null;
  tok_cache_read: number | null;
  tok_context_last: number | null;
  model_name: string | null;
  tool_usage_count: number | null;
  /** Durable terminal result used when task finalization resumes after restart. */
  result?: string | null;
  reviewScore?: number | null;
  testingDecision?: TestingRunDecision | null;
  stage: string | null;
  triggeredByUserId?: string | null;
  triggerSource?: TriggerSource;
  trigger?: TriggerMetadata;
}
