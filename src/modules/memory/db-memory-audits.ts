import { randomUUID } from 'crypto';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  memoryAuditItems,
  memoryAudits,
  memoryEvidenceCertificates,
  memoryEvidenceFiles,
  memories,
} from '../../db/schema.js';
import { parseMemory } from './db-memories.js';
import type { Memory } from './types.js';
import type {
  MemoryAudit,
  MemoryAuditDisposition,
  MemoryAuditEvidenceClaim,
  MemoryAuditItem,
  MemoryAuditMode,
  MemoryAuditReport,
  MemoryAuditProposalEvidence,
  MemoryAuditReviewDecision,
  MemoryAuditStatus,
  MemoryEvidenceCertificate,
} from './memory-audit-types.js';

function parseTags(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((tag) => typeof tag === 'string')
      : null;
  } catch {
    return null;
  }
}

function parseItem(row: any): MemoryAuditItem {
  let proposalEvidence: MemoryAuditProposalEvidence[] = [];
  try {
    const parsed = JSON.parse(row.proposal_evidence ?? '[]');
    if (Array.isArray(parsed)) proposalEvidence = parsed;
  } catch {
    // Malformed proposal evidence is treated as absent and will fail apply.
  }
  return {
    ...row,
    proposed_tags: parseTags(row.proposed_tags),
    proposal_evidence: proposalEvidence,
  };
}

export async function getCurrentProjectMemoriesForAudit(
  projectId: string,
): Promise<Memory[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.group_folder, projectId),
        isNull(memories.valid_to),
        isNull(memories.superseded_by),
      ),
    )
    .orderBy(asc(memories.created_at));
  return rows.map(parseMemory).filter((memory): memory is Memory => !!memory);
}

export async function getActiveMemoryAudit(
  projectId: string,
): Promise<MemoryAudit | null> {
  const rows = await drizzleDbRef.current
    .select()
    .from(memoryAudits)
    .where(
      and(
        eq(memoryAudits.project_id, projectId),
        inArray(memoryAudits.status, [
          'queued',
          'running',
          'ready',
          'applying',
          'paused',
        ]),
      ),
    )
    .orderBy(desc(memoryAudits.created_at))
    .limit(1);
  const active = (rows[0] as MemoryAudit | undefined) ?? null;
  // Older workers, or a worker interrupted between finalization writes, may
  // leave a proposal-free audit in `ready`. There is nothing to review or
  // apply, so do not let that orphaned state block the next maintenance job.
  if (
    active?.status === 'ready' &&
    active.processed_items >= active.total_items &&
    active.proposal_items === 0
  ) {
    await setMemoryAuditStatus(active.id, 'applied', {
      processed_items: active.processed_items,
      proposal_items: 0,
      retry_count: 0,
    });
    return null;
  }
  return active;
}

export async function createMemoryAuditSnapshot(args: {
  projectId: string;
  initiatedBy: string;
  runtimeId: string;
  promptVersion: string;
  baselineFingerprint: string;
  memories: Array<{ memory: Memory; fingerprint: string }>;
  mode?: MemoryAuditMode;
}): Promise<{ audit: MemoryAudit; created: boolean }> {
  const active = await getActiveMemoryAudit(args.projectId);
  if (active) return { audit: active, created: false };
  const now = new Date().toISOString();
  const audit: MemoryAudit = {
    id: `ma-${randomUUID()}`,
    project_id: args.projectId,
    initiated_by: args.initiatedBy,
    runtime_id: args.runtimeId,
    prompt_version: args.promptVersion,
    mode: args.mode ?? 'cleanup',
    status: 'queued',
    total_items: args.memories.length,
    processed_items: 0,
    proposal_items: 0,
    cursor: 0,
    retry_count: 0,
    baseline_fingerprint: args.baselineFingerprint,
    error: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    ready_at: null,
    applied_at: null,
  };
  try {
    await drizzleDbRef.current.transaction(async (tx: any) => {
      await tx.insert(memoryAudits).values(audit);
      if (args.memories.length) {
        await tx.insert(memoryAuditItems).values(
          args.memories.map(({ memory, fingerprint }) => ({
            id: `mai-${randomUUID()}`,
            audit_id: audit.id,
            memory_id: memory.id,
            memory_fingerprint: fingerprint,
            processing_state: 'pending',
            review_decision: 'pending',
            revision: 0,
            created_at: now,
            updated_at: now,
          })),
        );
      }
    });
    return { audit, created: true };
  } catch (error) {
    const raced = await getActiveMemoryAudit(args.projectId);
    if (raced) return { audit: raced, created: false };
    throw error;
  }
}

