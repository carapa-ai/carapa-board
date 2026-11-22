import { describe, expect, test } from 'bun:test';
import { validateVoiceStyleJson } from './voice-styles.js';

describe('Supertonic persona voice styles', () => {
  test('accepts Voice Builder shape and rejects malformed or oversized JSON', () => {
    expect(
      validateVoiceStyleJson(
        Buffer.from(
          JSON.stringify({ style_ttl: { dims: [] }, style_dp: { dims: [] } }),
        ),
      ),
    ).toBeTruthy();
    expect(() => validateVoiceStyleJson(Buffer.from('{'))).toThrow(
      'valid JSON',
    );
    expect(() => validateVoiceStyleJson(Buffer.from('{}'))).toThrow(
      'style_ttl and style_dp',
    );
    expect(() => validateVoiceStyleJson(Buffer.alloc(1024 * 1024 + 1))).toThrow(
      'under 1 MB',
    );
  });
});
