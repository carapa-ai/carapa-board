// Required Notice: Copyright Regun Software SRL (https://carapa.ai)

import {
  SEARXNG_URL,
  WEB_SEARCH_GROUNDING_MODEL,
  WEB_SEARCH_GROUNDING_URL,
} from '../../config.js';
import { logger, serializeError } from '../../logger.js';
import TurndownService from 'turndown';
import { parseHTML } from 'linkedom';
import { PDFParse } from 'pdf-parse';
import {
  normalizeYouTubeVideoUrl,
  resolveSharedGoogleUrl,
  retrieveYouTubeTranscript,
} from './youtube-transcript.js';
import { retrieveXPost } from './x-post.js';
import { BodyTooLargeError, readCapped } from './read-capped.js';
import {
  retrieveWithBrowserAgent,
  type WebViewAgentContext,
} from './browser-agent.js';
import {
  createGroundedSearch,
  type GroundedSearch,
  type GroundedSearchResult,
} from './grounded-search.js';
import {
  assertPublicHttpUrl,
  BlockedUrlError,
  createGuardedFetch,
  defaultResolver,
  type Resolver,
  type WebFetch,
} from './url-guard.js';

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface WebViewDependencies {
  fetch: WebFetch;
  resolveHost: Resolver;
  retrieveWithBrowserAgent: typeof retrieveWithBrowserAgent;
}

const defaultWebViewDependencies: WebViewDependencies = {
  fetch: (...args) => globalThis.fetch(...args),
  resolveHost: defaultResolver,
  retrieveWithBrowserAgent,
};

/** Largest response body web_view reads, counted after decompression. */
export const WEB_VIEW_MAX_BODY_BYTES = 20 * 1024 * 1024;

function webFetchSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(10_000);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

// In-memory cache of successfully fetched pages (url -> markdown). Lets a page
// fetched earlier in a conversation (e.g. via the web_view tool) be reused
// instantly when saving the message to a knowledge base, instead of re-fetching.
const WEBVIEW_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const WEBVIEW_CACHE_MAX = 100;
// Markdown above this many characters is returned but not kept in the cache.
const WEBVIEW_CACHE_MAX_CHARS = 500_000;
const webViewCache = new Map<string, { markdown: string; ts: number }>();

/** Return a previously fetched page's markdown if it is still cached, else null. Never fetches. */
export function getCachedWebView(url: string): string | null {
  const hit = webViewCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.ts > WEBVIEW_CACHE_TTL_MS) {
    webViewCache.delete(url);
    return null;
  }
  // Refresh recency (Map preserves insertion order → cheap LRU)
  webViewCache.delete(url);
  webViewCache.set(url, hit);
  return hit.markdown;
}

function setCachedWebView(url: string, markdown: string): void {
  if (markdown.length > WEBVIEW_CACHE_MAX_CHARS) return;
  if (webViewCache.size >= WEBVIEW_CACHE_MAX) {
    const oldest = webViewCache.keys().next().value;
    if (oldest !== undefined) webViewCache.delete(oldest);
  }
  webViewCache.set(url, { markdown, ts: Date.now() });
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

// Configure turndown to strip scripts, styles, etc.
turndown.remove([
  'script',
  'style',
  'iframe',
  'noscript',
  'canvas',
  'svg',
  'video',
  'audio',
]);

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en',
  'Sec-Ch-Ua':
    '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Linux"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Mirror sites respond best to bot user agents (they provide static meta-content).
 * Browser user agents often trigger a redirect back to the original problematic site.
 */
const BOT_HEADERS = {
  ...DEFAULT_HEADERS,
  'User-Agent': 'facebookexternalhit/1.1',
};

/**
 * Check if a URL is one of our known privacy-friendly mirrors.
 */
function isMirrorUrl(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return [
      'fxtwitter.com',
      'fixupx.com',
      'ddinstagram.com',
      'vxtiktok.com',
    ].includes(host);
  } catch {
    return false;
  }
}

export interface UnresponsiveEngine {
  engine: string;
  reason: string;
}

export interface WebSearchDetailed {
  results: WebSearchResult[];
  unresponsiveEngines: UnresponsiveEngine[];
  /** Set when results came from the Google-grounded Gemini fallback. */
  grounded?: { summary: string };
}

