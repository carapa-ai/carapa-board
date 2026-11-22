# Live Mode voice transcription

Composer dictation and Live Mode share a continuous 16 kHz PCM stream. The
browser uses adaptive VAD, a 200 ms pre-roll, 250 ms trailing silence, and a
14.5-second phrase bound, so pre-roll and phrase stay within the server's
15-second PCM limit. It sends binary PCM through the authenticated,
same-origin `/api/live-voice/ws` endpoint; only stable phrase finals are shown.
Captured PCM is retained in memory until the phrase resolves and is never
persisted.

Set `LIVE_STT_API_URL` to the internal Speaches
`/v1/audio/transcriptions` endpoint and `LIVE_STT_MODEL` to its faster-whisper
model. `LIVE_STT_LANGUAGE` is optional; when empty, language detection remains
automatic. The browser is the only phrase-boundary detector, so committed WAVs
go directly to the resident GPU model without a second server-side VAD delay.

The existing `WHISPER_API_URL` upload transcriber becomes the CPU path only if
the GPU request fails or reaches its session watchdog. Once that happens, the
whole dictation session remains on CPU; GPU and CPU results are never mixed per
phrase. Ordinary audio uploads, WhatsApp voice notes, meetings, and
`/api/live-voice/utterance` keep their existing behavior.

The browser protocol is `carapa.live-stt.v2`: `start`, binary PCM frames,
`commit { utteranceId }`, and `stop` flow upstream; `ready`, ordered `final`,
and recoverable/non-recoverable `error` events flow back. WebSocket clients
must use the existing one-time `/api/ws-ticket` authentication.
