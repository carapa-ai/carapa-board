import type { Memory } from './types.js';

export const MEMORY_AUDIT_MAX_CLUSTER_SIZE = 20;
const MEMORY_AUDIT_MIN_VECTOR_SIMILARITY = (() => {
  const configured = Number(
    process.env.MEMORY_AUDIT_MIN_CLUSTER_SIMILARITY ?? 0.72,
  );
  return Number.isFinite(configured) && configured >= 0 && configured <= 1
    ? configured
    : 0.72;
})();

interface RankedMemory {
  memory: Memory;
  score: number;
  vectorScore?: number;
  lexicalScore: number;
  reason: 'seed' | 'provenance' | 'vector' | 'lexical';
}

export interface MemoryAuditSemanticCluster {
  memories: Memory[];
  ranked: RankedMemory[];
  vectorMatches: number;
  lexicalMatches: number;
}

function normalizedTokens(content: string): Set<string> {
  const tokens = content
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}_-]{3,}/gu);
  return new Set(tokens ?? []);
}

function diceSimilarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return (2 * intersection) / (left.size + right.size);
}

function sameScope(left: Memory, right: Memory): boolean {
  return (left.objective_id ?? null) === (right.objective_id ?? null);
}

/**
 * Select one natural semantic cluster around the oldest pending seed.
 * Similarity controls membership; maxSize is only an upper bound.
 */
export function selectMemoryAuditSemanticCluster(args: {
  seed: Memory;
  candidates: Memory[];
  vectorScores?: Map<string, number>;
  maxSize?: number;
  minVectorSimilarity?: number;
}): MemoryAuditSemanticCluster {
  const maxSize = Math.max(
    1,
    Math.min(
      MEMORY_AUDIT_MAX_CLUSTER_SIZE,
      Math.floor(args.maxSize ?? MEMORY_AUDIT_MAX_CLUSTER_SIZE),
    ),
  );
  const minVectorSimilarity =
    args.minVectorSimilarity ?? MEMORY_AUDIT_MIN_VECTOR_SIMILARITY;
  const seedTokens = normalizedTokens(args.seed.content);
  const seedSourceRef = args.seed.sourceRef?.trim() || null;
  const ranked: RankedMemory[] = [
    {
      memory: args.seed,
      score: 1,
      vectorScore: args.vectorScores?.get(args.seed.id),
      lexicalScore: 1,
      reason: 'seed',
    },
  ];

  for (const memory of args.candidates) {
    if (memory.id === args.seed.id || !sameScope(args.seed, memory)) continue;
    const lexicalScore = diceSimilarity(
      seedTokens,
      normalizedTokens(memory.content),
    );
    const vectorScore = args.vectorScores?.get(memory.id);
    const sameProvenance =
      !!seedSourceRef && seedSourceRef === memory.sourceRef?.trim();
    const vectorMatch =
      vectorScore !== undefined && vectorScore >= minVectorSimilarity;
    // Require strong lexical overlap. Memory type is deliberately not a
    // partition because noisy models often classify duplicates differently.
    const lexicalMatch = lexicalScore >= 0.55;
    if (!sameProvenance && !vectorMatch && !lexicalMatch) continue;
    const reason = sameProvenance
      ? 'provenance'
      : vectorMatch
        ? 'vector'
        : 'lexical';
    ranked.push({
      memory,
      score: sameProvenance ? 1 : Math.max(vectorScore ?? 0, lexicalScore),
      ...(vectorScore === undefined ? {} : { vectorScore }),
      lexicalScore,
      reason,
    });
  }

  const selected = [
    ranked[0]!,
    ...ranked
      .slice(1)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.memory.created_at.localeCompare(right.memory.created_at) ||
          left.memory.id.localeCompare(right.memory.id),
      )
      .slice(0, maxSize - 1),
  ];
  return {
    memories: selected.map((entry) => entry.memory),
    ranked: selected,
    vectorMatches: selected.filter((entry) => entry.reason === 'vector').length,
    lexicalMatches: selected.filter((entry) => entry.reason === 'lexical')
      .length,
  };
}
