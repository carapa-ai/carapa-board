import { z } from 'zod';
import { logger } from '../../logger.js';
import { ToolDefinition } from '../tools/types.js';
import { hasPermission } from '../../mcp/auth.js';
import { MemoryType } from './types.js';
import { parseTagsInput } from './parse-tags.js';
import { getMemoryBackend } from './backend/factory.js';
import {
  applyPrivacyRecallScope,
  resolveRecallGroupFolders,
} from './backend/scope.js';
import { registeredGroups } from '../../state-manager.js';
import { countObjectiveScopedMemories } from './db-memories.js';
import {
  getDefaultImportance,
  getMemory,
  getObjective,
  insertSupersedingMemory,
} from '../../db.js';
import { getVectorStoreHooks } from '../vector-store/hooks.js';
import { syncGraphInvalidation } from './graph-invalidation.js';
import { withMemoryLifecycleLock } from './lifecycle-lock.js';
import { getPrivacyErasureEpoch } from './privacy-epoch.js';
import { wordOverlap } from './word-overlap.js';
import { isDuplicateMemoryContent } from './dedup.js';
import { matchOpenCardReference } from './open-card-match.js';
import { loadOpenProjectCards } from './open-card-reflection.js';
import type {
  EvidenceDivergence,
  MemoryEvidenceReference,
  ReflectorMemoryExecutionContext,
} from './execution-context.js';
import {
  effectivePreviewMemories,
  ReflectorEvidenceError,
  ReflectorValidationError,
  resolveEffectivePreviewMemory,
} from './execution-context.js';
import {
  abandonReflectorOperation,
  beginReflectorOperation,
  finishReflectorOperation,
  recordTranscriptEvidence,
  reflectorRequestFingerprint,
  reflectorResultMemoryId,
  updateReflectorOperationResultMemoryId,
} from './reflector-state.js';

/**
 * A reflector chunk whose evidence all belongs to one objective recalls within
 * that objective by default, so it can dedupe against scoped memories. Mixed,
 * project-wide, or unscoped evidence yields no default.
 */
function singleEvidenceObjectiveId(
  context: ReflectorMemoryExecutionContext | undefined,
): string | undefined {
  if (context?.kind !== 'reflector' || context.evidence.size === 0) {
    return undefined;
  }
  let objectiveId: string | undefined;
  for (const message of context.evidence.values()) {
    if (!message.objectiveId) return undefined;
    if (objectiveId !== undefined && objectiveId !== message.objectiveId) {
      return undefined;
    }
    objectiveId = message.objectiveId;
  }
  return objectiveId;
}

const isoTimestampSchema = z.string().datetime({ offset: true });

/** Clock-skew allowance when rejecting future validFrom/effectiveAt values. */
const FUTURE_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

function reflectorValidationError(
  context: ReflectorMemoryExecutionContext | undefined,
  operationKey: unknown,
  message: string,
  kind: 'date' | 'input',
): Error {
  return context
    ? new ReflectorValidationError(message, operationKey, kind)
    : new Error(message);
}

function validateIsoTimestamp(
  value: unknown,
  field: 'validFrom' | 'effectiveAt' | 'asOf',
  context?: ReflectorMemoryExecutionContext,
  operationKey?: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  const parsed = isoTimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw reflectorValidationError(
      context,
      operationKey,
      `${field} must be a valid ISO timestamp`,
      'date',
    );
  }
  // Validity is stored as text and compared lexicographically, so normalize
  // accepted ISO offsets to one canonical UTC representation.
  const timestamp = new Date(parsed.data);
  // A future validFrom/effectiveAt would hide a still-valid fact early, so only
  // the read-side asOf may point into the future.
  if (
    field !== 'asOf' &&
    timestamp.getTime() > Date.now() + FUTURE_TIMESTAMP_SKEW_MS
  ) {
    throw reflectorValidationError(
      context,
      operationKey,
      `${field} must not be more than 5 minutes in the future`,
      'date',
    );
  }
  return timestamp.toISOString();
}

const transcriptEvidenceSchema = z.object({
  message_id: z.string().min(1),
  excerpt: z.string().min(1),
});

function requireReflectorEvidence(
  context: ReflectorMemoryExecutionContext,
  value: unknown,
  operationKey: unknown,
): MemoryEvidenceReference[] {
  const parsed = z.array(transcriptEvidenceSchema).min(1).safeParse(value);
  if (!parsed.success) {
    throw new ReflectorEvidenceError(
      'evidence must contain at least one {message_id, excerpt} reference from this transcript chunk',
      operationKey,
    );
  }
  return parsed.data.map((reference) => {
    const excerpt = normalizeEvidenceText(reference.excerpt);
    if (excerpt === '') {
      throw new ReflectorEvidenceError(
        `Evidence excerpt for message "${reference.message_id}" is empty`,
        operationKey,
      );
    }
    const blocksContaining = () =>
      [...context.evidence.keys()].filter((id) =>
        normalizeEvidenceText(context.evidence.get(id)!.content).includes(
          excerpt,
        ),
      );
    // Count-only diagnostics: never log the excerpt, ids or any block text.
    const reattribute = (
      others: string[],
      citedKind: 'exact' | 'bare',
    ): string | undefined => {
      if (others.length !== 1) return undefined;
      logger.info(
        { evidenceReattributed: true, citedKind },
        'Reflector evidence re-attributed to the block containing the excerpt',
      );
      return others[0];
    };
    const rejectNotVerbatim = (citedBlockId: string): never => {
      const divergence = classifyEvidenceDivergence(
        context,
        citedBlockId,
        excerpt,
      );
      logger.info(
        {
          evidenceDivergenceClass: divergence.class,
          citedBlockLength: divergence.citedBlockLength,
          excerptLength: excerpt.length,
        },
        'Reflector evidence excerpt rejected as not verbatim',
      );
      throw new ReflectorEvidenceError(
        `Evidence excerpt for message "${reference.message_id}" is not verbatim (divergence: ${divergence.class}; cited block length: ${divergence.citedBlockLength} chars)`,
        operationKey,
        divergence,
      );
    };
    let messageId = reference.message_id;
    if (!context.evidence.has(messageId)) {
      // Models often cite the bare transcript entry id. Resolution order: the
      // single block of that entry holding the excerpt; else the single block
      // anywhere in the chunk holding it; else a not-verbatim rejection. An id
      // that prefixes no block is unknown and is never re-attributed.
      const blockIds = [...context.evidence.keys()].filter((id) =>
        id.startsWith(`${messageId}:`),
      );
      const containing = blocksContaining();
      const matching = blockIds.filter((id) => containing.includes(id));
      if (matching.length === 1) {
        messageId = matching[0]!;
      } else if (matching.length > 1 || blockIds.length === 0) {
        throw new ReflectorEvidenceError(
          `Evidence message "${messageId}" ${
            matching.length > 1
              ? 'matches several blocks of this reflector chunk; cite one of'
              : 'is not in this reflector chunk; valid ids include'
          }: ${formatValidEvidenceIds(context, blockIds)}`,
          operationKey,
        );
      } else {
        const moved = reattribute(containing, 'bare');
        if (moved) {
          messageId = moved;
        } else if (blockIds.length === 1) {
          rejectNotVerbatim(blockIds[0]!);
        } else {
          throw new ReflectorEvidenceError(
            `Evidence excerpt for message "${messageId}" is not verbatim in any block of that entry; cite one of: ${formatValidEvidenceIds(context, blockIds)}`,
            operationKey,
          );
        }
      }
    } else if (
      !normalizeEvidenceText(context.evidence.get(messageId)!.content).includes(
        excerpt,
      )
    ) {
      const moved = reattribute(blocksContaining(), 'exact');
      if (moved) messageId = moved;
      else rejectNotVerbatim(messageId);
    }
    return { ...reference, message_id: messageId };
  });
}

