import { describe, expect, test } from 'bun:test';
import { directLlmAgent, prepareForTts } from './normalizer.js';

describe('TTS DirectLLM selection', () => {
  test('does not produce a DirectLLM configuration for a CLI runtime with an inherited endpoint', () => {
    expect(
      directLlmAgent({
        id: 'claude:qwen',
        harnessKind: 'cli',
        baseUrl: 'http://inherited.example/v1',
      } as any),
    ).toBeUndefined();
  });

  test('uses a materialized direct runtime endpoint', () => {
    expect(
      directLlmAgent({
        id: 'llm:direct:qwen',
        harnessKind: 'direct',
        baseUrl: 'http://direct.example/v1',
      } as any),
    ).toEqual({
      agentId: 'llm:direct:qwen',
      baseUrl: 'http://direct.example/v1',
    });
  });
});

describe('TTS expression normalization', () => {
  test('preserves approved Supertonic tags at their prose boundaries', async () => {
    const prepared = await prepareForTts(
      'Well <throatclear> okay <yawn>!',
      'en',
    );

    expect(prepared.sentences.join(' ')).toBe(
      'Well <throatclear> okay <yawn> !',
    );
    expect(prepared.normalized).toBe(false);
  });
});

describe('TTS tool activity provenance', () => {
  test('keeps reserved markers and tool blockquotes out of prepared speech', async () => {
    const prepared = await prepareForTts(
      [
        'Spoken answer before.',
        '<!-- carapa-tool:request -->',
        '> **webFetch**',
        '<!-- carapa-tool:result -->',
        '> 7 files',
        '<!-- carapa-tool:error -->',
        '> Permission denied',
        'Spoken answer after.',
      ].join('\n'),
      'en',
    );

    expect(prepared.sentences.join(' ')).toBe(
      'Spoken answer before. Spoken answer after.',
    );
    expect(prepared.sentences.join(' ')).not.toContain('carapa-tool');
  });
});
