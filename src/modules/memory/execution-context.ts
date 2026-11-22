import type { Memory } from './types.js';
import { serializeError } from '../../logger.js';

export interface TranscriptEvidenceMessage {
  id: string;
  createdAt: string;
  role: 'user' | 'assistant';
  content: string;
  /**
   * Scope carried by server-authored History Review transcripts. Undefined
   * means the source format did not provide scope metadata; null means the
   * source conversation is explicitly project-wide.
   */
  objectiveId?: string | null;
  /**
   * Tool calls, tool results and file contents of the same transcript entry.
   * Never shown to the reflector and never citable; kept only so a rejected
   * excerpt can be classified as non-text content.
   */
  nonTextContent?: string;
}

export interface MemoryEvidenceReference {
  message_id: string;
  excerpt: string;
}

export interface PreviewMemoryState {
  memories: Map<string, Memory>;
  forgottenIds: Set<string>;
  operations: Map<string, PreviewMemoryOperation>;
}

/** Reviewable write intent captured by the server-controlled preview. */
export interface PreviewMemoryOperation {
  operationKey: string;
  requestFingerprint: string;
  operation: 'create' | 'supersede' | 'invalidate' | 'forget';
  memoryId?: string;
  resultMemoryId?: string;
  content?: string;
  memoryType?: Memory['memory_type'];
  importance?: number;
  objectiveId?: string | null;
  tags?: string[];
  validFrom?: string;
  effectiveAt?: string;
  expectedVersion?: string;
  reason?: string;
  targetContent?: string;
  successorId?: string;
  evidence: MemoryEvidenceReference[];
}

/** Server-owned authority passed only to the dedicated reflector tool loop. */
export interface ReflectorMemoryExecutionContext {
  kind: 'reflector';
  mode: 'live' | 'preview';
  runId: string;
  chunkKey: string;
  sourceRef: string;
  /**
   * Privacy epoch of the project when the job began, before it read anything.
   * Retiring a folder (archiving a personal main) advances it, so a job that
   * outlives the folder's identity can neither read nor write the project that
   * later reuses the name.
   */
  privacyEpoch?: number;
  evidence: Map<string, TranscriptEvidenceMessage>;
  preview?: PreviewMemoryState;
  hadToolError: boolean;
  /** Bounded diagnostics, without tool arguments or successful result payloads. */
  toolErrors?: Array<{
    tool: string;
    message: string;
    operationKey?: string;
    /** Set for `ReflectorValidationError`s only; absent for other failures. */
    kind?: ReflectorValidationKind;
  }>;
  /** Only keyed, pre-write validation rejections can be cleared by a successful retry. */
  pendingEvidenceErrors?: Set<string>;
  hadOtherToolError?: boolean;
  completedOperationKeys: Set<string>;
  /** Read-only checkout which produced the evidence being reflected. */
  filesystem?: {
    stack: string;
    service: string;
    instance: string;
    workspaceRoot: string;
  };
}

export type ReflectorValidationKind = 'evidence' | 'date' | 'input';

/** Why a cited excerpt was not found verbatim in its cited text block. */
type EvidenceDivergenceClass =
  | 'paraphrase'
  | 'other_block'
  | 'non_text'
  | 'truncated';

export interface EvidenceDivergence {
  class: EvidenceDivergenceClass;
  /** Length in characters of the cited text block. */
  citedBlockLength: number;
}

const DIVERGENCE_HINTS: Record<EvidenceDivergenceClass, string> = {
  paraphrase:
    'The excerpt matches no text in the chunk. Copy a short span character for character from the cited message instead of rewording it.',
  other_block:
    'The excerpt exists in a different message of this chunk. Cite the message_id of the block that contains it, or copy an excerpt from the block you cited.',
  non_text:
    'Tool output and file contents are not citable; cite the text block that contains it, quoting what the user or assistant wrote there.',
  truncated:
    'The excerpt was shortened or extended (ellipsis or altered ends). Copy one contiguous span exactly, without "..." and without added or dropped words at either end.',
};

function correctionGuidance(
  kind: ReflectorValidationKind,
  divergence?: EvidenceDivergence,
): string {
  if (kind === 'evidence') {
    const base =
      'No write was made. Copy a message_id and a short exact excerpt from the supplied chunk, then retry the same operation_key. Do not paraphrase excerpts or cite messages from another chunk.';
    return divergence ? `${base} ${DIVERGENCE_HINTS[divergence.class]}` : base;
  }
  if (kind === 'date') {
    return 'No write was made. Correct the date to a valid ISO-8601 timestamp. An explicitly supported historical date may precede a later report and later corroboration does not move it forward; otherwise use the earliest cited supporting message timestamp; retry the same operation_key.';
  }
  return 'No write was made. Correct the invalid arguments, then retry the same operation_key. Use a new operation_key only for a new operation.';
}