const ELLIPSIS = /\.{3,}|\u2026/;
/** A shortened or extended excerpt must still share most of its length. */
const MIN_TRUNCATED_RUN = 20;
const MIN_TRUNCATED_COVERAGE = 0.8;

/** Longest prefix of `excerpt` (or suffix, when `fromEnd`) found in `content`. */
function longestVerbatimRun(
  content: string,
  excerpt: string,
  fromEnd: boolean,
): number {
  let low = 0;
  let high = excerpt.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const part = fromEnd ? excerpt.slice(-mid) : excerpt.slice(0, mid);
    if (content.includes(part)) low = mid;
    else high = mid - 1;
  }
  return low;
}

function isTruncatedVariant(content: string, excerpt: string): boolean {
  if (ELLIPSIS.test(excerpt)) {
    const segments = excerpt
      .split(new RegExp(ELLIPSIS, 'g'))
      .map((segment) => segment.trim())
      .filter(Boolean);
    return segments.length > 0 && segments.every((s) => content.includes(s));
  }
  const run = Math.max(
    longestVerbatimRun(content, excerpt, false),
    longestVerbatimRun(content, excerpt, true),
  );
  return (
    run >= MIN_TRUNCATED_RUN && run >= excerpt.length * MIN_TRUNCATED_COVERAGE
  );
}

/**
 * Explain why an excerpt is not in the cited text block. Returns only a class
 * and a length so the result is safe to put in errors and logs.
 */
function classifyEvidenceDivergence(
  context: ReflectorMemoryExecutionContext,
  messageId: string,
  excerpt: string,
): EvidenceDivergence {
  const cited = context.evidence.get(messageId)!;
  const content = normalizeEvidenceText(cited.content);
  const citedBlockLength = cited.content.length;
  for (const [id, message] of context.evidence) {
    if (
      id !== messageId &&
      normalizeEvidenceText(message.content).includes(excerpt)
    ) {
      return { class: 'other_block', citedBlockLength };
    }
  }
  if (
    cited.nonTextContent &&
    normalizeEvidenceText(cited.nonTextContent).includes(excerpt)
  ) {
    return { class: 'non_text', citedBlockLength };
  }
  return {
    class: isTruncatedVariant(content, excerpt) ? 'truncated' : 'paraphrase',
    citedBlockLength,
  };
}

/** Whitespace runs and curly/straight quotes are not meaningful differences. */
function normalizeEvidenceText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatValidEvidenceIds(
  context: ReflectorMemoryExecutionContext,
  preferred: string[],
): string {
  const ids = preferred.length > 0 ? preferred : [...context.evidence.keys()];
  return ids.slice(0, 5).join(', ');
}

function assertEvidenceTimestamps(
  context: ReflectorMemoryExecutionContext,
  references: MemoryEvidenceReference[],
  operationKey: unknown,
): void {
  for (const reference of references) {
    const message = context.evidence.get(reference.message_id)!;
    const evidenceTimestamp = Date.parse(message.createdAt);
    if (!Number.isFinite(evidenceTimestamp)) {
      throw new ReflectorValidationError(
        `Supporting message "${reference.message_id}" has an invalid timestamp (${message.createdAt})`,
        operationKey,
        'date',
      );
    }
  }
}

function earliestEvidenceTimestamp(
  context: ReflectorMemoryExecutionContext,
  references: MemoryEvidenceReference[],
  operationKey: unknown,
): string {
  assertEvidenceTimestamps(context, references, operationKey);
  return references
    .map((reference) => context.evidence.get(reference.message_id)!.createdAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .map((timestamp) => new Date(timestamp).toISOString())[0]!;
}

const PROJECT_WIDE_USER_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set([
  'identity',
  'preference',
  'contact',
]);

function resolveReflectorObjectiveId(
  context: ReflectorMemoryExecutionContext,
  references: MemoryEvidenceReference[],
  requestedObjectiveId: string | null | undefined,
  operation: 'create' | 'supersede' | 'invalidate',
  memoryType: MemoryType,
  operationKey: unknown,
): string | undefined {
  const scopes = references.map(
    (reference) => context.evidence.get(reference.message_id)!.objectiveId,
  );
  const authoritativeScopes = new Set(
    scopes.filter((scope) => scope !== undefined),
  );
  if (authoritativeScopes.size > 1) {
    const labels = [...authoritativeScopes]
      .map((scope) => scope ?? 'project-wide')
      .join(', ');
    throw new ReflectorValidationError(
      `Supporting transcript evidence spans multiple objective scopes (${labels}); use separate memorize operations supported by evidence from one scope each`,
      operationKey,
      'evidence',
    );
  }
  const authoritativeScope = [...authoritativeScopes][0];
  if (requestedObjectiveId === null) {
    // Explicit project-wide request. Never guess without authoritative
    // metadata on every cited message.
    if (scopes.some((scope) => scope === undefined)) {
      throw new ReflectorValidationError(
        'objective_id null requires supporting transcript evidence with authoritative objective metadata',
        operationKey,
        'evidence',
      );
    }
    if (
      authoritativeScope !== null &&
      (operation !== 'create' ||
        !PROJECT_WIDE_USER_MEMORY_TYPES.has(memoryType))
    ) {
      throw new ReflectorValidationError(
        'objective_id null is allowed only for creating user identity, preference or contact memories from objective evidence',
        operationKey,
        'input',
      );
    }
    return undefined;
  }
  if (requestedObjectiveId && authoritativeScope === null) {
    throw new ReflectorValidationError(
      `objective_id "${requestedObjectiveId}" conflicts with project-wide supporting transcript evidence`,
      operationKey,
      'evidence',
    );
  }
  if (
    requestedObjectiveId &&
    authoritativeScope !== undefined &&
    authoritativeScope !== null &&
    requestedObjectiveId !== authoritativeScope
  ) {
    throw new ReflectorValidationError(
      `objective_id "${requestedObjectiveId}" conflicts with supporting transcript evidence scoped to objective "${authoritativeScope}"`,
      operationKey,
      'evidence',
    );
  }
  // Infer only when every cited message has authoritative server-authored
  // metadata and all of them belong to the same objective.
  if (scopes.some((scope) => scope === undefined)) return requestedObjectiveId;
  const evidenceObjectiveId = authoritativeScope;
  if (evidenceObjectiveId === null) {
    return undefined;
  }
  return requestedObjectiveId ?? evidenceObjectiveId;
}

function reflectorOperationKey(
  context: ReflectorMemoryExecutionContext,
  value: unknown,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      'operation_key is required for reflector writes; derive a stable key from the supporting message id and fact',
    );
  }
  return `${context.chunkKey}:${value.trim()}`;
}

function memoryVersionError(memoryId: string): Error {
  return new Error(
    `Memory ${memoryId} changed concurrently; call recall again and retry with its current updated value as expected_version.`,
  );
}

function operationKeyReuseError(operationKey: unknown): Error {
  return new Error(
    `operation_key "${operationKey}" was already used for a different write in this run`,
  );
}

