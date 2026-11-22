import type { RegisteredGroup } from '../../types.js';
import type { Memory } from './types.js';

export const MEMORY_REORGANIZE_SCHEMA = `{
  "items": [
    {
      "memory_id": "one supplied memory ID",
      "disposition": "keep | move",
      "confidence": 0.95,
      "reason": "concise placement rationale",
      "target_project_id": "required only for move; one allowed related project ID"
    }
  ]
}`;

type MemoryProjectRelationship =
  | 'parent'
  | 'ancestor'
  | 'child'
  | 'descendant'
  | 'memory-source';

export interface RelatedMemoryProject {
  id: string;
  name: string;
  relationship: MemoryProjectRelationship;
  parentId?: string;
  repositoryUrl?: string;
  workspacePath?: string;
}

function descendantsOf(
  rootId: string,
  groups: RegisteredGroup[],
): Array<{ group: RegisteredGroup; depth: number }> {
  const result: Array<{ group: RegisteredGroup; depth: number }> = [];
  const childrenByParent = new Map<string, RegisteredGroup[]>();
  for (const group of groups) {
    if (!group.parentId) continue;
    const children = childrenByParent.get(group.parentId) ?? [];
    children.push(group);
    childrenByParent.set(group.parentId, children);
  }
  const queue = [{ id: rootId, depth: 0 }];
  const visited = new Set([rootId]);
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    for (const group of childrenByParent.get(current.id) ?? []) {
      if (visited.has(group.folder)) continue;
      visited.add(group.folder);
      result.push({ group, depth: current.depth + 1 });
      queue.push({ id: group.folder, depth: current.depth + 1 });
    }
  }
  return result;
}

/**
 * Returns only destinations explicitly related to the source project.
 * Framework links are intentionally directional: applications may move shared
 * knowledge into configured frameworks, but applications sharing a framework
 * never become destinations for one another.
 */
