import { describe, expect, test } from 'bun:test';
import { isSandboxRunning } from './status.js';

describe('isSandboxRunning', () => {
  test.each([
    [{ stdout: '[{"State":"running"}]', isError: false }, true],
    [{ stdout: 'service is not running', isError: false }, false],
    [{ stdout: 'sandbox not found', isError: false }, false],
    [{ stdout: '[{"State":"running"}]', isError: true }, false],
    [{ stdout: '[]', isError: false }, false],
  ])('interprets CarapaBox status output %#', (status, expected) => {
    expect(isSandboxRunning(status)).toBe(expected);
  });
});
