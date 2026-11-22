/**
 * Helpers for classifying database errors before they reach an HTTP response.
 *
 * The data layer throws Drizzle's `DrizzleQueryError`, whose `message` is the
 * raw SQL plus its bind parameters (`Failed query: insert into ... params: ...`).
 * That text can carry secrets — password hashes among them — so routes must
 * never forward it to a client. The actionable driver error (SQLSTATE
 * `23505` for a unique violation) lives on `error.cause`, so the whole cause
 * chain is inspected before an error is classified.
 */

/** Maximum number of `cause` links inspected while classifying an error. */
const MAX_CAUSE_DEPTH = 5;

/**
 * True when the error, or any error in its `cause` chain, is a PostgreSQL
 * unique-constraint violation.
 */
export function isUniqueViolationError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== 'object') return false;
    const candidate = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (candidate.code === '23505') return true;
    const message =
      typeof candidate.message === 'string' ? candidate.message : '';
    if (/duplicate key value violates unique constraint/i.test(message))
      return true;
    current = candidate.cause;
  }
  return false;
}
