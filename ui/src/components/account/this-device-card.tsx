import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Select, SelectItem } from '@/components/ui/select';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  deleteLocalModel,
  downloadLocalModel,
  getLocalTranscriptionStatus,
  localTranscriptionAvailable,
  onLocalTranscriptionStatus,
  prepareLocalTranscription,
  selectLocalEngine,
  selectLocalModel,
  setLocalTranscriptionEnabled,
  type LocalModelEntry,
  type LocalRecognizerEntry,
  type LocalTranscriptionEngine,
  type LocalTranscriptionStatus,
} from '@/lib/local-transcription';
import {
  deviceTtsAvailable,
  getDeviceTtsStatus,
  selectDeviceTtsEngine,
  selectDeviceTtsVoice,
  setDeviceTtsEnabled,
  type DeviceTtsStatus,
} from '@/lib/device-tts';

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** The engine in use, named first so it is clear which one transcribes. */
function summary(status: LocalTranscriptionStatus): string {
  if (status.enabled && status.engine === 'system') {
    const recognizer =
      status.recognizers?.find((entry) => entry.selected)?.label ??
      'system default';
    if (status.state === 'ready') {
      return `On · Android recognizer (${recognizer}). Dictation and Live Mode are transcribed by this service; depending on the language it may send audio to its provider (Romanian uses Google's online recognition).`;
    }
    if (status.state !== 'unsupported' && status.state !== 'disabled') {
      return `On · Android recognizer, but it is unavailable: ${status.error ?? 'unknown error'}`;
    }
  }
  if (status.enabled && status.state !== 'unsupported') {
    const model = status.model.label.replace(/\s*\(.*\)$/, '');
    switch (status.state) {
      case 'failed':
        return `On · ${model}, but the model is unavailable: ${status.error ?? 'unknown error'}`;
      case 'missing':
        return `On · ${model}, but the model is not downloaded yet.`;
      default:
        return `On · ${model}. Dictation and Live Mode are transcribed on this device; audio is never uploaded, and it works offline.`;
    }
  }
  switch (status.state) {
    case 'unsupported':
      return status.error ?? 'This device cannot run on-device transcription.';
    case 'disabled':
      return 'Off. Dictation and Live Mode send audio to CarapaBoard for transcription.';
    case 'failed':
      return `On, but the selected model is unavailable: ${status.error ?? 'unknown error'}`;
    case 'missing':
      return 'On, but the selected model is not downloaded yet.';
    default:
      return 'On. Dictation and Live Mode are transcribed on this device; audio is never uploaded, and it works offline.';
  }
}

function modelState(model: LocalModelEntry): string {
  if (model.phase === 'downloading') {
    return `Downloading ${Math.floor((model.progress ?? 0) * 100)}%`;
  }
  if (model.phase === 'verifying') return 'Verifying';
  if (model.phase === 'loading') return 'Loading';
  if (model.error) return 'Failed';
  if (model.loaded) return 'Active';
  return model.installed ? 'Downloaded' : 'Not downloaded';
}

const ENGINE_LABELS: Record<LocalTranscriptionEngine, string> = {
  whisper: 'Whisper',
  system: 'Android recognizer',
};

function speechSummary(status: DeviceTtsStatus): string {
  switch (status.state) {
    case 'unsupported':
      return status.error ?? 'This device has no text-to-speech engine.';
    case 'disabled':
      return "Off. Replies are spoken with CarapaBoard's server voices.";
    case 'fallback':
      return `On, but the last reply used the server voice: ${status.error ?? 'unknown error'}`;
    case 'failed':
      return `${status.enabled ? 'On, but the' : 'The'} text-to-speech engine is unavailable: ${status.error ?? 'unknown error'}`;
    default:
      return "On. Replies are spoken by this device's text-to-speech engine. The server voice is used only for a reply the device cannot speak.";
  }
}

function baseLanguage(tag: string): string {
  return tag.toLowerCase().split('-')[0]!;
}

function languageName(code: string): string {
  try {
    return (
      new Intl.DisplayNames(undefined, { type: 'language' }).of(code) ?? code
    );
  } catch {
    return code;
  }
}

/** Runs a setting change; failures surface as a toast. */
async function applyChange<T>(
  action: () => Promise<T>,
  failure: string,
  setBusy: (busy: boolean) => void,
  apply: (value: T) => void,
): Promise<boolean> {
  setBusy(true);
  try {
    apply(await action());
    return true;
  } catch (error) {
    toast.error(
      `${failure}: ${error instanceof Error ? error.message : error}`,
    );
    return false;
  } finally {
    setBusy(false);
  }
}

