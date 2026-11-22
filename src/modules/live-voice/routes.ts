import { Router } from 'express';
import multer from 'multer';
import { getTranscriber } from '../whisper/index.js';
import { WHISPER_CONFIGURED, WHISPER_MODEL } from '../whisper/config.js';
import {
  getLiveVoiceMetrics,
  LIVE_VOICE_METRICS,
  recordLiveVoiceMetric,
} from './telemetry.js';
import { chooseTranscript } from './transcript-choice.js';
import {
  LIVE_STT_PROTOCOL,
  LIVE_STT_SAMPLE_RATE,
  LIVE_STT_API_URL,
  LIVE_STT_LANGUAGE,
} from './config.js';

const MAX_UTTERANCE_BYTES = 4 * 1024 * 1024;
const MAX_UTTERANCE_BASE64_LENGTH = Math.ceil(MAX_UTTERANCE_BYTES / 3) * 4;

export interface LiveVoiceRouteDeps {
  transcriber?: typeof getTranscriber;
  transcriptionConfigured?: boolean;
}

/** HTTP contract used by the browser before it opens the local STT socket. */
export function getLiveVoiceRouter(deps: LiveVoiceRouteDeps = {}): Router {
  const router = Router();
  const resolveTranscriber = deps.transcriber ?? getTranscriber;
  const transcriptionConfigured =
    deps.transcriptionConfigured ?? WHISPER_CONFIGURED;
  router.get('/live-voice/config', (_req, res) =>
    res.json({
      transcriptionConfigured:
        transcriptionConfigured && Boolean(resolveTranscriber()),
      model: WHISPER_MODEL,
      sampleRate: LIVE_STT_SAMPLE_RATE,
      utteranceTransport: 'json-base64-v1',
      streamingConfigured: Boolean(LIVE_STT_API_URL),
      streamingTransport: LIVE_STT_PROTOCOL,
      websocketPath: '/api/live-voice/ws',
      language: LIVE_STT_LANGUAGE || 'auto',
    }),
  );
  const audio = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UTTERANCE_BYTES },
  });
  router.post(
    '/live-voice/utterance',
    audio.single('audio'),
    async (req: any, res) => {
      if (!req.authUser)
        return res.status(401).json({ error: 'authentication required' });
      const transcriber = resolveTranscriber();
      if (!transcriptionConfigured || !transcriber)
        return res.status(503).json({
          error: 'Voice input unavailable: configure local transcription',
        });
      let buffer: Buffer | undefined = req.file?.buffer;
      let mimetype = req.file?.mimetype || 'audio/wav';
      let filename = req.file?.originalname || 'utterance.wav';
      if (!buffer && typeof req.body?.audioBase64 === 'string') {
        if (req.body.audioBase64.length > MAX_UTTERANCE_BASE64_LENGTH)
          return res.status(413).json({ error: 'audio utterance too large' });
        buffer = Buffer.from(req.body.audioBase64, 'base64');
        if (buffer.length > MAX_UTTERANCE_BYTES)
          return res.status(413).json({ error: 'audio utterance too large' });
        mimetype =
          typeof req.body.mimetype === 'string' ? req.body.mimetype : mimetype;
        filename =
          typeof req.body.filename === 'string' ? req.body.filename : filename;
      }
      if (!buffer?.length) {
        const bodyKind = Array.isArray(req.body) ? 'array' : typeof req.body;
        const bodyKeys =
          req.body && typeof req.body === 'object'
            ? Object.keys(req.body).slice(0, 8)
            : [];
        return res.status(400).json({
          error: 'audio utterance required',
          diagnostic: {
            contentType: req.get('content-type') || null,
            contentLength: req.get('content-length') || null,
            bodyKind,
            bodyKeys,
            hasMultipartFile: Boolean(req.file),
            transport: 'json-base64-v1',
          },
        });
      }
      try {
        const text = await transcriber(buffer, mimetype, filename);
        return res.json({
          outcome: text.trim() ? 'transcribed' : 'empty',
          text: text.trim(),
        });
      } catch (error) {
        return res.status(502).json({
          error:
            error instanceof Error ? error.message : 'Transcription failed',
        });
      }
    },
  );
  // On-device Android recognition yields one transcript per language;
  // return the one the user really said (see transcript-choice).
  router.post('/live-voice/transcript-choice', async (req: any, res) => {
    if (!req.authUser)
      return res.status(401).json({ error: 'authentication required' });
    const raw = req.body?.candidates;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4)
      return res
        .status(400)
        .json({ error: 'candidates must list 1-4 transcripts' });
    const candidates = raw.map((candidate: any) => ({
      language: String(candidate?.language ?? '').slice(0, 35),
      text: String(candidate?.text ?? '').slice(0, 2_000),
    }));
    const projectId =
      typeof req.body?.projectId === 'string' ? req.body.projectId : undefined;
    return res.json(await chooseTranscript(candidates, projectId));
  });

  router.get('/live-voice/metrics', (req: any, res) => {
    if (!req.authUser)
      return res.status(401).json({ error: 'authentication required' });
    return res.json(getLiveVoiceMetrics());
  });
  router.post('/live-voice/metrics', (req, res) => {
    if (!(req as any).authUser)
      return res.status(401).json({ error: 'authentication required' });
    const metric = req.body?.metric;
    if (
      !(LIVE_VOICE_METRICS as readonly unknown[]).includes(metric) ||
      typeof req.body?.value !== 'number' ||
      !Number.isFinite(req.body.value) ||
      req.body.value < 0
    )
      return res.status(400).json({ error: 'invalid metric' });
    recordLiveVoiceMetric(metric, req.body.value, { source: 'browser' });
    return res.status(204).end();
  });
  return router;
}
