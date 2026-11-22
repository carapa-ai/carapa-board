/**
 * Tests for the graph memory schema: lightweight (exact-match) entity-name
 * normalization.
 */

import { describe, test, expect } from 'bun:test';
import { normalizeEntityName } from './graph-schema.js';

describe('normalizeEntityName (exact-match resolution)', () => {
  test('lowercases and trims', () => {
    expect(normalizeEntityName('  Marta Rossi ')).toBe('marta rossi');
  });

  test('collapses internal whitespace', () => {
    expect(normalizeEntityName('Acme   Corp')).toBe('acme corp');
  });
});
