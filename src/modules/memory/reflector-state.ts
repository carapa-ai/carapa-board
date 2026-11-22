import { createHash } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  memoryReflectorOperations,
  memoryReflectorRuns,
  memoryTranscriptEvidence,
} from '../../db/schema.js';
import type {
  MemoryEvidenceReference,
  TranscriptEvidenceMessage,
} from './execution-context.js';

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('base64url');
}

export function reflectorRunId(parts: {
  projectId: string;
  transcriptPath: string;
  transcriptFingerprint: string;
  byteOffset: number;
  profile: string;
  mode: string;
}): string {
  return `mrr-${digest(
    parts.projectId,
    parts.transcriptPath,
    parts.transcriptFingerprint,
    String(parts.byteOffset),
    parts.profile,
    parts.mode,
  ).slice(0, 32)}`;
}

export async function ensureReflectorRun(args: {
  id: string;
  projectId: string;
  transcriptPath: string;
  transcriptFingerprint: string;
  byteOffset: number;
  profile: string;
  mode: 'live' | 'preview';
  totalChunks: number;
  originScopeKnown?: number;
  originObjectiveId?: string | null;
  originConversationId?: string | null;
  workspaceRoot?: string | null;
  sandboxStack?: string | null;
  sandboxService?: string | null;
  sandboxInstance?: string | null;
  sandboxWorkspacePath?: string | null;
}) {
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .insert(memoryReflectorRuns)
    .values({
      ...args,
      status: 'pending',
      nextChunkIndex: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    })
    .onConflictDoNothing();
  return (
    await drizzleDbRef.current
      .select()
      .from(memoryReflectorRuns)
      .where(eq(memoryReflectorRuns.id, args.id))
      .limit(1)
  )[0];
}

export async function getReflectorRun(runId: string) {
  return (
    await drizzleDbRef.current
      .select()
      .from(memoryReflectorRuns)
      .where(eq(memoryReflectorRuns.id, runId))
      .limit(1)
  )[0];
}

/** Widen an unstarted durable admission when another source turn arrives. */
export async function widenPendingReflectorRun(
  runId: string,
  args: {
    transcriptFingerprint: string;
    byteOffset: number;
    totalChunks: number;
    originScopeKnown: number;
    originObjectiveId: string | null;
    originConversationId: string | null;
    workspaceRoot: string | null;
    sandboxStack: string | null;
    sandboxService: string | null;
    sandboxInstance: string | null;
    sandboxWorkspacePath: string | null;
  },
) {
  const rows = await drizzleDbRef.current
    .update(memoryReflectorRuns)
    .set({ ...args, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(memoryReflectorRuns.id, runId),
        eq(memoryReflectorRuns.status, 'pending'),
        eq(memoryReflectorRuns.nextChunkIndex, 0),
      ),
    )
    .returning();
  return rows[0];
}

/** Atomically claim an unfinished run before any chunk is executed. */
export async function claimReflectorRun(
  runId: string,
  leaseToken: string,
  options: { now?: Date; leaseMs?: number } = {},
) {
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  const leaseExpiresAt = new Date(
    nowDate.getTime() + (options.leaseMs ?? 20 * 60_000),
  ).toISOString();
  const rows = await drizzleDbRef.current
    .update(memoryReflectorRuns)
    .set({
      status: 'processing',
      leaseToken,
      leaseExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(memoryReflectorRuns.id, runId),
        ne(memoryReflectorRuns.status, 'completed'),
        or(
          ne(memoryReflectorRuns.status, 'processing'),
          eq(memoryReflectorRuns.leaseToken, leaseToken),
          isNull(memoryReflectorRuns.leaseExpiresAt),
          lt(memoryReflectorRuns.leaseExpiresAt, now),
        ),
      ),
    )
    .returning();
  return rows[0];
}

/**
 * Reclaim an orphaned explicit-preview run after its owning batch lease was
 * recovered at Board startup. Live reflector runs retain their normal lease
 * expiry semantics; the preview identity and fingerprint keep this escape
 * hatch scoped to the recovered batch's run.
 */
