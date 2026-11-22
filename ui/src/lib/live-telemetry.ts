import { API_BASE_URL } from './api-config';
import { apiFetch } from './api';
export type LiveMetric = 'speech_start_to_audio_cutoff_ms' | 'utterance_end_to_final_stt_ms' | 'router_decision_ms' | 'first_audio_ms' | 'queue_drops' | 'failed_stt_calls' | 'failed_tts_calls';
export function recordLiveMetric(metric: LiveMetric, value = 1): void { void apiFetch(`${API_BASE_URL}/api/live-voice/metrics`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metric, value }) }).catch(() => undefined); }
