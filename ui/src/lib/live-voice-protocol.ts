/** Browser-independent pieces of the Live Mode streaming STT contract. */
export const LIVE_VOICE_PROTOCOL = 'carapa.live-stt.v2';
export function zeroCrossingRate(samples: Float32Array): number {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (
      (samples[i - 1] < 0 && samples[i] >= 0) ||
      (samples[i - 1] >= 0 && samples[i] < 0)
    )
      crossings++;
  }
  return crossings / (samples.length - 1);
}

/** Stateful linear resampler for microphone contexts that ignore the requested
 * 16 kHz rate (notably Android WebView, which commonly stays at 48 kHz). */
export class StreamingPcmResampler {
  private buffer = new Float32Array(0);
  private position = 0;

  constructor(
    private readonly inputRate: number,
    private readonly outputRate: number,
  ) {
    if (inputRate <= 0 || outputRate <= 0) {
      throw new Error('Audio sample rates must be positive');
    }
  }

  push(input: Float32Array): Float32Array {
    if (!input.length) return input;
    if (this.inputRate === this.outputRate) return input.slice();
    const combined = new Float32Array(this.buffer.length + input.length);
    combined.set(this.buffer);
    combined.set(input, this.buffer.length);
    const ratio = this.inputRate / this.outputRate;
    const output: number[] = [];
    while (this.position + 1 < combined.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      output.push(
        combined[left]! * (1 - fraction) + combined[left + 1]! * fraction,
      );
      this.position += ratio;
    }
    const drop = Math.min(Math.floor(this.position), combined.length - 1);
    this.buffer = combined.slice(drop);
    this.position -= drop;
    return Float32Array.from(output);
  }
}
export type VoiceFrameDecision =
  | 'silence'
  | 'speech-start'
  | 'speech'
  | 'discard'
  | 'finalize';
export interface VoiceDetectorOptions {
  sampleRate: number;
  trailingSilenceMs?: number;
  maxUtteranceMs?: number;
  minSpeechMs?: number;
  minSpeechLikeMs?: number;
  maxZeroCrossingHz?: number;
  /** Once an utterance reaches `relaxAfterMs`, a pause of `relaxedTrailingSilenceMs` also ends it. */
  relaxAfterMs?: number;
  relaxedTrailingSilenceMs?: number;
}

/** Initial adaptive noise floor; also restored after speaker playback ends. */
const INITIAL_NOISE_FLOOR = 0.003;

