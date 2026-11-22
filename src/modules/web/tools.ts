// Required Notice: Copyright Regun Software SRL (https://carapa.ai)

import { z } from 'zod';
import { WEB_VIEW_MAX_CHARS } from '../../config.js';
import { logger } from '../../logger.js';
import { wrapUntrustedWebContent } from './content-safety.js';
import { fetchImage } from './fetch-image.js';
import { webSearchDetailed, webView } from './proxy.js';
import type { ToolDefinition } from '../tools/types.js';

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff;

/**
 * Bounds of the chunk that starts at `offset`. Boundaries never split a
 * surrogate pair: a start inside a pair moves forward, an end inside a pair
 * moves back, so consecutive chunks concatenate to the original text.
 */
function webViewChunkBounds(
  content: string,
  offset: number,
): { start: number; end: number } {
  let start = offset;
  if (
    start > 0 &&
    isHighSurrogate(content.charCodeAt(start - 1)) &&
    isLowSurrogate(content.charCodeAt(start))
  ) {
    start += 1;
  }
  let end = Math.min(start + WEB_VIEW_MAX_CHARS, content.length);
  if (
    end < content.length &&
    isHighSurrogate(content.charCodeAt(end - 1)) &&
    isLowSurrogate(content.charCodeAt(end))
  ) {
    end -= 1;
  }
  return { start, end };
}

const formatSearchResult = (r: {
  title: string;
  url: string;
  content: string;
}) => `### ${r.title}\nURL: ${r.url}\n${r.content}`;

export const web_search: ToolDefinition = {
  name: 'web_search',
  privacyPurpose: 'web',
  description:
    'Search the web for current information using SearXNG, falling back to Google-grounded Gemini when SearXNG has no results. Returns titles, URLs, and brief content snippets.',
  inputSchema: {
    query: z.string().describe('The search query'),
  },
  async handler({ query }: { query: string }, _deps, context) {
    const { results, unresponsiveEngines, grounded } =
      await webSearchDetailed(query);
    if (grounded) {
      const blocks = results.map(formatSearchResult);
      if (grounded.summary) blocks.unshift(`### Summary\n${grounded.summary}`);
      return wrapUntrustedWebContent({
        tool: 'web_search',
        source: 'web_search',
        content: `Source: Google-grounded Gemini\n\n${blocks.join('\n\n---\n\n')}`,
        projectId: context?.group_folder,
        signal: context?.signal,
      });
    }
    if (results.length === 0) {
      if (unresponsiveEngines.length === 0) return 'No results found.';
      logger.warn(
        { unresponsiveEngines, queryLength: query.length },
        'Web search returned no results with unresponsive engines',
      );
      const detail = unresponsiveEngines
        .map((e) => `${e.engine}: ${e.reason}`)
        .join('; ');
      return `Search failed: no engine answered (${detail}). This is an engine outage, not proof that nothing exists. Retry later or use web_view on a known URL.`;
    }

    return wrapUntrustedWebContent({
      tool: 'web_search',
      source: 'web_search',
      content: results.map(formatSearchResult).join('\n\n---\n\n'),
      projectId: context?.group_folder,
      signal: context?.signal,
    });
  },
};

export function createWebViewTool(
  view: typeof webView = webView,
): ToolDefinition {
  return {
    name: 'web_view',
    privacyPurpose: 'web',
    // Browser-agent fallback owns its configurable deadline and follows the
    // parent signal; the ordinary short MCP tool timeout must not cut it off.
    mcpTimeoutMs: null,
    description: `Fetch the content of a specific URL and return it as Markdown, in chunks of about ${WEB_VIEW_MAX_CHARS} characters. When a page is longer than one chunk, the line after the content names the next offset (for example "next: offset=${WEB_VIEW_MAX_CHARS}"); pass that value as \`offset\` to read the next chunk. A refetch after about 30 minutes may return different content, so chunks from separate calls may not line up. Useful for reading articles or documentation. Supports JavaScript-heavy sites and retrieves public captions for supported YouTube video links. X/Twitter posts and articles are returned as Markdown.`,
    inputSchema: {
      url: z.string().describe('The URL to view'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Character offset to start the chunk at; use the "next: offset=" value from the previous chunk. Omit to start at the beginning.',
        ),
    },
    async handler(
      { url, offset = 0 }: { url: string; offset?: number },
      _deps,
      context,
    ) {
      const content = await view(url, {}, context);
      const { start, end } = webViewChunkBounds(content, offset);
      if (offset > 0 && start >= content.length) {
        return `web_view: offset ${offset} is beyond the end of this page (${content.length} characters total).`;
      }
      const wrapped = await wrapUntrustedWebContent({
        tool: 'web_view',
        source: url,
        content: content.slice(start, end),
        projectId: context?.group_folder,
        signal: context?.signal,
      });
      if (start === 0 && end === content.length) return wrapped;
      // Outside the envelope so page text cannot forge or alter the paging line.
      const next = end < content.length ? `; next: offset=${end}` : '';
      return `${wrapped}\n[web_view: chars ${start}-${end} of ${content.length}${next}]`;
    },
  };
}

export const web_view = createWebViewTool();

export const web_fetch_image: ToolDefinition = {
  name: 'web_fetch_image',
  privacyPurpose: 'web',
  description:
    'Download a public PNG, JPEG, WebP or GIF image (max 10 MB) from a URL and save it under the project artifacts/web-images folder. Returns the container path to open with your file viewer. Use it for image links found via web_view.',
  inputSchema: {
    url: z.string().describe('The public http(s) image URL'),
  },
  requiredPermissions: ['images:fetch'],
  mcpTimeoutMs: 90_000,
  async handler({ url }: { url: string }, _deps, context) {
    return fetchImage(url, context);
  },
};
