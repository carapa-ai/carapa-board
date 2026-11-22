import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThisDeviceCard } from './this-device-card';

const native = vi.hoisted(() => ({
  android: true,
  plugins: {} as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => native.android,
    getPlatform: () => (native.android ? 'android' : 'web'),
    convertFileSrc: (uri: string) => uri,
  },
  registerPlugin: (name: string) =>
    new Proxy(
      {},
      { get: (_target, method: string) => native.plugins[name]?.[method] },
    ),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const model = {
  id: 'ggml-small-q5_1',
  label: 'Whisper small',
  sizeBytes: 190_000_000,
  sha256: 'x',
};

function sttStatus(engine: 'whisper' | 'system') {
  return {
    state: 'ready',
    enabled: true,
    engine,
    engines: { whisper: {}, system: {} },
    model,
    models: [{ ...model, installed: true, selected: true, loaded: true }],
    recognizers: [
      {
        id: 'com.google.android.tts/Recognizer',
        label: 'Speech Services by Google',
        isDefault: true,
        selected: true,
      },
    ],
  };
}

function ttsStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: 'disabled',
    enabled: false,
    error: null,
    engines: [
      {
        id: 'com.google.android.tts',
        label: 'Google',
        isDefault: true,
        selected: true,
      },
    ],
    voices: [
      { id: 'ro-a', language: 'ro-RO', label: 'Romanian A', selected: true },
      { id: 'ro-b', language: 'ro-RO', label: 'Romanian B', selected: false },
    ],
    ...overrides,
  };
}

function install() {
  native.plugins = {
    CarapaWhisper: {
      getStatus: vi.fn(async () => sttStatus('whisper')),
      addListener: vi.fn(async () => ({ remove: async () => undefined })),
      selectEngine: vi.fn(async () => sttStatus('system')),
      setEnabled: vi.fn(),
    },
    CarapaDeviceTts: {
      getStatus: vi.fn(async () => ttsStatus()),
      setEnabled: vi.fn(async () =>
        ttsStatus({ state: 'ready', enabled: true }),
      ),
      selectVoice: vi.fn(async () => ttsStatus()),
    },
  };
  return native.plugins;
}

afterEach(() => {
  cleanup();
  native.android = true;
});

describe('ThisDeviceCard', () => {
  it('renders nothing outside the Android app', async () => {
    native.android = false;
    const plugins = install();
    const { container } = render(<ThisDeviceCard />);
    await Promise.resolve();
    expect(container.innerHTML).toBe('');
    expect(plugins.CarapaDeviceTts.getStatus).not.toHaveBeenCalled();
  });

  it('switches device text-to-speech and its voice through the plugin', async () => {
    const plugins = install();
    plugins.CarapaDeviceTts.selectVoice.mockResolvedValueOnce(
      ttsStatus({
        state: 'fallback',
        enabled: true,
        error: 'the Romanian voice is not downloaded on this device',
      }),
    );
    render(<ThisDeviceCard />);

    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="account-local-speech-status"]')
          ?.textContent,
      ).toContain('server voices'),
    );
    expect(
      document.querySelector('[data-ui="account-local-transcription"]'),
    ).not.toBeNull();

    fireEvent.click(
      document.querySelector('[data-ui="account-local-speech-toggle"]')!,
    );
    await waitFor(() =>
      expect(plugins.CarapaDeviceTts.setEnabled).toHaveBeenCalledWith({
        enabled: true,
      }),
    );

    const voice = document.querySelector('[data-voice-id="ro-b"]')!;
    fireEvent.click(voice.querySelector('button')!);
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="account-local-speech-status"]')
          ?.textContent,
      ).toContain('the Romanian voice is not downloaded on this device'),
    );
    expect(plugins.CarapaDeviceTts.selectVoice).toHaveBeenCalledWith({
      language: 'ro-RO',
      id: 'ro-b',
    });
  });

  it('switches speech-to-text between Whisper and the Android recognizer', async () => {
    const plugins = install();
    render(<ThisDeviceCard />);
    await waitFor(() => expect(screen.getByText('Whisper small')).toBeTruthy());

    expect(
      screen
        .getByRole('radio', { name: 'Whisper' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Android recognizer' }));

    await waitFor(() =>
      expect(screen.getByText('Speech Services by Google')).toBeTruthy(),
    );
    expect(plugins.CarapaWhisper.selectEngine).toHaveBeenCalledWith({
      engine: 'system',
    });
    expect(screen.queryByText('Whisper small')).toBeNull();
    expect(
      document.querySelector('[data-ui="account-local-transcription-status"]')
        ?.textContent,
    ).toContain('On · Android recognizer (Speech Services by Google)');
    expect(
      screen
        .getByRole('radio', { name: 'Android recognizer' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });
});
