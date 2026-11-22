import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { getGroupDir, readChatTranscriptAsync } from '../../group-dir.js';
import {
  GroupFsError,
  openDirAt,
  openGroupDir,
  openParentDirSync,
  readFileAt,
  readGroupFileSync,
  readdirAt,
  removeAtSync,
  removeGroupPathSync,
  renameAtSync,
  writeGroupFileSync,
  type PinnedDir,
} from '../../lib/group-fs.js';
import { sha256Hex } from '../../lib/hash.js';
import { isPathInside } from '../../lib/path-containment.js';
import { logger } from '../../logger.js';
import type { RegisteredGroup } from '../../types.js';
import type { RuntimeSelection } from '../../lib/chat-agents.js';
import { getConversationsForHistoryReflection } from '../chat/db-chats.js';
import type { Conversation } from '../chat/db-chats.js';
import {
  dateInRange,
  earlierIso,
  normalizeHistoryMessages,
  type HistoryReflectionManifest,
} from './history-reflector-core.js';
import {
  MAX_MEMORY_STATE_BYTES,
  MAX_MEMORY_TEXT_BYTES,
} from './file-limits.js';
import { isRecord } from '../../lib/type-guards.js';

export const PROJECT_HISTORY_BATCH_VERSION = 2;
const PROJECT_HISTORY_MANIFEST_PATTERN =
  /^project-history-[a-zA-Z0-9._:-]+\.json$/;
const BATCH_LEASE_HEARTBEAT_MS = 30_000;
const BATCH_LEASE_STALE_MS = 2 * 60_000;

export interface NativeMemoryProjectDiscovery {
  project_id: string;
  group_dir: string;
  import_manifests: string[];
  memory_file_paths: string[];
  declared_entries: number;
  source_fingerprint: string;
  errors: string[];
}

export interface ProjectHistoryDiscovery extends NativeMemoryProjectDiscovery {
  conversation_count: number;
  sources: {
    conversations: boolean;
    native_memories: boolean;
  };
}

export function projectHistorySourceFingerprint(
  conversations: Array<
    Pick<Conversation, 'id' | 'created_at' | 'objective_id'>
  >,
  nativeFingerprint = sha256Hex('[]'),
): string {
  return sha256Hex(
    JSON.stringify({
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        created_at: conversation.created_at,
        objective_id: conversation.objective_id ?? null,
      })),
      native: nativeFingerprint,
    }),
  );
}

export interface ProjectHistoryBatchProject {
  project_id: string;
  import_manifests: string[];
  memory_file_paths: string[];
  declared_entries: number;
  source_fingerprint: string;
  conversation_count: number;
  sources: {
    conversations: boolean;
    native_memories: boolean;
  };
  reflection_manifest: string;
  review_fingerprint: string | null;
  candidates: number;
  memory_ops: number;
  skipped_candidates: number;
  errors: string[];
  status: 'pending' | 'preview' | 'applied' | 'error';
  progress?: {
    reflection?: {
      completedChunks: number;
      totalChunks: number;
      failedChunks: number;
      activeChunk: number | null;
      updatedAt: string;
    };
    conversations_processed: number;
    conversations_total: number;
    memory_files_processed: number;
    memory_files_total: number;
  };
  preview_state?: {
    preview_id: string;
    /** Group-relative path of the per-chunk preview checkpoint state file. */
    state_file: string;
  };
  partial_finalized_at?: string;
  applied_at?: string;
}

export interface ProjectHistoryBatchManifest {
  batch_version: number;
  created_at: string;
  cutoff_at: string;
  filters: {
    project: string | null;
    since: string | null;
    until: string | null;
    sources: {
      conversations: boolean;
      native_memories: boolean;
    };
  };
  agents: {
    observer: string | null;
    reflector: string | null;
    /** Human-readable catalog model selected for a Board-launched preview. */
    reflector_model?: string;
    /** Exact Board runtime selection used by a Board-launched preview. */
    reflector_runtime?: RuntimeSelection;
  };
  projects: ProjectHistoryBatchProject[];
  status: 'previewing' | 'preview' | 'applying' | 'applied' | 'error';
  errors: string[];
  applied_at?: string;
}

interface ProjectHistoryBatchLeaseRecord {
  owner_id: string;
  pid: number;
  started_at: string;
  heartbeat_at: string;
  batch_path: string;
}