export async function createMemoryIndexAudit(args: {
  projectId: string;
  initiatedBy: string;
  runtimeId: string;
  promptVersion: string;
  baselineFingerprint: string;
}): Promise<{ audit: MemoryAudit; created: boolean }> {
  const active = await getActiveMemoryAudit(args.projectId);
  if (active) return { audit: active, created: false };
  const now = new Date().toISOString();
  const audit: MemoryAudit = {
    id: `ma-${randomUUID()}`,
    project_id: args.projectId,
    initiated_by: args.initiatedBy,
    runtime_id: args.runtimeId,
    prompt_version: args.promptVersion,
    mode: 'index',
    status: 'queued',
    total_items: 1,
    processed_items: 0,
    proposal_items: 0,
    cursor: 0,
    retry_count: 0,
    baseline_fingerprint: args.baselineFingerprint,
    error: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    ready_at: null,
    applied_at: null,
  };
  try {
    await drizzleDbRef.current.insert(memoryAudits).values(audit);
    return { audit, created: true };
  } catch (error) {
    const raced = await getActiveMemoryAudit(args.projectId);
    if (raced) return { audit: raced, created: false };
    throw error;
  }
}

export async function completeMemoryIndexAudit(args: {
  auditId: string;
  proposals: Array<{
    id: string;
    memoryId: string;
    memoryFingerprint: string;
    disposition: 'create' | 'enhance';
    confidence: number;
    reason: string;
    retrievalValue: string;
    proposedContent: string;
    proposedMemoryType: string;
    proposedImportance: number;
    proposedTags: string[];
    proposedValidFrom: string;
    evidence: MemoryAuditProposalEvidence[];
  }>;
}): Promise<void> {
  const now = new Date().toISOString();
  await drizzleDbRef.current.transaction(async (tx: any) => {
    const existing = await tx
      .select({ id: memoryAuditItems.id })
      .from(memoryAuditItems)
      .where(eq(memoryAuditItems.audit_id, args.auditId))
      .limit(1);
    if (!existing.length && args.proposals.length) {
      await tx.insert(memoryAuditItems).values(
        args.proposals.map((proposal) => ({
          id: proposal.id,
          audit_id: args.auditId,
          memory_id: proposal.memoryId,
          memory_fingerprint: proposal.memoryFingerprint,
          processing_state: 'complete',
          disposition: proposal.disposition,
          confidence: proposal.confidence,
          reason: proposal.reason,
          retrieval_value: proposal.retrievalValue,
          proposed_content: proposal.proposedContent,
          proposed_memory_type: proposal.proposedMemoryType,
          proposed_importance: proposal.proposedImportance,
          proposed_tags: JSON.stringify(proposal.proposedTags),
          proposed_valid_from: proposal.proposedValidFrom,
          proposal_evidence: JSON.stringify(proposal.evidence),
          review_decision: 'pending',
          revision: 0,
          created_at: now,
          updated_at: now,
        })),
      );
    }
    await tx
      .update(memoryAudits)
      .set({
        status: args.proposals.length ? 'ready' : 'applied',
        processed_items: 1,
        proposal_items: args.proposals.length,
        cursor: 1,
        retry_count: 0,
        ready_at: now,
        applied_at: args.proposals.length ? null : now,
        error: null,
        updated_at: now,
      })
      .where(eq(memoryAudits.id, args.auditId));
  });
}

