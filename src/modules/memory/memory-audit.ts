import path from 'path';
import {
  ackSupersededNotificationPayloads,
  getMemory,
  insertMemory,
  moveMemoryToGroup,
  updateMemory,
} from '../../db.js';
import {
  canStartBackgroundWork,
  onBackgroundWorkResumed,
  trackBackgroundWork,
} from '../../lib/background-work-gate.js';
import { sha256Hex } from '../../lib/hash.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import {
  getRuntimeCatalog,
  isDirectRuntime,
  resolveKanbanRuntimeSelection,
  resolveRuntimeSelection,
} from '../../lib/chat-agents.js';
import { logger } from '../../logger.js';
import { runContainerAgent } from '../../sandbox/process.js';
import { getGroupByFolder, registeredGroups } from '../../state-manager.js';
import { escapeRegex } from '../../utils.js';
import { getGroupStages } from '../kanban/stages.js';
import { getVectorStoreHooks } from '../vector-store/hooks.js';
import {
  prepareGroupSandbox,
  resolveSandboxPath,
  shellQuote,
} from '../fs/sandbox-fs.js';
import { getMemoryBackend } from './backend/factory.js';
import {
  historyMemoryEvalMarkedIds,
  setHistoryMemoryEvalMark,
} from './history-review.js';
import { withMemoryLifecycleLock } from './lifecycle-lock.js';
import { eraseMemoriesDurably } from './privacy-erasure.js';
import {
  beginMemoryIndexCollection,
  finishMemoryIndexCollection,
  getMemoryIndexAuditSummary,
  listMemoryIndexCandidates,
  recordMemoryIndexReconciliation,
} from './db-memory-index.js';
import {
  approvePendingMemoryAuditItems,
  completeMemoryAuditItem,
  completeMemoryIndexAudit,
  createMemoryAuditSnapshot,
  createMemoryIndexAudit,
  createMemoryEvidenceCertificate,
  dismissMemoryAuditItemsForDeletedMemories,
  getActiveMemoryAudit,
  getActiveMemoryEvidenceCertificate,
  getCurrentProjectMemoriesForAudit,
  getMemoryAudit,
  getMemoryAuditReport as getStoredMemoryAuditReport,
  listMemoryAuditItems,
  listMemoryAudits,
  listPendingMemoryAuditItems,
  listApplyingMemoryAudits,
  listRecoverableMemoryAudits,
  returnInterruptedMemoryAuditToReady,
  markMemoryAuditItemApplied,
  markSkippedMemoryAuditItemDeleted,
  refreshMemoryAuditProgress,
  relocateMemoryEvidenceFile,
  resetMemoryAuditItem,
  revokeMemoryEvidenceCertificate,
  setMemoryAuditStatus,
  setMemoryAuditRuntime,
  skipMemoryAuditBatch,
  updateMemoryAuditReview,
} from './db-memory-audits.js';
import {
  MEMORY_AUDIT_KEEP_TTL_DAYS,
  MEMORY_AUDIT_PROMPT_VERSION,
  MEMORY_INDEX_PROMPT_VERSION,
  MEMORY_REORGANIZE_PROMPT_VERSION,
  memoryStructuralFingerprint,
  summarizeMemoryAuditReview,
  type MemoryAudit,
  type MemoryAuditEnvelope,
  type MemoryAuditEvidenceClaim,
  type MemoryAuditItem,
  type MemoryAuditReport,
  type MemoryAuditReviewDecision,
  type MemoryAuditView,
  type MemoryEvidenceCertificate,
} from './memory-audit-types.js';
import type { Memory, MemoryType } from './types.js';
import {
  MEMORY_AUDIT_MAX_CLUSTER_SIZE,
  selectMemoryAuditSemanticCluster,
} from './memory-audit-clustering.js';
import {
  requestValidMemoryAuditJson,
  requestValidStructuredJson,
  structuredJsonRepairPrompt,
} from './memory-audit-json.js';
import { memoryAuditPromptForCluster } from './memory-audit-prompt.js';
import {
  MEMORY_INDEX_DISCOVERY_SCHEMA,
  MEMORY_INDEX_RECONCILIATION_SCHEMA,
  memoryIndexDiscoveryPrompt,
  memoryIndexReconciliationPrompt,
  memoryIndexToolDiscoveryPrompt,
  normalizeMemoryIndexCandidates,
  normalizeMemoryIndexReconciliation,
  parseMemoryIndexJson,
  type MemoryIndexCandidate,
} from './memory-index.js';
import {
  getMemoryIndexCollectorDiagnostics,
  resetMemoryIndexCollectorDiagnostics,
} from './memory-index-collector.js';
import {
  MEMORY_REORGANIZE_SCHEMA,
  memoryReorganizePromptForCluster,
  normalizeMemoryReorganization,
  relatedMemoryProjects,
} from './memory-reorganize.js';

const MAX_REASON = 4000;
const MAX_CONTENT = 20_000;
const MAX_TAGS = 30;
const MAX_MEMORY_AUDIT_BATCH_FAILURES = 3;
const MEMORY_AUDIT_RETRY_DELAY_MS = 5_000;
const activeWorkers = new Map<string, Promise<void>>();
const activeApplies = new Map<string, Promise<MemoryAuditView>>();
const queuedAuditIds = new Set<string>();
const rerunAfterActiveAuditIds = new Set<string>();
const auditQueue: string[] = [];
const MAX_CONCURRENT_AUDITS = Math.max(
  1,
  Math.min(4, Number(process.env.MEMORY_AUDIT_CONCURRENCY ?? 1) || 1),
);
let runningAuditWorkers = 0;
const MEMORY_TYPES = new Set<MemoryType>([
  'identity',
  'project',
  'goal',
  'decision',
  'preference',
  'contact',
  'event',
  'task',
]);

export class MemoryAuditError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A deterministic problem with one cluster's claims, not the audit runtime. */
class MemoryAuditBatchSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryAuditBatchSkipError';
  }
}

function baselineFingerprint(
  memories: Array<{ fingerprint: string; memory: Memory }>,
): string {
  return sha256Hex(
    memories
      .map(({ memory, fingerprint }) => `${memory.id}:${fingerprint}`)
      .sort()
      .join('\n'),
  );
}

function resolveAuditRuntime(projectId: string) {
  const group = getGroupByFolder(projectId);
  if (!group) throw new MemoryAuditError(404, 'Project not found');
  const auditSelection = getRuntimeCatalog().defaults.auditMemories;
  if (auditSelection) {
    return {
      group,
      runtime: resolveRuntimeSelection(auditSelection),
    };
  }
  const reviewStage = getGroupStages(group).find(
    (stage) => stage.type === 'review',
  );
  const resolved = resolveKanbanRuntimeSelection(
    [
      reviewStage?.runtimeSelection,
      group.settings?.kanbanRuntimeSelection ?? undefined,
    ],
    reviewStage?.id ?? 'review',
    'review',
  );
  if (isDirectRuntime(resolved.agent)) {
    throw new MemoryAuditError(
      422,
      'Configure defaults.auditMemories with a sandbox-capable runtime, or use a CLI project review runtime',
    );
  }
  return { group, runtime: resolved.agent };
}

function parseEnvelope(output: string): MemoryAuditEnvelope {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate =
    fenced ?? output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Reflector did not return valid JSON: ${detail}`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as any).items)
  ) {
    throw new Error('Reflector envelope must contain an items array');
  }
  return parsed as MemoryAuditEnvelope;
}

async function readSandboxFile(
  projectId: string,
  requestedPath: string,
  repositoryRoot?: string,
) {
  const resolved = await prepareGroupSandbox(projectId);
  const roots = { primary: resolved.workspaceRoot, extra: resolved.extraRoots };
  let root: string;
  let fullPath: string;
  try {
    root = repositoryRoot
      ? resolveSandboxPath(roots, repositoryRoot)
      : resolved.workspaceRoot;
    fullPath = resolveSandboxPath(
      roots,
      path.posix.isAbsolute(requestedPath)
        ? requestedPath
        : path.posix.join(root, requestedPath),
    );
  } catch (error) {
    throw new MemoryAuditBatchSkipError(
      `Invalid evidence path: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const client = getSandboxClient();
  const result = await client.sandboxExec(
    resolved.stack,
    resolved.service,
    `fs-tool.sh read-file ${shellQuote(fullPath)}`,
    { instance: resolved.instance, timeout: 20 },
  );
  const stdout = (result.stdout ?? '').trim();
  if (stdout === '__NOT_FOUND__') {
    throw new MemoryAuditBatchSkipError(
      `Evidence file is unavailable: ${fullPath}`,
    );
  }
  if (result.isError) {
    throw new Error(
      `Sandbox failed while reading evidence ${fullPath}: ${stdout.slice(0, 1_000)}`,
    );
  }
  return {
    resolved,
    root,
    fullPath,
    content: Buffer.from(stdout, 'base64').toString('utf8'),
  };
}

export async function verifyMemoryAuditEvidence(
  projectId: string,
  evidence: MemoryAuditEvidenceClaim[],
) {
  const verified = [];
  for (const claim of evidence.slice(0, 10)) {
    if (
      !claim ||
      typeof claim.path !== 'string' ||
      typeof claim.excerpt !== 'string'
    ) {
      throw new MemoryAuditBatchSkipError('Malformed evidence claim');
    }
    const file = await readSandboxFile(
      projectId,
      claim.path,
      claim.repository_root,
    );
    if (!file.content.includes(claim.excerpt)) {
      throw new MemoryAuditBatchSkipError(
        `Evidence excerpt was not found in ${file.fullPath}`,
      );
    }
    let watchedScopeHash: string | null = null;
    if (claim.watched_scope) {
      const scope = await readSandboxFile(
        projectId,
        claim.watched_scope,
        claim.repository_root,
      );
      watchedScopeHash = sha256Hex(scope.content);
    }
    verified.push({
      ...claim,
      repository_root: file.root,
      path: file.fullPath,
      file_sha256: sha256Hex(file.content),
      excerpt_sha256: sha256Hex(claim.excerpt),
      watched_scope_sha256: watchedScopeHash,
      repository_commit: null,
    });
  }
  return verified;
}