export async function reclaimPreviewReflectorRun(
  runId: string,
  previewId: string,
  transcriptFingerprint: string,
): Promise<boolean> {
  if (!transcriptFingerprint.endsWith(`:${previewId}`)) return false;
  const changed = await drizzleDbRef.current
    .update(memoryReflectorRuns)
    .set({
      status: 'pending',
      error: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date().toISOString(),
      completedAt: null,
    })
    .where(
      and(
        eq(memoryReflectorRuns.id, runId),
        eq(memoryReflectorRuns.mode, 'preview'),
        eq(memoryReflectorRuns.status, 'processing'),
        eq(memoryReflectorRuns.transcriptFingerprint, transcriptFingerprint),
      ),
    )
    .returning();
  return changed.length === 1;
}

/** Reopen a completed preview whose durable state still contains failed chunks. */
export async function reopenCompletedPreviewReflectorRun(
  runId: string,
  transcriptFingerprint: string,
  nextChunkIndex: number,
) {
  const rows = await drizzleDbRef.current
    .update(memoryReflectorRuns)
    .set({
      status: 'pending',
      nextChunkIndex,
      error: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date().toISOString(),
      completedAt: null,
    })
    .where(
      and(
        eq(memoryReflectorRuns.id, runId),
        eq(memoryReflectorRuns.mode, 'preview'),
        eq(memoryReflectorRuns.status, 'completed'),
        eq(memoryReflectorRuns.transcriptFingerprint, transcriptFingerprint),
      ),
    )
    .returning();
  return rows[0];
}

export async function checkpointReflectorRun(
  runId: string,
  leaseToken: string,
  nextChunkIndex: number,
  totalChunks: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const complete = nextChunkIndex >= totalChunks;
  const changed = await drizzleDbRef.current
    .update(memoryReflectorRuns)
    .set({
      nextChunkIndex,
      // Progress ends a failure streak: dead-lettering counts consecutive failures.
      failureCount: 0,
      status: complete ? 'completed' : 'processing',
      leaseToken: complete ? null : leaseToken,
      leaseExpiresAt: complete
        ? null
        : new Date(Date.now() + 20 * 60_000).toISOString(),
      updatedAt: now,
      completedAt: complete ? now : null,
    })
    .where(
      and(
        eq(memoryReflectorRuns.id, runId),
        eq(memoryReflectorRuns.status, 'processing'),
        eq(memoryReflectorRuns.leaseToken, leaseToken),
      ),
    )
    .returning();
  return changed.length === 1;
}

export async function failReflectorRun(
  runId: string,
  leaseToken: string,
  error: string,
  options: { countFailure?: boolean } = {},
): Promise<boolean> {
  const changed = await drizzleDbRef.current
    .update(memoryReflectorRuns)
    .set({
      status: 'error',
      error: error.slice(0, 2000),
      ...(options.countFailure === false
        ? {}
        : { failureCount: sql`${memoryReflectorRuns.failureCount} + 1` }),
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(memoryReflectorRuns.id, runId),
        eq(memoryReflectorRuns.status, 'processing'),
        eq(memoryReflectorRuns.leaseToken, leaseToken),
      ),
    )
    .returning();
  return changed.length === 1;
}

/**
 * Return runs held under the given lease tokens to pending so a restarted
 * process can claim them immediately. Runs under any other token are untouched.
 */
export async function releaseReflectorLeases(
  tokens: string[],
): Promise<number> {
  if (tokens.length === 0) return 0;
  const released = await drizzleDbRef.current
    .update(memoryReflectorRuns)
    .set({
      status: 'pending',
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(memoryReflectorRuns.status, 'processing'),
        inArray(memoryReflectorRuns.leaseToken, tokens),
      ),
    )
    .returning();
  return released.length;
}

/** Close an unfinished run which must never execute again, so it is not rescanned. */
export async function retireReflectorRun(
  runId: string,
  reason = 'Retired propagation run',
): Promise<boolean> {
  const changed = await drizzleDbRef.current
    .update(memoryReflectorRuns)
    .set({
      status: 'retired',
      error: reason.slice(0, 2000),
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(memoryReflectorRuns.id, runId),
        inArray(memoryReflectorRuns.status, ['pending', 'processing', 'error']),
      ),
    )
    .returning();
  return changed.length === 1;
}