export async function getMemoryAudit(id: string): Promise<MemoryAudit | null> {
  const rows = await drizzleDbRef.current
    .select()
    .from(memoryAudits)
    .where(eq(memoryAudits.id, id))
    .limit(1);
  return (rows[0] as MemoryAudit | undefined) ?? null;
}

export async function listMemoryAudits(
  projectId: string,
): Promise<MemoryAudit[]> {
  return (await drizzleDbRef.current
    .select()
    .from(memoryAudits)
    .where(eq(memoryAudits.project_id, projectId))
    .orderBy(desc(memoryAudits.created_at))
    .limit(20)) as MemoryAudit[];
}

function parseActionCounts(row: Record<string, unknown>) {
  return {
    erased: Number(row.erased ?? 0),
    merged: Number(row.merged ?? 0),
    created: Number(row.created ?? 0),
    moved: Number(row.moved ?? 0),
  };
}

export async function getMemoryAuditReport(
  projectId: string,
): Promise<MemoryAuditReport> {
  const appliedCondition = sql`${memoryAuditItems.applied_at} is not null and ${memoryAuditItems.review_decision} = 'approved'`;
  const erasedCount = sql<number>`coalesce(sum(case
    when ${memoryAuditItems.applied_at} is not null
      and ${memoryAuditItems.review_decision} = 'approved'
      and ${memoryAuditItems.disposition} = 'erase' then 1
    when ${memoryAuditItems.applied_at} is not null
      and ${memoryAuditItems.review_decision} = 'delete_both'
      and ${memoryAuditItems.disposition} = 'merge' then 2
    when ${memoryAuditItems.applied_at} is not null
      and ${memoryAuditItems.review_decision} = 'delete_memory'
      and ${memoryAuditItems.disposition} in ('rewrite', 'merge', 'keep') then 1
    else 0 end), 0)`;
  const totalsRows = await drizzleDbRef.current
    .select({
      total_audits: sql<number>`count(distinct ${memoryAudits.id})`,
      last_applied_at: sql<
        string | null
      >`nullif(max(greatest(coalesce(${memoryAudits.applied_at}, ''), coalesce(${memoryAuditItems.applied_at}, ''))), '')`,
      erased: erasedCount,
      merged: sql<number>`count(*) filter (where ${appliedCondition} and ${memoryAuditItems.disposition} = 'merge')`,
      created: sql<number>`count(*) filter (where ${appliedCondition} and ${memoryAuditItems.disposition} = 'create')`,
      moved: sql<number>`count(*) filter (where ${appliedCondition} and ${memoryAuditItems.disposition} = 'move')`,
    })
    .from(memoryAudits)
    .leftJoin(memoryAuditItems, eq(memoryAuditItems.audit_id, memoryAudits.id))
    .where(eq(memoryAudits.project_id, projectId));
  const recentRows = await drizzleDbRef.current
    .select({
      id: memoryAudits.id,
      mode: memoryAudits.mode,
      status: memoryAudits.status,
      created_at: memoryAudits.created_at,
      applied_at: memoryAudits.applied_at,
      erased: erasedCount,
      merged: sql<number>`count(*) filter (where ${appliedCondition} and ${memoryAuditItems.disposition} = 'merge')`,
      created: sql<number>`count(*) filter (where ${appliedCondition} and ${memoryAuditItems.disposition} = 'create')`,
      moved: sql<number>`count(*) filter (where ${appliedCondition} and ${memoryAuditItems.disposition} = 'move')`,
    })
    .from(memoryAudits)
    .leftJoin(memoryAuditItems, eq(memoryAuditItems.audit_id, memoryAudits.id))
    .where(eq(memoryAudits.project_id, projectId))
    .groupBy(
      memoryAudits.id,
      memoryAudits.mode,
      memoryAudits.status,
      memoryAudits.created_at,
      memoryAudits.applied_at,
    )
    .orderBy(desc(memoryAudits.created_at))
    .limit(50);
  const totals = totalsRows[0] ?? {};
  return {
    project_id: projectId,
    generated_at: new Date().toISOString(),
    last_applied_at:
      typeof totals.last_applied_at === 'string'
        ? totals.last_applied_at
        : null,
    total_audits: Number(totals.total_audits ?? 0),
    totals: parseActionCounts(totals),
    audits: recentRows.map((row) => ({
      id: row.id,
      mode: row.mode as MemoryAuditMode,
      status: row.status as MemoryAuditStatus,
      created_at: row.created_at,
      applied_at: row.applied_at,
      counts: parseActionCounts(row),
    })),
  };
}

