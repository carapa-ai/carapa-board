import { describe, expect, test } from 'bun:test';
import { transcriptionExtraBody } from './transcribe-audio-llm.js';

describe('transcriptionExtraBody', () => {
  test('disables thinking for Gemma4-style agents', () => {
    const body = transcriptionExtraBody({
      id: 'llm:gemma4-12b',
      label: 'Gemma4',
      extra_body: {
        chat_template_kwargs: {
          enable_thinking: true,
          preserve_thinking: true,
        },
      },
    });
    expect(body.think).toBe(false);
    expect(body.temperature).toBe(0);
    expect((body.chat_template_kwargs as any).enable_thinking).toBe(false);
    expect((body.chat_template_kwargs as any).think).toBe(false);
  });
});
