import path from 'node:path';

import {
  applyImportedConversationUpdate,
  getExternalRunCostsForConversation,
  getImportedConversationState,
  type ExternalRunCostInsert,
  type ExternalRunCostPatch,
  type ExternalRunCostRow,
  type ImportedConversationPatch,
} from '../../db/external-run-costs.js';
import {
  chatArchiveLowerBound,
  chatArchiveMemberNames,
  getGroupDir,
} from '../../group-dir.js';
import {
  lstatAtSync,
  openGroupDirSync,
  openParentDirSync,
  readFileAtSync,
} from '../../lib/group-fs.js';
import {
  restoreFromArchiveIfMissing,
  restoreFromArchiveIfMissingUnderLock,
} from './archive-restore.js';
import { archivedCarapaRunV1Paths } from './carapa-run-v1.js';
import { nativeImportTranscriptPath } from './native-import-apply.js';
import type { NativeImportV1Run } from './native-run-v1.js';
import {
  ensureImportDir,
  installNativeV1Pair,
  nativeV1ExternalRunRows,
  projectNativeV1TranscriptEntries,
  removeImportFile,
} from './native-v1-import.js';
import { appendTranscriptLines } from './transcript-append-service.js';

type NativeImportStatus =
  | 'complete'
  | 'partial'
  | 'diverged'
  | 'missing_transcript';

type TokenTotals = {
  total: number | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  reasoning: number | null;
};
type RunCostSnapshot = { costUsd: number | null; tokens: TokenTotals };

export interface NativeImportComparison {
  status: NativeImportStatus;
  reasons: string[];
  conversationId: string;
  transcriptPath: string;
  transcript: {
    exists: boolean;
    messages: { native: number; stored: number };
    turns: { native: number; stored: number };
    telemetryEntries: { stored: number };
    /** Stored lines that are not part of the native export. */
    unexpectedLines: number;
  };
  timestamps: {
    lastUserAt: { native: string | null; stored: string | null };
    lastAssistantAt: { native: string | null; stored: string | null };
  };
  missingTurns: { transcript: string[]; runCosts: string[] };
  runCosts: Array<{
    turnId: string;
    native: RunCostSnapshot;
    stored: RunCostSnapshot | null;
    match: boolean;
  }>;
}

export interface NativeImportUpdateInput {
  conversationId: string;
  v1Runs: NativeImportV1Run[];
  native: {
    lastUserAt: string | null;
    lastAssistantAt: string | null;
    preview: string;
  };
}

interface NativeImportUpdatePlan {
  groupFolder: string;
  /** Native lines plus their legacy-timestamp twins: any may be stored. */
  acceptedLineSet: Set<string>;
  /** Native entries with no stored line (current or legacy form). */
  missingEntries: Record<string, unknown>[];
  missingV1Runs: NativeImportV1Run[];
  insertRuns: ExternalRunCostInsert[];
  updateRuns: Array<{
    id: string;
    turnId: string;
    patch: ExternalRunCostPatch;
  }>;
  conversationPatch: ImportedConversationPatch;
}

/** What an update writes (or, in a dry run, would write). */
interface NativeImportUpdateChanges {
  transcriptLinesMissing: number;
  v1PairsMissing: number;
  runCostsInserted: string[];
  runCostsCorrected: string[];
  conversationColumns: string[];
}

export type NativeImportUpdateResult =
  | {
      status: 'updated' | 'unchanged';
      comparison: NativeImportComparison;
      changes: NativeImportUpdateChanges;
      /** Transcript bytes this apply appended; absent when nothing was. */
      appendedRange?: { byteOffset: number; byteEndOffset: number };
    }
  | {
      status: 'refused';
      comparison: NativeImportComparison;
      reasons: string[];
    };

class UpdateRefusedError extends Error {}

const TOKEN_COLUMNS = [
  ['total', 'tok_total'],
  ['input', 'tok_input'],
  ['output', 'tok_output'],
  ['cacheRead', 'tok_cache_read'],
  ['reasoning', 'tok_reasoning'],
] as const;

function snapshot(row: ExternalRunCostInsert | ExternalRunCostRow) {
  return {
    costUsd: row.cost_usd ?? null,
    tokens: Object.fromEntries(
      TOKEN_COLUMNS.map(([key, column]) => [key, row[column] ?? null]),
    ) as TokenTotals,
  };
}

/** Postgres `real` stores a 4-byte float, so compare with float32 tolerance. */
function costsEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

function snapshotsEqual(a: RunCostSnapshot, b: RunCostSnapshot): boolean {
  return (
    costsEqual(a.costUsd, b.costUsd) &&
    TOKEN_COLUMNS.every(([key]) => a.tokens[key] === b.tokens[key])
  );
}