export async function listMemoryAuditItems(
  auditId: string,
): Promise<MemoryAuditItem[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(memoryAuditItems)
    .where(eq(memoryAuditItems.audit_id, auditId))
    .orderBy(asc(memoryAuditItems.created_at), asc(memoryAuditItems.id));
  return rows.map(parseItem);
}

export async function listPendingMemoryAuditItems(
  auditId: string,
  limit: number,
): Promise<MemoryAuditItem[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(memoryAuditItems)
    .where(
      and(
        eq(memoryAuditItems.audit_id, auditId),
        eq(memoryAuditItems.processing_state, 'pending'),
      ),
    )
    .orderBy(asc(memoryAuditItems.created_at), asc(memoryAuditItems.id))
    .limit(limit);
  return rows.map(parseItem);
}

export async function setMemoryAuditStatus(
  id: string,
  status: MemoryAuditStatus,
  updates: Partial<
    Pick<
      MemoryAudit,
      'error' | 'processed_items' | 'proposal_items' | 'cursor' | 'retry_count'
    >
  > = {},
): Promise<void> {
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .update(memoryAudits)
    .set({
      status,
      updated_at: now,
      ...(status === 'running' ? { started_at: now } : {}),
      ...(status === 'ready' ? { ready_at: now, error: null } : {}),
      ...(status === 'applied' ? { applied_at: now, error: null } : {}),
      // Explicit caller updates win over status defaults so a caller can
      // record an error while returning an audit to 'ready'.
      ...updates,
    })
    .where(eq(memoryAudits.id, id));
}

export async function setMemoryAuditRuntime(
  id: string,
  runtimeId: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(memoryAudits)
    .set({ runtime_id: runtimeId, updated_at: new Date().toISOString() })
    .where(eq(memoryAudits.id, id));
}

export async function completeMemoryAuditItem(args: {
  itemId: string;
  disposition: MemoryAuditDisposition;
  confidence: number;
  reason: string;
  proposedContent?: string;
  proposedMemoryType?: string;
  proposedImportance?: number;
  proposedTags?: string[];
  mergeTargetId?: string;
  targetProjectId?: string;
  retrievalValue?: string;
  proposedValidFrom?: string;
  proposalEvidence?: MemoryAuditProposalEvidence[];
  processingState?: 'complete' | 'certified';
}): Promise<void> {
  await drizzleDbRef.current
    .update(memoryAuditItems)
    .set({
      processing_state: args.processingState ?? 'complete',
      disposition: args.disposition,
      confidence: args.confidence,
      reason: args.reason,
      proposed_content: args.proposedContent ?? null,
      proposed_memory_type: args.proposedMemoryType ?? null,
      proposed_importance: args.proposedImportance ?? null,
      proposed_tags: args.proposedTags
        ? JSON.stringify(args.proposedTags)
        : null,
      merge_target_id: args.mergeTargetId ?? null,
      target_project_id: args.targetProjectId ?? null,
      retrieval_value: args.retrievalValue ?? null,
      proposed_valid_from: args.proposedValidFrom ?? null,
      proposal_evidence: args.proposalEvidence
        ? JSON.stringify(args.proposalEvidence)
        : null,
      updated_at: new Date().toISOString(),
    })
    .where(eq(memoryAuditItems.id, args.itemId));
}

export async function skipMemoryAuditBatch(args: {
  itemIds: string[];
  reason: string;
}): Promise<void> {
  if (!args.itemIds.length) return;
  await drizzleDbRef.current
    .update(memoryAuditItems)
    .set({
      processing_state: 'error',
      disposition: 'keep',
      confidence: 0,
      reason: args.reason.slice(0, 4_000),
      updated_at: new Date().toISOString(),
    })
    .where(inArray(memoryAuditItems.id, args.itemIds));
}

