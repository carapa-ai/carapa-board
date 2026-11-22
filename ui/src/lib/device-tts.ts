import { Capacitor, registerPlugin } from '@capacitor/core';

/** Native `CarapaDeviceTts` state; see CarapaDeviceTtsPlugin.kt. */
export type DeviceTtsState =
  | 'unsupported'
  | 'disabled'
  | 'ready'
  | 'fallback'
  | 'failed';

export interface DeviceTtsEngine {
  /** Engine package, e.g. com.google.android.tts. */
  id: string;
  label: string;
  isDefault: boolean;
  selected: boolean;
}

/** An installed voice that works offline. */
export interface DeviceTtsVoice {
  id: string;
  /** BCP 47 tag, e.g. ro-RO. */
  language: string;
  label: string;
  selected: boolean;
}

export interface DeviceTtsStatus {
  state: DeviceTtsState;
  /** Per-device opt-in; off by default so other devices keep server voices. */
  enabled: boolean;
  /** Why the last reply used server audio, or why the engine is unusable. */
  error?: string | null;
  engines: DeviceTtsEngine[];
  voices: DeviceTtsVoice[];
}

interface CarapaDeviceTtsPlugin {
  getStatus(): Promise<DeviceTtsStatus>;
  setEnabled(options: { enabled: boolean }): Promise<DeviceTtsStatus>;
  selectEngine(options: { id: string }): Promise<DeviceTtsStatus>;
  selectVoice(options: {
    language: string;
    id: string;
  }): Promise<DeviceTtsStatus>;
  synthesize(options: {
    text: string;
    language?: string;
  }): Promise<{ uri: string }>;
  preview(options: {
    text: string;
    language?: string;
    voice?: string;
  }): Promise<{ uri: string }>;
}

// Registered on first use so importing this module has no side effects.
let plugin: CarapaDeviceTtsPlugin | null = null;
function deviceTts(): CarapaDeviceTtsPlugin {
  plugin ??= registerPlugin<CarapaDeviceTtsPlugin>('CarapaDeviceTts');
  return plugin;
}

let enabledCache: Promise<boolean> | null = null;

function remember(status: DeviceTtsStatus): DeviceTtsStatus {
  enabledCache = Promise.resolve(status.enabled);
  return status;
}

export function deviceTtsAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/** Null outside the Android app, or on a shell without the plugin. */
export async function getDeviceTtsStatus(): Promise<DeviceTtsStatus | null> {
  if (!deviceTtsAvailable()) return null;
  try {
    return remember(await deviceTts().getStatus());
  } catch {
    return null;
  }
}

/** Whether replies on this device are spoken by its own TTS engine. */
export function deviceTtsEnabled(): Promise<boolean> {
  if (!deviceTtsAvailable()) return Promise.resolve(false);
  enabledCache ??= getDeviceTtsStatus().then((status) => !!status?.enabled);
  return enabledCache;
}

export async function setDeviceTtsEnabled(
  enabled: boolean,
): Promise<DeviceTtsStatus> {
  return remember(await deviceTts().setEnabled({ enabled }));
}

export async function selectDeviceTtsEngine(
  id: string,
): Promise<DeviceTtsStatus> {
  return remember(await deviceTts().selectEngine({ id }));
}

export async function selectDeviceTtsVoice(
  language: string,
  id: string,
): Promise<DeviceTtsStatus> {
  return remember(await deviceTts().selectVoice({ language, id }));
}

/**
 * Speaks `text` with the device engine into a cached WAV and returns a
 * WebView-playable URL, or null so the caller uses server audio instead.
 */
export async function synthesizeDeviceSpeech(
  text: string,
  language?: string | null,
): Promise<string | null> {
  if (!(await deviceTtsEnabled())) return null;
  try {
    const { uri } = await deviceTts().synthesize({
      text,
      ...(language ? { language } : {}),
    });
    return Capacitor.convertFileSrc(uri);
  } catch (error) {
    console.warn('[device-tts] falling back to server speech', error);
    return null;
  }
}

/**
 * Renders a voice preview with this device's voice for `language` (or the
 * given voice), whether or not device speech is on. Throws when the device
 * cannot speak it, so the caller can say why.
 */
export async function previewDeviceSpeech(
  text: string,
  language?: string | null,
  voice?: string | null,
): Promise<string> {
  const { uri } = await deviceTts().preview({
    text,
    ...(language ? { language } : {}),
    ...(voice ? { voice } : {}),
  });
  return Capacitor.convertFileSrc(uri);
}