function isNewer(native: string | null, stored: string | null): boolean {
  if (!native) return false;
  if (!stored) return true;
  const nativeMs = Date.parse(native);
  const storedMs = Date.parse(stored);
  return Number.isFinite(nativeMs) && Number.isFinite(storedMs)
    ? nativeMs > storedMs
    : native > stored;
}

/** Largest stored transcript read for the divergence check. */
const MAX_STORED_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

function archiveDirFor(groupFolder: string): string {
  return path.join(getGroupDir(groupFolder), 'transcripts', 'archive');
}

/** Stored lines, read through the pinned parent; null when the transcript is missing. */
function readStoredLines(transcriptPath: string): string[] | null {
  const parent = openParentDirSync(transcriptPath);
  if (!parent) return null;
  let text: string;
  try {
    const read = readFileAtSync(parent.dir, parent.name, {
      maxBytes: MAX_STORED_TRANSCRIPT_BYTES,
    });
    if (!read) return null;
    text = read.data.toString('utf8');
  } finally {
    parent.dir.closeSync();
  }
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  return lines.length > 0 ? lines : null;
}

function storedTranscriptStats(lines: string[]) {
  let messages = 0;
  let telemetry = 0;
  const turns = new Set<string>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry?.type === 'message') {
        messages++;
        if (typeof entry.external_turn_id === 'string')
          turns.add(entry.external_turn_id);
      } else if (entry?.type === 'telemetry') telemetry++;
    } catch {
      // An unparsable stored line is reported as unexpected by the caller.
    }
  }
  return { messages, telemetry, turns: turns.size };
}

function v1Dir(groupFolder: string): string {
  return path.join(getGroupDir(groupFolder), 'session-transcripts');
}

function v1PairExists(groupFolder: string, runId: string): boolean {
  const paths = archivedCarapaRunV1Paths(v1Dir(groupFolder), runId);
  const dir = openGroupDirSync(groupFolder, 'session-transcripts');
  if (!dir) return false;
  try {
    return [paths.events, paths.manifest].every(
      (file) => lstatAtSync(dir, path.basename(file)) !== null,
    );
  } finally {
    dir.closeSync();
  }
}

/**
 * Comparison of a native session with its stored import, plus the writes an
 * update would make. The only write is the archive round-trip restore of a
 * swept transcript, which any read of the conversation performs too.
 */
