import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { sha256Hex } from '../../lib/hash.js';
import { PROMPTS_DIR } from '../../config.js';
import {
  getConversationsForHistoryReflection,
  getImportProjects,
  getLastPrivacyErasureAt,
  getMemory,
  getMemoryTimeline,
  getObjective,
  insertMemory,
  insertSupersedingMemory,
  invalidateMemory,
  setMemorySuccessor,
} from '../../db.js';
import { getGroupDir, readChatTranscriptAsync } from '../../group-dir.js';
import {
  GroupFsError,
  openDirAt,
  openGroupDir,
  readFileAt,
  readGroupFileSync,
  readdirAt,
  removeAt,
  writeFileAt,
  writeGroupFileSync,
  type PinnedDir,
} from '../../lib/group-fs.js';
import { llmComplete } from '../../lib/llm-client.js';
import { isPathInside } from '../../lib/path-containment.js';
import type { RuntimeSelection } from '../../lib/chat-agents.js';
import { logger } from '../../logger.js';
import type { Conversation } from '../chat/db-chats.js';
import { getVectorStoreHooks } from '../vector-store/hooks.js';
import { getMemoryConfig } from './config.js';
import {
  MAX_MEMORY_STATE_BYTES,
  MAX_MEMORY_TEXT_BYTES,
} from './file-limits.js';
import { syncGraphInvalidation } from './graph-invalidation.js';
import {
  HISTORY_CANDIDATE_PROMPT_VERSION,
  HISTORY_MANIFEST_VERSION,
  HISTORY_MIN_IMPORTANCE,
  HISTORY_REFLECTION_BATCH_SIZE,
  HISTORY_REFLECTOR_PROMPT_VERSION,
  applyHistoryEnvelopeToShadow,
  buildHistoryCandidateUserMessage,
  buildHistoryMemoryFileCandidateUserMessage,
  buildHistoryReflectorUserMessage,
  chunkHistoryMessages,
  dateInRange,
  earlierIso,
  hashHistoryMemoryFile,
  hashHistoryTranscript,
  historyMemoryFileSourceId,
  memoryBaselineFingerprint,
  normalizeHistoryMemoryFile,
  normalizeHistoryMessages,
  orderHistoryMemoryOperations,
  parseHistoryCandidates,
  parseHistoryReflectionEnvelope,
  plannedHistoryMemoryId,
  selectRelevantMemoryTimeline,
  sourceRefForCandidates,
  type HistoryCandidate,
  type HistoryConversationManifest,
  type HistoryMemoryOp,
  type HistoryMemoryFileManifest,
  type HistoryMessage,
  type HistoryReflectionEnvelope,
  type HistoryReflectionManifest,
  type HistoryRuleSummary,
} from './history-reflector-core.js';
import { projectHistorySourceFingerprint } from './project-history-reflection-batch.js';
import {
  assertFolderIdentity,
  getFolderGeneration,
} from '../../lib/folder-identity.js';
import { withMemoryLifecycleLock } from './lifecycle-lock.js';
import { eraseMemoryDurably } from './privacy-erasure.js';
import { getPrivacyErasureEpoch } from './privacy-epoch.js';
import type { Memory } from './types.js';
import {
  runToolDrivenReflector,
  toolPreviewStatePath,
  type ReflectorPreviewProgress,
} from './tool-reflector.js';
import {
  createPreviewMemoryState,
  type MemoryEvidenceReference,
  type PreviewMemoryOperation,
  type TranscriptEvidenceMessage,
} from './execution-context.js';
import {
  checkpointHistoryApplyReceipt,
  getHistoryApplyReceipts,
  operationFingerprint,
  prepareHistoryApplyReceipts,
  type HistoryApplyReceipt,
} from './history-apply-state.js';
import { recordTranscriptEvidence } from './reflector-state.js';
import { isRecord } from '../../lib/type-guards.js';

const HISTORY_CANDIDATE_PROMPT_FILE = 'history-candidate.md';
const HISTORY_REFLECTOR_PROMPT_FILE = 'history-reflector.md';

export interface HistoryPreviewOptions {
  projectId: string;
  since?: string;
  until?: string;
  cutoffAt?: string;
  priorManifest?: HistoryReflectionManifest;
  observerAgentId?: string;
  reflectorAgentId?: string;
  reflectorRuntime?: RuntimeSelection;
  /** Stable caller-owned preview identity for resumable generations. */
  previewId?: string;
  /** Source inventory persisted with a resumable History Review batch. */
  expectedSourceFingerprint?: string;
  maxTokensPerChunk?: number;
  batchSize?: number;
  includeConversations?: boolean;
  includeMemoryFiles?: boolean;
  memoryFilePaths?: string[];
  requireNativeManifest?: boolean;
  onProgress?: (progress: HistoryPreviewProgress) => void | Promise<void>;
  onCheckpoint?: (manifest: HistoryReflectionManifest) => void | Promise<void>;
}

interface HistoryPreviewProgress {
  phase:
    | 'extract-memory-files'
    | 'extract-conversations'
    | 'reflect-memory-files'
    | 'reflect-conversations';
  completed: number;
  total: number;
  item_id?: string;
  reused?: boolean;
  chunk?: number;
  chunks?: number;
  candidates?: number;
  state?: 'started' | 'progress' | 'completed';
  checkpoint_miss_reason?: string;
  failedChunks?: number;
}

export interface HistoryMemoryFileSource {
  sourceId: string;
  relativePath: string;
  modifiedAt: string;
  timestampSource: 'native_import_manifest' | 'filesystem_mtime';
  content: string;
  byteCount: number;
  nativeOrigin?: HistoryMemoryFileManifest['native_origin'];
}

export interface HistoryWorkflowDeps {
  listConversations(projectId: string): Promise<Conversation[]>;
  readConversation(conversation: Conversation): Promise<unknown[]>;
  listMemoryFiles(projectId: string): Promise<HistoryMemoryFileSource[]>;
  getTimeline(projectId: string): Promise<Memory[]>;
  getRules(projectId: string): Promise<HistoryRuleSummary[]>;
  extractCandidates(systemPrompt: string, userMessage: string): Promise<string>;
  reflect(systemPrompt: string, userMessage: string): Promise<string>;
  previewConversations(
    projectId: string,
    messages: ToolHistoryMessage[],
    timeline: Memory[],
    options: HistoryPreviewOptions,
    onPartial?: (result: ToolHistoryPreviewResult) => void | Promise<void>,
  ): Promise<{
    candidates: HistoryCandidate[];
    operations: HistoryMemoryOp[];
    error?: string;
  }>;
}

export interface HistoryApplyResult {
  alreadyApplied: boolean;
  baselineRebased?: boolean;
  applied: {
    created: number;
    superseded: number;
    invalidated: number;
    forgotten: number;
  };
}

function loadPrompt(file: string): string {
  const promptPath = path.join(PROMPTS_DIR, file);
  return fs.readFileSync(promptPath, 'utf8');
}

async function defaultReadConversation(
  conversation: Conversation,
): Promise<unknown[]> {
  return readChatTranscriptAsync(
    conversation.group_folder,
    conversation.id,
    conversation.created_at,
  );
}

/** Open a group sub-directory; a refused (linked or non-directory) path is logged and reads as absent. */
async function openGroupDirOrSkip(
  projectId: string,
  sub: string,
): Promise<PinnedDir | null> {
  try {
    return await openGroupDir(projectId, sub);
  } catch (error) {
    if (!(error instanceof GroupFsError)) throw error;
    logger.warn(
      { err: error, projectId, sub },
      'Skipping group directory that is not readable inside the group',
    );
    return null;
  }
}

async function readProjectRules(
  projectId: string,
): Promise<HistoryRuleSummary[]> {
  const rules: HistoryRuleSummary[] = [];
  let rulesDir: PinnedDir | null;
  try {
    rulesDir = await openGroupDirOrSkip(projectId, '.agent/rules');
  } catch {
    return [];
  }
  if (!rulesDir) return [];
  try {
    let files: string[];
    try {
      files = ((await readdirAt(rulesDir)) ?? [])
        .filter((file) => file.endsWith('.md'))
        .sort();
    } catch {
      return [];
    }

    let remaining = 40_000;
    for (const filename of files) {
      if (remaining <= 0) break;
      try {
        const read = await readFileAt(rulesDir, filename, {
          maxBytes: MAX_MEMORY_TEXT_BYTES,
        });
        if (!read) continue;
        const bounded = read.data
          .toString('utf8')
          .slice(0, Math.min(4000, remaining));
        rules.push({ filename, body: bounded });
        remaining -= bounded.length;
      } catch {
        // A rule may disappear or be refused during a long preview; it is
        // coverage context only.
      }
    }
    return rules;
  } finally {
    await rulesDir.close();
  }
}

export async function listProjectMemoryFiles(
  projectId: string,
): Promise<HistoryMemoryFileSource[]> {
  const memoriesRoot = await openGroupDirOrSkip(projectId, '.agent/memories');
  if (!memoriesRoot) return [];
  try {
    return await collectProjectMemoryFiles(projectId, memoriesRoot);
  } finally {
    await memoriesRoot.close();
  }
}

