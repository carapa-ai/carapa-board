// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  nextPromptPollDecision,
  PROMPT_POLL_MAX_FAILURES,
} from './public-share-prompt-poll';

describe('nextPromptPollDecision', () => {
  test('404 ends the poll immediately', () => {
    expect(nextPromptPollDecision(404, 0).outcome).toBe('unavailable');
  });

  test('transient failures retry until 40 consecutive failures', () => {
    let failures = 0;
    for (let i = 1; i < PROMPT_POLL_MAX_FAILURES; i++) {
      const decision = nextPromptPollDecision(500, failures);
      expect(decision.outcome).toBe('retry');
      failures = decision.consecutiveFailures;
    }
    expect(nextPromptPollDecision(500, failures).outcome).toBe('unavailable');
  });

  test('a successful response resets the failure count', () => {
    expect(nextPromptPollDecision(200, 12)).toEqual({
      outcome: 'ok',
      consecutiveFailures: 0,
    });
  });
});