export interface ProjectHistoryBatchLease {
  path: string;
  release(): void;
}

function readBatchLease(
  filePath: string,
): ProjectHistoryBatchLeaseRecord | null {
  try {
    const read = readGroupFileSync(filePath, {
      maxBytes: MAX_MEMORY_STATE_BYTES,
    });
    if (!read) return null;
    const parsed = JSON.parse(
      read.data.toString('utf8'),
    ) as Partial<ProjectHistoryBatchLeaseRecord>;
    if (
      !Number.isInteger(parsed.pid) ||
      typeof parsed.owner_id !== 'string' ||
      typeof parsed.started_at !== 'string' ||
      typeof parsed.heartbeat_at !== 'string' ||
      typeof parsed.batch_path !== 'string'
    ) {
      return null;
    }
    return parsed as ProjectHistoryBatchLeaseRecord;
  } catch {
    return null;
  }
}

/**
 * Prevent two long-running preview/apply processes from checkpointing the same
 * batch index from independent in-memory copies. The heartbeat permits recovery
 * after a killed process without expiring a healthy multi-hour reflection.
 */
export function acquireProjectHistoryBatchLease(
  batchFilePath: string,
  options: { staleMs?: number; heartbeatMs?: number } = {},
): ProjectHistoryBatchLease {
  const batchPath = path.resolve(batchFilePath);
  const leasePath = `${batchPath}.lock`;
  const leaseName = path.basename(leasePath);
  const staleMs = options.staleMs ?? BATCH_LEASE_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? BATCH_LEASE_HEARTBEAT_MS;
  const ownerId = randomUUID();

  const parent = openParentDirSync(batchPath, { create: true });
  if (!parent) {
    throw new Error(
      `Project-history batch directory is unavailable: ${batchPath}`,
    );
  }

  let record: ProjectHistoryBatchLeaseRecord;
  try {
    for (;;) {
      const now = new Date().toISOString();
      record = {
        owner_id: ownerId,
        pid: process.pid,
        started_at: now,
        heartbeat_at: now,
        batch_path: batchPath,
      };
      try {
        // Exclusive create named through the pinned directory: a leaf planted
        // by the agent is never written through.
        const fd = fs.openSync(
          parent.dir.entry(leaseName),
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o644,
        );
        try {
          fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
        } finally {
          fs.closeSync(fd);
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = readBatchLease(leasePath);
        const heartbeat = owner ? Date.parse(owner.heartbeat_at) : Number.NaN;
        const fresh =
          Number.isFinite(heartbeat) && Date.now() - heartbeat < staleMs;
        if (owner && fresh) {
          throw new Error(
            `Project-history batch is already active (pid ${owner.pid}, started ${owner.started_at}): ${batchPath}`,
          );
        }

        const staleName = `${leaseName}.stale.${process.pid}.${Date.now()}`;
        try {
          renameAtSync(parent.dir, leaseName, parent.dir, staleName);
          removeAtSync(parent.dir, staleName);
        } catch (reclaimError) {
          const vanished =
            reclaimError instanceof GroupFsError &&
            reclaimError.code === 'not_found';
          if (!vanished) throw reclaimError;
        }
      }
    }
  } finally {
    parent.dir.closeSync();
  }

  let released = false;
  const heartbeat = setInterval(() => {
    if (released) return;
    const current = readBatchLease(leasePath);
    if (!current || current.owner_id !== ownerId) return;
    record = { ...record, heartbeat_at: new Date().toISOString() };
    try {
      writeGroupFileSync(leasePath, `${JSON.stringify(record, null, 2)}\n`);
    } catch {
      // A missing lease will be detected by a competing process; the batch
      // writes themselves remain atomic.
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    path: leasePath,
    release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      const current = readBatchLease(leasePath);
      if (current?.owner_id === ownerId) removeGroupPathSync(leasePath);
    },
  };
}

/** Resolve both new group-relative references and legacy /app absolute paths. */
export function resolveProjectHistoryManifestPath(
  project: Pick<
    ProjectHistoryBatchProject,
    'project_id' | 'reflection_manifest'
  >,
): string {
  const groupRoot = path.resolve(getGroupDir(project.project_id));
  const stored = project.reflection_manifest;
  let relative: string;

  if (path.isAbsolute(stored)) {
    const direct = path.resolve(stored);
    if (isPathInside(groupRoot, direct)) {
      relative = path.relative(groupRoot, direct);
    } else {
      // Batch v2 originally persisted container-local /app paths. Remap only
      // the fixed, validated artifact suffix when another runtime reads it.
      const normalized = stored.split(path.sep).join('/');
      const match = normalized.match(
        /(?:^|\/)artifacts\/history-reflection\/([^/]+\.json)$/,
      );
      if (!match) throw new Error('Unsafe project history manifest path');
      relative = `artifacts/history-reflection/${match[1]}`;
    }
  } else {
    relative = stored;
  }

  const normalizedRelative = relative.split(path.sep).join('/');
  const expectedPrefix = 'artifacts/history-reflection/';
  const filename = path.posix.basename(normalizedRelative);
  if (
    !normalizedRelative.startsWith(expectedPrefix) ||
    normalizedRelative.slice(expectedPrefix.length).includes('/') ||
    !PROJECT_HISTORY_MANIFEST_PATTERN.test(filename)
  ) {
    throw new Error('Unsafe project history manifest path');
  }
  const resolved = path.resolve(groupRoot, ...normalizedRelative.split('/'));
  if (!isPathInside(groupRoot, resolved)) {
    throw new Error('Unsafe project history manifest path');
  }
  return resolved;
}

/**
 * Find the native-import manifests below the pinned memories directory.
 * `label` names `root` for the returned paths only; every read goes through
 * the pinned directories. A refused (linked) sub-directory is logged and skipped.
 */
async function walkNativeManifests(
  root: PinnedDir,
  label: string,
  projectId: string,
): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: PinnedDir, directory: string): Promise<void> {
    const entries =
      (await readdirAt(dir, undefined, { withFileTypes: true })) ?? [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = path.join(directory, entry.name);
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
        entry.name === '.native-memory-import.json'
      ) {
        result.push(entryPath);
      }
    }
  }
  await walk(root, label);
  return result.sort();
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function supportedMemoryFile(file: string): boolean {
  return ['.md', '.markdown', '.txt'].includes(
    path.extname(file).toLowerCase(),
  );
}