async function assertObjectiveOwnership(
  objectiveId: string | null | undefined,
  groupFolder: string,
  execution?: ReflectorMemoryExecutionContext,
  operationKey?: unknown,
): Promise<void> {
  if (!objectiveId) return;
  const objective = await getObjective(objectiveId);
  if (!objective) {
    throw reflectorValidationError(
      execution,
      operationKey,
      `Objective "${objectiveId}" was not found; use an objective owned by project "${groupFolder}" or omit objective_id.`,
      'input',
    );
  }
  if (objective.project_id !== groupFolder) {
    throw reflectorValidationError(
      execution,
      operationKey,
      `Objective "${objectiveId}" does not belong to project "${groupFolder}"; use an objective owned by this project or omit objective_id.`,
      'input',
    );
  }
}

function assertExpectedMemory(
  memory: Awaited<ReturnType<typeof getMemory>>,
  groupFolder: string,
  memoryId: string,
  expectedVersion: unknown,
  execution?: ReflectorMemoryExecutionContext,
  operationKey?: unknown,
) {
  if (!memory) {
    throw reflectorValidationError(
      execution,
      operationKey,
      `Memory ${memoryId} not found. Recall the target and retry with a valid memory_id.`,
      'input',
    );
  }
  if (memory.group_folder !== groupFolder) {
    throw new Error(
      `Memory ${memoryId} does not belong to project "${groupFolder}"`,
    );
  }
  if (typeof expectedVersion !== 'string' || !expectedVersion) {
    throw reflectorValidationError(
      execution,
      operationKey,
      `expected_version is required for memory ${memoryId}; use the updated value returned by recall`,
      'input',
    );
  }
  if (memory.updated_at !== expectedVersion) {
    throw reflectorValidationError(
      execution,
      operationKey,
      memoryVersionError(memoryId).message,
      'input',
    );
  }
  return memory;
}

function markReflectorToolError(
  context: ReflectorMemoryExecutionContext | undefined,
  error: unknown,
): never {
  if (context) {
    context.hadToolError = true;
    if (!(error instanceof ReflectorValidationError && error.operationKey)) {
      context.hadOtherToolError = true;
    }
  }
  throw error;
}

type SupersedingMemory = NonNullable<
  Awaited<ReturnType<typeof insertSupersedingMemory>>
>;

async function synchronizeSupersedingMemory(
  replacement: SupersedingMemory,
  groupFolder: string,
  targetMemoryId: string,
  effectiveAt: string,
): Promise<void> {
  const hooks = getVectorStoreHooks();
  if (hooks?.isAvailable()) {
    await hooks.embedAndStore(
      replacement.id,
      groupFolder,
      replacement.content,
      replacement.objective_id || null,
    );
  }
  await syncGraphInvalidation(targetMemoryId, effectiveAt);
  if (replacement.valid_to) {
    await syncGraphInvalidation(replacement.id, replacement.valid_to);
  }
}

const MEMORIZE_MEMORY_TYPES = [
  'identity',
  'project',
  'goal',
  'decision',
  'preference',
  'contact',
  'event',
  'task',
] as const;

const MEMORY_CONTENT_MAX_LENGTH = 400;

