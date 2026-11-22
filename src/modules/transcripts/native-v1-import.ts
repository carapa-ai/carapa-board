import fs from 'node:fs/promises';
import path from 'node:path';

import type { ExternalRunCostInsert } from '../../db/external-run-costs.js';
import { openParentDir, removeAt } from '../../lib/group-fs.js';
import { sha256Hex } from '../../lib/hash.js';
import {
  archivedCarapaRunV1Paths,
  projectCarapaRunV1Entries,
  readCarapaRunV1Pair,
  summarizeCarapaRunV1,
} from './carapa-run-v1.js';
import type { NativeImportV1Run } from './native-run-v1.js';

export class NativeV1ImportConflictError extends Error {
  constructor(readonly runId: string) {
    super(`Stored V1 run ${runId} conflicts with this native conversation`);
    this.name = 'NativeV1ImportConflictError';
  }
}

export function nativeV1ExternalRunRows(
  runs: NativeImportV1Run[],
  projectId: string,
  conversationId: string,
): ExternalRunCostInsert[] {
  return runs
    .filter((run) =>
      run.document.events.some(
        (event) =>
          event.type === 'usage' ||
          (event.type === 'run' &&
            (event.model !== undefined || event.metrics !== undefined)),
      ),
    )
    .map((run) => {
      const summary = summarizeCarapaRunV1(run.document);
      const costUsd = run.document.events.reduce<number | null>(
        (cost, event) =>
          event.type === 'run' && event.metrics?.costUsd !== undefined
            ? event.metrics.costUsd
            : cost,
        null,
      );
      return {
        id: run.runId,
        source: run.document.manifest.harness,
        external_session_id: summary.session_id!,
        external_turn_id: run.turnId,
        group_folder: projectId,
        conversation_id: conversationId,
        started_at: run.startedAt,
        completed_at: run.completedAt,
        model_name: summary.model_name ?? null,
        tok_total: summary.total_tokens ?? null,
        tok_input: summary.tok_input ?? null,
        tok_output: summary.tok_output ?? null,
        tok_cache_read: summary.tok_cache_read ?? null,
        tok_reasoning: summary.tok_reasoning ?? null,
        cost_usd: costUsd,
        cost_estimated: costUsd == null ? 0 : 1,
        cost_source: 'model-pricing',
      };
    });
}

/**
 * Index of the V1 event a projected row came from (ids are `v1-<index>-...`);
 * rows the projection derives from other events have their own index too.
 */
function projectedEventIndex(entryId: unknown): number | null {
  const match = /^v1-(\d+)-/.exec(String(entryId));
  return match ? Number(match[1]) : null;
}

/**
 * `legacyUserTimestamps` projects user lines the way earlier imports stored
 * them, stamped with the run time instead of the message's own time, so an
 * update can recognize those stored lines.
 */
export function projectNativeV1TranscriptEntries(
  runs: NativeImportV1Run[],
  conversationId: string,
  options: { legacyUserTimestamps?: boolean } = {},
): Record<string, unknown>[] {
  return runs.flatMap((run) => {
    const entries = projectCarapaRunV1Entries(
      run.document,
      {
        conversation_id: conversationId,
        source: run.document.manifest.harness,
        created_at: run.completedAt ?? run.startedAt,
        external_session_id: run.document.events.find(
          (event) => event.type === 'session',
        )?.id,
        external_turn_id: run.turnId,
      },
      '',
      { includeUserMessages: true },
    );
    return entries.map((entry) => {
      const eventIndex = projectedEventIndex(entry.id);
      const ownUserAt =
        entry.role === 'user' && !options.legacyUserTimestamps
          ? run.userMessageAt?.[eventIndex ?? -1]
          : undefined;
      return {
        ...entry,
        id: `imp-${sha256Hex(`${run.runId}\0${String(entry.id)}`).slice(0, 24)}`,
        created_at:
          ownUserAt ??
          (entry.role === 'user'
            ? run.startedAt
            : (run.completedAt ?? run.startedAt)),
      };
    });
  });
}

/**
 * Create `dir` (and missing parents) below a group folder, one pinned
 * no-follow directory at a time: an agent swapping a directory for a symlink
 * cannot redirect the import out of the group.
 */
export async function ensureImportDir(dir: string): Promise<void> {
  const parent = await openParentDir(path.join(dir, 'x'), { create: true });
  if (parent) await parent.dir.close();
  // Only a directory outside GROUPS_DIR (board-owned) has no pinned anchor yet.
  else await fs.mkdir(dir, { recursive: true });
}

/** Remove a file this import created, through its pinned parent directory. */
export async function removeImportFile(file: string): Promise<void> {
  const parent = await openParentDir(file);
  if (!parent) return;
  try {
    await removeAt(parent.dir, parent.name);
  } finally {
    await parent.dir.close();
  }
}

/** Atomically install and validate one archived V1 manifest/event pair. */
export async function installNativeV1Pair(
  run: NativeImportV1Run,
  transcriptDir: string,
  nonce: string,
): Promise<{ createdPaths: string[] }> {
  const finalPaths = archivedCarapaRunV1Paths(transcriptDir, run.runId);
  const temporaryPaths = {
    events: `${finalPaths.events}.${nonce}.tmp`,
    manifest: `${finalPaths.manifest}.${nonce}.tmp`,
  };
  const createdFinalPaths: string[] = [];
  const writeDurableFile = async (
    file: string,
    content: string,
  ): Promise<void> => {
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  const linkOrVerify = async (
    source: string,
    target: string,
  ): Promise<void> => {
    try {
      await fs.link(source, target);
      createdFinalPaths.push(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const [sourceContent, targetContent] = await Promise.all([
        fs.readFile(source),
        fs.readFile(target),
      ]);
      if (!sourceContent.equals(targetContent)) {
        throw new NativeV1ImportConflictError(run.runId);
      }
    }
  };
  try {
    await writeDurableFile(
      temporaryPaths.manifest,
      `${JSON.stringify(run.document.manifest)}\n`,
    );
    await writeDurableFile(
      temporaryPaths.events,
      `${run.document.events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
    readCarapaRunV1Pair(temporaryPaths, {
      expectedHarness: run.document.manifest.harness,
      requireTerminal: true,
    });
    await linkOrVerify(temporaryPaths.manifest, finalPaths.manifest);
    await linkOrVerify(temporaryPaths.events, finalPaths.events);
    readCarapaRunV1Pair(finalPaths, {
      expectedHarness: run.document.manifest.harness,
      requireTerminal: true,
    });
    const directory = await fs.open(transcriptDir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { createdPaths: [...createdFinalPaths] };
  } catch (error) {
    await Promise.all(
      createdFinalPaths.map((file) => fs.rm(file, { force: true })),
    );
    throw error;
  } finally {
    await Promise.all([
      fs.rm(temporaryPaths.events, { force: true }),
      fs.rm(temporaryPaths.manifest, { force: true }),
    ]);
  }
}
