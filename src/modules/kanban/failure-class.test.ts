import { describe, expect, test } from 'bun:test';

import {
  classifyTaskFailure,
  FAILURE_REASON_MAX_LENGTH,
} from './failure-class.js';

describe('classifyTaskFailure', () => {
  test.each([
    ['Interrupted: server restarted during execution', 'infra_transient'],
    ['Retry scheduled: provider overloaded', 'infra_transient'],
    ['Transient error retries exhausted after 3 attempts', 'infra_transient'],
    ['Timed out: agent did not finish before deadline', 'timeout'],
    ['Timed out during process restart', 'timeout'],
    ['⚠️ Configuration error: missing model', 'config'],
    ['Deploy failed: exit 1', 'deploy'],
    ['Deploy error: ECONNREFUSED', 'deploy'],
    ['Agent exited with error during restart', 'agent_error'],
    ['TypeError: x is not a function', 'agent_error'],
    ['', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ] as const)('classifies %p as %s', (error, expected) => {
    expect(classifyTaskFailure(error).failure_class).toBe(expected);
  });

  test('manual moves are classed user', () => {
    expect(classifyTaskFailure('anything', 'user').failure_class).toBe('user');
  });

  test('empty text yields a non-empty placeholder reason', () => {
    expect(classifyTaskFailure('  \n ').failure_reason).toBe(
      'No error text captured (unknown)',
    );
    expect(classifyTaskFailure(null, 'user').failure_reason).toBe(
      'No error text captured (user)',
    );
  });

  test('bounds a 500-char deploy stdout to 300 chars with an ellipsis', () => {
    const { failure_class, failure_reason } = classifyTaskFailure(
      `Deploy failed: ${'x'.repeat(500)}`,
    );
    expect(failure_class).toBe('deploy');
    expect(failure_reason).toHaveLength(FAILURE_REASON_MAX_LENGTH);
    expect(failure_reason.endsWith('…')).toBe(true);
  });

  test('strips ANSI codes and JSONL protocol lines and collapses whitespace', () => {
    const { failure_reason } = classifyTaskFailure(
      '{"type":"system","subtype":"init"}\n\x1b[31mError:\x1b[0m   boom\n\n  bang',
    );
    expect(failure_reason).toBe('Error: boom bang');
  });

  test('drops an echoed task description prefix', () => {
    const description =
      'Implement the widget exactly as described in the spec.';
    const { failure_reason } = classifyTaskFailure(
      `${description}\nError: build failed`,
      undefined,
      description,
    );
    expect(failure_reason).toBe('Error: build failed');
  });
});