export async function completedReflectorRunsForSource(args: {
  projectId: string;
  transcriptPath: string;
  profile: string;
}) {
  return drizzleDbRef.current
    .select()
    .from(memoryReflectorRuns)
    .where(
      and(
        eq(memoryReflectorRuns.projectId, args.projectId),
        eq(memoryReflectorRuns.transcriptPath, args.transcriptPath),
        eq(memoryReflectorRuns.profile, args.profile),
        eq(memoryReflectorRuns.mode, 'live'),
        eq(memoryReflectorRuns.status, 'completed'),
      ),
    )
    .orderBy(desc(memoryReflectorRuns.createdAt));
}

export async function failedReflectorRunsForSource(args: {
  projectId: string;
  transcriptPath: string;
  profile: string;
  byteOffset: number;
}) {
  return drizzleDbRef.current
    .select()
    .from(memoryReflectorRuns)
    .where(
      and(
        eq(memoryReflectorRuns.projectId, args.projectId),
        eq(memoryReflectorRuns.transcriptPath, args.transcriptPath),
        eq(memoryReflectorRuns.profile, args.profile),
        eq(memoryReflectorRuns.byteOffset, args.byteOffset),
        eq(memoryReflectorRuns.mode, 'live'),
        or(
          eq(memoryReflectorRuns.status, 'error'),
          eq(memoryReflectorRuns.status, 'processing'),
        ),
      ),
    )
    .orderBy(desc(memoryReflectorRuns.createdAt));
}

/** Ordered durable work that a later source trigger must not overtake. */
export async function unfinishedReflectorRunsForSource(args: {
  projectId: string;
  transcriptPath: string;
  profile: string;
}) {
  return drizzleDbRef.current
    .select()
    .from(memoryReflectorRuns)
    .where(
      and(
        eq(memoryReflectorRuns.projectId, args.projectId),
        eq(memoryReflectorRuns.transcriptPath, args.transcriptPath),
        eq(memoryReflectorRuns.profile, args.profile),
        eq(memoryReflectorRuns.mode, 'live'),
        or(
          eq(memoryReflectorRuns.status, 'pending'),
          eq(memoryReflectorRuns.status, 'error'),
          eq(memoryReflectorRuns.status, 'processing'),
        ),
      ),
    )
    .orderBy(
      asc(memoryReflectorRuns.byteOffset),
      asc(memoryReflectorRuns.createdAt),
    );
}

/** Live work to queue now or schedule for recovery when its lease expires. */
export async function recoverableReflectorRuns() {
  return drizzleDbRef.current
    .select()
    .from(memoryReflectorRuns)
    .where(
      and(
        eq(memoryReflectorRuns.mode, 'live'),
        or(
          eq(memoryReflectorRuns.status, 'pending'),
          eq(memoryReflectorRuns.status, 'error'),
          eq(memoryReflectorRuns.status, 'processing'),
        ),
      ),
    )
    .orderBy(
      asc(memoryReflectorRuns.projectId),
      asc(memoryReflectorRuns.transcriptPath),
      asc(memoryReflectorRuns.byteOffset),
      asc(memoryReflectorRuns.createdAt),
    );
}

/**
 * Unclaimed, untouched live admissions that have been idle since
 * `updatedBefore`: candidates for the periodic sweep.
 */
export async function pendingLiveReflectorRunsForSweep(args: {
  updatedBefore: string;
}) {
  return drizzleDbRef.current
    .select({
      id: memoryReflectorRuns.id,
      projectId: memoryReflectorRuns.projectId,
    })
    .from(memoryReflectorRuns)
    .where(
      and(
        eq(memoryReflectorRuns.mode, 'live'),
        eq(memoryReflectorRuns.status, 'pending'),
        isNull(memoryReflectorRuns.leaseToken),
        eq(memoryReflectorRuns.nextChunkIndex, 0),
        lt(memoryReflectorRuns.updatedAt, args.updatedBefore),
      ),
    )
    .orderBy(
      asc(memoryReflectorRuns.projectId),
      asc(memoryReflectorRuns.transcriptPath),
      asc(memoryReflectorRuns.byteOffset),
      asc(memoryReflectorRuns.createdAt),
    );
}

