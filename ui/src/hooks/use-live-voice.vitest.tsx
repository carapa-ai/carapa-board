import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  apiFetch,
  cutOffLiveSpeech,
  liveSpeechState,
  nativeSpeech,
  recordLiveMetric,
  detectorPush,
  toastError,
  localTranscription,
} = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  cutOffLiveSpeech: vi.fn(async () => undefined),
  liveSpeechState: { status: 'idle' },
  nativeSpeech: { playing: false },
  recordLiveMetric: vi.fn(),
  detectorPush:
    vi.fn<(rms: number, samples: number, zeroCrossings?: number) => string>(),
  toastError: vi.fn(),
  localTranscription: {
    getLocalTranscriptionStatus: vi.fn(),
    prepareLocalTranscription: vi.fn(),
    transcribeLocalPhrase: vi.fn(),
    cancelLocalPhrases: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ apiFetch }));
vi.mock('@/lib/use-tts', () => ({
  cutOffLiveSpeech,
  getLiveSpeechState: () => liveSpeechState,
}));
vi.mock('@/lib/push-bridge', () => ({
  isNativeSpeechPlaying: () => nativeSpeech.playing,
}));
vi.mock('@/lib/live-telemetry', () => ({ recordLiveMetric }));
vi.mock('sonner', () => ({
  toast: { error: toastError, loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/lib/local-transcription', () => localTranscription);
vi.mock('@/lib/live-voice-socket', () => ({
  liveVoiceWebSocketUrl: vi.fn(async () => 'ws://localhost/api/live-voice/ws'),
}));
vi.mock('@/lib/live-voice-protocol', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/live-voice-protocol')>();
  // Scripted tests drive `detectorPush`; with no implementation armed, the
  // real adaptive detector runs (long-playback scenarios need its state).
  class DelegatingDetector {
    private inner: InstanceType<typeof actual.LiveVoiceDetector>;
    constructor(
      options: ConstructorParameters<typeof actual.LiveVoiceDetector>[0],
    ) {
      this.inner = new actual.LiveVoiceDetector(options);
    }
    push(rms: number, samples: number, zeroCrossings?: number) {
      if (detectorPush.getMockImplementation())
        return detectorPush(rms, samples, zeroCrossings);
      return this.inner.push(rms, samples, zeroCrossings);
    }
    reset() {
      this.inner.reset();
    }
    flush() {
      // Scripted detector decisions leave the real detector idle: treat the
      // open phrase as meeting the speech minimums.
      return detectorPush.getMockImplementation() ? true : this.inner.flush();
    }
    resetNoiseFloor() {
      this.inner.resetNoiseFloor();
    }
  }
  return {
    ...actual,
    LIVE_VOICE_PROTOCOL: 'carapa.live-voice.v2',
    LiveVoiceDetector: DelegatingDetector,
    StreamingPcmResampler: class {
      push(input: Float32Array) {
        return input;
      }
    },
    cleanupLiveVoiceResources: vi.fn((resources) => {
      resources.stream
        ?.getTracks()
        .forEach((track: MediaStreamTrack) => track.stop());
      resources.node?.disconnect();
      resources.source?.disconnect();
      void resources.context?.close();
    }),
    zeroCrossingRate: vi.fn(() => 0),
  };
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  binaryType = '';
  sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(value: unknown) {
    this.sent.push(value);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  open() {
    this.onopen?.();
  }

  message(value: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
}

let audioFrame:
  | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void)
  | null;
let initialAudioContextState: AudioContextState;
let resumeAudioContext: boolean;
const trackStop = vi.fn();
const sourceDisconnect = vi.fn();
const nodeDisconnect = vi.fn();
const contextClose = vi.fn(async () => undefined);
const contextResume = vi.fn(async () => undefined);

class FakeAudioContext {
  state: AudioContextState = initialAudioContextState;
  sampleRate = 16_000;
  destination = {} as AudioDestinationNode;

  constructor() {
    audioFrame = null;
  }

  resume = async () => {
    await contextResume();
    if (resumeAudioContext) this.state = 'running';
  };
  close = contextClose;
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: sourceDisconnect };
  }
  createScriptProcessor() {
    return {
      connect: vi.fn(),
      disconnect: nodeDisconnect,
      set onaudioprocess(
        handler: (event: {
          inputBuffer: { getChannelData: () => Float32Array };
        }) => void,
      ) {
        audioFrame = handler;
      },
    };
  }
}

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
  constructor(public name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    transcriptionConfigured: true,
    streamingConfigured: true,
    streamingTransport: 'carapa.live-voice.v2',
    websocketPath: '/api/live-voice/ws',
    sampleRate: 16_000,
    ...overrides,
  };
}

async function readySocket() {
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  const socket = FakeSocket.instances[0]!;
  act(() => {
    socket.open();
    socket.message({ type: 'ready', mode: 'gpu' });
  });
  await waitFor(() => expect(audioFrame).not.toBeNull());
  return socket;
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeSocket.instances = [];
  FakeBroadcastChannel.instances = [];
  audioFrame = null;
  initialAudioContextState = 'running';
  resumeAudioContext = true;
  detectorPush.mockReturnValue('silence');
  liveSpeechState.status = 'idle';
  nativeSpeech.playing = false;
  apiFetch.mockResolvedValue({ json: async () => config() });
  localTranscription.getLocalTranscriptionStatus.mockResolvedValue(null);
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: FakeSocket,
  });
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: FakeAudioContext,
  });
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    value: FakeBroadcastChannel,
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: trackStop }],
      })),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useLiveVoice orchestration', () => {
  it('rejects an incompatible streaming protocol before opening media', async () => {
    apiFetch.mockResolvedValueOnce({
      json: async () => config({ streamingTransport: 'legacy' }),
    });
    const { result } = renderHook(() => useLiveVoice(true, vi.fn()));

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.error).toContain('backend is outdated');
    expect(FakeSocket.instances).toHaveLength(0);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('becomes ready on the first audio frame, sends PCM, and delivers one final', async () => {
    const onFinal = vi.fn(async () => undefined);
    const { result } = renderHook(() => useLiveVoice(true, onFinal));
    const socket = await readySocket();

    detectorPush.mockReturnValueOnce('speech-start');
    act(() =>
      audioFrame?.({
        inputBuffer: {
          getChannelData: () => new Float32Array(1600).fill(0.25),
        },
      }),
    );
    expect(result.current.status).toBe('hearing');
    expect(cutOffLiveSpeech).toHaveBeenCalledOnce();
    expect(socket.sent.some((value) => value instanceof ArrayBuffer)).toBe(
      true,
    );

    detectorPush.mockReturnValueOnce('finalize');
    act(() =>
      audioFrame?.({
        inputBuffer: { getChannelData: () => new Float32Array([0.2]) },
      }),
    );
    const commit = socket.sent.find(
      (value) => typeof value === 'string' && value.includes('"commit"'),
    ) as string;
    const utteranceId = JSON.parse(commit).utteranceId;
    act(() => {
      socket.message({ type: 'final', utteranceId, text: ' hello voice ' });
      socket.message({ type: 'final', utteranceId, text: 'duplicate' });
    });
    await waitFor(() => expect(onFinal).toHaveBeenCalledWith('hello voice'));
    expect(onFinal).toHaveBeenCalledOnce();
    expect(result.current.lastFinal).toBe('hello voice');
  });

  it('transcribes phrases on-device without server STT, merges phrases queued behind a running inference, and drops stale results', async () => {
    localTranscription.getLocalTranscriptionStatus.mockResolvedValue({
      enabled: true,
    });
    localTranscription.prepareLocalTranscription.mockResolvedValue({
      ok: true,
    });
    const deferred = () => {
      let resolve!: (value: unknown) => void;
      const promise = new Promise((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const second = deferred();
    const merged = deferred();
    localTranscription.transcribeLocalPhrase
      .mockResolvedValueOnce({ ok: true, text: ' salut ', inferenceMs: 1 })
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(merged.promise);
    const onFinal = vi.fn(async (_text: string) => undefined);
    const { result } = renderHook(() => useLiveVoice(true, onFinal));
    await waitFor(() => expect(audioFrame).not.toBeNull());
    const phrase = () => {
      detectorPush.mockReturnValueOnce('speech-start');
      act(() =>
        audioFrame?.({
          inputBuffer: {
            getChannelData: () => new Float32Array(1600).fill(0.25),
          },
        }),
      );
      detectorPush.mockReturnValueOnce('finalize');
      act(() =>
        audioFrame?.({
          inputBuffer: { getChannelData: () => new Float32Array([0.2]) },
        }),
      );
    };
    const calls = localTranscription.transcribeLocalPhrase.mock.calls;

    phrase();
    await waitFor(() => expect(onFinal).toHaveBeenCalledWith('salut'));
    const [, pcm, language] = calls[0]!;
    expect((pcm as ArrayBuffer).byteLength).toBe(1601 * 2);
    expect(language).toBe('auto');

    // Two phrases committed while the second inference runs become one call.
    phrase();
    await waitFor(() => expect(calls).toHaveLength(2));
    phrase();
    phrase();
    expect(calls).toHaveLength(2);
    await act(async () => {
      second.resolve({ ok: true, text: 'unu', inferenceMs: 1 });
    });
    await waitFor(() => expect(calls).toHaveLength(3));
    const gapBytes = Math.round(0.15 * 16_000) * 2;
    expect((calls[2]![1] as ArrayBuffer).byteLength).toBe(
      1601 * 2 * 2 + gapBytes,
    );
    expect(onFinal.mock.calls.map(([text]) => text)).toEqual(['salut', 'unu']);

    const staleId = calls[2]![0];
    act(() => result.current.stop());
    expect(localTranscription.cancelLocalPhrases).toHaveBeenCalledWith([
      staleId,
    ]);
    await act(async () => {
      merged.resolve({ ok: true, text: 'stale', inferenceMs: 1 });
    });

    expect(onFinal).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('idle');
    expect(apiFetch).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('stays transcribing after finish until every queued on-device phrase is delivered', async () => {
    localTranscription.getLocalTranscriptionStatus.mockResolvedValue({
      enabled: true,
    });
    localTranscription.prepareLocalTranscription.mockResolvedValue({
      ok: true,
    });
    let finishRunning!: (value: unknown) => void;
    let finishQueued!: (value: unknown) => void;
    localTranscription.transcribeLocalPhrase
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishRunning = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishQueued = resolve;
        }),
      );
    const onFinal = vi.fn(async (_text: string) => undefined);
    const { result } = renderHook(() => useLiveVoice(true, onFinal));
    await waitFor(() => expect(audioFrame).not.toBeNull());
    for (let i = 0; i < 2; i++) {
      detectorPush.mockReturnValueOnce('speech-start');
      act(() =>
        audioFrame?.({
          inputBuffer: {
            getChannelData: () => new Float32Array(1600).fill(0.25),
          },
        }),
      );
      detectorPush.mockReturnValueOnce('finalize');
      act(() =>
        audioFrame?.({
          inputBuffer: { getChannelData: () => new Float32Array([0.2]) },
        }),
      );
    }

    act(() => void result.current.finish());
    expect(result.current.capturing).toBe(false);
    await act(async () => {
      finishRunning({ ok: true, text: 'unu', inferenceMs: 1 });
    });
    expect(onFinal).toHaveBeenCalledWith('unu');
    // A phrase is still being transcribed: the composer stays busy.
    expect(result.current.status).toBe('transcribing');
    await act(async () => {
      finishQueued({ ok: true, text: 'doi', inferenceMs: 1 });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(onFinal.mock.calls.map(([text]) => text)).toEqual(['unu', 'doi']);
  });

  it('sends the saved account dictation language only when opted in', async () => {
    apiFetch.mockImplementation(async (url: string) => ({
      json: async () =>
        url.includes('/account/preferences')
          ? { dictationLanguage: 'ro' }
          : config({ language: 'en' }),
    }));
    const { result } = renderHook(() =>
      useLiveVoice(true, vi.fn(), { useAccountDictationLanguage: true }),
    );
    const socket = await readySocket();
    const start = JSON.parse(String(socket.sent[0]));
    expect(start).toMatchObject({ language: 'ro' });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    result.current.stop();
  });

  it('does not load account preferences for Live Mode consumers', async () => {
    const { result } = renderHook(() => useLiveVoice(true, vi.fn()));
    const socket = await readySocket();
    const start = JSON.parse(String(socket.sent[0]));
    expect(start).not.toHaveProperty('language');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    result.current.stop();
  });

  it('explicit stop cancels resources and ignores stale socket messages', async () => {
    const onFinal = vi.fn();
    const { result } = renderHook(() => useLiveVoice(true, onFinal));
    const socket = await readySocket();

    act(() => result.current.stop());
    expect(result.current.status).toBe('idle');
    expect(socket.closed).toBe(true);
    expect(trackStop).toHaveBeenCalled();
    act(() =>
      socket.message({ type: 'final', utteranceId: 'stale', text: 'no' }),
    );
    expect(onFinal).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('releases a deferred permission result after stop and keeps the stale run idle', async () => {
    let resolvePermission!: (stream: MediaStream) => void;
    const staleTrackStop = vi.fn();
    const permission = new Promise<MediaStream>((resolve) => {
      resolvePermission = resolve;
    });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(
      permission,
    );
    const { result } = renderHook(() => useLiveVoice(true, vi.fn()));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.message({ type: 'ready' });
    });
    await waitFor(() =>
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce(),
    );

    act(() => result.current.stop());
    await act(async () => {
      resolvePermission({
        getTracks: () => [
          { stop: staleTrackStop } as unknown as MediaStreamTrack,
        ],
      } as MediaStream);
      await permission;
    });

    expect(staleTrackStop).toHaveBeenCalledOnce();
    expect(result.current.status).toBe('idle');
    expect(result.current.capturing).toBe(false);
    expect(contextResume).not.toHaveBeenCalled();
  });

  it('fails and releases resources when capture produces no first frame for three seconds', async () => {
    let resolvePermission!: (stream: MediaStream) => void;
    const permission = new Promise<MediaStream>((resolve) => {
      resolvePermission = resolve;
    });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(
      permission,
    );
    const { result } = renderHook(() => useLiveVoice(true, vi.fn()));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    act(() => {
      FakeSocket.instances[0]!.open();
      FakeSocket.instances[0]!.message({ type: 'ready' });
    });
    await waitFor(() =>
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce(),
    );
    vi.useFakeTimers();
    await act(async () => {
      resolvePermission({
        getTracks: () => [{ stop: trackStop } as unknown as MediaStreamTrack],
      } as MediaStream);
      await permission;
      await Promise.resolve();
    });
    expect(audioFrame).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(result.current.status).toBe('error');
    expect(result.current.capturing).toBe(false);
    expect(result.current.error).toContain('no audio was received');
    expect(trackStop).toHaveBeenCalled();
    expect(contextClose).toHaveBeenCalled();
    expect(FakeSocket.instances[0]!.closed).toBe(true);
  });

  it('requires AudioContext to reach running before reporting capture ready', async () => {
    initialAudioContextState = 'suspended';
    resumeAudioContext = false;
    const { result } = renderHook(() => useLiveVoice(true, vi.fn()));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    act(() => {
      FakeSocket.instances[0]!.open();
      FakeSocket.instances[0]!.message({ type: 'ready' });
    });

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(contextResume).toHaveBeenCalledOnce();
    expect(result.current.error).toContain('Audio capture could not start');
    expect(trackStop).toHaveBeenCalled();
  });

  it('serializes same-page capture ownership to one hook instance', async () => {
    const first = renderHook(() => useLiveVoice(true, vi.fn()));
    const firstSocket = await readySocket();
    const second = renderHook(() => useLiveVoice(true, vi.fn()));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));

    expect(first.result.current.status).toBe('idle');
    expect(firstSocket.closed).toBe(true);
    expect(second.result.current.capturing).toBe(true);
    first.unmount();
    second.unmount();
  });

  it('releases capture when another tab claims microphone ownership', async () => {
    const { result } = renderHook(() => useLiveVoice(true, vi.fn()));
    const socket = await readySocket();
    const channel = FakeBroadcastChannel.instances[0]!;

    act(() =>
      channel.onmessage?.({
        data: { type: 'claim', owner: 'another-tab' },
      } as MessageEvent),
    );
    expect(result.current.status).toBe('idle');
    expect(result.current.capturing).toBe(false);
    expect(socket.closed).toBe(true);
  });

  it('toasts a visible error when a user-initiated start fails before ready', async () => {
    const { result } = renderHook(() => {
      const dictation = useLiveVoice(false, vi.fn());
      useDictationFailureToast(dictation);
      return dictation;
    });
    expect(result.current.capturing).toBe(false);
    act(() => {
      void result.current.start();
    });
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.onerror?.();
    });
    await waitFor(() => expect(result.current.capturing).toBe(false));
    expect(result.current.status).toBe('unavailable');
    expect(result.current.error).toBe('Local voice socket failed');
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      'Dictation stopped: Local voice socket failed',
    );
  });

  it('does not toast when the user stops a healthy capture', async () => {
    const { result } = renderHook(() => {
      const dictation = useLiveVoice(true, vi.fn());
      useDictationFailureToast(dictation);
      return dictation;
    });
    await readySocket();
    act(() => result.current.stop());
    expect(result.current.capturing).toBe(false);
    expect(result.current.error).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts a visible hint for a recoverable backend error mid-session', async () => {
    const { result } = renderHook(() => {
      const dictation = useLiveVoice(true, vi.fn());
      useDictationFailureToast(dictation);
      return dictation;
    });
    const socket = await readySocket();
    act(() => {
      socket.message({
        type: 'error',
        recoverable: true,
        message: 'GPU pool busy',
      });
    });
    await waitFor(() => expect(result.current.error).toBe('GPU pool busy'));
    expect(result.current.capturing).toBe(true);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Dictation issue: GPU pool busy');
  });

  it('toasts a visible error when the phrase callback fails mid-session', async () => {
    const { result } = renderHook(() => {
      const dictation = useLiveVoice(true, () =>
        Promise.reject(new Error('insert failed')),
      );
      useDictationFailureToast(dictation);
      return dictation;
    });
    const socket = await readySocket();
    act(() => {
      socket.message({ type: 'final', utteranceId: 'u1', text: 'hello' });
    });
    await waitFor(() => expect(result.current.error).toBe('insert failed'));
    expect(result.current.capturing).toBe(true);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Dictation issue: insert failed');
  });

  it('does not toast for an empty-text final soft hint while actively speaking', async () => {
    const { result } = renderHook(() => {
      const dictation = useLiveVoice(true, vi.fn());
      useDictationFailureToast(dictation);
      return dictation;
    });
    const socket = await readySocket();
    detectorPush.mockReturnValueOnce('speech-start');
    act(() =>
      audioFrame?.({
        inputBuffer: {
          getChannelData: () => new Float32Array(1600).fill(0.25),
        },
      }),
    );
    expect(result.current.status).toBe('hearing');
    act(() =>
      socket.message({ type: 'final', utteranceId: 'soft', text: '   ' }),
    );
    await waitFor(() => expect(result.current.status).toBe('empty'));
    expect(result.current.capturing).toBe(true);
    expect(result.current.error).toBe(
      'No words were recognized. Keep talking or try again.',
    );
    // Soft informational hint, never an actionable failure toast.
    expect(toastError).not.toHaveBeenCalled();
  });

  describe('server reconnect (Live Mode)', () => {
    const liveOptions = { reconnect: true };
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    const openReady = async (socket: FakeSocket) => {
      act(() => {
        socket.open();
        socket.message({ type: 'ready', mode: 'gpu' });
      });
      await advance(0);
    };
    const render = async (
      onFinal: (text: string) => void = vi.fn(),
      enabled = true,
    ) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const hook = renderHook(
        ({ on }) => {
          const voice = useLiveVoice(on, onFinal, liveOptions);
          useDictationFailureToast(voice);
          return voice;
        },
        { initialProps: { on: enabled } },
      );
      await advance(0);
      return hook;
    };

    it('reopens the socket after an unexpected close and delivers finals from the new one', async () => {
      const onFinal = vi.fn();
      const { result } = await render(onFinal);
      const first = FakeSocket.instances[0]!;
      await openReady(first);
      act(() =>
        audioFrame?.({
          inputBuffer: { getChannelData: () => new Float32Array(1600) },
        }),
      );
      expect(result.current.status).toBe('ready');

      act(() => first.onclose?.());
      expect(result.current.status).toBe('reconnecting');
      expect(result.current.error).toBe('Reconnecting voice…');
      await advance(499);
      expect(FakeSocket.instances).toHaveLength(1);
      await advance(1);
      expect(FakeSocket.instances).toHaveLength(2);

      const second = FakeSocket.instances[1]!;
      await openReady(second);
      expect(audioFrame).not.toBeNull();
      detectorPush.mockReturnValueOnce('speech-start');
      act(() =>
        audioFrame?.({
          inputBuffer: { getChannelData: () => new Float32Array(1600) },
        }),
      );
      detectorPush.mockReturnValueOnce('finalize');
      act(() =>
        audioFrame?.({
          inputBuffer: { getChannelData: () => new Float32Array([0.2]) },
        }),
      );
      const commit = second.sent.find(
        (value) => typeof value === 'string' && value.includes('"commit"'),
      ) as string;
      act(() =>
        second.message({
          type: 'final',
          utteranceId: JSON.parse(commit).utteranceId,
          text: 'after restart',
        }),
      );
      expect(onFinal).toHaveBeenCalledWith('after restart');
      expect(toastError).not.toHaveBeenCalled();
    });

    it('does not leave an in-flight phrase transcribing when the socket drops', async () => {
      const { result } = await render();
      const socket = FakeSocket.instances[0]!;
      await openReady(socket);
      detectorPush.mockReturnValueOnce('speech-start');
      act(() =>
        audioFrame?.({
          inputBuffer: { getChannelData: () => new Float32Array(1600) },
        }),
      );
      detectorPush.mockReturnValueOnce('finalize');
      act(() =>
        audioFrame?.({
          inputBuffer: { getChannelData: () => new Float32Array([0.2]) },
        }),
      );
      expect(result.current.status).toBe('transcribing');

      act(() => socket.onclose?.());
      expect(result.current.status).toBe('reconnecting');
    });

    it('does not reconnect after disabling or unmounting during the backoff', async () => {
      const { result, rerender, unmount } = await render();
      const first = FakeSocket.instances[0]!;
      await openReady(first);
      act(() => first.onclose?.());
      rerender({ on: false });
      await advance(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(result.current.status).toBe('idle');

      rerender({ on: true });
      await advance(0);
      expect(FakeSocket.instances).toHaveLength(2);
      await openReady(FakeSocket.instances[1]!);
      act(() => FakeSocket.instances[1]!.onclose?.());
      unmount();
      await advance(60_000);
      expect(FakeSocket.instances).toHaveLength(2);
    });

    it('does not reconnect after an explicit stop or a server stopped message', async () => {
      const { result } = await render();
      const first = FakeSocket.instances[0]!;
      await openReady(first);
      act(() => first.message({ type: 'stopped' }));
      act(() => first.onclose?.());
      await advance(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(result.current.status).toBe('idle');

      await act(async () => {
        void result.current.start();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(FakeSocket.instances).toHaveLength(2);
      const second = FakeSocket.instances[1]!;
      await openReady(second);
      act(() => result.current.stop());
      act(() => second.onclose?.());
      await advance(60_000);
      expect(FakeSocket.instances).toHaveLength(2);
    });

    it('backs off up to the cap while the server stays down, without a toast per retry', async () => {
      const { result } = await render();
      const delays = [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000];
      for (const [index, delay] of delays.entries()) {
        expect(FakeSocket.instances).toHaveLength(index + 1);
        act(() => FakeSocket.instances[index]!.onerror?.());
        await advance(0);
        expect(result.current.status).toBe('reconnecting');
        await advance(delay - 1);
        expect(FakeSocket.instances).toHaveLength(index + 1);
        await advance(1);
      }
      expect(FakeSocket.instances).toHaveLength(delays.length + 1);
      expect(toastError).not.toHaveBeenCalled();
    });

    it('restarts the backoff after a successful ready', async () => {
      await render();
      act(() => FakeSocket.instances[0]!.onerror?.());
      await advance(500);
      act(() => FakeSocket.instances[1]!.onerror?.());
      await advance(1_000);
      await openReady(FakeSocket.instances[2]!);
      act(() => FakeSocket.instances[2]!.onclose?.());
      await advance(499);
      expect(FakeSocket.instances).toHaveLength(3);
      await advance(1);
      expect(FakeSocket.instances).toHaveLength(4);
    });
  });

  describe('reply echo gate (Live Mode)', () => {
    const frame = (level: number, decision: string) => {
      detectorPush.mockReturnValueOnce(decision);
      act(() =>
        audioFrame?.({
          inputBuffer: {
            getChannelData: () => new Float32Array(1600).fill(level),
          },
        }),
      );
    };
    const sentAudio = (socket: FakeSocket) =>
      socket.sent.some((value) => value instanceof ArrayBuffer);
    const sentCommit = (socket: FakeSocket) =>
      socket.sent.some(
        (value) => typeof value === 'string' && value.includes('"commit"'),
      );
    const liveOptions = { suppressReplyEcho: true };

    it('ignores quiet speech while the web reply is playing: no barge-in, no utterance', async () => {
      liveSpeechState.status = 'speaking';
      const onFinal = vi.fn();
      renderHook(() => useLiveVoice(true, onFinal, liveOptions));
      const socket = await readySocket();

      frame(0.02, 'speech-start');
      frame(0.02, 'speech');
      frame(0.02, 'finalize');

      expect(cutOffLiveSpeech).not.toHaveBeenCalled();
      expect(sentAudio(socket)).toBe(false);
      expect(sentCommit(socket)).toBe(false);
      expect(onFinal).not.toHaveBeenCalled();
    });

    it('commits speech that continues past the end of the reply and its tail', async () => {
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      liveSpeechState.status = 'speaking';
      const onFinal = vi.fn(async () => undefined);
      renderHook(() => useLiveVoice(true, onFinal, liveOptions));
      const socket = await readySocket();

      frame(0.02, 'speech-start');
      liveSpeechState.status = 'idle';
      now += REPLY_AUDIO_TAIL_MS + 100;
      frame(0.001, 'speech');
      expect(cutOffLiveSpeech).not.toHaveBeenCalled();
      frame(0.03, 'speech');
      expect(sentAudio(socket)).toBe(true);

      frame(0.2, 'finalize');
      const commit = socket.sent.find(
        (value) => typeof value === 'string' && value.includes('"commit"'),
      ) as string;
      act(() =>
        socket.message({
          type: 'final',
          utteranceId: JSON.parse(commit).utteranceId,
          text: 'yes',
        }),
      );
      await waitFor(() => expect(onFinal).toHaveBeenCalledWith('yes'));
    });

    it('drops a short suppressed echo phrase without a server discard or a noise hint', async () => {
      liveSpeechState.status = 'speaking';
      const { result } = renderHook(() =>
        useLiveVoice(true, vi.fn(), liveOptions),
      );
      const socket = await readySocket();

      frame(0.02, 'speech-start');
      frame(0.02, 'discard');

      expect(
        socket.sent.some(
          (value) => typeof value === 'string' && value.includes('"discard"'),
        ),
      ).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.status).toBe('ready');
    });

    it('treats a playing native speech session like web playback', async () => {
      nativeSpeech.playing = true;
      renderHook(() => useLiveVoice(true, vi.fn(), liveOptions));
      const socket = await readySocket();

      frame(0.02, 'speech-start');

      expect(cutOffLiveSpeech).not.toHaveBeenCalled();
      expect(sentAudio(socket)).toBe(false);
    });

    it('barges in and delivers a transcript when a later frame of the phrase is clearly louder than the echo', async () => {
      liveSpeechState.status = 'speaking';
      const onFinal = vi.fn(async () => undefined);
      renderHook(() => useLiveVoice(true, onFinal, liveOptions));
      const socket = await readySocket();

      // The detector fires speech-start once, on the quiet onset frame.
      frame(0.02, 'speech-start');
      frame(0.03, 'speech');
      expect(cutOffLiveSpeech).not.toHaveBeenCalled();
      expect(sentAudio(socket)).toBe(false);
      frame(0.3, 'speech');
      expect(cutOffLiveSpeech).toHaveBeenCalledOnce();
      expect(sentAudio(socket)).toBe(true);

      frame(0.2, 'finalize');
      const commit = socket.sent.find(
        (value) => typeof value === 'string' && value.includes('"commit"'),
      ) as string;
      act(() =>
        socket.message({
          type: 'final',
          utteranceId: JSON.parse(commit).utteranceId,
          text: 'stop',
        }),
      );
      await waitFor(() => expect(onFinal).toHaveBeenCalledWith('stop'));
    });

    it('keeps ignoring quiet speech during the tail after playback ends, then behaves normally', async () => {
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      liveSpeechState.status = 'speaking';
      renderHook(() => useLiveVoice(true, vi.fn(), liveOptions));
      const socket = await readySocket();

      frame(0.02, 'silence');
      liveSpeechState.status = 'idle';
      now += REPLY_AUDIO_TAIL_MS - 100;
      frame(0.02, 'speech-start');
      expect(cutOffLiveSpeech).not.toHaveBeenCalled();
      expect(sentAudio(socket)).toBe(false);
      frame(0.02, 'finalize');

      now += 200;
      frame(0.02, 'speech-start');
      expect(cutOffLiveSpeech).toHaveBeenCalledOnce();
      expect(sentAudio(socket)).toBe(true);
    });

    it('is unchanged without playback or without the Live Mode option', async () => {
      renderHook(() => useLiveVoice(true, vi.fn(), liveOptions));
      await readySocket();
      frame(0.02, 'speech-start');
      expect(cutOffLiveSpeech).toHaveBeenCalledOnce();
    });

    it('does not gate dictation consumers while reply audio plays', async () => {
      liveSpeechState.status = 'speaking';
      renderHook(() => useLiveVoice(true, vi.fn()));
      await readySocket();
      frame(0.02, 'speech-start');
      expect(cutOffLiveSpeech).toHaveBeenCalledOnce();
    });

    it('captures speech at once 1 s after a long reply ends, whatever the playback pinned the VAD floor to', async () => {
      // Coverage gap: no existing case fed the capture loop a long playback
      // with the real adaptive detector, so the post-playback deaf period
      // (noise floor pinned at the speaker echo, onset above normal speech)
      // was invisible to tests.
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      detectorPush.mockReset(); // run the real LiveVoiceDetector
      liveSpeechState.status = 'speaking';
      const onFinal = vi.fn(async () => undefined);
      renderHook(() => useLiveVoice(true, onFinal, liveOptions));
      const socket = await readySocket();

      // 100 ms capture frames; a sine at amplitude level*sqrt(2) has that RMS.
      const feed = (rmsLevel: number, ms: number) => {
        const frameCount = Math.round(ms / 100);
        act(() => {
          for (let i = 0; i < frameCount; i++) {
            const buf = new Float32Array(1600);
            for (let j = 0; j < buf.length; j++)
              buf[j] =
                Math.sin((2 * Math.PI * 220 * j) / 16_000) *
                rmsLevel *
                Math.SQRT2;
            audioFrame?.({ inputBuffer: { getChannelData: () => buf } });
          }
        });
      };

      // 30 s reply heard at the mic just below the VAD onset (AGC-held
      // speaker echo): it pins the adaptive noise floor for the whole reply.
      feed(0.011, 30_000);
      expect(sentAudio(socket)).toBe(false);
      expect(cutOffLiveSpeech).not.toHaveBeenCalled();

      // Playback ends; the echo tail elapses.
      liveSpeechState.status = 'idle';
      now += REPLY_AUDIO_TAIL_MS + 400;

      // Normal-level speech 1 s after the reply ended is an utterance from
      // its first word, not after a multi-second deaf period.
      feed(0.02, 100);
      expect(sentAudio(socket)).toBe(true);
      expect(cutOffLiveSpeech).toHaveBeenCalledOnce();

      feed(0.02, 500);
      feed(0.004, 400);
      const commit = socket.sent.find(
        (value) => typeof value === 'string' && value.includes('"commit"'),
      ) as string;
      act(() =>
        socket.message({
          type: 'final',
          utteranceId: JSON.parse(commit).utteranceId,
          text: 'hello',
        }),
      );
      await waitFor(() => expect(onFinal).toHaveBeenCalledWith('hello'));
    });

    it('ends a continuous server phrase before pre-roll and speech exceed the server PCM cap', async () => {
      // Silent regression: the server drops the whole phrase above 15 s of PCM
      // (480 000 bytes) and the user sees no failure, only a missing transcript.
      detectorPush.mockReset(); // run the real LiveVoiceDetector
      const onFinal = vi.fn(async () => undefined);
      renderHook(() => useLiveVoice(true, onFinal, liveOptions));
      const socket = await readySocket();
      const feed = (rmsLevel: number, ms: number) => {
        const frameCount = Math.round(ms / 100);
        act(() => {
          for (let i = 0; i < frameCount; i++) {
            const buf = new Float32Array(1600);
            for (let j = 0; j < buf.length; j++)
              buf[j] =
                Math.sin((2 * Math.PI * 220 * j) / 16_000) *
                rmsLevel *
                Math.SQRT2;
            audioFrame?.({ inputBuffer: { getChannelData: () => buf } });
          }
        });
      };
      const hasCommit = () =>
        socket.sent.some(
          (value) => typeof value === 'string' && value.includes('"commit"'),
        );
      const sentBytes = () =>
        socket.sent.reduce<number>(
          (sum, value) =>
            value instanceof ArrayBuffer ? sum + value.byteLength : sum,
          0,
        );

      feed(0.004, 300);
      for (let i = 0; i < 200 && !hasCommit(); i++) feed(0.05, 100);

      expect(hasCommit()).toBe(true);
      expect(sentBytes()).toBeGreaterThan(0);
      expect(sentBytes()).toBeLessThanOrEqual(16_000 * 2 * 15);
    });
  });
});

import { useDictationFailureToast, useLiveVoice } from './use-live-voice';
import { REPLY_AUDIO_TAIL_MS } from '@/lib/reply-audio';
