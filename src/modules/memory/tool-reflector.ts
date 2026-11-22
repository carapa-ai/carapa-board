import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import {
  PROMPTS_DIR,
  REFLECTOR_CHUNK_TIMEOUT_MS,
  REFLECTOR_PENDING_SWEEP_INTERVAL_MS,
} from '../../config.js';
import { logger, serializeError } from '../../logger.js';
import { llmComplete } from '../../lib/llm-client.js';
import { assembleCacheableSystemPrompt } from '../../prompt-cache.js';
import type { RuntimeSelection } from '../../lib/chat-agents.js';
import { chatTranscriptPath, getGroupDir } from '../../group-dir.js';
import { getGroupByFolder } from '../../state-manager.js';
import { getMemoryConfig } from './config.js';
import {
  reflectorGateEnabled,
  startReflectorGateScore,
} from './reflector-gate.js';
import {
  TRANSCRIPT_PROFILE_FILES,
  type TranscriptProfile,
} from './transcript-profiles.js';
import {
  buildReflectorChunks,
  isTaskReflectionSource,
  type ReflectorChunkSource,
} from './transcript-observe.js';
import { parseTranscriptEvidenceFromBuffer } from './transcript-parser.js';
import {
  createPreviewMemoryState,
  type MemoryEvidenceReference,
  type PreviewMemoryOperation,
  type PreviewMemoryState,
  type ReflectorMemoryExecutionContext,
} from './execution-context.js';
import type { Memory } from './types.js';
import {
  checkpointReflectorRun,
  claimReflectorRun,
  completedReflectorRunsForSource,
  ensureReflectorRun,
  failReflectorRun,
  failedReflectorRunsForSource,
  getReflectorRun,
  reclaimPreviewReflectorRun,
  pendingLiveReflectorRunsForSweep,
  recoverableReflectorRuns,
  reflectorRunId,
  releaseReflectorLeases,
  reopenCompletedPreviewReflectorRun,
  resumeReflectorRun,
  retireReflectorRun,
  unfinishedReflectorRunsForSource,
  widenPendingReflectorRun,
} from './reflector-state.js';
import { getPrivacyErasureEpoch } from './privacy-epoch.js';
import {
  automaticTranscriptReflectionQueue,
  isRateLimitedAutomaticReflection,
} from './automatic-reflection-queue.js';
import { trackBackgroundWork } from '../../lib/background-work-gate.js';
import { nameConversationIfUntitled } from '../chat/conversation-title.js';
import { safeResolve } from '../../lib/file-content.js';
import { sha256Hex } from '../../lib/hash.js';
import { isPathInside } from '../../lib/path-containment.js';
import {
  GroupFsError,
  readGroupFile,
  readGroupFileSync,
  writeGroupFileSync,
} from '../../lib/group-fs.js';
import { MAX_MEMORY_STATE_BYTES } from './file-limits.js';
import { MAX_REFLECTOR_TRANSCRIPT_BYTES } from './transcript-read.js';
import {
  sweepObserverCardMemories,
  withOpenCardCache,
} from './open-card-reflection.js';

const TOOL_REFLECTOR_PROMPT_FILE = 'tool-reflector.md';
const TOOL_REFLECTOR_TOOL_NAMES = [
  'recall',
  'memorize',
  'forget',
  'ripgrep',
  'read_file',
  'peek_files',
] as const;

/** Which branch of a chunk's try block threw, for failure categorisation. */
type ReflectorChunkFailureStage = 'tool_error' | 'no_completion' | 'lease_lost';

export class ReflectorChunkFailure extends Error {
  constructor(
    message: string,
    readonly stage: ReflectorChunkFailureStage,
  ) {
    super(message);
    this.name = 'ReflectorChunkFailure';
  }
}

type ErrorLike = {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
  cause?: unknown;
};

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Bounded cause of a failed reflector LLM call: `timeout`, `http_<status>`,
 * `connection`, `empty_response`, `parse` or `other`. Derived from error
 * type/name/code/status (following `cause`) first, message substrings only as
 * a fallback. Never returns raw error text. The call's only abort source is
 * its own timeout signal (lease loss is a `ReflectorChunkFailure`), so aborts
 * are reported as `timeout`; the OpenAI SDK surfaces that timeout as
 * `APIUserAbortError` when it fires before the response arrives.
 */
