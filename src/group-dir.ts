import path from 'path';
import { GROUPS_DIR, HOST_GROUPS_DIR } from './config.js';
import {
  restoreFromArchiveIfMissing,
  restoreFromArchiveIfMissingAsync,
  restoreFromArchiveIfMissingUnderLock,
} from './modules/transcripts/archive-restore.js';
import {
  appendTranscriptLines,
  appendTranscriptLinesUnderLock,
  readTranscriptText,
  readTranscriptTextSync,
  replaceTranscriptUnderLock,
  withTranscriptLock,
  withTranscriptLockSyncOrDefer,
} from './modules/transcripts/transcript-append-service.js';
import { lstatGroupPath, lstatGroupPathSync } from './lib/group-fs.js';
import { parseJsonl } from './lib/jsonl.js';
import type { RegisteredGroup } from './types.js';
import { logger } from './logger.js';

/** Resolver callback — set once from index.ts to avoid circular imports. */
let groupLookup: ((folder: string) => RegisteredGroup | undefined) | null =
  null;

export function setGroupLookup(
  fn: (folder: string) => RegisteredGroup | undefined,
): void {
  groupLookup = fn;
}

/**
 * Directory of a group folder for a given parent: `groups/<parent>/<folder>/`
 * for a child, `groups/<folder>/` otherwise. Lets callers name the directory a
 * project has before and after a parent change.
 */
export function groupDirFor(
  folder: string,
  parentId?: string | null,
  root: string = GROUPS_DIR,
): string {
  return parentId ? path.join(root, parentId, folder) : path.join(root, folder);
}

/**
 * Resolve a group folder name to its filesystem directory path.
 * Children with a parentId are nested: groups/<parent>/<folder>/
 * All others remain flat: groups/<folder>/
 */
export function getGroupDir(folder: string): string {
  return groupDirFor(folder, groupLookup?.(folder)?.parentId);
}

/**
 * Like getGroupDir but returns the host-side path suitable for Docker bind mounts.
 * When the board runs inside a container, GROUPS_DIR is /app/groups — not valid
 * as a bind mount source. HOST_GROUPS_DIR resolves to the real host path.
 */
export function getHostGroupDir(folder: string): string {
  return groupDirFor(folder, groupLookup?.(folder)?.parentId, HOST_GROUPS_DIR);
}

/**
 * Derive a YYYY-MM-DD date string from the epoch-ms embedded in an id such as
 * `task-1777812859778-abc` or `conv-1780212455017-xz0m56`. Returns null when no
 * 13-digit epoch is present (e.g. legacy uuid-style ids), so callers fall back
 * to the undated filename.
 */