async function planNativeImportUpdate(input: NativeImportUpdateInput): Promise<{
  comparison: NativeImportComparison;
  plan: NativeImportUpdatePlan;
}> {
  const { conversationId, v1Runs, native } = input;
  const stored = await getImportedConversationState(conversationId);
  if (!stored) throw new Error(`Conversation ${conversationId} does not exist`);
  const groupFolder = stored.group_folder;
  const transcriptPath = nativeImportTranscriptPath(
    groupFolder,
    stored.objective_id,
    conversationId,
  );

  // Native entries per turn; entry ids are scoped by run ID so per-run
  // projection is identical to projecting the whole session. `legacyLines`
  // holds the same entries as earlier imports stored them (user lines stamped
  // with the run time): a stored legacy line counts as the native line.
  const nativeByTurn = v1Runs.map((run) => {
    const entries = projectNativeV1TranscriptEntries([run], conversationId);
    return {
      turnId: run.turnId,
      entries,
      lines: entries.map((entry) => JSON.stringify(entry)),
      legacyLines: projectNativeV1TranscriptEntries([run], conversationId, {
        legacyUserTimestamps: true,
      }).map((entry) => JSON.stringify(entry)),
    };
  });
  const transcriptEntries = nativeByTurn.flatMap((turn) => turn.entries);
  const acceptedLineSet = new Set(
    nativeByTurn.flatMap((turn) => [...turn.lines, ...turn.legacyLines]),
  );
  const nativeMessages = transcriptEntries.filter(
    (entry) => entry.type === 'message',
  ).length;

  // An archived transcript is still the stored one: bring it back first, as
  // opening the conversation does, so Board lines kept in the archive are
  // compared (and refused as diverged) instead of reported as missing.
  restoreFromArchiveIfMissing(
    archiveDirFor(groupFolder),
    transcriptPath,
    chatArchiveMemberNames(conversationId),
    chatArchiveLowerBound(conversationId),
  );
  const storedLines = readStoredLines(transcriptPath);
  const storedLineSet = new Set(storedLines ?? []);
  const unexpected = (storedLines ?? []).filter(
    (line) => !acceptedLineSet.has(line),
  );
  const isStored = (turn: (typeof nativeByTurn)[number], index: number) =>
    storedLineSet.has(turn.lines[index]) ||
    storedLineSet.has(turn.legacyLines[index]);
  const missingEntries = nativeByTurn.flatMap((turn) =>
    turn.entries.filter((_, index) => !isStored(turn, index)),
  );
  const missingTranscriptTurns = nativeByTurn
    .filter((turn) => turn.entries.some((_, index) => !isStored(turn, index)))
    .map((turn) => turn.turnId);
  const stats = storedTranscriptStats(storedLines ?? []);

  const nativeRows = nativeV1ExternalRunRows(
    v1Runs,
    groupFolder,
    conversationId,
  );
  const storedRowsByTurn = new Map(
    (await getExternalRunCostsForConversation(conversationId)).map((row) => [
      row.external_turn_id,
      row,
    ]),
  );
  const insertRuns: ExternalRunCostInsert[] = [];
  const updateRuns: NativeImportUpdatePlan['updateRuns'] = [];
  const runCosts: NativeImportComparison['runCosts'] = [];
  const costReasons: string[] = [];
  for (const row of nativeRows) {
    const storedRow = storedRowsByTurn.get(row.external_turn_id);
    const nativeSnapshot = snapshot(row);
    const storedSnapshot = storedRow ? snapshot(storedRow) : null;
    const match =
      storedSnapshot !== null && snapshotsEqual(nativeSnapshot, storedSnapshot);
    runCosts.push({
      turnId: row.external_turn_id,
      native: nativeSnapshot,
      stored: storedSnapshot,
      match,
    });
    if (!storedRow) {
      insertRuns.push(row);
      costReasons.push(`run cost missing for turn ${row.external_turn_id}`);
    } else if (!match) {
      updateRuns.push({
        id: storedRow.id,
        turnId: row.external_turn_id,
        patch: {
          cost_usd: row.cost_usd ?? null,
          cost_estimated: row.cost_estimated,
          tok_total: row.tok_total ?? null,
          tok_input: row.tok_input ?? null,
          tok_output: row.tok_output ?? null,
          tok_cache_read: row.tok_cache_read ?? null,
          tok_reasoning: row.tok_reasoning ?? null,
        },
      });
      costReasons.push(`run cost differs for turn ${row.external_turn_id}`);
    }
  }

  const userAdvanced = isNewer(native.lastUserAt, stored.last_user_at);
  const assistantAdvanced = isNewer(
    native.lastAssistantAt,
    stored.last_assistant_at,
  );
  const conversationPatch: ImportedConversationPatch = {};
  const timestampReasons: string[] = [];
  if (userAdvanced) {
    conversationPatch.last_user_at = native.lastUserAt;
    timestampReasons.push(
      stored.last_user_at
        ? 'native last user timestamp is newer than stored'
        : 'stored last user timestamp is empty',
    );
  }
  if (assistantAdvanced) {
    conversationPatch.last_assistant_at = native.lastAssistantAt;
    timestampReasons.push(
      stored.last_assistant_at
        ? 'native last assistant timestamp is newer than stored'
        : 'stored last assistant timestamp is empty',
    );
    // History reviewed outside the Board counts as read: a conversation that
    // was fully read stays read when its last reply moves forward. An unread
    // one keeps its read_at, and read_at never moves backwards.
    const fullyRead =
      stored.read_at != null &&
      !isNewer(stored.last_assistant_at, stored.read_at);
    if (fullyRead && isNewer(native.lastAssistantAt, stored.read_at)) {
      conversationPatch.read_at = native.lastAssistantAt;
    }
  }
  if (
    native.preview &&
    (!stored.preview?.trim() ||
      ((userAdvanced || assistantAdvanced) &&
        stored.preview !== native.preview))
  ) {
    conversationPatch.preview = native.preview;
  }

  const missingV1Runs = v1Runs.filter(
    (run) => !v1PairExists(groupFolder, run.runId),
  );

  const reasons: string[] = [];
  if (!storedLines) reasons.push('stored transcript is missing or empty');
  if (unexpected.length > 0) {
    let example = '';
    try {
      example = ` (e.g. id ${JSON.parse(unexpected[0]).id})`;
    } catch {
      example = ' (e.g. an unparsable line)';
    }
    reasons.push(
      `${unexpected.length} stored transcript line(s) are not in the native export${example}; the conversation was probably continued or edited after the import`,
    );
  }
  if (missingTranscriptTurns.length > 0)
    reasons.push(
      `transcript is missing lines for ${missingTranscriptTurns.length} native turn(s)`,
    );
  reasons.push(...costReasons, ...timestampReasons);
  if (conversationPatch.preview !== undefined)
    reasons.push('stored preview is empty or stale');
  if (missingV1Runs.length > 0)
    reasons.push(
      `V1 run pair missing for ${missingV1Runs.length} native turn(s)`,
    );

  const status: NativeImportStatus = !storedLines
    ? 'missing_transcript'
    : unexpected.length > 0
      ? 'diverged'
      : reasons.length > 0
        ? 'partial'
        : 'complete';

  const comparison: NativeImportComparison = {
    status,
    reasons,
    conversationId,
    transcriptPath,
    transcript: {
      exists: storedLines !== null,
      messages: { native: nativeMessages, stored: stats.messages },
      turns: { native: v1Runs.length, stored: stats.turns },
      telemetryEntries: { stored: stats.telemetry },
      unexpectedLines: unexpected.length,
    },
    timestamps: {
      lastUserAt: { native: native.lastUserAt, stored: stored.last_user_at },
      lastAssistantAt: {
        native: native.lastAssistantAt,
        stored: stored.last_assistant_at,
      },
    },
    missingTurns: {
      transcript: missingTranscriptTurns,
      runCosts: insertRuns.map((row) => row.external_turn_id),
    },
    runCosts,
  };
  return {
    comparison,
    plan: {
      groupFolder,
      acceptedLineSet,
      missingEntries,
      missingV1Runs,
      insertRuns,
      updateRuns,
      conversationPatch,
    },
  };
}

