import { validateLiveStatus } from './live-speech-protocol.js';

/** Denoising steps for short Live status lines. Narration is latency-bound,
 * so it uses fewer steps than persona replies (8), trading some voice quality
 * for faster synthesis. Shared with transcript replay so both reuse cached
 * audio. */
export const LIVE_STATUS_TTS_STEPS = 4;

export interface LiveSpeechSynthesis {
  audio: ArrayBuffer;
  text: string;
  requestMs: number;
  response?: Response;
}

/** Production Live Mode TTS request boundary. Only registry-derived statuses
 * are accepted; chat prose and tool output cannot reach the endpoint. */
export async function synthesizeLiveStatus(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  endpoint: string,
  conversationId: string,
  text: string,
  source: 'registry' | undefined,
  speechProfile?: { voice?: string; lang?: string },
): Promise<LiveSpeechSynthesis> {
  if (source !== 'registry')
    throw new Error('Live speech requires registry status');
  const safe = validateLiveStatus(text);
  if (!safe) throw new Error('Invalid Live speech status');
  const started = performance.now();
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Live-Conversation': conversationId,
    },
    body: JSON.stringify({
      text: safe,
      voice: speechProfile?.voice,
      lang: speechProfile?.lang,
      // Spoken in the language the status is written in (server-side Jev).
      detectLanguage: true,
      format: 'ogg',
      steps: LIVE_STATUS_TTS_STEPS,
      profile: 'interactive',
    }),
  });
  if (!response.ok) throw new Error(`Live TTS ${response.status}`);
  return {
    audio: await response.arrayBuffer(),
    text: safe,
    requestMs: performance.now() - started,
    response,
  };
}
