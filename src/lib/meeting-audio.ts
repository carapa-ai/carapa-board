/**
 * Audio helpers for meeting recording transcription.
 *
 * MediaRecorder chunks are appended to one container file (the "spool") that
 * lives for the session. Each Whisper call uses ffmpeg to extract only the
 * *next* time window (-ss / -t) so we never re-transcribe audio that was
 * already processed. All ffmpeg/ffprobe work is async with a hard timeout so a
 * long or hung run never blocks the event loop.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../logger.js';

const FFPROBE_TIMEOUT_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 120_000;
const MAX_CAPTURED_BYTES = 64 * 1024;

/** Growing on-disk copy of a session's recording, appended to per flush. */
export interface AudioSpool {
  dir: string | null;
  file: string | null;
  /** How many of the session's `all_chunks` are already in `file`. */
  chunks: number;
}

export function createAudioSpool(): AudioSpool {
  return { dir: null, file: null, chunks: 0 };
}

/** Full recording blob (all MediaRecorder chunks in capture order). */
export function buildFullRecordingBlob(chunks: Buffer[]): Buffer | null {
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks);
}

/** Delete the spool's temp directory; the spool can be rebuilt afterwards. */
export async function removeAudioSpool(spool: AudioSpool): Promise<void> {
  const dir = spool.dir;
  spool.dir = null;
  spool.file = null;
  spool.chunks = 0;
  if (!dir) return;
  await fs.promises.rm(dir, { recursive: true, force: true }).catch((err) => {
    logger.warn({ err, dir }, 'meeting audio spool cleanup failed');
  });
}

/**
 * Append chunks not yet on disk and return the spool file path, or null when
 * the file could not be written (the spool is reset and rebuilt next time).
 */
export async function syncAudioSpool(
  spool: AudioSpool,
  chunks: Buffer[],
  inputExt: string,
): Promise<string | null> {
  try {
    if (!spool.dir || !spool.file) {
      spool.dir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'carapa-meeting-'),
      );
      spool.file = path.join(spool.dir, `in.${inputExt}`);
      spool.chunks = 0;
    }
    if (spool.chunks < chunks.length) {
      // `chunks` is the live session array: chunks pushed during the await
      // are not in `pending`, so only count what was actually written.
      const end = chunks.length;
      const pending = chunks.slice(spool.chunks, end);
      await fs.promises.appendFile(spool.file, Buffer.concat(pending));
      spool.chunks = end;
    }
    return spool.file;
  } catch (err) {
    logger.warn({ err }, 'meeting audio spool write error');
    await removeAudioSpool(spool);
    return null;
  }
}

interface ToolResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Run a binary without blocking the event loop; null on spawn error or timeout. */
function runTool(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<ToolResult | null> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let settled = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const finish = (result: ToolResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      logger.warn({ cmd, timeoutMs }, 'meeting audio tool timed out — killed');
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);

    const capture = (sink: Buffer[]) => (data: Buffer) => {
      if (captured >= MAX_CAPTURED_BYTES) return;
      captured += data.length;
      sink.push(data);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', (err) => {
      logger.warn({ err, cmd }, 'meeting audio tool failed to run');
      finish(null);
    });
    child.on('close', (status) =>
      finish({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
  });
}

async function withTempDir<T>(
  fn: (tmpDir: string) => Promise<T>,
): Promise<T | null> {
  let tmpDir: string | null = null;
  try {
    tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'carapa-meeting-'),
    );
    return await fn(tmpDir);
  } catch (err) {
    logger.warn({ err }, 'meeting audio temp file error');
    return null;
  } finally {
    if (tmpDir) {
      await fs.promises
        .rm(tmpDir, { recursive: true, force: true })
        .catch((err) => {
          logger.warn({ err, tmpDir }, 'meeting audio temp dir cleanup failed');
        });
    }
  }
}

/** Total duration of an audio file in seconds (ffprobe). */
export async function probeAudioDurationSec(
  filePath: string,
): Promise<number | null> {
  const result = await runTool(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ],
    FFPROBE_TIMEOUT_MS,
  );
  if (!result) return null;
  if (result.status !== 0) {
    logger.warn(
      { stderr: result.stderr.toString().slice(0, 300) },
      'ffprobe duration failed',
    );
    return null;
  }
  const seconds = parseFloat(result.stdout.toString().trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Run ffmpeg on `inPath` and return the 16 kHz mono WAV it wrote. */
async function ffmpegToWav(
  inPath: string,
  windowArgs: string[],
  failureContext: Record<string, unknown>,
  failureMessage: string,
): Promise<Buffer | null> {
  return withTempDir(async (tmpDir) => {
    const outPath = path.join(tmpDir, 'out.wav');
    const result = await runTool(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        inPath,
        ...windowArgs,
        '-ar',
        '16000',
        '-ac',
        '1',
        outPath,
      ],
      FFMPEG_TIMEOUT_MS,
    );
    if (!result || result.status !== 0) {
      logger.warn(
        {
          ...failureContext,
          status: result?.status,
          stderr: result?.stderr.toString().slice(0, 500),
        },
        failureMessage,
      );
      return null;
    }
    return fs.promises.readFile(outPath);
  });
}

/**
 * Extract a slice as 16 kHz mono WAV (whisper-stream sample rate).
 * `startSec` must advance after each successful transcription.
 */
export async function extractWavSegment(
  filePath: string,
  startSec: number,
  durationSec: number,
): Promise<Buffer | null> {
  if (durationSec <= 0) return null;
  return ffmpegToWav(
    filePath,
    ['-ss', String(startSec), '-t', String(durationSec)],
    { startSec, durationSec },
    'ffmpeg segment extract failed',
  );
}

/** Convert an entire blob to WAV (stop-time fallback). */
export async function convertAudioToWav(
  input: Buffer,
  inputExt: string,
): Promise<Buffer | null> {
  return withTempDir(async (tmpDir) => {
    const inPath = path.join(tmpDir, `in.${inputExt}`);
    await fs.promises.writeFile(inPath, input);
    return ffmpegToWav(inPath, [], {}, 'ffmpeg full conversion failed');
  });
}
