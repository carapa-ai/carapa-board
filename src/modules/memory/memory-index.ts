import type {
  MemoryAuditEvidenceClaim,
  MemoryIndexRetrievalValue,
} from './memory-audit-types.js';
import type { Memory, MemoryType } from './types.js';
import { parseTagsInput } from './parse-tags.js';

const MEMORY_INDEX_MAX_CANDIDATES = 50;
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
const RETRIEVAL_VALUES = new Set<MemoryIndexRetrievalValue>([
  'navigation',
  'pattern',
  'constraint',
  'decision',
  'workflow',
  'integration',
]);

export const MEMORY_INDEX_DISCOVERY_SCHEMA = `{
  "candidates": [
    {
      "candidate_id": "c1",
      "content": "Canonical durable project knowledge",
      "memory_type": "project | decision | preference | event | task | goal | identity | contact",
      "importance": 0.8,
      "tags": ["architecture"],
      "retrieval_value": "navigation | pattern | constraint | decision | workflow | integration",
      "reason": "How this saves future search or prevents a mistake",
      "valid_from": "ISO-8601 timestamp when reliably established; otherwise omit",
      "evidence": [{"repository_root":"/workspace/repo","path":"src/file.ts","line_start":1,"line_end":3,"excerpt":"exact text","watched_scope":"optional/configuration-file"}]
    }
  ]
}`;

export const MEMORY_INDEX_RECONCILIATION_SCHEMA = `{
  "decisions": [
    {
      "candidate_id": "c1",
      "op": "create | enhance | covered | skip",
      "memory_id": "required for enhance or covered; one supplied matching memory ID",
      "confidence": 0.9,
      "reason": "Concise reconciliation reason",
      "content": "Canonical content required for create or enhance",
      "memory_type": "required for create or enhance",
      "importance": 0.8,
      "tags": ["tag"]
    }
  ]
}`;

export interface MemoryIndexCandidate {
  candidateId: string;
  content: string;
  memoryType: MemoryType;
  importance: number;
  tags: string[];
  retrievalValue: MemoryIndexRetrievalValue;
  reason: string;
  validFrom: string;
  evidence: MemoryAuditEvidenceClaim[];
}

export interface MemoryIndexReconciliation {
  candidateId: string;
  op: 'create' | 'enhance' | 'covered' | 'skip';
  memoryId?: string;
  confidence: number;
  reason: string;
  content?: string;
  memoryType?: MemoryType;
  importance?: number;
  tags?: string[];
}

export interface MemoryIndexVerifiedCoverage {
  memory_id: string;
  content: string;
  evidence_paths: string[];
  watched_scopes: string[];
}

