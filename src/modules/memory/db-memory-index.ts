import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { memoryAudits, memoryIndexCandidates } from '../../db/schema.js';
import { sha256Hex } from '../../lib/hash.js';
import type {
  MemoryAuditProposalEvidence,
  MemoryIndexAuditSummary,
} from './memory-audit-types.js';
import type {
  MemoryIndexCandidate,
  MemoryIndexReconciliation,
} from './memory-index.js';

export interface StoredMemoryIndexCandidate extends MemoryIndexCandidate {
  id: string;
  disposition: 'discovered' | 'create' | 'enhance' | 'covered' | 'skip';
  confidence?: number | null;
  reconciliationReason?: string | null;
  targetMemoryId?: string | null;
  evidence: MemoryAuditProposalEvidence[];
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseCandidate(row: any): StoredMemoryIndexCandidate {
  return {
    id: row.id,
    candidateId: row.candidate_key,
    content: row.content,
    memoryType: row.memory_type,
    importance: row.importance,
    tags: parseJsonArray<string>(row.tags),
    retrievalValue: row.retrieval_value,
    reason: row.reason,
    validFrom: row.valid_from,
    evidence: parseJsonArray<MemoryAuditProposalEvidence>(row.evidence),
    disposition: row.disposition,
    confidence: row.confidence,
    reconciliationReason: row.reconciliation_reason,
    targetMemoryId: row.target_memory_id,
  };
}

export async function beginMemoryIndexCollection(
  auditId: string,
): Promise<string> {
  const token = `mic_${randomUUID()}_${randomUUID()}`;
  const now = new Date().toISOString();
  await drizzleDbRef.current.transaction(async (tx: any) => {
    await tx
      .delete(memoryIndexCandidates)
      .where(eq(memoryIndexCandidates.audit_id, auditId));
    await tx
      .update(memoryAudits)
      .set({
        index_collector_token_hash: sha256Hex(token),
        index_collector_finished_at: null,
        index_collector_summary: null,
        index_collector_inspected_areas: null,
        updated_at: now,
      })
      .where(
        and(
          eq(memoryAudits.id, auditId),
          eq(memoryAudits.mode, 'index'),
          eq(memoryAudits.status, 'running'),
        ),
      );
  });
  return token;
}

export async function resolveMemoryIndexCollector(
  projectId: string,
  token: string,
): Promise<{ auditId: string; verifiedAt: string }> {
  const rows = await drizzleDbRef.current
    .select({
      id: memoryAudits.id,
      started_at: memoryAudits.started_at,
      created_at: memoryAudits.created_at,
    })
    .from(memoryAudits)
    .where(
      and(
        eq(memoryAudits.project_id, projectId),
        eq(memoryAudits.mode, 'index'),
        eq(memoryAudits.status, 'running'),
        eq(memoryAudits.index_collector_token_hash, sha256Hex(token)),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('Index collector token is invalid or expired');
  return {
    auditId: row.id,
    verifiedAt: row.started_at ?? row.created_at,
  };
}

export async function storeMemoryIndexCandidate(args: {
  auditId: string;
  candidate: MemoryIndexCandidate;
  evidence: MemoryAuditProposalEvidence[];
}): Promise<{ id: string; created: boolean }> {
  const existing = await drizzleDbRef.current
    .select()
    .from(memoryIndexCandidates)
    .where(
      and(
        eq(memoryIndexCandidates.audit_id, args.auditId),
        eq(memoryIndexCandidates.candidate_key, args.candidate.candidateId),
      ),
    )
    .limit(1);
  const fingerprint = sha256Hex(
    JSON.stringify({
      content: args.candidate.content,
      type: args.candidate.memoryType,
      evidence: args.evidence.map((file) => [file.path, file.file_sha256]),
    }),
  );
  const id = `mic-${sha256Hex(`${args.auditId}:${args.candidate.candidateId}`).slice(0, 32)}`;
  if (existing[0]) {
    const prior = parseCandidate(existing[0]);
    const priorFingerprint = sha256Hex(
      JSON.stringify({
        content: prior.content,
        type: prior.memoryType,
        evidence: prior.evidence.map((file) => [file.path, file.file_sha256]),
      }),
    );
    if (priorFingerprint !== fingerprint) {
      throw new Error(
        `Candidate key ${args.candidate.candidateId} was reused with different content`,
      );
    }
    return { id: existing[0].id, created: false };
  }
  const counts = await drizzleDbRef.current
    .select({ count: sql<number>`count(*)` })
    .from(memoryIndexCandidates)
    .where(eq(memoryIndexCandidates.audit_id, args.auditId));
  if (Number(counts[0]?.count ?? 0) >= 50) {
    throw new Error('This index audit already has the maximum 50 candidates');
  }
  const now = new Date().toISOString();
  await drizzleDbRef.current.insert(memoryIndexCandidates).values({
    id,
    audit_id: args.auditId,
    candidate_key: args.candidate.candidateId,
    content: args.candidate.content,
    memory_type: args.candidate.memoryType,
    importance: args.candidate.importance,
    tags: JSON.stringify(args.candidate.tags),
    retrieval_value: args.candidate.retrievalValue,
    reason: args.candidate.reason,
    valid_from: args.candidate.validFrom,
    evidence: JSON.stringify(args.evidence),
    disposition: 'discovered',
    created_at: now,
    updated_at: now,
  });
  return { id, created: true };
}

export async function finishMemoryIndexCollection(args: {
  auditId: string;
  summary: string;
  inspectedAreas: string[];
}): Promise<void> {
  await drizzleDbRef.current
    .update(memoryAudits)
    .set({
      index_collector_finished_at: new Date().toISOString(),
      index_collector_summary: args.summary,
      index_collector_inspected_areas: JSON.stringify(args.inspectedAreas),
      updated_at: new Date().toISOString(),
    })
    .where(eq(memoryAudits.id, args.auditId));
}

export async function listMemoryIndexCandidates(
  auditId: string,
): Promise<StoredMemoryIndexCandidate[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(memoryIndexCandidates)
    .where(eq(memoryIndexCandidates.audit_id, auditId));
  return rows.map(parseCandidate);
}

export async function recordMemoryIndexReconciliation(
  auditId: string,
  decisions: MemoryIndexReconciliation[],
): Promise<void> {
  await drizzleDbRef.current.transaction(async (tx: any) => {
    for (const decision of decisions) {
      await tx
        .update(memoryIndexCandidates)
        .set({
          disposition: decision.op,
          confidence: decision.confidence,
          reconciliation_reason: decision.reason,
          target_memory_id: decision.memoryId ?? null,
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(memoryIndexCandidates.audit_id, auditId),
            eq(memoryIndexCandidates.candidate_key, decision.candidateId),
          ),
        );
    }
  });
}

export async function getMemoryIndexAuditSummary(
  auditId: string,
): Promise<MemoryIndexAuditSummary> {
  const candidates = await listMemoryIndexCandidates(auditId);
  const rows = await drizzleDbRef.current
    .select({
      finished_at: memoryAudits.index_collector_finished_at,
      summary: memoryAudits.index_collector_summary,
      inspected_areas: memoryAudits.index_collector_inspected_areas,
    })
    .from(memoryAudits)
    .where(eq(memoryAudits.id, auditId))
    .limit(1);
  const audit = rows[0];
  return {
    discovered: candidates.length,
    created: candidates.filter(
      (candidate) => candidate.disposition === 'create',
    ).length,
    enhanced: candidates.filter(
      (candidate) => candidate.disposition === 'enhance',
    ).length,
    covered: candidates.filter(
      (candidate) => candidate.disposition === 'covered',
    ).length,
    skipped: candidates.filter((candidate) => candidate.disposition === 'skip')
      .length,
    finished_at: audit?.finished_at ?? null,
    summary: audit?.summary ?? null,
    inspected_areas: parseJsonArray<string>(audit?.inspected_areas),
  };
}