async function collectProjectMemoryFiles(
  projectId: string,
  memoriesRoot: PinnedDir,
): Promise<HistoryMemoryFileSource[]> {
  const groupDir = getGroupDir(projectId);
  // Naming root only: every read goes through the pinned directory.
  const memoriesDir = path.join(groupDir, '.agent', 'memories');
  const files: string[] = [];
  const importManifests: string[] = [];
  /** Path below the memories root, for reading through the pinned directory. */
  const below = (absolute: string) =>
    path.relative(memoriesDir, absolute).split(path.sep).join('/');

  async function walk(dir: PinnedDir, directory: string): Promise<void> {
    const entries =
      (await readdirAt(dir, undefined, { withFileTypes: true })) ?? [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === '.native-memory-import.json') {
        importManifests.push(entryPath);
        continue;
      }
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        let sub: PinnedDir | null;
        try {
          sub = await openDirAt(dir, entry.name);
        } catch (error) {
          if (!(error instanceof GroupFsError)) throw error;
          logger.warn(
            { err: error, projectId },
            'Skipping refused memory directory',
          );
          continue;
        }
        if (!sub) continue;
        try {
          await walk(sub, entryPath);
        } finally {
          await sub.close();
        }
      } else if (
        entry.isFile() &&
        ['.md', '.markdown', '.txt'].includes(
          path.extname(entry.name).toLowerCase(),
        )
      ) {
        files.push(entryPath);
      }
    }
  }

  await walk(memoriesRoot, memoriesDir);
  const nativeOrigins = new Map<
    string,
    NonNullable<HistoryMemoryFileSource['nativeOrigin']>
  >();
  for (const manifestPath of importManifests.sort()) {
    let parsed: unknown;
    try {
      const read = await readFileAt(memoriesRoot, below(manifestPath), {
        maxBytes: MAX_MEMORY_STATE_BYTES,
      });
      if (!read) continue;
      parsed = JSON.parse(read.data.toString('utf8'));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    for (const [entryName, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const record = value;
      const relativePath =
        typeof record.relativePath === 'string'
          ? record.relativePath
          : entryName;
      const sourceMtimeValue =
        typeof record.sourceMtime === 'string' ? record.sourceMtime : '';
      const sourceMtimeTimestamp = Date.parse(sourceMtimeValue);
      const sourceMtime = Number.isFinite(sourceMtimeTimestamp)
        ? new Date(sourceMtimeTimestamp).toISOString()
        : null;
      const sha256 =
        typeof record.sha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(record.sha256)
          ? record.sha256.toLowerCase()
          : null;
      if (!sourceMtime || !sha256) continue;
      const target = path.resolve(path.dirname(manifestPath), relativePath);
      if (!isPathInside(path.dirname(manifestPath), target)) continue;
      nativeOrigins.set(target, {
        provider:
          typeof record.provider === 'string' ? record.provider : 'unknown',
        source_label:
          typeof record.sourceLabel === 'string'
            ? record.sourceLabel
            : 'unknown',
        native_project:
          typeof record.nativeProject === 'string'
            ? record.nativeProject
            : 'unknown',
        source_path:
          typeof record.sourcePath === 'string' ? record.sourcePath : '',
        relative_path: relativePath.split(path.sep).join('/'),
        source_birthtime:
          typeof record.sourceBirthtime === 'string'
            ? record.sourceBirthtime
            : sourceMtime,
        source_mtime: sourceMtime,
        sha256,
      });
    }
  }

  const result: HistoryMemoryFileSource[] = [];
  for (const file of files.sort()) {
    let read: Awaited<ReturnType<typeof readFileAt>>;
    try {
      read = await readFileAt(memoriesRoot, below(file), {
        maxBytes: MAX_MEMORY_TEXT_BYTES,
      });
    } catch (error) {
      if (!(error instanceof GroupFsError)) throw error;
      logger.warn({ err: error, projectId }, 'Skipping refused memory file');
      continue;
    }
    if (!read) continue;
    const stats = read.stat;
    const content = read.data.toString('utf8');
    const rawHash = sha256Hex(content);
    const declaredOrigin = nativeOrigins.get(path.resolve(file));
    const nativeOrigin =
      declaredOrigin?.sha256 === rawHash ? declaredOrigin : undefined;
    const relativePath = path
      .relative(groupDir, file)
      .split(path.sep)
      .join('/');
    result.push({
      sourceId: historyMemoryFileSourceId(relativePath),
      relativePath,
      modifiedAt: nativeOrigin?.source_mtime ?? stats.mtime.toISOString(),
      timestampSource: nativeOrigin
        ? 'native_import_manifest'
        : 'filesystem_mtime',
      content,
      byteCount: stats.size,
      ...(nativeOrigin ? { nativeOrigin } : {}),
    });
  }
  return result.sort(
    (a, b) =>
      a.modifiedAt.localeCompare(b.modifiedAt) ||
      a.relativePath.localeCompare(b.relativePath),
  );
}

export function defaultDeps(
  options: HistoryPreviewOptions,
): HistoryWorkflowDeps {
  const config = getMemoryConfig();
  const candidatePrompt = loadPrompt(HISTORY_CANDIDATE_PROMPT_FILE);
  const reflectorPrompt = loadPrompt(HISTORY_REFLECTOR_PROMPT_FILE);
  return {
    listConversations: getConversationsForHistoryReflection,
    readConversation: defaultReadConversation,
    listMemoryFiles: listProjectMemoryFiles,
    getTimeline: getMemoryTimeline,
    getRules: readProjectRules,
    extractCandidates: async (_systemPrompt, userMessage) => {
      const response = await llmComplete(
        config.observer.llm,
        candidatePrompt,
        userMessage,
        {
          watchAgentsFile: false,
          ...(options.observerAgentId
            ? { agentIdOverride: options.observerAgentId }
            : {}),
          temperatureOverride: 0.1,
          timeoutMs: 600_000,
          projectId: options.projectId,
          privacyPurpose: 'memory',
        },
      );
      return response.content;
    },
    reflect: async (_systemPrompt, userMessage) => {
      const response = await llmComplete(
        config.reflector.llm,
        reflectorPrompt,
        userMessage,
        {
          watchAgentsFile: false,
          ...(options.reflectorAgentId
            ? { agentIdOverride: options.reflectorAgentId }
            : {}),
          temperatureOverride: 0.1,
          timeoutMs: 600_000,
          projectId: options.projectId,
          privacyPurpose: 'memory',
        },
      );
      return response.content;
    },
    previewConversations: runToolHistoryPreview,
  };
}

async function extractConversation(
  projectId: string,
  conversation: Conversation,
  entries: unknown[],
  cutoffAt: string,
  maxTokensPerChunk: number,
  candidatePrompt: string,
  deps: HistoryWorkflowDeps,
  onChunk?: (chunk: number, chunks: number) => void | Promise<void>,
  selectedMessages?: HistoryMessage[],
): Promise<HistoryConversationManifest> {
  const messages =
    selectedMessages ?? normalizeHistoryMessages(conversation, entries);
  const transcriptHash = hashHistoryTranscript(messages);
  const candidates: HistoryCandidate[] = [];
  const errors: string[] = [];
  const chunks = chunkHistoryMessages(messages, maxTokensPerChunk);

  for (const [chunkIndex, chunk] of chunks.entries()) {
    await onChunk?.(chunkIndex + 1, chunks.length);
    const userMessage = buildHistoryCandidateUserMessage(
      projectId,
      conversation,
      chunk,
      cutoffAt,
    );
    try {
      const raw = await deps.extractCandidates(candidatePrompt, userMessage);
      const parsed = parseHistoryCandidates(
        raw,
        conversation.id,
        chunk,
        cutoffAt,
        chunkIndex * 10_000,
      );
      candidates.push(...parsed.candidates);
      errors.push(
        ...parsed.errors.map((error) => `chunk ${chunkIndex + 1}: ${error}`),
      );
    } catch (error) {
      errors.push(
        `chunk ${chunkIndex + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    conversation_id: conversation.id,
    objective_id: conversation.objective_id ?? null,
    title: conversation.title ?? null,
    created_at: conversation.created_at,
    transcript_hash: transcriptHash,
    message_count: messages.length,
    candidates,
    errors,
  };
}

async function extractMemoryFile(
  projectId: string,
  file: HistoryMemoryFileSource,
  cutoffAt: string,
  maxTokensPerChunk: number,
  candidatePrompt: string,
  deps: HistoryWorkflowDeps,
  onChunk?: (chunk: number, chunks: number) => void | Promise<void>,
): Promise<HistoryMemoryFileManifest> {
  const messages = normalizeHistoryMemoryFile(
    file.relativePath,
    file.content,
    file.modifiedAt,
  );
  const candidates: HistoryCandidate[] = [];
  const errors: string[] = [];
  const chunks = chunkHistoryMessages(messages, maxTokensPerChunk);

  for (const [chunkIndex, chunk] of chunks.entries()) {
    await onChunk?.(chunkIndex + 1, chunks.length);
    const userMessage = buildHistoryMemoryFileCandidateUserMessage(
      projectId,
      file.relativePath,
      file.modifiedAt,
      chunk,
      cutoffAt,
    );
    try {
      const raw = await deps.extractCandidates(candidatePrompt, userMessage);
      const parsed = parseHistoryCandidates(
        raw,
        file.sourceId,
        chunk,
        cutoffAt,
        chunkIndex * 10_000,
        file.modifiedAt,
      );
      candidates.push(...parsed.candidates);
      errors.push(
        ...parsed.errors.map((error) => `chunk ${chunkIndex + 1}: ${error}`),
      );
    } catch (error) {
      errors.push(
        `chunk ${chunkIndex + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    source_id: file.sourceId,
    relative_path: file.relativePath,
    modified_at: file.modifiedAt,
    timestamp_source: file.timestampSource,
    file_hash: hashHistoryMemoryFile(
      file.relativePath,
      file.content,
      file.modifiedAt,
    ),
    byte_count: file.byteCount,
    ...(file.nativeOrigin ? { native_origin: file.nativeOrigin } : {}),
    candidates,
    errors,
  };
}

function sortCandidates(candidates: HistoryCandidate[]): HistoryCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      a.effective_at.localeCompare(b.effective_at) ||
      a.evidence[0]!.created_at.localeCompare(b.evidence[0]!.created_at) ||
      a.id.localeCompare(b.id),
  );
}

function priorConversation(
  manifest: HistoryReflectionManifest | undefined,
  conversationId: string,
  transcriptHash: string,
  cutoffAt: string,
): HistoryConversationManifest | undefined {
  if (
    !manifest ||
    manifest.manifest_version !== HISTORY_MANIFEST_VERSION ||
    manifest.candidate_prompt_version !== HISTORY_CANDIDATE_PROMPT_VERSION ||
    manifest.cutoff_at !== cutoffAt
  ) {
    return undefined;
  }
  return manifest.conversations.find(
    (conversation) =>
      conversation.conversation_id === conversationId &&
      conversation.transcript_hash === transcriptHash &&
      conversation.errors.length === 0,
  );
}

function priorMemoryFile(
  manifest: HistoryReflectionManifest | undefined,
  file: HistoryMemoryFileSource,
  fileHash: string,
  cutoffAt: string,
): HistoryMemoryFileManifest | undefined {
  if (
    !manifest ||
    manifest.manifest_version !== HISTORY_MANIFEST_VERSION ||
    manifest.candidate_prompt_version !== HISTORY_CANDIDATE_PROMPT_VERSION ||
    manifest.cutoff_at !== cutoffAt
  ) {
    return undefined;
  }
  return manifest.memory_files.find(
    (record) =>
      record.source_id === file.sourceId &&
      record.relative_path === file.relativePath &&
      record.modified_at === file.modifiedAt &&
      record.timestamp_source === file.timestampSource &&
      JSON.stringify(record.native_origin ?? null) ===
        JSON.stringify(file.nativeOrigin ?? null) &&
      record.file_hash === fileHash &&
      record.errors.length === 0,
  );
}

interface ToolHistoryMessage {
  toolId: string;
  conversationId: string;
  objectiveId: string | null;
  message: HistoryMessage;
}

function toolHistoryCandidate(
  projectId: string,
  operation: PreviewMemoryOperation,
  messages: Map<string, ToolHistoryMessage>,
  timeline: Memory[],
  stagedMemoryIds: Map<string, string>,
): { candidate: HistoryCandidate; operation: HistoryMemoryOp } {
  const memoryId = operation.memoryId
    ? (stagedMemoryIds.get(operation.memoryId) ?? operation.memoryId)
    : undefined;
  const target = memoryId
    ? timeline.find((memory) => memory.id === memoryId)
    : undefined;
  const evidence = operation.evidence.map((reference) => {
    const source = messages.get(reference.message_id);
    if (!source) {
      throw new Error(
        `Tool preview returned unknown evidence message ${reference.message_id}`,
      );
    }
    return {
      source_kind: 'conversation' as const,
      conversation_id: source.conversationId,
      message_id: source.message.id,
      role: source.message.role as 'user' | 'assistant',
      created_at: source.message.created_at,
      date_basis: 'message_timestamp' as const,
      excerpt: reference.excerpt,
    };
  });
  const evidenceTimestamp = [...evidence].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  )[0]!.created_at;
  const effectiveAt =
    operation.validFrom ?? operation.effectiveAt ?? evidenceTimestamp;
  const candidateId = `hist-tool-${sha256Hex(
    JSON.stringify([
      projectId,
      operation.operationKey,
      operation.operation,
      memoryId ?? null,
      operation.content ?? operation.targetContent ?? null,
      effectiveAt,
    ]),
  ).slice(0, 24)}`;
  const candidate: HistoryCandidate = {
    id: candidateId,
    planned_memory_id: plannedHistoryMemoryId(candidateId),
    memory_type: operation.memoryType ?? target?.memory_type ?? 'project',
    claim:
      operation.content ?? operation.targetContent ?? target?.content ?? '',
    change_kind:
      operation.operation === 'supersede'
        ? 'replace'
        : operation.operation === 'invalidate'
          ? 'cease'
          : operation.operation === 'forget'
            ? 'forget'
            : 'assert',
    effective_at: effectiveAt,
    confidence: 1,
    importance: operation.importance ?? target?.importance ?? 0.7,
    tags: operation.tags ?? target?.tags ?? [],
    evidence,
  };
  if (operation.resultMemoryId) {
    stagedMemoryIds.set(operation.resultMemoryId, candidate.planned_memory_id);
  }
  const candidate_ids = [candidateId];
  if (operation.operation === 'create') {
    return {
      candidate,
      operation: {
        op: 'create',
        candidate_ids,
        new_memory_id: candidate.planned_memory_id,
        objective_id: operation.objectiveId ?? null,
        memory_type: candidate.memory_type,
        content: operation.content!,
        valid_from: operation.validFrom ?? effectiveAt,
        importance: candidate.importance,
        tags: candidate.tags,
      },
    };
  }
  if (operation.operation === 'supersede') {
    return {
      candidate,
      operation: {
        op: 'supersede',
        candidate_ids,
        new_memory_id: candidate.planned_memory_id,
        supersedes_id: memoryId!,
        objective_id: operation.objectiveId ?? target?.objective_id ?? null,
        memory_type: candidate.memory_type,
        correction_content: operation.content!,
        valid_from: operation.validFrom ?? effectiveAt,
        importance: candidate.importance,
        tags: candidate.tags,
        ...(operation.successorId
          ? {
              precedes_id:
                stagedMemoryIds.get(operation.successorId) ??
                operation.successorId,
            }
          : {}),
      },
    };
  }
  if (operation.operation === 'invalidate') {
    return {
      candidate,
      operation: {
        op: 'invalidate',
        candidate_ids,
        memory_id: memoryId!,
        effective_at: operation.effectiveAt ?? effectiveAt,
        reason:
          operation.reason ?? 'Conversation evidence says this fact ceased',
      },
    };
  }
  return {
    candidate,
    operation: {
      op: 'forget',
      candidate_ids,
      memory_id: memoryId!,
      target: operation.targetContent ?? target?.content ?? '',
    },
  };
}

interface ToolHistoryPreviewResult {
  candidates: HistoryCandidate[];
  operations: HistoryMemoryOp[];
  error?: string;
}

async function runToolHistoryPreview(
  projectId: string,
  messages: ToolHistoryMessage[],
  timeline: Memory[],
  options: HistoryPreviewOptions,
  onPartial?: (result: ToolHistoryPreviewResult) => void | Promise<void>,
): Promise<ToolHistoryPreviewResult> {
  if (messages.length === 0) {
    if (options.previewId) {
      throw new Error(
        'History proposal recovery input is missing; the selected conversation history is no longer available',
      );
    }
    return { candidates: [], operations: [] };
  }
  // Pinned once: the transcript write, the state-file removal and the final
  // cleanup all name their targets through this descriptor.
  const artifactsDir = await openGroupDir(
    projectId,
    'artifacts/history-reflection',
    { create: true },
  );
  if (!artifactsDir) {
    throw new Error(`Group folder is not available: ${projectId}`);
  }
  const previewId = options.previewId ?? randomUUID();
  const transcriptName = `.tool-preview-${previewId}.jsonl`;
  const transcriptPath = path.join(
    getGroupDir(projectId),
    'artifacts',
    'history-reflection',
    transcriptName,
  );
  const preview = createPreviewMemoryState();
  for (const memory of timeline) preview.memories.set(memory.id, { ...memory });
  try {
    // Atomic: a leaf planted at the preview path is replaced, never written through.
    await writeFileAt(
      artifactsDir,
      transcriptName,
      `${messages
        .map(({ toolId, objectiveId, message }) =>
          JSON.stringify({
            type: 'message',
            id: toolId,
            role: message.role,
            content: message.content,
            created_at: message.created_at,
            objective_id: objectiveId,
          }),
        )
        .join('\n')}\n`,
    );
  } catch (error) {
    await artifactsDir.close();
    throw error;
  }
  const byId = new Map(messages.map((message) => [message.toolId, message]));
  function convert(
    operations: PreviewMemoryOperation[],
    error?: string,
  ): ToolHistoryPreviewResult {
    const stagedMemoryIds = new Map<string, string>();
    const converted = operations.map((operation) =>
      toolHistoryCandidate(
        projectId,
        operation,
        byId,
        timeline,
        stagedMemoryIds,
      ),
    );
    return {
      candidates: converted.map((item) => item.candidate),
      operations: converted.map((item) => item.operation),
      ...(error ? { error } : {}),
    };
  }
  async function publish(progress: ReflectorPreviewProgress) {
    if (progress.activeChunk === null) {
      await onPartial?.(
        convert(progress.operations, progress.errors.join('\n')),
      );
    }
    await options.onProgress?.({
      phase: 'reflect-conversations',
      completed: progress.completedChunks,
      total: progress.totalChunks,
      failedChunks: progress.failedChunks,
      chunk: progress.activeChunk ?? undefined,
      candidates: progress.operations.length,
      state: progress.activeChunk === null ? 'progress' : 'started',
    });
  }
  try {
    const result = await runToolDrivenReflector(projectId, transcriptPath, {
      onPreviewProgress: publish,
      mode: 'preview',
      explicitReview: true,
      previewId,
      previewState: preview,
      minimumTranscriptLength: 0,
      minimumImportance: HISTORY_MIN_IMPORTANCE,
      maxTokensPerChunk: options.maxTokensPerChunk,
      profile: 'direct-llm-conversation',
      agentIdOverride: options.reflectorAgentId,
      runtimeSelectionOverride: options.reflectorRuntime,
    });
    if (!result) return { candidates: [], operations: [] };
    return convert(
      result.previewOperations ?? [],
      !result.completed
        ? `Tool-driven history preview did not complete${result.error ? `: ${result.error}` : ''}`
        : undefined,
    );
  } finally {
    try {
      await removeAt(artifactsDir, transcriptName);
      // Ephemeral previews are not resumable; their per-chunk state file is
      // released here. Resumable launches release theirs from the batch
      // lifecycle after the terminal batch write.
      if (!options.previewId) {
        await removeAt(
          artifactsDir,
          path.basename(toolPreviewStatePath(transcriptPath, previewId)),
        );
      }
    } finally {
      await artifactsDir.close();
    }
  }
}

export async function runHistoryReflectionPreview(
  options: HistoryPreviewOptions,
  overrides?: Partial<HistoryWorkflowDeps>,
): Promise<HistoryReflectionManifest> {
  const cutoffAt = new Date(
    options.cutoffAt ?? options.priorManifest?.cutoff_at ?? Date.now(),
  ).toISOString();
  const deps = { ...defaultDeps(options), ...overrides };
  const candidatePrompt = loadPrompt(HISTORY_CANDIDATE_PROMPT_FILE);
  const reflectorPrompt = loadPrompt(HISTORY_REFLECTOR_PROMPT_FILE);
  const maxTokensPerChunk = options.maxTokensPerChunk ?? 5000;
  const batchSize = options.batchSize ?? HISTORY_REFLECTION_BATCH_SIZE;
  // Dependency overrides are the deterministic legacy harness used by the
  // existing comparison suite. The supported production path has no
  // overrides and evaluates conversations with the staged tool reflector.
  const useToolConversationPreview =
    overrides?.extractCandidates === undefined &&
    overrides?.reflect === undefined &&
    typeof deps.previewConversations === 'function';

  const includeConversations = options.includeConversations !== false;
  const includeMemoryFiles = options.includeMemoryFiles !== false;
  // The checkpoint and baseline are captured under the project lifecycle lock,
  // which privacy erasure also holds: an erasure either committed before the
  // baseline read (so it is excluded) or records a mark after the checkpoint.
  // created_at is stamped after the read, so it cannot bound this.
  const readBaselineUnderLock = () =>
    withMemoryLifecycleLock(options.projectId, async () => ({
      privacyCheckpointAt: earlierIso(
        options.priorManifest?.privacy_checkpoint_at,
        new Date().toISOString(),
      ),
      baselineTimeline: await deps.getTimeline(options.projectId),
    }));
  const [
    allConversations,
    allMemoryFiles,
    { privacyCheckpointAt, baselineTimeline },
    rules,
  ] = await Promise.all([
    includeConversations
      ? deps.listConversations(options.projectId)
      : Promise.resolve([]),
    includeMemoryFiles
      ? deps.listMemoryFiles(options.projectId)
      : Promise.resolve([]),
    readBaselineUnderLock(),
    deps.getRules(options.projectId),
  ]);
  const sourceUntil = earlierIso(options.until, cutoffAt);
  // Conversation creation time is not an evidence boundary: a long-lived
  // conversation may contain messages inside a much later selected range.
  // Select authoritative messages after reading each transcript instead, so
  // progress totals describe only conversations that will actually be read.
  let conversations = allConversations.sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  const selectedMessages = new Map<string, HistoryMessage[]>();
  if (options.since || options.until) {
    const conversationsWithEvidence: typeof conversations = [];
    for (const conversation of conversations) {
      const entries = await deps.readConversation(conversation);
      const messages = normalizeHistoryMessages(conversation, entries).filter(
        (message) =>
          dateInRange(message.created_at, options.since, sourceUntil),
      );
      if (messages.length > 0) {
        conversationsWithEvidence.push(conversation);
        selectedMessages.set(conversation.id, messages);
      }
    }
    conversations = conversationsWithEvidence;
  }
  if (options.expectedSourceFingerprint) {
    const actualSourceFingerprint =
      projectHistorySourceFingerprint(conversations);
    if (actualSourceFingerprint !== options.expectedSourceFingerprint) {
      throw new Error(
        'History proposal recovery input changed; the selected conversation history no longer matches the interrupted batch',
      );
    }
  }
  const conversationManifests: HistoryConversationManifest[] = [];
  const toolHistoryMessages: ToolHistoryMessage[] = [];
  const selectedMemoryPaths = options.memoryFilePaths
    ? new Set(options.memoryFilePaths)
    : null;
  const eligibleMemoryFiles = allMemoryFiles.filter(
    (file) =>
      (!selectedMemoryPaths || selectedMemoryPaths.has(file.relativePath)) &&
      (!options.requireNativeManifest || !!file.nativeOrigin),
  );
  const memoryFiles = eligibleMemoryFiles.filter((file) =>
    dateInRange(file.modifiedAt, options.since, sourceUntil),
  );
  const sourceSelectionErrors = options.memoryFilePaths
    ? options.memoryFilePaths
        .filter(
          (relativePath) =>
            !eligibleMemoryFiles.some(
              (file) => file.relativePath === relativePath,
            ),
        )
        .map(
          (relativePath) =>
            `memory-file:${relativePath}: selected file is missing or no longer verified by a native import manifest`,
        )
    : [];
  const memoryFileManifests: HistoryMemoryFileManifest[] = [];
  const memoryOps: HistoryMemoryOp[] = [];
  const skippedCandidates: HistoryReflectionEnvelope['skipped_candidates'] = [];
  const reflectionErrors: string[] = [];
  const baselineFingerprint = memoryBaselineFingerprint(baselineTimeline);
  const createdAt = new Date().toISOString();

  function snapshot(): HistoryReflectionManifest {
    return {
      manifest_version: HISTORY_MANIFEST_VERSION,
      candidate_prompt_version: HISTORY_CANDIDATE_PROMPT_VERSION,
      reflector_prompt_version: HISTORY_REFLECTOR_PROMPT_VERSION,
      project_id: options.projectId,
      created_at: createdAt,
      cutoff_at: cutoffAt,
      privacy_checkpoint_at: privacyCheckpointAt,
      filters: {
        since: options.since ?? null,
        until: options.until ?? null,
      },
      sources: {
        conversations: includeConversations,
        memory_files: includeMemoryFiles,
        memory_file_paths: options.memoryFilePaths
          ? [...options.memoryFilePaths].sort()
          : null,
        require_native_manifest: options.requireNativeManifest === true,
      },
      memory_baseline: baselineFingerprint,
      conversations: [...conversationManifests],
      memory_files: [...memoryFileManifests],
      envelope: {
        memory_ops: [...memoryOps],
        skipped_candidates: [...skippedCandidates],
      },
      errors: [
        ...conversationManifests.flatMap((conversation) =>
          conversation.errors.map(
            (error) => `${conversation.conversation_id}: ${error}`,
          ),
        ),
        ...sourceSelectionErrors,
        ...memoryFileManifests.flatMap((file) =>
          file.errors.map((error) => `${file.source_id}: ${error}`),
        ),
        ...reflectionErrors,
      ],
      status: 'preview',
    };
  }

  async function checkpoint(): Promise<void> {
    await options.onCheckpoint?.(snapshot());
  }

  async function checkpointExtraction(): Promise<void> {
    const prior = options.priorManifest;
    if (
      prior &&
      (prior.envelope.memory_ops.length > 0 ||
        prior.envelope.skipped_candidates.length > 0 ||
        memoryFileManifests.length < prior.memory_files.length ||
        conversationManifests.length < prior.conversations.length)
    ) {
      // Do not replace a more advanced resume point while revalidating and
      // replaying its cached source records.
      return;
    }
    await checkpoint();
  }

  // Recovered memories are extracted first as well as reflected first. This
  // makes the ordering visible and gives large projects useful early
  // checkpoints before their conversation archive is processed.
  for (const [fileIndex, file] of memoryFiles.entries()) {
    const fileHash = hashHistoryMemoryFile(
      file.relativePath,
      file.content,
      file.modifiedAt,
    );
    const prior = priorMemoryFile(
      options.priorManifest,
      file,
      fileHash,
      cutoffAt,
    );
    await options.onProgress?.({
      phase: 'extract-memory-files',
      completed: fileIndex,
      total: memoryFiles.length,
      item_id: file.relativePath,
      reused: !!prior,
      state: 'started',
    });
    if (prior) {
      memoryFileManifests.push(prior);
    } else {
      memoryFileManifests.push(
        await extractMemoryFile(
          options.projectId,
          file,
          cutoffAt,
          maxTokensPerChunk,
          candidatePrompt,
          deps,
          async (chunk, chunks) => {
            await options.onProgress?.({
              phase: 'extract-memory-files',
              completed: fileIndex,
              total: memoryFiles.length,
              item_id: file.relativePath,
              chunk,
              chunks,
              state: 'progress',
            });
          },
        ),
      );
    }
    await checkpointExtraction();
    await options.onProgress?.({
      phase: 'extract-memory-files',
      completed: fileIndex + 1,
      total: memoryFiles.length,
      item_id: file.relativePath,
      reused: !!prior,
      candidates: memoryFileManifests.at(-1)!.candidates.length,
      state: 'completed',
    });
  }

  for (const [conversationIndex, conversation] of conversations.entries()) {
    const entries =
      options.since || options.until
        ? []
        : await deps.readConversation(conversation);
    const messages =
      selectedMessages.get(conversation.id) ??
      normalizeHistoryMessages(conversation, entries).filter((message) =>
        dateInRange(message.created_at, options.since, sourceUntil),
      );
    const transcriptHash = hashHistoryTranscript(messages);
    const prior = priorConversation(
      options.priorManifest,
      conversation.id,
      transcriptHash,
      cutoffAt,
    );
    await options.onProgress?.({
      phase: 'extract-conversations',
      completed: conversationIndex,
      total: conversations.length,
      item_id: conversation.id,
      reused: !!prior,
      state: 'started',
    });
    if (useToolConversationPreview) {
      conversationManifests.push({
        conversation_id: conversation.id,
        objective_id: conversation.objective_id ?? null,
        title: conversation.title ?? null,
        created_at: conversation.created_at,
        transcript_hash: transcriptHash,
        message_count: messages.length,
        candidates: [],
        errors: [],
      });
      for (const message of messages) {
        toolHistoryMessages.push({
          toolId: `history:${conversation.id}:${message.id}`,
          conversationId: conversation.id,
          objectiveId: conversation.objective_id ?? null,
          message,
        });
      }
    } else if (prior) {
      conversationManifests.push(prior);
    } else {
      conversationManifests.push(
        await extractConversation(
          options.projectId,
          conversation,
          entries,
          cutoffAt,
          maxTokensPerChunk,
          candidatePrompt,
          deps,
          async (chunk, chunks) => {
            await options.onProgress?.({
              phase: 'extract-conversations',
              completed: conversationIndex,
              total: conversations.length,
              item_id: conversation.id,
              chunk,
              chunks,
              state: 'progress',
            });
          },
          messages,
        ),
      );
    }
    await checkpointExtraction();
    await options.onProgress?.({
      phase: 'extract-conversations',
      completed: conversationIndex + 1,
      total: conversations.length,
      item_id: conversation.id,
      reused: !!prior,
      candidates: conversationManifests.at(-1)!.candidates.length,
      state: 'completed',
    });
  }

  const memoryFileCandidates = sortCandidates(
    memoryFileManifests.flatMap((file) => file.candidates),
  );
  const conversationCandidates = sortCandidates(
    conversationManifests.flatMap((conversation) => conversation.candidates),
  );
  // Recovered memories are second-order summaries, so reconcile them first.
  // Direct conversation evidence then sees those proposed facts in the shadow
  // timeline and can deduplicate, correct, supersede, or invalidate them.
  const candidateStages = [
    {
      label: 'memory-files',
      phase: 'reflect-memory-files' as const,
      candidates: memoryFileCandidates,
    },
    {
      label: 'conversations',
      phase: 'reflect-conversations' as const,
      candidates: conversationCandidates,
    },
  ];
  const candidates = [...memoryFileCandidates, ...conversationCandidates];
  const candidateMap = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  let shadowTimeline = baselineTimeline;
  let checkpointMissReason: string | undefined;

  function priorEnvelopeForBatch(
    batch: HistoryCandidate[],
    relevantTimeline: Memory[],
  ): HistoryReflectionEnvelope | null {
    const prior = options.priorManifest;
    checkpointMissReason = undefined;
    if (!prior) return null;
    if (prior.manifest_version !== HISTORY_MANIFEST_VERSION) {
      checkpointMissReason = 'manifest version changed';
      return null;
    }
    if (prior.reflector_prompt_version !== HISTORY_REFLECTOR_PROMPT_VERSION) {
      checkpointMissReason = 'reflector prompt version changed';
      return null;
    }
    if (prior.cutoff_at !== cutoffAt) {
      checkpointMissReason = 'processing cutoff changed';
      return null;
    }
    if (prior.memory_baseline !== baselineFingerprint) {
      checkpointMissReason = 'memory baseline changed';
      return null;
    }
    const batchIds = new Set(batch.map((candidate) => candidate.id));
    const priorItems = [
      ...prior.envelope.memory_ops,
      ...prior.envelope.skipped_candidates,
    ];
    if (
      priorItems.some((item) => {
        const overlap = item.candidate_ids.some((id) => batchIds.has(id));
        return overlap && item.candidate_ids.some((id) => !batchIds.has(id));
      })
    ) {
      checkpointMissReason = 'a prior disposition crosses batch boundaries';
      return null;
    }
    const envelope = {
      memory_ops: prior.envelope.memory_ops.filter((op) =>
        op.candidate_ids.every((id) => batchIds.has(id)),
      ),
      skipped_candidates: prior.envelope.skipped_candidates.filter((skip) =>
        skip.candidate_ids.every((id) => batchIds.has(id)),
      ),
    };
    const covered = new Set(
      [...envelope.memory_ops, ...envelope.skipped_candidates].flatMap(
        (item) => item.candidate_ids,
      ),
    );
    if (
      covered.size !== batchIds.size ||
      [...batchIds].some((id) => !covered.has(id))
    ) {
      checkpointMissReason = `checkpoint covers ${covered.size}/${batchIds.size} candidates`;
      return null;
    }
    const parsed = parseHistoryReflectionEnvelope(
      JSON.stringify(envelope),
      batch,
      relevantTimeline,
      cutoffAt,
    );
    if (!parsed.envelope) {
      checkpointMissReason = `checkpoint no longer validates: ${parsed.errors.join('; ')}`;
      return null;
    }
    return parsed.envelope;
  }

  let reflectionFailed = false;
  for (const stage of candidateStages) {
    const totalBatches = Math.ceil(stage.candidates.length / batchSize);
    for (
      let offset = 0;
      offset < stage.candidates.length;
      offset += batchSize
    ) {
      const batch = stage.candidates.slice(offset, offset + batchSize);
      const batchIndex = offset / batchSize;
      const batchLabel = `reflect ${stage.label} batch ${batchIndex + 1}`;
      const relevantTimeline = selectRelevantMemoryTimeline(
        batch,
        shadowTimeline,
      );
      const priorEnvelope = priorEnvelopeForBatch(batch, relevantTimeline);
      await options.onProgress?.({
        phase: stage.phase,
        completed: batchIndex,
        total: totalBatches,
        reused: !!priorEnvelope,
        candidates: batch.length,
        state: 'started',
        ...(!priorEnvelope && checkpointMissReason
          ? { checkpoint_miss_reason: checkpointMissReason }
          : {}),
      });
      try {
        let envelope = priorEnvelope;
        if (!envelope) {
          const userMessage = buildHistoryReflectorUserMessage(
            options.projectId,
            cutoffAt,
            batch,
            relevantTimeline,
            rules,
          );
          const raw = await deps.reflect(reflectorPrompt, userMessage);
          const parsed = parseHistoryReflectionEnvelope(
            raw,
            batch,
            relevantTimeline,
            cutoffAt,
          );
          if (!parsed.envelope) {
            reflectionErrors.push(
              ...parsed.errors.map((error) => `${batchLabel}: ${error}`),
            );
            reflectionFailed = true;
            break;
          }
          envelope = parsed.envelope;
        }
        const shadow = applyHistoryEnvelopeToShadow(
          shadowTimeline,
          envelope,
          candidateMap,
        );
        if (shadow.errors.length > 0) {
          reflectionErrors.push(
            ...shadow.errors.map((error) => `${batchLabel}: ${error}`),
          );
          reflectionFailed = true;
          break;
        }
        shadowTimeline = shadow.timeline;
        memoryOps.push(...envelope.memory_ops);
        skippedCandidates.push(...envelope.skipped_candidates);
        await checkpoint();
        await options.onProgress?.({
          phase: stage.phase,
          completed: batchIndex + 1,
          total: totalBatches,
          reused: !!priorEnvelope,
          candidates: batch.length,
          state: 'completed',
        });
      } catch (error) {
        reflectionErrors.push(
          `${batchLabel}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        reflectionFailed = true;
        break;
      }
    }
    if (reflectionFailed) break;
  }

  if (!reflectionFailed && useToolConversationPreview) {
    try {
      toolHistoryMessages.sort(
        (a, b) =>
          a.message.created_at.localeCompare(b.message.created_at) ||
          a.conversationId.localeCompare(b.conversationId) ||
          a.toolId.localeCompare(b.toolId),
      );
      const memoryOpsStart = memoryOps.length;
      const skippedStart = skippedCandidates.length;
      const errorsStart = reflectionErrors.length;
      async function publishToolPreview(toolPreview: ToolHistoryPreviewResult) {
        // Each update is a cumulative snapshot. Replace the tool-preview suffix
        // so intermediate checkpoints and final delivery never duplicate it.
        memoryOps.length = memoryOpsStart;
        skippedCandidates.length = skippedStart;
        reflectionErrors.length = errorsStart;
        for (const conversation of conversationManifests)
          conversation.candidates = [];
        if (toolPreview.error) {
          reflectionErrors.push(toolPreview.error);
        }
        for (const candidate of toolPreview.candidates) {
          const conversationId = candidate.evidence[0]?.conversation_id;
          const manifest = conversationManifests.find(
            (item) => item.conversation_id === conversationId,
          );
          if (manifest) manifest.candidates.push(candidate);
        }
        const recovered = recoverHistoryEnvelope(
          { memory_ops: toolPreview.operations, skipped_candidates: [] },
          toolPreview.candidates,
          shadowTimeline,
          cutoffAt,
        );
        memoryOps.push(...recovered.envelope.memory_ops);
        skippedCandidates.push(...recovered.envelope.skipped_candidates);
        const allToolCandidates = new Map(
          toolPreview.candidates.map((candidate) => [candidate.id, candidate]),
        );
        const parsed = parseHistoryReflectionEnvelope(
          JSON.stringify(recovered.envelope),
          toolPreview.candidates,
          shadowTimeline,
          cutoffAt,
        );
        if (!parsed.envelope) {
          reflectionErrors.push(
            ...parsed.errors.map((error) => `tool preview: ${error}`),
          );
        } else {
          const shadow = applyHistoryEnvelopeToShadow(
            shadowTimeline,
            parsed.envelope,
            allToolCandidates,
          );
          reflectionErrors.push(
            ...shadow.errors.map((error) => `tool preview: ${error}`),
          );
        }
        await checkpoint();
      }
      const toolPreview = await deps.previewConversations(
        options.projectId,
        toolHistoryMessages,
        shadowTimeline,
        options,
        publishToolPreview,
      );
      await publishToolPreview(toolPreview);
    } catch (error) {
      reflectionErrors.push(
        `tool preview: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return snapshot();
}

/** Keep independently valid operations and explicitly account for rejected evidence. */
function recoverHistoryEnvelope(
  input: HistoryReflectionEnvelope,
  candidates: HistoryCandidate[],
  timeline: Memory[],
  cutoffAt: string,
): { envelope: HistoryReflectionEnvelope; errors: string[] } {
  const ordered = orderHistoryMemoryOperations(input.memory_ops);
  if (ordered.errors.length > 0) {
    throw new Error(
      `Cannot recover history operations: ${ordered.errors.join('; ')}`,
    );
  }
  const candidateMap = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const retained = new Map<HistoryMemoryOp, HistoryMemoryOp[]>();
  const claimed = new Set<string>();
  const rejectedReasons = new Map<string, string>();
  const errors: string[] = [];
  let shadowTimeline = timeline;
  for (const operation of ordered.operations) {
    const evidence = candidates.filter((candidate) =>
      operation.candidate_ids.includes(candidate.id),
    );
    const parsed = parseHistoryReflectionEnvelope(
      JSON.stringify({ memory_ops: [operation], skipped_candidates: [] }),
      evidence,
      shadowTimeline,
      cutoffAt,
    );
    const shadow = parsed.envelope
      ? applyHistoryEnvelopeToShadow(
          shadowTimeline,
          parsed.envelope,
          candidateMap,
        )
      : null;
    const failures = [
      ...parsed.errors,
      ...(shadow?.errors ?? []),
      ...(operation.candidate_ids.some((id) => claimed.has(id))
        ? ['Candidate already used by a retained operation']
        : []),
    ];
    if (failures.length > 0 || !parsed.envelope || !shadow) {
      const reason = `Skipped invalid ${operation.op} proposal: ${failures.join('; ')}`;
      errors.push(reason);
      for (const id of operation.candidate_ids) rejectedReasons.set(id, reason);
      continue;
    }
    retained.set(operation, parsed.envelope.memory_ops);
    for (const id of operation.candidate_ids) claimed.add(id);
    shadowTimeline = shadow.timeline;
  }
  const skipped = [...input.skipped_candidates];
  const accounted = new Set([
    ...claimed,
    ...skipped.flatMap((item) => item.candidate_ids),
  ]);
  for (const candidate of candidates) {
    if (accounted.has(candidate.id)) continue;
    skipped.push({
      candidate_ids: [candidate.id],
      reason:
        rejectedReasons.get(candidate.id) ??
        'No valid proposal was produced for this evidence',
    });
  }
  return {
    envelope: {
      // Dependency order is for validation only; keep the proposal sequence
      // stable for review, checkpoint fingerprints, and existing consumers.
      memory_ops: input.memory_ops.flatMap(
        (operation) => retained.get(operation) ?? [],
      ),
      skipped_candidates: skipped,
    },
    errors,
  };
}

/**
 * Convert a failed/incomplete preview checkpoint into an explicitly partial
 * preview without making another LLM call. Successfully reflected operations
 * are retained and every candidate that has no disposition yet is recorded as
 * skipped, so the normal apply-time candidate accounting remains strict.
 */
export function finalizePartialHistoryReflectionManifest(
  input: HistoryReflectionManifest,
  timeline: Memory[],
  finalizedAt = new Date().toISOString(),
  options: { allowBaselineRebase?: boolean } = {},
): HistoryReflectionManifest {
  const currentBaseline = memoryBaselineFingerprint(timeline);
  if (
    currentBaseline !== input.memory_baseline &&
    !options.allowBaselineRebase
  ) {
    throw new Error(
      'Memory baseline changed after preview; generate a new preview before finalizing partial results',
    );
  }

  const candidates = [
    ...input.memory_files.flatMap((file) => file.candidates),
    ...input.conversations.flatMap((conversation) => conversation.candidates),
  ];
  const recovered = recoverHistoryEnvelope(
    input.envelope,
    candidates,
    timeline,
    input.cutoff_at,
  );
  const accounted = new Set(
    [
      ...recovered.envelope.memory_ops,
      ...input.envelope.skipped_candidates,
    ].flatMap((item) => item.candidate_ids),
  );
  const unaccounted = candidates.filter(
    (candidate) => !accounted.has(candidate.id),
  );
  const ignoredErrors = [
    ...new Set([
      ...(input.partial_finalization?.ignored_errors ?? []),
      ...input.errors,
      ...recovered.errors,
    ]),
  ];
  const parsed = parseHistoryReflectionEnvelope(
    JSON.stringify(recovered.envelope),
    candidates,
    timeline,
    input.cutoff_at,
  );
  if (!parsed.envelope) {
    throw new Error(
      `Partial preview cannot be finalized: ${parsed.errors.join('; ')}`,
    );
  }
  const shadow = applyHistoryEnvelopeToShadow(
    timeline,
    parsed.envelope,
    new Map(candidates.map((candidate) => [candidate.id, candidate])),
  );
  if (shadow.errors.length > 0) {
    throw new Error(
      `Partial preview chronology is invalid: ${shadow.errors.join('; ')}`,
    );
  }

  return {
    ...input,
    memory_baseline: currentBaseline,
    envelope: parsed.envelope,
    errors: [],
    partial_finalization: {
      finalized_at: new Date(finalizedAt).toISOString(),
      ignored_errors: ignoredErrors,
      skipped_candidates:
        (input.partial_finalization?.skipped_candidates ?? 0) +
        unaccounted.length,
    },
    status: 'preview',
  };
}

async function syncMemoryVector(memory: Memory): Promise<void> {
  const hooks = getVectorStoreHooks();
  if (!hooks?.isAvailable()) return;
  await hooks.embedAndStore(
    memory.id,
    memory.group_folder,
    memory.content,
    memory.objective_id ?? null,
  );
}

async function assertHistoryObjectiveOwnership(
  projectId: string,
  objectiveId: string | null | undefined,
): Promise<void> {
  if (!objectiveId) return;
  const objective = await getObjective(objectiveId);
  if (!objective || objective.project_id !== projectId) {
    throw new Error(
      `History objective "${objectiveId}" no longer belongs to project "${projectId}"; generate a new preview before applying`,
    );
  }
}

function historyApplyManifestId(manifest: HistoryReflectionManifest): string {
  const {
    status: _status,
    applied_at: _appliedAt,
    ...reviewedManifest
  } = manifest;
  return createHash('sha256')
    .update(JSON.stringify(reviewedManifest))
    .digest('base64url');
}

async function applyCreate(
  projectId: string,
  op: Extract<HistoryMemoryOp, { op: 'create' }>,
  candidates: Map<string, HistoryCandidate>,
  writeEpoch: number,
): Promise<void> {
  await assertHistoryObjectiveOwnership(projectId, op.objective_id);
  const successor = op.precedes_id
    ? await getMemory(op.precedes_id)
    : undefined;
  if (op.precedes_id && !successor) {
    throw new Error(`create successor ${op.precedes_id} no longer exists`);
  }
  const validTo = successor?.valid_from ?? successor?.created_at;
  const sourceRef = sourceRefForCandidates(op.candidate_ids, candidates);
  let memory: Memory | null | undefined = await getMemory(op.new_memory_id);
  if (memory) {
    const matches =
      memory.group_folder === projectId &&
      (memory.objective_id ?? null) === (op.objective_id ?? null) &&
      memory.content === op.content &&
      memory.memory_type === op.memory_type &&
      memory.importance === op.importance &&
      memory.source === 'observer' &&
      memory.sourceRef === sourceRef &&
      memory.valid_from === op.valid_from &&
      JSON.stringify(memory.tags ?? []) === JSON.stringify(op.tags ?? []) &&
      (memory.valid_to === (validTo ?? null) ||
        (op.precedes_id &&
          memory.valid_to === null &&
          memory.superseded_by === null));
    if (!matches) {
      throw new Error(
        `History memory ${op.new_memory_id} already exists with different data`,
      );
    }
  } else {
    memory = await insertMemory({
      id: op.new_memory_id,
      group_folder: projectId,
      objective_id: op.objective_id ?? null,
      content: op.content,
      memory_type: op.memory_type,
      importance: op.importance,
      source: 'observer',
      sourceRef,
      tags: op.tags,
      valid_from: op.valid_from,
      expectedPrivacyEpoch: writeEpoch,
    });
  }
  await syncMemoryVector(memory);
  if (
    successor &&
    validTo &&
    (memory.superseded_by !== successor.id || memory.valid_to !== validTo)
  ) {
    await setMemorySuccessor(memory.id, successor.id, validTo);
  }
  if (successor && validTo) await syncGraphInvalidation(memory.id, validTo);
}

async function recordHistoryOperationTranscriptEvidence(
  projectId: string,
  op: Exclude<HistoryMemoryOp, { op: 'forget' }>,
  candidates: Map<string, HistoryCandidate>,
): Promise<void> {
  const memoryId = op.op === 'invalidate' ? op.memory_id : op.new_memory_id;
  if (!(await getMemory(memoryId))) return;

  const byConversation = new Map<
    string,
    {
      references: MemoryEvidenceReference[];
      messages: Map<string, TranscriptEvidenceMessage>;
    }
  >();
  for (const candidateId of op.candidate_ids) {
    for (const evidence of candidates.get(candidateId)?.evidence ?? []) {
      if (
        evidence.source_kind !== 'conversation' ||
        evidence.role === 'memory_file'
      ) {
        continue;
      }
      const sourceRef = `conversation:${evidence.conversation_id}`;
      const group = byConversation.get(sourceRef) ?? {
        references: [] as MemoryEvidenceReference[],
        messages: new Map<string, TranscriptEvidenceMessage>(),
      };
      group.references.push({
        message_id: evidence.message_id,
        excerpt: evidence.excerpt,
      });
      group.messages.set(evidence.message_id, {
        id: evidence.message_id,
        createdAt: evidence.created_at,
        role: evidence.role,
        content: evidence.excerpt,
      });
      byConversation.set(sourceRef, group);
    }
  }
  for (const [sourceRef, evidence] of byConversation) {
    await recordTranscriptEvidence({
      memoryId,
      projectId,
      sourceRef,
      ...evidence,
    });
  }
}

/**
 * Apply a reviewed standalone historical create to a different project. The
 * caller must first validate the source reflection manifest so candidate
 * evidence is still anchored to the project where it was observed.
 */
export async function applyRelocatedHistoryCreate(
  projectId: string,
  operation: Extract<HistoryMemoryOp, { op: 'create' }>,
  sourceCandidates: HistoryCandidate[],
  privacyCheckpointAt: string,
): Promise<HistoryApplyResult> {
  if (operation.precedes_id) {
    throw new Error(
      'A history create linked to a project timeline cannot be moved',
    );
  }
  const projects = await getImportProjects();
  if (!projects.some((project) => project.id === projectId)) {
    throw new Error(`Unknown project "${projectId}"`);
  }
  const candidates = operation.candidate_ids.map((candidateId) => {
    const candidate = sourceCandidates.find((item) => item.id === candidateId);
    if (!candidate) {
      throw new Error(`Missing source candidate ${candidateId}`);
    }
    return candidate;
  });
  const candidateMap = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const relocatedOperation = { ...operation, objective_id: null };
  const expectedSourceRef = sourceRefForCandidates(
    relocatedOperation.candidate_ids,
    candidateMap,
  );

  return withMemoryLifecycleLock(projectId, async () => {
    const existing = await getMemory(operation.new_memory_id);
    if (existing) {
      const matches =
        existing.group_folder === projectId &&
        (existing.objective_id ?? null) === null &&
        existing.content === relocatedOperation.content &&
        existing.memory_type === relocatedOperation.memory_type &&
        existing.importance === relocatedOperation.importance &&
        existing.valid_from === relocatedOperation.valid_from &&
        existing.sourceRef === expectedSourceRef &&
        JSON.stringify(existing.tags ?? []) ===
          JSON.stringify(relocatedOperation.tags ?? []);
      if (!matches) {
        throw new Error(
          `History memory ${operation.new_memory_id} already exists with different data`,
        );
      }
      await syncMemoryVector(existing);
      await recordHistoryOperationTranscriptEvidence(
        projectId,
        relocatedOperation,
        candidateMap,
      );
      return {
        alreadyApplied: true,
        applied: { created: 0, superseded: 0, invalidated: 0, forgotten: 0 },
      };
    }

    await assertNoPrivacyErasureSince(projectId, privacyCheckpointAt, 1);
    const timeline = await getMemoryTimeline(projectId);
    const parsed = parseHistoryReflectionEnvelope(
      JSON.stringify({
        memory_ops: [relocatedOperation],
        skipped_candidates: [],
      }),
      candidates,
      timeline,
      new Date().toISOString(),
    );
    if (!parsed.envelope) {
      throw new Error(
        `Moved history operation is invalid: ${parsed.errors.join('; ')}`,
      );
    }
    const shadow = applyHistoryEnvelopeToShadow(
      timeline,
      parsed.envelope,
      candidateMap,
    );
    if (shadow.errors.length > 0) {
      throw new Error(
        `Moved history operation conflicts with the destination timeline: ${shadow.errors.join('; ')}`,
      );
    }
    const writeEpoch = getPrivacyErasureEpoch(projectId);
    await applyCreate(projectId, relocatedOperation, candidateMap, writeEpoch);
    await recordHistoryOperationTranscriptEvidence(
      projectId,
      relocatedOperation,
      candidateMap,
    );
    return {
      alreadyApplied: false,
      applied: { created: 1, superseded: 0, invalidated: 0, forgotten: 0 },
    };
  });
}

async function applySupersede(
  projectId: string,
  op: Extract<HistoryMemoryOp, { op: 'supersede' }>,
  candidates: Map<string, HistoryCandidate>,
  writeEpoch: number,
  expectedTargetVersion: string | null,
  targetCreatedByManifest: boolean,
): Promise<void> {
  const prior = await getMemory(op.supersedes_id);
  if (!prior || prior.group_folder !== projectId) {
    throw new Error(
      `supersede target ${op.supersedes_id} no longer exists in project`,
    );
  }
  const objectiveId =
    op.objective_id !== undefined
      ? op.objective_id
      : (prior.objective_id ?? null);
  await assertHistoryObjectiveOwnership(projectId, objectiveId);
  const sourceRef = sourceRefForCandidates(op.candidate_ids, candidates);
  let memory: Memory | null | undefined = await getMemory(op.new_memory_id);
  if (memory) {
    const matches =
      memory.group_folder === projectId &&
      (memory.objective_id ?? null) === objectiveId &&
      memory.content === op.correction_content &&
      memory.memory_type === op.memory_type &&
      memory.importance === op.importance &&
      memory.source === 'observer' &&
      memory.sourceRef === sourceRef &&
      memory.valid_from === op.valid_from &&
      JSON.stringify(memory.tags ?? []) === JSON.stringify(op.tags ?? []) &&
      prior.superseded_by === memory.id &&
      prior.valid_to === op.valid_from;
    if (!matches) {
      throw new Error(
        `History supersession ${op.new_memory_id} is only partially applied or has changed`,
      );
    }
  } else {
    const expectedVersion =
      expectedTargetVersion ??
      (targetCreatedByManifest ? prior.updated_at : undefined);
    if (!expectedVersion || prior.updated_at !== expectedVersion) {
      throw new Error(
        `supersede target ${op.supersedes_id} changed after review; generate a new preview`,
      );
    }
    memory = await insertSupersedingMemory({
      id: op.new_memory_id,
      targetMemoryId: prior.id,
      groupFolder: projectId,
      expectedVersion,
      effectiveAt: op.valid_from,
      content: op.correction_content,
      memoryType: op.memory_type,
      importance: op.importance,
      objectiveId,
      source: 'observer',
      sourceRef,
      tags: op.tags,
      expectedPrivacyEpoch: writeEpoch,
    });
  }
  if (!memory) {
    throw new Error(
      `supersede target ${op.supersedes_id} changed after review; generate a new preview`,
    );
  }
  await syncGraphInvalidation(prior.id, op.valid_from);
  if (op.precedes_id) {
    const successor = await getMemory(op.precedes_id);
    if (!successor)
      throw new Error(`supersede successor ${op.precedes_id} no longer exists`);
    const successorFrom = successor.valid_from ?? successor.created_at;
    await setMemorySuccessor(memory.id, successor.id, successorFrom);
    await syncGraphInvalidation(memory.id, successorFrom);
  }
  const stored = (await getMemory(memory.id))!;
  if (!op.precedes_id && stored.valid_to) {
    await syncGraphInvalidation(stored.id, stored.valid_to);
  }
  await syncMemoryVector(stored);
}

async function applyInvalidate(
  projectId: string,
  op: Extract<HistoryMemoryOp, { op: 'invalidate' }>,
  expectedTargetVersion: string | null,
  targetCreatedByManifest: boolean,
): Promise<void> {
  const memory = await getMemory(op.memory_id);
  if (!memory || memory.group_folder !== projectId) {
    throw new Error(
      `invalidate target ${op.memory_id} no longer exists in project`,
    );
  }
  if (memory.valid_to === op.effective_at) {
    await syncGraphInvalidation(memory.id, op.effective_at);
    return;
  }
  const expectedVersion =
    expectedTargetVersion ??
    (targetCreatedByManifest ? memory.updated_at : undefined);
  if (!expectedVersion || memory.updated_at !== expectedVersion) {
    throw new Error(
      `invalidate target ${op.memory_id} changed after review; generate a new preview`,
    );
  }
  const changed = await invalidateMemory(
    memory.id,
    op.effective_at,
    expectedVersion,
  );
  if (!changed) {
    throw new Error(
      `invalidate target ${op.memory_id} changed after review; generate a new preview`,
    );
  }
  await syncGraphInvalidation(memory.id, op.effective_at);
}

async function applyForget(
  projectId: string,
  op: Extract<HistoryMemoryOp, { op: 'forget' }>,
  expectedTargetVersion: string | null,
  targetCreatedByManifest: boolean,
): Promise<void> {
  const memory = await getMemory(op.memory_id);
  if (!memory) return;
  if (memory.group_folder !== projectId) {
    throw new Error(`forget target ${op.memory_id} is outside project`);
  }
  if (
    (!expectedTargetVersion && !targetCreatedByManifest) ||
    (expectedTargetVersion && memory.updated_at !== expectedTargetVersion)
  ) {
    throw new Error(
      `forget target ${op.memory_id} changed after review; generate a new preview`,
    );
  }
  await eraseMemoryDurably(memory.id, projectId, op.target);
}

async function historyOperationSqlApplied(
  projectId: string,
  op: HistoryMemoryOp,
  candidates: Map<string, HistoryCandidate>,
): Promise<boolean> {
  if (op.op === 'forget') return !(await getMemory(op.memory_id));
  if (op.op === 'invalidate') {
    const memory = await getMemory(op.memory_id);
    return (
      memory?.group_folder === projectId && memory.valid_to === op.effective_at
    );
  }

  const memory = await getMemory(op.new_memory_id);
  if (!memory || memory.group_folder !== projectId) return false;
  const expectedObjectiveId =
    op.op === 'supersede' && op.objective_id === undefined
      ? ((await getMemory(op.supersedes_id))?.objective_id ?? null)
      : (op.objective_id ?? null);
  const commonMatches =
    (memory.objective_id ?? null) === expectedObjectiveId &&
    memory.content ===
      (op.op === 'create' ? op.content : op.correction_content) &&
    memory.memory_type === op.memory_type &&
    memory.importance === op.importance &&
    memory.source === 'observer' &&
    memory.sourceRef === sourceRefForCandidates(op.candidate_ids, candidates) &&
    memory.valid_from === op.valid_from &&
    JSON.stringify(memory.tags ?? []) === JSON.stringify(op.tags ?? []);
  if (!commonMatches) return false;
  if (op.op === 'create') {
    return !op.precedes_id || memory.superseded_by === op.precedes_id;
  }
  const prior = await getMemory(op.supersedes_id);
  return prior?.superseded_by === memory.id && prior.valid_to === op.valid_from;
}

async function applyHistoryOperation(
  projectId: string,
  op: HistoryMemoryOp,
  candidateMap: Map<string, HistoryCandidate>,
  writeEpoch: number,
  expectedTargetVersion: string | null,
  plannedMemoryIds: Set<string>,
): Promise<void> {
  if (op.op === 'create') {
    await applyCreate(projectId, op, candidateMap, writeEpoch);
  } else if (op.op === 'supersede') {
    await applySupersede(
      projectId,
      op,
      candidateMap,
      writeEpoch,
      expectedTargetVersion,
      plannedMemoryIds.has(op.supersedes_id),
    );
  } else if (op.op === 'invalidate') {
    await applyInvalidate(
      projectId,
      op,
      expectedTargetVersion,
      plannedMemoryIds.has(op.memory_id),
    );
  } else {
    await applyForget(
      projectId,
      op,
      expectedTargetVersion,
      plannedMemoryIds.has(op.memory_id),
    );
  }
  if (op.op !== 'forget') {
    await recordHistoryOperationTranscriptEvidence(projectId, op, candidateMap);
  }
}

async function manifestAlreadyApplied(
  manifest: HistoryReflectionManifest,
  timeline: Memory[],
): Promise<boolean> {
  if (manifest.envelope.memory_ops.length === 0) return false;
  const byId = new Map(timeline.map((memory) => [memory.id, memory]));
  for (const op of manifest.envelope.memory_ops) {
    if (op.op === 'create') {
      const created = byId.get(op.new_memory_id);
      if (
        !created ||
        (created.objective_id ?? null) !== (op.objective_id ?? null) ||
        created.content !== op.content ||
        created.valid_from !== op.valid_from ||
        (op.precedes_id && created.superseded_by !== op.precedes_id)
      )
        return false;
    } else if (op.op === 'supersede') {
      const created = byId.get(op.new_memory_id);
      const prior = byId.get(op.supersedes_id);
      if (
        !created ||
        (created.objective_id ?? null) !==
          (op.objective_id !== undefined
            ? op.objective_id
            : (prior?.objective_id ?? null)) ||
        created.content !== op.correction_content ||
        prior?.superseded_by !== created.id ||
        prior.valid_to !== op.valid_from
      )
        return false;
    } else if (op.op === 'invalidate') {
      if (byId.get(op.memory_id)?.valid_to !== op.effective_at) return false;
    } else if (byId.has(op.memory_id)) {
      return false;
    }
  }
  return true;
}

async function resyncManifestPersistence(
  manifest: HistoryReflectionManifest,
  candidates: Map<string, HistoryCandidate>,
): Promise<void> {
  for (const op of manifest.envelope.memory_ops) {
    if (op.op === 'create' || op.op === 'supersede') {
      const memory = await getMemory(op.new_memory_id);
      if (memory) await syncMemoryVector(memory);
    }
    if (op.op !== 'forget') {
      await recordHistoryOperationTranscriptEvidence(
        manifest.project_id,
        op,
        candidates,
      );
    }
  }
}

async function validateManifestSources(
  manifest: HistoryReflectionManifest,
): Promise<void> {
  const sourceUntil = earlierIso(
    manifest.filters.until ?? undefined,
    manifest.cutoff_at,
  );
  const [allConversations, allMemoryFiles] = await Promise.all([
    manifest.sources.conversations
      ? getConversationsForHistoryReflection(manifest.project_id)
      : Promise.resolve([]),
    manifest.sources.memory_files
      ? listProjectMemoryFiles(manifest.project_id).then((files) => {
          const selected = manifest.sources.memory_file_paths;
          const paths = selected ? new Set(selected) : null;
          return files.filter(
            (file) =>
              (!paths || paths.has(file.relativePath)) &&
              (!manifest.sources.require_native_manifest ||
                !!file.nativeOrigin),
          );
        })
      : Promise.resolve([]),
  ]);
  // Preview selection is based on evidence timestamps, not conversation
  // creation time. Reconstruct the same bounded authoritative transcript here
  // so an older long-lived conversation can be applied and out-of-range
  // messages do not make its reviewed hash appear stale.
  const currentConversationSources = (
    await Promise.all(
      allConversations
        .sort(
          (a, b) =>
            a.created_at.localeCompare(b.created_at) ||
            a.id.localeCompare(b.id),
        )
        .map(async (conversation) => {
          const entries = await defaultReadConversation(conversation);
          const messages = normalizeHistoryMessages(
            conversation,
            entries,
          ).filter((message) =>
            dateInRange(
              message.created_at,
              manifest.filters.since ?? undefined,
              sourceUntil,
            ),
          );
          return messages.length > 0 ? { conversation, messages } : null;
        }),
    )
  ).filter(
    (
      source,
    ): source is { conversation: Conversation; messages: HistoryMessage[] } =>
      source !== null,
  );
  const currentMemoryFiles = allMemoryFiles.filter((file) =>
    dateInRange(
      file.modifiedAt,
      manifest.filters.since ?? undefined,
      sourceUntil,
    ),
  );
  const expectedIds = currentConversationSources.map(
    ({ conversation }) => conversation.id,
  );
  const manifestIds = manifest.conversations.map(
    (conversation) => conversation.conversation_id,
  );
  if (
    expectedIds.length !== manifestIds.length ||
    expectedIds.some((id, index) => id !== manifestIds[index])
  ) {
    throw new Error(
      'Project conversation inventory changed after preview; generate a new preview',
    );
  }

  const seenCandidates = new Set<string>();
  const conversationMessagesByEvidence = new Map(
    currentConversationSources.flatMap(({ conversation, messages }) =>
      messages.map(
        (message) =>
          [`${conversation.id}\u0000${message.id}`, message] as const,
      ),
    ),
  );

  function validateCandidates(
    candidates: HistoryCandidate[],
    messages: HistoryMessage[],
    sourceId: string,
    sourceKind: 'conversation' | 'memory_file',
    requiredEffectiveAt?: string,
  ): void {
    const messagesById = new Map(
      messages.map((message) => [message.id, message]),
    );
    for (const candidate of candidates) {
      if (!candidate.id || seenCandidates.has(candidate.id)) {
        throw new Error(`Duplicate or missing candidate id in ${sourceId}`);
      }
      seenCandidates.add(candidate.id);
      if (
        candidate.planned_memory_id !== plannedHistoryMemoryId(candidate.id)
      ) {
        throw new Error(
          `Candidate ${candidate.id} has an invalid planned memory id`,
        );
      }
      if (
        !candidate.claim ||
        !Number.isFinite(candidate.confidence) ||
        candidate.confidence < 0 ||
        candidate.confidence > 1 ||
        !Number.isFinite(candidate.importance) ||
        candidate.importance < 0 ||
        candidate.importance > 1 ||
        !Array.isArray(candidate.evidence) ||
        candidate.evidence.length === 0 ||
        !Number.isFinite(Date.parse(candidate.effective_at)) ||
        candidate.effective_at > manifest.cutoff_at ||
        (requiredEffectiveAt !== undefined &&
          candidate.effective_at !== requiredEffectiveAt)
      ) {
        throw new Error(`Candidate ${candidate.id} is structurally invalid`);
      }
      if (
        !candidate.evidence.some(
          (evidence) =>
            evidence.source_kind === sourceKind &&
            evidence.conversation_id === sourceId,
        )
      ) {
        throw new Error(
          `Candidate ${candidate.id} is not attached to its ${sourceKind} source ${sourceId}`,
        );
      }
      for (const evidence of candidate.evidence) {
        const source =
          sourceKind === 'conversation'
            ? conversationMessagesByEvidence.get(
                `${evidence.conversation_id}\u0000${evidence.message_id}`,
              )
            : messagesById.get(evidence.message_id);
        if (
          !source ||
          evidence.source_kind !== sourceKind ||
          (sourceKind === 'memory_file' &&
            evidence.conversation_id !== sourceId) ||
          evidence.role !== source.role ||
          evidence.created_at !== source.created_at ||
          evidence.date_basis !==
            (sourceKind === 'memory_file'
              ? 'file_mtime'
              : 'message_timestamp') ||
          (sourceKind === 'memory_file' &&
            evidence.memory_file_path !== sourceId.replace(/^memory-file:/, ''))
        ) {
          throw new Error(
            `Candidate ${candidate.id} has invalid ${sourceKind} evidence ${evidence.message_id}`,
          );
        }
      }
    }
  }

  for (const [index, source] of currentConversationSources.entries()) {
    const { conversation, messages } = source;
    const record = manifest.conversations[index]!;
    if (
      record.objective_id !== (conversation.objective_id ?? null) ||
      record.created_at !== conversation.created_at
    ) {
      throw new Error(`Conversation metadata changed for ${conversation.id}`);
    }
    if (hashHistoryTranscript(messages) !== record.transcript_hash) {
      throw new Error(
        `Conversation transcript changed after preview: ${conversation.id}`,
      );
    }
    validateCandidates(
      record.candidates,
      messages,
      conversation.id,
      'conversation',
    );
  }

  const manifestFileIds = manifest.memory_files.map((file) => file.source_id);
  const currentFileIds = currentMemoryFiles.map((file) => file.sourceId);
  if (
    currentFileIds.length !== manifestFileIds.length ||
    currentFileIds.some((id, index) => id !== manifestFileIds[index])
  ) {
    throw new Error(
      'Project memory-file inventory changed after preview; generate a new preview',
    );
  }

  for (const [index, file] of currentMemoryFiles.entries()) {
    const record = manifest.memory_files[index]!;
    const fileHash = hashHistoryMemoryFile(
      file.relativePath,
      file.content,
      file.modifiedAt,
    );
    if (
      record.relative_path !== file.relativePath ||
      record.modified_at !== file.modifiedAt ||
      record.timestamp_source !== file.timestampSource ||
      JSON.stringify(record.native_origin ?? null) !==
        JSON.stringify(file.nativeOrigin ?? null) ||
      record.file_hash !== fileHash ||
      record.byte_count !== file.byteCount
    ) {
      throw new Error(
        `Memory file changed after preview: ${file.relativePath}`,
      );
    }
    const messages = normalizeHistoryMemoryFile(
      file.relativePath,
      file.content,
      file.modifiedAt,
    );
    validateCandidates(
      record.candidates,
      messages,
      file.sourceId,
      'memory_file',
      file.modifiedAt,
    );
  }
}

/**
 * Earliest point a privacy erasure could have invalidated a stored preview.
 * Manifests without a recorded checkpoint fall back to their earliest
 * timestamps, which can only widen the refusal window.
 */
export function historyPrivacyCheckpoint(
  manifest: Pick<
    HistoryReflectionManifest,
    'privacy_checkpoint_at' | 'cutoff_at' | 'created_at'
  >,
): string {
  return (
    manifest.privacy_checkpoint_at ??
    earlierIso(manifest.cutoff_at, manifest.created_at)
  );
}

/**
 * Fail closed when a privacy erasure ran in the project at or after the
 * checkpoint: applying creates would silently restore forgotten content. An
 * unparseable timestamp also refuses.
 */
export async function assertNoPrivacyErasureSince(
  projectId: string,
  checkpointAt: string,
  pendingContentOps: number,
): Promise<void> {
  const erasedAt = await getLastPrivacyErasureAt(projectId);
  if (erasedAt === null || Date.parse(erasedAt) < Date.parse(checkpointAt)) {
    return;
  }
  logger.warn(
    { projectId, pendingContentOps },
    'history_apply_refused_after_erasure',
  );
  throw new Error(
    `A privacy erasure ran in project ${projectId} after this preview was generated; regenerate the preview and reject any proposal that restores forgotten content`,
  );
}

function rebaseMissingHistoryReferences(
  envelope: HistoryReflectionEnvelope,
  timeline: Memory[],
): HistoryReflectionEnvelope {
  const availableIds = new Set(timeline.map((memory) => memory.id));
  for (const operation of envelope.memory_ops) {
    if (operation.op === 'create' || operation.op === 'supersede') {
      availableIds.add(operation.new_memory_id);
    }
  }
  const skipped = [...envelope.skipped_candidates];
  const memoryOps = envelope.memory_ops.flatMap(
    (operation): HistoryMemoryOp[] => {
      if (operation.op === 'create') {
        const { precedes_id: precedesId, ...rest } = operation;
        return [
          {
            ...rest,
            ...(precedesId && availableIds.has(precedesId)
              ? { precedes_id: precedesId }
              : {}),
          },
        ];
      }
      if (operation.op === 'supersede') {
        const { precedes_id: precedesId } = operation;
        const successor =
          precedesId && availableIds.has(precedesId)
            ? { precedes_id: precedesId }
            : {};
        if (!availableIds.has(operation.supersedes_id)) {
          return [
            {
              op: 'create',
              candidate_ids: operation.candidate_ids,
              new_memory_id: operation.new_memory_id,
              ...(operation.objective_id !== undefined
                ? { objective_id: operation.objective_id }
                : {}),
              memory_type: operation.memory_type,
              content: operation.correction_content,
              valid_from: operation.valid_from,
              importance: operation.importance,
              tags: operation.tags,
              ...successor,
            },
          ];
        }
        const { precedes_id: _precedesId, ...rest } = operation;
        return [{ ...rest, ...successor }];
      }
      if (availableIds.has(operation.memory_id)) return [operation];
      skipped.push({
        candidate_ids: operation.candidate_ids,
        reason: 'baseline-target-no-longer-exists',
      });
      return [];
    },
  );
  return { memory_ops: memoryOps, skipped_candidates: skipped };
}

// Receipts store fingerprints rather than memory content. Recover the exact
// originally prepared operations, including any fresh-apply rebase, by matching
// the finite rebase variants against those fingerprints. Never use the current
// timeline to change an operation after progress has been recorded.
function restoreReceiptedHistoryOperations(
  envelope: HistoryReflectionEnvelope,
  receipts: HistoryApplyReceipt[],
  candidates: HistoryCandidate[],
  cutoffAt: string,
): HistoryMemoryOp[] {
  const variants = envelope.memory_ops.map((operation) => {
    const ids = [
      ...(operation.op === 'supersede' ? [operation.supersedes_id] : []),
      ...((operation.op === 'create' || operation.op === 'supersede') &&
      operation.precedes_id
        ? [operation.precedes_id]
        : []),
      ...(operation.op === 'forget' || operation.op === 'invalidate'
        ? [operation.memory_id]
        : []),
    ];
    return Array.from({ length: 1 << ids.length }, (_, mask) => {
      const timeline = ids
        .filter((_, index) => mask & (1 << index))
        .map((id) => ({ id }) as Memory);
      const variant = rebaseMissingHistoryReferences(
        { memory_ops: [operation], skipped_candidates: [] },
        timeline,
      ).memory_ops[0];
      if (!variant) return undefined;
      // Receipts were fingerprinted after parsing, not from the review's
      // property order or unnormalized field values.
      const variantCandidates = candidates.filter((candidate) =>
        variant.candidate_ids.includes(candidate.id),
      );
      return parseHistoryReflectionEnvelope(
        JSON.stringify({ memory_ops: [variant], skipped_candidates: [] }),
        variantCandidates,
        timeline,
        cutoffAt,
      ).envelope?.memory_ops[0];
    }).filter((variant): variant is HistoryMemoryOp => !!variant);
  });
  return [...receipts]
    .sort((a, b) => a.operationIndex - b.operationIndex)
    .map((receipt, index) => {
      if (receipt.operationIndex !== index) {
        throw new Error('History apply progress does not match this review');
      }
      const match = variants.findIndex((choices) =>
        choices.some(
          (choice) =>
            operationFingerprint(choice) === receipt.requestFingerprint,
        ),
      );
      if (match < 0) {
        throw new Error('History apply progress does not match this review');
      }
      const operation = variants[match]!.find(
        (choice) => operationFingerprint(choice) === receipt.requestFingerprint,
      )!;
      variants[match] = [];
      return operation;
    });
}

export async function applyHistoryReflectionManifest(
  inputManifest: HistoryReflectionManifest,
  options: {
    allowBaselineRebase?: boolean;
    trustStoredSources?: boolean;
  } = {},
): Promise<HistoryApplyResult> {
  if (inputManifest.status === 'applied') {
    return {
      alreadyApplied: true,
      applied: { created: 0, superseded: 0, invalidated: 0, forgotten: 0 },
    };
  }
  if (
    inputManifest.manifest_version !== HISTORY_MANIFEST_VERSION ||
    inputManifest.candidate_prompt_version !==
      HISTORY_CANDIDATE_PROMPT_VERSION ||
    inputManifest.reflector_prompt_version !== HISTORY_REFLECTOR_PROMPT_VERSION
  ) {
    throw new Error('Manifest version or prompt version is not supported');
  }
  if (
    !inputManifest.sources ||
    typeof inputManifest.sources.conversations !== 'boolean' ||
    typeof inputManifest.sources.memory_files !== 'boolean' ||
    (inputManifest.sources.memory_file_paths != null &&
      (!Array.isArray(inputManifest.sources.memory_file_paths) ||
        inputManifest.sources.memory_file_paths.some(
          (value) => typeof value !== 'string' || !value,
        ))) ||
    (inputManifest.sources.require_native_manifest != null &&
      typeof inputManifest.sources.require_native_manifest !== 'boolean') ||
    !Array.isArray(inputManifest.conversations) ||
    !Array.isArray(inputManifest.memory_files)
  ) {
    throw new Error('Manifest source inventory is malformed');
  }
  if (inputManifest.errors.length > 0) {
    throw new Error(
      'Manifest contains extraction/reflection errors and cannot be applied',
    );
  }

  // Before any source is read: the manifest is only valid for the project
  // that held this folder name when the sources were validated.
  const folderIdentity = getFolderGeneration(inputManifest.project_id);
  const projects = await getImportProjects();
  if (!projects.some((project) => project.id === inputManifest.project_id)) {
    throw new Error(`Unknown project "${inputManifest.project_id}"`);
  }

  if (!options.trustStoredSources) {
    await validateManifestSources(inputManifest);
  }
  const candidates = [
    ...inputManifest.conversations.flatMap(
      (conversation) => conversation.candidates,
    ),
    ...inputManifest.memory_files.flatMap((file) => file.candidates),
  ];
  const candidateMap = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const manifestId = historyApplyManifestId(inputManifest);
  const result = await withMemoryLifecycleLock(
    inputManifest.project_id,
    async (): Promise<HistoryApplyResult> => {
      assertFolderIdentity(inputManifest.project_id, folderIdentity);
      // The baseline and reviewed target versions must be captured only after
      // this apply owns the same lifecycle lock as automatic memory writes.
      const timeline = await getMemoryTimeline(inputManifest.project_id);
      const currentBaseline = memoryBaselineFingerprint(timeline);
      const existingReceipts = await getHistoryApplyReceipts(manifestId);
      let baselineRebased = false;
      let envelope = inputManifest.envelope;

      if (currentBaseline !== inputManifest.memory_baseline) {
        if (
          existingReceipts.length === 0 &&
          (await manifestAlreadyApplied(inputManifest, timeline))
        ) {
          await resyncManifestPersistence(inputManifest, candidateMap);
          return {
            alreadyApplied: true,
            applied: {
              created: 0,
              superseded: 0,
              invalidated: 0,
              forgotten: 0,
            },
          };
        }
        if (existingReceipts.length === 0) {
          if (!options.allowBaselineRebase) {
            throw new Error(
              'Memory baseline changed after preview; generate a new preview before applying',
            );
          }
          baselineRebased = true;
          envelope = rebaseMissingHistoryReferences(envelope, timeline);
          if (
            await manifestAlreadyApplied(
              { ...inputManifest, envelope },
              timeline,
            )
          ) {
            await resyncManifestPersistence(
              { ...inputManifest, envelope },
              candidateMap,
            );
            return {
              alreadyApplied: true,
              baselineRebased: true,
              applied: {
                created: 0,
                superseded: 0,
                invalidated: 0,
                forgotten: 0,
              },
            };
          }
        }
      }

      let operations: HistoryMemoryOp[];
      if (existingReceipts.length === 0) {
        const reparsed = parseHistoryReflectionEnvelope(
          JSON.stringify(envelope),
          candidates,
          timeline,
          inputManifest.cutoff_at,
        );
        if (!reparsed.envelope) {
          throw new Error(
            baselineRebased
              ? `Memory baseline changed and the reviewed operations conflict with the current timeline: ${reparsed.errors.join('; ')}`
              : `Manifest envelope is invalid: ${reparsed.errors.join('; ')}`,
          );
        }
        const shadow = applyHistoryEnvelopeToShadow(
          timeline,
          reparsed.envelope,
          candidateMap,
        );
        if (shadow.errors.length > 0) {
          throw new Error(
            baselineRebased
              ? `Memory baseline changed and the reviewed operations conflict with the current chronology: ${shadow.errors.join('; ')}`
              : `Manifest chronology is invalid: ${shadow.errors.join('; ')}`,
          );
        }
        operations = reparsed.envelope.memory_ops;
      } else {
        operations = restoreReceiptedHistoryOperations(
          envelope,
          existingReceipts,
          candidates,
          inputManifest.cutoff_at,
        );
        baselineRebased =
          JSON.stringify(operations) !== JSON.stringify(envelope.memory_ops);
        envelope = { ...envelope, memory_ops: operations };
      }

      const ordering = orderHistoryMemoryOperations(operations);
      if (ordering.errors.length > 0) {
        throw new Error(
          `Manifest operation dependencies are invalid: ${ordering.errors.join('; ')}`,
        );
      }
      const executionOrder = [
        ...ordering.operations.filter((op) => op.op !== 'forget'),
        ...ordering.operations.filter((op) => op.op === 'forget'),
      ];
      // Refuse before any write if forgotten content could be restored. Only
      // create/supersede can restore content, so an interrupted apply may
      // still finish its own forget/invalidate work.
      const completedIndexes = new Set(
        existingReceipts
          .filter((receipt) => receipt.status === 'completed')
          .map((receipt) => receipt.operationIndex),
      );
      const pendingContentOps = executionOrder.filter(
        (op, index) =>
          (op.op === 'create' || op.op === 'supersede') &&
          !completedIndexes.has(index),
      ).length;
      if (pendingContentOps > 0) {
        await assertNoPrivacyErasureSince(
          inputManifest.project_id,
          historyPrivacyCheckpoint(inputManifest),
          pendingContentOps,
        );
      }
      const receipts = await prepareHistoryApplyReceipts(
        manifestId,
        inputManifest.project_id,
        executionOrder,
        timeline,
      );
      const plannedMemoryIds = new Set(
        executionOrder.flatMap((operation) =>
          operation.op === 'create' || operation.op === 'supersede'
            ? [operation.new_memory_id]
            : [],
        ),
      );
      const writeEpoch = getPrivacyErasureEpoch(inputManifest.project_id);
      // A process can exit after the SQL mutation commits but before its
      // receipt is checkpointed. Only receipts with no checkpoint are eligible
      // for this reconciliation; checkpointed pending work still uses its
      // recorded baseline to detect unrelated concurrent writes.
      for (const [index, receipt] of receipts.entries()) {
        if (
          receipt.status !== 'pending' ||
          receipt.baselineFingerprint !== null ||
          !(await historyOperationSqlApplied(
            inputManifest.project_id,
            executionOrder[index]!,
            candidateMap,
          ))
        ) {
          continue;
        }
        await applyHistoryOperation(
          inputManifest.project_id,
          executionOrder[index]!,
          candidateMap,
          writeEpoch,
          receipt.expectedTargetVersion,
          plannedMemoryIds,
        );
        const reconciledBaseline = memoryBaselineFingerprint(
          await getMemoryTimeline(inputManifest.project_id),
        );
        await checkpointHistoryApplyReceipt(
          receipt.id,
          'completed',
          reconciledBaseline,
        );
        receipts[index] = {
          ...receipt,
          status: 'completed',
          baselineFingerprint: reconciledBaseline,
        };
      }
      const reconciledTimeline = await getMemoryTimeline(
        inputManifest.project_id,
      );
      const reconciledBaseline = memoryBaselineFingerprint(reconciledTimeline);
      const latestCheckpoint = receipts
        .filter((receipt) => receipt.baselineFingerprint)
        .sort((a, b) => b.operationIndex - a.operationIndex)[0];
      if (
        existingReceipts.length > 0 &&
        receipts.some((receipt) => receipt.status !== 'completed') &&
        ((latestCheckpoint?.baselineFingerprint &&
          latestCheckpoint.baselineFingerprint !== reconciledBaseline) ||
          (!latestCheckpoint?.baselineFingerprint &&
            !options.allowBaselineRebase &&
            inputManifest.memory_baseline !== reconciledBaseline))
      ) {
        throw new Error(
          'Memory baseline changed after the partial History Review apply; generate a new preview before applying',
        );
      }
      if (
        receipts.length > 0 &&
        receipts.every((receipt) => receipt.status === 'completed')
      ) {
        if (
          !(await manifestAlreadyApplied(
            { ...inputManifest, envelope },
            reconciledTimeline,
          ))
        ) {
          throw new Error(
            'Memory baseline changed after History Review was applied; generate a new preview before applying',
          );
        }
        await resyncManifestPersistence(
          { ...inputManifest, envelope },
          candidateMap,
        );
        return {
          alreadyApplied: true,
          baselineRebased: baselineRebased || undefined,
          applied: {
            created: 0,
            superseded: 0,
            invalidated: 0,
            forgotten: 0,
          },
        };
      }

      const applied = {
        created: 0,
        superseded: 0,
        invalidated: 0,
        forgotten: 0,
      };
      for (const [index, op] of executionOrder.entries()) {
        const receipt = receipts[index]!;
        if (receipt.status === 'completed') continue;
        try {
          await applyHistoryOperation(
            inputManifest.project_id,
            op,
            candidateMap,
            writeEpoch,
            receipt.expectedTargetVersion,
            plannedMemoryIds,
          );
          if (op.op === 'create') applied.created++;
          else if (op.op === 'supersede') applied.superseded++;
          else if (op.op === 'invalidate') applied.invalidated++;
          else applied.forgotten++;
        } catch (error) {
          await checkpointHistoryApplyReceipt(
            receipt.id,
            'pending',
            memoryBaselineFingerprint(
              await getMemoryTimeline(inputManifest.project_id),
            ),
          );
          throw error;
        }
        await checkpointHistoryApplyReceipt(
          receipt.id,
          'completed',
          memoryBaselineFingerprint(
            await getMemoryTimeline(inputManifest.project_id),
          ),
        );
      }
      return { alreadyApplied: false, baselineRebased, applied };
    },
  );

  logger.info(
    { project: inputManifest.project_id, applied: result.applied },
    'Historical project memories applied',
  );
  return result;
}

export function readHistoryManifest(
  filePath: string,
): HistoryReflectionManifest {
  const read = readGroupFileSync(path.resolve(filePath), {
    maxBytes: MAX_MEMORY_STATE_BYTES,
  });
  if (!read) throw new GroupFsError('not_found', `Not found: ${filePath}`);
  return JSON.parse(read.data.toString('utf8')) as HistoryReflectionManifest;
}

export function writeHistoryManifest(
  filePath: string,
  manifest: HistoryReflectionManifest,
): void {
  writeGroupFileSync(
    path.resolve(filePath),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mkdirs: true },
  );
}

export function defaultHistoryManifestPath(
  projectId: string,
  createdAt = new Date().toISOString(),
): string {
  const stamp = createdAt.replace(/[:.]/g, '-');
  return path.join(
    getGroupDir(projectId),
    'artifacts',
    'history-reflection',
    `${stamp}.json`,
  );
}

export async function assertHistoryProjectExists(
  projectId: string,
): Promise<void> {
  const projects = await getImportProjects();
  if (!projects.some((project) => project.id === projectId)) {
    throw new Error(`Unknown project "${projectId}"`);
  }
}

export async function refreshAppliedManifest(
  filePath: string,
  manifest: HistoryReflectionManifest,
): Promise<void> {
  const updated: HistoryReflectionManifest = {
    ...manifest,
    status: 'applied',
    applied_at: new Date().toISOString(),
  };
  writeHistoryManifest(filePath, updated);
}
