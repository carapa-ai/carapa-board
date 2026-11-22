// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { dictatedTextInsertion } from './dictation-text';

function apply(value: string, start: number, end: number, phrase: string) {
  const insertion = dictatedTextInsertion(value, start, end, phrase);
  if (!insertion) return value;
  return (
    value.slice(0, insertion.start) +
    insertion.text +
    value.slice(insertion.end)
  );
}

describe('composer dictation insertion', () => {
  test('inserts at the caret with whitespace-aware joining', () => {
    expect(apply('hello world', 5, 5, 'brave')).toBe('hello brave world');
    expect(apply('hello', 5, 5, ', friend')).toBe('hello, friend');
  });

  test('replaces only the active selection and preserves later user edits', () => {
    expect(apply('alpha editable omega', 6, 14, 'spoken words')).toBe(
      'alpha spoken words omega',
    );
  });

  test('ignores empty finals', () => {
    expect(dictatedTextInsertion('draft', 5, 5, '   ')).toBeNull();
  });
});
