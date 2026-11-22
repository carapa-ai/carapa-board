/** Consecutive failed status polls (~1.5 s apart, about 60 s) before giving up. */
export const PROMPT_POLL_MAX_FAILURES = 40;

/** HTTP statuses meaning the visitor session or share link no longer exists. */
const PERMANENT_STATUSES = new Set([403, 404, 410]);

export type PromptPollDecision =
  | { outcome: 'ok'; consecutiveFailures: 0 }
  | { outcome: 'retry'; consecutiveFailures: number }
  | { outcome: 'unavailable'; consecutiveFailures: number };

/** Decide what a visitor-prompt status poll does next; `httpStatus` 0 means a network error. */
export function nextPromptPollDecision(
  httpStatus: number,
  consecutiveFailures: number,
): PromptPollDecision {
  if (httpStatus >= 200 && httpStatus < 300)
    return { outcome: 'ok', consecutiveFailures: 0 };
  if (PERMANENT_STATUSES.has(httpStatus))
    return { outcome: 'unavailable', consecutiveFailures };
  const failures = consecutiveFailures + 1;
  return {
    outcome: failures >= PROMPT_POLL_MAX_FAILURES ? 'unavailable' : 'retry',
    consecutiveFailures: failures,
  };
}