const defaultGroundedSearch = createGroundedSearch({
  url: WEB_SEARCH_GROUNDING_URL,
  model: WEB_SEARCH_GROUNDING_MODEL,
});

/**
 * Search the web using SearXNG, also reporting engines that failed to answer
 * (SearXNG `unresponsive_engines`: `[engineName, reason]` pairs).
 */
export async function webSearchDetailed(
  query: string,
  groundedSearch: GroundedSearch = defaultGroundedSearch,
): Promise<WebSearchDetailed> {
  let searxng: WebSearchDetailed;
  try {
    searxng = await searxngSearch(query);
  } catch (err) {
    // SearXNG itself is down: still try the fallback, else surface the error.
    const grounded = await groundedSearch(query);
    if (grounded && 'sources' in grounded) return groundedToDetailed(grounded);
    throw err;
  }
  if (searxng.results.length > 0) return searxng;
  const grounded = await groundedSearch(query);
  if (!grounded) return searxng;
  if ('failure' in grounded) {
    // Report a failed fallback like an unresponsive engine so the tool says
    // "Search failed" instead of claiming that nothing exists.
    return {
      ...searxng,
      unresponsiveEngines: [
        ...searxng.unresponsiveEngines,
        { engine: 'google-grounded-gemini', reason: grounded.failure },
      ],
    };
  }
  return {
    ...groundedToDetailed(grounded),
    unresponsiveEngines: searxng.unresponsiveEngines,
  };
}

function groundedToDetailed(grounded: GroundedSearchResult): WebSearchDetailed {
  return {
    results: grounded.sources,
    unresponsiveEngines: [],
    grounded: { summary: grounded.summary },
  };
}

