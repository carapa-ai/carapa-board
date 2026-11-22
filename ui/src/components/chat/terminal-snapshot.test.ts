// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { snapshotToTerminalText } from './terminal-snapshot';

describe('snapshotToTerminalText', () => {
  test('starts every snapshot row at column 0 without doubling existing CRLF', () => {
    expect(snapshotToTerminalText('a\nb\r\nc')).toBe('a\r\nb\r\nc');
  });
});
