import { describe, expect, test } from 'bun:test';
import {
  captionPayloadToSegments,
  normalizeYouTubeVideoUrl,
  resolveSharedGoogleUrl,
  retrieveYouTubeTranscript,
  type YouTubeVideo,
} from './youtube-transcript.js';

const VIDEO_ID = 'AbCdEfGhI_1';
const VIDEO: YouTubeVideo = {
  videoId: VIDEO_ID,
  sourceUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
};

function playerPage(player: object, innertubeApiKey?: string): string {
  const apiKey = innertubeApiKey
    ? `<script>var ytcfg = {"INNERTUBE_API_KEY":"${innertubeApiKey}"};</script>`
    : '';
  return `<html>${apiKey}<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></html>`;
}

const INNERTUBE_PLAYER_URL =
  'https://www.youtube.com/youtubei/v1/player?key=test-key';

describe('YouTube video URL normalization', () => {
  const supported = [
    `https://youtube.com/watch?v=${VIDEO_ID}&t=42s&list=ignored`,
    `https://youtu.be/${VIDEO_ID}?t=1`,
    `https://www.youtube.com/shorts/${VIDEO_ID}?feature=share`,
    `https://youtube.com/embed/${VIDEO_ID}?start=30`,
  ];

  for (const url of supported) {
    test(`recognizes ${url}`, () => {
      expect(normalizeYouTubeVideoUrl(url)).toEqual(VIDEO);
    });
  }

  const generic = [
    `https://youtube.example/watch?v=${VIDEO_ID}`,
    `https://notyoutube.com/watch?v=${VIDEO_ID}`,
    `https://www.youtube.com/watch?list=PL123`,
  ];

  for (const url of generic) {
    test(`leaves ${url} on the generic path`, () => {
      expect(normalizeYouTubeVideoUrl(url)).toBeNull();
    });
  }
});

describe('YouTube caption conversion and selection', () => {
  const payloads = [
    {
      name: 'JSON3',
      payload: JSON.stringify({
        events: [
          { tStartMs: 2_000, segs: [{ utf8: 'Second &amp; <c>clear</c>' }] },
          { tStartMs: 1_000, segs: [{ utf8: 'First' }] },
          { tStartMs: 3_000 },
        ],
      }),
      second: 'Second & clear',
    },
    {
      name: 'XML',
      payload:
        '<transcript><text start="2.0" dur="1">Second &amp; &lt;clear&gt;</text><text start="1.0" dur="1"><font color="#fff">First</font></text></transcript>',
      second: 'Second & <clear>',
    },
  ];

  for (const fixture of payloads) {
    test(`decodes markup and preserves playback order for ${fixture.name}`, () => {
      expect(captionPayloadToSegments(fixture.payload)).toEqual([
        { text: 'First', offsetMs: 1_000 },
        { text: fixture.second, offsetMs: 2_000 },
      ]);
    });
  }

  test('uses default-caption metadata and returns one labelled track', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === VIDEO.sourceUrl) {
        return new Response(
          playerPage({
            playabilityStatus: { status: 'OK' },
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  {
                    baseUrl: 'https://captions.test/en',
                    languageCode: 'en',
                    name: { simpleText: 'English' },
                  },
                  {
                    baseUrl:
                      'https://captions.test/es?existing=1&tlang=translated',
                    languageCode: 'es',
                    name: { simpleText: 'Español' },
                    kind: 'asr',
                  },
                ],
                audioTracks: [
                  { captionTrackIndices: [1], defaultCaptionTrackIndex: 1 },
                ],
                defaultAudioTrackIndex: 0,
              },
            },
          }),
        );
      }
      if (url === 'https://captions.test/es?existing=1&fmt=json3') {
        return Response.json({
          events: [
            { tStartMs: 1_000, segs: [{ utf8: 'Hola &amp; <c>bien</c>' }] },
            { tStartMs: 2_000, segs: [{ utf8: 'Adiós' }] },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const markdown = await retrieveYouTubeTranscript(VIDEO, fetchImpl);

    expect(requestedUrls).toEqual([
      VIDEO.sourceUrl,
      'https://captions.test/es?existing=1&fmt=json3',
    ]);
    expect(markdown).toContain(`> **Source**: ${VIDEO.sourceUrl}`);
    expect(markdown).toContain(
      '> **Caption language**: Español (es) (automatically generated)',
    );
    expect(markdown).toContain('Hola & bien\nAdiós');
    expect(markdown).not.toContain('https://captions.test/en');
  });

  test('uses original-language metadata, then track order as the documented fallback', async () => {
    for (const originalLanguage of ['de', undefined]) {
      const fetchedCaptions: string[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === VIDEO.sourceUrl) {
          return new Response(
            playerPage({
              playabilityStatus: { status: 'OK' },
              microformat: {
                playerMicroformatRenderer: { audioLanguage: originalLanguage },
              },
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [
                    {
                      baseUrl: 'https://captions.test/fr',
                      languageCode: 'fr',
                      name: { simpleText: 'Français' },
                    },
                    {
                      baseUrl: 'https://captions.test/de',
                      languageCode: 'de',
                      name: { simpleText: 'Deutsch' },
                    },
                  ],
                },
              },
            }),
          );
        }
        fetchedCaptions.push(url);
        return Response.json({
          events: [{ tStartMs: 0, segs: [{ utf8: 'Caption' }] }],
        });
      }) as unknown as typeof fetch;

      await retrieveYouTubeTranscript(VIDEO, fetchImpl);
      expect(fetchedCaptions).toEqual([
        originalLanguage === 'de'
          ? 'https://captions.test/de?fmt=json3'
          : 'https://captions.test/fr?fmt=json3',
      ]);
    }
  });
});

