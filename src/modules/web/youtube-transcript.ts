// Required Notice: Copyright Regun Software SRL (https://carapa.ai)

import { parseHTML } from 'linkedom';
import { escapeRegex } from '../../utils.js';

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
]);
const SHARE_GOOGLE_HOST = 'share.google';
const MAX_SHARED_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_FETCH_ATTEMPTS = 2;
const INNERTUBE_PLAYER_ENDPOINT = 'https://www.youtube.com/youtubei/v1/player';
const INNERTUBE_CLIENT_NAME = 'ANDROID';
const INNERTUBE_CLIENT_VERSION = '20.10.38';
const INNERTUBE_API_KEY_PATTERN =
  /"INNERTUBE_API_KEY"\s*:\s*"([A-Za-z0-9_-]+)"/;

type YouTubeFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

function requestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Web retrieval cancelled');
}

export interface YouTubeVideo {
  videoId: string;
  sourceUrl: string;
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  name?: {
    simpleText?: string;
    runs?: Array<{ text?: string }>;
  };
  kind?: string;
  isDefault?: boolean;
}

interface AudioTrack {
  captionTrackIndices?: number[];
  defaultCaptionTrackIndex?: number;
  hasDefaultTrack?: boolean;
}

interface PlayerResponse {
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  videoDetails?: {
    defaultAudioLanguage?: string;
  };
  microformat?: {
    playerMicroformatRenderer?: {
      audioLanguage?: string;
      defaultAudioLanguage?: string;
    };
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      audioTracks?: AudioTrack[];
      defaultAudioTrackIndex?: number;
    };
  };
}

export interface TranscriptSegment {
  text: string;
  offsetMs: number;
}

function validVideoId(value: string | null | undefined): string | null {
  return value && YOUTUBE_VIDEO_ID.test(value) ? value : null;
}

/** Normalize supported public YouTube video URLs to one canonical source URL. */
export function normalizeYouTubeVideoUrl(value: string): YouTubeVideo | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  let videoId: string | null = null;

  if (host === 'youtu.be') {
    videoId = validVideoId(url.pathname.split('/').filter(Boolean)[0]);
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === '/watch') {
      videoId = validVideoId(url.searchParams.get('v'));
    } else {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' || parts[0] === 'embed') {
        videoId = validVideoId(parts[1]);
      }
    }
  }

  if (!videoId) return null;
  return {
    videoId,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

function isSharedGoogleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.toLowerCase() === SHARE_GOOGLE_HOST
    );
  } catch {
    return false;
  }
}

function redirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Resolve share.google links with an explicit redirect cap before URL routing. */
export async function resolveSharedGoogleUrl(
  value: string,
  fetchImpl: YouTubeFetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  if (!isSharedGoogleUrl(value)) return value;

  let current = value;
  for (let redirectCount = 0; ; redirectCount += 1) {
    throwIfAborted(signal);
    let response: Response;
    try {
      response = await fetchImpl(current, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
        },
        redirect: 'manual',
        signal: requestSignal(signal),
      });
    } catch (error) {
      throwIfAborted(signal);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to resolve shared URL: ${reason}`);
    }

    if (!redirectStatus(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok && isSharedGoogleUrl(current)) {
        throw new Error(
          `Failed to resolve shared URL: upstream returned HTTP ${response.status}`,
        );
      }
      return current;
    }

    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location) {
      throw new Error('Failed to resolve shared URL: redirect had no location');
    }
    if (redirectCount >= MAX_SHARED_REDIRECTS) {
      throw new Error(
        `Failed to resolve shared URL: exceeded ${MAX_SHARED_REDIRECTS} redirects`,
      );
    }

    try {
      current = new URL(location, current).toString();
    } catch {
      throw new Error('Failed to resolve shared URL: redirect was invalid');
    }
  }
}

function responseIsRetryable(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

async function fetchWithBounds(
  url: string,
  init: RequestInit,
  fetchImpl: YouTubeFetch,
  signal?: AbortSignal,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: requestSignal(signal),
      });
      if (!responseIsRetryable(response) || attempt === MAX_FETCH_ATTEMPTS) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      throwIfAborted(signal);
      lastError = error;
      if (attempt === MAX_FETCH_ATTEMPTS) break;
    }
  }

  const reason =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`YouTube upstream request failed: ${reason}`);
}

function extractAssignedJson(html: string, variableName: string): unknown {
  const assignment = new RegExp(
    `(?:var\\s+)?${escapeRegex(variableName)}\\s*=`,
  ).exec(html);
  if (!assignment) return null;

  const start = html.indexOf('{', assignment.index + assignment[0].length);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function captionTrackName(track: CaptionTrack): string {
  return (
    track.name?.simpleText ||
    track.name?.runs?.map((run) => run.text || '').join('') ||
    track.languageCode ||
    'unknown'
  );
}

function itemAtIndex<T>(items: T[], index: number | undefined): T | null {
  return Number.isInteger(index) && index !== undefined && items[index]
    ? items[index]
    : null;
}

/**
 * Prefer YouTube's default audio/caption metadata, then original-language
 * metadata. When neither is present, YouTube's stable caption-track order is
 * the deterministic fallback; tracks are never combined or translated.
 */
function selectCaptionTrack(
  player: PlayerResponse,
  tracks: CaptionTrack[],
): CaptionTrack {
  const tracklist = player.captions?.playerCaptionsTracklistRenderer;
  const audioTracks = tracklist?.audioTracks || [];
  const defaultAudio =
    itemAtIndex(audioTracks, tracklist?.defaultAudioTrackIndex) ||
    audioTracks.find((track) => track.hasDefaultTrack);
  const defaultTrack = itemAtIndex(
    tracks,
    defaultAudio?.defaultCaptionTrackIndex,
  );
  if (defaultTrack) return defaultTrack;

  if (defaultAudio?.captionTrackIndices) {
    for (const index of defaultAudio.captionTrackIndices) {
      const track = itemAtIndex(tracks, index);
      if (track) return track;
    }
  }

  const explicitlyDefault = tracks.find((track) => track.isDefault);
  if (explicitlyDefault) return explicitlyDefault;

  const microformat = player.microformat?.playerMicroformatRenderer;
  const originalLanguage =
    player.videoDetails?.defaultAudioLanguage ||
    microformat?.defaultAudioLanguage ||
    microformat?.audioLanguage;
  const originalTrack = tracks.find(
    (track) => track.languageCode === originalLanguage,
  );
  return originalTrack || tracks[0];
}

function decodeCaptionText(value: string): string {
  const { document } = parseHTML(`<html><body>${value}</body></html>`);
  return (document.body?.textContent || '')
    .replace(/\u200b/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function parseJson3Transcript(payload: unknown): TranscriptSegment[] {
  if (!payload || typeof payload !== 'object') return [];
  const events = (payload as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];

  return events.flatMap((event): TranscriptSegment[] => {
    if (!event || typeof event !== 'object') return [];
    const typed = event as {
      tStartMs?: number;
      segs?: Array<{ utf8?: string }>;
    };
    if (!Array.isArray(typed.segs)) return [];
    const text = decodeCaptionText(
      typed.segs.map((segment) => segment.utf8 || '').join(''),
    );
    return text ? [{ text, offsetMs: Number(typed.tStartMs) || 0 }] : [];
  });
}

function xmlAttribute(attributes: string, name: string): number | null {
  const match = new RegExp(`\\b${name}="([^"]+)"`).exec(attributes);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseXmlTranscript(payload: string): TranscriptSegment[] {
  return [...payload.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)]
    .map((match): TranscriptSegment | null => {
      const seconds = xmlAttribute(match[1], 'start');
      const milliseconds = xmlAttribute(match[1], 't');
      const text = decodeCaptionText(match[2]);
      if (!text) return null;
      return {
        text,
        offsetMs: seconds !== null ? seconds * 1000 : milliseconds || 0,
      };
    })
    .filter((segment): segment is TranscriptSegment => segment !== null);
}

/** Convert YouTube JSON3 or XML timed-text payloads into ordered plain cues. */
export function captionPayloadToSegments(payload: string): TranscriptSegment[] {
  let segments: TranscriptSegment[] = [];
  try {
    segments = parseJson3Transcript(JSON.parse(payload));
  } catch {
    segments = parseXmlTranscript(payload);
  }
  return segments
    .map((segment, index) => ({ segment, index }))
    .sort(
      (left, right) =>
        left.segment.offsetMs - right.segment.offsetMs ||
        left.index - right.index,
    )
    .map(({ segment }) => segment);
}

function youtubeHttpFailure(response: Response): string {
  if (response.status === 429) return 'upstream rate limit (HTTP 429)';
  if (response.status === 403) return 'upstream access was denied (HTTP 403)';
  if (response.status === 404) return 'video was not found (HTTP 404)';
  return `upstream request failed (HTTP ${response.status})`;
}

function unavailable(video: YouTubeVideo, reason: string): Error {
  return new Error(
    `YouTube transcript unavailable for ${video.sourceUrl}: ${reason}`,
  );
}

