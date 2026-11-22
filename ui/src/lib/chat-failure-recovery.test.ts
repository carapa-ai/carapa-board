// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  hasPartialResponseBeforeSandboxError,
  isPersistentTurnTimeout,
} from './chat-failure-recovery';

describe('isPersistentTurnTimeout', () => {
  test('recognizes warm-session turn timeout variants', () => {
    expect(
      isPersistentTurnTimeout('⚠️ Sandbox Error: persistent: turn timeout'),
    ).toBe(true);
    expect(
      isPersistentTurnTimeout(
        '⚠️ Sandbox Error: persistent: cursor-acp turn timeout',
      ),
    ).toBe(true);
  });

  test('does not treat unrelated failures as resumable turn timeouts', () => {
    expect(isPersistentTurnTimeout('⚠️ Sandbox Error: request timeout')).toBe(
      false,
    );
    expect(
      isPersistentTurnTimeout(
        '⚠️ Sandbox Error: persistent: lock wait timeout',
      ),
    ).toBe(false);
  });
});

describe('hasPartialResponseBeforeSandboxError', () => {
  test('recognizes a failure after assistant output', () => {
    expect(
      hasPartialResponseBeforeSandboxError(
        'I updated the first two files.\n\n⚠️ Sandbox Error: connection lost',
      ),
    ).toBe(true);
  });

  test('recognizes a capacity failure after assistant output', () => {
    expect(
      hasPartialResponseBeforeSandboxError(
        'I updated the first two files.\nSelected model is at capacity. Please try a different model.\n⚠️ Sandbox Error: request failed',
      ),
    ).toBe(true);
    expect(
      hasPartialResponseBeforeSandboxError(
        'I updated the first two files.\n⚠️ **LLM Error**: Responses API stream ended unsuccessfully: Selected model is at capacity. Please try a different model.',
      ),
    ).toBe(true);
    // Stream chunks concatenate without a separator, so the live buffer can
    // join the error marker directly onto the last output character.
    expect(
      hasPartialResponseBeforeSandboxError(
        'I updated the first two files.⚠️ **LLM Error**: Responses API stream ended unsuccessfully: Selected model is at capacity. Please try a different model.',
      ),
    ).toBe(true);
  });

  test('rejects immediate failures and provider diagnostics', () => {
    expect(
      hasPartialResponseBeforeSandboxError(
        '⚠️ Sandbox Error: authentication failed',
      ),
    ).toBe(false);
    expect(
      hasPartialResponseBeforeSandboxError(
        'Selected model is at capacity\n⚠️ Sandbox Error: request failed',
      ),
    ).toBe(false);
    expect(
      hasPartialResponseBeforeSandboxError(
        '⚠️ **LLM Error**: Responses API stream ended unsuccessfully: Selected model is at capacity. Please try a different model.',
      ),
    ).toBe(false);
  });
});