/** Settings that live on this device only; rendered in the Android app. */
export function ThisDeviceCard() {
  const [status, setStatus] = useState<LocalTranscriptionStatus | null>(null);
  const [speech, setSpeech] = useState<DeviceTtsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [speechBusy, setSpeechBusy] = useState(false);
  const [voiceLanguage, setVoiceLanguage] = useState<string | null>(null);
  useEffect(() => {
    if (!localTranscriptionAvailable()) return;
    let active = true;
    let unsubscribe: (() => void) | null = null;
    void getLocalTranscriptionStatus().then((initial) => {
      if (!active || !initial) return;
      setStatus(initial);
      unsubscribe = onLocalTranscriptionStatus((next) => {
        if (active) setStatus(next);
      });
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!deviceTtsAvailable()) return;
    let active = true;
    void getDeviceTtsStatus().then((initial) => {
      if (active && initial) setSpeech(initial);
    });
    return () => {
      active = false;
    };
  }, []);

  const voiceLanguages = useMemo(() => {
    const codes = [
      ...new Set((speech?.voices ?? []).map((v) => baseLanguage(v.language))),
    ];
    return codes
      .map((code) => ({ code, label: languageName(code) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [speech?.voices]);

  if (!status && !speech) return null;

  const shownLanguage =
    voiceLanguage ??
    [
      baseLanguage(navigator.language || 'en'),
      'ro',
      'en',
      voiceLanguages[0]?.code,
    ].find((code) => code && voiceLanguages.some((l) => l.code === code)) ??
    null;

  const refresh = async () => {
    const latest = await getLocalTranscriptionStatus();
    if (latest) setStatus(latest);
  };

  const run = (
    action: () => Promise<LocalTranscriptionStatus>,
    failure: string,
  ) => applyChange(action, failure, setBusy, setStatus);

  const runSpeech = (action: () => Promise<DeviceTtsStatus>, failure: string) =>
    applyChange(action, failure, setSpeechBusy, setSpeech);

  /** Downloads and loads the selected model in the background. */
  const prepare = async () => {
    const result = await prepareLocalTranscription();
    if (!result.ok && result.code !== 'cancelled') {
      toast.error(`Voice model unavailable: ${result.message}`);
    }
    await refresh();
  };

  const toggle = async () => {
    if (!status) return;
    const enable = !status.enabled;
    if (
      (await run(
        () => setLocalTranscriptionEnabled(enable),
        'Could not change setting',
      )) &&
      enable
    ) {
      void prepare();
    }
  };

  const use = async (model: LocalModelEntry) => {
    if (
      (await run(() => selectLocalModel(model.id), 'Could not select model')) &&
      status?.enabled
    ) {
      void prepare();
    }
  };

  const useEngine = async (
    engine: LocalTranscriptionEngine,
    recognizer?: LocalRecognizerEntry,
  ) => {
    if (
      (await run(
        () => selectLocalEngine(engine, recognizer?.id),
        'Could not select engine',
      )) &&
      engine === 'whisper' &&
      status?.enabled
    ) {
      void prepare();
    }
  };

  const download = (model: LocalModelEntry) => {
    void downloadLocalModel(model.id)
      .then(setStatus)
      .catch((error) => {
        if ((error as { code?: string }).code !== 'CANCELLED') {
          toast.error(`Download failed: ${error.message}`);
        }
        return refresh();
      });
  };

  const engine = status?.engine ?? 'whisper';
  const engineChoices = status?.engines
    ? (Object.keys(ENGINE_LABELS) as LocalTranscriptionEngine[])
    : [];
  const anyEngineSupported = engineChoices.some(
    (choice) => !status?.engines?.[choice]?.unsupported,
  );
  const shownVoices = (speech?.voices ?? []).filter(
    (voice) => baseLanguage(voice.language) === shownLanguage,
  );

  return (
    <Card data-ui="account-this-device">
      <CardContent className="p-6 space-y-4">
        <div className="space-y-1">
          <CardTitle className="text-base">This device</CardTitle>
          <p className="text-sm text-muted-foreground">
            Stored on this device only, so each phone or tablet can differ.
          </p>
        </div>

        {status && (
          <section className="space-y-3" data-ui="account-local-transcription">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium">On-device speech-to-text</p>
                <p
                  className="text-sm text-muted-foreground"
                  data-ui="account-local-transcription-status"
                  data-state={status.state}
                >
                  {summary(status)}
                </p>
              </div>
              {status.state !== 'unsupported' && (
                <Button
                  data-ui="account-local-transcription-toggle"
                  variant={status.enabled ? 'outline' : 'default'}
                  disabled={busy}
                  onClick={() => void toggle()}
                >
                  {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                  {status.enabled ? 'Turn off' : 'Turn on'}
                </Button>
              )}
            </div>

            {anyEngineSupported && (
              <div
                className="flex flex-wrap items-center gap-2"
                data-ui="account-local-transcription-engine"
                data-engine={engine}
              >
                <span
                  className="text-sm text-muted-foreground"
                  id="account-local-transcription-engine-label"
                >
                  Engine
                </span>
                <div
                  className="flex flex-wrap gap-2"
                  role="radiogroup"
                  aria-labelledby="account-local-transcription-engine-label"
                >
                  {engineChoices.map((choice) => {
                    const unsupported = status.engines?.[choice]?.unsupported;
                    const active = engine === choice;
                    return (
                      <Button
                        key={choice}
                        size="sm"
                        role="radio"
                        aria-checked={active}
                        variant={active ? 'default' : 'outline'}
                        data-engine-option={choice}
                        data-active={active}
                        title={unsupported ?? undefined}
                        disabled={busy || !!unsupported}
                        onClick={() => {
                          if (!active) void useEngine(choice);
                        }}
                      >
                        {active && <Check className="mr-1 size-4" />}
                        {ENGINE_LABELS[choice]}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}

            {engine === 'system' && status.state !== 'unsupported' && (
              <ul className="divide-y divide-border rounded-md border">
                {(status.recognizers ?? []).map((recognizer) => (
                  <li
                    key={recognizer.id}
                    data-ui="account-local-recognizer"
                    data-recognizer-id={recognizer.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm">{recognizer.label}</span>
                        {recognizer.selected && (
                          <Badge variant="secondary">Selected</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground break-all">
                        {recognizer.isDefault ? 'System default · ' : ''}
                        {recognizer.id.split('/')[0]}
                      </p>
                    </div>
                    {!recognizer.selected && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void useEngine('system', recognizer)}
                      >
                        Use
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {engine === 'whisper' && status.state !== 'unsupported' && (
              <ul className="divide-y divide-border rounded-md border">
                {status.models.map((model) => {
                  const working = !!model.phase;
                  return (
                    <li
                      key={model.id}
                      data-ui="account-local-model"
                      data-model-id={model.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm">{model.label}</span>
                          {model.selected && (
                            <Badge variant="secondary">Selected</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {megabytes(model.sizeBytes)} · {modelState(model)}
                          {model.error ? ` · ${model.error}` : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {!model.selected && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void use(model)}
                          >
                            Use
                          </Button>
                        )}
                        {!model.installed && !working && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => download(model)}
                          >
                            Download
                          </Button>
                        )}
                        {(model.installed || model.phase === 'downloading') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => deleteLocalModel(model.id),
                                'Could not delete model',
                              )
                            }
                          >
                            {model.phase === 'downloading'
                              ? 'Cancel'
                              : 'Delete'}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {speech && (
          <section className="space-y-3" data-ui="account-local-speech">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium">On-device text-to-speech</p>
                <p
                  className="text-sm text-muted-foreground"
                  data-ui="account-local-speech-status"
                  data-state={speech.state}
                >
                  {speechSummary(speech)}
                </p>
              </div>
              {speech.state !== 'unsupported' && (
                <Button
                  data-ui="account-local-speech-toggle"
                  variant={speech.enabled ? 'outline' : 'default'}
                  disabled={speechBusy}
                  onClick={() =>
                    void runSpeech(
                      () => setDeviceTtsEnabled(!speech.enabled),
                      'Could not change setting',
                    )
                  }
                >
                  {speechBusy && (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  )}
                  {speech.enabled ? 'Turn off' : 'Turn on'}
                </Button>
              )}
            </div>

            {speech.engines.length > 0 && (
              <ul className="divide-y divide-border rounded-md border">
                {speech.engines.map((engine) => (
                  <li
                    key={engine.id}
                    data-ui="account-local-speech-engine"
                    data-engine-id={engine.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm">{engine.label}</span>
                        {engine.selected && (
                          <Badge variant="secondary">Selected</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground break-all">
                        {engine.isDefault ? 'System default · ' : ''}
                        {engine.id}
                      </p>
                    </div>
                    {!engine.selected && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={speechBusy}
                        onClick={() =>
                          void runSpeech(
                            () => selectDeviceTtsEngine(engine.id),
                            'Could not select engine',
                          )
                        }
                      >
                        Use
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {voiceLanguages.length > 0 && shownLanguage && (
              <div className="space-y-2">
                <label className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    Voices for
                  </span>
                  <Select
                    data-ui="account-local-speech-language"
                    value={shownLanguage}
                    onValueChange={(nextValue) => setVoiceLanguage(nextValue)}
                  >
                    {voiceLanguages.map((language) => (
                      <SelectItem key={language.code} value={language.code}>
                        {language.label}
                      </SelectItem>
                    ))}
                  </Select>
                </label>
                {!shownVoices.some((voice) => voice.selected) && (
                  <p className="text-xs text-muted-foreground">
                    The engine's default voice is used until you choose one.
                  </p>
                )}
                <ul className="divide-y divide-border rounded-md border">
                  {shownVoices.map((voice) => (
                    <li
                      key={voice.id}
                      data-ui="account-local-speech-voice"
                      data-voice-id={voice.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3"
                    >
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                        <span className="text-sm break-all">{voice.label}</span>
                        {voice.selected && (
                          <Badge variant="secondary">Selected</Badge>
                        )}
                      </div>
                      {!voice.selected && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={speechBusy}
                          onClick={() =>
                            void runSpeech(
                              () =>
                                selectDeviceTtsVoice(voice.language, voice.id),
                              'Could not select voice',
                            )
                          }
                        >
                          Use
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
