import { isNativeSpeechPlaying } from '@/lib/push-bridge';
import { getLiveSpeechState } from '@/lib/use-tts';

/** How long after reply audio ends the mic still hears room reverb/echo. */
export const REPLY_AUDIO_TAIL_MS = 600;

/**
 * Tracks whether the assistant's reply audio is audible on the speakers: web
 * Live playback, or the Android native speech service (outside the WebView, so
 * WebView echo cancellation has no reference for it), plus a short tail.
 * Poll it from the capture loop; each poll made while audio plays extends the
 * tail.
 */
export function createReplyAudioTracker(): (now?: number) => boolean {
  let lastPlayingAt = -Infinity;
  return (now = Date.now()) => {
    if (
      getLiveSpeechState().status === 'speaking' ||
      isNativeSpeechPlaying(now)
    ) {
      lastPlayingAt = now;
      return true;
    }
    return now - lastPlayingAt < REPLY_AUDIO_TAIL_MS;
  };
}