export async function discoverNativeMemoryProjects(
  groups: RegisteredGroup[],
  projectFilter?: string,
): Promise<NativeMemoryProjectDiscovery[]> {
  const discoveries: NativeMemoryProjectDiscovery[] = [];
  const selectedGroups = groups
    .filter((group) => !projectFilter || group.folder === projectFilter)
    .sort((a, b) => a.folder.localeCompare(b.folder));

  for (const group of selectedGroups) {
    const groupDir = getGroupDir(group.folder);
    // Naming root only: every read goes through the pinned directory.
    const memoryRoot = path.join(groupDir, '.agent', 'memories');
    let pinnedRoot: PinnedDir | null = null;
    try {
      pinnedRoot = await openGroupDir(group.folder, '.agent/memories');
    } catch (error) {
      if (!(error instanceof GroupFsError)) throw error;
      logger.warn(
        { err: error, projectId: group.folder },
        'Skipping refused native memory directory',
      );
    }
    if (!pinnedRoot) continue;
    try {
      const discovery = await discoverNativeMemoryProject(
        group.folder,
        groupDir,
        memoryRoot,
        pinnedRoot,
      );
      if (discovery) discoveries.push(discovery);
    } finally {
      await pinnedRoot.close();
    }
  }
  return discoveries;
}

