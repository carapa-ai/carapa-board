import { describe, expect, test } from 'bun:test';
import { formatFormResponseAsMarkdown } from './form-response-router.js';

describe('formatFormResponseAsMarkdown', () => {
  test('json_form uses property titles in schema order', () => {
    const body = formatFormResponseAsMarkdown(
      {
        kind: 'json_form',
        content: JSON.stringify({
          type: 'object',
          title: 'Quick poll',
          properties: {
            answer: { type: 'string', title: 'Pick one', enum: ['yes', 'no'] },
            note: { type: 'string', title: 'Anything else?' },
          },
          required: ['answer'],
        }),
      },
      { note: 'fine', answer: 'yes' },
    );

    expect(body).toBe('**Pick one**: yes\n**Anything else?**: fine');
  });

  test('json_form falls back to the property name and appends unknown keys', () => {
    const body = formatFormResponseAsMarkdown(
      {
        kind: 'json_form',
        content: JSON.stringify({
          type: 'object',
          properties: {
            answer: { type: 'string' },
            other: { type: 'string', title: '' },
          },
        }),
      },
      { answer: 'yes', other: 'x', extra: 'bonus' },
    );

    expect(body).toBe('**answer**: yes\n**other**: x\n**extra**: bonus');
  });

  test('json_form renders a missing value as empty', () => {
    const body = formatFormResponseAsMarkdown(
      {
        kind: 'json_form',
        content: JSON.stringify({
          type: 'object',
          properties: { answer: { type: 'string', title: 'Pick one' } },
        }),
      },
      {},
    );

    expect(body).toBe('**Pick one**: _(empty)_');
  });

  test('json_form with unparsable content keeps raw keys', () => {
    const body = formatFormResponseAsMarkdown(
      { kind: 'json_form', content: 'not json' },
      { answer: 'yes' },
    );

    expect(body).toBe('**answer**: yes');
  });

  test('html_form keeps raw keys', () => {
    const body = formatFormResponseAsMarkdown(
      { kind: 'html_form', content: '<input name="answer">' },
      { answer: 'yes' },
    );

    expect(body).toBe('**answer**: yes');
  });

  test('empty values produce the empty form response marker', () => {
    const body = formatFormResponseAsMarkdown(
      {
        kind: 'json_form',
        content: JSON.stringify({ type: 'object', properties: {} }),
      },
      {},
    );

    expect(body).toBe('*(empty form response)*');
  });
});