/** Read-only: explain how a stored import differs from the native session. */
export async function compareNativeImport(
  input: NativeImportUpdateInput,
): Promise<NativeImportComparison> {
  return (await planNativeImportUpdate(input)).comparison;
}

/**
 * Bring an existing import up to date with its native session. Never rewrites
 * or deletes existing transcript lines, V1 pairs, or conversation rows; refuses
 * when the stored transcript holds lines the native export does not. With
 * `apply` false, nothing is written.
 */
export async function updateNativeImport(
  input: NativeImportUpdateInput,
  options: { apply: boolean },
): Promise<NativeImportUpdateResult> {
  const { comparison, plan } = await planNativeImportUpdate(input);
  if (comparison.status === 'diverged') {
    return { status: 'refused', comparison, reasons: comparison.reasons };
  }
  const changes: NativeImportUpdateChanges = {
    transcriptLinesMissing: plan.missingEntries.length,
    v1PairsMissing: plan.missingV1Runs.length,
    runCostsInserted: plan.insertRuns.map((row) => row.external_turn_id),
    runCostsCorrected: plan.updateRuns.map((row) => row.turnId),
    conversationColumns: Object.keys(plan.conversationPatch),
  };
  if (comparison.status === 'complete') {
    return { status: 'unchanged', comparison, changes };
  }
  if (!options.apply) return { status: 'updated', comparison, changes };

  const { conversationId } = input;
  const transcriptPath = comparison.transcriptPath;
  const createdV1Paths: string[] = [];
  let transcriptAppended = false;
  let appendedRange: { byteOffset: number; byteEndOffset: number } | undefined;
  try {
    if (plan.missingV1Runs.length > 0) {
      const dir = v1Dir(plan.groupFolder);
      await ensureImportDir(dir);
      const nonce = `bulk-update-${process.pid}-${Date.now()}`;
      for (const run of plan.missingV1Runs) {
        const installed = await installNativeV1Pair(run, dir, nonce);
        createdV1Paths.push(...installed.createdPaths);
      }
    }
    if (plan.missingEntries.length > 0) {
      await ensureImportDir(path.dirname(transcriptPath));
      // Re-check divergence under the transcript lock: the Board may have
      // appended since planning.
      const appended = await appendTranscriptLines(
        transcriptPath,
        plan.missingEntries,
        () => {
          restoreFromArchiveIfMissingUnderLock(
            archiveDirFor(plan.groupFolder),
            transcriptPath,
            chatArchiveMemberNames(conversationId),
            chatArchiveLowerBound(conversationId),
          );
          const current = readStoredLines(transcriptPath) ?? [];
          if (current.some((line) => !plan.acceptedLineSet.has(line)))
            throw new UpdateRefusedError();
        },
      );
      transcriptAppended = true;
      appendedRange = appended.appendedRange;
    }
    await applyImportedConversationUpdate(conversationId, {
      conversationPatch: plan.conversationPatch,
      insertRuns: plan.insertRuns,
      updateRuns: plan.updateRuns,
    });
    return {
      status: 'updated',
      comparison,
      changes,
      ...(appendedRange ? { appendedRange } : {}),
    };
  } catch (error) {
    // Pairs created by this call are unreferenced until the transcript is
    // appended; afterwards they are kept so a re-run can finish the update.
    if (!transcriptAppended) {
      await Promise.all(createdV1Paths.map((file) => removeImportFile(file)));
    }
    if (error instanceof UpdateRefusedError) {
      const reasons = [
        'stored transcript changed during the update; it now contains lines that are not in the native export',
      ];
      return { status: 'refused', comparison, reasons };
    }
    throw error;
  }
}