async function discoverNativeMemoryProject(
  projectId: string,
  groupDir: string,
  memoryRoot: string,
  pinnedRoot: PinnedDir,
): Promise<NativeMemoryProjectDiscovery | null> {
  const below = (absolute: string) =>
    path.relative(memoryRoot, absolute).split(path.sep).join('/');
  const manifests = await walkNativeManifests(
    pinnedRoot,
    memoryRoot,
    projectId,
  );
  if (manifests.length === 0) return null;

  const errors: string[] = [];
  const files = new Map<string, { hash: string; sourceMtime: string }>();
  const fingerprintParts: Array<Record<string, unknown>> = [];
  let declaredEntries = 0;

  for (const manifestPath of manifests) {
    const manifestRelative = path
      .relative(groupDir, manifestPath)
      .split(path.sep)
      .join('/');
    let raw: string;
    let parsed: unknown;
    try {
      const read = await readFileAt(pinnedRoot, below(manifestPath), {
        maxBytes: MAX_MEMORY_STATE_BYTES,
      });
      if (!read) throw new Error('manifest not found');
      raw = read.data.toString('utf8');
      parsed = JSON.parse(raw);
    } catch (error) {
      errors.push(
        `${manifestRelative}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    fingerprintParts.push({
      manifest: manifestRelative,
      sha256: sha256Hex(raw),
    });
    if (!isRecord(parsed)) {
      errors.push(`${manifestRelative}: root must be an object`);
      continue;
    }

    for (const [entryName, value] of Object.entries(parsed)) {
      declaredEntries++;
      const label = `${manifestRelative}#${entryName}`;
      if (!isRecord(value)) {
        errors.push(`${label}: entry must be an object`);
        continue;
      }
      const record = value as Record<string, unknown>;
      const relativePath =
        typeof record.relativePath === 'string'
          ? record.relativePath
          : entryName;
      const expectedHash = record.sha256;
      const sourceMtime = record.sourceMtime;
      if (!validSha256(expectedHash)) {
        errors.push(`${label}: invalid sha256`);
        continue;
      }
      if (
        typeof sourceMtime !== 'string' ||
        !Number.isFinite(Date.parse(sourceMtime))
      ) {
        errors.push(`${label}: invalid sourceMtime`);
        continue;
      }
      const filePath = path.resolve(path.dirname(manifestPath), relativePath);
      if (
        !isPathInside(path.dirname(manifestPath), filePath) ||
        !supportedMemoryFile(filePath)
      ) {
        errors.push(`${label}: unsafe or unsupported relativePath`);
        continue;
      }
      let content: Buffer;
      try {
        const read = await readFileAt(pinnedRoot, below(filePath), {
          maxBytes: MAX_MEMORY_TEXT_BYTES,
        });
        if (!read) throw new Error('file not found');
        content = read.data;
      } catch (error) {
        errors.push(
          `${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const actualHash = sha256Hex(content);
      if (actualHash !== expectedHash.toLowerCase()) {
        errors.push(`${label}: recovered file sha256 does not match`);
        continue;
      }
      const groupRelative = path
        .relative(groupDir, filePath)
        .split(path.sep)
        .join('/');
      const existing = files.get(groupRelative);
      if (
        existing &&
        (existing.hash !== actualHash ||
          existing.sourceMtime !== new Date(sourceMtime).toISOString())
      ) {
        errors.push(`${label}: conflicting duplicate recovered file`);
        continue;
      }
      files.set(groupRelative, {
        hash: actualHash,
        sourceMtime: new Date(sourceMtime).toISOString(),
      });
    }
  }

  const fileRows = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relativePath, metadata]) => ({
      relative_path: relativePath,
      sha256: metadata.hash,
      source_mtime: metadata.sourceMtime,
    }));
  fingerprintParts.push(...fileRows);
  if (fileRows.length === 0) {
    errors.push('No verified recovered memory files were found');
  }
  return {
    project_id: projectId,
    group_dir: groupDir,
    import_manifests: manifests.map((file) =>
      path.relative(groupDir, file).split(path.sep).join('/'),
    ),
    memory_file_paths: fileRows.map((row) => row.relative_path),
    declared_entries: declaredEntries,
    source_fingerprint: sha256Hex(
      JSON.stringify(
        fingerprintParts.sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      ),
    ),
    errors,
  };
}

export async function discoverProjectHistory(
  groups: RegisteredGroup[],
  options: {
    projectFilter?: string;
    includeConversations: boolean;
    includeNativeMemories: boolean;
    since?: string;
    until?: string;
    cutoffAt?: string;
  },
  listConversations: (
    projectId: string,
  ) => Promise<
    Array<
      Pick<Conversation, 'id' | 'created_at' | 'objective_id' | 'session_id'>
    >
  > = getConversationsForHistoryReflection,
  readConversation: (
    groupFolder: string,
    conversation: Pick<Conversation, 'id' | 'created_at' | 'session_id'>,
  ) => Promise<unknown[]> = (groupFolder, conversation) =>
    readChatTranscriptAsync(
      groupFolder,
      conversation.id,
      conversation.created_at,
    ),
): Promise<ProjectHistoryDiscovery[]> {
  const selectedGroups = groups
    .filter(
      (group) =>
        !options.projectFilter || group.folder === options.projectFilter,
    )
    .sort((a, b) => a.folder.localeCompare(b.folder));
  const nativeDiscoveries = options.includeNativeMemories
    ? await discoverNativeMemoryProjects(selectedGroups, options.projectFilter)
    : [];
  const nativeByProject = new Map(
    nativeDiscoveries.map((discovery) => [discovery.project_id, discovery]),
  );
  const result: ProjectHistoryDiscovery[] = [];
  const sourceUntil = earlierIso(options.until, options.cutoffAt);

  for (const group of selectedGroups) {
    const allConversations = options.includeConversations
      ? await listConversations(group.folder)
      : [];
    // A conversation may remain active for years, so its creation time cannot
    // establish the lower evidence boundary. First bound by the upper cutoff,
    // then, when a window is selected, retain only conversations whose
    // authoritative transcript contains evidence inside that window.
    let conversations = allConversations
      .filter((conversation) =>
        dateInRange(conversation.created_at, undefined, sourceUntil),
      )
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      );
    if (options.since || options.until) {
      const conversationsWithEvidence: typeof conversations = [];
      for (const conversation of conversations) {
        const entries = await readConversation(group.folder, conversation);
        const hasEvidence = normalizeHistoryMessages(
          conversation,
          entries,
        ).some((message) =>
          dateInRange(message.created_at, options.since, sourceUntil),
        );
        if (hasEvidence) conversationsWithEvidence.push(conversation);
      }
      conversations = conversationsWithEvidence;
    }
    const native = nativeByProject.get(group.folder);
    if (conversations.length === 0 && !native) continue;
    const nativeFingerprint = native?.source_fingerprint ?? sha256Hex('[]');
    result.push({
      project_id: group.folder,
      group_dir: getGroupDir(group.folder),
      import_manifests: native?.import_manifests ?? [],
      memory_file_paths: native?.memory_file_paths ?? [],
      declared_entries: native?.declared_entries ?? 0,
      source_fingerprint: projectHistorySourceFingerprint(
        conversations,
        nativeFingerprint,
      ),
      errors: native?.errors ?? [],
      conversation_count: conversations.length,
      sources: {
        conversations: options.includeConversations,
        native_memories: options.includeNativeMemories,
      },
    });
  }
  return result;
}

export function historyReviewFingerprint(
  manifest: HistoryReflectionManifest,
): string {
  const { applied_at: _appliedAt, ...withoutAppliedAt } = manifest;
  return sha256Hex(
    JSON.stringify({
      ...withoutAppliedAt,
      status: 'preview',
    }),
  );
}

/**
 * Batch files live in agent-writable artifacts and name the groups later
 * swept by recovery, so a project id must be exactly one safe path segment.
 */
const projectHistoryBatchSchema = z.looseObject({
  batch_version: z.number(),
  projects: z.array(
    z.looseObject({
      project_id: z
        .string()
        .regex(/^[A-Za-z0-9._-]+$/)
        .refine((id) => id !== '.' && id !== '..'),
    }),
  ),
});

export function readProjectHistoryBatch(
  filePath: string,
): ProjectHistoryBatchManifest {
  const target = path.resolve(filePath);
  const read = readGroupFileSync(target, { maxBytes: MAX_MEMORY_STATE_BYTES });
  if (!read) throw new GroupFsError('not_found', `Not found: ${target}`);
  const parsed: unknown = JSON.parse(read.data.toString('utf8'));
  const checked = projectHistoryBatchSchema.safeParse(parsed);
  if (!checked.success) {
    logger.warn(
      { batch: path.basename(target), issues: checked.error.issues.length },
      'Skipping malformed project-history batch',
    );
    throw new Error(
      `Malformed project-history batch: ${path.basename(target)}`,
    );
  }
  return parsed as ProjectHistoryBatchManifest;
}

export function writeProjectHistoryBatch(
  filePath: string,
  manifest: ProjectHistoryBatchManifest,
): void {
  writeGroupFileSync(
    path.resolve(filePath),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mkdirs: true },
  );
}