/**
 * Watch-page caption URLs now require a PO token and return empty bodies. The
 * InnerTube Android player response returns caption URLs that do not. Returns
 * null when that response cannot supply caption tracks, so the caller keeps the
 * watch-page player.
 */
async function fetchInnertubeCaptionPlayer(
  video: YouTubeVideo,
  watchHtml: string,
  fetchImpl: YouTubeFetch,
  signal?: AbortSignal,
): Promise<PlayerResponse | null> {
  const apiKey = INNERTUBE_API_KEY_PATTERN.exec(watchHtml)?.[1];
  if (!apiKey) return null;

  try {
    const response = await fetchWithBounds(
      `${INNERTUBE_PLAYER_ENDPOINT}?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            client: {
              clientName: INNERTUBE_CLIENT_NAME,
              clientVersion: INNERTUBE_CLIENT_VERSION,
            },
          },
          videoId: video.videoId,
        }),
      },
      fetchImpl,
      signal,
    );
    if (!response.ok) return null;

    const player = (await response.json()) as PlayerResponse | null;
    const tracks =
      player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return player?.playabilityStatus?.status === 'OK' && tracks.length > 0
      ? player
      : null;
  } catch {
    throwIfAborted(signal);
    return null;
  }
}

/** Retrieve one selected public YouTube caption track as source-labelled Markdown. */
export async function retrieveYouTubeTranscript(
  video: YouTubeVideo,
  fetchImpl: YouTubeFetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  let watchResponse: Response;
  try {
    watchResponse = await fetchWithBounds(
      video.sourceUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
        },
      },
      fetchImpl,
      signal,
    );
  } catch (error) {
    throwIfAborted(signal);
    throw unavailable(
      video,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!watchResponse.ok) {
    throw unavailable(video, youtubeHttpFailure(watchResponse));
  }

  const watchHtml = await watchResponse.text();
  if (
    /class=["']g-recaptcha/i.test(watchHtml) ||
    /sign in to confirm (?:you(?:'|’)re|you're) not a bot/i.test(watchHtml)
  ) {
    throw unavailable(video, 'upstream access challenge prevented retrieval');
  }

  const player = extractAssignedJson(
    watchHtml,
    'ytInitialPlayerResponse',
  ) as PlayerResponse | null;
  if (!player) {
    throw unavailable(video, 'YouTube did not expose caption metadata');
  }

  const playability = player.playabilityStatus;
  if (playability?.status && playability.status !== 'OK') {
    const detail = playability.reason
      ? `${playability.status}: ${playability.reason}`
      : playability.status;
    throw unavailable(video, `video is unavailable (${detail})`);
  }

  const captionPlayer =
    (await fetchInnertubeCaptionPlayer(video, watchHtml, fetchImpl, signal)) ??
    player;
  const tracks =
    captionPlayer.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
    [];
  if (tracks.length === 0) {
    throw unavailable(video, 'captions are disabled or missing');
  }

  const selected = selectCaptionTrack(captionPlayer, tracks);
  if (!selected.baseUrl) {
    throw unavailable(video, 'selected caption track has no public URL');
  }

  let transcriptUrl: URL;
  try {
    transcriptUrl = new URL(selected.baseUrl);
  } catch {
    throw unavailable(video, 'selected caption track URL was invalid');
  }
  transcriptUrl.searchParams.delete('tlang');
  transcriptUrl.searchParams.set('fmt', 'json3');

  let captionResponse: Response;
  try {
    captionResponse = await fetchWithBounds(
      transcriptUrl.toString(),
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
      fetchImpl,
      signal,
    );
  } catch (error) {
    throwIfAborted(signal);
    throw unavailable(
      video,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!captionResponse.ok) {
    throw unavailable(video, youtubeHttpFailure(captionResponse));
  }

  const captionBody = await captionResponse.text();
  if (!captionBody.trim()) {
    throw unavailable(
      video,
      'caption endpoint returned an empty body (YouTube may require a PO token)',
    );
  }

  const segments = captionPayloadToSegments(captionBody);
  if (segments.length === 0) {
    throw unavailable(video, 'selected caption track contained no transcript');
  }

  const languageCode = selected.languageCode || 'unknown';
  const languageName = captionTrackName(selected);
  const generated = selected.kind === 'asr' ? ' (automatically generated)' : '';
  const text = segments.map((segment) => segment.text).join('\n');

  return [
    '# YouTube transcript',
    '',
    `> **Source**: ${video.sourceUrl}`,
    `> **Caption language**: ${languageName} (${languageCode})${generated}`,
    '',
    text,
  ].join('\n');
}
