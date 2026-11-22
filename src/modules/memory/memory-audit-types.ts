import { sha256Hex } from '../../lib/hash.js';
import type { Memory, MemoryType } from './types.js';

export const MEMORY_AUDIT_PROMPT_VERSION = 'memory-audit-v2';
export const MEMORY_INDEX_PROMPT_VERSION =
  'memory-index-v3-typed-tool-collector';
export const MEMORY_REORGANIZE_PROMPT_VERSION = 'memory-reorganize-v1';
export const MEMORY_AUDIT_KEEP_TTL_DAYS = 90;

export type MemoryAuditMode = 'cleanup' | 'index' | 'reorganize';

export type MemoryAuditStatus =
  | 'queued'
  | 'running'
  | 'ready'
  | 'applying'
  | 'applied'
  | 'paused'
  | 'failed';
export type MemoryAuditDisposition =
  | 'keep'
  | 'rewrite'
  | 'merge'
  | 'erase'
  | 'create'
  | 'enhance'
  | 'move';
export type MemoryAuditReviewDecision =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'delete_memory'
  | 'delete_both'
  | 'dismissed';
export type MemoryIndexRetrievalValue =
  | 'navigation'
  | 'pattern'
  | 'constraint'
  | 'decision'
  | 'workflow'
  | 'integration';

export interface MemoryAuditEvidenceClaim {
  repository_root: string;
  path: string;
  line_start?: number;
  line_end?: number;
  excerpt: string;
  watched_scope?: string;
}

interface MemoryAuditReflectionItem {
  memory_id: string;
  disposition: MemoryAuditDisposition;
  confidence: number;
  reason: string;
  proposed_content?: string;
  proposed_memory_type?: MemoryType;
  proposed_importance?: number;
  proposed_tags?: string[];
  merge_target_id?: string;
  target_project_id?: string;
  evidence?: MemoryAuditEvidenceClaim[];
}

export interface MemoryAuditEnvelope {
  items: MemoryAuditReflectionItem[];
}

interface MemoryEvidenceFile {
  id: string;
  certificate_id: string;
  repository_root: string;
  path: string;
  file_sha256: string;
  excerpt_sha256: string;
  watched_scope?: string | null;
  watched_scope_sha256?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  excerpt: string;
  repository_commit?: string | null;
  verified_at: string;
}

export interface MemoryAuditProposalEvidence extends MemoryAuditEvidenceClaim {
  id: string;
  file_sha256: string;
  excerpt_sha256: string;
  watched_scope_sha256?: string | null;
  repository_commit?: string | null;
  verified_at: string;
}

export interface MemoryEvidenceCertificate {
  id: string;
  memory_id: string;
  project_id: string;
  memory_fingerprint: string;
  verdict: MemoryAuditDisposition | 'human_keep';
  value_justification: string;
  evidence_type: 'code' | 'reasoning' | 'human';
  reflector_version: string;
  origin: 'automatic' | 'human';
  expires_at?: string | null;
  revoked_at?: string | null;
  created_at: string;
  updated_at: string;
  files: MemoryEvidenceFile[];
}

export interface MemoryAuditItem {
  id: string;
  audit_id: string;
  memory_id: string;
  memory_fingerprint: string;
  processing_state:
    | 'pending'
    | 'processing'
    | 'complete'
    | 'certified'
    | 'error';
  disposition?: MemoryAuditDisposition | null;
  confidence?: number | null;
  reason?: string | null;
  proposed_content?: string | null;
  proposed_memory_type?: MemoryType | null;
  proposed_importance?: number | null;
  proposed_tags?: string[] | null;
  merge_target_id?: string | null;
  target_project_id?: string | null;
  retrieval_value?: MemoryIndexRetrievalValue | null;
  proposed_valid_from?: string | null;
  proposal_evidence?: MemoryAuditProposalEvidence[];
  review_decision: MemoryAuditReviewDecision;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  revision: number;
  applied_at?: string | null;
  applied_memory_id?: string | null;
  apply_error?: string | null;
  created_at: string;
  updated_at: string;
  memory?: Memory | null;
  certificate?: MemoryEvidenceCertificate | null;
  stale?: boolean;
}

