// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { normalizeTerminalTitle } from './terminal-title';

describe('normalizeTerminalTitle', () => {
  test('drops an animated spinner prefix so a spinning title stays constant', () => {
    expect(normalizeTerminalTitle('⠙ aaaaa')).toBe('aaaaa');
    expect(normalizeTerminalTitle('⠹ aaaaa')).toBe(normalizeTerminalTitle('⠙ aaaaa'));
    expect(normalizeTerminalTitle('✳ Claude Code')).toBe('✳ Claude Code');
  });

  test('an empty or control-only title means no title', () => {
    expect(normalizeTerminalTitle('')).toBe('');
    expect(normalizeTerminalTitle('\u001b\u0007  ')).toBe('');
  });
});
