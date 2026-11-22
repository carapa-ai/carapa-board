import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  deviceTts: {
    getStatus: vi.fn(),
    synthesize: vi.fn(),
    preview: vi.fn(),
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    convertFileSrc: (uri: string) => `webview:${uri}`,
  },
  registerPlugin: () => mocks.deviceTts,
}));
vi.mock('@/lib/api', () => ({
  apiFetch: mocks.apiFetch,
}));
vi.mock('./native-speech', () => ({
  cachedNativeSpeechFileUrl: vi.fn(async () => null),
  nativeSpeechFileUrl: vi.fn(async () => null),
}));
vi.mock('./push-bridge', () => ({
  cacheNativeSpeech: vi.fn(),
  isBridgeSupported: () => true,
  stopActiveNativeSpeech: vi.fn(async () => undefined),
}));

const played: string[] = [];
class FakeAudio {
  src = '';
  preload = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  load() {}
  pause() {}
  async play() {
    played.push(this.src);
  }
}

beforeEach(() => {
  played.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal('Audio', FakeAudio);
  URL.createObjectURL = vi.fn(() => 'blob:server');
  URL.revokeObjectURL = vi.fn();
  mocks.apiFetch.mockImplementation(async (url: string) =>
    url.endsWith('/api/tts/prepare')
      ? new Response(
          JSON.stringify({ sentences: ['Bună ziua.'], language: 'ro' }),
        )
      : new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'audio/ogg' },
        }),
  );
  mocks.deviceTts.getStatus.mockResolvedValue({ enabled: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const synthesizeCalls = () =>
  mocks.apiFetch.mock.calls.filter(([url]) =>
    String(url).endsWith('/api/tts/synthesize'),
  );

describe('in-WebView speech with on-device TTS', () => {
  it('plays the device rendition instead of server audio', async () => {
    mocks.deviceTts.synthesize.mockResolvedValue({ uri: 'file:///tts/a.wav' });
    const { toggleTts } = await import('./use-tts');

    // The server detects the text's language for device voices.
    await toggleTts('message-1', 'Bună ziua.', { lang: 'en' });

    expect(JSON.parse(mocks.apiFetch.mock.calls[0][1].body)).toMatchObject({
      detectLanguage: true,
    });
    expect(mocks.deviceTts.synthesize).toHaveBeenCalledWith({
      text: 'Bună ziua.',
      language: 'ro',
    });
    expect(played).toEqual(['webview:file:///tts/a.wav']);
    expect(synthesizeCalls()).toHaveLength(0);
  });

  it('falls back to server audio when the device cannot speak', async () => {
    mocks.deviceTts.synthesize.mockRejectedValue(new Error('no voice'));
    const { toggleTts } = await import('./use-tts');

    await toggleTts('message-2', 'Bună ziua.', { lang: 'ro' });

    expect(synthesizeCalls()).toHaveLength(1);
    expect(played).toEqual(['blob:server']);
  });

  it('lets voice previews choose the server or the device engine', async () => {
    mocks.deviceTts.synthesize.mockResolvedValue({ uri: 'file:///tts/a.wav' });
    mocks.deviceTts.preview.mockResolvedValue({ uri: 'file:///tts/p.wav' });
    const { toggleTts, stopTts } = await import('./use-tts');

    await toggleTts('preview-server', 'Bună ziua.', {
      lang: 'ro',
      engine: 'server',
    });
    expect(mocks.deviceTts.synthesize).not.toHaveBeenCalled();
    expect(synthesizeCalls()).toHaveLength(1);

    stopTts();
    mocks.deviceTts.getStatus.mockResolvedValue({ enabled: false });
    await toggleTts('preview-device', 'Bună ziua.', {
      lang: 'ro',
      engine: 'device',
    });
    expect(mocks.deviceTts.preview).toHaveBeenCalledWith({
      text: 'Bună ziua.',
      language: 'ro',
    });
    expect(played).toEqual(['blob:server', 'webview:file:///tts/p.wav']);
  });
});
