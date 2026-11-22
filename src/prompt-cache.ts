/**
 * Convert an assembled system prompt into an Anthropic-cacheable request
 * shape. The system prompt is built by `system-prompt-builder.ts` and
 * contains a `CACHE_BREAKPOINT_MARKER` substring at the boundary between
 * the stable project prefix (cacheable across users and turns)
 * and the per-conversation tail. This module:
 *
 *   1. Detects whether the backend is Anthropic (the only provider that
 *      honours `cache_control: { type: "ephemeral" }`).
 *   2. Splits the system prompt on the marker, producing at most two
 *      text blocks.
 *   3. Returns a new system-prompt shape (`extra_body.system` array)
 *      with `cache_control` attached to the prefix block.
 *
 * Two important non-features:
 *   - The system prompt MUST remain a single `string` on the OpenAI /
 *     non-Anthropic paths. We do not change the request shape there.
 *   - We never split into more than two blocks. The current
 *     `assembleSystemPrompt` emits at most one marker, so a single
 *     split is sufficient. A future marker variant would need an
 *     updated `assembleSystemPrompt` + a matching update here.
 *
 * The output of this helper is what `runDirectLlm` puts into
 * `params.extra_body.system` (and removes from `messages[0]`).
 */

import {
  CACHE_BREAKPOINT_MARKER,
  VOLATILE_CONTEXT_MARKER,
} from './prompt-loader.js';

/** Keep reusable instructions before any per-run system context. */
export function assembleCacheableSystemPrompt(
  stablePrefix: string,
  variableSuffix = '',
): string {
  return (
    stablePrefix +
    CACHE_BREAKPOINT_MARKER +
    (variableSuffix ? VOLATILE_CONTEXT_MARKER + variableSuffix : '')
  );
}

/**
 * A single Anthropic-style text content block, optionally carrying
 * `cache_control`. The shape is what the Anthropic `/v1/messages` API
 * accepts as the top-level `system` field (or any content part).
 *
 * `cache_control` on the *last* block of a request anchors the cache
 * breakpoint: everything from the previous breakpoint (or the start of
 * the request) up to and including this block is one cacheable region.
 */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/**
 * Heuristic: identify Anthropic / Anthropic-compatible backends from the
 * `baseUrl` an agent is configured with. Returns `true` for:
 *
 *   - `https://api.anthropic.com` (direct Anthropic API)
 *   - `http://api-relay:8080/anthropic/...` (carapa-box's transparent
 *     credential-injection relay forwarding to api.anthropic.com)
 *   - any URL whose path contains `/anthropic/` (matches the relay
 *     convention and any user-defined proxies)
 *   - any URL whose host contains `anthropic` (catches other proxies)
 *
 * Returns `false` for OpenAI, OpenRouter, Ollama, llama.cpp, or any
 * other non-Anthropic backend — for those we do NOT inject
 * `cache_control` (the field would either be ignored or cause a 4xx).
 */
function isAnthropicBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  return baseUrl.toLowerCase().includes('anthropic');
}

/**
 * Split the assembled system prompt on the first cache-breakpoint
 * marker, returning the prefix and the rest. When the marker is
 * absent (e.g. the sandbox path always emits it, but a future
 * assembly might not) the suffix is `null` and the caller can decide
 * whether to skip cache-control entirely.
 *
 * Marker occurrences beyond the first are ignored. They shouldn't
 * happen with the current `assembleSystemPrompt`; if they do (e.g.
 * user-pasted content happens to contain the marker string), the
 * Anthropic cache region would split on the first one, which is the
 * conservative behaviour — it errs on the side of *more* cache
 * regions, not fewer, and never silently disables caching.
 */
function splitSystemPromptAtBreakpoint(systemPrompt: string): {
  prefix: string;
  suffix: string | null;
} {
  const idx = systemPrompt.indexOf(CACHE_BREAKPOINT_MARKER);
  if (idx === -1) return { prefix: systemPrompt, suffix: null };
  return {
    prefix: systemPrompt.slice(0, idx),
    suffix: systemPrompt.slice(idx + CACHE_BREAKPOINT_MARKER.length),
  };
}

/**
 * Build the Anthropic-compatible `system` array for the request body.
 * Returns `null` when no cache_control should be applied — the caller
 * leaves the system prompt in `messages[0]` and skips `extra_body.system`.
 *
 * Conditions for returning a non-null value:
 *
 *   1. `baseUrl` is an Anthropic / Anthropic-proxy URL.
 *   2. The system prompt contains the cache-breakpoint marker.
 *   3. The prefix is non-empty after trimming (Anthropic rejects an
 *      empty `system` field; the marker-split always yields a non-empty
 *      prefix when the marker is at position > 0, but the very first
 *      system message can be a single section with no marker, in
 *      which case there is nothing to split on).
 *   4. The prefix is at least 1024 tokens (~ 4000 chars at 4 chars /
 *      token). Anthropic's minimum cacheable region is 1024 tokens;
 *      below that, the API ignores the cache_control marker and the
 *      cache write charges back at full price. We use a conservative
 *      character estimate to avoid wasted cache writes.
 *
 * On a non-null return the caller MUST:
 *   - drop `messages[0]` (the original system message) from the
 *     `messages` array (Anthropic rejects a request that has both
 *     `system` and a `messages[].role = 'system'` entry)
 *   - set `params.extra_body.system = blocks` (the OpenAI SDK
 *     forwards unknown top-level fields as-is)
 *
 * The returned array has at most two blocks. The first carries
 * `cache_control: { type: "ephemeral" }`; the second (suffix) is plain
 * and varies per objective — it sits after the cache region
 * and is sent fresh every turn.
 */
export function buildAnthropicSystemBlocks(
  systemPrompt: string,
  baseUrl: string | undefined | null,
): AnthropicTextBlock[] | null {
  if (!isAnthropicBaseUrl(baseUrl)) return null;

  const { prefix, suffix } = splitSystemPromptAtBreakpoint(systemPrompt);
  if (suffix === null) {
    // No marker present (sandbox path, or future assembly without a
    // breakpoint). Without a marker there is no cache region to
    // anchor, so we leave the system prompt in messages[0] and skip
    // the Anthropic-specific shape entirely.
    return null;
  }

  // Anthropic's minimum cacheable region is 1024 tokens. Below that
  // the API ignores the cache_control marker and still bills a full
  // cache write. Skip the cache_control in that case so the user
  // doesn't pay the cache write cost for nothing. The 4-chars-per-
  // token ratio is a conservative estimate for English + JSON /
  // markdown; a real tokenizer would be more accurate but a constant
  // factor keeps the helper allocation-free.
  const MIN_PREFIX_CHARS = 1024 * 4;
  if (prefix.length < MIN_PREFIX_CHARS) return null;

  const blocks: AnthropicTextBlock[] = [
    {
      type: 'text',
      text: prefix,
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (suffix) {
    blocks.push({ type: 'text', text: suffix });
  }
  return blocks;
}
