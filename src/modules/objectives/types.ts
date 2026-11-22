// Objectives (goals above tasks)

import type { RuntimeSelection } from '../../lib/chat-agents.js';

type ObjectiveStatus = 'draft' | 'active' | 'achieved' | 'failed' | 'paused';

export interface Objective {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: ObjectiveStatus;
  priority: number; // sort order (lower = higher priority)
  deadline?: string | null;
  progress: number; // 0–100
  // Arbitrary key-value metadata (e.g. SMART fields, OKRs, custom data)
  metadata?: Record<string, unknown> | null;
  // Trigger config — defines what events trigger processing
  trigger_config?: Record<string, unknown> | null;
  // Optional runtime override used only for autonomous objective event handling.
  // null/absent inherits the project's effective Kanban runtime.
  eventRuntimeSelection?: RuntimeSelection | null;
  // Pre-computed agent working directory (container-side path)
  work_dir?: string | null;
  /** Set while a move from this project still has steps left to finish. */
  move_source_project?: string | null;
  // User-owned spending limit. Agents and MCP tools cannot modify it.
  cost_limit_usd?: number | null;
  created_at: string;
  updated_at: string;
  // Runtime-computed fields (not stored in DB)
  runStats?: ObjectiveRunStats | null;
  isAgentRunning?: boolean;
  chatStatus?: 'working' | 'finished' | 'failed' | 'pending' | null;
}

export interface ObjectiveRunStats {
  totalCostUsd: number;
  runCount: number;
  lastRunAt: string | null;
  avgDurationMs: number;
  successRate: number; // 0-1
}
