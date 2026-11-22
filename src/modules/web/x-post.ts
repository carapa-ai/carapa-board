// Required Notice: Copyright Regun Software SRL (https://carapa.ai)

import { isRecord } from '../../lib/type-guards.js';
import { logger, serializeError } from '../../logger.js';
import type { WebFetch } from './url-guard.js';

const X_HOSTS = new Set(
  ['x.com', 'twitter.com', 'fxtwitter.com', 'fixupx.com'].flatMap((host) => [
    host,
    `www.${host}`,
    `mobile.${host}`,
  ]),
);
X_HOSTS.add('api.fxtwitter.com');

const STATUS_PATH = /^\/(?:[^/]+\/)?status\/(\d+)(?:\/|$)/;
const API_ORIGIN = 'https://api.fxtwitter.com';
const API_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Returns the tweet id when the URL is an X/Twitter status URL. */
export function parseXStatusId(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    if (!X_HOSTS.has(url.hostname.toLowerCase())) return null;
    return STATUS_PATH.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function applyInlineStyles(text: string, block: JsonObject): string {
  const marks: Array<{ at: number; order: number; mark: string }> = [];
  for (const range of asArray(block.inlineStyleRanges)) {
    if (!isRecord(range)) continue;
    const { offset, length, style } = range;
    const mark = style === 'Bold' ? '**' : style === 'Italic' ? '*' : null;
    if (
      !mark ||
      typeof offset !== 'number' ||
      typeof length !== 'number' ||
      length <= 0 ||
      offset < 0 ||
      offset + length > text.length
    ) {
      continue;
    }
    marks.push({ at: offset, order: 0, mark });
    marks.push({ at: offset + length, order: 1, mark });
  }
  // Insert from the end so earlier offsets stay valid.
  marks.sort((a, b) => b.at - a.at || a.order - b.order);
  let out = text;
  for (const { at, mark } of marks) {
    out = out.slice(0, at) + mark + out.slice(at);
  }
  return out;
}

function renderMedia(
  entityData: unknown,
  mediaEntities: unknown[],
): string | null {
  if (!isRecord(entityData)) return null;
  const first = asArray(entityData.mediaItems)[0];
  const mediaId = isRecord(first) ? first.mediaId : undefined;
  if (mediaId === undefined) return null;
  const media = mediaEntities.find(
    (m) => isRecord(m) && String(m.media_id) === String(mediaId),
  );
  if (!isRecord(media) || !isRecord(media.media_info)) return null;
  const info = media.media_info;
  if (info.__typename === 'ApiImage') {
    const src = str(info.original_img_url);
    return src ? `![](${src})` : null;
  }
  const videoUrl =
    str(info.url) ??
    str(info.original_url) ??
    asArray(info.variants)
      .map((v) => (isRecord(v) ? str(v.url) : undefined))
      .find(Boolean);
  return videoUrl ? `[video](${videoUrl})` : null;
}

function renderEntity(entry: unknown, mediaEntities: unknown[]): string | null {
  if (!isRecord(entry) || !isRecord(entry.value)) return null;
  const { type, data } = entry.value;
  if (type === 'MEDIA') return renderMedia(data, mediaEntities);
  if (type === 'MARKDOWN') {
    return isRecord(data) ? (str(data.markdown) ?? null) : null;
  }
  if (type === 'TWEET') {
    const tweetId = isRecord(data) ? str(data.tweetId) : undefined;
    return tweetId
      ? `[Embedded post](https://x.com/i/status/${tweetId})`
      : null;
  }
  return null;
}

function renderArticle(article: JsonObject): string {
  const parts: string[] = [];
  const title = str(article.title);
  if (title) parts.push(`# ${title}`);

  const cover = isRecord(article.cover_media) ? article.cover_media : null;
  const coverInfo =
    cover && isRecord(cover.media_info) ? cover.media_info : null;
  const coverUrl = coverInfo ? str(coverInfo.original_img_url) : undefined;
  if (coverUrl) parts.push(`![](${coverUrl})`);

  const content = isRecord(article.content) ? article.content : {};
  const entityMap = asArray(content.entityMap);
  const mediaEntities = asArray(article.media_entities);

  let previousWasList = false;
  for (const raw of asArray(content.blocks)) {
    if (!isRecord(raw)) continue;
    const type = str(raw.type) ?? 'unstyled';
    const text = typeof raw.text === 'string' ? raw.text : '';

    let rendered: string | null = null;
    let isList = false;
    if (type === 'atomic') {
      const items: string[] = [];
      for (const range of asArray(raw.entityRanges)) {
        if (!isRecord(range)) continue;
        const entry = entityMap.find(
          (e) => isRecord(e) && e.key === String(range.key),
        );
        const item = renderEntity(entry, mediaEntities);
        if (item) items.push(item);
      }
      rendered = items.length ? items.join('\n\n') : null;
    } else if (text.trim()) {
      const styled = applyInlineStyles(text, raw);
      if (type === 'header-one') rendered = `## ${styled}`;
      else if (type === 'header-two') rendered = `### ${styled}`;
      else if (type === 'blockquote') rendered = `> ${styled}`;
      else if (type === 'ordered-list-item') {
        rendered = `1. ${styled}`;
        isList = true;
      } else if (type === 'unordered-list-item') {
        rendered = `- ${styled}`;
        isList = true;
      } else rendered = styled;
    }
    if (rendered === null) continue;

    if (isList && previousWasList) {
      parts[parts.length - 1] += `\n${rendered}`;
    } else {
      parts.push(rendered);
    }
    previousWasList = isList;
  }
  return parts.join('\n\n');
}

function renderTweet(tweet: JsonObject, sourceUrl: string): string | null {
  const text = typeof tweet.text === 'string' ? tweet.text : undefined;
  const article = isRecord(tweet.article) ? tweet.article : null;
  if (text === undefined && !article) return null;

  const author = isRecord(tweet.author) ? tweet.author : {};
  const name = str(author.name);
  const handle = str(author.screen_name);
  const byline = [
    name && handle
      ? `**${name}** (@${handle})`
      : name || (handle && `@${handle}`),
    str(tweet.created_at),
    str(tweet.url) && `[Link](${tweet.url})`,
  ].filter(Boolean);

  const parts = [`> **Source**: ${sourceUrl}`];
  if (byline.length) parts.push(byline.join(' · '));
  if (text?.trim()) parts.push(text.trim());

  const media = isRecord(tweet.media) ? tweet.media : {};
  for (const photo of asArray(media.photos)) {
    const src = isRecord(photo) ? str(photo.url) : undefined;
    if (src) parts.push(`![](${src})`);
  }

  if (article) {
    const rendered = renderArticle(article);
    if (rendered) parts.push(rendered);
  }
  return parts.join('\n\n');
}

/**
 * Fetches an X/Twitter post through the fxtwitter JSON API and renders it as
 * Markdown. Returns null when the URL is not an X status URL or the API
 * response is unusable or times out, so the caller can fall back to the mirror
 * path. `signal` is the caller's own signal: only its abort is rethrown.
 */
export async function retrieveXPost(
  url: string,
  fetchFn: WebFetch,
  signal?: AbortSignal,
): Promise<string | null> {
  const tweetId = parseXStatusId(url);
  if (!tweetId) return null;

  const apiUrl = `${API_ORIGIN}/status/${tweetId}`;
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetchFn(apiUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'carapa-board' },
      signal: requestSignal,
    });
    if (!res.ok) {
      logger.debug({ apiUrl, status: res.status }, 'X post API non-200');
      return null;
    }
    const json: unknown = await res.json();
    const tweet = isRecord(json) ? json.tweet : undefined;
    if (!isRecord(tweet)) {
      logger.debug({ apiUrl }, 'X post API shape mismatch');
      return null;
    }
    const markdown = renderTweet(tweet, url);
    if (!markdown) logger.debug({ apiUrl }, 'X post API shape mismatch');
    return markdown;
  } catch (err) {
    if (signal?.aborted) throw err;
    logger.debug({ apiUrl, error: serializeError(err) }, 'X post API failed');
    return null;
  }
}
