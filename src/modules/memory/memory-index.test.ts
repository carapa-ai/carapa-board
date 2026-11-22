import { describe, expect, test } from 'bun:test';
import {
  normalizeMemoryIndexCandidates,
  normalizeMemoryIndexReconciliation,
  type MemoryIndexCandidate,
} from './memory-index.js';

const verifiedAt = '2026-07-31T12:00:00.000Z';

function candidateEnvelope(evidence: unknown[]) {
  return {
    candidates: [
      {
        candidate_id: 'routing',
        content: 'Routes are registered through the module registry.',
        memory_type: 'project',
        importance: 0.8,
        tags: ['routing'],
        retrieval_value: 'navigation',
        reason: 'Avoids searching every route file.',
        evidence,
      },
    ],
  };
}

function enhanceDecision(memoryId: string) {
  return {
    decisions: [
      {
        candidate_id: 'routing',
        op: 'enhance',
        memory_id: memoryId,
        confidence: 0.91,
        reason: 'Adds the missing entry point.',
        content: 'Use the registry in src/modules.ts.',
        memory_type: 'project',
        importance: 0.8,
        tags: ['routing'],
      },
    ],
  };
}

describe('project memory index validation', () => {
  test('requires repository evidence before accepting a candidate', () => {
    expect(() =>
      normalizeMemoryIndexCandidates(candidateEnvelope([]), verifiedAt),
    ).toThrow('requires code evidence');

    const [candidate] = normalizeMemoryIndexCandidates(
      candidateEnvelope([
        {
          repository_root: '/workspace/repo',
          path: 'src/modules.ts',
          excerpt: 'registerModules(app)',
        },
      ]),
      verifiedAt,
    );
    expect(candidate?.validFrom).toBe(verifiedAt);
    expect(candidate?.evidence).toHaveLength(1);
  });

  test('parses a JSON-encoded candidate tags string into clean tags', () => {
    const envelope = candidateEnvelope([
      {
        repository_root: '/workspace/repo',
        path: 'src/modules.ts',
        excerpt: 'registerModules(app)',
      },
    ]);
    envelope.candidates[0].tags = '["routing","D-39"]' as any;
    const [candidate] = normalizeMemoryIndexCandidates(envelope, verifiedAt);
    expect(candidate?.tags).toEqual(['routing', 'D-39']);
  });

  test('allows reconciliation only against the candidate supplied match set', () => {
    const candidates = normalizeMemoryIndexCandidates(
      candidateEnvelope([
        {
          repository_root: '/workspace/repo',
          path: 'src/modules.ts',
          excerpt: 'registerModules(app)',
        },
      ]),
      verifiedAt,
    );
    const matchingMemoryIds = new Map([['routing', new Set(['memory-1'])]]);

    expect(
      normalizeMemoryIndexReconciliation({
        envelope: enhanceDecision('memory-1'),
        candidates,
        matchingMemoryIds,
      }),
    ).toMatchObject([{ op: 'enhance', memoryId: 'memory-1' }]);
    expect(() =>
      normalizeMemoryIndexReconciliation({
        envelope: enhanceDecision('invented-memory'),
        candidates: candidates as MemoryIndexCandidate[],
        matchingMemoryIds,
      }),
    ).toThrow('Invalid matching memory');
  });
});
