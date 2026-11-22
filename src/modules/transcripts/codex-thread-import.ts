import fs from 'node:fs/promises';
import { existsSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { CODEX_IMPORT_HOME } from '../../config.js';
import { logger } from '../../logger.js';
import {
  getConversation,
  insertImportedConversation,
  upsertConversationMember,
} from '../../db.js';
import { chatTranscriptPath, getGroupDir } from '../../group-dir.js';
import {
  codexSessionToCarapaRunV1,
  deterministicCodexConversationId,
  loadCodexTitles,
  parseCodexSession,
  type ParsedCodexSession,
} from './codex-session-import.js';
import {
  ensureImportDir,
  installNativeV1Pair,
  NativeV1ImportConflictError,
  nativeV1ExternalRunRows,
  projectNativeV1TranscriptEntries,
  removeImportFile,
} from './native-v1-import.js';
import {
  appendTranscriptLines,
  deleteTranscriptUnderLockAsync,
  withTranscriptLock,
} from './transcript-append-service.js';

const CODEX_THREAD_LINK =
  /^codex:\/\/threads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const MAX_CODEX_SESSION_BYTES = 128 * 1024 * 1024;

export class CodexThreadImportError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 500 = 400,
  ) {
    super(message);
    this.name = 'CodexThreadImportError';
  }
}

export function parseCodexThreadDeepLink(value: string): string | null {
  return value.trim().match(CODEX_THREAD_LINK)?.[1]?.toLowerCase() ?? null;
}

async function findSessionFiles(
  directory: string,
  fileSuffix: string,
  depth = 0,
): Promise<string[]> {
  if (depth > 6) return [];
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const matches: string[] = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(
        ...(await findSessionFiles(candidate, fileSuffix, depth + 1)),
      );
    } else if (entry.isFile() && entry.name.endsWith(fileSuffix)) {
      matches.push(candidate);
    }
  }
  return matches;
}

/** Recover only a header whose damaged item is ignored by parseCodexSession. */
function isUnusedItemCompletion(line: string): boolean {
  const item = /"item"\s*:/.exec(line);
  if (!item) return false;
  try {
    const header = JSON.parse(`${line.slice(0, item.index)}"item":null}}`);
    return (
      header?.type === 'event_msg' && header.payload?.type === 'item_completed'
    );
  } catch {
    return false;
  }
}

async function readJsonl(file: string): Promise<Record<string, any>[]> {
  const stat = await fs.stat(file);
  if (stat.size > MAX_CODEX_SESSION_BYTES) {
    throw new CodexThreadImportError(
      'The Codex thread is too large to import safely',
      413,
    );
  }
  const records: Record<string, any>[] = [];
  const raw = await fs.readFile(file, 'utf8');
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      if (isUnusedItemCompletion(line)) {
        logger.warn(
          { file, line: index + 1 },
          'Skipping malformed Codex item-completion event during import',
        );
        continue;
      }
      throw new CodexThreadImportError(
        `The Codex thread contains invalid JSONL at line ${index + 1}`,
      );
    }
  }
  return records;
}

