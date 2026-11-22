/**
 * Tests for src/stream/parsers.ts display re-exports.
 */

import { describe, test, expect } from 'bun:test';
import { formatToolResult } from './parsers.js';

describe('formatToolResult', () => {
  test('hides the empty-output sentinel without hiding real output that mentions it', () => {
    expect(formatToolResult([{ type: 'text', text: '(no output)' }])).toBe('');
    expect(formatToolResult('file content: (no output)')).toContain(
      '> file content: (no output)',
    );
  });
});