export function dateFromId(id: string | undefined): string | null {
  if (!id) return null;
  const m = id.match(/(\d{13})/);
  if (!m) return null;
  const d = new Date(parseInt(m[1], 10));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Build the human-readable transcript basename for an id: the legacy basename
 * prefixed with the conversation/task creation date (e.g.
 * `2026-05-31-chat-conv-….output.jsonl`). Falls back to the undated basename
 * when the id carries no epoch.
 */
export function datedTranscriptName(
  legacyBasename: string,
  id: string | undefined,
): string {
  const date = dateFromId(id);
  return date ? `${date}-${legacyBasename}` : legacyBasename;
}

/**
 * Resolve a transcript file path inside `dir`: the dated name when the id
 * carries a creation epoch, otherwise the plain basename.
 */
export function resolveTranscriptFile(
  dir: string,
  legacyBasename: string,
  id: string | undefined,
): string {
  return path.join(
    dir,
    id ? datedTranscriptName(legacyBasename, id) : legacyBasename,
  );
}

/** Get the host-side path for a chat conversation's transcript. */
export function chatTranscriptPath(
  group_folder: string,
  session_id?: string,
  conversation_id?: string,
): string {
  const dir = path.join(getGroupDir(group_folder), 'transcripts');
  const id = conversation_id ?? session_id;
  return resolveTranscriptFile(dir, `chat-${id}.output.jsonl`, id);
}

/** Cheap change marker (size and mtime) of a chat transcript; '-' when absent. */
export async function chatTranscriptStatKey(
  group_folder: string,
  conversation_id: string,
): Promise<string> {
  const stat = await lstatGroupPath(
    chatTranscriptPath(group_folder, undefined, conversation_id),
  );
  return stat ? `${stat.size}:${stat.mtimeMs}` : '-';
}

/**
 * Candidate in-archive member names for a chat transcript. Chat transcripts
 * are stored under `chat-<convId>.output.jsonl` (or its dated variant). The
 * archive sweep walks `transcripts/*.jsonl`, so both names are valid
 * members depending on the era in which the file was archived.
 */
export function chatArchiveMemberNames(conv_id: string): string[] {
  const legacy = `chat-${conv_id}.output.jsonl`;
  const dated = datedTranscriptName(legacy, conv_id);
  return dated === legacy ? [legacy] : [dated, legacy];
}

function chatArchiveHint(conv_id: string): string | null {
  const date = dateFromId(conv_id);
  return date ? `${date}.tar.gz` : null;
}

export function chatArchiveLowerBound(
  conv_id: string,
  createdAt?: string | null,
): string | null {
  const createdDate = createdAt ? new Date(createdAt) : null;
  if (createdDate && !Number.isNaN(createdDate.getTime())) {
    return `${createdDate.toISOString().slice(0, 10)}.tar.gz`;
  }
  return chatArchiveHint(conv_id);
}

/**
 * Read a chat conversation's raw transcript JSONL.
 * Returns an array of parsed JSON objects (one per JSONL line).
 * Returns empty array if the transcript file doesn't exist.
 *
 * If the live file is missing or empty, transparently restore it from the
 * project's `transcripts/archive/*.tar.gz` bundles so archived conversations
 * are not empty. The restore is a round-trip: the file is written back to
 * disk, so subsequent reads hit the fast path and any append lands on the
 * restored history.
 */
export function readChatTranscript(
  group_folder: string,
  conversation_id: string,
  createdAt?: string | null,
): unknown[] {
  const filePath = chatTranscriptPath(group_folder, undefined, conversation_id);
  let needsRestore = true;
  try {
    // lstat through the pinned parent: a planted symlink is never followed
    // (the read below refuses it).
    needsRestore = (lstatGroupPathSync(filePath)?.size ?? 0) === 0;
  } catch {
    needsRestore = true;
  }
  if (needsRestore) {
    // Best-effort round-trip restore from the project archive. After this the
    // live file exists with content, so subsequent reads skip the restore.
    restoreFromArchiveIfMissing(
      path.join(getGroupDir(group_folder), 'transcripts', 'archive'),
      filePath,
      chatArchiveMemberNames(conversation_id),
      chatArchiveLowerBound(conversation_id, createdAt),
    );
    try {
      if (!lstatGroupPathSync(filePath)) return [];
    } catch {
      return [];
    }
  }
  const read = readTranscriptTextSync(filePath);
  return read ? parseJsonl(read.content) : [];
}

/**
 * Non-blocking transcript reader for HTTP routes. Archive lookup/extraction is
 * awaited from child processes so the server can keep serving UI and websocket
 * traffic while an old archive is searched.
 */
export async function readChatTranscriptAsync(
  group_folder: string,
  conversation_id: string,
  createdAt?: string | null,
): Promise<unknown[]> {
  const filePath = chatTranscriptPath(group_folder, undefined, conversation_id);
  let needsRestore = true;
  try {
    needsRestore = ((await lstatGroupPath(filePath))?.size ?? 0) === 0;
  } catch {
    needsRestore = true;
  }
  if (needsRestore) {
    await restoreFromArchiveIfMissingAsync(
      path.join(getGroupDir(group_folder), 'transcripts', 'archive'),
      filePath,
      chatArchiveMemberNames(conversation_id),
      chatArchiveLowerBound(conversation_id, createdAt),
    );
  }
  const read = await readTranscriptText(filePath);
  return read ? parseJsonl(read.content) : [];
}

/**
 * Read only an already-live chat transcript without restoring archived data.
 * List endpoints use this for optional metadata such as cost totals: restoring
 * dozens of old transcripts while paginating a sidebar is both unnecessary
 * and expensive. Opening a conversation still uses readChatTranscriptAsync()
 * and performs the normal archive round-trip.
 */
export async function readLiveChatTranscriptAsync(
  group_folder: string,
  conversation_id: string,
): Promise<unknown[]> {
  const filePath = chatTranscriptPath(group_folder, undefined, conversation_id);
  const read = await readTranscriptText(filePath);
  return read ? parseJsonl(read.content) : [];
}

/** Get the host-side path for a task's transcript. */
export function outputTranscriptPath(
  group_folder: string,
  task_id: string,
): string {
  const dir = path.join(getGroupDir(group_folder), 'transcripts');
  return resolveTranscriptFile(dir, `${task_id}.output.jsonl`, task_id);
}

/**
 * Append a raw entry to a chat conversation's transcript file.
 *
 * If the live file is missing (i.e. the conversation was swept to the
 * archive), restore it from the project archive BEFORE appending. Otherwise
 * the new entry would land on a fresh empty file and orphan the archived
 * turns.
 */
export function appendChatTranscriptEntry(
  group_folder: string,
  conversation_id: string,
  entry: unknown,
): void {
  try {
    // The append creates the transcripts directory itself, pinned.
    const filePath = chatTranscriptPath(
      group_folder,
      undefined,
      conversation_id,
    );
    withTranscriptLockSyncOrDefer(
      filePath,
      () => {
        restoreFromArchiveIfMissingUnderLock(
          path.join(getGroupDir(group_folder), 'transcripts', 'archive'),
          filePath,
          chatArchiveMemberNames(conversation_id),
          chatArchiveLowerBound(conversation_id),
        );
        appendTranscriptLinesUnderLock(filePath, [entry]);
      },
      (err) => {
        logger.warn(
          { err, group_folder, conversation_id },
          'Chat transcript append failed',
        );
      },
    );
  } catch (err) {
    // Best effort, but never silent: a lost transcript line must be visible.
    logger.warn(
      { err, group_folder, conversation_id },
      'Chat transcript append failed',
    );
  }
}

/**
 * Non-blocking chat transcript append for request paths. Writes for the same
 * transcript are serialized so concurrent callers cannot reorder JSONL lines.
 */
export function appendChatTranscriptEntryAsync(
  group_folder: string,
  conversation_id: string,
  entry: unknown,
): Promise<void> {
  const filePath = chatTranscriptPath(group_folder, undefined, conversation_id);
  // The append creates the transcripts directory itself, pinned.
  return appendTranscriptLines(filePath, [entry], () =>
    restoreFromArchiveIfMissingUnderLock(
      path.join(getGroupDir(group_folder), 'transcripts', 'archive'),
      filePath,
      chatArchiveMemberNames(conversation_id),
      chatArchiveLowerBound(conversation_id),
    ),
  )
    .then(() => undefined)
    .catch((err) => {
      logger.warn(
        { err, group_folder, conversation_id },
        'Chat transcript append failed',
      );
    });
}

/**
 * Rewrite a chat transcript file with entries that don't match `predicate`
 * dropped. Returns the number of removed lines. No-op if the file doesn't
 * exist. The chat detail route prefers the JSONL file over the DB, so DB-
 * only deletions can leave a stale view; this gives callers a way to keep
 * the two in sync.
 */
export async function removeChatTranscriptEntries(
  group_folder: string,
  conversation_id: string,
  predicate: (entry: unknown) => boolean,
): Promise<number> {
  const filePath = chatTranscriptPath(group_folder, undefined, conversation_id);
  try {
    // Waits for another process holding the transcript lock instead of
    // returning 0 and letting the removed entries reappear from the JSONL.
    return await withTranscriptLock(filePath, () => {
      const read = readTranscriptTextSync(filePath);
      if (!read) return 0;
      const lines = read.content.split('\n');
      const kept: string[] = [];
      let removed = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          // Keep malformed lines as-is — we don't want to silently lose data.
          kept.push(line);
          continue;
        }
        if (predicate(entry)) {
          removed++;
        } else {
          kept.push(line);
        }
      }
      if (removed === 0) return 0;
      const out = kept.length > 0 ? kept.join('\n') + '\n' : '';
      replaceTranscriptUnderLock(filePath, out);
      return removed;
    });
  } catch (err) {
    logger.warn(
      { err, group_folder, conversation_id },
      'Chat transcript removal failed',
    );
    return 0;
  }
}