describe('YouTube InnerTube caption retrieval', () => {
  const webTrackPlayer = {
    playabilityStatus: { status: 'OK' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: 'https://captions.test/web-en?exp=xpe',
            languageCode: 'en',
            name: { simpleText: 'English' },
          },
        ],
      },
    },
  };

  test('prefers InnerTube caption tracks when watch-page URLs need a PO token', async () => {
    const requestedUrls: string[] = [];
    let innertubeRequest: { method?: string; body?: unknown } = {};
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === VIDEO.sourceUrl) {
        return new Response(playerPage(webTrackPlayer, 'test-key'));
      }
      if (url === INNERTUBE_PLAYER_URL) {
        innertubeRequest = {
          method: init?.method,
          body: JSON.parse(String(init?.body)),
        };
        return Response.json({
          playabilityStatus: { status: 'OK' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl:
                    'https://captions.test/innertube-en?lang=en&fmt=srv3',
                  languageCode: 'en',
                  name: { simpleText: 'English' },
                },
              ],
            },
          },
        });
      }
      if (url === 'https://captions.test/innertube-en?lang=en&fmt=json3') {
        return Response.json({
          events: [{ tStartMs: 0, segs: [{ utf8: 'We are no strangers' }] }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const markdown = await retrieveYouTubeTranscript(VIDEO, fetchImpl);

    expect(innertubeRequest).toEqual({
      method: 'POST',
      body: {
        context: {
          client: { clientName: 'ANDROID', clientVersion: '20.10.38' },
        },
        videoId: VIDEO_ID,
      },
    });
    expect(requestedUrls).toEqual([
      VIDEO.sourceUrl,
      INNERTUBE_PLAYER_URL,
      'https://captions.test/innertube-en?lang=en&fmt=json3',
    ]);
    expect(markdown).toContain('We are no strangers');
  });

  test('falls back to watch-page tracks when the InnerTube call fails or has no tracks', async () => {
    const innertubeOutcomes: Array<() => Promise<Response>> = [
      () => Promise.reject(new Error('network down')),
      () =>
        Promise.resolve(
          Response.json({ playabilityStatus: { status: 'OK' }, captions: {} }),
        ),
    ];

    for (const innertubeOutcome of innertubeOutcomes) {
      const requestedUrls: string[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url === VIDEO.sourceUrl) {
          return new Response(playerPage(webTrackPlayer, 'test-key'));
        }
        if (url === INNERTUBE_PLAYER_URL) return innertubeOutcome();
        if (url === 'https://captions.test/web-en?exp=xpe&fmt=json3') {
          return Response.json({
            events: [{ tStartMs: 0, segs: [{ utf8: 'Web caption' }] }],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;

      const markdown = await retrieveYouTubeTranscript(VIDEO, fetchImpl);

      expect(requestedUrls.at(-1)).toBe(
        'https://captions.test/web-en?exp=xpe&fmt=json3',
      );
      expect(markdown).toContain('Web caption');
    }
  });

  test('reports an empty caption body as a PO-token requirement', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === VIDEO.sourceUrl) {
        return new Response(playerPage(webTrackPlayer));
      }
      if (url === 'https://captions.test/web-en?exp=xpe&fmt=json3') {
        return new Response('');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    await expect(retrieveYouTubeTranscript(VIDEO, fetchImpl)).rejects.toThrow(
      'caption endpoint returned an empty body (YouTube may require a PO token)',
    );
  });
});

describe('shared-link redirect resolution', () => {
  test('follows a bounded redirect chain to its destination', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://share.google/example') {
        return new Response(null, {
          status: 302,
          headers: { location: '/second' },
        });
      }
      if (url === 'https://share.google/second') {
        return new Response(null, {
          status: 301,
          headers: { location: `https://youtu.be/${VIDEO_ID}?t=3` },
        });
      }
      return new Response('destination');
    }) as unknown as typeof fetch;

    expect(
      await resolveSharedGoogleUrl('https://share.google/example', fetchImpl),
    ).toBe(`https://youtu.be/${VIDEO_ID}?t=3`);
    expect(calls).toEqual([
      'https://share.google/example',
      'https://share.google/second',
      `https://youtu.be/${VIDEO_ID}?t=3`,
    ]);
  });

  test('rejects redirect chains longer than five hops', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://share.google/hop-${calls}` },
      });
    }) as unknown as typeof fetch;

    await expect(
      resolveSharedGoogleUrl('https://share.google/start', fetchImpl),
    ).rejects.toThrow('exceeded 5 redirects');
    expect(calls).toBe(6);
  });
});