async function searxngSearch(query: string): Promise<WebSearchDetailed> {
  try {
    const url = new URL(`${SEARXNG_URL}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`SearXNG returned ${res.status}`);
    }

    const data = (await res.json()) as any;
    const results = (data.results || []).slice(0, 10).map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || '',
    }));
    const unresponsiveEngines = (
      Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : []
    )
      .filter((e: unknown) => Array.isArray(e) && typeof e[0] === 'string')
      .map((e: unknown[]) => ({
        engine: e[0] as string,
        reason: typeof e[1] === 'string' ? e[1] : 'unknown',
      }));
    return { results, unresponsiveEngines };
  } catch (err) {
    logger.error(
      { error: serializeError(err), queryLength: query.length },
      'Web search failed',
    );
    throw err;
  }
}

/**
 * Detect mirrors for problematic sites (Twitter, X, Instagram, TikTok)
 */
function getMirroredUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();

    if (host === 'twitter.com' || host.endsWith('.twitter.com')) {
      url.hostname = 'fxtwitter.com';
      return url.toString();
    }
    if (host === 'x.com' || host.endsWith('.x.com')) {
      url.hostname = 'fixupx.com';
      return url.toString();
    }
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
      url.hostname = 'ddinstagram.com';
      return url.toString();
    }
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
      url.hostname = 'vxtiktok.com';
      return url.toString();
    }
  } catch {
    // Ignore invalid URLs
  }
  return null;
}

/**
 * Fetch a URL and return its content as Markdown.
 * Serves from an in-memory cache when the same URL was fetched recently (so a
 * link already opened earlier in a conversation is reused instantly), otherwise
 * fetches fresh and caches the result. Failures are not cached.
 */
export async function webView(
  url: string,
  dependencyOverrides: Partial<WebViewDependencies> = {},
  context?: WebViewAgentContext,
): Promise<string> {
  const dependencies = {
    ...defaultWebViewDependencies,
    ...dependencyOverrides,
  };
  const logBlocked = (err: unknown) => {
    if (err instanceof BlockedUrlError) {
      logger.warn(
        {
          reason: err.reason,
          scheme: err.scheme,
          project: context?.group_folder,
        },
        'web_view URL blocked',
      );
    }
  };

  // Refuse before the cache lookup so a blocked URL is never fetched, cached
  // or handed to the browser agent.
  try {
    await assertPublicHttpUrl(url, dependencies.resolveHost);
  } catch (err) {
    logBlocked(err);
    throw err;
  }

  const cached = getCachedWebView(url);
  if (cached !== null) {
    logger.debug({ url }, 'webView: serving cached content');
    return cached;
  }

  const guardedFetch = createGuardedFetch(
    dependencies.fetch,
    dependencies.resolveHost,
  );
  const markdown = await fetchWebView(
    url,
    {
      ...dependencies,
      fetch: async (...args) => {
        try {
          return await guardedFetch(...args);
        } catch (err) {
          logBlocked(err);
          throw err;
        }
      },
    },
    context,
  );
  if (!isCacheablePageMarkdown(markdown)) {
    throw new Error('Failed to retrieve useful page content');
  }
  setCachedWebView(url, markdown);
  return markdown;
}

function isCacheablePageMarkdown(markdown: string): boolean {
  const normalized = markdown.trim();
  if (!/^> \*\*Source\*\*:/m.test(normalized)) return false;
  const body = normalized.replace(/^> \*\*Source\*\*:.*$/m, '').trim();
  return (
    body.length > 0 &&
    !/^\[(?:No (?:readable )?(?:content|text)|PDF text extraction failed)/i.test(
      body,
    )
  );
}

/** Statuses that mean the page is gone, so the browser fallback is skipped. */
const MISSING_PAGE_STATUS: Record<number, string> = {
  404: 'Not Found',
  410: 'Gone',
};

/**
 * Fetch a URL and return its content as Markdown.
 * Optimistically tries static fetch first, then delegates uncertain pages to a
 * normal sandbox agent with an already-open playwright-cli session.
 */
async function fetchWebView(
  url: string,
  dependencies: WebViewDependencies,
  context?: WebViewAgentContext,
): Promise<string> {
  const resolvedUrl = await resolveSharedGoogleUrl(
    url,
    dependencies.fetch,
    context?.signal,
  );
  const youtubeVideo = normalizeYouTubeVideoUrl(resolvedUrl);
  if (youtubeVideo) {
    return retrieveYouTubeTranscript(
      youtubeVideo,
      dependencies.fetch,
      context?.signal,
    );
  }

  const xPost = await retrieveXPost(
    resolvedUrl,
    dependencies.fetch,
    context?.signal,
  );
  if (xPost) return xPost;

  const mirroredUrl = getMirroredUrl(resolvedUrl);
  const urlsToTry = mirroredUrl ? [mirroredUrl, resolvedUrl] : [resolvedUrl];

  let missingStatus: number | null = null;

  for (const targetUrl of urlsToTry) {
    try {
      const isMirror = isMirrorUrl(targetUrl);
      // 1. Try FAST static fetch first
      logger.debug(
        { targetUrl, originalUrl: url, isMirror },
        'Attempting optimistic static fetch',
      );
      const res = await dependencies.fetch(targetUrl, {
        headers: isMirror ? BOT_HEADERS : DEFAULT_HEADERS,
        signal: webFetchSignal(context?.signal),
      });

      if (res.ok) {
        // Read the response as bytes first. A PDF passed to Response.text()
        // becomes binary garbage, which is both unusable and potentially very
        // expensive to put into the model context.
        const body = new Uint8Array(
          await readCapped(res, WEB_VIEW_MAX_BODY_BYTES),
        );
        if (isPdfResponse(res.headers.get('content-type'), body)) {
          return await convertPdfToMarkdown(body, resolvedUrl);
        }

        const html = new TextDecoder().decode(body);
        const finalUrl = res.url;

        // 2. Keep the cheap path only when its extracted page content is
        // clearly useful. Ambiguous shells and gates belong to the agent.
        const staticMarkdown = convertToMarkdown(html, resolvedUrl);
        if (isUsefulStaticExtraction(staticMarkdown, html, isMirror)) {
          logger.debug(
            { targetUrl },
            'Static fetch successful and substantial',
          );
          return staticMarkdown;
        }

        // If we didn't try a mirror yet, but the final URL (after redirect) is problematic
        const redirectMirror = getMirroredUrl(finalUrl);
        if (redirectMirror && targetUrl !== redirectMirror) {
          logger.debug(
            { finalUrl, redirectMirror },
            'Redirected to problematic site, trying mirror',
          );
          const mRes = await dependencies.fetch(redirectMirror, {
            headers: BOT_HEADERS,
            signal: webFetchSignal(context?.signal),
          });
          if (mRes.ok) {
            const mBody = new Uint8Array(
              await readCapped(mRes, WEB_VIEW_MAX_BODY_BYTES),
            );
            if (isPdfResponse(mRes.headers.get('content-type'), mBody)) {
              return await convertPdfToMarkdown(mBody, resolvedUrl);
            }
            const mHtml = new TextDecoder().decode(mBody);
            const mirrorMarkdown = convertToMarkdown(mHtml, resolvedUrl);
            if (isUsefulStaticExtraction(mirrorMarkdown, mHtml, true)) {
              return mirrorMarkdown;
            }
          }
        }

        logger.debug(
          { targetUrl },
          'Static fetch returned JS shell or error page, falling back',
        );
      } else if (!isMirror && MISSING_PAGE_STATUS[res.status]) {
        // The original URL definitively does not exist; a browser agent
        // cannot change that and would only run into its long deadline.
        missingStatus = res.status;
        break;
      }
    } catch (err) {
      // A refused URL must never fall back to the browser agent.
      if (err instanceof BlockedUrlError) throw err;
      // An oversized page cannot be read by the browser agent either.
      if (err instanceof BodyTooLargeError) {
        throw new Error(
          `Page is larger than the ${WEB_VIEW_MAX_BODY_BYTES / (1024 * 1024)} MB limit: ${resolvedUrl}`,
        );
      }
      logger.debug({ err, targetUrl }, 'Static fetch failed');
    }
  }

  if (missingStatus !== null) {
    throw new Error(
      `HTTP ${missingStatus} ${MISSING_PAGE_STATUS[missingStatus]}: ${resolvedUrl}`,
    );
  }

  if (!context) {
    throw new Error(
      'Failed to retrieve useful content statically and browser-agent context was not provided',
    );
  }
  return dependencies.retrieveWithBrowserAgent(resolvedUrl, context);
}

/** Identify PDFs without trusting Content-Type alone (many file hosts omit it). */
export function isPdfResponse(
  contentType: string | null,
  body: Uint8Array,
): boolean {
  return (
    (contentType || '').split(';', 1)[0].trim().toLowerCase() ===
      'application/pdf' ||
    new TextDecoder().decode(body.subarray(0, 5)) === '%PDF-'
  );
}

/** Extract readable PDF text and always return a source-labelled Markdown result. */
export async function convertPdfToMarkdown(
  body: Uint8Array,
  sourceUrl: string,
): Promise<string> {
  const source = `> **Source**: ${sourceUrl}`;

  try {
    const parser = new PDFParse({ data: body });
    try {
      const result = await parser.getText();
      // pdf-parse's aggregate `text` includes generated page separators such
      // as "-- 1 of 1 --", even when every page contains no extractable
      // text. Build the output from the per-page payloads so parser metadata
      // cannot make an empty PDF look useful (and therefore cacheable).
      const text = result.pages
        .map((page) => page.text.trim())
        .filter(Boolean)
        .join('\n\n');
      return `${source}\n\n${text || '[No readable text could be extracted from this PDF.]'}`;
    } finally {
      await parser.destroy();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, sourceUrl }, 'PDF text extraction failed');
    return `${source}\n\n[PDF text extraction failed: ${message}]`;
  }
}

/**
 * A deliberately small admission check for the cheap path. It does not decide
 * how to clear a website blocker; it only recognizes results that are clearly
 * useful enough to cache and hands uncertain pages to the browser agent.
 */
function isUsefulStaticExtraction(
  markdown: string,
  html: string,
  isMirror: boolean,
): boolean {
  const body = markdown.replace(/^> \*\*Source\*\*:.*?(?:\r?\n){2}/, '').trim();
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (!normalized || /^\[No content could be retrieved/i.test(normalized)) {
    return false;
  }

  const lowerHtml = html.toLowerCase();
  if (
    /<dialog\b[^>]*\bopen\b/i.test(html) ||
    /\baria-modal\s*=\s*["']?true\b/i.test(html)
  ) {
    return false;
  }
  if (
    [
      'javascript is required',
      'enable javascript',
      'privacy related extensions may cause issues on x.com',
      'something went wrong, but don’t fret',
    ].some((indicator) => lowerHtml.includes(indicator))
  ) {
    return false;
  }

  // Mirrors often expose short but complete posts through OpenGraph metadata.
  if (isMirror) return normalized.length >= 20;

  const uncertainGate =
    /\b(?:cookies?|consent|privacy choices|optional tracking|personalized (?:ads?|advertising))\b/i.test(
      normalized,
    ) ||
    /\b(?:to continue(?: reading)?[,.:;]?\s*)?(?:subscribe(?: now)?|sign in|log in|create an account)\b/i.test(
      normalized,
    );
  if (uncertainGate && normalized.length < 2_000) return false;
  return normalized.length >= 200;
}

function convertToMarkdown(html: string, baseUrl: string): string {
  if (!html || html.trim().length === 0) {
    return `> **Source**: ${baseUrl}\n\n[No content could be retrieved from this URL.]`;
  }

  try {
    const { document } = parseHTML(html);
    if (!document) throw new Error('Failed to parse HTML');

    // Basic cleanup: remove ads, nav, footer if possible
    const selectorsToRemove = [
      'nav',
      'footer',
      'header',
      'aside',
      '.ads',
      '.sidebar',
      'script',
      'style',
      'iframe',
      'noscript',
    ];

    selectorsToRemove.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((el: any) => el.remove());
      } catch {
        /* ignore */
      }
    });

    // Hidden templates and fallback shells must not make an otherwise empty
    // extraction look useful.
    document
      .querySelectorAll('[hidden], [aria-hidden="true"]')
      .forEach((element: any) => element.remove());

    // Remove images with embedded data URLs to avoid huge context usage
    try {
      document.querySelectorAll('img').forEach((img: any) => {
        const src = img.getAttribute('src');
        if (src && src.startsWith('data:')) {
          img.remove();
        }
      });
    } catch {
      /* ignore */
    }

    // Extract main content if available, fallback to whole document if needed
    let contentNode: any;
    try {
      contentNode =
        document.querySelector('main') ||
        document.querySelector('article') ||
        document.body ||
        document.documentElement;
    } catch {
      contentNode = document.documentElement;
    }

    const innerHTML = contentNode?.innerHTML || html;
    let markdown = turndown.turndown(innerHTML).trim();

    // Strip any leftover base64 strings
    markdown = markdown.replace(
      /data:[a-zA-Z0-9/+\.-]+;base64,[a-zA-Z0-9/+=]+/g,
      '[Image Base64 Data]',
    );

    // If body extraction results in empty content, fallback to OpenGraph metadata
    // (Crucial for mirrors like fixupx/fxtwitter which serve content in meta tags for bots)
    if (!markdown) {
      const ogDesc =
        document
          .querySelector('meta[property="og:description"]')
          ?.getAttribute('content') ||
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute('content');
      if (ogDesc) {
        markdown = ogDesc;
        const ogTitle =
          document
            .querySelector('meta[property="og:title"]')
            ?.getAttribute('content') ||
          document.querySelector('title')?.textContent;
        if (ogTitle) {
          markdown = `### ${ogTitle}\n\n${markdown}`;
        }
      }
    }

    if (!markdown) {
      return `> **Source**: ${baseUrl}\n\n[No content could be retrieved from this URL.]`;
    }

    // Add source info
    markdown = `> **Source**: ${baseUrl}\n\n${markdown}`;

    return markdown;
  } catch (err) {
    logger.warn(
      { err, baseUrl },
      'Linkedom parsing failed, falling back to raw HTML conversion',
    );
    let md = turndown.turndown(html);
    md = md.replace(
      /data:[a-zA-Z0-9/+\.-]+;base64,[a-zA-Z0-9/+=]+/g,
      '[Image Base64 Data]',
    );
    return `> **Source**: ${baseUrl}\n\n${md}`;
  }
}