/** Adaptive, sample-count based VAD. It remains deterministic across callback sizes. */
export class LiveVoiceDetector {
  private noiseFloor = INITIAL_NOISE_FLOOR;
  private speaking = false;
  private utteranceSamples = 0;
  private silenceSamples = 0;
  private voicedSamples = 0;
  private speechLikeSamples = 0;
  private readonly trailing: number;
  private readonly relaxAfter: number;
  private readonly relaxedTrailing: number;
  private readonly maximum: number;
  private readonly minimum: number;
  private readonly speechLikeMinimum: number;
  private readonly maxZeroCrossingRate: number;
  constructor(private readonly options: VoiceDetectorOptions) {
    this.trailing =
      (options.sampleRate * (options.trailingSilenceMs ?? 250)) / 1000;
    this.relaxAfter =
      options.relaxAfterMs === undefined
        ? Infinity
        : (options.sampleRate * options.relaxAfterMs) / 1000;
    this.relaxedTrailing =
      (options.sampleRate *
        (options.relaxedTrailingSilenceMs ??
          options.trailingSilenceMs ??
          250)) /
      1000;
    this.maximum =
      (options.sampleRate * (options.maxUtteranceMs ?? 15_000)) / 1000;
    this.minimum = (options.sampleRate * (options.minSpeechMs ?? 300)) / 1000;
    this.speechLikeMinimum =
      (options.sampleRate * (options.minSpeechLikeMs ?? 120)) / 1000;
    this.maxZeroCrossingRate =
      ((options.maxZeroCrossingHz ?? 1800) * 2) / options.sampleRate;
  }
  push(
    rms: number,
    samples: number,
    zeroCrossings?: number,
  ): VoiceFrameDecision {
    const onset = Math.max(0.012, this.noiseFloor * 3);
    const release = Math.max(0.007, this.noiseFloor * 1.8);
    const voice = rms >= (this.speaking ? release : onset);
    const speechLike =
      zeroCrossings === undefined || zeroCrossings <= this.maxZeroCrossingRate;
    if (!this.speaking) {
      if (!voice)
        this.noiseFloor = this.noiseFloor * 0.97 + Math.min(rms, 0.02) * 0.03;
      if (!voice) return 'silence';
      this.speaking = true;
      this.utteranceSamples = samples;
      this.voicedSamples = samples;
      this.speechLikeSamples = speechLike ? samples : 0;
      this.silenceSamples = 0;
      return 'speech-start';
    }
    this.utteranceSamples += samples;
    if (voice) {
      this.voicedSamples += samples;
      if (speechLike) this.speechLikeSamples += samples;
      this.silenceSamples = 0;
    } else this.silenceSamples += samples;
    const trailing =
      this.utteranceSamples >= this.relaxAfter
        ? this.relaxedTrailing
        : this.trailing;
    if (
      this.utteranceSamples >= this.maximum ||
      this.silenceSamples >= trailing
    ) {
      const valid =
        this.voicedSamples >= this.minimum &&
        this.speechLikeSamples >= this.speechLikeMinimum;
      this.reset();
      return valid ? 'finalize' : 'discard';
    }
    return 'speech';
  }
  /** Ends the open utterance (a Stop before trailing silence) and reports
   * whether it met the same speech minimums as an automatic finalize. */
  flush(): boolean {
    const valid =
      this.speaking &&
      this.voicedSamples >= this.minimum &&
      this.speechLikeSamples >= this.speechLikeMinimum;
    this.reset();
    return valid;
  }
  reset(): void {
    this.speaking = false;
    this.utteranceSamples = 0;
    this.silenceSamples = 0;
    this.voicedSamples = 0;
    this.speechLikeSamples = 0;
  }
  /** Forget the noise floor learned while the speakers were playing: a long
   * reply heard at the mic pins it at the echo level, which can lift the
   * onset above normal speech and deafen the VAD for seconds after playback
   * ends. Called when reply audio (and its echo tail) has just ended. */
  resetNoiseFloor(): void {
    this.noiseFloor = INITIAL_NOISE_FLOOR;
  }
}
export function sttTextEvent(message: unknown): {
  partial?: string;
  final?: string;
  error?: string;
} {
  if (!message || typeof message !== 'object') return {};
  const value = message as {
    type?: unknown;
    text?: unknown;
    message?: unknown;
  };
  if (value.type === 'partial' && typeof value.text === 'string')
    return { partial: value.text };
  if (
    value.type === 'final' &&
    typeof value.text === 'string' &&
    value.text.trim()
  )
    return { final: value.text.trim() };
  if (value.type === 'error')
    return {
      error:
        typeof value.message === 'string' ? value.message : 'Local STT error',
    };
  return {};
}
export interface LiveVoiceCleanupResources {
  stream?: { getTracks(): Array<{ stop(): void }> };
  context?: { close(): Promise<void> };
  node?: { disconnect(): void };
  source?: { disconnect(): void };
  workletUrl?: string;
}
export function cleanupLiveVoiceResources(
  resources: LiveVoiceCleanupResources,
): void {
  resources.node?.disconnect();
  resources.source?.disconnect();
  resources.stream?.getTracks().forEach((track) => track.stop());
  void resources.context?.close();
  if (resources.workletUrl) URL.revokeObjectURL(resources.workletUrl);
}