export async function loadCodexThread(
  threadId: string,
  codexHomes: string | string[] = codexImportHomes(),
): Promise<ParsedCodexSession> {
  const sessionRoots = [
    ...new Set(
      (typeof codexHomes === 'string' ? [codexHomes] : codexHomes).map((home) =>
        path.resolve(home, 'sessions'),
      ),
    ),
  ];
  const readErrors: string[] = [];
  let foundFiles = false;
  for (const sessionRoot of sessionRoots) {
    let files: string[];
    try {
      files = await findSessionFiles(sessionRoot, `-${threadId}.jsonl`);
    } catch (error) {
      readErrors.push(
        `${sessionRoot}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    foundFiles ||= files.length > 0;
    for (const file of files.sort().reverse()) {
      const parsed = parseCodexSession(await readJsonl(file));
      if (parsed?.sessionId.toLowerCase() === threadId) {
        const titles = await loadCodexTitles(
          path.join(path.dirname(sessionRoot), 'session_index.jsonl'),
        );
        return { ...parsed, title: titles.get(threadId) };
      }
    }
  }
  if (readErrors.length) {
    throw new CodexThreadImportError(
      `Codex sessions cannot be read from ${readErrors.join('; ')}`,
      500,
    );
  }
  if (!foundFiles) {
    throw new CodexThreadImportError(
      `Codex thread ${threadId} was not found under ${sessionRoots.join(', ')}`,
      404,
    );
  }
  throw new CodexThreadImportError(
    `Codex thread ${threadId} did not match its session file`,
    409,
  );
}

/** Only Board-visible homes; repositoryLocation is a host mount specification. */
export function codexImportHomes(
  projectCodexHome?: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...new Set(
      [
        env.CODEX_IMPORT_HOME || CODEX_IMPORT_HOME,
        env.CODEX_IMPORT_AGENT_HOME ||
          (env.AGENT_HOME ? path.join(env.AGENT_HOME, '.codex') : undefined),
        projectCodexHome,
        env.CODEX_HOME,
        env.HOME ? path.join(env.HOME, '.codex') : undefined,
      ]
        .filter((home): home is string => Boolean(home))
        .map((home) => path.resolve(home)),
    ),
  ];
}

export async function importCodexThread(input: {
  threadLink: string;
  projectId: string;
  ownerUserId: string | null;
  codexHome?: string;
  projectCodexHome?: string;
}): Promise<{
  conversation: NonNullable<Awaited<ReturnType<typeof getConversation>>>;
  imported: boolean;
}> {
  const threadId = parseCodexThreadDeepLink(input.threadLink);
  if (!threadId) {
    throw new CodexThreadImportError(
      'Expected a Codex thread link such as codex://threads/<thread-id>',
    );
  }
  const conversationId = deterministicCodexConversationId(threadId);
  const existing = await getConversation(conversationId);
  if (existing) {
    if (existing.group_folder !== input.projectId) {
      throw new CodexThreadImportError(
        'This Codex thread has already been imported into another project',
        409,
      );
    }
    return { conversation: existing, imported: false };
  }

  const session = await loadCodexThread(
    threadId,
    input.codexHome ?? codexImportHomes(input.projectCodexHome),
  );
  const visibleMessages = session.messages.filter(
    (entry) => entry.type === 'message',
  );
  if (
    !session.firstUserText ||
    !visibleMessages.some((entry) => entry.role === 'assistant')
  ) {
    throw new CodexThreadImportError(
      'The Codex thread does not contain a user and assistant conversation',
      409,
    );
  }

  const title = (session.title || session.firstUserText)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const preview = session.firstUserText
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  const v1Runs = codexSessionToCarapaRunV1(session);
  if (v1Runs.length === 0) {
    throw new CodexThreadImportError(
      'The Codex thread could not be normalized into a V1 run',
      409,
    );
  }
  const transcriptEntries = projectNativeV1TranscriptEntries(
    v1Runs,
    conversationId,
  );
  const transcriptPath = chatTranscriptPath(
    input.projectId,
    undefined,
    conversationId,
  );
  try {
    await fs.access(transcriptPath);
    throw new CodexThreadImportError(
      'A transcript already exists for this Codex thread',
      409,
    );
  } catch (error) {
    if (
      error instanceof CodexThreadImportError ||
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw error;
    }
  }
  await ensureImportDir(path.dirname(transcriptPath));
  const v1TranscriptDir = path.join(
    getGroupDir(input.projectId),
    'session-transcripts',
  );
  await ensureImportDir(v1TranscriptDir);
  const nonce = `import-${process.pid}-${Date.now()}`;
  const installedV1Paths: string[] = [];
  // Set only once this request owns the transcript append. The append guard
  // runs under the transcript lock before any line is written, so a guard
  // failure means a concurrent request owns the file: that transcript must
  // survive this request's rollback. A failure after the guard passed means
  // this request may have written its own lines, which must be cleaned up.
  let transcriptWriteStarted = false;
  let conversationCommitted = false;
  try {
    for (const run of v1Runs) {
      const installed = await installNativeV1Pair(run, v1TranscriptDir, nonce);
      installedV1Paths.push(...installed.createdPaths);
    }
    await appendTranscriptLines(transcriptPath, transcriptEntries, () => {
      if (existsSync(transcriptPath)) {
        throw new CodexThreadImportError(
          'A transcript already exists for this Codex thread',
          409,
        );
      }
      transcriptWriteStarted = true;
    });
    const inserted = await insertImportedConversation(
      {
        id: conversationId,
        group_folder: input.projectId,
        preview,
        title,
        created_at: session.createdAt,
        read_at: session.lastAssistantAt || session.createdAt,
        pinned: 0,
        session_id: null,
        forked_from: null,
        use_worktree: 0,
        worktree_path: null,
        branch_name: null,
        brain_managed: 0,
        objective_id: null,
        last_agent_cmd: null,
        runtimeHarnessId: null,
        runtimeModelId: null,
        runtimeReasoning: null,
        ownerUserId: input.ownerUserId,
        last_user_at: session.lastUserAt,
        last_assistant_at: session.lastAssistantAt,
      },
      nativeV1ExternalRunRows(v1Runs, input.projectId, conversationId),
    );
    const conversation = await getConversation(conversationId);
    if (
      !inserted ||
      !conversation ||
      conversation.group_folder !== input.projectId
    ) {
      throw new CodexThreadImportError(
        'The Codex thread import conflicted with another conversation',
        409,
      );
    }
    conversationCommitted = true;
    if (input.ownerUserId) {
      await upsertConversationMember(
        input.ownerUserId,
        conversationId,
        'owner',
      );
    }
    return { conversation, imported: true };
  } catch (error) {
    if (transcriptWriteStarted && !conversationCommitted) {
      try {
        await withTranscriptLock(transcriptPath, () =>
          deleteTranscriptUnderLockAsync(transcriptPath),
        );
      } catch (cleanupError) {
        logger.warn(
          { cleanupError, transcriptPath },
          'Failed to remove transcript after Codex import failure',
        );
      }
    }
    if (!conversationCommitted) {
      await Promise.all(
        installedV1Paths.map((file) => removeImportFile(file)),
      ).catch(() => {});
    }
    if (error instanceof NativeV1ImportConflictError) {
      throw new CodexThreadImportError(error.message, 409);
    }
    throw error;
  }
}
