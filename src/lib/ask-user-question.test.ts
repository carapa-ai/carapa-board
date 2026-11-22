import { describe, expect, test } from 'bun:test';
import { normalizeAskUserQuestions } from './ask-user-question.js';

describe('normalizeAskUserQuestions', () => {
  test('accepts a question array', () => {
    const qs = [{ question: 'Pick one', options: [{ label: 'A' }] }];
    expect(normalizeAskUserQuestions(qs)).toEqual(qs);
  });

  test('parses a JSON string of questions', () => {
    const qs = [{ question: 'Pick one' }];
    expect(normalizeAskUserQuestions(JSON.stringify(qs))).toEqual(qs);
  });

  test('wraps a single question object', () => {
    const q = { question: 'Pick one', options: [{ label: 'A' }] };
    expect(normalizeAskUserQuestions(q)).toEqual([q]);
  });

  test('builds from legacy flat input fields', () => {
    expect(
      normalizeAskUserQuestions(undefined, {
        question: 'Which repo?',
        header: 'Target',
        multiSelect: true,
      }),
    ).toEqual([
      {
        question: 'Which repo?',
        header: 'Target',
        options: undefined,
        multiSelect: true,
      },
    ]);
  });

  test('rejects plain strings that are not JSON arrays', () => {
    expect(normalizeAskUserQuestions('Pick one')).toBeNull();
  });
});
