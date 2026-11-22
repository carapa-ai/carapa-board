import type { GraphFact } from '../../vector-store/graph-schema.js';
import type { Memory, MemoryType } from '../types.js';

/** Single-project scope for write and delete. */
export interface MemoryScope {
  group_folder: string;
}

/**
 * Recall scope — groupFolders MUST be pre-filtered by MCP permissions in tools.ts.
 * Empty array means orchestrator / full access (search all projects).
 */
export interface MemoryRecallScope {
  groupFolders: string[];
}

export interface MemoryWriteInput extends MemoryScope {
  /** Server-selected deterministic id used by retryable reflector writes. */
  id?: string;
  content: string;
  memory_type: MemoryType;
  importance?: number;
  objective_id?: string | null;
  tags?: string[];
  source: 'user' | 'agent' | 'observer';
  sourceRef?: string | null;
  /** ISO timestamp at which the stored fact became effective. */
  validFrom?: string | null;
  /** Legacy callers merge stronger near-duplicates; explicit create never rewrites one. */
  mergeDuplicates?: boolean;
  /** Persist server-owned retry identity before the lifecycle lock is released. */
  onResolvedMemoryId?: (memoryId: string) => Promise<void>;
  /** Epoch the caller's job started at; a later advance discards the write. */
  expectedPrivacyEpoch?: number;
  /** When false, store verbatim; PG backend always stores as given. */
  infer?: boolean;
}

export interface MemoryRecallQuery extends MemoryRecallScope {
  query?: string;
  memory_type?: string;
  objective_id?: string | null;
  asOf?: string;
  limit: number;
  /** Preview/evaluation reads must not mutate access telemetry. */
  skipTouch?: boolean;
}

export interface MemoryRecallResult {
  memories: Memory[];
  related?: GraphFact[];
}

export type MemorizeOutcome =
  | { kind: 'created'; memory: Memory; message: string }
  | { kind: 'merged'; memory: Memory; message: string }
  | { kind: 'duplicate'; memory: Memory; message: string };

/** Pluggable long-term memory store behind memorize / recall / lifecycle operations. */
export interface MemoryBackend {
  readonly id: string;

  memorize(input: MemoryWriteInput): Promise<MemorizeOutcome>;

  recall(query: MemoryRecallQuery): Promise<MemoryRecallResult>;

  /** Close temporal validity while preserving historical recall. */
  invalidate(
    memoryId: string,
    scope: MemoryScope,
    effectiveAt?: string,
    expectedVersion?: string,
  ): Promise<void>;

  /** Irreversibly erase primary, vector, and graph storage for privacy. */
  erase(memoryId: string, scope: MemoryScope): Promise<void>;

  get(memoryId: string): Promise<Memory | null>;
}