async function certificateStillValid(
  projectId: string,
  memory: Memory,
  certificate: MemoryEvidenceCertificate,
): Promise<boolean> {
  if (certificate.memory_fingerprint !== memoryStructuralFingerprint(memory))
    return false;
  if (
    certificate.expires_at &&
    Date.parse(certificate.expires_at) <= Date.now()
  )
    return false;
  for (const file of certificate.files) {
    let current: Awaited<ReturnType<typeof readSandboxFile>> | null = null;
    try {
      current = await readSandboxFile(
        projectId,
        file.path,
        file.repository_root,
      );
      if (sha256Hex(current.content) !== file.file_sha256) current = null;
    } catch {
      current = null;
    }
    if (!current) {
      current = await findRelocatedEvidenceFile(projectId, file);
      if (!current) return false;
      const relocatedScope =
        file.watched_scope === file.path ? current.fullPath : undefined;
      await relocateMemoryEvidenceFile(
        file.id,
        current.root,
        current.fullPath,
        relocatedScope,
      );
      if (relocatedScope) file.watched_scope = relocatedScope;
    }
    try {
      if (file.watched_scope && file.watched_scope_sha256) {
        const scope = await readSandboxFile(
          projectId,
          file.watched_scope,
          file.repository_root,
        );
        if (sha256Hex(scope.content) !== file.watched_scope_sha256)
          return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function findRelocatedEvidenceFile(
  projectId: string,
  evidence: MemoryEvidenceCertificate['files'][number],
): Promise<Awaited<ReturnType<typeof readSandboxFile>> | null> {
  const needle = evidence.excerpt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length >= 8);
  if (!needle) return null;
  const resolved = await prepareGroupSandbox(projectId);
  const client = getSandboxClient();
  const escapedNeedle = escapeRegex(needle);
  const candidates = new Set<string>();
  for (const root of [resolved.workspaceRoot, ...resolved.extraRoots]) {
    const result = await client.sandboxExec(
      resolved.stack,
      resolved.service,
      `fs-tool.sh ripgrep ${shellQuote(root)} ${shellQuote(escapedNeedle)}`,
      { instance: resolved.instance, timeout: 30 },
    );
    if (result.isError) continue;
    for (const line of (result.stdout ?? '').split('\n')) {
      const match = line.match(/^(.*?):\d+:/);
      if (match?.[1]) candidates.add(match[1]);
      if (candidates.size > 25) return null;
    }
  }
  const matches: Array<Awaited<ReturnType<typeof readSandboxFile>>> = [];
  for (const candidate of candidates) {
    try {
      const file = await readSandboxFile(projectId, candidate);
      if (sha256Hex(file.content) === evidence.file_sha256) matches.push(file);
    } catch {
      // A concurrent rename or unreadable candidate is not reusable evidence.
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

export function normalizeReflection(item: any, allowedIds: Set<string>) {
  if (
    !item ||
    typeof item.memory_id !== 'string' ||
    !allowedIds.has(item.memory_id)
  ) {
    throw new Error('Reflector referenced an unknown memory ID');
  }
  const allowed = new Set(['keep', 'rewrite', 'merge', 'erase']);
  if (!allowed.has(item.disposition))
    throw new Error(`Invalid disposition for ${item.memory_id}`);
  let disposition = item.disposition as 'keep' | 'rewrite' | 'merge' | 'erase';
  const confidence = Number(item.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Invalid confidence for ${item.memory_id}`);
  }
  if (
    (disposition === 'erase' && confidence < 0.9) ||
    ((disposition === 'rewrite' || disposition === 'merge') &&
      confidence < 0.85)
  ) {
    disposition = 'keep';
  }
  const reason =
    typeof item.reason === 'string'
      ? item.reason.trim().slice(0, MAX_REASON)
      : '';
  if (!reason) throw new Error(`Missing reason for ${item.memory_id}`);
  const proposedContent =
    typeof item.proposed_content === 'string'
      ? item.proposed_content.trim().slice(0, MAX_CONTENT)
      : undefined;
  if (disposition === 'rewrite' && !proposedContent)
    throw new Error(`Rewrite ${item.memory_id} has no content`);
  const proposedType = item.proposed_memory_type ?? undefined;
  if (proposedType != null && !MEMORY_TYPES.has(proposedType)) {
    throw new Error(`Invalid memory type for ${item.memory_id}`);
  }
  const proposedImportance =
    item.proposed_importance == null
      ? undefined
      : Number(item.proposed_importance);
  if (
    proposedImportance !== undefined &&
    (!Number.isFinite(proposedImportance) ||
      proposedImportance < 0 ||
      proposedImportance > 1)
  ) {
    throw new Error(`Invalid importance for ${item.memory_id}`);
  }
  const proposedTags = Array.isArray(item.proposed_tags)
    ? item.proposed_tags
        .filter((tag: unknown): tag is string => typeof tag === 'string')
        .slice(0, MAX_TAGS)
    : undefined;
  const mergeTarget =
    typeof item.merge_target_id === 'string' ? item.merge_target_id : undefined;
  if (
    disposition === 'merge' &&
    (!mergeTarget ||
      mergeTarget === item.memory_id ||
      !allowedIds.has(mergeTarget))
  ) {
    throw new Error(`Invalid merge target for ${item.memory_id}`);
  }
  return {
    memoryId: item.memory_id as string,
    disposition,
    confidence,
    reason,
    proposedContent,
    proposedMemoryType: proposedType as MemoryType | undefined,
    proposedImportance,
    proposedTags,
    mergeTargetId: mergeTarget,
    evidence: Array.isArray(item.evidence)
      ? (item.evidence as MemoryAuditEvidenceClaim[])
      : [],
  };
}

async function invokeMemoryIndexAgent(args: {
  group: any;
  runtime: ReturnType<typeof resolveAuditRuntime>['runtime'];
  auditId: string;
  prompt: string;
  repair: boolean;
  toolDriven?: boolean;
  stage: 'discovery' | 'reconciliation';
}): Promise<string> {
  const output = await runContainerAgent(args.group, {
    prompt: args.prompt,
    group_folder: args.group.folder,
    chat_jid: `memory-index:${args.auditId}:${args.stage}`,
    isMain: !!args.group.is_main,
    triggeredByUserId: null,
    triggerSource: 'system',
    model: args.runtime.model,
    reasoning_effort: args.runtime.reasoning_effort,
    env: args.runtime.env,
    agent_cmd: isDirectRuntime(args.runtime)
      ? args.runtime.id
      : args.runtime.agentCmd,
    agent: args.runtime.agent,
    privacyRuntime: args.runtime,
    privacyPurpose: 'memory',
    bare: args.runtime.bare,
    systemPrompt: args.toolDriven
      ? 'Discover project knowledge read-only and stage candidates only through propose_memory. Never call memorize or modify the project.'
      : args.repair
        ? 'Correct the project memory-index response to the exact JSON schema. Return JSON only. Never modify the project.'
        : 'Discover and reconcile project knowledge read-only. Return only the requested JSON. Never modify the project.',
    injectAgentContext: true,
    allowedToolNames: args.toolDriven
      ? [
          'ripgrep',
          'read_file',
          'peek_files',
          'propose_memory',
          'finish_indexing',
        ]
      : [],
    skipTranscriptMemory: true,
    ephemeral: true,
    timeout: 3600,
  });
  if (output.status === 'error' || !output.result) {
    throw new Error(output.error || 'Memory index reflector failed');
  }
  return output.result;
}

async function processMemoryIndexAudit(
  audit: MemoryAudit,
  group: any,
  runtime: ReturnType<typeof resolveAuditRuntime>['runtime'],
): Promise<void> {
  const verifiedAt = new Date().toISOString();
  const currentMemories = await getCurrentProjectMemoriesForAudit(
    audit.project_id,
  );
  const verifiedCoverage = [];
  for (const memory of currentMemories) {
    const certificate = await getActiveMemoryEvidenceCertificate(memory.id);
    if (
      !certificate ||
      !['keep', 'human_keep'].includes(certificate.verdict) ||
      !certificate.files.length ||
      !(await certificateStillValid(audit.project_id, memory, certificate))
    ) {
      continue;
    }
    verifiedCoverage.push({
      memory_id: memory.id,
      content: memory.content.slice(0, 2_000),
      evidence_paths: [...new Set(certificate.files.map((file) => file.path))],
      watched_scopes: [
        ...new Set(
          certificate.files
            .map((file) => file.watched_scope)
            .filter((scope): scope is string => !!scope),
        ),
      ],
    });
  }
  let candidates: MemoryIndexCandidate[];
  let verifiedEvidence: Map<
    string,
    Awaited<ReturnType<typeof verifyMemoryAuditEvidence>>
  >;
  if (isDirectRuntime(runtime)) {
    const collectorToken = await beginMemoryIndexCollection(audit.id);
    resetMemoryIndexCollectorDiagnostics(audit.id);
    const discoveryPrompt = memoryIndexToolDiscoveryPrompt(
      verifiedAt,
      verifiedCoverage,
      collectorToken,
    );
    await invokeMemoryIndexAgent({
      group,
      runtime,
      auditId: audit.id,
      prompt: discoveryPrompt,
      repair: false,
      toolDriven: true,
      stage: 'discovery',
    });
    const stored = await listMemoryIndexCandidates(audit.id);
    let summary = await getMemoryIndexAuditSummary(audit.id);
    if (!stored.length && !summary.finished_at) {
      const diagnostics = getMemoryIndexCollectorDiagnostics(audit.id);
      throw new Error(
        diagnostics.rejectedCalls
          ? `Indexer staged no candidates because ${diagnostics.rejectedCalls} propose_memory call(s) were rejected. Last rejection: ${diagnostics.lastError}`
          : 'Indexer exited without staging candidates or explicitly reporting a verified zero-result scan',
      );
    }
    if (stored.length && !summary.finished_at) {
      await finishMemoryIndexCollection({
        auditId: audit.id,
        summary: `Automatically finalized ${stored.length} staged candidate(s) when the indexer exited.`,
        inspectedAreas: [
          ...new Set(
            stored.flatMap((candidate) =>
              candidate.evidence.map((file) => file.path),
            ),
          ),
        ].slice(0, 30),
      });
      summary = await getMemoryIndexAuditSummary(audit.id);
    }
    candidates = stored.map((candidate) => ({
      candidateId: candidate.candidateId,
      content: candidate.content,
      memoryType: candidate.memoryType,
      importance: candidate.importance,
      tags: candidate.tags,
      retrievalValue: candidate.retrievalValue,
      reason: candidate.reason,
      validFrom: candidate.validFrom,
      evidence: candidate.evidence,
    }));
    verifiedEvidence = new Map(
      stored.map((candidate) => [candidate.candidateId, candidate.evidence]),
    ) as typeof verifiedEvidence;
  } else {
    const discoveryPrompt = memoryIndexDiscoveryPrompt(
      verifiedAt,
      verifiedCoverage,
    );
    const discovered = await requestValidStructuredJson({
      originalPrompt: discoveryPrompt,
      invoke: (prompt, repair) =>
        invokeMemoryIndexAgent({
          group,
          runtime,
          auditId: audit.id,
          prompt,
          repair,
          stage: 'discovery',
        }),
      validate: (output) =>
        normalizeMemoryIndexCandidates(
          parseMemoryIndexJson(output),
          verifiedAt,
        ),
      repairPrompt: ({ previousOutput, validationError }) =>
        structuredJsonRepairPrompt({
          originalPrompt: discoveryPrompt,
          previousOutput,
          validationError,
          schema: MEMORY_INDEX_DISCOVERY_SCHEMA,
          requirements:
            'Candidate IDs must be unique. Every candidate requires exact repository evidence. Return at most 50 candidates.',
        }),
      onValidationFailure: (diagnostic) =>
        logger.warn(
          {
            auditId: audit.id,
            projectId: audit.project_id,
            stage: 'discovery',
            ...diagnostic,
          },
          'memory index reflector response rejected',
        ),
    });
    candidates = [];
    verifiedEvidence = new Map();
    for (const candidate of discovered) {
      try {
        verifiedEvidence.set(
          candidate.candidateId,
          await verifyMemoryAuditEvidence(audit.project_id, candidate.evidence),
        );
        candidates.push(candidate);
      } catch (error) {
        if (!(error instanceof MemoryAuditBatchSkipError)) throw error;
        logger.warn(
          {
            auditId: audit.id,
            projectId: audit.project_id,
            candidateId: candidate.candidateId,
            error: error.message,
          },
          'memory index candidate skipped because its evidence is invalid',
        );
      }
    }
  }

  const currentById = new Map(
    currentMemories.map((memory) => [memory.id, memory]),
  );
  const matches = new Map<string, Memory[]>();
  const matchingMemoryIds = new Map<string, Set<string>>();
  const hooks = getVectorStoreHooks();
  for (const candidate of candidates) {
    let vectorScores: Map<string, number> | undefined;
    if (hooks?.isAvailable()) {
      try {
        const hits = await hooks.enhanceRecall({
          groupFolders: [audit.project_id],
          query: candidate.content,
          limit: 25,
          objective_id: null,
        });
        if (hits) {
          vectorScores = new Map(hits.map((hit) => [hit.id, hit.score]));
        }
      } catch (error) {
        logger.warn(
          {
            auditId: audit.id,
            projectId: audit.project_id,
            candidateId: candidate.candidateId,
            error,
          },
          'memory index similarity lookup failed; using lexical matching',
        );
      }
    }
    const pseudoMemory: Memory = {
      id: `candidate:${candidate.candidateId}`,
      group_folder: audit.project_id,
      objective_id: null,
      content: candidate.content,
      memory_type: candidate.memoryType,
      importance: candidate.importance,
      source: 'agent',
      tags: candidate.tags,
      created_at: verifiedAt,
      updated_at: verifiedAt,
      last_accessed_at: verifiedAt,
      access_count: 0,
      valid_from: candidate.validFrom,
      valid_to: null,
    };
    const cluster = selectMemoryAuditSemanticCluster({
      seed: pseudoMemory,
      candidates: [pseudoMemory, ...currentMemories],
      vectorScores,
      maxSize: 6,
    });
    const candidateMatches = cluster.memories
      .filter((memory) => memory.id !== pseudoMemory.id)
      .slice(0, 5);
    matches.set(candidate.candidateId, candidateMatches);
    matchingMemoryIds.set(
      candidate.candidateId,
      new Set(candidateMatches.map((memory) => memory.id)),
    );
  }

  let decisions: ReturnType<typeof normalizeMemoryIndexReconciliation> = [];
  if (candidates.length && currentMemories.length === 0) {
    decisions = candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      op: 'create' as const,
      confidence: 1,
      reason: candidate.reason,
      content: candidate.content,
      memoryType: candidate.memoryType,
      importance: candidate.importance,
      tags: candidate.tags,
    }));
  } else if (candidates.length) {
    const reconciliationPrompt = memoryIndexReconciliationPrompt({
      candidates,
      matches,
    });
    decisions = await requestValidStructuredJson({
      originalPrompt: reconciliationPrompt,
      invoke: (prompt, repair) =>
        invokeMemoryIndexAgent({
          group,
          runtime,
          auditId: audit.id,
          prompt,
          repair,
          stage: 'reconciliation',
        }),
      validate: (output) =>
        normalizeMemoryIndexReconciliation({
          envelope: parseMemoryIndexJson(output),
          candidates,
          matchingMemoryIds,
        }),
      repairPrompt: ({ previousOutput, validationError }) =>
        structuredJsonRepairPrompt({
          originalPrompt: reconciliationPrompt,
          previousOutput,
          validationError,
          schema: MEMORY_INDEX_RECONCILIATION_SCHEMA,
          requirements: `Account for every candidate exactly once. Candidate IDs: ${JSON.stringify(
            candidates.map((candidate) => candidate.candidateId),
          )}`,
        }),
      onValidationFailure: (diagnostic) =>
        logger.warn(
          {
            auditId: audit.id,
            projectId: audit.project_id,
            stage: 'reconciliation',
            ...diagnostic,
          },
          'memory index reflector response rejected',
        ),
    });
  }
  if (isDirectRuntime(runtime)) {
    await recordMemoryIndexReconciliation(audit.id, decisions);
  }

  const candidateById = new Map(
    candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const proposals = decisions.flatMap((decision) => {
    if (decision.op !== 'create' && decision.op !== 'enhance') return [];
    const candidate = candidateById.get(decision.candidateId)!;
    const evidence = (verifiedEvidence.get(decision.candidateId) ?? []).map(
      (file, index) => ({
        ...file,
        id:
          'id' in file && typeof file.id === 'string'
            ? file.id
            : `mae-${sha256Hex(`${audit.id}:${decision.candidateId}:${index}:${file.file_sha256}`).slice(0, 32)}`,
        verified_at:
          'verified_at' in file && typeof file.verified_at === 'string'
            ? file.verified_at
            : verifiedAt,
      }),
    );
    const proposalKey = sha256Hex(
      JSON.stringify({
        auditId: audit.id,
        candidateId: decision.candidateId,
        op: decision.op,
        memoryId: decision.memoryId ?? null,
        content: decision.content,
        evidence: evidence.map((file) => [file.path, file.file_sha256]),
      }),
    );
    const target = decision.memoryId
      ? currentById.get(decision.memoryId)
      : undefined;
    if (decision.op === 'enhance' && !target) {
      throw new Error(
        `Enhancement target disappeared for ${decision.candidateId}`,
      );
    }
    return [
      {
        id: `mai-${proposalKey.slice(0, 32)}`,
        memoryId:
          decision.op === 'create'
            ? `index-proposal:${proposalKey.slice(0, 32)}`
            : target!.id,
        memoryFingerprint:
          decision.op === 'create'
            ? proposalKey
            : memoryStructuralFingerprint(target!),
        disposition: decision.op,
        confidence: decision.confidence,
        reason: decision.reason,
        retrievalValue: candidate.retrievalValue,
        proposedContent: decision.content!,
        proposedMemoryType: decision.memoryType!,
        proposedImportance: decision.importance!,
        proposedTags: decision.tags!,
        proposedValidFrom: candidate.validFrom,
        evidence,
      },
    ];
  });
  await completeMemoryIndexAudit({ auditId: audit.id, proposals });
  const ready = await getMemoryAudit(audit.id);
  if (ready) {
    broadcastAuditUpdate(ready);
    await notifyAuditStatus(ready, ready.status);
  }
}

async function processMemoryReorganizationAudit(
  audit: MemoryAudit,
  group: NonNullable<ReturnType<typeof getGroupByFolder>>,
  runtime: ReturnType<typeof resolveAuditRuntime>['runtime'],
): Promise<void> {
  const destinations = relatedMemoryProjects(
    audit.project_id,
    registeredGroups,
  );
  if (!destinations.length) {
    throw new MemoryAuditError(
      422,
      'This project has no parent, child, or configured memory-source destinations',
    );
  }
  const allowedProjectIds = new Set(
    destinations.map((destination) => destination.id),
  );
  const clusteringMemories = new Map(
    (await getCurrentProjectMemoriesForAudit(audit.project_id)).map(
      (memory) => [memory.id, memory],
    ),
  );
  while (true) {
    const allPending = await listPendingMemoryAuditItems(
      audit.id,
      Math.max(1, audit.total_items),
    );
    if (!allPending.length) break;
    const seedItem = allPending[0]!;
    const seed = clusteringMemories.get(seedItem.memory_id);
    const pendingMemoryIds = new Set(allPending.map((item) => item.memory_id));
    const candidates = [...clusteringMemories.values()].filter((memory) =>
      pendingMemoryIds.has(memory.id),
    );
    let vectorScores: Map<string, number> | undefined;
    const hooks = getVectorStoreHooks();
    if (seed && allPending.length > 1 && hooks?.isAvailable()) {
      try {
        const hits = await hooks.enhanceRecall({
          groupFolders: [audit.project_id],
          query: seed.content,
          limit: Math.min(Math.max(audit.total_items, 100), 1_000),
          objective_id: seed.objective_id ?? null,
        });
        if (hits) {
          vectorScores = new Map(hits.map((hit) => [hit.id, hit.score]));
        }
      } catch (error) {
        logger.warn(
          { auditId: audit.id, projectId: audit.project_id, error },
          'memory reorganization similarity lookup failed; using lexical clustering',
        );
      }
    }
    const cluster = seed
      ? selectMemoryAuditSemanticCluster({
          seed,
          candidates,
          vectorScores,
          maxSize: MEMORY_AUDIT_MAX_CLUSTER_SIZE,
        })
      : { memories: [] };
    const clusterIds = new Set(
      cluster.memories.length
        ? cluster.memories.map((memory) => memory.id)
        : [seedItem.memory_id],
    );
    const pending = allPending.filter((item) => clusterIds.has(item.memory_id));
    const memories: Memory[] = [];
    const workItems: MemoryAuditItem[] = [];
    for (const item of pending) {
      const memory = await getMemory(item.memory_id);
      if (
        !memory ||
        memory.group_folder !== audit.project_id ||
        memoryStructuralFingerprint(memory) !== item.memory_fingerprint
      ) {
        await completeMemoryAuditItem({
          itemId: item.id,
          disposition: 'keep',
          confidence: 1,
          reason: 'Memory changed or moved after the reorganization snapshot',
        });
        continue;
      }
      memories.push(memory);
      workItems.push(item);
    }
    if (memories.length) {
      const allowedMemoryIds = new Set(memories.map((memory) => memory.id));
      const prompt = memoryReorganizePromptForCluster({
        source: group,
        destinations,
        memories,
      });
      const decisions = await requestValidStructuredJson({
        originalPrompt: prompt,
        invoke: async (currentPrompt, repair) => {
          const output = await runContainerAgent(group, {
            prompt: currentPrompt,
            group_folder: group.folder,
            chat_jid: `memory-reorganize:${audit.id}`,
            isMain: !!group.is_main,
            triggeredByUserId: null,
            triggerSource: 'system',
            model: runtime.model,
            reasoning_effort: runtime.reasoning_effort,
            env: runtime.env,
            agent_cmd: isDirectRuntime(runtime) ? runtime.id : runtime.agentCmd,
            agent: runtime.agent,
            privacyRuntime: runtime,
            privacyPurpose: 'memory',
            bare: runtime.bare,
            systemPrompt: repair
              ? 'Correct the memory-placement response to the exact JSON schema. Return JSON only. Never modify the project.'
              : 'Classify project-memory placement read-only. Return only the requested JSON. Never modify the project.',
            injectAgentContext: true,
            allowedToolNames: [],
            skipTranscriptMemory: true,
            ephemeral: true,
            timeout: 3600,
          });
          if (output.status === 'error' || !output.result) {
            throw new Error(
              output.error || 'Memory reorganization reflector failed',
            );
          }
          return output.result;
        },
        validate: (output) =>
          normalizeMemoryReorganization({
            output,
            allowedMemoryIds,
            allowedProjectIds,
          }),
        repairPrompt: ({ previousOutput, validationError }) =>
          structuredJsonRepairPrompt({
            originalPrompt: prompt,
            previousOutput,
            validationError,
            schema: MEMORY_REORGANIZE_SCHEMA,
            requirements: `Every supplied memory ID must occur exactly once. Allowed memory IDs: ${JSON.stringify([...allowedMemoryIds])}. Allowed target project IDs: ${JSON.stringify([...allowedProjectIds])}.`,
          }),
        onValidationFailure: (diagnostic) => {
          logger.warn(
            {
              auditId: audit.id,
              projectId: audit.project_id,
              clusterSize: allowedMemoryIds.size,
              ...diagnostic,
            },
            'memory reorganization reflector response rejected',
          );
        },
      });
      for (const decision of decisions) {
        const workItem = workItems.find(
          (item) => item.memory_id === decision.memoryId,
        )!;
        const latest = await getMemory(decision.memoryId);
        if (
          !latest ||
          latest.group_folder !== audit.project_id ||
          memoryStructuralFingerprint(latest) !== workItem.memory_fingerprint
        ) {
          await completeMemoryAuditItem({
            itemId: workItem.id,
            disposition: 'keep',
            confidence: 1,
            reason:
              'Memory changed or moved while its placement cluster was running',
          });
          continue;
        }
        await completeMemoryAuditItem({
          itemId: workItem.id,
          disposition: decision.disposition,
          confidence: decision.confidence,
          reason: decision.reason,
          targetProjectId: decision.targetProjectId,
        });
      }
    }
    const progress = await refreshMemoryAuditProgress(audit.id, {
      successfulBatch: true,
    });
    broadcastAuditUpdate({
      ...audit,
      status: 'running',
      processed_items: progress.processed,
      proposal_items: progress.proposals,
    });
  }
  const progress = await refreshMemoryAuditProgress(audit.id);
  const finalStatus = progress.proposals > 0 ? 'ready' : 'applied';
  await setMemoryAuditStatus(audit.id, finalStatus, {
    processed_items: progress.processed,
    proposal_items: progress.proposals,
    retry_count: 0,
  });
  const ready = await getMemoryAudit(audit.id);
  if (ready) {
    broadcastAuditUpdate(ready);
    await notifyAuditStatus(ready, finalStatus);
  }
}

async function processAudit(auditId: string): Promise<void> {
  const audit = await getMemoryAudit(auditId);
  if (!audit || !['queued', 'running'].includes(audit.status)) return;
  try {
    const { group, runtime } = resolveAuditRuntime(audit.project_id);
    if (audit.runtime_id !== runtime.id) {
      await setMemoryAuditRuntime(audit.id, runtime.id);
    }
    await prepareGroupSandbox(group.folder);
    await setMemoryAuditStatus(audit.id, 'running', { error: null });
    if (audit.mode === 'index') {
      await processMemoryIndexAudit(audit, group, runtime);
      return;
    }
    if (audit.mode === 'reorganize') {
      await processMemoryReorganizationAudit(audit, group, runtime);
      return;
    }
    const clusteringMemories = new Map(
      (await getCurrentProjectMemoriesForAudit(audit.project_id)).map(
        (memory) => [memory.id, memory],
      ),
    );
    while (true) {
      const allPending = await listPendingMemoryAuditItems(
        audit.id,
        Math.max(1, audit.total_items),
      );
      if (!allPending.length) break;
      const seedItem = allPending[0]!;
      const seed = clusteringMemories.get(seedItem.memory_id);
      const hooks = getVectorStoreHooks();
      let vectorScores: Map<string, number> | undefined;
      if (seed && allPending.length > 1 && hooks?.isAvailable()) {
        try {
          const hits = await hooks.enhanceRecall({
            groupFolders: [audit.project_id],
            query: seed.content,
            limit: Math.min(Math.max(audit.total_items, 100), 1_000),
            objective_id: seed.objective_id ?? null,
          });
          if (hits) {
            vectorScores = new Map(hits.map((hit) => [hit.id, hit.score]));
          }
        } catch (error) {
          logger.warn(
            { auditId: audit.id, projectId: audit.project_id, error },
            'memory audit similarity lookup failed; using lexical clustering',
          );
        }
      }
      const pendingMemoryIds = new Set(
        allPending.map((item) => item.memory_id),
      );
      const candidates = [...clusteringMemories.values()].filter((memory) =>
        pendingMemoryIds.has(memory.id),
      );
      const cluster = seed
        ? selectMemoryAuditSemanticCluster({
            seed,
            candidates,
            vectorScores,
            maxSize: MEMORY_AUDIT_MAX_CLUSTER_SIZE,
          })
        : { memories: [] };
      const clusterIds = new Set(
        cluster.memories.length
          ? cluster.memories.map((memory) => memory.id)
          : [seedItem.memory_id],
      );
      const pending = allPending.filter((item) =>
        clusterIds.has(item.memory_id),
      );
      logger.info(
        {
          auditId: audit.id,
          projectId: audit.project_id,
          seedMemoryId: seedItem.memory_id,
          pendingItems: allPending.length,
          clusterSize: pending.length,
          maxClusterSize: MEMORY_AUDIT_MAX_CLUSTER_SIZE,
          vectorMatches: 'vectorMatches' in cluster ? cluster.vectorMatches : 0,
          lexicalMatches:
            'lexicalMatches' in cluster ? cluster.lexicalMatches : 0,
        },
        'memory audit semantic cluster selected',
      );
      const memories: Memory[] = [];
      const workItems: MemoryAuditItem[] = [];
      for (const item of pending) {
        const memory = await getMemory(item.memory_id);
        if (
          !memory ||
          memory.group_folder !== audit.project_id ||
          memoryStructuralFingerprint(memory) !== item.memory_fingerprint
        ) {
          await completeMemoryAuditItem({
            itemId: item.id,
            disposition: 'keep',
            confidence: 1,
            reason: 'Memory changed or disappeared after the audit snapshot',
          });
          continue;
        }
        const certificate = await getActiveMemoryEvidenceCertificate(memory.id);
        if (
          certificate &&
          (certificate.verdict === 'keep' ||
            certificate.verdict === 'human_keep') &&
          (await certificateStillValid(audit.project_id, memory, certificate))
        ) {
          await completeMemoryAuditItem({
            itemId: item.id,
            disposition: 'keep',
            confidence: 1,
            reason: `Covered by unchanged ${certificate.origin} evidence certificate`,
            processingState: 'certified',
          });
          continue;
        }
        if (certificate) await revokeMemoryEvidenceCertificate(memory.id);
        memories.push(memory);
        workItems.push(item);
      }
      if (memories.length) {
        const allowedIds = new Set(memories.map((memory) => memory.id));
        const normalized = await requestValidMemoryAuditJson({
          originalPrompt: memoryAuditPromptForCluster(memories),
          allowedMemoryIds: [...allowedIds],
          invoke: async (prompt, isRepair) => {
            const output = await runContainerAgent(group, {
              prompt,
              group_folder: group.folder,
              chat_jid: `memory-audit:${audit.id}`,
              isMain: !!group.is_main,
              triggeredByUserId: null,
              triggerSource: 'system',
              model: runtime.model,
              reasoning_effort: runtime.reasoning_effort,
              env: runtime.env,
              agent_cmd: isDirectRuntime(runtime)
                ? runtime.id
                : runtime.agentCmd,
              agent: runtime.agent,
              privacyRuntime: runtime,
              privacyPurpose: 'memory',
              bare: runtime.bare,
              systemPrompt: isRepair
                ? 'Correct your prior memory-audit response to the exact JSON schema. Return JSON only. Never modify the project.'
                : 'Perform a read-only memory quality audit. Return only the requested JSON. Never modify the project.',
              injectAgentContext: true,
              allowedToolNames: [],
              skipTranscriptMemory: true,
              ephemeral: true,
              timeout: 3600,
            });
            if (output.status === 'error' || !output.result) {
              throw new Error(output.error || 'Audit reflector failed');
            }
            return output.result;
          },
          validate: (output) => {
            const envelope = parseEnvelope(output);
            const items = envelope.items.map((item) =>
              normalizeReflection(item, allowedIds),
            );
            if (
              items.length !== allowedIds.size ||
              new Set(items.map((item) => item.memoryId)).size !==
                allowedIds.size
            ) {
              throw new Error(
                'Reflector must account for every memory exactly once',
              );
            }
            return items;
          },
          onValidationFailure: (diagnostic) => {
            logger.warn(
              {
                auditId: audit.id,
                projectId: audit.project_id,
                clusterSize: allowedIds.size,
                ...diagnostic,
              },
              'memory audit reflector response rejected',
            );
          },
        });
        // Validate every untrusted evidence reference before persisting any
        // disposition from this cluster. A malformed envelope is atomic.
        try {
          const prepared = [];
          for (const result of normalized) {
            const workItem = workItems.find(
              (item) => item.memory_id === result.memoryId,
            )!;
            const verifiedEvidence = await verifyMemoryAuditEvidence(
              audit.project_id,
              result.evidence,
            );
            prepared.push({ result, workItem, verifiedEvidence });
          }
          for (const { result, workItem, verifiedEvidence } of prepared) {
            // Review/apply may proceed while later clusters are still running.
            // Never persist a result produced from a snapshot that changed while
            // this reflector call was in flight.
            const latest = await getMemory(result.memoryId);
            if (
              !latest ||
              latest.group_folder !== audit.project_id ||
              memoryStructuralFingerprint(latest) !==
                workItem.memory_fingerprint
            ) {
              await completeMemoryAuditItem({
                itemId: workItem.id,
                disposition: 'keep',
                confidence: 1,
                reason:
                  'Memory changed or disappeared while its audit cluster was running',
              });
              continue;
            }
            if (result.disposition === 'merge' && result.mergeTargetId) {
              const targetItem = workItems.find(
                (candidate) => candidate.memory_id === result.mergeTargetId,
              );
              const target = await getMemory(result.mergeTargetId);
              if (
                !targetItem ||
                !target ||
                target.group_folder !== audit.project_id ||
                memoryStructuralFingerprint(target) !==
                  targetItem.memory_fingerprint
              ) {
                await completeMemoryAuditItem({
                  itemId: workItem.id,
                  disposition: 'keep',
                  confidence: 1,
                  reason:
                    'Merge target changed while its audit cluster was running',
                });
                continue;
              }
            }
            await completeMemoryAuditItem({ itemId: workItem.id, ...result });
            const hasCode = verifiedEvidence.length > 0;
            const expiresAt =
              result.disposition === 'keep' && !hasCode
                ? new Date(
                    Date.now() + MEMORY_AUDIT_KEEP_TTL_DAYS * 86_400_000,
                  ).toISOString()
                : null;
            await createMemoryEvidenceCertificate({
              projectId: audit.project_id,
              memoryId: result.memoryId,
              memoryFingerprint: workItem.memory_fingerprint,
              verdict: result.disposition,
              justification: result.reason,
              evidenceType: hasCode ? 'code' : 'reasoning',
              reflectorVersion: audit.prompt_version,
              origin: 'automatic',
              expiresAt,
              files: verifiedEvidence,
            });
          }
        } catch (error) {
          if (!(error instanceof MemoryAuditBatchSkipError)) throw error;
          const reason = `Skipped audit batch without certification: ${error.message}`;
          await skipMemoryAuditBatch({
            itemIds: workItems.map((item) => item.id),
            reason,
          });
          logger.warn(
            {
              auditId: audit.id,
              projectId: audit.project_id,
              seedMemoryId: seedItem.memory_id,
              skippedItems: workItems.length,
              error: error.message,
            },
            'memory audit batch skipped because its evidence is invalid',
          );
        }
      }
      const progress = await refreshMemoryAuditProgress(audit.id, {
        successfulBatch: true,
      });
      broadcastAuditUpdate({
        ...audit,
        status: 'running',
        processed_items: progress.processed,
        proposal_items: progress.proposals,
      });
    }
    const progress = await refreshMemoryAuditProgress(audit.id);
    const completedItems = await listMemoryAuditItems(audit.id);
    const completedProposals = completedItems.filter((item) =>
      ['rewrite', 'merge', 'erase'].includes(item.disposition ?? ''),
    );
    const finalStatus =
      completedProposals.length === 0 ||
      completedProposals.every((item) => !!item.applied_at)
        ? 'applied'
        : 'ready';
    // Commit the terminal state once. Writing `ready` first could strand a
    // zero-proposal audit if the worker stopped between the two updates.
    await setMemoryAuditStatus(audit.id, finalStatus, {
      processed_items: progress.processed,
      proposal_items: progress.proposals,
      retry_count: 0,
    });
    const ready = await getMemoryAudit(audit.id);
    if (ready) {
      broadcastAuditUpdate(ready);
      if (ready.status === finalStatus) {
        await notifyAuditStatus(ready, finalStatus);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latest = await getMemoryAudit(audit.id);
    const retries = (latest?.retry_count ?? 0) + 1;
    const status =
      retries >= MAX_MEMORY_AUDIT_BATCH_FAILURES ? 'paused' : 'queued';
    const retryMessage = `Batch attempt ${retries}/${MAX_MEMORY_AUDIT_BATCH_FAILURES} failed: ${message}`;
    await setMemoryAuditStatus(audit.id, status, {
      error: retryMessage,
      retry_count: retries,
    });
    const failed = await getMemoryAudit(audit.id);
    if (failed) {
      broadcastAuditUpdate(failed);
      if (status === 'paused') await notifyAuditStatus(failed, status);
    }
    logger.error(
      {
        auditId,
        projectId: audit.project_id,
        batchCursor: latest?.cursor ?? audit.cursor,
        batchAttempt: retries,
        maxBatchAttempts: MAX_MEMORY_AUDIT_BATCH_FAILURES,
        willRetry: status === 'queued',
        error: message,
      },
      'memory audit failed',
    );
    if (status === 'queued') {
      setTimeout(() => queueAudit(audit.id), MEMORY_AUDIT_RETRY_DELAY_MS);
    }
  }
}

function drainAuditQueue(): void {
  // Paused: queued audits stay persisted/queued and start after resume (or are
  // recovered on the next boot).
  while (
    canStartBackgroundWork() &&
    runningAuditWorkers < MAX_CONCURRENT_AUDITS &&
    auditQueue.length
  ) {
    const auditId = auditQueue.shift()!;
    queuedAuditIds.delete(auditId);
    runningAuditWorkers += 1;
    const promise = trackBackgroundWork('memory audit', () =>
      processAudit(auditId),
    ).finally(() => {
      activeWorkers.delete(auditId);
      runningAuditWorkers -= 1;
      if (rerunAfterActiveAuditIds.delete(auditId)) {
        queueAudit(auditId);
      }
      drainAuditQueue();
    });
    activeWorkers.set(auditId, promise);
  }
}

function queueAudit(auditId: string, rerunIfActive = false): void {
  if (activeWorkers.has(auditId)) {
    if (rerunIfActive) rerunAfterActiveAuditIds.add(auditId);
    return;
  }
  if (queuedAuditIds.has(auditId)) return;
  queuedAuditIds.add(auditId);
  auditQueue.push(auditId);
  drainAuditQueue();
}

onBackgroundWorkResumed(drainAuditQueue);

// Late imports avoid coupling the DB-only helpers to HTTP/push initialization.
import { broadcast } from '../objectives/ws-events.js';
import { notifyUserSystem } from '../tools/push-tools.js';

function broadcastAuditUpdate(audit: MemoryAudit): void {
  broadcast({
    type: 'memory_audit_updated',
    payload: {
      user_id: audit.initiated_by,
      project_id: audit.project_id,
      audit_id: audit.id,
      status: audit.status,
    },
  });
}

async function notifyAuditStatus(
  audit: MemoryAudit,
  status: string,
): Promise<void> {
  if (!audit.initiated_by) return;
  const jobLabel =
    audit.mode === 'index'
      ? 'Memory index'
      : audit.mode === 'reorganize'
        ? 'Memory reorganization'
        : 'Memory audit';
  const labels: Record<string, string> = {
    ready: `${jobLabel} ready for review`,
    paused: `${jobLabel} needs attention`,
    failed: `${jobLabel} failed`,
    applied: `${jobLabel} applied`,
  };
  const sourceId = `memory-audit:${audit.id}:${status}`;
  const actionUrl = `/memory-review?mode=existing&projectId=${encodeURIComponent(audit.project_id)}&auditId=${encodeURIComponent(audit.id)}`;
  await notifyUserSystem(audit.initiated_by, audit.project_id, {
    summary: labels[status] ?? `${jobLabel} ${status}`,
    content:
      status === 'ready'
        ? `${audit.proposal_items} proposed memory changes are ready for review.`
        : audit.error || `The project ${jobLabel.toLowerCase()} is ${status}.`,
    source_id: sourceId,
    action_url: actionUrl,
  });
  try {
    await ackSupersededNotificationPayloads(
      audit.initiated_by,
      actionUrl,
      sourceId,
    );
  } catch (error) {
    logger.warn(
      { audit_id: audit.id, status, error: String(error) },
      '[memory-audit] failed to dismiss superseded notifications',
    );
  }
}

export async function startProjectMemoryAudit(
  projectId: string,
  userId: string,
): Promise<{ audit: MemoryAudit; created: boolean }> {
  const { runtime } = resolveAuditRuntime(projectId);
  await prepareGroupSandbox(projectId);
  const memories = (await getCurrentProjectMemoriesForAudit(projectId)).map(
    (memory) => ({
      memory,
      fingerprint: memoryStructuralFingerprint(memory),
    }),
  );
  const result = await createMemoryAuditSnapshot({
    projectId,
    initiatedBy: userId,
    runtimeId: runtime.id,
    promptVersion: MEMORY_AUDIT_PROMPT_VERSION,
    baselineFingerprint: baselineFingerprint(memories),
    memories,
  });
  if (result.audit.total_items === 0) {
    await setMemoryAuditStatus(result.audit.id, 'applied', {
      processed_items: 0,
      proposal_items: 0,
    });
    const ready = await getMemoryAudit(result.audit.id);
    if (ready) {
      broadcastAuditUpdate(ready);
      await notifyAuditStatus(ready, 'applied');
    }
  } else if (
    result.created ||
    ['queued', 'running'].includes(result.audit.status)
  ) {
    queueAudit(result.audit.id);
  }
  return {
    audit: (await getMemoryAudit(result.audit.id))!,
    created: result.created,
  };
}

export async function startProjectMemoryIndex(
  projectId: string,
  userId: string,
): Promise<{ audit: MemoryAudit; created: boolean }> {
  const { runtime } = resolveAuditRuntime(projectId);
  await prepareGroupSandbox(projectId);
  const memories = (await getCurrentProjectMemoriesForAudit(projectId)).map(
    (memory) => ({
      memory,
      fingerprint: memoryStructuralFingerprint(memory),
    }),
  );
  const result = await createMemoryIndexAudit({
    projectId,
    initiatedBy: userId,
    runtimeId: runtime.id,
    promptVersion: MEMORY_INDEX_PROMPT_VERSION,
    baselineFingerprint: baselineFingerprint(memories),
  });
  if (result.created || ['queued', 'running'].includes(result.audit.status)) {
    queueAudit(result.audit.id);
  }
  return {
    audit: (await getMemoryAudit(result.audit.id))!,
    created: result.created,
  };
}

export async function startProjectMemoryReorganization(
  projectId: string,
  userId: string,
): Promise<{ audit: MemoryAudit; created: boolean }> {
  const { runtime } = resolveAuditRuntime(projectId);
  const destinations = relatedMemoryProjects(projectId, registeredGroups);
  if (!destinations.length) {
    throw new MemoryAuditError(
      422,
      'This project has no parent, child, or configured memory-source destinations',
    );
  }
  await prepareGroupSandbox(projectId);
  const memories = (await getCurrentProjectMemoriesForAudit(projectId)).map(
    (memory) => ({
      memory,
      fingerprint: memoryStructuralFingerprint(memory),
    }),
  );
  const result = await createMemoryAuditSnapshot({
    projectId,
    initiatedBy: userId,
    runtimeId: runtime.id,
    promptVersion: MEMORY_REORGANIZE_PROMPT_VERSION,
    baselineFingerprint: baselineFingerprint(memories),
    memories,
    mode: 'reorganize',
  });
  if (result.audit.total_items === 0) {
    await setMemoryAuditStatus(result.audit.id, 'applied', {
      processed_items: 0,
      proposal_items: 0,
    });
    const ready = await getMemoryAudit(result.audit.id);
    if (ready) {
      broadcastAuditUpdate(ready);
      await notifyAuditStatus(ready, 'applied');
    }
  } else if (
    result.created ||
    ['queued', 'running'].includes(result.audit.status)
  ) {
    queueAudit(result.audit.id);
  }
  return {
    audit: (await getMemoryAudit(result.audit.id))!,
    created: result.created,
  };
}

export async function resumeProjectMemoryAudit(
  auditId: string,
): Promise<MemoryAudit> {
  const audit = await getMemoryAudit(auditId);
  if (!audit) throw new MemoryAuditError(404, 'Memory audit not found');
  if (!['paused', 'failed', 'queued', 'running'].includes(audit.status)) {
    throw new MemoryAuditError(
      409,
      `Cannot resume an audit in ${audit.status} state`,
    );
  }
  await setMemoryAuditStatus(audit.id, 'queued', {
    error: null,
    retry_count: 0,
  });
  queueAudit(audit.id, true);
  return (await getMemoryAudit(audit.id))!;
}

const INTERRUPTED_APPLY_MESSAGE =
  'Apply was interrupted by a board restart. Already applied proposals are kept; apply again to finish the rest.';

// An apply runs in-process, so a row still `applying` at startup was cut off
// by a crash or restart. Return it to `ready` for a manual re-apply (applied
// items keep `applied_at` and are skipped); never replay it automatically.
async function reconcileInterruptedMemoryAuditApplies(): Promise<void> {
  try {
    for (const audit of await listApplyingMemoryAudits()) {
      if (activeApplies.has(audit.id)) continue;
      if (
        await returnInterruptedMemoryAuditToReady(
          audit.id,
          INTERRUPTED_APPLY_MESSAGE,
        )
      ) {
        logger.warn(
          { auditId: audit.id, projectId: audit.project_id },
          'memory audit apply was interrupted; returned to ready',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'memory audit interrupted-apply recovery failed');
  }
}

export async function recoverMemoryAudits(): Promise<void> {
  await reconcileInterruptedMemoryAuditApplies();
  for (const audit of await listRecoverableMemoryAudits()) queueAudit(audit.id);
}

export async function getProjectMemoryAudits(
  projectId: string,
): Promise<MemoryAudit[]> {
  // Also repairs legacy/interrupted `ready` audits with no review work so the
  // list and controls immediately reflect that the project is free.
  await getActiveMemoryAudit(projectId);
  return listMemoryAudits(projectId);
}

export async function getProjectMemoryAuditReport(
  projectId: string,
): Promise<MemoryAuditReport> {
  if (!getGroupByFolder(projectId)) {
    throw new MemoryAuditError(404, 'Project not found');
  }
  return getStoredMemoryAuditReport(projectId);
}

function matchesAppliedEnhancement(
  item: MemoryAuditItem,
  memory: Memory,
): boolean {
  if (
    item.disposition !== 'enhance' ||
    !item.proposed_content ||
    !item.proposed_memory_type
  ) {
    return false;
  }
  return (
    memoryStructuralFingerprint(memory) ===
    memoryStructuralFingerprint({
      ...memory,
      content: item.proposed_content,
      memory_type: item.proposed_memory_type,
      tags: item.proposed_tags ?? [],
    })
  );
}

export async function getProjectMemoryAudit(
  auditId: string,
  projectId?: string,
): Promise<MemoryAuditView> {
  const audit = await getMemoryAudit(auditId);
  if (!audit || (projectId && audit.project_id !== projectId))
    throw new MemoryAuditError(404, 'Memory audit not found');
  let rawItems = await listMemoryAuditItems(audit.id);
  const deletedByAppliedReview = new Set<string>();
  for (const item of rawItems) {
    if (!item.applied_at) continue;
    if (
      item.review_decision === 'delete_memory' ||
      (item.review_decision === 'approved' &&
        (item.disposition === 'erase' || item.disposition === 'merge'))
    ) {
      deletedByAppliedReview.add(item.memory_id);
    }
    if (item.review_decision === 'delete_both') {
      deletedByAppliedReview.add(item.memory_id);
      if (item.merge_target_id)
        deletedByAppliedReview.add(item.merge_target_id);
    }
  }
  if (deletedByAppliedReview.size) {
    const repaired = await dismissMemoryAuditItemsForDeletedMemories({
      auditId: audit.id,
      deletedMemoryIds: [...deletedByAppliedReview],
      exceptItemId: '',
      reviewer: 'system:deletion-dependency-repair',
    });
    if (repaired.length) rawItems = await listMemoryAuditItems(audit.id);
  }
  const items: MemoryAuditItem[] = [];
  for (const item of rawItems) {
    const isCreate = item.disposition === 'create';
    const resolvedMemoryId = item.applied_memory_id ?? item.memory_id;
    const memory =
      isCreate && !item.applied_memory_id
        ? null
        : ((await getMemory(resolvedMemoryId)) ?? null);
    const certificate = memory
      ? await getActiveMemoryEvidenceCertificate(memory.id)
      : null;
    items.push({
      ...item,
      memory,
      certificate,
      stale:
        !item.applied_at &&
        !isCreate &&
        (!memory ||
          memory.group_folder !== audit.project_id ||
          (memoryStructuralFingerprint(memory) !== item.memory_fingerprint &&
            !matchesAppliedEnhancement(item, memory))),
    });
  }
  const byMemoryId = new Map(items.map((item) => [item.memory_id, item]));
  for (const item of items) {
    if (
      item.applied_at ||
      item.disposition !== 'merge' ||
      !item.merge_target_id
    )
      continue;
    const target = byMemoryId.get(item.merge_target_id);
    if (
      !target?.memory ||
      memoryStructuralFingerprint(target.memory) !== target.memory_fingerprint
    ) {
      item.stale = true;
    }
  }
  if (audit.mode === 'reorganize') {
    const allowedTargets = new Set(
      relatedMemoryProjects(audit.project_id, registeredGroups).map(
        (project) => project.id,
      ),
    );
    for (const item of items) {
      if (
        !item.applied_at &&
        item.disposition === 'move' &&
        (!item.target_project_id || !allowedTargets.has(item.target_project_id))
      ) {
        item.stale = true;
      }
    }
  }
  const review = summarizeMemoryAuditReview(audit.status, items);
  if (
    audit.status === 'ready' &&
    audit.processed_items >= audit.total_items &&
    review.counts.pending === 0 &&
    review.counts.applicable === 0
  ) {
    await setMemoryAuditStatus(audit.id, 'applied');
    audit.status = 'applied';
    audit.applied_at = new Date().toISOString();
  }
  return {
    ...audit,
    items,
    index_summary:
      audit.mode === 'index'
        ? await (async () => {
            const summary = await getMemoryIndexAuditSummary(audit.id);
            return summary.discovered > 0 || summary.finished_at
              ? summary
              : null;
          })()
        : null,
    related_projects:
      audit.mode === 'reorganize'
        ? relatedMemoryProjects(audit.project_id, registeredGroups).map(
            ({ id, name, relationship }) => ({ id, name, relationship }),
          )
        : [],
    ...review,
  };
}

export async function reviewMemoryAuditItem(args: {
  auditId: string;
  itemId: string;
  revision: number;
  decision: MemoryAuditReviewDecision;
  reviewer: string;
  edits?: Parameters<typeof updateMemoryAuditReview>[0]['edits'];
}): Promise<MemoryAuditView> {
  const audit = await getMemoryAudit(args.auditId);
  if (!audit) throw new MemoryAuditError(404, 'Memory audit not found');
  if (
    !['queued', 'running', 'ready', 'paused', 'failed'].includes(audit.status)
  ) {
    throw new MemoryAuditError(
      409,
      `Cannot review an audit in ${audit.status} state`,
    );
  }
  const item = (await listMemoryAuditItems(audit.id)).find(
    (candidate) => candidate.id === args.itemId,
  );
  if (
    !item ||
    !['complete', 'certified'].includes(item.processing_state) ||
    !!item.applied_at ||
    !['rewrite', 'merge', 'erase', 'create', 'enhance', 'move'].includes(
      item.disposition ?? '',
    )
  ) {
    throw new MemoryAuditError(404, 'Audit proposal not found');
  }
  if (
    args.decision === 'delete_memory' ||
    args.decision === 'delete_both' ||
    args.decision === 'dismissed'
  ) {
    const viewItem = (await getProjectMemoryAudit(audit.id)).items.find(
      (candidate) => candidate.id === item.id,
    );
    if (!viewItem) throw new MemoryAuditError(404, 'Audit proposal not found');
    if (
      args.decision === 'dismissed' &&
      !viewItem.stale &&
      !viewItem.apply_error
    ) {
      throw new MemoryAuditError(
        409,
        'Only stale or apply-failed proposals can be dismissed without applying them',
      );
    }
    if (
      args.decision === 'delete_memory' &&
      (!['rewrite', 'merge'].includes(viewItem.disposition ?? '') ||
        !viewItem.memory ||
        viewItem.memory.group_folder !== audit.project_id)
    ) {
      throw new MemoryAuditError(
        409,
        'Delete memory requires a rewrite or merge-source memory that still exists in this project',
      );
    }
    if (
      args.decision === 'delete_both' &&
      (viewItem.disposition !== 'merge' || viewItem.stale)
    ) {
      throw new MemoryAuditError(
        409,
        'Delete both requires a live merge proposal with both memories available',
      );
    }
  }
  if (args.edits?.target_project_id !== undefined) {
    if (audit.mode !== 'reorganize' || item.disposition !== 'move') {
      throw new MemoryAuditError(
        400,
        'target_project_id is only editable for move proposals',
      );
    }
    const allowedTargets = new Set(
      relatedMemoryProjects(audit.project_id, registeredGroups).map(
        (project) => project.id,
      ),
    );
    if (!allowedTargets.has(args.edits.target_project_id)) {
      throw new MemoryAuditError(400, 'Move destination is not related');
    }
  }
  const changed = await updateMemoryAuditReview(args);
  if (!changed)
    throw new MemoryAuditError(
      409,
      'Review revision changed; reload and retry',
    );
  return getProjectMemoryAudit(audit.id);
}

export async function forceRecheckMemory(
  auditId: string,
  memoryId: string,
): Promise<void> {
  const audit = await getMemoryAudit(auditId);
  if (!audit) throw new MemoryAuditError(404, 'Memory audit not found');
  if (audit.mode === 'index') {
    throw new MemoryAuditError(
      409,
      'Index proposals are immutable; start a new index job to rediscover project knowledge',
    );
  }
  const item = (await listMemoryAuditItems(audit.id)).find(
    (candidate) => candidate.memory_id === memoryId,
  );
  if (!item)
    throw new MemoryAuditError(404, 'Memory is not part of this audit');
  const memory = await getMemory(memoryId);
  if (!memory || memory.group_folder !== audit.project_id) {
    throw new MemoryAuditError(404, 'Memory no longer exists in this project');
  }
  if (audit.mode === 'cleanup') {
    await revokeMemoryEvidenceCertificate(memoryId);
  }
  await resetMemoryAuditItem(
    item.id,
    memoryStructuralFingerprint(memory),
    item.revision,
  );
  await setMemoryAuditStatus(audit.id, 'queued', { error: null });
  queueAudit(audit.id);
}

export async function deleteSkippedAuditMemory(args: {
  auditId: string;
  projectId: string;
  itemId: string;
  reviewer: string;
}): Promise<MemoryAuditView> {
  const audit = await getMemoryAudit(args.auditId);
  if (!audit || audit.project_id !== args.projectId) {
    throw new MemoryAuditError(404, 'Memory audit not found');
  }
  const item = (await listMemoryAuditItems(audit.id)).find(
    (candidate) => candidate.id === args.itemId,
  );
  if (!item || item.processing_state !== 'error') {
    throw new MemoryAuditError(404, 'Skipped audit memory not found');
  }
  if (!item.applied_at) {
    const memory = await getMemory(item.memory_id);
    if (memory) {
      if (
        memory.group_folder !== audit.project_id ||
        memoryStructuralFingerprint(memory) !== item.memory_fingerprint
      ) {
        throw new MemoryAuditError(
          409,
          'Skipped memory changed before deletion; run a new audit or delete it from Existing Memories',
        );
      }
      await eraseAuditMemoriesTogether(audit.project_id, [memory]);
    }
    const marked = await markSkippedMemoryAuditItemDeleted({
      auditId: audit.id,
      itemId: item.id,
      reviewer: args.reviewer,
    });
    if (!marked) {
      throw new MemoryAuditError(409, 'Skipped audit item changed; reload');
    }
  }
  return getProjectMemoryAudit(audit.id, audit.project_id);
}

async function proposalEvidenceStillValid(
  projectId: string,
  item: MemoryAuditItem,
): Promise<boolean> {
  if (!item.proposal_evidence?.length) return false;
  for (const evidence of item.proposal_evidence) {
    if (sha256Hex(evidence.excerpt) !== evidence.excerpt_sha256) return false;
    let file: Awaited<ReturnType<typeof readSandboxFile>>;
    try {
      file = await readSandboxFile(
        projectId,
        evidence.path,
        evidence.repository_root,
      );
    } catch {
      return false;
    }
    if (
      sha256Hex(file.content) !== evidence.file_sha256 ||
      !file.content.includes(evidence.excerpt)
    ) {
      return false;
    }
    if (evidence.watched_scope) {
      try {
        const scope = await readSandboxFile(
          projectId,
          evidence.watched_scope,
          evidence.repository_root,
        );
        if (sha256Hex(scope.content) !== evidence.watched_scope_sha256)
          return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

async function eraseAuditMemoriesTogether(
  projectId: string,
  memories: Memory[],
): Promise<void> {
  const unique = [
    ...new Map(memories.map((memory) => [memory.id, memory])).values(),
  ];
  await withMemoryLifecycleLock(projectId, async () => {
    // Enqueue the complete set before any fallible secondary-store cleanup so
    // a retry can never leave one half of an approved delete-both merge alive.
    await eraseMemoriesDurably(
      unique.map((memory) => memory.id),
      projectId,
      unique.map((memory) => memory.content).join('\n'),
    );
  });
}

async function assertAuditMemoryUnchanged(
  projectId: string,
  memoryId: string,
  fingerprint: string,
): Promise<void> {
  const latest = await getMemory(memoryId);
  if (
    !latest ||
    latest.group_folder !== projectId ||
    memoryStructuralFingerprint(latest) !== fingerprint
  ) {
    throw new MemoryAuditError(409, `Memory ${memoryId} changed before apply`);
  }
}

async function applySingleMemoryAuditItem(
  view: MemoryAuditView,
  item: MemoryAuditItem,
  allowedMoveTargets: Set<string>,
  automaticallyResolvedItemIds: Set<string>,
  reviewer: string,
): Promise<void> {
  if (item.review_decision === 'dismissed') {
    await markMemoryAuditItemApplied(item.id);
    return;
  }
  if (item.disposition === 'create' || item.disposition === 'enhance') {
    const current =
      item.disposition === 'enhance' ? await getMemory(item.memory_id) : null;
    if (
      item.disposition === 'enhance' &&
      (!current ||
        (memoryStructuralFingerprint(current) !== item.memory_fingerprint &&
          !matchesAppliedEnhancement(item, current)))
    ) {
      throw new MemoryAuditError(
        409,
        `Memory ${item.memory_id} changed before enhancement`,
      );
    }
    if (item.review_decision === 'rejected') {
      await markMemoryAuditItemApplied(item.id);
      return;
    }
    if (!(await proposalEvidenceStillValid(view.project_id, item))) {
      throw new MemoryAuditError(
        409,
        `Repository evidence for index proposal ${item.id} changed; start a new index job`,
      );
    }
    if (
      !item.proposed_content ||
      !item.proposed_memory_type ||
      item.proposed_importance === null ||
      item.proposed_importance === undefined
    ) {
      throw new MemoryAuditError(
        422,
        `Index proposal ${item.id} is incomplete`,
      );
    }
    let resultingMemory: Memory;
    if (item.disposition === 'create') {
      const deterministicId = `mem-index-${sha256Hex(`${view.id}:${item.id}`).slice(0, 32)}`;
      const sourceRef = `memory-index:${view.id}#${item.id}`;
      resultingMemory = await withMemoryLifecycleLock(
        view.project_id,
        async () => {
          const existing = await getMemory(deterministicId);
          if (existing) {
            if (
              existing.group_folder !== view.project_id ||
              existing.sourceRef !== sourceRef
            ) {
              throw new MemoryAuditError(
                409,
                `Deterministic index memory ID ${deterministicId} is already in use`,
              );
            }
            return existing;
          }
          const created = await insertMemory({
            id: deterministicId,
            group_folder: view.project_id,
            objective_id: null,
            content: item.proposed_content!,
            memory_type: item.proposed_memory_type!,
            importance: item.proposed_importance!,
            tags: item.proposed_tags ?? [],
            source: 'agent',
            sourceRef,
            valid_from: item.proposed_valid_from ?? new Date().toISOString(),
            valid_to: null,
          });
          const hooks = getVectorStoreHooks();
          if (hooks?.isAvailable()) {
            await hooks.embedAndStore(
              created.id,
              view.project_id,
              created.content,
              null,
            );
          }
          return created;
        },
      );
    } else {
      if (!matchesAppliedEnhancement(item, current!)) {
        await withMemoryLifecycleLock(view.project_id, async () => {
          await assertAuditMemoryUnchanged(
            view.project_id,
            item.memory_id,
            item.memory_fingerprint,
          );
          await updateMemory(item.memory_id, {
            content: item.proposed_content!,
            memory_type: item.proposed_memory_type!,
            importance: item.proposed_importance!,
            tags: item.proposed_tags ?? [],
          });
          const hooks = getVectorStoreHooks();
          if (hooks?.isAvailable()) {
            await hooks.embedAndStore(
              item.memory_id,
              view.project_id,
              item.proposed_content!,
              current!.objective_id,
            );
          }
        });
      }
      resultingMemory = (await getMemory(item.memory_id))!;
    }
    await createMemoryEvidenceCertificate({
      projectId: view.project_id,
      memoryId: resultingMemory.id,
      memoryFingerprint: memoryStructuralFingerprint(resultingMemory),
      verdict: 'keep',
      justification:
        item.reason || `${item.retrieval_value ?? 'Project'} indexing value`,
      evidenceType: 'code',
      reflectorVersion: view.prompt_version,
      origin: 'automatic',
      expiresAt: null,
      files: item.proposal_evidence,
    });
    await markMemoryAuditItemApplied(item.id, undefined, resultingMemory.id);
    return;
  }
  const current = await getMemory(item.memory_id);
  if (
    !current ||
    current.group_folder !== view.project_id ||
    (item.review_decision !== 'delete_memory' &&
      memoryStructuralFingerprint(current) !== item.memory_fingerprint)
  ) {
    throw new MemoryAuditError(
      409,
      `Memory ${item.memory_id} changed before apply`,
    );
  }
  if (item.review_decision === 'delete_both') {
    const targetSnapshot = item.merge_target_id
      ? view.items.find(
          (candidate) => candidate.memory_id === item.merge_target_id,
        )
      : null;
    const target = item.merge_target_id
      ? await getMemory(item.merge_target_id)
      : null;
    if (
      item.disposition !== 'merge' ||
      !target ||
      target.group_folder !== view.project_id ||
      !targetSnapshot ||
      memoryStructuralFingerprint(target) !== targetSnapshot.memory_fingerprint
    ) {
      throw new MemoryAuditError(
        409,
        'Both merge memories must remain unchanged until delete-both is applied',
      );
    }
    await withMemoryLifecycleLock(view.project_id, async () => {
      await assertAuditMemoryUnchanged(
        view.project_id,
        current.id,
        item.memory_fingerprint,
      );
      await assertAuditMemoryUnchanged(
        view.project_id,
        target.id,
        targetSnapshot.memory_fingerprint,
      );
      await eraseAuditMemoriesTogether(view.project_id, [current, target]);
    });
    for (const resolvedId of await dismissMemoryAuditItemsForDeletedMemories({
      auditId: view.id,
      deletedMemoryIds: [current.id, target.id],
      exceptItemId: item.id,
      reviewer,
    })) {
      automaticallyResolvedItemIds.add(resolvedId);
    }
    await markMemoryAuditItemApplied(item.id);
    return;
  }
  if (item.review_decision === 'delete_memory') {
    if (!['rewrite', 'merge'].includes(item.disposition ?? '')) {
      throw new MemoryAuditError(
        409,
        'Delete memory is only valid for rewrite and merge proposals',
      );
    }
    await eraseAuditMemoriesTogether(view.project_id, [current]);
    for (const resolvedId of await dismissMemoryAuditItemsForDeletedMemories({
      auditId: view.id,
      deletedMemoryIds: [current.id],
      exceptItemId: item.id,
      reviewer,
    })) {
      automaticallyResolvedItemIds.add(resolvedId);
    }
    await markMemoryAuditItemApplied(item.id);
    return;
  }
  if (item.disposition === 'move') {
    const targetProjectId = item.target_project_id;
    if (
      !targetProjectId ||
      !allowedMoveTargets.has(targetProjectId) ||
      !getGroupByFolder(targetProjectId)
    ) {
      throw new MemoryAuditError(
        409,
        `Move target for memory ${item.memory_id} is no longer related`,
      );
    }
    if (item.review_decision === 'rejected') {
      await markMemoryAuditItemApplied(item.id);
      return;
    }
    const wasMarkedForEval = historyMemoryEvalMarkedIds(view.project_id).has(
      item.memory_id,
    );
    await withMemoryLifecycleLock(view.project_id, async () => {
      await assertAuditMemoryUnchanged(
        view.project_id,
        item.memory_id,
        item.memory_fingerprint,
      );
      await moveMemoryToGroup(item.memory_id, targetProjectId);
      const hooks = getVectorStoreHooks();
      if (hooks?.isAvailable()) {
        await hooks.moveMemoryScope?.(
          item.memory_id,
          view.project_id,
          targetProjectId,
        );
      }
      await revokeMemoryEvidenceCertificate(item.memory_id);
    });
    if (wasMarkedForEval) {
      const moved = await getMemory(item.memory_id);
      setHistoryMemoryEvalMark(view.project_id, current, false, reviewer);
      if (moved) {
        setHistoryMemoryEvalMark(targetProjectId, moved, true, reviewer);
      }
    }
    await markMemoryAuditItemApplied(item.id);
    return;
  }
  if (item.review_decision === 'rejected') {
    await createMemoryEvidenceCertificate({
      projectId: view.project_id,
      memoryId: item.memory_id,
      memoryFingerprint: item.memory_fingerprint,
      verdict: 'human_keep',
      justification: item.reason || 'Human reviewer chose to keep this memory',
      evidenceType: 'human',
      reflectorVersion: view.prompt_version,
      origin: 'human',
      expiresAt: null,
    });
    await markMemoryAuditItemApplied(item.id);
    return;
  }
  const certificate = await getActiveMemoryEvidenceCertificate(item.memory_id);
  if (!certificate) {
    throw new MemoryAuditError(
      409,
      `Memory ${item.memory_id} has no active evidence certificate; re-check the memory before applying`,
    );
  }
  if (certificate.memory_fingerprint !== item.memory_fingerprint) {
    throw new MemoryAuditError(
      409,
      `Evidence certificate for memory ${item.memory_id} predates the audited version; re-check the memory before applying`,
    );
  }
  if (!(await certificateStillValid(view.project_id, current, certificate))) {
    throw new MemoryAuditError(
      409,
      `Repository evidence for memory ${item.memory_id} changed since the audit; re-check the memory before applying`,
    );
  }
  if (item.disposition === 'rewrite') {
    await withMemoryLifecycleLock(view.project_id, async () => {
      await assertAuditMemoryUnchanged(
        view.project_id,
        item.memory_id,
        item.memory_fingerprint,
      );
      await updateMemory(item.memory_id, {
        content: item.proposed_content || current.content,
        memory_type: item.proposed_memory_type || current.memory_type,
        importance: item.proposed_importance ?? current.importance,
        tags: item.proposed_tags ?? current.tags,
      });
      const hooks = getVectorStoreHooks();
      if (hooks?.isAvailable()) {
        await hooks.embedAndStore(
          item.memory_id,
          view.project_id,
          item.proposed_content || current.content,
          current.objective_id,
        );
      }
    });
    await revokeMemoryEvidenceCertificate(item.memory_id);
  } else if (item.disposition === 'merge') {
    const target = item.merge_target_id
      ? await getMemory(item.merge_target_id)
      : null;
    const targetSnapshot = item.merge_target_id
      ? view.items.find(
          (candidate) => candidate.memory_id === item.merge_target_id,
        )
      : null;
    if (
      !target ||
      target.group_folder !== view.project_id ||
      !targetSnapshot ||
      memoryStructuralFingerprint(target) !== targetSnapshot.memory_fingerprint
    )
      throw new MemoryAuditError(409, 'Merge target is unavailable');
    await withMemoryLifecycleLock(view.project_id, async () => {
      await assertAuditMemoryUnchanged(
        view.project_id,
        current.id,
        item.memory_fingerprint,
      );
      await assertAuditMemoryUnchanged(
        view.project_id,
        target.id,
        targetSnapshot.memory_fingerprint,
      );
      if (item.proposed_content) {
        const mergedContent = item.proposed_content;
        await updateMemory(target.id, {
          content: mergedContent,
          memory_type: item.proposed_memory_type || target.memory_type,
          importance:
            item.proposed_importance ??
            Math.max(target.importance, current.importance),
          tags: item.proposed_tags ?? [
            ...new Set([...(target.tags ?? []), ...(current.tags ?? [])]),
          ],
        });
        const hooks = getVectorStoreHooks();
        if (hooks?.isAvailable())
          await hooks.embedAndStore(
            target.id,
            view.project_id,
            mergedContent,
            target.objective_id,
          );
      }
      await getMemoryBackend().erase(current.id, {
        group_folder: view.project_id,
      });
    });
  } else if (item.disposition === 'erase') {
    await withMemoryLifecycleLock(view.project_id, async () => {
      await assertAuditMemoryUnchanged(
        view.project_id,
        current.id,
        item.memory_fingerprint,
      );
      await getMemoryBackend().erase(current.id, {
        group_folder: view.project_id,
      });
    });
  }
  await markMemoryAuditItemApplied(item.id);
}

async function applyReviewedMemoryAuditItems(
  auditId: string,
  reviewer: string,
): Promise<MemoryAuditView> {
  const view = await getProjectMemoryAudit(auditId);
  if (!view.apply_enabled)
    throw new MemoryAuditError(
      409,
      'Audit has no reviewed, non-stale proposals to apply',
    );
  const priorStatus = view.status;
  const allowedMoveTargets = new Set(
    view.mode === 'reorganize'
      ? relatedMemoryProjects(view.project_id, registeredGroups).map(
          (project) => project.id,
        )
      : [],
  );
  if (priorStatus === 'ready') await setMemoryAuditStatus(auditId, 'applying');
  try {
    const automaticallyResolvedItemIds = new Set<string>();
    const selectedItems = view.items
      .filter(
        (candidate) =>
          ['rewrite', 'merge', 'erase', 'create', 'enhance', 'move'].includes(
            candidate.disposition ?? '',
          ) &&
          !candidate.applied_at &&
          candidate.review_decision !== 'pending',
      )
      .sort((left, right) => {
        const priority = (candidate: MemoryAuditItem) =>
          candidate.review_decision === 'delete_both'
            ? 0
            : candidate.review_decision === 'delete_memory'
              ? 1
              : candidate.disposition === 'erase' &&
                  candidate.review_decision === 'approved'
                ? 2
                : 3;
        return priority(left) - priority(right);
      });
    const applyFailures: Array<{ memoryId: string; message: string }> = [];
    for (const item of selectedItems) {
      if (automaticallyResolvedItemIds.has(item.id)) continue;
      try {
        await applySingleMemoryAuditItem(
          view,
          item,
          allowedMoveTargets,
          automaticallyResolvedItemIds,
          reviewer,
        );
      } catch (error) {
        if (!(error instanceof MemoryAuditError) || error.status !== 409) {
          throw error;
        }
        // Expected conflict: the memory or its evidence drifted since
        // review. Record the failure on the item and keep applying the
        // remaining reviewed decisions.
        await markMemoryAuditItemApplied(item.id, error.message);
        applyFailures.push({
          memoryId: item.memory_id,
          message: error.message,
        });
        logger.warn(
          {
            auditId,
            itemId: item.id,
            memoryId: item.memory_id,
            error: error.message,
          },
          'memory audit item failed to apply; continuing with remaining items',
        );
      }
    }
    const updated = await getProjectMemoryAudit(auditId);
    const latestBeforeFinalize = await getMemoryAudit(auditId);
    const isComplete =
      !!latestBeforeFinalize &&
      ['ready', 'applying'].includes(latestBeforeFinalize.status) &&
      latestBeforeFinalize.processed_items >=
        latestBeforeFinalize.total_items &&
      updated.counts.pending === 0 &&
      updated.counts.applicable === 0;
    if (isComplete) {
      await setMemoryAuditStatus(auditId, 'applied');
    } else if (priorStatus === 'ready') {
      await setMemoryAuditStatus(auditId, 'ready');
    }
    if (applyFailures.length > 0) {
      const summaryMessages = applyFailures
        .slice(0, 3)
        .map((failure) => failure.message);
      const summary = `${applyFailures.length} proposal(s) could not be applied: ${summaryMessages.join(' | ')}${applyFailures.length > 3 ? ` | ${applyFailures.length - 3} more` : ''}`;
      if (priorStatus === 'ready') {
        await setMemoryAuditStatus(auditId, 'ready', { error: summary });
      }
      logger.warn(
        { auditId, failureCount: applyFailures.length, summary },
        'memory audit apply completed with per-item failures',
      );
    }
    const latest = await getMemoryAudit(auditId);
    if (latest) {
      broadcastAuditUpdate(latest);
      if (isComplete) await notifyAuditStatus(latest, 'applied');
    }
    return getProjectMemoryAudit(auditId);
  } catch (error) {
    if (priorStatus === 'ready') {
      await setMemoryAuditStatus(auditId, 'ready', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

export function applyProjectMemoryAudit(
  auditId: string,
  reviewer: string,
): Promise<MemoryAuditView> {
  const active = activeApplies.get(auditId);
  if (active) return active;
  const applying = applyReviewedMemoryAuditItems(auditId, reviewer).finally(
    () => activeApplies.delete(auditId),
  );
  activeApplies.set(auditId, applying);
  return applying;
}

export function approveAndApplyProjectMemoryAudit(
  auditId: string,
  reviewer: string,
): Promise<MemoryAuditView> {
  const active = activeApplies.get(auditId);
  if (active) return active;
  const applying = (async () => {
    const view = await getProjectMemoryAudit(auditId);
    const isProposal = (item: MemoryAuditItem) =>
      ['rewrite', 'merge', 'erase', 'create', 'enhance', 'move'].includes(
        item.disposition ?? '',
      ) && !item.applied_at;
    const unsafeReviewed = view.items.filter(
      (item) =>
        isProposal(item) &&
        item.review_decision !== 'pending' &&
        item.stale &&
        !['dismissed', 'delete_memory'].includes(item.review_decision),
    );
    if (unsafeReviewed.length > 0) {
      throw new MemoryAuditError(
        409,
        'A reviewed proposal became stale; resolve it before applying all',
      );
    }
    const pendingItemIds = view.items
      .filter(
        (item) =>
          isProposal(item) && item.review_decision === 'pending' && !item.stale,
      )
      .map((item) => item.id);
    if (pendingItemIds.length === 0 && view.counts.applicable === 0) {
      throw new MemoryAuditError(
        409,
        'Audit has no pending or reviewed, non-stale proposals to apply',
      );
    }
    await approvePendingMemoryAuditItems({
      auditId,
      itemIds: pendingItemIds,
      reviewer,
    });
    return applyReviewedMemoryAuditItems(auditId, reviewer);
  })().finally(() => activeApplies.delete(auditId));
  activeApplies.set(auditId, applying);
  return applying;
}
