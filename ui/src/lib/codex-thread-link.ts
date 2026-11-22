const CODEX_THREAD_LINK =
  /^codex:\/\/threads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** Return the normalized thread id only when the whole composer value is a deep link. */
export function codexThreadIdFromDeepLink(value: string): string | null {
  return value.trim().match(CODEX_THREAD_LINK)?.[1]?.toLowerCase() ?? null;
}
