/** Failures from a warm agent turn that can resume in the same conversation. */
export function isPersistentTurnTimeout(content: string): boolean {
  return /\bpersistent:\s*(?:[\w-]+\s+)?turn timeout\b/i.test(content);
}

/**
 * Whether the agent produced useful output before the runner appended an
 * error marker (sandbox or direct-LLM). Stream chunks concatenate without a
 * separator, so the marker is not line-anchored. Provider diagnostic lines
 * (capacity/overload) are not assistant output, so a capacity failure after
 * real output stays resumable.
 */
export function hasPartialResponseBeforeSandboxError(content: string): boolean {
  const markerIndex = content.search(
    /\s*⚠️\s*\*{0,2}(?:Sandbox Error|LLM Error)/i,
  );
  if (markerIndex <= 0) return false;

  const responseLines = content
    .slice(0, markerIndex)
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/Selected model is at capacity|\b(?:server)?overloaded\b/i.test(line),
    );
  return responseLines.length > 0;
}
