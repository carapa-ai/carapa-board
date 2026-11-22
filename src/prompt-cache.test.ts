/**
 * Tests for src/prompt-cache.ts — the Anthropic cache_control
 * conversion layer between the assembled system prompt (with
 * CACHE_BREAKPOINT_MARKER) and the Anthropic request body shape.
 */

import { describe, test, expect } from 'bun:test';

import { buildAnthropicSystemBlocks } from './prompt-cache.js';
import { CACHE_BREAKPOINT_MARKER } from './prompt-loader.js';
import { assembleSystemPrompt } from './system-prompt-builder.js';

// ─── isAnthropicBaseUrl ──────────────────────────────────────────────────────

describe('buildAnthropicSystemBlocks', () => {
  test('returns null when the prefix is below the 1024-token minimum', () => {
    // 100 chars of prefix << 1024 tokens (~ 4000 chars). Anthropic's
    // minimum cacheable region is 1024 tokens; below that the API
    // ignores the cache_control marker and charges a full cache write.
    const shortPrefix = 'a'.repeat(100);
    const prompt = `${shortPrefix}${CACHE_BREAKPOINT_MARKER}some user prefs`;
    expect(
      buildAnthropicSystemBlocks(prompt, 'https://api.anthropic.com/v1'),
    ).toBeNull();
  });

  test('returns two blocks (prefix + suffix) for a long prompt with a marker', () => {
    const prefix = 'X'.repeat(5000); // ~1250 tokens, above 1024 floor
    const suffix = 'user prefs here';
    const prompt = `${prefix}${CACHE_BREAKPOINT_MARKER}${suffix}`;
    const blocks = buildAnthropicSystemBlocks(
      prompt,
      'https://api.anthropic.com/v1',
    );
    expect(blocks).not.toBeNull();
    expect(blocks).toHaveLength(2);
    expect(blocks![0].type).toBe('text');
    expect(blocks![0].text).toBe(prefix);
    expect(blocks![0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks![1].type).toBe('text');
    expect(blocks![1].text).toBe(suffix);
    expect(blocks![1].cache_control).toBeUndefined();
  });

  test('keeps the cached block identical when objective context changes', () => {
    const systemPrompt = 'Stable project instructions. '.repeat(200);
    const blocksFor = (objectiveRules: string) =>
      buildAnthropicSystemBlocks(
        assembleSystemPrompt({ systemPrompt, objectiveRules }),
        'https://api.anthropic.com/v1',
      )!;
    const first = blocksFor('First objective context');
    const second = blocksFor('Different objective context');

    expect(first[0]).toEqual(second[0]);
    expect(first[0].text).toBe(systemPrompt);
    expect(first[1].text).toContain('First objective context');
    expect(second[1].text).toContain('Different objective context');
    expect(first[1].cache_control).toBeUndefined();
    expect(second[1].cache_control).toBeUndefined();
  });

  test('caches a qualifying stable prefix when the variable suffix is empty', () => {
    const prefix = 'X'.repeat(5000);
    const blocks = buildAnthropicSystemBlocks(
      assembleSystemPrompt({ systemPrompt: prefix }),
      'https://api.anthropic.com/v1',
    );

    expect(blocks).toEqual([
      {
        type: 'text',
        text: prefix,
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });
});
