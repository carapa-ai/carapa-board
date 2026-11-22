import { logger } from '../../logger.js';

export const LIVE_VOICE_METRICS = [
  'speech_start_to_audio_cutoff_ms',
  'utterance_end_to_final_stt_ms',
  'router_decision_ms',
  'first_audio_ms',
  'queue_drops',
  'failed_stt_calls',
  'failed_tts_calls',
  'stt_stream_connect_ms',
  'stt_fallbacks',
  'stt_upstream_failures',
  'stt_suppressed_results',
  'stt_out_of_order_results',
] as const;

export type LiveVoiceMetric = (typeof LIVE_VOICE_METRICS)[number];

const samples = new Map<LiveVoiceMetric, number[]>();

/** Process-local metrics keep Live Mode observable without requiring a remote metrics service. */
export function recordLiveVoiceMetric(
  metric: LiveVoiceMetric,
  value = 1,
  fields: Record<string, unknown> = {},
): void {
  const values = samples.get(metric) || [];
  values.push(value);
  if (values.length > 1000) values.shift();
  samples.set(metric, values);
  logger.info(
    { liveMode: true, metric, value, ...fields },
    'live voice metric',
  );
}

export function getLiveVoiceMetrics(): Record<
  LiveVoiceMetric,
  { count: number; p50: number; p95: number; last: number }
> {
  const result = {} as Record<
    LiveVoiceMetric,
    { count: number; p50: number; p95: number; last: number }
  >;
  for (const [metric, values] of samples) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    result[metric] = {
      count: values.length,
      p50: at(0.5),
      p95: at(0.95),
      last: values.at(-1) ?? 0,
    };
  }
  return result;
}
