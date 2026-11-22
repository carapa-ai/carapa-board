import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { SynthResult } from './synthesizer.js';

/** Build an ffmpeg filter with silence only after natural punctuation boundaries. */
export function buildAudioConcatFilter(
  clipCount: number,
  sampleRate: number,
  pauseAfter: boolean[],
  gapMs: number,
): string {
  const filters: string[] = [];
  const inputs: string[] = [];
  for (let i = 0; i < clipCount; i++) {
    filters.push(
      `[${i}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=mono[a${i}]`,
    );
    inputs.push(`[a${i}]`);
    if (i < clipCount - 1 && pauseAfter[i]) {
      filters.push(`anullsrc=r=${sampleRate}:cl=mono:d=${gapMs / 1000}[s${i}]`);
      inputs.push(`[s${i}]`);
    }
  }
  filters.push(`${inputs.join('')}concat=n=${inputs.length}:v=0:a=1[out]`);
  return filters.join(';');
}

/** Combine independently synthesized OGG clips into one browser-safe OGG. */
export async function concatenateOggClips(
  clips: SynthResult[],
  pauseAfter: boolean[],
  gapMs: number,
): Promise<SynthResult> {
  if (clips.length === 0)
    throw new Error('Cannot concatenate an empty TTS clip list');
  if (clips.length === 1) return clips[0];

  const sampleRate = clips[0].sampleRate;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'carapa-tts-'));
  const outPath = path.join(tmpDir, 'combined.ogg');
  try {
    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    for (const [index, clip] of clips.entries()) {
      const inputPath = path.join(tmpDir, `${index}.${clip.format}`);
      await fs.writeFile(inputPath, clip.audio);
      args.push('-i', inputPath);
    }
    args.push(
      '-filter_complex',
      buildAudioConcatFilter(clips.length, sampleRate, pauseAfter, gapMs),
      '-map',
      '[out]',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      '-c:a',
      'libvorbis',
      outPath,
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 500)
          stderr += chunk.toString().slice(0, 500 - stderr.length);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `ffmpeg TTS concatenation failed: ${stderr || 'unknown error'}`,
            ),
          );
      });
    });
    return {
      audio: await fs.readFile(outPath),
      format: 'ogg',
      durationMs:
        clips.reduce((sum, clip) => sum + clip.durationMs, 0) +
        gapMs * pauseAfter.slice(0, -1).filter(Boolean).length,
      sampleRate,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
