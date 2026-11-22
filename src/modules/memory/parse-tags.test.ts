import { describe, expect, test } from 'bun:test';
import { parseTagsInput } from './parse-tags.js';

describe('parseTagsInput', () => {
  test('parses a JSON array string', () => {
    expect(parseTagsInput('["decision-measure","batching","D-39"]')).toEqual([
      'decision-measure',
      'batching',
      'D-39',
    ]);
  });

  test('splits a comma-separated string', () => {
    expect(parseTagsInput('a, b')).toEqual(['a', 'b']);
  });

  test('recovers tags from malformed JSON', () => {
    expect(parseTagsInput('["a","b"')).toEqual(['a', 'b']);
  });

  test('passes arrays through, keeping only strings', () => {
    expect(parseTagsInput(['a', 'b'])).toEqual(['a', 'b']);
    expect(parseTagsInput(['a', 1, null, 'b'])).toEqual(['a', 'b']);
  });

  test('removes duplicates and empties', () => {
    expect(parseTagsInput(' a,,b , a ,')).toEqual(['a', 'b']);
    expect(parseTagsInput(['a', ' ', 'a', ''])).toEqual(['a']);
  });
});
