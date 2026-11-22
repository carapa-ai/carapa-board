# Live Mode test and observability runbook

Live Mode must use local services. Set `LIVE_STT_API_URL` to the internal
Speaches HTTP transcription endpoint (normally
`http://whisper-realtime:8080/v1/audio/transcriptions`) and set `LIVE_STT_MODEL` to the
resident faster-whisper model. Leave `LIVE_STT_LANGUAGE` empty for multilingual
automatic detection. Keep `WHISPER_API_URL` pointed at the CPU Speaches upload
endpoint: CarapaBoard converts retained PCM to WAV and uses it automatically if
the GPU connection or inference fails. The API key may be empty. TTS is the
local `/api/tts/synthesize` endpoint.

The `/api/live-voice/utterance` upload endpoint accepts multipart audio and
`json-base64-v1` audio. Both transports limit audio to 4 MiB per utterance.

An audio-capable runtime may be selected through `defaults.transcription` in
`data/board_agents.jsonc`. Live Mode uses it when the conversation model cannot
consume audio directly and falls back to Whisper if it fails or returns an
invalid transcript.

Run `bun test src/live-mode-e2e.test.ts` for the scenario suite,
and `bun test src/modules/live-voice/streaming.test.ts` for WebSocket/fallback
behavior.
Run `bun run typecheck`, `cd ui && npm run typecheck`, the UI build, and
`docker compose config` in your speech-service deployment before a release.

Structured `live voice metric` logs additionally expose stream connection
latency, GPU fallback counts, upstream failures, duplicate/late suppression,
out-of-order buffering, and final latency tagged by `gpu` or `cpu-fallback`.
Alert when audio-cutoff p95 is >=150 ms (browser API
limits apply) or warm final STT p95 is >=1.2 s on the recommended local GPU.

Operational acceptance:

1. Start your Speaches deployment and warm the configured transcription model
   before testing. Adapt service names below to your Compose configuration.
2. Confirm CUDA visibility with `docker compose exec whisper-realtime nvidia-smi`.
3. Dictate warm 2–10 second phrases in a browser and Android WebView and check
   final-latency metrics.
4. Stop `whisper-realtime` during a phrase and confirm one ordered
   `cpu-fallback` final is delivered without an audio attachment.

## Live Mode kinds

The selector next to the Live Mode toggle sets what the agent produces:

- **Persona · full replies** (`personas`): the main or invited persona writes
  complete replies. Each reply is synthesized and spoken in turn, and its text
  is revealed as it plays. The agent does not emit `[[live: ...]]` markers.
- **Work · short narration** (`work`): the agent works normally and emits short
  `[[live: ...]]` narration markers that are spoken while it works.

When a `personas` run is active, every persona turn — the main persona and each
invited persona that speaks — receives the spoken-reply instruction
`PERSONA_LIVE_VOICE_INSTRUCTION` from `src/modules/chat/live-activity.ts`
("LIVE VOICE MODE IS ON: …") in its system prompt or per-turn instructions
instead of the `LIVE MODE IS OFF` notice: the reply is read aloud, so it must
answer in the user's language in 1-4 short spoken sentences with no markdown,
headings, lists, code, links or file paths unless asked. `[[live: ...]]`
markers remain Work-only — the voice instruction itself forbids them. When
Persona Live Mode is switched off in the same conversation, the next persona
turn drops the voice instruction and gets the regular `LIVE MODE IS OFF`
notice again; persistent sessions do not keep the voice rule.

On web, the spoken reply's words appear in step with the audio. While a clip
plays, `ui/src/lib/use-tts.ts` reports `audio.currentTime / audio.duration` to
the `live-persona-reveal` store (`ui/src/lib/live-persona-reveal.ts`) on every
animation frame, and the message bubble renders the reply through the
live-reveal markdown plugin in `ui/src/components/markdown-content.tsx`, which
wraps each word in a `span[data-ui="live-voice-reveal-word"]` and hides the
words beyond `floor(totalWords × progress)`. A row whose reveal is still
pending is never handed to the deferred-markdown placeholder
(`ui/src/components/markdown-content-lazy.tsx`), which would otherwise paint
the full text at once — so the reveal paces the words whether the speaking row
is the last row in the transcript and on screen or not. Once the reveal is
released, the row defers like any other old row again (the full text is
supposed to be visible by then). To check it: in the UI
sandbox with a stub TTS clip of known duration, start Persona Live Mode with a
main persona, send a prompt, and count the visible `live-voice-reveal-word`
spans at ~25/50/75/100 % playback — at 50 % roughly half the words should be
visible, and the full text must stay visible after the clip ends (released).
Repeat for a later reply in the same chat and with the speaking row not being
the last row of the transcript.

Persona needs a main persona or at least one invited persona on the chat. With
neither, "Live Mode · Persona" (composer menu and kind selector) is disabled
with the hint "Select a main persona to use Persona Live Mode", and a stored
`personas` kind resolves to `work`. "Live Mode · Work" is always available.

Stopping Live Mode ("Stop Live Mode") means silence now: the current reply
clip, queued and prepared clips, and Android native speech are cut on the
device immediately, and the cut reply's text is shown in full instead of
spinning. The server-side stop (lookahead cancellation plus the durable stop
signal) is unchanged.

While a reply plays, the microphone treats speech as possible speaker echo:
it only barges in when a frame is louder than max(0.05, 2.5 × the recent
playback level, which decays with a 1.5 s half-life). After the audio ends, a
600 ms tail (`REPLY_AUDIO_TAIL_MS`) keeps that guard for the room reverb; once
the tail elapses, the VAD noise floor learned during playback is reset, so
speech is heard again from its first word — there is no multi-second deaf
period after a long reply.

Troubleshooting a reply stuck on "Preparing voice…":

1. Open the Live queue state of the conversation (`conversation_live_queue_items`)
   and check the item of the stuck reply. Every registered reply is synthesized
   as soon as its message is saved, whether or not it is current yet; the
   talking stick only decides playback order. A current item stuck in `ready`
   (or a null current with pending items) means the queue transition was lost —
   restarting the board recovers it via `recoverLiveQueues`. A `failed` item
   with a paused run points at voice generation.
2. Check the server log for TTS errors and confirm the TTS service is
   reachable. A synthesis failure fails the item, pauses the run, and releases
   the client bubble.
3. The client releases a reply whose voice preparation has run for 120 s
   without finishing and shows its text (heartbeat queue snapshots do not
   restart this countdown). If voice arrives later it still plays over the
   visible text.
4. Stop and restart Live Mode to clear a paused run.
