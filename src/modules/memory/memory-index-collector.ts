import { sha256Hex } from '../../lib/hash.js';
import type { MemoryAuditEvidenceClaim } from './memory-audit-types.js';
import { normalizeMemoryIndexCandidates } from './memory-index.js';
import {
  finishMemoryIndexCollection,
  resolveMemoryIndexCollector,
  storeMemoryIndexCandidate,
} from './db-memory-index.js';

const collectorLocks = new Map<string, Promise<void>>();
const collectorDiagnostics = new Map<
  string,
  { rejectedCalls: number; lastError: string }
>();

export function resetMemoryIndexCollectorDiagnostics(auditId: string): void {
  collectorDiagnostics.delete(auditId);
}

export function getMemoryIndexCollectorDiagnostics(auditId: string): {
  rejectedCalls: number;
  lastError: string | null;
} {
  const diagnostic = collectorDiagnostics.get(auditId);
  return {
    rejectedCalls: diagnostic?.rejectedCalls ?? 0,
    lastError: diagnostic?.lastError ?? null,
  };
}

async function withCollectorLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = collectorLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = prior.then(() => current);
  collectorLocks.set(key, chain);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (collectorLocks.get(key) === chain) collectorLocks.delete(key);
  }
}

export async function proposeMemoryForIndex(
  projectId: string,
  args: {
    collector_token: string;
    candidate_id: string;
    content: string;
    memory_type: string;
    importance: number;
    tags?: string[];
    retrieval_value: string;
    reason: string;
    valid_from?: string;
    evidence: MemoryAuditEvidenceClaim[];
  },
): Promise<string> {
  const collector = await resolveMemoryIndexCollector(
    projectId,
    args.collector_token,
  );
  try {
    return await withCollectorLock(collector.auditId, async () => {
      const candidate = normalizeMemoryIndexCandidates(
        { candidates: [args] },
        collector.verifiedAt,
      )[0]!;
      // Dynamic import avoids coupling the globally registered DirectLLM-only
      // tool to the audit worker during module initialization.
      const { verifyMemoryAuditEvidence } = await import('./memory-audit.js');
      const evidence = await verifyMemoryAuditEvidence(
        projectId,
        candidate.evidence,
      );
      const verifiedAt = new Date().toISOString();
      const proposalEvidence = evidence.map((file, index) => ({
        ...file,
        id: `mae-${sha256Hex(
          `${collector.auditId}:${candidate.candidateId}:${index}:${file.file_sha256}`,
        ).slice(0, 32)}`,
        verified_at: verifiedAt,
      }));
      const stored = await storeMemoryIndexCandidate({
        auditId: collector.auditId,
        candidate,
        evidence: proposalEvidence,
      });
      return `${stored.created ? 'Staged' : 'Already staged'} index candidate ${candidate.candidateId} (${stored.id}).`;
    });
  } catch (error) {
    const lastError = error instanceof Error ? error.message : String(error);
    const prior = collectorDiagnostics.get(collector.auditId);
    collectorDiagnostics.set(collector.auditId, {
      rejectedCalls: (prior?.rejectedCalls ?? 0) + 1,
      lastError,
    });
    throw error;
  }
}

export async function finishIndexCollection(
  projectId: string,
  args: {
    collector_token: string;
    summary: string;
    inspected_areas: string[];
  },
): Promise<string> {
  const collector = await resolveMemoryIndexCollector(
    projectId,
    args.collector_token,
  );
  return withCollectorLock(collector.auditId, async () => {
    const summary = args.summary.trim().slice(0, 4_000);
    const inspectedAreas = [
      ...new Set(
        args.inspected_areas.map((area) => area.trim()).filter(Boolean),
      ),
    ].slice(0, 30);
    if (!summary || !inspectedAreas.length) {
      throw new Error('finish_indexing requires a summary and inspected areas');
    }
    await finishMemoryIndexCollection({
      auditId: collector.auditId,
      summary,
      inspectedAreas,
    });
    return 'Index discovery completion recorded.';
  });
}