export async function refreshMemoryAuditProgress(
  auditId: string,
  options: { successfulBatch?: boolean } = {},
): Promise<{ processed: number; proposals: number }> {
  const rows = await drizzleDbRef.current
    .select({
      processed: sql<number>`count(*) filter (where ${memoryAuditItems.processing_state} in ('complete','certified','error'))`,
      proposals: sql<number>`count(*) filter (where ${memoryAuditItems.disposition} in ('rewrite','merge','erase','create','enhance','move'))`,
    })
    .from(memoryAuditItems)
    .where(eq(memoryAuditItems.audit_id, auditId));
  const processed = Number(rows[0]?.processed ?? 0);
  const proposals = Number(rows[0]?.proposals ?? 0);
  await drizzleDbRef.current
    .update(memoryAudits)
    .set({
      processed_items: processed,
      proposal_items: proposals,
      cursor: processed,
      // retry_count is deliberately batch-local. Once this checkpoint lands,
      // later failures belong to the next semantic cluster and get three fresh
      // attempts, including after a service restart.
      ...(options.successfulBatch ? { retry_count: 0, error: null } : {}),
      updated_at: new Date().toISOString(),
    })
    .where(eq(memoryAudits.id, auditId));
  return { processed, proposals };
}

export async function createMemoryEvidenceCertificate(args: {
  projectId: string;
  memoryId: string;
  memoryFingerprint: string;
  verdict: string;
  justification: string;
  evidenceType: 'code' | 'reasoning' | 'human';
  reflectorVersion: string;
  origin: 'automatic' | 'human';
  expiresAt?: string | null;
  files?: Array<
    MemoryAuditEvidenceClaim & {
      path: string;
      repository_root: string;
      file_sha256: string;
      excerpt_sha256: string;
      watched_scope_sha256?: string | null;
      repository_commit?: string | null;
    }
  >;
}): Promise<string> {
  const now = new Date().toISOString();
  const id = `mec-${randomUUID()}`;
  await drizzleDbRef.current.transaction(async (tx: any) => {
    await tx
      .update(memoryEvidenceCertificates)
      .set({ revoked_at: now, updated_at: now })
      .where(
        and(
          eq(memoryEvidenceCertificates.memory_id, args.memoryId),
          isNull(memoryEvidenceCertificates.revoked_at),
        ),
      );
    await tx.insert(memoryEvidenceCertificates).values({
      id,
      memory_id: args.memoryId,
      project_id: args.projectId,
      memory_fingerprint: args.memoryFingerprint,
      verdict: args.verdict,
      value_justification: args.justification,
      evidence_type: args.evidenceType,
      reflector_version: args.reflectorVersion,
      origin: args.origin,
      expires_at: args.expiresAt ?? null,
      revoked_at: null,
      created_at: now,
      updated_at: now,
    });
    if (args.files?.length) {
      await tx.insert(memoryEvidenceFiles).values(
        args.files.map((file) => ({
          id: `mef-${randomUUID()}`,
          certificate_id: id,
          repository_root: file.repository_root,
          path: file.path,
          file_sha256: file.file_sha256,
          excerpt_sha256: file.excerpt_sha256,
          watched_scope: file.watched_scope ?? null,
          watched_scope_sha256: file.watched_scope_sha256 ?? null,
          line_start: file.line_start ?? null,
          line_end: file.line_end ?? null,
          excerpt: file.excerpt.slice(0, 4000),
          repository_commit: file.repository_commit ?? null,
          verified_at: now,
        })),
      );
    }
  });
  return id;
}

