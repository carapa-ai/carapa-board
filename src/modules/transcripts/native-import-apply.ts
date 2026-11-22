import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  insertImportedConversation,
  type ExternalRunCostInsert,
} from '../../db/external-run-costs.js';
import type { conversations } from '../../db/schema.js';
import { chatTranscriptPath, getGroupDir } from '../../group-dir.js';
import type { NativeImportV1Run } from './native-run-v1.js';
import {
  ensureImportDir,
  installNativeV1Pair,
  removeImportFile,
} from './native-v1-import.js';
import {
  appendTranscriptLines,
  deleteTranscriptUnderLockAsync,
  withTranscriptLock,
} from './transcript-append-service.js';

export type NativeImportApplyResult =
  | { status: 'imported' }
  | { status: 'orphanTranscript'; transcriptPath: string };

export type NativeImportApplyInput = {
  projectId: string;
  objectiveId?: string | null;
  conversationId: string;
  v1Runs: NativeImportV1Run[];
  transcriptEntries: unknown[];
  conversation: typeof conversations.$inferInsert;
  runRows: ExternalRunCostInsert[];
  insertConversation?: typeof insertImportedConversation;
};

class OrphanTranscriptError extends Error {}

/** Path the native import writes (and checks for a pre-existing) transcript at. */
export function nativeImportTranscriptPath(
  projectId: string,
  objectiveId: string | null | undefined,
  conversationId: string,
): string {
  return chatTranscriptPath(
    projectId,
    objectiveId || undefined,
    conversationId,
  );
}

/**
 * Install one native conversation: V1 pairs, chat transcript, then the
 * conversation row. A failure removes only the files this call created; a
 * transcript that already exists is never overwritten or deleted.
 */
export async function applyNativeConversationImport(
  input: NativeImportApplyInput,
): Promise<NativeImportApplyResult> {
  const { projectId, conversationId } = input;
  const insertConversation =
    input.insertConversation ?? insertImportedConversation;
  const transcriptPath = nativeImportTranscriptPath(
    projectId,
    input.objectiveId,
    conversationId,
  );
  await ensureImportDir(path.dirname(transcriptPath));
  const v1TranscriptDir = path.join(
    getGroupDir(projectId),
    'session-transcripts',
  );
  await ensureImportDir(v1TranscriptDir);
  const nonce = `bulk-import-${process.pid}-${Date.now()}`;
  const installedV1Paths: string[] = [];
  // Set under the transcript lock once the file is known not to exist, so any
  // file at transcriptPath afterwards was created by this call.
  let transcriptCreatedHere = false;
  let conversationCommitted = false;
  try {
    for (const run of input.v1Runs) {
      const installed = await installNativeV1Pair(run, v1TranscriptDir, nonce);
      installedV1Paths.push(...installed.createdPaths);
    }
    await appendTranscriptLines(transcriptPath, input.transcriptEntries, () => {
      if (existsSync(transcriptPath)) throw new OrphanTranscriptError();
      transcriptCreatedHere = true;
    });
    const inserted = await insertConversation(
      input.conversation,
      input.runRows,
    );
    if (!inserted) {
      throw new Error(
        `Conversation ${conversationId} was imported concurrently`,
      );
    }
    conversationCommitted = true;
    return { status: 'imported' };
  } catch (error) {
    if (!conversationCommitted) {
      if (transcriptCreatedHere) {
        try {
          await withTranscriptLock(transcriptPath, () =>
            deleteTranscriptUnderLockAsync(transcriptPath),
          );
        } catch (cleanupError) {
          console.error(
            `Failed to remove transcript ${transcriptPath} after a failed import: ${cleanupError}`,
          );
        }
      }
      await Promise.all(
        installedV1Paths.map((file) =>
          removeImportFile(file).catch((cleanupError) => {
            console.error(
              `Failed to remove ${file} after a failed import: ${cleanupError}`,
            );
          }),
        ),
      );
    }
    if (error instanceof OrphanTranscriptError) {
      return { status: 'orphanTranscript', transcriptPath };
    }
    throw error;
  }
}

/**
 * Apply each import independently, in order. A session that throws is reported
 * as `failed` (after its own cleanup) and does not stop later sessions.
 */
export async function applyNativeConversationBatch(
  inputs: NativeImportApplyInput[],
): Promise<
  Array<NativeImportApplyResult | { status: 'failed'; error: unknown }>
> {
  const results: Array<
    NativeImportApplyResult | { status: 'failed'; error: unknown }
  > = [];
  for (const input of inputs) {
    try {
      results.push(await applyNativeConversationImport(input));
    } catch (error) {
      results.push({ status: 'failed', error });
    }
  }
  return results;
}
