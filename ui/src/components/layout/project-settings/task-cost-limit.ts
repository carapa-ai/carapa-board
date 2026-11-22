export const TASK_COST_LIMIT_ERROR =
  'Enter an amount above 0, or clear the field for no limit.';

export type TaskCostLimitParse =
  | { ok: true; value: number | null }
  | { ok: false };

/**
 * Parses the per-task cost limit text. Only an empty field means "no limit"
 * (null, which the API treats as "clear the limit"); any other text,
 * including whitespace only, must be a finite number above 0.
 */
export function parseTaskCostLimit(text: string): TaskCostLimitParse {
  if (text === '') return { ok: true, value: null };
  const trimmed = text.trim();
  const value = /^[\d.eE+-]+$/.test(trimmed) ? Number(trimmed) : NaN;
  return Number.isFinite(value) && value > 0
    ? { ok: true, value }
    : { ok: false };
}