export class ReflectorValidationError extends Error {
  readonly operationKey: string | undefined;
  readonly kind: ReflectorValidationKind;
  readonly correctionGuidance: string;

  constructor(
    message: string,
    operationKey: unknown,
    kind: ReflectorValidationKind,
    divergence?: EvidenceDivergence,
  ) {
    super(message);
    this.name = 'ReflectorValidationError';
    this.kind = kind;
    this.correctionGuidance = correctionGuidance(kind, divergence);
    this.operationKey =
      typeof operationKey === 'string' && operationKey.trim()
        ? operationKey.trim()
        : undefined;
  }
}

export class ReflectorEvidenceError extends ReflectorValidationError {
  constructor(
    message: string,
    operationKey: unknown,
    divergence?: EvidenceDivergence,
  ) {
    super(message, operationKey, 'evidence', divergence);
    this.name = 'ReflectorEvidenceError';
  }
}

export function recordReflectorToolError(
  context: ReflectorMemoryExecutionContext | undefined,
  tool: string,
  error: unknown,
): void {
  if (!context) return;
  context.hadToolError = true;
  const operationKey =
    error instanceof ReflectorValidationError ? error.operationKey : undefined;
  if (operationKey) {
    (context.pendingEvidenceErrors ??= new Set()).add(
      `${tool}:${operationKey}`,
    );
  } else {
    context.hadOtherToolError = true;
  }
  const message = String(serializeError(error).message)
    .replace(/^Error:(?:\s|$)/i, '')
    .trim()
    .slice(0, 1000);
  const errors = (context.toolErrors ??= []);
  // The handler and dispatcher can observe the same rejection. Keep the first
  // distinct failures, so retries cannot bury the original cause or grow a
  // persisted History Review manifest without bound.
  if (
    errors.length < 5 &&
    !errors.some(
      (entry) =>
        entry.tool === tool &&
        entry.message === message &&
        entry.operationKey === operationKey,
    )
  ) {
    errors.push({
      tool,
      message,
      ...(operationKey ? { operationKey } : {}),
      ...(error instanceof ReflectorValidationError
        ? { kind: error.kind }
        : {}),
    });
  }
}

export function resolveReflectorEvidenceError(
  context: ReflectorMemoryExecutionContext | undefined,
  tool: string,
  operationKey: unknown,
): void {
  if (
    !context ||
    (tool !== 'memorize' && tool !== 'forget') ||
    typeof operationKey !== 'string' ||
    !context.pendingEvidenceErrors?.delete(`${tool}:${operationKey.trim()}`)
  )
    return;
  context.toolErrors = context.toolErrors?.filter(
    (entry) =>
      entry.tool !== tool || entry.operationKey !== operationKey.trim(),
  );
  context.hadToolError =
    !!context.hadOtherToolError || context.pendingEvidenceErrors.size > 0;
}

export function createPreviewMemoryState(): PreviewMemoryState {
  return {
    memories: new Map(),
    forgottenIds: new Set(),
    operations: new Map(),
  };
}

/**
 * Merge live query results into the server-owned preview and return the
 * effective transactional view. Staged mutations win over the live baseline,
 * while staged erasures stay absent from every later read or write.
 */
export function effectivePreviewMemories(
  preview: PreviewMemoryState,
  liveMemories: Memory[],
  include: (memory: Memory) => boolean = () => true,
): Memory[] {
  for (const memory of liveMemories) {
    if (!preview.memories.has(memory.id)) {
      preview.memories.set(memory.id, { ...memory });
    }
  }

  const effective = new Map(
    liveMemories.map((memory) => [memory.id, preview.memories.get(memory.id)!]),
  );
  for (const memory of preview.memories.values()) {
    if (preview.forgottenIds.has(memory.id) || !include(memory)) {
      effective.delete(memory.id);
    } else {
      effective.set(memory.id, memory);
    }
  }
  return [...effective.values()];
}

/** Resolve one memory against the same preview overlay used by recall. */
export async function resolveEffectivePreviewMemory(
  preview: PreviewMemoryState,
  memoryId: string,
  loadLive: () => Promise<Memory | null | undefined>,
): Promise<Memory | undefined> {
  if (preview.forgottenIds.has(memoryId)) return undefined;
  const staged = preview.memories.get(memoryId);
  if (staged) return staged;

  const live = await loadLive();
  if (!live) return undefined;
  preview.memories.set(live.id, { ...live });
  return preview.memories.get(live.id);
}
