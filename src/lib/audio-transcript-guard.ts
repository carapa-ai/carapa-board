/** Duration from the canonical PCM WAV header emitted by Live Mode. */
export function wavDurationMs(buffer: Buffer): number | null {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  )
    return null;
  const byteRate = buffer.readUInt32LE(28);
  const dataBytes = buffer.readUInt32LE(40);
  if (!byteRate || !dataBytes) return null;
  return (dataBytes / byteRate) * 1000;
}

/** A sub-second utterance cannot plausibly contain a long sentence. */
export function isImplausibleShortAudioTranscript(
  buffer: Buffer,
  transcript: string,
): boolean {
  const duration = wavDurationMs(buffer);
  if (duration === null || duration >= 1000) return false;
  const normalized = transcript.replace(/\s+/g, ' ').trim();
  const words = normalized ? normalized.split(' ').length : 0;
  return normalized.length > 40 || words > 7;
}

function normalized(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Reject models echoing the transcription instruction instead of the audio. */
export function isTranscriptionPromptEcho(
  transcript: string,
  prompt: string,
): boolean {
  const result = normalized(transcript);
  const instruction = normalized(prompt);
  if (!result || !instruction) return false;
  if (result === instruction) return true;
  const shorter = Math.min(result.length, instruction.length);
  const longer = Math.max(result.length, instruction.length);
  return (
    shorter / longer >= 0.8 &&
    (result.includes(instruction) || instruction.includes(result))
  );
}