export function relatedMemoryProjects(
  sourceId: string,
  groupRecord: Record<string, RegisteredGroup>,
): RelatedMemoryProject[] {
  const groups = Object.values(groupRecord);
  const byId = new Map(groups.map((group) => [group.folder, group]));
  const source = byId.get(sourceId);
  if (!source) return [];
  const related = new Map<
    string,
    { group: RegisteredGroup; relationship: MemoryProjectRelationship }
  >();
  const add = (
    group: RegisteredGroup | undefined,
    relationship: MemoryProjectRelationship,
  ) => {
    if (!group || group.folder === sourceId || related.has(group.folder))
      return;
    related.set(group.folder, { group, relationship });
  };

  let ancestorId = source.parentId;
  let ancestorDepth = 1;
  const visitedAncestors = new Set<string>();
  while (ancestorId && !visitedAncestors.has(ancestorId)) {
    visitedAncestors.add(ancestorId);
    const ancestor = byId.get(ancestorId);
    if (!ancestor) break;
    add(ancestor, ancestorDepth === 1 ? 'parent' : 'ancestor');
    ancestorId = ancestor.parentId;
    ancestorDepth += 1;
  }

  for (const { group, depth } of descendantsOf(sourceId, groups)) {
    add(group, depth === 1 ? 'child' : 'descendant');
  }

  for (const sourceId of source.settings?.memorySourceProjects ?? []) {
    add(byId.get(sourceId), 'memory-source');
  }

  return [...related.values()]
    .map(({ group, relationship }) => ({
      id: group.folder,
      name: group.name,
      relationship,
      ...(group.parentId ? { parentId: group.parentId } : {}),
      ...(group.settings?.repositoryUrl
        ? { repositoryUrl: group.settings.repositoryUrl }
        : {}),
      ...(group.settings?.workspacePath
        ? { workspacePath: group.settings.workspacePath }
        : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function memoryReorganizePromptForCluster(args: {
  source: RegisteredGroup;
  destinations: RelatedMemoryProject[];
  memories: Memory[];
}): string {
  const memories = args.memories.map((memory) => ({
    id: memory.id,
    content: memory.content,
    memory_type: memory.memory_type,
    tags: memory.tags ?? [],
    source_ref: memory.sourceRef ?? null,
  }));
  const source = {
    id: args.source.folder,
    name: args.source.name,
    parent_id: args.source.parentId ?? null,
    repository_url: args.source.settings?.repositoryUrl ?? null,
    workspace_path: args.source.settings?.workspacePath ?? null,
  };
  return `You are CarapaBoard's project-memory placement reflector.

Decide whether each supplied memory belongs in the source project or clearly
belongs in one of the explicitly allowed related projects. Precision is more
important than recall. Most memories should remain where they are.

This mode is placement-only:
- keep leaves the memory in the source project.
- move relocates the unchanged memory to exactly one allowed related project.
- Never propose deletion, merging, rewriting, retagging, or a destination not
  present in ALLOWED DESTINATIONS.

Move only when the claim's durable subject and future retrieval audience clearly
belong to the destination. Prefer a parent for genuinely cross-child knowledge,
a child for child-specific implementation knowledge, and a configured shared
framework for framework-owned APIs, conventions, constraints, or architecture.
Keep project-specific integration decisions in the application even when they
mention a framework. Keep user preferences at the narrowest scope where they
consistently apply. Ambiguity means keep.

You may inspect the source sandbox read-only when ownership is unclear, but do
not modify files or use mutation tools. Return every supplied memory ID exactly
once. A move requires confidence >= 0.90; lower-confidence moves are treated as
keep.

Return only JSON in this shape:
${MEMORY_REORGANIZE_SCHEMA}

SOURCE PROJECT:
${JSON.stringify(source)}

ALLOWED DESTINATIONS:
${JSON.stringify(args.destinations)}

MEMORIES:
${JSON.stringify(memories)}`;
}

export interface MemoryReorganizeDecision {
  memoryId: string;
  disposition: 'keep' | 'move';
  confidence: number;
  reason: string;
  targetProjectId?: string;
}

function parseEnvelope(output: string): any {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const first = output.indexOf('{');
  const last = output.lastIndexOf('}');
  const candidate =
    fenced ??
    (first >= 0 && last >= first ? output.slice(first, last + 1) : output);
  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error(
      `Reflector did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    throw new Error('Reflector envelope must contain an items array');
  }
  return parsed;
}

export function normalizeMemoryReorganization(args: {
  output: string;
  allowedMemoryIds: Set<string>;
  allowedProjectIds: Set<string>;
}): MemoryReorganizeDecision[] {
  const envelope = parseEnvelope(args.output);
  const seen = new Set<string>();
  const decisions = envelope.items.map((item: any) => {
    if (
      !item ||
      typeof item.memory_id !== 'string' ||
      !args.allowedMemoryIds.has(item.memory_id) ||
      seen.has(item.memory_id)
    ) {
      throw new Error('Reflector referenced an unknown or duplicate memory ID');
    }
    seen.add(item.memory_id);
    if (!['keep', 'move'].includes(item.disposition)) {
      throw new Error(`Invalid placement disposition for ${item.memory_id}`);
    }
    const confidence = Number(item.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`Invalid confidence for ${item.memory_id}`);
    }
    const reason =
      typeof item.reason === 'string' ? item.reason.trim().slice(0, 4_000) : '';
    if (!reason) throw new Error(`Missing reason for ${item.memory_id}`);
    let disposition = item.disposition as 'keep' | 'move';
    let targetProjectId =
      typeof item.target_project_id === 'string'
        ? item.target_project_id.trim()
        : undefined;
    if (disposition === 'move' && confidence < 0.9) {
      disposition = 'keep';
      targetProjectId = undefined;
    }
    if (
      disposition === 'move' &&
      (!targetProjectId || !args.allowedProjectIds.has(targetProjectId))
    ) {
      throw new Error(`Invalid target project for ${item.memory_id}`);
    }
    return {
      memoryId: item.memory_id as string,
      disposition,
      confidence,
      reason,
      ...(disposition === 'move' ? { targetProjectId } : {}),
    } as MemoryReorganizeDecision;
  });
  if (seen.size !== args.allowedMemoryIds.size) {
    throw new Error('Reflector must account for every memory exactly once');
  }
  return decisions;
}
