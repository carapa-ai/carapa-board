import { getGroupDir } from '../../group-dir.js';
import { isPathInside } from '../../lib/path-containment.js';

export type NativeImportReflectSkipReason =
  | 'too_old'
  | 'no_timestamp'
  | 'not_in_project'
  | 'not_admitted';

export type NativeImportReflectResult =
  | { status: 'admitted'; runId: string }
  | { status: 'skipped'; reason: NativeImportReflectSkipReason };

export const NATIVE_IMPORT_REFLECT_DEFAULT_MAX_AGE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Newest of the two message times (null when neither parses). */
export function newestNativeMessageAt(
  lastUserAt: string | null | undefined,
  lastAssistantAt: string | null | undefined,
): string | null {
  let newest: { at: string; ms: number } | null = null;
  for (const at of [lastUserAt, lastAssistantAt]) {
    const ms = at ? Date.parse(at) : Number.NaN;
    if (!Number.isNaN(ms) && (!newest || ms > newest.ms))
      newest = { at: at!, ms };
  }
  return newest?.at ?? null;
}

/** Why a session's newest message keeps it out of reflection, or null. */
export function nativeImportReflectAgeSkip(
  newestMessageAt: string | null,
  maxAgeDays: number,
  now: Date = new Date(),
): 'no_timestamp' | 'too_old' | null {
  const newest = newestMessageAt ? Date.parse(newestMessageAt) : Number.NaN;
  if (Number.isNaN(newest)) return 'no_timestamp';
  return now.getTime() - newest > maxAgeDays * DAY_MS ? 'too_old' : null;
}

/**
 * Durably admit one freshly imported transcript range to the live reflector.
 * Only the row is written: the running Board's periodic sweep processes it,
 * and its observer/privacy gates apply there too. The transcript must be
 * inside `projectId`'s own group directory.
 */
export async function admitNativeImportForReflection(input: {
  projectId: string;
  objectiveId: string | null;
  conversationId: string;
  transcriptPath: string;
  byteOffset: number;
  byteEndOffset: number;
  newestMessageAt: string | null;
  maxAgeDays: number;
  now?: Date;
}): Promise<NativeImportReflectResult> {
  if (
    !isPathInside(getGroupDir(input.projectId), input.transcriptPath, {
      allowRoot: false,
    })
  )
    return { status: 'skipped', reason: 'not_in_project' };
  const ageSkip = nativeImportReflectAgeSkip(
    input.newestMessageAt,
    input.maxAgeDays,
    input.now,
  );
  if (ageSkip) return { status: 'skipped', reason: ageSkip };

  // Loaded lazily so imports without --reflect never pull in the reflector.
  const { admitTranscriptMemory } = await import('../memory/tool-reflector.js');
  const admitted = await admitTranscriptMemory(
    input.projectId,
    input.transcriptPath,
    {
      profile: 'run-agent-conversation',
      conversationId: input.conversationId,
      objectiveId: input.objectiveId,
      byteOffset: input.byteOffset,
      byteEndOffset: input.byteEndOffset,
    },
  );
  return admitted
    ? { status: 'admitted', runId: admitted.runId }
    : { status: 'skipped', reason: 'not_admitted' };
}