export function parseMemoryIndexJson(output: string): any {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const first = output.indexOf('{');
  const last = output.lastIndexOf('}');
  const candidate =
    fenced ??
    (first >= 0 && last >= first ? output.slice(first, last + 1) : output);
  try {
    return JSON.parse(candidate);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Memory index reflector did not return valid JSON: ${detail}`,
    );
  }
}

function boundedText(value: unknown, name: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max)
    throw new Error(`${name} must be 1..${max} characters`);
  return text;
}

function normalizedTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')) {
    throw new Error('tags must be an array of strings');
  }
  return [...new Set(value.map((tag) => tag.trim()).filter(Boolean))].slice(
    0,
    30,
  );
}

function normalizedImportance(value: unknown): number {
  const named =
    typeof value === 'string'
      ? ({ high: 0.9, important: 0.85, medium: 0.8 } as const)[
          value.trim().toLocaleLowerCase('en-US') as
            | 'high'
            | 'important'
            | 'medium'
        ]
      : undefined;
  const importance = named ?? Number(value);
  if (!Number.isFinite(importance) || importance < 0.7 || importance > 1) {
    throw new Error('importance must be between 0.7 and 1');
  }
  return importance;
}

function normalizedMemoryType(value: unknown): MemoryType | undefined {
  if (MEMORY_TYPES.has(value as MemoryType)) return value as MemoryType;
  const normalized =
    typeof value === 'string'
      ? value
          .trim()
          .toLocaleLowerCase('en-US')
          .replace(/[\s-]+/g, '_')
      : '';
  if (
    [
      'fact',
      'knowledge',
      'project_knowledge',
      'architecture',
      'constraint',
      'navigation',
      'pattern',
      'workflow',
      'integration',
    ].includes(normalized)
  ) {
    return 'project';
  }
  if (normalized === 'user_preference') return 'preference';
  return undefined;
}

function normalizedRetrievalValue(
  value: unknown,
  rawMemoryType: unknown,
): MemoryIndexRetrievalValue | undefined {
  if (RETRIEVAL_VALUES.has(value as MemoryIndexRetrievalValue)) {
    return value as MemoryIndexRetrievalValue;
  }
  if (RETRIEVAL_VALUES.has(rawMemoryType as MemoryIndexRetrievalValue)) {
    return rawMemoryType as MemoryIndexRetrievalValue;
  }
  const text =
    typeof value === 'string' ? value.toLocaleLowerCase('en-US') : '';
  if (/integrat|external|component boundary/.test(text)) return 'integration';
  if (/workflow|deploy|operat|process|release/.test(text)) return 'workflow';
  if (/decision|chosen|choice|rationale/.test(text)) return 'decision';
  if (
    /constraint|security|must|only|prevent|restrict|allowlist|fail closed/.test(
      text,
    )
  ) {
    return 'constraint';
  }
  if (/navigat|where|entry|start|locat|find|debug|search|check/.test(text)) {
    return 'navigation';
  }
  if (text.trim()) return 'pattern';
  return undefined;
}

export function normalizeMemoryIndexCandidates(
  envelope: any,
  verifiedAt: string,
): MemoryIndexCandidate[] {
  if (!Array.isArray(envelope?.candidates)) {
    throw new Error('Memory index envelope must contain a candidates array');
  }
  if (envelope.candidates.length > MEMORY_INDEX_MAX_CANDIDATES) {
    throw new Error(
      `Memory index returned more than ${MEMORY_INDEX_MAX_CANDIDATES} candidates`,
    );
  }
  const ids = new Set<string>();
  const contents = new Set<string>();
  return envelope.candidates.map((raw: any, index: number) => {
    const candidateId = boundedText(
      raw?.candidate_id,
      `candidate ${index + 1} ID`,
      100,
    );
    if (!/^[a-zA-Z0-9._:-]+$/.test(candidateId) || ids.has(candidateId)) {
      throw new Error(`Invalid or duplicate candidate ID ${candidateId}`);
    }
    ids.add(candidateId);
    const content = boundedText(raw?.content, `${candidateId} content`, 20_000);
    const contentKey = content.toLocaleLowerCase('en-US');
    if (contents.has(contentKey))
      throw new Error(`Duplicate candidate content for ${candidateId}`);
    contents.add(contentKey);
    const memoryType = normalizedMemoryType(raw?.memory_type);
    if (!memoryType) {
      throw new Error(
        `Invalid memory_type ${JSON.stringify(raw?.memory_type)} for ${candidateId}; use project, decision, preference, event, task, goal, identity, or contact`,
      );
    }
    const retrievalValue = normalizedRetrievalValue(
      raw?.retrieval_value,
      raw?.memory_type,
    );
    if (!retrievalValue) {
      throw new Error(
        `Invalid retrieval_value ${JSON.stringify(raw?.retrieval_value)} for ${candidateId}; use navigation, pattern, constraint, decision, workflow, or integration`,
      );
    }
    const evidence = Array.isArray(raw?.evidence) ? raw.evidence : [];
    if (!evidence.length)
      throw new Error(`${candidateId} requires code evidence`);
    const proposedDate =
      typeof raw.valid_from === 'string' ? raw.valid_from : verifiedAt;
    const parsedDate = Date.parse(proposedDate);
    if (
      !Number.isFinite(parsedDate) ||
      parsedDate > Date.parse(verifiedAt) + 300_000
    ) {
      throw new Error(`Invalid valid_from for ${candidateId}`);
    }
    return {
      candidateId,
      content,
      memoryType,
      importance: normalizedImportance(raw.importance),
      tags: normalizedTags(
        typeof raw.tags === 'string'
          ? parseTagsInput(raw.tags)
          : (raw.tags ?? []),
      ),
      retrievalValue,
      reason: boundedText(raw.reason, `${candidateId} reason`, 4_000),
      validFrom: new Date(parsedDate).toISOString(),
      evidence: evidence as MemoryAuditEvidenceClaim[],
    };
  });
}

export function normalizeMemoryIndexReconciliation(args: {
  envelope: any;
  candidates: MemoryIndexCandidate[];
  matchingMemoryIds: Map<string, Set<string>>;
}): MemoryIndexReconciliation[] {
  if (!Array.isArray(args.envelope?.decisions)) {
    throw new Error(
      'Memory index reconciliation must contain a decisions array',
    );
  }
  const candidates = new Map(
    args.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const seen = new Set<string>();
  const decisions = args.envelope.decisions.map((raw: any) => {
    const candidateId =
      typeof raw?.candidate_id === 'string' ? raw.candidate_id : '';
    const candidate = candidates.get(candidateId);
    if (!candidate || seen.has(candidateId)) {
      throw new Error(
        `Unknown or duplicate reconciliation candidate ${candidateId}`,
      );
    }
    seen.add(candidateId);
    if (!['create', 'enhance', 'covered', 'skip'].includes(raw.op)) {
      throw new Error(`Invalid reconciliation operation for ${candidateId}`);
    }
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`Invalid confidence for ${candidateId}`);
    }
    let op = raw.op as MemoryIndexReconciliation['op'];
    if ((op === 'create' || op === 'enhance') && confidence < 0.85) op = 'skip';
    const memoryId =
      typeof raw.memory_id === 'string' ? raw.memory_id : undefined;
    if (
      (op === 'enhance' || op === 'covered') &&
      (!memoryId || !args.matchingMemoryIds.get(candidateId)?.has(memoryId))
    ) {
      throw new Error(`Invalid matching memory for ${candidateId}`);
    }
    let content: string | undefined;
    let memoryType: MemoryType | undefined;
    let importance: number | undefined;
    let tags: string[] | undefined;
    if (op === 'create' || op === 'enhance') {
      content = boundedText(
        raw.content,
        `${candidateId} reconciled content`,
        20_000,
      );
      if (!MEMORY_TYPES.has(raw.memory_type)) {
        throw new Error(`Invalid reconciled memory type for ${candidateId}`);
      }
      memoryType = raw.memory_type as MemoryType;
      importance = normalizedImportance(raw.importance);
      tags = normalizedTags(raw.tags ?? []);
    }
    return {
      candidateId,
      op,
      memoryId,
      confidence,
      reason: boundedText(
        raw.reason,
        `${candidateId} reconciliation reason`,
        4_000,
      ),
      content,
      memoryType,
      importance,
      tags,
    };
  });
  if (seen.size !== candidates.size) {
    throw new Error(
      'Reconciliation must account for every candidate exactly once',
    );
  }
  return decisions;
}

export function memoryIndexDiscoveryPrompt(
  verifiedAt: string,
  verifiedCoverage: MemoryIndexVerifiedCoverage[] = [],
): string {
  return `You are CarapaBoard's project knowledge indexer. Work read-only inside this project's sandbox and discover missing durable memories that will save future coding agents from broad repository searches.

Inspect high-leverage project surfaces and follow important connections when useful: agent instructions, architecture documentation, manifests, schemas, routing and registration, configuration, security boundaries, deployment, integrations, and recurring implementation patterns. Do not attempt to enumerate every file.

Propose only concise knowledge with lasting retrieval value:
- navigation: identifies where an important concern begins or is wired together
- pattern: explains a recurring project-specific implementation convention
- constraint: records a compatibility, security, or architectural restriction
- decision: captures an established architectural choice evident in the repository
- workflow: explains a stable development, deployment, or operational flow
- integration: explains a boundary between components or external systems

Skip isolated symbol names, ordinary implementation details, generic software facts, temporary state, completed tasks, and anything that would not save meaningful future search. Every candidate requires a short exact code excerpt. Use watched_scope for broad, negative, generated, or configuration-dependent claims. Do not inspect or output secrets. Do not modify files or invoke mutation tools. Return at most ${MEMORY_INDEX_MAX_CANDIDATES} candidates. Precision is more important than coverage.

The verification time is ${verifiedAt}. Only provide valid_from when repository history establishes it reliably; otherwise omit it.

CarapaBoard independently revalidated the file hashes for the following existing memory coverage. Treat these claims as already indexed: do not reinspect their listed evidence merely to prove them again, and do not propose semantically equivalent candidates. You may inspect adjacent code only to discover distinct missing knowledge.
VERIFIED COVERAGE:
${JSON.stringify(verifiedCoverage)}

Return only JSON matching this shape:
${MEMORY_INDEX_DISCOVERY_SCHEMA}`;
}

export function memoryIndexToolDiscoveryPrompt(
  verifiedAt: string,
  verifiedCoverage: MemoryIndexVerifiedCoverage[],
  collectorToken: string,
): string {
  const jsonPrompt = memoryIndexDiscoveryPrompt(verifiedAt, verifiedCoverage);
  const outputMarker = '\nReturn only JSON matching this shape:';
  const base = jsonPrompt.slice(0, jsonPrompt.indexOf(outputMarker));
  return `${base}

Use repository inspection tools as needed. For every memory-worthy candidate,
call propose_memory exactly once with the collector token below. The tool
independently verifies and persists the evidence; do not return candidates as
JSON and never call memorize.

COLLECTOR TOKEN:
${collectorToken}

Use stable, short candidate_id values. After all useful candidates have been
staged, you may call finish_indexing with a concise summary and the repository
areas inspected. finish_indexing is optional when at least one candidate was
staged because CarapaBoard finalizes those automatically when you exit. For a
zero-candidate result it is mandatory: explain why and list the inspected
areas. Then end with a brief completion message.

For propose_memory, use memory_type=project for repository facts, navigation,
patterns, constraints, workflows, and integrations. importance is a numeric
0.7..1 score; tags is a string array; retrieval_value is exactly one of
navigation, pattern, constraint, decision, workflow, or integration; evidence
is an array of objects with path and an exact excerpt from that file.`;
}

export function memoryIndexReconciliationPrompt(args: {
  candidates: MemoryIndexCandidate[];
  matches: Map<string, Memory[]>;
}): string {
  const payload = args.candidates.map((candidate) => ({
    candidate,
    matching_memories: (args.matches.get(candidate.candidateId) ?? []).map(
      (memory) => ({
        id: memory.id,
        content: memory.content,
        memory_type: memory.memory_type,
        importance: memory.importance,
        tags: memory.tags ?? [],
        source_ref: memory.sourceRef ?? null,
        valid_from: memory.valid_from ?? null,
      }),
    ),
  }));
  return `You are CarapaBoard's project memory index reconciler. Compare each verified repository candidate with only its supplied semantically matching current memories.

Choose exactly one operation per candidate:
- create: no supplied memory adequately covers it
- enhance: one supplied memory is the right canonical home but should be rewritten to add the candidate's durable retrieval value; preserve all valuable existing rationale and facts
- covered: a supplied memory already covers the candidate well enough
- skip: the candidate is not sufficiently durable, useful, or distinct after comparison

Never erase memories. Never reference a memory outside that candidate's matching_memories. For create/enhance, return canonical standalone content, type, importance, and tags. Do not blindly append text. Keep the smallest memory that still saves meaningful future search. Confidence below 0.85 will be skipped.

Return only JSON matching this shape:
${MEMORY_INDEX_RECONCILIATION_SCHEMA}

INPUT:
${JSON.stringify(payload)}`;
}
