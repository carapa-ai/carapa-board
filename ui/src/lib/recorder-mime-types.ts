/**
 * Preferred MIME types for `MediaRecorder` instances in this app, ordered
 * from most to least preferred. Used by `useMeetingRecording` (the meeting
 * recorder that streams chunks to the backend) — `audio/ogg;codecs=opus`
 * first because it matches the Whisper backend's preferred input format,
 * then webm variants, then MP4 as the final fallback.
 *
 * Consumers pick the first entry that `MediaRecorder.isTypeSupported`
 * accepts. Do NOT mutate the array — pass it to `Array.prototype.find`
 * (or copy it) so the shared constant stays a single source of truth.
 */
export const RECORDER_MIME_TYPES: readonly string[] = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
];
