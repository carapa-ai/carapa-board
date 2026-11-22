import { describe, expect, test } from 'bun:test';
import type { RuntimeSelection } from '../../../lib/chat-agents.js';
import {
  isVisibleToExtraReviewer,
  partitionCoReviewStagesByRuntime,
} from './review-chain.js';

describe('isVisibleToExtraReviewer', () => {
  const startedAt = '2026-01-01T00:00:10.000Z';
  const at = (created_at: string, extra = {}) => ({ created_at, ...extra });

  test("hides the chain's own review output but never queued steering", () => {
    expect(
      isVisibleToExtraReviewer(at('2026-01-01T00:00:05.000Z'), startedAt),
    ).toBe(true);
    expect(
      isVisibleToExtraReviewer(
        at('2026-01-01T00:00:20.000Z', { entry_type: 'run_result' }),
        startedAt,
      ),
    ).toBe(false);
    for (const queued of [
      { steering: true },
      { entry_type: 'stage_prompt' },
      { entry_type: 'steering_delivery' },
    ]) {
      expect(
        isVisibleToExtraReviewer(
          at('2026-01-01T00:00:20.000Z', queued),
          startedAt,
        ),
      ).toBe(true);
    }
  });
});

describe('partitionCoReviewStagesByRuntime', () => {
  const primary: RuntimeSelection = {
    harnessId: 'claude',
    modelId: 'claude-opus-5-5',
    reasoning: 'high',
  };
  const runtimeOf =
    (map: Record<string, RuntimeSelection>) =>
    (stageId: string): RuntimeSelection => {
      const selection = map[stageId];
      if (!selection) throw new Error(`unresolvable ${stageId}`);
      return selection;
    };

  test('skips an extra reviewer whose runtime is identical to the primary', () => {
    const { kept, skipped } = partitionCoReviewStagesByRuntime(
      ['review.o', 'review.p'],
      primary,
      runtimeOf({
        'review.o': {
          harnessId: 'claude',
          modelId: 'claude-opus-5-5',
          reasoning: 'high',
        },
        'review.p': {
          harnessId: 'claude',
          modelId: 'claude-sonnet-4-5',
          reasoning: 'high',
        },
      }),
    );
    expect(kept).toEqual(['review.p']);
    expect(skipped).toEqual([
      { stageId: 'review.o', runtime: 'claude/claude-opus-5-5/high' },
    ]);
  });

  test('keeps an extra reviewer on a different model or reasoning', () => {
    const { kept, skipped } = partitionCoReviewStagesByRuntime(
      ['review.o', 'review.p'],
      primary,
      runtimeOf({
        'review.o': {
          harnessId: 'claude',
          modelId: 'claude-sonnet-4-5',
          reasoning: 'high',
        },
        'review.p': {
          harnessId: 'claude',
          modelId: 'claude-opus-5-5',
          reasoning: 'low',
        },
      }),
    );
    expect(kept).toEqual(['review.o', 'review.p']);
    expect(skipped).toEqual([]);
  });
});