/** Adopt an appended transcript into an errored or expired run. */
export async function resumeReflectorRun(
  runId: string,
  transcriptFingerprint: string,
  totalChunks: number,
) {
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .update(memoryReflectorRuns)
    .set({
      transcriptFingerprint,
      totalChunks,
      status: 'pending',
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
      completedAt: null,
    })
    .where(
      and(
        eq(memoryReflectorRuns.id, runId),
        or(
          eq(memoryReflectorRuns.status, 'error'),
          and(
            eq(memoryReflectorRuns.status, 'processing'),
            or(
              isNull(memoryReflectorRuns.leaseExpiresAt),
              lt(memoryReflectorRuns.leaseExpiresAt, now),
            ),
          ),
        ),
      ),
    );
  return (
    await drizzleDbRef.current
      .select()
      .from(memoryReflectorRuns)
      .where(eq(memoryReflectorRuns.id, runId))
      .limit(1)
  )[0];
}

type ReflectorOperationRow = typeof memoryReflectorOperations.$inferSelect;

export interface BegunReflectorOperation {
  receipt: ReflectorOperationRow;
  /** True only when this call claimed a previously unused operation key. */
  created: boolean;
}

export async function beginReflectorOperation(args: {
  runId: string;
  operationKey: string;
  requestFingerprint: string;
  operation: string;
  targetMemoryId?: string | null;
  resultMemoryId?: string | null;
}): Promise<BegunReflectorOperation> {
  const id = `mro-${digest(args.runId, args.operationKey).slice(0, 32)}`;
  const now = new Date().toISOString();
  const inserted = await drizzleDbRef.current
    .insert(memoryReflectorOperations)
    .values({
      id,
      runId: args.runId,
      operationKey: args.operationKey,
      requestFingerprint: args.requestFingerprint,
      operation: args.operation,
      status: 'pending',
      targetMemoryId: args.targetMemoryId ?? null,
      resultMemoryId: args.resultMemoryId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  const receipt =
    inserted[0] ??
    (
      await drizzleDbRef.current
        .select()
        .from(memoryReflectorOperations)
        .where(
          and(
            eq(memoryReflectorOperations.runId, args.runId),
            eq(memoryReflectorOperations.operationKey, args.operationKey),
          ),
        )
        .limit(1)
    )[0];
  if (!receipt) {
    throw new Error('Unable to claim reflector memory operation');
  }
  return { receipt, created: inserted.length > 0 };
}

export async function finishReflectorOperation(
  id: string,
  status: 'completed' | 'failed',
  resultMemoryId?: string | null,
): Promise<void> {
  await drizzleDbRef.current
    .update(memoryReflectorOperations)
    .set({
      status,
      ...(resultMemoryId !== undefined ? { resultMemoryId } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(memoryReflectorOperations.id, id));
}

/** Release a pending receipt when its transition made no durable mutation. */
export async function abandonReflectorOperation(
  id: string,
  requestFingerprint: string,
): Promise<void> {
  await drizzleDbRef.current
    .delete(memoryReflectorOperations)
    .where(
      and(
        eq(memoryReflectorOperations.id, id),
        eq(memoryReflectorOperations.status, 'pending'),
        eq(memoryReflectorOperations.requestFingerprint, requestFingerprint),
      ),
    );
}

/** Associate a pending write with its resolved row before fallible follow-up work. */
export async function updateReflectorOperationResultMemoryId(
  id: string,
  resultMemoryId: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(memoryReflectorOperations)
    .set({ resultMemoryId, updatedAt: new Date().toISOString() })
    .where(eq(memoryReflectorOperations.id, id));
}

export function reflectorRequestFingerprint(value: unknown): string {
  return digest(JSON.stringify(value));
}

export function reflectorResultMemoryId(
  runId: string,
  operationKey: string,
): string {
  return `mem-ref-${digest(runId, operationKey).slice(0, 28)}`;
}

export async function recordTranscriptEvidence(args: {
  memoryId: string;
  projectId: string;
  sourceRef: string;
  references: MemoryEvidenceReference[];
  messages: Map<string, TranscriptEvidenceMessage>;
}): Promise<void> {
  const createdAt = new Date().toISOString();
  for (const reference of args.references) {
    const message = args.messages.get(reference.message_id)!;
    await drizzleDbRef.current
      .insert(memoryTranscriptEvidence)
      .values({
        id: `mte-${digest(
          args.memoryId,
          args.sourceRef,
          reference.message_id,
          reference.excerpt,
        ).slice(0, 32)}`,
        memoryId: args.memoryId,
        projectId: args.projectId,
        sourceRef: args.sourceRef,
        messageId: reference.message_id,
        messageCreatedAt: message.createdAt,
        excerpt: reference.excerpt,
        createdAt,
      })
      .onConflictDoNothing();
  }
}
