/**
 * TTS HTTP routes (mounted under /api by the module loader).
 *
 *   POST /api/tts/synthesize  → one-shot, returns raw audio bytes (e.g. a
 *                               "play" button on a chat message).
 *   POST /api/tts/stream      → pseudo-streaming NDJSON: one JSON line per
 *                               chunk as it is synthesized, so the app starts
 *                               playing chunk 0 while later chunks render.
 *
 * Auth: these run behind the same global /api middleware as other module
 * routers (req.authUser is populated upstream).
 */

import { Router } from 'express';
import { logger } from '../../logger.js';
import { canAccessProject } from '../../routes/_helpers.js';
import { getGroupByFolder } from '../../state-manager.js';
import {
  synthesizeStream,
  formatToMime,
  type SynthOptions,
} from './synthesizer.js';
import { synthesizeCached } from './cache.js';
import { prepareForTts } from './normalizer.js';
import { detectSpeechLanguage } from './language-detect.js';
import { TTS_FORMATS, TTS_LANG, type TtsFormat } from './config.js';
import { recordLiveVoiceMetric } from '../live-voice/telemetry.js';

function parseOpts(body: Record<string, unknown>): SynthOptions {
  const opts: SynthOptions = {};
  if (typeof body.voice === 'string') opts.voice = body.voice;
  if (typeof body.lang === 'string') opts.lang = body.lang;
  if (typeof body.steps === 'number' && Number.isFinite(body.steps))
    opts.steps = body.steps;
  if (typeof body.speed === 'number' && Number.isFinite(body.speed))
    opts.speed = body.speed;
  if (
    typeof body.format === 'string' &&
    (TTS_FORMATS as string[]).includes(body.format)
  ) {
    opts.format = body.format as TtsFormat;
  }
  return opts;
}

async function accessibleProjectId(
  projectId: unknown,
  user: Parameters<typeof canAccessProject>[0],
): Promise<string | undefined> {
  return typeof projectId === 'string' &&
    projectId &&
    getGroupByFolder(projectId) &&
    (await canAccessProject(user, projectId, { min: 'viewer' }))
    ? projectId
    : undefined;
}

/** The text's own language when `detectLanguage: true`, else `requested`. */
async function resolveSpeechLanguage(
  text: string,
  requested: string,
  body: Record<string, unknown>,
  projectId?: string,
): Promise<string> {
  if (body.detectLanguage !== true) return requested;
  return (
    (await detectSpeechLanguage(text, [requested, TTS_LANG], projectId)) ??
    requested
  );
}

/**
 * Synthesis options; with `detectLanguage: true` the voice speaks the language
 * the text is written in (see language-detect), else the requested one.
 */
async function synthOptions(
  text: string,
  body: Record<string, unknown>,
  user: Parameters<typeof canAccessProject>[0],
): Promise<SynthOptions> {
  const opts = parseOpts(body);
  if (body.detectLanguage === true)
    opts.lang = await resolveSpeechLanguage(
      text,
      opts.lang || TTS_LANG,
      body,
      await accessibleProjectId(body.projectId, user),
    );
  return opts;
}

export function getTtsRouter(): Router {
  const router = Router();

  // One-shot synthesis → raw audio bytes.
  router.post('/tts/synthesize', async (req: any, res) => {
    try {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return res.status(400).json({ error: 'text is required' });
      const result = await synthesizeCached(
        text,
        await synthOptions(text, req.body || {}, req.authUser),
      );
      res.setHeader('Content-Type', formatToMime(result.format));
      res.setHeader('X-Audio-Duration', (result.durationMs / 1000).toFixed(3));
      if (result.assetId) res.setHeader('X-TTS-Asset-Id', result.assetId);
      res.setHeader('X-TTS-Cache', result.cacheHit ? 'hit' : 'miss');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(result.audio);
    } catch (err: any) {
      recordLiveVoiceMetric('failed_tts_calls', 1, { endpoint: 'synthesize' });
      logger.warn({ err }, 'tts synthesize failed');
      return res
        .status(502)
        .json({ error: err?.message || 'TTS synthesis failed' });
    }
  });

  // Pseudo-streaming synthesis → NDJSON, one line per chunk as it lands.
  // Each line: { index, total, text, audioBase64, format, durationMs, last }.
  router.post('/tts/stream', async (req: any, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering so chunks flush

    try {
      const opts = await synthOptions(text, req.body || {}, req.authUser);
      await synthesizeStream(text, opts, (chunk) => {
        res.write(JSON.stringify(chunk) + '\n');
      });
      return res.end();
    } catch (err: any) {
      recordLiveVoiceMetric('failed_tts_calls', 1, { endpoint: 'stream' });
      logger.warn({ err }, 'tts stream failed');
      if (!res.headersSent) {
        return res
          .status(502)
          .json({ error: err?.message || 'TTS stream failed' });
      }
      // Mid-stream failure: terminate with a trailing error line.
      res.write(
        JSON.stringify({ error: err?.message || 'TTS stream failed' }) + '\n',
      );
      return res.end();
    }
  });

  // Normalize a raw assistant reply into speech-ready sentences (LLM pass with
  // graceful fallback to plain sentence splitting). The client then synthesizes
  // each returned sentence in order (pseudo-streaming).
  router.post('/tts/prepare', async (req: any, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    const lang =
      typeof req.body?.lang === 'string' && req.body.lang
        ? req.body.lang
        : TTS_LANG;
    try {
      const projectId = await accessibleProjectId(
        req.body?.projectId,
        req.authUser,
      );
      // Device voices ask for the text's own language (see language-detect).
      const language = await resolveSpeechLanguage(
        text,
        lang,
        req.body,
        projectId,
      );
      const result = await prepareForTts(text, language, projectId);
      return res.json({ ...result, language });
    } catch (err: any) {
      logger.warn({ err }, 'tts prepare failed');
      return res
        .status(502)
        .json({ error: err?.message || 'TTS prepare failed' });
    }
  });

  return router;
}
