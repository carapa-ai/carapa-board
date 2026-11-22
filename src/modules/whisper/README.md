# Whisper Module

## Overview

Optional audio transcription module. Converts voice messages (from WhatsApp or other sources) to text using OpenAI Whisper or Groq-compatible APIs.

## How it works

- Enabled when `WHISPER_API_KEY` (or its secret file) or an explicit `WHISPER_API_URL` is configured
- On init, registers a `Transcriber` function via the `transcriber` singleton in `index.ts`
- Core code (`src/lib/media-processor.ts`, live voice and `src/routes/meetings.ts`) calls `getTranscriber()` — returns `null` when disabled, the transcription function when enabled
- Integration pattern: **singleton getter**

## Files

| File             | Purpose                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `index.ts`       | `CarapaModule` implementation — sets/clears the transcriber singleton        |
| `config.ts`      | Reads `WHISPER_API_URL`, `WHISPER_MODEL`, `WHISPER_API_KEY` from env/secrets |
| `transcriber.ts` | Actual HTTP call to the Whisper API endpoint                                 |

## Environment variables

| Variable            | Default                                          | Description                                                                                                                                                            |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHISPER_API_URL`   | `https://api.openai.com/v1/audio/transcriptions` | Transcription endpoint. Override to use Groq: `https://api.groq.com/openai/v1/audio/transcriptions`                                                                    |
| `WHISPER_MODEL`     | `whisper-1`                                      | Model name. Use `whisper-large-v3` for Groq                                                                                                                            |
| `WHISPER_API_KEY`   | _(none)_                                         | API key for the transcription service. Read from `$SECRETS_DIR/whisper_api_key` or env var. Not needed for local endpoints                                             |
| `WHISPER_LANGUAGE`  | _(none)_                                         | Global fallback ISO-639-1 hint when a meeting uses **Auto-detect**                                                                                                     |
| `WHISPER_PROMPT`    | _(none)_                                         | Global fallback Whisper prompt when a meeting language has no per-language prompt                                                                                      |
| `MEETING_LANGUAGES` | _(built-in default)_                             | Comma-separated meeting language picker entries. Format: `code\|label[\|script[\|prompt]]`. Script: `latin`, `cyrillic`, or `any`. Served to the UI via `/api/config`. |

## Disabling

Unset `WHISPER_API_KEY` and `WHISPER_API_URL` and remove the `whisper_api_key` secret. Voice messages will get a placeholder text instead of transcription.
