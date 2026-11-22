# Android on-device transcription

The Android app can transcribe composer dictation and Live Mode phrases with
Whisper running entirely on the device. It is **off by default and enabled per
device**, not per account, so a tablet can transcribe locally while a phone
signed in to the same account keeps using server transcription.

## Behavior

- **Off (default), web, and iOS:** unchanged. The browser VAD streams PCM to
  `/api/live-voice/ws` (`carapa.live-stt.v2`) and the server transcribes.
- **On:** `useLiveVoice` never requests `/api/live-voice/config`, never opens
  the live-voice WebSocket, and never uploads audio. The same browser VAD
  commits phrases. Each committed 16 kHz mono phrase is sent to the native
  `CarapaWhisper` plugin in one call. Finals arrive in phrase order through the
  existing `onFinal` callback.
- Failures never fall back to the server. A model that is missing, failed or
  unloaded stops capture with a visible error. A failed phrase inference
  reports a recoverable error and capture continues. Stop in composer
  dictation commits the open phrase, waits for the pending phrases (the button
  shows a spinner) and inserts their text, so a short answer such as "yes"
  survives. A failure, or a phrase without words anywhere in the Stop queue
  (even one that returned just before Stop, with the other text kept), shows
  the dictation failure toast and dictation returns to idle, also when the
  server connection is closing or closes during Stop. With server STT, Stop
  waits for the server's results and gives up with that toast after 90 s
  without any (each result and the server's switch to CPU fallback restart the
  wait; the server allows 10 s for the GPU attempt, then 60 s per CPU request).
  Stop never waits longer than the worst case in the table below without a
  new result, then ends the same way and drops any late result. Each delivered
  result restarts that wait, so Stop with several pending phrases can take
  longer in total. Dictation accepts phrases with at least 150 ms of voiced
  audio (Live Mode keeps 300 ms): measured
  with Android-style 128-sample and 1024-sample blocks, a short "ja" has
  205-235 ms voiced audio, while taps, knocks and clicks stay below 150 ms or
  fail the speech-like check. Unmounting, switching conversation and sending
  the message cancel queued phrases, abort the running inference and drop any
  stale result.

  Longest wait of composer Stop per engine without a new result (the
  watchdog), not a total Stop duration. Every delivered result (including a
  blank or failed one) restarts the watchdog, so a queue of phrases is not cut
  off by one deadline. The constants are in `ui/src/hooks/use-live-voice.ts`.

  | Engine             | Worst case of one result (source)                                                                                                                                                                                                                    | Stop watchdog                                                   |
  | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
  | Server STT         | GPU attempt 10 s (`LIVE_STT_FINAL_TIMEOUT_MS`, `live-voice/streaming.ts`), then CPU fallback 60 s (`AbortSignal.timeout`, `whisper/transcriber.ts`) = 70 s; phrases run one after another; the fallback notice restarts the wait                     | `FINISH_STALL_TIMEOUT_MS` 90 s (20 s transport margin)          |
  | On-device Whisper  | 1 native call, no deadline of its own; 1.7 s typical, 7.4 s first after a model load                                                                                                                                                                 | `WHISPER_FINISH_STALL_TIMEOUT_MS` 60 s                          |
  | Android recognizer | `MAX_LANGUAGES` 3 x (1 attempt + 1 retry after a `TRANSIENT_ERRORS` failure) x (`TIMEOUT_MS` 30 s + 1 s writer join) = 186 s, then the server's transcript pick, cut off at 4 s (`TRANSCRIPT_CHOICE_TIMEOUT_MS`) = 190 s, all inside one native call | `SYSTEM_RECOGNIZER_FINISH_STALL_TIMEOUT_MS` 200 s (10 s margin) |

