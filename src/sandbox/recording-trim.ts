import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { RECORD_TRIM } from '../config.js';
import { logger } from '../logger.js';

const run = promisify(execFile);

const FREEZE_TAIL_SECONDS = 2;
const MOTION_TAIL_SECONDS = 1;
const MIN_SAVINGS_SECONDS = 3;
const ANALYZE_TIMEOUT_MS = 120_000;
const ANALYZE_FILTER =
  'freezedetect=n=-50dB:d=3,mpdecimate=hi=2048:lo=512:frac=0.05,showinfo';

interface TrailingIdleCut {
  duration: number;
  at: number;
  reason: 'freeze' | 'near-duplicate';
}

/**
 * Where the trailing static section of a recording begins, from the stderr of
 * one ffmpeg pass over ANALYZE_FILTER. Returns null when nothing worth cutting
 * remains.
 */
function trailingIdleCut(log: string): TrailingIdleCut | null {
  const header = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(log);
  if (!header) return null;
  const duration =
    Number(header[1]) * 3600 + Number(header[2]) * 60 + Number(header[3]);

  // freezedetect emits freeze_start once a freeze reaches its duration and
  // freeze_end only when movement resumes, so an unmatched final start begins
  // the trailing static section. Tiny periodic refreshes split one long freeze
  // into short ones; mpdecimate's last retained frame (logged by showinfo) is
  // the fallback for the last meaningful visual change.
  let freezeStart: number | null = null;
  let motionLast: number | null = null;
  for (const line of log.split('\n')) {
    const start = /lavfi\.freezedetect\.freeze_start: ([\d.]+)/.exec(line);
    if (start) freezeStart = Number(start[1]);
    else if (line.includes('lavfi.freezedetect.freeze_end:'))
      freezeStart = null;
    const shown = /Parsed_showinfo.*\bpts_time:([\d.]+)/.exec(line);
    if (shown) motionLast = Number(shown[1]);
  }

  const cutAfter = (start: number | null, tail: number) => {
    if (start === null) return null;
    const cut = Math.min(start + tail, duration);
    return cut > 0 && duration - cut >= MIN_SAVINGS_SECONDS ? cut : null;
  };
  const freezeCut = cutAfter(freezeStart, FREEZE_TAIL_SECONDS);
  const motionCut = cutAfter(motionLast, MOTION_TAIL_SECONDS);
  // Keep the earlier boundary: periodic refreshes ending in one longer freeze
  // would otherwise leave all but the final freeze segment in place.
  if (motionCut !== null && (freezeCut === null || motionCut < freezeCut))
    return { duration, at: motionCut, reason: 'near-duplicate' };
  if (freezeCut !== null) return { duration, at: freezeCut, reason: 'freeze' };
  return null;
}

/**
 * Cut the static tail a Testing-stage recording keeps after the agent stops
 * interacting. Best-effort: any failure keeps the original video.
 */
async function trimTrailingIdle(video: string): Promise<void> {
  let cut: TrailingIdleCut | null;
  try {
    const { stderr } = await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostats',
        '-loglevel',
        'info',
        '-i',
        video,
        '-vf',
        ANALYZE_FILTER,
        '-an',
        '-f',
        'null',
        '-',
      ],
      { timeout: ANALYZE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    );
    cut = trailingIdleCut(stderr);
  } catch (error) {
    logger.warn(
      { video, error: String(error) },
      'Recording idle analysis failed; keeping original',
    );
    return;
  }
  if (!cut) return;

  // Not *.webm, so the recordings list never shows a half-written cut.
  const trimmed = `${video}.trimming`;
  try {
    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        video,
        '-t',
        cut.at.toFixed(3),
        '-map',
        '0',
        '-c',
        'copy',
        '-f',
        'webm',
        trimmed,
      ],
      { timeout: ANALYZE_TIMEOUT_MS },
    );
    if (fs.statSync(trimmed).size === 0) throw new Error('empty output');
    fs.renameSync(trimmed, video);
    logger.info(
      { video, duration: cut.duration, cutAt: cut.at, detector: cut.reason },
      'Trimmed trailing idle from recording',
    );
  } catch (error) {
    fs.rmSync(trimmed, { force: true });
    logger.warn(
      { video, error: String(error) },
      'Recording idle trim failed; keeping original',
    );
  }
}

let queue: Promise<void> = Promise.resolve();

/**
 * Trim in the background, one video at a time, so a finished run and its
 * browser never wait on ffmpeg. CARAPA_RECORD_TRIM=0 keeps videos untouched.
 */
export function queueTrailingIdleTrim(videos: string[]): void {
  if (!RECORD_TRIM || videos.length === 0) return;
  queue = queue.then(async () => {
    for (const video of videos) await trimTrailingIdle(video);
  });
}