export async function getActiveMemoryEvidenceCertificate(
  memoryId: string,
): Promise<MemoryEvidenceCertificate | null> {
  const rows = await drizzleDbRef.current
    .select()
    .from(memoryEvidenceCertificates)
    .where(
      and(
        eq(memoryEvidenceCertificates.memory_id, memoryId),
        isNull(memoryEvidenceCertificates.revoked_at),
      ),
    )
    .orderBy(desc(memoryEvidenceCertificates.created_at))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const files = await drizzleDbRef.current
    .select()
    .from(memoryEvidenceFiles)
    .where(eq(memoryEvidenceFiles.certificate_id, row.id));
  return { ...(row as any), files } as MemoryEvidenceCertificate;
}

export async function revokeMemoryEvidenceCertificate(
  memoryId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .update(memoryEvidenceCertificates)
    .set({ revoked_at: now, updated_at: now })
    .where(
      and(
        eq(memoryEvidenceCertificates.memory_id, memoryId),
        isNull(memoryEvidenceCertificates.revoked_at),
      ),
    );
}

export async function relocateMemoryEvidenceFile(
  evidenceFileId: string,
  repositoryRoot: string,
  filePath: string,
  watchedScope?: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(memoryEvidenceFiles)
    .set({
      repository_root: repositoryRoot,
      path: filePath,
      ...(watchedScope ? { watched_scope: watchedScope } : {}),
    })
    .where(eq(memoryEvidenceFiles.id, evidenceFileId));
}

export async function updateMemoryAuditReview(args: {
  auditId: string;
  itemId: string;
  revision: number;
  decision: MemoryAuditReviewDecision;
  reviewer: string;
  edits?: {
    reason?: string;
    proposed_content?: string;
    proposed_memory_type?: string;
    proposed_importance?: number;
    proposed_tags?: string[];
    merge_target_id?: string;
    target_project_id?: string;
    proposed_valid_from?: string;
  };
}): Promise<boolean> {
  const now = new Date().toISOString();
  const setFields: Record<string, unknown> = {
    review_decision: args.decision,
    reviewed_by: args.decision === 'pending' ? null : args.reviewer,
    reviewed_at: args.decision === 'pending' ? null : now,
    revision: args.revision + 1,
    updated_at: now,
  };
  if (args.edits?.reason !== undefined) setFields.reason = args.edits.reason;
  if (args.edits?.proposed_content !== undefined)
    setFields.proposed_content = args.edits.proposed_content;
  if (args.edits?.proposed_memory_type !== undefined)
    setFields.proposed_memory_type = args.edits.proposed_memory_type;
  if (args.edits?.proposed_importance !== undefined)
    setFields.proposed_importance = args.edits.proposed_importance;
  if (args.edits?.proposed_tags !== undefined)
    setFields.proposed_tags = JSON.stringify(args.edits.proposed_tags);
  if (args.edits?.merge_target_id !== undefined)
    setFields.merge_target_id = args.edits.merge_target_id;
  if (args.edits?.target_project_id !== undefined)
    setFields.target_project_id = args.edits.target_project_id;
  if (args.edits?.proposed_valid_from !== undefined)
    setFields.proposed_valid_from = args.edits.proposed_valid_from;
  const result = await drizzleDbRef.current
    .update(memoryAuditItems)
    .set(setFields)
    .where(
      and(
        eq(memoryAuditItems.id, args.itemId),
        eq(memoryAuditItems.audit_id, args.auditId),
        eq(memoryAuditItems.revision, args.revision),
      ),
    )
    .returning();
  return result.length === 1;
}

export async function approvePendingMemoryAuditItems(args: {
  auditId: string;
  itemIds: string[];
  reviewer: string;
}): Promise<number> {
  const itemIds = [...new Set(args.itemIds)];
  if (itemIds.length === 0) return 0;
  const now = new Date().toISOString();
  const updated = await drizzleDbRef.current
    .update(memoryAuditItems)
    .set({
      review_decision: 'approved',
      reviewed_by: args.reviewer,
      reviewed_at: now,
      revision: sql`${memoryAuditItems.revision} + 1`,
      updated_at: now,
    })
    .where(
      and(
        eq(memoryAuditItems.audit_id, args.auditId),
        inArray(memoryAuditItems.id, itemIds),
        eq(memoryAuditItems.review_decision, 'pending'),
        isNull(memoryAuditItems.applied_at),
      ),
    )
    .returning();
  return updated.length;
}