function classifyLlmErrorCause(error: unknown): string {
  const chain: ErrorLike[] = [];
  for (
    let current: unknown = error;
    current && typeof current === 'object' && chain.length < 4;
    current = (current as ErrorLike).cause
  ) {
    chain.push(current as ErrorLike);
  }
  const names = chain.map((e) => String(e.name ?? ''));
  const codes = chain.map((e) => String(e.code ?? '').toUpperCase());
  const status = chain
    .map((e) => Number(e.status ?? e.statusCode))
    .find((value) => Number.isInteger(value) && value >= 100 && value <= 599);
  const messages = chain.map((e) => String(e.message ?? '').toLowerCase());
  const anyMessage = (pattern: RegExp) =>
    messages.some((message) => pattern.test(message));

  if (
    chain.some(
      (e) =>
        e instanceof OpenAI.APIUserAbortError ||
        e instanceof OpenAI.APIConnectionTimeoutError,
    ) ||
    names.some((n) => n === 'TimeoutError' || n === 'AbortError') ||
    codes.some((c) => c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT')
  )
    return 'timeout';
  if (status !== undefined) return `http_${status}`;
  if (
    chain.some((e) => e instanceof OpenAI.APIConnectionError) ||
    codes.some((c) => CONNECTION_CODES.has(c))
  )
    return 'connection';
  if (names.includes('SyntaxError')) return 'parse';

  // Message fallback for errors without a usable type, status or code.
  const httpMatch = messages
    .map((message) => /\bllm request failed \((\d{3})\)/.exec(message))
    .find(Boolean);
  if (httpMatch) return `http_${httpMatch[1]}`;
  if (anyMessage(/timed? ?out|timeout|\baborted\b|\bcancell?ed\b/))
    return 'timeout';
  if (anyMessage(/econn(refused|reset)|fetch failed|connection error/))
    return 'connection';
  if (anyMessage(/empty response|no content|no choices|empty completion/))
    return 'empty_response';
  if (anyMessage(/\bjson\b|\bparse\b|unexpected token/)) return 'parse';
  return 'other';
}

/**
 * Categorise why a reflector chunk failed, by the branch that threw rather
 * than by parsing LLM output. Returns a bounded category string only (never
 * error text): `tool_error:<tool>:<kind>`, `no_completion`, `lease_lost` or
 * `llm_error:<cause>` (see `classifyLlmErrorCause`).
 */
export function classifyReflectorChunkFailure(
  error: unknown,
  toolErrors: ReflectorMemoryExecutionContext['toolErrors'],
): string {
  if (!(error instanceof ReflectorChunkFailure))
    return `llm_error:${classifyLlmErrorCause(error)}`;
  if (error.stage !== 'tool_error') return error.stage;
  const first = toolErrors?.[0];
  const tool = (TOOL_REFLECTOR_TOOL_NAMES as readonly string[]).includes(
    first?.tool ?? '',
  )
    ? first!.tool
    : 'unknown';
  const kind = first?.message.includes('changed concurrently')
    ? 'version'
    : (first?.kind ?? 'other');
  return `tool_error:${tool}:${kind}`;
}

export interface ProcessTranscriptMemoryOptions {
  /** Publish in-flight History Review progress and staged proposals. */
  onPreviewProgress?: (
    progress: ReflectorPreviewProgress,
  ) => void | Promise<void>;
  byteOffset?: number;
  /** Exclusive transcript watermark for one automatically scheduled range. */
  byteEndOffset?: number;
  profile?: TranscriptProfile;
  mode?: 'live' | 'preview';
  /** Stable caller-owned preview identity; live runs derive identity from source. */
  previewId?: string;
  /** Server-created state used to seed a History Review shadow timeline. */
  previewState?: ReturnType<typeof createPreviewMemoryState>;
  /** Selected-history previews must evaluate even a very short transcript. */
  minimumTranscriptLength?: number;
  /** Additional admission floor for explicit history proposals, not live memory. */
  minimumImportance?: number;
  maxTokensPerChunk?: number;
  agentIdOverride?: string;
  /** Exact Board runtime chosen for an explicit History Review preview. */
  runtimeSelectionOverride?: RuntimeSelection;
  /** Explicit History Review is independent of automatic observation opt-outs. */
  explicitReview?: boolean;
  /**
   * Sandbox context of the run that produced the transcript, used for the
   * reflector's read-only repository inspection.
   */
  workspaceRoot?: string;
  sandboxStack?: string;
  sandboxService?: string;
  sandboxInstance?: string;
  sandboxWorkspacePath?: string;
  /** Authoritative scope of the conversation or task which produced the range. */
  objectiveId?: string | null;
  conversationId?: string;
  /** Internal identity returned by durable automatic admission. */
  admittedRunId?: string;
  /** Signal that eligible live processing has acquired work and is starting. */
  onLiveProcessingStarted?: () => void | Promise<void>;
}

export interface ReflectorPreviewProgress {
  completedChunks: number;
  totalChunks: number;
  failedChunks: number;
  activeChunk: number | null;
  operations: PreviewMemoryOperation[];
  errors: string[];
}

export interface AdmittedTranscriptReflection {
  runId: string;
  byteOffset: number;
  byteEndOffset: number;
}

export interface ProcessTranscriptMemoryResult {
  runId: string;
  completed: boolean;
  error?: string;
  processedChunks: number;
  operationCount: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  previewOperations?: PreviewMemoryOperation[];
}

/**
 * Plain `{ error }` objects are sanitized to `{}` by the logger, so surface the
 * incomplete reason as explicit strings.
 */
export function describeIncompleteReflection(value: unknown): {
  detail: string;
  failureReason?: string;
} {
  const record =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : null;
  const detail =
    value instanceof Error
      ? value.message
      : typeof record?.error === 'string'
        ? record.error
        : String(value);
  return {
    detail: detail.slice(0, 300),
    ...(typeof record?.failureReason === 'string'
      ? { failureReason: record.failureReason.slice(0, 300) }
      : {}),
  };
}

const reflectorRecoveryTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

function sourceReference(groupFolder: string, transcriptPath: string): string {
  const groupDir = getGroupDir(groupFolder);
  return isPathInside(groupDir, transcriptPath)
    ? path.relative(groupDir, transcriptPath).split(path.sep).join('/')
    : path.basename(transcriptPath);
}

/**
 * Read a transcript only through pinned, link-free directories below the group
 * root. A symlink swapped in for the transcript (or one of its parent
 * directories) must not pull another group's file into this group's memories:
 * such a path (or an oversized/non-regular file) is logged and skipped (null)
 * rather than thrown into the pipeline. A missing file still rejects with
 * ENOENT as before. Callers must build chunks from the returned bytes, never
 * from a second by-path read.
 */
async function readGroupTranscript(
  groupFolder: string,
  transcriptPath: string,
): Promise<ReflectorChunkSource | null> {
  try {
    if (
      !isPathInside(getGroupDir(groupFolder), transcriptPath, {
        allowRoot: false,
      })
    ) {
      // A missing file keeps rejecting with ENOENT (callers drop the job).
      await fs.promises.lstat(transcriptPath).catch((statErr: unknown) => {
        if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') throw statErr;
      });
      throw new GroupFsError('invalid_path', 'File is outside its root');
    }
    const read = await readGroupFile(path.resolve(transcriptPath), {
      maxBytes: MAX_REFLECTOR_TRANSCRIPT_BYTES,
    });
    if (!read) {
      throw Object.assign(
        new Error(
          `ENOENT: no such file or directory, open '${transcriptPath}'`,
        ),
        { code: 'ENOENT' },
      );
    }
    return { bytes: read.data, mtimeIso: read.stat.mtime.toISOString() };
  } catch (err) {
    if (!(err instanceof GroupFsError)) throw err;
    logger.warn(
      { groupFolder, transcriptPath, reason: err.code },
      'Skipping transcript that is not a readable file inside the group directory',
    );
    return null;
  }
}

function loadToolReflectorPrompt(profile: TranscriptProfile): string {
  const base = fs.readFileSync(
    path.join(PROMPTS_DIR, TOOL_REFLECTOR_PROMPT_FILE),
    'utf8',
  );
  const sourceProfile = fs.readFileSync(
    path.join(PROMPTS_DIR, TRANSCRIPT_PROFILE_FILES[profile]),
    'utf8',
  );
  return `${base.trim()}\n\n---\n\n${sourceProfile.trim()}\n`;
}

function reflectorOriginFields(options: ProcessTranscriptMemoryOptions) {
  return {
    originScopeKnown: Object.prototype.hasOwnProperty.call(
      options,
      'objectiveId',
    )
      ? 1
      : 0,
    originObjectiveId: options.objectiveId ?? null,
    originConversationId: options.conversationId ?? null,
    workspaceRoot: options.workspaceRoot ?? null,
    sandboxStack: options.sandboxStack ?? null,
    sandboxService: options.sandboxService ?? null,
    sandboxInstance: options.sandboxInstance ?? null,
    sandboxWorkspacePath: options.sandboxWorkspacePath ?? null,
  };
}

function optionsForDurableReflectorRun(
  run: NonNullable<Awaited<ReturnType<typeof getReflectorRun>>>,
  byteEndOffset: number,
  onLiveProcessingStarted?: () => void | Promise<void>,
): ProcessTranscriptMemoryOptions {
  return {
    byteOffset: run.byteOffset,
    byteEndOffset,
    profile: run.profile as TranscriptProfile,
    admittedRunId: run.id,
    ...(run.originScopeKnown === 1
      ? { objectiveId: run.originObjectiveId }
      : {}),
    ...(run.originConversationId
      ? { conversationId: run.originConversationId }
      : {}),
    ...(run.workspaceRoot ? { workspaceRoot: run.workspaceRoot } : {}),
    ...(run.sandboxStack ? { sandboxStack: run.sandboxStack } : {}),
    ...(run.sandboxService ? { sandboxService: run.sandboxService } : {}),
    ...(run.sandboxInstance ? { sandboxInstance: run.sandboxInstance } : {}),
    ...(run.sandboxWorkspacePath
      ? { sandboxWorkspacePath: run.sandboxWorkspacePath }
      : {}),
    ...(onLiveProcessingStarted ? { onLiveProcessingStarted } : {}),
  };
}

function sameOrigin(
  row: Awaited<ReturnType<typeof unfinishedReflectorRunsForSource>>[number],
  origin: ReturnType<typeof reflectorOriginFields>,
): boolean {
  return (
    row.originScopeKnown === origin.originScopeKnown &&
    row.originObjectiveId === origin.originObjectiveId &&
    row.originConversationId === origin.originConversationId &&
    row.workspaceRoot === origin.workspaceRoot &&
    row.sandboxStack === origin.sandboxStack &&
    row.sandboxService === origin.sandboxService &&
    row.sandboxInstance === origin.sandboxInstance &&
    row.sandboxWorkspacePath === origin.sandboxWorkspacePath
  );
}

async function admissibleAutomaticRange(
  groupFolder: string,
  transcriptPath: string,
  options: ProcessTranscriptMemoryOptions,
): Promise<{ byteOffset: number; byteEndOffset: number } | null> {
  const config = getMemoryConfig();
  const profile = options.profile ?? 'run-agent-conversation';
  const transcriptRef = sourceReference(groupFolder, transcriptPath);
  const transcriptSource = await readGroupTranscript(
    groupFolder,
    transcriptPath,
  );
  if (!transcriptSource) return null;
  const transcriptBytes = transcriptSource.bytes;
  const byteEndOffset = Math.max(
    0,
    Math.min(
      transcriptBytes.length,
      options.byteEndOffset ?? transcriptBytes.length,
    ),
  );
  let byteOffset = Math.max(0, options.byteOffset ?? 0);
  if (options.byteOffset === undefined) {
    const priorRuns = await completedReflectorRunsForSource({
      projectId: groupFolder,
      transcriptPath: transcriptRef,
      profile,
    });
    for (const prior of priorRuns) {
      const endOffset = liveFingerprintEnd(
        transcriptBytes,
        prior.transcriptFingerprint,
      );
      if (
        endOffset !== null &&
        endOffset <= byteEndOffset &&
        endOffset > byteOffset
      ) {
        byteOffset = endOffset;
        break;
      }
    }
  }
  if (byteOffset >= byteEndOffset) return null;

  const chunks = buildReflectorChunks(
    transcriptPath,
    byteOffset,
    options.maxTokensPerChunk ?? config.observer.maxTokensPerChunk,
    byteEndOffset,
    transcriptSource,
  );
  const transcriptLength = chunks.reduce(
    (total, chunk) =>
      total +
      chunk.messages.reduce((sum, message) => sum + message.content.length, 0),
    0,
  );
  return transcriptLength >=
    (options.minimumTranscriptLength ?? config.observer.minTranscriptLength)
    ? { byteOffset, byteEndOffset }
    : null;
}

/** Persist an automatic range before its process-local idle timer is armed. */
export async function admitTranscriptMemory(
  groupFolder: string,
  transcriptPath: string,
  options: ProcessTranscriptMemoryOptions,
): Promise<AdmittedTranscriptReflection | null> {
  if (isTaskReflectionSource(transcriptPath, options.profile)) return null;
  const config = getMemoryConfig();
  const gateReason = observationGateReason(groupFolder);
  if (gateReason) {
    logChatReflectionSkip(groupFolder, gateReason, options.conversationId);
    return null;
  }

  const profile = options.profile ?? 'run-agent-conversation';
  const transcriptRef = sourceReference(groupFolder, transcriptPath);
  const transcriptSource = await readGroupTranscript(
    groupFolder,
    transcriptPath,
  );
  if (!transcriptSource) {
    logChatReflectionSkip(groupFolder, 'no_transcript', options.conversationId);
    return null;
  }
  const bytes = transcriptSource.bytes;
  const requestedOffset = Math.max(0, options.byteOffset ?? 0);
  const requestedEnd = Math.max(
    requestedOffset,
    Math.min(bytes.length, options.byteEndOffset ?? bytes.length),
  );
  if (requestedOffset >= requestedEnd) {
    logChatReflectionSkip(groupFolder, 'empty_range', options.conversationId);
    return null;
  }

  const origin = reflectorOriginFields(options);
  const unfinished = await unfinishedReflectorRunsForSource({
    projectId: groupFolder,
    transcriptPath: transcriptRef,
    profile,
  });
  const mergeable = unfinished.find((candidate) => {
    if (
      candidate.status !== 'pending' ||
      candidate.nextChunkIndex !== 0 ||
      !sameOrigin(candidate, origin)
    )
      return false;
    const end = liveFingerprintEnd(bytes, candidate.transcriptFingerprint);
    if (end === null || end > requestedEnd) return false;
    if (requestedOffset <= end) return true;
    // Bookkeeping lines (turn_outcome, ai_user_attribution) are appended after
    // a range is admitted, so consecutive turns are rarely byte-contiguous.
    // They merge as long as the gap carries no user/assistant evidence.
    try {
      return (
        parseTranscriptEvidenceFromBuffer(
          bytes,
          end,
          requestedOffset,
          transcriptSource.mtimeIso,
        ).length === 0
      );
    } catch {
      return false;
    }
  });
  const fingerprint = `${requestedEnd}:${sha256Hex(bytes.subarray(0, requestedEnd))}`;
  const chunkCount = (offset: number) =>
    buildReflectorChunks(
      transcriptPath,
      offset,
      options.maxTokensPerChunk ?? config.observer.maxTokensPerChunk,
      requestedEnd,
      transcriptSource,
    ).length;
  let byteOffset = Math.min(
    mergeable?.byteOffset ?? requestedOffset,
    requestedOffset,
  );
  let totalChunks = chunkCount(byteOffset);

  let run = mergeable
    ? await widenPendingReflectorRun(mergeable.id, {
        transcriptFingerprint: fingerprint,
        byteOffset,
        totalChunks,
        ...origin,
      })
    : undefined;
  if (mergeable && !run) {
    // A queued or recovery claim moved the merge target out of `pending`
    // after the read above. It keeps its own range, so this admission covers
    // only the requested turn rather than a run which re-reflects the target's.
    byteOffset = requestedOffset;
    totalChunks = chunkCount(byteOffset);
  }
  // A range without user or assistant evidence has nothing to reflect.
  if (!run && totalChunks === 0) {
    logChatReflectionSkip(groupFolder, 'empty_range', options.conversationId);
    return null;
  }
  run ??= await ensureReflectorRun({
    id: reflectorRunId({
      projectId: groupFolder,
      transcriptPath: transcriptRef,
      transcriptFingerprint: fingerprint,
      byteOffset,
      profile,
      mode: 'live',
    }),
    projectId: groupFolder,
    transcriptPath: transcriptRef,
    transcriptFingerprint: fingerprint,
    byteOffset,
    profile,
    mode: 'live',
    totalChunks,
    ...origin,
  });
  if (!run) throw new Error('Unable to persist transcript reflector admission');
  return { runId: run.id, byteOffset, byteEndOffset: requestedEnd };
}

interface ToolPreviewStateFile {
  preview_id: string;
  /** Fingerprint of the exact transcript and preview identity producing the checkpoint. */
  transcript_fingerprint: string;
  total_chunks: number;
  /** Staged operations keyed by operation key. */
  operations: Record<string, PreviewMemoryOperation>;
  /** Touched timeline entries referenced by staged operations. */
  memories: Record<string, Memory>;
  forgotten_ids: string[];
  /** Chunk indexes whose staged state completed successfully. */
  completed_chunks?: number[];
  /** Failure details for chunks not durably completed by this checkpoint. */
  failed_chunks: string[];
}

export function toolPreviewStatePath(
  transcriptPath: string,
  previewId: string,
): string {
  return path.join(
    path.dirname(transcriptPath),
    `.tool-preview-state-${previewId}.json`,
  );
}

function isPreviewOperation(value: unknown): value is PreviewMemoryOperation {
  if (typeof value !== 'object' || value === null) return false;
  const operation = value as Partial<PreviewMemoryOperation>;
  if (
    typeof operation.operationKey !== 'string' ||
    operation.operationKey.length === 0
  )
    return false;
  if (
    typeof operation.requestFingerprint !== 'string' ||
    operation.requestFingerprint.length === 0
  )
    return false;
  if (
    operation.operation !== 'create' &&
    operation.operation !== 'supersede' &&
    operation.operation !== 'invalidate' &&
    operation.operation !== 'forget'
  )
    return false;
  if (!Array.isArray(operation.evidence)) return false;
  return operation.evidence.every(
    (reference): reference is MemoryEvidenceReference =>
      typeof reference === 'object' &&
      reference !== null &&
      typeof reference.message_id === 'string' &&
      typeof reference.excerpt === 'string',
  );
}

function isRestorableMemory(value: unknown): value is Memory {
  if (typeof value !== 'object' || value === null) return false;
  const memory = value as Partial<Memory>;
  if (typeof memory.id !== 'string' || memory.id.length === 0) return false;
  if (
    typeof memory.group_folder !== 'string' ||
    memory.group_folder.length === 0
  )
    return false;
  if (typeof memory.content !== 'string') return false;
  return (
    (memory.memory_type === 'identity' ||
      memory.memory_type === 'project' ||
      memory.memory_type === 'goal' ||
      memory.memory_type === 'decision' ||
      memory.memory_type === 'preference' ||
      memory.memory_type === 'contact' ||
      memory.memory_type === 'event' ||
      memory.memory_type === 'task') &&
    typeof memory.importance === 'number' &&
    (memory.source === 'user' ||
      memory.source === 'agent' ||
      memory.source === 'observer') &&
    typeof memory.created_at === 'string' &&
    typeof memory.updated_at === 'string' &&
    typeof memory.last_accessed_at === 'string' &&
    typeof memory.access_count === 'number'
  );
}

function writeToolPreviewState(
  transcriptPath: string,
  previewId: string,
  transcriptFingerprint: string,
  totalChunks: number,
  preview: PreviewMemoryState,
  failedChunks: string[],
  completedChunks: Iterable<number> = [],
): void {
  const operations: Record<string, PreviewMemoryOperation> = {};
  for (const operation of preview.operations.values()) {
    operations[operation.operationKey] = operation;
  }
  // Later supersede/invalidate/forget operations address earlier proposals by
  // memory id; persist exactly the timeline entries those operations touch.
  const touchedIds = new Set<string>();
  for (const operation of Object.values(operations)) {
    if (operation.memoryId) touchedIds.add(operation.memoryId);
    if (operation.resultMemoryId) touchedIds.add(operation.resultMemoryId);
  }
  const memories: Record<string, Memory> = {};
  for (const id of touchedIds) {
    const memory = preview.memories.get(id);
    if (memory) memories[id] = memory;
  }
  const state: ToolPreviewStateFile = {
    preview_id: previewId,
    transcript_fingerprint: transcriptFingerprint,
    total_chunks: totalChunks,
    operations,
    memories,
    forgotten_ids: [...preview.forgottenIds],
    completed_chunks: [...new Set(completedChunks)].sort((a, b) => a - b),
    failed_chunks: [...failedChunks],
  };
  // Atomic and pinned: a leaf or directory planted by the agent is replaced or
  // refused, never written through.
  writeGroupFileSync(
    toolPreviewStatePath(transcriptPath, previewId),
    `${JSON.stringify(state)}\n`,
    { mkdirs: true },
  );
}

function tryReadToolPreviewState(
  statePath: string,
): ToolPreviewStateFile | null {
  let parsed: unknown;
  try {
    const read = readGroupFileSync(statePath, {
      maxBytes: MAX_MEMORY_STATE_BYTES,
    });
    if (!read) return null;
    parsed = JSON.parse(read.data.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const state = parsed as Partial<ToolPreviewStateFile>;
  if (
    typeof state.preview_id !== 'string' ||
    state.preview_id.length === 0 ||
    typeof state.transcript_fingerprint !== 'string' ||
    state.transcript_fingerprint.length === 0 ||
    !Number.isInteger(state.total_chunks) ||
    (state.total_chunks as number) < 0
  )
    return null;
  const record = (value: unknown): value is Record<string, never> =>
    typeof value === 'object' && value !== null;
  if (!record(state.operations) || !record(state.memories)) return null;
  if (!Object.values(state.operations).every(isPreviewOperation)) return null;
  if (!Object.values(state.memories).every(isRestorableMemory)) return null;
  if (!Array.isArray(state.forgotten_ids)) return null;
  if (!Array.isArray(state.failed_chunks)) return null;
  if (
    state.completed_chunks !== undefined &&
    (!Array.isArray(state.completed_chunks) ||
      !state.completed_chunks.every(
        (index) => Number.isInteger(index) && index >= 0,
      ))
  )
    return null;
  if (!state.forgotten_ids.every((id) => typeof id === 'string')) return null;
  if (!state.failed_chunks.every((detail) => typeof detail === 'string'))
    return null;
  return parsed as ToolPreviewStateFile;
}

function completedPreviewChunkIndexes(
  state: ToolPreviewStateFile,
  nextChunkIndex: number,
): Set<number> {
  if (state.completed_chunks) {
    return new Set(
      state.completed_chunks.filter(
        (index) => index >= 0 && index < state.total_chunks,
      ),
    );
  }
  const failedIndexes = new Set<number>();
  for (const detail of state.failed_chunks) {
    const match = detail.match(/chunk (\d+)\//);
    if (match) failedIndexes.add(Number(match[1]) - 1);
  }
  return new Set(
    Array.from({ length: nextChunkIndex }, (_, index) => index).filter(
      (index) => !failedIndexes.has(index),
    ),
  );
}

function firstIncompletePreviewChunkIndex(
  completedChunks: Set<number>,
  totalChunks: number,
): number {
  for (let index = 0; index < totalChunks; index++) {
    if (!completedChunks.has(index)) return index;
  }
  return totalChunks;
}

/**
 * Strictly load a checkpoint that must accompany already-completed chunks. A
 * proposal manifest alone is not proof that a chunk staged every operation,
 * so incompatible or missing state is an actionable resume failure.
 */
function readToolPreviewState(
  statePath: string,
  expected: { transcriptFingerprint: string; totalChunks: number },
): ToolPreviewStateFile {
  const state = tryReadToolPreviewState(statePath);
  if (!state) {
    throw new Error(
      `History preview checkpoint state is missing or invalid: ${statePath}`,
    );
  }
  if (state.transcript_fingerprint !== expected.transcriptFingerprint) {
    throw new Error(
      `History preview checkpoint state no longer matches the selected history: ${statePath}`,
    );
  }
  if (state.total_chunks !== expected.totalChunks) {
    throw new Error(
      `History preview checkpoint state no longer matches the selected history chunk layout: ${statePath}`,
    );
  }
  return state;
}

function restoreToolPreviewState(
  preview: PreviewMemoryState,
  state: ToolPreviewStateFile,
  failedChunks: string[],
): void {
  for (const operation of Object.values(state.operations)) {
    preview.operations.set(operation.operationKey, operation);
  }
  for (const memory of Object.values(state.memories)) {
    preview.memories.set(memory.id, memory);
  }
  for (const id of state.forgotten_ids) {
    preview.forgottenIds.add(id);
  }
  for (const detail of state.failed_chunks) {
    if (!failedChunks.includes(detail)) failedChunks.push(detail);
  }
}

/** Lease tokens this process currently holds, so shutdown can release only its own. */
const ownedReflectorLeaseTokens = new Set<string>();

/** Hand this process's reflector leases back so a restart need not wait out their expiry. */
export async function releaseOwnReflectorLeases(): Promise<number> {
  return releaseReflectorLeases([...ownedReflectorLeaseTokens]);
}

/**
 * Run the single tool-driven reflector over stable, ordered transcript chunks.
 * Every completed chunk is checkpointed once its staged state is durable;
 * live chunks resume at the first incomplete chunk, and preview chunks resume
 * from their per-chunk state file after a Board restart. Failed preview
 * chunks retry on the next run of the same preview; retries reuse durable
 * per-operation receipts.
 */
async function runToolDrivenReflectorRange(
  groupFolder: string,
  transcriptPath: string,
  options: ProcessTranscriptMemoryOptions = {},
): Promise<ProcessTranscriptMemoryResult | null> {
  const held: { token?: string } = {};
  try {
    return await runToolDrivenReflectorRangeLeased(
      groupFolder,
      transcriptPath,
      options,
      held,
    );
  } finally {
    if (held.token) ownedReflectorLeaseTokens.delete(held.token);
  }
}

async function runToolDrivenReflectorRangeLeased(
  groupFolder: string,
  transcriptPath: string,
  options: ProcessTranscriptMemoryOptions,
  held: { token?: string },
): Promise<ProcessTranscriptMemoryResult | null> {
  const config = getMemoryConfig();
  const group = getGroupByFolder(groupFolder);
  const mode = options.mode ?? 'live';
  const chatSkip = (reason: string) => {
    if (mode === 'live' && !options.explicitReview)
      logChatReflectionSkip(groupFolder, reason, options.conversationId);
  };
  if (!options.explicitReview) {
    const gateReason = observationGateReason(groupFolder);
    if (gateReason) {
      chatSkip(gateReason);
      return null;
    }
  }

  const profile = options.profile ?? 'run-agent-conversation';
  const transcriptRef = sourceReference(groupFolder, transcriptPath);
  // Taken before anything is read: if the folder is retired while this job
  // waits on its LLM, every later read and write is refused.
  const privacyEpoch = getPrivacyErasureEpoch(groupFolder);
  const transcriptSource = await readGroupTranscript(
    groupFolder,
    transcriptPath,
  );
  if (!transcriptSource) {
    chatSkip('no_transcript');
    return null;
  }
  const transcriptBytes = transcriptSource.bytes;
  const transcriptEndOffset = Math.max(
    0,
    Math.min(
      transcriptBytes.length,
      options.byteEndOffset ?? transcriptBytes.length,
    ),
  );
  let byteOffset = Math.max(0, options.byteOffset ?? 0);
  if (options.byteOffset === undefined && mode === 'live') {
    const priorRuns = await completedReflectorRunsForSource({
      projectId: groupFolder,
      transcriptPath: transcriptRef,
      profile,
    });
    for (const prior of priorRuns) {
      const match = prior.transcriptFingerprint.match(/^(\d+):([a-f0-9]{64})$/);
      if (!match) continue;
      const endOffset = Number(match[1]);
      if (endOffset > transcriptEndOffset || endOffset <= byteOffset) continue;
      const prefixHash = sha256Hex(transcriptBytes.subarray(0, endOffset));
      if (prefixHash === match[2]) {
        byteOffset = endOffset;
        break;
      }
    }
  }
  if (byteOffset >= transcriptEndOffset) {
    chatSkip('nothing_new');
    return null;
  }
  const chunks = buildReflectorChunks(
    transcriptPath,
    byteOffset,
    options.maxTokensPerChunk ?? config.observer.maxTokensPerChunk,
    transcriptEndOffset,
    transcriptSource,
  );
  if (chunks.length === 0) {
    chatSkip('empty_range');
    return null;
  }
  let run = options.admittedRunId
    ? await getReflectorRun(options.admittedRunId)
    : undefined;
  if (
    run &&
    (run.projectId !== groupFolder ||
      run.transcriptPath !== transcriptRef ||
      run.profile !== profile ||
      run.mode !== mode ||
      run.byteOffset !== byteOffset)
  ) {
    throw new Error('Durable reflector admission no longer matches its source');
  }
  const transcriptLength = chunks.reduce(
    (total, chunk) =>
      total +
      chunk.messages.reduce((sum, message) => sum + message.content.length, 0),
    0,
  );
  if (
    !run &&
    transcriptLength <
      (options.minimumTranscriptLength ?? config.observer.minTranscriptLength)
  )
    return null;

  const fingerprint = `${transcriptEndOffset}:${sha256Hex(
    transcriptBytes.subarray(0, transcriptEndOffset),
  )}`;
  const runFingerprint =
    mode === 'preview' && options.previewId
      ? `${fingerprint}:${options.previewId}`
      : fingerprint;
  if (run && run.transcriptFingerprint !== runFingerprint) {
    throw new Error('Durable reflector admission transcript changed');
  }
  const previewId = mode === 'preview' ? options.previewId : undefined;
  const resumablePreview = previewId !== undefined;
  const previewStatePath = previewId
    ? toolPreviewStatePath(transcriptPath, previewId)
    : undefined;
  const persistedPreviewState =
    previewStatePath && fs.existsSync(previewStatePath)
      ? readToolPreviewState(previewStatePath, {
          transcriptFingerprint: runFingerprint,
          totalChunks: chunks.length,
        })
      : null;
  const derivedRunId = reflectorRunId({
    projectId: groupFolder,
    transcriptPath: transcriptRef,
    transcriptFingerprint: runFingerprint,
    byteOffset,
    profile,
    mode,
  });
  if (!run && mode === 'live') {
    const failedRuns = await failedReflectorRunsForSource({
      projectId: groupFolder,
      transcriptPath: transcriptRef,
      profile,
      byteOffset,
    });
    const compatible = failedRuns
      .map((candidate) => {
        const match = candidate.transcriptFingerprint.match(
          /^(\d+):([a-f0-9]{64})$/,
        );
        if (!match) return null;
        const previousLength = Number(match[1]);
        if (previousLength > transcriptEndOffset) return null;
        const prefixHash = sha256Hex(
          transcriptBytes.subarray(0, previousLength),
        );
        return prefixHash === match[2] ? { candidate, previousLength } : null;
      })
      .filter(
        (
          value,
        ): value is {
          candidate: (typeof failedRuns)[number];
          previousLength: number;
        } => value !== null,
      )
      .sort((a, b) => b.previousLength - a.previousLength)[0]?.candidate;
    if (compatible) {
      run = await resumeReflectorRun(
        compatible.id,
        runFingerprint,
        chunks.length,
      );
    }
  }
  run ??= await ensureReflectorRun({
    id: derivedRunId,
    projectId: groupFolder,
    transcriptPath: transcriptRef,
    transcriptFingerprint: runFingerprint,
    byteOffset,
    profile,
    mode,
    totalChunks: chunks.length,
    ...reflectorOriginFields(options),
  });
  if (!run) throw new Error('Unable to create reflector progress record');
  const preview =
    mode === 'preview'
      ? (options.previewState ?? createPreviewMemoryState())
      : undefined;
  const previewStateRequired =
    resumablePreview && (run.status !== 'pending' || run.nextChunkIndex > 0);

  if (preview && previewId && !persistedPreviewState && !previewStateRequired) {
    // Materialize the empty checkpoint before claiming a new run. From this
    // point on, an absent state file unambiguously means that the resumable
    // overlay was lost rather than that the run had never started.
    writeToolPreviewState(
      transcriptPath,
      previewId,
      runFingerprint,
      chunks.length,
      preview,
      [],
      [],
    );
  }

  if (run.status === 'completed') {
    if (previewId) {
      // The run already finished a full pass. Re-derive the staged preview
      // from its durable checkpoint instead of reporting empty results.
      const state =
        persistedPreviewState ??
        readToolPreviewState(previewStatePath!, {
          transcriptFingerprint: runFingerprint,
          totalChunks: chunks.length,
        });
      if (state.preview_id !== previewId) {
        throw new Error(
          'History preview checkpoint state does not belong to this preview',
        );
      }
      const completedChunkIndexes = completedPreviewChunkIndexes(
        state,
        run.nextChunkIndex,
      );
      if (state.failed_chunks.length > 0) {
        const reopened = await reopenCompletedPreviewReflectorRun(
          run.id,
          runFingerprint,
          firstIncompletePreviewChunkIndex(
            completedChunkIndexes,
            chunks.length,
          ),
        );
        if (!reopened) {
          throw new Error(
            'History preview run with failed chunks could not be reopened safely',
          );
        }
        run = reopened;
      } else {
        await options.onPreviewProgress?.({
          completedChunks: completedChunkIndexes.size,
          totalChunks: chunks.length,
          failedChunks: state.failed_chunks.length,
          activeChunk: null,
          operations: Object.values(state.operations),
          errors: [...state.failed_chunks],
        });
        return {
          runId: run.id,
          completed: true,
          processedChunks: completedChunkIndexes.size,
          operationCount: Object.keys(state.operations).length,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          previewOperations: Object.values(state.operations),
        };
      }
    } else {
      chatSkip('nothing_new');
      return {
        runId: run.id,
        completed: true,
        processedChunks: 0,
        operationCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
  }

  let leaseToken = randomUUID();
  let claimed = await claimReflectorRun(run.id, leaseToken);
  if (claimed) {
    held.token = leaseToken;
    ownedReflectorLeaseTokens.add(leaseToken);
  }
  if (!claimed && resumablePreview) {
    // Recovery already owns the batch lease, so a processing preview run can
    // only belong to the stopped Board process. Reclaim it immediately; the
    // normal lease timeout remains in force for live reflector work.
    const current = await getReflectorRun(run.id);
    if (current?.status === 'processing') {
      await reclaimPreviewReflectorRun(run.id, previewId, runFingerprint);
      const retryToken = randomUUID();
      const retried = await claimReflectorRun(run.id, retryToken);
      if (retried) {
        leaseToken = retryToken;
        claimed = retried;
        held.token = retryToken;
        ownedReflectorLeaseTokens.add(retryToken);
      }
    }
  }
  if (!claimed) {
    chatSkip('leased_by_other_worker');
    let previewOperations: PreviewMemoryOperation[] | undefined;
    let restoredProgress = run.nextChunkIndex;
    if (previewId) {
      const state =
        persistedPreviewState ??
        (previewStateRequired
          ? readToolPreviewState(previewStatePath!, {
              transcriptFingerprint: runFingerprint,
              totalChunks: chunks.length,
            })
          : null);
      if (
        state &&
        state.preview_id === previewId &&
        state.transcript_fingerprint === runFingerprint &&
        state.total_chunks === chunks.length
      ) {
        previewOperations = Object.values(state.operations);
        restoredProgress = completedPreviewChunkIndexes(
          state,
          run.nextChunkIndex,
        ).size;
      }
    }
    return {
      runId: run.id,
      completed: false,
      error: 'Reflector run is already leased by another worker',
      processedChunks: resumablePreview ? restoredProgress : 0,
      operationCount: previewOperations?.length ?? 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ...(previewOperations ? { previewOperations } : {}),
    };
  }
  run = claimed;

  const prompt = assembleCacheableSystemPrompt(
    loadToolReflectorPrompt(profile),
    options.minimumImportance !== undefined
      ? `History Review admission: create and supersede proposals must have importance ${options.minimumImportance}..1. Pass an explicit importance score to memorize. Skip lower-importance candidates; do not inflate scores to meet the threshold. This floor does not apply to invalidate or forget.`
      : '',
  );

  if (mode === 'live' && run.nextChunkIndex < chunks.length) {
    await options.onLiveProcessingStarted?.();
  }
  let completedChunkIndexes = new Set<number>();
  let processedChunks = 0;
  let operationCount = 0;
  let previewErrors: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  if (preview && previewId) {
    const statePath = previewStatePath!;
    const state =
      persistedPreviewState ??
      (previewStateRequired
        ? readToolPreviewState(statePath, {
            transcriptFingerprint: runFingerprint,
            totalChunks: chunks.length,
          })
        : null);
    if (state) {
      // Checkpointed work requires its state file: a proposal manifest alone
      // is not proof that a chunk staged every operation.
      if (state.preview_id !== previewId) {
        throw new Error(
          'History preview checkpoint state does not belong to this preview',
        );
      }
      restoreToolPreviewState(preview, state, previewErrors);
      completedChunkIndexes = completedPreviewChunkIndexes(
        state,
        run.nextChunkIndex,
      );
      processedChunks = completedChunkIndexes.size;
    }
  }

  async function publishPreviewProgress(activeChunk: number | null) {
    if (!preview) return;
    await options.onPreviewProgress?.({
      completedChunks: processedChunks,
      totalChunks: chunks.length,
      failedChunks: previewErrors.length,
      activeChunk,
      operations: [...preview.operations.values()],
      errors: [...previewErrors],
    });
  }

  // Runtime the reflector call uses, mirroring llmComplete's precedence.
  const runtimeSelection =
    options.runtimeSelectionOverride ?? config.reflector.llm.runtimeSelection;
  const reflectorModel = options.runtimeSelectionOverride
    ? `${options.runtimeSelectionOverride.harnessId}/${options.runtimeSelectionOverride.modelId}`
    : options.agentIdOverride
      ? options.agentIdOverride
      : runtimeSelection
        ? `${runtimeSelection.harnessId}/${runtimeSelection.modelId}`
        : config.reflector.llm.agentId;

  for (let index = run.nextChunkIndex; index < chunks.length; index++) {
    if (completedChunkIndexes.has(index)) continue;
    await publishPreviewProgress(index + 1);
    const chunk = chunks[index]!;
    if (run.originScopeKnown === 1) {
      for (const message of chunk.messages) {
        if (message.objectiveId === undefined) {
          message.objectiveId = run.originObjectiveId;
        }
      }
    }
    const context: ReflectorMemoryExecutionContext = {
      kind: 'reflector',
      mode,
      runId: run.id,
      chunkKey: `chunk-${index}`,
      sourceRef: transcriptRef,
      privacyEpoch,
      evidence: new Map(chunk.messages.map((message) => [message.id, message])),
      preview,
      hadToolError: false,
      completedOperationKeys: new Set(),
      ...(run.sandboxStack &&
      run.sandboxService &&
      run.sandboxInstance &&
      run.sandboxWorkspacePath
        ? {
            filesystem: {
              stack: run.sandboxStack,
              service: run.sandboxService,
              instance: run.sandboxInstance,
              workspaceRoot: run.sandboxWorkspacePath,
            },
          }
        : {}),
    };
    const projectMetadata = {
      folder: groupFolder,
      name: group?.name ?? groupFolder,
      parent: group?.parentId ?? null,
      repositoryAvailable: Boolean(group?.settings?.repositoryLocation),
      ...(run.originConversationId
        ? { conversationId: run.originConversationId }
        : {}),
      ...(run.originScopeKnown === 1
        ? { objectiveId: run.originObjectiveId }
        : {}),
    };
    const userMessage = [
      `Project metadata: ${JSON.stringify(projectMetadata)}`,
      `Chunk ${index + 1} of ${chunks.length}; evidence time begins ${chunk.messageDateUtc}.`,
      '',
      'Transcript chunk:',
      chunk.text,
    ].join('\n');

    const startedAt = Date.now();
    // Observe-only: Jev scores the chunk while the LLM works; never affects it.
    const gateScore = reflectorGateEnabled({
      mode,
      explicitReview: options.explicitReview,
    })
      ? startReflectorGateScore(
          {
            text: chunk.text,
            index,
            transcriptPath: transcriptRef,
            firstMessageId: chunk.messages[0]?.id,
            lastMessageId: chunk.messages.at(-1)?.id,
          },
          { groupFolder, runId: run.id },
        )
      : null;
    let chunkOperationCount: number | null = null;
    let failureReason: string | undefined;
    let llmDurationMs: number | undefined;
    let llmUsage:
      | { prompt_tokens?: number; completion_tokens?: number }
      | undefined;
    const llmStartedAt = Date.now();
    try {
      const response = await llmComplete(
        config.reflector.llm,
        prompt,
        userMessage,
        {
          watchAgentsFile: false,
          // History proposals run in the background and include multiple tool
          // calls per chunk; the interactive two-minute default is too short.
          timeoutMs: mode === 'preview' ? 600_000 : REFLECTOR_CHUNK_TIMEOUT_MS,
          groupFolder,
          allowedToolNames: [...TOOL_REFLECTOR_TOOL_NAMES],
          permissions: {
            [groupFolder]: ['fs:read', 'memories:read', 'memories:write'],
          },
          memoryExecution: context,
          ...(options.agentIdOverride
            ? { agentIdOverride: options.agentIdOverride }
            : {}),
          ...(options.runtimeSelectionOverride
            ? { runtimeSelectionOverride: options.runtimeSelectionOverride }
            : {}),
        },
      );
      llmDurationMs = Date.now() - llmStartedAt;
      llmUsage = response.usage;
      usage.inputTokens += response.usage?.prompt_tokens ?? 0;
      usage.outputTokens += response.usage?.completion_tokens ?? 0;
      usage.totalTokens += response.usage?.total_tokens ?? 0;
      if (
        context.hadToolError ||
        !response.content.trimEnd().endsWith('REFLECTION_COMPLETE')
      ) {
        throw new ReflectorChunkFailure(
          context.hadToolError
            ? 'Reflector ended after a rejected or failed tool operation'
            : 'Reflector did not confirm chunk completion',
          context.hadToolError ? 'tool_error' : 'no_completion',
        );
      }
      chunkOperationCount = context.completedOperationKeys.size;
      operationCount += context.completedOperationKeys.size;
      completedChunkIndexes.add(index);
      processedChunks++;
      if (preview && previewId) {
        previewErrors = previewErrors.filter(
          (record) =>
            !record.includes(
              ` (run ${run.id}, chunk ${index + 1}/${chunks.length})`,
            ),
        );
        writeToolPreviewState(
          transcriptPath,
          previewId,
          runFingerprint,
          chunks.length,
          preview,
          previewErrors,
          completedChunkIndexes,
        );
      }
      const nextChunkIndex = preview
        ? firstIncompletePreviewChunkIndex(completedChunkIndexes, chunks.length)
        : index + 1;
      const retained = await checkpointReflectorRun(
        run.id,
        leaseToken,
        nextChunkIndex,
        chunks.length,
      );
      if (!retained) {
        throw new ReflectorChunkFailure(
          'Reflector run lease was lost',
          'lease_lost',
        );
      }
      logger.info(
        {
          group_folder: groupFolder,
          runId: run.id,
          chunk: index,
          transcriptPath: transcriptRef,
          totalChunks: chunks.length,
          byteOffset,
          byteEndOffset: transcriptEndOffset,
          mode,
          profile,
          duration_ms: Date.now() - startedAt,
          operations: context.completedOperationKeys.size,
          usage: response.usage,
        },
        'Tool-driven reflector chunk completed',
      );
      await publishPreviewProgress(null);
    } catch (error) {
      llmDurationMs ??= Date.now() - llmStartedAt;
      failureReason = classifyReflectorChunkFailure(error, context.toolErrors);
      const reason = String(serializeError(error).message);
      const toolDetails = (context.toolErrors ?? [])
        .map(({ tool, message }) => `${tool}: ${message}`)
        .join('; ');
      const detail = `${reason} (run ${run.id}, chunk ${index + 1}/${chunks.length})${toolDetails ? `: ${toolDetails}` : ''}`;
      logger.warn(
        {
          error,
          detail,
          failureReason,
          model: reflectorModel,
          group_folder: groupFolder,
          runId: run.id,
          chunk: index,
          transcriptPath: transcriptRef,
          totalChunks: chunks.length,
          byteOffset,
          byteEndOffset: transcriptEndOffset,
          mode,
          profile,
        },
        'Tool-driven reflector chunk incomplete; progress retained',
      );
      if (mode === 'preview') {
        // Keep staged proposals and inspect the remaining history. Record the
        // failures at the end rather than marking skipped chunks complete.
        previewErrors = previewErrors.filter(
          (record) =>
            !record.includes(
              ` (run ${run.id}, chunk ${index + 1}/${chunks.length})`,
            ),
        );
        previewErrors.push(detail);
        if (preview && previewId) {
          writeToolPreviewState(
            transcriptPath,
            previewId,
            runFingerprint,
            chunks.length,
            preview,
            previewErrors,
            completedChunkIndexes,
          );
        }
        operationCount += context.completedOperationKeys.size;
        await publishPreviewProgress(null);
        continue;
      }
      // Rate limits are transient and never count toward dead-lettering.
      await failReflectorRun(run.id, leaseToken, detail, {
        countFailure: !isRateLimitedAutomaticReflection(detail),
      });
      if (await deadLetterFailingReflectorRun(run.id, groupFolder, detail)) {
        // Retired: report the range as finished so the queue and recovery
        // move on to later ranges instead of retrying it.
        return {
          runId: run.id,
          completed: true,
          error: detail,
          processedChunks,
          operationCount,
          usage,
        };
      }
      return {
        runId: run.id,
        completed: false,
        error: detail,
        processedChunks,
        operationCount,
        usage,
        ...(preview
          ? { previewOperations: [...preview.operations.values()] }
          : {}),
      };
    } finally {
      // Detached: the shadow record must never delay the next chunk.
      void gateScore?.finish(
        chunkOperationCount,
        failureReason,
        reflectorModel,
        {
          llmDurationMs,
          promptTokens: llmUsage?.prompt_tokens,
          completionTokens: llmUsage?.completion_tokens,
          chunkMessages: chunk.messages.length,
        },
      );
    }
    await publishPreviewProgress(null);
  }

  if (previewErrors.length > 0) {
    const error = previewErrors.join('\n');
    await failReflectorRun(run.id, leaseToken, error);
    return {
      runId: run.id,
      completed: false,
      error,
      processedChunks,
      operationCount,
      usage,
      previewOperations: [...preview!.operations.values()],
    };
  }

  if (mode === 'preview') {
    // Preview progress is an execution record only; no live memory mutation or
    // reusable checkpoint is exposed as a completed automatic run.
    await checkpointReflectorRun(
      run.id,
      leaseToken,
      chunks.length,
      chunks.length,
    );
  } else if (run.nextChunkIndex >= chunks.length) {
    chatSkip('nothing_new');
    await checkpointReflectorRun(
      run.id,
      leaseToken,
      chunks.length,
      chunks.length,
    );
  }
  return {
    runId: run.id,
    completed: true,
    processedChunks,
    operationCount,
    usage,
    ...(preview ? { previewOperations: [...preview.operations.values()] } : {}),
  };
}

/** Consecutive failures after which a live range is dead-lettered. */
const MAX_REFLECTOR_RUN_FAILURES = 3;

/**
 * Retire a live run that has failed repeatedly so a deterministic failure
 * cannot block every later range of its conversation. Returns whether it
 * was retired.
 */
async function deadLetterFailingReflectorRun(
  runId: string,
  groupFolder: string,
  lastError: string,
): Promise<boolean> {
  const failed = await getReflectorRun(runId);
  if (
    !failed ||
    failed.mode !== 'live' ||
    failed.status !== 'error' ||
    failed.failureCount < MAX_REFLECTOR_RUN_FAILURES
  ) {
    return false;
  }
  if (
    !(await retireReflectorRun(
      runId,
      `dead_lettered after ${failed.failureCount} failures: ${lastError}`,
    ))
  ) {
    return false;
  }
  logger.warn(
    {
      runId,
      group_folder: groupFolder,
      conversationId: failed.originConversationId,
      transcriptPath: failed.transcriptPath,
      byteOffset: failed.byteOffset,
      byteEndOffset: Number(failed.transcriptFingerprint.split(':')[0]),
      failureCount: failed.failureCount,
      detail: lastError.slice(0, 300),
    },
    'Dead-lettered reflector run after repeated failures; later ranges proceed',
  );
  return true;
}

function liveFingerprintEnd(
  transcriptBytes: Buffer,
  fingerprint: string,
): number | null {
  const match = fingerprint.match(/^(\d+):([a-f0-9]{64})$/);
  if (!match) return null;
  const endOffset = Number(match[1]);
  if (endOffset > transcriptBytes.length) return null;
  const prefixHash = sha256Hex(transcriptBytes.subarray(0, endOffset));
  return prefixHash === match[2] ? endOffset : null;
}

/**
 * Recover durable earlier source ranges before admitting the newly scheduled
 * boundary. This preserves source order even when the process-local queue and
 * its retry timer were lost during a board restart.
 */
export async function runToolDrivenReflector(
  groupFolder: string,
  transcriptPath: string,
  options: ProcessTranscriptMemoryOptions = {},
): Promise<ProcessTranscriptMemoryResult | null> {
  if (isTaskReflectionSource(transcriptPath, options.profile)) return null;
  return withOpenCardCache(async () => {
    try {
      return await runToolDrivenReflectorWithRecovery(
        groupFolder,
        transcriptPath,
        options,
      );
    } finally {
      if ((options.mode ?? 'live') === 'live')
        await sweepObserverCardMemories(groupFolder);
    }
  });
}

async function runToolDrivenReflectorWithRecovery(
  groupFolder: string,
  transcriptPath: string,
  options: ProcessTranscriptMemoryOptions,
): Promise<ProcessTranscriptMemoryResult | null> {
  if ((options.mode ?? 'live') !== 'live') {
    return runToolDrivenReflectorRange(groupFolder, transcriptPath, options);
  }

  const profile = options.profile ?? 'run-agent-conversation';
  const transcriptRef = sourceReference(groupFolder, transcriptPath);
  const transcriptSource = await readGroupTranscript(
    groupFolder,
    transcriptPath,
  );
  if (!transcriptSource) return null;
  const transcriptBytes = transcriptSource.bytes;
  const requestedOffset = Math.max(0, options.byteOffset ?? 0);
  const requestedEnd = Math.max(
    0,
    Math.min(
      transcriptBytes.length,
      options.byteEndOffset ?? transcriptBytes.length,
    ),
  );
  const unfinished = await unfinishedReflectorRunsForSource({
    projectId: groupFolder,
    transcriptPath: transcriptRef,
    profile,
  });
  const recoveryResults: ProcessTranscriptMemoryResult[] = [];

  for (const pending of unfinished) {
    const pendingEnd = liveFingerprintEnd(
      transcriptBytes,
      pending.transcriptFingerprint,
    );
    if (
      pendingEnd === null ||
      pendingEnd > requestedEnd ||
      (pending.byteOffset === requestedOffset && pendingEnd === requestedEnd)
    ) {
      continue;
    }
    const recovered = await runToolDrivenReflectorRange(
      pending.projectId,
      transcriptPath,
      {
        ...optionsForDurableReflectorRun(pending, pendingEnd),
        minimumTranscriptLength: 0,
        onLiveProcessingStarted: options.onLiveProcessingStarted,
      },
    );
    if (!recovered) continue;
    recoveryResults.push(recovered);
    if (!recovered.completed) return recovered;
  }

  const current = await runToolDrivenReflectorRange(
    groupFolder,
    transcriptPath,
    options,
  );
  if (recoveryResults.length === 0) return current;
  if (!current) return recoveryResults.at(-1)!;
  return {
    ...current,
    processedChunks:
      current.processedChunks +
      recoveryResults.reduce((sum, result) => sum + result.processedChunks, 0),
    operationCount:
      current.operationCount +
      recoveryResults.reduce((sum, result) => sum + result.operationCount, 0),
    usage: recoveryResults.reduce(
      (total, result) => ({
        inputTokens: total.inputTokens + result.usage.inputTokens,
        outputTokens: total.outputTokens + result.usage.outputTokens,
        totalTokens: total.totalTokens + result.usage.totalTokens,
      }),
      { ...current.usage },
    ),
  };
}

function sourceTranscriptPath(run: {
  projectId: string;
  transcriptPath: string;
}): string | null {
  try {
    return safeResolve(getGroupDir(run.projectId), run.transcriptPath);
  } catch {
    return null;
  }
}

/** Propagated runs were admitted for a parent/main project before propagation was retired. */
function isRetiredPropagationRun(run: {
  projectId: string;
  transcriptPath: string;
  sourceGroupFolder: string | null;
}): boolean {
  return (
    run.transcriptPath.startsWith('propagated:') ||
    (run.sourceGroupFolder !== null && run.sourceGroupFolder !== run.projectId)
  );
}

/** The chat idle delay is 5 minutes; leave a row's own timer twice that. */
const PENDING_SWEEP_MIN_AGE_MS = 10 * 60_000;
const PENDING_SWEEP_LIMIT = 50;

type ObservationGateReason =
  | 'disabled'
  | 'excluded_group'
  | 'observations_disabled_for_project';

/** Memory disabled, group excluded, or observations disabled for the project. */
function observationGateReason(
  groupFolder: string,
): ObservationGateReason | null {
  const config = getMemoryConfig();
  if (!config.enabled) return 'disabled';
  if (config.observer.excludeGroups.includes(groupFolder))
    return 'excluded_group';
  if (getGroupByFolder(groupFolder)?.settings?.disableObservations)
    return 'observations_disabled_for_project';
  return null;
}

function isObservationGated(groupFolder: string): boolean {
  return observationGateReason(groupFolder) !== null;
}

/** Groups whose `disabled` skip was already logged, so a flag left off logs once. */
const disabledSkipLoggedGroups = new Set<string>();

/** Log why an automatic chat reflection did nothing; never logs transcript content. */
function logChatReflectionSkip(
  groupFolder: string,
  reason: string,
  conversationId?: string,
): void {
  if (reason === 'disabled') {
    if (disabledSkipLoggedGroups.has(groupFolder)) return;
    disabledSkipLoggedGroups.add(groupFolder);
  }
  logger.info(
    {
      group_folder: groupFolder,
      skip_reason: reason,
      ...(conversationId ? { conversation_id: conversationId } : {}),
    },
    'Chat reflection skipped',
  );
}

/** A live run whose transcript has been missing this long will not come back. */
const SOURCE_UNAVAILABLE_RETIRE_AFTER_MS = 24 * 3600_000;

type RecoverableRunOutcome =
  | 'queued'
  | 'already_queued'
  | 'retired_source_unavailable'
  | 'retired_source_changed'
  | 'source_unavailable'
  | 'skipped';

async function queueRecoverableReflectorRun(
  runId: string,
  options: { afterLeaseExpiry?: boolean } = {},
): Promise<RecoverableRunOutcome> {
  const run = await getReflectorRun(runId);
  if (
    !run ||
    run.mode !== 'live' ||
    !['pending', 'processing', 'error'].includes(run.status)
  ) {
    return 'skipped';
  }

  const transcriptPath = sourceTranscriptPath(run);
  // Leave old task records intact, but never arm retries or replay them.
  if (
    isTaskReflectionSource(transcriptPath ?? run.transcriptPath, run.profile)
  ) {
    return 'skipped';
  }

  if (isRetiredPropagationRun(run)) {
    if (await retireReflectorRun(run.id)) {
      logger.info(
        {
          runId: run.id,
          projectId: run.projectId,
          sourceGroupFolder: run.sourceGroupFolder,
        },
        'Retired propagated transcript reflector run; child transcripts are no longer reflected for parent or main projects',
      );
    }
    return 'skipped';
  }

  if (run.totalChunks === 0) {
    // Admitted before empty ranges were refused: nothing to reflect, and
    // processing never checkpoints it, so it would be requeued on every start.
    if (
      await retireReflectorRun(run.id, 'empty_range: no evidence to reflect')
    ) {
      logger.info(
        { runId: run.id, projectId: run.projectId },
        'Retired empty transcript reflector run',
      );
    }
    return 'skipped';
  }

  const leaseExpiry = run.leaseExpiresAt
    ? Date.parse(run.leaseExpiresAt)
    : Number.NaN;
  if (run.status === 'processing' && leaseExpiry > Date.now()) {
    if (!reflectorRecoveryTimers.has(run.id)) {
      const timer = setTimeout(
        () => {
          reflectorRecoveryTimers.delete(run.id);
          void queueRecoverableReflectorRun(run.id, {
            afterLeaseExpiry: true,
          }).catch((error) =>
            logger.warn(
              { error, runId: run.id, projectId: run.projectId },
              'Transcript reflector lease-expiry recovery failed',
            ),
          );
        },
        leaseExpiry - Date.now() + 1,
      );
      timer.unref?.();
      reflectorRecoveryTimers.set(run.id, timer);
    }
    // Enqueueing now would only fail with "already leased"; the timer above
    // requeues the run once the lease expires.
    return 'queued';
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    const updatedAt = Date.parse(run.updatedAt);
    const stale =
      Number.isFinite(updatedAt) &&
      Date.now() - updatedAt > SOURCE_UNAVAILABLE_RETIRE_AFTER_MS;
    if (stale) {
      // Diagnostics are read before retiring: retirement overwrites `error`.
      const diagnostics = {
        runId: run.id,
        projectId: run.projectId,
        profile: run.profile,
        status: run.status,
        failureCount: run.failureCount,
        nextChunkIndex: run.nextChunkIndex,
        totalChunks: run.totalChunks,
        detail: String(run.error ?? '').slice(0, 300),
      };
      if (
        await retireReflectorRun(
          run.id,
          'source_unavailable: live transcript missing (archived or deleted)',
        )
      ) {
        logger.warn(
          diagnostics,
          'Retired reflector run: source transcript unavailable',
        );
        return 'retired_source_unavailable';
      }
      return 'skipped';
    }
    logger.warn(
      {
        runId: run.id,
        projectId: run.projectId,
        profile: run.profile,
        transcriptPath: run.transcriptPath,
      },
      'Durable reflector admission source is unavailable',
    );
    return 'source_unavailable';
  }
  const transcriptSource = await readGroupTranscript(
    run.projectId,
    transcriptPath,
  );
  if (!transcriptSource) return 'skipped';
  const byteEndOffset = liveFingerprintEnd(
    transcriptSource.bytes,
    run.transcriptFingerprint,
  );
  if (byteEndOffset === null) {
    const updatedAt = Date.parse(run.updatedAt);
    const stale =
      Number.isFinite(updatedAt) &&
      Date.now() - updatedAt > SOURCE_UNAVAILABLE_RETIRE_AFTER_MS;
    if (stale) {
      // Diagnostics are read before retiring: retirement overwrites `error`.
      const diagnostics = {
        runId: run.id,
        projectId: run.projectId,
        profile: run.profile,
        status: run.status,
        failureCount: run.failureCount,
        nextChunkIndex: run.nextChunkIndex,
        totalChunks: run.totalChunks,
        transcriptPath: run.transcriptPath,
        detail: String(run.error ?? '').slice(0, 300),
      };
      if (
        await retireReflectorRun(
          run.id,
          'source_changed: live transcript no longer matches the admitted range',
        )
      ) {
        logger.warn(
          diagnostics,
          'Retired reflector run: source transcript changed',
        );
        return 'retired_source_changed';
      }
      return 'skipped';
    }
    logger.warn(
      { runId: run.id, transcriptPath: run.transcriptPath },
      'Durable reflector admission no longer matches its transcript',
    );
    return 'skipped';
  }
  const enqueued = automaticTranscriptReflectionQueue.enqueue(
    {
      sourceKey: `${run.projectId}\0${transcriptPath}`,
      jobKey: run.id,
      process: async () => {
        return processAdmittedAutomaticTranscriptMemory(
          run.projectId,
          transcriptPath,
          run.id,
        );
      },
      onIncomplete: (error) =>
        logger.warn(
          {
            error,
            ...describeIncompleteReflection(error),
            runId: run.id,
            projectId: run.projectId,
          },
          'Recovered transcript reflector incomplete; retry scheduled',
        ),
    },
    // The lease that parked this source has expired: retry now, not after the
    // backoff that the lease failure started.
    { retryNow: options.afterLeaseExpiry },
  );
  return enqueued ? 'queued' : 'already_queued';
}

/** Requeue work which survived a board restart before debounce or completion. */
export async function recoverPendingTranscriptReflections(): Promise<number> {
  const runs = await recoverableReflectorRuns();
  const counts = {
    queued: 0,
    retiredSourceUnavailable: 0,
    retiredSourceChanged: 0,
    sourceUnavailablePending: 0,
  };
  for (const run of runs) {
    const outcome = await queueRecoverableReflectorRun(run.id);
    if (outcome === 'queued') counts.queued++;
    else if (outcome === 'retired_source_unavailable')
      counts.retiredSourceUnavailable++;
    else if (outcome === 'retired_source_changed')
      counts.retiredSourceChanged++;
    else if (outcome === 'source_unavailable')
      counts.sourceUnavailablePending++;
  }
  logger.info(counts, 'Reflector recovery summary');
  return counts.queued;
}

/**
 * Rows the sweep has selected, keyed by run id, with the time it last did so:
 * skipped (gated project, task-source, missing or changed transcript, ...) or
 * queued but still pending. Process-local on purpose: rows stay untouched in the database (their
 * `updatedAt` also drives retirement), and a restart only repeats one pass.
 */
const sweepSelectedAt = new Map<string, number>();

/**
 * Queue live `pending` rows this process is not going to run, e.g. rows
 * admitted by another process. Every gate of `queueRecoverableReflectorRun`
 * still applies; rows already queued or running here are not queued twice.
 * A row the sweep selects is not selected again until the idle window has
 * passed again, and then only behind rows it never selected, so unprocessable
 * or already queued rows neither get re-read every sweep nor fill the batch. Gated projects are
 * skipped before any transcript read.
 */
export async function sweepPendingTranscriptReflections(
  options: { now?: Date; minAgeMs?: number; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const minAgeMs = options.minAgeMs ?? PENDING_SWEEP_MIN_AGE_MS;
  const rows = await pendingLiveReflectorRunsForSweep({
    updatedBefore: new Date(now.getTime() - minAgeMs).toISOString(),
  });
  const present = new Set(rows.map((row) => row.id));
  for (const id of sweepSelectedAt.keys()) {
    if (!present.has(id)) sweepSelectedAt.delete(id);
  }
  const batch = rows
    .filter((row) => {
      const selectedAt = sweepSelectedAt.get(row.id);
      return selectedAt === undefined || now.getTime() - selectedAt >= minAgeMs;
    })
    // Stable: never-selected rows keep their database order, ahead of re-offered ones.
    .sort(
      (a, b) =>
        (sweepSelectedAt.get(a.id) ?? 0) - (sweepSelectedAt.get(b.id) ?? 0),
    )
    .slice(0, options.limit ?? PENDING_SWEEP_LIMIT);
  let queued = 0;
  for (const run of batch) {
    try {
      if (
        !isObservationGated(run.projectId) &&
        (await queueRecoverableReflectorRun(run.id)) === 'queued'
      ) {
        queued++;
      }
    } catch (error) {
      // One unreadable row must not abort the batch; it is deferred below.
      logger.warn(
        { error, runId: run.id, projectId: run.projectId },
        'Pending transcript reflector sweep skipped a row it could not read',
      );
    }
    // Skipped, failed and queued rows all count as seen: queued rows stay
    // pending while their job waits or runs, and none may fill every batch.
    sweepSelectedAt.set(run.id, now.getTime());
  }
  return queued;
}

/** Periodically sweep pending rows; returns a function that stops the timer. */
export function startPendingReflectorSweep(
  intervalMs = REFLECTOR_PENDING_SWEEP_INTERVAL_MS,
): () => void {
  if (intervalMs <= 0) return () => {};
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepPendingTranscriptReflections()
      .then((queued) => {
        if (queued > 0) {
          logger.info({ queued }, 'Queued pending transcript reflections');
        }
      })
      .catch((error) =>
        logger.warn({ error }, 'Pending transcript reflector sweep failed'),
      )
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Process a transcript's memory. Counted as an in-flight background job so a
 * pending restart waits for it.
 */
export function processTranscriptMemory(
  groupFolder: string,
  transcriptPath: string,
  options: ProcessTranscriptMemoryOptions = {},
) {
  return trackBackgroundWork('reflector', () =>
    runTranscriptMemory(groupFolder, transcriptPath, options),
  );
}

/**
 * Automatic (queued) variant of `processTranscriptMemory`. A transcript deleted
 * after the job was queued can never be read again, so the job is dropped
 * (null, i.e. complete) instead of being retried forever by the queue. ENOENT
 * for any other file while the transcript exists still rethrows. The durable
 * run row is left to the startup path, which retires it as source_unavailable.
 */
export async function processAutomaticTranscriptMemory(
  groupFolder: string,
  transcriptPath: string,
  options: ProcessTranscriptMemoryOptions = {},
) {
  try {
    return await processTranscriptMemory(groupFolder, transcriptPath, options);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' &&
      !fs.existsSync(transcriptPath)
    ) {
      logger.warn(
        {
          groupFolder,
          transcriptPath: path.basename(transcriptPath),
          admittedRunId: options.admittedRunId,
        },
        'Dropped automatic transcript reflection: transcript no longer exists',
      );
      return null;
    }
    throw error;
  }
}

/**
 * Run a queued automatic reflection for an admitted durable run. The run's end
 * is read when the job runs, not when it was queued: a later turn may have
 * widened the pending run under the same id, and the job's older end would no
 * longer match the run fingerprint. Returns null (complete) when the run is
 * already finished or retired, or the transcript no longer exists.
 */
export async function processAdmittedAutomaticTranscriptMemory(
  groupFolder: string,
  transcriptPath: string,
  runId: string,
) {
  const run = await getReflectorRun(runId);
  if (!run || !['pending', 'processing', 'error'].includes(run.status)) {
    return null;
  }
  let transcriptSource: ReflectorChunkSource | null;
  try {
    transcriptSource = await readGroupTranscript(groupFolder, transcriptPath);
  } catch (error) {
    // readGroupTranscript only rejects ENOENT for the transcript itself.
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      logger.warn(
        { groupFolder, transcriptPath: path.basename(transcriptPath), runId },
        'Dropped automatic transcript reflection: transcript no longer exists',
      );
      return null;
    }
    throw error;
  }
  if (!transcriptSource) return null;
  const end = liveFingerprintEnd(
    transcriptSource.bytes,
    run.transcriptFingerprint,
  );
  if (end === null) {
    if (
      await retireReflectorRun(
        run.id,
        'source_changed: live transcript no longer matches the admitted range',
      )
    ) {
      logger.warn(
        { runId: run.id, projectId: run.projectId, status: run.status },
        'Retired reflector run: source transcript changed',
      );
    }
    return null;
  }
  return processAutomaticTranscriptMemory(
    groupFolder,
    transcriptPath,
    optionsForDurableReflectorRun(run, end),
  );
}

async function runTranscriptMemory(
  groupFolder: string,
  transcriptPath: string,
  options: ProcessTranscriptMemoryOptions,
) {
  if (isTaskReflectionSource(transcriptPath, options.profile)) return null;
  const liveConversationNaming =
    (options.mode ?? 'live') === 'live' &&
    !options.explicitReview &&
    options.conversationId &&
    path.resolve(transcriptPath) ===
      path.resolve(
        chatTranscriptPath(groupFolder, undefined, options.conversationId),
      )
      ? (() => {
          let attempted = false;
          return async () => {
            if (attempted) return;
            attempted = true;
            try {
              await nameConversationIfUntitled(
                groupFolder,
                options.conversationId!,
              );
            } catch (error) {
              logger.warn(
                {
                  error,
                  group_folder: groupFolder,
                  conversation_id: options.conversationId,
                },
                'Automatic conversation title generation failed',
              );
            }
          };
        })()
      : undefined;
  const processingOptions = liveConversationNaming
    ? { ...options, onLiveProcessingStarted: liveConversationNaming }
    : options;

  const gateReason = observationGateReason(groupFolder);
  if (gateReason) {
    if ((options.mode ?? 'live') === 'live' && !options.explicitReview)
      logChatReflectionSkip(groupFolder, gateReason, options.conversationId);
    return null;
  }
  let primaryOptions = processingOptions;
  if (
    !processingOptions.admittedRunId &&
    (processingOptions.mode ?? 'live') === 'live'
  ) {
    const range = await admissibleAutomaticRange(
      groupFolder,
      transcriptPath,
      processingOptions,
    );
    if (range) {
      const admitted = await admitTranscriptMemory(
        groupFolder,
        transcriptPath,
        {
          ...processingOptions,
          ...range,
        },
      );
      if (admitted) {
        primaryOptions = {
          ...processingOptions,
          byteOffset: admitted.byteOffset,
          byteEndOffset: admitted.byteEndOffset,
          admittedRunId: admitted.runId,
        };
      }
    }
  }

  return runToolDrivenReflector(groupFolder, transcriptPath, primaryOptions);
}
