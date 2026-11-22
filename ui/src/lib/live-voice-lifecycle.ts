export function releaseStaleMicrophoneStream(
  stream: { getTracks(): Array<{ stop(): void }> },
  isCurrent: boolean,
): boolean {
  if (isCurrent) return false;
  for (const track of stream.getTracks()) track.stop();
  return true;
}

export function expireSilentCapture(
  receivedFrame: boolean,
  isCurrent: boolean,
  cleanup: () => void,
): boolean {
  if (receivedFrame || !isCurrent) return false;
  cleanup();
  return true;
}