export async function markMemoryAuditItemApplied(
  itemId: string,
  error?: string,
  appliedMemoryId?: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(memoryAuditItems)
    .set({
      applied_at: error ? null : new Date().toISOString(),
      applied_memory_id: error ? null : (appliedMemoryId ?? null),
      apply_error: error ?? null,
      updated_at: new Date().toISOString(),
    })
    .where(eq(memoryAuditItems.id, itemId));
}

export async function markSkippedMemoryAuditItemDeleted(args: {
  auditId: string;
  itemId: string;
  reviewer: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await drizzleDbRef.current
    .update(memoryAuditItems)
    .set({
      review_decision: 'delete_memory',
      reviewed_by: args.reviewer,
      reviewed_at: now,
      revision: sql`${memoryAuditItems.revision} + 1`,
      applied_at: now,
      apply_error: null,
      updated_at: now,
    })
    .where(
      and(
        eq(memoryAuditItems.audit_id, args.auditId),
        eq(memoryAuditItems.id, args.itemId),
        eq(memoryAuditItems.processing_state, 'error'),
      ),
    )
    .returning();
  return rows.length === 1;
}

export async function dismissMemoryAuditItemsForDeletedMemories(args: {
  auditId: string;
  deletedMemoryIds: string[];
  exceptItemId: string;
  reviewer: string;
}): Promise<string[]> {
  const memoryIds = [...new Set(args.deletedMemoryIds)];
  if (!memoryIds.length) return [];
  const now = new Date().toISOString();
  const rows = await drizzleDbRef.current
    .update(memoryAuditItems)
    .set({
      processing_state: 'complete',
      review_decision: 'dismissed',
      reviewed_by: args.reviewer,
      reviewed_at: now,
      revision: sql`${memoryAuditItems.revision} + 1`,
      applied_at: now,
      apply_error: null,
      updated_at: now,
    })
    .where(
      and(
        eq(memoryAuditItems.audit_id, args.auditId),
        ne(memoryAuditItems.id, args.exceptItemId),
        isNull(memoryAuditItems.applied_at),
        inArray(memoryAuditItems.memory_id, memoryIds),
      ),
    )
    .returning();
  return rows.map((row) => row.id);
}

export async function resetMemoryAuditItem(
  itemId: string,
  memoryFingerprint: string,
  revision: number,
): Promise<void> {
  await drizzleDbRef.current
    .update(memoryAuditItems)
    .set({
      memory_fingerprint: memoryFingerprint,
      processing_state: 'pending',
      disposition: null,
      confidence: null,
      reason: null,
      proposed_content: null,
      proposed_memory_type: null,
      proposed_importance: null,
      proposed_tags: null,
      merge_target_id: null,
      target_project_id: null,
      review_decision: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      apply_error: null,
      applied_memory_id: null,
      revision: revision + 1,
      updated_at: new Date().toISOString(),
    })
    .where(eq(memoryAuditItems.id, itemId));
}

export async function listRecoverableMemoryAudits(): Promise<MemoryAudit[]> {
  return (await drizzleDbRef.current
    .select()
    .from(memoryAudits)
    .where(
      inArray(memoryAudits.status, ['queued', 'running']),
    )) as MemoryAudit[];
}

export async function listApplyingMemoryAudits(): Promise<MemoryAudit[]> {
  return (await drizzleDbRef.current
    .select()
    .from(memoryAudits)
    .where(eq(memoryAudits.status, 'applying'))) as MemoryAudit[];
}

/** Returns an `applying` audit to `ready`; false if it was no longer applying. */
export async function returnInterruptedMemoryAuditToReady(
  id: string,
  error: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await drizzleDbRef.current
    .update(memoryAudits)
    .set({ status: 'ready', ready_at: now, updated_at: now, error })
    .where(and(eq(memoryAudits.id, id), eq(memoryAudits.status, 'applying')))
    .returning();
  return rows.length > 0;
}
