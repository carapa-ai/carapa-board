// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import type { HistoryReviewOperation } from '@/lib/api';
import { buildHistoryReviewVerificationPrompt } from './history-review-verification';

function operation(): HistoryReviewOperation {
  return {
    id: 'history-op-123',
    operation: {
      op: 'create',
      candidate_ids: ['candidate-1'],
      new_memory_id: 'memory-1',
      memory_type: 'project',
      content: 'Review state is saved after every reflection call.',
      valid_from: '2026-07-30T00:00:00.000Z',
      importance: 0.8,
      tags: ['memory'],
    },
    candidates: [
      {
        id: 'candidate-1',
        planned_memory_id: 'memory-1',
        memory_type: 'project',
        claim: 'Each reflection result is checkpointed.',
        change_kind: 'new',
        effective_at: '2026-07-30T00:00:00.000Z',
        confidence: 0.75,
        importance: 0.8,
        tags: ['memory'],
        evidence: [],
      },
    ],
    evidence: [
      {
        source_kind: 'conversation',
        conversation_id: 'conversation-1',
        message_id: 'message-1',
        role: 'assistant',
        created_at: '2026-07-30T00:00:00.000Z',
        excerpt: 'The manifest is written after a successful call.',
      },
    ],
    mandatory: false,
    decision: 'pending',
    mark_for_eval: false,
    target_project_id: 'carapa-board',
  };
}

describe('history review verification prompt', () => {
  test('bounds transcript evidence included in the handoff', () => {
    const item = operation();
    item.evidence[0]!.excerpt = 'x'.repeat(3_000);
    const prompt = buildHistoryReviewVerificationPrompt({
      batchId: 'project-history-batch-test.json',
      projectId: 'carapa-board',
      item,
    });

    expect(prompt).toContain('[truncated]');
    expect(prompt.length).toBeLessThan(10_000);
  });
});
