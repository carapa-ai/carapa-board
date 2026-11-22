import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch, writeFile } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    convertFileSrc: (uri: string) => `native:${uri}`,
  },
}));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: {
    stat: vi.fn(async () => {
      throw new Error('not persisted');
    }),
    getUri: vi.fn(),
    writeFile,
  },
}));
vi.mock('@/lib/api-config', () => ({ resolveApiUrl: (url: string) => url }));
vi.mock('@/lib/api', () => ({
  apiFetch,
  getNativeBinaryDataUrl: (response: { nativeUrl?: string }) =>
    response.nativeUrl
      ? {
          url: response.nativeUrl,
          base64: 'aW1hZ2U=',
          byteLength: 5,
          contentType: 'image/jpeg',
        }
      : null,
}));

import { SecureImage } from './secure-image';

describe('mounted native persona images', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    writeFile.mockReset();
    writeFile.mockImplementation(async ({ path }: { path: string }) => ({
      uri: `cache://${path}`,
    }));
    localStorage.removeItem('secure-media-native-identity-index-v1');
  });

  it('validates persisted identity fallbacks and recovers evicted files', async () => {
    localStorage.setItem(
      'secure-media-native-identity-index-v1',
      JSON.stringify({
        'https://board.test:restart-persona:avatar': {
          version: '7',
          sourceUrl:
            'https://board.test/api/ai-users/restart-persona/avatar?thumbnail=1&v=7',
          entry: {
            secureUrl: 'native:cache://persisted-avatar.jpg',
            byteLength: 12,
          },
        },
        'https://remote.test:restart-persona:avatar': {
          version: '7',
          sourceUrl:
            'https://remote.test/api/ai-users/restart-persona/avatar?thumbnail=1&v=7',
          entry: {
            secureUrl: 'native:cache://remote-avatar.jpg',
            byteLength: 12,
          },
        },
      }),
    );
    apiFetch.mockResolvedValue({
      ok: true,
      nativeUrl: 'data:recovered-avatar',
      status: 200,
      statusText: 'OK',
    });
    const streaming = render(
      <SecureImage
        data-ui="restart-streaming-avatar"
        src="https://board.test/api/ai-users/restart-persona/avatar?thumbnail=1"
        alt="Persona avatar"
      />,
    );
    const image = streaming.container.querySelector('img')!;
    expect(image.src).toBe('native:cache://persisted-avatar.jpg');
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const remote = render(
      <SecureImage
        data-ui="remote-streaming-avatar"
        src="https://remote.test/api/ai-users/restart-persona/avatar?thumbnail=1"
        alt="Persona avatar"
      />,
    );
    expect(remote.container.querySelector('img')!.src).toBe(
      'native:cache://remote-avatar.jpg',
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    streaming.unmount();
    remote.unmount();
  });

  it('refetches an initially persisted candidate after its first decode failure', async () => {
    const source =
      'https://board.test/api/ai-users/evicted-persona/avatar?thumbnail=1&v=7';
    localStorage.setItem(
      'secure-media-native-identity-index-v1',
      JSON.stringify({
        'https://board.test:evicted-persona:avatar': {
          version: '7',
          sourceUrl: source,
          entry: {
            secureUrl: 'native:cache://evicted-avatar.jpg',
            byteLength: 12,
          },
        },
      }),
    );
    apiFetch.mockResolvedValue({
      ok: true,
      nativeUrl: 'data:recovered-avatar',
      status: 200,
      statusText: 'OK',
    });
    const view = render(<SecureImage src={source} alt="Persona avatar" />);
    const image = view.container.querySelector('img')!;
    const failedUrl = image.src;
    expect(failedUrl).toContain('native:cache://');
    fireEvent.error(image);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(image.src).not.toBe(failedUrl));
    fireEvent.load(image);
    expect(image.style.visibility).not.toBe('hidden');
    view.unmount();
  });

  it('quarantines the persisted version behind an unversioned streaming request', async () => {
    const source =
      'https://board.test/api/ai-users/stream-persona/avatar?thumbnail=1';
    const persistedSource = `${source}&v=9`;
    localStorage.setItem(
      'secure-media-native-identity-index-v1',
      JSON.stringify({
        'https://board.test:stream-persona:avatar': {
          version: '9',
          sourceUrl: persistedSource,
          entry: {
            secureUrl: 'native:cache://stream-avatar.jpg',
            byteLength: 12,
          },
        },
      }),
    );
    apiFetch.mockResolvedValue({
      ok: true,
      nativeUrl: 'data:stream-recovered-avatar',
      status: 200,
      statusText: 'OK',
    });
    const view = render(<SecureImage src={source} alt="Persona avatar" />);
    const image = view.container.querySelector('img')!;
    expect(image.src).toBe('native:cache://stream-avatar.jpg');
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    fireEvent.error(image);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(image.src).not.toBe('native:cache://stream-avatar.jpg'),
    );
    fireEvent.load(image);
    expect(image.style.visibility).not.toBe('hidden');
    view.unmount();
  });

  it('shows the decoded image on first paint for new streaming and canonical renderers', async () => {
    const v1 = 'https://board.test/api/ai-users/persona/avatar?thumbnail=1&v=1';
    const streaming =
      'https://board.test/api/ai-users/persona/avatar?thumbnail=1';
    const emoteV1 =
      'https://board.test/api/ai-users/persona/emotes/happy?thumbnail=1&v=1';
    const streamingEmote =
      'https://board.test/api/ai-users/persona/emotes/happy?thumbnail=1';
    const v2 = 'https://board.test/api/ai-users/persona/avatar?thumbnail=1&v=2';
    let releaseV2!: () => void;
    apiFetch.mockImplementation(async (url: string) => {
      if (url === v2)
        await new Promise<void>((resolve) => (releaseV2 = resolve));
      return {
        ok: true,
        nativeUrl: `data:${url}`,
        status: 200,
        statusText: 'OK',
      };
    });

    const earlier = render(
      <SecureImage data-ui="earlier-avatar" src={v1} alt="Persona avatar" />,
    );
    const earlierImage = earlier.container.querySelector('img')!;
    await waitFor(() => expect(earlierImage.src).toMatch(/^native:/));
    const cachedV1 = earlierImage.src;
    expect(apiFetch).toHaveBeenCalledTimes(1);

    const earlierEmote = render(
      <SecureImage data-ui="earlier-emote" src={emoteV1} alt="Happy emote" />,
    );
    const earlierEmoteImage = earlierEmote.container.querySelector('img')!;
    await waitFor(() => expect(earlierEmoteImage.src).toMatch(/^native:/));
    const cachedEmote = earlierEmoteImage.src;
    expect(cachedEmote).not.toBe(cachedV1);
    expect(apiFetch).toHaveBeenCalledTimes(2);

    const streamingBubble = render(
      <SecureImage
        data-ui="streaming-avatar"
        src={streaming}
        alt="Persona avatar"
      />,
    );
    const streamingImage = streamingBubble.container.querySelector('img')!;
    expect(streamingImage.src).toBe(cachedV1);
    expect(streamingImage.getAttribute('src')).not.toBe('');
    expect(streamingImage.getAttribute('data-media-error')).toBeNull();
    expect(streamingImage.getAttribute('aria-busy')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(2);

    const streamingEmoteBubble = render(
      <SecureImage
        data-ui="streaming-emote"
        src={streamingEmote}
        alt="Happy emote"
      />,
    );
    const streamingEmoteImage =
      streamingEmoteBubble.container.querySelector('img')!;
    expect(streamingEmoteImage.src).toBe(cachedEmote);
    expect(streamingEmoteImage.src).not.toBe(cachedV1);
    expect(apiFetch).toHaveBeenCalledTimes(2);

    const canonicalBubble = render(
      <SecureImage data-ui="canonical-avatar" src={v1} alt="Persona avatar" />,
    );
    const canonicalImage = canonicalBubble.container.querySelector('img')!;
    expect(canonicalImage.src).toBe(cachedV1);
    expect(canonicalImage.getAttribute('data-media-error')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(2);

    const updatedBubble = render(
      <SecureImage data-ui="updated-avatar" src={v2} alt="Persona avatar" />,
    );
    const updatedImage = updatedBubble.container.querySelector('img')!;
    expect(updatedImage.src).toBe(cachedV1);
    expect(updatedImage.style.visibility).not.toBe('hidden');
    expect(updatedImage.getAttribute('data-media-error')).toBeNull();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    await act(async () => releaseV2());
    await waitFor(() => expect(updatedImage.src).not.toBe(cachedV1));
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual([v1, emoteV1, v2]);
  });

  it('retains a decoded native image when a replacement fails to decode', async () => {
    const v1 =
      'https://board.test/api/ai-users/decode-persona/avatar?thumbnail=1&v=1';
    const v2 =
      'https://board.test/api/ai-users/decode-persona/avatar?thumbnail=1&v=2';
    apiFetch.mockImplementation(async (url: string) => ({
      ok: true,
      nativeUrl: `data:${url}`,
      status: 200,
      statusText: 'OK',
    }));
    const view = render(<SecureImage src={v1} alt="Decode avatar" />);
    const image = view.container.querySelector('img')!;
    await waitFor(() => expect(image.src).toMatch(/^native:/));
    fireEvent.load(image);
    const decoded = image.src;
    view.rerender(<SecureImage src={v2} alt="Decode avatar" />);
    await waitFor(() => expect(image.src).not.toBe(decoded));
    fireEvent.error(image);
    expect(image.src).toBe(decoded);
    expect(image.style.visibility).not.toBe('hidden');
    const streaming = render(
      <SecureImage
        src="https://board.test/api/ai-users/decode-persona/avatar?thumbnail=1"
        alt="Decode avatar"
      />,
    );
    expect(streaming.container.querySelector('img')!.src).toBe(decoded);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('uses the newest successful version despite late historical loads and newer failures', async () => {
    const historyV1 =
      'https://board.test/api/ai-users/history-persona/avatar?thumbnail=1&v=1';
    const historyV2 =
      'https://board.test/api/ai-users/history-persona/avatar?thumbnail=1&v=2';
    const historyStreaming =
      'https://board.test/api/ai-users/history-persona/avatar?thumbnail=1';
    apiFetch.mockImplementation(async (url: string) => ({
      ok: true,
      nativeUrl: `data:${url}`,
      status: 200,
      statusText: 'OK',
    }));

    const newest = render(
      <SecureImage src={historyV2} alt="History persona avatar" />,
    );
    await waitFor(() =>
      expect(newest.container.querySelector('img')!.src).toMatch(/^native:/),
    );
    const cachedV2 = newest.container.querySelector('img')!.src;
    const historical = render(
      <SecureImage src={historyV1} alt="History persona avatar" />,
    );
    await waitFor(() =>
      expect(historical.container.querySelector('img')!.src).toMatch(
        /^native:/,
      ),
    );
    const historyStream = render(
      <SecureImage src={historyStreaming} alt="History persona avatar" />,
    );
    expect(historyStream.container.querySelector('img')!.src).toBe(cachedV2);

    const failureV1 =
      'https://board.test/api/ai-users/failure-persona/avatar?thumbnail=1&v=1';
    const failureV2 =
      'https://board.test/api/ai-users/failure-persona/avatar?thumbnail=1&v=2';
    const failureStreaming =
      'https://board.test/api/ai-users/failure-persona/avatar?thumbnail=1';
    let releaseOlder!: (response: Record<string, unknown>) => void;
    let releaseNewer!: (response: Record<string, unknown>) => void;
    apiFetch.mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          if (url === failureV1) releaseOlder = resolve;
          if (url === failureV2) releaseNewer = resolve;
        }),
    );
    const older = render(
      <SecureImage src={failureV1} alt="Failure persona avatar" />,
    );
    render(<SecureImage src={failureV2} alt="Failure persona avatar" />);
    await waitFor(() => expect(releaseOlder).toBeTypeOf('function'));
    await waitFor(() => expect(releaseNewer).toBeTypeOf('function'));
    await act(async () =>
      releaseNewer({ ok: false, status: 500, statusText: 'failed' }),
    );
    await act(async () =>
      releaseOlder({
        ok: true,
        nativeUrl: `data:${failureV1}`,
        status: 200,
        statusText: 'OK',
      }),
    );
    await waitFor(() =>
      expect(older.container.querySelector('img')!.src).toMatch(/^native:/),
    );
    const successfulOlder = older.container.querySelector('img')!.src;
    const failureStream = render(
      <SecureImage src={failureStreaming} alt="Failure persona avatar" />,
    );
    expect(failureStream.container.querySelector('img')!.src).toBe(
      successfulOlder,
    );
  });

  it('retains the base avatar when an unresolved emote is not cached', async () => {
    const avatar =
      'https://board.test/api/ai-users/cold-emote/avatar?thumbnail=1&v=1';
    const unresolvedEmote =
      'https://board.test/api/ai-users/cold-emote/emotes/surprised?thumbnail=1';
    const resolvedEmote = `${unresolvedEmote}&v=1`;
    apiFetch.mockImplementation(async (url: string) => ({
      ok: true,
      nativeUrl: `data:${url}`,
      status: 200,
      statusText: 'OK',
    }));

    const base = render(<SecureImage src={avatar} alt="Base avatar" />);
    await waitFor(() =>
      expect(base.container.querySelector('img')!.src).toMatch(/^native:/),
    );
    const cachedAvatar = base.container.querySelector('img')!.src;
    const response = render(
      <SecureImage
        src={unresolvedEmote}
        fallbackSrc={avatar}
        alt="Surprised emote"
      />,
    );
    const responseImage = response.container.querySelector('img')!;
    expect(responseImage.src).toBe(cachedAvatar);
    expect(responseImage.getAttribute('data-media-error')).toBeNull();
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual([avatar]);

    response.rerender(
      <SecureImage
        src={resolvedEmote}
        fallbackSrc={avatar}
        alt="Surprised emote"
      />,
    );
    expect(responseImage.src).toBe(cachedAvatar);
    await waitFor(() => expect(responseImage.src).not.toBe(cachedAvatar));
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual([
      avatar,
      resolvedEmote,
    ]);
  });
});