export const memorizeTool: ToolDefinition = {
  name: 'memorize',
  description:
    "Store a fact, or explicitly create, supersede, or invalidate a temporally versioned memory. Supersede/invalidate require the current memory id and version returned by recall. Call recall first; if a related memory exists, supersede it instead of creating a duplicate. Do not store task progress, run logs, reminders or due dates, or anything already in the repository or AGENTS.md. A lesson that is also in a rule file may be stored when agents outside that rule's scope need it; do not copy rule text that the agents who can recall the memory already load. Content is limited to 400 characters.",
  inputSchema: {
    operation: z.enum(['create', 'supersede', 'invalidate']).optional(),
    content: z
      .string()
      .optional()
      .describe(
        'The fact to create or the replacement fact for supersede. Write one idea in at most two plain sentences (about 300 characters, hard limit 400 characters): state the decision, constraint or finding first in everyday words; put ids, task ids, commit hashes or dates at the end in one parenthesis, never at the start. Do not store status or counters (pending, merged, N remaining, review scores) — those belong on the task board.',
      ),
    memory_type: z
      .enum(MEMORIZE_MEMORY_TYPES)
      .optional()
      .describe(
        'Type of memory for categorization. Required for create and supersede.',
      ),
    importance: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Importance score 0.0–1.0 (optional; defaults by memory_type)'),
    objective_id: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Optional objective ID to scope this memory. null = project-wide; omitted = inferred from evidence. Reflector: null is allowed only when creating identity, preference or contact memories; other agents treat null as omitted.',
      ),
    tags: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        'Tags as an array, a JSON array string, or a compatibility comma-separated string',
      ),
    sourceRef: z
      .string()
      .optional()
      .describe('Source identifier (e.g. "conversation", "task-123")'),
    validFrom: isoTimestampSchema
      .optional()
      .describe(
        'ISO timestamp at which this fact became effective. Defaults to now for agent writes. For reflector writes, use an explicit date supported by the evidence, or omit it to use the earliest cited message timestamp.',
      ),
    effectiveAt: isoTimestampSchema
      .optional()
      .describe(
        'ISO timestamp at which an invalidated fact stopped being true. Defaults to now for agent writes. For reflector writes, omit it only when the cited evidence gives no earlier cessation time; the earliest cited message timestamp is then used.',
      ),
    memory_id: z
      .string()
      .optional()
      .describe('Existing memory referenced by supersede or invalidate'),
    expected_version: z
      .string()
      .optional()
      .describe('Exact updated value returned by recall for memory_id'),
    operation_key: z
      .string()
      .optional()
      .describe(
        'Stable per-operation retry key; required for reflector writes',
      ),
    evidence: z
      .array(transcriptEvidenceSchema)
      .optional()
      .describe(
        'Supporting transcript message identities and verbatim excerpts',
      ),
    project_id: z
      .string()
      .optional()
      .describe(
        "Target project ID. Defaults to the caller's project. The main agent may target any project; parent agents may target their child projects.",
      ),
  },
  requiredPermissions: ['memories:write'],
  authorizesTargetProject: true,
  handler: async (args, deps, context) => {
    const { group_folder, permissions } = context;
    const targetFolder =
      (args.project_id as string | undefined)?.trim() || group_folder;
    const {
      content,
      memory_type,
      importance,
      objective_id: requestedObjectiveId,
      tags,
      sourceRef,
    } = args;
    const execution = context.memoryExecution;

    if (!hasPermission(permissions, targetFolder, 'memories:write')) {
      throw new Error(
        `Unauthorized: missing memories:write permission for project "${targetFolder}"`,
      );
    }
    if (
      targetFolder !== group_folder &&
      !Object.values(deps.getRegisteredGroups()).some(
        (group) => group.folder === targetFolder,
      )
    ) {
      throw new Error(`Project "${targetFolder}" not found`);
    }

    try {
      const operation = args.operation as
        | 'create'
        | 'supersede'
        | 'invalidate'
        | undefined;
      const explicit = operation !== undefined;
      const resolvedOperation = operation ?? 'create';
      if (
        operation !== undefined &&
        !['create', 'supersede', 'invalidate'].includes(operation)
      ) {
        throw reflectorValidationError(
          execution,
          args.operation_key,
          'operation must be create, supersede, or invalidate',
          'input',
        );
      }
      if (
        resolvedOperation !== 'invalidate' &&
        (!content || typeof content !== 'string' || !content.trim())
      ) {
        throw reflectorValidationError(
          execution,
          args.operation_key,
          'Memory content is required and must be a non-empty string',
          'input',
        );
      }
      if (resolvedOperation !== 'invalidate' && !memory_type) {
        throw reflectorValidationError(
          execution,
          args.operation_key,
          `memory_type is required for create and supersede; must be one of: ${MEMORIZE_MEMORY_TYPES.join(', ')}`,
          'input',
        );
      }
      if (
        resolvedOperation !== 'invalidate' &&
        content.trim().length > MEMORY_CONTENT_MAX_LENGTH
      ) {
        throw reflectorValidationError(
          execution,
          args.operation_key,
          `Memory content is ${content.trim().length} characters; the limit is ${MEMORY_CONTENT_MAX_LENGTH}. Store one idea in one or two plain sentences, or split it into separate memories.`,
          'input',
        );
      }
      const mType = (memory_type || 'project') as MemoryType;
      if (
        memory_type !== undefined &&
        !(MEMORIZE_MEMORY_TYPES as readonly string[]).includes(memory_type)
      ) {
        throw reflectorValidationError(
          execution,
          args.operation_key,
          `memory_type is invalid; must be one of: ${MEMORIZE_MEMORY_TYPES.join(', ')}`,
          'input',
        );
      }
      if (
        importance !== undefined &&
        (typeof importance !== 'number' ||
          !Number.isFinite(importance) ||
          importance < 0 ||
          importance > 1)
      ) {
        throw reflectorValidationError(
          execution,
          args.operation_key,
          'importance must be a number between 0 and 1',
          'input',
        );
      }
      if (execution && !explicit) {
        throw reflectorValidationError(
          execution,
          args.operation_key,
          'Reflector writes must set operation to create, supersede, or invalidate',
          'input',
        );
      }
      const requestedValidFrom = validateIsoTimestamp(
        args.validFrom,
        'validFrom',
        execution,
        args.operation_key,
      );
      const requestedEffectiveAt = validateIsoTimestamp(
        args.effectiveAt,
        'effectiveAt',
        execution,
        args.operation_key,
      );
      const references = execution
        ? requireReflectorEvidence(execution, args.evidence, args.operation_key)
        : [];
      const evidenceTimestamp = execution
        ? earliestEvidenceTimestamp(execution, references, args.operation_key)
        : undefined;
      const agentWriteDefault =
        !execution && explicit ? new Date().toISOString() : undefined;
      const validFrom =
        requestedValidFrom ??
        (resolvedOperation === 'invalidate'
          ? undefined
          : execution
            ? evidenceTimestamp
            : agentWriteDefault);
      const effectiveAt =
        requestedEffectiveAt ??
        (resolvedOperation !== 'invalidate'
          ? undefined
          : execution
            ? evidenceTimestamp
            : agentWriteDefault);
      if (explicit && resolvedOperation !== 'invalidate' && !validFrom) {
        throw reflectorValidationError(
          execution,
          args.operation_key,
          'validFrom is required for explicit temporal writes',
          'input',
        );
      }
      if (resolvedOperation === 'invalidate' && !effectiveAt) {
        throw reflectorValidationError(
          execution,
          args.operation_key,
          'effectiveAt is required for invalidate',
          'input',
        );
      }
      const objectiveId = execution
        ? resolveReflectorObjectiveId(
            execution,
            references,
            requestedObjectiveId,
            resolvedOperation,
            mType,
            args.operation_key,
          )
        : (requestedObjectiveId ?? undefined);
      const hasAuthoritativeObjectiveScope =
        !!execution &&
        references.every(
          (reference) =>
            execution.evidence.get(reference.message_id)!.objectiveId !==
            undefined,
        );
      if (objectiveId) {
        await assertObjectiveOwnership(
          objectiveId,
          targetFolder,
          execution,
          args.operation_key,
        );
      }
      const fullOperationKey = execution
        ? reflectorOperationKey(execution, args.operation_key)
        : undefined;

      const parsedTags = tags ? parseTagsInput(tags) : undefined;
      const backend = getMemoryBackend();
      const agentSourceRef =
        sourceRef ||
        (context.task_id
          ? `task:${context.task_id}`
          : context.conversation_id
            ? `conversation:${context.conversation_id}`
            : undefined);

      if (!execution) {
        if (resolvedOperation === 'create') {
          return (
            await backend.memorize({
              group_folder: targetFolder,
              content: content.trim(),
              memory_type: mType,
              importance,
              objective_id: objectiveId || null,
              tags: parsedTags,
              source: 'agent',
              sourceRef: agentSourceRef || null,
              validFrom,
              mergeDuplicates: !explicit,
            })
          ).message;
        }
      }

      const memoryId = args.memory_id as string | undefined;
      const expectedVersion = args.expected_version as string | undefined;
      let target = memoryId
        ? execution?.mode === 'preview' && execution.preview
          ? await resolveEffectivePreviewMemory(
              execution.preview,
              memoryId,
              () => getMemory(memoryId),
            )
          : await getMemory(memoryId)
        : undefined;
      if (
        execution &&
        hasAuthoritativeObjectiveScope &&
        resolvedOperation !== 'create' &&
        target?.group_folder === targetFolder &&
        (target.objective_id ?? null) !== (objectiveId ?? null)
      ) {
        const targetScope = target.objective_id
          ? `objective "${target.objective_id}"`
          : 'the project-wide scope';
        const evidenceScope = objectiveId
          ? `objective "${objectiveId}"`
          : 'the project-wide scope';
        const createGuidance = objectiveId
          ? ` Retain the existing memory and use operation "create" to store a fact scoped to objective "${objectiveId}" instead.`
          : '';
        throw reflectorValidationError(
          execution,
          args.operation_key,
          `Memory ${memoryId} belongs to ${targetScope}, but its supporting transcript evidence belongs to ${evidenceScope}. ${resolvedOperation} requires the target and authoritative evidence to have the same objective scope.${createGuidance}`,
          'input',
        );
      }
      const resultMemoryId =
        execution &&
        (resolvedOperation === 'create' || resolvedOperation === 'supersede')
          ? reflectorResultMemoryId(execution.runId, fullOperationKey!)
          : null;
      let receipt:
        | Awaited<ReturnType<typeof beginReflectorOperation>>['receipt']
        | undefined;
      const requestFingerprint = execution
        ? reflectorRequestFingerprint({
            operation: resolvedOperation,
            content: content?.trim(),
            memory_type: mType,
            importance,
            objective_id: objectiveId || null,
            tags: parsedTags,
            validFrom,
            effectiveAt,
            memoryId,
            expectedVersion,
            evidence: references,
          })
        : undefined;
      if (execution?.mode === 'preview') {
        const staged = execution.preview?.operations.get(fullOperationKey!);
        if (staged) {
          if (staged.requestFingerprint !== requestFingerprint) {
            throw operationKeyReuseError(args.operation_key);
          }
          execution.completedOperationKeys.add(fullOperationKey!);
          return `Operation already staged${staged.resultMemoryId ? ` (memory ${staged.resultMemoryId})` : ''}.`;
        }
      }
      const recoveredLiveMutation =
        execution?.mode === 'live' && target?.group_folder === targetFolder
          ? resolvedOperation === 'invalidate'
            ? target.valid_to === effectiveAt
            : resolvedOperation === 'supersede'
              ? target.superseded_by === resultMemoryId &&
                target.valid_to === validFrom &&
                !!(await getMemory(resultMemoryId!))
              : false
          : false;
      let transitionValidated = false;
      const validateTransition = async () => {
        target = assertExpectedMemory(
          target,
          targetFolder,
          memoryId!,
          expectedVersion,
          execution,
          args.operation_key,
        );
        if (
          !execution &&
          resolvedOperation === 'supersede' &&
          objectiveId &&
          (target.objective_id ?? null) !== objectiveId
        ) {
          const targetScope = target.objective_id
            ? `objective "${target.objective_id}"`
            : 'the project-wide scope';
          throw new Error(
            `Memory ${memoryId} belongs to ${targetScope}, but objective_id "${objectiveId}" was supplied. supersede keeps the target's scope: omit objective_id to supersede within ${targetScope}, or use operation "create" for the narrower fact and then "invalidate" the old memory to change its scope.`,
          );
        }
        if (resolvedOperation === 'supersede' && !objectiveId) {
          await assertObjectiveOwnership(
            target.objective_id,
            targetFolder,
            execution,
            args.operation_key,
          );
        }
        const boundary =
          resolvedOperation === 'invalidate' ? effectiveAt! : validFrom!;
        if (target.valid_from && boundary < target.valid_from) {
          throw reflectorValidationError(
            execution,
            args.operation_key,
            `${resolvedOperation === 'invalidate' ? 'effectiveAt' : 'validFrom'} cannot precede memory ${memoryId}'s validFrom (${target.valid_from})`,
            'input',
          );
        }
        if (resolvedOperation === 'invalidate' && target.valid_to) {
          throw reflectorValidationError(
            execution,
            args.operation_key,
            `Memory ${memoryId} is already invalidated; call recall again before proposing another transition.`,
            'input',
          );
        }
        if (
          resolvedOperation === 'supersede' &&
          target.valid_to &&
          target.valid_to <= boundary
        ) {
          throw reflectorValidationError(
            execution,
            args.operation_key,
            `validFrom must fall inside memory ${memoryId}'s validity interval, which ends at ${target.valid_to}`,
            'input',
          );
        }
        transitionValidated = true;
      };
      // A stale transition must not reserve its idempotency key. The same
      // stable key can then be retried after recall supplies a fresh version.
      if (resolvedOperation !== 'create' && !recoveredLiveMutation) {
        if (!memoryId) {
          throw reflectorValidationError(
            execution,
            args.operation_key,
            'memory_id is required',
            'input',
          );
        }
        await validateTransition();
      }
      if (execution?.mode === 'live') {
        const begun = await beginReflectorOperation({
          runId: execution.runId,
          operationKey: fullOperationKey!,
          requestFingerprint: requestFingerprint!,
          operation: resolvedOperation,
          targetMemoryId: memoryId,
          resultMemoryId,
        });
        receipt = begun.receipt;
        if (receipt.requestFingerprint !== requestFingerprint!) {
          throw operationKeyReuseError(args.operation_key);
        }
        if (receipt.status === 'completed') {
          execution.completedOperationKeys.add(fullOperationKey!);
          return `Operation already completed${receipt.resultMemoryId ? ` (memory ${receipt.resultMemoryId})` : ''}.`;
        }
        if (receipt.status === 'erased') {
          execution.completedOperationKeys.add(fullOperationKey!);
          return `Operation will not be retried because its result was deliberately erased.`;
        }
        if (recoveredLiveMutation && !begun.created) {
          const evidenceMemoryId =
            resolvedOperation === 'supersede' ? resultMemoryId! : memoryId!;
          if (resolvedOperation === 'supersede') {
            const replacement = (await getMemory(resultMemoryId!))!;
            await synchronizeSupersedingMemory(
              replacement,
              targetFolder,
              memoryId!,
              validFrom!,
            );
          } else {
            await syncGraphInvalidation(memoryId!, effectiveAt!);
          }
          await recordTranscriptEvidence({
            memoryId: evidenceMemoryId,
            projectId: targetFolder,
            sourceRef: execution.sourceRef,
            references,
            messages: execution.evidence,
          });
          await finishReflectorOperation(
            receipt.id,
            'completed',
            evidenceMemoryId,
          );
          execution.completedOperationKeys.add(fullOperationKey!);
          return `Recovered completed ${resolvedOperation} operation (memory ${evidenceMemoryId}).`;
        }
        if (recoveredLiveMutation && begun.created) {
          try {
            await validateTransition();
          } catch (error) {
            await abandonReflectorOperation(receipt.id, requestFingerprint!);
            throw error;
          }
        }
      }
      const releaseReceiptIfTransitionUnmutated = async () => {
        if (
          !receipt ||
          !requestFingerprint ||
          execution?.mode !== 'live' ||
          resolvedOperation === 'create'
        ) {
          return;
        }
        const currentTarget = memoryId ? await getMemory(memoryId) : undefined;
        const transitionApplied =
          currentTarget?.group_folder === targetFolder &&
          (resolvedOperation === 'invalidate'
            ? currentTarget.valid_to === effectiveAt
            : currentTarget.superseded_by === resultMemoryId &&
              currentTarget.valid_to === validFrom &&
              !!(await getMemory(resultMemoryId!)));
        if (!transitionApplied) {
          await abandonReflectorOperation(receipt.id, requestFingerprint);
        }
      };
      if (resolvedOperation !== 'create' && !transitionValidated) {
        if (!memoryId) {
          throw reflectorValidationError(
            execution,
            args.operation_key,
            'memory_id is required',
            'input',
          );
        }
        await validateTransition();
      }

      if (execution?.mode === 'preview') {
        const preview = execution.preview;
        if (!preview) throw new Error('Preview memory staging is unavailable');
        const now = new Date().toISOString();
        if (resolvedOperation === 'create') {
          const liveMatches = (
            await backend.recall({
              groupFolders: [targetFolder],
              query: content.trim(),
              memory_type: mType,
              objective_id: objectiveId || null,
              limit: 5,
              skipTouch: true,
            })
          ).memories;
          const duplicate = effectivePreviewMemories(
            preview,
            liveMatches,
            (memory) =>
              memory.group_folder === targetFolder &&
              memory.memory_type === mType &&
              (objectiveId
                ? memory.objective_id === objectiveId
                : !memory.objective_id) &&
              !memory.valid_to &&
              !memory.superseded_by,
          ).find((memory) =>
            isDuplicateMemoryContent(memory.content, content.trim()),
          );
          if (duplicate) {
            preview.memories.set(duplicate.id, { ...duplicate });
            return `Duplicate detected — existing memory ${duplicate.id} retained.`;
          }
          const id = reflectorResultMemoryId(
            execution.runId,
            fullOperationKey!,
          );
          preview.memories.set(id, {
            id,
            group_folder: targetFolder,
            content: content.trim(),
            memory_type: mType,
            importance: importance ?? getDefaultImportance(mType),
            source: 'observer',
            sourceRef: execution.sourceRef,
            objective_id: objectiveId || null,
            tags: parsedTags,
            created_at: now,
            updated_at: now,
            last_accessed_at: now,
            access_count: 0,
            valid_from: validFrom!,
            valid_to: null,
          });
          preview.operations.set(fullOperationKey!, {
            operationKey: fullOperationKey!,
            requestFingerprint: requestFingerprint!,
            operation: 'create',
            resultMemoryId: id,
            content: content.trim(),
            memoryType: mType,
            importance: importance ?? getDefaultImportance(mType),
            objectiveId: objectiveId || null,
            tags: parsedTags,
            validFrom: validFrom!,
            evidence: references,
          });
          execution.completedOperationKeys.add(fullOperationKey!);
          return `Preview staged memory ${id}.`;
        }
        const stagedTarget = preview.memories.get(memoryId!) ?? target!;
        preview.memories.set(memoryId!, { ...stagedTarget });
        if (resolvedOperation === 'invalidate') {
          preview.memories.set(memoryId!, {
            ...stagedTarget,
            valid_to: effectiveAt!,
            updated_at: now,
          });
          preview.operations.set(fullOperationKey!, {
            operationKey: fullOperationKey!,
            requestFingerprint: requestFingerprint!,
            operation: 'invalidate',
            memoryId: memoryId!,
            effectiveAt: effectiveAt!,
            expectedVersion,
            targetContent: stagedTarget.content,
            evidence: references,
          });
          execution.completedOperationKeys.add(fullOperationKey!);
          return `Preview staged invalidation of memory ${memoryId}.`;
        }
        const id = reflectorResultMemoryId(execution.runId, fullOperationKey!);
        preview.memories.set(id, {
          id,
          group_folder: targetFolder,
          content: content.trim(),
          memory_type: mType,
          importance: importance ?? getDefaultImportance(mType),
          source: 'observer',
          sourceRef: execution.sourceRef,
          objective_id: objectiveId || target?.objective_id || null,
          tags: parsedTags ?? stagedTarget.tags,
          created_at: now,
          updated_at: now,
          last_accessed_at: now,
          access_count: 0,
          superseded_by: stagedTarget.superseded_by,
          valid_from: validFrom!,
          valid_to: stagedTarget.valid_to,
        });
        preview.memories.set(memoryId!, {
          ...stagedTarget,
          superseded_by: id,
          valid_to: validFrom!,
          updated_at: now,
        });
        preview.operations.set(fullOperationKey!, {
          operationKey: fullOperationKey!,
          requestFingerprint: requestFingerprint!,
          operation: 'supersede',
          memoryId: memoryId!,
          resultMemoryId: id,
          content: content.trim(),
          memoryType: mType,
          importance: importance ?? getDefaultImportance(mType),
          objectiveId: objectiveId || target?.objective_id || null,
          tags: parsedTags,
          validFrom: validFrom!,
          expectedVersion,
          targetContent: stagedTarget.content,
          successorId: stagedTarget.superseded_by ?? undefined,
          evidence: references,
        });
        execution.completedOperationKeys.add(fullOperationKey!);
        return `Preview staged supersession of memory ${memoryId} by ${id}.`;
      }

      if (!execution) {
        if (resolvedOperation === 'invalidate') {
          await backend.invalidate(
            memoryId!,
            { group_folder: targetFolder },
            effectiveAt,
            expectedVersion,
          );
          return `Memory ${memoryId} invalidated at ${effectiveAt}.`;
        }
        let replacement: SupersedingMemory | null = null;
        await withMemoryLifecycleLock(targetFolder, async () => {
          replacement = await insertSupersedingMemory({
            targetMemoryId: memoryId!,
            groupFolder: targetFolder,
            expectedVersion: expectedVersion!,
            effectiveAt: validFrom!,
            content: content.trim(),
            memoryType: mType,
            importance,
            objectiveId: objectiveId || target?.objective_id || null,
            source: 'agent',
            sourceRef: agentSourceRef,
            tags: parsedTags,
            expectedPrivacyEpoch: getPrivacyErasureEpoch(targetFolder),
          });
          if (!replacement) throw memoryVersionError(memoryId!);
        });
        await synchronizeSupersedingMemory(
          replacement!,
          targetFolder,
          memoryId!,
          validFrom!,
        );
        return `Memory ${memoryId} superseded by ${replacement!.id}.`;
      }

      let storedMemoryId: string | null = resultMemoryId;
      if (resolvedOperation === 'create') {
        const existingRetry = await getMemory(resultMemoryId!);
        if (!existingRetry) {
          const match = matchOpenCardReference(
            content,
            await loadOpenProjectCards(targetFolder),
          );
          if (match) {
            await finishReflectorOperation(receipt!.id, 'completed', null);
            execution.completedOperationKeys.add(fullOperationKey!);
            logger.info(
              {
                projectId: targetFolder,
                cardId: match.cardId,
                token: match.token,
                skipped: 1,
              },
              'Skipped observer memory restating open card',
            );
            return `Not stored: restates open card ${match.cardId} (${match.token}).`;
          }
        }
        if (existingRetry) {
          const hooks = getVectorStoreHooks();
          if (hooks?.isAvailable()) {
            await hooks.embedAndStore(
              existingRetry.id,
              targetFolder,
              existingRetry.content,
              existingRetry.objective_id || null,
            );
          }
        }
        const outcome = existingRetry
          ? {
              memory: existingRetry,
              message: `Information memorized (ID: ${existingRetry.id})`,
            }
          : await backend.memorize({
              id: resultMemoryId!,
              group_folder: targetFolder,
              content: content.trim(),
              memory_type: mType,
              importance,
              objective_id: objectiveId || null,
              tags: parsedTags,
              source: 'observer',
              sourceRef: execution.sourceRef,
              validFrom,
              mergeDuplicates: false,
              expectedPrivacyEpoch: execution.privacyEpoch,
              onResolvedMemoryId: async (memoryId) => {
                storedMemoryId = memoryId;
                await updateReflectorOperationResultMemoryId(
                  receipt!.id,
                  memoryId,
                );
              },
            });
        storedMemoryId = outcome.memory.id;
      } else if (resolvedOperation === 'invalidate') {
        if (target!.valid_to === effectiveAt) {
          storedMemoryId = target!.id;
        } else {
          try {
            await backend.invalidate(
              memoryId!,
              { group_folder: targetFolder },
              effectiveAt,
              expectedVersion,
            );
          } catch (error) {
            await releaseReceiptIfTransitionUnmutated();
            throw error;
          }
          storedMemoryId = memoryId!;
        }
      } else {
        try {
          const existingRetry = await getMemory(resultMemoryId!);
          if (
            !existingRetry ||
            target!.superseded_by !== resultMemoryId ||
            target!.valid_to !== validFrom
          ) {
            let replacement: SupersedingMemory | null = null;
            await withMemoryLifecycleLock(targetFolder, async () => {
              if (existingRetry) {
                throw new Error(
                  `Retry state for operation_key "${args.operation_key}" is inconsistent; recall the target and retry with a new key`,
                );
              }
              replacement = await insertSupersedingMemory({
                id: resultMemoryId!,
                targetMemoryId: memoryId!,
                groupFolder: targetFolder,
                expectedVersion: expectedVersion!,
                effectiveAt: validFrom!,
                content: content.trim(),
                memoryType: mType,
                importance,
                objectiveId: objectiveId || target?.objective_id || null,
                source: 'observer',
                sourceRef: execution.sourceRef,
                tags: parsedTags,
                expectedPrivacyEpoch:
                  execution.privacyEpoch ??
                  getPrivacyErasureEpoch(targetFolder),
              });
              if (!replacement) throw memoryVersionError(memoryId!);
            });
            await synchronizeSupersedingMemory(
              replacement!,
              targetFolder,
              memoryId!,
              validFrom!,
            );
          }
        } catch (error) {
          await releaseReceiptIfTransitionUnmutated();
          throw error;
        }
      }

      if (storedMemoryId) {
        await recordTranscriptEvidence({
          memoryId: storedMemoryId,
          projectId: targetFolder,
          sourceRef: execution.sourceRef,
          references,
          messages: execution.evidence,
        });
      }
      await finishReflectorOperation(receipt!.id, 'completed', storedMemoryId);
      execution.completedOperationKeys.add(fullOperationKey!);
      return `${resolvedOperation} completed${storedMemoryId ? ` (memory ${storedMemoryId})` : ''}.`;
    } catch (error) {
      return markReflectorToolError(execution, error);
    }
  },
};