- **Record meeting** does not use on-device transcription, also when it is on
  for the device. Recording needs owner or editor access to the project (board
  admins excepted on projects they own or that have no owner; on someone
  else's project only their membership level counts); viewers do not get the
  control and the server refuses them. The meeting always records audio and
  uploads the audio chunks to the server, which transcribes them and keeps the
  recording. Failures, including another voice feature taking the microphone
  or a failed save of the transcript file (the text stays in the panel),
  appear in the meeting panel. Starting the board session and saving the
  transcript need the server.
- Language: dictation uses the account's dictation language and caches the
  last value so dictation works offline. Live Mode uses automatic detection,
  as the server does when `LIVE_STT_LANGUAGE` is empty. On the device, a fixed
  language L is sent to Whisper as `L,en`: each phrase is transcribed as L or
  English, whichever is more likely. Whisper given only L tends to translate
  English speech into L. English and Auto-detect are passed unchanged.
- When the feature is on and the selected model is installed, the app loads
  the model and runs one silent warm-up inference in the background at
  startup. The first inference after a load is otherwise several times slower
  (7.4 s versus 1.7 s for large-v3 turbo), which queued phrases behind it and
  made Stop wait for the text.

## This device settings

**Account → Devices → This device** holds settings stored on the device only:

- **Turn on / Turn off** switches on-device speech-to-text. Turning it on
  downloads and loads the selected model. Turning it off frees memory and
  returns the device to server transcription; downloaded models are kept.
- The model list shows each pinned model's size and state. **Use** selects a
  model (and downloads it when the feature is on), **Download** fetches one
  ahead of time, **Cancel** stops a download, and **Delete** removes a
  downloaded model. Selecting another model while a model is still
  downloading or loading makes the pending preparation continue with the newly
  selected model before dictation starts.
- If the selected model is missing when dictation or Live Mode starts, the
  download starts from there and its progress appears as a toast.
- **Engine** switches between **Whisper** (the models above) and **Android
  recognizer**, which lists the device's speech recognition services
  (**Use** selects one; the system default is preselected).
- **On-device text-to-speech** has its own **Turn on / Turn off** (off by
  default), the device's TTS engines, and the installed offline voices per
  language. See [On-device text-to-speech](#on-device-text-to-speech).

## Android recognizer engine

The same committed 16 kHz phrases are streamed to the selected
`RecognitionService` through `RecognizerIntent.EXTRA_AUDIO_SOURCE` in a
segmented session (`SystemSpeechRecognizer.kt`), so the service never opens
the microphone. It needs Android 13. Each phrase gets 0.3 s of silence on both
sides; without it Google's recognizer drops the last word of tightly cut
phrases ("Da sigur" → "da").

Google's recognizer understands only the language it is asked for: an English
phrase under `ro-RO` comes back empty, Romanian under `en-US` comes back empty
or as English nonsense, and its multi-language extras
(`EXTRA_ADDITIONAL_LANGUAGES`, `EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES`)
had no effect on the tablet. So the language comes from the account
dictation language, which Live Mode also uses with this engine (Whisper keeps
detecting the language itself):

- **A chosen language** (e.g. Romanian) is recognized alone, without Jev.
- **Auto-detect** recognizes the phrase in each language set in Android (at
  most 3). When more than one transcript has text, the wrong-language one is
  phonetic nonsense ("buona ziwa to mifacts"), and Google's confidence scores
  rate it as high as the right one, so the app asks
  `POST /api/live-voice/transcript-choice`, where Jev rates each transcript on
  its own as a meaningful phrase and the best one wins (asking Jev to pick
  between them favoured whichever was listed first). Without Jev the first
  transcript with text is used. This costs a second recognition plus about
  0.13 s.

A transient service error is retried once. A language that fails or does not
answer within 30 s is skipped, and the phrase keeps the transcripts of the
other languages. The Live Mode panel shows the
listening language next to the microphone button (`Auto` or a language code;
hovering names the engine).

Unlike Whisper, a recognizer may send audio to its provider. On the Lenovo
tablet Google's offline recognizer has no Romanian, so Romanian goes to
Google's online recognition. Measured there with one 5.8 s Romanian phrase:
Google ~1.4–2.0 s, plain Romanian correct but "Pull request-ul" garbled;
Whisper turbo exact. Android System Intelligence rejects Romanian, and the
Qualcomm and Claude services fail with audio-source input. The app must be in
the foreground (microphone permission is checked by the service).

## On-device text-to-speech

When on, every native playback path (manual replay, Live Mode, and
push-triggered background playback) gets
`GET /api/native/tts/conversations/:cid/messages/:mid/text` (same device
signature, access and Live session checks as the audio route): the server's
normalized speech text without Supertonic expression tags, and its language.
`DeviceTts.kt` synthesizes it with the selected engine and voice. A Live
reply is synthesized piece by piece: the first piece (up to about 80
characters, whole sentences) is queued as soon as it is ready and the rest
are appended while it plays, so speech starts after one sentence instead of
the whole reply. The pieces play as one reply: one `started` and one
`completed` acknowledgement. A manual replay is synthesized whole into
`cacheDir/tts/<cid>-<mid>.device.wav`. The Media3 queue, acknowledgements and
stop otherwise behave as for server audio. The WebView paths (Live narration and plain
text playback) use `CarapaDeviceTts.synthesize`.

Both the device voice and the server's Supertonic voice speak the language the
text is written in: the server asks Jev (`src/modules/tts/language-detect.ts`)
to choose among the persona's language, `TTS_LANG` and `TTS_DETECT_LANGUAGES`
(limited to languages Supertonic speaks), and keeps the persona's language
when Jev is not configured, fails, or is refused by the project's privacy
mode. Jev leans towards the languages listed first, so short English such as
"Identity answer" scored about 0.5 behind a Romanian persona's language: when
it is under 80% sure, the most likely language other than the persona's is
used only if Jev confirms it in a separate yes/no question ("Is this text
written in English?"), else the persona's language is kept. Persona replies,
Live narration, plain text playback and voice previews use it; it adds about
0.07 s, or 0.13 s when the answer is confirmed.
Speech already generated for a message keeps its language. A persona's Supertonic voice is not used, so personas with the same
language sound alike on a device.
**Admin → AI users → Android voice** (Android app only) previews the preview
text with this device's voice for the persona's language, whether or not the
setting is on; nothing is saved on the persona, because devices have
different voices.

If the engine does not start, has no installed voice for the language, fails,
or takes over 15 s per 1000-character piece, that message uses the server
audio, and the reason appears in the status line ("On, but …"). A Live
reply that fails after its first piece has played ends early instead. Device speech
is never acknowledged as `failed` for these reasons.

When Persona Live Mode is started (or kept alive by the heartbeat) from an
Android device with this setting on, the run records `leader_device_speech`
and the server does not synthesize Supertonic audio for its replies: each
queue item is released as soon as the reply exists, without an asset. The
device reports the reply's length with its playback-start acknowledgement
(estimated from the first piece's speaking rate while the rest is still being
synthesized) and the server paces the queue by it; a released device item waits up to 20 s for
the device to start it (instead of 2.5 s). Only if the device cannot speak a
reply does its fallback request make the server synthesize that one reply.

## Runtime

| Item         | Value                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine       | whisper.cpp v1.9.5, CPU only, fetched by CMake with source SHA-256 `ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720` (`ui/android/app/src/main/cpp/CMakeLists.txt`)                                                                    |
| ABI          | `arm64-v8a`, built for `armv8.2-a+dotprod+fp16`, always `-O3` (also in debug APKs). Other ABIs and CPUs without these extensions report `unsupported`.                                                                                                  |
| NDK / CMake  | NDK `28.2.13676358`, CMake `3.22.1` (Gradle installs both on first build)                                                                                                                                                                               |
| Model source | `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/<id>.bin` (pinned repository commit)                                                                                                                     |
| Storage      | App-private `files/whisper-models/`, removed on uninstall or app-data clear. Models are never committed to git or bundled in the APK.                                                                                                                   |
| Threads      | `min(6, cores)`: the six performance cores of a Snapdragon 8 Gen 3                                                                                                                                                                                      |
| Patch        | `ui/android/app/src/main/cpp/whisper-carapa.patch`, applied when CMake fetches whisper.cpp: language detection uses the phrase-sized window and its encoder pass is reused for transcription, and a `ro,en` list restricts detection to those languages |
| Audio window | Encoder window sized to the phrase plus 2.5 s, at least 512 positions (about 10 s) and at most 1500 (30 s)                                                                                                                                              |

### Model catalog

| ID                          | Size (bytes) | SHA-256                                                            |
| --------------------------- | -----------: | ------------------------------------------------------------------ |
| `ggml-base-q5_1`            |   59,707,625 | `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898` |
| `ggml-small-q5_1` (default) |  190,085,487 | `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb` |
| `ggml-large-v3-turbo-q8_0`  |  874,188,075 | `317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1` |

Provisioning streams the download into `<id>.part` and hashes it as it
arrives. The file is renamed to `<id>.bin` only when the size and SHA-256
match the pinned values. An interrupted, cancelled, oversized or mismatched
download is deleted and never becomes usable, and the next attempt starts from
scratch. A verified file that whisper.cpp still cannot load is deleted so that
a retry downloads it again. Files not in the catalog (superseded models, stray
partial downloads) are removed when the app starts. Captured audio and
inference state stay in memory; only models are persisted. Downloads run on
their own thread, so a large download never delays transcription with an
installed model.

## Changing the catalog

The catalog is defined in one place: `WhisperModels` in
`ui/android/app/src/main/java/ai/carapa/board/WhisperModelStore.kt`. The
bridge and the JavaScript code receive it through `getStatus`. To add or
replace a model:

1. Use the pinned repository commit, not `main`. Hugging Face reports each LFS
   file's SHA-256 as its `X-Linked-Etag`. Confirm it by downloading the file
   and running `sha256sum`.
2. Edit the catalog (and `DEFAULT_ID` if needed), then bump `versionCode` in
   `ui/android/native-shell-version.json`.

## Measurements (Lenovo Yoga Tab Plus, 2026-10-16)

Lenovo TB520FU, Snapdragon 8 Gen 3 (SM8650), Android 16. Five synthesized
Romanian phrases of 4.1 to 4.7 s each, some containing English technical
terms. Times are median native inference per phrase with the Romanian hint.

| Model               | CPU (shipped) | Adreno 750 GPU (OpenCL, not shipped) | Accuracy on the test phrases                                       |
| ------------------- | ------------: | -----------------------------------: | ------------------------------------------------------------------ |
| small q5_1          |        ~1.3 s |                                ~82 s | Plain Romanian mostly right; English terms garbled ("docher")      |
| large-v3 turbo q8_0 |        ~1.9 s |                               ~8.3 s | Near-perfect, including "pull request-ul", "Docker" and diacritics |
| large-v3 turbo q5_0 |          ~7 s |                                    — | Same as q8_0; replaced by q8_0                                     |

- Language detection: unpatched, auto-detect encoded a full 30 s window and
  then encoded the phrase again (about 3.5 to 4 s for turbo). With the patch,
  turbo takes about 1.8 s with `ro`, 2.0 s with `ro,en` and 2.1 s with
  `auto`.
- The 8-bit turbo is about 3.5x faster than the 5-bit one on this CPU, with
  the same output. Building with `i8mm` added only about 4%, so the build
  stays at `armv8.2-a+dotprod+fp16` and older arm64 devices remain supported.
- ggml's OpenCL backend did detect the Adreno 750 and run there, but it was
  4x (turbo) to 60x (small) slower than the CPU. It also needed a workaround
  for a null-context crash during model load. Whisper therefore stays CPU-only.
- With the full 30 s window, small took about 5.2 s per phrase. A window sized
  only to the phrase (below 10 s) dropped characters, hence the 512-position
  minimum.
- The 8-bit turbo loads in about 0.6 s on the CPU. Downloading it took about
  30 s over the tablet's Wi-Fi, and the small model took 9 s.

## Device validation

The automated check is the local-routing case in
`ui/src/hooks/use-live-voice.vitest.tsx`. It verifies that no server STT call
is made, that the final is delivered, and that stale results are dropped after
stop. Model provisioning and native inference are validated on the target
device:

1. `ui/android/install-apk.sh` with the tablet attached over USB.
2. Turn the feature on in Account → Devices and wait for the download.
3. Dictate Romanian and mixed Romanian/English technical phrases in composer
   dictation and Live Mode.
4. Repeat with Wi-Fi and mobile data off. Confirm logcat shows no
   `/api/live-voice` requests.
5. Collect latency from logcat: `adb logcat -s CarapaWhisper Capacitor/Console`.
   - `CarapaWhisper: phrase N ms audio -> M ms inference` is the native time.
   - `[carapa-local-stt] end-of-speech to final N ms` is the latency the user
     experiences.