export interface MemoryAudit {
  id: string;
  project_id: string;
  initiated_by?: string | null;
  runtime_id: string;
  prompt_version: string;
  mode: MemoryAuditMode;
  status: MemoryAuditStatus;
  total_items: number;
  processed_items: number;
  proposal_items: number;
  cursor: number;
  retry_count: number;
  baseline_fingerprint: string;
  error?: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  ready_at?: string | null;
  applied_at?: string | null;
}

export interface MemoryAuditView extends MemoryAudit {
  items: MemoryAuditItem[];
  index_summary?: MemoryIndexAuditSummary | null;
  related_projects: Array<{
    id: string;
    name: string;
    relationship: string;
  }>;
  counts: {
    pending: number;
    approved: number;
    rejected: number;
    applied: number;
    applicable: number;
    skipped: number;
    delete_memory: number;
    delete_both: number;
    dismissed: number;
  };
  apply_enabled: boolean;
}

export interface MemoryIndexAuditSummary {
  discovered: number;
  created: number;
  enhanced: number;
  covered: number;
  skipped: number;
  finished_at?: string | null;
  summary?: string | null;
  inspected_areas: string[];
}

interface MemoryAuditActionCounts {
  erased: number;
  merged: number;
  created: number;
  moved: number;
}

export interface MemoryAuditReport {
  project_id: string;
  generated_at: string;
  last_applied_at?: string | null;
  total_audits: number;
  totals: MemoryAuditActionCounts;
  audits: Array<{
    id: string;
    mode: MemoryAuditMode;
    status: MemoryAuditStatus;
    created_at: string;
    applied_at?: string | null;
    counts: MemoryAuditActionCounts;
  }>;
}

export function summarizeMemoryAuditReview(
  status: MemoryAuditStatus,
  items: MemoryAuditItem[],
): Pick<MemoryAuditView, 'counts' | 'apply_enabled'> {
  const proposals = items.filter((item) =>
    ['rewrite', 'merge', 'erase', 'create', 'enhance', 'move'].includes(
      item.disposition ?? '',
    ),
  );
  const unapplied = proposals.filter((item) => !item.applied_at);
  const approved = unapplied.filter(
    (item) => item.review_decision === 'approved',
  ).length;
  const rejected = unapplied.filter(
    (item) => item.review_decision === 'rejected',
  ).length;
  const deleteBoth = unapplied.filter(
    (item) => item.review_decision === 'delete_both',
  ).length;
  const deleteMemory = unapplied.filter(
    (item) => item.review_decision === 'delete_memory',
  ).length;
  const dismissed = unapplied.filter(
    (item) => item.review_decision === 'dismissed',
  ).length;
  const selected = unapplied.filter(
    (item) => item.review_decision !== 'pending',
  );
  const counts = {
    pending: unapplied.filter((item) => item.review_decision === 'pending')
      .length,
    approved,
    rejected,
    applied: proposals.filter((item) => !!item.applied_at).length,
    applicable: approved + rejected + deleteMemory + deleteBoth + dismissed,
    skipped: items.filter(
      (item) => item.processing_state === 'error' && !item.applied_at,
    ).length,
    delete_memory: deleteMemory,
    delete_both: deleteBoth,
    dismissed,
  };
  return {
    counts,
    apply_enabled:
      ['queued', 'running', 'ready', 'paused', 'failed'].includes(status) &&
      selected.length > 0 &&
      selected.every(
        (item) =>
          !item.stale ||
          item.review_decision === 'dismissed' ||
          item.review_decision === 'delete_memory',
      ),
  };
}

export function memoryStructuralFingerprint(memory: Memory): string {
  const canonical = JSON.stringify({
    content: memory.content.trim(),
    memory_type: memory.memory_type,
    tags: [...(memory.tags ?? [])].map((tag) => tag.trim()).sort(),
    source: memory.source,
    sourceRef: memory.sourceRef ?? null,
    objective_id: memory.objective_id ?? null,
    valid_from: memory.valid_from ?? null,
    valid_to: memory.valid_to ?? null,
  });
  return sha256Hex(canonical);
}