const indexEvidenceSchema = z.object({
  repository_root: z
    .string()
    .optional()
    .describe(
      'Absolute sandbox repository root; omit for the primary repository.',
    ),
  path: z
    .string()
    .describe(
      'Repository-relative or sandbox-absolute path of one existing file.',
    ),
  line_start: z.number().int().positive().optional(),
  line_end: z.number().int().positive().optional(),
  excerpt: z
    .string()
    .describe('Short exact verbatim text that currently exists in path.'),
  watched_scope: z
    .string()
    .optional()
    .describe(
      'One existing file path whose whole-file hash guards a broad claim.',
    ),
});

/**
 * DirectLLM-only staging tools. They are globally discoverable to direct
 * agents, but a random token tied to one running index audit is required for
 * every call. They never write live memories.
 */
export const proposeMemoryTool: ToolDefinition = {
  name: 'propose_memory',
  description:
    'Stage one repository-backed memory candidate for the active project indexing audit. Requires the collector token supplied by the indexing prompt; this does not write live memory.',
  mcpExempt: true,
  directLlmGlobal: true,
  inputSchema: {
    collector_token: z.string(),
    candidate_id: z
      .string()
      .describe('Stable short identifier for this candidate.'),
    content: z.string().describe('Canonical durable memory content.'),
    memory_type: z
      .enum([
        'identity',
        'project',
        'goal',
        'decision',
        'preference',
        'contact',
        'event',
        'task',
      ])
      .describe(
        'Use project for repository facts, patterns, constraints, navigation, workflows, and integrations.',
      ),
    importance: z
      .number()
      .min(0.7)
      .max(1)
      .describe('Numeric score from 0.7 through 1.0.'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Array of short search tags.'),
    retrieval_value: z
      .enum([
        'navigation',
        'pattern',
        'constraint',
        'decision',
        'workflow',
        'integration',
      ])
      .describe('Categorical way this memory saves future repository search.'),
    reason: z.string(),
    valid_from: z.string().optional(),
    evidence: z
      .array(indexEvidenceSchema)
      .min(1)
      .max(10)
      .describe('Structured exact code evidence. Never pass a string here.'),
  },
  requiredPermissions: ['memories:write'],
  handler: async (args, _deps, context) => {
    const { proposeMemoryForIndex } =
      await import('./memory-index-collector.js');
    return proposeMemoryForIndex(context.group_folder, args);
  },
};

export const finishIndexingTool: ToolDefinition = {
  name: 'finish_indexing',
  description:
    'Optionally record what an active project indexing audit inspected. Required only to justify a zero-candidate result; staged candidates are automatically finalized when the agent exits.',
  mcpExempt: true,
  directLlmGlobal: true,
  inputSchema: {
    collector_token: z.string(),
    summary: z.string(),
    inspected_areas: z.array(z.string()).min(1).max(30),
  },
  requiredPermissions: ['memories:write'],
  handler: async (args, _deps, context) => {
    const { finishIndexCollection } =
      await import('./memory-index-collector.js');
    return finishIndexCollection(context.group_folder, args);
  },
};

export const recallTool: ToolDefinition = {
  name: 'recall',
  description:
    "Search memories by keyword, type, or recency. Returns each memory's temporal validity and provenance. By default only currently-valid memories are returned; use asOf for historical recall.",
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe('Search keyword or phrase for content/tags'),
    memory_type: z
      .string()
      .optional()
      .describe(
        'Filter by categorization (identity, project, goal, decision, preference, contact, event, task)',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(10)
      .describe('Maximum number of memories to return (default 10)'),
    objective_id: z
      .string()
      .optional()
      .describe(
        'Omitted -> only project-wide memories; objective-scoped memories are excluded. Pass your objective ID to get its memories plus project-wide ones.',
      ),
    asOf: isoTimestampSchema
      .optional()
      .describe(
        'Point-in-time ISO timestamp: return memories that were valid at this instant (includes since-superseded facts). When omitted, only currently-valid memories are returned.',
      ),
  },
  requiredPermissions: ['memories:read'],
  handler: async (args, deps, context) => {
    const { query, memory_type, limit } = args;
    let objective_id: string | undefined = args.objective_id;
    if (!objective_id) {
      const evidenceObjectiveId = singleEvidenceObjectiveId(
        context.memoryExecution,
      );
      if (evidenceObjectiveId) {
        objective_id = evidenceObjectiveId;
        logger.debug(
          { objectiveId: evidenceObjectiveId },
          'Reflector recall defaulted objective_id to the chunk evidence scope',
        );
      }
    }
    const asOf = validateIsoTimestamp(args.asOf, 'asOf');
    const { permissions } = context;
    const resultLimit = limit ?? 10;
    const preview = context.memoryExecution?.preview;
    const stagedMemoryIds = new Set<string>();
    if (context.memoryExecution?.mode === 'preview' && preview) {
      for (const operation of preview.operations.values()) {
        if (operation.memoryId) stagedMemoryIds.add(operation.memoryId);
        if (operation.resultMemoryId)
          stagedMemoryIds.add(operation.resultMemoryId);
      }
    }

    const groupFolders = applyPrivacyRecallScope(
      resolveRecallGroupFolders(permissions),
      context.group_folder,
      Object.values(registeredGroups).map((g) => g.folder),
    );
    if (!groupFolders) return { memories: [] };
    const backend = getMemoryBackend();
    let { memories, related: relatedFacts } = await backend.recall({
      groupFolders,
      query,
      memory_type,
      // A staged invalidation, supersession, or erasure can remove a ranked
      // live result. Fetch enough of the live baseline to refill the requested
      // window after applying the preview overlay.
      limit: resultLimit + stagedMemoryIds.size,
      objective_id: objective_id || null,
      asOf,
      skipTouch: context.memoryExecution?.mode === 'preview',
    });

    if (context.memoryExecution?.mode === 'preview' && preview) {
      const queryText = typeof query === 'string' ? query.toLowerCase() : '';
      // Rows the backend returned keep its ranking; only server-staged rows,
      // which it cannot rank, need the lexical query predicate.
      const backendRankedIds = new Set(memories.map((memory) => memory.id));
      const matchesQuery = (memory: (typeof memories)[number]) =>
        !queryText ||
        memory.content.toLowerCase().includes(queryText) ||
        wordOverlap(memory.content, queryText) > 0.2 ||
        !!memory.tags?.some((tag) => tag.toLowerCase().includes(queryText));
      const isValid = (memory: (typeof memories)[number]) =>
        asOf
          ? (!memory.valid_from || memory.valid_from <= asOf) &&
            (!memory.valid_to || memory.valid_to > asOf)
          : !memory.valid_to && !memory.superseded_by;
      const effective = effectivePreviewMemories(
        preview,
        memories,
        (memory) =>
          isValid(memory) &&
          groupFolders.includes(memory.group_folder) &&
          (!memory_type || memory.memory_type === memory_type) &&
          (objective_id
            ? memory.objective_id === objective_id || !memory.objective_id
            : !memory.objective_id) &&
          (stagedMemoryIds.has(memory.id)
            ? matchesQuery(memory)
            : backendRankedIds.has(memory.id)),
      );
      // The backend cannot rank server-staged rows that do not exist in live
      // storage. Put matching staged mutations into the bounded result window,
      // then preserve the backend order for the remaining live rows.
      memories = [
        ...effective.filter((memory) => stagedMemoryIds.has(memory.id)),
        ...effective.filter((memory) => !stagedMemoryIds.has(memory.id)),
      ].slice(0, resultLimit);
      const effectiveMemoryIds = new Set(
        effectivePreviewMemories(preview, [], (memory) => isValid(memory)).map(
          (memory) => memory.id,
        ),
      );
      relatedFacts = relatedFacts?.filter((fact) => {
        if (!fact.sourceMemoryId) return true;
        return (
          !preview.memories.has(fact.sourceMemoryId) ||
          effectiveMemoryIds.has(fact.sourceMemoryId)
        );
      });
    }

    const formatted = memories.map((m) => ({
      id: m.id,
      type: m.memory_type,
      content: m.content,
      importance: m.importance,
      tags: Array.isArray(m.tags) ? m.tags : m.tags ? [m.tags] : [],
      group: m.group_folder,
      objective_id: m.objective_id ?? null,
      validFrom: m.valid_from ?? null,
      validTo: m.valid_to ?? null,
      source: m.source,
      sourceRef: m.sourceRef ?? null,
      updated: m.updated_at,
    }));

    const related = (relatedFacts ?? []).map((f) => ({
      subject: f.subject,
      relation: f.relation,
      object: f.object,
      ...(f.rawLabel ? { rawLabel: f.rawLabel } : {}),
      ...(f.sourceMemoryId ? { sourceMemoryId: f.sourceMemoryId } : {}),
    }));

    const hiddenScopedCount =
      !objective_id && context.memoryExecution?.mode !== 'preview'
        ? await countObjectiveScopedMemories({
            groupFolders,
            query,
            memory_type,
            asOf,
          })
        : 0;

    return {
      memories: formatted,
      ...(related.length > 0 ? { related } : {}),
      ...(hiddenScopedCount > 0 ? { hiddenScopedCount } : {}),
    };
  },
};

export const forgetTool: ToolDefinition = {
  name: 'forget',
  description:
    'Permanently erase a memory and its vector/graph data from long-term storage.',
  inputSchema: {
    memory_id: z.string().describe('ID of the memory to remove'),
    reason: z.string().optional().describe('Why this memory is being removed'),
    operation_key: z
      .string()
      .optional()
      .describe(
        'Stable per-operation retry key; required for reflector writes',
      ),
    evidence: z.array(transcriptEvidenceSchema).optional(),
  },
  requiredPermissions: ['memories:write'],
  authorizesTargetProject: true,
  handler: async (args, _deps, context) => {
    const { memory_id } = args;
    const { permissions } = context;
    const execution = context.memoryExecution;
    let evidenceReferences: MemoryEvidenceReference[] = [];
    try {
      evidenceReferences = execution
        ? requireReflectorEvidence(execution, args.evidence, args.operation_key)
        : [];
    } catch (error) {
      return markReflectorToolError(execution, error);
    }

    let operationKey: string | undefined;
    let requestFingerprint: string | undefined;
    try {
      operationKey = execution
        ? reflectorOperationKey(execution, args.operation_key)
        : undefined;
      requestFingerprint = execution
        ? reflectorRequestFingerprint({
            operation: 'forget',
            memory_id,
            evidence: evidenceReferences,
          })
        : undefined;
    } catch (error) {
      return markReflectorToolError(execution, error);
    }
    if (execution?.mode === 'preview') {
      const staged = execution.preview?.operations.get(operationKey!);
      if (staged) {
        if (staged.requestFingerprint !== requestFingerprint) {
          return markReflectorToolError(
            execution,
            operationKeyReuseError(args.operation_key),
          );
        }
        execution.completedOperationKeys.add(operationKey!);
        return `Operation already staged (memory ${memory_id} erased).`;
      }
    }

    const backend = getMemoryBackend();
    const mem =
      execution?.mode === 'preview' && execution.preview
        ? await resolveEffectivePreviewMemory(
            execution.preview,
            memory_id,
            () => backend.get(memory_id),
          )
        : await backend.get(memory_id);
    if (!mem) {
      if (execution?.mode === 'live') {
        const { receipt } = await beginReflectorOperation({
          runId: execution.runId,
          operationKey: operationKey!,
          requestFingerprint: requestFingerprint!,
          operation: 'forget',
          targetMemoryId: memory_id,
        });
        if (receipt.requestFingerprint !== requestFingerprint!) {
          return markReflectorToolError(
            execution,
            operationKeyReuseError(args.operation_key),
          );
        }
        if (receipt.status === 'pending') {
          await finishReflectorOperation(receipt.id, 'completed', null);
        }
        execution.completedOperationKeys.add(operationKey!);
        return `Operation already completed (memory ${memory_id} is absent).`;
      }
      throw reflectorValidationError(
        execution,
        args.operation_key,
        `Memory ${memory_id} not found. Recall the target and retry with a valid memory_id.`,
        'input',
      );
    }
    if (!hasPermission(permissions, mem.group_folder, 'memories:write')) {
      return markReflectorToolError(
        execution,
        new Error(
          `Unauthorized: missing memories:write permission for project "${mem.group_folder}"`,
        ),
      );
    }

    try {
      const references = evidenceReferences;
      if (execution?.mode === 'preview') {
        if (!execution.preview)
          throw new Error('Preview memory staging is unavailable');
        execution.preview.forgottenIds.add(memory_id);
        execution.preview.operations.set(operationKey!, {
          operationKey: operationKey!,
          requestFingerprint: requestFingerprint!,
          operation: 'forget',
          memoryId: memory_id,
          reason:
            typeof args.reason === 'string' ? args.reason.trim() : undefined,
          targetContent: mem.content,
          evidence: references,
        });
        execution.completedOperationKeys.add(operationKey!);
        return `Preview staged erasure of memory ${memory_id}.`;
      }

      let receipt:
        | Awaited<ReturnType<typeof beginReflectorOperation>>['receipt']
        | undefined;
      if (execution) {
        ({ receipt } = await beginReflectorOperation({
          runId: execution.runId,
          operationKey: operationKey!,
          requestFingerprint: requestFingerprint!,
          operation: 'forget',
          targetMemoryId: memory_id,
        }));
        if (receipt.requestFingerprint !== requestFingerprint!) {
          throw operationKeyReuseError(args.operation_key);
        }
        if (receipt.status === 'completed') {
          execution.completedOperationKeys.add(operationKey!);
          return `Operation already completed (memory ${memory_id} erased).`;
        }
      }

      await backend.erase(memory_id, { group_folder: mem.group_folder });
      if (receipt)
        await finishReflectorOperation(receipt.id, 'completed', null);
      if (execution) execution.completedOperationKeys.add(operationKey!);
      return `Memory ${memory_id} deleted.`;
    } catch (error) {
      return markReflectorToolError(execution, error);
    }
  },
};
