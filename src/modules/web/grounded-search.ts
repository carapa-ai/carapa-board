// Required Notice: Copyright Regun Software SRL (https://carapa.ai)

/**
 * Fallback for web_search when SearXNG has nothing: one Google-grounded Gemini
 * call through api-relay (Gemini-API-shaped route, no API key). Throttled,
 * cached, and never throws — a failure simply means "no fallback results".
 */

import { logger, serializeError } from '../../logger.js';
import {
  assertPublicHttpUrl,
  createGuardedFetch,
  defaultResolver,
  type Resolver,
  type WebFetch,
} from './url-guard.js';

interface GroundedSource {
  title: string;
  url: string;
  content: string;
}

export interface GroundedSearchResult {
  /** Model answer text, used as a summary block. */
  summary: string;
  sources: GroundedSource[];
}

/** A fallback attempt that failed (quota, outage, local throttle). */
interface GroundedSearchFailure {
  failure: string;
}

/** null: fallback disabled, or it answered without any usable result. */
export type GroundedSearch = (
  query: string,
) => Promise<GroundedSearchResult | GroundedSearchFailure | null>;

export interface GroundedSearchOptions {
  /** api-relay route prefix; empty disables the fallback. */
  url: string;
  model: string;
  fetch?: WebFetch;
  resolveHost?: Resolver;
}

// Worst case after SearXNG's 10s: QUEUE_WAIT + REQUEST + REDIRECT = 28s, which
// keeps web_search under the 45s default tool timeout.
const QUEUE_WAIT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;
const REDIRECT_TIMEOUT_MS = 3_000;
const MAX_CONCURRENT = 2;
const MAX_CALLS_PER_MINUTE = 10;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 100;
const MAX_SOURCES = 10;
const MAX_SNIPPET_CHARS = 500;
const MAX_SUMMARY_CHARS = 4_000;
// Grounding chunk URIs are Google redirects; only these are resolved.
const GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com';

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Follow one hop of a grounding redirect; keep the original URL on any failure. */
async function resolveGroundingRedirect(
  uri: string,
  guardedFetch: WebFetch,
  resolveHost: Resolver,
): Promise<string> {
  // The deadline also covers DNS lookups, which the fetch signal does not.
  const deadline = new Promise<string>((resolve) =>
    setTimeout(() => resolve(uri), REDIRECT_TIMEOUT_MS).unref?.(),
  );
  const resolveOnce = async (): Promise<string> => {
    try {
      if (new URL(uri).hostname !== GROUNDING_REDIRECT_HOST) return uri;
      const res = await guardedFetch(uri, {
        redirect: 'manual',
        signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (!location) return uri;
      const target = await assertPublicHttpUrl(
        new URL(location, uri).toString(),
        resolveHost,
      );
      return target.toString();
    } catch {
      return uri;
    }
  };
  return Promise.race([resolveOnce(), deadline]);
}

export function createGroundedSearch(
  options: GroundedSearchOptions,
): GroundedSearch {
  const baseUrl = options.url.trim().replace(/\/+$/, '');
  const doFetch: WebFetch =
    options.fetch ?? ((...args) => globalThis.fetch(...args));
  const resolveHost = options.resolveHost ?? defaultResolver;
  const guardedFetch = createGuardedFetch(doFetch, resolveHost);

  const cache = new Map<string, { value: GroundedSearchResult; ts: number }>();
  let callTimes: number[] = [];
  let active = 0;
  const waiters: Array<() => void> = [];

  /** Take a concurrency slot; false when none freed up within the queue deadline. */
  const acquire = async (): Promise<boolean> => {
    if (active < MAX_CONCURRENT) {
      active += 1;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        resolve(false);
      }, QUEUE_WAIT_TIMEOUT_MS);
      waiters.push(waiter);
    });
  };
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  };

  async function call(
    query: string,
  ): Promise<GroundedSearchResult | GroundedSearchFailure | null> {
    const res = await doFetch(
      `${baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: query }] }],
          tools: [{ googleSearch: {} }],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      logger.warn(
        { status: res.status, model: options.model, queryLength: query.length },
        res.status === 429
          ? 'Grounded web search quota/rate limit reached'
          : 'Grounded web search returned an error status',
      );
      return { failure: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as any;
    const candidate = data?.candidates?.[0];
    const summary = String(
      (candidate?.content?.parts ?? [])
        .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
        .join(''),
    ).trim();
    const chunks: any[] = candidate?.groundingMetadata?.groundingChunks ?? [];
    const supports: any[] =
      candidate?.groundingMetadata?.groundingSupports ?? [];

    const uris = await Promise.all(
      chunks.map((chunk) =>
        typeof chunk?.web?.uri === 'string'
          ? resolveGroundingRedirect(chunk.web.uri, guardedFetch, resolveHost)
          : Promise.resolve(''),
      ),
    );

    const seen = new Set<string>();
    const sources: GroundedSource[] = [];
    chunks.forEach((chunk, index) => {
      const url = uris[index];
      if (!url || seen.has(url) || sources.length >= MAX_SOURCES) return;
      seen.add(url);
      const snippets: string[] = [];
      for (const support of supports) {
        const text = support?.segment?.text;
        if (
          typeof text === 'string' &&
          Array.isArray(support.groundingChunkIndices) &&
          support.groundingChunkIndices.includes(index) &&
          !snippets.includes(text)
        ) {
          snippets.push(text);
        }
      }
      sources.push({
        title: typeof chunk.web.title === 'string' ? chunk.web.title : url,
        url,
        content: truncate(snippets.join(' '), MAX_SNIPPET_CHARS),
      });
    });

    if (sources.length === 0 && !summary) return null;
    return { summary: truncate(summary, MAX_SUMMARY_CHARS), sources };
  }

  return async (query) => {
    if (!baseUrl) return null;
    const key = query.trim().toLowerCase();
    const now = Date.now();

    const hit = cache.get(key);
    if (hit && now - hit.ts <= CACHE_TTL_MS) return hit.value;
    cache.delete(key);

    callTimes = callTimes.filter((t) => now - t < 60_000);
    if (callTimes.length >= MAX_CALLS_PER_MINUTE) {
      logger.warn(
        { queryLength: query.length },
        'Grounded web search skipped: per-minute cap reached',
      );
      return { failure: 'local rate cap reached' };
    }
    callTimes.push(now);

    if (!(await acquire())) {
      logger.warn(
        { queryLength: query.length },
        'Grounded web search skipped: concurrency slots busy',
      );
      return { failure: 'busy' };
    }
    try {
      const value = await call(query);
      if (value && 'sources' in value) {
        if (cache.size >= CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { value, ts: Date.now() });
        logger.info(
          { queryLength: query.length, sources: value.sources.length },
          'Web search served by grounded fallback',
        );
      }
      return value;
    } catch (err) {
      logger.warn(
        { error: serializeError(err), queryLength: query.length },
        'Grounded web search failed',
      );
      return { failure: 'request failed' };
    } finally {
      release();
    }
  };
}
